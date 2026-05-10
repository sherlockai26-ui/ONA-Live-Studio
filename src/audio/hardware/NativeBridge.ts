/**
 * NativeBridge.ts — Puente experimental hacia audio nativo (ASIO/WASAPI/CoreAudio)
 *
 * Objetivo: preparar la integración con naudiodon para acceso directo a:
 *   - ASIO (Windows, baja latencia)
 *   - WASAPI exclusive (Windows)
 *   - CoreAudio (macOS)
 *
 * Arquitectura:
 *   Renderer (NativeBridge.ts)
 *     → IPC invoke 'native-audio-probe'
 *     → Main process (main.cjs)
 *     → require('naudiodon') — si está instalado
 *     → retorna { available: true, devices: [...] }
 *
 * Para instalar naudiodon (opcional — el app funciona sin él):
 *   npm install naudiodon
 *   (requiere node-gyp y compilación nativa)
 *
 * Estado actual: DETECTION ONLY — streaming nativo pendiente para Paso 4+
 *
 * Expuesto en consola como:
 *   window.__ONA_NATIVE.isAvailable()
 *   window.__ONA_NATIVE.getDevices()
 *   window.__ONA_NATIVE.getCapabilities()
 */

export interface NativeAudioDevice {
  id:               number
  name:             string
  maxInputChannels: number
  maxOutputChannels: number
  defaultSampleRate: number
  isDefaultInput:   boolean
  isDefaultOutput:  boolean
}

export interface NativeCapabilities {
  available:   boolean
  asio:        boolean
  wasapi:      boolean
  coreAudio:   boolean
  devices:     NativeAudioDevice[]
  version?:    string
}

class NativeBridge {
  private _probed      = false
  private _available   = false
  private _devices:    NativeAudioDevice[] = []
  private _caps:       NativeCapabilities | null = null

  // ── Probe — llamar una vez, después del init ──────────────────────────────────

  async probe(): Promise<NativeCapabilities> {
    if (this._probed) return this._caps!

    try {
      const api = (window as any).electronAPI
      if (!api?.probeNativeAudio) {
        // Fuera de Electron (browser dev) — nativo no disponible
        return this._buildCaps(false, [])
      }

      const result = await api.probeNativeAudio()
      this._available = result?.available === true
      this._devices   = result?.devices ?? []

      if (this._available) {
        console.log(`[NATIVE] naudiodon disponible — ${this._devices.length} dispositivos detectados`)
        this._logDevices()
      } else {
        console.log('[NATIVE] Audio nativo no disponible. Para ASIO/WASAPI: npm install naudiodon')
      }
    } catch (err) {
      console.warn('[NATIVE] probe IPC falló:', err)
      this._available = false
    }

    this._probed = true
    this._caps   = this._buildCaps(this._available, this._devices)
    return this._caps
  }

  private _buildCaps(available: boolean, devices: NativeAudioDevice[]): NativeCapabilities {
    const platform = (window as any).ona?.platform ?? 'unknown'
    return {
      available,
      asio:      available && platform === 'win32' && devices.some(d => /asio/i.test(d.name)),
      wasapi:    available && platform === 'win32',
      coreAudio: available && platform === 'darwin',
      devices,
    }
  }

  private _logDevices(): void {
    for (const d of this._devices) {
      const io = `in=${d.maxInputChannels} out=${d.maxOutputChannels}`
      console.log(`  [NATIVE]   #${d.id}: ${d.name} (${io}, ${d.defaultSampleRate}Hz)` +
        `${d.isDefaultInput ? ' [DEFAULT IN]' : ''}${d.isDefaultOutput ? ' [DEFAULT OUT]' : ''}`)
    }
  }

  // ── API pública ───────────────────────────────────────────────────────────────

  isAvailable():  boolean             { return this._available }
  isProbed():     boolean             { return this._probed }
  getDevices():   NativeAudioDevice[] { return [...this._devices] }
  getCapabilities(): NativeCapabilities {
    return this._caps ?? this._buildCaps(false, [])
  }

  getAsioDevices(): NativeAudioDevice[] {
    return this._devices.filter(d => /asio/i.test(d.name))
  }

  getWasapiDevices(): NativeAudioDevice[] {
    return this._devices.filter(d => /wasapi/i.test(d.name))
  }

  // Futuro Paso 4: openNativeStream(deviceId, sampleRate, bufferSize)
  // Por ahora retorna instrucciones
  openNativeStream(_deviceId: number): string {
    if (!this._available) {
      return 'naudiodon no instalado. Ejecutar: npm install naudiodon'
    }
    return 'Native streaming pendiente — implementar en Paso 4 (DSP Thread)'
  }
}

export const nativeBridge = new NativeBridge()
export default nativeBridge

// ── Exposición en consola ─────────────────────────────────────────────────────
;(window as any).__ONA_NATIVE = {
  isAvailable:     () => nativeBridge.isAvailable(),
  getDevices:      () => nativeBridge.getDevices(),
  getCapabilities: () => nativeBridge.getCapabilities(),
  getAsioDevices:  () => nativeBridge.getAsioDevices(),
}
