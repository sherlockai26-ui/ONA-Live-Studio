/**
 * FxCpuProtection.ts — Protección de CPU para motores FX con feedback.
 *
 * Tres capas de protección (Paso 12):
 *
 *  1. Feedback clamp: GainNode de feedback limitado a MAX_FEEDBACK (0.97) independiente
 *     de lo que pida el usuario. Evita feedback ≥ 1.0 que causaría runaway exponencial.
 *
 *  2. Denormal protection: inyectar señal DC de amplitud 1e-25 en el path de feedback.
 *     Sin esto, en algunas plataformas, los loops de feedback producen IEEE 754 denormals
 *     que el FPU procesa ~100× más lento (subnormals). El kick mantiene los valores
 *     en rango normal flotando sobre el ruido de cuantización.
 *
 *  3. Runaway detection: AnalyserNode en la salida del FX bus. Si el pico supera
 *     RUNAWAY_THRESHOLD, se llama onRunaway() que typicalmente silencia el bus.
 *     Check cada 200ms (sin hot path).
 */

export const MAX_FEEDBACK        = 0.97   // hard clamp: |feedback gain| ≤ 0.97
export const RUNAWAY_THRESHOLD   = 1.4    // +3dBFS: señal fuera de rango → runaway

/** Clamp feedback coefficient to safe range [0, MAX_FEEDBACK]. */
export function clampFeedback(value: number): number {
  return Math.max(0, Math.min(value, MAX_FEEDBACK))
}

/**
 * Create a minimal DC injection source for denormal protection.
 * Returns a GainNode (amplitude 1e-25) that should be connected to each
 * feedback loop node that risks producing denormals (delay→lpf→gain).
 *
 * Must call start() after connecting. Call stop() + disconnect in destroy().
 */
export function createDenormalKick(ctx: AudioContext): {
  node:  GainNode
  start: () => void
  stop:  () => void
} {
  // Single sample alternating +/− pattern — minimum valid AudioBuffer
  const buffer    = ctx.createBuffer(1, 2, ctx.sampleRate)
  const data      = buffer.getChannelData(0)
  data[0]  =  1e-25
  data[1]  = -1e-25

  const gainNode = ctx.createGain()
  gainNode.gain.value = 1.0

  let src: AudioBufferSourceNode | null = null

  const start = () => {
    src        = ctx.createBufferSource()
    src.buffer = buffer
    src.loop   = true
    src.connect(gainNode)
    src.start()
  }

  const stop = () => {
    try { src?.stop() } catch (_) {}
    try { src?.disconnect() } catch (_) {}
    src = null
  }

  return { node: gainNode, start, stop }
}

/**
 * Attach a runaway detector to an AnalyserNode.
 * Returns a cleanup function (call in destroy() of the FX engine).
 *
 * onRunaway is called at most once per 2s to avoid callback storms.
 */
export function watchRunaway(
  analyser:   AnalyserNode,
  onRunaway:  () => void,
): () => void {
  const fftSize = Math.max(32, analyser.fftSize >> 2)  // small buffer for speed
  const buf     = new Float32Array(fftSize)
  let lastFired = 0
  let active    = true

  const check = () => {
    if (!active) return
    analyser.getFloatTimeDomainData(buf)
    let peak = 0
    for (let i = 0; i < buf.length; i++) {
      const abs = Math.abs(buf[i])
      if (abs > peak) peak = abs
    }
    const now = performance.now()
    if (peak > RUNAWAY_THRESHOLD && (now - lastFired) > 2000) {
      lastFired = now
      onRunaway()
    }
  }

  const id = setInterval(check, 200)
  return () => { active = false; clearInterval(id) }
}

/** Apply a smooth ramp to an AudioParam (no zipper noise). tc = time constant in seconds. */
export function ramp(ctx: AudioContext, param: AudioParam, target: number, tc = 0.012): void {
  param.setTargetAtTime(target, ctx.currentTime, tc)
}
