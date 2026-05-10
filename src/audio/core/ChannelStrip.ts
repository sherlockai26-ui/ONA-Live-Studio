/**
 * ChannelStrip.ts — Cadena DSP interna de un canal de ONA Live Studio.
 *
 * Responsabilidades:
 *   - Crear y cablear todos los nodos internos en el constructor
 *   - NO hacer conexiones externas (reverb, buses) — eso lo hace DSPGraphEngine
 *   - Exponer nodos públicos de salida para registro en DSPGraphEngine
 *   - Exponer setters tipados para AudioBridge → AudioEngineSingleton
 *   - tickMeter() — leer metros y correr lógica de gate (llamado por MeteringEngine)
 *
 * Paso 4 — Tone.js Migration Phase 1:
 *   - MeterTap usa AnalyserNode nativo (si se pasa ctx)
 *   - upgradeGateToWorklet() — reemplaza el gate Tone.Gain por AudioWorkletNode
 *
 * Paso 5 — Tone.js Migration Phase 2:
 *   - Cuando ctx está disponible, todos los nodos simples usan WebAudio nativo:
 *     inputGain, hpf, makeupGain, eqNodes → GainNode / BiquadFilterNode
 *     panner → StereoPannerNode
 *     toMain, toSub, reverbSend, delaySend → GainNode
 *   - Setters usan AudioParam.setTargetAtTime (sin rampTo de Tone.js)
 *   - _c() helper para conexiones native → Tone (extrae .input)
 *   - Reducción de bundle: ~4 Tone.js nodes por canal = ~24 nodes para 6 canales
 *   - Se mantienen en Tone.js: gateNode (hasta upgrade), Tone.Compressor, Tone.Volume (fader)
 *
 * Cadena interna:
 *   inputGain → inputMeter (tap)
 *   inputGain → hpf → lpf → gateNode → compressor → makeupGain → eq[0..N] → preFaderTap
 *   preFaderTap → reverbSend (externamente a fx_reverb)
 *   preFaderTap → delaySend  (externamente a fx_delay)
 *   preFaderTap → [auxSendN] (externamente a AUX bus N — Paso 9)
 *   preFaderTap → [groupN]   (externamente a Subgroup N — Paso 9)
 *   preFaderTap → panner → fader → postFaderTap
 *   postFaderTap → outputMeter (tap)
 *   postFaderTap → toMain (externamente a bus_main)
 *   postFaderTap → toSub  (externamente a bus_sub)
 */

import * as Tone from 'tone'
import { EQ_BAND_DEFS } from '../../store/mixerStore.js'
import type { WorkletManager } from './WorkletManager'

interface GateParams {
  bypass:     boolean
  threshold:  number
  attack:     number
  release:    number
  range:      number
  hysteresis: number  // dB above threshold required to re-open (default 6)
  hold:       number  // seconds gate stays open after signal drops (default 0.1)
}

interface LpfParams {
  active: boolean
  freq:   number
}

export interface ChannelMeterData {
  inputDb:       number
  outputDb:      number
  gainReduction: number
  gateLevel:     number
}

const BIQUAD_MAP: Record<string, BiquadFilterType> = {
  lowshelf: 'lowshelf', peaking: 'peaking', highshelf: 'highshelf',
}

function dbToGain(db: number): number { return Math.pow(10, db / 20) }
function volToDb(v: number): number   { return v <= 0 ? -Infinity : 20 * Math.log10(v / 100) }

// ── Meter tap abstraction ─────────────────────────────────────────────────────

class MeterTap {
  private _analyser:    AnalyserNode | null
  private _toneMeter:   any
  private _analyserBuf: Float32Array

  readonly node: any

  constructor(ctx?: AudioContext) {
    if (ctx) {
      const a = (Tone.getContext() as any).createAnalyser()
      a.fftSize = 256
      a.smoothingTimeConstant = 0
      this._analyser    = a
      this._toneMeter   = null
      this._analyserBuf = new Float32Array(a.fftSize)
      this.node = a
    } else {
      this._analyser    = null
      this._toneMeter   = new Tone.Meter({ normalRange: false })
      this._analyserBuf = new Float32Array(0)
      this.node = this._toneMeter
    }
  }

