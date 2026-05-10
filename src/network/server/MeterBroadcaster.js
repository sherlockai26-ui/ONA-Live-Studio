/**
 * MeterBroadcaster.js — Adaptive throttled meter stream broadcast.
 *
 * Receives raw meter data (from host engine) and broadcasts to subscribed clients.
 * Each client has its own:
 *   - meterFps:       requested fps (1–60, default 25)
 *   - visibleMeters:  Set of meter IDs to receive
 *   - nextTickMs:     timestamp of next scheduled packet
 *   - dropCount:      packets skipped because socket buffer was full
 *
 * Server drops meter packets for slow clients (socket.readyState !== 'open')
 * rather than queuing them, preventing memory growth.
 *
 * Adaptive throttling:
 *   If client's drop rate exceeds DROP_THRESHOLD_PERCENT → halve fps
 *   If client's drop rate is 0 for RECOVERY_TICKS → restore fps by 25%
 */

const DROP_THRESHOLD_PERCENT = 10
const RECOVERY_TICKS         = 20
const MIN_FPS                = 5
const MAX_FPS                = 60

export class MeterBroadcaster {
  /** @type {Map<string, ClientMeterState>} */
  _clients  = new Map()

  /** @type {import('socket.io').Namespace|null} */
  _metersNs = null

  /**
   * @param {import('socket.io').Namespace} metersNs
   */
  attach(metersNs) {
    this._metersNs = metersNs
  }

  /**
   * Register a client for meter broadcasts.
   * @param {string} socketId
   * @param {import('socket.io').Socket} socket
   */
  registerClient(socketId, socket) {
    this._clients.set(socketId, {
      socket,
      targetFps:     25,
      currentFps:    25,
      nextTickMs:    0,
      packetsSent:   0,
      packetsDropped: 0,
      cleanTicks:    0,
    })
  }

  updatePrefs(socketId, { fps, visible }) {
    const c = this._clients.get(socketId)
    if (!c) return
    if (fps) c.targetFps = c.currentFps = Math.max(MIN_FPS, Math.min(MAX_FPS, fps))
  }

  removeClient(socketId) {
    this._clients.delete(socketId)
  }

  /**
   * Broadcast meter data to all eligible clients.
   * Called by the host engine's metering callback.
   * @param {Record<string, number>} meterData
   */
  broadcast(meterData) {
    const now = Date.now()

    for (const [id, c] of this._clients) {
      if (now < c.nextTickMs) continue  // not due yet for this client

      // Schedule next tick BEFORE checking socket state
      c.nextTickMs = now + 1000 / c.currentFps

      // Check socket readiness — drop rather than queue
      if (!c.socket.connected) {
        c.packetsDropped++
        continue
      }

      c.socket.volatile.emit('meters', meterData)
      c.packetsSent++

      // Adaptive throttling
      const total     = c.packetsSent + c.packetsDropped
      const dropRate  = total > 20 ? (c.packetsDropped / total) * 100 : 0

      if (dropRate > DROP_THRESHOLD_PERCENT) {
        c.currentFps = Math.max(MIN_FPS, Math.floor(c.currentFps * 0.5))
        c.packetsDropped = 0
        c.packetsSent    = 0
        c.cleanTicks     = 0
        console.debug(`[MeterBcast] ${id.slice(0, 8)} fps throttled → ${c.currentFps}fps (drop ${dropRate.toFixed(0)}%)`)
      } else {
        c.cleanTicks++
        if (c.cleanTicks >= RECOVERY_TICKS && c.currentFps < c.targetFps) {
          c.currentFps = Math.min(c.targetFps, Math.ceil(c.currentFps * 1.25))
          c.cleanTicks = 0
          console.debug(`[MeterBcast] ${id.slice(0, 8)} fps recovered → ${c.currentFps}fps`)
        }
      }
    }
  }

  getStats() {
    const arr = [...this._clients.values()]
    return {
      clients:    arr.length,
      avgFps:     arr.length > 0 ? +(arr.reduce((a, c) => a + c.currentFps, 0) / arr.length).toFixed(1) : 0,
      totalSent:  arr.reduce((a, c) => a + c.packetsSent, 0),
      totalDropped: arr.reduce((a, c) => a + c.packetsDropped, 0),
    }
  }

  destroy() {
    this._clients.clear()
  }
}
