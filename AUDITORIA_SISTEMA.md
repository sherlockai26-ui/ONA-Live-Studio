# ONA LIVE STUDIO — RADIOGRAFÍA COMPLETA DEL SISTEMA
### Full System Audit · Pre-Legacy Purge
**Fecha:** 2026-05-10 · **Estado del repo:** bc87e28 (pre-legacy-audit backup)

---

## 1. ÁRBOL REAL DE INICIALIZACIÓN (Boot Trace)

```
electron/main.cjs
  ├── GPU switches: disable-gpu-compositing, disable-gpu-rasterization
  ├── enable-features=SharedArrayBufferOnDesktop
  ├── autoplay-policy=no-user-gesture-required
  ├── IPC handlers registrados:
  │     crash-log, native-audio-probe, save-recording,
  │     recording:create-session / write-chunk / finalize-session / list-sessions / load-file,
  │     scenes-save / scenes-list / scenes-load / scenes-delete,
  │     show-open-dialog
  └── BrowserWindow(contextIsolation:true, nodeIntegration:false)
        └── electron/preload.cjs
              ├── window.electronAPI  → grabación, escenas, crashLog, probeNativeAudio
              ├── window.ona          → { version:'0.2.0', platform, safeMode }
              ├── window.onaRecording → createSession / writeChunk / finalizeSession / listSessions / loadFile
              └── window.onaNative   → handles Rust DSP (solo si .node compila)
                    └── http://localhost:5173 → src/main.jsx
                          ├── SafeMode: window.ona.safeMode | ?safeMode=1 | localStorage '__ONA_SAFE_MODE'
                          ├── window.onerror + onunhandledrejection → electronAPI.crashLog → disco
                          ├── ErrorBoundary (React class component)
                          └── ReactDOM.createRoot → <App />
                                ├── useMixerStore (Zustand) — 6 canales, buses, FX, routing
                                ├── useDevices() — enumerateAudioDevices sin getUserMedia
                                ├── useEffect → window.addEventListener('click', {once:true})
                                │     └── audioEngine.initialize(6, zustandSnapshot)
                                │           └── audioEngine.js (FACADE) → AudioBridge.ts
                                │                 └── AudioEngineSingleton.ts — 19 pasos:
                                │
                                │                  0.  StateEngine.loadFromInitialState()
                                │                  1.  Tone.start() → AudioContext (48kHz)
                                │                  2.  HAL.initialize() + ClockManager.attach()
                                │                  3.  DSPCommandBus + DSPScheduler + DSPParameterManager + DSPWatchdog
                                │                  4.  NativeBridge.probe() (async, no-block)
                                │                  4b. NativeDSPBridge.initialize() — Rust o WebAudio fallback
                                │                  5.  BusEngine (main+sub) + AuxBusEngine (×8)
                                │                      + SubgroupEngine (×4) + CueBus + RoutingMatrix
                                │                  5b. FxBusEngine (×4 professional FX buses)
                                │                  6.  Global FX: ReverbEngine + DelayEngine
                                │                  7.  ChannelStrip × 6 (HPF→Gate→Comp→EQ7→Pan→Fader→Routing)
                                │                  8.  WorkletManager — gate upgrade a AudioWorklet thread
                                │                  9.  Estado inicial (mainVolume, subVolume, FX)
                                │                  10. MeteringEngine.start() → RAF loop #1 (único dueño)
                                │                  11. PerformanceMonitor.start() → RAF loop #2
                                │                  12. DSPWatchdog.start() → setInterval
                                │                  13. CPUSafetyMode.startAutoDetect() → setInterval
                                │                  14. PersistenceEngine.startAutosave(30000) → setInterval
                                │                  15. SafeRecovery.attach() + DSP recovery hooks
                                │                  16. MIDI + ControlSurface (Paso 13)
                                │                  17. Mix engine: GainStaging, MixBusProtection,
                                │                      LoudnessMeter, PanLaw (Paso 14)
                                │                  18. Scalability: DSPLoadBalancer (RAF #3),
                                │                      ResourceManager, ChannelSleepSystem,
                                │                      LazyDSPRegistry, MulticorePrep, CacheOptimizer (Paso 15)
                                │                  19. persistenceEngine.startAutosave(30000) — activo
                                │
                                └── useEffect (post engineReady) → dynamic import('./services/syncService.js')
                                      └── syncService.connect() → Socket.IO → localhost:3000
                                          ⚠️  syncService.onState() → UNDEFINED — BUG CRÍTICO (ver §2)
```

