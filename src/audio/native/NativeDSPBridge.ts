/**
 * NativeDSPBridge.ts — Puente entre ONA y el engine DSP nativo (Rust).
 *
 * Responsabilidades:
 *   1. Detectar si el módulo Rust está disponible (via window.onaNative)
 *   2. Instanciar NativeChannelProcessor por canal (o fallback JS)
 *   3. Exponer API unificada IDSPChannel — la UI NO sabe qué backend usa
 *   4. Health checks periódicos
 *   5. DSP capability report en consola
 *
 * Estrategia de carga (Electron contextIsolation: true):
 *   El módulo .node se carga en electron/preload.cjs (acceso Node.js).
 *   Preload expone window.onaNative con los métodos del módulo nativo.
 *   Si window.onaNative no existe → fallback automático a WebAudioDSPFallback.
 *
 * Threading design (Paso 6 — baseline para migración futura):
 *   Paso 6:  DSP síncrono en preload (mismo proceso renderer, sub-microsegundo)
 *   Paso 7+: Worker Thread con SAB bidireccional, zero-copy real
 */

import type {
  IDSPChannel,
  DSPBridgeStatus,
  DSPBackend,
  NativeCapabilities,
  BenchmarkResult,
  BlockResult,
} from './types'
import { WebAudioDSPChannel } from './WebAudioDSPFallback'

// ─── Interfaz de lo que preload expone en window.onaNative ───────────────────

interface OnaNativeWindow {
  engineVersion():   string
  getCapabilities(): NativeCapabilities
  createProcessor(channelId: number, sampleRate: number, blockSize: number): string
  destroyProcessor(handle: string): void
  setGainDb(handle: string, db: number): void
  setGainLinear(handle: string, gain: number): void
  setPan(handle: string, pan: number): void
  setBypass(handle: string, bypass: boolean): void
  resetMeters(handle: string): void
  processBlock(handle: string, samples: Float32Array): BlockResult
  processShared(handle: string, buffer: Uint8Array, offset: number, count: number): BlockResult
  benchmarkProcessing(blockSize: number, numBlocks: number, sampleRate: number): BenchmarkResult
}

declare global {
  interface Window {
    onaNative?: OnaNativeWindow
  }
}

// ─── Canal nativo (wrapper sobre window.onaNative handles) ───────────────────

class NativeDSPChannelWrapper implements IDSPChannel {
  constructor(
    private readonly _handle: string,
    private readonly _native: OnaNativeWindow,
  ) {}

  setGainDb(db: number):       void { this._native.setGainDb(this._handle, db) }
  setGainLinear(gain: number): void { this._native.setGainLinear(this._handle, gain) }
  setPan(pan: number):         void { this._native.setPan(this._handle, pan) }
  setBypass(b: boolean):       void { this._native.setBypass(this._handle, b) }
  resetMeters():               void { this._native.resetMeters(this._handle) }

  processBlock(samples: Float32Array): BlockResult {
    return this._native.processBlock(this._handle, samples)
  }

  processShared(buffer: Uint8Array, offset: number, count: number): BlockResult {
    return this._native.processShared(this._handle, buffer, offset, count)
  }

  dispose(): void {
    try { this._native.destroyProcessor(this._handle) } catch (_) {}
  }
}

// ─── NativeDSPBridge (singleton) ─────────────────────────────────────────────

class NativeDSPBridge {
  private static _inst: NativeDSPBridge | null = null

  static getInstance(): NativeDSPBridge {
    if (!NativeDSPBridge._inst) NativeDSPBridge._inst = new NativeDSPBridge()
    return NativeDSPBridge._inst
  }

  private _status: DSPBridgeStatus = { backend: 'webaudio-fallback', available: false }
  private _native: OnaNativeWindow | null = null
  private _channels = new Map<number, IDSPChannel>()
  private _wrappers = new Map<number, NativeDSPChannelWrapper>()
  private _sampleRate = 48000
  private _blockSize  = 128

  /** Inicializa el bridge. Llama desde AudioEngineSingleton.initialize(). */
  initialize(sampleRate: number, blockSize = 128): void {
    this._sampleRate = sampleRate
    this._blockSize  = blockSize
    this._probe()
    this._reportCapabilities()
    this._exposeConsoleAPI()
  }

  // ── Detección del módulo nativo ─────────────────────────────────────────────

