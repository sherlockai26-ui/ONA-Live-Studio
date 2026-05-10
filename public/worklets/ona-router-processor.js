/**
 * ona-router-processor.js — Router/mixing DSP en el audio thread
 *
 * Estado actual: PASSTHROUGH (placeholder para routing matrix futura)
 *
 * Diseñado para escalar hacia:
 *   - Routing matrix N×M (ANY INPUT → ANY BUS → ANY OUTPUT)
 *   - Gain automation en audio thread
 *   - Futuro: Rust DSP engine bridge
 *
 * AudioParams:
 *   gain    nivel de salida [0, 4]  default 1.0
 *   mute    0=activo, 1=mute       default 0
 *
 * Invariantes realtime-safe:
 *   - CERO allocations en process()
 *   - CERO heap access dinámico
 */

class OnaRouterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors () {
    return [
      { name: 'gain', defaultValue: 1.0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
      { name: 'mute', defaultValue: 0,   minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor () {
    super()
    this._sabView   = null
    this._sabOffset = 0

    this.port.onmessage = (event) => {
      const { sab, busIndex } = event.data
      if (sab) {
        this._sabView   = new Float32Array(sab)
        this._sabOffset = (busIndex ?? 0) * 8 + 1  // output peak
      }
    }
  }

  // INVARIANTE: process() — sin allocations, deterministic
  process (inputs, outputs, parameters) {
    const input  = inputs[0]
    const output = outputs[0]
    if (!input.length || !output.length) return true

    const gain = parameters.gain[0]
    const mute = parameters.mute[0]
    const g    = mute > 0.5 ? 0 : gain

    const chCount = input.length < output.length ? input.length : output.length
    const len     = input[0].length

    // Aplicar gain o silenciar
    for (let ch = 0; ch < chCount; ch++) {
      const inp = input[ch]
      const out = output[ch]
      for (let i = 0; i < len; i++) {
        out[i] = inp[i] * g
      }
    }

    // Peak metering para SAB
    if (this._sabView !== null && input.length > 0) {
      const buf = input[0]
      let peak = 0
      for (let i = 0; i < len; i++) {
        const s = buf[i]
        const a = s < 0 ? -s : s
        if (a > peak) peak = a
      }
      this._sabView[this._sabOffset] = peak > 0 ? 8.685889638065822 * Math.log(peak) : -200
    }

    return true
  }
}

registerProcessor('ona-router-processor', OnaRouterProcessor)