---

## 2. DETECCIÓN LEGACY

### 🔴 BUG CRÍTICO: API mismatch en syncService

**App.jsx llama métodos que NO existen en syncService.js:**

```js
// App.jsx líneas 70, 77
unsub = syncService.onState(cb)         // ❌ undefined() → TypeError
syncService.emit({ channels... })       // ❌ undefined() → TypeError
```

**syncService.js solo expone:**
```js
connect() / disconnect() / sendCommand(type, channelId, payload) / onCommand(cb)
```

**Consecuencia:** El `try/catch` en `connectSync()` silencia el error. ONA **siempre opera en modo standalone**. La sincronización multi-dispositivo **nunca funciona** en el estado actual, independientemente de si el servidor está corriendo.

---

### Inventario legacy activo

| Sistema | Archivo | Estado real |
|---|---|---|
| Sync Paso 5 | `src/services/syncService.js` | Importado por App.jsx pero ROTO (API mismatch) |
| Servidor Paso 5 | `src/server/index.js` | Corre con `npm run server` — protocolo obsoleto |
| Recorder blob | `src/components/Recorder.jsx` + `src/utils/wavEncoder.js` | Activo — graba blob en RAM, NO usa MultitrackRecorder |
| Scene IPC | `src/hooks/useScenes.js` + `src/services/scenesService.js` | Activo — sistema paralelo a SceneManager.ts |
| Scene localStorage | `src/audio/state/SceneManager.ts` | Activo — sistema paralelo al anterior |

---

## 3. MAPA DE DEPENDENCIAS

### Quién importa qué (cadena crítica)

```
App.jsx
  ├── src/store/mixerStore.js               ← fuente de verdad UI
  ├── src/audio/audioEngine.js              ← FACADE (re-exports AudioBridge)
  │     └── src/audio/AudioBridge.ts        ← capa de comandos
  │           └── src/audio/core/AudioEngineSingleton.ts   ← orquestador DSP
  │                 ├── src/audio/core/DSPGraphEngine.ts
  │                 ├── src/audio/core/BusEngine.ts
  │                 ├── src/audio/core/ChannelStrip.ts
  │                 ├── src/audio/core/MeteringEngine.ts   ← RAF #1
  │                 ├── src/audio/core/PerformanceMonitor.ts ← RAF #2
  │                 ├── src/audio/hardware/* (HAL, ClockManager, NativeBridge)
  │                 ├── src/audio/native/* (NativeDSPBridge, fallback)
  │                 ├── src/audio/state/* (StateEngine, SceneManager, PersistenceEngine)
  │                 ├── src/audio/recording/* (MultitrackRecorder, WavEncoder, etc.)
  │                 ├── src/audio/fx/* (FxBusEngine, DelayEngine, ReverbEngine)
  │                 ├── src/audio/scalability/* (DSPLoadBalancer RAF #3, todos)
  │                 └── src/control/* (MidiEngine, MidiMapper, ControlPath, etc.)
  ├── src/hooks/useDevices.js → src/services/deviceService.js
  └── [dynamic] src/services/syncService.js  ← ROTO (ver §2)

Channel.jsx / ChannelMeter.jsx / FXRack.jsx / MasterBus.jsx / Recorder.jsx / GatePanel.jsx / CompPanel.jsx / EQPanel.jsx
  └── src/audio/audioEngine.js  (todos usan el mismo facade)

SceneManager.jsx (componente React)
  └── src/hooks/useScenes.js → src/services/scenesService.js → window.electronAPI.saveScene/listScenes/loadScene/deleteScene
      (NO importa src/audio/state/SceneManager.ts — son sistemas separados)
```

