'use strict'

const fs = require('fs')
const path = require('path')
const { PLATFORM_KEYS } = require('./platforms')

// Persist runtime settings next to the job DB (so they live in the volume).
const DB_PATH = process.env.DB_PATH || '/downloads/.jobs.json'
const SETTINGS_PATH = process.env.SETTINGS_PATH || path.join(path.dirname(DB_PATH), '.settings.json')

let cache = null

function load() {
  try {
    cache = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) || {}
  } catch (e) {
    cache = {}
  }
  return cache
}

function getAll() {
  return cache || load()
}

function setAll(patch) {
  const next = { ...getAll(), ...patch }
  cache = next
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2))
  return next
}

// The default (env or built-in) download dir, used when nothing is configured.
function defaultDownloadDir() {
  return process.env.DOWNLOAD_DIR || '/downloads'
}

// The effective download dir: a user-set folder wins, else the default.
function getDownloadDir() {
  const dir = (getAll().downloadDir || '').trim()
  return dir || defaultDownloadDir()
}

// Whether visitors are allowed to start downloads (admin can toggle). Default on.
function getDownloadsEnabled() {
  const v = getAll().downloadsEnabled
  return v === undefined || v === null ? true : !!v
}

// Per-platform enable flags, defaulting every platform to enabled.
function getPlatforms() {
  const stored = getAll().platforms || {}
  const out = {}
  for (const key of PLATFORM_KEYS) {
    out[key] = stored[key] === undefined || stored[key] === null ? true : !!stored[key]
  }
  return out
}

function isPlatformEnabled(key) {
  return getPlatforms()[key] !== false
}

module.exports = {
  getAll,
  setAll,
  getDownloadDir,
  defaultDownloadDir,
  getDownloadsEnabled,
  getPlatforms,
  isPlatformEnabled,
  SETTINGS_PATH,
}
