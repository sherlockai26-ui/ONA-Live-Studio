/**
 * MeterSubscriber.ts — Visibility-based meter stream client.
 *
 * Connects to the /meters Socket.IO namespace.
 * Sends meter preferences to server: { fps: number, visible: string[] }
 *
 * Visibility management:
 *   Call setVisible(ids) when the UI mounts/unmounts meter components.
 *   The server will only send data for visible meters, reducing bandwidth.
 *
 * Throttle awareness:
 *   If the server throttles our fps (due to slow connection), the local
 *   subscriber reports the effective fps and logs the degradation.
 *
 * Fallback:
 *   If the /meters connection fails, falls back to meter data from the
 *   legacy default namespace (command-based meter updates).
 */

const DEFAULT_FPS = 25

export interface MeterData { [id: string]: number }

type MeterCallback = (data: MeterData) => void

export class MeterSubscriber {
  private _socket:    any            = null
  private _visible:   Set<string>    = new Set(['_main', '_sub'])
  private _fps        = DEFAULT_FPS
  private _cbs        = new Set<MeterCallback>()
  private _lastData:  MeterData      = {}
  private _packetsRx  = 0
  private _connected  = false
  private _prefsDirty = false
  private _prefsTimer: ReturnType<typeof setInterval> | null = null

  attach(metersSocket: any): void {
    this._socket = metersSocket

    metersSocket.on('connect', () => {
      this._connected = true
      this._sendPrefs()
      console.log('[MeterSub] connected to /meters')
    })

    metersSocket.on('disconnect', () => {
      this._connected = false
    })

    metersSocket.on('meters', (data: MeterData) => {
      this._lastData = data
      this._packetsRx++
      for (const cb of this._cbs) { try { cb(data) } catch (_) {} }
    })

    // Throttle pref sends — batch visible changes over 200ms
    this._prefsTimer = setInterval(() => {
      if (this._prefsDirty && this._connected) {
        this._sendPrefs()
        this._prefsDirty = false
      }
    }, 200)
  }

  /**
   * Set which meter IDs the UI currently has visible.
   * Server will only send data for these IDs.
   */
  setVisible(ids: string[]): void {
    this._visible   = new Set(ids)
    this._prefsDirty = true
  }

  addVisible(id: string): void   { this._visible.add(id);    this._prefsDirty = true }
  removeVisible(id: string): void { this._visible.delete(id); this._prefsDirty = true }

  setFps(fps: number): void {
    this._fps        = Math.max(1, Math.min(60, fps))
    this._prefsDirty = true
  }

  private _sendPrefs(): void {
    if (!this._socket?.connected) return
    this._socket.emit('set_meter_prefs', {
      fps:     this._fps,
      visible: [...this._visible],
    })
  }

  onMeterUpdate(cb: MeterCallback): () => void {
    this._cbs.add(cb)
    return () => this._cbs.delete(cb)
  }

  getLastData(): MeterData { return this._lastData }

  getMetrics() {
    return {
      connected:   this._connected,
      packetsRx:   this._packetsRx,
      visibleCount: this._visible.size,
      fps:          this._fps,
    }
  }

  destroy(): void {
    if (this._prefsTimer) clearInterval(this._prefsTimer)
    this._cbs.clear()
    this._socket?.disconnect()
  }
}
