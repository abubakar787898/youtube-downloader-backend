'use strict'

const express = require('express')
const fs = require('fs')
const path = require('path')
const os = require('os')
const router = express.Router()

const settings = require('../settings')

function currentPayload() {
  const all = settings.getAll()
  return {
    downloadDir: settings.getDownloadDir(),
    defaultDownloadDir: settings.defaultDownloadDir(),
    isCustom: !!(settings.getAll().downloadDir || '').trim(),
    downloadsEnabled: settings.getDownloadsEnabled(),
    platforms: settings.getPlatforms(),
    cookiesFile: all.cookiesFile || '',
    cookiesFromBrowser: all.cookiesFromBrowser || '',
  }
}

// GET /api/settings — current effective settings.
router.get('/', (req, res) => {
  res.json(currentPayload())
})

// PUT /api/settings — body { downloadDir, cookiesFile, cookiesFromBrowser }.
router.put('/', (req, res) => {
  const body = req.body || {}
  const patch = {}

  if (body.downloadDir !== undefined) {
    const raw = typeof body.downloadDir === 'string' ? body.downloadDir.trim() : ''
    if (!raw) {
      patch.downloadDir = null
    } else {
      if (!path.isAbsolute(raw)) {
        return res.status(400).json({ error: 'Enter a full (absolute) folder path, e.g. D:\\Videos or /downloads.' })
      }
      try {
        fs.mkdirSync(raw, { recursive: true })
        const probe = path.join(raw, `.write-test-${process.pid}-${Date.now()}`)
        fs.writeFileSync(probe, 'ok')
        fs.unlinkSync(probe)
        patch.downloadDir = raw
      } catch (e) {
        return res.status(400).json({ error: `Can't use that folder: ${e.code || e.message}` })
      }
    }
  }

  if (body.cookiesFile !== undefined) {
    const rawFile = typeof body.cookiesFile === 'string' ? body.cookiesFile.trim() : ''
    if (rawFile) {
      if (!path.isAbsolute(rawFile)) {
        return res.status(400).json({ error: 'Enter a full (absolute) cookies file path, e.g. C:\\cookies.txt.' })
      }
      if (!fs.existsSync(rawFile)) {
        return res.status(400).json({ error: `Cookies file does not exist at path: ${rawFile}` })
      }
      patch.cookiesFile = rawFile
    } else {
      patch.cookiesFile = null
    }
  }

  if (body.cookiesFromBrowser !== undefined) {
    const rawBrowser = typeof body.cookiesFromBrowser === 'string' ? body.cookiesFromBrowser.trim() : ''
    const validBrowsers = ['chrome', 'firefox', 'edge', 'brave', 'opera', 'vivaldi', 'safari', '', 'none']
    if (rawBrowser && !validBrowsers.includes(rawBrowser.toLowerCase())) {
      return res.status(400).json({ error: `Invalid browser name: ${rawBrowser}` })
    }
    patch.cookiesFromBrowser = rawBrowser === 'none' ? '' : rawBrowser
  }

  if (Object.keys(patch).length > 0) {
    settings.setAll(patch)
  }

  return res.json(currentPayload())
})

// GET /api/settings/suggestions — a few sensible folders for the UI to offer.
router.get('/suggestions', (req, res) => {
  const home = os.homedir()
  const candidates = [
    settings.defaultDownloadDir(),
    path.join(home, 'Downloads'),
    path.join(home, 'Videos'),
  ]
  const seen = new Set()
  const list = candidates.filter((p) => p && !seen.has(p) && seen.add(p))
  res.json({ suggestions: list })
})

module.exports = router