  getValue(): number {
    if (this._analyser) {
      this._analyser.getFloatTimeDomainData(this._analyserBuf)
      const buf = this._analyserBuf
      const len = buf.length
      let peak = 0
      for (let i = 0; i < len; i++) {
        const s = buf[i]
        const a = s < 0 ? -s : s
        if (a > peak) peak = a
      }
      return peak > 0 ? 20 * Math.log10(peak) : -Infinity
    }
    const v = this._toneMeter?.getValue()
    return typeof v === 'number' ? v : (v?.[0] ?? -Infinity)
  }

  dispose(): void { this._toneMeter?.dispose?.() }
}

// ─── ChannelStrip ─────────────────────────────────────────────────────────────

export class ChannelStrip {
  readonly id: number

  // Nodos expuestos para DSPGraphEngine y HAL
  readonly inputGain:    any
  readonly toMain:       any
  readonly toSub:        any
  readonly reverbSend:   any
  readonly delaySend:    any
  // Tap nodes para routing Paso 9
  readonly preFaderTap:  any  // post-EQ, pre-fader — PFL + pre-fader aux sends
  readonly postFaderTap: any  // post-fader — AFL + post-fader aux sends

  // Nodos internos
  private readonly _inputMeterTap:  MeterTap
  private readonly _outputMeterTap: MeterTap
  private          _trim:           any   // GainNode (native) | Tone.Gain — input trim ±18dB
  private readonly _hpf:            any
  private          _lpf:            any   // LPF (Paso 8)
  private          _gateNode:       any
  private readonly _compressor:     any
  private readonly _makeupGain:     any
  private readonly _eqNodes:        any[]
  private readonly _panner:         any
  private readonly _fader:          any

  // Estado del gate (main-thread fallback)
  private _gate:      GateParams
  private _gateLevel: number = 1
  // Gate state machine (Paso 8): 0=CLOSED 1=OPENING 2=OPEN 3=HOLDING 4=CLOSING
  private _gateState:          number = 0
  private _holdTicksRemaining: number = 0
  private _gateHoldTicks:      number = 0

  // Paso 7: alphas pre-computadas para evitar Math.exp en el hot path RAF
  private _gateAttackAlpha:  number = 0
  private _gateReleaseAlpha: number = 0

  // AUX / Group / Solo routing (Paso 9)
  private _auxSends   = new Map<number, { node: GainNode; preFader: boolean; level: number; muted: boolean }>()
  private _groupSends = new Map<number, { node: GainNode }>()
  // FX bus sends (Paso 12)
  private _fxBusSends = new Map<number, { node: GainNode; preFader: boolean; level: number; muted: boolean }>()
  private _soloNode:  GainNode | null = null
  private _soloMode:  'pfl' | 'afl'  = 'pfl'

  // Flags
  private _hpfActive:        boolean
  private _lpfActive:        boolean = false
  private _compBypass:       boolean
  private _usingWorkletGate: boolean = false

  // Modo nativo (Paso 5 Phase 2) — true cuando ctx provisto
  private readonly _nativeMode: boolean
  private readonly _ctx: AudioContext | undefined

