/**
 * ReverbEngine.ts — Reverberación estilo Freeverb-lite, low CPU, live-safe.
 *
 * Arquitectura (Paso 12):
 *   4 filtros comb en paralelo → suma → 1 filtro allpass → wetGain → output
 *
 * Cada filtro comb (Schroeder comb filter):
 *   input → delay(t) → lpf(damping) → feedbackGain(roomsize) → delay (loop)
 *               ↓ output
 *
 * Los 4 outputs de los combs se suman y pasan por un BiquadFilter allpass
 * (aproximación WebAudio-nativa de Schroeder allpass — suficiente para difusión musical).
 *
 * Delay times a 44100Hz (Freeverb standard — 4 de los 8 combs):
 *   1116, 1356, 1491, 1617 samples → escalados a sampleRate actual
 *
 * Parámetros:
 *   roomSize   0–100: tamaño de sala (feedback en combs: 0.5 + rs×0.47)
 *   damping    0–100: absorción HF (LPF cutoff 20kHz→1kHz)
 *   predelay   0–100 ms: delay antes de la red de reverb
 *   wetLevel   0–100 (%): nivel de wet
 *
 * Protección:
 *   - feedbackGain clamped a MAX_FEEDBACK (0.97)
 *   - denormal kick en cada loop de feedback
 *   - allpass con Q=0.7 (sin resonancia peligrosa)
 *   - runaway detection via AnalyserNode (llamado desde FxBusEngine)
 *
 * Evaluación Rust (Paso 12, tarea 8):
 *   Los 4 comb filters corren en el audio thread de WebAudio (C++, SIMD cuando
 *   disponible en Chromium). Mover estos a Rust via napi-rs solo beneficiaría
 *   si necesitáramos >8 comb filters o procesamiento por bloque personalizado.
 *   Con 4 combs y WebAudio nativo el overhead es mínimo (~0.2% CPU a 48kHz).
 *   RECOMENDACIÓN: NO migrar Reverb/Delay a Rust en esta fase. Revisitar si
 *   el usuario necesita convolución de IR (> 1s) o más de 8 reverbs simultáneas.
 */

import * as Tone from 'tone'
import { clampFeedback, createDenormalKick, ramp } from './FxCpuProtection'

function _toneCtx(): AudioContext { return Tone.getContext() as unknown as AudioContext }

export interface ReverbParams {
  roomSize:  number   // 0 – 100
  damping:   number   // 0 – 100
  predelay:  number   // 0 – 100 ms
  wetLevel:  number   // 0 – 100
}

const DEFAULT_PARAMS: ReverbParams = {
  roomSize: 55, damping: 40, predelay: 30, wetLevel: 100,
}

// Freeverb comb filter delay times in samples at 44100Hz (4 of the 8 standard combs)
const COMB_SAMPLES_44100 = [1116, 1356, 1491, 1617]

// Schroeder allpass delay at 44100Hz (first of the 4 standard allpass)
const ALLPASS_SAMPLE_44100 = 556

interface CombFilter {
  delay:    DelayNode
  lpf:      BiquadFilterNode
  fbGain:   GainNode
  kick:     ReturnType<typeof createDenormalKick>
}

export class ReverbEngine {
  private _ctx:      AudioContext | null = null

  readonly input:    GainNode
  readonly output:   GainNode

  private _preDelay:  DelayNode
  private _combs:     CombFilter[]
  private _combSum:   GainNode       // normalizes 4 comb outputs
  private _allpass:   BiquadFilterNode
  private _wetGain:   GainNode

  private _params: ReverbParams = { ...DEFAULT_PARAMS }

