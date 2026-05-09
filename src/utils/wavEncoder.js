/**
 * wavEncoder.js — Codificador WAV puro en JavaScript
 *
 * Flujo de grabación:
 *   Tone.Recorder (WebM/Opus) → decodeAudioData → AudioBuffer → encodeWav → ArrayBuffer → IPC → disco
 *
 * Soporta 16-bit y 24-bit PCM.
 */

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

/**
 * Codifica un AudioBuffer a WAV PCM.
 * @param {AudioBuffer} audioBuffer
 * @param {16|24} bitDepth
 * @returns {ArrayBuffer}
 */
export function encodeWav(audioBuffer, bitDepth = 24) {
  const numChannels   = audioBuffer.numberOfChannels
  const sampleRate    = audioBuffer.sampleRate
  const length        = audioBuffer.length
  const bytesPerSample = bitDepth / 8
  const dataSize      = length * numChannels * bytesPerSample
  const buffer        = new ArrayBuffer(44 + dataSize)
  const view          = new DataView(buffer)

  // ── RIFF header ──────────────────────────────────────────────────────────
  writeString(view, 0,  'RIFF')
  view.setUint32(4,  36 + dataSize, true)
  writeString(view, 8,  'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)             // chunk size
  view.setUint16(20, 1,  true)             // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true)  // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true)               // block align
  view.setUint16(34, bitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // ── Samples interleaved ───────────────────────────────────────────────────
  let offset = 44
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(c)[i]))
      if (bitDepth === 16) {
        view.setInt16(offset, Math.round(s * 32767), true)
        offset += 2
      } else {
        // 24-bit: 3 bytes little-endian
        const v = Math.round(s * 8388607)
        view.setUint8(offset,     v & 0xFF)
        view.setUint8(offset + 1, (v >> 8) & 0xFF)
        view.setUint8(offset + 2, (v >> 16) & 0xFF)
        offset += 3
      }
    }
  }

  return buffer
}

/**
 * Convierte un Blob (WebM/Opus de Tone.Recorder) a ArrayBuffer WAV 24-bit.
 * @param {Blob} blob
 * @returns {Promise<ArrayBuffer>}
 */
export async function blobToWav(blob, bitDepth = 24) {
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx    = new AudioContext()
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
    return encodeWav(audioBuffer, bitDepth)
  } finally {
    audioCtx.close()
  }
}
