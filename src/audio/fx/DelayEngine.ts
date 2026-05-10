/**
 * DelayEngine.ts — Delay profesional live-safe con LPF damping y ancho estéreo.
 *
 * Arquitectura (Paso 12):
 *   input → preDelay → [delayL + feedbackL loop]  ─→ merger[ch0]
 *                   → [delayR + feedbackR loop]  ─→ merger[ch1]
 *                                                     ↓
 *                                               wetGain → output
 *
 * Cadena de cada canal (L o R):
 *   preDelay → delay(time) → lpf(lowpass, damping)
 *           ← feedbackGain ←────────────────────────┘ (feedback loop)
 *   delay output → merger
 *
 * Protección (FxCpuProtection):
 *   - feedbackGain clamped a MAX_FEEDBACK (0.97) independientemente del input
 *   - denormal kick inyectado en cada feedback path
 *   - todos los parámetros con setTargetAtTime (sin zipper noise)
 *
 * Ancho estéreo:
 *   delayR.time = delayL.time × (1 + width×0.025) — offset porcentual mínimo
 *   crea percepción de ancho sin usar dos fuentes completamente distintas.
 *
 * El preDelay (0–100ms) introduce un gap antes de que empiece la repetición,
 * útil para dar sensación de tamaño a la sala sin suciedad en transientes.
 */

import { clampFeedback, createDenormalKick, ramp } from './FxCpuProtection'

export interface DelayParams {
  time:      number   // 0.001 – 2.0 s
  feedback:  number   // 0 – 100 (%)
  damping:   number   // 0 – 100 (0=brillante 20kHz, 100=oscuro 500Hz)
  width:     number   // 0 – 100 (% spread estéreo)
  wetLevel:  number   // 0 – 100 (%)
  predelay:  number   // 0 – 100 ms
}

const DEFAULT_PARAMS: DelayParams = {
  time: 0.35, feedback: 35, damping: 25, width: 60, wetLevel: 100, predelay: 20,
}

export class DelayEngine {
  private _ctx:    AudioContext | null = null

  // Public I/O
  readonly input:  GainNode
  readonly output: GainNode

  // Core nodes
  private _preDelay:   DelayNode
  private _delayL:     DelayNode
  private _delayR:     DelayNode
  private _lpfL:       BiquadFilterNode
  private _lpfR:       BiquadFilterNode
  private _fbGainL:    GainNode
  private _fbGainR:    GainNode
  private _merger:     ChannelMergerNode
  private _wetGain:    GainNode

  // Denormal kicks
  private _kickL: ReturnType<typeof createDenormalKick>
  private _kickR: ReturnType<typeof createDenormalKick>

  private _params: DelayParams = { ...DEFAULT_PARAMS }

  constructor(ctx: AudioContext) {
    this._ctx = ctx

    this.input   = ctx.createGain()   // unity summing input
    this.output  = ctx.createGain()   // unity output

    this._preDelay = ctx.createDelay(0.101)  // 0–100 ms predelay
    this._delayL   = ctx.createDelay(2.001)
    this._delayR   = ctx.createDelay(2.001)
    this._lpfL     = ctx.createBiquadFilter()
    this._lpfR     = ctx.createBiquadFilter()
    this._fbGainL  = ctx.createGain()
    this._fbGainR  = ctx.createGain()
    this._merger   = ctx.createChannelMerger(2)
    this._wetGain  = ctx.createGain()

    this._lpfL.type = 'lowpass'
    this._lpfR.type = 'lowpass'

    // ── Wiring ────────────────────────────────────────────────────────────────
    // input → preDelay (shared source for L and R)
    this.input.connect(this._preDelay)

    // L chain: preDelay → delayL → lpfL → feedbackGainL → delayL (loop)
    this._preDelay.connect(this._delayL)
    this._delayL.connect(this._lpfL)
    this._lpfL.connect(this._fbGainL)
    this._fbGainL.connect(this._delayL)    // feedback loop (valid: DelayNode in cycle)

    // R chain: preDelay → delayR → lpfR → feedbackGainR → delayR (loop)
    this._preDelay.connect(this._delayR)
    this._delayR.connect(this._lpfR)
    this._lpfR.connect(this._fbGainR)
    this._fbGainR.connect(this._delayR)    // feedback loop

    // Wet output: merge L→ch0, R→ch1
    this._lpfL.connect(this._merger, 0, 0)
    this._lpfR.connect(this._merger, 0, 1)
    this._merger.connect(this._wetGain)
    this._wetGain.connect(this.output)

    // ── Denormal protection ──────────────────────────────────────────────────
    this._kickL = createDenormalKick(ctx)
    this._kickR = createDenormalKick(ctx)
    this._kickL.node.connect(this._fbGainL)
    this._kickR.node.connect(this._fbGainR)
    this._kickL.start()
    this._kickR.start()

    // ── Apply defaults ────────────────────────────────────────────────────────
    this._applyAll()
  }

