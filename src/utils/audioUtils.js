/**
 * audioUtils.js — Utilidades de audio para ONA Live Studio
 *
 * Incluye:
 *   · computeFilterResponse()  — respuesta en frecuencia de un filtro biquad
 *   · computeEqCurve()         — curva combinada de todas las bandas EQ
 *   · logFrequencies()         — array de frecuencias en escala logarítmica
 */

const SAMPLE_RATE = 48000

/**
 * Calcula la respuesta en dB de un filtro biquad sobre un array de frecuencias.
 * Implementa las ecuaciones estándar de Audio EQ Cookbook (R. Bristow-Johnson).
 */
export function computeFilterResponse(type, freqHz, Q, gainDb, frequencies) {
  const A    = Math.pow(10, gainDb / 40)
  const w0   = (2 * Math.PI * freqHz) / SAMPLE_RATE
  const cosW = Math.cos(w0)
  const sinW = Math.sin(w0)
  const alpha = sinW / (2 * Q)

  let b0, b1, b2, a0, a1, a2

  switch (type) {
    case 'peaking':
      b0 = 1 + alpha * A
      b1 = -2 * cosW
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cosW
      a2 = 1 - alpha / A
      break
    case 'lowshelf': {
      const sqA = Math.sqrt(A)
      b0 = A * ((A + 1) - (A - 1) * cosW + 2 * sqA * alpha)
      b1 = 2 * A * ((A - 1) - (A + 1) * cosW)
      b2 = A * ((A + 1) - (A - 1) * cosW - 2 * sqA * alpha)
      a0 = (A + 1) + (A - 1) * cosW + 2 * sqA * alpha
      a1 = -2 * ((A - 1) + (A + 1) * cosW)
      a2 = (A + 1) + (A - 1) * cosW - 2 * sqA * alpha
      break
    }
    case 'highshelf': {
      const sqA = Math.sqrt(A)
      b0 = A * ((A + 1) + (A - 1) * cosW + 2 * sqA * alpha)
      b1 = -2 * A * ((A - 1) + (A + 1) * cosW)
      b2 = A * ((A + 1) + (A - 1) * cosW - 2 * sqA * alpha)
      a0 = (A + 1) - (A - 1) * cosW + 2 * sqA * alpha
      a1 = 2 * ((A - 1) - (A + 1) * cosW)
      a2 = (A + 1) - (A - 1) * cosW - 2 * sqA * alpha
      break
    }
    default:
      return frequencies.map(() => 0)
  }

  // Normalizar por a0
  b0 /= a0; b1 /= a0; b2 /= a0
  a1 /= a0; a2 /= a0

  return frequencies.map(f => {
    const w   = (2 * Math.PI * f) / SAMPLE_RATE
    const cos1 = Math.cos(w), sin1 = Math.sin(w)
    const cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w)

    const nRe = b0 + b1 * cos1 + b2 * cos2
    const nIm = -b1 * sin1 - b2 * sin2
    const dRe = 1 + a1 * cos1 + a2 * cos2
    const dIm = -a1 * sin1 - a2 * sin2

    const mag2 = (nRe ** 2 + nIm ** 2) / (dRe ** 2 + dIm ** 2)
    return 10 * Math.log10(Math.max(mag2, 1e-10))
  })
}

/**
 * Suma las respuestas de todas las bandas activas → curva EQ combinada en dB.
 * eqBands: [{ id, gain, freq, q }] (del store)
 * bandDefs: EQ_BAND_DEFS (para type)
 */
export function computeEqCurve(eqBands, bandDefs, frequencies) {
  const total = new Array(frequencies.length).fill(0)
  eqBands.forEach(band => {
    if (band.gain === 0) return   // banda plana → no contribuye
    const def = bandDefs.find(d => d.id === band.id)
    if (!def) return
    const response = computeFilterResponse(def.type, band.freq, band.q, band.gain, frequencies)
    response.forEach((v, i) => { total[i] += v })
  })
  return total
}

/**
 * Genera N frecuencias equiespaciadas en escala logarítmica entre fMin y fMax.
 */
export function logFrequencies(fMin = 20, fMax = 20000, N = 512) {
  const logMin = Math.log10(fMin)
  const logMax = Math.log10(fMax)
  return Array.from({ length: N }, (_, i) =>
    Math.pow(10, logMin + (i / (N - 1)) * (logMax - logMin))
  )
}

/** Convierte volumen lineal 0-100 a dB */
export function volToDb(vol) {
  if (vol <= 0) return -Infinity
  return 20 * Math.log10(vol / 100)
}
