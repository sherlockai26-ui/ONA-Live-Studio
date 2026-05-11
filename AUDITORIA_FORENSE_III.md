# ONA LIVE STUDIO
# AUDITORÍA FORENSE ULTRA-DETALLADA — POST FIX3
# Generado: 2026-05-10

---

## ÍNDICE

1. [Mapa Completo del Filesystem](#1-mapa-completo-del-filesystem)
2. [Secuencia de Boot Exacta](#2-secuencia-de-boot-exacta)
3. [Auditoría AudioContext y DSP](#3-auditoría-audiocontext-y-dsp)
4. [Auditoría AudioWorklet y SAB](#4-auditoría-audioworklet-y-sab)
5. [Auditoría Runtime — Loops y Listeners](#5-auditoría-runtime--loops-y-listeners)
6. [Auditoría React y Zustand](#6-auditoría-react-y-zustand)
7. [Auditoría Electron](#7-auditoría-electron)
8. [Auditoría Networking](#8-auditoría-networking)
9. [Auditoría Estado y Escenas](#9-auditoría-estado-y-escenas)
10. [Auditoría Memoria y Cleanup](#10-auditoría-memoria-y-cleanup)
11. [Mapa de Contaminación Legacy](#11-mapa-de-contaminación-legacy)
12. [Sistemas de Escalabilidad — Estado Real](#12-sistemas-de-escalabilidad--estado-real)
13. [Mapa de Riesgos Críticos](#13-mapa-de-riesgos-críticos)
14. [Evaluación Arquitectónica Final](#14-evaluación-arquitectónica-final)

---

## 1. MAPA COMPLETO DEL FILESYSTEM

### 1.1 Inventario Total

| Directorio | Archivos | Descripción |
|---|---|---|
| `electron/` | 2 | Main process + Preload |
| `native/src/` | 6 | Rust DSP engine (sin compilar) |
| `public/worklets/` | 4 | AudioWorklet processors |
| `src/audio/core/` | 27 | Motor DSP central |
| `src/audio/fx/` | 5 | Efectos (Delay, Reverb) |
| `src/audio/hardware/` | 4 | HAL + DeviceManager |
| `src/audio/native/` | 4 | NativeDSPBridge + fallback |
| `src/audio/recording/` | 8 | Grabación multitrack |
| `src/audio/scalability/` | 9 | Balanceo de carga DSP |
| `src/audio/state/` | 3 | StateEngine, SceneManager, Persistence |
| `src/audio/` | 2 | audioEngine.js (facade) + AudioBridge.ts |
| `src/components/` | 12 | Componentes React legacy |
| `src/control/` | 6 | MIDI + ControlSurface |
| `src/hooks/` | 2 | useDevices.js, useScenes.js |
| `src/live/` | 8 | SceneEngine, DCA, Show, Transitions |
| `src/network/client/` | 5 | NetworkClient, comandos, métricas |
| `src/network/server/` | 7 | NetworkServer, sync, discovery |
| `src/server/` | 1 | Entry point del servidor |
| `src/services/` | 3 | Servicios legacy/bridge |
| `src/store/` | 1 | Zustand mixerStore |
| `src/ui/` | 10 | ConsoleUI profesional |
| `src/utils/` | 2 | audioUtils.js, wavEncoder.js |
| **TOTAL** | **~130** | |

### 1.2 Clasificación de Archivos

#### A) CRÍTICO RUNTIME (rompe todo si falla)
| Archivo | Rol |
|---|---|
| `electron/main.cjs` | Entry point Electron |
| `electron/preload.cjs` | Bridge IPC seguro |
| `src/main.jsx` | Bootstrap React |
| `src/App.jsx` | Orchestrador principal |
| `src/store/mixerStore.js` | Estado global Zustand |
| `src/audio/audioEngine.js` | Facade API de audio |
| `src/audio/AudioBridge.ts` | Bridge UI → DSP |
| `src/audio/core/AudioEngineSingleton.ts` | Motor DSP singleton |
| `src/audio/core/DSPGraphEngine.ts` | Grafo de nodos |
| `src/audio/core/ChannelStrip.ts` | Cadena DSP por canal |
| `src/audio/core/BusEngine.ts` | Buses main/sub |
| `src/audio/core/WorkletManager.ts` | Gestión AudioWorklets |
| `src/audio/core/MeteringEngine.ts` | Medición de niveles |
| `public/worklets/ona-dsp-processor.js` | Gate en audio thread |
| `public/worklets/ona-meter-processor.js` | Medición en audio thread |
| `src/services/deviceService.js` | Detección hardware |
| `src/services/scenesService.js` | IPC escenas |
| `src/hooks/useDevices.js` | Hook dispositivos |

#### B) ACTIVO (usado, no crítico directo)
| Archivo | Rol |
|---|---|
| `src/audio/core/AuxBusEngine.ts` | 8 buses auxiliares |
| `src/audio/core/SubgroupEngine.ts` | 4 subgrupos |
| `src/audio/core/CueBus.ts` | Bus de monitoreo |
| `src/audio/core/RoutingMatrix.ts` | Matriz 15×8 |
| `src/audio/core/DSPCommandBus.ts` | SAB ring buffer |
| `src/audio/core/DSPScheduler.ts` | Profiling de drift |
| `src/audio/core/DSPWatchdog.ts` | Health monitor |
| `src/audio/core/SafeRecoverySystem.ts` | Recuperación de fallos |
| `src/audio/core/CPUSafetyMode.ts` | Modo seguro adaptativo |
| `src/audio/core/GainStaging.ts` | Ganancia de escena |
| `src/audio/core/MixBusProtection.ts` | Soft-sat + limiter |
| `src/audio/core/LoudnessMeter.ts` | LUFS ITU-R |
| `src/audio/core/PanLaw.ts` | Ley de paneo |
| `src/audio/fx/FxBusEngine.ts` | 4 buses FX |
| `src/audio/fx/DelayEngine.ts` | Delay estéreo |
| `src/audio/fx/ReverbEngine.ts` | Reverb Freeverb-lite |
| `src/audio/fx/FxCpuProtection.ts` | Clamp feedback |
| `src/audio/hardware/HardwareAbstractionLayer.ts` | HAL dispositivos |
| `src/audio/hardware/DeviceManager.ts` | Hot swap |
| `src/audio/hardware/NativeBridge.ts` | ASIO/WASAPI/CoreAudio probe |
| `src/audio/native/NativeDSPBridge.ts` | Puente Rust/fallback |
| `src/audio/native/WebAudioDSPFallback.ts` | Fallback WebAudio |
| `src/audio/recording/AudioCapture.ts` | Captura worklet |
| `src/audio/recording/MultitrackRecorder.ts` | Sesiones multitrack |
| `src/audio/recording/DiskStreamingQueue.ts` | Cola IPC→disco |
| `src/audio/recording/WavEncoder.ts` | Codificador Int24 |
| `src/audio/state/StateEngine.ts` | Estado canónico DSP |
| `src/audio/state/SceneManager.ts` | Escenas nombradas |
| `src/audio/state/PersistenceEngine.ts` | Autosave + recovery |
| `src/live/SceneEngine.ts` | Orquestador de recalls |
| `src/live/TransitionEngine.ts` | Ramps pop-free |
| `src/live/DCAEngine.ts` | 8 DCAs + mute groups |
| `src/live/ChannelSafeSystem.ts` | Canales safe |
| `src/live/ShowFileEngine.ts` | Show file completo |
| `src/live/RemoteSyncBridge.ts` | Sync remoto seq-locked |
| `src/live/RecallValidator.ts` | Validación pre-recall |
| `src/network/server/NetworkServer.js` | Socket.IO server |
| `src/network/server/CommandRouter.js` | Enrutado prioritario |
| `src/network/server/DeltaStateSync.js` | Delta de estado |
| `src/network/server/MeterBroadcaster.js` | Broadcast adaptativo |
| `src/network/server/ClientManager.js` | Gestión clientes |
| `src/network/server/DiscoveryServer.js` | mDNS + UDP |
| `src/network/client/NetworkClient.ts` | Cliente completo |
| `src/network/client/CommandChannel.ts` | Envío priorizado |
| `src/network/client/MeterSubscriber.ts` | Recepción métricas |
| `src/network/client/DiscoveryClient.ts` | Auto-descubrimiento |
| `src/control/MidiEngine.ts` | WebMIDI |
| `src/control/ControlPath.ts` | Hot path rate-limited |
| `src/control/MidiMapper.ts` | CC→parámetro |
| `src/control/ControlFeedback.ts` | Faders motorizados |
| `src/control/MotorFaderManager.ts` | Gestión motores |
| `src/ui/ConsoleLayout.tsx` | Layout adaptativo 4 breakpoints |
| `src/ui/ConsoleMeter.tsx` | Medidor canvas |
| `src/ui/ProFader.tsx` | Fader pointer events |
| `src/ui/VirtualChannelList.tsx` | Lista virtualizada |
| `src/ui/RenderScheduler.ts` | RAF unificado prioridades |
| `src/ui/UILayerManager.ts` | Registro de capas |
| `src/ui/UIFailsafe.ts` | Adaptación FPS |
| `src/utils/audioUtils.js` | Matemáticas EQ/curva |
| `src/components/Channel.jsx` | Canal principal |
| `src/components/ChannelMeter.jsx` | Medidor por canal |
| `src/components/MasterBus.jsx` | Bus master |
| `src/components/EQPanel.jsx` | Panel EQ 7 bandas |
| `src/components/CompPanel.jsx` | Panel compresor |
| `src/components/GatePanel.jsx` | Panel gate |
| `src/components/FXRack.jsx` | Rack efectos |
| `src/components/SceneManager.jsx` | Panel escenas |
| `src/components/Recorder.jsx` | Panel grabación |
| `src/components/VirtualSoundcheck.jsx` | Virtual soundcheck |

#### C) LEGACY COMPATIBLE (presentes, funcionales, reemplazados)
| Archivo | Reemplazado Por | Riesgo |
|---|---|---|
| `src/utils/wavEncoder.js` | `src/audio/recording/WavEncoder.ts` | P1 — activo en path legacy (Recorder.jsx) |
| `src/audio/hardware/ToneJsAudit.ts` | ─ | P2 — herramienta de auditoría interna |

#### D) EXPERIMENTAL / PARCIALMENTE DESCONECTADO
| Archivo | Estado | Detalle |
|---|---|---|
| `src/audio/scalability/DSPLoadBalancer.ts` | **DECLARADO, NO LLAMADO** | schedule() no tiene callers en la base de código |
| `src/audio/scalability/LazyDSPRegistry.ts` | **DECLARADO, NO LLAMADO** | ensureInit() no tiene callers |
| `src/audio/scalability/ChannelSleepSystem.ts` | **DECLARADO, CALLBACKS NO INYECTADOS** | onSleep/onWake sin wirear a DSP |
| `src/audio/scalability/ResourceManager.ts` | **DECLARADO, isMeterSuspended NO CONSULTADO** | La flag existe pero nadie la lee |
| `src/audio/scalability/PerformanceModes.ts` | **DECLARADO, onModeChange SIN WIRING** | Modo cambia pero subsistemas no responden |
| `src/audio/core/NodeLifecycleValidator.ts` | Solo en tests/benchmarks | No en path de producción |
| `src/audio/core/DSPTestSignal.ts` | Solo en tests | No en producción |
| `src/audio/core/DSPObjectPool.ts` | Declarado, uso no confirmado | Pool sin callers visibles |
| `src/audio/core/DSPParameterManager.ts` | Instanciado en Singleton | Uso activo no confirmado |
| `src/audio/core/DSPBenchmarkRunner.ts` | Solo benchmarks | No en producción |
| `src/audio/core/ClockManager.ts` | Instanciado, uso parcial | Métricas disponibles |
| `native/src/` | **SIN COMPILAR** | Código Rust sin binario .node |

#### G) MUERTO / SIN USAR
| Archivo | Evidencia | Riesgo |
|---|---|---|
| `src/services/syncService.js` | **Cero imports.** Header dice `@deprecated`. Reemplazado por NetworkClient.ts | P2 — dead code puro |
| `src/hooks/useScenes.js` | **Cero imports.** SceneManager.jsx importa sceneEngine directamente | P2 — dead code puro |

#### H) BENCHMARK / TESTING ÚNICAMENTE
| Archivo |
|---|
| `src/audio/core/DSPBenchmarkRunner.ts` |
| `src/audio/core/ProductionStressTest.ts` |
| `src/audio/core/ProductionReport.ts` |
| `src/audio/core/MixEngineReport.ts` |
| `src/audio/fx/FxBenchmark.ts` |
| `src/audio/scalability/ScalabilityBenchmark.ts` |
| `src/audio/scalability/ScalabilityReport.ts` |
| `src/audio/native/NativeDSPBenchmark.ts` |
| `src/control/ControlBenchmark.ts` |
| `src/network/client/NetworkBenchmark.ts` |
| `src/network/client/NetworkReport.ts` |
| `src/network/server/NetworkBenchmark.js` |
| `src/live/LiveBenchmark.ts` |
| `src/live/LiveReport.ts` |
| `src/ui/UIBenchmark.ts` |
| `src/ui/UIReport.ts` |

---

## 2. SECUENCIA DE BOOT EXACTA

```
Phase 0: Electron Main (electron/main.cjs)
  ├─ process.on('uncaughtException') / ('unhandledRejection') → writeCrashLog()
  ├─ --disable-gpu, --disable-gpu-compositing, --disable-gpu-rasterization
  ├─ enable-features=SharedArrayBufferOnDesktop
  ├─ app.on('web-contents-created') → handler de restricción de navegación
  └─ app.whenReady() → createWindow()
        ├─ BrowserWindow({ contextIsolation:true, nodeIntegration:false, preload })
        ├─ session.defaultSession.webRequest → CSP + COOP/COEP headers
        ├─ session.defaultSession.setPermissionRequestHandler → allow media/audioCapture
        ├─ win.loadURL('http://localhost:5173') [dev] o file://dist [prod]
        ├─ win.webContents.on('render-process-gone') → writeCrashLog [NO auto-reload]
        └─ win.webContents.on('crashed') → writeCrashLog

Phase 1: Preload (electron/preload.cjs)
  ├─ SAFE_MODE detectado via --safe-mode CLI flag
  ├─ window.ona = { version, platform, safeMode }
  ├─ window.electronAPI = { saveRecording, getRecordingsDir, saveScene, listScenes,
  │                          loadScene, deleteScene, showOpenDialog, crashLog, probeNativeAudio }
  ├─ window.onaRecording = { createSession, writeChunk, finalizeSession,
  │                           listSessions, loadFile }
  └─ window.onaNative = [CONDICIONAL si .node compilado existe]
        ├─ Intenta cargar: ona-dsp-engine.{platform}-{arch}-{abi}.node
        ├─ Si CARGA: expone engineVersion, createProcessor, processBlock, processShared...
        └─ Si FALLA: window.onaNative = undefined → NativeDSPBridge usa WebAudioDSPFallback

Phase 2: HTML → src/main.jsx
  ├─ window.onerror / window.onunhandledrejection → window.electronAPI.crashLog()
  ├─ SAFE_MODE: detectado (prioridad: window.ona.safeMode > ?safeMode=1 > localStorage)
  ├─ Si NO SAFE_MODE: expone __ONA_UI_BENCH, __ONA_LIVE_BENCH, __ONA_NET_BENCH
  ├─ ErrorBoundary wrapper
  └─ ReactDOM.createRoot.render(<ErrorBoundary><App/></ErrorBoundary>)

Phase 3: App.jsx monta
  ├─ useMixerStore() inicializado (Zustand, 6 canales default)
  ├─ useDevices() hook → enumerateAudioDevices() [SIN getUserMedia aún]
  ├─ [useEffect #1 — primer click del usuario]
  │     ├─ Si SAFE_MODE: return early (sin audio)
  │     ├─ audioEngine.initialize(channels.length, store.getState())
  │     │     └─ [Ver Phase 4]
  │     ├─ sceneEngine.setApplyDSPCallback(snapshot => {
  │     │     audioEngine.applyEngineSnapshot(snapshot)
  │     │     useMixerStore.getState().loadFullState({...})
  │     │   })
  │     ├─ uiFailsafe.start() [arranca polling FPS cada 1s]
  │     └─ refreshDeviceLabels() [enumerateDevices con contexto Tone.js activo]
  └─ [useEffect #2 — espera engineReady]
        ├─ audioEngine.setSyncCallback(cb) [previene echo en sync remoto]
        ├─ networkClient.onCommand(cmd => {...}) [subscripción comandos remotos]
        ├─ networkClient.onStateSync(snap => {...}) [recall remoto]
        └─ networkClient.connectAuto() [auto-descubrimiento LAN]

Phase 4: audioEngine.initialize() [AudioEngineSingleton]
  ├─ Tone.start() → AudioContext creado via standardized-audio-context
  ├─ rawCtx = Tone.context.rawContext [ÚNICO AudioContext en todo el sistema]
  ├─ DSPGraphEngine instanciado
  ├─ BusEngine (main + sub) → 6 nodos total
  ├─ ChannelStrip × N → ~18 nodos/canal (HPF→LPF→Gate→Comp→EQ×7→Pan→Fader→Routing)
  ├─ MeteringEngine → RAF loop + SAB 128 floats
  ├─ PerformanceMonitor.start()
  ├─ ClockManager
  ├─ HardwareAbstractionLayer → DeviceManager (hot swap listeners)
  ├─ NativeBridge (ASIO/WASAPI/CoreAudio probe)
  ├─ WorkletManager.initialize(rawCtx)
  │     ├─ addModule('./worklets/ona-meter-processor.js')
  │     ├─ addModule('./worklets/ona-dsp-processor.js')
  │     ├─ addModule('./worklets/ona-router-processor.js')
  │     └─ [FALLO → catch, continúa en modo main-thread gate]
  ├─ DSPScheduler
  ├─ DSPCommandBus (SAB ring buffer)
  ├─ StateEngine (estado canónico)
  ├─ DSPParameterManager
  ├─ SceneManager (localStorage)
  ├─ PersistenceEngine.startAutosave() [setInterval 30s]
  ├─ DSPWatchdog.start() [setInterval 250ms]
  ├─ NativeDSPBridge → detecta window.onaNative → usa Rust o WebAudioDSPFallback
  ├─ AuxBusEngine (8) → 24 nodos
  ├─ SubgroupEngine (4) → 20 nodos
  ├─ CueBus → 3 nodos
  ├─ RoutingMatrix (15 fuentes × 8 destinos, lazy cells)
  ├─ MultitrackRecorder, MultitrackPlayer, LatencyMeasurement
  ├─ BufferManager, RecordingClock
  ├─ SafeRecoverySystem.start() [listener 'statechange' + xrun interval]
  ├─ CPUSafetyMode.startAutoDetect() [setInterval]
  ├─ FxBusEngine (4) + DelayEngine + ReverbEngine → ~51 nodos FX
  ├─ GainStaging, MixBusProtection, LoudnessMeter, PanLaw
  ├─ DSPLoadBalancer, ResourceManager, ChannelSleepSystem, LazyDSPRegistry [declarados]
  ├─ MidiEngine (requestMIDIAccess), MidiMapper, ControlPath, ControlFeedback, MotorFaderManager
  └─ PerformanceMonitor.start(), engineSingleton.initialized = true → callback → App.setEngineReady(true)

Phase 5: React render completo
  ├─ ConsoleLayout monta → VirtualChannelList → 6× Channel
  ├─ Cada Channel monta → ConsoleMeter + ProFader
  ├─ ConsoleMeter.useEffect → uiLayerManager.register('metering', cb, CRITICAL)
  ├─ uiLayerManager → renderScheduler.start() [UN RAF loop global]
  └─ UIFailsafe polling activo

Phase 6: Red (si servidor disponible)
  ├─ DiscoveryClient.discover() → prueba 192.168.x.x:3000, 10.x.x.x:3000
  ├─ Si encontrado: NetworkClient crea 3 sockets (/ctrl, /sync, /meters)
  └─ Si NO encontrado: modo standalone (sin error)
```

**Qué queda vivo tras el boot:**
- 1× RAF loop (renderScheduler)
- 1× setInterval DSPWatchdog (250ms)
- 1× setInterval PersistenceEngine autosave (30s)
- 1× setInterval CPUSafetyMode (variable)
- 1× setInterval UIFailsafe polling (1s)
- 1× AudioContext activo
- ~180–300 AudioNodes conectados
- DeviceManager event listener (devicechange)
- SafeRecoverySystem 'statechange' listener
- 3× sockets Socket.IO (si red activa)
- MidiEngine listeners (si MIDI disponible)

---

## 3. AUDITORÍA AUDIOCONTEXT Y DSP

### 3.1 AudioContext — Singleton Verificado

**RESULTADO: UN SOLO AudioContext.**

```typescript
// AudioEngineSingleton.ts — el ÚNICO punto de creación
await Tone.start()
const rawCtx = (Tone.context as any).rawContext as AudioContext
this._rawCtx = rawCtx
```

- Todos los módulos acceden via `Tone.getContext()` o `Tone.getContext().rawContext`
- `audioEngine.js` es un re-export puro de `AudioBridge.ts` (cero código propio)
- `AudioBridge.ts` no crea contextos — solo delega a `engineSingleton`
- No se detectaron `new AudioContext()` fuera del singleton
- No hay `OfflineAudioContext`
- Tone.js usa standardized-audio-context → compatibilidad con Safari/Chromium verificada

**sampleRate:** propagado correctamente a DSPScheduler, ReverbEngine (escala tiempos por sr/44100), HAL.getSampleRate()

### 3.2 Cadena de Señal DSP — Mapa Completo

```
INPUT (MediaStream / MediaStreamSourceNode)
    │
    ▼
inputGain [GainNode] ── inputMeterTap [AnalyserNode]
    │
    ▼
trim [GainNode]
    │
    ▼
hpf [BiquadFilterNode: highpass]
    │
    ▼
lpf [BiquadFilterNode: lowpass]
    │
    ▼
gateNode [GainNode | AudioWorkletNode]  ← gate 5-state machine / worklet
    │
    ▼
compressor [DynamicsCompressorNode]
    │
    ▼
makeupGain [GainNode]
    │
    ▼
eq[0..6] [BiquadFilterNode × 7]
    │
    ├──────────────────────────────────────── preFaderTap [GainNode]
    │                                              │
    │                          ┌──────────────────┤
    │                          ▼                  ▼
    │                   reverbSend           delaySend
    │                      │                    │
    │                 auxSends[0..7]       groupSends[0..3]
    │
    ▼
panner [StereoPannerNode]
    │
    ▼
fader [GainNode]
    │
    ├──────────────────────────────────────── postFaderTap [GainNode]
    │                                              │
    │                          ┌──────────────────┤
    │                          ▼                  ▼
    │                   toMain [GainNode]    toSub [GainNode]
    │                          │                  │
    │                          ▼                  ▼
    │                   BusEngine.main      BusEngine.sub
    │
    ▼
outputMeterTap [AnalyserNode]

─────────────────────────────────────────────────────────────

BusEngine (main / sub):
  gain [GainNode] → fader [GainNode] ──→ Tone.Destination (AudioContext.destination)
                                     └─→ analyser [AnalyserNode]

─────────────────────────────────────────────────────────────

FX Bus Flow (por FxBusEngine):
  preFaderTap → reverbSend/delaySend → FxBusEngine[i].input
  FxBusEngine: input → bypass → analyser → returnGain → BusEngine.main
  Con processor: input ← [bypass off] → processor.input → processor.output → analyser → returnGain

─────────────────────────────────────────────────────────────

AuxBus Flow (8):
  preFaderTap → auxSend[i] → AuxBusEngine[i].input → fader → analyser

─────────────────────────────────────────────────────────────

Subgroup Flow (4):
  preFaderTap → groupSend[i] → SubgroupEngine[i].input → fader → toMain/toSub

─────────────────────────────────────────────────────────────

RoutingMatrix (15 fuentes × 8 destinos):
  Fuentes: main, sub, cue, aux1-8, group1-4
  Destinos: out1-8 (GainNode summing → AudioContext.destination por salida)
  Cells: GainNode creado lazy por (src, dst) par
```

### 3.3 Conteo Total de AudioNodes (6 canales, full config)

| Sistema | Nodos |
|---|---|
| Canales × 6 (18 por canal) | 108 |
| AuxBusEngine × 8 (3 por bus) | 24 |
| SubgroupEngine × 4 (5 por grupo) | 20 |
| CueBus | 3 |
| BusEngine main + sub (3 cada uno) | 6 |
| FxBusEngine × 4 (4 por bus) | 16 |
| DelayEngine | 11 |
| ReverbEngine (4 combs + allpass) | ~20 |
| MixBusProtection | 3 |
| RoutingMatrix (max 15×8 cells lazy) | 0–120 |
| **TOTAL MÍNIMO** | **~211 nodos** |
| **TOTAL MÁXIMO (routing full)** | **~331 nodos** |

### 3.4 Nodos Creados en Bucles — Análisis de Acumulación

**ChannelStrip constructor:** nodos EQ fijos (EQ_BAND_DEFS.length, array constante). Sin acumulación.

**setAuxSend():** patrón lazy-creation — un GainNode por (channel, auxId), reutilizado en llamadas sucesivas. Sin acumulación.

**setFxBusSend():** igual que setAuxSend. Sin acumulación.

**RoutingMatrix.connect():** crea cell GainNode solo si no existe. Sin acumulación.

**VEREDICTO: No se detecta acumulación de nodos en bucles. Arquitectura correcta.**

### 3.5 Ramps de Automatización AudioParam

```typescript
// Patrón universal en todo el DSP:
param.setTargetAtTime(target, ctx.currentTime, ms / 3000)
```

- `setTargetAtTime()` sobrescribe ramp pendiente automáticamente
- No se acumulan objetos de automatización
- No hay `linearRampToValueAtTime` sin `cancelScheduledValues()`
- **Sin riesgo de leak de automatización**

---

## 4. AUDITORÍA AUDIOWORKLET Y SAB

### 4.1 Módulos Registrados

| Módulo | Nombre | Función |
|---|---|---|
| `ona-meter-processor.js` | `ona-meter-processor` | Tap de medición (input/output peak dBFS) |
| `ona-dsp-processor.js` | `ona-dsp-processor` | Gate en audio thread (5-state machine) |
| `ona-router-processor.js` | `ona-router-processor` | Routing / placeholder |

### 4.2 Layout del SharedArrayBuffer

```
Float32Array[128]  (16 canales × 8 floats/canal)

Por canal (stride = 8, offset = channelIndex × 8):
  [ch*8 + 0]  input peak dBFS       ← escrito por ona-meter-processor
  [ch*8 + 1]  output peak dBFS      ← escrito por ona-meter-processor
  [ch*8 + 2]  gate level 0.0–1.0    ← escrito por ona-dsp-processor
  [ch*8 + 3]  bus peak (router)     ← escrito por ona-router-processor
  [ch*8 + 4..7]  reservado
```

**Fallback si SAB no disponible:**
```typescript
try {
  const sab = new SharedArrayBuffer(512)
  this._sabView = new Float32Array(sab)
} catch {
  this._sabView = new Float32Array(128)
  // ⚠ RIESGO P2: worklets escriben en su SAB, main thread lee ArrayBuffer distinto
}
```

### 4.3 Race Conditions — ANÁLISIS

- Cada índice SAB es 4 bytes, alienado en x86/ARM → escritura atómica garantizada
- Worklets solo ESCRIBEN, main thread solo LEE → sin R-M-W
- Cada worklet escribe en índices distintos del mismo canal
- **VEREDICTO: Sin race conditions. Arquitectura SAB correcta.**

### 4.4 Gate: Hilo de Audio vs Main Thread

**Doble modo:**
1. **Main thread** (fallback): `_tickGateMachine()` en RAF de MeteringEngine (~25fps). Pre-computed alphas (Math.exp() cacheado). 5 estados: CLOSED/OPENING/OPEN/HOLDING/CLOSING.
2. **Audio thread** (upgrade via worklet): `upgradeGateToWorklet()` reemplaza GainNode por AudioWorkletNode. Parámetros k-rate (128 muestras = ~2.6ms quantización).

**Transición segura:** Si upgrade falla → try/catch → fallback transparente. No puede haber ambos activos simultáneamente.

---

## 5. AUDITORÍA RUNTIME — LOOPS Y LISTENERS

### 5.1 Inventario de requestAnimationFrame

| Loop | Owner | Frecuencia | Función |
|---|---|---|---|
| `renderScheduler._tick()` | RenderScheduler.ts | 60fps base | RAF unificado con prioridades |

**ÚNICO RAF activo para UI.** Todos los componentes se registran vía `uiLayerManager.register()`.

**Prioridades del renderScheduler:**
- `CRITICAL (0)`: Metros — cada frame
- `HIGH (1)`: Input feedback — cada frame
- `MEDIUM (2)`: Paneles — cada 2 frames
- `LOW (3)`: Background — cada 4 frames

**⚠ RIESGO P1: RAF loop NUNCA SE DETIENE.**
El renderScheduler.start() se activa al primer `uiLayerManager.register()` pero no tiene mecanismo de stop si todos los listeners se eliminan. RAF continúa vacío consumiendo CPU.

### 5.2 Inventario de setInterval

| Interval | Owner | Frecuencia | Función |
|---|---|---|---|
| `this._watchInterval` | DSPWatchdog | 250ms | Health check SAB + ctx |
| `this._autosaveTimer` | PersistenceEngine | 30s | Autosave localStorage |
| `this._autosaveTimer` | ShowFileEngine | 30s | Show file autosave ← **DUPLICADO** |
| `this._pollInterval` | UIFailsafe | 1s | Poll FPS para adaptación |
| `this._detectTimer` | CPUSafetyMode | variable | Detección carga CPU |
| `this._pingInterval` | ClientManager | 5s | Heartbeat clientes red |
| `this._xrunTimer` | SafeRecoverySystem | variable | Detección xruns |
| `setInterval(setElapsed, 1000)` | Recorder.jsx | 1s | Contador tiempo grabación |

**⚠ DOBLE AUTOSAVE (P2):** PersistenceEngine y ShowFileEngine tienen autosave independientes cada 30s sobre localStorage. Riesgo de escritura simultánea.

### 5.3 Inventario de Listeners Activos Tras Boot

| Listener | Owner | Evento | Cleanup |
|---|---|---|---|
| `'devicechange'` | DeviceManager | navigator.mediaDevices | ✓ `_stopWatcher()` |
| `'statechange'` | SafeRecoverySystem | AudioContext | ✓ `removeEventListener` |
| `onmessage` | WorkletManager | Cada AudioWorkletNode.port | ✓ `disconnect()` |
| socket.on('*') | NetworkClient | Socket.IO × 3 | ✓ en destroy() |
| `onCommand` | App.jsx | networkClient | ✓ en useEffect cleanup |
| `onMeterUpdate` | ChannelMeter.jsx × 6 | audioEngine | ✓ retorna unsub |

**⚠ RIESGO P2: `ChannelMeter.jsx` — listener sin guard de null:**
```javascript
// Puede fallar si audioEngine no está listo:
const unsub = audioEngine.onMeterUpdate((data) => { ... })
```
Si `audioEngine.onMeterUpdate` es undefined en el momento de mount, explota silenciosamente.

---

## 6. AUDITORÍA REACT Y ZUSTAND

### 6.1 Componentes — Estado de Memoización

| Componente | memo() | Selectors | Estado |
|---|---|---|---|
| `Channel.jsx` | ✓ memo | `s.channels.find(...), shallow` | CORRECTO |
| `ChannelMeter.jsx` | ✗ | Sin Zustand (audioEngine listener) | CORRECTO — canvas puro |
| `MasterBus.jsx` | ✓ memo | 4 selectores primitivos | CORRECTO |
| `EQPanel.jsx` | ✓ memo | `?.eqBands ?? []` sin shallow | ⚠ P1 — array nuevo cada render |
| `CompPanel.jsx` | ✓ memo | `?.compressor` sin shallow | ⚠ P2 |
| `GatePanel.jsx` | ✓ memo | `?.gate` sin shallow | ⚠ P2 |
| `FXRack.jsx` | **✗ SIN memo** | `s => s.fx` (objeto entero) | **🔴 P0 — render storm** |
| `SceneManager.jsx` | ✗ | Sin Zustand (sceneEngine directo) | P3 — bajo impacto |
| `Recorder.jsx` | ✗ | Sin Zustand directo | P2 |
| `VirtualSoundcheck.jsx` | ✗ | `s => s.channels` (array entero) | P1 |
| `ConsoleMeter.tsx` | ✗ | Sin React state (RAF callback) | CORRECTO — canvas puro |
| `ProFader.tsx` | ✓ en prod | Pointer events, sin Zustand | CORRECTO |

### 6.2 Render Storms Documentados

#### 🔴 RENDER STORM #1 — FXRack (P0 CRÍTICO)
```javascript
// FXRack.jsx — SIN memo + selector fat
const fx = useMixerStore(s => s.fx)  // objeto completo

// RESULTADO: cualquier cambio en reverb, delay, o fxReturn
// → FXRack re-render → 6 sliders re-render → handlers re-creados
```
**Trigger:** Usuario mueve cualquier slider de FX.
**Frecuencia:** Continua durante live mixing.
**Fix:**
```javascript
export default memo(FXRack)
const reverb = useMixerStore(s => s.fx.reverb, shallow)
const delay  = useMixerStore(s => s.fx.delay, shallow)
```

#### 🟠 RENDER STORM #2 — EQPanel (P1)
```javascript
// EQPanel.jsx — selector crea nuevo array en cada llamada
const eqBands = useMixerStore(
  s => s.channels.find(c => c.id === channelId)?.eqBands ?? []
  // ^-- nueva referencia aunque eqBands no cambió
)
```
**Trigger:** Cualquier update a cualquier propiedad del canal (volumen, pan, HPF...).
**Resultado:** Los 7 `BandControl` re-renderizan aunque solo se movió el fader.

#### 🟠 RENDER STORM #3 — ConsoleMeter getLevel Leak (P1)
```javascript
// Channel.jsx — función inline creada en cada render
<ConsoleMeter
  getLevel={() => {           // ← nueva función cada render
    return audioEngine.getMeterBuffer()[channelId - 1] ?? 0
  }}
  ...
/>

// ConsoleMeter.tsx — getLevel en dependency array
useEffect(() => {
  const unsub = uiLayerManager.register('metering', cb, id)
  return () => unsub()
}, [channelId, getLevel, ...]) // ← getLevel cambia → re-registro cada render
```
**Resultado:** ConsoleMeter se re-registra en uiLayerManager en cada render del padre.

#### 🟡 RENDER STORM #4 — VirtualSoundcheck (P1)
```javascript
const channels = useMixerStore(s => s.channels) // array entero
// .map() en cada render sobre todos los canales
```

### 6.3 Análisis del Store Zustand

**Forma del estado:**
```javascript
{
  channels: Array<{
    id, name, color, inputSource, toMain, toSub,
    volume, pan, muted, soloed,
    hpf: { active, freq },
    lpf: { active, freq },
    gate: { bypass, threshold, attack, release, range, hysteresis, hold },
    compressor: { bypass, threshold, ratio, attack, release, knee, makeupGain },
    eqBands: Array<{ id, gain, freq, q }> × 7,
    reverbSend, delaySend,
    auxSends: Array<{ auxId, level, preFader, muted }> × 8,
    groupSends: Record<id, boolean>,
    solo, soloMode
  }> × 6,
  mainVolume, subVolume,
  auxBuses: Array × 8,
  subgroups: Array × 4,
  cue: { level, mode },
  fx: { reverb, delay, fxReturn },
  recorder: { recording, mode, elapsed }
}
```

**Problemas de batching:** Ningún mecanismo de `unstable_batchedUpdates` o React 18 `batch()`. Cada llamada a `updateChannel()` = 1 notificación a todos los subscribers.

**loadFullState() es atómico** (un solo `set()` — correcto para recall de escenas).

**Protección anti-echo de red:**
```javascript
// App.jsx — correcto pero frágil
syncRef.current = true   // marca: update viene de red
updateChannel(...)        // update store
requestAnimationFrame(() => { syncRef.current = false })  // limpia en siguiente frame
```
Frágil si comandos remotos llegan más rápido que 1 RAF (~16ms).

---

## 7. AUDITORÍA ELECTRON

### 7.1 Seguridad BrowserWindow

```javascript
// main.cjs — CONFIGURACIÓN SEGURA ✓
const win = new BrowserWindow({
  webPreferences: {
    preload:          path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,   // ✓ NO INJECTION
    nodeIntegration:  false,  // ✓ NO NODE EN RENDERER
    // sandbox: true (default en Electron reciente)
  }
})
```

**APIs expuestas vía contextBridge — inventario completo:**

| Namespace | Métodos | Riesgo |
|---|---|---|
| `window.ona` | version, platform, safeMode | Sin riesgo |
| `window.electronAPI` | saveRecording, getRecordingsDir, saveScene, listScenes, loadScene, deleteScene, showOpenDialog, crashLog, probeNativeAudio | Bajo — sin fs directo |
| `window.onaRecording` | createSession, writeChunk, finalizeSession, listSessions, loadFile | Medio — escribe a disco |
| `window.onaNative` | engineVersion, createProcessor, destroyProcessor, setGain, setPan, processBlock, processShared | Medio — binario nativo |

**Riesgos de seguridad identificados:**
- ⚠ IPC channels sin rate limiting (DoS desde renderer posible si comprometido)
- ⚠ Native module cargado sin verificación de checksum
- ✓ No hay `shell.openExternal()` expuesto
- ✓ No hay `fs` directamente expuesto
- ✓ Diálogos de archivo limitados a tipos de audio

### 7.2 GPU Flags — Impacto

```javascript
// main.cjs lines 45-48
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-gpu-rasterization')
app.commandLine.appendSwitch('disable-software-rasterizer')
```

**Impacto real:**
- Deshabilita aceleración GPU para canvas, CSS transforms, WebGL
- Fuerza compositing por CPU → mayor carga en renders canvas (metros, EQ curve)
- **NO afecta WebAudio** (procesado en audio thread, independiente de GPU)
- **Justificación:** evita crashes del proceso GPU en Windows con drivers conflictivos
- **Costo:** ConsoleMeter × 6 + EQCurve en software rendering

**Clasificación: P2** — funcional pero subóptimo para UI intensiva en canvas.

### 7.3 IPC Handlers — Inventario Completo

**ipcMain.handle (request-response):**
```
native-audio-probe        → { available, devices }
save-recording            → escribe ArrayBuffer a disco
get-recordings-dir        → path de directorio
recording:create-session  → crea directorio + file descriptors WAV
recording:write-chunk     → fs.writeSync() PCM
recording:finalize-session → cierra fd, parchea headers WAV
recording:list-sessions   → lista directorios de sesiones
recording:load-file       → lee archivo audio
scenes-save               → JSON escena a disco
scenes-list               → lista archivos escena
scenes-load               → lee JSON escena
scenes-delete             → elimina archivo escena
show-open-dialog          → dialog.showOpenDialog (tipos audio)
```

**ipcMain.on (fire-and-forget):**
```
crash-log                 → escribe a Documentos/ONA Live Studio/Logs/
```

### 7.4 SharedArrayBuffer

Habilitado via Electron flag (no requiere COOP/COEP en app nativa). Usado para:
1. Metering SAB (main → worklet → main, sin copy)
2. `window.onaNative.processShared()` (zero-copy audio processing Rust)

### 7.5 Crash Recovery

- **Main process:** `uncaughtException` + `unhandledRejection` → writeCrashLog()
- **Renderer gone:** log + mensaje manual (NO auto-reload — documentado como prevención de crash-loop)
- **Sin auto-reload** es una decisión deliberada después de FIX2/FIX3

---

## 8. AUDITORÍA NETWORKING

### 8.1 Arquitectura Socket.IO

```
Servidor (src/network/server/NetworkServer.js)
  ├─ Namespace /ctrl  → CRITICAL + HIGH priority commands
  ├─ Namespace /sync  → MEDIUM + LOW priority commands
  └─ Namespace /meters → Stream métricas, volatile.emit()

Cliente (src/network/client/NetworkClient.ts)
  ├─ socket_ctrl  → /ctrl
  ├─ socket_sync  → /sync
  └─ socket_meter → /meters
```

### 8.2 Sistema de Prioridad de Comandos

| Prioridad | Tipos | Namespace |
|---|---|---|
| CRITICAL (0) | SET_MAIN_VOL, SET_SUB_VOL | /ctrl |
| HIGH (1) | SET_GAIN, SET_MUTE, SET_SOLO, SET_PAN, SET_CUE_LEVEL, SET_TRIM | /ctrl |
| MEDIUM (2) | SET_EQ, SET_GATE, SET_COMPRESSOR, SET_AUX_SEND, SET_FX_BUS_SEND, SET_ROUTING | /sync |
| LOW (3) | LOAD_SCENE, SAVE_SCENE, RECALL_SCENE, SET_PERF_MODE | /sync |

### 8.3 Echo Suppression

```javascript
// CommandRouter.js
ns.except(excludeSocketId).emit(event, payload)
//       ↑ el remitente NO recibe su propio broadcast
// + command_ack con sequence number devuelto al remitente
```

**Conflicto por ventana de 50ms:** Si dos clientes modifican el mismo parámetro dentro de 50ms, gana el último por timestamp. Last-write-wins aceptable para mixing en vivo.

### 8.4 Delta Sync en Reconexión

```javascript
// NetworkClient.ts — al reconectar /ctrl
socket_ctrl.on('connect', () => {
  socket_ctrl.emit('request_delta', { fromSeq: this._lastSeq })
})
// Servidor responde con command_log (ring buffer MAX_LOG=2000)
```

**⚠ RIESGO P1: Ring Buffer Overflow**
- MAX_LOG = 2000 comandos
- Si cliente offline > ~30 minutos (1 cmd/seg promedio) → delta incompleto
- Servidor envía full sync pero no lo notifica explícitamente como "incompleto"

### 8.5 MeterBroadcaster — Adaptive Rate

```javascript
// Por cliente: default 25fps, rango 5-60fps
if (dropRate > 0.10) fps = Math.max(5, fps / 2)    // halve on drops
if (cleanTicks > 20)  fps = Math.min(targetFps, fps * 1.25) // recover gradually
socket.volatile.emit('meter_data', payload)   // drops si buffer lleno
```

**Sin backpressure hacia el host.** Si red saturada → paquetes caen silenciosamente → UI sin métricas temporalmente.

### 8.6 Dualidad syncService.js + NetworkClient.ts

```javascript
// src/services/syncService.js — ARCHIVO LEGACY
// @deprecated — Reemplazado por src/network/client/NetworkClient.ts

// Si código legacy importa syncService.js directamente:
//   → crea socket.io-client hacia namespace DEFAULT (sin /ctrl, /sync, /meters)
//   → crea SEGUNDA conexión al servidor
//   → comandos van sin priorización

// HALLAZGO: 0 imports activos de syncService.js → DEAD CODE
// ACCIÓN: Eliminar
```

### 8.7 Riesgo de Split en Tres Sockets

Si `/ctrl` se desconecta pero `/sync` permanece activo:
- Comandos HIGH (faders, mutes) quedan sin ruta
- CommandChannel.ts encola en offline queue con prioridad
- Al reconectar `/ctrl` → flushQueue() con orden correcto
- **Mitigado por CommandChannel, pero sin sincronización explícita de estado entre los 3 sockets.**

---

## 9. AUDITORÍA ESTADO Y ESCENAS

### 9.1 Tres Capas de Gestión de Escenas — Diseño Intencional

```
ShowFileEngine.ts        ← CAPA 3: Show completo (metadata + venue + DCA + safe + devices)
       │
       ▼
SceneEngine.ts           ← CAPA 2: Operaciones live (recall, undo, cue-list, transitions, safe)
       │
       ▼
SceneManager.ts          ← CAPA 1: Persistencia de snapshots (localStorage, 32 máx)
       │
       ▼
StateEngine.ts           ← CAPA 0: Estado canónico DSP (suscriptores, patches)
```

**No son duplicados.** Son capas con responsabilidades distintas.

**Flujo de recall:**
```
SceneEngine.recall(name, opts)
  → RecallValidator.validate(snapshot)           [validación pre-recall]
  → ChannelSafeSystem.filterChannelPatch()       [protección canales safe]
  → TransitionEngine.staggerApply()              [ramp pop-free, stagger]
  → audioEngine.applyEngineSnapshot(snapshot)    [DSP]
  → useMixerStore.loadFullState({...})           [UI store]
  → RemoteSyncBridge._onRecallDone()             [broadcast a remotes]
```

### 9.2 TransitionEngine — Pop Prevention

4 perfiles disponibles:
| Perfil | Ramp | Stagger | Uso |
|---|---|---|---|
| `instant` | 0ms | 0ms | Recall de emergencia |
| `fast` | 80ms | 0ms | Cambios rápidos |
| `smooth` | 400ms | 20ms | Default producción |
| `slow` | 1200ms | 40ms | Transiciones dramáticas |

**Pop detection:** si delta > 6dB entre pre/post recall → log warning (umbral conservador).

### 9.3 Doble Autosave — Riesgo Identificado

```
PersistenceEngine.startAutosave()  → setInterval(30s) → localStorage['ona_autosave']
ShowFileEngine.startAutosave()     → setInterval(30s) → localStorage['ona_show'] + IPC disk
```

Ambos inician en Phase 4 del boot (AudioEngineSingleton.initialize()). Escrituras a localStorage simultáneas cada 30s. Sin coordinación.

**Riesgo P2:** potencial contención en localStorage (single-threaded en renderer, bajo riesgo real de corrupción, pero innecesaria duplicación).

### 9.4 RecallValidator

Valida antes de cada recall:
- Rangos de parámetros (volume 0-100, pan -1..1, etc.)
- Integridad de routing (aux sends sin buses inexistentes)
- Sources de input existentes
- Conflictos FX (reverb + delay activos con CPU alto)

**⚠ Omitible:** `SceneEngine.recall(name, { skipValidation: true })` — debería ser no-bypasseable para escenas de producción.

---

## 10. AUDITORÍA MEMORIA Y CLEANUP

### 10.1 Implementaciones dispose()/destroy() — Audit Completo

| Módulo | Método | Nodos Desconectados | Intervalos Limpiados | Listeners Removidos |
|---|---|---|---|---|
| `ChannelStrip` | `dispose()` | ✓ 18+ nodos | ─ | ✓ aux/solo sends |
| `BusEngine` | `destroy()` | ✓ 6 nodos | ─ | ─ |
| `WorkletManager` | `destroy()` | ✓ worklet nodes | ─ | ✓ SAB nulled |
| `AuxBusEngine` | `destroy()` | ✓ 24 nodos | ─ | ─ |
| `SubgroupEngine` | `destroy()` | ✓ 20 nodos | ─ | ─ |
| `CueBus` | `destroy()` | ✓ 3 nodos | ─ | ─ |
| `RoutingMatrix` | `destroy()` | ✓ cells + sums | ─ | ─ |
| `FxBusEngine` | `destroy()` | ✓ 16 nodos + procs | ✓ watchdog | ─ |
| `DelayEngine` | `destroy()` | ✓ 11 nodos + kicks | ─ | ─ |
| `ReverbEngine` | `destroy()` | ✓ ~20 nodos + kicks | ─ | ─ |
| `MixBusProtection` | `destroy()` | ✓ 3 nodos | ✓ clipInterval | ─ |
| `MeteringEngine` | `stop()` | ─ (solo refs) | ✓ RAF cancelled | ─ |
| `DSPWatchdog` | `stop()` | ─ | ✓ interval | ─ |
| `SafeRecoverySystem` | `destroy()` | ─ | ✓ xrunTimer | ✓ statechange |
| `CPUSafetyMode` | `destroy()` | ─ | ✓ interval | ─ |
| `HardwareAbstractionLayer` | `destroy()` | ─ | ─ | ✓ devicechange, MediaStream.stop() |
| `DeviceManager` | `destroy()` | ─ | ─ | ✓ watcher |
| `MidiEngine` | (implícito) | ─ | ─ | ✓ MIDI state change |
| `NetworkClient` | `destroy()` | ─ | ─ | ✓ 3× socket.disconnect() |

**VEREDICTO: Cleanup comprehensivo. Todos los módulos críticos implementan cleanup correcto con try-catch.**

### 10.2 Canvas Leaks

**ConsoleMeter.tsx:** Canvas rendering via RAF callback. Gradient cacheado en `gradRef.current`. Cleanup en useEffect return:
```typescript
return () => { unsub(); gradRef.current = null }
```
Sin leak de canvas context.

**EQCurve.jsx:** Canvas 2D para curva EQ. Gradient recreado en cada cambio de `eqBands`. Sin explicit cleanup del gradient en unmount — **P3 menor.**

### 10.3 Proyecciones de Sesiones Largas

**AudioNodes:** Fijos tras boot. Sin acumulación por uso normal. Sin leak de nodos.

**Heap React:** Riesgo de lento crecimiento por:
- Renders de FXRack sin memo (callbacks recreados frecuentemente)
- EQPanel selectors sin shallow (stale closures por Zustand internals)

**SAB metering:** Tamaño fijo (512 bytes). Sin crecimiento.

**Socket.IO:** Si reconexión frecuente → eventos acumulados en buffers del cliente. Mitigado por offline queue max 200.

**Recording:** DiskStreamingQueue backpressure a 16MB RAM max → SafeRecoverySystem notificado en caso de drop. Sin leak de buffer.

---

## 11. MAPA DE CONTAMINACIÓN LEGACY

### 11.1 Clasificación de Contaminación

| Archivo | Clasificación | Riesgo | Acción |
|---|---|---|---|
| `src/services/syncService.js` | **MUERTO** | P2 — inerte | **ELIMINAR** |
| `src/hooks/useScenes.js` | **MUERTO** | P2 — inerte | **ELIMINAR** |
| `src/audio/audioEngine.js` | ACTIVO (facade) | P0 — 10 importers | Mantener |
| `src/audio/AudioBridge.ts` | ACTIVO (adapter) | P0 — crítico | Mantener |
| `src/utils/wavEncoder.js` | LEGACY ACTIVO | P1 — dual encoder | Consolidar con WavEncoder.ts |
| `native/src/` | NO COMPILADO | P2 — confusión | Compilar o documentar estado |

### 11.2 Sistemas Paralelos Identificados

| Sistema A | Sistema B | Relación Real | Riesgo |
|---|---|---|---|
| `SceneManager.ts` (state) | `SceneEngine.ts` (ops) | Capas distintas — correctas | Sin riesgo |
| `PersistenceEngine.ts` | `ShowFileEngine.ts` | Doble autosave — solapado | P2 |
| `syncService.js` | `NetworkClient.ts` | Syncservice DEAD, NetworkClient activo | P2 (solo si alguien importa syncService) |
| `wavEncoder.js` | `WavEncoder.ts` | Implementaciones distintas para paths distintos | P1 — fragmentación |
| `useScenes.js` hook | Uso directo de `sceneEngine` en componente | Hook DEAD | P2 |
| `MultitrackRecorder.ts` | `Recorder.jsx` (Tone.Recorder) | Paths paralelos, distinto propósito | Intencionado |

### 11.3 Legacy P0 — Peligroso Tocar

- `src/audio/audioEngine.js` — 10 componentes dependen de esta facade
- `src/audio/AudioBridge.ts` — toda la lógica de debouncing está aquí
- `electron/preload.cjs` — cualquier cambio rompe IPC

### 11.4 Legacy P1 — Altamente Acoplado

- `src/utils/wavEncoder.js` — activo en `Recorder.jsx`. Remover implica migrar Recorder al nuevo path.

### 11.5 Legacy P2 — Removible con Cuidado

- `src/services/syncService.js` — cero importers, safe eliminar
- `src/hooks/useScenes.js` — cero importers, safe eliminar
- `src/audio/hardware/ToneJsAudit.ts` — herramienta de diagnóstico, no en prod

### 11.6 Legacy P3 — Removible Inmediatamente

- *(ninguno en esta categoría)*

---

## 12. SISTEMAS DE ESCALABILIDAD — ESTADO REAL

### 12.1 DSPLoadBalancer.ts

- **Declarado:** Priority queue + degradation stages (full/reduced/minimal/emergency)
- **¿Llamado?** NO. `schedule()` sin callers en codebase.
- **Estado:** Feature completa sin integrar al motor DSP.
- **Impacto actual:** Cero — no corre en runtime.

### 12.2 LazyDSPRegistry.ts

- **Declarado:** Deferred init pattern para nodos DSP.
- **¿Llamado?** NO. `register()` y `ensureInit()` sin callers.
- **Estado:** Feature sin integrar.
- **Impacto actual:** Cero.

### 12.3 ChannelSleepSystem.ts

- **Declarado:** Detecta silencio por 2s → sleep; señal > -54dB → wake.
- **¿Conectado?** NO. `setPeakReader()` y `onSleep()/onWake()` sin inyectar desde DSP.
- **Estado:** Lógica completa, sin wirear a AudioEngineSingleton.
- **Impacto actual:** Cero.

### 12.4 ResourceManager.ts

- **Declarado:** Suspension de lectura de metros ociosos.
- **¿Consultado?** NO. `isMeterSuspended()` no verificado antes de `getFloatTimeDomainData()`.
- **Estado:** Flag existe, nadie la lee.
- **Impacto actual:** Cero.

### 12.5 PerformanceModes.ts

- **Declarado:** Tres modos (studio/live/eco) + auto-switch por CPU.
- **¿Propagado?** NO. `onModeChange()` requiere inyección manual. Ningún subsistema suscrito.
- **Estado:** Modo puede cambiar pero nada reacciona.
- **Impacto actual:** Cero.

### 12.6 Resumen de Escalabilidad

**5 de los 9 sistemas de escalabilidad están declarados pero NO integrados en el runtime.** Son código correcto y bien diseñado, pero actualmente sin efecto. El sistema opera en modo "full" permanente.

---

## 13. MAPA DE RIESGOS CRÍTICOS

### 🔴 P0 — CRASH CRÍTICO

| ID | Módulo | Descripción | Línea/Archivo |
|---|---|---|---|
| P0-01 | `FXRack.jsx` | Sin `memo()` + selector fat `s.fx`. Render storm continuo durante live mixing. | FXRack.jsx:5 |
| P0-02 | `ChannelMeter.jsx` | `audioEngine.onMeterUpdate()` sin guard de null. Explota en mount temprano. | ChannelMeter.jsx:60 |
| P0-03 | `WorkletManager` | `Promise.all(addModule×3)` — si cualquiera falla, todo falla. | WorkletManager.ts:58 (**MITIGADO** por catch en Singleton) |

### 🟠 P1 — DEGRADACIÓN SEVERA

| ID | Módulo | Descripción | Archivo:Línea |
|---|---|---|---|
| P1-01 | `ConsoleMeter.tsx` | `getLevel` inline en Channel.jsx → re-registro en uiLayerManager cada render. | Channel.jsx:101, ConsoleMeter.tsx:123 |
| P1-02 | `EQPanel.jsx` | Selector `?.eqBands ?? []` sin shallow → array nuevo cada update → 7 BandControl re-renders. | EQPanel.jsx:83 |
| P1-03 | `App.jsx` | Lógica syncRef frágil para anti-echo: si comandos remotos llegan < 16ms, echo posible. | App.jsx:85-151 |
| P1-04 | `RenderScheduler.ts` | RAF loop nunca se detiene aunque no haya listeners. CPU waste permanente. | RenderScheduler.ts:46 |
| P1-05 | `NetworkClient.ts` | 3 sockets independientes: si `/ctrl` cae pero `/sync` no, estado split hasta reconexión. | NetworkClient.ts:80-82 |
| P1-06 | Scalability stack | DSPLoadBalancer, ChannelSleepSystem, PerformanceModes no integrados → no hay adaptación de carga. | Todos en scalability/ |
| P1-07 | `CommandRouter.js` | Sin rate limiting por cliente → 1000 SET_GAIN/ms posibles → saturación DSP y red. | CommandRouter.js:94 |
| P1-08 | `FxBusEngine.ts` | Runaway detection latency: 200ms antes de silenciar bus descontrolado. | FxBusEngine.ts:91, FxCpuProtection.ts:97 |

### 🟡 P2 — DEUDA TÉCNICA IMPORTANTE

| ID | Módulo | Descripción | Archivo |
|---|---|---|---|
| P2-01 | `services/syncService.js` | Dead code explícitamente marcado @deprecated. Riesgo de re-importación accidental. | syncService.js |
| P2-02 | `hooks/useScenes.js` | Dead code, 0 importers. | useScenes.js |
| P2-03 | `native/src/` | Código Rust sin binario compilado. Confunde el estado del proyecto. | native/ |
| P2-04 | `utils/wavEncoder.js` | Duplica parcialmente WavEncoder.ts. Dos implementaciones vivas para WAV. | wavEncoder.js, WavEncoder.ts |
| P2-05 | `PersistenceEngine` + `ShowFileEngine` | Doble autosave cada 30s a localStorage. Sin coordinación. | PersistenceEngine.ts:35, ShowFileEngine.ts:195 |
| P2-06 | GPU flags | `--disable-gpu` fuerza rendering por software en todos los canvas. | main.cjs:45-48 |
| P2-07 | SAB fallback | Si SAB no disponible, worklets escriben en SAB, main thread lee ArrayBuffer diferente → métricas perdidas. | WorkletManager.ts:65-72 |
| P2-08 | `ChannelStrip` dual mode | Path Tone.js fallback (sin ctx) completamente no testeado. | ChannelStrip.ts:270 |
| P2-09 | `RecallValidator` | `skipValidation: true` bypass permite recalls sin verificación en producción. | SceneEngine.ts:98 |
| P2-10 | `loadFullState` en recall | Si `applyEngineSnapshot` lanza excepción, `loadFullState` nunca corre → store y DSP divergentes. | App.jsx:47-54 |
| P2-11 | Ring buffer delta sync | MAX_LOG = 2000 comandos (~30min). Cliente offline más tiempo → full sync sin notificación. | CommandRouter.js:115 |
| P2-12 | IPC sin rate limiting | window.onaRecording.writeChunk() puede saturar disco en hardware slow. | preload.cjs |
| P2-13 | Pan Law coherence | `checkCoherence()` existe pero nadie la llama en init. | PanLaw.ts:128 |

### 🟢 P3 — OPTIMIZACIÓN FUTURA

| ID | Módulo | Descripción |
|---|---|---|
| P3-01 | `RoutingMatrix` | Cells lazy crean hasta 120 GainNodes. Monitor usage real. |
| P3-02 | `MeteringEngine` | RAF loop no sincronizado con AudioContext.currentTime (jitter de timestamp). |
| P3-03 | `ona-dsp-processor.js` | Gate k-rate: quantización 128 muestras (~2.6ms). Aceptable para gate, no para a-rate smooth. |
| P3-04 | `ProFader.tsx` | Pointer capture sin guard en error handler. `pointerCancel` mitiga. |
| P3-05 | `EQCurve.jsx` | Gradient canvas no limpiado en unmount. |
| P3-06 | `App.jsx` | `applyEngineSnapshot` + `loadFullState` sin bloque try/finally — race en recall fallido. |
| P3-07 | Zustand | Sin `createSelector` (Reselect) para selectores derivados → referencias inestables. |
| P3-08 | `ChannelMeter.jsx` | `draw()` llamado directamente desde audioEngine callback — fuera del RAF unificado. |
| P3-09 | `SceneEngine` | Undo de un solo nivel. Sin undo stack múltiple. |
| P3-10 | Network | DiscoveryClient tiene IPs hardcodeadas (192.168.137.x, 192.168.2.x). |

### ⚪ P4 — CLEANUP OPCIONAL

| ID | Módulo | Descripción |
|---|---|---|
| P4-01 | `AudioBridge.ts` | Capa de debounce inline (setTargetAtTime ya tiene ramp nativo). |
| P4-02 | `MixEngineReport.ts` | Solo benchmark output, sin impacto runtime. |
| P4-03 | Benchmarks | 15+ archivos de benchmark/report expuestos en window global. |

---

## 14. EVALUACIÓN ARQUITECTÓNICA FINAL

### 14.1 Puntuaciones por Área

| Área | Puntuación | Notas |
|---|---|---|
| DSP Architecture | **9/10** | Cadena profesional, singleton correcto, cleanup comprehensivo |
| AudioWorklet / SAB | **8/10** | SAB layout correcto, fallback implementado, gate dual-mode |
| React/UI | **6/10** | Metros correctos, pero FXRack P0 y selectores unstable |
| Electron Security | **8/10** | contextIsolation, no nodeIntegration, IPC bien delimitado |
| Networking | **7/10** | Priority system bueno, 3-socket split risk, sin rate limiting |
| State/Scenes | **8/10** | 3 capas correctas, transiciones pop-free, doble autosave |
| Memory/Cleanup | **8/10** | Todos los módulos con dispose(), sin acumulación detectada |
| Scalability Systems | **3/10** | Código correcto pero 5 de 9 sistemas sin integrar |
| Legacy Contamination | **8/10** | Solo 2 archivos muertos, sin conflictos activos |
| Boot Sequence | **7/10** | First-click audio correcto, sin race conditions críticas |

### 14.2 Resumen de Estabilidad Real

**Lo que es estable y maduro:**
- Motor DSP central (AudioEngineSingleton + cadena de señal)
- Sistema de routing (AuxBus, Subgroup, Matrix)
- FX engine (Delay, Reverb con denormal kicks y runaway detection)
- Electron security model
- Cleanup de todos los AudioNodes
- SAB metering architecture
- Scene recall con transiciones
- DCA + mute groups
- Show file con autosave + crash recovery
- Networking priority + delta sync

**Lo que es frágil:**
- React layer (FXRack sin memo, selectors unstable, getLevel inline)
- RAF loop no stoppable
- Scalability systems desconectados
- Doble autosave sin coordinación
- 3-socket split risk en red

**Lo que no está en producción:**
- Rust native DSP engine (código existe, sin compilar)
- DSPLoadBalancer, LazyDSPRegistry, ChannelSleepSystem, ResourceManager, PerformanceModes (declarados, no integrados)

### 14.3 Viabilidad para Producción

**Hardware high-end (PC gaming, Mac M1+):** ✅ Viable hoy. FPS estable, DSP correcto, UI responde.

**Hardware low-end (Intel Celeron 4GB RAM):** ⚠ Condicionado. GPU disabled fuerza CPU rendering. Scalability systems no activos impiden adaptación automática de carga. Necesita wiring de PerformanceModes + ChannelSleepSystem.

**Live streaming / broadcast (8+ horas):** ⚠ Condicionado. Doble autosave puede causar contención. RAF loop no stoppable acumula microlatencia. Necesita P1-04 fix.

**Multi-device remote control:** ✅ Viable. Delta sync + CommandChannel + echo suppression funcionan. Rate limiting recomendado antes de deploy público.

### 14.4 Plan de Acción Recomendado

**Inmediato (antes de cualquier release):**
1. `FXRack.jsx`: añadir `React.memo()` + split selectors → **elimina P0-01**
2. `Channel.jsx`: `useCallback` en `getLevel` → **elimina P1-01**
3. `ChannelMeter.jsx`: guard null en `onMeterUpdate` → **elimina P0-02**
4. `App.jsx`: `try/finally` en `applyEngineSnapshot` + `loadFullState` → **elimina P2-10**

**Corto plazo (hardening pre-release):**
5. Eliminar `syncService.js` y `useScenes.js` → **elimina P2-01, P2-02**
6. `EQPanel.jsx`: selector con `shallow` → **reduce P1-02**
7. `CommandRouter.js`: token bucket rate limiting → **elimina P1-07**
8. `RenderScheduler`: mecanismo de stop cuando listeners = 0 → **elimina P1-04**

**Medio plazo (production hardening):**
9. Wirear `PerformanceModes` → `ChannelSleepSystem` → `MeteringEngine` → **activa P15**
10. Compilar native Rust DSP o eliminar directorio `native/` → **elimina P2-03**
11. Unificar autosave (ShowFileEngine vs PersistenceEngine) → **elimina P2-05**
12. `RecallValidator.skipValidation` → forzar validación en producción → **elimina P2-09**

---

## APÉNDICE: ARCHIVOS HUÉRFANOS (VERIFICADO)

```
DEAD CODE (0 importers activos):
├─ src/services/syncService.js         ← eliminar
└─ src/hooks/useScenes.js              ← eliminar

FEATURES DECLARADAS SIN INTEGRAR (code correcto, runtime cero):
├─ src/audio/scalability/DSPLoadBalancer.ts
├─ src/audio/scalability/LazyDSPRegistry.ts
├─ src/audio/scalability/ChannelSleepSystem.ts    (callbacks no inyectados)
├─ src/audio/scalability/ResourceManager.ts       (flag no consultada)
└─ src/audio/scalability/PerformanceModes.ts      (onModeChange sin subs)

BINARIO NATIVO FALTANTE:
└─ native/ona-dsp-engine.*.node   (Rust source presente, .node ausente)
```

---

*Auditoría forense generada por análisis estático completo de 130+ archivos.*
*Ningún archivo fue modificado durante esta auditoría.*
*Clasificación de riesgos basada en análisis de impacto real, no teórico.*
