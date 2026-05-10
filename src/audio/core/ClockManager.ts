/**
 * ClockManager.ts — Gestión de reloj, latencia y xruns del pipeline de audio
 *
 * Responsabilidades:
 *   - Leer sampleRate / baseLatency / outputLatency del AudioContext
 *   - Detectar xruns por gaps en el RAF loop (heurístico)
 *   - Medir jitter del scheduler de animación
 *   - Estimar DSP load como % del buffer
 *   - Detectar drift de sample rate (cambios entre llamadas)
 *
 * Diseño:
 *   - Corre su propio RAF loop (independiente de MeteringEngine)
 *   - Throttle a ~15fps (cada 4 frames) — baja presión GC
 *   - Expuesto en consola como window.__ONA_CLOCK
 *
 * Xrun heurístico:
 *   Gap > 3× expected frame interval → probable xrun o suspensión del contexto
 *   No es perfecto pero es suficiente para alertas de performance en Electron.
 */

export interface ClockState {
  sampleRate:    number
  bufferSizeEst: number    // estimación en samples (baseLatency × sampleRate)
  baseLatencyMs: number
  outputLatencyMs: number
  totalLatencyMs:  number
  xruns:           number
  jitterMs:        number  // promedio de jitter en los últimos 30 ticks
  dspLoadPct:      number  // estimación de carga DSP (0-100)
  lastTickMs:      number
  contextState:   AudioContextState
}

class ClockManager {
  private _ctx:    AudioContext | null = null
  private _rafId:  number | null       = null
  private _state:  ClockState = {
    sampleRate: 48000, bufferSizeEst: 0,
    baseLatencyMs: 0, outputLatencyMs: 0, totalLatencyMs: 0,
    xruns: 0, jitterMs: 0, dspLoadPct: 0, lastTickMs: 0,
    contextState: 'suspended',
  }

  private _jitterBuf: number[] = []
  private _lastRaf:   number   = 0
  private _frame:     number   = 0

  // ── Inicialización ────────────────────────────────────────────────────────────

  attach(ctx: AudioContext): void {
    if (this._ctx) this.destroy()
    this._ctx = ctx
    this._readContext()
    this._startLoop()
    console.log(`[CLOCK] Attached — ${this._state.sampleRate}Hz, ` +
      `latencia: ${this._state.totalLatencyMs.toFixed(1)}ms, ` +
      `buffer est: ${this._state.bufferSizeEst} samples`)
  }

  private _readContext(): void {
    const ctx = this._ctx; if (!ctx) return
    const baseMs   = (ctx.baseLatency   ?? 0) * 1000
    const outputMs = (ctx.outputLatency ?? 0) * 1000
    const sr       = ctx.sampleRate

    this._state.sampleRate      = sr
    this._state.baseLatencyMs   = baseMs
    this._state.outputLatencyMs = outputMs
    this._state.totalLatencyMs  = baseMs + outputMs
    this._state.bufferSizeEst   = Math.round(ctx.baseLatency * sr)
    this._state.contextState    = ctx.state
  }

  // ── RAF loop de monitoreo ─────────────────────────────────────────────────────

  private _startLoop(): void {
    const INTERVAL = 16.7 * 4  // ~4 frames a 60fps ≈ 66ms esperado

    const tick = (now: number) => {
      this._rafId = requestAnimationFrame(tick)

      if ((this._frame++ & 3) !== 0) return  // throttle a ~15fps

      // Jitter y xruns
      if (this._lastRaf > 0) {
        const delta  = now - this._lastRaf
        const jitter = Math.abs(delta - INTERVAL)
        this._jitterBuf.push(jitter)
        if (this._jitterBuf.length > 30) this._jitterBuf.shift()

        if (delta > INTERVAL * 3) {
          this._state.xruns++
          console.warn(`[CLOCK] Xrun #${this._state.xruns} — gap ${delta.toFixed(0)}ms (esperado ~${INTERVAL.toFixed(0)}ms)`)
        }
      }
      this._lastRaf = now

      // Jitter promedio
      if (this._jitterBuf.length > 0) {
        this._state.jitterMs = this._jitterBuf.reduce((a, b) => a + b, 0) / this._jitterBuf.length
      }

      // DSP load estimado: ratio jitter/buffer (heurístico)
      if (this._state.bufferSizeEst > 0 && this._state.sampleRate > 0) {
        const bufMs     = (this._state.bufferSizeEst / this._state.sampleRate) * 1000
        this._state.dspLoadPct = Math.min(100, (this._state.jitterMs / bufMs) * 100)
      }

      this._state.lastTickMs = now

      // Re-leer contexto periódicamente (sampleRate puede cambiar en hotplug)
      this._readContext()
    }

    this._rafId = requestAnimationFrame(tick)
  }

  // ── API pública ───────────────────────────────────────────────────────────────

  getState(): Readonly<ClockState> { return { ...this._state } }
  getLatencyMs():  number          { return this._state.totalLatencyMs }
  getSampleRate(): number          { return this._state.sampleRate }
  getXruns():      number          { return this._state.xruns }
  resetXruns():    void            { this._state.xruns = 0; this._jitterBuf = [] }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  destroy(): void {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null }
    this._ctx         = null
    this._jitterBuf   = []
    this._lastRaf     = 0
    this._frame       = 0
    this._state.contextState = 'closed'
  }
}

export const clockManager = new ClockManager()
export default clockManager

// ── Exposición en consola ─────────────────────────────────────────────────────
;(window as any).__ONA_CLOCK = {
  state:       () => clockManager.getState(),
  latency:     () => `${clockManager.getLatencyMs().toFixed(2)}ms`,
  sampleRate:  () => clockManager.getSampleRate(),
  xruns:       () => clockManager.getXruns(),
  resetXruns:  () => { clockManager.resetXruns(); console.log('[CLOCK] Xruns reseteados') },
}
