/**
 * DSPCommandBus.ts — Ring buffer SAB para comandos main thread → audio thread
 *
 * Objetivo:
 *   Enviar comandos DSP (gain, mute, gate params...) al audio thread sin
 *   bloquear, sin GC, y sin postMessage por cada cambio de parámetro.
 *
 * Implementación:
 *   Ring buffer SPSC (Single Producer, Single Consumer) en SharedArrayBuffer.
 *   - Producer: main thread (AudioBridge / AudioEngineSingleton)
 *   - Consumer: AudioWorklet process() — lee comandos en el audio thread
 *
 * Layout del SAB (Int32):
 *   [0]    write head (Atomics)
 *   [1]    read head  (Atomics)
 *   [2..N] command data: cada comando = 2 × Int32 = 8 bytes
 *
 * Estructura de comando (8 bytes):
 *   Byte 0: command type (u8)
 *   Byte 1: channel id (u8)
 *   Byte 2-3: pad
 *   Byte 4-7: value (f32 bits)
 *
 * Tipos de comando:
 *   CMD_GAIN       = 1    (setChannelGain)
 *   CMD_MUTE       = 2    (muteChannel)
 *   CMD_GATE_THR   = 3    (gate threshold)
 *   CMD_GATE_ATK   = 4    (gate attack)
 *   CMD_GATE_REL   = 5    (gate release)
 *   CMD_GATE_RANGE = 6    (gate range)
 *   CMD_GATE_BYP   = 7    (gate bypass)
 *   CMD_PAN        = 8    (setPan)
 *
 * Reglas de uso:
 *   - push() solo desde main thread
 *   - drain() solo desde audio thread (worklet process())
 *   - NUNCA allocar en drain()
 *   - NUNCA logging en drain()
 */

// ─── Constantes de tipo de comando ───────────────────────────────────────────

export const CMD = {
  GAIN:       1,
  MUTE:       2,
  GATE_THR:   3,
  GATE_ATK:   4,
  GATE_REL:   5,
  GATE_RANGE: 6,
  GATE_BYP:   7,
  PAN:        8,
} as const

export type CommandType = typeof CMD[keyof typeof CMD]

// ─── Ring Buffer ──────────────────────────────────────────────────────────────

const CAPACITY      = 256   // máximo de comandos en espera
const HEADER_INT32S = 2     // write head + read head
const CMD_INT32S    = 2     // 8 bytes por comando
const TOTAL_INT32S  = HEADER_INT32S + CAPACITY * CMD_INT32S
const TOTAL_BYTES   = TOTAL_INT32S * 4

const HEAD_WRITE = 0
const HEAD_READ  = 1

class DSPCommandBus {
  private _sabInt32:   Int32Array | null  = null
  private _sabUint8:   Uint8Array | null  = null
  private _sabFloat32: Float32Array | null = null
  private _available   = false

  // Temporal DataView para escribir float32 como bits Int32 (sin allocar)
  private readonly _tmpBuf    = new ArrayBuffer(4)
  private readonly _tmpFloat  = new Float32Array(this._tmpBuf)
  private readonly _tmpInt32  = new Int32Array(this._tmpBuf)

  // ── Inicialización ──────────────────────────────────────────────────────────

  initialize(): ArrayBuffer | null {
    try {
      const sab = new SharedArrayBuffer(TOTAL_BYTES)
      this._sabInt32   = new Int32Array(sab)
      this._sabUint8   = new Uint8Array(sab)
      this._sabFloat32 = new Float32Array(sab)
      Atomics.store(this._sabInt32, HEAD_WRITE, 0)
      Atomics.store(this._sabInt32, HEAD_READ,  0)
      this._available = true
      console.log(`[CMD BUS] Ring buffer ${CAPACITY} slots × 8B = ${TOTAL_BYTES}B (SAB)`)
      return sab
    } catch {
      console.warn('[CMD BUS] SharedArrayBuffer no disponible — command bus desactivado')
      return null
    }
  }

  isAvailable(): boolean { return this._available }

  // ── Producer — main thread ──────────────────────────────────────────────────

  /**
   * push — encolar comando DSP. Sin GC, sin blocking.
   * Retorna false si el buffer está lleno (producer overrun).
   */
  push(type: CommandType, channelId: number, value: number): boolean {
    if (!this._available || !this._sabInt32) return false

    const writeHead = Atomics.load(this._sabInt32, HEAD_WRITE)
    const readHead  = Atomics.load(this._sabInt32, HEAD_READ)
    const used      = (writeHead - readHead + CAPACITY) % CAPACITY

    if (used >= CAPACITY - 1) {
      console.warn('[CMD BUS] Buffer lleno — comando descartado')
      return false
    }

    // Calcular offset en el SAB (después del header de 2 Int32)
    const slot    = writeHead % CAPACITY
    const base    = (HEADER_INT32S + slot * CMD_INT32S) * 4  // byte offset

    // Escribir tipo y canal (sin DataView — directo en Uint8)
    this._sabUint8![base]     = type
    this._sabUint8![base + 1] = channelId

    // Escribir value como f32 bits en el segundo Int32
    this._tmpFloat[0] = value
    this._sabInt32![(HEADER_INT32S + slot * CMD_INT32S + 1)] = this._tmpInt32[0]

    // Avanzar write head (atómico — visible al consumer)
    Atomics.store(this._sabInt32, HEAD_WRITE, (writeHead + 1) % CAPACITY)

    return true
  }

  // ── Consumer — llamado desde audio thread (worklet) ─────────────────────────

  /**
   * drain — procesar todos los comandos pendientes.
   * SIN allocations. El callback recibe type, channelId, value.
   * En main thread se puede llamar también para preview de comandos.
   */
  drain(callback: (type: number, channelId: number, value: number) => void): void {
    if (!this._available || !this._sabInt32) return

    const tmpFloat  = this._tmpFloat
    const tmpInt32  = this._tmpInt32
    const sabInt32  = this._sabInt32
    const sabUint8  = this._sabUint8!

    let readHead  = Atomics.load(sabInt32, HEAD_READ)
    const writeHead = Atomics.load(sabInt32, HEAD_WRITE)

    while (readHead !== writeHead) {
      const slot = readHead % CAPACITY
      const base = (HEADER_INT32S + slot * CMD_INT32S) * 4

      const type      = sabUint8[base]
      const channelId = sabUint8[base + 1]

      // Leer float32 desde los bits del segundo Int32
      tmpInt32[0] = sabInt32[HEADER_INT32S + slot * CMD_INT32S + 1]
      const value = tmpFloat[0]

      callback(type, channelId, value)

      readHead = (readHead + 1) % CAPACITY
    }

    Atomics.store(sabInt32, HEAD_READ, readHead)
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getPending(): number {
    if (!this._sabInt32) return 0
    const w = Atomics.load(this._sabInt32, HEAD_WRITE)
    const r = Atomics.load(this._sabInt32, HEAD_READ)
    return (w - r + CAPACITY) % CAPACITY
  }

  destroy(): void {
    this._sabInt32   = null
    this._sabUint8   = null
    this._sabFloat32 = null
    this._available  = false
  }
}

export const dspCommandBus = new DSPCommandBus()
export default dspCommandBus
