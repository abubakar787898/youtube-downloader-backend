'use strict'

const db = require('./db')
const ytdlp = require('./ytdlp')
const { broadcast } = require('./routes/stream')

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT, 10) > 0
  ? parseInt(process.env.MAX_CONCURRENT, 10)
  : 3

// In-memory live progress, keyed by job id. Never persisted to disk.
// shape: { status, percent, speed, eta, title, filename, error }
const live = new Map()

// --- tiny inline concurrency limiter -------------------------------------
let active = 0
const waiting = []

function schedule() {
  while (active < MAX_CONCURRENT && waiting.length) {
    const task = waiting.shift()
    active += 1
    task().finally(() => {
      active -= 1
      schedule()
    })
  }
}
// -------------------------------------------------------------------------

function setLive(id, patch) {
  const next = { ...(live.get(id) || {}), ...patch }
  live.set(id, next)
  return next
}

function emit(id) {
  const v = live.get(id) || {}
  broadcast({
    id,
    status: v.status || null,
    percent: typeof v.percent === 'number' ? v.percent : null,
    speed: v.speed || null,
    eta: v.eta || null,
    title: v.title || null,
    filename: v.filename || null,
    error: v.error || null,
  })
}

function getLiveProgress() {
  const out = {}
  for (const [id, v] of live.entries()) out[id] = v
  return out
}

function getLiveProgressFor(id) {
  return live.get(id) || null
}

function clearLive(id) {
  live.delete(id)
}

function stripExt(name) {
  return name ? name.replace(/\.[^.]+$/, '') : name
}

/**
 * Queue a job for download. The DB record (status 'queued') must already exist.
 * Drives the in-memory live map + SSE broadcaster, and persists only the
 * terminal (done/error) record back to lowdb.
 */
function enqueue(job) {
  setLive(job.id, {
    status: 'queued',
    percent: 0,
    speed: null,
    eta: null,
    title: job.title || null,
    filename: null,
    error: null,
  })
  emit(job.id)

  const task = () => {
    setLive(job.id, { status: 'downloading' })
    emit(job.id)

    return ytdlp.runDownload(job, (p) => {
      const patch = {
        status: 'downloading',
        percent: p.percent,
        speed: p.speed,
        eta: p.eta,
      }
      if (p.title) patch.title = p.title
      setLive(job.id, patch)
      emit(job.id)
    })
      .then((res) => {
        const finishedAt = new Date().toISOString()
        const title =
          (live.get(job.id) || {}).title ||
          res.title ||
          (res.filename ? stripExt(res.filename) : null)
        db.updateJob(job.id, {
          status: 'done',
          title,
          filename: res.filename,
          filepath: res.filepath,
          error: null,
          finishedAt,
        })
        setLive(job.id, {
          status: 'done',
          percent: 100,
          speed: null,
          eta: null,
          title,
          filename: res.filename,
        })
        emit(job.id)
      })
      .catch((err) => {
        const finishedAt = new Date().toISOString()
        const message = String((err && err.message) || err || 'Download failed')
        db.updateJob(job.id, { status: 'error', error: message, finishedAt })
        setLive(job.id, { status: 'error', error: message })
        emit(job.id)
      })
  }

  waiting.push(task)
  schedule()
  return job
}

module.exports = {
  enqueue,
  getLiveProgress,
  getLiveProgressFor,
  clearLive,
  MAX_CONCURRENT,
}
