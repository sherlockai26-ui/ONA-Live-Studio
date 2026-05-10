/**
 * MidiMapper.ts — Sistema de mapping MIDI → acciones DSP.
 *
 * Soporta:
 *   CC  → fader, mute, aux send, EQ band, FX bus send
 *   Note On/Off → mute toggle, solo toggle, scene recall, transport
 *   Pitch Bend → master volume, channel volume
 *   Encoder (relative CC) → EQ gain/freq trim, fader trim
 *
 * Persistencia:
 *   serialize() / deserialize() — JSON para localStorage/proyecto
 *   Perfiles de controlador: guardar/cargar sets de mappings por nombre
 *
 * Transformaciones de valor:
 *   cc2vol(v)    : 0–127 → 0–100 (lineal)
 *   cc2pan(v)    : 0–127 → -1…+1 (centro=64)
 *   cc2toggle(v) : velocity/value > 0 → toggle boolean
 *   cc2rel(v)    : encoder relativo 40H mode (64=no move, >64=CW, <64=CCW)
 */

import type { MidiMessage } from './MidiEngine'

// ── Action types ──────────────────────────────────────────────────────────────

export type ControlAction =
  | { type: 'channelVolume';  channelId: number; value: number }
  | { type: 'channelMute';    channelId: number; muted: boolean }
  | { type: 'channelSolo';    channelId: number; soloed: boolean; mode: 'pfl' | 'afl' }
  | { type: 'channelPan';     channelId: number; value: number }
  | { type: 'channelEqBand';  channelId: number; bandIndex: number; param: 'gain' | 'freq' | 'q'; value: number }
  | { type: 'channelAuxSend'; channelId: number; auxId: number; value: number }
  | { type: 'channelFxSend';  channelId: number; busId: number; value: number }
  | { type: 'mainVolume';     value: number }
  | { type: 'subVolume';      value: number }
  | { type: 'fxBusActive';   busId: number; active: boolean }
  | { type: 'sceneRecall';   sceneName: string }
  | { type: 'transport';     action: 'play' | 'stop' | 'pause' }
  | { type: 'clearSolo' }

// ── Mapping source ─────────────────────────────────────────────────────────────

export type MappingSourceType = 'cc' | 'noteon' | 'noteoff' | 'pitchbend'

export interface MappingSource {
  type:     MappingSourceType
  channel:  number    // MIDI channel 1–16, 0 = any
  number:   number    // CC number, note number, or 0 for pitchbend
}

// ── Mapping target ─────────────────────────────────────────────────────────────

export type MappingMode =
  | 'absolute'    // CC value 0–127 mapped linearly (default)
  | 'toggle'      // any non-zero triggers toggle (for buttons)
  | 'relative'    // encoder relative mode: 64=center, <64 dec, >64 inc
  | 'note_toggle' // Note On toggles, Note Off ignored

export interface MappingTarget {
  action:     ControlAction['type']
  channelId?: number
  auxId?:     number
  busId?:     number
  bandIndex?: number
  param?:     'gain' | 'freq' | 'q'
  mode?:      'pfl' | 'afl'
  sceneName?: string
  transport?: 'play' | 'stop' | 'pause'
}

export interface MappingRule {
  id:     string
  label?: string
  source: MappingSource
  target: MappingTarget
  mode:   MappingMode
  relativeStep?: number   // for relative mode: units per encoder step (default 2)
}

// ── Value transforms ──────────────────────────────────────────────────────────

function cc2vol(v: number): number  { return Math.round(v / 127 * 100) }
function cc2pan(v: number): number  { return +((v - 64) / 64).toFixed(3) }
function pb2vol(v: number): number  { return Math.round((v + 8192) / 16383 * 100) }

// Encoder relative: 40H mode (64=center). Returns delta: negative=CCW, positive=CW
function cc2rel(v: number, step: number): number {
  if (v > 64) return +(((v - 64) * step)).toFixed(1)
  if (v < 64) return -(((64 - v) * step)).toFixed(1)
  return 0
}