  constructor(id: number, s: any = {}, ctx?: AudioContext) {
    this.id        = id
    this._ctx      = ctx
    this._nativeMode = ctx !== undefined

    const comp = s.compressor ?? {}

    if (this._nativeMode) {
      // ── Paso 5: nodos nativos WebAudio ──────────────────────────────────────
      // Use Tone.getContext() for node creation so standardized-audio-context tracks them.
      // ctx (rawCtx) is kept in this._ctx only for AudioParam timing (currentTime).
      const c = Tone.getContext() as unknown as AudioContext

      const ig = c.createGain()
      ig.gain.value = 1
      this.inputGain = ig

      this._inputMeterTap = new MeterTap(ctx)

      const trim = c.createGain()
      trim.gain.value = s.trim !== undefined ? Math.pow(10, s.trim / 20) : 1
      this._trim = trim

      const hpf = c.createBiquadFilter()
      hpf.type = 'highpass'
      hpf.frequency.value = (s.hpf?.active && s.hpf?.freq) ? s.hpf.freq : 20
      hpf.Q.value = 0.7
      this._hpf = hpf

      const lpf = c.createBiquadFilter()
      lpf.type = 'lowpass'
      lpf.frequency.value = (s.lpf?.active && s.lpf?.freq) ? s.lpf.freq : 20000
      lpf.Q.value = 0.7
      this._lpf = lpf

      this._gateNode = c.createGain()  // replaced by worklet in upgradeGateToWorklet()

      // Paso 7: DynamicsCompressorNode nativo en lugar de Tone.Compressor
      const dyn = c.createDynamicsCompressor()
      dyn.threshold.value = comp.threshold ?? -24
      dyn.ratio.value     = comp.ratio     ?? 4
      dyn.attack.value    = comp.attack    ?? 0.003
      dyn.release.value   = comp.release   ?? 0.25
      dyn.knee.value      = comp.knee      ?? 6
      this._compressor = dyn

      const mg = c.createGain()
      mg.gain.value = dbToGain(comp.makeupGain ?? 0)
      this._makeupGain = mg

      this._eqNodes = (EQ_BAND_DEFS as any[]).map((def: any) => {
        const band = s.eqBands?.find((b: any) => b.id === def.id)
        const f = c.createBiquadFilter()
        f.type = BIQUAD_MAP[def.type] ?? 'peaking'
        f.frequency.value = band?.freq ?? def.freqDefault
        f.Q.value         = band?.q    ?? def.qDefault
        f.gain.value      = band?.gain ?? 0
        return f
      })

      const pft = c.createGain()
      pft.gain.value = 1
      this.preFaderTap = pft

      const poft = c.createGain()
      poft.gain.value = 1
      this.postFaderTap = poft

      const rs = c.createGain()
      rs.gain.value = (s.reverbSend ?? 0) / 100
      this.reverbSend = rs

      const ds = c.createGain()
      ds.gain.value = (s.delaySend ?? 0) / 100
      this.delaySend = ds

      const pan = c.createStereoPanner()
      pan.pan.value = s.pan ?? 0
      this._panner = pan

      // Paso 7: GainNode nativo en lugar de Tone.Volume
      const fader = c.createGain()
      fader.gain.value = s.muted ? 0 : dbToGain(volToDb(s.volume ?? 75))
      this._fader = fader

      this._outputMeterTap = new MeterTap(ctx)

      const tm = c.createGain()
      tm.gain.value = s.toMain !== false ? 1 : 0
      this.toMain = tm

      const ts = c.createGain()
      ts.gain.value = s.toSub ? 1 : 0
      this.toSub = ts

    } else {
      // ── Fallback: Tone.js (sin ctx) ──────────────────────────────────────────
      this.inputGain = new Tone.Gain(1)
      this._inputMeterTap = new MeterTap()
      this._hpf = new Tone.Filter({
        type: 'highpass',
        frequency: (s.hpf?.active && s.hpf?.freq) ? s.hpf.freq : 20,
        Q: 0.7, rolloff: -12,
      })
      this._lpf = new Tone.Filter({
        type: 'lowpass',
        frequency: (s.lpf?.active && s.lpf?.freq) ? s.lpf.freq : 20000,
        Q: 0.7, rolloff: -12,
      })
      this._gateNode = new Tone.Gain(1)
      this._compressor = new Tone.Compressor({
        threshold: comp.threshold ?? -24,
        ratio:     comp.ratio     ?? 4,
        attack:    comp.attack    ?? 0.003,
        release:   comp.release   ?? 0.25,
        knee:      comp.knee      ?? 6,
      })
      this._makeupGain = new Tone.Gain(dbToGain(comp.makeupGain ?? 0))
      this._eqNodes = (EQ_BAND_DEFS as any[]).map((def: any) => {
        const band = s.eqBands?.find((b: any) => b.id === def.id)
        return new Tone.BiquadFilter({
          type:      (BIQUAD_MAP[def.type] ?? 'peaking') as BiquadFilterType,
          frequency: band?.freq ?? def.freqDefault,
          Q:         band?.q    ?? def.qDefault,
          gain:      band?.gain ?? 0,
        })
      })
      this.preFaderTap  = new Tone.Gain(1)
      this.postFaderTap = new Tone.Gain(1)
      this.reverbSend = new Tone.Gain((s.reverbSend ?? 0) / 100)
      this.delaySend  = new Tone.Gain((s.delaySend  ?? 0) / 100)
      this._panner    = new Tone.Panner(s.pan ?? 0)
      this._fader     = new Tone.Volume(volToDb(s.volume ?? 75))
      this._outputMeterTap = new MeterTap()
      this.toMain = new Tone.Gain(s.toMain !== false ? 1 : 0)
      this.toSub  = new Tone.Gain(s.toSub  ? 1 : 0)
    }

    this._gate = {
      bypass:     s.gate?.bypass     ?? true,
      threshold:  s.gate?.threshold  ?? -50,
      attack:     s.gate?.attack     ?? 0.002,
      release:    s.gate?.release    ?? 0.15,
      range:      s.gate?.range      ?? -80,
      hysteresis: s.gate?.hysteresis ?? 6,
      hold:       s.gate?.hold       ?? 0.1,
    }
    this._gateHoldTicks = Math.round((s.gate?.hold ?? 0.1) * 25)
    this._hpfActive  = s.hpf?.active        ?? false
    this._lpfActive  = s.lpf?.active        ?? false
    this._compBypass = s.compressor?.bypass ?? false

    // Paso 7: pre-computar alphas del gate (evita Math.exp en hot path)
    this._computeGateAlphas()

    this._wireSelf()

    // Tone.Volume fallback muted — nativeMode ya lo maneja en la declaración de fader
    if (s.muted && !this._nativeMode) this._fader.volume.value = -Infinity
  }

