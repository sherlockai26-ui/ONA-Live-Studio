/**
 * DSPTestSignal.ts — Generadores de señal de prueba para validación DSP.
 *
 * Genera señales estándar directamente en el AudioContext sin allocations en hot path.
 * Uso: conectar la salida al canal de entrada deseado para sweep, calibración, etc.
 *
 * Señales disponibles:
 *   sine(freq, ampl)   — tono puro (calibración de nivel, resonancias)
 *   pinknoise(ampl)    — ruido rosa (respuesta en frecuencia, EQ)
 *   sweep(f0, f1, dur) — chirp log (análisis IR, phase)
 *   impulse(ampl)      — impulso unitario (respuesta al impulso)
 *
 * Console API: window.__ONA_TEST.*
 */

// ─── Sine ─────────────────────────────────────────────────────────────────────

export class SineGenerator {
  private readonly _osc:  OscillatorNode
  private readonly _gain: GainNode
  private _running = false

  constructor(ctx: AudioContext, freq = 1000, amplDb = -18) {
    this._osc  = ctx.createOscillator()
    this._gain = ctx.createGain()
    this._osc.type = 'sine'
    this._osc.frequency.value = freq
    this._gain.gain.value = Math.pow(10, amplDb / 20)
    this._osc.connect(this._gain)
  }

  get output(): AudioNode { return this._gain }

  start(): void {
    if (this._running) return
    this._osc.start()
    this._running = true
  }

  stop(): void {
    if (!this._running) return
    try { this._osc.stop() } catch (_) {}
    this._osc.disconnect()
    this._gain.disconnect()
    this._running = false
  }

  setFreq(hz: number): void { this._osc.frequency.value = hz }
  setAmplDb(db: number): void { this._gain.gain.value = Math.pow(10, db / 20) }
}

// ─── Pink Noise ───────────────────────────────────────────────────────────────
// Paul Kellet's refined pink noise filter (6 stage IIR, ≈ -3dB/oct)

export class PinkNoiseGenerator {
  private readonly _node:  ScriptProcessorNode
  private readonly _gain:  GainNode
  private _running = false
  private _b0 = 0; _b1 = 0; _b2 = 0; _b3 = 0; _b4 = 0; _b5 = 0; _b6 = 0

  constructor(ctx: AudioContext, amplDb = -18) {
    this._gain = ctx.createGain()
    this._gain.gain.value = Math.pow(10, amplDb / 20)

    // ScriptProcessorNode deprecated but universally supported; AudioWorklet needs registration
    this._node = ctx.createScriptProcessor(4096, 0, 1)
    this._node.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0)
      for (let i = 0; i < out.length; i++) {
        const wh = Math.random() * 2 - 1
        this._b0 = 0.99886 * this._b0 + wh * 0.0555179
        this._b1 = 0.99332 * this._b1 + wh * 0.0750759
        this._b2 = 0.96900 * this._b2 + wh * 0.1538520
        this._b3 = 0.86650 * this._b3 + wh * 0.3104856
        this._b4 = 0.55000 * this._b4 + wh * 0.5329522
        this._b5 = -0.7616 * this._b5 - wh * 0.0168980
        out[i] = (this._b0 + this._b1 + this._b2 + this._b3 + this._b4 + this._b5 + this._b6 + wh * 0.5362) * 0.11
        this._b6 = wh * 0.115926
      }
    }
    this._node.connect(this._gain)
  }

  get output(): AudioNode { return this._gain }

  start(): void { this._running = true }
  stop(): void  {
    this._node.disconnect()
    this._gain.disconnect()
    this._running = false
  }

  setAmplDb(db: number): void { this._gain.gain.value = Math.pow(10, db / 20) }
}

// ─── Log Sweep ────────────────────────────────────────────────────────────────

export class SweepGenerator {
  private readonly _osc:  OscillatorNode
  private readonly _gain: GainNode

  constructor(ctx: AudioContext, f0 = 20, f1 = 20000, durationMs = 5000, amplDb = -18) {
    this._osc  = ctx.createOscillator()
    this._gain = ctx.createGain()
    this._osc.type = 'sine'
    this._gain.gain.value = Math.pow(10, amplDb / 20)

    const t0  = ctx.currentTime + 0.01
    const dur = durationMs / 1000
    this._osc.frequency.setValueAtTime(f0, t0)
    this._osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur)

    this._osc.connect(this._gain)
    this._osc.start(t0)
    this._osc.stop(t0 + dur + 0.05)
  }

  get output(): AudioNode { return this._gain }

  connect(dest: AudioNode): void { this._gain.connect(dest) }
}

// ─── Impulse ──────────────────────────────────────────────────────────────────

export class ImpulseGenerator {
  private readonly _buf:    AudioBuffer
  private readonly _src:    AudioBufferSourceNode
  private readonly _gain:   GainNode

  constructor(ctx: AudioContext, amplDb = 0) {
    this._gain = ctx.createGain()
    this._gain.gain.value = Math.pow(10, amplDb / 20)

    this._buf = ctx.createBuffer(1, 1, ctx.sampleRate)
    this._buf.getChannelData(0)[0] = 1.0

    this._src = ctx.createBufferSource()
    this._src.buffer = this._buf
    this._src.connect(this._gain)
  }

  get output(): AudioNode { return this._gain }

  fire(): void {
    this._src.start()
  }
}

// ─── Console API ──────────────────────────────────────────────────────────────

let _activeGen: { stop?: () => void } | null = null

export function exposeTestSignalAPI(ctx: AudioContext, destination: AudioNode): void {
  const stopActive = () => {
    _activeGen?.stop?.()
    _activeGen = null
  }

  ;(window as any).__ONA_TEST = {
    sine: (freq = 1000, db = -18) => {
      stopActive()
      const g = new SineGenerator(ctx, freq, db)
      g.output.connect(destination)
      g.start()
      _activeGen = g
      console.log(`[TEST] Sine ${freq}Hz @ ${db}dBFS — __ONA_TEST.stop() to stop`)
      return g
    },
    pink: (db = -18) => {
      stopActive()
      const g = new PinkNoiseGenerator(ctx, db)
      g.output.connect(destination)
      g.start()
      _activeGen = g
      console.log(`[TEST] Pink noise @ ${db}dBFS — __ONA_TEST.stop() to stop`)
      return g
    },
    sweep: (f0 = 20, f1 = 20000, ms = 5000, db = -18) => {
      stopActive()
      const g = new SweepGenerator(ctx, f0, f1, ms, db)
      g.connect(destination)
      _activeGen = { stop: () => {} }
      console.log(`[TEST] Log sweep ${f0}→${f1}Hz / ${ms}ms @ ${db}dBFS`)
      return g
    },
    impulse: (db = 0) => {
      const g = new ImpulseGenerator(ctx, db)
      g.output.connect(destination)
      g.fire()
      console.log(`[TEST] Impulse @ ${db}dBFS`)
    },
    stop: () => { stopActive(); console.log('[TEST] Signal stopped') },
  }
}
