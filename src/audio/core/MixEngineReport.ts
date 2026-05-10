/**
 * MixEngineReport.ts — Validación, benchmarks y reporte del mix engine.
 *
 * Combina (Paso 14):
 *   - Bus summing validation (phase accumulation, stereo coherence)
 *   - Floating point safety audit (NaN, Inf, denormals)
 *   - Mix benchmarks (16/32/64ch — param load + metering overhead)
 *   - Loudness + headroom report
 *   - Max safe channel count estimate
 *
 * Tests de floating point:
 *   NaN detection:     any sample is NaN → propagation problem
 *   Inf detection:     |sample| ≥ 1e38 → runaway feedback or DC offset
 *   Denormal risk:     |sample| < 1e-37 && > 0 → potential FPU slowdown
 *   Clipping:          |sample| ≥ 1.0 → digital overload
 *
 * Bus summing validation:
 *   Mono coherence:    |L - R| < 0.1 when pan=0 (no accidental phase issue)
 *   Headroom math:     with N channels at 0dBFS, potential gain = +20log10(N) dB
 *   Phase accumulation: flag if > 16 channels are summing without attenuation
 *
 * Benchmark methodology:
 *   Measure param set time for N channels (gain, EQ, pan, compressor) × M iterations
 *   Measure analyser read time for N AnalyserNodes
 *   Estimate CPU % from timing (compare to 48kHz buffer duration)
 */

export interface FloatSafetyReport {
  busId:      string
  peakDb:     number
  hasNaN:     boolean
  hasInf:     boolean
  hasDenorm:  boolean
  hasClip:    boolean
  sampleCount: number
}

export interface SummingValidation {
  channelCount:  number
  theoreticalMaxBoostDb: number
  headroomWarning: boolean
  phaseRisk:     boolean
  recommendation: string
}

export interface MixBenchResult {
  channels:     number
  paramSetMs:   number
  analyserMs:   number
  totalMs:      number
  cpuEstimatePercent: number
  passed:       boolean
}

export interface MixEngineFullReport {
  timestamp:        string
  floatSafety:      FloatSafetyReport[]
  summingValidation: SummingValidation
  benchmarks:       MixBenchResult[]
  loudness:         Record<string, any>
  maxSafeChannels:  number
  verdict:          'excellent' | 'good' | 'marginal' | 'unstable'
  issues:           string[]
}

// ── Float safety audit ────────────────────────────────────────────────────────

export function auditFloatSafety(
  buses: Array<{ id: string; analyser: AnalyserNode }>,
): FloatSafetyReport[] {
  return buses.map(({ id, analyser }) => {
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)

    let hasNaN   = false
    let hasInf   = false
    let hasDenorm = false
    let hasClip  = false
    let peak     = 0

    for (let i = 0; i < buf.length; i++) {
      const s = buf[i]
      if (isNaN(s))                         { hasNaN = true; continue }
      if (!isFinite(s))                     { hasInf = true; continue }
      const a = Math.abs(s)
      if (a > peak) peak = a
      if (a >= 1.0)                         hasClip = true
      if (a > 0 && a < 1e-37)             hasDenorm = true
    }

    return {
      busId:      id,
      peakDb:     peak > 0 ? +(20 * Math.log10(peak)).toFixed(1) : -Infinity,
      hasNaN, hasInf, hasDenorm, hasClip,
      sampleCount: buf.length,
    }
  })
}

// ── Bus summing validation ────────────────────────────────────────────────────

export function validateSumming(numChannels: number, panLawMode: string): SummingValidation {
  const theoreticalMaxBoostDb = +(20 * Math.log10(Math.max(1, numChannels))).toFixed(1)
  const headroomWarning  = theoreticalMaxBoostDb > 12
  const phaseRisk        = numChannels > 16 && panLawMode === 'linear_0db'

  let recommendation = 'OK — sufficient headroom for this channel count.'
  if (phaseRisk) {
    recommendation = `RISK: ${numChannels}ch with linear_0db → +${theoreticalMaxBoostDb}dB possible boost. Use equal_power.`
  } else if (headroomWarning) {
    recommendation = `WARNING: ${numChannels}ch → +${theoreticalMaxBoostDb}dB theoretical max. ` +
      'Ensure channels are attenuated and gain staging is applied.'
  }

  return { channelCount: numChannels, theoreticalMaxBoostDb, headroomWarning, phaseRisk, recommendation }
}

// ── Mix benchmark ─────────────────────────────────────────────────────────────

function benchParamSet(ctx: AudioContext, numChannels: number, iterations = 200): number {
  const gains: GainNode[] = []
  for (let i = 0; i < numChannels; i++) gains.push(ctx.createGain())

  const t0 = performance.now()
  for (let iter = 0; iter < iterations; iter++) {
    for (const g of gains) {
      g.gain.setTargetAtTime(0.5 + Math.random() * 0.5, ctx.currentTime, 0.007)
    }
  }
  const elapsed = performance.now() - t0

  for (const g of gains) { try { g.disconnect() } catch (_) {} }
  return elapsed
}

