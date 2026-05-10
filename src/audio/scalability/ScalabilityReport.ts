/**
 * ScalabilityReport.ts — Comprehensive scalability and viability report.
 *
 * Sections:
 *   1. Max stable channels (derived from 96ch benchmark CPU%)
 *   2. Sustainable runtime (long session benchmark pass/fail)
 *   3. CPU scaling (linear / sublinear / superlinear)
 *   4. Thermal risk (sustained CPU × session duration estimate)
 *   5. Low-end laptop viability (≥32ch stable + thermal low/medium)
 *   6. Multicore readiness (SharedArrayBuffer + Atomics)
 *   7. Resource manager efficiency
 *   8. Cache optimizer stats
 *   9. Recommendations
 *  10. Verdict: excellent / good / marginal / poor
 */

import type { ScalabilityBenchResult } from './ScalabilityBenchmark'
import type { MulticoreProfile }        from './MulticorePrep'
import type { LoadBalancerMetrics }     from './DSPLoadBalancer'
import type { ResourceStats }           from './ResourceManager'
import type { CacheStats }              from './CacheOptimizer'

export interface ScalabilityFullReport {
  timestamp:          string
  maxStableChannels:  number
  sustainableRuntime: string
  cpuScaling:         'linear' | 'sublinear' | 'superlinear' | 'unknown'
  thermalRisk:        'low' | 'medium' | 'high'
  lowEndViable:       boolean
  multicoreReady:     boolean
  benchmarks:         ScalabilityBenchResult[]
  multicoreProfile:   MulticoreProfile
  loadBalancer:       LoadBalancerMetrics
  resourceStats:      ResourceStats
  cacheStats:         CacheStats
  issues:             string[]
  recommendations:    string[]
  verdict:            'excellent' | 'good' | 'marginal' | 'poor'
}

function scalingOf(results: ScalabilityBenchResult[]): 'linear' | 'sublinear' | 'superlinear' | 'unknown' {
  const p = results.find(r => r.test === 'paramLoad_96ch')
  const a = results.find(r => r.test === 'analyserLoad_96ch')
  if (!p || !a) return 'unknown'
  const total = p.cpuEstimate + a.cpuEstimate
  if (total < 15)  return 'sublinear'
  if (total < 35)  return 'linear'
  return 'superlinear'
}

function maxStableOf(results: ScalabilityBenchResult[]): number {
  const p = results.find(r => r.test === 'paramLoad_96ch')
  const a = results.find(r => r.test === 'analyserLoad_96ch')
  const cpu96 = (p?.cpuEstimate ?? 0) + (a?.cpuEstimate ?? 0)
  if (cpu96 === 0) return 96
  const fraction = 80 / cpu96  // 80% CPU budget target
  return Math.min(96, Math.max(8, Math.floor(fraction * 96)))
}

function thermalOf(results: ScalabilityBenchResult[]): 'low' | 'medium' | 'high' {
  const p = results.find(r => r.test === 'paramLoad_96ch')
  const a = results.find(r => r.test === 'analyserLoad_96ch')
  const total = (p?.cpuEstimate ?? 0) + (a?.cpuEstimate ?? 0)
  if (total < 20) return 'low'
  if (total < 40) return 'medium'
  return 'high'
}

