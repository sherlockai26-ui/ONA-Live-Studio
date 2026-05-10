/**
 * ProductionReport.ts — Reporte integral de estabilidad de producción (Paso 11).
 *
 * Agrega métricas de todos los subsistemas en un snapshot estático o continuo.
 * El reporte se puede volcar en consola, exportar a JSON, o registrar en disco.
 *
 * Métricas incluidas:
 *   - CPU mode + jitter promedio
 *   - JS heap: usage + growth indicator
 *   - AudioContext: state, sampleRate, latencia total
 *   - Recovery system: total events, success rate, by-mode breakdown
 *   - Buffer manager: xruns, dropPpm, stability
 *   - Node lifecycle: live count + potential leaks
 *   - Multitrack recording: active, queue stats
 *   - DSP scheduler: drift, starve probability
 *   - Clock drift (audio vs wall)
 */

import { cpuSafetyMode }     from './CPUSafetyMode'
import { safeRecovery }      from './SafeRecoverySystem'
import { nodeValidator }     from './NodeLifecycleValidator'
import { bufferManager }     from '../recording/BufferManager'
import { multitrackRecorder } from '../recording/MultitrackRecorder'
import { latencyMeasurement } from '../recording/LatencyMeasurement'
import { recordingClock }    from '../recording/RecordingClock'
import { dspScheduler }      from './DSPScheduler'
import { clockManager }      from './ClockManager'
import { workletManager }    from './WorkletManager'

export interface ProductionSnapshot {
  timestamp:    string
  uptimeSec:    number

  cpu: {
    mode:          string
    meteringFps:   number
    jitterAvgMs:   number
    dspLoadPct:    number
    gcSpikes:      number
  }

  memory: {
    heapUsedMb:  number
    heapTotalMb: number
    heapLimitMb: number
    available:   boolean
  }

  audio: {
    contextState:  string
    sampleRate:    number
    baseLatencyMs: number
    totalLatencyMs: number
    bufferFrames:  number
    xruns:         number
    workletReady:  boolean
    driftPpm:      number
  }

  recovery: {
    total:     number
    recovered: number
    failed:    number
    successPct: number
    byMode:    Record<string, number>
  }

  buffer: {
    xruns:       number
    stability:   string
    dropRatePpm: number
  }

  recording: {
    active:    boolean
    sessionId: string | null
    queueWrittenMb: number
    queueDroppedMb: number
  }

  nodes: {
    liveCount:  number
    byType:     Record<string, number>
    potentialLeaks: number
  }

  verdict: 'excellent' | 'good' | 'marginal' | 'unstable'
  issues:  string[]
}

class ProductionReportImpl {
  private _startTime = performance.now()