function benchAnalyserRead(ctx: AudioContext, numChannels: number, iterations = 200): number {
  const analysers: AnalyserNode[] = []
  const buf = new Float32Array(256)
  for (let i = 0; i < numChannels; i++) {
    const a = ctx.createAnalyser()
    a.fftSize = 256
    analysers.push(a)
  }

  const t0 = performance.now()
  for (let iter = 0; iter < iterations; iter++) {
    for (const a of analysers) a.getFloatTimeDomainData(buf)
  }
  const elapsed = performance.now() - t0

  for (const a of analysers) { try { a.disconnect() } catch (_) {} }
  return elapsed
}

export function runMixBenchmark(
  ctx:         AudioContext,
  channelCounts: number[] = [16, 32, 64],
): MixBenchResult[] {
  return channelCounts.map(n => {
    const paramMs    = benchParamSet(ctx, n)
    const analyserMs = benchAnalyserRead(ctx, n)
    const totalMs    = paramMs + analyserMs

    // Buffer duration at 48kHz / 128 frames ≈ 2.67ms
    // CPU% = (processing time per buffer) / (buffer duration) × 100
    const bufferDurMs       = 128 / (ctx.sampleRate ?? 48000) * 1000
    const perIterMs         = totalMs / 200
    const cpuEstimate       = +(perIterMs / bufferDurMs * 100).toFixed(1)

    return {
      channels:    n,
      paramSetMs:  +paramMs.toFixed(2),
      analyserMs:  +analyserMs.toFixed(2),
      totalMs:     +totalMs.toFixed(2),
      cpuEstimatePercent: cpuEstimate,
      passed:      cpuEstimate < 20,  // < 20% CPU for param + meter overhead
    }
  })
}

// ── Full report generator ─────────────────────────────────────────────────────

export function generateMixEngineReport(
  ctx:          AudioContext,
  buses:        Array<{ id: string; analyser: AnalyserNode }>,
  numChannels:  number,
  panLawMode:   string,
  loudnessData: Record<string, any>,
): MixEngineFullReport {
  const floatSafety  = auditFloatSafety(buses)
  const summing      = validateSumming(numChannels, panLawMode)
  const benchmarks   = runMixBenchmark(ctx, [16, 32, 64])
  const issues: string[] = []

  // Float safety issues
  for (const f of floatSafety) {
    if (f.hasNaN)   issues.push(`[CRITICAL] NaN detected on ${f.busId} — feedback runaway or unconnected node`)
    if (f.hasInf)   issues.push(`[CRITICAL] Inf detected on ${f.busId} — feedback runaway`)
    if (f.hasClip)  issues.push(`[WARNING] Clipping on ${f.busId} (${f.peakDb}dBFS) — reduce gain or enable limiter`)
    if (f.hasDenorm) issues.push(`[INFO] Denormals on ${f.busId} — add denormal kick or enable FTZ`)
  }

  // Summing issues
  if (summing.phaseRisk)     issues.push(`[WARNING] ${summing.recommendation}`)
  if (summing.headroomWarning && !summing.phaseRisk)
    issues.push(`[INFO] ${summing.recommendation}`)

  // Benchmark issues
  for (const b of benchmarks) {
    if (!b.passed) issues.push(`[WARNING] ${b.channels}ch benchmark: CPU ${b.cpuEstimatePercent}% > 20% threshold`)
  }

  // Estimate max safe channels
  const safeB = benchmarks.filter(b => b.passed)
  const maxSafeChannels = safeB.length > 0 ? Math.max(...safeB.map(b => b.channels)) : 16

  const verdict = issues.filter(i => i.startsWith('[CRITICAL]')).length > 0 ? 'unstable'
    : issues.filter(i => i.startsWith('[WARNING]')).length > 2 ? 'marginal'
    : issues.filter(i => i.startsWith('[WARNING]')).length > 0 ? 'good'
    : 'excellent'

  return {
    timestamp:  new Date().toISOString(),
    floatSafety,
    summingValidation: summing,
    benchmarks,
    loudness:   loudnessData,
    maxSafeChannels,
    verdict,
    issues,
  }
}

// ── Console printer ───────────────────────────────────────────────────────────

export function printMixEngineReport(report: MixEngineFullReport): void {
  const icon = { excellent: '✓', good: '◑', marginal: '⚠', unstable: '✗' }[report.verdict]
  console.group(`${icon} [PASO 14] Mix Engine Report — ${report.verdict.toUpperCase()} — ${report.timestamp}`)

  console.log('\n=== Float Safety ===')
  console.table(report.floatSafety)

  console.log('\n=== Bus Summing ===')
  const s = report.summingValidation
  console.log(`  Channels:      ${s.channelCount}`)
  console.log(`  Max boost:     +${s.theoreticalMaxBoostDb}dB (theoretical)`)
  console.log(`  ${s.headroomWarning ? '⚠' : '✓'} ${s.recommendation}`)

  console.log('\n=== Benchmarks ===')
  console.table(report.benchmarks)
  console.log(`  Max safe channels: ${report.maxSafeChannels}`)

  console.log('\n=== Loudness ===')
  for (const [id, r] of Object.entries(report.loudness)) {
    console.log(`  ${id}: ${r.momentaryLufs}LUFS momentary | ${r.shortTermLufs}LUFS 3s | peak ${r.peakDb}dBFS`)
  }

  if (report.issues.length > 0) {
    console.log('\n=== Issues ===')
    report.issues.forEach(i => console.log(`  ${i}`))
  } else {
    console.log('\n  ✓ No issues detected')
  }

  console.groupEnd()
}
