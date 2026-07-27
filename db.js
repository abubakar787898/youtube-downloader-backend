'use strict'

const path = require('path')
const fs = require('fs')
const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')

// Kept alongside the downloads so the job history persists with the volume.
const DB_PATH = process.env.DB_PATH || '/downloads/.jobs.json'

let db = null

function init() {
  const dir = path.dirname(DB_PATH)
  fs.mkdirSync(dir, { recursive: true })
  const adapter = new FileSync(DB_PATH)
  db = low(adapter)
  db.defaults({ jobs: [] }).write()
  return db
}

function ensure() {
  if (!db) init()
  return db
}

// Persist a brand-new job record (status 'queued').
function addJob(job) {
  ensure().get('jobs').push(job).write()
  return job
}

// Persist a record change. Only called for terminal status changes
// (done/error) — live progress is never written to disk.
function updateJob(id, patch) {
  ensure().get('jobs').find({ id }).assign(patch).write()
  return ensure().get('jobs').find({ id }).value() || null
}

function getJobs() {
  // Return a fresh array of plain objects (lowdb's lodash chain is live).
  return (ensure().get('jobs').value() || []).map((j) => ({ ...j }))
}

function getJob(id) {
  const j = ensure().get('jobs').find({ id }).value()
  return j ? { ...j } : null
}

function removeJob(id) {
  ensure().get('jobs').remove({ id }).write()
}

module.exports = { init, addJob, updateJob, getJobs, getJob, removeJob, DB_PATH }
