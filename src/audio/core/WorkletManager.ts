/**
 * WorkletManager.ts — Gestión del ciclo de vida de AudioWorklets
 *
 * Responsabilidades:
 *   - Registrar módulos worklet (addModule) — UNA SOLA VEZ por contexto
 *   - Crear AudioWorkletNode por canal (meter tap, gate)
 *   - Allocar SharedArrayBuffer para comunicación audio thread → main thread
 *   - Reconectar worklets en caso de error (processorerror)
 *   - Exponer SAB de worklet para que MeteringEngine lo lea
 *
 * Layout del Worklet SAB (Float32, strides de 8 por canal):
 *   [chIdx * 8 + 0]  input peak dBFS       (escrito por ona-meter-processor tap de entrada)
 *   [chIdx * 8 + 1]  output peak dBFS      (escrito por ona-meter-processor tap de salida)
 *   [chIdx * 8 + 2]  gate level 0.0..1.0   (escrito por ona-dsp-processor)
 *   [chIdx * 8 + 3..7]  reservado
 *
 * MAX_CHANNELS = 16 (suficiente para futura expansión)
 *
 * Regla: NUNCA recrear AudioWorkletNode en caliente — solo reconectar la señal.
 */

export const MAX_WORKLET_CHANNELS = 16
const WORKLET_SAB_FLOATS          = MAX_WORKLET_CHANNELS * 8

export interface WorkletChannelNodes {
  channelId:   number
  gateNode:    AudioWorkletNode | null
  meterInNode: AudioWorkletNode | null
  meterOutNode: AudioWorkletNode | null
}

type WorkletState = 'idle' | 'loading' | 'ready' | 'error'

class WorkletManager {
  private _ctx:          AudioContext | null = null
  private _state:        WorkletState = 'idle'
  private _sabView:      Float32Array | null = null
  private _sabAvailable  = false
  private _nodes         = new Map<number, WorkletChannelNodes>()
  private _readyPromise: Promise<void> | null = null

  // ── Inicialización ────────────────────────────────────────────────────────────

  async initialize(ctx: AudioContext): Promise<void> {
    if (this._state === 'ready') return
    if (this._readyPromise) return this._readyPromise

    this._ctx   = ctx
    this._state = 'loading'

    this._readyPromise = this._load()
    return this._readyPromise
  }

  private async _load(): Promise<void> {
    if (!this._ctx) return
    try {
      // Registrar módulos worklet — addModule carga y compila una sola vez
      await Promise.all([
        this._ctx.audioWorklet.addModule('./worklets/ona-meter-processor.js'),
        this._ctx.audioWorklet.addModule('./worklets/ona-dsp-processor.js'),
        this._ctx.audioWorklet.addModule('./worklets/ona-router-processor.js'),
      ])

      // Allocar SAB compartido para todos los worklets del proyecto.
      // Si SAB no está disponible (COOP/COEP no configurado o navegador restringido)
      // los worklets funcionan para DSP pero no pueden reportar métricas de vuelta
      // al hilo principal. MeteringEngine usa AnalyserNode como fallback automático.
      try {
        const sab = new SharedArrayBuffer(WORKLET_SAB_FLOATS * Float32Array.BYTES_PER_ELEMENT)
        this._sabView     = new Float32Array(sab)
        this._sabAvailable = true
        this._sabView.fill(-200)
      } catch {
        this._sabView     = null
        this._sabAvailable = false
        console.warn(
          '[WORKLET] SharedArrayBuffer no disponible — worklets activos para DSP, ' +
          'pero sin métricas SAB; MeteringEngine usa AnalyserNode como fallback'
        )
      }

      this._state = 'ready'
      console.log(`[WORKLET] WorkletManager listo — 3 módulos registrados (SAB: ${this._sabAvailable})`)
    } catch (err) {
      this._state = 'error'
      console.error('[WORKLET] Error al cargar módulos:', err)
      throw err
    }
  }