  // ── Node connection helper ────────────────────────────────────────────────────
  // Handles native AudioNode → Tone wrapper connections (extracts .input).

  private static _c(src: any, dst: any): void {
    if (src instanceof AudioNode) {
      const to = dst instanceof AudioNode ? dst : ((dst as any).input ?? dst)
      src.connect(to)
    } else {
      src.connect(dst)
    }
  }

  // ── Gate alpha pre-computation (Paso 7) ──────────────────────────────────────
  // Evita Math.exp() en tickMeter() que corre en el RAF loop a 25fps.

  private _computeGateAlphas(): void {
    this._gateAttackAlpha  = Math.exp(-1 / Math.max(this._gate.attack  * 25, 0.5))
    this._gateReleaseAlpha = Math.exp(-1 / Math.max(this._gate.release * 25, 0.5))
  }

  // ── AudioParam ramp helper (Phase 2 native nodes) ─────────────────────────────

  private _ramp(param: AudioParam, target: number, ms = 20): void {
    if (this._ctx) {
      param.setTargetAtTime(target, this._ctx.currentTime, ms / 3000)
    } else {
      param.value = target
    }
  }

  // ── Internal wiring ───────────────────────────────────────────────────────────

  private _wireSelf(): void {
    const c = ChannelStrip._c

    // Tap de entrada
    c(this.inputGain, this._inputMeterTap.node)

    // Cadena principal (inputGain → trim → hpf → ...)
    c(this.inputGain, this._trim)
    c(this._trim,     this._hpf)
    c(this._hpf,        this._lpf)
    c(this._lpf,        this._gateNode)
    c(this._gateNode,   this._compressor)
    c(this._compressor, this._makeupGain)
    c(this._makeupGain, this._eqNodes[0])
    for (let i = 0; i < this._eqNodes.length - 1; i++) {
      c(this._eqNodes[i], this._eqNodes[i + 1])
    }
    const eqLast = this._eqNodes[this._eqNodes.length - 1]

    // preFaderTap — fan-out point post-EQ, pre-fader (PFL + pre-fader sends)
    c(eqLast,            this.preFaderTap)
    c(this.preFaderTap,  this.reverbSend)
    c(this.preFaderTap,  this.delaySend)
    c(this.preFaderTap,  this._panner)
    // postFaderTap — fan-out point post-fader (AFL + post-fader sends + routing)
    c(this._panner,      this._fader)
    c(this._fader,       this.postFaderTap)
    c(this.postFaderTap, this._outputMeterTap.node)
    c(this.postFaderTap, this.toMain)
    c(this.postFaderTap, this.toSub)
  }

  // ── Paso 4/5 — Gate Worklet Upgrade ──────────────────────────────────────────

