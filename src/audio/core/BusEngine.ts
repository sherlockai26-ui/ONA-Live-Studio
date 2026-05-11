/**
 * BusEngine.ts — Buses maestros de ONA Live Studio (MAIN y SUB)
 *
 * Paso 7: eliminación completa de Tone.js en los buses.
 *   Tone.Gain   → GainNode  (entrada de canales, sumador)
 *   Tone.Volume → GainNode  (fader maestro, linear gain)
 *   Tone.Meter  → AnalyserNode (peak reading, pre-allocated buffer)
 *
 * Beneficios:
 *   - Sin Tone.js overhead en el path crítico de audio
 *   - AnalyserNode lee peak instantáneo sin scheduler Tone
 *   - getMeterValue() no crea objetos temporales
 */

import * as Tone from 'tone'

// Tone.getContext() en vez de rawContext: los nodos creados via rawCtx
// no quedan registrados en standardized-audio-context, causando
// "A value with the given key could not be found" al conectarlos.
function getRawCtx(): AudioContext {
  return Tone.getContext().rawContext as AudioContext
}

function volToDb(v: number): number  { return v <= 0 ? -Infinity : 20 * Math.log10(v / 100) }
function dbToGain(db: number): number { return db <= -144 ? 0 : Math.pow(10, db / 20) }

const ANALYSER_FFT = 256

export interface BusDef {
  id:       string
  gain:     GainNode     // entrada para canales
  fader:    GainNode     // fader maestro (linear)
  analyser: AnalyserNode // peak read por MeteringEngine
}

export class BusEngine {
  private _buses    = new Map<string, BusDef>()
  private _peakBuf  = new Float32Array(ANALYSER_FFT)  // pre-allocated — sin GC en getMeterValue
  private _destNode: AudioNode | null = null  // stored for protection chain injection

  initialize(): void {
    const ctx = getRawCtx()

    // FIX 4:
    // Conectar directamente al AudioDestinationNode real.
    // Evita incompatibilidad Tone.js ↔ standardized-audio-context.
    const toneDestIn = ctx.destination

    this._destNode = toneDestIn

    for (const id of ['main', 'sub']) {
      const gain     = ctx.createGain()
      gain.gain.value = 1

      const fader    = ctx.createGain()
      fader.gain.value = 1  // 0 dB

      const analyser = ctx.createAnalyser()
      analyser.fftSize = ANALYSER_FFT
      analyser.smoothingTimeConstant = 0.3

      gain.connect(fader)
      fader.connect(toneDestIn)
      fader.connect(analyser)

      this._buses.set(id, { id, gain, fader, analyser })
    }
  }

  /** Returns the destination node (Tone destination input or ctx.destination). */
  getDestNode(): AudioNode | null { return this._destNode }

  getBus(id: string): BusDef | undefined { return this._buses.get(id) }

  /**
   * getMeterValue — peak dBFS del bus.
   * Usa buffer pre-allocado (_peakBuf) — sin new Float32Array() en hot path.
   * Retorna -Infinity si el bus no existe o el analyser no tiene datos.
   */
  getMeterValue(id: string): number {
    const bus = this._buses.get(id)
    if (!bus) return -Infinity

    bus.analyser.getFloatTimeDomainData(this._peakBuf)
    let peak = 0
    const buf = this._peakBuf
    const len = buf.length
    for (let i = 0; i < len; i++) {
      const a = buf[i] < 0 ? -buf[i] : buf[i]
      if (a > peak) peak = a
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity
  }

  setMainVolume(v: number): void {
    const bus = this._buses.get('main')
    if (!bus) return
    const ctx   = getRawCtx()
    const target = dbToGain(volToDb(v))
    bus.fader.gain.setTargetAtTime(target, ctx.currentTime, 0.007)
  }

  setSubVolume(v: number): void {
    const bus = this._buses.get('sub')
    if (!bus) return
    const ctx   = getRawCtx()
    const target = dbToGain(volToDb(v))
    bus.fader.gain.setTargetAtTime(target, ctx.currentTime, 0.007)
  }

  destroy(): void {
    for (const bus of this._buses.values()) {
      try { bus.analyser.disconnect() } catch (_) {}
      try { bus.fader.disconnect()    } catch (_) {}
      try { bus.gain.disconnect()     } catch (_) {}
    }
    this._buses.clear()
  }
}