  private _probe(): void {
    const native = (window as any).onaNative as OnaNativeWindow | undefined
    if (!native) {
      this._status = {
        backend:   'webaudio-fallback',
        available: false,
        error:     'window.onaNative no expuesto — Rust no compilado o preload sin cargar',
      }
      console.warn('[NATIVE-DSP] Módulo nativo no disponible → fallback WebAudio activo')
      return
    }

    try {
      const version      = native.engineVersion()
      const capabilities = native.getCapabilities()
      this._native = native
      this._status = {
        backend:      'native-rust',
        available:    true,
        version,
        capabilities,
      }
      console.log(`[NATIVE-DSP] Módulo Rust activo — ${version}`)
    } catch (err) {
      this._status = {
        backend:   'webaudio-fallback',
        available: false,
        error:     String(err),
      }
      console.error('[NATIVE-DSP] Error al cargar módulo nativo:', err)
    }
  }

  // ── Canal DSP (factory) ─────────────────────────────────────────────────────

  /**
   * Crea o retorna el IDSPChannel para el canal dado.
   * Primer llamado: crea instancia (nativa o fallback).
   * Llamadas subsiguientes: retorna la instancia existente.
   */
  getChannel(channelId: number): IDSPChannel {
    const existing = this._channels.get(channelId)
    if (existing) return existing

    const ch = this._createChannel(channelId)
    this._channels.set(channelId, ch)
    return ch
  }

  private _createChannel(channelId: number): IDSPChannel {
    if (this._native) {
      try {
        const handle  = this._native.createProcessor(channelId, this._sampleRate, this._blockSize)
        const wrapper = new NativeDSPChannelWrapper(handle, this._native)
        this._wrappers.set(channelId, wrapper)
        return wrapper
      } catch (err) {
        console.warn(`[NATIVE-DSP] No se pudo crear NativeProcessor ch${channelId}, usando fallback:`, err)
      }
    }
    return new WebAudioDSPChannel(channelId, this._sampleRate)
  }

  destroyChannel(channelId: number): void {
    this._wrappers.get(channelId)?.dispose()
    this._wrappers.delete(channelId)
    this._channels.delete(channelId)
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  get status(): DSPBridgeStatus          { return this._status }
  get backend(): DSPBackend              { return this._status.backend }
  get isNative(): boolean                { return this._status.available }
  get capabilities(): NativeCapabilities | undefined { return this._status.capabilities }

  /** Health check — verifica que el módulo sigue respondiendo. */
  healthCheck(): boolean {
    if (!this._native) return false
    try {
      this._native.engineVersion()
      return true
    } catch (_) {
      console.error('[NATIVE-DSP] Health check falló — módulo no responde')
      return false
    }
  }

  // ── Benchmark ───────────────────────────────────────────────────────────────

  async benchmarkNative(blockSize = 128, numBlocks = 10_000): Promise<BenchmarkResult | null> {
    if (!this._native) return null
    try {
      return this._native.benchmarkProcessing(blockSize, numBlocks, this._sampleRate)
    } catch (err) {
      console.error('[NATIVE-DSP] Benchmark nativo falló:', err)
      return null
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  destroy(): void {
    for (const [id] of this._channels) this.destroyChannel(id)
    this._channels.clear()
    this._native = null
    NativeDSPBridge._inst = null
  }

  // ── Console API ─────────────────────────────────────────────────────────────

  private _reportCapabilities(): void {
    const s = this._status
    if (s.available && s.capabilities) {
      const c = s.capabilities
      console.group('[NATIVE-DSP] Capacidades del engine nativo')
      console.log(`  Backend:  ${s.backend}`)
      console.log(`  Versión:  ${s.version}`)
      console.log(`  Gain:     ${c.gain}   Pan: ${c.pan}`)
      console.log(`  Peak:     ${c.peakMeter}   RMS: ${c.rmsMeter}`)
      console.log(`  SAB:      ${c.sharedMemory}   SIMD: ${c.simd}`)
      console.groupEnd()
    } else {
      console.info(
        `[NATIVE-DSP] Usando fallback WebAudio (${s.error ?? 'módulo no disponible'}).\n` +
        `  Para activar Rust: instala Rust toolchain y ejecuta: npm run build:native`
      )
    }
  }

  private _exposeConsoleAPI(): void {
    ;(window as any).__ONA_NATIVE = {
      status:      () => this._status,
      healthCheck: () => this.healthCheck(),
      benchmark:   (bs?: number, nb?: number) => this.benchmarkNative(bs, nb),
      channels:    () => Array.from(this._channels.keys()),
    }
  }
}

export const nativeDSPBridge = NativeDSPBridge.getInstance()
export default nativeDSPBridge
