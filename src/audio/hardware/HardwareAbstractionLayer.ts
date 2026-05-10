/**
 * HardwareAbstractionLayer.ts — Capa central de hardware de audio de ONA Live Studio
 *
 * Responsabilidades:
 *   - Wrap de DeviceManager (enumeración, watching, streams)
 *   - Mapa channel → device para hot swap automático
 *   - Reconexión automática cuando un dispositivo se desconecta y vuelve
 *   - Fallback a dispositivo default si el activo no vuelve
 *   - Exponer latencia real del AudioContext
 *   - API `connectChannel(channelId, deviceId)` — punto de entrada único para routing
 *
 * Relación con otras capas:
 *   React/UI → AudioBridge → HAL.connectChannel() → DeviceManager.getMediaStream()
 *                                                  → callback → engineSingleton.connectMediaStream()
 *
 * React NO conoce DeviceManager directamente.
 * AudioEngineSingleton NO llama getUserMedia directamente.
 */

import { DeviceManager, type AudioDeviceInfo } from './DeviceManager'

type StreamCallback = (channelId: number, stream: MediaStream) => void
type DisconnectCallback = (channelId: number, deviceId: string) => void

export interface HalLatency {
  baseMs:   number
  outputMs: number
  totalMs:  number
}

export interface ChannelConnection {
  channelId:  number
  deviceId:   string
  stream:     MediaStream
  connectedAt: number
}

class HardwareAbstractionLayer {
  readonly devices = new DeviceManager()

  private _ctx:              AudioContext | null = null
  private _channelMap        = new Map<number, ChannelConnection>()
  private _streamCbs         = new Set<StreamCallback>()
  private _disconnectCbs     = new Set<DisconnectCallback>()
  private _unwatchDevices:   (() => void) | null = null
  private _initialized       = false

  // ── Inicialización ────────────────────────────────────────────────────────────

  initialize(ctx: AudioContext): void {
    if (this._initialized) return
    this._ctx = ctx

    // Enumeración inicial para tener device list fresca
    this.devices.enumerateDevices().catch(() => {})

    // Observar cambios de hardware para hot swap
    this._unwatchDevices = this.devices.watchDeviceChanges(devices => {
      console.log(`[HAL] devicechange — ${devices.length} dispositivos`)
      this._handleDeviceChange(devices).catch(err =>
        console.warn('[HAL] handleDeviceChange error:', err)
      )
    })

    this._initialized = true
    const lat = this.getLatency()
    console.log(`[HAL] Initialized — sampleRate: ${ctx.sampleRate}Hz, ` +
      `latency: ${lat.totalMs.toFixed(1)}ms (base: ${lat.baseMs.toFixed(1)}ms + output: ${lat.outputMs.toFixed(1)}ms)`)
  }

  // ── Conexión de canales ───────────────────────────────────────────────────────

  /**
   * connectChannel — punto de entrada único para conectar un canal a un dispositivo.
   * Obtiene el MediaStream, notifica a AudioEngineSingleton via callback.
   * Returns el stream para compatibilidad con código existente.
   */
  async connectChannel(channelId: number, deviceId: string): Promise<MediaStream | null> {
    // Detener stream anterior del canal
    const prev = this._channelMap.get(channelId)
    if (prev) {
      prev.stream.getTracks().forEach(t => t.stop())
      this._channelMap.delete(channelId)
    }

    const stream = await this.devices.getMediaStream(deviceId)
    if (!stream) {
      console.warn(`[HAL] connectChannel: no se pudo abrir stream para device ${deviceId.slice(0, 8)}`)
      return null
    }

    this._channelMap.set(channelId, {
      channelId,
      deviceId,
      stream,
      connectedAt: Date.now(),
    })

    // Notificar al motor de audio
    for (const cb of this._streamCbs) {
      try { cb(channelId, stream) } catch (_) {}
    }

    return stream
  }

  disconnectChannel(channelId: number): void {
    const conn = this._channelMap.get(channelId)
    if (!conn) return
    conn.stream.getTracks().forEach(t => t.stop())
    this._channelMap.delete(channelId)
    console.log(`[HAL] Canal ${channelId} desconectado`)
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────────

  /** Registrar callback para cuando HAL conecta/reconecta un stream */
  onStreamReady(cb: StreamCallback): () => void {
    this._streamCbs.add(cb)
    return () => this._streamCbs.delete(cb)
  }

  /** Registrar callback para cuando un dispositivo se desconecta sin volver */
  onDeviceDisconnected(cb: DisconnectCallback): () => void {
    this._disconnectCbs.add(cb)
    return () => this._disconnectCbs.delete(cb)
  }

  // ── Hot swap ─────────────────────────────────────────────────────────────────

  private async _handleDeviceChange(currentDevices: AudioDeviceInfo[]): Promise<void> {
    const liveInputIds = new Set(
      currentDevices.filter(d => d.kind === 'audioinput').map(d => d.deviceId)
    )

    for (const [channelId, conn] of this._channelMap) {
      const streamAlive = conn.stream.getAudioTracks().some(t => t.readyState === 'live')

      if (!streamAlive) {
        if (liveInputIds.has(conn.deviceId)) {
          // Dispositivo sigue presente pero stream cayó — reconectar
          console.log(`[HAL] Hot swap — reconectando canal ${channelId} → ${conn.deviceId.slice(0, 8)}`)
          await this.connectChannel(channelId, conn.deviceId)
        } else {
          // Dispositivo ya no está — notificar desconexión
          console.warn(`[HAL] Dispositivo desconectado para canal ${channelId} (${conn.deviceId.slice(0, 8)})`)
          this._channelMap.delete(channelId)
          for (const cb of this._disconnectCbs) {
            try { cb(channelId, conn.deviceId) } catch (_) {}
          }
        }
      }
    }
  }

  // ── Latencia + sample rate ────────────────────────────────────────────────────

  getSampleRate(): number {
    return this._ctx?.sampleRate ?? 48000
  }

  getLatency(): HalLatency {
    const ctx = this._ctx
    if (!ctx) return { baseMs: 0, outputMs: 0, totalMs: 0 }
    const baseMs   = (ctx.baseLatency   ?? 0) * 1000
    const outputMs = (ctx.outputLatency ?? 0) * 1000
    return { baseMs, outputMs, totalMs: baseMs + outputMs }
  }

  // ── Inspección ────────────────────────────────────────────────────────────────

  getChannelConnections(): ChannelConnection[] {
    return Array.from(this._channelMap.values())
  }

  isChannelConnected(channelId: number): boolean {
    const conn = this._channelMap.get(channelId)
    return conn?.stream.getAudioTracks().some(t => t.readyState === 'live') ?? false
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  destroy(): void {
    this._unwatchDevices?.()
    for (const conn of this._channelMap.values()) {
      conn.stream.getTracks().forEach(t => t.stop())
    }
    this._channelMap.clear()
    this._streamCbs.clear()
    this._disconnectCbs.clear()
    this.devices.destroy()
    this._initialized = false
    this._ctx = null
    console.log('[HAL] destroy() completo')
  }
}

export const hal = new HardwareAbstractionLayer()
export default hal
