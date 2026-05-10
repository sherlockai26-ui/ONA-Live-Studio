/**
 * MotorFaderManager.ts — Arquitectura para motor faders físicos.
 *
 * Estado actual: preparación arquitectural. Los motor faders físicos no existen todavía.
 * Este módulo establece la capa de abstracción para cuando existan.
 *
 * Cuando un motor fader físico esté disponible:
 *   1. Recibe CC MIDI desde el fader (físico → DAW)
 *   2. Envía CC MIDI al fader para moverlo (DAW → físico)
 *   3. Anti-feedback: ignora mensajes MIDI del fader mientras está en movimiento
 *
 * Estados de fader:
 *   IDLE    — fader en reposo, acepta comandos de posición
 *   MOVING  — fader en movimiento por comando DSP (ignora input físico)
 *   TOUCHED — fader siendo tocado por usuario (capta posición, ignora comandos DSP)
 *   CATCH   — fader catching up: usuario soltó, esperando coincidencia de posición
 *
 * Protección anti-feedback:
 *   Mientras state=MOVING: ignora CC input del mismo fader (evita loop MIDI)
 *   Timeout 200ms: si no hay CC input, asume que el motor llegó a posición
 *
 * Motor fader CC conventions (Mackie MCU/HUI compatible):
 *   Fader position: Pitch Bend en canal del fader (ch 1 = fader 1, etc.)
 *   Touch detect:   Note On/Off específico por superficie
 *
 * Integración futura:
 *   1. MidiEngine.onMessage → MotorFaderManager.handleInput()
 *   2. setPosition() → ControlFeedback._sendPitchBend() al output
 *   3. onMove callback → ControlPath dispatcher → audioBridge.setChannelVolume()
 */

export type FaderState = 'idle' | 'moving' | 'touched' | 'catch'

export interface FaderChannel {
  id:       number
  position: number       // current logical position 0–100
  target:   number       // commanded target 0–100
  state:    FaderState
  deviceId: string | null  // MIDI output device ID
}

type FaderMoveCallback = (channelId: number, position: number) => void

const MOTOR_SETTLE_MS = 200  // time to assume motor reached position

class MotorFaderManagerImpl {
  private _faders  = new Map<number, FaderChannel>()
  private _timers  = new Map<number, ReturnType<typeof setTimeout>>()
  private _onMove: FaderMoveCallback | null = null

  // ── Setup ─────────────────────────────────────────────────────────────────────

  registerChannel(channelId: number, deviceId?: string): void {
    this._faders.set(channelId, {
      id: channelId, position: 0, target: 0,
      state: 'idle', deviceId: deviceId ?? null,
    })
  }

  onMove(cb: FaderMoveCallback): void { this._onMove = cb }

  // ── Physical fader input (from MIDI Engine) ───────────────────────────────────

  handleInput(channelId: number, position: number): void {
    const f = this._faders.get(channelId)
    if (!f) return

    if (f.state === 'moving') {
      // Anti-feedback: ignore while motor is moving to commanded position
      return
    }

    f.state    = 'touched'
    f.position = position

    this._onMove?.(channelId, position)
  }

  handleTouchOn(channelId: number): void {
    const f = this._faders.get(channelId)
    if (f) f.state = 'touched'
  }

  handleTouchOff(channelId: number): void {
    const f = this._faders.get(channelId)
    if (!f) return
    if (f.state === 'touched') {
      // Check if position matches target (catch mode if not)
      f.state = Math.abs(f.position - f.target) < 1 ? 'idle' : 'catch'
    }
  }

  // ── Commanded position update (from DSP / scene recall) ──────────────────────

  setPosition(channelId: number, position: number): void {
    const f = this._faders.get(channelId)
    if (!f) return

    // If user is touching the fader, don't command motor (user has priority)
    if (f.state === 'touched') return

    f.target = Math.max(0, Math.min(100, position))
    f.state  = 'moving'

    // Clear pending settle timer
    const prev = this._timers.get(channelId)
    if (prev !== undefined) clearTimeout(prev)

    // Motor settle timeout — assume reached after MOTOR_SETTLE_MS
    this._timers.set(channelId, setTimeout(() => {
      const fader = this._faders.get(channelId)
      if (fader && fader.state === 'moving') {
        fader.position = fader.target
        fader.state    = 'idle'
      }
      this._timers.delete(channelId)
    }, MOTOR_SETTLE_MS))

    // Note: actual MIDI send would happen here via ControlFeedback.sendFaderPosition()
    // ControlFeedback is not imported here to avoid coupling — caller should handle send.
  }

  // ── Batch update (scene recall) ───────────────────────────────────────────────

  setAllPositions(positions: Record<number, number>): void {
    for (const [id, pos] of Object.entries(positions)) {
      this.setPosition(Number(id), pos)
    }
  }

  // ── State query ───────────────────────────────────────────────────────────────

  getState(channelId: number): FaderChannel | null {
    return this._faders.get(channelId) ?? null
  }

  getAllStates(): FaderChannel[] {
    return Array.from(this._faders.values())
  }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    for (const t of this._timers.values()) clearTimeout(t)
    this._timers.clear()
    this._faders.clear()
    this._onMove = null
  }
}

export const motorFaderManager = new MotorFaderManagerImpl()