  upgradeGateToWorklet(workletMgr: WorkletManager): boolean {
    if (this._usingWorkletGate || !this._ctx) return false

    const gateWorklet = workletMgr.createGateNode(this.id)
    if (!gateWorklet) return false

    try {
      try { this._hpf.disconnect(this._gateNode) } catch (_) {}
      try { (this._gateNode as any).disconnect?.() } catch (_) {}
      try { (this._gateNode as any).dispose?.()    } catch (_) {}

      // HPF is native BiquadFilterNode — direct connect ✓
      this._hpf.connect(gateWorklet)

      const compInput = (this._compressor as any).input ?? this._compressor
      gateWorklet.connect(compInput)

      const gParams = gateWorklet.parameters
      const t       = this._ctx.currentTime
      gParams.get('threshold')?.setValueAtTime(this._gate.threshold, t)
      gParams.get('attack')?.setValueAtTime(this._gate.attack, t)
      gParams.get('release')?.setValueAtTime(this._gate.release, t)
      gParams.get('range')?.setValueAtTime(this._gate.range, t)
      gParams.get('bypass')?.setValueAtTime(this._gate.bypass ? 1 : 0, t)

      this._gateNode = gateWorklet
      this._usingWorkletGate = true
      console.log(`[STRIP ${this.id}] Gate → AudioWorklet ✓`)
      return true
    } catch (err) {
      console.error(`[STRIP ${this.id}] upgradeGateToWorklet error:`, err)
      return false
    }
  }

  isUsingWorkletGate(): boolean { return this._usingWorkletGate }

  // ── Setters ───────────────────────────────────────────────────────────────────

  setVolume(vol: number, muted = false): void {
    if (this._nativeMode) {
      // Paso 7: fader es GainNode — linear gain
      this._ramp((this._fader as GainNode).gain, muted ? 0 : dbToGain(volToDb(vol)))
    } else {
      this._fader.volume.rampTo(muted ? -Infinity : volToDb(vol), 0.02)
    }
  }

  setPan(pan: number): void {
    const clamped = Math.max(-1, Math.min(1, pan))
    if (this._nativeMode) {
      this._ramp((this._panner as StereoPannerNode).pan, clamped)
    } else {
      this._panner.pan.rampTo(clamped, 0.02)
    }
  }

  setRouting(toMain: boolean, toSub: boolean): void {
    if (this._nativeMode) {
      this._ramp((this.toMain as GainNode).gain, toMain ? 1 : 0)
      this._ramp((this.toSub  as GainNode).gain, toSub  ? 1 : 0)
    } else {
      (this.toMain as any).gain.rampTo(toMain ? 1 : 0, 0.02)
      (this.toSub  as any).gain.rampTo(toSub  ? 1 : 0, 0.02)
    }
  }

  setHpf(params: { active?: boolean; freq?: number }): void {
    if (params.active !== undefined) this._hpfActive = params.active
    const target = this._hpfActive ? (params.freq ?? (this._nativeMode
      ? (this._hpf as BiquadFilterNode).frequency.value
      : this._hpf.frequency.value)) : 20
    if (this._nativeMode) {
      this._ramp((this._hpf as BiquadFilterNode).frequency, target)
    } else {
      this._hpf.frequency.rampTo(target, 0.02)
    }
  }

  setLpf(params: LpfParams): void {
    if (params.active !== undefined) this._lpfActive = params.active
    const target = this._lpfActive ? (params.freq ?? (this._nativeMode
      ? (this._lpf as BiquadFilterNode).frequency.value
      : this._lpf.frequency.value)) : 20000
    if (this._nativeMode) {
      this._ramp((this._lpf as BiquadFilterNode).frequency, target)
    } else {
      this._lpf.frequency.rampTo(target, 0.02)
    }
  }

  setGate(params: Partial<GateParams>): void {
    Object.assign(this._gate, params)
    if (params.attack !== undefined || params.release !== undefined) this._computeGateAlphas()
    if (params.hold !== undefined) this._gateHoldTicks = Math.round(params.hold * 25)

    if (this._usingWorkletGate && this._ctx) {
      const p = (this._gateNode as AudioWorkletNode).parameters
      const t = this._ctx.currentTime
      if (params.threshold !== undefined) p.get('threshold')?.setValueAtTime(params.threshold, t)
      if (params.attack    !== undefined) p.get('attack')?.setValueAtTime(params.attack,    t)
      if (params.release   !== undefined) p.get('release')?.setValueAtTime(params.release,  t)
      if (params.range     !== undefined) p.get('range')?.setValueAtTime(params.range,      t)
      if (params.bypass    !== undefined) p.get('bypass')?.setValueAtTime(params.bypass ? 1 : 0, t)
    } else if (params.bypass === true) {
      this._gateLevel = 1
      ;(this._gateNode as any).gain.value = 1
    }
  }

