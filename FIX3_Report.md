# FIX 3 — Runtime Stabilization + Stress Hardening Report
**Fecha:** 2026-05-10  
**Build resultado:** ✅ 1133 módulos — sin errores

---

## Resumen ejecutivo

FIX 3 completó la unificación total de AudioContext, eliminó los últimos nodos rawCtx
en el grafo de audio activo, redujo el overhead React en paneles DSP, y validó la
ausencia de listener leaks y sends duplicados.

---

## Fase 1 — Audio Context Unification (Completa)

### Audit realizado

Búsqueda exhaustiva de todas las llamadas a `create*` en el codebase:
`createGain`, `createDelay`, `createBiquadFilter`, `createDynamicsCompressor`,
`createStereoPanner`, `createAnalyser`, `createConvolver`, `createBufferSource`,
`createChannelSplitter`, `createChannelMerger`

### Archivos corregidos (FIX 3)

| Archivo | Cambio | Detalle |
|---|---|---|
| `src/audio/core/ChannelStrip.ts` | Fix P1 — `_trim` sobreescrito | Línea 210: `this._trim = new Tone.Gain(...)` **eliminada** — `_trim` ya estaba correctamente asignada en línea 196 como GainNode nativo |
| `src/audio/core/ChannelStrip.ts` | Fix P1 — `_gateNode` Tone en modo nativo | `new Tone.Gain(1)` → `c.createGain()` — nodo nativo en el path nativo |
| `src/audio/core/ChannelStrip.ts` | Fix P1 — 4 métodos lazy | `setAuxSend`, `setFxBusSend`, `setGroupSend`, `setSolo`: `this._ctx.createGain()` → `(Tone.getContext() as any).createGain()` |
| `src/audio/fx/ReverbEngine.ts` | Añadir `_toneCtx()`, usar `nc` | `Tone.import` + helper + `nc.createGain/createDelay/createBiquadFilter`, `createDenormalKick(nc)` |
| `src/audio/fx/DelayEngine.ts` | Añadir `_toneCtx()`, usar `nc` | Mismo patrón: `nc.createGain/createDelay/createBiquadFilter/createChannelMerger`, `createDenormalKick(nc)` |
| `src/audio/core/RoutingMatrix.ts` | Añadir `_toneCtx()` | `initialize()`: `nc.createGain()` para sumadores de salida. `connect()`: `_toneCtx().createGain()` para celdas de matrix |
| `src/audio/core/MixBusProtection.ts` | Añadir `_toneCtx()` | `nc.createWaveShaper()`, `nc.createDynamicsCompressor()`, `nc.createAnalyser()` |
| `src/audio/core/LoudnessMeter.ts` | Añadir `_toneCtx()` | `nc.createGain()`, `nc.createBiquadFilter()` ×2, `nc.createAnalyser()` |

### Riesgo P1 específico: `_trim` sobreescrito

```typescript
// ANTES (bug):
const trim = c.createGain()        // línea 194: nativo ✓
trim.gain.value = ...
this._trim = trim                  // línea 196: asignado ✓
// ...
this._trim = new Tone.Gain(...)    // línea 210: SOBREESCRIBÍA — nativo perdido, Tone.js activo
this._gateNode = new Tone.Gain(1)  // línea 211: Tone.js en modo nativo

// DESPUÉS (correcto):
const trim = c.createGain()        // línea 194: nativo ✓
trim.gain.value = ...
this._trim = trim                  // línea 196: asignado ✓ — se mantiene
// línea 210: ELIMINADA
this._gateNode = c.createGain()    // línea 211: nativo ✓
```

---

## Fase 2 — Single AudioContext Validation

**Resultado: ✅ AudioContext único confirmado**

| Instancia | Contexto | Estado |
|---|---|---|
| `Tone.start()` en `AudioEngineSingleton.initialize()` | ÚNICO contexto principal | ✓ Guard: `if (this._state !== 'uninitialized') return` |
| `new AudioContext()` en `wavEncoder.js:73` | AISLADO — solo para decodificar WAV | ✓ No conectado al grafo principal |
| `OfflineAudioContext` en `Tone.Reverb` IR | INTERNO Tone.js | ✓ Controlado, ya con debounce en AudioBridge |
| `Tone.context.suspend()` / `resume()` | Operan sobre el contexto único | ✓ |

