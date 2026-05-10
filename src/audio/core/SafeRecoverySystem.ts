/**
 * SafeRecoverySystem.ts — Detección y recuperación automática de fallos en vivo.
 *
 * Cubre (Paso 11):
 *   - AudioContext suspendido / interrumpido → auto-resume sin reiniciar app
 *   - XRun detection: gap entre audio clock y wall clock → log + notify
 *   - Disk overload: DiskStreamingQueue drops → notificación para throttle recording
 *   - Device disconnect → graceful degradation (canal silenciado, no crash)
 *   - Worklet freeze → delegado a DSPWatchdog con callback aquí
 *
 * Diseño: sin polling agresivo. Usa:
 *   - AudioContext.onstatechange para ctx failures (event-based, cero CPU)
 *   - setInterval 3s para XRun detection (comparación de timestamps)
 *   - Callbacks desde DiskStreamingQueue para disk overload
 *
 * No reinicia el AudioContext (operación irreversible). Solo resume/recupera.
 */

export type FailureMode =
  | 'ctx_suspended'
  | 'ctx_interrupted'
  | 'ctx_closed'
  | 'worklet_frozen'
  | 'device_disconnect'
  | 'disk_overload'
  | 'xrun_detected'

export interface RecoveryRecord {
  failure:   FailureMode
  timestamp: number
  recovered: boolean
  details:   string
}

type FailureCallback  = (mode: FailureMode, record: RecoveryRecord) => void
type RecoveryCallback = (record: RecoveryRecord) => void

const XRUN_CHECK_MS     = 3000   // poll interval for XRun detection
const XRUN_GAP_RATIO    = 0.6    // audio elapsed < 60% of wall elapsed → xrun
const DISK_WINDOW       = 5      // rolling window for disk-drop events

class SafeRecoverySystemImpl {
  private _ctx:       AudioContext | null = null
  private _history:   RecoveryRecord[]   = []
  private _handlers   = new Map<string, EventListener>()

  private _xrunTimer:          ReturnType<typeof setInterval> | null = null
  private _xrunLastAudioTime   = 0
  private _xrunLastPerfMs      = 0
  private _consecutiveXruns    = 0

  private _diskDropWindow:     number[] = []

  private _onFailureCbs:  Set<FailureCallback>  = new Set()
  private _onRecoveryCbs: Set<RecoveryCallback> = new Set()

  // ── Attach / detach ───────────────────────────────────────────────────────────

  attach(ctx: AudioContext): void {
    this._ctx = ctx

    const handler: EventListener = () => {
      switch (ctx.state) {
        case 'suspended':
          this._attemptRecovery('ctx_suspended', 'auto-resume', () => ctx.resume())
          break
        case 'running':
          break
        case 'closed':
          this._recordFailure('ctx_closed', 'AudioContext permanently closed — requires app restart', false)
          break
        default:
          // 'interrupted' (iOS Safari)
          this._attemptRecovery('ctx_interrupted', 'auto-resume', () => ctx.resume())
      }
    }

    ctx.addEventListener('statechange', handler)
    this._handlers.set('statechange', handler)

    this._startXrunDetection(ctx)
    console.log('[SafeRecovery] Attached to AudioContext')
  }

  // ── XRun detection ────────────────────────────────────────────────────────────

  private _startXrunDetection(ctx: AudioContext): void {
    this._xrunLastAudioTime = ctx.currentTime
    this._xrunLastPerfMs    = performance.now()
    this._consecutiveXruns  = 0

    this._xrunTimer = setInterval(() => {
      if (!this._ctx) return

      const audioNow = this._ctx.currentTime
      const perfNow  = performance.now()
      const dAudio   = audioNow - this._xrunLastAudioTime
      const dWall    = (perfNow  - this._xrunLastPerfMs) / 1000

      this._xrunLastAudioTime = audioNow
      this._xrunLastPerfMs    = perfNow

      // If AudioContext advanced less than XRUN_GAP_RATIO × wall clock → gap detected
      if (dWall > 0.5 && dAudio > 0 && dAudio < dWall * XRUN_GAP_RATIO) {
        this._consecutiveXruns++
        if (this._consecutiveXruns >= 2) {
          this._recordFailure(
            'xrun_detected',
            `Audio gap: ctx=${dAudio.toFixed(3)}s wall=${dWall.toFixed(3)}s (${(dAudio/dWall*100).toFixed(0)}%)`,
            true,
          )
          this._consecutiveXruns = 0
        }
      } else {
        if (this._consecutiveXruns > 0) this._consecutiveXruns--
      }
    }, XRUN_CHECK_MS)
  }

