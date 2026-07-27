'use strict'

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const settings = require('./settings')

const YT_DLP = process.env.YTDLP_PATH || 'yt-dlp'

// Output template, resolved live so a download-folder change in Settings takes
// effect immediately. Title is truncated to 150 chars because some sites
// (Facebook reels) use the whole description as the title, which otherwise
// blows past the OS filename limit (NTFS 255/component, Windows 260/path);
// applied at render time so it also covers the merge step.
function outTemplate() {
  return path.join(settings.getDownloadDir(), '%(title).150s.%(ext)s')
}

// Progress is streamed as: "  42.1%|  1.23MiB/s|00:12" (one per line via --newline)
const PROGRESS_RE = /^([\d.]+)%\|([^|]*)\|(.*)$/

// Parse one progress line into { percent, speed, eta } or null if it isn't one.
function parseProgressLine(line) {
  const s = String(line).trim()
  const m = s.match(PROGRESS_RE)
  if (!m) return null
  const percent = parseFloat(m[1])
  if (Number.isNaN(percent)) return null
  const speed = (m[2] || '').trim()
  const eta = (m[3] || '').trim()
  return {
    percent,
    speed: speed && speed !== 'Unknown' ? speed : null,
    eta: eta && eta !== 'Unknown' ? eta : null,
  }
}

// Optional cookies for login-gated sites (Instagram/Facebook, age-restricted, etc.)
// COOKIES_FILE takes precedence (works in Docker via a mounted file);
// COOKIES_FROM_BROWSER (e.g. "chrome", "edge", "firefox") is handy locally.
function cookieArgs() {
  const file = (process.env.COOKIES_FILE || '').trim()
  if (file) return ['--cookies', file]
  const browser = (process.env.COOKIES_FROM_BROWSER || '').trim()
  if (browser) return ['--cookies-from-browser', browser]

  const dbFile = (settings.getAll().cookiesFile || '').trim()
  if (dbFile) return ['--cookies', dbFile]
  const dbBrowser = (settings.getAll().cookiesFromBrowser || '').trim()
  if (dbBrowser && dbBrowser !== 'none') return ['--cookies-from-browser', dbBrowser]

  return []
}

function cookiesMode() {
  const file = (process.env.COOKIES_FILE || '').trim()
  if (file) return `env file (${file})`
  const browser = (process.env.COOKIES_FROM_BROWSER || '').trim()
  if (browser) return `env browser (${browser})`

  const dbFile = (settings.getAll().cookiesFile || '').trim()
  if (dbFile) return `file (${dbFile})`
  const dbBrowser = (settings.getAll().cookiesFromBrowser || '').trim()
  if (dbBrowser && dbBrowser !== 'none') return `browser (${dbBrowser})`

  return null
}

function buildArgs(format, height) {
  const progress = [
    '--newline',
    '--progress-template',
    '%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    // Some sites (e.g. Facebook reels) use the whole description as the title;
    // cap the filename so it never exceeds the OS path limit (esp. Windows 260).
    '--trim-filenames',
    '150',
    '-o',
    outTemplate(),
  ]

  if (format === 'mp3') {
    return [
      '--no-playlist',
      ...cookieArgs(),
      '-x',
      '--audio-format',
      'mp3',
      '--embed-thumbnail',
      '--embed-metadata',
      ...progress,
    ]
  }

  // mp4 — cap to the requested height when given, else best.
  const h = Number.isInteger(height) && height > 0 ? height : null
  const selector = h
    ? `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`
    : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'

  return ['--no-playlist', ...cookieArgs(), '-f', selector, '--merge-output-format', 'mp4', ...progress]
}

// Strip directory, extension and any ".f137" yt-dlp format fragment to get a
// human-friendly title from a destination/merge filename.
function titleFromPath(p) {
  let base = path.basename(p.trim().replace(/^"|"$/g, ''))
  base = base.replace(/\.[^.]+$/, '') // extension
  base = base.replace(/\.f\d+$/, '') // format fragment (video/audio stream id)
  return base || null
}

function newestFileIn(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => !f.startsWith('.'))
      .map((f) => path.join(dir, f))
      .filter((p) => {
        try {
          return fs.statSync(p).isFile()
        } catch (e) {
          return false
        }
      })
    if (!files.length) return null
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    return files[0]
  } catch (e) {
    return null
  }
}

/**
 * Run a download. Calls onProgress({ percent, speed, eta, title }) on each tick.
 * Resolves with { filename, filepath } on success; rejects with an stderr tail
 * (or a clear "yt-dlp not found" message) on failure.
 */
