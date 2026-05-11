/**
 * NetworkServer.js — Professional low-latency Socket.IO server for ONA Live Studio.
 *
 * Replaces src/server/index.js with a production-grade multi-namespace server.
 *
 * Namespace architecture:
 *   /ctrl    — control commands (faders, mute, solo) — always-first, no queuing
 *   /sync    — state commands (EQ, routing, scenes) — deferred-ok
 *   /meters  — metering stream — volatile, dropped when client is slow
 *
 * Features:
 *   - StateMirror: one full-state packet on connect, no 200-command replay
 *   - Delta sync: reconnecting clients get only missed commands (by sequence)
 *   - Adaptive metering: per-client fps based on socket buffer health
 *   - Heartbeat: 5s ping/pong, auto-disconnect stale clients
 *   - Reconnect recovery: queued commands replayed on reconnect
 *   - Discovery: HTTP /api/discover + UDP broadcast on LAN port 3001
 *   - Hotspot ready: binds to 0.0.0.0, announces all local IPs
 *   - Backwards compatible: legacy /command event still accepted on default ns
 *
 * Usage:
 *   node src/network/server/NetworkServer.js
 *   -- or require/import from electron/main.cjs --
 */

import express          from 'express'
import http             from 'http'
import { Server }       from 'socket.io'
import { ClientManager } from './ClientManager.js'
import { CommandRouter } from './CommandRouter.js'
import { DeltaStateSync } from './DeltaStateSync.js'
import { MeterBroadcaster } from './MeterBroadcaster.js'
import { DiscoveryServer } from './DiscoveryServer.js'
import { NetworkBenchmark } from './NetworkBenchmark.js'

// ── Express + Socket.IO setup ─────────────────────────────────────────────────

const app    = express()
const server = http.createServer(app)
app.use(express.json())

// CORS — allow Electron renderer (localhost:5173) and LAN remote clients to reach HTTP routes.
// Cross-Origin-Resource-Policy: cross-origin is also set so that Chromium renderers with
// COEP enabled can load these resources (required when SAB cross-origin isolation is active).
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return }
  next()
})

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 5_000,
  pingTimeout:  10_000,
  // Disable per-message deflate — reduces CPU on hot meter path
  perMessageDeflate: false,
  // Prefer WebSocket — avoid HTTP long-poll overhead
  transports: ['websocket', 'polling'],
})

// ── Namespaces ────────────────────────────────────────────────────────────────

const ctrlNs   = io.of('/ctrl')    // control commands
const syncNs   = io.of('/sync')    // state sync commands
const metersNs = io.of('/meters')  // metering stream

// ── Core modules ─────────────────────────────────────────────────────────────

const clientMgr  = new ClientManager()
const cmdRouter  = new CommandRouter()
const deltaSync  = new DeltaStateSync()
const meterBcast = new MeterBroadcaster()
const discovery  = new DiscoveryServer()
const bench      = new NetworkBenchmark()

clientMgr.attach(io)
cmdRouter.attach(ctrlNs, syncNs)
meterBcast.attach(metersNs)

// ── Helper: send full sync to a new client ────────────────────────────────────

function sendFullSync(socket, ns = 'ctrl') {
  const full    = deltaSync.getFullState()
  const recent  = cmdRouter.getRecent(100)
  socket.emit('state_full', full)
  if (recent.length > 0) socket.emit('command_log', recent)
  console.log(`[NET] full sync → ${socket.id.slice(0, 8)} (${full.state ? Object.keys(full.state).length : 0} paths, ${recent.length} commands)`)
}

// ── /ctrl namespace ───────────────────────────────────────────────────────────

