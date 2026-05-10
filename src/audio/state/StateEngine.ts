/**
 * StateEngine.ts — Source of truth for all DSP state in ONA Live Studio.
 *
 * Headless-ready: zero React/Zustand dependencies.
 *
 * Responsibilities:
 *   - Hold canonical DSP snapshot (channels, buses, FX)
 *   - patchChannel / patchBuses / patchFx — incremental updates from DSP layer
 *   - subscribe(cb) — for PersistenceEngine, SceneManager, sync layer
 *   - applySnapshot(s) — full restore (scene recall or crash recovery)
 *   - getSnapshot() — pure JSON-serializable state
 *   - loadFromInitialState(mixerStoreFormat) — one-time init from Zustand snapshot
 *
 * Schema v1: { version, timestamp, channels[], buses{}, fx{} }
 *
 * Exposed in console as window.__ONA_STATE (merged with SceneManager/PersistenceEngine)
 */

import { EQ_BAND_DEFS } from '../../store/mixerStore.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EqBandState {
  id:   string
  gain: number
  freq: number
  q:    number
}

export interface ChannelState {
  id:          number
  name:        string
  color:       string
  volume:      number
  pan:         number
  muted:       boolean
  soloed:      boolean
  toMain:      boolean
  toSub:       boolean
  inputSource: string | null
  hpf:         { active: boolean; freq: number }
  gate:        { bypass: boolean; threshold: number; attack: number; release: number; range: number }
  compressor:  { bypass: boolean; threshold: number; ratio: number; attack: number; release: number; knee: number; makeupGain: number }
  eqBands:     EqBandState[]
  reverbSend:  number
  delaySend:   number
}

export interface BusState {
  mainVolume: number
  subVolume:  number
}

export interface FxState {
  reverb:   { active: boolean; decay: number; preDelay: number }
  delay:    { active: boolean; time: number; feedback: number }
  fxReturn: { volume: number; muted: boolean }
}

export interface EngineSnapshot {
  version:   number
  timestamp: number
  channels:  ChannelState[]
  buses:     BusState
  fx:        FxState
}

type SubscriberCb = (snapshot: Readonly<EngineSnapshot>, patch: Partial<EngineSnapshot>) => void

// ─── Default factories ────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1

function makeDefaultChannel(index: number): ChannelState {
  return {
    id:          index + 1,
    name:        `Canal ${index + 1}`,
    color:       '#f97316',
    volume:      75,
    pan:         0,
    muted:       false,
    soloed:      false,
    toMain:      true,
    toSub:       false,
    inputSource: null,
    hpf:         { active: false, freq: 80 },
    gate:        { bypass: true, threshold: -50, attack: 0.002, release: 0.15, range: -80 },
    compressor:  { bypass: false, threshold: -24, ratio: 4, attack: 0.003, release: 0.25, knee: 6, makeupGain: 0 },
    eqBands:     (EQ_BAND_DEFS as any[]).map(b => ({ id: b.id, gain: 0, freq: b.freqDefault, q: b.qDefault })),
    reverbSend:  0,
    delaySend:   0,
  }
}

function makeDefaultSnapshot(numChannels = 6): EngineSnapshot {
  return {
    version:   SCHEMA_VERSION,
    timestamp: Date.now(),
    channels:  Array.from({ length: numChannels }, (_, i) => makeDefaultChannel(i)),
    buses:     { mainVolume: 80, subVolume: 80 },
    fx: {
      reverb:   { active: false, decay: 2.5, preDelay: 0 },
      delay:    { active: false, time: 300, feedback: 30 },
      fxReturn: { volume: 80, muted: false },
    },
  }
}

// ─── StateEngine ──────────────────────────────────────────────────────────────

class StateEngine {
  private _snapshot    = makeDefaultSnapshot()
  private _subscribers = new Set<SubscriberCb>()

  // ── Read ──────────────────────────────────────────────────────────────────

  getSnapshot(): Readonly<EngineSnapshot> { return this._snapshot }

