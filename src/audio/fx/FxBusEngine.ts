/**
 * FxBusEngine.ts — 4 buses FX profesionales con procesador intercambiable.
 *
 * Arquitectura por bus (Paso 12):
 *   input (GainNode) → [bypass | processor.input → processor.output] → mid(GainNode) → returnGain → mainBus
 *
 *   Sin processor:   input → bypass → mid → returnGain
 *   Con processor:   input → processor.input; processor.output → mid → returnGain
 *
 * Processor slot:
 *   Cada bus aloja UN processor (DelayEngine | ReverbEngine) intercambiable en vivo.
 *   attachProcessor(busId, proc, type): cablea processor, desconecta bypass.
 *   detachProcessor(busId): desconecta processor, reconecta bypass.
 *
 * NOTA: AnalyserNode + watchRunaway() deshabilitados — causan ACCESS_VIOLATION (-1073741819)
 *   con WASAPI en Electron/Windows cuando el hilo de audio nativo hace su primer render.
 *   mid es un GainNode pasante que preserva el grafo sin AnalyserNode.
 *
 * Sends de canal:
 *   ChannelStrip.setFxBusSend(busId, fxBusEngine.getInput(busId), params)
 *   — mismo patrón lazy que setAuxSend() (preFaderTap | postFaderTap → sendGain → busInput).
 *
 * Return routing:
 *   returnGain → mainBus (sumador del main mix).
 *   Retorno directo al main mix — no pasa por RoutingMatrix.
 */

import * as Tone from 'tone'
import type { DelayEngine } from './DelayEngine'
import type { ReverbEngine } from './ReverbEngine'

function _toneCtx() { return Tone.getContext() as unknown as AudioContext }

export const NUM_FX_BUSES = 4

type FxProcessor = DelayEngine | ReverbEngine

export interface FxBusState {
  id:            number
  active:        boolean
  wetLevel:      number   // 0–100
  processorType: 'delay' | 'reverb' | null
}

interface FxBusNodes {
  input:       GainNode
  bypass:      GainNode
  mid:         GainNode    // AnalyserNode deshabilitado — ACCESS_VIOLATION con WASAPI en Electron/Windows
  returnGain:  GainNode
  processor:   FxProcessor | null
  state:       FxBusState
}

function fxVolToGain(vol: number): number { return vol <= 0 ? 0 : vol / 100 }

class FxBusEngineImpl {
  private _buses = new Map<number, FxBusNodes>()
  private _ctx:   AudioContext | null = null

  // ── Initialize ────────────────────────────────────────────────────────────────

  initialize(ctx: AudioContext, mainBus: GainNode): void {
    this._ctx = ctx
    const nc  = _toneCtx()
    for (let i = 1; i <= NUM_FX_BUSES; i++) {
      const input      = nc.createGain()
      const bypass     = nc.createGain()
      const mid        = nc.createGain()   // passthrough — AnalyserNode deshabilitado (ACCESS_VIOLATION WASAPI)
      const returnGain = nc.createGain()

      input.gain.value      = 1
      bypass.gain.value     = 1
      mid.gain.value        = 1
      returnGain.gain.value = 0   // silent until activated

      // Default bypass path
      input.connect(bypass)
      bypass.connect(mid)
      mid.connect(returnGain)

      // Return to main bus
      returnGain.connect(mainBus)

      this._buses.set(i, {
        input, bypass, mid, returnGain,
        processor:   null,
        state: { id: i, active: false, wetLevel: 100, processorType: null },
      })
    }
    console.log(`[FxBus] ${NUM_FX_BUSES} buses listos`)
  }

  // ── Accessors for channel sends and matrix registration ───────────────────────

  getInput(id: number): GainNode | null {
    return this._buses.get(id)?.input ?? null
  }

  getReturn(id: number): GainNode | null {
    return this._buses.get(id)?.returnGain ?? null
  }

  // ── Processor attachment ──────────────────────────────────────────────────────

  attachProcessor(id: number, processor: FxProcessor, type: 'delay' | 'reverb'): void {
    const b = this._buses.get(id)
    if (!b || !this._ctx) return

    // Detach existing processor first
    if (b.processor) this._detachInternal(b)

    // Disconnect bypass path
    try { b.input.disconnect(b.bypass) } catch (_) {}

    // Wire processor
    b.input.connect(processor.input)
    processor.output.connect(b.mid)

    b.processor = processor
    b.state.processorType = type
    console.log(`[FxBus ${id}] ${type} processor attached`)
  }

  detachProcessor(id: number): void {
    const b = this._buses.get(id)
    if (!b) return
    this._detachInternal(b)
  }

  private _detachInternal(b: FxBusNodes): void {
    if (!b.processor) return
    try { b.input.disconnect(b.processor.input)     } catch (_) {}
    try { b.processor.output.disconnect(b.mid)      } catch (_) {}
    // Restore bypass
    b.input.connect(b.bypass)
    b.state.processorType = null
    b.processor = null
  }

  // ── Bus control ───────────────────────────────────────────────────────────────

  setActive(id: number, active: boolean): void {
    const b = this._buses.get(id)
    if (!b || !this._ctx) return
    b.state.active = active
    const target = active ? fxVolToGain(b.state.wetLevel) : 0
    b.returnGain.gain.setTargetAtTime(target, this._ctx.currentTime, 0.007)
  }

  setWetLevel(id: number, level: number): void {
    const b = this._buses.get(id)
    if (!b || !this._ctx) return
    b.state.wetLevel = Math.max(0, Math.min(100, level))
    if (b.state.active) {
      b.returnGain.gain.setTargetAtTime(fxVolToGain(b.state.wetLevel), this._ctx.currentTime, 0.007)
    }
  }

  // ── Metering ──────────────────────────────────────────────────────────────────

  getMeterValue(_id: number): number {
    return -Infinity  // AnalyserNode deshabilitado — software metering no implementado para FX buses
  }

  // ── State ─────────────────────────────────────────────────────────────────────

  getState(id: number): FxBusState | null {
    return this._buses.get(id)?.state ?? null
  }

  getAllStates(): FxBusState[] {
    return Array.from(this._buses.values()).map(b => b.state)
  }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    for (const b of this._buses.values()) {
      if (b.processor) {
        try { b.processor.destroy() } catch (_) {}
      }
      for (const n of [b.input, b.bypass, b.mid, b.returnGain] as AudioNode[]) {
        try { n.disconnect() } catch (_) {}
      }
    }
    this._buses.clear()
    this._ctx = null
  }
}

export const fxBusEngine = new FxBusEngineImpl()
