/**
 * UIReport.ts — UI performance and viability report.
 *
 * Sections:
 *   1. FPS stability (avg, p99, spike count)
 *   2. Render layer breakdown (registrations per priority)
 *   3. Max viable channel count (for current device)
 *   4. Touchscreen viability (touch API, pointer events support)
 *   5. Low-end device flag (based on hardware concurrency + memory)
 *   6. Current UIFailsafe stage
 *   7. Issues + recommendations
 *   8. Verdict: excellent / good / marginal / poor
 */

import { renderScheduler } from './RenderScheduler'
import { uiLayerManager } from './UILayerManager'
import { uiFailsafe, type UIQualityStage } from './UIFailsafe'
import type { UIBenchResult } from './UIBenchmark'

export interface UIFullReport {
  timestamp:         string
  fps:               number
  stage:             UIQualityStage
  layerStats:        ReturnType<typeof uiLayerManager.getStats>
  schedulerMetrics:  ReturnType<typeof renderScheduler.getMetrics>
  failsafeMetrics:   ReturnType<typeof uiFailsafe.getMetrics>
  touchSupport:      boolean
  pointerSupport:    boolean
  lowEndDevice:      boolean
  hwConcurrency:     number
  deviceMemoryGB:    number | null
  maxViableChannels: number
  benchResults?:     UIBenchResult[]
  issues:            string[]
  recommendations:   string[]
  verdict:           'excellent' | 'good' | 'marginal' | 'poor'
}

function detectTouchSupport(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0
}

function detectPointerSupport(): boolean {
  return 'PointerEvent' in window
}

function detectLowEnd(): boolean {
  const conc = navigator.hardwareConcurrency ?? 2
  const mem  = (navigator as any).deviceMemory ?? null
  return conc <= 2 || (mem !== null && mem <= 2)
}

function estimateMaxChannels(fps: number, stage: UIQualityStage): number {
  if (stage === 'safe') return 8
  if (fps >= 55) return 96
  if (fps >= 45) return 64
  if (fps >= 30) return 32
  return 16
}

export async function generateUIReport(benchResults?: UIBenchResult[]): Promise<UIFullReport> {
  const issues: string[]          = []
  const recommendations: string[] = []

  const fps            = renderScheduler.getFPS()
  const stage          = uiFailsafe.getStage()
  const layerStats     = uiLayerManager.getStats()
  const schedulerMetrics = renderScheduler.getMetrics()
  const failsafeMetrics  = uiFailsafe.getMetrics()
  const touchSupport   = detectTouchSupport()
  const pointerSupport = detectPointerSupport()
  const lowEnd         = detectLowEnd()
  const hwConc         = navigator.hardwareConcurrency ?? 2
  const deviceMem      = (navigator as any).deviceMemory ?? null

  if (fps < 30)
    issues.push(`[CRIT] FPS ${fps} below 30 — UI will feel sluggish`)
  if (fps < 45)
    issues.push(`[WARN] FPS ${fps} — fader animation may appear choppy`)
  if (stage !== 'full')
    issues.push(`[WARN] UIFailsafe active: stage=${stage} — some UI features are paused`)
  if (!pointerSupport)
    issues.push('[WARN] PointerEvent API not supported — fader fine mode unavailable')
  if (lowEnd)
    issues.push('[INFO] Low-end device detected — recommend ECO performance mode')
  if (benchResults) {
    const failed = benchResults.filter(r => !r.passed)
    failed.forEach(r => issues.push(`[WARN] Bench failed: ${r.test} — ${r.detail}`))
  }

  if (fps < 45)
    recommendations.push('Close other browser tabs or GPU-intensive applications')
  if (lowEnd)
    recommendations.push('Enable ECO mode: fewer channels, reduced meter fps')
  if (!touchSupport)
    recommendations.push('Use a touchscreen device for live fader control')
  if (stage !== 'full')
    recommendations.push(`UIFailsafe is in "${stage}" mode — check CPU load`)

  const maxChannels = estimateMaxChannels(fps, stage)
  const criticals   = issues.filter(i => i.startsWith('[CRIT]')).length
  const warns       = issues.filter(i => i.startsWith('[WARN]')).length
  const verdict     = criticals > 0 ? 'poor'
    : warns > 2      ? 'marginal'
    : warns > 0      ? 'good'
    : 'excellent'

  return {
    timestamp:         new Date().toISOString(),
    fps,
    stage,
    layerStats,
    schedulerMetrics,
    failsafeMetrics,
    touchSupport,
    pointerSupport,
    lowEndDevice:      lowEnd,
    hwConcurrency:     hwConc,
    deviceMemoryGB:    deviceMem,
    maxViableChannels: maxChannels,
    benchResults,
    issues,
    recommendations,
    verdict,
  }
}

export function printUIReport(report: UIFullReport): void {
  const icon = { excellent: '✓', good: '◑', marginal: '⚠', poor: '✗' }[report.verdict]
  console.group(`${icon} [Paso 17] UI Report — ${report.verdict.toUpperCase()} — ${report.timestamp}`)

  console.log('\n=== Render Performance ===')
  console.log(`  FPS:              ${report.fps}`)
  console.log(`  Failsafe stage:   ${report.stage}`)
  console.table(report.schedulerMetrics)

  console.log('\n=== Layer Registrations ===')
  console.table(report.layerStats.byLayer)

  console.log('\n=== Device ===')
  console.log(`  HW threads:       ${report.hwConcurrency}`)
  console.log(`  Device memory:    ${report.deviceMemoryGB ?? 'n/a'} GB`)
  console.log(`  Touch support:    ${report.touchSupport}`)
  console.log(`  Pointer events:   ${report.pointerSupport}`)
  console.log(`  Low-end flag:     ${report.lowEndDevice}`)

  console.log('\n=== Viability ===')
  console.log(`  Max channels:     ${report.maxViableChannels}`)

  if (report.benchResults) {
    console.log('\n=== Benchmark ===')
    console.table(report.benchResults.map(r => ({
      test: r.test, fps: r.avgFps, p99ms: r.p99FrameMs, passed: r.passed,
    })))
  }

  if (report.issues.length > 0) {
    console.log('\n=== Issues ===')
    report.issues.forEach(i => console.log(`  ${i}`))
  }
  if (report.recommendations.length > 0) {
    console.log('\n=== Recommendations ===')
    report.recommendations.forEach(r => console.log(`  → ${r}`))
  }

  console.groupEnd()
}
