/**
 * CPUSafetyMode.ts — Gestión automática de modos de rendimiento de CPU.
 *
 * Modos (Paso 11):
 *   NORMAL   — operación completa: metering 25fps, validación activa, analizadores pesados
 *   LOW_CPU  — metering 10fps, validación desactivada, analizadores ligeros
 *   SAFE     — metering 5fps, sin validación, sin analizadores pesados, 8ch max grabación
 *
 * Auto-detect: se alimenta con jitter de RAF/DSPScheduler (ms). Si el jitter
 * promedio sube, el modo baja automáticamente. Si baja, el modo sube de vuelta.
 * Hysteresis: 3 evaluaciones consecutivas antes de cambiar para evitar oscilación.
 *
 * Subscribers (e.g. MeteringEngine) reciben callback cuando el modo cambia,
 * para ajustar su TICK_INTERVAL_MS sin tener que releer el modo en cada frame.
 */

export type CpuMode = 'normal' | 'low_cpu' | 'safe'

export interface CpuModeConfig {
  meteringIntervalMs:   number   // RAF throttle para MeteringEngine
  validationEnabled:    boolean  // RoutingValidator, DSPValidator
  heavyAnalysisEnabled: boolean  // AnalyserNode reads, bench, sweep
  maxRecordingChannels: number   // cap de canales simultáneos en grabación
}

export const CPU_MODE_CONFIGS: Record<CpuMode, CpuModeConfig> = {
  normal: {
    meteringIntervalMs:   40,    // 25fps
    validationEnabled:    true,
    heavyAnalysisEnabled: true,
    maxRecordingChannels: 32,
  },
  low_cpu: {
    meteringIntervalMs:   100,   // 10fps
    validationEnabled:    false,
    heavyAnalysisEnabled: false,
    maxRecordingChannels: 16,
  },
  safe: {
    meteringIntervalMs:   200,   // 5fps
    validationEnabled:    false,
    heavyAnalysisEnabled: false,
    maxRecordingChannels: 8,
  },
}

// Auto-detect thresholds (ms jitter, promedio últimas N muestras)
const JITTER_HIGH  = 20   // ms — trigger downgrade
const JITTER_MED   = 10   // ms — trigger low_cpu
const JITTER_OK    = 5    // ms — allow upgrade
const SAMPLE_SIZE  = 8    // muestras de jitter para promediar
const HYSTERESIS   = 3    // evaluaciones consecutivas antes de cambiar modo

type ModeCallback = (mode: CpuMode, config: CpuModeConfig) => void

class CPUSafetyModeImpl {
  private _mode:      CpuMode    = 'normal'
  private _callbacks: Set<ModeCallback> = new Set()
  private _autoTimer: ReturnType<typeof setInterval> | null = null
  private _jitter:    number[]   = []
  private _pending:   CpuMode | null = null
  private _pendingCount = 0

  get mode():   CpuMode       { return this._mode }
  get config(): CpuModeConfig { return CPU_MODE_CONFIGS[this._mode] }

  // ── Manual control ────────────────────────────────────────────────────────────

  setMode(mode: CpuMode): void {
    if (this._mode === mode) return
    const prev = this._mode
    this._mode = mode
    this._pending      = null
    this._pendingCount = 0
    console.log(`[CPUMode] ${prev.toUpperCase()} → ${mode.toUpperCase()}`)
    const cfg = CPU_MODE_CONFIGS[mode]
    for (const cb of this._callbacks) { try { cb(mode, cfg) } catch (_) {} }
  }

  onModeChange(cb: ModeCallback): () => void {
    this._callbacks.add(cb)
    return () => this._callbacks.delete(cb)
  }

  // ── Auto-detect ───────────────────────────────────────────────────────────────

  /** Start automatic CPU mode detection. getJitterMs is called every evalIntervalMs. */
  startAutoDetect(getJitterMs: () => number, evalIntervalMs = 5000): void {
    this.stopAutoDetect()
    this._jitter = []
    this._autoTimer = setInterval(() => {
      const j = getJitterMs()
      if (!isFinite(j) || j < 0) return
      this._jitter.push(j)
      if (this._jitter.length > SAMPLE_SIZE) this._jitter.shift()
      this._evaluate()
    }, evalIntervalMs)
  }

  stopAutoDetect(): void {
    if (this._autoTimer) { clearInterval(this._autoTimer); this._autoTimer = null }
    this._jitter = []
    this._pending = null
    this._pendingCount = 0
  }

  /** Feed a jitter sample manually (without auto-detect timer). */
  recordJitter(jitterMs: number): void {
    if (!isFinite(jitterMs) || jitterMs < 0) return
    this._jitter.push(jitterMs)
    if (this._jitter.length > SAMPLE_SIZE) this._jitter.shift()
  }

  private _evaluate(): void {
    if (this._jitter.length < 3) return
    const avg = this._jitter.reduce((a, b) => a + b, 0) / this._jitter.length

    let target: CpuMode
    if      (avg > JITTER_HIGH) target = 'safe'
    else if (avg > JITTER_MED)  target = 'low_cpu'
    else if (avg < JITTER_OK)   target = 'normal'
    else                        return  // in acceptable range — no change

    if (target === this._mode) { this._pending = null; this._pendingCount = 0; return }

    // Hysteresis: must evaluate the same target N times before switching
    if (target === this._pending) {
      this._pendingCount++
      if (this._pendingCount >= HYSTERESIS) this.setMode(target)
    } else {
      this._pending      = target
      this._pendingCount = 1
    }
  }

  // ── Power efficiency helpers ──────────────────────────────────────────────────

  /** True if metering should run a full analysis cycle this tick (cheap gate). */
  shouldRunFullMeter(): boolean { return this._mode !== 'safe' }

  /** Current metering interval in ms (read by MeteringEngine on each tick). */
  get meteringIntervalMs(): number { return CPU_MODE_CONFIGS[this._mode].meteringIntervalMs }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    this.stopAutoDetect()
    this._callbacks.clear()
  }
}

export const cpuSafetyMode = new CPUSafetyModeImpl()
