/**
 * ClientManager.js — Multi-client tracking with heartbeat and stale cleanup.
 *
 * Each connected socket gets a ClientRecord with:
 *   - lastSeq:     last command sequence the client has seen
 *   - lastPong:    timestamp of last pong (heartbeat)
 *   - meterFps:    client's requested meter frame rate (default 25)
 *   - visibleMeters: Set of meter IDs the client wants to receive
 *   - reconnects:  total reconnect count (for storm detection)
 *   - role:        'host' | 'remote' (host has full write access)
 *
 * Heartbeat: every PING_INTERVAL_MS, server pings all clients.
 * If a client doesn't pong within PONG_TIMEOUT_MS, it's disconnected.
 *
 * Reconnect storm protection: if a client reconnects >3× in 5s, it's
 * throttled: full-state sync delayed by STORM_BACKOFF_MS.
 */

const PING_INTERVAL_MS  = 5_000
const PONG_TIMEOUT_MS   = 10_000
const STORM_WINDOW_MS   = 5_000
const STORM_THRESHOLD   = 3
const STORM_BACKOFF_MS  = 2_000

export class ClientManager {
  /** @type {Map<string, ClientRecord>} */
  _clients = new Map()

  /** @type {Map<string, number[]>} socketId → reconnect timestamps */
  _reconnects = new Map()

  _pingTimer = null
  _io        = null

  /**
   * @param {import('socket.io').Server} io
   */
  attach(io) {
    this._io = io
    this._pingTimer = setInterval(() => this._pingAll(), PING_INTERVAL_MS)
  }

  /**
   * Register a new socket connection.
   * @param {import('socket.io').Socket} socket
   * @param {'host'|'remote'} role
   */
  register(socket, role = 'remote') {
    this._clients.set(socket.id, {
      id:             socket.id,
      role,
      lastSeq:        0,
      lastPong:       Date.now(),
      meterFps:       25,
      visibleMeters:  new Set(['_main', '_sub']),
      joinedAt:       Date.now(),
      reconnects:     0,
    })

    socket.on('pong_ack', () => {
      const c = this._clients.get(socket.id)
      if (c) c.lastPong = Date.now()
    })

    socket.on('set_meter_prefs', ({ fps, visible }) => {
      const c = this._clients.get(socket.id)
      if (!c) return
      if (fps && Number.isFinite(fps)) c.meterFps = Math.max(1, Math.min(60, fps))
      if (Array.isArray(visible))      c.visibleMeters = new Set(visible)
    })

    socket.on('disconnect', () => this._clients.delete(socket.id))
  }

  /**
   * Returns true if the client is reconnecting and should get a storm backoff.
   * @param {string} socketId
   * @returns {number} delay in ms (0 if no storm)
   */
  checkReconnectStorm(socketId) {
    const now  = Date.now()
    const list = this._reconnects.get(socketId) ?? []
    const recent = list.filter(t => now - t < STORM_WINDOW_MS)
    recent.push(now)
    this._reconnects.set(socketId, recent)
    return recent.length >= STORM_THRESHOLD ? STORM_BACKOFF_MS : 0
  }

  get(socketId) { return this._clients.get(socketId) }

  getAll() { return [...this._clients.values()] }

  count() { return this._clients.size }

  /** @param {string} id */
  updateSeq(id, seq) {
    const c = this._clients.get(id)
    if (c && seq > c.lastSeq) c.lastSeq = seq
  }

  _pingAll() {
    const now = Date.now()
    for (const [id, c] of this._clients) {
      if (now - c.lastPong > PONG_TIMEOUT_MS) {
        console.warn(`[ClientMgr] stale client ${id.slice(0, 8)} — disconnecting`)
        this._io?.sockets.sockets.get(id)?.disconnect(true)
        this._clients.delete(id)
      } else {
        this._io?.to(id).emit('ping_check', { ts: now })
      }
    }
  }

  getStats() {
    const clients = [...this._clients.values()]
    return {
      total:   clients.length,
      hosts:   clients.filter(c => c.role === 'host').length,
      remotes: clients.filter(c => c.role === 'remote').length,
      avgFps:  clients.length > 0
        ? +(clients.reduce((a, c) => a + c.meterFps, 0) / clients.length).toFixed(1)
        : 0,
    }
  }

  destroy() {
    clearInterval(this._pingTimer)
    this._clients.clear()
    this._reconnects.clear()
  }
}