  // ── External notifications ────────────────────────────────────────────────────

  /** Called by DiskStreamingQueue when data is dropped due to backpressure. */
  notifyDiskDrop(droppedBytes: number): void {
    this._diskDropWindow.push(droppedBytes)
    if (this._diskDropWindow.length > DISK_WINDOW) this._diskDropWindow.shift()

    const drops = this._diskDropWindow.filter(d => d > 0).length
    if (drops >= 3) {
      this._recordFailure(
        'disk_overload',
        `Disk too slow: ${drops}/${this._diskDropWindow.length} recent checks had drops`,
        true,
      )
      // Reset window to avoid repeating too quickly
      this._diskDropWindow = []
    }
  }

  /** Called by HAL onDeviceDisconnected handler. */
  notifyDeviceDisconnect(channelId: number, deviceId: string): void {
    this._recordFailure(
      'device_disconnect',
      `Channel ${channelId} device ${deviceId.slice(0, 8)}… disconnected — channel muted`,
      true,
    )
  }

  /** Called by DSPWatchdog when worklet SAB is stale. */
  notifyWorkletFrozen(details: string): void {
    this._recordFailure('worklet_frozen', details, false)
  }

  // ── Attempt recovery ──────────────────────────────────────────────────────────

  private async _attemptRecovery(
    failure: FailureMode,
    action:  string,
    fn:      () => Promise<void>,
  ): Promise<void> {
    try {
      await fn()
      const record: RecoveryRecord = { failure, timestamp: Date.now(), recovered: true, details: action }
      this._push(record)
      for (const cb of this._onRecoveryCbs) { try { cb(record) } catch (_) {} }
      console.log(`[SafeRecovery] ✓ Recovered from ${failure}`)
    } catch (err) {
      this._recordFailure(failure, `${action} failed: ${String(err)}`, false)
    }
  }

  private _recordFailure(failure: FailureMode, details: string, recovered: boolean): void {
    const record: RecoveryRecord = { failure, timestamp: Date.now(), recovered, details }
    this._push(record)
    console.warn(`[SafeRecovery] ${recovered ? '⚠' : '✗'} ${failure}: ${details}`)
    for (const cb of this._onFailureCbs) { try { cb(failure, record) } catch (_) {} }
  }

  private _push(record: RecoveryRecord): void {
    this._history.push(record)
    if (this._history.length > 200) this._history.shift()
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────────

  onFailure(cb: FailureCallback): () => void {
    this._onFailureCbs.add(cb)
    return () => this._onFailureCbs.delete(cb)
  }

  onRecovery(cb: RecoveryCallback): () => void {
    this._onRecoveryCbs.add(cb)
    return () => this._onRecoveryCbs.delete(cb)
  }

  // ── Status ────────────────────────────────────────────────────────────────────

  getHistory(): RecoveryRecord[] { return [...this._history] }

  getStats() {
    const total     = this._history.length
    const recovered = this._history.filter(r => r.recovered).length
    const byMode    = {} as Record<FailureMode, number>
    for (const r of this._history) byMode[r.failure] = (byMode[r.failure] ?? 0) + 1
    return { total, recovered, failed: total - recovered, byMode, recent: this._history.slice(-10) }
  }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    if (this._xrunTimer) { clearInterval(this._xrunTimer); this._xrunTimer = null }

    const handler = this._handlers.get('statechange')
    if (handler && this._ctx) this._ctx.removeEventListener('statechange', handler)
    this._handlers.clear()

    this._ctx = null
    this._history = []
    this._onFailureCbs.clear()
    this._onRecoveryCbs.clear()
    this._diskDropWindow = []
    console.log('[SafeRecovery] Destroyed')
  }
}

export const safeRecovery = new SafeRecoverySystemImpl()
