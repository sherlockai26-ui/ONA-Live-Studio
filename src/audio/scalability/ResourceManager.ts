/**
 * ResourceManager.ts — Dynamic DSP resource management.
 *
 * Policies:
 *   Meter idle:    no subscriber read for > METER_IDLE_MS → suspend analyser reads
 *   FX bus idle:   peak < -60 dBFS for > FX_IDLE_MS → mark idle (skip metering)
 *   Aux bus idle:  no active sends for > AUX_IDLE_MS → skip metering
 *
 * MeteringEngine checks isMeterSuspended() before each analyser read.
 * Suspended meters return the last known value rather than reading the analyser.
 * This saves N × AnalyserNode.getFloatTimeDomainData() calls per RAF frame.
 */

const METER_IDLE_MS = 5_000
const FX_IDLE_MS    = 10_000
const AUDIT_INTERVAL_MS = 2_000

export interface ResourceStats {
  suspendedMeters:    number
  activeFxBuses:      number
  idleFxBuses:        number
  savedAnalyserReads: number
  totalMeters:        number
}

interface MeterTracker {
  id:          string
  lastReadMs:  number
  suspended:   boolean
  lastValue:   number
}

interface FxBusTracker {
  busId:      number
  lastSignalMs: number
  idle:       boolean
}

class ResourceManager {
  private _meters    = new Map<string, MeterTracker>()
  private _fxBuses   = new Map<number, FxBusTracker>()
  private _savedReads = 0
  private _interval:  ReturnType<typeof setInterval> | null = null

  start(): void {
    this._interval = setInterval(() => this._audit(), AUDIT_INTERVAL_MS)
  }

  // ── Meter tracking ────────────────────────────────────────────────────────────

  registerMeter(id: string): void {
    if (!this._meters.has(id)) {
      this._meters.set(id, { id, lastReadMs: Date.now(), suspended: false, lastValue: -Infinity })
    }
  }

  /** Call every time the UI reads a meter value */
  touchMeter(id: string): void {
    const t = this._meters.get(id)
    if (!t) return
    t.lastReadMs = Date.now()
    if (t.suspended) {
      t.suspended = false
      console.debug(`[ResourceMgr] meter resumed: ${id}`)
    }
  }

  isMeterSuspended(id: string): boolean {
    return this._meters.get(id)?.suspended ?? false
  }

  updateMeterValue(id: string, value: number): void {
    const t = this._meters.get(id)
    if (t) t.lastValue = value
  }

  getCachedMeterValue(id: string): number {
    return this._meters.get(id)?.lastValue ?? -Infinity
  }

  // ── FX bus tracking ───────────────────────────────────────────────────────────

  registerFxBus(busId: number): void {
    if (!this._fxBuses.has(busId)) {
      this._fxBuses.set(busId, { busId, lastSignalMs: Date.now(), idle: false })
    }
  }

  touchFxBus(busId: number): void {
    const t = this._fxBuses.get(busId)
    if (!t) return
    t.lastSignalMs = Date.now()
    t.idle         = false
  }

  isFxBusIdle(busId: number): boolean {
    return this._fxBuses.get(busId)?.idle ?? false
  }

  // ── Audit ─────────────────────────────────────────────────────────────────────

  private _audit(): void {
    const now = Date.now()

    for (const t of this._meters.values()) {
      if (!t.suspended && now - t.lastReadMs > METER_IDLE_MS) {
        t.suspended = true
        this._savedReads++
        console.debug(`[ResourceMgr] meter suspended (idle ${((now - t.lastReadMs) / 1000).toFixed(0)}s): ${t.id}`)
      }
    }

    for (const t of this._fxBuses.values()) {
      if (!t.idle && now - t.lastSignalMs > FX_IDLE_MS) {
        t.idle = true
        console.debug(`[ResourceMgr] FX bus ${t.busId} idle`)
      }
    }
  }

  getStats(): ResourceStats {
    let suspended = 0
    for (const t of this._meters.values()) if (t.suspended) suspended++

    let idleFx = 0
    let activeFx = 0
    for (const t of this._fxBuses.values()) {
      if (t.idle) idleFx++; else activeFx++
    }

    return {
      suspendedMeters:    suspended,
      activeFxBuses:      activeFx,
      idleFxBuses:        idleFx,
      savedAnalyserReads: this._savedReads,
      totalMeters:        this._meters.size,
    }
  }

  destroy(): void {
    if (this._interval) clearInterval(this._interval)
    this._meters.clear()
    this._fxBuses.clear()
  }
}

export const resourceManager = new ResourceManager()
