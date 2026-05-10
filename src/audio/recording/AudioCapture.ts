/**
 * AudioCapture.ts — Per-channel audio capture with AudioWorklet / ScriptProcessorNode fallback.
 *
 * Taps from a source AudioNode (typically ChannelStrip.preFaderTap — post-EQ, pre-fader).
 * Captured samples arrive as Float32Array mono chunks via the onData callback.
 *
 * AudioWorklet is preferred: lower overhead, runs off the main thread.
 * ScriptProcessorNode fallback is used when the worklet module fails to load.
 */

export type CaptureCallback = (channelId: number, samples: Float32Array) => void

export class AudioCapture {
  private _ctx:        AudioContext
  private _channelId:  number
  private _source:     AudioNode
  private _onData:     CaptureCallback
  private _worklet:    AudioWorkletNode | null = null
  private _script:     ScriptProcessorNode | null = null
  private _silentSink: GainNode | null = null
  private _active      = false

  constructor(
    ctx:       AudioContext,
    channelId: number,
    source:    AudioNode,
    onData:    CaptureCallback,
  ) {
    this._ctx       = ctx
    this._channelId = channelId
    this._source    = source
    this._onData    = onData
  }

  get channelId(): number { return this._channelId }
  get active():    boolean { return this._active }

  async start(): Promise<void> {
    if (this._active) return
    this._active = true
    try {
      await this._startWorklet()
    } catch (_) {
      // Worklet not available or module load failed — use ScriptProcessorNode
      this._startFallback()
    }
  }

  private async _startWorklet(): Promise<void> {
    await this._ctx.audioWorklet.addModule('/worklets/capture-processor.js')

    const node = new AudioWorkletNode(this._ctx, 'ona-capture')
    node.port.onmessage = (e) => {
      if (e.data?.type === 'data' && this._active) {
        this._onData(this._channelId, e.data.samples as Float32Array)
      }
    }

    // Silent sink: keeps worklet alive without routing capture audio to speakers
    const sink = this._ctx.createGain()
    sink.gain.value = 0
    sink.connect(this._ctx.destination)

    this._source.connect(node)
    node.connect(sink)

    this._worklet    = node
    this._silentSink = sink
  }

  private _startFallback(): void {
    const sp = this._ctx.createScriptProcessor(4096, 1, 1)
    sp.onaudioprocess = (e) => {
      if (!this._active) return
      const raw = e.inputBuffer.getChannelData(0)
      this._onData(this._channelId, raw.slice())  // slice = copy (safe to hold reference)
    }

    const sink = this._ctx.createGain()
    sink.gain.value = 0
    sink.connect(this._ctx.destination)

    this._source.connect(sp)
    sp.connect(sink)

    this._script     = sp
    this._silentSink = sink
  }

  stop(): void {
    if (!this._active) return
    this._active = false

    if (this._worklet) {
      this._worklet.port.postMessage({ type: 'stop' })
      try { this._source.disconnect(this._worklet) } catch (_) {}
      try { this._worklet.disconnect() }             catch (_) {}
      this._worklet = null
    }

    if (this._script) {
      this._script.onaudioprocess = null
      try { this._source.disconnect(this._script) } catch (_) {}
      try { this._script.disconnect() }             catch (_) {}
      this._script = null
    }

    if (this._silentSink) {
      try { this._silentSink.disconnect() } catch (_) {}
      this._silentSink = null
    }
  }
}
