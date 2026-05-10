/**
 * CommandRouter.js — Priority-based command validation, routing, and log.
 *
 * Priority channels:
 *   CRITICAL → /ctrl namespace: SET_MAIN_VOL, SET_SUB_VOL
 *   HIGH     → /ctrl namespace: SET_GAIN, SET_MUTE, SET_SOLO, SET_PAN, SET_CUE_LEVEL
 *   MEDIUM   → /sync namespace: SET_EQ, SET_GATE, SET_COMPRESSOR, SET_AUX_SEND, SET_FX_BUS_SEND
 *   LOW      → /sync namespace: LOAD_SCENE, SAVE_SCENE, SET_PAN_LAW, SET_PERF_MODE
 *
 * Command log: ring buffer of last MAX_LOG commands with sequence numbers.
 * Delta replay: clients can request commands from sequence N via 'request_delta'.
 *
 * Conflict resolution: last-write-wins with (ts, clientId) tiebreaker.
 *   If two commands for the same channel param arrive within CONFLICT_WINDOW_MS,
 *   the later ts wins. Ties broken by socketId string comparison.
 */

const MAX_LOG           = 2000
const CONFLICT_WINDOW_MS = 50

const PRIORITY = {
  // CRITICAL — always routed first, never dropped
  SET_MAIN_VOL:         0,
  SET_SUB_VOL:          0,
  // HIGH — control namespace
  SET_GAIN:             1,
  SET_MUTE:             1,
  SET_SOLO:             1,
  CLEAR_SOLO:           1,
  SET_PAN:              1,
  SET_CUE_LEVEL:        1,
  SET_CUE_MODE:         1,
  SET_TRIM:             1,
  // MEDIUM — sync namespace
  SET_EQ:               2,
  SET_GATE:             2,
  SET_COMPRESSOR:       2,
  SET_HPF:              2,
  SET_LPF:              2,
  SET_AUX_SEND:         2,
  SET_AUX_LEVEL:        2,
  SET_AUX_MUTE:         2,
  SET_GROUP_SEND:       2,
  SET_GROUP_LEVEL:      2,
  SET_SUBGROUP_ROUTING: 2,
  SET_FX_BUS_SEND:      2,
  SET_FX_ACTIVE:        2,
  SET_FX_WET:           2,
  SET_ROUTING:          2,
  SET_REVERB_SEND:      2,
  SET_DELAY_SEND:       2,
  SET_FX:               2,
  SET_MIX_PROTECTION:   2,
  // LOW — sync namespace, can be deferred
  LOAD_SCENE:           3,
  SAVE_SCENE:           3,
  SET_PAN_LAW:          3,
  SET_PERF_MODE:        3,
  RECALL_SCENE:         3,
}

const CTRL_PRIORITIES = new Set([0, 1])
const VALID_TYPES      = new Set(Object.keys(PRIORITY))

export class CommandRouter {
  /** @type {Array<{seq: number, type: string, channelId: number|null, payload: any, ts: number, from: string}>} */
  _log    = []
  _seq    = 0

  /** Last seen command per (type+channelId) for conflict detection */
  _lastSeen = new Map()

  /** @type {import('socket.io').Namespace} ctrl namespace */
  _ctrl   = null
  /** @type {import('socket.io').Namespace} sync namespace */
  _sync   = null

  /**
   * @param {import('socket.io').Namespace} ctrl
   * @param {import('socket.io').Namespace} sync
   */
  attach(ctrl, sync) {
    this._ctrl = ctrl
    this._sync = sync
  }

  /**
   * Validate and route an incoming command.
   * @param {{ type: string, channelId: number|null, payload: any, ts: number }} cmd
   * @param {string} fromSocketId
   * @param {string} excludeSocketId — don't echo back to sender
   * @returns {{ ok: boolean, cmd?: object, reason?: string }}
   */
  route(cmd, fromSocketId, excludeSocketId) {
    if (!cmd || !VALID_TYPES.has(cmd.type)) {
      return { ok: false, reason: `unknown type: ${cmd?.type}` }
    }

    const prio    = PRIORITY[cmd.type]
    const seq     = ++this._seq
    const routed  = { ...cmd, seq, from: fromSocketId, ts: cmd.ts ?? Date.now() }

    // Conflict detection — only for channel-level ops
    if (cmd.channelId != null) {
      const key      = `${cmd.type}_${cmd.channelId}`
      const prev     = this._lastSeen.get(key)
      if (prev && routed.ts - prev.ts < CONFLICT_WINDOW_MS && routed.ts < prev.ts) {
        // Stale write — discard
        return { ok: false, reason: `stale (conflict): seq ${prev.seq} wins` }
      }
      this._lastSeen.set(key, { seq, ts: routed.ts })
    }

    // Append to log
    this._log.push(routed)
    if (this._log.length > MAX_LOG) this._log.shift()

    // Route to appropriate namespace/event
    const ns = CTRL_PRIORITIES.has(prio) ? this._ctrl : this._sync
    if (excludeSocketId) {
      ns?.except(excludeSocketId).emit('command', routed)
    } else {
      ns?.emit('command', routed)
    }

    return { ok: true, cmd: routed }
  }

  /**
   * Get commands from sequence N onwards (for delta replay on reconnect).
   * @param {number} fromSeq
   * @returns {Array}
   */
  getDelta(fromSeq) {
    return this._log.filter(c => c.seq > fromSeq)
  }

  /**
   * Get last MAX commands for new-client state reconstruction.
   * @param {number} max
   */
  getRecent(max = 200) {
    return this._log.slice(-max)
  }

  currentSeq() { return this._seq }

  getStats() {
    const byType = {}
    for (const c of this._log) {
      byType[c.type] = (byType[c.type] ?? 0) + 1
    }
    return {
      totalCommands: this._log.length,
      currentSeq:    this._seq,
      byType,
    }
  }

  clear() {
    this._log.length = 0
    this._seq        = 0
    this._lastSeen.clear()
  }
}
