'use strict'

const express = require('express')
const crypto = require('crypto')
const router = express.Router()

const db = require('../db')
const queue = require('../queue')
const ytdlp = require('../ytdlp')
const settings = require('../settings')
const { detectPlatform, LABELS } = require('../platforms')

const URL_RE = /^https?:\/\/.+/i
const FORMATS = new Set(['mp4', 'mp3'])

// Global map for short-lived download tokens
const downloadTokens = new Map()

// POST /api/downloads/prepare - prepare native download
router.post('/prepare', async (req, res) => {
  const body = req.body || {}
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  let format = typeof body.format === 'string' ? body.format : 'mp4'
  if (!format) format = 'mp4'

  if (!settings.getDownloadsEnabled()) {
    return res.status(403).json({ error: 'Downloads are currently disabled by the administrator.' })
  }
  if (!URL_RE.test(url)) {
    return res.status(400).json({ error: 'A valid http(s) URL is required.' })
  }
  if (!FORMATS.has(format)) {
    return res.status(400).json({ error: 'format must be one of: mp4, mp3.' })
  }

  const platform = detectPlatform(url)
  if (!settings.isPlatformEnabled(platform)) {
    return res
      .status(403)
      .json({ error: `${LABELS[platform] || 'These'} downloads are currently disabled by the administrator.` })
  }

  let height = null
  if (body.height !== undefined && body.height !== null && body.height !== '') {
    const h = parseInt(body.height, 10)
    if (!Number.isInteger(h) || h < 1 || h > 4320) {
      return res.status(400).json({ error: 'height must be an integer between 1 and 4320.' })
    }
    height = h
  }
  if (format === 'mp3') height = null

  try {
    const info = await ytdlp.getInfo(url)
    const token = crypto.randomUUID()
    
    // Add dummy job for history (so user sees what they downloaded previously)
    const job = {
      id: token,
      url,
      format,
      height,
      status: 'done', 
      title: info.title || null,
      filename: (info.title || 'download').replace(/[^\x20-\x7E]/g, '') + (format === 'mp3' ? '.mp3' : '.mp4'),
      filepath: null,
      error: null,
      hidden: false,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }
    db.addJob(job)
    
    downloadTokens.set(token, {
      url,
      format,
      height,
      title: info.title || null,
      createdAt: Date.now()
    })
    
    // Auto-expire token after 10 minutes
    setTimeout(() => {
      downloadTokens.delete(token)
    }, 10 * 60 * 1000)

    // Ensure frontend points to the base URL appropriately (absolute path so browser routes correctly)
    return res.json({ success: true, download_url: `/api/downloads/file/${token}` })
  } catch (e) {
    return res.status(422).json({ error: String((e && e.message) || e || 'Could not prepare download.') })
  }
})