// ── Toggle state tracking ─────────────────────────────────────────────────────

// Persist toggle states so we can flip them on each trigger
const _toggleStates = new Map<string, boolean>()

function getToggleKey(rule: MappingRule): string {
  return `${rule.id}_toggle`
}

// ── Mapper implementation ─────────────────────────────────────────────────────

class MidiMapperImpl {
  private _rules = new Map<string, MappingRule>()
  private _byKey = new Map<string, MappingRule[]>()  // "type_ch_num" → rules

  private static _key(s: MappingSource): string {
    return `${s.type}_${s.channel}_${s.number}`
  }

  // ── Rule management ───────────────────────────────────────────────────────────

  addRule(rule: MappingRule): void {
    this._rules.set(rule.id, rule)
    const k = MidiMapperImpl._key(rule.source)
    if (!this._byKey.has(k)) this._byKey.set(k, [])
    const arr = this._byKey.get(k)!
    const idx = arr.findIndex(r => r.id === rule.id)
    if (idx >= 0) arr[idx] = rule
    else          arr.push(rule)
  }

  removeRule(id: string): void {
    const rule = this._rules.get(id)
    if (!rule) return
    this._rules.delete(id)
    const k   = MidiMapperImpl._key(rule.source)
    const arr = this._byKey.get(k)
    if (arr) {
      const i = arr.findIndex(r => r.id === id)
      if (i >= 0) arr.splice(i, 1)
      if (arr.length === 0) this._byKey.delete(k)
    }
    _toggleStates.delete(getToggleKey(rule))
  }

  clearRules(): void { this._rules.clear(); this._byKey.clear(); _toggleStates.clear() }

  getRules(): MappingRule[] { return Array.from(this._rules.values()) }

  // ── Message processing ────────────────────────────────────────────────────────

  processMessage(msg: MidiMessage): ControlAction[] {
    const actions: ControlAction[] = []
    // Try exact channel match, then any-channel (ch=0)
    const keys = [
      MidiMapperImpl._key({ type: msg.type as MappingSourceType, channel: msg.channel, number: this._msgNumber(msg) }),
      MidiMapperImpl._key({ type: msg.type as MappingSourceType, channel: 0, number: this._msgNumber(msg) }),
    ]
    for (const key of keys) {
      const rules = this._byKey.get(key) ?? []
      for (const rule of rules) {
        const action = this._buildAction(rule, msg)
        if (action) actions.push(action)
      }
    }
    return actions
  }

  private _msgNumber(msg: MidiMessage): number {
    if (msg.type === 'cc')        return msg.cc ?? 0
    if (msg.type === 'noteon' || msg.type === 'noteoff') return msg.note ?? 0
    return 0  // pitchbend, program, etc.
  }

