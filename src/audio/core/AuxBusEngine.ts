/**
 * AuxBusEngine.ts — 8 AUX buses para monitor mixing, FX externos y splits de grabación.
 *
 * Cada AUX bus:
 *   input (GainNode)    — sumador de sends de canal
 *   fader (GainNode)    — nivel maestro del bus
 *   analyser            — metering peak
 *
 * Los sends de canal se conectan a bus.input externamente (vía ChannelStrip).
 * bus.fader es el nodo de salida — conectar a RoutingMatrix para audición.
 */

export const NUM_AUX   = 8
const AUX_LABELS       = ['Aux 1','Aux 2','Aux 3','Aux 4','Aux 5','Aux 6','Aux 7','Aux 8']
const ANALYSER_FFT_AUX = 256

export interface AuxBusState {
  id:    number
  label: string
  level: number   // 0-100
  muted: boolean
}

interface AuxBusNodes {
  input:    GainNode
  fader:    GainNode
  analyser: AnalyserNode
  peakBuf:  Float32Array
  state:    AuxBusState
}

function auxVolToGain(vol: number): number { return vol <= 0 ? 0 : vol / 100 }

class AuxBusEngineImpl {
  private _buses = new Map<number, AuxBusNodes>()
  private _ctx:   AudioContext | null = null

  initialize(ctx: AudioContext): void {
    this._ctx = ctx
    for (let i = 1; i <= NUM_AUX; i++) {
      const input    = ctx.createGain()
      const fader    = ctx.createGain()
      const analyser = ctx.createAnalyser()
      analyser.fftSize               = ANALYSER_FFT_AUX
      analyser.smoothingTimeConstant = 0
      input.gain.value  = 1
      fader.gain.value  = 1
      input.connect(fader)
      fader.connect(analyser)
      this._buses.set(i, {
        input, fader, analyser,
        peakBuf: new Float32Array(ANALYSER_FFT_AUX),
        state: { id: i, label: AUX_LABELS[i - 1], level: 100, muted: false },
      })
    }
    console.log(`[AUX] ${NUM_AUX} buses listos`)
  }

  getBus(id: number): { input: GainNode; fader: GainNode } | null {
    const b = this._buses.get(id)
    return b ? { input: b.input, fader: b.fader } : null
  }

  setLevel(id: number, level: number): void {
    const b = this._buses.get(id)
    if (!b || !this._ctx) return
    b.state.level = level
    if (!b.state.muted) b.fader.gain.setTargetAtTime(auxVolToGain(level), this._ctx.currentTime, 0.007)
  }

  setMuted(id: number, muted: boolean): void {
    const b = this._buses.get(id)
    if (!b || !this._ctx) return
    b.state.muted = muted
    b.fader.gain.setTargetAtTime(muted ? 0 : auxVolToGain(b.state.level), this._ctx.currentTime, 0.007)
  }

  setLabel(id: number, label: string): void {
    const b = this._buses.get(id)
    if (b) b.state.label = label
  }

  getMeterValue(id: number): number {
    const b = this._buses.get(id)
    if (!b) return -Infinity
    b.analyser.getFloatTimeDomainData(b.peakBuf)
    let peak = 0
    for (let i = 0; i < b.peakBuf.length; i++) {
      const a = Math.abs(b.peakBuf[i])
      if (a > peak) peak = a
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity
  }

  getState(id: number): AuxBusState | null { return this._buses.get(id)?.state ?? null }

  getAllStates(): AuxBusState[] {
    return Array.from(this._buses.values()).map(b => b.state)
  }

  destroy(): void {
    for (const b of this._buses.values()) {
      try { b.input.disconnect() }    catch (_) {}
      try { b.fader.disconnect() }    catch (_) {}
      try { b.analyser.disconnect() } catch (_) {}
    }
    this._buses.clear()
    this._ctx = null
  }
}

export const auxBusEngine = new AuxBusEngineImpl()
