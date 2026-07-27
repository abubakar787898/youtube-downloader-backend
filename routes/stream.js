'use strict'

const express = require('express')
const router = express.Router()

// Connected SSE clients (Express response objects).
const clients = new Set()

// Broadcast a JSON payload to every connected browser.
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
    try {
      res.write(data)
    } catch (e) {
      // Drop dead connections silently; 'close' handler cleans the Set.
    }
  }
}

// GET /api/stream  — Server-Sent Events stream of live job updates.
router.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx etc.) so events flush immediately.
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  // Hint the browser's reconnect interval and open the stream.
  res.write('retry: 3000\n\n')
  res.write(': connected\n\n')
  clients.add(res)

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch (e) {
      /* ignore */
    }
  }, 15000)

  req.on('close', () => {
    clearInterval(heartbeat)
    clients.delete(res)
  })
})

module.exports = { router, broadcast, clients }
