'use strict'

const path = require('path')
const fs = require('fs')
const express = require('express')
const cors = require('cors')

const db = require('./db')
const ytdlp = require('./ytdlp')
const settings = require('./settings')
const downloadsRouter = require('./routes/downloads')
const settingsRouter = require('./routes/settings')
const toolsRouter = require('./routes/tools')
const { router: adminRouter, isProtected: adminProtected } = require('./routes/admin')
const { router: streamRouter } = require('./routes/stream')

const PORT = parseInt(process.env.PORT, 10) || 8080

const app = express()
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }))
app.use(express.json())

// --- Optional HTTP Basic auth (off unless both vars are set) -------------
const AUTH_USER = process.env.AUTH_USER
const AUTH_PASS = process.env.AUTH_PASS
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || ''
    const [scheme, encoded] = header.split(' ')
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8')
      const idx = decoded.indexOf(':')
      const user = decoded.slice(0, idx)
      const pass = decoded.slice(idx + 1)
      if (user === AUTH_USER && pass === AUTH_PASS) return next()
    }
    res.set('WWW-Authenticate', 'Basic realm="media-downloader"')
    return res.status(401).send('Authentication required.')
  })
}
// -------------------------------------------------------------------------

// API
app.use('/api/downloads', downloadsRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/tools', toolsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/stream', streamRouter)
app.get('/api/health', (req, res) => res.json({ ok: true }))

// Static SPA + client-side routing fallback
const webDist = path.join(__dirname, '..', 'web', 'dist')
app.use(express.static(webDist))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) next()
  })
})

async function start() {
  const downloadDir = settings.getDownloadDir()
  fs.mkdirSync(downloadDir, { recursive: true })
  db.init()

  const version = await ytdlp.getVersion()
  if (version) {
    console.log(`[media-downloader] yt-dlp version: ${version}`)
  } else {
    console.warn('[media-downloader] WARNING: yt-dlp not found or not runnable on PATH.')
  }

  const jsRuntime = await ytdlp.getJsRuntime()
  if (jsRuntime) {
    console.log(`[media-downloader] JS runtime: ${jsRuntime}`)
  } else {
    console.warn(
      '[media-downloader] WARNING: no JS runtime (deno) found — YouTube downloads may be unreliable. See README.'
    )
  }

  const cookies = ytdlp.cookiesMode()
  if (cookies) console.log(`[media-downloader] cookies: ${cookies}`)

  app.listen(PORT, () => {
    console.log(`[media-downloader] listening on http://0.0.0.0:${PORT}`)
    console.log(`[media-downloader] downloads dir: ${downloadDir}`)
    if (AUTH_USER && AUTH_PASS) {
      console.log('[media-downloader] HTTP Basic auth ENABLED')
    }
    if (adminProtected) {
      console.log('[media-downloader] admin panel: protected by ADMIN_KEY')
    } else {
      console.warn('[media-downloader] admin panel: OPEN (set ADMIN_KEY before deploying)')
    }
  })
}

// Only auto-start when run directly (e.g. `node server/index.js`); requiring
// this module (tests) gives access to the configured app without listening.
if (require.main === module) {
  start()
}

module.exports = { app, start }
