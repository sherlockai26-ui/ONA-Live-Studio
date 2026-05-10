/**
 * MeteringEngine.ts — RAF loop de metering desacoplado de AudioEngineSingleton.
 *
 * Paso 7 optimizations:
 *   - Pre-allocated _data object: cero allocations en el RAF loop (sin GC)
 *   - Pre-computed string keys: sin template literals en hot path
 *   - Time-based throttle 25fps (40ms): comportamiento consistente sin importar
 *     el refresh rate del monitor (no depende de frame count modulo)
 *
 * Layout SAB Float32 (índice → dato):
 *   0..5   → output dBFS canal 1..6
 *   6      → main bus dBFS
 *   7      → sub bus dBFS
 *   8..13  → gain reduction compresor canal 1..6
 *   14..19 → nivel gate canal 1..6
 */

import type { ChannelStrip } from './ChannelStrip'
import type { BusEngine }    from './BusEngine'
import { workletManager }    from './WorkletManager'
import { cpuSafetyMode }     from './CPUSafetyMode'

const SAB_LEN = 20
// Default 40ms (25fps). cpuSafetyMode.meteringIntervalMs overrides in-flight.
const TICK_INTERVAL_DEFAULT_MS = 40

type MeterCallback = (data: Record<string, number>) => void

export class MeteringEngine {
  private _buf: Float32Array
  private _rafId:     number | null = null
  private _strips:    Map<number, ChannelStrip> | null = null
  private _busEngine: BusEngine | null                 = null
  private _cbs = new Set<MeterCallback>()

  // Paso 7: objeto pre-allocado con todas las keys — sin new {} en RAF loop
  private _data: Record<string, number> = {}

  // Paso 7: pre-computed key strings — sin template literals en hot path
  private _grKeys:   string[] = []
  private _gateKeys: string[] = []

  // Paso 7: time-based throttle — elimina dependencia del refresh rate
  private _lastTickMs      = 0
  private _tickIntervalMs  = TICK_INTERVAL_DEFAULT_MS  // overridable by CPUSafetyMode

  constructor() {
    try {
      const sab = new SharedArrayBuffer(SAB_LEN * Float32Array.BYTES_PER_ELEMENT)
      this._buf = new Float32Array(sab)
    } catch {
      this._buf = new Float32Array(SAB_LEN)
    }
    this._buf.fill(-Infinity)
  }

  getBuffer(): Float32Array { return this._buf }

  onUpdate(cb: MeterCallback): () => void {
    this._cbs.add(cb)
    return () => this._cbs.delete(cb)
  }

  start(strips: Map<number, ChannelStrip>, busEngine: BusEngine): void {
    if (this._rafId !== null) return
    this._strips    = strips
    this._busEngine = busEngine

    // Pre-allocar objeto y keys — una sola vez al inicio
    this._data    = {}
    this._grKeys  = []
    this._gateKeys = []
    for (const id of strips.keys()) {
      this._data[id]          = -Infinity
      const grKey   = `gr_${id}`
      const gateKey = `gate_${id}`
      this._data[grKey]   = 0
      this._data[gateKey] = 1
      this._grKeys.push(grKey)
      this._gateKeys.push(gateKey)
    }
    this._data._main = -Infinity
    this._data._sub  = -Infinity

    this._lastTickMs = 0

    const tick = (now: number) => {
      // Reagendar PRIMERO — loop sobrevive a excepciones en el cuerpo
      this._rafId = requestAnimationFrame(tick)

      // Throttle time-based — interval controlled by CPUSafetyMode (Paso 11)
      this._tickIntervalMs = cpuSafetyMode.meteringIntervalMs
      if (now - this._lastTickMs < this._tickIntervalMs) return
      this._lastTickMs = now

      // Leer canales + gate + escribir SAB
      try {
        let idx = 0
        for (const [id, strip] of this._strips!) {
          try {
            const m = strip.tickMeter()
            const gateLevel = (workletManager.isReady() && strip.isUsingWorkletGate())
              ? workletManager.getGateLevel(id)
              : m.gateLevel

            // Mutación directa — sin allocations
            this._data[id]              = m.outputDb
            this._data[this._grKeys[idx]]   = m.gainReduction
            this._data[this._gateKeys[idx]] = gateLevel
            this._buf[idx]      = m.outputDb
            this._buf[8  + idx] = m.gainReduction
            this._buf[14 + idx] = gateLevel
          } catch (_) {
            this._data[id] = -Infinity
          }
          idx++
        }

        const mn = this._busEngine!.getMeterValue('main')
        const sb = this._busEngine!.getMeterValue('sub')
        this._data._main = mn
        this._data._sub  = sb
        this._buf[6] = mn
        this._buf[7] = sb
      } catch (_) {}

      // Notificar callbacks legacy (síncrono — data object reutilizado)
      if (!(window as any).__ONA_METERING_DISABLED) {
        for (const cb of this._cbs) { try { cb(this._data) } catch (_) {} }
      }
    }

    this._rafId = requestAnimationFrame(tick)
  }

  /** Returns the last known output dBFS for a channel (from the RAF tick data object). */
  getChannelMeter(id: number): number {
    return (this._data[id] as number | undefined) ?? -Infinity
  }

  stop(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
    this._strips    = null
    this._busEngine = null
    this._cbs.clear()
    this._buf.fill(-Infinity)
    this._data = {}
    this._grKeys  = []
    this._gateKeys = []
  }
}
