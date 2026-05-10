/**
 * ona-meter-processor.js — AudioWorklet de metering en el audio thread
 *
 * Responsabilidades:
 *   - Passthrough transparente (no altera la señal)
 *   - Calcula peak en el audio thread sin pasar por main thread
 *   - Escribe en SharedArrayBuffer (lock-free, sin GC)
 *
 * Invariantes realtime-safe:
 *   - CERO allocations en process()
 *   - CERO closures que capturen estado mutable
 *   - CERO logging en hot path
 *   - Todos los buffers pre-allocados en el constructor
 *
 * Comunicación con main thread:
 *   - SAB recibido vía port.postMessage({ sab, channelIndex })
 *   - Escribe: sab[channelIndex * 8 + 1] = outputPeakDb
 *   - Lee: nada (solo escribe)
 *
 * Layout SAB (Float32, strides de 8 por canal):
 *   [chIdx * 8 + 0] input peak dBFS
 *   [chIdx * 8 + 1] output peak dBFS
 *   [chIdx * 8 + 2] gate level
 *   [chIdx * 8 + 3] reserved
 */

const LOG10 = Math.log(10)
const INV_20_LOG10 = 1 / (20 / Math.log(10))  // para db = 20*log10(x)

class OnaMeterProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super()

    // ── Pre-alloación de todo lo que necesita process() ──
    this._sabView      = null   // Float32Array — se asigna vía postMessage
    this._channelIndex = 0      // índice de canal (0-based)
    this._sabOffset    = 0      // float offset en SAB: channelIndex * 8
    this._isTap        = options.processorOptions?.isTap !== false  // true = solo monitorear entrada, no output

    this.port.onmessage = (event) => {
      const { sab, channelIndex } = event.data
      if (sab) {
        this._sabView      = new Float32Array(sab)
        this._channelIndex = channelIndex ?? 0
        this._sabOffset    = this._channelIndex * 8
      }
    }
  }

  // INVARIANTE: process() — sin allocations, sin logging, deterministic
  process (inputs, outputs) {
    const input  = inputs[0]
    const output = outputs[0]

    // 1. Passthrough — copiar input a output sin modificar
    if (input.length > 0 && output.length > 0) {
      const chCount = input.length < output.length ? input.length : output.length
      for (let ch = 0; ch < chCount; ch++) {
        output[ch].set(input[ch])
      }
    }

    // 2. Peak detection — sin allocations, sin Math.abs (usa branch)
    if (this._sabView !== null && input.length > 0) {
      const buf = input[0]
      let peak = 0
      const len = buf.length
      for (let i = 0; i < len; i++) {
        const s = buf[i]
        const a = s < 0 ? -s : s
        if (a > peak) peak = a
      }

      // dBFS: 20 * log10(peak) — evitar log(0)
      const peakDb = peak > 0 ? 8.685889638065822 * Math.log(peak) : -200

      // Escribir al SAB — acceso alineado Float32, atómico en x86/ARM
      this._sabView[this._sabOffset + 1] = peakDb
    }

    return true  // mantener el processor vivo
  }
}

registerProcessor('ona-meter-processor', OnaMeterProcessor)
