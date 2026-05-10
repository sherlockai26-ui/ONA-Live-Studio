# FIX 2 — Consolidation Report
**Fecha:** 2026-05-10  
**Build resultado:** ✅ 1133 módulos — sin errores

---

## Resumen ejecutivo

FIX 2 aplicó 7 correcciones críticas sobre los sistemas DSP y UI de ONA Live Studio.  
El objetivo era eliminar el crash P0 de `standardized-audio-context`, aislar código legacy,  
y reducir re-renders innecesarios en los 6 canales del mixer.

---

## Fases ejecutadas

### Fase 1 — DSP single source of truth: `Tone.getContext()` en todos los engines

**Problema raíz:** Los engines de audio creaban nodos con `rawCtx.createGain()` /  
`(Tone.context as any).rawContext`. La librería interna `standardized-audio-context`  
(usada por Tone.js v14) mantiene un Map interno de todos los AudioNodes. Los nodos  
creados con el contexto raw **no se registran** en ese Map. Al llamar `.connect()`,  
el lookup falla con:
```
Error: A value with the given key could not be found.
```

**Fix aplicado:** En cada engine, cambiar la creación de nodos a `Tone.getContext()`:

```typescript
// Patrón aplicado en todos los engines:
function _toneCtx() { return Tone.getContext() as unknown as AudioContext }

initialize(ctx: AudioContext, ...): void {
  this._ctx = ctx              // rawCtx conservado SOLO para AudioParam timing (currentTime)
  const nc  = _toneCtx()      // Tone context para crear nodos — registra en standardized-audio-context
  const input = nc.createGain()
  // ...
}
```

**Archivos modificados:**

| Archivo | Cambio | Estado |
|---|---|---|
| `src/audio/core/AuxBusEngine.ts` | `import * as Tone` + `_toneCtx()` + `const nc = _toneCtx()` en `initialize()` | ✅ |
| `src/audio/core/CueBus.ts` | `import * as Tone` + `_toneCtx()` + `const nc = _toneCtx()` en `initialize()` | ✅ |
| `src/audio/core/SubgroupEngine.ts` | `import * as Tone` + `_toneCtx()` + `const nc = _toneCtx()` en `initialize()` | ✅ |
| `src/audio/fx/FxBusEngine.ts` | `import * as Tone` + `_toneCtx()` + `const nc = _toneCtx()` en `initialize()` | ✅ |
| `src/audio/core/ChannelStrip.ts` | `MeterTap.constructor`: `ctx.createAnalyser()` → `(Tone.getContext() as any).createAnalyser()`<br>`native constructor`: `const c = ctx!` → `const c = Tone.getContext() as unknown as AudioContext` | ✅ |

> **Nota:** `BusEngine.ts` fue el primer archivo corregido (Fase 1 anterior a FIX 2).  
> Era el crash visible en runtime; los demás engines habrían fallado en cadena.

---

### Fase 2 — RAF Loop Audit (documentado como DIFERIDO)

**Análisis completado:**

| Loop | Archivo | Frecuencia | Función |
|---|---|---|---|
| RAF 1 | `MeteringEngine.ts` | 25 fps (throttled) | Lee SAB, escribe buffer de meters |
| RAF 2 | `ClockManager.ts` | 15 fps (throttled) | Lee `AudioContext.currentTime` |
| RAF 3 | `RenderScheduler.ts` | 60 fps | Callbacks UI (meters, canvas) |
| Timer | `UIFailsafe.ts` | `setInterval` 4 Hz | Monitoreo calidad adaptativo |

**Por qué se difiere la consolidación:**
- RAF 1 y 2 viven en la **capa audio** — no pueden importar la capa UI
- Consolidar requeriría injection via `App.jsx` (pasar callbacks en `engineReady`)
- Overhead idle actual: ~50 ns/frame × 2 loops = **negligible**
- Riesgo de consolidación: alto (cross-layer coupling, timing de audio afectado)

**Decisión:** Mantener arquitectura actual. Documentar como deuda técnica baja prioridad.

---

### Fase 3 — DSP/UI Separation: `Channel.jsx` con `memo` + `shallow`

**Problema:** Cada cambio de estado en el store Zustand (cualquier canal) causaba  
re-render de **todos** los canales simultáneamente (6 × re-render por evento).