  generate(ctx?: AudioContext | null): ProductionSnapshot {
    const now = new Date().toISOString()
    const uptime = (performance.now() - this._startTime) / 1000

    // CPU
    const dspMetrics  = dspScheduler.getMetrics()
    const cpuConfig   = cpuSafetyMode.config
    const cpu = {
      mode:          cpuSafetyMode.mode,
      meteringFps:   Math.round(1000 / cpuConfig.meteringIntervalMs),
      jitterAvgMs:   parseFloat(dspMetrics.callbackJitterMs.toFixed(2)),
      dspLoadPct:    parseFloat(dspMetrics.bufferStarveProb.toFixed(1)),
      gcSpikes:      dspMetrics.gcSpikes,
    }

    // Memory
    const mem = (performance as any).memory
    const memory = {
      heapUsedMb:  mem ? parseFloat((mem.usedJSHeapSize  / 1048576).toFixed(1)) : 0,
      heapTotalMb: mem ? parseFloat((mem.totalJSHeapSize / 1048576).toFixed(1)) : 0,
      heapLimitMb: mem ? parseFloat((mem.jsHeapSizeLimit / 1048576).toFixed(0)) : 0,
      available:   !!mem,
    }

    // Audio
    const latency = latencyMeasurement.getLast() ?? latencyMeasurement.measure()
    const driftPpm = recordingClock.getDriftPpm()
    const audio = {
      contextState:   ctx?.state ?? 'unknown',
      sampleRate:     latency.sampleRate,
      baseLatencyMs:  parseFloat(latency.baseLatencyMs.toFixed(2)),
      totalLatencyMs: parseFloat(latency.totalLatencyMs.toFixed(2)),
      bufferFrames:   latency.bufferFrames,
      xruns:          clockManager.getXruns(),
      workletReady:   workletManager.isReady(),
      driftPpm:       parseFloat(driftPpm.toFixed(1)),
    }

    // Recovery
    const recStats = safeRecovery.getStats()
    const recovery = {
      total:      recStats.total,
      recovered:  recStats.recovered,
      failed:     recStats.failed,
      successPct: recStats.total > 0 ? Math.round(recStats.recovered / recStats.total * 100) : 100,
      byMode:     recStats.byMode as Record<string, number>,
    }

    // Buffer
    const bufStats = bufferManager.getStats()
    const buffer = {
      xruns:       bufStats.xruns,
      stability:   bufStats.stability,
      dropRatePpm: parseFloat(bufStats.dropRatePpm.toFixed(1)),
    }

    // Recording
    const recStats2 = multitrackRecorder.getStats()
    const recording = {
      active:         recStats2.active,
      sessionId:      recStats2.session?.id ?? null,
      queueWrittenMb: parseFloat((recStats2.queue.written / 1048576).toFixed(2)),
      queueDroppedMb: parseFloat((recStats2.queue.dropped / 1048576).toFixed(4)),
    }

    // Nodes
    const nodeReport = nodeValidator.getReport()
    const nodes = {
      liveCount:      nodeReport.liveCount,
      byType:         nodeReport.byType,
      potentialLeaks: nodeReport.potentialLeaks,
    }

    // Verdict + issues
    const issues: string[] = []
    if (nodeReport.potentialLeaks > 0) issues.push(`${nodeReport.potentialLeaks} potential AudioNode leaks`)
    if (bufStats.xruns > 0)            issues.push(`${bufStats.xruns} buffer XRuns recorded`)
    if (recStats.failed > 0)           issues.push(`${recStats.failed} unrecovered failures`)
    if (recording.queueDroppedMb > 0)  issues.push(`${recording.queueDroppedMb}MB dropped from disk queue`)
    if (cpu.jitterAvgMs > JITTER_HIGH) issues.push(`High DSP jitter: ${cpu.jitterAvgMs}ms avg`)
    if (Math.abs(driftPpm) > 100)      issues.push(`Clock drift: ${driftPpm.toFixed(0)}ppm`)

    let verdict: ProductionSnapshot['verdict']
    if (issues.length === 0)  verdict = 'excellent'
    else if (issues.length <= 1) verdict = 'good'
    else if (issues.length <= 3) verdict = 'marginal'
    else                         verdict = 'unstable'

    return {
      timestamp: now, uptimeSec: parseFloat(uptime.toFixed(1)),
      cpu, memory, audio, recovery, buffer, recording, nodes,
      verdict, issues,
    }
  }

  /** Print a formatted report to the browser console. */
  print(ctx?: AudioContext | null): ProductionSnapshot {
    const r = this.generate(ctx)
    const icon = r.verdict === 'excellent' ? '✓' : r.verdict === 'good' ? '◑' : r.verdict === 'marginal' ? '⚠' : '✗'

    console.group(`${icon} [ONA PRODUCTION REPORT] ${r.timestamp} — ${r.verdict.toUpperCase()}`)
    console.log(`Uptime:    ${r.uptimeSec}s`)
    console.log(`CPU mode:  ${r.cpu.mode.toUpperCase()} | Meter: ${r.cpu.meteringFps}fps | Jitter: ${r.cpu.jitterAvgMs}ms | GC spikes: ${r.cpu.gcSpikes}`)
    console.log(`Memory:    ${r.memory.heapUsedMb}MB / ${r.memory.heapTotalMb}MB (limit: ${r.memory.heapLimitMb}MB)${!r.memory.available ? ' [N/A - not Chromium]' : ''}`)
    console.log(`Audio:     ${r.audio.contextState} @ ${r.audio.sampleRate}Hz | lat: ${r.audio.totalLatencyMs}ms | xruns: ${r.audio.xruns} | worklet: ${r.audio.workletReady ? '✓' : '✗'} | drift: ${r.audio.driftPpm}ppm`)
    console.log(`Recovery:  ${r.recovery.total} events | ${r.recovery.successPct}% recovered | failures: ${r.recovery.failed}`)
    console.log(`Buffer:    stability=${r.buffer.stability} | xruns=${r.buffer.xruns} | drops=${r.buffer.dropRatePpm}ppm`)
    console.log(`Recording: ${r.recording.active ? `ACTIVE [${r.recording.sessionId}]` : 'idle'} | written: ${r.recording.queueWrittenMb}MB | dropped: ${r.recording.queueDroppedMb}MB`)
    console.log(`Nodes:     ${r.nodes.liveCount} live | leaks: ${r.nodes.potentialLeaks}`)
    if (r.issues.length > 0) {
      console.warn('Issues:')
      r.issues.forEach(i => console.warn(`  ⚠ ${i}`))
    }
    console.groupEnd()
    return r
  }

  resetTimer(): void { this._startTime = performance.now() }
}

const JITTER_HIGH = 20

export const productionReport = new ProductionReportImpl()