  setCompressor(params: any): void {
    if (this._nativeMode) {
      // Paso 7: DynamicsCompressorNode — native AudioParams
      const comp = this._compressor as DynamicsCompressorNode
      const { threshold, ratio, attack, release, knee, makeupGain, bypass } = params
      if (bypass !== undefined) {
        this._compBypass = bypass
        this._ramp(comp.ratio,     bypass ? 1 : (ratio     ?? comp.ratio.value))
        this._ramp(comp.threshold, bypass ? 0 : (threshold ?? comp.threshold.value))
        return
      }
      if (threshold  !== undefined) this._ramp(comp.threshold, threshold)
      if (ratio      !== undefined) this._ramp(comp.ratio,     Math.max(1, ratio))
      if (attack     !== undefined) this._ramp(comp.attack,    attack)
      if (release    !== undefined) this._ramp(comp.release,   release)
      if (knee       !== undefined) this._ramp(comp.knee,      knee)
      if (makeupGain !== undefined) this._ramp((this._makeupGain as GainNode).gain, dbToGain(makeupGain))
    } else {
      const { threshold, ratio, attack, release, knee, makeupGain, bypass } = params
      if (bypass !== undefined) {
        this._compBypass = bypass
        this._compressor.ratio.rampTo(bypass ? 1 : (ratio ?? this._compressor.ratio.value), 0.05)
        this._compressor.threshold.rampTo(bypass ? 0 : (threshold ?? this._compressor.threshold.value), 0.05)
        return
      }
      if (threshold  !== undefined) this._compressor.threshold.rampTo(threshold, 0.02)
      if (ratio      !== undefined) this._compressor.ratio.rampTo(Math.max(1, ratio), 0.02)
      if (attack     !== undefined) this._compressor.attack.rampTo(attack, 0.02)
      if (release    !== undefined) this._compressor.release.rampTo(release, 0.02)
      if (knee       !== undefined) this._compressor.knee.rampTo(knee, 0.02)
      if (makeupGain !== undefined) (this._makeupGain as any).gain.rampTo(dbToGain(makeupGain), 0.02)
    }
  }

  setEqBand(bandIndex: number, params: { gain?: number; freq?: number; q?: number }): void {
    const n = this._eqNodes[bandIndex]; if (!n) return
    if (this._nativeMode) {
      const node = n as BiquadFilterNode
      if (params.gain !== undefined) this._ramp(node.gain,      params.gain)
      if (params.freq !== undefined) this._ramp(node.frequency, params.freq)
      if (params.q    !== undefined) this._ramp(node.Q,         params.q)
    } else {
      if (params.gain !== undefined) n.gain.value = params.gain
      if (params.freq !== undefined) n.frequency.rampTo(params.freq, 0.02)
      if (params.q    !== undefined) n.Q.rampTo(params.q, 0.02)
    }
  }

  setReverbSend(v: number): void {
    const t = Math.max(0, v / 100)
    if (this._nativeMode) {
      this._ramp((this.reverbSend as GainNode).gain, t)
    } else {
      (this.reverbSend as any).gain.rampTo(t, 0.02)
    }
  }

  setDelaySend(v: number): void {
    const t = Math.max(0, v / 100)
    if (this._nativeMode) {
      this._ramp((this.delaySend as GainNode).gain, t)
    } else {
      (this.delaySend as any).gain.rampTo(t, 0.02)
    }
  }

  /** setTrim — input trim ±18dB (antes del HPF, post inputGain). */
  setTrim(db: number): void {
    const clamped  = Math.max(-18, Math.min(18, db))
    const linGain  = Math.pow(10, clamped / 20)
    if (this._nativeMode) {
      this._ramp((this._trim as GainNode).gain, linGain)
    } else {
      (this._trim as any).gain.rampTo(linGain, 0.02)
    }
  }

  // ── Metering — llamado por MeteringEngine en el RAF loop ──────────────────────
  // HOT PATH: no allocations, no closures, no logging

  tickMeter(): ChannelMeterData {
    const inputDb       = this._inputMeterTap.getValue()
    const outputDb      = this._outputMeterTap.getValue()
    const gainReduction = this._compressor.reduction ?? 0

    if (!this._usingWorkletGate && !this._gate.bypass) {
      this._tickGateMachine(inputDb)
    }

    return { inputDb, outputDb, gainReduction, gateLevel: this._gateLevel }
  }

