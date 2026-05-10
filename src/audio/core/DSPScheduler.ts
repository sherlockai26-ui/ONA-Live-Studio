/**
 * DSPScheduler.ts — Scheduler y profiling del pipeline DSP
 *
 * Paso 7 optimizations:
 *   - Circular buffer Float64Array para jitter: Array.shift() O(n) → O(1)
 *   - Running sum para media: reduce() O(n) → O(1)
 *   - Mutación in-place de _metrics: sin new {} en RAF loop
 *   - Fixed-size ring para hotPathWarn: sin Array.push/shift
 *   - Métricas expuestas por getter (no copia) — sin spread [...]
 *
 * Métricas:
 *   driftMs         diferencia AudioContext vs wall clock en ms
 *   callbackJitter  variación del interval entre ticks de metering
 *   gcSpikes        ticks donde jitter > 50ms (probable GC pause)
 *   bufferStarveProb  estimación de probabilidad de underrun basado en jitter
 */

import { workletManager } from './WorkletManager'
import { dspCommandBus }  from './DSPCommandBus'

export interface DSPMetrics {
  sampleRate:          number
  audioCurrentTime:    number
  wallClockTime:       number
  driftMs:             number
  callbackJitterMs:    number
  gcSpikes:            number
  bufferStarveProb:    number
  workletReady:        boolean
  commandsPending:     number
  hotPathWarnings:     string[]
}

const GC_SPIKE_THRESHOLD_MS = 50
const JITTER_BUF_SIZE        = 30   // slots en el circular buffer
const WARN_RING_SIZE         = 10   // slots de warnings

class DSPScheduler {
  private _ctx:        AudioContext | null = null
  private _rafId:      number | null       = null
  private _startWall:  number              = 0
  private _startAudio: number              = 0
  private _lastTick:   number              = 0
  private _frame:      number              = 0
  private _gcSpikes:   number              = 0

  // Paso 7: circular buffer Float64Array — sin push/shift
  private readonly _jitterBuf   = new Float64Array(JITTER_BUF_SIZE)
  private _jitterHead            = 0
  private _jitterSum             = 0.0
  private _jitterFilled          = 0

  // Paso 7: fixed-size ring para warnings — sin push/shift/spread
  private readonly _warnRing     = new Array<string>(WARN_RING_SIZE).fill('')
  private _warnHead              = 0
  private _warnCount             = 0  // cuántos válidos hay

  // Paso 7: objeto de métricas pre-allocado — sin new {} en RAF loop
  private _metrics: DSPMetrics = {
    sampleRate: 48000, audioCurrentTime: 0, wallClockTime: 0,
    driftMs: 0, callbackJitterMs: 0, gcSpikes: 0,
    bufferStarveProb: 0, workletReady: false, commandsPending: 0,
    hotPathWarnings: this._warnRing,
  }

  // ── Init ──────────────────────────────────────────────────────────────────────

  attach(ctx: AudioContext): void {
    if (this._ctx) this.destroy()
    this._ctx        = ctx
    this._startWall  = performance.now() / 1000
    this._startAudio = ctx.currentTime
    this._metrics.sampleRate = ctx.sampleRate
    this._startLoop()
    console.log(`[DSP SCHED] Attached — SR: ${ctx.sampleRate}Hz`)
  }

  // ── RAF loop de profiling ─────────────────────────────────────────────────────

