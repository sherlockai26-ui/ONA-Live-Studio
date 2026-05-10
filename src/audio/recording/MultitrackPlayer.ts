/**
 * MultitrackPlayer.ts — Load and play recorded WAV sessions for virtual soundcheck.
 *
 * Playback is routed to channel strip inputGain nodes, so all DSP processing
 * (EQ, compressor, gate, routing) is applied exactly as in a live performance.
 *
 * API:
 *   setTarget(channelId, inputGain)   — register playback destination
 *   loadSessionTrack(channelId, path) — decode WAV from disk via IPC
 *   loadTrack(channelId, arrayBuffer) — decode from in-memory ArrayBuffer
 *   start(offsetSeconds)              — begin playback
 *   pause() / seek(seconds)           — transport control
 *   stop()                            — stop + reset position
 *   unloadTracks()                    — free AudioBuffers
 */

export interface PlayerTrack {
  channelId:   number
  buffer:      AudioBuffer
  source:      AudioBufferSourceNode | null
  startOffset: number    // position at which start() was called (seconds)
}

class MultitrackPlayerImpl {
  private _ctx:         AudioContext | null = null
  private _tracks       = new Map<number, PlayerTrack>()
  private _targets      = new Map<number, AudioNode>()   // channelId → inputGain
  private _ctxStartTime = 0   // ctx.currentTime when start() was called
  private _pauseOffset  = 0   // playback position when paused (seconds)
  private _playing      = false
  private _loop         = false

  get playing():  boolean { return this._playing }
  get loop():     boolean { return this._loop }
  set loop(v:    boolean) { this._loop = v }

  get position(): number {
    if (!this._ctx) return 0
    return this._playing
      ? this._ctx.currentTime - this._ctxStartTime + this._pauseOffset
      : this._pauseOffset
  }

  get duration(): number {
    let max = 0
    for (const t of this._tracks.values()) if (t.buffer.duration > max) max = t.buffer.duration
    return max
  }

  setContext(ctx: AudioContext): void { this._ctx = ctx }

  /** Register where a channel's audio should be routed during playback */
  setTarget(channelId: number, inputGain: AudioNode): void {
    this._targets.set(channelId, inputGain)
  }

  removeTarget(channelId: number): void { this._targets.delete(channelId) }

  /** Decode an in-memory ArrayBuffer (WAV/MP3/etc.) into the track for channelId */
  async loadTrack(channelId: number, arrayBuffer: ArrayBuffer): Promise<boolean> {
    if (!this._ctx) return false
    try {
      const audioBuffer = await this._ctx.decodeAudioData(arrayBuffer.slice(0))
      this._tracks.set(channelId, { channelId, buffer: audioBuffer, source: null, startOffset: 0 })
      return true
    } catch (err) {
      console.error(`[MultitrackPlayer] decodeAudioData ch${channelId}:`, err)
      return false
    }
  }

  /** Load a WAV file from disk via Electron IPC */
  async loadSessionTrack(channelId: number, filePath: string): Promise<boolean> {
    const onaRec = (window as any).onaRecording
    if (!onaRec) { console.error('[MultitrackPlayer] onaRecording not available'); return false }
    try {
      const buf = await onaRec.loadFile(filePath)
      if (!buf) return false
      return this.loadTrack(channelId, buf)
    } catch (err) {
      console.error(`[MultitrackPlayer] loadSessionTrack ch${channelId}:`, err)
      return false
    }
  }

  start(offsetSeconds = this._pauseOffset): void {
    if (!this._ctx || this._playing) return
    this._pauseOffset  = offsetSeconds
    this._ctxStartTime = this._ctx.currentTime
    this._playing      = true

    for (const [channelId, track] of this._tracks) {
      const target = this._targets.get(channelId)
      if (!target) continue

      const src = this._ctx.createBufferSource()
      src.buffer = track.buffer
      src.loop   = this._loop
      src.connect(target)
      src.start(0, offsetSeconds)
      src.onended = () => {
        if (this._playing && !this._loop) this._onPlaybackEnded()
      }
      track.source      = src
      track.startOffset = offsetSeconds
    }
  }

  pause(): void {
    if (!this._playing) return
    this._pauseOffset = this.position
    this._playing     = false
    this._stopSources()
  }

  stop(): void {
    this._playing     = false
    this._pauseOffset = 0
    this._ctxStartTime = 0
    this._stopSources()
  }

  seek(seconds: number): void {
    const wasPlaying = this._playing
    if (wasPlaying) this.pause()
    this._pauseOffset = Math.max(0, Math.min(seconds, this.duration))
    if (wasPlaying) this.start(this._pauseOffset)
  }

  private _stopSources(): void {
    for (const track of this._tracks.values()) {
      try { track.source?.stop() }       catch (_) {}
      try { track.source?.disconnect() } catch (_) {}
      track.source = null
    }
  }

  private _onPlaybackEnded(): void {
    this._playing     = false
    this._pauseOffset = 0
  }

  loadedChannels(): number[] { return Array.from(this._tracks.keys()) }

  unloadTrack(channelId: number): void {
    const t = this._tracks.get(channelId)
    if (!t) return
    try { t.source?.stop() }       catch (_) {}
    try { t.source?.disconnect() } catch (_) {}
    this._tracks.delete(channelId)
  }

  unloadTracks(): void {
    this.stop()
    this._tracks.clear()
  }

  destroy(): void {
    this.unloadTracks()
    this._targets.clear()
    this._ctx = null
  }
}

export const multitrackPlayer = new MultitrackPlayerImpl()
