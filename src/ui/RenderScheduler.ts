/**
 * RenderScheduler.ts — Centralized RAF loop for all UI render callbacks.
 *
 * All UI systems (meters, panel updates, animations) register here instead
 * of spawning their own requestAnimationFrame loops. This gives a single RAF
 * tick for the entire render pass, with priority-based execution order.
 *
 * Priority tiers:
 *   CRITICAL (0): meters — run every frame
 *   HIGH     (1): input feedback — run every frame
 *   MEDIUM   (2): panel updates — run every other frame
 *   LOW      (3): background — run every 4th frame
 *
 * Failsafe integration: UIFailsafe can call setMaxPriority() to skip
 * LOW/MEDIUM callbacks when FPS drops below threshold.
 */

export type SchedulePriority = 0 | 1 | 2 | 3

export const RENDER_PRIORITY = {
  CRITICAL: 0 as SchedulePriority,
  HIGH:     1 as SchedulePriority,
  MEDIUM:   2 as SchedulePriority,
  LOW:      3 as SchedulePriority,
} as const

type RenderCallback = (now: number, delta: number) => void

interface Registration {
  id:       string
  priority: SchedulePriority
  fn:       RenderCallback
}

class RenderScheduler {
  private _regs     = new Map<string, Registration>()
  private _rafId:   number | null = null
  private _running  = false
  private _frame    = 0
  private _lastNow  = 0
  private _maxPriority: SchedulePriority = 3
  private _fps      = 0
  private _fpsFrames = 0
  private _fpsStart  = 0

  start(): void {
    if (this._running) return
    this._running  = true
    this._fpsStart = performance.now()
    this._tick(performance.now())
  }

  stop(): void {
    this._running = false
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null }
  }

  private _tick(now: number): void {
    if (!this._running) return
    this._rafId = requestAnimationFrame(n => this._tick(n))

    const delta = now - (this._lastNow || now)
    this._lastNow = now
    this._frame++

    // FPS measurement
    this._fpsFrames++
    if (now - this._fpsStart >= 1000) {
      this._fps      = this._fpsFrames
      this._fpsFrames = 0
      this._fpsStart  = now
    }

    for (const reg of this._regs.values()) {
      if (reg.priority > this._maxPriority) continue
      if (reg.priority === 2 && this._frame % 2 !== 0) continue
      if (reg.priority === 3 && this._frame % 4 !== 0) continue
      try { reg.fn(now, delta) } catch (_) {}
    }
  }

  /**
   * Register a render callback.
   * @returns unsubscribe function
   */
  register(id: string, priority: SchedulePriority, fn: RenderCallback): () => void {
    this._regs.set(id, { id, priority, fn })
    if (!this._running) this.start()
    return () => {
      this._regs.delete(id)
      if (this._regs.size === 0) this.stop()
    }
  }

  /** UIFailsafe calls this to skip low-priority work */
  setMaxPriority(p: SchedulePriority): void { this._maxPriority = p }
  resetMaxPriority(): void                   { this._maxPriority = 3 }

  getFPS(): number { return this._fps }

  getMetrics() {
    return {
      fps:          this._fps,
      frame:        this._frame,
      registrations: this._regs.size,
      maxPriority:  this._maxPriority,
    }
  }

  destroy(): void { this.stop(); this._regs.clear() }
}

export const renderScheduler = new RenderScheduler()
