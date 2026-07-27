'use strict'

// Platforms that can be individually enabled/disabled by the admin.
// 'other' covers every site that isn't one of the named four.
const PLATFORM_KEYS = ['youtube', 'facebook', 'instagram', 'tiktok', 'other']

const LABELS = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  other: 'Other sites',
}

// Map a URL to one of the platform keys above.
function detectPlatform(url) {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch (e) {
    return 'other'
  }
  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be' || host.endsWith('.youtu.be')) {
    return 'youtube'
  }
  if (host.includes('facebook.com') || host.includes('fb.watch') || host.includes('fb.com')) {
    return 'facebook'
  }
  if (host.includes('instagram.com')) return 'instagram'
  if (host.includes('tiktok.com')) return 'tiktok'
  return 'other'
}

module.exports = { PLATFORM_KEYS, LABELS, detectPlatform }