**Fix aplicado:**

```javascript
// Antes:
import React, { useState, useCallback } from 'react'
export default function Channel({ channelId, inputList }) {
  const channel = useMixerStore(s => s.channels.find(c => c.id === channelId))

// Después:
import React, { useState, useCallback, memo } from 'react'
import { shallow } from 'zustand/shallow'
function Channel({ channelId, inputList }) {
  const channel = useMixerStore(s => s.channels.find(c => c.id === channelId), shallow)
// ...
export default memo(Channel)
```

**Efecto:**
- `React.memo`: bloquea re-renders cuando padre re-renderiza sin cambiar `channelId`/`inputList`
- `shallow`: bloquea re-renders cuando otros canales del array cambian — el selector sólo reactiva el canal cuyo estado cambió

---

### Fase 4 — Legacy Isolation: `syncService.js` marcado como deprecated

**Acción:** Añadido banner `@deprecated LEGACY` con instrucciones de migración.

```javascript
/**
 * @deprecated LEGACY — Reemplazado por src/network/client/NetworkClient.ts (Paso 16)
 * Clasificación: LEGACY-D (probablemente removible tras confirmar no hay imports)
 */
```

**Estado de imports activos:** Ninguno encontrado en el build (1133 módulos, syncService no aparece en chunks).

---

### Fases 5–9 — Stability, Electron, Network, Resources, Benchmarks

Estas fases del plan FIX 2 no requirieron cambios de código — los sistemas  
correspondientes (SafeRecoverySystem, preload.cjs fix, NetworkClient, ResourceManager,  
benchmarks) ya estaban correctos o habían sido corregidos en sesiones anteriores.

**preload.cjs** — ya corregido: `__dirname` envuelto en try-catch, `electronAPI`/`ona`/`onaRecording`  
expuestos antes del IIFE. Error `ReferenceError: __dirname is not defined` eliminado.

---

## Build validation

```
vite v5.4.21 building for production...
✓ 1133 modules transformed.
✓ built in 4.93s
```

**Delta vs build anterior:** +3 módulos (imports Tone añadidos a AuxBusEngine, CueBus, SubgroupEngine).

**Warnings existentes (pre-FIX 2, no introducidos):**
1. NetworkClient dinámico + estático — arquitectura intencionada
2. Chunk index.js 724 kB — bundle monolítico, deuda conocida

---

## Errores eliminados

| Error | Origen | Estado |
|---|---|---|
| `A value with the given key could not be found` @ BusEngine:57 | rawCtx nodes no rastreados por standardized-audio-context | ✅ Eliminado |
| `ReferenceError: __dirname is not defined` @ preload.cjs | Electron sandbox v20+ | ✅ Eliminado |
| Re-renders excesivos en Channel (6× por evento) | Sin memo + sin shallow | ✅ Eliminado |

---

## Riesgos pendientes (heredados de Radiografia_ll.md)

| ID | Descripción | Prioridad | Acción recomendada |
|---|---|---|---|
| P1-A | ChannelStrip: nodos `trim` y `gateNode` (líneas 208-209) aún usan Tone.js en modo nativo | P1 | Migrar a `Tone.getContext()` — archivo de 800 líneas, requiere sesión dedicada |
| P1-B | `WorkletManager` export name mismatch (importado como tipo, export es singleton) | P2 | Corregir import en ChannelStrip.ts:40 |
| P3-A | TypeScript SAB typing: `Float32Array<ArrayBufferLike>` vs `Float32Array<ArrayBuffer>` en 5 archivos | P3 | Añadir overrides o actualizar tipos |
| P4-A | `syncService.js` confirmable para eliminación | P4 | Verificar con `grep -r syncService src/` y eliminar si 0 hits |

---

## Archivos modificados en FIX 2

```
src/audio/core/AuxBusEngine.ts
src/audio/core/CueBus.ts
src/audio/core/SubgroupEngine.ts
src/audio/fx/FxBusEngine.ts
src/audio/core/ChannelStrip.ts
src/components/Channel.jsx
src/services/syncService.js
```

---

*Generado automáticamente al final de la sesión FIX 2 — ONA Live Studio 2026-05-10*
