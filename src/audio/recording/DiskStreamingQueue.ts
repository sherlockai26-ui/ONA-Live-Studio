/**
 * DiskStreamingQueue.ts — Backpressure-safe streaming write queue for Electron IPC.
 *
 * PCM chunks arrive faster than IPC can drain them. This queue:
 *   - Serialises writes (one at a time) to avoid IPC storms
 *   - Drops the *oldest* chunk when the RAM queue exceeds MAX_QUEUE_BYTES
 *     (newest data is more valuable in live recording)
 *   - Notifies SafeRecoverySystem on drops (Paso 11: backpressure monitoring)
 *   - _destroyed guard prevents callbacks from resolving after clear() is called
 *     (Paso 11 fix: avoids writing to a closed session after stopSession())
 *   - Exposes stats so the UI can warn when drops are detected
 */

const MAX_QUEUE_BYTES = 16 * 1024 * 1024  // 16 MB ceiling before oldest drop

interface WriteJob {
  sessionId: string
  channelId: number
  data:      Uint8Array
}

export class DiskStreamingQueue {
  private _queue:     WriteJob[] = []
  private _draining   = false
  private _destroyed  = false   // Paso 11: guard against post-clear() IPC callbacks
  private _dropped    = 0
  private _queued     = 0
  private _written    = 0

  // Paso 11: optional SafeRecoverySystem reference (set by MultitrackRecorder)
  private _onDrop: ((droppedBytes: number) => void) | null = null

  setDropCallback(cb: (droppedBytes: number) => void): void {
    this._onDrop = cb
  }

  get stats() {
    return {
      dropped: this._dropped,
      queued:  this._queued,
      written: this._written,
    }
  }

  enqueue(sessionId: string, channelId: number, data: Uint8Array): void {
    if (this._destroyed) return
    this._queued += data.byteLength

    // If queue is over budget, evict the oldest entry (newest data is more valuable)
    let totalEvicted = 0
    while (this._queued > MAX_QUEUE_BYTES && this._queue.length > 0) {
      const evicted = this._queue.shift()!
      this._queued   -= evicted.data.byteLength
      this._dropped  += evicted.data.byteLength
      totalEvicted   += evicted.data.byteLength
      console.warn('[DiskStreamingQueue] dropped chunk — IPC too slow')
    }

    if (totalEvicted > 0 && this._onDrop) this._onDrop(totalEvicted)

    this._queue.push({ sessionId, channelId, data })
    if (!this._draining) this._pump()
  }

  private _pump(): void {
    if (this._destroyed || this._queue.length === 0) { this._draining = false; return }
    this._draining = true

    const job = this._queue.shift()!
    this._queued -= job.data.byteLength

    const onaRec = (window as any).onaRecording
    if (!onaRec) { this._pump(); return }

    onaRec.writeChunk(job.sessionId, job.channelId, job.data.buffer)
      .then(() => {
        if (this._destroyed) return           // Paso 11: guard — session already closed
        this._written += job.data.byteLength
        this._pump()
      })
      .catch((err: unknown) => {
        if (this._destroyed) return
        console.error('[DiskStreamingQueue] IPC write error:', err)
        this._pump()
      })
  }

  /** Wait until the queue is fully drained (all writes acknowledged by main process). */
  flush(): Promise<void> {
    return new Promise((resolve) => {
      const poll = () => {
        if (this._destroyed || (this._queue.length === 0 && !this._draining)) resolve()
        else setTimeout(poll, 10)
      }
      poll()
    })
  }

  clear(): void {
    this._destroyed = true   // Paso 11: stop any in-flight IPC callbacks
    this._queue     = []
    this._queued    = 0
  }

  reset(): void {
    this._destroyed = false
    this._queue     = []
    this._queued    = 0
    this._dropped   = 0
    this._written   = 0
  }
}
