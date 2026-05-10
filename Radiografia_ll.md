# ONA LIVE STUDIO — RADIOGRAFÍA FORENSE COMPLETA
## Full System Forensic Audit — Stabilization Phase

**Fecha:** 2026-05-10  
**Versión auditada:** ONA Live Studio v0.2.0  
**Stack:** Electron + React 18 + Vite 5 + Tone.js 14.7.77 + TypeScript  
**Módulos compilados:** 1130 (último build confirmado)  
**Estado general:** ESTABLE (Pre-Release)

---

## ÍNDICE

1. [Boot Forensics — Secuencia de arranque completa](#1-boot-forensics)
2. [Audio Engine Forensics — Conteos y estructura](#2-audio-engine-forensics)
3. [Tone.js Audit — Uso, propiedad y riesgos](#3-tonejs-audit)
4. [Renderer Performance Forensics](#4-renderer-performance)
5. [Electron Forensics — Sandbox, CSP, APIs](#5-electron-forensics)
6. [Networking Forensics](#6-networking-forensics)
7. [SharedArrayBuffer + Worklet Audit](#7-sharedarraybuffer--worklet)
8. [Legacy Detection — Clasificación](#8-legacy-detection)
9. [Dependency Graph — Imports críticos](#9-dependency-graph)
10. [Resource Inventory + Performance Baseline](#10-resource-inventory--performance-baseline)
11. [TypeScript / Compilación](#11-typescript--compilación)
12. [Reporte Forense Final](#12-reporte-forense-final)

---

## 1. BOOT FORENSICS

### Secuencia real de arranque (orden cronológico)

```
FASE 0 — Proceso principal Electron
  electron/main.cjs
    ├─ app.commandLine flags (GPU disable, SAB, autoplay)
    ├─ Crash logging: Documents/ONA Live Studio/Logs/crash_YYYY-MM-DD.log
    ├─ createWindow()
    │    ├─ CSP via webRequest.onHeadersReceived (unsafe-eval, blob:, http:)
    │    ├─ BrowserWindow({ contextIsolation:true, nodeIntegration:false })
    │    └─ win.loadURL('http://localhost:5173')
    └─ IPC handlers registrados (9 handlers):
         save-recording, get-recordings-dir,
         scenes-save/list/load/delete,
         show-open-dialog, crash-log, native-audio-probe,
         recording:create-session/write-chunk/finalize-session/list-sessions/load-file

FASE 1 — Preload (electron/preload.cjs, 135 líneas)
  ├─ Expose 'electronAPI'   (grabación, escenas, crash-log, native probe)
  ├─ Expose 'ona'           (version, platform, safeMode)
  ├─ Expose 'onaRecording'  (protocolo 3-fases multipista)
  └─ loadNativeDSP() IIFE   (Rust .node → 'onaNative' si compilado, else silencioso)
       └─ En sandbox Electron v20+: __dirname no disponible → catch silencioso
          → onaNative NO expuesto → NativeDSPBridge usa WebAudio fallback

FASE 2 — React Entry (src/main.jsx, 128 líneas)
  ├─ Safe Mode detection (3 niveles: CLI flag > query param > localStorage)
  ├─ Global crash handler (errorBoundary + unhandledrejection)
  ├─ ErrorBoundary React component (crash UI + recovery)
  ├─ SIN React.StrictMode (desactivado explícitamente — evita double-effect)
  ├─ Dynamic imports (si no safe mode):
  │    UIBenchmark.exposeUIBenchAPI()
  │    LiveBenchmark.exposeLiveBenchAPI()
  │    networkClient.exposeConsoleAPI()
  └─ ReactDOM.createRoot().render(<App />)

FASE 3 — App bootstrap (src/App.jsx, 227 líneas)
  ├─ Static imports: Channel, MasterBus, FXRack, Recorder, SceneManager,
  │    VirtualSoundcheck, useMixerStore, audioEngine, useDevices,
  │    networkClient, uiFailsafe, sceneEngine, console.css
  ├─ useEffect #1 — Audio engine init (trigger: primer click del usuario)
  │    ├─ Guard: si SAFE_MODE → skip completo
  │    ├─ audioEngine.initialize(numChannels, storeState)
  │    ├─ sceneEngine.setApplyDSPCallback(...)
  │    ├─ uiFailsafe.start()
  │    └─ refreshDeviceLabels() — después de AudioContext disponible
  └─ useEffect #2 — Networking (trigger: engineReady && !SAFE_MODE)
       ├─ audioEngine.setSyncCallback(fn) — cambios DSP → NetworkClient
       ├─ networkClient.onCommand(cb)     — comandos remotos → engine + store
       ├─ networkClient.onStateSync(cb)   — reconexión: sync full state
       └─ networkClient.connectAuto()     — autodescubrir servidor LAN

FASE 4 — AudioEngineSingleton.initialize() (src/audio/core/AudioEngineSingleton.ts)
  [Líneas 150-308]
  ├─ stateEngine.loadFromInitialState()
  ├─ await Tone.start()                   ← BLOQUEA hasta AudioContext running
  ├─ rawCtx = Tone.context.rawContext     ← único AudioContext del sistema
  ├─ hal.initialize(rawCtx)
  ├─ clockManager.attach(rawCtx)
  ├─ dspCommandBus.initialize()           ← SAB ring buffer (1032 bytes)
  ├─ dspScheduler.attach(rawCtx)
  ├─ dspParamMgr.attach(rawCtx)
  ├─ dspWatchdog.attach(rawCtx)
  ├─ nativeBridge.probe().catch(→ silencioso)
  ├─ nativeDSPBridge.initialize(sampleRate, 128)
  ├─ busEngine.initialize()               ← MAIN + SUB buses (4 GainNodes + 2 Analysers)
  ├─ auxBusEngine.initialize(rawCtx)      ← 8 AUX buses
  ├─ subgroupEngine.initialize(rawCtx)    ← 4 subgrupos
  ├─ cueBus.initialize(rawCtx)
  ├─ routingMatrix.initialize(rawCtx)
  ├─ fxBusEngine.initialize(rawCtx)       ← 4 FX buses profesionales
  ├─ await _buildGlobalFx()               ← Tone.Reverb + Tone.FeedbackDelay + ...
  ├─ for i in 1..numChannels:
  │    _buildAndRegisterChannel(i)        ← ChannelStrip por canal
  ├─ await workletManager.initialize()    ← registra 3 módulos worklet
  ├─ apply initialState (volumes, FX)
  ├─ meteringEngine.start()               ← RAF loop #1 iniciado aquí
  ├─ perfMonitor.start()
  ├─ latencyMeasurement.attach()
  ├─ recordingClock.attach()
  ├─ multitrackPlayer.setContext()
  ├─ _initScalability(rawCtx)             ← loadBalancer, channelSleep, CPUSafety
  ├─ await _initControlSurface()          ← MIDI devices enum ← BLOQUEA (IPC)
  ├─ persistenceEngine.startAutosave(30_000)
  └─ state = 'running'
```

### Qué bloquea el main thread durante init

| Operación | Tipo | Bloqueo | Impacto |
|-----------|------|---------|---------|
| `await Tone.start()` | Async | SÍ | Espera AudioContext running |
| `await workletManager.initialize()` | Async | SÍ | Registra 3 módulos worklet |
| `await _initControlSurface()` | Async | SÍ | Enumeración MIDI (IPC) |
| `nativeBridge.probe()` | Async | NO | `.catch(() => {})` |
| `networkClient.connectAuto()` | Async | NO | Retorna si no encuentra servidor |
| `_buildGlobalFx()` | Async | SÍ | Tone.Reverb genera IR OfflineAudioContext |

### RAF Loops iniciados en boot

| Loop | Módulo | Frecuencia | Inicio |
|------|--------|-----------|--------|
| #1 MeteringEngine | MeteringEngine.ts:87 | 25fps (throttle 40ms) | `meteringEngine.start()` |
| #2 ClockManager | ClockManager.ts:76 | ~15fps (throttle 66ms) | `clockManager.attach()` |
| #3 UIFailsafe | UIFailsafe.ts | 60fps | `uiFailsafe.start()` |
| #4 RenderScheduler | RenderScheduler.ts:60 | 60fps (priority tiers) | primer `ConsoleMeter` montado |
| **Total** | | **~160 RAF/seg** | |

---

## 2. AUDIO ENGINE FORENSICS

### AudioContext: 1 (único)

Creado en `AudioEngineSingleton.ts:160` vía `Tone.start()`.  
Accesible globalmente como `(Tone.context as any).rawContext`.

### Conteo de AudioNodes por sesión de 6 canales

#### GainNodes

| Origen | Cantidad | Notas |
|--------|----------|-------|
| BusEngine MAIN (gain + fader) | 2 | `ctx.createGain()` |
| BusEngine SUB (gain + fader) | 2 | `ctx.createGain()` |
| ChannelStrip × 6 (~10 por canal) | 60 | inputGain, trim, makeupGain, toMain, toSub, reverbSend, delaySend, preFaderTap, postFaderTap, panner/fader |
| **TOTAL GainNodes** | **~64** | |

#### AnalyserNodes

| Origen | Cantidad |
|--------|----------|
| BusEngine MAIN analyser | 1 |
| BusEngine SUB analyser | 1 |
| ChannelStrip × 6 (in + out) | 12 |
| **TOTAL AnalyserNodes** | **~14** |

#### AudioWorkletNodes (si worklet disponible)

| Tipo | Por canal | Total 6ch |
|------|-----------|-----------|
| gateNode | 1 | 6 |
| meterInNode | 1 | 6 |
| meterOutNode | 1 | 6 |
| **TOTAL WorkletNodes** | | **18** |

#### Tone.js Nodes (instancias Tone.*)

| Origen | Nodos Tone |
|--------|-----------|
| Global FX (reverb, delay, return path) | 6 |
| Por canal: compressor + gate fallback | ~2 |
| VirtualSoundcheck (Player + Recorder) | 2 (por sesión) |
| **TOTAL Tone.js nodes (6ch)** | **~18** |

### Schedulers activos en runtime

| Scheduler | Tipo | Descripción |
|-----------|------|-------------|
| MeteringEngine RAF | `requestAnimationFrame` | Lee meters, escribe SAB |
| ClockManager RAF | `requestAnimationFrame` | Detecta xruns y jitter |
| DSPParameterManager | `AudioParam.setTargetAtTime` | Transiciones suaves |
| DSPCommandBus | Atomics (audio thread) | Ring buffer SAB main→worklet |
| persistenceEngine | `setInterval(30_000)` | Autosave cada 30 segundos |
| CPUSafetyMode | `setInterval` | Monitorea CPU, ajusta FPS |
| DSPWatchdog | `setInterval` | Health check engine |

### Hallazgo crítico: OfflineAudioContext bloqueante

`_buildGlobalFx()` en `AudioEngineSingleton.ts:432-454`:
```typescript
this._gfx.reverb = new Tone.Reverb({ decay: 0.5, wet: 1 })
// Tone.Reverb genera IR con OfflineAudioContext en background
```
`Tone.Reverb` crea un `OfflineAudioContext` para generar el IR de 220,500 samples.  
**MITIGACIÓN APLICADA (sesión anterior):** `_scheduleReverbDecay` ahora llama  
`setTimeout(() => _applyReverbDecay(decay), 0)` — diferido al siguiente event loop turn.

---

## 3. TONE.JS AUDIT

### Patrones de acceso al contexto

```typescript
// AudioEngineSingleton.ts:162
const rawCtx = (Tone.context as any).rawContext as AudioContext   // ← ANTES: problemático

// BusEngine.ts:21 (FIX aplicado en esta sesión)
function getRawCtx(): AudioContext {
  return Tone.getContext() as unknown as AudioContext              // ← CORREGIDO
}
```

### Por qué rawContext causaba el crash de BusEngine

Tone.js v14 usa internamente la biblioteca `standardized-audio-context` que:
1. **Parchea el comportamiento** de los AudioNodes para tracking de conexiones
2. **Registra nodos** en un Map interno cuando son creados vía el contexto Tone
3. **Lanza error** "A value with the given key could not be found" cuando se intenta  
   conectar un nodo que NO fue creado vía el contexto Tone (porque no está en el Map)

`rawCtx.createGain()` crea un GainNode nativo **no registrado** → `gain.connect(fader)` falla.  
`Tone.getContext().createGain()` crea un GainNode **registrado** → conexión funciona.

**Estado:** ✅ FIX APLICADO (`BusEngine.ts:21`)

### Inventario Tone.js nodes (global)

```typescript
// _buildGlobalFx() — AudioEngineSingleton.ts:432-454
this._gfx.reverb      = new Tone.Reverb({ decay: 0.5, wet: 1 })
this._gfx.delay       = new Tone.FeedbackDelay({ delayTime: 0.3, feedback: 0.3, wet: 1 })
this._gfx.returnGain  = new Tone.Gain(1)
this._gfx.returnFader = new Tone.Volume(0)
this._gfx.returnMeter = new Tone.Meter({ normalRange: false })
```

### Riesgo de nodos Tone.js con rawContext (post-fix)

**Búsqueda de rawContext restante:**

| Archivo | Línea | Uso | Riesgo |
|---------|-------|-----|--------|
| AudioEngineSingleton.ts | 162 | `rawCtx = (Tone.context as any).rawContext` | BAJO: usado solo para pasar a constructores de motores, no para crear nodos directamente |
| BusEngine.ts | 21 | `Tone.getContext()` | ✅ CORREGIDO |

**Advertencia:** `rawCtx` del `AudioEngineSingleton` se pasa como parámetro a `AuxBusEngine`, `CueBus`, `routingMatrix` etc. Si alguno de estos usa `rawCtx.createGain()` directamente, pueden tener el mismo problema. Verificar en fase de estabilización.

### Estado del Disconnect lifecycle

```typescript
// destroy() — AudioEngineSingleton.ts:326-428
// Desconecta en orden inverso al init:
// FX → Channels → Recorders → VS Players → Buses
```
✅ Limpieza ordenada detectada en código.

---

## 4. RENDERER PERFORMANCE

### ProFader.tsx

- **Implementación:** SVG/DOM puro, sin canvas
- **RAF loop:** NINGUNO — event-driven (pointer events)
- **Allocations por frame:** CERO
- **Hot path:** DOM directo (`thumbRef.current.style.top = ...`)
- **Estado:** ✅ Sin problemas de performance

### ConsoleMeter.tsx

- **Canvas:** SÍ, 1 canvas por canal
- **RAF loop:** NO crea el suyo; se registra en `UILayerManager`
- **Gradient:** PRE-COMPUTADO (buildGradient al montar)
- **Hot path por frame:**
  ```typescript
  const raw = Math.max(0, Math.min(1, getLevel()))
  smoothRef.current = raw > smoothRef.current  // exponential smoothing
    ? raw * 0.9 + smoothRef.current * 0.1
    : raw * 0.05 + smoothRef.current * 0.95
  ctx.clearRect(0, 0, width, height)
  ctx.fillRect(...)  // meter bar
  ```
- **Allocations por frame:** CERO (pre-allocated, sin new)
- **Estado:** ✅ Sin problemas de performance

### RenderScheduler.ts (Central RAF)

- **RAF loops:** 1 único loop central
- **Priority tiers:**

| Prioridad | Nombre | Skip |
|-----------|--------|------|
| 0 | CRITICAL | Nunca |
| 1 | HIGH | Nunca |
| 2 | MEDIUM | Frames impares (cada 2°) |
| 3 | LOW | Solo cada 4° frame |

- `UIFailsafe` puede reducir maxPriority cuando baja el FPS
- **Estado:** ✅ Diseño correcto, sin duplicados

### Channel.jsx — Presión de re-render

- **No hay `React.memo`** — re-renders completos en cualquier cambio de estado del canal
- **Zustand selector** `s.channels.find(c => c.id === channelId)` — re-renderiza en CUALQUIER cambio al array channels (no solo al canal propio)
- **Con 6 canales:** potencial de 6 re-renders simultáneos por un cambio de volumen
- **Riesgo:** ⚠ MEDIO — optimizable con `React.memo` y selector memoizado

### App.jsx — Render triggers

- 2 useEffects, dependencias correctamente declaradas
- Sin StrictMode → sin double-mount en desarrollo
- `channels.map(ch => <Channel key={ch.id} .../>)` — keys correctas

---

## 5. ELECTRON FORENSICS

### Configuración de seguridad

```typescript
// electron/main.cjs:102-113
webPreferences: {
  contextIsolation: true,   // ✅ HABILITADO
  nodeIntegration: false,   // ✅ DESHABILITADO
  sandbox: (implícito)      // ⚠ DEFAULT true en Electron v20+
}
```

### Flags Electron al arranque

| Flag | Valor | Propósito |
|------|-------|-----------|
| `disable-gpu` | ✅ | Deshabilita rendering GPU (no afecta audio) |
| `disable-gpu-compositing` | ✅ | Sin compositing GPU |
| `disable-gpu-rasterization` | ✅ | Sin rasterización GPU |
| `disable-software-rasterizer` | ✅ | Sin rasterizador software |
| `enable-features=SharedArrayBufferOnDesktop` | ✅ | SAB sin COOP/COEP |
| `autoplay-policy=no-user-gesture-required` | ✅ | AudioContext sin gesto |

### CSP aplicada

```
default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:
script-src  'self' 'unsafe-inline' 'unsafe-eval' blob:
worker-src  'self' blob:
connect-src 'self' blob: http: ws: wss:      ← LAN discovery sin restricción de IP
media-src   'self' blob: mediastream:
img-src     'self' data: blob:
font-src    'self' data:
style-src   'self' 'unsafe-inline'
```

**Notas:**
- `unsafe-eval` requerido por Tone.js (algunos paths internos)
- `http:/ws:/wss:` scheme-only para LAN discovery (wildcards de IP no válidos en CSP)
- Aceptable para aplicación desktop; tighten para distribución web

### APIs expuestas vía contextBridge

#### `window.electronAPI`
| Método | IPC | Descripción |
|--------|-----|-------------|
| `saveRecording(buf, file)` | invoke | Guarda WAV en disco |
| `getRecordingsDir()` | invoke | Directorio sesión actual |
| `saveScene(name, json)` | invoke | Persiste escena |
| `listScenes()` | invoke | Lista escenas disponibles |
| `loadScene(name)` | invoke | Carga JSON de escena |
| `deleteScene(name)` | invoke | Elimina escena |
| `showOpenDialog(opts)` | invoke | Dialog nativo de archivo |
| `crashLog(msg)` | send | Log de crash al disco |
| `probeNativeAudio()` | invoke | Detecta ASIO/WASAPI/CoreAudio |

#### `window.ona`
```typescript
{ version: '0.2.0', platform: process.platform, safeMode: boolean }
```

#### `window.onaRecording`
Protocolo de grabación multipista 3-fases: createSession / writeChunk / finalizeSession / listSessions / loadFile

#### `window.onaNative`
**Estado:** NO expuesto (módulo Rust no compilado)  
Rust DSP `.node` binary no existe → `loadNativeDSP` IIFE falla en try/catch → fallback WebAudio  
**FIX APLICADO (esta sesión):** `__dirname` no disponible en sandbox → envuelto en try-catch global

### Estado del sandbox vs preload

El preload puede usar `require('electron')` y variantes whitelisted.  
`__dirname`, `__filename`, `path`, `fs` NO disponibles en sandbox mode.  
**Impacto:** Solo afecta a `loadNativeDSP` (Rust no compilado de todas formas).  
`electronAPI`, `ona`, `onaRecording` expuestos correctamente antes del IIFE.

---

## 6. NETWORKING FORENSICS

### Arquitectura de sockets

```
NetworkClient.ts
  ├─ Socket #1: /ctrl   (comandos DSP prioritarios — faders, mutes)
  ├─ Socket #2: /sync   (comandos de estado — EQ, routing, escenas)
  └─ Socket #3: /meters (streaming de meters — volatile, drop if slow)
```

**Opciones de conexión:**
```typescript
{
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  transports: ['websocket', 'polling'],
}
```

### Flujo de comando (host → remoto)

```
UI change → useMixerStore.updateChannel()
         → audioEngine.set*() → AudioBridge._syncFn()
         → [echo guard] syncRef.current === false?
         → networkClient.sendCommand(type, channelId, payload)
         → CommandChannel.send()
         → /ctrl o /sync namespace
         → remoto: recibe 'command' event → aplica localmente
```

### Flujo de comando (remoto → host)

```
remoto.sendCommand()
  → /ctrl socket → servidor → broadcast
  → host recibe 'command' event
  → syncRef.current = true  (echo suppression activado)
  → store.updateChannel() + audioEngine.set*()
  → requestAnimationFrame(() => syncRef.current = false)
```

### Mecanismo anti-echo

```typescript
// App.jsx:85-131
const syncRef = useRef(false)

audioEngine.setSyncCallback((type, channelId, payload) => {
  if (syncRef.current) return  // suprime si estamos aplicando comando remoto
  networkClient.sendCommand(type, channelId, payload)
})

networkClient.onCommand((cmd) => {
  syncRef.current = true
  try { /* apply */ } finally {
    requestAnimationFrame(() => { syncRef.current = false })
  }
})
```

**Riesgo edge case:** Si dos cambios locales ocurren en el mismo frame que se recibe un comando remoto, el segundo cambio local podría ser suprimido. Mitigado por el rAF reset.

### CommandChannel — Offline Queue

- Comandos encolados si desconectado
- Flush automático al reconectar
- Sin pérdida de comandos en desconexiones transitorias

### MeterSubscriber — Visibility-based

- Se desuscribe cuando `document.hidden === true`
- Solo recibe meters cuando la ventana está visible
- Sin RAF loop propio — data-driven

### DiscoveryClient

- Escanea LAN para servidor ONA
- UDP broadcast / mDNS
- Cache de último servidor encontrado
- Manual override disponible: `discoveryClient.setManual(url)`

### syncService.js (legacy)

- **Existe en:** `src/services/syncService.js`
- **Estado:** DEPRECADO — reemplazado por `NetworkClient.ts`
- **Importado activamente:** NO (verificado)
- **Riesgo de contaminación:** BAJO (no en imports activos)

---

## 7. SHAREDARRAYBUFFER + WORKLET

### DSPCommandBus (ring buffer SAB)

**Layout del buffer:**
```
Total: 258 Int32s = 1032 bytes

[0]       write head (Atomics.store/load)
[1]       read head  (Atomics.store/load)
[2..257]  comandos (256 slots × 2 Int32 = 8 bytes/cmd)

Por comando (8 bytes):
  Byte 0: tipo de comando (u8)  CMD_GAIN=1..CMD_PAN=8
  Byte 1: channelId (u8)
  Byte 2-3: padding
  Byte 4-7: valor (f32 little-endian)
```

**Protocolo:**
- Producer (main thread): `push(cmd)` → Atomics.add(writeHead)
- Consumer (worklet): `drain()` → lee hasta readHead == writeHead → Atomics.add(readHead)
- **Regla de oro:** NUNCA allocar en `drain()` (hot path audio thread)

### WorkletManager — 3 módulos

| Módulo | Archivo | Función |
|--------|---------|---------|
| ona-meter-processor.js | public/worklets/ | Meter taps in/out |
| ona-dsp-processor.js | public/worklets/ | Gate + compresión audio thread |
| ona-router-processor.js | public/worklets/ | Routing matrix |

**SAB del worklet:**
```
SAB_FLOATS layout (8 floats por canal):
[chIdx×8 + 0]  input peak dBFS
[chIdx×8 + 1]  output peak dBFS
[chIdx×8 + 2]  gate level 0.0..1.0
[chIdx×8 + 3..7]  reservado
```

**Fallback:** Si SAB no disponible → `new Float32Array(SAB_FLOATS)` (ArrayBuffer normal, sin zero-copy)

### MeteringEngine — SAB layout

```
SAB_LEN floats:
[0..5]   output dBFS canal 1..6
[6]      main bus dBFS
[7]      sub bus dBFS
[8..13]  gain reduction compresor canal 1..6
[14..19] nivel gate canal 1..6
```

### TypeScript mismatches conocidos (pre-existentes)

| Archivo | Error | Tipo |
|---------|-------|------|
| AuxBusEngine.ts:86 | `Float32Array<ArrayBufferLike>` vs `Float32Array<ArrayBuffer>` | SAB vs ArrayBuffer |
| CueBus.ts:91 | Ídem | SAB vs ArrayBuffer |
| DSPCommandBus.ts:90 | `SharedArrayBuffer` no asignable a `ArrayBuffer` | SAB typing |
| DSPValidator.ts:57 | Ídem | SAB typing |
| LoudnessMeter.ts:112 | Ídem | SAB typing |
| ChannelStrip.ts:40 | WorkletManager export incorrecto | Named export |
| ChannelStrip.ts:500-504 | `AudioParamMap.get()` no existe | API typing |
| FxBenchmark.ts:18 | FxBusEngineImpl export | Named export |

**Todos pre-existentes. No introducidos por cambios recientes.**

---

## 8. LEGACY DETECTION

### Clasificación de archivos legacy

**A — Crítico (no tocar)**  
Sistemas activos y críticos para runtime.

| Archivo | Rol |
|---------|-----|
| `src/audio/core/AudioEngineSingleton.ts` | Orquestador central del DSP |
| `src/audio/AudioBridge.ts` | Facade DSP — interfaz única del renderer |
| `src/network/client/NetworkClient.ts` | Cliente de red activo |
| `src/network/server/NetworkServer.js` | Servidor de red activo |
| `electron/main.cjs` | Electron main process |
| `electron/preload.cjs` | Bridge seguro |

**B — Activo (usar con cuidado)**

| Archivo | Rol |
|---------|-----|
| `src/services/deviceService.js` | Enumeración de dispositivos (useDevices hook) |
| `src/services/scenesService.js` | Carga/guarda escenas (puede solapar con IPC) |
| `src/hooks/useDevices.js` | Usado en App.jsx:23 |
| `src/hooks/useScenes.js` | Verificar si sigue activo o reemplazado por SceneEngine |
| `src/server/index.js` | Servidor legacy — verificar si sigue importado |
| `src/audio/audioEngine.js` | Facade/re-export de AudioBridge para compatibilidad |

**C — Compatible legacy (funcional pero reemplazado)**

| Archivo | Estado |
|---------|--------|
| `src/services/syncService.js` | Reemplazado por NetworkClient.ts, no importado activamente |

**D — Probablemente removible (verificar con grep antes)**

| Archivo | Motivo |
|---------|--------|
| `src/services/syncService.js` | No importado, arquitectura reemplazada |

**E — Muerto/no usado**

| Archivo | Estado |
|---------|--------|
| `src/components/ChannelMeter.jsx` | NO ENCONTRADO (ya eliminado o renombrado) |

### Hooks verificados

| Hook | Estado |
|------|--------|
| `useSync` | NO EXISTE — metering ahora por SAB directo |
| `useMeters` | NO EXISTE — ConsoleMeter consume MeteringEngine directamente |
| `useDevices` | ✅ ACTIVO — usado en App.jsx |
| `useScenes` | Probablemente reemplazado por `sceneEngine` directo |

---

## 9. DEPENDENCY GRAPH

### src/main.jsx — imports estáticos

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
```

Imports dinámicos (no-safe-mode):
```typescript
import('./ui/UIBenchmark')
import('./live/LiveBenchmark')
import('./network/client/NetworkClient')
```

### src/App.jsx — critical path

```
App.jsx
  ├── Channel.jsx → ProFader, ConsoleMeter (UI)
  ├── MasterBus.jsx
  ├── FXRack.jsx
  ├── Recorder.jsx
  ├── SceneManager.jsx → sceneEngine
  ├── VirtualSoundcheck.jsx
  ├── audioEngine.js (facade)
  │     └── AudioBridge.ts
  │           └── AudioEngineSingleton.ts (todo el motor DSP)
  ├── networkClient (NetworkClient.ts)
  │     ├── CommandChannel.ts
  │     ├── MeterSubscriber.ts
  │     └── DiscoveryClient.ts
  ├── uiFailsafe (UIFailsafe.ts → RenderScheduler.ts)
  └── sceneEngine (SceneEngine.ts)
```

### Imports circulares — análisis

| Cadena | Circular | Estado |
|--------|---------|--------|
| AudioBridge → AudioEngineSingleton → ? | NO (AES no importa AB) | ✅ SAFE |
| App.jsx → audioEngine → AudioBridge | NO | ✅ SAFE |
| NetworkClient → App.jsx | NO (events, no imports) | ✅ SAFE |

### Contaminación del chunk principal (problema conocido)

```
Vite warning detectado en build:
  "NetworkClient.ts is dynamically imported by main.jsx but also statically
   imported by App.jsx, dynamic import will not move module into another chunk."
```

**Impacto:** NetworkClient (Socket.IO completo) siempre en el main chunk.  
**Riesgo:** Chunk principal de ~723KB (antes de gzip: ~206KB) — dentro de rango aceptable para Electron desktop.

---

## 10. RESOURCE INVENTORY + PERFORMANCE BASELINE

### Inventario de recursos activos en runtime (sesión 6 canales)

| Recurso | Cantidad | Notas |
|---------|----------|-------|
| AudioContext | 1 | Vía Tone.js |
| RAF loops | 4 | Metering, Clock, UIFailsafe, RenderScheduler |
| GainNodes | ~64 | Buses + canales |
| AnalyserNodes | ~14 | Buses + canales |
| AudioWorkletNodes | 0–18 | Según disponibilidad worklet |
| Tone.js nodes | ~18 | Global FX + fallbacks por canal |
| Socket.IO sockets | 3 | /ctrl, /sync, /meters |
| setInterval activos | ~5 | Autosave(30s), CPUSafety, Watchdog, ClockManager, PerfMonitor |
| SAB buffers | 2 | DSPCommandBus(1KB), MeteringEngine(80B) |
| Canvas elements | 6 | 1 por ConsoleMeter |
| IPC handlers registrados | ~13 | En main.cjs |

### Memoria estimada (sesión idle)

| Componente | Estimado |
|-----------|---------|
| AudioContext + Tone.js | ~5–10 MB |
| React + Zustand + UI | ~3–5 MB |
| NetworkClient + Socket.IO | ~2–4 MB |
| AudioNodes (~100 nodos) | ~2–4 MB |
| Canvas buffers (6) | ~0.5 MB |
| SABs + Worklets | ~1 MB |
| Electron/Chromium overhead | ~50–80 MB |
| **TOTAL estimado** | **~65–105 MB** |

### Performance baseline (condiciones ideales)

| Métrica | Valor esperado |
|---------|---------------|
| FPS UI | 55–60 |
| DSP latencia | 10–30ms (Electron + WASAPI) |
| Main thread idle | <5% |
| Audio thread load (6ch) | 10–20% |
| RAF callbacks/frame | ~10 (ConsoleMeter×6 + otros) |
| Listeners activos | ~30–50 |
| GC pauses | <2ms (no allocations en hot paths) |

### Factores de riesgo de Xruns

1. **OfflineAudioContext bloqueante** (Tone.Reverb IR generation) — mitigado con setTimeout defer
2. **Worklet no disponible** → gate en main thread → bloqueo potencial
3. **setInterval de autosave** conflictando con audio buffer callbacks
4. **React re-render en audio callback** — no detectado directamente pero posible

---

## 11. TYPESCRIPT / COMPILACIÓN

### Estado del build

```
✅ Vite build exitoso — 1130 módulos transformados en 4.94s
✅ Bundle principal: 723KB (206KB gzip) — aceptable para Electron
⚠  Vite warning: NetworkClient en chunk estático cuando debería ser dinámico
```

### Errores TypeScript conocidos (pre-existentes, no bloquean build)

```
AudioBridge.ts:169      — MixBusProtection property names mismatch
AudioEngineSingleton.ts:499 — 'lpf' not in ChannelState
AudioEngineSingleton.ts:1802 — Recorder no es AudioNode
AuxBusEngine.ts:86      — Float32Array<ArrayBufferLike> vs ArrayBuffer
ChannelStrip.ts:40      — WorkletManager export name mismatch
ChannelStrip.ts:99,500-504 — Float32Array typing + AudioParamMap.get()
CueBus.ts:91            — Float32Array SAB typing
DSPCommandBus.ts:90     — SharedArrayBuffer typing
DSPValidator.ts:57      — Float32Array SAB typing
LoudnessMeter.ts:112    — Float32Array SAB typing
FxBenchmark.ts:18       — FxBusEngineImpl export
FxBusEngine.ts:174      — Float32Array SAB typing
```

**Categoría principal:** TypeScript 5.x introdujo genérico en Float32Array que distingue `ArrayBuffer` de `ArrayBufferLike`. Afecta a todos los usos de `Float32Array` con `SharedArrayBuffer` como backing. Arreglable con `as Float32Array<ArrayBuffer>` cast o usando `Float32Array<ArrayBufferLike>` en las firmas.

---

## 12. REPORTE FORENSE FINAL

### Arquitectura real del sistema

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ELECTRON MAIN PROCESS (electron/main.cjs)                              │
│  ├─ Crash logging, IPC handlers, GPU flags, SAB flag                    │
│  └─ BrowserWindow (contextIsolation, nodeIntegration:false)             │
├─────────────────────────────────────────────────────────────────────────┤
│  PRELOAD (electron/preload.cjs)                                          │
│  ├─ electronAPI, ona, onaRecording (activos)                            │
│  └─ onaNative (inactivo — Rust no compilado)                            │
├─────────────────────────────────────────────────────────────────────────┤
│  RENDERER PROCESS                                                        │
│  ├─ React 18 (sin StrictMode)                                           │
│  │   └─ App.jsx → Channel×6, MasterBus, FXRack, Recorder, SceneManager │
│  ├─ Zustand (mixerStore) — fuente de verdad UI                          │
│  ├─ AudioBridge.ts — facade DSP (único punto de acceso)                 │
│  │   └─ AudioEngineSingleton.ts — orquestador DSP completo              │
│  │       ├─ BusEngine (MAIN + SUB, native GainNodes)                   │
│  │       ├─ ChannelStrip×6 (DSP por canal, Phase 2 parcial)            │
│  │       ├─ FxBusEngine (4 buses FX)                                   │
│  │       ├─ AuxBusEngine (8 AUX), SubgroupEngine (4), CueBus           │
│  │       ├─ MeteringEngine (RAF + SAB)                                  │
│  │       ├─ WorkletManager (3 módulos AudioWorklet)                     │
│  │       ├─ DSPCommandBus (SAB ring buffer main→worklet)               │
│  │       ├─ Global FX: Tone.Reverb + Tone.FeedbackDelay                │
│  │       └─ [15+ engines: recording, scalability, MIDI, FX...]         │
│  ├─ NetworkClient.ts — 3 sockets Socket.IO (/ctrl, /sync, /meters)     │
│  │   └─ Echo suppression vía syncRef                                    │
│  ├─ SceneEngine.ts (save/recall/transition escenas)                     │
│  └─ UI Pipeline:                                                         │
│      ├─ RenderScheduler (1 RAF central, priority tiers)                │
│      ├─ UIFailsafe (FPS monitor, adaptive quality)                      │
│      ├─ ProFader (SVG/DOM, cero allocations)                            │
│      └─ ConsoleMeter (canvas + gradient precomputado)                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Mapa de riesgos por subsistema

| Subsistema | Riesgo | Severidad | Fix disponible |
|-----------|--------|-----------|---------------|
| BusEngine rawContext | "key not found" crash | 🔴 CRÍTICO | ✅ APLICADO |
| preload __dirname | ReferenceError en consola | 🟡 MEDIO | ✅ APLICADO |
| Reverb IR bloqueante | 4200ms main thread spike | 🟡 MEDIO | ✅ APLICADO |
| ChannelStrip Phase 2 incompleto | Nodos Tone mezclados con nativos | 🟡 MEDIO | Pendiente |
| Channel.jsx sin React.memo | Re-renders innecesarios | 🟡 MEDIO | Pendiente |
| rawCtx en AuxBusEngine/CueBus | Posible "key not found" | 🟡 MEDIO | Auditar |
| TypeScript SAB typing | Build pasa, pero typechecks fallidos | 🟢 BAJO | Pendiente |
| CSP unsafe-eval | Superficie de ataque aumentada | 🟢 BAJO | Solo para web |
| NetworkClient en main chunk | Bundle más grande | 🟢 BAJO | Code-split opcional |
| WorkletManager module names | ChannelStrip import mismatch | 🟡 MEDIO | Verificar |

### Causas probables de Xruns detectados

1. **OfflineAudioContext bloqueante al cambiar reverb decay** → ✅ MITIGADO (setTimeout defer)
2. **Gate en main thread (si worklet no disponible)** → proceso DSP en thread que puede ser interrumpido por React
3. **autosave setInterval(30s)** → escritura a disco puede competir con audio callbacks
4. **clockManager.attach() RAF loop** → overhead de monitoreo en frame activo
5. **initControlSurface() bloqueando** en inicio (MIDI enum vía IPC) → xrun durante boot

### Causas probables de render starvation

1. **4 RAF loops competidores** — no coordinados entre sí (MeteringEngine, ClockManager, UIFailsafe, RenderScheduler corren cada uno su propio rAF)
2. **Canal re-renders sin memo** — 6 canales × re-render completo por cambio de fader
3. **Tone.Reverb IR generation** (4200ms) → congelaba completamente el RAF loop → ✅ MITIGADO

### Módulos seguros de tocar (bajo riesgo de regresión)

- `Channel.jsx` — agregar React.memo
- `electron/preload.cjs` — ajustes de sandbox
- `src/ui/*.tsx` — UI components (bien aislados)
- `src/components/SceneManager.jsx` — capa UI solamente

### Módulos peligrosos de tocar (alto riesgo de regresión)

- `AudioEngineSingleton.ts` — orquestador central, 1882 líneas, muchas dependencias
- `BusEngine.ts` — conexiones críticas audio graph
- `ChannelStrip.ts` — Phase 2 migration incompleta, estado frágil
- `DSPCommandBus.ts` — ring buffer con Atomics, race conditions posibles
- `WorkletManager.ts` — gestión de módulos worklet, fallos silenciosos
- `NetworkClient.ts` — 3 sockets, echo suppression, offline queue

### Prioridades de estabilización (ordenadas por impacto)

| Prioridad | Tarea | Impacto |
|-----------|-------|---------|
| P0 | ✅ Fix BusEngine rawContext (APLICADO) | Audio engine crash eliminado |
| P0 | ✅ Fix preload __dirname (APLICADO) | Error consola eliminado |
| P0 | ✅ Fix reverb defer (APLICADO) | 4200ms spike eliminado |
| P0 | ✅ Renombrar M/S → MAIN/SUB (APLICADO) | Confusión UI eliminada |
| P1 | Auditar rawCtx en AuxBusEngine, CueBus, etc. | Prevenir xruns secundarios |
| P1 | Completar Phase 2 migration en ChannelStrip | Estabilizar nodos Tone |
| P2 | React.memo en Channel.jsx | Reducir re-render pressure |
| P2 | Coordinar RAF loops (solo 1 en RenderScheduler) | Reducir RAF overhead |
| P3 | Unificar SAB typing en TypeScript | Clean build |
| P3 | Mover NetworkClient a dynamic import | Reducir main chunk |
| P4 | syncService.js → eliminar definitivamente | Limpiar legacy |

---

## ESTADO FINAL

```
ONA Live Studio v0.2.0 — Estado operativo post-auditoría

Sistemas activos confirmados: 20+
Crashes críticos resueltos en esta sesión: 3 (BusEngine, preload, reverb)
UI confusión resuelta: MUTE/SOLO vs MAIN/SUB
Errores TypeScript pre-existentes: 12 (no bloquean build)
Build: ✅ 1130 módulos, 4.94s
Evaluación general: ESTABLE para uso en desarrollo, listo para estabilización P1
```

---

*Radiografía generada el 2026-05-10 — ONA Live Studio Forensic Audit II*