**No hay contextos duplicados, ocultos ni conflictos de scheduler.**

---

## Fase 3 — Listener + RAF Sanity Pass

**Resultado: ✅ Sin leaks detectados**

Todos los listeners del sistema tienen cleanup correcto:

| Listener | Ubicación | Cleanup |
|---|---|---|
| `window` click (audio unlock) | App.jsx | `{ once: true }` — auto-remove |
| `window` resize | ConsoleLayout.tsx | `removeEventListener` en return |
| `navigator.mediaDevices` devicechange | deviceService.js, DeviceManager.ts | return function con removeEventListener |
| `AudioContext` statechange | SafeRecoverySystem.ts | `removeEventListener` en destroy() |
| scroll, touchmove | VirtualChannelList.tsx, TouchGuard.tsx | cleanup en useEffect return |
| Socket.IO listeners | NetworkClient, CommandChannel, MeterSubscriber | Gestionados por Socket.IO lifecycle |
| `processorerror` en WorkletNode | WorkletManager.ts | Garbage collected con el nodo |

**RAF loops** — confirmados sin cambios (ya auditados en FIX 2):
- MeteringEngine: 25fps throttled, escritura DSP → SAB
- ClockManager: 15fps throttled, AudioContext.currentTime
- RenderScheduler: 60fps, callbacks UI

---

## Fase 4 — React Overhead Reduction

### Componentes optimizados

**`MasterBus.jsx`:**
- `Fader` sub-componente: `function` → `const Fader = memo(function Fader...)`
- `MasterBus`: `export default function` → `function` + `export default memo(MasterBus)`
- `handleMain`, `handleSub`: closures inline → `useCallback(..., [setMain/setSub])`

**`CompPanel.jsx`:**
- `export default function CompPanel` → `function CompPanel` + `export default memo(CompPanel)`
- `set` callback: inline → `useCallback(..., [updateComp, channelId])`
- Imports: añadido `memo, useCallback`

**`GatePanel.jsx`:**
- Mismo patrón que CompPanel

**`EQPanel.jsx`:**
- `BandControl`: `function` → `const BandControl = memo(function BandControl...)`
- `BandControl` ya no suscribe a Zustand — `updateBand` recibido como prop (elimina 7 suscripciones paralelas al mismo selector)
- `set` callback en `BandControl`: inline → `useCallback(..., [updateBand, channelId, band.id, bandIndex])`
- `EQPanel`: `export default function` → `function` + `export default memo(EQPanel)`
- `resetAll`: inline → `useCallback(..., [updateBand, channelId])`

---

## Fase 5 — DSP Safety Pass

**Resultado: ✅ Sin problemas críticos**

| Check | Estado | Detalle |
|---|---|---|
| Node disposal en ChannelStrip | ✓ | Desconecta inputGain, trim, hpf, lpf, gateNode, compressor, makeupGain, eq[7], panner, fader, sends, solo |
| Lazy sends sin duplicados | ✓ | Map-check antes de crear: `if (!send) { create }` — idempotente |
| Reconnect storms | ✓ | try-catch en disconnect, GainNode actualizado via setTargetAtTime |
| destroy() chain completa | ✓ | AudioEngineSingleton.destroy() llama destroy() en todos los subsistemas |
| setInterval cleanup | ✓ | SafeRecoverySystem, MixBusProtection, LoudnessMeter: clearInterval en destroy() |

---

## Fase 6 — Build Validation

```
vite v5.4.21 building for production...
✓ 1133 modules transformed.
✓ built in 4.90s
```

**0 errores. Módulos estables (1133).** Warnings pre-existentes sin cambios.

---

## Estado de AudioNode Creation — Post FIX 3

### Engines con `_toneCtx()` / `nc` pattern (✅ todos):

