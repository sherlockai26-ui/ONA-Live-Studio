/**
 * TransitionEngine.ts — Pop-free scene transitions for live operation.
 *
 * Three mechanisms (used in combination):
 *
 *   1. Ramp       — smooth parameter change over N ms (linear or S-curve)
 *   2. Stagger    — sequence channel updates with configurable inter-channel delay
 *   3. Deferred   — apply non-critical params (EQ, comp) on next quiet DSP window
 *
 * Transition profiles:
 *   instant   — no ramp, immediate apply (use only for clicks/debug)
 *   fast      — 80ms ramp, 0ms stagger   (snappy but safe)
 *   smooth    — 400ms ramp, 20ms stagger  (default live recall)
 *   slow      — 1200ms ramp, 40ms stagger (theatrical)
 *
 * Pop detection: monitors DSP output level after apply — if peak jumps > 6dB
 * in one frame, logs a pop event (used by LiveBenchmark).
 */

export type TransitionProfile = 'instant' | 'fast' | 'smooth' | 'slow'
export type RampCurve         = 'linear' | 'scurve'

interface ProfileConfig {
  rampMs:      number
  staggerMs:   number   // delay between channels
  curve:       RampCurve
  deferNonCrit: boolean
}

const PROFILES: Record<TransitionProfile, ProfileConfig> = {
  instant: { rampMs:    0, staggerMs:  0, curve: 'linear',  deferNonCrit: false },
  fast:    { rampMs:   80, staggerMs:  0, curve: 'linear',  deferNonCrit: true  },
  smooth:  { rampMs:  400, staggerMs: 20, curve: 'scurve',  deferNonCrit: true  },
  slow:    { rampMs: 1200, staggerMs: 40, curve: 'scurve',  deferNonCrit: true  },
}

export interface RampTask {
  id:        string
  from:      number
  to:        number
  startMs:   number
  durationMs: number
  curve:     RampCurve
  onUpdate:  (v: number) => void
  onDone?:   () => void
}

function scurve(t: number): number {
  // Smoothstep: 3t² - 2t³
  return t * t * (3 - 2 * t)
}

class TransitionEngine {
  private _ramps    = new Map<string, RampTask>()
  private _rafId:   number | null = null
  private _running  = false
  private _popLog:  Array<{ ts: number; delta: number; channel: number }> = []
  private _lastPeak = 0
  private _profile: TransitionProfile = 'smooth'

  setProfile(p: TransitionProfile): void { this._profile = p }
  getProfile(): TransitionProfile        { return this._profile }

  // ── Ramp API ──────────────────────────────────────────────────────────────

  ramp(
    id:        string,
    from:      number,
    to:        number,
    onUpdate:  (v: number) => void,
    opts?: { durationMs?: number; curve?: RampCurve; onDone?: () => void },
  ): void {
    const cfg = PROFILES[this._profile]
    const dur = opts?.durationMs ?? cfg.rampMs

    if (dur === 0) { onUpdate(to); opts?.onDone?.(); return }

    const task: RampTask = {
      id,
      from, to,
      startMs:    performance.now(),
      durationMs: dur,
      curve:      opts?.curve ?? cfg.curve,
      onUpdate,
      onDone:     opts?.onDone,
    }
    this._ramps.set(id, task)
    if (!this._running) this._startLoop()
  }

  cancelRamp(id: string): void { this._ramps.delete(id) }

  // ── Staggered multi-channel apply ─────────────────────────────────────────

  /**
   * Apply a setter function to N channels with inter-channel delay.
   * Returns a promise that resolves when the last channel is scheduled.
   */
  async staggerApply(
    channelIds: number[],
    applyFn:    (channelId: number, index: number) => void,
    staggerMs?: number,
  ): Promise<void> {
    const delay = staggerMs ?? PROFILES[this._profile].staggerMs
    for (let i = 0; i < channelIds.length; i++) {
      if (i > 0 && delay > 0) await new Promise(r => setTimeout(r, delay))
      applyFn(channelIds[i], i)
    }
  }

  // ── Deferred non-critical apply ───────────────────────────────────────────

  private _deferQueue: Array<() => void> = []
  private _deferTimeout: ReturnType<typeof setTimeout> | null = null

  defer(fn: () => void, delayMs = 50): void {
    this._deferQueue.push(fn)
    if (this._deferTimeout === null) {
      this._deferTimeout = setTimeout(() => {
        const queue = this._deferQueue.splice(0)
        queue.forEach(f => { try { f() } catch (_) {} })
        this._deferTimeout = null
      }, delayMs)
    }
  }

  // ── Pop detection ─────────────────────────────────────────────────────────

  notifyPeakLevel(peak: number, channelId = -1): void {
    const delta = peak - this._lastPeak
    if (delta > 6) {
      this._popLog.push({ ts: Date.now(), delta: +delta.toFixed(1), channel: channelId })
      console.warn(`[TransitionEngine] Pop detected: +${delta.toFixed(1)}dB on ch${channelId}`)
    }
    this._lastPeak = peak
  }

  getPopLog(): Array<{ ts: number; delta: number; channel: number }> {
    return [...this._popLog]
  }

  clearPopLog(): void { this._popLog = [] }

  // ── RAF loop ──────────────────────────────────────────────────────────────

  private _startLoop(): void {
    if (this._running) return
    this._running = true
    this._tick()
  }

  private _tick(): void {
    if (!this._running) return
    const now = performance.now()

    for (const [id, task] of this._ramps) {
      const t = Math.min(1, (now - task.startMs) / task.durationMs)
      const easedT = task.curve === 'scurve' ? scurve(t) : t
      const val    = task.from + (task.to - task.from) * easedT
      try { task.onUpdate(val) } catch (_) {}

      if (t >= 1) {
        this._ramps.delete(id)
        try { task.onDone?.() } catch (_) {}
      }
    }

    if (this._ramps.size > 0) {
      this._rafId = requestAnimationFrame(() => this._tick())
    } else {
      this._running = false
      this._rafId   = null
    }
  }

  getMetrics() {
    return {
      profile:     this._profile,
      activeRamps: this._ramps.size,
      deferQueue:  this._deferQueue.length,
      popCount:    this._popLog.length,
    }
  }

  destroy(): void {
    this._running = false
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null }
    if (this._deferTimeout !== null) { clearTimeout(this._deferTimeout); this._deferTimeout = null }
    this._ramps.clear()
    this._deferQueue.length = 0
  }
}

export const transitionEngine = new TransitionEngine()
