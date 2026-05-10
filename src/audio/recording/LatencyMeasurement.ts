/**
 * LatencyMeasurement.ts — Real I/O latency from AudioContext built-in properties.
 *
 * AudioContext.baseLatency:   rendering quantisation latency (hardware buffer size)
 * AudioContext.outputLatency: OS audio stack latency (WASAPI/CoreAudio/ALSA)
 *
 * Both are available only after the context is running. The measurement is
 * snapshotted at recording start and at finalize so it's attached to each session.
 */

export interface LatencyReport {
  baseLatencyMs:   number
  outputLatencyMs: number
  totalLatencyMs:  number
  sampleRate:      number
  bufferFrames:    number   // baseLatency × sampleRate (estimated hardware buffer size)
  stable:          boolean  // |driftPpm| < 50 ppm
  driftPpm:        number
}

class LatencyMeasurementImpl {
  private _ctx: AudioContext | null = null
  private _history: LatencyReport[] = []

  attach(ctx: AudioContext): void { this._ctx = ctx }

  measure(driftPpm = 0): LatencyReport {
    const ctx = this._ctx
    if (!ctx) {
      return { baseLatencyMs: 0, outputLatencyMs: 0, totalLatencyMs: 0,
               sampleRate: 48000, bufferFrames: 0, stable: false, driftPpm: 0 }
    }

    const baseLatencyMs   = (ctx.baseLatency   ?? 0) * 1000
    const outputLatencyMs = (ctx.outputLatency ?? 0) * 1000
    const totalLatencyMs  = baseLatencyMs + outputLatencyMs
    const sampleRate      = ctx.sampleRate
    const bufferFrames    = Math.round((ctx.baseLatency ?? 0) * sampleRate)
    const stable          = Math.abs(driftPpm) < 50

    const report: LatencyReport = {
      baseLatencyMs, outputLatencyMs, totalLatencyMs,
      sampleRate, bufferFrames, stable, driftPpm,
    }
    this._history.push(report)
    if (this._history.length > 120) this._history.shift()
    return report
  }

  getHistory(): LatencyReport[] { return [...this._history] }
  getLast(): LatencyReport | null { return this._history[this._history.length - 1] ?? null }

  destroy(): void { this._ctx = null; this._history = [] }
}

export const latencyMeasurement = new LatencyMeasurementImpl()
