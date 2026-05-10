/**
 * ona-dsp-processor.js — Gate DSP en el audio thread (AudioWorklet)
 *
 * Reemplaza el Tone.Gain gate + la lógica de smoothing del RAF loop.
 * El gate ahora se computa y aplica DENTRO del audio thread — realtime-safe.
 *
 * Invariantes realtime-safe:
 *   - CERO allocations en process()
 *   - CERO setTimeout/setInterval
 *   - AudioParams para todos los parámetros controlables (thread-safe)
 *   - SAB para exponer el gate level al main thread (lock-free)
 *
 * AudioParams expuestos (K-rate — valor constante por buffer de 128 samples):
 *   threshold  dBFS umbral del gate        [-96, 0]   default -50
 *   attack     tiempo de apertura (s)      [0, 2]     default 0.002
 *   release    tiempo de cierre (s)        [0, 5]     default 0.15
 *   range      atenuación al cerrar (dBFS) [-96, 0]   default -80
 *   bypass     0=activo, 1=bypass          [0, 1]     default 1
 *
 * Comunicación con main thread vía SAB:
 *   sab[channelIndex * 8 + 2] = gateLevel (0.0 a 1.0)
 *
 * Inserción en el grafo (ChannelStrip):
 *   HPF → [este worklet] → Compressor → ...
 */

// Constante pre-calculada para dBFS sin división: 20/ln(10) = 8.6858...
const DB_COEFF = 8.685889638065822

class OnaDspProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors () {
    return [
      { name: 'threshold', defaultValue: -50,   minValue: -96,  maxValue: 0,   automationRate: 'k-rate' },
      { name: 'attack',    defaultValue: 0.002,  minValue: 0,    maxValue: 2,   automationRate: 'k-rate' },
      { name: 'release',   defaultValue: 0.15,   minValue: 0,    maxValue: 5,   automationRate: 'k-rate' },
      { name: 'range',     defaultValue: -80,    minValue: -96,  maxValue: 0,   automationRate: 'k-rate' },
      { name: 'bypass',    defaultValue: 1,      minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
    ]
  }

  constructor (options) {
    super()

    // ── Estado del gate — pre-allocado, sin cambios en process() ──
    this._gateLevel    = 1.0  // suavizado (0 = cerrado, 1 = abierto)
    this._sampleRate   = sampleRate  // global del AudioWorklet scope

    // ── SAB para reportar gate level al main thread ──
    this._sabView      = null
    this._sabOffset    = 0

    this.port.onmessage = (event) => {
      const { sab, channelIndex } = event.data
      if (sab) {
        this._sabView  = new Float32Array(sab)
        this._sabOffset = (channelIndex ?? 0) * 8
      }
    }
  }

  // INVARIANTE: process() — sin allocations, sin new, sin logging
  process (inputs, outputs, parameters) {
    const input  = inputs[0]
    const output = outputs[0]

    if (!input.length || !output.length) return true

    const bypass    = parameters.bypass[0]    // K-rate: un valor por buffer

    // Passthrough cuando bypass activo
    if (bypass > 0.5) {
      const chCount = input.length < output.length ? input.length : output.length
      for (let ch = 0; ch < chCount; ch++) {
        output[ch].set(input[ch])
      }
      // Gate level = abierto al 100% en bypass
      if (this._sabView !== null) this._sabView[this._sabOffset + 2] = 1.0
      return true
    }

    const threshold = parameters.threshold[0]
    const attack    = parameters.attack[0]
    const release   = parameters.release[0]
    const range     = parameters.range[0]

    // range dBFS → gain lineal (pre-calculado, no aloca)
    const rangeGain = range <= -96 ? 0 : Math.pow(10, range * 0.05)  // 10^(range/20)

    // 1. Peak detection del canal 0 (detección mono — eficiencia > precisión)
    const buf0 = input[0]
    const len  = buf0.length
    let peak = 0
    for (let i = 0; i < len; i++) {
      const s = buf0[i]
      const a = s < 0 ? -s : s
      if (a > peak) peak = a
    }
    const peakDb = peak > 0 ? DB_COEFF * Math.log(peak) : -200

    // 2. Gate smoothing — ballistics por buffer (no sample-by-sample, suficiente para gate)
    const targetGain = peakDb > threshold ? 1.0 : rangeGain
    const tc         = peakDb > threshold ? attack : release
    // alpha: coeficiente de suavizado exponencial
    // tc * sampleRate = número de samples para el tiempo de ataque/release
    // Dividimos entre len porque computamos una vez por buffer
    const tcSamples = tc * this._sampleRate
    const alpha     = tcSamples > 0 ? Math.exp(-len / tcSamples) : 0
    this._gateLevel = alpha * this._gateLevel + (1 - alpha) * targetGain

    const gateGain = this._gateLevel

    // 3. Aplicar gate a todos los canales
    const chCount = input.length < output.length ? input.length : output.length
    for (let ch = 0; ch < chCount; ch++) {
      const inp = input[ch]
      const out = output[ch]
      for (let i = 0; i < len; i++) {
        out[i] = inp[i] * gateGain
      }
    }

    // 4. Reportar gate level al main thread vía SAB
    if (this._sabView !== null) {
      this._sabView[this._sabOffset + 2] = gateGain
    }

    return true
  }
}

registerProcessor('ona-dsp-processor', OnaDspProcessor)
