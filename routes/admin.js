'use strict'

const express = require('express')
const router = express.Router()

const db = require('../db')
const queue = require('../queue')
const settings = require('../settings')
const { PLATFORM_KEYS, LABELS } = require('../platforms')

const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim()

// Require a matching x-admin-key header when ADMIN_KEY is configured.
// If it's not set, admin is open (local convenience) — see startup warning.
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next()
  const provided = (req.get('x-admin-key') || '').trim()
  if (provided && provided === ADMIN_KEY) return next()
  return res.status(401).json({ error: 'Invalid or missing admin key.' })
}

// Lets the UI know whether a key is required, and whether the supplied one works.
router.get('/ping', (req, res) => {
  const provided = (req.get('x-admin-key') || '').trim()
  res.json({
    protected: !!ADMIN_KEY,
    authed: !ADMIN_KEY || (!!provided && provided === ADMIN_KEY),
  })
})

router.use(requireAdmin)

// Full state for the admin panel: every job (incl. hidden) + the global toggle.
router.get('/state', (req, res) => {
  const live = queue.getLiveProgress()
  const jobs = db
    .getJobs()
    .map((j) => {
      const l = live[j.id]
      return {
        ...j,
        status: l ? l.status || j.status : j.status,
        percent: l && typeof l.percent === 'number' ? l.percent : null,
      }
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  res.json({
    downloadsEnabled: settings.getDownloadsEnabled(),
    platforms: settings.getPlatforms(),
    platformLabels: LABELS,
    jobs,
  })
})

// Turn downloads on/off site-wide.
router.post('/downloads-enabled', (req, res) => {
  const enabled = !!(req.body && req.body.enabled)
  settings.setAll({ downloadsEnabled: enabled })
  res.json({ downloadsEnabled: settings.getDownloadsEnabled() })
})

// Turn a single platform's downloads on/off.
router.post('/platform-enabled', (req, res) => {
  const platform = req.body && req.body.platform
  if (!PLATFORM_KEYS.includes(platform)) {
    return res.status(400).json({ error: 'Unknown platform.' })
  }
  const enabled = !!(req.body && req.body.enabled)
  const platforms = { ...settings.getPlatforms(), [platform]: enabled }
  settings.setAll({ platforms })
  res.json({ platforms: settings.getPlatforms() })
})

// Show/hide a single job from the public list.
router.post('/jobs/:id/visibility', (req, res) => {
  const hidden = !!(req.body && req.body.hidden)
  const updated = db.updateJob(req.params.id, { hidden })
  if (!updated) return res.status(404).json({ error: 'Job not found.' })
  res.json({ id: req.params.id, hidden })
})

// Delete a job record (file is left on disk).
router.delete('/jobs/:id', (req, res) => {
  db.removeJob(req.params.id)
  queue.clearLive(req.params.id)
  res.status(204).end()
})

module.exports = { router, isProtected: !!ADMIN_KEY }
