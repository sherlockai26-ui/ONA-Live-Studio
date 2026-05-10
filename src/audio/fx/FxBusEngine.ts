/**
 * FxBusEngine.ts — 4 buses FX profesionales con procesador intercambiable.
 *
 * Arquitectura por bus (Paso 12):
 *   input (GainNode) → [bypass | processor.input → processor.output] → analyser → returnGain → mainBus
 *
 *   Sin processor:   input → bypass → analyser → returnGain
 *   Con processor:   input → processor.input; processor.output → analyser → returnGain
 *
 * Processor slot:
 *   Cada bus aloja UN processor (DelayEngine | ReverbEngine) intercambiable en vivo.
 *   attachProcessor(busId, proc, type): cablea processor, desconecta bypass.
 *   detachProcessor(busId): desconecta processor, reconecta bypass.
 *
 * Protección CPU:
 *   watchRunaway() en cada analyser: peak > 1.4 (+3dBFS) → silencia returnGain.
 *   Processor destruye sus propios denormal kicks en destroy().
 *
 * Sends de canal:
 *   ChannelStrip.setFxBusSend(busId, fxBusEngine.getInput(busId), params)
 *   — mismo patrón lazy que setAuxSend() (preFaderTap | postFaderTap → sendGain → busInput).
 *
 * Return routing:
 *   returnGain → mainBus (sumador del main mix).
 *   Retorno directo al main mix — no pasa por RoutingMatrix.
 */

import { watchRunaway } from './FxCpuProtection'
import type { DelayEngine } from './DelayEngine'
import type { ReverbEngine } from './ReverbEngine'

export const NUM_FX_BUSES = 4

const ANALYSER_FFT_FX = 256

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
  analyser:    AnalyserNode
  peakBuf:     Float32Array
  returnGain:  GainNode
  processor:   FxProcessor | null
  stopRunaway: (() => void) | null
  state:       FxBusState
}

function fxVolToGain(vol: number): number { return vol <= 0 ? 0 : vol / 100 }

class FxBusEngineImpl {
  private _buses = new Map<number, FxBusNodes>()
  private _ctx:   AudioContext | null = null

  // ── Initialize ────────────────────────────────────────────────────────────────

  initialize(ctx: AudioContext, mainBus: GainNode): void {
    this._ctx = ctx
    for (let i = 1; i <= NUM_FX_BUSES; i++) {
      const input      = ctx.createGain()
      const bypass     = ctx.createGain()
      const analyser   = ctx.createAnalyser()
      const returnGain = ctx.createGain()

      analyser.fftSize               = ANALYSER_FFT_FX
      analyser.smoothingTimeConstant = 0
      input.gain.value      = 1
      bypass.gain.value     = 1
      returnGain.gain.value = 0   // silent until activated

      // Default bypass path
      input.connect(bypass)
      bypass.connect(analyser)
      analyser.connect(returnGain)

      // Return to main bus
      returnGain.connect(mainBus)

      // Runaway protection: silence on overload
      const stopRunaway = watchRunaway(analyser, () => {
        console.warn(`[FxBus ${i}] Runaway detected — silencing bus`)
        returnGain.gain.setTargetAtTime(0, ctx.currentTime, 0.001)
      })

      this._buses.set(i, {
        input, bypass, analyser, returnGain,
        peakBuf:     new Float32Array(ANALYSER_FFT_FX),
        processor:   null,
        stopRunaway,
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
    processor.output.connect(b.analyser)

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
    try { b.input.disconnect(b.processor.input)       } catch (_) {}
    try { b.processor.output.disconnect(b.analyser)   } catch (_) {}
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

  getMeterValue(id: number): number {
    const b = this._buses.get(id)
    if (!b) return -Infinity
    b.analyser.getFloatTimeDomainData(b.peakBuf)
    let peak = 0
    for (let i = 0; i < b.peakBuf.length; i++) {
      const a = Math.abs(b.peakBuf[i])
      if (a > peak) peak = a
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity
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
      b.stopRunaway?.()
      if (b.processor) {
        try { b.processor.destroy() } catch (_) {}
      }
      for (const n of [b.input, b.bypass, b.analyser, b.returnGain] as AudioNode[]) {
        try { n.disconnect() } catch (_) {}
      }
    }
    this._buses.clear()
    this._ctx = null
  }
}

export const fxBusEngine = new FxBusEngineImpl()
