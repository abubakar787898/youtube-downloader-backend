'use strict'

const express = require('express')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const router = express.Router()

const db = require('../db')
const settings = require('../settings')

const URL_RE = /^https?:\/\/.+/i

// GET /api/tools/thumbnail?url=...&name=...  — stream a remote image as a
// downloadable attachment (the thumbnail-downloader tool).
router.get('/thumbnail', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : ''
  if (!URL_RE.test(url)) return res.status(400).json({ error: 'A valid image URL is required.' })

  try {
    const upstream = await fetch(url, { redirect: 'follow' })
    const type = upstream.headers.get('content-type') || ''
    // Only proxy actual images — limits this endpoint as an SSRF vector.
    if (!upstream.ok || !type.startsWith('image/')) {
      return res.status(422).json({ error: 'That URL did not return an image.' })
    }
    const ext = (type.split('/')[1] || 'jpg').split(';')[0].replace('jpeg', 'jpg')
    const safeName = (typeof req.query.name === 'string' && req.query.name ? req.query.name : 'thumbnail')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 120)
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.set({
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${safeName}.${ext}"`,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    })
    return res.end(buf)
  } catch (e) {
    return res.status(502).json({ error: 'Could not fetch the image.' })
  }
})

// POST /api/tools/reveal  — open the download folder (or a job's file) in the
// host's file manager. Only meaningful when the server runs on your machine.
router.post('/reveal', (req, res) => {
  const id = req.body && req.body.id
  let target = settings.getDownloadDir()
  let select = null

  if (id) {
    const job = db.getJob(id)
    if (job && job.filepath && fs.existsSync(job.filepath)) {
      select = job.filepath
      target = path.dirname(job.filepath)
    }
  }

  try {
    if (process.platform === 'win32') {
      if (select) spawn('explorer.exe', ['/select,', select], { windowsHide: true, detached: true }).unref()
      else spawn('explorer.exe', [target], { windowsHide: true, detached: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', select ? ['-R', select] : [target], { detached: true }).unref()
    } else {
      spawn('xdg-open', [target], { detached: true }).unref()
    }
  } catch (e) {
    // No display / not supported (e.g. headless server) — report the path anyway.
  }
  res.json({ ok: true, folder: target })
})

module.exports = router
