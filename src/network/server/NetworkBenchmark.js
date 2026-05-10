/**
 * NetworkBenchmark.js — Server-side network performance tracking.
 *
 * Measures:
 *   - Round-trip latency per client (ping→pong_ack timestamps)
 *   - Command throughput (commands/s per namespace)
 *   - Meter packet drop rate per client
 *   - Multi-client stress: simultaneous command injection
 *
 * Exposed at GET /api/bench — returns latest metrics snapshot.
 * Console API: __ONA_NET_BENCH (exposed on NetworkServer startup).
 */

export class NetworkBenchmark {
  /** @type {Map<string, number[]>} socketId → RTT samples (ms) */
  _rttSamples = new Map()

  _ctrlCmds   = 0
  _syncCmds   = 0
  _meterPkts  = 0
  _startTime  = Date.now()

  /** @param {import('express').Application} app */
  attachRoutes(app) {
    app.get('/api/bench', (_req, res) => {
      res.json(this.getSnapshot())
    })
  }

  recordRTT(socketId, rttMs) {
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 5000) return
    let arr = this._rttSamples.get(socketId)
    if (!arr) { arr = []; this._rttSamples.set(socketId, arr) }
    arr.push(rttMs)
    if (arr.length > 100) arr.shift()
  }

  recordCtrlCmd()  { this._ctrlCmds++ }
  recordSyncCmd()  { this._syncCmds++ }
  recordMeterPkt() { this._meterPkts++ }

  getClientRTT(socketId) {
    const arr = this._rttSamples.get(socketId) ?? []
    if (arr.length === 0) return { avg: -1, p95: -1, samples: 0 }
    const sorted = [...arr].sort((a, b) => a - b)
    const avg    = arr.reduce((a, b) => a + b, 0) / arr.length
    const p95    = sorted[Math.floor(sorted.length * 0.95)]
    return { avg: +avg.toFixed(1), p95: +p95.toFixed(1), samples: arr.length }
  }

  getSnapshot() {
    const elapsed = (Date.now() - this._startTime) / 1000
    const rttAll  = []
    for (const [, arr] of this._rttSamples) rttAll.push(...arr)

    const avgRtt = rttAll.length > 0
      ? +(rttAll.reduce((a, b) => a + b, 0) / rttAll.length).toFixed(1)
      : -1

    const sorted = [...rttAll].sort((a, b) => a - b)
    const p95Rtt = sorted.length > 0
      ? +sorted[Math.floor(sorted.length * 0.95)].toFixed(1)
      : -1

    return {
      uptime:         +elapsed.toFixed(0),
      ctrlCmds:       this._ctrlCmds,
      syncCmds:       this._syncCmds,
      meterPackets:   this._meterPkts,
      ctrlCmdsPerSec: +(this._ctrlCmds / Math.max(1, elapsed)).toFixed(1),
      syncCmdsPerSec: +(this._syncCmds / Math.max(1, elapsed)).toFixed(1),
      avgRttMs:       avgRtt,
      p95RttMs:       p95Rtt,
      rttSamples:     rttAll.length,
    }
  }

  reset() {
    this._rttSamples.clear()
    this._ctrlCmds  = 0
    this._syncCmds  = 0
    this._meterPkts = 0
    this._startTime = Date.now()
  }
}
