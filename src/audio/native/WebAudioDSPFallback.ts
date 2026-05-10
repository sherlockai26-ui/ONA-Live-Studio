/**
 * WebAudioDSPFallback.ts — Implementación JS pura del pipeline DSP.
 *
 * Activa cuando el módulo nativo Rust no está compilado o no carga.
 * Misma API que NativeChannelProcessor — NativeDSPBridge los intercambia
 * de forma transparente.
 *
 * Algoritmos idénticos al código Rust para que los resultados sean comparables
 * en el benchmark. Diferencia: JS no tiene SIMD ni acceso directo al heap.
 */

import type { IDSPChannel, BlockResult } from './types'

export class WebAudioDSPChannel implements IDSPChannel {
  private _gainTarget  = 1.0
  private _gainCurrent = 1.0
  private _pan         = 0.0
  private _bypass      = false

  // Metering state
  private _peakL     = 0.0
  private _peakR     = 0.0
  private _rmsAccL   = 0.0
  private _rmsAccR   = 0.0
  private _holdL     = 0
  private _holdR     = 0

  // Coefficients (calculados una vez en constructor)
  private readonly _smoothCoeff:    number
  private readonly _rmsCoeff:       number
  private readonly _peakHoldTotal:  number
  private readonly _peakDecay:      number

  constructor(
    private readonly _channelId: number,
    private readonly _sampleRate = 48000,
  ) {
    this._smoothCoeff   = Math.exp(-1 / (0.010 * _sampleRate)) // 10ms
    this._rmsCoeff      = Math.exp(-1 / (0.300 * _sampleRate)) // 300ms
    this._peakHoldTotal = Math.round(1.5 * _sampleRate)
    this._peakDecay     = Math.pow(10, -20.0 / 20.0 / _sampleRate)
  }

  setGainDb(db: number): void {
    this._gainTarget = db <= -96 ? 0 : Math.pow(10, db / 20)
  }

  setGainLinear(gain: number): void {
    this._gainTarget = Math.max(0, Math.min(4, gain))
  }

  setPan(pan: number): void {
    this._pan = Math.max(-1, Math.min(1, pan))
  }

  setBypass(bypass: boolean): void {
    this._bypass = bypass
  }

  processBlock(samples: Float32Array): BlockResult {
    const t0 = performance.now()

    if (!this._bypass) {
      this._applyGain(samples)
      this._applyPan(samples)
    }

    const { peakL, peakR, rmsL, rmsR } = this._measure(samples)

    return {
      peakL,
      peakR,
      rmsL,
      rmsR,
      processingNs: (performance.now() - t0) * 1_000_000,
    }
  }

  resetMeters(): void {
    this._peakL   = 0
    this._peakR   = 0
    this._rmsAccL = 0
    this._rmsAccR = 0
    this._holdL   = 0
    this._holdR   = 0
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  private _applyGain(samples: Float32Array): void {
    const diff = Math.abs(this._gainTarget - this._gainCurrent)
    if (diff < 1e-6) {
      const g = this._gainTarget
      for (let i = 0; i < samples.length; i++) samples[i] *= g
    } else {
      const coeff  = this._smoothCoeff
      const target = this._gainTarget
      for (let i = 0; i < samples.length; i++) {
        this._gainCurrent = target + coeff * (this._gainCurrent - target)
        samples[i] *= this._gainCurrent
      }
    }
  }

  private _applyPan(samples: Float32Array): void {
    const angle = (this._pan + 1) * Math.PI / 4
    const lg    = Math.cos(angle)
    const rg    = Math.sin(angle)
    if (Math.abs(lg - rg) < 1e-6) return // centro: sin-op
    for (let i = 0; i < samples.length; i += 2) {
      samples[i]     *= lg
      samples[i + 1] *= rg
    }
  }

  private _measure(samples: Float32Array) {
    const rmsCoeff    = this._rmsCoeff
    const peakDecay   = this._peakDecay
    const holdTotal   = this._peakHoldTotal

    for (let i = 0; i < samples.length; i += 2) {
      const l = Math.abs(samples[i])
      const r = Math.abs(samples[i + 1] ?? l)

      if (l > this._peakL) { this._peakL = l; this._holdL = holdTotal }
      else if (this._holdL > 0) this._holdL--
      else this._peakL *= peakDecay

      if (r > this._peakR) { this._peakR = r; this._holdR = holdTotal }
      else if (this._holdR > 0) this._holdR--
      else this._peakR *= peakDecay

      const l2 = l * l
      const r2 = r * r
      this._rmsAccL = l2 + rmsCoeff * (this._rmsAccL - l2)
      this._rmsAccR = r2 + rmsCoeff * (this._rmsAccR - r2)
    }

    return {
      peakL: this._peakL,
      peakR: this._peakR,
      rmsL:  Math.sqrt(this._rmsAccL),
      rmsR:  Math.sqrt(this._rmsAccR),
    }
  }
}