### Módulos nunca importados desde el bundle principal

```
src/live/*          (Paso 18 — SceneEngine, DCAEngine, TransitionEngine, etc.)
src/ui/*            (Paso 17 — ProFader, ConsoleMeter, RenderScheduler, etc.)
src/network/client/* (Paso 16 — NetworkClient, CommandChannel, etc.)
src/network/server/* (Paso 16 — Node.js solo, nunca bundleado)
```

### Imports circulares detectados
Ninguno. La arquitectura es estrictamente jerárquica:
`Components → audioEngine.js (facade) → AudioBridge → AudioEngineSingleton → subsistemas`

---

## 4. VALIDACIÓN AUDIO ENGINE

### ¿Cuántas veces inicia AudioEngine?
**1 vez exactamente.** `AudioEngineSingleton` tiene guard estricto:
```ts
if (this._state !== 'uninitialized') return
```
`audioEngine.js` es un alias puro — misma instancia para todos los componentes.

### Schedulers y loops activos tras initialize()

| Loop | Dueño | Tipo | Cadencia |
|---|---|---|---|
| Metering RAF #1 | `MeteringEngine` | `requestAnimationFrame` | 60fps (throttled ~30fps efectivos) |
| Profiling RAF #2 | `PerformanceMonitor` | `requestAnimationFrame` | 60fps |
| DSP Load RAF #3 | `DSPLoadBalancer` | `requestAnimationFrame` | 60fps |
| DSP Watchdog | `DSPWatchdog` | `setInterval` | ~1000ms |
| CPU Safety | `CPUSafetyMode` | `setInterval` | ~500ms |
| Persistence | `PersistenceEngine` | `setInterval` | 30000ms |
| Recorder UI | `Recorder.jsx` | `setInterval` | 1000ms (solo durante grabación) |

**Loops de sistemas nuevos (Paso 17–18):** `RenderScheduler.ts` existe pero **nadie lo arranca**. `UIFailsafe` no está iniciado. `TransitionEngine` no corre. Los sistemas nuevos no añaden ningún loop activo.

### ¿Hay MeteringEngine duplicado?
No. `MeteringEngine` es el único RAF de metering. `ChannelMeter.jsx` se suscribe vía `audioEngine.onMeterUpdate(cb)` — sin RAF propio.

---

## 5. VALIDACIÓN ELECTRON

| Configuración | Valor | Estado |
|---|---|---|
| `contextIsolation` | `true` | ✓ Correcto |
| `nodeIntegration` | `false` | ✓ Correcto |
| `webSecurity` | `true` (default) | ✓ Correcto |
| `sandbox` | no declarado (default Electron 28) | ⚠ Verificar para naudiodon |
| SharedArrayBuffer | `enable-features=SharedArrayBufferOnDesktop` | ✓ Funciona en desktop sin COOP/COEP |
| CSP | vía `webRequest.onHeadersReceived` | ✓ Permisivo intencionalmente (Tone.js + blob worklets) |
| IPC | `ipcMain.handle` con contextIsolation | ✓ Correcto — no hay nodeIntegration leak |
| Preload exposición | `contextBridge.exposeInMainWorld` | ✓ Correcto |

**Nota COOP/COEP:** El SAB de metering funciona porque se activa `SharedArrayBufferOnDesktop`. El servidor nuevo (Paso 16) también añade headers COOP/COEP para cuando se use en contexto HTTP — no hay conflicto.

---

## 6. AUDITORÍA DE RECURSOS VIVOS

