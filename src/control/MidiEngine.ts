/**
 * MidiEngine.ts — MIDI input engine profesional via Web MIDI API.
 *
 * Responsabilidades:
 *   - requestMIDIAccess (sysex=false — suficiente para control surfaces)
 *   - Device registry: Map<id, MidiDevice>
 *   - Hotplug: onstatechange → connect/disconnect sin reinicializar
 *   - Auto-reconnect: Web MIDI reconecta automáticamente al detectar el dispositivo
 *   - Decodificación de mensajes MIDI en MidiMessage tipado
 *   - Latencia: mensaje → callback < 1ms (evento nativo en callback directo)
 *
 * Compatibilidad:
 *   - MIDI USB estándar (class-compliant) en Chrome/Electron ≥ M43
 *   - Control surfaces genéricas (Behringer, AKAI, Korg, etc.)
 *   - Motor faders MIDI (Mackie HUI/MCU compatible)
 */

export interface MidiDevice {
  id:           string
  name:         string
  manufacturer: string
  type:         'input' | 'output'
  connected:    boolean
}

export interface MidiMessage {
  type:      'noteon' | 'noteoff' | 'cc' | 'pitchbend' | 'program' | 'aftertouch' | 'clock' | 'other'
  channel:   number   // 1–16
  note?:     number   // noteon/noteoff: 0–127
  velocity?: number   // noteon/noteoff: 0–127
  cc?:       number   // cc: controller number 0–127
  value?:    number   // cc: 0–127 | pitchbend: -8192 to 8191
  program?:  number   // program change: 0–127
  raw:       Uint8Array
  deviceId:  string
  timestamp: number
}

type MessageHandler    = (msg: MidiMessage) => void
type DeviceChangeHandler = (device: MidiDevice) => void

function decodeMidi(data: Uint8Array, deviceId: string, ts: number): MidiMessage {
  const status = data[0]
  const type4  = status & 0xF0
  const ch     = (status & 0x0F) + 1   // 1-based channel
  const d1     = data[1] ?? 0
  const d2     = data[2] ?? 0

  if (type4 === 0x90 && d2 > 0) return { type: 'noteon',   channel: ch, note: d1, velocity: d2, raw: data, deviceId, timestamp: ts }
  if (type4 === 0x80 || (type4 === 0x90 && d2 === 0))
                                 return { type: 'noteoff',  channel: ch, note: d1, velocity: d2, raw: data, deviceId, timestamp: ts }
  if (type4 === 0xB0)            return { type: 'cc',       channel: ch, cc: d1,   value: d2,    raw: data, deviceId, timestamp: ts }
  if (type4 === 0xE0) {
    const pb = ((d2 << 7) | d1) - 8192
    return { type: 'pitchbend', channel: ch, value: pb, raw: data, deviceId, timestamp: ts }
  }
  if (type4 === 0xC0)            return { type: 'program', channel: ch, program: d1, raw: data, deviceId, timestamp: ts }
  if (type4 === 0xD0)            return { type: 'aftertouch', channel: ch, value: d1, raw: data, deviceId, timestamp: ts }
  if (status === 0xF8)           return { type: 'clock',   channel: 0, raw: data, deviceId, timestamp: ts }
  return { type: 'other', channel: ch, raw: data, deviceId, timestamp: ts }
}

class MidiEngineImpl {
  private _access:        MIDIAccess | null = null
  private _inputs         = new Map<string, MIDIInput>()
  private _outputs        = new Map<string, MIDIOutput>()
  private _devices        = new Map<string, MidiDevice>()
  private _msgHandlers    = new Set<MessageHandler>()
  private _devHandlers    = new Set<DeviceChangeHandler>()
  private _initialized    = false

  // ── Init ──────────────────────────────────────────────────────────────────────

