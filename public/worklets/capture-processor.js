/**
 * capture-processor.js — AudioWorklet per-channel capture
 *
 * Runs on the audio thread. Accumulates samples into a ring buffer and flushes
 * to the main thread via MessagePort when FLUSH_FRAMES is reached.
 * Output is silence (zeros) — source audio is NOT routed to speakers by this node.
 */

const FLUSH_FRAMES = 4096  // ~85ms @ 48kHz — balances IPC overhead vs RAM usage

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf    = new Float32Array(FLUSH_FRAMES)
    this._pos    = 0
    this._active = true

    this.port.onmessage = (e) => {
      if (e.data?.type === 'stop') this._active = false
    }
  }

  process(inputs) {
    if (!this._active) return false

    const input = inputs[0]
    if (!input || !input.length) return true

    const numCh    = input.length
    const blockLen = input[0].length

    for (let i = 0; i < blockLen; i++) {
      // Mix all input channels down to mono
      let sample = 0
      for (let ch = 0; ch < numCh; ch++) sample += input[ch][i]
      if (numCh > 1) sample /= numCh

      this._buf[this._pos++] = sample

      if (this._pos >= FLUSH_FRAMES) {
        // Transfer ownership — avoids a copy on the main-thread side
        const transfer = this._buf.buffer.slice(0)
        this.port.postMessage({ type: 'data', samples: new Float32Array(transfer) }, [transfer])
        this._buf = new Float32Array(FLUSH_FRAMES)
        this._pos = 0
      }
    }

    // outputs[0] remains zeros — silence sink
    return true
  }
}

registerProcessor('ona-capture', CaptureProcessor)
