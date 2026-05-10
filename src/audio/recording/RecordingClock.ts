/**
 * RecordingClock.ts — Clock drift measurement between AudioContext and performance.now().
 *
 * Samples both clocks at regular intervals. Over time, linear regression over the
 * sample set gives a stable drift estimate in ppm (parts per million).
 * Positive ppm = audio clock running fast relative to system clock.
 */

export interface ClockSample {
  audioTime: number   // AudioContext.currentTime (seconds)
  perfTime:  number   // performance.now() / 1000 (seconds)
}

class RecordingClockImpl {
  private _ctx:        AudioContext | null = null
  private _samples:    ClockSample[] = []
  private _startAudio  = 0
  private _startPerf   = 0
  private _timer:      ReturnType<typeof setInterval> | null = null

  attach(ctx: AudioContext): void {
    this._ctx        = ctx
    this._startAudio = ctx.currentTime
    this._startPerf  = performance.now() / 1000
    this._samples    = []
  }

  startMonitoring(intervalMs = 1000): void {
    this.stopMonitoring()
    this._timer = setInterval(() => this._sample(), intervalMs)
  }

  stopMonitoring(): void {
    if (this._timer !== null) { clearInterval(this._timer); this._timer = null }
  }

  private _sample(): void {
    if (!this._ctx) return
    this._samples.push({
      audioTime: this._ctx.currentTime,
      perfTime:  performance.now() / 1000,
    })
    if (this._samples.length > 300) this._samples.shift()  // ~5 min at 1s interval
  }

  /**
   * Drift in ppm calculated from the oldest and newest sample.
   * Returns 0 if fewer than 2 samples collected.
   */
  getDriftPpm(): number {
    if (this._samples.length < 2) return 0
    const first = this._samples[0]
    const last  = this._samples[this._samples.length - 1]
    const dAudio = last.audioTime - first.audioTime
    const dPerf  = last.perfTime  - first.perfTime
    if (dPerf < 0.5) return 0
    return ((dAudio - dPerf) / dPerf) * 1_000_000
  }

  /** Convert an AudioContext timestamp to the performance.now() domain (ms). */
  audioTimeToPerfMs(audioTime: number): number {
    const elapsed = audioTime - this._startAudio
    return (this._startPerf + elapsed) * 1000
  }

  get currentTime(): number { return this._ctx?.currentTime ?? 0 }
  getSamples(): ClockSample[] { return [...this._samples] }

  destroy(): void {
    this.stopMonitoring()
    this._ctx     = null
    this._samples = []
  }
}

export const recordingClock = new RecordingClockImpl()