function runDownload(job, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [...buildArgs(job.format, job.height), job.url]
    const child = spawn(YT_DLP, args, { windowsHide: true })

    let finalFile = null
    let currentTitle = null
    let stderrTail = ''
    let stdoutBuf = ''

    function rememberFile(raw, isFinal) {
      if (!raw) return
      const cleaned = raw.trim().replace(/^"|"$/g, '')
      if (isFinal) finalFile = cleaned
      const t = titleFromPath(cleaned)
      if (t) currentTitle = t
    }

    function handleLine(line) {
      const s = line.trim()
      if (!s) return

      const prog = parseProgressLine(s)
      if (prog) {
        onProgress({ ...prog, title: currentTitle })
        return
      }

      let t
      if ((t = s.match(/\[download\] Destination:\s*(.+)$/))) rememberFile(t[1], false)
      else if ((t = s.match(/\[Merger\] Merging formats into "(.+)"\s*$/))) rememberFile(t[1], true)
      else if ((t = s.match(/\[ExtractAudio\] Destination:\s*(.+)$/))) rememberFile(t[1], true)
      else if ((t = s.match(/\[download\]\s+(.+?) has already been downloaded/))) rememberFile(t[1], true)
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString()
      let idx
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx)
        stdoutBuf = stdoutBuf.slice(idx + 1)
        handleLine(line)
      }
    })

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000)
    })

    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        return reject(
          new Error('yt-dlp not found in image (the yt-dlp binary must be installed and on PATH)')
        )
      }
      reject(err)
    })

    child.on('close', (code) => {
      if (stdoutBuf) handleLine(stdoutBuf)

      if (code === 0) {
        const dir = settings.getDownloadDir()
        let filepath = finalFile
        if (filepath && !path.isAbsolute(filepath)) {
          filepath = path.join(dir, filepath)
        }
        if (!filepath || !fs.existsSync(filepath)) {
          filepath = newestFileIn(dir) || filepath
        }
        const filename = filepath ? path.basename(filepath) : null
        return resolve({ filename, filepath, title: currentTitle })
      }

      const tail = stderrTail
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-6)
        .join('\n')
      reject(new Error(tail || `yt-dlp exited with code ${code}`))
    })
  })
}

function commandVersion(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { windowsHide: true })
      let out = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.on('error', () => resolve(null))
      child.on('close', (code) => resolve(code === 0 ? out.trim() : null))
    } catch (e) {
      resolve(null)
    }
  })
}

function getVersion() {
  return commandVersion(YT_DLP, ['--version'])
}

// yt-dlp (2025+) needs a JS runtime (Deno) for reliable YouTube extraction.
// Returns the first line of `deno --version`, or null if not found.
function getJsRuntime() {
  return commandVersion('deno', ['--version']).then((v) => (v ? v.split('\n')[0].trim() : null))
}

function fmtDuration(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return null
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

// Common quality ladder offered to the user (filtered to what's available).
const QUALITY_LADDER = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144]

// Turn yt-dlp's full -J payload into a compact summary for the UI.
function summarizeInfo(info) {
  let maxHeight = 0
  for (const f of info.formats || []) {
    if (f && f.vcodec && f.vcodec !== 'none' && typeof f.height === 'number' && f.height > maxHeight) {
      maxHeight = f.height
    }
  }

  let qualities = QUALITY_LADDER.filter((h) => h <= maxHeight).map((h) => ({
    label: `MP4 ${h}p`,
    format: 'mp4',
    height: h,
  }))
  if (!qualities.length) {
    qualities = [{ label: 'MP4 (best)', format: 'mp4', height: null }]
  }
  qualities.push({ label: 'MP3 (audio only)', format: 'mp3', height: null })

  let thumbnail = info.thumbnail || null
  if (!thumbnail && Array.isArray(info.thumbnails)) {
    const withUrl = info.thumbnails.filter((t) => t && t.url)
    if (withUrl.length) thumbnail = withUrl[withUrl.length - 1].url
  }

  return {
    title: info.title || null,
    uploader: info.uploader || info.channel || info.uploader_id || null,
    duration: typeof info.duration === 'number' ? info.duration : null,
    durationText: fmtDuration(info.duration),
    thumbnail,
    extractor: info.extractor_key || info.extractor || null,
    isLive: !!info.is_live,
    qualities,
  }
}

// Resolve metadata + available qualities for a URL (no download).
function getInfo(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP, ['-J', '--no-playlist', ...cookieArgs(), '--no-warnings', url], {
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-4000)
    })
    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        return reject(new Error('yt-dlp not found in image (the yt-dlp binary must be installed and on PATH)'))
      }
      reject(e)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = err
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-4)
          .join('\n')
        return reject(new Error(tail || `Could not fetch info (yt-dlp exit ${code}).`))
      }
      let info
      try {
        info = JSON.parse(out)
      } catch (e) {
        return reject(new Error('Could not parse video info.'))
      }
      resolve(summarizeInfo(info))
    })
  })
}

module.exports = {
  runDownload,
  getInfo,
  getVersion,
  getJsRuntime,
  cookiesMode,
  // exported for unit tests:
  buildArgs,
  parseProgressLine,
  titleFromPath,
}
