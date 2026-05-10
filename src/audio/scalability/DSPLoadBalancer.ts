/**
 * DSPLoadBalancer.ts — Priority-based DSP workload scheduler.
 *
 * Priority levels:
 *   CRITICAL (0): bus faders, master gain — never deferred
 *   HIGH     (1): active channel params, EQ, gate, comp — run every frame
 *   MEDIUM   (2): aux sends, FX sends — run every frame, yield if over budget
 *   LOW      (3): inactive meters, analyser reads — skip when CPU high
 *   IDLE     (4): sleeping channels, unused buses — skip on any overrun
 *
 * Budget: JS-thread audio work per RAF frame (default 5ms ceiling).
 * Overrun detection: 3 consecutive over-budget frames → escalate degradation.
 * Recovery: 0 overruns for 10 frames → recover one stage.
 */

export type DSPPriority = 0 | 1 | 2 | 3 | 4

export const PRIORITY = {
  CRITICAL: 0 as DSPPriority,
  HIGH:     1 as DSPPriority,
  MEDIUM:   2 as DSPPriority,
  LOW:      3 as DSPPriority,
  IDLE:     4 as DSPPriority,
} as const

export type DegradationStage = 'full' | 'reduced' | 'minimal' | 'emergency'

export interface LoadBalancerMetrics {
  stage:          DegradationStage
  budgetMs:       number
  lastCycleMs:    number
  overrunCount:   number
  tasksQueued:    number
  tasksDeferred:  number
  tasksDropped:   number
}

interface ScheduledTask {
  id:       string
  priority: DSPPriority
  fn:       () => void
  maxAgeMs: number
  queuedAt: number
}

class DSPLoadBalancer {
  private _stage:          DegradationStage = 'full'
  private _budgetMs        = 5
  private _overrunCount    = 0
  private _cleanCount      = 0
  private _cycleCount      = 0
  private _lastCycleMs     = 0
  private _tasksQueued     = 0
  private _tasksDeferred   = 0
  private _tasksDropped    = 0
  private _running         = false
  private _rafId:          number | null = null

  private _queues = new Map<DSPPriority, ScheduledTask[]>([
    [0, []], [1, []], [2, []], [3, []], [4, []],
  ])

  attach(ctx: AudioContext, bufferSize = 256, budgetFraction = 0.8): void {
    this._budgetMs = (bufferSize / ctx.sampleRate) * 1000 * bufferSize * budgetFraction
    // Clamp to a sensible range: 2ms–8ms per RAF tick
    this._budgetMs = Math.max(2, Math.min(8, this._budgetMs))
    this._running  = true
    this._tick()
  }

  private _tick(): void {
    if (!this._running) return
    this._rafId = requestAnimationFrame(() => {
      const t0 = performance.now()
      this._cycleCount++

      const maxP = this._stage === 'emergency' ? 1
        : this._stage === 'minimal'            ? 2
        : this._stage === 'reduced'            ? 3
        : 4

      for (let p = 0; p <= maxP; p++) {
        const q   = this._queues.get(p as DSPPriority)!
        const now = performance.now()

        // Skip LOW every other cycle in reduced/minimal, MEDIUM every other in minimal
        if (p === 3 && this._stage !== 'full'     && this._cycleCount % 2 === 0) continue
        if (p === 2 && this._stage === 'minimal'  && this._cycleCount % 2 === 0) continue

        let i = 0
        while (i < q.length) {
          const task = q[i]

          // Drop stale tasks (over max age)
          if (now - task.queuedAt > task.maxAgeMs) {
            q.splice(i, 1)
            this._tasksDropped++
            continue
          }

          // Yield on budget overrun for non-critical tasks
          if (p > 1 && performance.now() - t0 > this._budgetMs) {
            this._tasksDeferred += q.length - i
            break
          }

          q.splice(i, 1)
          try { task.fn() } catch (_) {}
        }
      }

      this._lastCycleMs = performance.now() - t0

      if (this._lastCycleMs > this._budgetMs) {
        this._overrunCount++
        this._cleanCount = 0
        if (this._overrunCount >= 3) { this._escalate(); this._overrunCount = 0 }
      } else {
        this._cleanCount++
        if (this._cleanCount >= 10) { this._recover(); this._cleanCount = 0 }
        this._overrunCount = Math.max(0, this._overrunCount - 1)
      }

      this._tick()
    })
  }

  schedule(id: string, priority: DSPPriority, fn: () => void, maxAgeMs = 100): void {
    const q        = this._queues.get(priority)!
    const existing = q.findIndex(t => t.id === id)
    if (existing >= 0) q.splice(existing, 1)
    q.push({ id, priority, fn, maxAgeMs, queuedAt: performance.now() })
    this._tasksQueued++
  }

  private _escalate(): void {
    const order: DegradationStage[] = ['full', 'reduced', 'minimal', 'emergency']
    const idx = order.indexOf(this._stage)
    if (idx < order.length - 1) {
      this._stage = order[idx + 1]
      console.warn(`[LoadBalancer] degradation escalated → ${this._stage}`)
    }
  }

  private _recover(): void {
    const order: DegradationStage[] = ['full', 'reduced', 'minimal', 'emergency']
    const idx = order.indexOf(this._stage)
    if (idx > 0) {
      this._stage = order[idx - 1]
      console.log(`[LoadBalancer] degradation recovered → ${this._stage}`)
    }
  }

  forceStage(stage: DegradationStage): void { this._stage = stage }
  getStage():  DegradationStage              { return this._stage }

  getMetrics(): LoadBalancerMetrics {
    let queued = 0
    for (const q of this._queues.values()) queued += q.length
    return {
      stage:         this._stage,
      budgetMs:      +this._budgetMs.toFixed(2),
      lastCycleMs:   +this._lastCycleMs.toFixed(2),
      overrunCount:  this._overrunCount,
      tasksQueued:   this._tasksQueued,
      tasksDeferred: this._tasksDeferred,
      tasksDropped:  this._tasksDropped,
    }
  }

  destroy(): void {
    this._running = false
    if (this._rafId !== null) cancelAnimationFrame(this._rafId)
    for (const q of this._queues.values()) q.length = 0
  }
}

export const dspLoadBalancer = new DSPLoadBalancer()
