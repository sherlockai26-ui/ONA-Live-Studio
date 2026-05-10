/**
 * ChannelSleepSystem.ts — Signal-based channel sleep and auto-wake.
 *
 * Each registered channel is polled every POLL_INTERVAL_MS.
 * Peak is read via injected peakReader (from MeteringEngine — no coupling).
 *
 * State machine per channel:
 *   active  → if peak < SLEEP_THRESHOLD for SLEEP_HOLD_CYCLES → sleeping
 *   sleeping → if peak > WAKE_THRESHOLD → active (immediate)
 *
 * Sleep effects (applied via onSleep/onWake callbacks):
 *   - DSPLoadBalancer priority demoted to IDLE
 *   - ResourceManager meter marked idle (analyser reads suspended)
 *   - CPU save: proportional to fraction of sleeping channels
 *
 * Safe: sleeping channels still process audio correctly — only JS metering stops.
 */

const SLEEP_THRESHOLD_DB  = -60
const WAKE_THRESHOLD_DB   = -54
const SLEEP_HOLD_CYCLES   = 4     // 4 × 500ms = 2s of silence
const POLL_INTERVAL_MS    = 500

export type ChannelState = 'active' | 'sleeping'

export interface ChannelSleepEntry {
  id:           number
  state:        ChannelState
  quietCycles:  number
  peakDb:       number
  sleepCount:   number
  wakeCount:    number
}

class ChannelSleepSystem {
  private _channels    = new Map<number, ChannelSleepEntry>()
  private _peakReader: ((id: number) => number) | null = null
  private _onSleep:    ((id: number) => void)   | null = null
  private _onWake:     ((id: number) => void)   | null = null
  private _interval:   ReturnType<typeof setInterval> | null = null

  setPeakReader(fn: (id: number) => number): void  { this._peakReader = fn }
  onSleep(cb: (id: number) => void):         void  { this._onSleep    = cb }
  onWake(cb: (id: number) => void):          void  { this._onWake     = cb }

  start(): void {
    if (this._interval) return
    this._interval = setInterval(() => this._poll(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this._interval) { clearInterval(this._interval); this._interval = null }
  }

  registerChannel(id: number): void {
    if (this._channels.has(id)) return
    this._channels.set(id, {
      id, state: 'active', quietCycles: 0, peakDb: -Infinity,
      sleepCount: 0, wakeCount: 0,
    })
  }

  unregisterChannel(id: number): void { this._channels.delete(id) }

  isAsleep(id: number): boolean {
    return this._channels.get(id)?.state === 'sleeping'
  }

  private _poll(): void {
    if (!this._peakReader) return

    for (const ch of this._channels.values()) {
      const peak = this._peakReader(ch.id)
      ch.peakDb  = peak

      if (ch.state === 'active') {
        if (peak < SLEEP_THRESHOLD_DB) {
          ch.quietCycles++
          if (ch.quietCycles >= SLEEP_HOLD_CYCLES) {
            ch.state = 'sleeping'
            ch.sleepCount++
            console.debug(`[Sleep] ch${ch.id} → sleep (${ch.sleepCount}× total)`)
            this._onSleep?.(ch.id)
          }
        } else {
          ch.quietCycles = 0
        }
      } else {
        if (peak > WAKE_THRESHOLD_DB) {
          ch.state       = 'active'
          ch.quietCycles = 0
          ch.wakeCount++
          console.debug(`[Sleep] ch${ch.id} → wake`)
          this._onWake?.(ch.id)
        }
      }
    }
  }

  wakeAll(): void {
    for (const ch of this._channels.values()) {
      if (ch.state === 'sleeping') {
        ch.state       = 'active'
        ch.quietCycles = 0
        ch.wakeCount++
        this._onWake?.(ch.id)
      }
    }
  }

  getSleepingCount(): number {
    let n = 0
    for (const ch of this._channels.values()) if (ch.state === 'sleeping') n++
    return n
  }

  getStatus(): ChannelSleepEntry[] {
    return [...this._channels.values()].sort((a, b) => a.id - b.id)
  }

  destroy(): void {
    this.stop()
    this._channels.clear()
  }
}

export const channelSleepSystem = new ChannelSleepSystem()