// GET /api/downloads/file/:token - streams actual file natively to browser
router.get('/file/:token', async (req, res) => {
  const token = req.params.token
  const params = downloadTokens.get(token)
  
  if (!params) {
    return res.status(404).send('Download token expired or invalid.')
  }
  
  // Single use token
  downloadTokens.delete(token)
  
  const ext = params.format === 'mp3' ? '.mp3' : '.mp4'
  let safeFilename = (params.title || 'download').replace(/[^\x20-\x7E]/g, '') || `download${ext}`
  if (!safeFilename.endsWith(ext)) safeFilename += ext
  const contentType = params.format === 'mp3' ? 'audio/mpeg' : 'video/mp4'

  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`)
  res.setHeader('Content-Type', contentType)
  
  try {
    await ytdlp.streamDownload(params, req, res)
  } catch (err) {
    console.error('[media-downloader] stream error:', err.message)
    if (!res.headersSent) res.status(500).end()
  }
})

// POST /api/downloads/info  — resolve metadata + available qualities (no download)
router.post('/info', async (req, res) => {
  const body = req.body || {}
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!URL_RE.test(url)) {
    return res.status(400).json({ error: 'A valid http(s) URL is required.' })
  }
  try {
    const info = await ytdlp.getInfo(url)
    return res.json({ url, ...info })
  } catch (e) {
    return res.status(422).json({ error: String((e && e.message) || e || 'Could not fetch video info.') })
  }
})

// POST /api/downloads  — body { url, format, height? }
router.post('/', (req, res) => {
  const body = req.body || {}
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  let format = typeof body.format === 'string' ? body.format : 'mp4'
  if (!format) format = 'mp4'

  if (!settings.getDownloadsEnabled()) {
    return res.status(403).json({ error: 'Downloads are currently disabled by the administrator.' })
  }
  if (!URL_RE.test(url)) {
    return res.status(400).json({ error: 'A valid http(s) URL is required.' })
  }
  if (!FORMATS.has(format)) {
    return res.status(400).json({ error: 'format must be one of: mp4, mp3.' })
  }

  const platform = detectPlatform(url)
  if (!settings.isPlatformEnabled(platform)) {
    return res
      .status(403)
      .json({ error: `${LABELS[platform] || 'These'} downloads are currently disabled by the administrator.` })
  }

  // Optional quality cap (mp4 only). Reject anything that isn't a sane integer.
  let height = null
  if (body.height !== undefined && body.height !== null && body.height !== '') {
    const h = parseInt(body.height, 10)
    if (!Number.isInteger(h) || h < 1 || h > 4320) {
      return res.status(400).json({ error: 'height must be an integer between 1 and 4320.' })
    }
    height = h
  }
  if (format === 'mp3') height = null

  const job = {
    id: crypto.randomUUID(),
    url,
    format,
    height,
    status: 'queued',
    title: null,
    filename: null,
    filepath: null,
    error: null,
    hidden: false,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  }

  db.addJob(job)
  queue.enqueue(job)
  return res.status(201).json(job)
})

// GET /api/downloads  — persisted records merged with in-memory live progress.
// Hidden jobs (set by the admin) are excluded from this public list.
router.get('/', (req, res) => {
  const jobs = db.getJobs().filter((j) => !j.hidden)
  const live = queue.getLiveProgress()

  const merged = jobs.map((j) => {
    const l = live[j.id]
    if (!l) return j
    return {
      ...j,
      status: l.status || j.status,
      title: j.title || l.title || null,
      filename: j.filename || l.filename || null,
      error: j.error || l.error || null,
      percent: typeof l.percent === 'number' ? l.percent : null,
      speed: l.speed || null,
      eta: l.eta || null,
    }
  })

  merged.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  return res.json(merged)
})

// DELETE /api/downloads/:id  — remove the record only (leaves the file on disk).
router.delete('/:id', (req, res) => {
  db.removeJob(req.params.id)
  queue.clearLive(req.params.id)
  return res.status(204).end()
})

// GET /api/downloads/:id/download  — trigger browser download for a finished job
router.get('/:id/download', (req, res) => {
  const job = db.getJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  if (job.status !== 'done' || !job.filepath) {
    return res.status(400).json({ error: 'File is not ready or has no path' })
  }

  const fs = require('fs')
  fs.stat(job.filepath, (err, stat) => {
    if (err) {
      console.error('[media-downloader] stat error:', err.message)
      return res.status(404).json({ error: 'File missing on disk' })
    }

    const contentType = job.format === 'mp3' ? 'audio/mpeg' : 'video/mp4'
    const fallbackExt = job.format === 'mp3' ? '.mp3' : '.mp4'
    let filename = job.filename || (job.title ? `${job.title}${fallbackExt}` : `download${fallbackExt}`)
    
    // Fallback for non-ascii characters in header
    const safeFilename = filename.replace(/[^\x20-\x7E]/g, '') || `download${fallbackExt}`
    const encodedName = encodeURIComponent(filename)

    res.download(job.filepath, safeFilename, {
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      }
    }, (err) => {
      if (err) {
        console.error('[media-downloader] download error:', err.message)
        if (!res.headersSent) res.status(500).end()
      }
    })
  })
})

module.exports = router