| Engine | Patrón | Versión corregida en |
|---|---|---|
| BusEngine | `getRawCtx()` → Tone.getContext() | FIX 2 |
| AuxBusEngine | `_toneCtx()` + `nc` | FIX 2 |
| CueBus | `_toneCtx()` + `nc` | FIX 2 |
| SubgroupEngine | `_toneCtx()` + `nc` | FIX 2 |
| FxBusEngine | `_toneCtx()` + `nc` | FIX 2 |
| ChannelStrip (constructor) | `const c = Tone.getContext()` | FIX 2 |
| ChannelStrip (gateNode) | `c.createGain()` | **FIX 3** |
| ChannelStrip (lazy sends) | `(Tone.getContext() as any).createGain()` | **FIX 3** |
| ReverbEngine | `_toneCtx()` + `nc` | **FIX 3** |
| DelayEngine | `_toneCtx()` + `nc` | **FIX 3** |
| RoutingMatrix | `_toneCtx()` + `nc` | **FIX 3** |
| MixBusProtection | `_toneCtx()` + `nc` | **FIX 3** |
| LoudnessMeter | `_toneCtx()` + `nc` | **FIX 3** |

### Engines que no necesitan Tone.getContext():
- `_buildGlobalFx()` — usa Tone.Reverb / Tone.FeedbackDelay (Tone.js nativo, auto-rastreado)
- `FxCpuProtection.createDenormalKick()` — recibe contexto del caller (ahora ReverbEngine/DelayEngine pasan `_toneCtx()`) ✓
- Benchmarks y test signals — crean nodos efímeros en contextos aislados

---

## Riesgos pendientes heredados

| ID | Descripción | Prioridad |
|---|---|---|
| P2-A | `WorkletManager` export name mismatch (ChannelStrip:40 importa `WorkletManager` como tipo, export real es singleton) | P2-TS |
| P3-A | TypeScript SAB typing: `Float32Array<ArrayBufferLike>` vs `Float32Array<ArrayBuffer>` | P3-TS |
| P4-A | `syncService.js` removible (sin imports activos) | P4-LOW |

---

## Errores eliminados en FIX 3

| Error | Módulo | Fix |
|---|---|---|
| `A value with the given key could not be found` al activar FX bus | ReverbEngine, DelayEngine | `_toneCtx()` en constructores |
| `A value with the given key...` al routing matrix | RoutingMatrix | `_toneCtx()` en createGain |
| `A value with the given key...` al activar limiter/protection | MixBusProtection | `_toneCtx()` en attach() |
| `A value with the given key...` al medir loudness | LoudnessMeter | `_toneCtx()` en constructor |
| `_trim` Tone.Gain sobreescribiendo native GainNode | ChannelStrip | Línea 210 eliminada |
| `_gateNode` Tone.Gain en modo nativo (mode mismatch) | ChannelStrip | `c.createGain()` |
| `A value with the given key...` al activar AUX/FX/group/solo sends | ChannelStrip | `Tone.getContext()` en lazy creates |
| Re-renders excesivos en paneles DSP abiertos | EQ/Comp/Gate/MasterBus | `memo` + `useCallback` en todos |

---

## Readiness para sesiones largas

**AudioContext:** Unificado — 0 contextos raw activos en el grafo  
**React:** 4 componentes DSP memorizados — re-renders solo en cambios relevantes  
**Listeners:** Cleanup correcto — sin leaks tras desmontaje  
**DSP chain:** Completamente rastreada por standardized-audio-context

**Lo que NO debe tocarse aún:**
- `_buildGlobalFx()` — usa Tone.Reverb / Tone.FeedbackDelay funcionalmente, no introducir nodos raw
- `WorkletManager.ts` export — pre-existing TS error, no impacta runtime
- Chunking/bundle size — deuda conocida, no afecta estabilidad

**Lo que puede optimizarse después:**
- RAF consolidation (MeteringEngine + ClockManager → RenderScheduler via injection)
- syncService.js eliminación definitiva (confirmar 0 imports)
- TypeScript SAB typing cleanup

---

*Generado automáticamente al final de la sesión FIX 3 — ONA Live Studio 2026-05-10*
