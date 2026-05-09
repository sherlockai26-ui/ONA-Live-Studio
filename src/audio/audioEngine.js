/**
 * audioEngine.js — Motor DSP de ONA Live Studio
 *
 * Cadena de señal completa por canal (Etapas 6-7):
 *
 *   [Source / MediaStream]
 *     │
 *   inputGain (Gain)              ← tap → inputMeter (Gate threshold)
 *     │
 *   hpf (Filter, highpass)        ← Etapa 7 — bypass = freq 20Hz
 *     │
 *   gate (Gain 0..1)              ← Etapa 7 — controlado en RAF loop
 *     │
 *   compressor (Compressor)       ← Etapa 6
 *     │
 *   makeupGain (Gain)             ← makeup dB → linear
 *     │
 *   eq[0..6] (BiquadFilter × 7)  ← EQ semiparamétrico
 *     │
 *   ├── reverbSend (Gain 0..1) ──→ globalReverb ─┐
 *   ├── delaySend  (Gain 0..1) ──→ globalDelay  ─┤→ fxReturnGain → fxReturnFader → mainBus
 *     │
 *   panner (Panner)               ← Etapa 7 — equal-power
 *     │
 *   fader (Volume dB)
 *     │── outputMeter (tap, sin output)
 *     │
 *   ├── toMain (Gain 0|1) ──→ mainBus.gain → mainBus.fader → Destination
 *   └── toSub  (Gain 0|1) ──→ subBus.gain  → subBus.fader  → Destination
 *
 * React NUNCA importa Tone.js directamente.
 * Todos los cambios van a través de audioEngine.setXxx() methods.
 */

import * as Tone from 'tone'
import { EQ_BAND_DEFS } from '../store/mixerStore.js'

const BIQUAD = { lowshelf: 'lowshelf', peaking: 'peaking', highshelf: 'highshelf' }

function volToDb(v) { return v <= 0 ? -Infinity : 20 * Math.log10(v / 100) }
function dbToGain(db) { return Math.pow(10, db / 20) }

class AudioEngine {
  static #inst = null
  static getInstance() {
    if (!AudioEngine.#inst) AudioEngine.#inst = new AudioEngine()
    return AudioEngine.#inst
  }

  #channels  = {}
  #buses     = {}
  #globalFx  = {}
  #meterCbs  = new Set()
  #rafId     = null
  initialized = false

  // ── Init ──────────────────────────────────────────────────────────────────
  async initialize(numChannels = 6, initialState = {}) {
    if (this.initialized) return
    await Tone.start()
    await this.#buildGlobalFx()   // async — espera generación IR del reverb
    this.#buildBuses()
    for (let i = 1; i <= numChannels; i++) {
      const s = initialState.channels?.find(c => c.id === i) ?? {}
      this.#buildChannel(i, s)
    }
    // Apply initial state
    const s = initialState
    if (s.mainVolume != null) this.setMainVolume(s.mainVolume)
    if (s.subVolume  != null) this.setSubVolume(s.subVolume)
    if (s.fx?.reverb)   this.setGlobalReverb(s.fx.reverb)
    if (s.fx?.delay)    this.setGlobalDelay(s.fx.delay)
    if (s.fx?.fxReturn) this.setFxReturn(s.fx.fxReturn)
    this.#startLoop()
    this.initialized = true
  }

  // ── Global FX (Send/Return — Etapa 6) ─────────────────────────────────────
  async #buildGlobalFx() {
    // Tone.Reverb genera su IR de forma asíncrona; hay que esperarla antes de
    // conectarla a la cadena, o el ConvolverNode queda sin buffer y puede
    // lanzar excepciones al recibir audio.
    this.#globalFx.reverb = new Tone.Reverb({ decay: 2.5, wet: 1 })
    await this.#globalFx.reverb.generate()

    this.#globalFx.delay       = new Tone.FeedbackDelay({ delayTime: 0.3, feedback: 0.3, wet: 1 })
    this.#globalFx.returnGain  = new Tone.Gain(1)
    this.#globalFx.returnFader = new Tone.Volume(0)
    this.#globalFx.returnMeter = new Tone.Meter({ normalRange: false })
  }

  // ── Buses maestros ────────────────────────────────────────────────────────
  #buildBuses() {
    const buildBus = () => {
      const gain  = new Tone.Gain(1)
      const fader = new Tone.Volume(0)
      const meter = new Tone.Meter({ normalRange: false })
      gain.connect(fader)
      fader.connect(Tone.getDestination())
      fader.connect(meter)
      return { gain, fader, meter }
    }
    this.#buses.main = buildBus()
    this.#buses.sub  = buildBus()

