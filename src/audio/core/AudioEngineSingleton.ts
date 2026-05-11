/**
 * AudioEngineSingleton.ts — Orquestador del motor DSP de ONA Live Studio
 *
 * Lifecycle:
 *   uninitialized → initializing → running → suspended → destroyed
 *
 * Arquitectura (Paso 6):
 *   AudioEngineSingleton (orquestador)
 *     ├── DSPGraphEngine      — router central, tracking de conexiones
 *     ├── BusEngine           — buses MAIN y SUB persistentes
 *     ├── ChannelStrip[]      — cadena DSP interna por canal (Phase 2: native nodes)
 *     ├── MeteringEngine      — RAF loop + gate DSP + SharedArrayBuffer
 *     ├── PerformanceMonitor  — profiling expuesto en consola
 *     ├── HardwareAbstractionLayer — device management + hot swap  (Paso 3)
 *     ├── ClockManager        — latency, xruns, jitter              (Paso 3)
 *     ├── NativeBridge        — probe ASIO/WASAPI (experimental)    (Paso 3)
 *     ├── WorkletManager      — AudioWorklet lifecycle + SAB        (Paso 4)
 *     ├── DSPScheduler        — drift/jitter/starvation profiling   (Paso 4)
 *     ├── DSPCommandBus       — SAB ring buffer main→audio thread   (Paso 4)
 *     ├── StateEngine         — source of truth DSP (headless-ready)(Paso 5)
 *     ├── DSPParameterManager — smooth param transitions / recall   (Paso 5)
 *     ├── SceneManager        — named scene save/load/rollback      (Paso 5)
 *     ├── PersistenceEngine   — autosave + crash recovery           (Paso 5)
 *     ├── DSPWatchdog         — health monitoring + auto-recovery   (Paso 5)
 *     └── NativeDSPBridge     — Rust native DSP / WebAudio fallback (Paso 6)
 *
 * Reglas de diseño:
 *   1. Ningún componente React instancia AudioNodes directamente
 *   2. Conexiones externas pasan siempre por DSPGraphEngine
 *   3. MeteringEngine es el único propietario del RAF loop de metering
 *   4. HAL es el único propietario de MediaStreams (hot swap)
 *   5. StateEngine es el único source of truth de estado DSP
 *   6. NativeDSPBridge gestiona canales nativos — UI no conoce el backend
 *   7. destroy() limpia todos los motores en orden inverso al init
 */

import * as Tone from 'tone'
import { dspGraph }           from './DSPGraphEngine'
import { BusEngine }          from './BusEngine'
import { ChannelStrip }       from './ChannelStrip'
import { MeteringEngine }     from './MeteringEngine'
import { perfMonitor }        from './PerformanceMonitor'
import { clockManager }       from './ClockManager'
import { hal }                from '../hardware/HardwareAbstractionLayer'
import { nativeBridge }       from '../hardware/NativeBridge'
import { workletManager }     from './WorkletManager'
import { dspScheduler }       from './DSPScheduler'
import { dspCommandBus }      from './DSPCommandBus'
import { stateEngine }        from '../state/StateEngine'
import { dspParamMgr }        from './DSPParameterManager'
import { sceneManager }       from '../state/SceneManager'
import { persistenceEngine }  from '../state/PersistenceEngine'
import { dspWatchdog }        from './DSPWatchdog'
import { nativeDSPBridge }           from '../native/NativeDSPBridge'
import { exposeBenchmarkAPI }         from '../native/NativeDSPBenchmark'
import { exposeBenchmarkRunnerAPI, channelBench } from './DSPBenchmarkRunner'
import { exposeTestSignalAPI }        from './DSPTestSignal'
import { exposeValidatorAPI }         from './DSPValidator'
import { auxBusEngine, NUM_AUX }      from './AuxBusEngine'
import { subgroupEngine, NUM_GROUPS } from './SubgroupEngine'
import { cueBus }                     from './CueBus'
import { routingMatrix }              from './RoutingMatrix'
import { routingValidator }           from './RoutingValidator'
import { multitrackRecorder }         from '../recording/MultitrackRecorder'
import { multitrackPlayer }           from '../recording/MultitrackPlayer'
import { latencyMeasurement }         from '../recording/LatencyMeasurement'
import { recordingClock }             from '../recording/RecordingClock'
import { bufferManager }              from '../recording/BufferManager'
import { safeRecovery }               from './SafeRecoverySystem'
import { cpuSafetyMode }              from './CPUSafetyMode'
import { nodeValidator }              from './NodeLifecycleValidator'
import { stressTest }                 from './ProductionStressTest'
import { productionReport }           from './ProductionReport'
import { fxBusEngine, NUM_FX_BUSES }  from '../fx/FxBusEngine'
import { DelayEngine }                from '../fx/DelayEngine'
import { ReverbEngine }               from '../fx/ReverbEngine'
import { exposeFxBenchAPI }           from '../fx/FxBenchmark'
import { gainStaging }                from './GainStaging'
import { mixBusProtection }          from './MixBusProtection'
import { loudnessMeter }             from './LoudnessMeter'
import { panLaw }                    from './PanLaw'
import { generateMixEngineReport, printMixEngineReport, auditFloatSafety, validateSumming, runMixBenchmark } from './MixEngineReport'
import { dspLoadBalancer }             from '../scalability/DSPLoadBalancer'
import { resourceManager }             from '../scalability/ResourceManager'
import { channelSleepSystem }          from '../scalability/ChannelSleepSystem'
import { lazyDSP }                     from '../scalability/LazyDSPRegistry'
import { multicorePrep }               from '../scalability/MulticorePrep'
import { cacheOptimizer }              from '../scalability/CacheOptimizer'
import { performanceModes }            from '../scalability/PerformanceModes'
import { runScalabilityBenchmark, exposeScalabilityBenchAPI } from '../scalability/ScalabilityBenchmark'
import { generateScalabilityReport, printScalabilityReport }  from '../scalability/ScalabilityReport'
import { midiEngine }                 from '../../control/MidiEngine'
import { midiMapper }                 from '../../control/MidiMapper'
import { controlPath }                from '../../control/ControlPath'
import { controlFeedback }            from '../../control/ControlFeedback'
import { motorFaderManager }          from '../../control/MotorFaderManager'
import { exposeControlBenchAPI, generateControlReport } from '../../control/ControlBenchmark'
import type { ControlAction }         from '../../control/MidiMapper'
import type { EngineSnapshot }        from '../state/StateEngine'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type EngineState   = 'uninitialized' | 'initializing' | 'running' | 'suspended' | 'destroyed'
type MeterCallback = (data: Record<string, number>) => void

// ─── AudioEngineSingleton ─────────────────────────────────────────────────────

class AudioEngineSingleton {
  private static _inst: AudioEngineSingleton | null = null

  static getInstance(): AudioEngineSingleton {
    if (!AudioEngineSingleton._inst) AudioEngineSingleton._inst = new AudioEngineSingleton()
    return AudioEngineSingleton._inst
  }

  private _state: EngineState = 'uninitialized'

  // AudioContext nativo (disponible tras initialize)
  private _rawCtx: AudioContext | null = null

  // Componentes DSP
  private _busEngine      = new BusEngine()
  private _meteringEngine = new MeteringEngine()
  private _strips         = new Map<number, ChannelStrip>()

  // Global FX
  private _gfx: Record<string, any> = {}

  // MediaStream sources
  private _mediaSources = new Map<number, MediaStreamAudioSourceNode>()

  // VS Players
  private _vsPlayers = new Map<number, any>()

  // Recorder nodes
  private _recMain: any  = null
  private _recRaw: any[] = []

  // Serialización de IR de reverb
  private _reverbGenerating   = false
  private _reverbDecayPending: number | null = null

  // ── Getters ──────────────────────────────────────────────────────────────────

  get state(): EngineState   { return this._state }
  get initialized(): boolean { return this._state === 'running' }

  // ── Inicialización ───────────────────────────────────────────────────────────