  // Gate state machine (Paso 8) — hysteresis + hold timer
  // HOT PATH: no allocations, no logging
  private _tickGateMachine(inputDb: number): void {
    const g          = this._gate
    const openThresh = g.threshold + g.hysteresis  // open threshold (higher)
    const rangeGain  = dbToGain(g.range)
    let   lvl        = this._gateLevel

    switch (this._gateState) {
      case 0: // CLOSED — wait for signal above open threshold
        lvl = this._gateReleaseAlpha * lvl + (1 - this._gateReleaseAlpha) * rangeGain
        if (inputDb > openThresh) this._gateState = 1  // → OPENING
        break

      case 1: // OPENING — attack ramp toward 1.0
        lvl = this._gateAttackAlpha * lvl + (1 - this._gateAttackAlpha) * 1.0
        if (lvl > 0.99) { this._gateState = 2 }               // → OPEN
        else if (inputDb < g.threshold) { this._gateState = 4 } // signal gone → CLOSING
        break

      case 2: // OPEN — hold at unity, monitor for close threshold
        lvl = this._gateAttackAlpha * lvl + (1 - this._gateAttackAlpha) * 1.0
        if (inputDb < g.threshold) {
          this._gateState          = 3
          this._holdTicksRemaining = this._gateHoldTicks  // → HOLDING
        }
        break

      case 3: // HOLDING — gate stays open, countdown
        lvl = this._gateAttackAlpha * lvl + (1 - this._gateAttackAlpha) * 1.0
        if (inputDb > openThresh) {
          this._gateState = 2  // re-trigger → OPEN
        } else {
          this._holdTicksRemaining--
          if (this._holdTicksRemaining <= 0) this._gateState = 4  // → CLOSING
        }
        break

      case 4: // CLOSING — release ramp toward rangeGain
        lvl = this._gateReleaseAlpha * lvl + (1 - this._gateReleaseAlpha) * rangeGain
        if (inputDb > openThresh) {
          this._gateState = 1  // re-trigger → OPENING
        } else if (lvl <= rangeGain + 1e-4) {
          this._gateState = 0  // → CLOSED
        }
        break
    }

    this._gateLevel = lvl
    ;(this._gateNode as any).gain.value = lvl
  }

  getGainReduction(): number { return this._compressor.reduction ?? 0 }
  getGateLevel():     number { return this._gateLevel }

  // ── AUX / Group / Solo routing (Paso 9) ──────────────────────────────────────

  /**
   * setAuxSend — conectar/actualizar envío a un bus AUX.
   * Primera llamada: crea el GainNode y cablea preFaderTap/postFaderTap → auxInput.
   * Llamadas posteriores: actualiza nivel/mute/preFader.
   * auxInput = auxBusEngine.getBus(auxId).input
   */
  setAuxSend(
    auxId:    number,
    auxInput: GainNode,
    params:   { level?: number; preFader?: boolean; muted?: boolean },
  ): void {
    if (!this._ctx) return
    let send = this._auxSends.get(auxId)
    const newPreFader = params.preFader ?? send?.preFader ?? true
    const newLevel    = params.level    ?? send?.level    ?? 0
    const newMuted    = params.muted    ?? send?.muted    ?? false

    if (!send) {
      const node = (Tone.getContext() as any).createGain()
      node.gain.value = newMuted ? 0 : newLevel / 100
      ;(newPreFader ? this.preFaderTap as GainNode : this.postFaderTap as GainNode).connect(node)
      node.connect(auxInput)
      send = { node, preFader: newPreFader, level: newLevel, muted: newMuted }
      this._auxSends.set(auxId, send)
    } else {
      // Toggle pre/post fader tap
      if (params.preFader !== undefined && params.preFader !== send.preFader) {
        const oldTap = send.preFader ? (this.preFaderTap as GainNode) : (this.postFaderTap as GainNode)
        const newTap = newPreFader   ? (this.preFaderTap as GainNode) : (this.postFaderTap as GainNode)
        try { oldTap.disconnect(send.node) } catch (_) {}
        newTap.connect(send.node)
        send.preFader = newPreFader
      }
      send.level = newLevel
      send.muted = newMuted
      send.node.gain.setTargetAtTime(newMuted ? 0 : newLevel / 100, this._ctx.currentTime, 0.007)
    }
  }