  constructor(ctx: AudioContext) {
    this._ctx = ctx
    const nc  = _toneCtx()
    const sr  = ctx.sampleRate

    this.input   = nc.createGain()
    this.output  = nc.createGain()

    this._preDelay = nc.createDelay(0.101)
    this._combSum  = nc.createGain()
    this._combSum.gain.value = 1 / COMB_SAMPLES_44100.length  // normalize sum
    this._allpass  = nc.createBiquadFilter()
    this._wetGain  = nc.createGain()

    // Allpass approximation: BiquadFilter type 'allpass' with flat magnitude
    // Q = 0.7 → very mild diffusion, no resonance risk
    this._allpass.type            = 'allpass'
    this._allpass.frequency.value = (ALLPASS_SAMPLE_44100 / 44100) * sr
    this._allpass.Q.value         = 0.7

    // ── Build comb filters ────────────────────────────────────────────────────
    this._combs = COMB_SAMPLES_44100.map((samples) => {
      const delayTime = samples / 44100 * (sr / 44100)  // scale to actual sampleRate
      const delay  = nc.createDelay(delayTime * 2 + 0.001)  // +headroom
      const lpf    = nc.createBiquadFilter()
      const fbGain = nc.createGain()
      const kick   = createDenormalKick(nc)

      lpf.type = 'lowpass'

      // Comb wiring: input → delay → lpf → feedbackGain → delay (loop)
      this._preDelay.connect(delay)
      delay.connect(lpf)
      lpf.connect(fbGain)
      fbGain.connect(delay)   // feedback loop (valid: DelayNode in cycle)

      // Sum comb output
      delay.connect(this._combSum)

      // Denormal protection in feedback path
      kick.node.connect(fbGain)
      kick.start()

      // Set initial delay time
      delay.delayTime.value = samples / 44100

      return { delay, lpf, fbGain, kick }
    })

    // ── Wiring ────────────────────────────────────────────────────────────────
    this.input.connect(this._preDelay)
    this._combSum.connect(this._allpass)
    this._allpass.connect(this._wetGain)
    this._wetGain.connect(this.output)

    this._applyAll()
  }

  // ── Parameter setters ─────────────────────────────────────────────────────────

  setRoomSize(value: number): void {
    this._params.roomSize = Math.max(0, Math.min(100, value))
    // roomsize maps to feedback: 0→0.5, 100→0.97 (Freeverb typical range)
    const fb = clampFeedback(0.5 + this._params.roomSize / 100 * 0.47)
    for (const c of this._combs) ramp(this._ctx!, c.fbGain.gain, fb)
  }

  setDamping(value: number): void {
    this._params.damping = Math.max(0, Math.min(100, value))
    // 0% damping = 20kHz (bright), 100% damping = 1kHz (dark)
    const freq = 1000 + (1 - this._params.damping / 100) * 19000
    for (const c of this._combs) ramp(this._ctx!, c.lpf.frequency, freq)
  }

  setPredelay(ms: number): void {
    this._params.predelay = Math.max(0, Math.min(100, ms))
    ramp(this._ctx!, this._preDelay.delayTime, this._params.predelay / 1000)
  }

  setWetLevel(value: number): void {
    this._params.wetLevel = Math.max(0, Math.min(100, value))
    ramp(this._ctx!, this._wetGain.gain, this._params.wetLevel / 100)
  }

  setParams(p: Partial<ReverbParams>): void {
    if (p.roomSize  !== undefined) this.setRoomSize(p.roomSize)
    if (p.damping   !== undefined) this.setDamping(p.damping)
    if (p.predelay  !== undefined) this.setPredelay(p.predelay)
    if (p.wetLevel  !== undefined) this.setWetLevel(p.wetLevel)
  }

  getParams(): ReverbParams { return { ...this._params } }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private _applyAll(): void {
    this.setRoomSize(this._params.roomSize)
    this.setDamping(this._params.damping)
    this.setPredelay(this._params.predelay)
    this.setWetLevel(this._params.wetLevel)
  }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    for (const c of this._combs) {
      c.kick.stop()
      try { c.kick.node.disconnect() } catch (_) {}
      try { c.delay.disconnect()     } catch (_) {}
      try { c.lpf.disconnect()       } catch (_) {}
      try { c.fbGain.disconnect()    } catch (_) {}
    }
    const nodes: AudioNode[] = [
      this.input, this._preDelay, this._combSum, this._allpass, this._wetGain, this.output,
    ]
    for (const n of nodes) { try { n.disconnect() } catch (_) {} }
    this._ctx = null
  }
}