    // FX Return → mainBus
    this.#globalFx.reverb.connect(this.#globalFx.returnGain)
    this.#globalFx.delay.connect(this.#globalFx.returnGain)
    this.#globalFx.returnGain.connect(this.#globalFx.returnFader)
    this.#globalFx.returnFader.connect(this.#buses.main.gain)
    this.#globalFx.returnFader.connect(this.#globalFx.returnMeter)
  }

  // ── Canal ─────────────────────────────────────────────────────────────────
  #buildChannel(id, s = {}) {
    // Input
    const inputGain  = new Tone.Gain(1)
    const inputMeter = new Tone.Meter({ normalRange: false }) // tap para gate

    // HPF (Etapa 7) — bypass = frequency 20Hz
    const hpf = new Tone.Filter({
      type: 'highpass',
      frequency: (s.hpf?.active && s.hpf?.freq) ? s.hpf.freq : 20,
      Q: 0.7,
      rolloff: -12,
    })

    // Gate (Etapa 7) — Gain controlado por RAF loop
    const gate = new Tone.Gain(1)

    // Compressor (Etapa 6)
    const comp = s.compressor ?? {}
    const compressor = new Tone.Compressor({
      threshold: comp.threshold  ?? -24,
      ratio:     comp.ratio      ?? 4,
      attack:    comp.attack     ?? 0.003,
      release:   comp.release    ?? 0.25,
      knee:      comp.knee       ?? 6,
    })
    const makeupGain = new Tone.Gain(dbToGain(comp.makeupGain ?? 0))

    // EQ 7 bandas
    const eqNodes = EQ_BAND_DEFS.map(def => {
      const band = s.eqBands?.find(b => b.id === def.id)
      return new Tone.BiquadFilter({
        type:      BIQUAD[def.type],
        frequency: band?.freq ?? def.freqDefault,
        Q:         band?.q    ?? def.qDefault,
        gain:      band?.gain ?? 0,
      })
    })

    // FX Sends (taps paralelos desde último EQ)
    const reverbSend = new Tone.Gain((s.reverbSend ?? 0) / 100)
    const delaySend  = new Tone.Gain((s.delaySend  ?? 0) / 100)

    // Pan + Fader + Routing (Etapa 7)
    const panner      = new Tone.Panner(s.pan ?? 0)
    const fader       = new Tone.Volume(volToDb(s.volume ?? 75))
    const outputMeter = new Tone.Meter({ normalRange: false })
    const toMain      = new Tone.Gain(s.toMain !== false ? 1 : 0)
    const toSub       = new Tone.Gain(s.toSub  ? 1 : 0)

    // ── Conexiones ──────────────────────────────────────────────────────────
    // inputGain → inputMeter (tap) + hpf
    inputGain.connect(inputMeter)
    inputGain.connect(hpf)

    // hpf → gate → compressor → makeupGain → EQ chain
    hpf.connect(gate)
    gate.connect(compressor)
    compressor.connect(makeupGain)

    // EQ chain
    makeupGain.connect(eqNodes[0])
    for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1])
    const eqLast = eqNodes[eqNodes.length - 1]

    // EQ last → sends paralelos + panner
    eqLast.connect(reverbSend)
    eqLast.connect(delaySend)
    eqLast.connect(panner)
    reverbSend.connect(this.#globalFx.reverb)
    delaySend.connect(this.#globalFx.delay)

    // panner → fader → meter tap + routing
    panner.connect(fader)
    fader.connect(outputMeter)
    fader.connect(toMain)
    fader.connect(toSub)
    toMain.connect(this.#buses.main.gain)
    toSub.connect(this.#buses.sub.gain)

    if (s.muted) fader.volume.value = -Infinity

    this.#channels[id] = {
      inputGain, inputMeter, hpf, gate, compressor, makeupGain,
      eqNodes, reverbSend, delaySend, panner, fader, outputMeter, toMain, toSub,
      // Gate state — actualizado en el RAF loop
      _gateLevel: 1,
      _gate: {
        bypass:    s.gate?.bypass    ?? true,
        threshold: s.gate?.threshold ?? -50,
        attack:    s.gate?.attack    ?? 0.002,
        release:   s.gate?.release   ?? 0.15,
        range:     s.gate?.range     ?? -80,
      },
      _hpfActive:  s.hpf?.active        ?? false,
      _compBypass: s.compressor?.bypass ?? false,
    }
  }

  // ── API pública ───────────────────────────────────────────────────────────

  setChannelVolume(id, vol, muted = false) {
    const ch = this.#channels[id]; if (!ch) return
    ch.fader.volume.rampTo(muted ? -Infinity : volToDb(vol), 0.02)
  }

  setChannelPan(id, pan) {
    const ch = this.#channels[id]; if (!ch) return
    ch.panner.pan.rampTo(Math.max(-1, Math.min(1, pan)), 0.02)
  }

  setChannelRouting(id, toMain, toSub) {
    const ch = this.#channels[id]; if (!ch) return
    ch.toMain.gain.rampTo(toMain ? 1 : 0, 0.02)
    ch.toSub.gain.rampTo(toSub  ? 1 : 0, 0.02)
  }

  setChannelEqBand(id, bandIndex, { gain, freq, q }) {
    const ch = this.#channels[id]; if (!ch) return
    const n = ch.eqNodes[bandIndex]
    if (gain !== undefined) n.gain.value      = gain
    if (freq !== undefined) n.frequency.value = freq
    if (q    !== undefined) n.Q.value         = q
  }

  setChannelHpf(id, { active, freq }) {
    const ch = this.#channels[id]; if (!ch) return
    if (active !== undefined) ch._hpfActive = active
    const targetFreq = ch._hpfActive ? (freq ?? ch.hpf.frequency.value) : 20
    ch.hpf.frequency.rampTo(targetFreq, 0.02)
  }

  setChannelGate(id, params) {
    const ch = this.#channels[id]; if (!ch) return
    Object.assign(ch._gate, params)
    if (params.bypass === true) { ch._gateLevel = 1; ch.gate.gain.value = 1 }
  }

  setChannelCompressor(id, params) {
    const ch = this.#channels[id]; if (!ch) return
    const { threshold, ratio, attack, release, knee, makeupGain, bypass } = params
    if (bypass !== undefined) {
      ch._compBypass = bypass
      // Bypass = ratio 1:1, threshold 0 (no compression)
      ch.compressor.ratio.rampTo(bypass ? 1 : (ratio ?? ch.compressor.ratio.value), 0.05)
      ch.compressor.threshold.rampTo(bypass ? 0 : (threshold ?? ch.compressor.threshold.value), 0.05)
      return
    }
    if (threshold  !== undefined) ch.compressor.threshold.rampTo(threshold, 0.02)
    if (ratio      !== undefined) ch.compressor.ratio.rampTo(Math.max(1, ratio), 0.02)
    if (attack     !== undefined) ch.compressor.attack.rampTo(attack, 0.02)
    if (release    !== undefined) ch.compressor.release.rampTo(release, 0.02)
    if (knee       !== undefined) ch.compressor.knee.rampTo(knee, 0.02)
    if (makeupGain !== undefined) ch.makeupGain.gain.rampTo(dbToGain(makeupGain), 0.02)
  }

  setChannelReverbSend(id, v) {
    const ch = this.#channels[id]; if (!ch) return
    ch.reverbSend.gain.rampTo(Math.max(0, v / 100), 0.02)
  }

  setChannelDelaySend(id, v) {
    const ch = this.#channels[id]; if (!ch) return
    ch.delaySend.gain.rampTo(Math.max(0, v / 100), 0.02)
  }

  setMainVolume(v) { this.#buses.main.fader.volume.rampTo(volToDb(v), 0.02) }
  setSubVolume(v)  { this.#buses.sub.fader.volume.rampTo(volToDb(v), 0.02) }

  setGlobalReverb({ active, decay, preDelay } = {}) {
    const r = this.#globalFx.reverb
    if (active    !== undefined) r.wet.rampTo(active ? 1 : 0, 0.05)
    if (decay     !== undefined && decay > 0) r.decay = decay
    if (preDelay  !== undefined) r.preDelay = preDelay / 1000
  }

  setGlobalDelay({ active, time, feedback } = {}) {
    const d = this.#globalFx.delay
    if (active   !== undefined) d.wet.rampTo(active ? 1 : 0, 0.05)
    if (time     !== undefined) d.delayTime.rampTo(time / 1000, 0.02)
    if (feedback !== undefined) d.feedback.rampTo(feedback / 100, 0.02)
  }

  setFxReturn({ volume, muted } = {}) {
    const f = this.#globalFx.returnFader
    const vol = volume ?? 80
    f.volume.rampTo(muted ? -Infinity : volToDb(vol), 0.02)
  }

  // Lectura de gain reduction del compresor (para GR meter)
  getCompReduction(id) {
    const ch = this.#channels[id]
    return ch ? ch.compressor.reduction : 0
  }

  // Estado del gate (para indicador visual)
  getGateLevel(id) {
    const ch = this.#channels[id]
    return ch ? ch._gateLevel : 1
  }

  // ── Meter callbacks ───────────────────────────────────────────────────────
  onMeterUpdate(cb) {
    this.#meterCbs.add(cb)
    return () => this.#meterCbs.delete(cb)
  }

  // ── RAF loop — meters + gate logic ────────────────────────────────────────
  #startLoop() {
    const tick = () => {
      const data = {}

      for (const [id, ch] of Object.entries(this.#channels)) {
        // Output meter
        const out = ch.outputMeter.getValue()
        data[id] = typeof out === 'number' ? out : (out[0] ?? -Infinity)

        // Input meter for gate
        const inp = ch.inputMeter.getValue()
        const inputDb = typeof inp === 'number' ? inp : (inp[0] ?? -Infinity)

        // Gate logic (~60fps granularity — suficiente para live sound)
        const g = ch._gate
        if (!g.bypass) {
          const target = inputDb > g.threshold ? 1 : dbToGain(g.range)
          const tc     = inputDb > g.threshold ? g.attack : g.release
          const alpha  = Math.exp(-1 / Math.max(tc * 60, 0.5))
          ch._gateLevel = alpha * ch._gateLevel + (1 - alpha) * target
          ch.gate.gain.value = ch._gateLevel
        }

        data[`gr_${id}`]   = ch.compressor.reduction  // GR meter
        data[`gate_${id}`] = ch._gateLevel             // Gate status
      }

      // Bus meters
      const mn = this.#buses.main.meter.getValue()
      const sb = this.#buses.sub.meter.getValue()
      data._main = typeof mn === 'number' ? mn : (mn[0] ?? -Infinity)
      data._sub  = typeof sb === 'number' ? sb : (sb[0] ?? -Infinity)

      this.#meterCbs.forEach(cb => cb(data))
      this.#rafId = requestAnimationFrame(tick)
    }
    this.#rafId = requestAnimationFrame(tick)
  }

  // ── Grabación ─────────────────────────────────────────────────────────────
  #recorders = {}

  startRecording(mode = 'procesado') {
    this.stopRecording().catch(() => {})
    if (mode === 'crudo' || mode === 'ambos') {
      this.#recorders.raw = Object.entries(this.#channels).map(([id, ch]) => {
        const rec = new Tone.Recorder()
        ch.inputGain.connect(rec)
        rec.start()
        return { id, rec }
      })
    }
    if (mode === 'procesado' || mode === 'ambos') {
      const rec = new Tone.Recorder()
      this.#buses.main.fader.connect(rec)
      rec.start()
      this.#recorders.main = rec
    }
  }

  async stopRecording() {
    const blobs = {}
    if (this.#recorders.main) { blobs.main = await this.#recorders.main.stop(); this.#recorders.main = null }
    if (this.#recorders.raw) {
      for (const { id, rec } of this.#recorders.raw) blobs[`raw_${id}`] = await rec.stop()
      this.#recorders.raw = null
    }
    return blobs
  }

  // ── Virtual Soundcheck (Etapa 11) ─────────────────────────────────────────
  #vsPlayers = {}

  async loadVSTrack(channelId, fileUrl) {
    const prev = this.#vsPlayers[channelId]
    if (prev) {
      try { prev.stop(); prev.unsync() } catch (_) {}
      prev.disconnect()
    }
    const player = new Tone.Player({ url: fileUrl, loop: true })
    await Tone.loaded()
    player.connect(this.#channels[channelId].inputGain)
    player.sync().start(0)       // sincronizado con Transport
    this.#vsPlayers[channelId] = player
    return true
  }

  startVS()  { Tone.Transport.start() }
  stopVS()   { Tone.Transport.stop();  Tone.Transport.position = 0 }
  pauseVS()  { Tone.Transport.pause() }

  getVSPlayerIds() { return Object.keys(this.#vsPlayers).map(Number) }

  // Conecta MediaStream real (Etapa 5 — hardware input)
  connectMediaStream(channelId, mediaStream) {
    const ch = this.#channels[channelId]; if (!ch) return
    const src = Tone.context.createMediaStreamSource(mediaStream)
    const wrapper = new Tone.ToneAudioNode()
    src.connect(wrapper.input)
    wrapper.connect(ch.inputGain)
  }
}

export const audioEngine = AudioEngine.getInstance()