  getChannel(id: number): Readonly<ChannelState> | undefined {
    return this._snapshot.channels.find(c => c.id === id)
  }

  // ── Subscribe ─────────────────────────────────────────────────────────────

  subscribe(cb: SubscriberCb): () => void {
    this._subscribers.add(cb)
    return () => this._subscribers.delete(cb)
  }

  private _notify(patch: Partial<EngineSnapshot>): void {
    for (const cb of this._subscribers) {
      try { cb(this._snapshot, patch) } catch (_) {}
    }
  }

  // ── Incremental patches (called after each DSP operation) ─────────────────

  patchChannel(id: number, patch: Partial<ChannelState>): void {
    const idx = this._snapshot.channels.findIndex(c => c.id === id)
    if (idx < 0) return
    const channels = [...this._snapshot.channels]
    channels[idx]  = { ...channels[idx], ...patch }
    this._snapshot = { ...this._snapshot, channels, timestamp: Date.now() }
    this._notify({ channels })
  }

  patchBuses(patch: Partial<BusState>): void {
    const buses    = { ...this._snapshot.buses, ...patch }
    this._snapshot = { ...this._snapshot, buses, timestamp: Date.now() }
    this._notify({ buses })
  }

  patchFx(section: keyof FxState, patch: any): void {
    const fx       = { ...this._snapshot.fx, [section]: { ...this._snapshot.fx[section], ...patch } }
    this._snapshot = { ...this._snapshot, fx, timestamp: Date.now() }
    this._notify({ fx })
  }

  // ── Full restore ──────────────────────────────────────────────────────────

  applySnapshot(s: EngineSnapshot): void {
    this._snapshot = { ...s, version: SCHEMA_VERSION, timestamp: Date.now() }
    this._notify(this._snapshot)
  }

  /**
   * loadFromInitialState — convert mixerStore-format object to EngineSnapshot.
   * Called once during AudioEngineSingleton.initialize().
   */
  loadFromInitialState(s: any): void {
    if (!s || typeof s !== 'object') return
    const defChannels = this._snapshot.channels
    const channels: ChannelState[] = defChannels.map(def => {
      const src = (s.channels ?? []).find((c: any) => c.id === def.id)
      if (!src) return def
      return {
        ...def,
        name:        src.name        ?? def.name,
        color:       src.color       ?? def.color,
        volume:      src.volume      ?? def.volume,
        pan:         src.pan         ?? def.pan,
        muted:       src.muted       ?? def.muted,
        soloed:      src.soloed      ?? def.soloed,
        toMain:      src.toMain      ?? def.toMain,
        toSub:       src.toSub       ?? def.toSub,
        inputSource: src.inputSource ?? def.inputSource,
        hpf:         src.hpf        ? { ...def.hpf,        ...src.hpf        } : def.hpf,
        gate:        src.gate       ? { ...def.gate,       ...src.gate       } : def.gate,
        compressor:  src.compressor ? { ...def.compressor, ...src.compressor } : def.compressor,
        eqBands:     src.eqBands
          ? src.eqBands.map((b: any, i: number) => ({ ...def.eqBands[i], ...b }))
          : def.eqBands,
        reverbSend:  src.reverbSend ?? def.reverbSend,
        delaySend:   src.delaySend  ?? def.delaySend,
      }
    })
    this._snapshot = {
      version:   SCHEMA_VERSION,
      timestamp: Date.now(),
      channels,
      buses: {
        mainVolume: s.mainVolume ?? this._snapshot.buses.mainVolume,
        subVolume:  s.subVolume  ?? this._snapshot.buses.subVolume,
      },
      fx: s.fx ? { ...this._snapshot.fx, ...s.fx } : this._snapshot.fx,
    }
  }
}

export const stateEngine = new StateEngine()
export default stateEngine

// ── Console exposure (merged in SceneManager/PersistenceEngine) ───────────────
;(window as any).__ONA_STATE = {
  snapshot: () => stateEngine.getSnapshot(),
  channel:  (id: number) => stateEngine.getChannel(id),
}