  private _startLoop(): void {
    const INTERVAL = 16.7 * 4  // ~66ms

    const tick = (now: number) => {
      this._rafId = requestAnimationFrame(tick)
      if ((this._frame++ & 3) !== 0) return

      const ctx = this._ctx!

      // 1. Drift
      const wallElapsed  = (now / 1000) - this._startWall
      const audioElapsed = ctx.currentTime - this._startAudio
      const driftMs      = (wallElapsed - audioElapsed) * 1000

      // 2. Jitter — circular buffer O(1) insert + running sum
      if (this._lastTick > 0) {
        const delta  = now - this._lastTick
        const jitter = Math.abs(delta - INTERVAL)

        // Overwrite oldest entry: subtract old, add new
        const oldVal = this._jitterBuf[this._jitterHead]
        this._jitterSum -= oldVal
        this._jitterBuf[this._jitterHead] = jitter
        this._jitterSum += jitter
        this._jitterHead = (this._jitterHead + 1) % JITTER_BUF_SIZE
        if (this._jitterFilled < JITTER_BUF_SIZE) this._jitterFilled++

        if (jitter > GC_SPIKE_THRESHOLD_MS) {
          this._gcSpikes++
          // Fixed-size ring — sin push/shift
          this._warnRing[this._warnHead] = `GC spike: ${jitter.toFixed(0)}ms @ ${now.toFixed(0)}ms`
          this._warnHead = (this._warnHead + 1) % WARN_RING_SIZE
          if (this._warnCount < WARN_RING_SIZE) this._warnCount++
        }
      }
      this._lastTick = now

      const avgJitter = this._jitterFilled > 0
        ? this._jitterSum / this._jitterFilled
        : 0

      // 3. Buffer starvation
      const bufferMs   = (ctx.baseLatency ?? 0.01) * 1000
      const starveProb = bufferMs > 0 ? Math.min(100, (avgJitter / bufferMs) * 100) : 0

      // 4. Mutación in-place de _metrics — sin new {}
      this._metrics.audioCurrentTime = ctx.currentTime
      this._metrics.wallClockTime    = now / 1000
      this._metrics.driftMs          = driftMs
      this._metrics.callbackJitterMs = avgJitter
      this._metrics.gcSpikes         = this._gcSpikes
      this._metrics.bufferStarveProb = starveProb
      this._metrics.workletReady     = workletManager.isReady()
      this._metrics.commandsPending  = dspCommandBus.getPending()
      // hotPathWarnings ya es referencia a _warnRing — sin spread
    }

    this._rafId = requestAnimationFrame(tick)
  }

  // ── Hot Path Audit ────────────────────────────────────────────────────────────

  runHotPathAudit(): string[] {
    const issues: string[] = []
    if (!workletManager.isReady()) issues.push('WorkletManager no inicializado — gate en main thread')
    if (!dspCommandBus.isAvailable()) issues.push('DSPCommandBus sin SAB — commands por postMessage')
    if ((window as any).__ONA_METERING_DISABLED) issues.push('MeteringEngine desactivado')
    try {
      new SharedArrayBuffer(4)
    } catch {
      issues.push('SharedArrayBuffer no disponible — metering usa ArrayBuffer normal')
    }
    return issues
  }

  // ── API pública ───────────────────────────────────────────────────────────────

  getMetrics():    Readonly<DSPMetrics> { return this._metrics }
  getDriftMs():    number { return this._metrics.driftMs }
  getGcSpikes():   number { return this._gcSpikes }
  resetGcSpikes(): void  {
    this._gcSpikes  = 0
    this._warnHead  = 0
    this._warnCount = 0
    this._warnRing.fill('')
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  destroy(): void {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null }
    this._ctx          = null
    this._jitterBuf.fill(0)
    this._jitterHead   = 0
    this._jitterSum    = 0
    this._jitterFilled = 0
    this._frame        = 0
    this._lastTick     = 0
  }
}

export const dspScheduler = new DSPScheduler()
export default dspScheduler

// ── Console exposure ──────────────────────────────────────────────────────────
;(window as any).__ONA_DSP = {
  metrics:     () => dspScheduler.getMetrics(),
  drift:       () => `${dspScheduler.getDriftMs().toFixed(2)}ms`,
  gcSpikes:    () => dspScheduler.getGcSpikes(),
  resetSpikes: () => { dspScheduler.resetGcSpikes(); console.log('[DSP] GC spikes reseteados') },
  audit: () => {
    const issues = dspScheduler.runHotPathAudit()
    console.group('[DSP] Hot Path Audit')
    if (issues.length === 0) console.log('✓ Sin problemas detectados')
    else issues.forEach(i => console.warn('⚠', i))
    console.groupEnd()
    return issues
  },
  commandBus: () => ({ available: dspCommandBus.isAvailable(), pending: dspCommandBus.getPending() }),
  worklets:   () => ({ state: workletManager.getState(), ready: workletManager.isReady() }),
}