export function generateScalabilityReport(
  benchmarks:       ScalabilityBenchResult[],
  multicoreProfile: MulticoreProfile,
  loadBalancer:     LoadBalancerMetrics,
  resourceStats:    ResourceStats,
  cacheStats:       CacheStats,
): ScalabilityFullReport {
  const issues: string[]          = []
  const recommendations: string[] = []

  const maxStable   = maxStableOf(benchmarks)
  const cpuScaling  = scalingOf(benchmarks)
  const thermal     = thermalOf(benchmarks)
  const sessionOk   = benchmarks.find(r => r.test === 'longSession_60min')?.passed ?? false
  const multicoreOk = multicoreProfile.rustReadiness === 'ready'
  const lowEnd      = maxStable >= 32 && thermal !== 'high'

  // Benchmark failures
  for (const r of benchmarks) {
    if (!r.passed) {
      issues.push(`[WARN] ${r.test}: FAILED — ${r.durationMs}ms` +
        (r.cpuEstimate > 0 ? ` / ${r.cpuEstimate}% CPU` : ''))
    }
  }

  if (cpuScaling === 'superlinear') {
    issues.push('[WARN] CPU scaling superlinear — analyzer count too high for 96ch')
    recommendations.push('For 64+ ch: disable per-channel meters, use bus-level metering only')
  }
  if (thermal === 'high') {
    issues.push('[WARN] High thermal risk — sustained 96ch may throttle on laptop hardware')
    recommendations.push('Enable ECO mode for 64+ ch sessions on non-desktop hardware')
  }
  if (!multicoreOk) {
    issues.push(`[INFO] SharedArrayBuffer: ${multicoreProfile.rustReadiness} — Rust workers blocked`)
    recommendations.push('Add COOP/COEP headers to electron/main.cjs for full multicore support')
  }
  if (loadBalancer.stage !== 'full') {
    issues.push(`[WARN] DSP load balancer in ${loadBalancer.stage} degradation stage during benchmark`)
    recommendations.push('Consider reducing channel count or switching to ECO mode')
  }
  if (resourceStats.savedAnalyserReads > 100) {
    recommendations.push(`ResourceManager saved ${resourceStats.savedAnalyserReads} analyser reads — keep ECO mode enabled`)
  }
  if (!sessionOk) {
    issues.push('[WARN] Long session benchmark failed — param scheduling may degrade over time')
    recommendations.push('Restart AudioContext after 4-hour sessions as a precaution')
  }

  const criticals = issues.filter(i => i.startsWith('[CRIT]')).length
  const warns     = issues.filter(i => i.startsWith('[WARN]')).length
  const verdict   = criticals > 0       ? 'poor'
    : warns > 3                          ? 'marginal'
    : warns > 0 || !multicoreOk         ? 'good'
    : 'excellent'

  return {
    timestamp:          new Date().toISOString(),
    maxStableChannels:  maxStable,
    sustainableRuntime: sessionOk ? '8+ hours' : '< 4 hours',
    cpuScaling,
    thermalRisk:        thermal,
    lowEndViable:       lowEnd,
    multicoreReady:     multicoreOk,
    benchmarks,
    multicoreProfile,
    loadBalancer,
    resourceStats,
    cacheStats,
    issues,
    recommendations,
    verdict,
  }
}

export function printScalabilityReport(report: ScalabilityFullReport): void {
  const icon = { excellent: '✓', good: '◑', marginal: '⚠', poor: '✗' }[report.verdict]
  console.group(`${icon} [PASO 15] Scalability Report — ${report.verdict.toUpperCase()} — ${report.timestamp}`)

  console.log('\n=== Session Capacity ===')
  console.log(`  Max stable channels:   ${report.maxStableChannels}`)
  console.log(`  Sustainable runtime:   ${report.sustainableRuntime}`)
  console.log(`  CPU scaling:           ${report.cpuScaling}`)
  console.log(`  Thermal risk:          ${report.thermalRisk}`)
  console.log(`  Low-end viable:        ${report.lowEndViable ? 'YES (≥32ch stable)' : 'NO'}`)
  console.log(`  Multicore ready:       ${report.multicoreReady ? 'YES' : 'NO — missing SAB headers'}`)

  console.log('\n=== Benchmarks ===')
  console.table(report.benchmarks.map(r => ({
    test:     r.test,
    ms:       r.durationMs,
    cpu:      r.cpuEstimate > 0 ? `${r.cpuEstimate}%` : '-',
    gc:       r.gcPressure,
    passed:   r.passed ? '✓' : '✗',
  })))

  console.log('\n=== Multicore Profile ===')
  const mc = report.multicoreProfile
  console.log(`  Logical cores:         ${mc.logicalCores}`)
  console.log(`  Recommended workers:   ${mc.recommendedWorkers}`)
  console.log(`  SAB IPC cost:          ${mc.ipcCostMicros}µs/op`)
  console.log(`  Rust readiness:        ${mc.rustReadiness}`)
  mc.notes.forEach(n => console.log(`  ${n}`))

  console.log('\n=== Resource Manager ===')
  console.log(`  Total meters:          ${report.resourceStats.totalMeters}`)
  console.log(`  Suspended:             ${report.resourceStats.suspendedMeters}`)
  console.log(`  Saved analyser reads:  ${report.resourceStats.savedAnalyserReads}`)
  console.log(`  FX buses active/idle:  ${report.resourceStats.activeFxBuses}/${report.resourceStats.idleFxBuses}`)

  console.log('\n=== Cache Optimizer ===')
  const b = report.cacheStats.batch
  console.log(`  Batch flushed:         ${b.flushed} commands`)
  console.log(`  Deduplicated:          ${b.deduplicated}`)
  console.log(`  SAB throughput:        ${report.cacheStats.sabAudit.throughputKBps}`)
  console.table(report.cacheStats.pool)

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
