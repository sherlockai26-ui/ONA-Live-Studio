/**
 * PerformanceModes.ts — Studio / Live / Eco performance profiles.
 *
 * STUDIO:  Full quality. No restrictions. Ideal for controlled recording environments.
 * LIVE:    Balanced. 30fps metering, channel sleep after 2s, idle analyser suspension.
 * ECO:     Aggressive saving. 15fps metering, 1s sleep, reduced FX polling.
 *          Targets low-end laptops and 8+ hour sessions.
 *
 * Auto-switch:
 *   Monitors a CPU% getter injected from AudioEngineSingleton.
 *   CPU > 75% for 3s → escalate one level.
 *   CPU < 30% for 10s → recover one level.
 *   Can be enabled/disabled at runtime.
 *
 * Mode change callback → AudioEngineSingleton applies the config
 * (metering fps, sleep enable/disable, LB stage, etc).
 */

export type PerformanceMode = 'studio' | 'live' | 'eco'

export interface ModeConfig {
  meterFps:             number
  channelSleepEnabled:  boolean
  sleepSilenceMs:       number    // unused: wired via ChannelSleepSystem internally
  analyserSuspend:      boolean
  fxIdleTimeoutMs:      number
  lbStage:              'full' | 'reduced' | 'minimal'
  description:          string
}

export const MODE_CONFIGS: Record<PerformanceMode, ModeConfig> = {
  studio: {
    meterFps:            60,
    channelSleepEnabled: false,
    sleepSilenceMs:      Infinity,
    analyserSuspend:     false,
    fxIdleTimeoutMs:     Infinity,
    lbStage:             'full',
    description:         'Full quality — studio recording and mixing',
  },
  live: {
    meterFps:            30,
    channelSleepEnabled: true,
    sleepSilenceMs:      2000,
    analyserSuspend:     true,
    fxIdleTimeoutMs:     10_000,
    lbStage:             'full',
    description:         'Balanced — live performance and broadcast',
  },
  eco: {
    meterFps:            15,
    channelSleepEnabled: true,
    sleepSilenceMs:      1000,
    analyserSuspend:     true,
    fxIdleTimeoutMs:     5_000,
    lbStage:             'reduced',
    description:         'Power saving — low-end hardware and long sessions',
  },
}

class PerformanceModeManager {
  private _mode:      PerformanceMode = 'live'
  private _auto:      boolean         = false
  private _cpuHigh    = 0
  private _cpuLow     = 0
  private _interval:  ReturnType<typeof setInterval> | null = null
  private _onChange:  ((mode: PerformanceMode, cfg: ModeConfig) => void) | null = null
  private _cpuGetter: (() => number) | null = null

  get mode():   PerformanceMode { return this._mode }
  get config(): ModeConfig      { return MODE_CONFIGS[this._mode] }

  onModeChange(cb: (mode: PerformanceMode, cfg: ModeConfig) => void): void {
    this._onChange = cb
  }

  setCpuGetter(fn: () => number): void { this._cpuGetter = fn }

  setMode(mode: PerformanceMode): void {
    if (this._mode === mode) return
    const prev    = this._mode
    this._mode    = mode
    this._cpuHigh = 0
    this._cpuLow  = 0
    console.log(`[PerfMode] ${prev} → ${mode}: ${MODE_CONFIGS[mode].description}`)
    this._onChange?.(mode, MODE_CONFIGS[mode])
  }

  enableAutoSwitch(enable: boolean): void {
    this._auto = enable
    if (enable && !this._interval) {
      this._interval = setInterval(() => this._autoTick(), 1000)
      console.log('[PerfMode] auto-switch enabled')
    } else if (!enable && this._interval) {
      clearInterval(this._interval)
      this._interval = null
      console.log('[PerfMode] auto-switch disabled')
    }
  }

  get autoEnabled(): boolean { return this._auto }

  private _autoTick(): void {
    if (!this._cpuGetter) return
    const cpu = this._cpuGetter()

    if (cpu > 75) {
      this._cpuHigh++
      this._cpuLow = 0
      if (this._cpuHigh >= 3) { this._cpuHigh = 0; this._escalate() }
    } else if (cpu < 30) {
      this._cpuLow++
      this._cpuHigh = 0
      if (this._cpuLow >= 10) { this._cpuLow = 0; this._recover() }
    } else {
      this._cpuHigh = 0
      this._cpuLow  = 0
    }
  }

  private _escalate(): void {
    const order: PerformanceMode[] = ['studio', 'live', 'eco']
    const idx = order.indexOf(this._mode)
    if (idx < order.length - 1) this.setMode(order[idx + 1])
  }

  private _recover(): void {
    const order: PerformanceMode[] = ['studio', 'live', 'eco']
    const idx = order.indexOf(this._mode)
    if (idx > 0) this.setMode(order[idx - 1])
  }

  destroy(): void {
    if (this._interval) clearInterval(this._interval)
  }
}

export const performanceModes = new PerformanceModeManager()