  async initialize(numChannels = 6, initialState: any = {}): Promise<void> {
    if (this._state !== 'uninitialized') return
    this._state = 'initializing'
    console.log('[ENGINE] initialize() — start')

    try {
      // 0. StateEngine — cargar estado inicial antes de construir nodos DSP
      stateEngine.loadFromInitialState(initialState)

      console.log('[ENGINE] Tone.start()')
      await Tone.start()
      const rawCtx = (Tone.context as any).rawContext as AudioContext
      this._rawCtx = rawCtx
      console.log(`[ENGINE] AudioContext running — sampleRate: ${rawCtx.sampleRate}Hz`)

      // 1. HAL + ClockManager
      hal.initialize(rawCtx)
      hal.onStreamReady((channelId, stream) => this.connectMediaStream(channelId, stream))
      hal.onDeviceDisconnected((channelId, deviceId) => {
        console.warn(`[ENGINE] Canal ${channelId} sin dispositivo (${deviceId.slice(0, 8)})`)
      })
      clockManager.attach(rawCtx)

      // 2. DSP infrastructure (Paso 4 + 5)
      dspCommandBus.initialize()
      dspScheduler.attach(rawCtx)
      dspParamMgr.attach(rawCtx)
      dspWatchdog.attach(rawCtx)

      // 3. Probe nativo (experimental, sin bloquear init)
      nativeBridge.probe().catch(() => {})

      // 3b. Native DSP Bridge (Paso 6) — Rust engine o fallback WebAudio
      nativeDSPBridge.initialize(rawCtx.sampleRate, 128)
      exposeBenchmarkAPI(rawCtx.sampleRate, 128)
      exposeBenchmarkRunnerAPI()
      console.log(`[ENGINE] NativeDSPBridge: ${nativeDSPBridge.backend}`)

      // 4. Buses
      this._busEngine.initialize()
      dspGraph.register('bus_main', this._busEngine.getBus('main')!.gain)
      dspGraph.register('bus_sub',  this._busEngine.getBus('sub')!.gain)
      console.log('[ENGINE] Buses listos')

      // 4b. Routing engines (Paso 9)
      const mainIn = this._busEngine.getBus('main')!.gain as GainNode
      const subIn  = this._busEngine.getBus('sub')!.gain  as GainNode
      auxBusEngine.initialize(rawCtx)
      subgroupEngine.initialize(rawCtx, mainIn, subIn)
      cueBus.initialize(rawCtx)
      routingMatrix.initialize(rawCtx, rawCtx.destination)
      // Register matrix sources
      routingMatrix.registerSource('main',  this._busEngine.getBus('main')!.fader as AudioNode)
      routingMatrix.registerSource('sub',   this._busEngine.getBus('sub')!.fader  as AudioNode)
      routingMatrix.registerSource('cue',   cueBus.fader!)
      for (let i = 1; i <= NUM_AUX; i++) {
        routingMatrix.registerSource(`aux${i}` as any, auxBusEngine.getBus(i)!.fader)
      }
      for (let i = 1; i <= NUM_GROUPS; i++) {
        routingMatrix.registerSource(`group${i}` as any, subgroupEngine.getGroup(i)!.fader)
      }
      console.log('[ENGINE] Routing engines listos')

      // 4c. FX Bus Engine (Paso 12) — 4 professional FX buses
      const mainBusGain = this._busEngine.getBus('main')!.gain as GainNode
      fxBusEngine.initialize(rawCtx, mainBusGain)
      console.log('[ENGINE] FX buses listos')

      // 5. Global FX
      await this._buildGlobalFx()
      console.log('[ENGINE] Global FX listos')

      // 6. Canales — rawCtx habilita Phase 2 (native nodes en ChannelStrip)
      for (let i = 1; i <= numChannels; i++) {
        const s = initialState.channels?.find((c: any) => c.id === i) ?? {}
        this._buildAndRegisterChannel(i, s, rawCtx)
      }
      console.log(`[ENGINE] ${numChannels} canales listos`)

      // 6b. WorkletManager — upgrade gates al audio thread
      try {
        await workletManager.initialize(rawCtx)
        let upgraded = 0
        for (const strip of this._strips.values()) {
          if (strip.upgradeGateToWorklet(workletManager)) upgraded++
        }
        console.log(`[ENGINE] WorkletManager listo — ${upgraded}/${this._strips.size} gates → worklet`)
      } catch (err) {
        console.warn('[ENGINE] WorkletManager falló — gate en main thread:', err)
      }

      // 7. Estado inicial maestro
      const s = initialState
      if (s.mainVolume != null) this.setMainVolume(s.mainVolume)
      if (s.subVolume  != null) this.setSubVolume(s.subVolume)
      if (s.fx?.reverb)         this.setGlobalReverb(s.fx.reverb)
      if (s.fx?.delay)          this.setGlobalDelay(s.fx.delay)
      if (s.fx?.fxReturn)       this.setFxReturn(s.fx.fxReturn)

      // 8. Metering + profiling
      if (!(window as any).__ONA_METERING_DISABLED) {
        this._meteringEngine.start(this._strips, this._busEngine)
        console.log('[ENGINE] MeteringEngine iniciado')
      }
      perfMonitor.start()
      dspWatchdog.start()

      // 8b. Paso 8 — Test signals + validator + console report
      exposeTestSignalAPI(rawCtx, rawCtx.destination)
      exposeValidatorAPI(rawCtx, this._strips)
      this._exposePaso8API(rawCtx)

      // 8c. Paso 10 — Multitrack I/O foundation
      latencyMeasurement.attach(rawCtx)
      recordingClock.attach(rawCtx)
      multitrackPlayer.setContext(rawCtx)
      for (const [id, strip] of this._strips) {
        multitrackPlayer.setTarget(id, strip.inputGain as AudioNode)
      }
      this._exposePaso10API(rawCtx)

      // 8e. Paso 12 — FX buses console API + benchmark
      this._exposePaso12API(rawCtx)

      // 8g. Paso 14 — Professional mix engine + gain staging
      this._initMixEngine(rawCtx)

      // 8h. Paso 15 — Scalability + resource management
      this._initScalability(rawCtx)

      // 8f. Paso 13 — MIDI control surface foundation
      await this._initControlSurface()

      // 8d. Paso 11 — Production stability systems
      safeRecovery.attach(rawCtx)
      dspWatchdog.onWarning((issue) => {
        if (issue.includes('congelado') || issue.includes('frozen')) {
          safeRecovery.notifyWorkletFrozen(issue)
        }
      })
      hal.onDeviceDisconnected((channelId, deviceId) => {
        safeRecovery.notifyDeviceDisconnect(channelId, deviceId)
      })
      cpuSafetyMode.startAutoDetect(() => dspScheduler.getMetrics().callbackJitterMs)
      this._exposePaso11API(rawCtx)

      // 9. Autosave (Paso 5)
      persistenceEngine.startAutosave(30_000)

      this._state = 'running'
      const graphStats = dspGraph.getStats()
      const latency    = hal.getLatency()
      console.log(`[ENGINE] listo ✓ — ${graphStats.nodes} nodos DSP, ${graphStats.edges} aristas, ` +
        `latencia: ${latency.totalMs.toFixed(1)}ms`)
    } catch (err) {
      this._state = 'uninitialized'
      throw err
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  suspend(): void {
    if (this._state !== 'running') return
    ;(Tone.context as any).suspend?.()
    this._state = 'suspended'
    console.log('[ENGINE] suspendido')
  }

  resume(): void {
    if (this._state !== 'suspended') return
    ;(Tone.context as any).resume?.()
    this._state = 'running'
    console.log('[ENGINE] reanudado')
  }

  destroy(): void {
    if (this._state === 'destroyed') return
    console.log('[ENGINE] destroy()')

    // 1. Watchdog + persistence (Paso 5) — antes de cerrar el contexto
    dspWatchdog.stop()
    persistenceEngine.flushAutosave()
    persistenceEngine.stopAutosave()

    // 1b. Native DSP Bridge (Paso 6)
    nativeDSPBridge.destroy()

    // 1a. Scalability systems (Paso 15)
    performanceModes.destroy()
    channelSleepSystem.destroy()
    dspLoadBalancer.destroy()
    cacheOptimizer.destroy()
    resourceManager.destroy()
    lazyDSP.clear()

    // 1a. Mix engine (Paso 14) + Control surface (Paso 13)
    mixBusProtection.destroy()
    loudnessMeter.destroy()
    controlPath.destroy()
    controlFeedback.destroy()
    motorFaderManager.destroy()
    midiEngine.destroy()

    // 1b. Production stability (Paso 11)
    cpuSafetyMode.destroy()
    safeRecovery.destroy()
    stressTest.stop()
    nodeValidator.disable()

    // 1c. Recording engines (Paso 10)
    multitrackRecorder.destroy()
    multitrackPlayer.destroy()
    latencyMeasurement.destroy()

    // 1c. Routing + FX engines
    fxBusEngine.destroy()
    auxBusEngine.destroy()
    subgroupEngine.destroy()
    cueBus.destroy()
    routingMatrix.destroy()

    // 2. Metering, profiling y schedulers DSP
    this._meteringEngine.stop()
    perfMonitor.stop()
    clockManager.destroy()
    dspScheduler.destroy()
    dspCommandBus.destroy()
    workletManager.destroy()

    // 3. HAL (cierra MediaStreams)
    hal.destroy()

    // 4. VS Players
    for (const player of this._vsPlayers.values()) {
      try { player.stop(); player.unsync() }       catch (_) {}
      try { player.disconnect(); player.dispose() } catch (_) {}
    }
    this._vsPlayers.clear()

    // 5. Recorders
    try { this._recMain?.stop()    } catch (_) {}
    try { this._recMain?.dispose() } catch (_) {}
    this._recMain = null
    for (const { rec } of this._recRaw) {
      try { rec.stop()    } catch (_) {}
      try { rec.dispose() } catch (_) {}
    }
    this._recRaw = []

    // 6. MediaStream sources legacy
    for (const src of this._mediaSources.values()) {
      try { src.disconnect() } catch (_) {}
    }
    this._mediaSources.clear()

    // 7. ChannelStrips
    for (const strip of this._strips.values()) {
      try { strip.dispose() } catch (_) {}
    }
    this._strips.clear()

    // 8. FX nodes
    for (const node of Object.values(this._gfx)) {
      try { node.disconnect() } catch (_) {}
      try { node.dispose()    } catch (_) {}
    }
    this._gfx = {}

    // 9. Buses
    this._busEngine.destroy()

    // 10. Grafo
    dspGraph.clear()

    this._state = 'destroyed'
    AudioEngineSingleton._inst = null
    console.log('[ENGINE] destroy() completo')
  }

  // ── Global FX ────────────────────────────────────────────────────────────────

  private async _buildGlobalFx(): Promise<void> {
    if ((window as any).__ONA_DISABLE_REVERB) {
      console.log('[ENGINE] Reverb desactivado por flag')
      this._gfx.reverb = new Tone.Volume(0)
    } else {
      this._gfx.reverb = new Tone.Reverb({ decay: 0.5, wet: 1 })
    }
    this._gfx.delay       = new Tone.FeedbackDelay({ delayTime: 0.3, feedback: 0.3, wet: 1 })
    this._gfx.returnGain  = new Tone.Gain(1)
    this._gfx.returnFader = new Tone.Volume(0)
    this._gfx.returnMeter = new Tone.Meter({ normalRange: false })

    this._gfx.reverb.connect(this._gfx.returnGain)
    this._gfx.delay.connect(this._gfx.returnGain)
    this._gfx.returnGain.connect(this._gfx.returnFader)
    this._gfx.returnFader.connect(this._busEngine.getBus('main')!.gain)
    this._gfx.returnFader.connect(this._gfx.returnMeter)

    dspGraph.register('fx_reverb',      this._gfx.reverb)
    dspGraph.register('fx_delay',       this._gfx.delay)
    dspGraph.register('fx_return_gain', this._gfx.returnGain)
    dspGraph.register('fx_return',      this._gfx.returnFader)
  }

  // ── Canal ────────────────────────────────────────────────────────────────────

  private _buildAndRegisterChannel(id: number, s: any, ctx?: AudioContext): void {
    const strip = new ChannelStrip(id, s, ctx)
    this._strips.set(id, strip)

    dspGraph.register(`ch${id}_toMain`,   strip.toMain)
    dspGraph.register(`ch${id}_toSub`,    strip.toSub)
    dspGraph.register(`ch${id}_send_rev`, strip.reverbSend)
    dspGraph.register(`ch${id}_send_dly`, strip.delaySend)

    dspGraph.connect(`ch${id}_toMain`,   'bus_main')
    dspGraph.connect(`ch${id}_toSub`,    'bus_sub')
    dspGraph.connect(`ch${id}_send_rev`, 'fx_reverb')
    dspGraph.connect(`ch${id}_send_dly`, 'fx_delay')
  }

  // ── API pública — canal ───────────────────────────────────────────────────────

  setChannelVolume(id: number, vol: number, muted = false): void {
    this._strips.get(id)?.setVolume(vol, muted)
    stateEngine.patchChannel(id, { volume: vol, muted })
  }

  setChannelPan(id: number, pan: number): void {
    this._strips.get(id)?.setPan(pan)
    stateEngine.patchChannel(id, { pan })
  }

  setChannelRouting(id: number, toMain: boolean, toSub: boolean): void {
    this._strips.get(id)?.setRouting(toMain, toSub)
    stateEngine.patchChannel(id, { toMain, toSub })
  }

  setChannelHpf(id: number, params: { active?: boolean; freq?: number }): void {
    this._strips.get(id)?.setHpf(params)
    const ch = stateEngine.getChannel(id)
    if (ch) stateEngine.patchChannel(id, { hpf: { ...ch.hpf, ...params } })
  }

  setChannelLpf(id: number, params: { active?: boolean; freq?: number }): void {
    this._strips.get(id)?.setLpf(params as any)
    const ch = stateEngine.getChannel(id)
    if (ch) stateEngine.patchChannel(id, { lpf: { ...(ch as any).lpf, ...params } })
  }

  // ── API pública — AUX sends (Paso 9) ─────────────────────────────────────────

  setChannelAuxSend(channelId: number, auxId: number, params: { level?: number; preFader?: boolean; muted?: boolean }): void {
    const strip  = this._strips.get(channelId)
    const auxBus = auxBusEngine.getBus(auxId)
    if (strip && auxBus) strip.setAuxSend(auxId, auxBus.input, params)
  }

  setAuxBusLevel(id: number, level: number): void { auxBusEngine.setLevel(id, level) }
  setAuxBusMuted(id: number, muted: boolean): void { auxBusEngine.setMuted(id, muted) }
  setAuxBusLabel(id: number, label: string): void  { auxBusEngine.setLabel(id, label) }
  getAuxBusMeter(id: number): number               { return auxBusEngine.getMeterValue(id) }

  // ── API pública — Subgroups (Paso 9) ─────────────────────────────────────────

  setChannelGroupSend(channelId: number, groupId: number, active: boolean): void {
    const strip = this._strips.get(channelId)
    const grp   = subgroupEngine.getGroup(groupId)
    if (strip && grp) strip.setGroupSend(groupId, grp.input, active)
  }

  setSubgroupLevel(id: number, level: number): void                   { subgroupEngine.setLevel(id, level) }
  setSubgroupMuted(id: number, muted: boolean): void                  { subgroupEngine.setMuted(id, muted) }
  setSubgroupRouting(id: number, toMain: boolean, toSub: boolean): void { subgroupEngine.setRouting(id, toMain, toSub) }
  setSubgroupLabel(id: number, label: string): void                   { subgroupEngine.setLabel(id, label) }
  getSubgroupMeter(id: number): number                                { return subgroupEngine.getMeterValue(id) }

  // ── API pública — Solo/Cue (Paso 9) ──────────────────────────────────────────

  setChannelSolo(channelId: number, soloed: boolean, mode: 'pfl' | 'afl' = 'pfl'): void {
    const strip = this._strips.get(channelId)
    if (!strip) return
    if (soloed) {
      cueBus.addSoloChannel(channelId)
      strip.setSolo(true, cueBus.input, mode)
    } else {
      cueBus.removeSoloChannel(channelId)
      strip.setSolo(false, null, mode)
    }
  }

  setCueLevel(level: number): void    { cueBus.setLevel(level) }
  setCueMode(mode: 'pfl' | 'afl'): void { cueBus.setMode(mode) }
  clearAllSolo(): void {
    for (const strip of this._strips.values()) strip.setSolo(false, null, 'pfl')
    cueBus.clearAll()
  }
  getCueMeter(): number { return cueBus.getMeterValue() }

  // ── API pública — Matrix routing (Paso 9) ────────────────────────────────────

  setMatrixConnect(source: string, dest: string, level = 100): void {
    routingMatrix.connect(source as any, dest as any, level)
  }
  setMatrixDisconnect(source: string, dest: string): void {
    routingMatrix.disconnect(source as any, dest as any)
  }
  setMatrixLevel(source: string, dest: string, level: number): void {
    routingMatrix.setLevel(source as any, dest as any, level)
  }
  getMatrixConnections() { return routingMatrix.getConnections() }

  // ── API pública — Routing validation (Paso 9) ────────────────────────────────

  validateRouting() {
    const connections = routingMatrix.getConnections()
    const buses = [
      { id: 'main',  peakDb: this._busEngine.getMeterValue('main') },
      { id: 'sub',   peakDb: this._busEngine.getMeterValue('sub')  },
      { id: 'cue',   peakDb: cueBus.getMeterValue() },
      ...Array.from({ length: NUM_AUX },    (_, i) => ({ id: `aux${i+1}`,   peakDb: auxBusEngine.getMeterValue(i + 1) })),
      ...Array.from({ length: NUM_GROUPS }, (_, i) => ({ id: `group${i+1}`, peakDb: subgroupEngine.getMeterValue(i + 1) })),
    ]
    // Build channel→group mapping for phase validation
    const chGroupSends: Record<number, number[]> = {}
    for (const [id, strip] of this._strips) {
      chGroupSends[id] = []
      for (let g = 1; g <= NUM_GROUPS; g++) {
        if ((strip as any)._groupSends?.has(g)) chGroupSends[id].push(g)
      }
    }
    return routingValidator.runFullValidation(connections, buses, chGroupSends)
  }

  setChannelGate(id: number, params: any): void {
    this._strips.get(id)?.setGate(params)
    const ch = stateEngine.getChannel(id)
    if (ch) stateEngine.patchChannel(id, { gate: { ...ch.gate, ...params } })
  }

  setChannelCompressor(id: number, params: any): void {
    this._strips.get(id)?.setCompressor(params)
    const ch = stateEngine.getChannel(id)
    if (ch) stateEngine.patchChannel(id, { compressor: { ...ch.compressor, ...params } })
  }

  setChannelReverbSend(id: number, v: number): void {
    this._strips.get(id)?.setReverbSend(v)
    stateEngine.patchChannel(id, { reverbSend: v })
  }

  setChannelDelaySend(id: number, v: number): void {
    this._strips.get(id)?.setDelaySend(v)
    stateEngine.patchChannel(id, { delaySend: v })
  }

  setChannelEqBand(id: number, bandIndex: number, params: { gain?: number; freq?: number; q?: number }): void {
    this._strips.get(id)?.setEqBand(bandIndex, params)
    const ch = stateEngine.getChannel(id)
    if (ch) {
      const eqBands = ch.eqBands.map((b, i) => i === bandIndex ? { ...b, ...params } : b)
      stateEngine.patchChannel(id, { eqBands })
    }
  }

  setChannelName(id: number, name: string): void {
    stateEngine.patchChannel(id, { name })
  }

  setChannelColor(id: number, color: string): void {
    stateEngine.patchChannel(id, { color })
  }

  getCompReduction(id: number): number { return this._strips.get(id)?.getGainReduction() ?? 0 }
  getGateLevel(id: number):     number { return this._strips.get(id)?.getGateLevel()     ?? 1 }

  private _exposePaso9API(): void {
    ;(window as any).__ONA_PASO9 = {
      /** Routing status: all buses, matrix, solo */
      status: () => {
        console.group('[PASO 9] Routing Status')
        console.log('AUX buses:')
        auxBusEngine.getAllStates().forEach(b => {
          const db = auxBusEngine.getMeterValue(b.id)
          console.log(`  aux${b.id} "${b.label}": ${b.muted ? 'MUTED' : b.level + '%'} | ${isFinite(db) ? db.toFixed(1) : '-∞'} dBFS`)
        })
        console.log('Subgroups:')
        subgroupEngine.getAllStates().forEach(g => {
          const db = subgroupEngine.getMeterValue(g.id)
          console.log(`  grp${g.id} "${g.label}": ${g.muted ? 'MUTED' : g.level + '%'} → main:${g.toMain} sub:${g.toSub} | ${isFinite(db) ? db.toFixed(1) : '-∞'} dBFS`)
        })
        console.log('Cue bus:   level=' + cueBus.state.level + ' mode=' + cueBus.mode + ' solo=[' + cueBus.state.soloedChannels.join(',') + ']')
        console.log('Matrix:')
        routingMatrix.getConnections().filter(c => c.active).forEach(c =>
          console.log(`  ${c.source} → ${c.dest} @ ${c.level}%`)
        )
        console.groupEnd()
      },

      /** Connect aux send for a channel */
      auxSend: (channelId: number, auxId: number, level: number, preFader = true) => {
        this.setChannelAuxSend(channelId, auxId, { level, preFader, muted: level === 0 })
        console.log(`[PASO 9] ch${channelId} → aux${auxId} ${level}% ${preFader ? 'pre' : 'post'}`)
      },

      /** Route channel to subgroup */
      groupSend: (channelId: number, groupId: number, active = true) => {
        this.setChannelGroupSend(channelId, groupId, active)
        console.log(`[PASO 9] ch${channelId} → grp${groupId} ${active ? 'ON' : 'OFF'}`)
      },

      /** Solo a channel (PFL or AFL) */
      solo: (channelId: number, mode: 'pfl' | 'afl' = 'pfl') => {
        this.setChannelSolo(channelId, true, mode)
        console.log(`[PASO 9] ch${channelId} SOLO ${mode.toUpperCase()}`)
      },
      unsolo: (channelId: number) => { this.setChannelSolo(channelId, false); console.log(`[PASO 9] ch${channelId} solo OFF`) },
      clearSolo: () => { this.clearAllSolo(); console.log('[PASO 9] All solo cleared') },

      /** Matrix routing */
      matrix: {
        connect:    (src: string, dst: string, level = 100) => { this.setMatrixConnect(src, dst, level); console.log(`[MATRIX] ${src} → ${dst} @ ${level}%`) },
        disconnect: (src: string, dst: string) => { this.setMatrixDisconnect(src, dst); console.log(`[MATRIX] ${src} → ${dst} OFF`) },
        list:       () => { console.table(routingMatrix.getConnections()); return routingMatrix.getConnections() },
      },

      /** Full routing validation */
      validate: () => {
        const report = this.validateRouting()
        const icon = report.verdict === 'ok' ? '✓' : report.verdict === 'warning' ? '⚠' : '✗'
        console.group(`${icon} [PASO 9] Routing Validation — ${report.verdict.toUpperCase()}`)
        if (report.issues.length === 0) console.log('No issues detected')
        report.issues.forEach(i => console.log(`  [${i.severity.toUpperCase()}] ${i.type}: ${i.message}`))
        console.groupEnd()
        return report
      },

      /** CPU benchmark with routing overhead */
      bench: async (numCh = 16) => {
        const r = await channelBench(numCh)
        console.table(r)
        console.log(`[PASO 9] Routing nodes: ${NUM_AUX} AUX + ${NUM_GROUPS} groups + cue + matrix`)
        return r
      },

      help: () => {
        console.group('[PASO 9] Console API')
        console.log('__ONA_PASO9.status()                           — routing overview')
        console.log('__ONA_PASO9.auxSend(ch, aux, level, preFader) — canal → AUX')
        console.log('__ONA_PASO9.groupSend(ch, group, active)      — canal → subgroup')
        console.log('__ONA_PASO9.solo(ch, mode)                    — PFL/AFL solo')
        console.log('__ONA_PASO9.clearSolo()                       — clear all solos')
        console.log('__ONA_PASO9.matrix.connect(src, dst, level)   — matrix routing')
        console.log('__ONA_PASO9.matrix.list()                     — ver matrix activa')
        console.log('__ONA_PASO9.validate()                        — routing validation')
        console.log('__ONA_PASO9.bench(16)                         — CPU benchmark')
        console.log('')
        console.log('Matrix sources: main, sub, cue, aux1-8, group1-4')
        console.log('Matrix dests:   out1-out8')
        console.groupEnd()
      },
    }
  }

  private _exposePaso8API(ctx: AudioContext): void {
    this._exposePaso9API()
    ;(window as any).__ONA_PASO8 = {
      status: () => {
        console.group('[PASO 8] DSP Status Report')
        console.log('Backend:    ', nativeDSPBridge.backend)
        console.log('Channels:   ', this._strips.size)
        console.log('SampleRate: ', ctx.sampleRate, 'Hz')
        console.log('BaseLatency:', ctx.baseLatency?.toFixed(3) ?? 'n/a', 'ms')
        console.log('Watchdog:   ', dspWatchdog.getStatus())
        console.log('Strips active:')
        for (const [id, strip] of this._strips) {
          console.log(`  ch${id}: workletGate=${strip.isUsingWorkletGate()} gr=${strip.getGainReduction().toFixed(1)}dB gate=${strip.getGateLevel().toFixed(3)}`)
        }
        console.groupEnd()
      },
      bench: async (n = 16) => {
        const r = await channelBench(n)
        console.table(r)
        return r
      },
      validate: () => (window as any).__ONA_VALIDATE?.check(),
      test:     () => console.log('Use __ONA_TEST.sine/pink/sweep/impulse/stop'),
      help: () => {
        console.group('[PASO 8] Console API')
        console.log('__ONA_PASO8.status()         — DSP status report')
        console.log('__ONA_PASO8.bench(n)         — channel benchmark (default 16ch)')
        console.log('__ONA_PASO8.validate()       — run audio validators')
        console.log('__ONA_TEST.sine(hz, db)      — sine test signal')
        console.log('__ONA_TEST.pink(db)          — pink noise')
        console.log('__ONA_TEST.sweep(f0, f1, ms) — log sweep')
        console.log('__ONA_TEST.impulse(db)       — single impulse')
        console.log('__ONA_TEST.stop()            — stop test signal')
        console.log('__ONA_VALIDATE.attachAll()   — attach validators to channels')
        console.log('__ONA_VALIDATE.check()       — read validator results')
        console.log('__ONA_BENCH.full()           — full 8/16/32/64ch bench suite')
        console.groupEnd()
      },
    }
  }

  // ── API pública — Multitrack Recording (Paso 10) ─────────────────────────────

  async startMultitrackRec(channelIds?: number[]): Promise<string> {
    if (!this._rawCtx) throw new Error('[ENGINE] Not initialized')
    const ids = channelIds ?? Array.from(this._strips.keys())
    const sources = new Map<number, AudioNode>()
    for (const id of ids) {
      const strip = this._strips.get(id)
      if (strip) sources.set(id, strip.preFaderTap as AudioNode)
    }
    const session = await multitrackRecorder.startSession(this._rawCtx, sources)
    return session.id
  }

  async stopMultitrackRec() {
    return multitrackRecorder.stopSession()
  }

  getMultitrackStats() { return multitrackRecorder.getStats() }
  listRecordingSessions() { return (window as any).onaRecording?.listSessions() ?? Promise.resolve([]) }

  // ── API pública — Multitrack Playback (Paso 10) ───────────────────────────────

  async loadPlaybackTrack(channelId: number, filePath: string): Promise<boolean> {
    return multitrackPlayer.loadSessionTrack(channelId, filePath)
  }

  startPlayback(offsetSeconds?: number): void {
    multitrackPlayer.start(offsetSeconds)
  }

  stopPlayback(): void  { multitrackPlayer.stop() }
  pausePlayback(): void { multitrackPlayer.pause() }
  seekPlayback(seconds: number): void { multitrackPlayer.seek(seconds) }

  getPlaybackState() {
    return {
      playing:  multitrackPlayer.playing,
      position: multitrackPlayer.position,
      duration: multitrackPlayer.duration,
      channels: multitrackPlayer.loadedChannels(),
    }
  }

  getMeasuredLatency() { return latencyMeasurement.measure(recordingClock.getDriftPpm()) }

  // ── API pública — Production Stability (Paso 11) ─────────────────────────────

  setCpuMode(mode: 'normal' | 'low_cpu' | 'safe'): void { cpuSafetyMode.setMode(mode) }
  getCpuMode(): string { return cpuSafetyMode.mode }

  getProductionReport() { return productionReport.print(this._rawCtx) }
  getRecoveryHistory()  { return safeRecovery.getHistory() }
  getNodeReport()       { return nodeValidator.getReport() }

  async runStressTest(hours: 4 | 8 | 12 = 4) {
    return stressTest.run(this, { simulatedHours: hours })
  }

  // ── API pública — FX buses (Paso 12) ─────────────────────────────────────────

  setChannelFxBusSend(channelId: number, busId: number, params: { level?: number; preFader?: boolean; muted?: boolean }): void {
    const strip  = this._strips.get(channelId)
    const input  = fxBusEngine.getInput(busId)
    if (strip && input) strip.setFxBusSend(busId, input, params)
  }

  setFxBusActive(busId: number, active: boolean): void    { fxBusEngine.setActive(busId, active) }
  setFxBusWetLevel(busId: number, level: number): void    { fxBusEngine.setWetLevel(busId, level) }

  attachFxProcessor(busId: number, type: 'delay' | 'reverb'): void {
    if (!this._rawCtx) return
    const proc = type === 'delay'
      ? new DelayEngine(this._rawCtx)
      : new ReverbEngine(this._rawCtx)
    fxBusEngine.attachProcessor(busId, proc, type)
  }

  detachFxProcessor(busId: number): void { fxBusEngine.detachProcessor(busId) }

  setFxProcessorParams(busId: number, params: Record<string, number>): void {
    const state = fxBusEngine.getState(busId)
    if (!state) return
    const bus = (fxBusEngine as any)._buses?.get(busId)
    if (!bus?.processor) return
    bus.processor.setParams(params)
  }

  getFxBusMeter(busId: number): number        { return fxBusEngine.getMeterValue(busId) }
  getFxBusState(busId: number)                { return fxBusEngine.getState(busId) }
  getAllFxBusStates()                          { return fxBusEngine.getAllStates() }

  // ── Mix Engine (Paso 14) ─────────────────────────────────────────────────────

  private _initMixEngine(ctx: AudioContext): void {
    // Gain staging — inject meter reader for headroom analysis
    gainStaging.setMeterReader((id) => {
      const strip = this._strips.get(id)
      if (!strip) return -Infinity
      // Use the strip's output meter (post-fader peak)
      return strip.getGainReduction()  // GR gives us relative info; peak is from MeteringEngine
    })

    // Mix bus protection — attach to main bus fader → destination
    const mainFader = this._busEngine.getBus('main')!.fader as AudioNode
    const destNode  = this._busEngine.getDestNode()
    if (destNode) {
      mixBusProtection.attach(ctx, mainFader, destNode, (event) => {
        console.warn(`[ENGINE] Clip guard triggered: ${event.peakDb.toFixed(1)} dBFS`)
      })
    }

    // Loudness meter on main bus (post-protection)
    loudnessMeter.initialize(ctx)
    const mainGain = this._busEngine.getBus('main')!.gain as AudioNode
    loudnessMeter.attach('main', mainGain)
    const subGain  = this._busEngine.getBus('sub')!.gain as AudioNode
    loudnessMeter.attach('sub', subGain)

    this._exposePaso14API(ctx)
  }

  // ── API pública — Gain staging ────────────────────────────────────────────────

  setChannelTrim(channelId: number, db: number): void {
    const clamped = gainStaging.setTrim(channelId, db)
    this._strips.get(channelId)?.setTrim(clamped)
  }

  getChannelTrim(channelId: number): number { return gainStaging.getTrim(channelId) }

  autoTrimChannel(channelId: number): number | null { return gainStaging.autoTrim(channelId) }

  setGainStagingProfile(profile: 'broadcast' | 'live' | 'recording'): void {
    gainStaging.setProfile(profile)
  }

  getGainStagingReport() {
    return gainStaging.generateReport(Array.from(this._strips.keys()))
  }

  // ── API pública — Mix bus protection ─────────────────────────────────────────

  setMixBusProtection(cfg: Partial<{ softSatEnabled: boolean; limiterEnabled: boolean; clipGuardEnabled: boolean; satDrive: number; limiterThresholdDb: number }>): void {
    mixBusProtection.setConfig(cfg)
  }

  getMixBusProtectionConfig() { return mixBusProtection.getConfig() }
  getPostProtectionPeakDb()   { return mixBusProtection.getPostProtectionPeakDb() }
  getLimiterReduction()        { return mixBusProtection.getLimiterReduction() }
  getMixBusClipCount()         { return mixBusProtection.clipCount }

  // ── API pública — Loudness metering ──────────────────────────────────────────

  getLoudness(busId = 'main')  { return loudnessMeter.read(busId) }
  getAllLoudness()              { return loudnessMeter.readAll() }

  // ── API pública — Pan law ─────────────────────────────────────────────────────

  setPanLaw(mode: 'equal_power' | 'linear_6db' | 'linear_0db'): void {
    panLaw.setMode(mode)
    // Reapply pan for all channels to use new law
    for (const [id, strip] of this._strips) {
      const ch = stateEngine.getChannel(id)
      if (ch) {
        const effectivePan = panLaw.getEffectivePan(ch.pan)
        strip.setPan(effectivePan)
      }
    }
  }

  getPanLaw()                  { return panLaw.mode }
  getPanLawInfo()              { return panLaw.info }
  getPanGains(pan: number)     { return panLaw.getGains(pan) }

  // ── API pública — Mix engine report ──────────────────────────────────────────

  async getMixEngineReport(): Promise<any> {
    if (!this._rawCtx) return null
    const buses = [
      { id: 'main', analyser: this._busEngine.getBus('main')!.analyser },
      { id: 'sub',  analyser: this._busEngine.getBus('sub')!.analyser  },
    ]
    const loudnessData = this.getAllLoudness()
    const report = generateMixEngineReport(
      this._rawCtx, buses, this._strips.size, panLaw.mode, loudnessData ?? {}
    )
    printMixEngineReport(report)
    return report
  }

  runMixBenchmark() {
    if (!this._rawCtx) return null
    const results = runMixBenchmark(this._rawCtx, [16, 32, 64])
    console.table(results)
    return results
  }

  private _exposePaso14API(ctx: AudioContext): void {
    ;(window as any).__ONA_PASO14 = {
      /** Gain staging */
      gain: {
        profile:  (p?: 'broadcast' | 'live' | 'recording') => {
          if (p) { this.setGainStagingProfile(p); console.log(`[PASO 14] profile: ${p}`) }
          return gainStaging.profile
        },
        trim:     (channelId: number, db?: number) => {
          if (db !== undefined) { this.setChannelTrim(channelId, db); console.log(`[PASO 14] ch${channelId} trim: ${db}dB`) }
          return gainStaging.getTrim(channelId)
        },
        autoTrim: (channelId: number) => {
          const result = this.autoTrimChannel(channelId)
          console.log(`[PASO 14] ch${channelId} auto-trim: ${result?.toFixed(1) ?? 'n/a'}dB`)
          return result
        },
        report:   () => { const r = this.getGainStagingReport(); console.table(r.channels); return r },
      },

      /** Mix bus protection */
      protection: {
        config:    (cfg?: any) => {
          if (cfg) this.setMixBusProtection(cfg)
          return mixBusProtection.getConfig()
        },
        enable:    (type: 'softSat' | 'limiter' | 'clipGuard', on: boolean) => {
          const cfg: any = {}
          if (type === 'softSat')   cfg.softSatEnabled   = on
          if (type === 'limiter')   cfg.limiterEnabled    = on
          if (type === 'clipGuard') cfg.clipGuardEnabled  = on
          this.setMixBusProtection(cfg)
          console.log(`[PASO 14] ${type}: ${on ? 'ON' : 'OFF'}`)
        },
        peak:      () => { const db = this.getPostProtectionPeakDb(); console.log(`[PASO 14] post-protection peak: ${db.toFixed(1)}dBFS`); return db },
        limiter:   () => { const gr = this.getLimiterReduction(); console.log(`[PASO 14] limiter GR: ${gr.toFixed(1)}dB`); return gr },
        clips:     () => { console.log(`[PASO 14] clip events: ${this.getMixBusClipCount()}`); return this.getMixBusClipCount() },
      },

      /** Loudness metering */
      loudness: {
        main:  () => { const r = this.getLoudness('main'); console.table(r); return r },
        sub:   () => { const r = this.getLoudness('sub');  console.table(r); return r },
        all:   () => { const r = this.getAllLoudness(); console.table(r); return r },
      },

      /** Pan law */
      pan: {
        law:  (mode?: 'equal_power' | 'linear_6db' | 'linear_0db') => {
          if (mode) { this.setPanLaw(mode); console.log(`[PASO 14] pan law: ${mode}`) }
          return panLaw.info
        },
        gains: (panValue: number) => { const g = panLaw.getGains(panValue); console.table(g); return g },
        check: () => {
          const c = panLaw.checkCoherence(this._strips.size)
          console.log(c.warning ?? '✓ Pan coherence OK')
          return c
        },
      },

      /** Full mix engine report */
      report: () => this.getMixEngineReport(),
      bench:  () => this.runMixBenchmark(),

      help: () => {
        console.group('[PASO 14] Console API — Professional Mix Engine')
        console.log('__ONA_PASO14.gain.profile("broadcast"|"live"|"recording")')
        console.log('__ONA_PASO14.gain.trim(channelId, dB)      — set input trim ±18dB')
        console.log('__ONA_PASO14.gain.autoTrim(channelId)      — auto-trim to nominal')
        console.log('__ONA_PASO14.gain.report()                 — headroom report per channel')
        console.log('__ONA_PASO14.protection.enable("softSat"|"limiter"|"clipGuard", true|false)')
        console.log('__ONA_PASO14.protection.peak()             — post-protection peak dBFS')
        console.log('__ONA_PASO14.protection.limiter()          — limiter gain reduction')
        console.log('__ONA_PASO14.loudness.main()               — main bus LUFS/RMS/peak')
        console.log('__ONA_PASO14.loudness.all()                — all metered buses')
        console.log('__ONA_PASO14.pan.law("equal_power"|"linear_6db"|"linear_0db")')
        console.log('__ONA_PASO14.pan.gains(panValue)           — L/R gain for pan position')
        console.log('__ONA_PASO14.report()                      — full mix engine report')
        console.log('__ONA_PASO14.bench()                       — 16/32/64ch benchmark')
        console.groupEnd()
      },
    }
    console.log('[ENGINE] Paso 14 mix engine API ready — window.__ONA_PASO14')
  }

  // ── Scalability (Paso 15) ─────────────────────────────────────────────────────

  private _initScalability(ctx: AudioContext): void {
    // Cache optimizer — Float32Array pool + command batching
    cacheOptimizer.initialize()

    // DSP load balancer — priority queue with budget management
    dspLoadBalancer.attach(ctx)

    // Resource manager — idle meter suspension, FX bus idle tracking
    for (let i = 1; i <= this._strips.size; i++) resourceManager.registerMeter(`ch${i}`)
    resourceManager.registerMeter('main')
    resourceManager.registerMeter('sub')
    for (let i = 0; i < 4; i++) resourceManager.registerFxBus(i)
    resourceManager.start()

    // Channel sleep system — signal-based sleep/wake
    channelSleepSystem.setPeakReader((id) => this._meteringEngine.getChannelMeter(id))
    channelSleepSystem.onSleep((id) => {
      // Demote to LOW priority — let the ResourceManager idle timer expire naturally
      // (do NOT touch the meter here, otherwise the idle timer resets and never suspends)
      dspLoadBalancer.schedule(`sleep_${id}`, 3, () => {})
    })
    channelSleepSystem.onWake((id) => {
      // Resume meter reads immediately on wake
      resourceManager.touchMeter(`ch${id}`)
    })
    for (const id of this._strips.keys()) {
      channelSleepSystem.registerChannel(id)
    }
    channelSleepSystem.start()

    // Multicore prep — assign channel groups, benchmark IPC
    const channelIds = [...this._strips.keys()]
    multicorePrep.assignGroups(channelIds)

    // Performance modes — wire mode-change callback
    performanceModes.onModeChange((mode, cfg) => {
      // Propagate to load balancer
      dspLoadBalancer.forceStage(cfg.lbStage)
      // Enable/disable channel sleep
      if (cfg.channelSleepEnabled) channelSleepSystem.start()
      else { channelSleepSystem.stop(); channelSleepSystem.wakeAll() }
    })
    // Wire CPU getter from DSP scheduler
    performanceModes.setCpuGetter(() => {
      const m = dspLoadBalancer.getMetrics()
      return m.lastCycleMs / m.budgetMs * 100
    })
    // Apply default mode (live)
    performanceModes.setMode('live')

    // Scalability bench + report API
    exposeScalabilityBenchAPI(
      ctx,
      (msg) => { /* dispatcher stub for bench */ },
      (key, fn) => cacheOptimizer.batchCommand(key, fn),
    )

    this._exposePaso15API(ctx)
    console.log(`[ENGINE] Paso 15 scalability ready — ${channelIds.length}ch in ${multicorePrep.getGroups().length} core group(s)`)
  }

  // ── API pública — Scalability (Paso 15) ───────────────────────────────────────

  setPerformanceMode(mode: 'studio' | 'live' | 'eco'): void { performanceModes.setMode(mode) }
  getPerformanceMode(): string { return performanceModes.mode }
  getModeConfig()              { return performanceModes.config }
  enableAutoPerformance(on: boolean): void { performanceModes.enableAutoSwitch(on) }

  getLoadBalancerMetrics()  { return dspLoadBalancer.getMetrics() }
  forceLoadBalancerStage(s: 'full'|'reduced'|'minimal'|'emergency'): void { dspLoadBalancer.forceStage(s) }

  getResourceStats()        { return resourceManager.getStats() }
  touchMeter(id: string):  void { resourceManager.touchMeter(id) }

  getSleepStatus()          { return channelSleepSystem.getStatus() }
  getSleepingCount(): number { return channelSleepSystem.getSleepingCount() }
  wakeAllChannels():  void  { channelSleepSystem.wakeAll() }

  getLazyDSPStats()         { return lazyDSP.getStats() }

  getMulticoreProfile()     { return multicorePrep.generateProfile([...this._strips.keys()]) }
  buildThreadContracts()    { return multicorePrep.buildContracts() }

  getCacheStats()           { return cacheOptimizer.getStats() }

  getScalabilityReport() {
    if (!this._rawCtx) return null
    const benchmarks = runScalabilityBenchmark(
      this._rawCtx,
      (msg) => {},
      (key, fn) => cacheOptimizer.batchCommand(key, fn),
    )
    const profile = multicorePrep.generateProfile([...this._strips.keys()])
    const report  = generateScalabilityReport(
      benchmarks, profile,
      dspLoadBalancer.getMetrics(),
      resourceManager.getStats(),
      cacheOptimizer.getStats(),
    )
    printScalabilityReport(report)
    return report
  }

  private _exposePaso15API(ctx: AudioContext): void {
    ;(window as any).__ONA_PASO15 = {
      /** Performance mode */
      mode: {
        get:    ()                                   => { console.log(`[PASO 15] mode: ${performanceModes.mode} — ${performanceModes.config.description}`); return performanceModes.mode },
        set:    (m: 'studio' | 'live' | 'eco')      => { this.setPerformanceMode(m) },
        auto:   (on = true)                          => { this.enableAutoPerformance(on); console.log(`[PASO 15] auto-switch: ${on ? 'ON' : 'OFF'}`) },
        config: ()                                   => { console.table(performanceModes.config); return performanceModes.config },
      },

      /** Load balancer */
      lb: {
        metrics: () => { const m = this.getLoadBalancerMetrics(); console.table(m); return m },
        stage:   (s?: 'full'|'reduced'|'minimal'|'emergency') => {
          if (s) { this.forceLoadBalancerStage(s); console.log(`[PASO 15] LB stage forced: ${s}`) }
          return dspLoadBalancer.getStage()
        },
      },

      /** Resource manager */
      resources: () => { const s = this.getResourceStats(); console.table(s); return s },

      /** Channel sleep */
      sleep: {
        status:  () => { const s = this.getSleepStatus(); console.table(s); return s },
        count:   () => { console.log(`[PASO 15] sleeping: ${this.getSleepingCount()}/${this._strips.size}`); return this.getSleepingCount() },
        wakeAll: () => { this.wakeAllChannels(); console.log('[PASO 15] all channels woken') },
      },

      /** Lazy DSP registry */
      lazy: () => { const s = this.getLazyDSPStats(); console.table(s.byModule); console.log(`Estimated saved init: ${s.estimatedSavedMs}ms`); return s },

      /** Multicore preparation */
      multicore: {
        profile:   () => { const p = this.getMulticoreProfile(); console.table(p.channelGroups); console.log('Notes:', p.notes); return p },
        contracts: () => { const c = this.buildThreadContracts(); console.table(c.map(t => ({ group: t.groupId, channels: t.channels.length, commandSAB: t.commandSAB !== null, meterSAB: t.meterSAB !== null }))); return c },
      },

      /** Cache stats */
      cache: () => { const s = this.getCacheStats(); console.table(s.pool); console.log('Batch:', s.batch); console.log('SAB:', s.sabAudit); return s },

      /** Full scalability report + benchmark */
      report: () => this.getScalabilityReport(),
      bench:  () => (window as any).__ONA_SCALE_BENCH?.run(),

      help: () => {
        console.group('[PASO 15] Console API — Scalability + Performance')
        console.log('__ONA_PASO15.mode.get()                        — current performance mode')
        console.log('__ONA_PASO15.mode.set("studio"|"live"|"eco")   — set mode manually')
        console.log('__ONA_PASO15.mode.auto(true|false)             — enable CPU-based auto-switch')
        console.log('__ONA_PASO15.lb.metrics()                      — load balancer metrics')
        console.log('__ONA_PASO15.lb.stage("full"|"reduced"|...)    — force degradation stage')
        console.log('__ONA_PASO15.resources()                       — resource manager stats')
        console.log('__ONA_PASO15.sleep.status()                    — per-channel sleep state')
        console.log('__ONA_PASO15.sleep.count()                     — sleeping channel count')
        console.log('__ONA_PASO15.sleep.wakeAll()                   — wake all sleeping channels')
        console.log('__ONA_PASO15.lazy()                            — lazy DSP init savings')
        console.log('__ONA_PASO15.multicore.profile()               — core group assignments')
        console.log('__ONA_PASO15.multicore.contracts()             — thread contracts (future)')
        console.log('__ONA_PASO15.cache()                           — Float32Array pool + batch')
        console.log('__ONA_PASO15.report()                          — full scalability report')
        console.log('__ONA_PASO15.bench()                           — 96ch extreme benchmark')
        console.groupEnd()
      },
    }
    console.log('[ENGINE] Paso 15 scalability API ready — window.__ONA_PASO15')
  }

  // ── Control Surface (Paso 13) ────────────────────────────────────────────────

  private async _initControlSurface(): Promise<void> {
    // Wire control path (no circular deps — dispatcher is injected here)
    controlPath.setMapper(midiMapper)
    controlPath.setDispatcher((action: ControlAction) => this._dispatchControlAction(action))

    // Register motor fader channels for all strips
    for (const id of this._strips.keys()) {
      motorFaderManager.registerChannel(id)
    }

    // Motor fader callback → update DSP
    motorFaderManager.onMove((channelId, position) => {
      this.setChannelVolume(channelId, position)
    })

    // Initialize MIDI engine
    const midiOk = await midiEngine.initialize()

    if (midiOk) {
      // Subscribe MIDI messages to control path (hot path, no React)
      midiEngine.onMessage((msg) => controlPath.handleMessage(msg))

      // Register MIDI outputs for feedback
      for (const out of midiEngine.listOutputs()) {
        const midiOut = midiEngine.getOutput(out.id)
        if (midiOut) controlFeedback.addOutput(out.id, midiOut)
      }

      // Hotplug: when new output connects, register it and sync feedback state
      midiEngine.onDeviceChange((dev) => {
        if (dev.type === 'output' && dev.connected) {
          const midiOut = midiEngine.getOutput(dev.id)
          if (midiOut) {
            controlFeedback.addOutput(dev.id, midiOut)
            controlFeedback.syncAll()
          }
        } else if (dev.type === 'output' && !dev.connected) {
          controlFeedback.removeOutput(dev.id)
        }
      })

      // Load saved MIDI mappings from localStorage (persist across sessions)
      const saved = localStorage.getItem('ona_midi_mappings')
      if (saved) {
        midiMapper.deserialize(saved)
        console.log('[ENGINE] MIDI mappings restored from storage')
      }

      console.log(`[ENGINE] Control surface ready — ${midiEngine.listInputs().length} inputs`)
    } else {
      console.warn('[ENGINE] MIDI not available — control surface disabled')
    }

    exposeControlBenchAPI(midiEngine, controlPath, midiMapper)
    this._exposePaso13API()
  }

  /**
   * _dispatchControlAction — high-priority path from MIDI → DSP.
   * Called from ControlPath (no React in this path).
   * Also sends feedback to MIDI outputs.
   */
  private _dispatchControlAction(action: ControlAction): void {
    switch (action.type) {
      case 'channelVolume':
        this.setChannelVolume(action.channelId, action.value)
        controlFeedback.updateChannelVolume(action.channelId, action.value)
        motorFaderManager.setPosition(action.channelId, action.value)
        break
      case 'channelMute':
        this._strips.get(action.channelId)?.setVolume(
          stateEngine.getChannel(action.channelId)?.volume ?? 75, action.muted
        )
        stateEngine.patchChannel(action.channelId, { muted: action.muted })
        controlFeedback.updateChannelMute(action.channelId, action.muted)
        break
      case 'channelSolo':
        this.setChannelSolo(action.channelId, action.soloed, action.mode)
        controlFeedback.updateChannelSolo(action.channelId, action.soloed)
        break
      case 'channelPan':
        this.setChannelPan(action.channelId, action.value)
        break
      case 'channelAuxSend':
        this.setChannelAuxSend(action.channelId, action.auxId, { level: action.value })
        break
      case 'channelFxSend':
        this.setChannelFxBusSend(action.channelId, action.busId, { level: action.value })
        break
      case 'mainVolume':
        this.setMainVolume(action.value)
        controlFeedback.updateMainVolume(action.value)
        break
      case 'subVolume':
        this.setSubVolume(action.value)
        controlFeedback.updateSubVolume(action.value)
        break
      case 'fxBusActive':
        this.setFxBusActive(action.busId, action.active)
        break
      case 'sceneRecall':
        this.recallScene(action.sceneName)
        break
      case 'transport':
        if (action.action === 'play')  this.startVS()
        if (action.action === 'stop')  this.stopVS()
        if (action.action === 'pause') this.pauseVS()
        break
      case 'clearSolo':
        this.clearAllSolo()
        controlFeedback.clearAllSoloFeedback(this._strips.size)
        break
    }
  }

  // ── API pública — Control surface ─────────────────────────────────────────────

  getMidiDevices()           { return { inputs: midiEngine.listInputs(), outputs: midiEngine.listOutputs() } }
  getMidiMappings()          { return midiMapper.getRules() }
  addMidiMapping(rule: any)  { midiMapper.addRule(rule); this._saveMidiMappings() }
  removeMidiMapping(id: string) { midiMapper.removeRule(id); this._saveMidiMappings() }
  loadMidiTemplate(numCh: number) { midiMapper.loadGenericFaderTemplate(numCh); this._saveMidiMappings() }
  saveMidiProfile(name: string)   { midiMapper.saveProfile(name) }
  loadMidiProfile(name: string)   { const ok = midiMapper.loadProfile(name); if (ok) this._saveMidiMappings(); return ok }
  listMidiProfiles()         { return midiMapper.listProfiles() }
  getControlMetrics()        { return controlPath.getMetrics() }
  syncControlFeedback()      { controlFeedback.syncAll() }
  setFeedbackConfig(cfg: any) { controlFeedback.setConfig(cfg) }
  getMotorFaderStates()      { return motorFaderManager.getAllStates() }
  isMidiAvailable()          { return midiEngine.isAvailable() }

  private _saveMidiMappings(): void {
    try { localStorage.setItem('ona_midi_mappings', midiMapper.serialize()) } catch (_) {}
  }

  private _exposePaso13API(): void {
    ;(window as any).__ONA_PASO13 = {
      /** MIDI device and connection status */
      status: () => {
        console.group('[PASO 13] Control Surface Status')
        const { inputs, outputs } = this.getMidiDevices()
        console.log(`MIDI inputs  (${inputs.length}):`, inputs.map(d => `${d.name} [${d.connected ? 'connected' : 'disconnected'}]`))
        console.log(`MIDI outputs (${outputs.length}):`, outputs.map(d => `${d.name} [${d.connected ? 'connected' : 'disconnected'}]`))
        console.log('Control path:', controlPath.active ? 'ACTIVE' : 'inactive')
        const m = controlPath.getMetrics()
        console.log(`Metrics: processed=${m.processed} dropped=${m.dropped} latency=${m.avgLatencyMs}ms`)
        console.groupEnd()
      },

      /** MIDI mapping management */
      mapping: {
        list:    () => { console.table(midiMapper.getRules()); return midiMapper.getRules() },
        add:     (rule: any) => { this.addMidiMapping(rule); console.log('[PASO 13] mapping added:', rule.id) },
        remove:  (id: string) => { this.removeMidiMapping(id); console.log('[PASO 13] mapping removed:', id) },
        clear:   () => { midiMapper.clearRules(); this._saveMidiMappings(); console.log('[PASO 13] all mappings cleared') },
        template: (numCh = 6) => { this.loadMidiTemplate(numCh); console.log(`[PASO 13] generic template loaded (${numCh}ch)`) },
        save:    (name: string) => { midiMapper.saveProfile(name); console.log(`[PASO 13] profile "${name}" saved`) },
        load:    (name: string) => { const ok = this.loadMidiProfile(name); console.log(`[PASO 13] profile "${name}" ${ok ? 'loaded' : 'NOT FOUND'}`); return ok },
        profiles: () => { const p = midiMapper.listProfiles(); console.log('Profiles:', p); return p },
      },

      /** Feedback control */
      feedback: {
        sync: () => { controlFeedback.syncAll(); console.log('[PASO 13] feedback synced to all outputs') },
        config: (cfg: any) => { controlFeedback.setConfig(cfg); console.log('[PASO 13] feedback config updated') },
      },

      /** Motor fader status */
      faders: () => { console.table(motorFaderManager.getAllStates()); return motorFaderManager.getAllStates() },

      /** Metrics and report */
      metrics: () => { const m = controlPath.getMetrics(); console.table(m); return m },
      report:  () => generateControlReport(midiEngine, controlPath, midiMapper),
      bench:   () => (window as any).__ONA_CONTROL_BENCH?.run(),

      help: () => {
        console.group('[PASO 13] Console API — MIDI Control Surface')
        console.log('__ONA_PASO13.status()                         — MIDI I/O + metrics')
        console.log('__ONA_PASO13.mapping.list()                   — all active mappings')
        console.log('__ONA_PASO13.mapping.template(numChannels)    — load generic fader template')
        console.log('__ONA_PASO13.mapping.add(rule)                — add mapping rule')
        console.log('__ONA_PASO13.mapping.remove(id)               — remove mapping by id')
        console.log('__ONA_PASO13.mapping.save("name")             — save profile')
        console.log('__ONA_PASO13.mapping.load("name")             — load profile')
        console.log('__ONA_PASO13.feedback.sync()                  — sync LEDs + faders')
        console.log('__ONA_PASO13.faders()                         — motor fader states')
        console.log('__ONA_PASO13.metrics()                        — control path metrics')
        console.log('__ONA_PASO13.report()                         — full workflow report')
        console.log('__ONA_PASO13.bench()                          — control benchmark suite')
        console.log('')
        console.log('__ONA_CONTROL_BENCH.run()   — benchmark suite')
        console.log('__ONA_CONTROL_BENCH.flood() — 1000 msgs/s flood test')
        console.groupEnd()
      },
    }
    console.log('[ENGINE] Paso 13 control API ready — window.__ONA_PASO13')
  }

  private _exposePaso12API(ctx: AudioContext): void {
    // Create one DelayEngine and one ReverbEngine for benchmarking
    const benchDelay  = new DelayEngine(ctx)
    const benchReverb = new ReverbEngine(ctx)
    exposeFxBenchAPI(ctx, fxBusEngine, benchDelay, benchReverb)

    ;(window as any).__ONA_PASO12 = {
      /** FX bus status */
      status: () => {
        console.group('[PASO 12] FX Bus Status')
        fxBusEngine.getAllStates().forEach(b => {
          const db = fxBusEngine.getMeterValue(b.id)
          console.log(
            `  fxbus${b.id}: ${b.active ? 'ACTIVE' : 'off'} | ` +
            `processor=${b.processorType ?? 'none'} | wet=${b.wetLevel}% | ` +
            `${isFinite(db) ? db.toFixed(1) : '-∞'} dBFS`
          )
        })
        console.groupEnd()
      },

      /** Attach a processor to a bus */
      attach: (busId: number, type: 'delay' | 'reverb') => {
        this.attachFxProcessor(busId, type)
        console.log(`[PASO 12] fxbus${busId} ← ${type} processor attached`)
      },

      /** Detach current processor from a bus */
      detach: (busId: number) => {
        this.detachFxProcessor(busId)
        console.log(`[PASO 12] fxbus${busId} processor detached`)
      },

      /** Activate/deactivate a bus */
      activate: (busId: number, active = true) => {
        this.setFxBusActive(busId, active)
        console.log(`[PASO 12] fxbus${busId} ${active ? 'activated' : 'deactivated'}`)
      },

      /** Set wet return level */
      wet: (busId: number, level: number) => {
        this.setFxBusWetLevel(busId, level)
        console.log(`[PASO 12] fxbus${busId} wet = ${level}%`)
      },

      /** Set processor parameters */
      params: (busId: number, params: Record<string, number>) => {
        this.setFxProcessorParams(busId, params)
        console.log(`[PASO 12] fxbus${busId} params:`, params)
      },

      /** Channel FX bus send */
      send: (channelId: number, busId: number, level: number, preFader = true) => {
        this.setChannelFxBusSend(channelId, busId, { level, preFader, muted: level === 0 })
        console.log(`[PASO 12] ch${channelId} → fxbus${busId} ${level}% ${preFader ? 'pre' : 'post'}`)
      },

      /** CPU + stability benchmark */
      bench: () => (window as any).__ONA_FX_BENCH?.run(),

      help: () => {
        console.group('[PASO 12] Console API — FX Bus Engine')
        console.log('__ONA_PASO12.status()                          — FX bus overview')
        console.log('__ONA_PASO12.attach(busId, "delay"|"reverb")   — attach processor')
        console.log('__ONA_PASO12.detach(busId)                     — detach processor')
        console.log('__ONA_PASO12.activate(busId, true|false)       — activate/deactivate bus')
        console.log('__ONA_PASO12.wet(busId, level)                 — return level 0-100')
        console.log('__ONA_PASO12.params(busId, {roomSize, damping, predelay, wetLevel})')
        console.log('__ONA_PASO12.send(ch, bus, level, preFader)    — channel FX send')
        console.log('__ONA_PASO12.bench()                           — CPU + stability benchmark')
        console.log('')
        console.log('__ONA_FX_BENCH.run()    — full benchmark suite')
        console.log('__ONA_FX_BENCH.sends(n) — send throughput test')
        console.groupEnd()
      },
    }
    console.log('[ENGINE] Paso 12 FX API ready — window.__ONA_PASO12')
  }

  private _exposePaso11API(ctx: AudioContext): void {
    ;(window as any).__ONA_PASO11 = {
      /** Full production status report */
      report: () => productionReport.print(ctx),

      /** CPU mode management */
      cpu: {
        mode:    ()                                => { console.log('[PASO 11] CPU mode:', cpuSafetyMode.mode); return cpuSafetyMode.mode },
        set:     (mode: 'normal'|'low_cpu'|'safe') => { cpuSafetyMode.setMode(mode) },
        config:  ()                                => { console.table(cpuSafetyMode.config); return cpuSafetyMode.config },
      },

      /** Recovery system */
      recovery: {
        history: () => { console.table(safeRecovery.getHistory()); return safeRecovery.getHistory() },
        stats:   () => { const s = safeRecovery.getStats(); console.log('[SafeRecovery]', s); return s },
      },

      /** Node lifecycle audit */
      nodes: {
        report: (maxAgeMs?: number) => {
          const r = nodeValidator.getReport(maxAgeMs)
          console.group('[NodeLifecycle] Report')
          console.log(`Live nodes: ${r.liveCount}`)
          console.table(r.byType)
          if (r.potentialLeaks > 0) { console.warn(`⚠ ${r.potentialLeaks} potential leaks:`); console.table(r.leakDetails) }
          else console.log('✓ No potential leaks detected')
          console.groupEnd()
          return r
        },
        enable:  () => nodeValidator.enable(),
        disable: () => nodeValidator.disable(),
      },

      /** Stress test simulator */
      stress: async (hours: 4|8|12 = 4) => {
        console.log(`[StressTest] Running ${hours}h simulation…`)
        const result = await stressTest.run(this, { simulatedHours: hours })
        console.table(result)
        return result
      },

      /** Production metrics snapshot */
      snapshot: () => productionReport.generate(ctx),

      help: () => {
        console.group('[PASO 11] Console API — Production Stability')
        console.log('__ONA_PASO11.report()                          — full production report')
        console.log('__ONA_PASO11.cpu.mode()                        — current CPU mode')
        console.log('__ONA_PASO11.cpu.set("normal"|"low_cpu"|"safe")— set CPU mode')
        console.log('__ONA_PASO11.recovery.history()                — recovery event log')
        console.log('__ONA_PASO11.recovery.stats()                  — recovery summary')
        console.log('__ONA_PASO11.nodes.report()                    — AudioNode lifecycle')
        console.log('__ONA_PASO11.stress(4|8|12)                    — stress test (hours)')
        console.log('__ONA_PASO11.snapshot()                        — raw metrics JSON')
        console.groupEnd()
      },
    }
    console.log('[ENGINE] Paso 11 stability API ready — window.__ONA_PASO11')
  }

  private _exposePaso10API(ctx: AudioContext): void {
    ;(window as any).__ONA_PASO10 = {
      status: () => {
        console.group('[PASO 10] Multitrack I/O Status')
        const latency = latencyMeasurement.measure(recordingClock.getDriftPpm())
        console.log(`Latency:    base=${latency.baseLatencyMs.toFixed(2)}ms  output=${latency.outputLatencyMs.toFixed(2)}ms  total=${latency.totalLatencyMs.toFixed(2)}ms`)
        console.log(`Buffer:     ${latency.bufferFrames} frames @ ${latency.sampleRate}Hz  stable=${latency.stable}  drift=${latency.driftPpm.toFixed(1)}ppm`)
        const stats = multitrackRecorder.getStats()
        console.log('Recording:', stats.active ? `ACTIVE session ${stats.session?.id}` : 'idle')
        if (stats.active) {
          console.log(`  Buffer:  xruns=${stats.buffer.xruns}  dropped=${stats.buffer.droppedFrames}  stability=${stats.buffer.stability}`)
          console.log(`  Queue:   written=${stats.queue.written}B  dropped=${stats.queue.dropped}B`)
        }
        const pb = multitrackPlayer
        console.log(`Playback:  ${pb.playing ? 'PLAYING' : 'stopped'}  pos=${pb.position.toFixed(2)}s / ${pb.duration.toFixed(2)}s  channels=[${pb.loadedChannels().join(',')}]`)
        console.groupEnd()
      },

      rec: {
        start: async (channels?: number[]) => {
          const id = await this.startMultitrackRec(channels)
          console.log(`[PASO 10] Recording started → session ${id}`)
          return id
        },
        stop: async () => {
          const result = await this.stopMultitrackRec()
          console.log('[PASO 10] Recording stopped')
          console.log('  Files:    ', result.files)
          console.log('  Stability:', result.stats.stability)
          console.log('  XRuns:    ', result.stats.xruns)
          console.log('  Drift:    ', result.driftPpm.toFixed(1), 'ppm')
          return result
        },
        stats: () => console.table(multitrackRecorder.getStats()),
      },

      play: {
        load:  (channelId: number, filePath: string) => this.loadPlaybackTrack(channelId, filePath),
        start: (offset?: number) => { this.startPlayback(offset); console.log('[PASO 10] Playback start') },
        stop:  () => { this.stopPlayback();  console.log('[PASO 10] Playback stop')  },
        pause: () => { this.pausePlayback(); console.log('[PASO 10] Playback pause') },
        seek:  (s: number) => { this.seekPlayback(s); console.log(`[PASO 10] Seek → ${s}s`) },
        state: () => { console.table(this.getPlaybackState()); return this.getPlaybackState() },
      },

      latency: () => {
        const r = this.getMeasuredLatency()
        console.table(r)
        return r
      },

      sessions: async () => {
        const list = await this.listRecordingSessions()
        console.table(list)
        return list
      },

      help: () => {
        console.group('[PASO 10] Console API')
        console.log('__ONA_PASO10.status()                    — I/O overview')
        console.log('__ONA_PASO10.rec.start([channels])       — start multitrack recording')
        console.log('__ONA_PASO10.rec.stop()                  — stop + finalize WAV files')
        console.log('__ONA_PASO10.rec.stats()                 — buffer + queue stats')
        console.log('__ONA_PASO10.play.load(ch, filePath)     — load WAV track for channel')
        console.log('__ONA_PASO10.play.start(offsetSeconds?)  — start playback')
        console.log('__ONA_PASO10.play.stop/pause/seek(s)     — transport control')
        console.log('__ONA_PASO10.play.state()                — playback state')
        console.log('__ONA_PASO10.latency()                   — measured I/O latency')
        console.log('__ONA_PASO10.sessions()                  — list recorded sessions')
        console.groupEnd()
      },
    }
    console.log('[ENGINE] Paso 10 I/O API ready — window.__ONA_PASO10')
  }

  // ── API pública — master ──────────────────────────────────────────────────────

  setMainVolume(v: number): void {
    this._busEngine.setMainVolume(v)
    stateEngine.patchBuses({ mainVolume: v })
  }

  setSubVolume(v: number): void {
    this._busEngine.setSubVolume(v)
    stateEngine.patchBuses({ subVolume: v })
  }

  setGlobalReverb(params: { active?: boolean; decay?: number; preDelay?: number } = {}): void {
    const r = this._gfx.reverb; if (!r) return
    if (params.active   !== undefined) r.wet.rampTo(params.active ? 1 : 0, 0.05)
    if (params.preDelay !== undefined) r.preDelay = params.preDelay / 1000
    if (params.decay !== undefined && params.decay > 0) this._scheduleReverbDecay(params.decay)
    const ch = stateEngine.getSnapshot().fx
    stateEngine.patchFx('reverb', { ...ch.reverb, ...params })
  }

  private _scheduleReverbDecay(decay: number): void {
    if (this._reverbGenerating) { this._reverbDecayPending = decay; return }
    // Defer to next event loop turn so the current RAF frame is never blocked.
    // Tone.Reverb IR generation (OfflineAudioContext) is async but has synchronous
    // setup cost; this keeps init and first-frame rendering spike-free.
    setTimeout(() => this._applyReverbDecay(decay), 0)
  }

  private _applyReverbDecay(decay: number): void {
    this._reverbGenerating = true
    this._gfx.reverb.decay = decay
    const wait = Math.max(600, decay * 1000 * 2)
    setTimeout(() => {
      this._reverbGenerating = false
      if (this._reverbDecayPending !== null) {
        const next = this._reverbDecayPending
        this._reverbDecayPending = null
        this._applyReverbDecay(next)
      }
    }, wait)
  }

  setGlobalDelay(params: { active?: boolean; time?: number; feedback?: number } = {}): void {
    const d = this._gfx.delay; if (!d) return
    if (params.active   !== undefined) d.wet.rampTo(params.active ? 1 : 0, 0.05)
    if (params.time     !== undefined) d.delayTime.rampTo(params.time / 1000, 0.02)
    if (params.feedback !== undefined) d.feedback.rampTo(params.feedback / 100, 0.02)
    const ch = stateEngine.getSnapshot().fx
    stateEngine.patchFx('delay', { ...ch.delay, ...params })
  }

  setFxReturn(params: { volume?: number; muted?: boolean } = {}): void {
    const vol = params.volume ?? 80
    this._gfx.returnFader?.volume.rampTo(params.muted ? -Infinity : 20 * Math.log10(vol / 100), 0.02)
    const ch = stateEngine.getSnapshot().fx
    stateEngine.patchFx('fxReturn', { ...ch.fxReturn, ...params })
  }

  // ── Scenes (Paso 5) ──────────────────────────────────────────────────────────

  saveScene(name: string): void {
    sceneManager.save(name)
    console.log(`[ENGINE] Escena guardada: "${name}"`)
  }

  /**
   * recallScene — safe scene recall:
   *   1. prepareRecall → gets snapshot for rollback + target
   *   2. dspParamMgr.applySceneState → smooth DSP parameter update (no node recreation)
   *   3. stateEngine.applySnapshot → update source of truth
   */
  recallScene(name: string): boolean {
    const snapshot = sceneManager.prepareRecall(name)
    if (!snapshot) return false

    // Apply DSP (smooth, no clicks, no node recreation)
    dspParamMgr.applySceneState(this._strips, snapshot)

    // Apply buses
    const { buses, fx } = snapshot
    if (buses) {
      this._busEngine.setMainVolume(buses.mainVolume)
      this._busEngine.setSubVolume(buses.subVolume)
    }
    // Apply FX (reverb decay is async — skip to avoid audio artifacts during recall)
    if (fx) {
      if (fx.reverb.active !== undefined) this._gfx.reverb?.wet.rampTo(fx.reverb.active ? 1 : 0, 0.1)
      if (fx.delay.active  !== undefined) this._gfx.delay?.wet.rampTo(fx.delay.active   ? 1 : 0, 0.1)
      const fxVol = fx.fxReturn?.volume ?? 80
      this._gfx.returnFader?.volume.rampTo(
        fx.fxReturn?.muted ? -Infinity : 20 * Math.log10(fxVol / 100), 0.05
      )
    }

    // Update state engine (source of truth)
    stateEngine.applySnapshot(snapshot)
    console.log(`[ENGINE] Escena cargada: "${name}"`)
    return true
  }

  rollbackScene(): boolean {
    const prev = sceneManager.getRollbackSnapshot()
    if (!prev) { console.warn('[ENGINE] Sin escena anterior para rollback'); return false }

    dspParamMgr.applySceneState(this._strips, prev)
    stateEngine.applySnapshot(prev)
    sceneManager.clearRollback()
    console.log('[ENGINE] Rollback de escena aplicado')
    return true
  }

  listScenes() { return sceneManager.list() }
  deleteScene(name: string): boolean { return sceneManager.delete(name) }

  // ── State snapshot ────────────────────────────────────────────────────────────

  getSnapshot(): EngineSnapshot { return stateEngine.getSnapshot() as EngineSnapshot }

  // ── Projects / persistence ────────────────────────────────────────────────────

  saveProject(name: string): boolean { return persistenceEngine.saveProject(name) }
  loadProject(name: string): EngineSnapshot | null { return persistenceEngine.loadProject(name) }
  listProjects() { return persistenceEngine.listProjects() }

  /**
   * restoreFromSnapshot — apply a persisted snapshot to DSP + stateEngine.
   * Used for crash recovery and project load.
   */
  restoreFromSnapshot(snapshot: EngineSnapshot): void {
    dspParamMgr.applySceneState(this._strips, snapshot)
    const { buses, fx } = snapshot
    if (buses) {
      this._busEngine.setMainVolume(buses.mainVolume)
      this._busEngine.setSubVolume(buses.subVolume)
    }
    if (fx) {
      this.setGlobalReverb(fx.reverb)
      this.setGlobalDelay(fx.delay)
      this.setFxReturn(fx.fxReturn)
    }
    stateEngine.applySnapshot(snapshot)
  }

  // ── Meter ─────────────────────────────────────────────────────────────────────

  getMeterBuffer(): Float32Array { return this._meteringEngine.getBuffer() }

  onMeterUpdate(cb: MeterCallback): () => void {
    return this._meteringEngine.onUpdate(cb)
  }

  // ── Grabación ─────────────────────────────────────────────────────────────────

  startRecording(mode = 'procesado'): void {
    this.stopRecording().catch(() => {})

    if (mode === 'crudo' || mode === 'ambos') {
      const raw: any[] = []
      for (const [id, strip] of this._strips) {
        const rec = new Tone.Recorder()
        try {
          strip.inputGain.connect(rec)
          rec.start()
          raw.push({ id, rec })
        } catch (err) {
          console.error(`[ENGINE] Recorder raw ch${id}:`, err)
          try { rec.dispose() } catch (_) {}
        }
      }
      this._recRaw = raw
    }

    if (mode === 'procesado' || mode === 'ambos') {
      const rec = new Tone.Recorder()
      try {
        this._busEngine.getBus('main')!.fader.connect(rec)
        rec.start()
        this._recMain = rec
      } catch (err) {
        console.error('[ENGINE] Recorder main:', err)
        try { rec.dispose() } catch (_) {}
      }
    }
  }

  async stopRecording(): Promise<Record<string, Blob>> {
    const blobs: Record<string, Blob> = {}
    if (this._recMain) {
      try { blobs.main = await this._recMain.stop() } catch (_) {}
      try { this._recMain.dispose() } catch (_) {}
      this._recMain = null
    }
    for (const { id, rec } of this._recRaw) {
      try { blobs[`raw_${id}`] = await rec.stop() } catch (_) {}
      try { rec.dispose() } catch (_) {}
    }
    this._recRaw = []
    return blobs
  }

  // ── Virtual Soundcheck ────────────────────────────────────────────────────────

  async loadVSTrack(channelId: number, fileUrl: string): Promise<boolean> {
    const prev = this._vsPlayers.get(channelId)
    if (prev) {
      try { prev.stop(); prev.unsync() }       catch (_) {}
      try { prev.disconnect(); prev.dispose() } catch (_) {}
      this._vsPlayers.delete(channelId)
    }
    const strip = this._strips.get(channelId)
    if (!strip) { console.error(`[ENGINE] loadVSTrack: canal ${channelId} no existe`); return false }

    const player = new Tone.Player({ url: fileUrl, loop: true })
    try {
      await Tone.loaded()
      player.connect(strip.inputGain)
      player.sync().start(0)
      this._vsPlayers.set(channelId, player)
      return true
    } catch (err) {
      console.error(`[ENGINE] loadVSTrack ch${channelId}:`, err)
      try { player.disconnect(); player.dispose() } catch (_) {}
      return false
    }
  }

  startVS(): void  { Tone.Transport.start() }
  stopVS(): void   { Tone.Transport.stop(); Tone.Transport.position = 0 }
  pauseVS(): void  { Tone.Transport.pause() }
  getVSPlayerIds(): number[] { return Array.from(this._vsPlayers.keys()) }

  // ── MediaStream (hardware input) ──────────────────────────────────────────────

  connectMediaStream(channelId: number, mediaStream: MediaStream): void {
    const strip = this._strips.get(channelId); if (!strip) return

    const prev = this._mediaSources.get(channelId)
    if (prev) { try { prev.disconnect() } catch (_) {} }

    const nativeCtx = (Tone.context as any).rawContext as AudioContext
    const src = nativeCtx.createMediaStreamSource(mediaStream)
    // inputGain is native GainNode in Phase 2 — direct connect ✓
    // In fallback (Tone.Gain), uses .input extraction
    if (strip.inputGain instanceof AudioNode) {
      src.connect(strip.inputGain)
    } else {
      src.connect((strip.inputGain as any).input ?? strip.inputGain)
    }
    this._mediaSources.set(channelId, src)
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const engineSingleton = AudioEngineSingleton.getInstance()
export default engineSingleton