| Recurso | Dueño | Cantidad estimada |
|---|---|---|
| AudioContext | AudioEngineSingleton (vía Tone.js) | 1 |
| GainNodes + DSP nodes | ChannelStrip × 6 + BusEngine + FX | ~70–90 nodos |
| AudioWorkletNode (gate) | WorkletManager | 0–6 (si upgrade exitoso) |
| MediaStream activo | HAL | 0–1 (según dispositivo conectado) |
| SharedArrayBuffer | MeteringEngine (ring buffer) | 1 |
| RAF loops | MeteringEngine + PerfMonitor + DSPLoadBalancer | 3 |
| setIntervals | Watchdog + CPUSafety + Persistence | 3 |
| Socket.IO sockets | syncService (si servidor corre) | 0–1 |
| localStorage keys | PersistenceEngine + SceneManager + SafeMode | ~5–10 |
| IPC sessions activas | `_activeSessions` Map en main.cjs | 0–N (durante grabación) |

---

## 7. AUDITORÍA UI

### Componentes React activos (montados en App.jsx)

| Componente | Importaciones clave | Estado |
|---|---|---|
| `Channel.jsx` | audioEngine, mixerStore | ✓ Activo, funcional |
| `ChannelMeter.jsx` | audioEngine.onMeterUpdate | ✓ Activo, canvas con gradient pre-computado |
| `MasterBus.jsx` | audioEngine, mixerStore | ✓ Activo |
| `FXRack.jsx` | audioEngine, mixerStore | ✓ Activo |
| `Recorder.jsx` | audioEngine, mixerStore, blobToWav | ✓ Activo (legacy — blob en RAM) |
| `SceneManager.jsx` | useScenes hook | ✓ Activo (usa IPC, NO usa SceneManager.ts) |
| `VirtualSoundcheck.jsx` | audioEngine, mixerStore | ✓ Activo |
| `CompPanel.jsx` | audioEngine, mixerStore | ✓ Activo (modal) |
| `EQPanel.jsx` | audioEngine, mixerStore | ✓ Activo (modal) |
| `GatePanel.jsx` | audioEngine, mixerStore | ✓ Activo (modal) |

### Componentes nuevos (Paso 17) — huérfanos

| Componente | Estado |
|---|---|
| `ProFader.tsx` | Creado, no importado en ningún componente |
| `ConsoleMeter.tsx` | Creado, no importado |
| `VirtualChannelList.tsx` | Creado, no importado |
| `ConsoleLayout.tsx` | Creado, no importado |
| `TouchGuard.tsx` | Creado, no importado |

### Providers / stores duplicados
No hay providers duplicados. Un solo store Zustand (`mixerStore.js`). No hay Context duplicado.

### Render loops innecesarios en UI
Ninguno detectado. `Recorder.jsx` tiene 1 `setInterval` pero solo activo durante grabación.

---

## 8. CLASIFICACIÓN FILESYSTEM

### A — CRÍTICO (sin esto la app no arranca)
```
electron/main.cjs
electron/preload.cjs
src/main.jsx
src/App.jsx
src/store/mixerStore.js
src/audio/audioEngine.js
src/audio/AudioBridge.ts
src/audio/core/AudioEngineSingleton.ts
src/audio/core/DSPGraphEngine.ts
src/audio/core/BusEngine.ts
src/audio/core/ChannelStrip.ts
src/audio/core/MeteringEngine.ts
src/audio/core/PerformanceMonitor.ts
src/audio/core/WorkletManager.ts
src/components/Channel.jsx
src/components/ChannelMeter.jsx
src/components/MasterBus.jsx
src/components/FXRack.jsx
src/components/Recorder.jsx
src/components/SceneManager.jsx
src/components/VirtualSoundcheck.jsx
src/components/EQPanel.jsx
src/components/CompPanel.jsx
src/components/GatePanel.jsx
src/hooks/useDevices.js
src/services/deviceService.js
index.html  vite.config.js  package.json  tsconfig.json
```

