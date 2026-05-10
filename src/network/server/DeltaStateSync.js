/**
 * DeltaStateSync.js — Server-side state mirror + delta computation.
 *
 * Problem: the stateless command-log approach (Paso 5) requires replaying
 * up to 2000 commands on reconnect. For 96-ch sessions, this is expensive.
 *
 * Solution: server maintains a flat state mirror (path → value).
 * New clients get the full mirror as one 'state_full' packet.
 * Reconnecting clients get only changes since their last sequence.
 *
 * State paths (flat):
 *   "ch.1.gain"          → number
 *   "ch.1.muted"         → boolean
 *   "ch.1.pan"           → number
 *   "ch.1.eq.0.gain"     → number
 *   "main.volume"        → number
 *   "sub.volume"         → number
 *   "scene.active"       → string
 *
 * Delta packet: { seq, patches: [{ path, value }] }
 * Full state:   { seq, state: Record<string, any> }
 *
 * Command → state path mapping:
 *   Each command type defines which state paths it affects.
 */

const CMD_TO_PATHS = {
  SET_GAIN:        (cmd) => [[`ch.${cmd.channelId}.gain`,    cmd.payload.volume],
                              [`ch.${cmd.channelId}.muted`,   cmd.payload.muted]],
  SET_MUTE:        (cmd) => [[`ch.${cmd.channelId}.muted`,   cmd.payload.muted]],
  SET_PAN:         (cmd) => [[`ch.${cmd.channelId}.pan`,     cmd.payload.pan]],
  SET_ROUTING:     (cmd) => [[`ch.${cmd.channelId}.toMain`,  cmd.payload.toMain],
                              [`ch.${cmd.channelId}.toSub`,   cmd.payload.toSub]],
  SET_HPF:         (cmd) => [[`ch.${cmd.channelId}.hpf.active`, cmd.payload.active],
                              [`ch.${cmd.channelId}.hpf.freq`,   cmd.payload.freq]],
  SET_LPF:         (cmd) => [[`ch.${cmd.channelId}.lpf.active`, cmd.payload.active],
                              [`ch.${cmd.channelId}.lpf.freq`,   cmd.payload.freq]],
  SET_GATE:        (cmd) => [[`ch.${cmd.channelId}.gate`,    cmd.payload]],
  SET_COMPRESSOR:  (cmd) => [[`ch.${cmd.channelId}.comp`,    cmd.payload]],
  SET_EQ:          (cmd) => [[`ch.${cmd.channelId}.eq.${cmd.payload.bandIndex}`, cmd.payload]],
  SET_REVERB_SEND: (cmd) => [[`ch.${cmd.channelId}.reverbSend`, cmd.payload.value]],
  SET_DELAY_SEND:  (cmd) => [[`ch.${cmd.channelId}.delaySend`,  cmd.payload.value]],
  SET_AUX_SEND:    (cmd) => [[`ch.${cmd.channelId}.aux.${cmd.payload.auxId}`, cmd.payload]],
  SET_AUX_LEVEL:   (cmd) => [[`aux.${cmd.payload.id}.level`, cmd.payload.level]],
  SET_AUX_MUTE:    (cmd) => [[`aux.${cmd.payload.id}.muted`, cmd.payload.muted]],
  SET_FX_BUS_SEND: (cmd) => [[`ch.${cmd.channelId}.fxSend.${cmd.payload.busId}`, cmd.payload]],
  SET_FX_ACTIVE:   (cmd) => [[`fx.${cmd.payload.busId}.active`,   cmd.payload.active]],
  SET_FX_WET:      (cmd) => [[`fx.${cmd.payload.busId}.wetLevel`, cmd.payload.level]],
  SET_MAIN_VOL:    (cmd) => [['main.volume', cmd.payload.volume]],
  SET_SUB_VOL:     (cmd) => [['sub.volume',  cmd.payload.volume]],
  SET_TRIM:        (cmd) => [[`ch.${cmd.channelId}.trim`, cmd.payload.db]],
  SET_PAN_LAW:     (cmd) => [['mix.panLaw',   cmd.payload.mode]],
  SET_PERF_MODE:   (cmd) => [['perf.mode',    cmd.payload.mode]],
  LOAD_SCENE:      (cmd) => [['scene.active', cmd.payload.name]],
  SAVE_SCENE:      (cmd) => [['scene.active', cmd.payload.name]],
  SET_SOLO:        (cmd) => [[`ch.${cmd.channelId}.soloed`, cmd.payload.soloed]],
  CLEAR_SOLO:      ()    => [['solo.all', false]],
  SET_CUE_LEVEL:   (cmd) => [['cue.level', cmd.payload.level]],
  SET_CUE_MODE:    (cmd) => [['cue.mode',  cmd.payload.mode]],
  SET_FX:          (cmd) => [['fx.global', cmd.payload]],
}

export class DeltaStateSync {
  /** @type {Record<string, any>} Flat state mirror */
  _state  = {}
  _seq    = 0

  /**
   * Apply a routed command to the state mirror.
   * @param {{ type: string, channelId: number|null, payload: any, seq: number }} cmd
   * @returns {{ path: string, value: any }[]} patches applied
   */
  apply(cmd) {
    const mapper = CMD_TO_PATHS[cmd.type]
    if (!mapper) return []

    const patches = []
    try {
      const pairs = mapper(cmd)
      for (const [path, value] of pairs) {
        if (path && value !== undefined) {
          this._state[path] = value
          patches.push({ path, value })
        }
      }
    } catch (_) {}

    this._seq = cmd.seq ?? this._seq
    return patches
  }

  /**
   * Full state snapshot for new connections.
   */
  getFullState() {
    return { seq: this._seq, state: { ...this._state } }
  }

  /**
   * For the current implementation, delta is derived from command log.
   * Returns the full state for simplicity (command log handles fine-grained delta).
   */
  currentSeq() { return this._seq }

  getStats() {
    return {
      paths:      Object.keys(this._state).length,
      currentSeq: this._seq,
    }
  }

  reset() { this._state = {}; this._seq = 0 }
}
