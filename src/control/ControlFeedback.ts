/**
 * ControlFeedback.ts — Feedback MIDI hacia control surfaces bidireccionales.
 *
 * Responsabilidades:
 *   - Mantener estado interno: fader positions, mute/solo LEDs, FX states
 *   - Enviar CC/Note Out a MIDI outputs cuando el estado DSP cambia
 *   - syncAll() — sincronización completa al conectar nuevo dispositivo
 *
 * Compatibilidad:
 *   - Control surfaces con motor faders (reciben CC para mover fader)
 *   - Surfaces con LEDs programables (reciben Note On/Off para LED on/off)
 *   - LED on  = Note On, velocity 127
 *   - LED off = Note On, velocity 0  (Note Off alternativo)
 *   - Fader position = CC, value 0–127
 *
 * Mapping de feedback (configurable):
 *   channel volume  → CC (cc = channelId - 1, value = vol*127/100)
 *   channel mute    → Note On ch2, note = channelId - 1, vel = muted ? 127 : 0
 *   channel solo    → Note On ch3, note = channelId - 1, vel = soloed ? 127 : 0
 *   main volume     → CC ch1, cc = 7, value = vol*127/100
 *
 * Estas asignaciones siguen la plantilla del MidiMapper genérico para coherencia.
 */

import type { MidiDevice } from './MidiEngine'

interface FeedbackState {
  channelVolumes: Map<number, number>    // channelId → 0–100
  channelMutes:   Map<number, boolean>   // channelId → muted
  channelSolos:   Map<number, boolean>   // channelId → soloed
  mainVolume:     number
  subVolume:      number
}

export interface FeedbackConfig {
  volumeCcChannel: number    // MIDI channel for volume CCs (default 1)
  muteMidiChannel: number    // MIDI channel for mute notes (default 2)
  soloMidiChannel: number    // MIDI channel for solo notes (default 3)
  mainVolumeCc:    number    // CC number for main volume (default 7)
}

const DEFAULT_CONFIG: FeedbackConfig = {
  volumeCcChannel: 1,
  muteMidiChannel: 2,
  soloMidiChannel: 3,
  mainVolumeCc:    7,
}

function volToMidi(vol: number): number { return Math.round(Math.max(0, Math.min(100, vol)) * 127 / 100) }

class ControlFeedbackImpl {
  private _outputs   = new Map<string, MIDIOutput>()
  private _config:   FeedbackConfig = { ...DEFAULT_CONFIG }

  private _state: FeedbackState = {
    channelVolumes: new Map(),
    channelMutes:   new Map(),
    channelSolos:   new Map(),
    mainVolume:     75,
    subVolume:      75,
  }

  // ── Output management ─────────────────────────────────────────────────────────

  addOutput(deviceId: string, output: MIDIOutput): void {
    this._outputs.set(deviceId, output)
    console.log(`[ControlFeedback] output registered: ${deviceId}`)
  }

  removeOutput(deviceId: string): void {
    this._outputs.delete(deviceId)
  }

  setConfig(cfg: Partial<FeedbackConfig>): void {
    Object.assign(this._config, cfg)
  }

  // ── State update + feedback send ──────────────────────────────────────────────

  updateChannelVolume(channelId: number, vol: number): void {
    this._state.channelVolumes.set(channelId, vol)
    const cc    = channelId - 1   // CC 0-based
    const value = volToMidi(vol)
    this._sendCC(this._config.volumeCcChannel, cc, value)
  }

  updateChannelMute(channelId: number, muted: boolean): void {
    this._state.channelMutes.set(channelId, muted)
    const note = channelId - 1
    const vel  = muted ? 127 : 0
    this._sendNote(this._config.muteMidiChannel, note, vel)
  }

  updateChannelSolo(channelId: number, soloed: boolean): void {
    this._state.channelSolos.set(channelId, soloed)
    const note = channelId - 1
    const vel  = soloed ? 127 : 0
    this._sendNote(this._config.soloMidiChannel, note, vel)
  }

  updateMainVolume(vol: number): void {
    this._state.mainVolume = vol
    this._sendCC(this._config.volumeCcChannel, this._config.mainVolumeCc, volToMidi(vol))
  }

  updateSubVolume(vol: number): void {
    this._state.subVolume = vol
    // Sub volume on CC 8 by convention
    this._sendCC(this._config.volumeCcChannel, 8, volToMidi(vol))
  }

  clearAllSoloFeedback(numChannels: number): void {
    for (let i = 1; i <= numChannels; i++) {
      this._state.channelSolos.set(i, false)
      this._sendNote(this._config.soloMidiChannel, i - 1, 0)
    }
  }

  // ── Bulk sync — call when a new MIDI device connects ─────────────────────────

  syncAll(): void {
    if (this._outputs.size === 0) return

    // Fader positions
    for (const [channelId, vol] of this._state.channelVolumes) {
      this._sendCC(this._config.volumeCcChannel, channelId - 1, volToMidi(vol))
    }
    // Mute LEDs
    for (const [channelId, muted] of this._state.channelMutes) {
      this._sendNote(this._config.muteMidiChannel, channelId - 1, muted ? 127 : 0)
    }
    // Solo LEDs
    for (const [channelId, soloed] of this._state.channelSolos) {
      this._sendNote(this._config.soloMidiChannel, channelId - 1, soloed ? 127 : 0)
    }
    // Master
    this._sendCC(this._config.volumeCcChannel, this._config.mainVolumeCc, volToMidi(this._state.mainVolume))

    console.log('[ControlFeedback] syncAll complete')
  }

  // ── MIDI output primitives ────────────────────────────────────────────────────

  private _sendCC(midiCh: number, cc: number, value: number): void {
    const status = 0xB0 | ((midiCh - 1) & 0x0F)
    const data   = [status, cc & 0x7F, value & 0x7F]
    this._sendToAll(data)
  }

  private _sendNote(midiCh: number, note: number, velocity: number): void {
    const status = velocity > 0 ? (0x90 | ((midiCh - 1) & 0x0F)) : (0x80 | ((midiCh - 1) & 0x0F))
    const data   = [status, note & 0x7F, velocity & 0x7F]
    this._sendToAll(data)
  }

  private _sendToAll(data: number[]): void {
    for (const output of this._outputs.values()) {
      try { output.send(data) } catch (_) {}
    }
  }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    this._outputs.clear()
    this._state.channelVolumes.clear()
    this._state.channelMutes.clear()
    this._state.channelSolos.clear()
  }
}

export const controlFeedback = new ControlFeedbackImpl()