### B — ACTIVO (importado y en ejecución)
```
src/audio/hardware/*        (HAL, DeviceManager, NativeBridge, ClockManager, ToneJsAudit)
src/audio/native/*          (NativeDSPBridge, WebAudioDSPFallback, NativeDSPBenchmark)
src/audio/state/*           (StateEngine, SceneManager, PersistenceEngine)
src/audio/recording/*       (MultitrackRecorder, WavEncoder, RecordingClock,
                              BufferManager, AudioCapture, LatencyMeasurement, MultitrackPlayer,
                              DiskStreamingQueue)
src/audio/fx/*              (FxBusEngine, DelayEngine, ReverbEngine, FxCpuProtection, FxBenchmark)
src/audio/scalability/*     (DSPLoadBalancer, ResourceManager, ChannelSleepSystem,
                              LazyDSPRegistry, MulticorePrep, CacheOptimizer, PerformanceModes,
                              ScalabilityBenchmark, ScalabilityReport)
src/audio/core/ (resto)     (DSPCommandBus, DSPScheduler, DSPWatchdog, DSPParameterManager,
                              AuxBusEngine, SubgroupEngine, CueBus, RoutingMatrix, RoutingValidator,
                              SafeRecoverySystem, CPUSafetyMode, NodeLifecycleValidator,
                              GainStaging, MixBusProtection, LoudnessMeter, PanLaw,
                              MixEngineReport, ProductionStressTest, ProductionReport,
                              DSPObjectPool, DSPBenchmarkRunner, DSPTestSignal, DSPValidator,
                              ClockManager)
src/control/*               (MidiEngine, MidiMapper, ControlPath, ControlFeedback,
                              MotorFaderManager, ControlBenchmark)
src/hooks/useScenes.js
src/services/scenesService.js
src/utils/audioUtils.js
src/utils/wavEncoder.js
```

### C — LEGACY COMPATIBLE (activo pero con problemas conocidos)
```
src/services/syncService.js   ← importado en App.jsx pero API mismatch (onState/emit no existen)
src/server/index.js           ← Paso 5 server, protocolo compatible con syncService.js viejo
```

### D — PROBABLEMENTE REMOVIBLE (huérfanos, esperando integración)
```
src/live/*                    (Paso 18 — SceneEngine, DCAEngine, TransitionEngine, ShowFileEngine,
                               ChannelSafeSystem, RecallValidator, RemoteSyncBridge,
                               LiveBenchmark, LiveReport)
src/ui/*                      (Paso 17 — ProFader, ConsoleMeter, RenderScheduler, UILayerManager,
                               VirtualChannelList, ConsoleLayout, TouchGuard, UIBenchmark,
                               UIFailsafe, UIReport, console.css)
src/network/client/*          (Paso 16 — NetworkClient, CommandChannel, MeterSubscriber,
                               DiscoveryClient, NetworkBenchmark, NetworkReport)
src/network/server/*          (Paso 16 — NetworkServer, ClientManager, CommandRouter,
                               DeltaStateSync, MeterBroadcaster, DiscoveryServer, NetworkBenchmark)
```
> ⚠ "Removible" = "aún no integrado", NO muerto. Son los sistemas profesionales de Pasos 15–18.

### E — MUERTO / NO USADO
```
(ningún archivo completamente muerto detectado)
```

---

## 9. SISTEMAS DUPLICADOS / PARALELOS

| Función | Sistema Legacy (activo en UI) | Sistema Nuevo (implementado, no wired) |
|---|---|---|
| **Escenas** | `useScenes` → `scenesService` → Electron IPC filesystem | `SceneManager.ts` (localStorage Paso 5) + `SceneEngine.ts` (Paso 18) |
| **Grabación** | `Recorder.jsx` + `blobToWav` → blob en RAM → IPC | `MultitrackRecorder.ts` wired en AudioEngineSingleton, no en UI |
| **Sync red** | `syncService.js` (Paso 5, namespace default, ROTO) | `NetworkClient.ts` (Paso 16, /ctrl+/sync+/meters) |
| **Servidor** | `src/server/index.js` (Paso 5, `npm run server`) | `src/network/server/NetworkServer.js` (Paso 16, no arranca) |
| **UI meters** | `ChannelMeter.jsx` (canvas, onMeterUpdate callback) | `ConsoleMeter.tsx` (Paso 17, uiLayerManager, no importado) |
| **Faders** | `<input type="range">` en Channel.jsx | `ProFader.tsx` (Paso 17, Pointer Events, no importado) |

