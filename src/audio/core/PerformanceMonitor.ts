/**
 * PerformanceMonitor.ts — Profiling integral del pipeline de audio de ONA Live Studio
 *
 * Métricas UI:
 *   fps()         → FPS actual (avg últimos 30 frames)
 *   memory()      → heap usage MB (solo Chromium)
 *
 * Métricas DSP Graph:
 *   graphStats()  → nodos/aristas de DSPGraphEngine
 *
 * Métricas pipeline de audio (Paso 3):
 *   audioLatency() → latencia total del AudioContext en ms
 *   clockState()   → snapshot completo del ClockManager
 *   xruns()        → contador de xruns detectados
 *   channels()     → canales conectados en HAL
 *   native()       → estado del NativeBridge (ASIO/WASAPI)
 *
 * Métricas DSP realtime (Paso 4):
 *   dsp()          → drift AudioContext, GC spikes, buffer starvation, worklets, commandBus
 *   dspAudit()     → hot path audit (allocations, logging, SAB availability)
 *
 * Expuesto en consola como: window.__ONA_PERF
 */

import { dspGraph }     from './DSPGraphEngine'
import { clockManager } from './ClockManager'
import { hal }          from '../hardware/HardwareAbstractionLayer'
import { nativeBridge } from '../hardware/NativeBridge'
import { dspScheduler } from './DSPScheduler'

class PerformanceMonitor {
  private _frameTimes: number[] = []
  private _rafId: number | null = null

  start(): void {
    if (this._rafId !== null) return
    let last = performance.now()
    const tick = (now: number) => {
      this._rafId = requestAnimationFrame(tick)
      const delta = now - last
      last = now
      this._frameTimes.push(delta)
      if (this._frameTimes.length > 30) this._frameTimes.shift()
    }
    this._rafId = requestAnimationFrame(tick)
  }

  stop(): void {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null }
    this._frameTimes = []
  }

  // ── Métricas UI ───────────────────────────────────────────────────────────────

  fps(): number {
    if (this._frameTimes.length === 0) return 0
    const avg = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length
    return Math.round(1000 / avg)
  }

  memory(): string {
    const mem = (performance as any).memory
    if (!mem) return 'N/A (solo Chromium)'
    const used  = (mem.usedJSHeapSize   / 1048576).toFixed(1)
    const limit = (mem.jsHeapSizeLimit  / 1048576).toFixed(0)
    const total = (mem.totalJSHeapSize  / 1048576).toFixed(1)
    return `${used}MB used / ${total}MB total / ${limit}MB limit`
  }

  // ── Métricas DSP Graph ────────────────────────────────────────────────────────

  graphStats(): { nodes: number; edges: number; matrix: Record<string, string[]> } {
    const stats = dspGraph.getStats()
    return { ...stats, matrix: dspGraph.getMatrix() }
  }

  // ── Métricas pipeline de audio ────────────────────────────────────────────────

  audioLatency(): string {
    const lat = clockManager.getLatencyMs()
    return `${lat.toFixed(2)}ms`
  }

  clockState(): ReturnType<typeof clockManager.getState> {
    return clockManager.getState()
  }

  xruns(): number {
    return clockManager.getXruns()
  }

  resetXruns(): void {
    clockManager.resetXruns()
    console.log('[PERF] Xruns reseteados')
  }

  channels(): ReturnType<typeof hal.getChannelConnections> {
    return hal.getChannelConnections()
  }

  native(): ReturnType<typeof nativeBridge.getCapabilities> {
    return nativeBridge.getCapabilities()
  }

  halLatency(): ReturnType<typeof hal.getLatency> {
    return hal.getLatency()
  }

  // ── Métricas DSP realtime (Paso 4) ───────────────────────────────────────────

  dsp(): ReturnType<typeof dspScheduler.getMetrics> {
    return dspScheduler.getMetrics()
  }

  dspAudit(): string[] {
    return dspScheduler.runHotPathAudit()
  }

  // ── Reporte completo ──────────────────────────────────────────────────────────

  report(): void {
    const g   = this.graphStats()
    const clk = this.clockState()
    const chs = this.channels()
    const nat = this.native()
    const dsp = this.dsp()

    console.group('[ONA PERF] Reporte completo')
    console.log(`FPS:            ${this.fps()}`)
    console.log(`Memoria:        ${this.memory()}`)
    console.log(`Latencia total: ${this.audioLatency()} (base: ${clk.baseLatencyMs.toFixed(1)}ms + output: ${clk.outputLatencyMs.toFixed(1)}ms)`)
    console.log(`Sample rate:    ${clk.sampleRate}Hz`)
    console.log(`Buffer est:     ${clk.bufferSizeEst} samples`)
    console.log(`Xruns:          ${clk.xruns}`)
    console.log(`Jitter RAF:     ${clk.jitterMs.toFixed(2)}ms avg`)
    console.log(`DSP load est:   ${clk.dspLoadPct.toFixed(1)}%`)
    console.log(`Nodos DSP:      ${g.nodes} / Aristas: ${g.edges}`)
    console.log(`— DSP Scheduler (Paso 4) —`)
    console.log(`  Drift ctx/wall: ${dsp.driftMs.toFixed(2)}ms`)
    console.log(`  Jitter callback:${dsp.callbackJitterMs.toFixed(2)}ms avg`)
    console.log(`  GC spikes:      ${dsp.gcSpikes}`)
    console.log(`  Buffer starve:  ${dsp.bufferStarveProb.toFixed(1)}%`)
    console.log(`  Worklets:       ${dsp.workletReady ? '✓' : '✗'}`)
    console.log(`  Cmd bus pending:${dsp.commandsPending}`)
    if (dsp.hotPathWarnings.length > 0) {
      console.warn('  Hot path warnings:', dsp.hotPathWarnings)
    }
    console.log(`Canales HAL:    ${chs.length} conectados`)
    if (chs.length > 0) {
      chs.forEach(c => console.log(`  ch${c.channelId}: ${c.deviceId.slice(0, 12)}… (${Math.round((Date.now() - c.connectedAt) / 1000)}s)`))
    }
    console.log(`Audio nativo:   ${nat.available ? '✓' : '✗'} (ASIO: ${nat.asio ? '✓' : '✗'}, WASAPI: ${nat.wasapi ? '✓' : '✗'})`)
    if (nat.available) console.log(`Devices nativos: ${nat.devices.length}`)
    console.groupEnd()
  }
}

export const perfMonitor = new PerformanceMonitor()

// ── Exposición en consola ─────────────────────────────────────────────────────
;(window as any).__ONA_PERF = {
  fps:          () => perfMonitor.fps(),
  memory:       () => perfMonitor.memory(),
  graphStats:   () => perfMonitor.graphStats(),
  audioLatency: () => perfMonitor.audioLatency(),
  clockState:   () => perfMonitor.clockState(),
  xruns:        () => perfMonitor.xruns(),
  resetXruns:   () => perfMonitor.resetXruns(),
  channels:     () => perfMonitor.channels(),
  native:       () => perfMonitor.native(),
  dsp:          () => perfMonitor.dsp(),
  dspAudit:     () => perfMonitor.dspAudit(),
  report:       () => perfMonitor.report(),
}
