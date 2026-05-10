/**
 * MultitrackRecorder.ts — Orchestrates per-channel WAV 24-bit recording.
 *
 * Flow:
 *   startSession() → create IPC session → start AudioCapture per channel
 *   [audio thread produces Float32 chunks] → encodeInt24 → DiskStreamingQueue
 *   stopSession() → flush queue → finalize IPC session (patch WAV headers)
 *
 * Capture tap: ChannelStrip.preFaderTap (post-EQ, pre-fader — "dry" signal).
 * One mono WAV file per channel, 24-bit, at the AudioContext sample rate.
 */

import { AudioCapture }       from './AudioCapture'
import type { CaptureCallback } from './AudioCapture'
import { DiskStreamingQueue } from './DiskStreamingQueue'
import { encodeInt24 }        from './WavEncoder'
import { bufferManager }      from './BufferManager'
import { recordingClock }     from './RecordingClock'
import { latencyMeasurement } from './LatencyMeasurement'
import { safeRecovery }       from '../core/SafeRecoverySystem'

export interface RecordingSession {
  id:         string
  startTime:  number   // AudioContext.currentTime at start
  channels:   number[]
  sampleRate: number
}

export interface SessionResult {
  files:    string[]
  stats:    ReturnType<typeof bufferManager.getStats>
  latency:  ReturnType<typeof latencyMeasurement.measure>
  driftPpm: number
}

class MultitrackRecorderImpl {
  private _captures  = new Map<number, AudioCapture>()
  private _queue     = new DiskStreamingQueue()
  private _session:  RecordingSession | null = null

  get active():  boolean { return this._session !== null }
  get session(): RecordingSession | null { return this._session }

  async startSession(
    ctx:            AudioContext,
    channelSources: Map<number, AudioNode>,
  ): Promise<RecordingSession> {
    if (this._session) await this.stopSession()

    const onaRec = (window as any).onaRecording
    if (!onaRec) throw new Error('[MultitrackRecorder] onaRecording not available — Electron required')

    const sampleRate = ctx.sampleRate
    const channelIds = Array.from(channelSources.keys())

    // Allocate session directory + per-channel file descriptors in main process
    const sessionId = await onaRec.createSession(channelIds, sampleRate)

    const session: RecordingSession = {
      id:        sessionId,
      startTime: ctx.currentTime,
      channels:  channelIds,
      sampleRate,
    }
    this._session = session

    // Reset stats
    bufferManager.reset()
    this._queue.reset()
    // Paso 11: wire disk-drop events to SafeRecoverySystem
    this._queue.setDropCallback((bytes) => safeRecovery.notifyDiskDrop(bytes))
    recordingClock.attach(ctx)
    recordingClock.startMonitoring(1000)
    latencyMeasurement.attach(ctx)

    // Per-channel callback: encode → enqueue
    const onData: CaptureCallback = (channelId, samples) => {
      if (!this._session) return
      bufferManager.recordFrames(samples.length)
      const pcm = encodeInt24(samples)
      this._queue.enqueue(session.id, channelId, pcm)
    }

    // Start all captures in parallel
    await Promise.all(
      channelIds.map(async (id) => {
        const node = channelSources.get(id)!
        const cap  = new AudioCapture(ctx, id, node, onData)
        await cap.start()
        this._captures.set(id, cap)
      })
    )

    console.log(`[MultitrackRecorder] Session ${sessionId} started — ${channelIds.length} ch @ ${sampleRate}Hz`)
    return session
  }

  async stopSession(): Promise<SessionResult> {
    if (!this._session) return { files: [], stats: bufferManager.getStats(), latency: latencyMeasurement.measure(), driftPpm: 0 }

    const session = this._session
    this._session = null

    // Stop all captures (flushes partial buffers)
    for (const cap of this._captures.values()) cap.stop()
    this._captures.clear()

    // Wait for all pending IPC writes
    await this._queue.flush()
    recordingClock.stopMonitoring()

    const driftPpm = recordingClock.getDriftPpm()
    const latency  = latencyMeasurement.measure(driftPpm)

    let files: string[] = []
    const onaRec = (window as any).onaRecording
    if (onaRec) {
      const result = await onaRec.finalizeSession(session.id, latency)
      files = result?.files ?? []
    }

    const stats = bufferManager.getStats()
    console.log(`[MultitrackRecorder] Session ${session.id} done — ${files.length} files, stability=${stats.stability}`)

    return { files, stats, latency, driftPpm }
  }

  getStats() {
    return {
      active:  this.active,
      session: this._session,
      buffer:  bufferManager.getStats(),
      queue:   this._queue.stats,
      drift:   { ppm: recordingClock.getDriftPpm() },
    }
  }

  destroy(): void {
    if (this._session) this.stopSession().catch(() => {})
    this._queue.clear()
    recordingClock.destroy()
    latencyMeasurement.destroy()
  }
}

export const multitrackRecorder = new MultitrackRecorderImpl()