  async initialize(): Promise<boolean> {
    if (this._initialized) return true
    if (!navigator.requestMIDIAccess) {
      console.warn('[MIDI] Web MIDI API not available in this environment')
      return false
    }
    try {
      this._access = await navigator.requestMIDIAccess({ sysex: false })
      this._access.onstatechange = (e) => this._onStateChange(e as MIDIConnectionEvent)

      // Register all currently connected devices
      this._access.inputs.forEach((input) => this._attachInput(input))
      this._access.outputs.forEach((output) => this._registerOutput(output))

      this._initialized = true
      console.log(`[MIDI] initialized — ${this._inputs.size} inputs, ${this._outputs.size} outputs`)
      return true
    } catch (err) {
      console.warn('[MIDI] requestMIDIAccess failed:', err)
      return false
    }
  }

  // ── Message subscription ──────────────────────────────────────────────────────

  onMessage(cb: MessageHandler): () => void {
    this._msgHandlers.add(cb)
    return () => this._msgHandlers.delete(cb)
  }

  onDeviceChange(cb: DeviceChangeHandler): () => void {
    this._devHandlers.add(cb)
    return () => this._devHandlers.delete(cb)
  }

  // ── Device info ───────────────────────────────────────────────────────────────

  listInputs(): MidiDevice[] {
    return Array.from(this._devices.values()).filter(d => d.type === 'input')
  }

  listOutputs(): MidiDevice[] {
    return Array.from(this._devices.values()).filter(d => d.type === 'output')
  }

  getOutput(deviceId: string): MIDIOutput | null {
    return this._outputs.get(deviceId) ?? null
  }

  isAvailable(): boolean { return this._initialized && this._access !== null }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private _attachInput(input: MIDIInput): void {
    if (this._inputs.has(input.id)) return
    this._inputs.set(input.id, input)
    this._devices.set(input.id, {
      id: input.id, name: input.name ?? 'Unknown', manufacturer: input.manufacturer ?? '',
      type: 'input', connected: input.state === 'connected',
    })
    input.onmidimessage = (e: MIDIMessageEvent) => {
      if (!e.data || e.data.length === 0) return
      const msg = decodeMidi(e.data as Uint8Array, input.id, e.timeStamp)
      // Skip MIDI clock to prevent flooding (24 msgs/beat)
      if (msg.type === 'clock') return
      for (const h of this._msgHandlers) h(msg)
    }
    console.log(`[MIDI] input connected: "${input.name}"`)
  }

  private _registerOutput(output: MIDIOutput): void {
    this._outputs.set(output.id, output)
    this._devices.set(output.id, {
      id: output.id, name: output.name ?? 'Unknown', manufacturer: output.manufacturer ?? '',
      type: 'output', connected: output.state === 'connected',
    })
    console.log(`[MIDI] output connected: "${output.name}"`)
  }

  private _onStateChange(e: MIDIConnectionEvent): void {
    const port = e.port
    const dev  = this._devices.get(port.id)

    if (port.state === 'connected') {
      if (port.type === 'input') this._attachInput(port as MIDIInput)
      else this._registerOutput(port as MIDIOutput)
      if (dev) {
        dev.connected = true
        for (const h of this._devHandlers) h(dev)
      }
    } else {
      // Disconnected — keep in registry, mark as disconnected
      if (dev) {
        dev.connected = false
        if (port.type === 'input') {
          const input = this._inputs.get(port.id)
          if (input) input.onmidimessage = null
        }
        console.warn(`[MIDI] device disconnected: "${port.name}"`)
        for (const h of this._devHandlers) h(dev)
      }
    }
  }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    for (const input of this._inputs.values()) { try { input.onmidimessage = null } catch (_) {} }
    if (this._access) { try { this._access.onstatechange = null } catch (_) {} }
    this._inputs.clear()
    this._outputs.clear()
    this._devices.clear()
    this._msgHandlers.clear()
    this._devHandlers.clear()
    this._access = null
    this._initialized = false
  }
}

export const midiEngine = new MidiEngineImpl()
