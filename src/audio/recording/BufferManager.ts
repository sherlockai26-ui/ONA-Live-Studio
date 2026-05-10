/**
 * BufferManager.ts — XRun detection + stability classification for recording.
 *
 * An XRun is a detected discontinuity in the audio stream (gap, duplicate frames,
 * or silence injection). The stability classification drives UI warnings.
 */

export type BufferStability = 'excellent' | 'good' | 'marginal' | 'unstable'

export interface BufferStats {
  xruns:        number
  totalFrames:  number
  droppedFrames: number
  stability:    BufferStability
  dropRatePpm:  number
}

class BufferManagerImpl {
  private _xruns        = 0
  private _totalFrames  = 0
  private _droppedFrames = 0

  reset(): void {
    this._xruns        = 0
    this._totalFrames  = 0
    this._droppedFrames = 0
  }

  recordFrames(count: number): void {
    this._totalFrames += count
  }

  recordXrun(droppedFrames = 128): void {
    this._xruns++
    this._droppedFrames += droppedFrames
    console.warn(`[BufferManager] XRun #${this._xruns} (+${droppedFrames} frames dropped)`)
  }

  getStats(): BufferStats {
    const dropRatePpm = this._totalFrames > 0
      ? (this._droppedFrames / this._totalFrames) * 1_000_000
      : 0

    let stability: BufferStability
    if      (this._xruns === 0  && dropRatePpm < 10)   stability = 'excellent'
    else if (this._xruns <= 2   && dropRatePpm < 100)  stability = 'good'
    else if (this._xruns <= 10  && dropRatePpm < 1000) stability = 'marginal'
    else                                                stability = 'unstable'

    return {
      xruns:        this._xruns,
      totalFrames:  this._totalFrames,
      droppedFrames: this._droppedFrames,
      stability,
      dropRatePpm,
    }
  }
}

export const bufferManager = new BufferManagerImpl()