ctrlNs.on('connection', (socket) => {
  const role = socket.handshake.auth?.role ?? 'remote'
  clientMgr.register(socket, role)
  console.log(`[NET /ctrl] ${role} ${socket.id.slice(0, 8)} connected (total: ${clientMgr.count()})`)

  // Send full state — instant reconnect without replaying 2000 commands
  const storm = clientMgr.checkReconnectStorm(socket.id)
  if (storm > 0) {
    setTimeout(() => sendFullSync(socket, 'ctrl'), storm)
  } else {
    sendFullSync(socket, 'ctrl')
  }

  socket.on('command', (cmd) => {
    const { ok, cmd: routed, reason } = cmdRouter.route(cmd, socket.id, socket.id)
    if (!ok) { socket.emit('command_error', { reason }); return }
    deltaSync.apply(routed)
    bench.recordCtrlCmd()
    clientMgr.updateSeq(socket.id, routed.seq)
    // Echo back to sender so UI gets confirmed seq
    socket.emit('command_ack', { seq: routed.seq, ts: Date.now() })
  })

  socket.on('request_delta', ({ fromSeq }) => {
    const seq = fromSeq ?? 0
    // If the client's last known seq precedes our oldest log entry the delta is incomplete —
    // tell the client to request a full state sync instead of replaying a partial window.
    if (seq > 0 && seq < cmdRouter.oldestSeq()) {
      socket.emit('full_sync_required', { reason: 'delta_window_expired', fromSeq: seq, oldestSeq: cmdRouter.oldestSeq() })
      console.warn(`[NET] full_sync_required → ${socket.id.slice(0, 8)} (fromSeq ${seq} < oldest ${cmdRouter.oldestSeq()})`)
      return
    }
    const delta = cmdRouter.getDelta(seq)
    socket.emit('command_log', delta)
    console.log(`[NET] delta ${seq}→${cmdRouter.currentSeq()} (${delta.length} commands) → ${socket.id.slice(0, 8)}`)
  })

  socket.on('request_full_sync', () => {
    console.log(`[NET] request_full_sync from ${socket.id.slice(0, 8)}`)
    sendFullSync(socket, 'ctrl')
  })

  socket.on('ping_reply', ({ ts }) => {
    const rtt = Date.now() - ts
    bench.recordRTT(socket.id, rtt)
    const c = clientMgr.get(socket.id)
    if (c) c.lastPong = Date.now()
  })

  socket.on('disconnect', () => {
    console.log(`[NET /ctrl] ${socket.id.slice(0, 8)} disconnected`)
  })
})

// ── /sync namespace ───────────────────────────────────────────────────────────

syncNs.on('connection', (socket) => {
  socket.on('command', (cmd) => {
    const { ok, cmd: routed, reason } = cmdRouter.route(cmd, socket.id, socket.id)
    if (!ok) { socket.emit('command_error', { reason }); return }
    deltaSync.apply(routed)
    bench.recordSyncCmd()
    clientMgr.updateSeq(socket.id, routed.seq)
    socket.emit('command_ack', { seq: routed.seq })
  })
})

// ── /meters namespace ─────────────────────────────────────────────────────────

metersNs.on('connection', (socket) => {
  meterBcast.registerClient(socket.id, socket)

  socket.on('set_meter_prefs', (prefs) => {
    meterBcast.updatePrefs(socket.id, prefs)
    const c = clientMgr.get(socket.id)
    if (c && prefs.fps) c.meterFps = prefs.fps
  })

  socket.on('disconnect', () => {
    meterBcast.removeClient(socket.id)
  })
})

// ── Legacy default namespace (backwards compat with Paso 5 clients) ───────────

io.on('connection', (socket) => {
  const recent = cmdRouter.getRecent(100)
  if (recent.length > 0) socket.emit('command_log', recent)

  socket.on('command', (cmd) => {
    const { ok, cmd: routed } = cmdRouter.route(cmd, socket.id, socket.id)
    if (ok) { deltaSync.apply(routed); bench.recordCtrlCmd() }
  })

  socket.on('request_log', () => {
    socket.emit('command_log', cmdRouter.getRecent(100))
  })

  socket.on('disconnect', () => {
    console.log(`[NET] legacy client disconnected: ${socket.id.slice(0, 8)}`)
  })
})

// ── Host meter injection API ──────────────────────────────────────────────────
// Called by Electron/main to forward meter data from AudioEngineSingleton

/**
 * Inject meter data from the host engine into the broadcast stream.
 * @param {Record<string, number>} meterData
 */
export function injectMeterData(meterData) {
  bench.recordMeterPkt()
  meterBcast.broadcast(meterData)
}

/**
 * Inject a command generated by the host (e.g., from MIDI control surface).
 * Broadcasts to all remote clients without echo.
 */
export function injectHostCommand(type, channelId, payload) {
  cmdRouter.route({ type, channelId, payload, ts: Date.now() }, 'host', null)
}

// ── Discovery + HTTP routes ────────────────────────────────────────────────────

bench.attachRoutes(app)
discovery.attach(app, clientMgr)

app.get('/api/stats', (_req, res) => {
  res.json({
    clients:  clientMgr.getStats(),
    commands: cmdRouter.getStats(),
    state:    deltaSync.getStats(),
    meters:   meterBcast.getStats(),
    bench:    bench.getSnapshot(),
  })
})

// ── Server start ──────────────────────────────────────────────────────────────

const PORT = process.env.ONA_PORT ? parseInt(process.env.ONA_PORT) : 3000

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[NET] ONA NetworkServer v${16} — port ${PORT}`)
  console.log('[NET] Namespaces: /ctrl  /sync  /meters')
  console.log('[NET] Discovery:  GET /api/discover  |  UDP :3001')
  console.log('[NET] Stats:      GET /api/stats')
})

export { app, server, io, clientMgr, cmdRouter, deltaSync, meterBcast, bench }
