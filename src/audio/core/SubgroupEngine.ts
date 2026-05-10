/**
 * SubgroupEngine.ts — 4 subgroup buses con processing compartido.
 *
 * Cada subgroup:
 *   input (GainNode) — sumador de canales enrutados
 *   fader (GainNode) — nivel maestro del grupo
 *   toMain / toSub   — salidas a bus main/sub (GainNode)
 *   analyser         — metering peak
 *
 * Canales enrutan su preFaderTap → groupSendNode → subgroup.input.
 * Subgroup output puede ir a main, sub, o ambos.
 */

import * as Tone from 'tone'

function _toneCtx() { return Tone.getContext() as unknown as AudioContext }

export const NUM_GROUPS   = 4
const GROUP_LABELS        = ['Drums', 'Vocals', 'Music', 'FX Grp']
const ANALYSER_FFT_GRP    = 256

export interface SubgroupState {
  id:     number
  label:  string
  level:  number   // 0-100
  muted:  boolean
  toMain: boolean
  toSub:  boolean
}

interface SubgroupNodes {
  input:    GainNode
  fader:    GainNode
  toMain:   GainNode
  toSub:    GainNode
  analyser: AnalyserNode
  peakBuf:  Float32Array
  state:    SubgroupState
}

function grpVolToGain(vol: number): number { return vol <= 0 ? 0 : vol / 100 }

class SubgroupEngineImpl {
  private _groups = new Map<number, SubgroupNodes>()
  private _ctx:    AudioContext | null = null

  initialize(ctx: AudioContext, mainIn: GainNode, subIn: GainNode): void {
    this._ctx = ctx
    const nc  = _toneCtx()
    for (let i = 1; i <= NUM_GROUPS; i++) {
      const input    = nc.createGain()
      const fader    = nc.createGain()
      const tm       = nc.createGain()
      const ts       = nc.createGain()
      const analyser = nc.createAnalyser()
      analyser.fftSize               = ANALYSER_FFT_GRP
      analyser.smoothingTimeConstant = 0
      input.gain.value = 1
      fader.gain.value = 1
      tm.gain.value    = 1  // toMain on by default
      ts.gain.value    = 0  // toSub off by default
      input.connect(fader)
      fader.connect(analyser)
      fader.connect(tm)
      fader.connect(ts)
      tm.connect(mainIn)
      ts.connect(subIn)
      this._groups.set(i, {
        input, fader, toMain: tm, toSub: ts, analyser,
        peakBuf: new Float32Array(ANALYSER_FFT_GRP),
        state: { id: i, label: GROUP_LABELS[i - 1], level: 100, muted: false, toMain: true, toSub: false },
      })
    }
    console.log(`[GRP] ${NUM_GROUPS} subgroups listos`)
  }

  getGroup(id: number): { input: GainNode; fader: GainNode } | null {
    const g = this._groups.get(id)
    return g ? { input: g.input, fader: g.fader } : null
  }

  setLevel(id: number, level: number): void {
    const g = this._groups.get(id)
    if (!g || !this._ctx) return
    g.state.level = level
    if (!g.state.muted) g.fader.gain.setTargetAtTime(grpVolToGain(level), this._ctx.currentTime, 0.007)
  }

  setMuted(id: number, muted: boolean): void {
    const g = this._groups.get(id)
    if (!g || !this._ctx) return
    g.state.muted = muted
    g.fader.gain.setTargetAtTime(muted ? 0 : grpVolToGain(g.state.level), this._ctx.currentTime, 0.007)
  }

  setRouting(id: number, toMain: boolean, toSub: boolean): void {
    const g = this._groups.get(id)
    if (!g || !this._ctx) return
    const t = this._ctx.currentTime
    g.toMain.gain.setTargetAtTime(toMain ? 1 : 0, t, 0.007)
    g.toSub.gain.setTargetAtTime(toSub  ? 1 : 0, t, 0.007)
    g.state.toMain = toMain
    g.state.toSub  = toSub
  }

  setLabel(id: number, label: string): void {
    const g = this._groups.get(id)
    if (g) g.state.label = label
  }

  getMeterValue(id: number): number {
    const g = this._groups.get(id)
    if (!g) return -Infinity
    g.analyser.getFloatTimeDomainData(g.peakBuf)
    let peak = 0
    for (let i = 0; i < g.peakBuf.length; i++) {
      const a = Math.abs(g.peakBuf[i])
      if (a > peak) peak = a
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity
  }

  getState(id: number): SubgroupState | null { return this._groups.get(id)?.state ?? null }

  getAllStates(): SubgroupState[] {
    return Array.from(this._groups.values()).map(g => g.state)
  }

  destroy(): void {
    for (const g of this._groups.values()) {
      try { g.input.disconnect() }    catch (_) {}
      try { g.fader.disconnect() }    catch (_) {}
      try { g.toMain.disconnect() }   catch (_) {}
      try { g.toSub.disconnect() }    catch (_) {}
      try { g.analyser.disconnect() } catch (_) {}
    }
    this._groups.clear()
    this._ctx = null
  }
}

export const subgroupEngine = new SubgroupEngineImpl()
