/**
 * LazyDSPRegistry.ts — Lazy initialization for per-channel DSP modules.
 *
 * At 64ch startup, many channels will never use EQ, Comp, or Gate.
 * Registering init functions here defers their execution to first use.
 *
 * Modules that benefit from lazy init:
 *   'eq'        — BiquadFilterNode band array (4 filters × N channels)
 *   'gate'      — DynamicsCompressorNode + state machine
 *   'comp'      — DynamicsCompressorNode (parallel comp path)
 *   'auxSend'   — GainNode per aux bus per channel
 *   'fxSend'    — GainNode per FX bus per channel
 *
 * Usage:
 *   lazyDSP.register('eq', channelId, () => strip.initEQ())
 *   // On first setChannelEqBand():
 *   lazyDSP.ensureInit('eq', channelId)
 *   strip.setEqBand(...)
 */

type InitFn = () => void

interface LazyEntry {
  module:       string
  channelId:    number
  initialized:  boolean
  initFn:       InitFn
  initTimeMs:   number | null
}

class LazyDSPRegistry {
  private _registry    = new Map<string, LazyEntry>()
  private _totalInited = 0
  private _totalDeferred = 0

  private _key(module: string, channelId: number): string {
    return `${module}_${channelId}`
  }

  register(module: string, channelId: number, initFn: InitFn): void {
    const key = this._key(module, channelId)
    if (this._registry.has(key)) return
    this._registry.set(key, {
      module, channelId, initialized: false, initFn, initTimeMs: null,
    })
    this._totalDeferred++
  }

  /**
   * Ensure module is initialized for channelId.
   * Returns true if initialization ran (first call), false if already done.
   */
  ensureInit(module: string, channelId: number): boolean {
    const key   = this._key(module, channelId)
    const entry = this._registry.get(key)
    if (!entry || entry.initialized) return false

    const t0 = performance.now()
    try {
      entry.initFn()
    } catch (err) {
      console.error(`[LazyDSP] init failed: ${module}/${channelId}`, err)
      return false
    }
    entry.initialized = true
    entry.initTimeMs  = +(performance.now() - t0).toFixed(2)
    this._totalInited++
    this._totalDeferred = Math.max(0, this._totalDeferred - 1)
    return true
  }

  isInitialized(module: string, channelId: number): boolean {
    const e = this._registry.get(this._key(module, channelId))
    return e?.initialized ?? true  // if not registered, assume already initialized
  }

  /** Initialize all pending entries for a module (e.g., on scene load) */
  initAll(module: string): void {
    for (const entry of this._registry.values()) {
      if (entry.module === module && !entry.initialized) {
        this.ensureInit(module, entry.channelId)
      }
    }
  }

  getStats() {
    const byModule = new Map<string, { total: number; inited: number; avgMs: number; savedMs: number }>()

    for (const e of this._registry.values()) {
      let s = byModule.get(e.module)
      if (!s) { s = { total: 0, inited: 0, avgMs: 0, savedMs: 0 }; byModule.set(e.module, s) }
      s.total++
      if (e.initialized) {
        s.inited++
        s.avgMs += e.initTimeMs ?? 0
      }
    }

    for (const [, s] of byModule) {
      const uninited = s.total - s.inited
      if (s.inited > 0) s.avgMs = +(s.avgMs / s.inited).toFixed(2)
      s.savedMs = +(uninited * s.avgMs).toFixed(2)
    }

    return {
      totalRegistered:  this._registry.size,
      totalInitialized: this._totalInited,
      totalDeferred:    this._totalDeferred,
      estimatedSavedMs: [...byModule.values()].reduce((a, s) => a + s.savedMs, 0).toFixed(1),
      byModule:         Object.fromEntries(byModule),
    }
  }

  clear(): void { this._registry.clear() }
}

export const lazyDSP = new LazyDSPRegistry()