---

## 10. BASELINE DE RENDIMIENTO

| Métrica | Valor estimado | Base |
|---|---|---|
| Tiempo hasta DOMContentLoaded | < 200ms | Vite dev server |
| Tiempo AudioEngine.initialize() | 800–1500ms | Tone.start() + WorkletManager + 6 canales |
| Heap JS tras init | ~60–120 MB | Tone.js + AudioNodes + SAB + Zustand |
| RAF loops activos | 3 | MeteringEngine + PerfMonitor + DSPLoadBalancer |
| setIntervals activos | 3 | Watchdog + CPUSafety + Persistence |
| AudioNodes vivos | ~70–90 | ChannelStrip × 6 + buses + FX |
| Socket.IO sockets | 0–1 | syncService (si servidor disponible) |
| IPC handlers registrados | 14 | main.cjs |

---

## RESUMEN EJECUTIVO

### Lo que funciona hoy
| Sistema | Estado |
|---|---|
| Boot DSP completo (19 pasos) | ✅ Funcional |
| Metering canvas (ChannelMeter) | ✅ Funcional |
| Escenas filesystem (IPC) | ✅ Funcional |
| Grabación legacy (blob→WAV) | ✅ Funcional |
| Safe mode | ✅ Funcional |
| Crash logging a disco | ✅ Funcional |
| Native DSP Rust + fallback | ✅ Funcional |
| AUX buses, subgroups, FX buses | ✅ Wired (no en UI) |
| MIDI control surface | ✅ Wired |
| Mix engine, loudness, pan law | ✅ Wired |
| Scalability systems | ✅ Wired |

### Lo que está roto hoy
| Bug | Severidad |
|---|---|
| `syncService.onState()` + `syncService.emit()` no existen → sync siempre offline | 🔴 CRÍTICO |

### Riesgos de purge

| Módulo | Riesgo | Acción segura |
|---|---|---|
| `syncService.js` | BAJO — solo 1 importador (App.jsx) | Fijar App.jsx, luego eliminar |
| `src/server/index.js` | BAJO — proceso separado | Migrar `npm run server` a NetworkServer.js |
| `src/utils/wavEncoder.js` | BAJO — solo usado en Recorder.jsx | Eliminar cuando Recorder use MultitrackRecorder |
| `src/audio/state/SceneManager.ts` | MEDIO — wired en AudioEngineSingleton | Unificar con SceneEngine antes de eliminar |
| `ChannelMeter.jsx` | BAJO | Reemplazar por ConsoleMeter.tsx al integrar Paso 17 |

### Módulos PELIGROSOS de tocar
- `AudioEngineSingleton.ts` — 1879 líneas, 19 pasos de init, núcleo de todo
- `mixerStore.js` — todos los componentes dependen de él
- `ChannelStrip.ts` — DSP chain por canal, afecta el audio directamente
- `AudioBridge.ts` — única API pública del engine para la UI

### Integraciones pendientes (por prioridad)
1. **Fijar bug syncService** — 5 líneas en App.jsx
2. **Conectar Paso 17 (UI)** — sustituir `<input range>` por `ProFader`, `ChannelMeter` por `ConsoleMeter`
3. **Conectar Paso 16 (red)** — reemplazar syncService.js con NetworkClient.ts en App.jsx
4. **Conectar Paso 18 (live)** — integrar SceneEngine en SceneManager.jsx
5. **Migrar grabación** — conectar Recorder.jsx a MultitrackRecorder (ya wired en engine)

---

*Generado por auditoría estática de código — 2026-05-10*
*Commit de referencia: bc87e28 (ONA v1 pre-legacy-audit backup)*