  /**
   * setFxBusSend — conectar/actualizar envío a un bus FX (Paso 12).
   * Mismo patrón lazy que setAuxSend().
   * busInput = fxBusEngine.getInput(busId)
   */
  setFxBusSend(
    busId:    number,
    busInput: GainNode,
    params:   { level?: number; preFader?: boolean; muted?: boolean },
  ): void {
    if (!this._ctx) return
    let send = this._fxBusSends.get(busId)
    const newPreFader = params.preFader ?? send?.preFader ?? true
    const newLevel    = params.level    ?? send?.level    ?? 0
    const newMuted    = params.muted    ?? send?.muted    ?? false

    if (!send) {
      const node = (Tone.getContext() as any).createGain()
      node.gain.value = newMuted ? 0 : newLevel / 100
      ;(newPreFader ? this.preFaderTap as GainNode : this.postFaderTap as GainNode).connect(node)
      node.connect(busInput)
      send = { node, preFader: newPreFader, level: newLevel, muted: newMuted }
      this._fxBusSends.set(busId, send)
    } else {
      if (params.preFader !== undefined && params.preFader !== send.preFader) {
        const oldTap = send.preFader ? (this.preFaderTap as GainNode) : (this.postFaderTap as GainNode)
        const newTap = newPreFader   ? (this.preFaderTap as GainNode) : (this.postFaderTap as GainNode)
        try { oldTap.disconnect(send.node) } catch (_) {}
        newTap.connect(send.node)
        send.preFader = newPreFader
      }
      send.level = newLevel
      send.muted = newMuted
      send.node.gain.setTargetAtTime(newMuted ? 0 : newLevel / 100, this._ctx.currentTime, 0.007)
    }
  }

  /**
   * setGroupSend — enrutar/desconectar canal a un subgroup.
   * Lazy: crea el GainNode solo si active=true.
   * groupInput = subgroupEngine.getGroup(groupId).input
   */
  setGroupSend(groupId: number, groupInput: GainNode, active: boolean): void {
    if (!this._ctx) return
    let send = this._groupSends.get(groupId)
    if (!send && active) {
      const node = (Tone.getContext() as any).createGain()
      node.gain.value = 1
      ;(this.preFaderTap as GainNode).connect(node)
      node.connect(groupInput)
      send = { node }
      this._groupSends.set(groupId, send)
    } else if (send) {
      send.node.gain.setTargetAtTime(active ? 1 : 0, this._ctx.currentTime, 0.007)
    }
  }

  /**
   * setSolo — enrutar canal al cue bus (PFL o AFL).
   * Solo NO corta el main mix — routing adicional al cue bus.
   * cueInput = cueBus.input
   */
  setSolo(soloed: boolean, cueInput: GainNode | null, mode: 'pfl' | 'afl'): void {
    if (!this._ctx) return
    if (soloed && cueInput) {
      if (!this._soloNode) {
        this._soloNode = (Tone.getContext() as any).createGain()
        this._soloNode.gain.value = 1
      } else {
        try { this._soloNode.disconnect() } catch (_) {}
      }
      const tap = mode === 'pfl' ? (this.preFaderTap as GainNode) : (this.postFaderTap as GainNode)
      tap.connect(this._soloNode)
      this._soloNode.connect(cueInput)
      this._soloMode = mode
    } else if (this._soloNode) {
      try { this._soloNode.disconnect() } catch (_) {}
      this._soloNode = null
    }
  }

  // ── Dispose ───────────────────────────────────────────────────────────────────

  dispose(): void {
    // Dispose aux/group/solo/fxbus send nodes
    if (this._soloNode) { try { this._soloNode.disconnect() } catch (_) {} }
    for (const s of this._auxSends.values())    { try { s.node.disconnect() } catch (_) {} }
    for (const s of this._groupSends.values())  { try { s.node.disconnect() } catch (_) {} }
    for (const s of this._fxBusSends.values())  { try { s.node.disconnect() } catch (_) {} }

    const nodes = [
      this.inputGain, this._trim, this._hpf, this._lpf, this._gateNode,
      this._compressor, this._makeupGain,
      ...this._eqNodes,
      this.preFaderTap, this.reverbSend, this.delaySend, this._panner,
      this._fader, this.postFaderTap, this.toMain, this.toSub,
    ]
    for (const n of nodes) {
      try { n.disconnect() } catch (_) {}
      try { (n as any).dispose?.()  } catch (_) {}
    }
    this._inputMeterTap.dispose()
    this._outputMeterTap.dispose()
  }
}