  private _buildAction(rule: MappingRule, msg: MidiMessage): ControlAction | null {
    const { target, mode } = rule
    const rawValue = msg.value ?? msg.velocity ?? 0

    switch (target.action) {
      case 'channelVolume': {
        const vol = mode === 'relative'
          ? null  // handled separately (stateful)
          : mode === 'absolute' ? cc2vol(rawValue)
          : msg.type === 'pitchbend' ? pb2vol(rawValue) : cc2vol(rawValue)
        if (vol === null) return null
        return { type: 'channelVolume', channelId: target.channelId!, value: vol }
      }
      case 'channelMute': {
        const key  = getToggleKey(rule)
        const prev = _toggleStates.get(key) ?? false
        if (mode === 'toggle' || mode === 'note_toggle') {
          if (rawValue === 0 && mode === 'note_toggle') return null  // ignore Note Off
          const muted = !prev
          _toggleStates.set(key, muted)
          return { type: 'channelMute', channelId: target.channelId!, muted }
        }
        return { type: 'channelMute', channelId: target.channelId!, muted: rawValue > 0 }
      }
      case 'channelSolo': {
        const key  = getToggleKey(rule)
        const prev = _toggleStates.get(key) ?? false
        if (rawValue === 0 && mode === 'note_toggle') return null
        const soloed = !prev
        _toggleStates.set(key, soloed)
        return { type: 'channelSolo', channelId: target.channelId!, soloed, mode: target.mode ?? 'pfl' }
      }
      case 'channelPan':
        return { type: 'channelPan', channelId: target.channelId!, value: cc2pan(rawValue) }
      case 'channelAuxSend':
        return { type: 'channelAuxSend', channelId: target.channelId!, auxId: target.auxId!, value: cc2vol(rawValue) }
      case 'channelFxSend':
        return { type: 'channelFxSend', channelId: target.channelId!, busId: target.busId!, value: cc2vol(rawValue) }
      case 'mainVolume':
        return { type: 'mainVolume', value: msg.type === 'pitchbend' ? pb2vol(rawValue) : cc2vol(rawValue) }
      case 'subVolume':
        return { type: 'subVolume', value: cc2vol(rawValue) }
      case 'fxBusActive': {
        const key  = getToggleKey(rule)
        const prev = _toggleStates.get(key) ?? false
        if (rawValue === 0 && mode === 'note_toggle') return null
        const active = !prev
        _toggleStates.set(key, active)
        return { type: 'fxBusActive', busId: target.busId!, active }
      }
      case 'sceneRecall':
        if (rawValue === 0) return null
        return { type: 'sceneRecall', sceneName: target.sceneName! }
      case 'transport':
        if (rawValue === 0) return null
        return { type: 'transport', action: target.transport! }
      case 'clearSolo':
        if (rawValue === 0) return null
        return { type: 'clearSolo' }
      default:
        return null
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify(Array.from(this._rules.values()))
  }

  deserialize(json: string): void {
    try {
      const rules: MappingRule[] = JSON.parse(json)
      this.clearRules()
      for (const r of rules) this.addRule(r)
    } catch (err) {
      console.error('[MidiMapper] deserialize error:', err)
    }
  }

  saveProfile(name: string): void {
    try { localStorage.setItem(`ona_midi_profile_${name}`, this.serialize()) } catch (_) {}
  }

  loadProfile(name: string): boolean {
    const json = localStorage.getItem(`ona_midi_profile_${name}`)
    if (!json) return false
    this.deserialize(json)
    return true
  }

  listProfiles(): string[] {
    const prefix = 'ona_midi_profile_'
    const names: string[] = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(prefix)) names.push(k.slice(prefix.length))
      }
    } catch (_) {}
    return names
  }

  // ── Built-in templates ────────────────────────────────────────────────────────

  loadGenericFaderTemplate(numChannels = 6): void {
    this.clearRules()
    for (let ch = 1; ch <= numChannels; ch++) {
      // CC 0-5 → channel volumes (1 MIDI channel)
      this.addRule({
        id: `vol_ch${ch}`, label: `Ch ${ch} Volume`,
        source: { type: 'cc', channel: 1, number: ch - 1 },
        target: { action: 'channelVolume', channelId: ch },
        mode: 'absolute',
      })
      // CC 16-21 → channel mutes (Note On toggle on channel 2)
      this.addRule({
        id: `mute_ch${ch}`, label: `Ch ${ch} Mute`,
        source: { type: 'noteon', channel: 2, number: ch - 1 },
        target: { action: 'channelMute', channelId: ch },
        mode: 'note_toggle',
      })
      // CC 32-37 → solo (Note On toggle on channel 3)
      this.addRule({
        id: `solo_ch${ch}`, label: `Ch ${ch} Solo`,
        source: { type: 'noteon', channel: 3, number: ch - 1 },
        target: { action: 'channelSolo', channelId: ch, mode: 'pfl' },
        mode: 'note_toggle',
      })
    }
    // CC 7 → master volume (common convention)
    this.addRule({
      id: 'main_vol', label: 'Main Volume',
      source: { type: 'cc', channel: 1, number: 7 },
      target: { action: 'mainVolume' },
      mode: 'absolute',
    })
    console.log(`[MidiMapper] generic fader template loaded (${numChannels} channels)`)
  }
}

export const midiMapper = new MidiMapperImpl()
