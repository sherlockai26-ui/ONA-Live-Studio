/**
 * ProductionStressTest.ts — Simulación de sesiones largas a tiempo acelerado.
 *
 * Simula 4h/8h/12h en segundos ejecutando operaciones representativas:
 *   - Automatización de faders y parámetros DSP (cada ciclo = 1 minuto simulado)
 *   - Cambios de escena periódicos
 *   - Ciclos de solo/unsolo
 *   - Métricas de memoria y estabilidad al inicio/fin
 *
 * NO hace grabación real ni playback real — esos paths tienen sus propios tests.
 * SÍ mide memory growth del JS heap (útil para detectar leaks de closures y Maps).
 *
 * Uso:
 *   const result = await stressTest.run(engineSingleton, { simulatedHours: 4 })
 *   console.table(result)
 */

import { cpuSafetyMode }   from './CPUSafetyMode'
import { safeRecovery }    from './SafeRecoverySystem'
import { bufferManager }   from '../recording/BufferManager'
import { nodeValidator }   from './NodeLifecycleValidator'

export interface StressTestConfig {
  simulatedHours:   4 | 8 | 12
  channels:         number
  withScenes:       boolean
  withSolo:         boolean
  withAuxSends:     boolean
  withEqAutomation: boolean
}

const DEFAULT_CONFIG: StressTestConfig = {
  simulatedHours:   4,
  channels:         6,
  withScenes:       true,
  withSolo:         true,
  withAuxSends:     true,
  withEqAutomation: true,
}

export interface StressTestResult {
  simulatedHours:   number
  actualDurationMs: number
  cycles:           number

  memStartMb:       number
  memEndMb:         number
  memGrowthMb:      number
  memGrowthPerHour: number

  recoveriesLogged: number
  scenesApplied:    number
  solosCycled:      number
  eqChanges:        number

  nodeLeaks:        number
  finalCpuMode:     string

  bufferXruns:      number
  bufferStability:  string

  passed:           boolean
  verdict:          string
}

class ProductionStressTestImpl {
  private _running = false

  get running(): boolean { return this._running }

  async run(engine: any, cfg: Partial<StressTestConfig> = {}): Promise<StressTestResult> {
    const config = { ...DEFAULT_CONFIG, ...cfg }

    if (this._running) throw new Error('[StressTest] Already running')
    this._running = true

    console.group(`[StressTest] Starting ${config.simulatedHours}h simulation (${config.channels} channels)`)
    const startMs  = performance.now()
    const startMem = this._getHeapMb()

    bufferManager.reset()
    const recoverysBefore = safeRecovery.getHistory().length
    let scenesApplied = 0, solosCycled = 0, eqChanges = 0

    const totalCycles = config.simulatedHours * 60  // 1 cycle ≈ 1 sim-minute

    for (let cycle = 0; cycle < totalCycles && this._running; cycle++) {
      const progress = Math.round((cycle / totalCycles) * 100)
      if (cycle % 60 === 0) console.log(`[StressTest] ${progress}% — ${Math.floor(cycle / 60)}h simulated`)

      // ── Fader automation (every cycle) ──────────────────────────────────────
      for (let ch = 1; ch <= config.channels; ch++) {
        const vol = 40 + Math.sin(cycle * 0.1 + ch) * 30 + 30   // oscillating 40-100
        try { engine.setChannelVolume(ch, Math.round(vol)) } catch (_) {}
      }

      // ── EQ automation (every 5 cycles) ──────────────────────────────────────
      if (config.withEqAutomation && cycle % 5 === 0) {
        for (let ch = 1; ch <= Math.min(config.channels, 2); ch++) {
          const gain = (Math.sin(cycle * 0.07) * 6).toFixed(1)
          try { engine.setChannelEqBand(ch, 2, { gain: parseFloat(gain) }); eqChanges++ } catch (_) {}
        }
      }

      // ── Scene changes (every 10 cycles = 10 sim-min) ─────────────────────────
      if (config.withScenes && cycle % 10 === 0 && cycle > 0) {
        const name = `stress_${cycle}`
        try { engine.saveScene(name); scenesApplied++ } catch (_) {}
      }

      // ── Solo cycles (every 15 cycles) ───────────────────────────────────────
      if (config.withSolo && cycle % 15 === 0) {
        const ch = (cycle % config.channels) + 1
        try {
          engine.setChannelSolo(ch, true,  'pfl')
          engine.setChannelSolo(ch, false, 'pfl')
          solosCycled++
        } catch (_) {}
      }

      // ── AUX send automation (every 20 cycles) ────────────────────────────────
      if (config.withAuxSends && cycle % 20 === 0) {
        for (let ch = 1; ch <= Math.min(config.channels, 2); ch++) {
          try { engine.setChannelAuxSend(ch, 1, { level: 30 + (cycle % 50), preFader: true }) } catch (_) {}
        }
      }

      // Yield every cycle to avoid blocking the event loop
      await new Promise<void>(r => setTimeout(r, 0))
    }

    const endMs  = performance.now()
    const endMem = this._getHeapMb()
    const durationMs  = endMs - startMs
    const memGrowthMb = endMem - startMem
    const recoveriesNow = safeRecovery.getHistory().length
    const nodeReport = nodeValidator.getReport()
    const bufStats   = bufferManager.getStats()

    const passed = memGrowthMb < 100 && nodeReport.potentialLeaks === 0
    const verdict = passed
      ? `✓ PASS — ${memGrowthMb.toFixed(1)}MB growth, ${nodeReport.potentialLeaks} leaks`
      : `✗ FAIL — ${memGrowthMb.toFixed(1)}MB growth, ${nodeReport.potentialLeaks} potential leaks`

    this._running = false
    console.log(`[StressTest] Done in ${(durationMs / 1000).toFixed(1)}s — ${verdict}`)
    console.groupEnd()

    return {
      simulatedHours:   config.simulatedHours,
      actualDurationMs: Math.round(durationMs),
      cycles:           totalCycles,

      memStartMb:       parseFloat(startMem.toFixed(2)),
      memEndMb:         parseFloat(endMem.toFixed(2)),
      memGrowthMb:      parseFloat(memGrowthMb.toFixed(2)),
      memGrowthPerHour: parseFloat((memGrowthMb / config.simulatedHours).toFixed(2)),

      recoveriesLogged: recoveriesNow - recoverysBefore,
      scenesApplied,
      solosCycled,
      eqChanges,

      nodeLeaks:        nodeReport.potentialLeaks,
      finalCpuMode:     cpuSafetyMode.mode,

      bufferXruns:     bufStats.xruns,
      bufferStability: bufStats.stability,

      passed,
      verdict,
    }
  }

  stop(): void { this._running = false }

  private _getHeapMb(): number {
    const mem = (performance as any).memory
    return mem ? mem.usedJSHeapSize / 1048576 : 0
  }
}

export const stressTest = new ProductionStressTestImpl()
