/**
 * DeviceManager.ts — Gestión profesional de dispositivos de audio
 *
 * Responsabilidades:
 *   - Enumerar dispositivos de audio (sin getUserMedia en startup — crash seguro)
 *   - Observar cambios de hardware (devicechange event)
 *   - Obtener MediaStreams con constraints profesionales (no EC, no AGC, no NR)
 *   - Validar capabilities de un dispositivo (sampleRate, channelCount, latency)
 *   - Coexiste con deviceService.js — no lo reemplaza, opera en capa diferente
 *
 * IMPORTANTE: getMediaStream() solo llamar DESPUÉS de que el AudioContext esté activo.
 * Antes de eso usar enumerateDevices() que NO llama getUserMedia.
 */

export interface AudioDeviceInfo {
  deviceId: string
  label:    string
  kind:     MediaDeviceKind
  groupId:  string
}

export interface DeviceCapabilities {
  sampleRates:   number[]
  channelCounts: number[]
  latencyRange:  { min: number; max: number }
  echoCancellation: boolean
  autoGainControl:  boolean
}

type DeviceChangeCallback = (devices: AudioDeviceInfo[]) => void

export class DeviceManager {
  private _devices:   AudioDeviceInfo[] = []
  private _watchers:  Set<DeviceChangeCallback> = new Set()
  private _unwatch:   (() => void) | null = null
  private _ready     = false  // true tras primera enumeración exitosa

  // ── Enumeración ───────────────────────────────────────────────────────────────

  async enumerateDevices(): Promise<AudioDeviceInfo[]> {
    try {
      const raw = await navigator.mediaDevices.enumerateDevices()
      this._devices = raw
        .filter(d => d.kind === 'audioinput' || d.kind === 'audiooutput')
        .map(d => ({
          deviceId: d.deviceId,
          label:    d.label || `${d.kind} (${d.deviceId.slice(0, 8)})`,
          kind:     d.kind as MediaDeviceKind,
          groupId:  d.groupId,
        }))
      this._ready = true
      return this._devices
    } catch (err) {
      console.warn('[DEVICE] enumerateDevices falló:', err)
      return this._devices
    }
  }

  getDevices():  AudioDeviceInfo[] { return [...this._devices] }
  getInputs():   AudioDeviceInfo[] { return this._devices.filter(d => d.kind === 'audioinput') }
  getOutputs():  AudioDeviceInfo[] { return this._devices.filter(d => d.kind === 'audiooutput') }
  isReady():     boolean           { return this._ready }

  // ── Observación de cambios ────────────────────────────────────────────────────

  watchDeviceChanges(cb: DeviceChangeCallback): () => void {
    this._watchers.add(cb)
    if (this._watchers.size === 1) this._startWatcher()
    return () => {
      this._watchers.delete(cb)
      if (this._watchers.size === 0) this._stopWatcher()
    }
  }

  private _startWatcher(): void {
    const handler = async () => {
      const devices = await this.enumerateDevices()
      for (const cb of this._watchers) try { cb(devices) } catch (_) {}
    }
    navigator.mediaDevices.addEventListener('devicechange', handler)
    this._unwatch = () => navigator.mediaDevices.removeEventListener('devicechange', handler)
  }

  private _stopWatcher(): void {
    this._unwatch?.()
    this._unwatch = null
  }

  // ── MediaStream con constraints profesionales ─────────────────────────────────

  async getMediaStream(
    deviceId:     string,
    channelCount: number = 2,
    sampleRate?:  number,
  ): Promise<MediaStream | null> {
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId:          { exact: deviceId },
        channelCount:      { ideal: channelCount },
        // Constraints profesionales — deshabilitar todo el procesamiento del browser
        echoCancellation:  false,
        noiseSuppression:  false,
        autoGainControl:   false,
        ...(sampleRate ? { sampleRate: { ideal: sampleRate } } : {}),
      },
      video: false,
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      const track  = stream.getAudioTracks()[0]
      const settings = track?.getSettings()
      console.log(`[DEVICE] Stream abierto — device ${deviceId.slice(0, 8)}, ` +
        `${settings?.sampleRate ?? '?'}Hz, ch=${settings?.channelCount ?? '?'}`)
      return stream
    } catch (err) {
      console.warn(`[DEVICE] getUserMedia falló para ${deviceId.slice(0, 8)}:`, err)
      return null
    }
  }

  async getDefaultStream(channelCount = 2): Promise<MediaStream | null> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { channelCount, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      })
    } catch (err) {
      console.warn('[DEVICE] getDefaultStream falló:', err)
      return null
    }
  }

  // ── Validación de capabilities ────────────────────────────────────────────────

  async validateCapabilities(deviceId: string): Promise<DeviceCapabilities | null> {
    const stream = await this.getMediaStream(deviceId, 1)
    if (!stream) return null

    const track = stream.getAudioTracks()[0]
    const caps  = track?.getCapabilities?.() ?? {}
    const settings = track?.getSettings?.() ?? {}

    // Parar inmediatamente — solo queríamos las capabilities
    track?.stop()
    stream.getTracks().forEach(t => t.stop())

    return {
      sampleRates:   (caps as any).sampleRate
        ? [(caps as any).sampleRate.min, 44100, 48000, (caps as any).sampleRate.max].filter(Boolean)
        : [settings.sampleRate ?? 48000],
      channelCounts: (caps as any).channelCount
        ? [1, 2, Math.min((caps as any).channelCount?.max ?? 2, 32)]
        : [1, 2],
      latencyRange: {
        min: (caps as any).latency?.min ?? 0,
        max: (caps as any).latency?.max ?? 0.1,
      },
      echoCancellation: (caps as any).echoCancellation ?? false,
      autoGainControl:  (caps as any).autoGainControl  ?? false,
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  destroy(): void {
    this._stopWatcher()
    this._watchers.clear()
  }
}
