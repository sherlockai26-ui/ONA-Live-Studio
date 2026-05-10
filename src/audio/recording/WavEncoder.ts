/**
 * WavEncoder.ts — WAV header building + Float32 → Int24 PCM encoding
 *
 * All WAV files are mono 24-bit PCM (one file per channel).
 * The 44-byte RIFF/WAVE/fmt/data header is written first with placeholder
 * sizes; electron/main.cjs seeks back and patches offsets 4 and 40 on finalize.
 */

export const WAV_HEADER_SIZE = 44

/** Build a complete 44-byte WAV header. Pass numSamples=0 for a placeholder. */
export function buildWavHeader(
  sampleRate:  number,
  numChannels: number,
  numSamples:  number
): ArrayBuffer {
  const bitsPerSample = 24
  const bytesPerSample = bitsPerSample / 8
  const byteRate   = sampleRate * numChannels * bytesPerSample
  const blockAlign = numChannels * bytesPerSample
  const dataSize   = numSamples * numChannels * bytesPerSample

  const buf  = new ArrayBuffer(WAV_HEADER_SIZE)
  const view = new DataView(buf)

  _writeStr(view, 0,  'RIFF')
  view.setUint32(4,   36 + dataSize, true)   // ChunkSize  (patched on finalize)
  _writeStr(view, 8,  'WAVE')
  _writeStr(view, 12, 'fmt ')
  view.setUint32(16,  16,           true)    // Subchunk1Size (PCM = 16)
  view.setUint16(20,  1,            true)    // AudioFormat 1 = PCM
  view.setUint16(22,  numChannels,  true)
  view.setUint32(24,  sampleRate,   true)
  view.setUint32(28,  byteRate,     true)
  view.setUint16(32,  blockAlign,   true)
  view.setUint16(34,  bitsPerSample,true)
  _writeStr(view, 36, 'data')
  view.setUint32(40,  dataSize,     true)    // Subchunk2Size (patched on finalize)

  return buf
}

function _writeStr(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

/**
 * Encode Float32 samples to 24-bit signed PCM (little-endian two's complement).
 * Clips to [-1, 1] before scaling to avoid wrap-around on hot signals.
 */
export function encodeInt24(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 3)
  let pos = 0

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    // Scale: -1.0 → -8388608, 1.0 → 8388607
    let v = clamped < 0
      ? Math.ceil(clamped  * 8388608)
      : Math.floor(clamped * 8388607)

    // Two's complement 24-bit (sign-extend to 32-bit via bitwise ops)
    out[pos++] =  v        & 0xFF
    out[pos++] = (v >>  8) & 0xFF
    out[pos++] = (v >> 16) & 0xFF
  }

  return out
}

/** Number of mono 24-bit PCM samples contained in `dataBytes` bytes */
export function samplesFromDataSize(dataBytes: number, numChannels = 1): number {
  return Math.floor(dataBytes / (numChannels * 3))
}