  isReady():        boolean            { return this._state === 'ready' }
  getState():       WorkletState       { return this._state }
  getSAB():         Float32Array | null { return this._sabView }
  get sabAvailable(): boolean           { return this._sabAvailable }

  // ── Creación de nodos ─────────────────────────────────────────────────────────

  /**
   * createGateNode — AudioWorkletNode que reemplaza el Tone.Gain gate en ChannelStrip.
   * El gate se computa en el audio thread — elimina la dependencia del RAF loop.
   */
  createGateNode(channelId: number): AudioWorkletNode | null {
    if (!this._ctx || !this.isReady()) return null
    try {
      const node = new AudioWorkletNode(this._ctx, 'ona-dsp-processor', {
        numberOfInputs:  1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })

      // Enviar SAB al worklet solo si está disponible (no enviar ArrayBuffer normal)
      if (this._sabAvailable && this._sabView) {
        node.port.postMessage({ sab: this._sabView.buffer, channelIndex: channelId - 1 })
      }

      node.addEventListener('processorerror', (err) => {
        console.error(`[WORKLET] Gate ch${channelId} processorerror:`, err)
      })

      return node
    } catch (err) {
      console.error(`[WORKLET] createGateNode ch${channelId} error:`, err)
      return null
    }
  }

  /**
   * createMeterNode — Tap de metering que mide peak sin modificar la señal.
   * isTap: true = solo escucha (AnalyserNode-like), false = passthrough
   */
  createMeterNode(channelId: number, slotOffset: number): AudioWorkletNode | null {
    if (!this._ctx || !this.isReady()) return null
    try {
      const node = new AudioWorkletNode(this._ctx, 'ona-meter-processor', {
        numberOfInputs:  1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { isTap: false },
      })

      if (this._sabAvailable && this._sabView) {
        node.port.postMessage({
          sab:          this._sabView.buffer,
          channelIndex: channelId - 1,
          slotOffset,
        })
      }

      node.addEventListener('processorerror', (err) => {
        console.error(`[WORKLET] Meter ch${channelId} processorerror:`, err)
      })

      return node
    } catch (err) {
      console.error(`[WORKLET] createMeterNode ch${channelId} error:`, err)
      return null
    }
  }

  // ── Lectura del SAB (para MeteringEngine) ─────────────────────────────────────

  getOutputPeakDb(channelId: number): number {
    if (!this._sabView) return -200
    return this._sabView[(channelId - 1) * 8 + 1]
  }

  getInputPeakDb(channelId: number): number {
    if (!this._sabView) return -200
    return this._sabView[(channelId - 1) * 8 + 0]
  }

  getGateLevel(channelId: number): number {
    if (!this._sabView) return 1
    return this._sabView[(channelId - 1) * 8 + 2]
  }

  // ── Gate params → AudioParams del worklet ────────────────────────────────────

  setGateParams(node: AudioWorkletNode, params: {
    threshold?: number
    attack?:    number
    release?:   number
    range?:     number
    bypass?:    boolean
  }): void {
    if (!this._ctx) return
    const t = this._ctx.currentTime
    const p = node.parameters
    if (params.threshold !== undefined) p.get('threshold')?.setValueAtTime(params.threshold, t)
    if (params.attack    !== undefined) p.get('attack')?.setValueAtTime(params.attack,    t)
    if (params.release   !== undefined) p.get('release')?.setValueAtTime(params.release,  t)
    if (params.range     !== undefined) p.get('range')?.setValueAtTime(params.range,      t)
    if (params.bypass    !== undefined) p.get('bypass')?.setValueAtTime(params.bypass ? 1 : 0, t)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  destroy(): void {
    for (const ch of this._nodes.values()) {
      try { ch.gateNode?.disconnect()    } catch (_) {}
      try { ch.meterInNode?.disconnect() } catch (_) {}
      try { ch.meterOutNode?.disconnect() } catch (_) {}
    }
    this._nodes.clear()
    this._ctx     = null
    this._state   = 'idle'
    this._sabView = null
    this._readyPromise = null
  }
}

export const workletManager = new WorkletManager()
export default workletManager