  // ── Parameter setters (all use smooth ramps — no zipper noise) ───────────────

  setTime(seconds: number): void {
    this._params.time = Math.max(0.001, Math.min(2.0, seconds))
    this._applyTimes()
  }

  setFeedback(value: number): void {
    this._params.feedback = Math.max(0, Math.min(100, value))
    const fb = clampFeedback(this._params.feedback / 100)
    ramp(this._ctx!, this._fbGainL.gain, fb)
    ramp(this._ctx!, this._fbGainR.gain, fb)
  }

  setDamping(value: number): void {
    this._params.damping = Math.max(0, Math.min(100, value))
    const freq = 500 + (1 - this._params.damping / 100) * 19500  // 500–20000 Hz
    ramp(this._ctx!, this._lpfL.frequency, freq)
    ramp(this._ctx!, this._lpfR.frequency, freq)
  }

  setWidth(value: number): void {
    this._params.width = Math.max(0, Math.min(100, value))
    this._applyTimes()
  }

  setWetLevel(value: number): void {
    this._params.wetLevel = Math.max(0, Math.min(100, value))
    ramp(this._ctx!, this._wetGain.gain, this._params.wetLevel / 100)
  }

  setPredelay(ms: number): void {
    this._params.predelay = Math.max(0, Math.min(100, ms))
    ramp(this._ctx!, this._preDelay.delayTime, this._params.predelay / 1000)
  }

  setParams(p: Partial<DelayParams>): void {
    if (p.time      !== undefined) this.setTime(p.time)
    if (p.feedback  !== undefined) this.setFeedback(p.feedback)
    if (p.damping   !== undefined) this.setDamping(p.damping)
    if (p.width     !== undefined) this.setWidth(p.width)
    if (p.wetLevel  !== undefined) this.setWetLevel(p.wetLevel)
    if (p.predelay  !== undefined) this.setPredelay(p.predelay)
  }

  getParams(): DelayParams { return { ...this._params } }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private _applyTimes(): void {
    const t   = this._params.time
    const wf  = this._params.width / 100
    ramp(this._ctx!, this._delayL.delayTime, t)
    ramp(this._ctx!, this._delayR.delayTime, t * (1 + wf * 0.025))  // small R offset
  }

  private _applyAll(): void {
    this._applyTimes()
    this.setFeedback(this._params.feedback)
    this.setDamping(this._params.damping)
    this.setWetLevel(this._params.wetLevel)
    this.setPredelay(this._params.predelay)
  }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    this._kickL.stop()
    this._kickR.stop()
    try { this._kickL.node.disconnect() } catch (_) {}
    try { this._kickR.node.disconnect() } catch (_) {}

    const nodes: AudioNode[] = [
      this.input, this._preDelay,
      this._delayL, this._lpfL, this._fbGainL,
      this._delayR, this._lpfR, this._fbGainR,
      this._merger, this._wetGain, this.output,
    ]
    for (const n of nodes) { try { n.disconnect() } catch (_) {} }
    this._ctx = null
  }
}
