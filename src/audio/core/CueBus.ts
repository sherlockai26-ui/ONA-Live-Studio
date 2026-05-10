/**
 * CueBus.ts — Bus de escucha PFL/AFL para sistema solo/cue profesional.
 *
 * PFL (Pre-Fader Listen): escucha antes del fader — nivel original sin atenuación.
 * AFL (After-Fader Listen): escucha después del fader — nivel de mezcla real.
 *
 * REGLA: solo NO corta el main mix — es routing adicional al cue bus.
 * El cue bus tiene su propio nivel y opera completamente independiente.
 *
 * Conexión:
 *   Canal.preFaderTap → soloSendNode → cue.input (modo PFL)
 *   Canal.postFaderTap → soloSendNode → cue.input (modo AFL)
 *   cue.fader → RoutingMatrix → salida monitora
 */

export type CueMode = 'pfl' | 'afl'

export interface CueState {
  level:          number    // 0-100
  mode:           CueMode
  soloedChannels: number[]
  soloedGroups:   number[]
}

const ANALYSER_FFT_CUE = 256

class CueBusImpl {
  private _input:    GainNode | null    = null
  private _fader:    GainNode | null    = null
  private _analyser: AnalyserNode | null = null
  private _peakBuf:  Float32Array        = new Float32Array(ANALYSER_FFT_CUE)
  private _ctx:      AudioContext | null = null

  private _state: CueState = {
    level: 100, mode: 'pfl',
    soloedChannels: [], soloedGroups: [],
  }

  initialize(ctx: AudioContext): void {
    this._ctx     = ctx
    this._input   = ctx.createGain()
    this._fader   = ctx.createGain()
    this._analyser = ctx.createAnalyser()
    this._analyser.fftSize               = ANALYSER_FFT_CUE
    this._analyser.smoothingTimeConstant = 0
    this._peakBuf  = new Float32Array(ANALYSER_FFT_CUE)
    this._input.gain.value = 1
    this._fader.gain.value = 1
    this._input.connect(this._fader)
    this._fader.connect(this._analyser)
    console.log('[CUE] Cue bus listo (PFL/AFL)')
  }

  get input():    GainNode | null { return this._input }
  get fader():    GainNode | null { return this._fader }
  get state():    CueState        { return this._state }
  get mode():     CueMode         { return this._state.mode }
  get hasSolo():  boolean         {
    return this._state.soloedChannels.length > 0 || this._state.soloedGroups.length > 0
  }

  setMode(mode: CueMode): void { this._state.mode = mode }

  setLevel(level: number): void {
    if (!this._fader || !this._ctx) return
    this._state.level = level
    this._fader.gain.setTargetAtTime(level / 100, this._ctx.currentTime, 0.007)
  }

  addSoloChannel(id: number): void {
    if (!this._state.soloedChannels.includes(id)) this._state.soloedChannels.push(id)
  }
  removeSoloChannel(id: number): void {
    this._state.soloedChannels = this._state.soloedChannels.filter(x => x !== id)
  }

  addSoloGroup(id: number): void {
    if (!this._state.soloedGroups.includes(id)) this._state.soloedGroups.push(id)
  }
  removeSoloGroup(id: number): void {
    this._state.soloedGroups = this._state.soloedGroups.filter(x => x !== id)
  }

  clearAll(): void {
    this._state.soloedChannels = []
    this._state.soloedGroups   = []
  }

  getMeterValue(): number {
    if (!this._analyser) return -Infinity
    this._analyser.getFloatTimeDomainData(this._peakBuf)
    let peak = 0
    for (let i = 0; i < this._peakBuf.length; i++) {
      const a = Math.abs(this._peakBuf[i])
      if (a > peak) peak = a
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity
  }

  destroy(): void {
    try { this._input?.disconnect() }    catch (_) {}
    try { this._fader?.disconnect() }    catch (_) {}
    try { this._analyser?.disconnect() } catch (_) {}
    this._input = this._fader = this._analyser = null
    this._ctx   = null
    this.clearAll()
  }
}

export const cueBus = new CueBusImpl()
