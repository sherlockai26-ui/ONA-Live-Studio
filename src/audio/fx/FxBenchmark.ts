/**
 * FxBenchmark.ts — CPU y estabilidad benchmark para el sistema de FX buses.
 *
 * Tests (Paso 12):
 *   1. sendThroughput  — tiempo de crear/actualizar N sends a 4 buses (puro param set)
 *   2. feedbackStress  — 1000 llamadas rápidas a clampFeedback — verifica ≤ MAX_FEEDBACK
 *   3. processorSwap   — tiempo de attachProcessor/detachProcessor (hot swap en vivo)
 *   4. meterRead       — overhead de leer 4 AnalyserNodes simultáneos
 *
 * Exposición:
 *   window.__ONA_FX_BENCH.run()      — suite completa
 *   window.__ONA_FX_BENCH.sends(n)   — solo sendThroughput con n canales
 *   window.__ONA_FX_BENCH.feedback() — solo feedbackStress
 *   window.__ONA_FX_BENCH.help()
 */

import { clampFeedback, MAX_FEEDBACK } from './FxCpuProtection'
import type { FxBusEngineImpl }        from './FxBusEngine'
import type { DelayEngine }            from './DelayEngine'
import type { ReverbEngine }           from './ReverbEngine'

export interface FxBenchResult {
  test:    string
  passed:  boolean
  durationMs: number
  details: Record<string, number | string>
}

function now(): number { return performance.now() }

// ── Test 1: send throughput ───────────────────────────────────────────────────

function benchSendThroughput(ctx: AudioContext, numChannels: number): FxBenchResult {
  const NUM_BUSES = 4
  const gains: GainNode[] = []
  const busInputs: GainNode[] = []

  // Create dummy bus inputs
  for (let b = 0; b < NUM_BUSES; b++) {
    busInputs.push(ctx.createGain())
  }

  const t0 = now()

  // Create and connect channel sends (same pattern as ChannelStrip.setFxBusSend)
  for (let ch = 0; ch < numChannels; ch++) {
    const tap = ctx.createGain()  // simulate preFaderTap
    for (let b = 0; b < NUM_BUSES; b++) {
      const send = ctx.createGain()
      send.gain.value = 0.5
      tap.connect(send)
      send.connect(busInputs[b])
      gains.push(send)
    }
    gains.push(tap)
  }

  const createMs = now() - t0

  // Update all send levels
  const t1 = now()
  for (const g of gains) {
    g.gain.setTargetAtTime(0.3, ctx.currentTime, 0.007)
  }
  const updateMs = now() - t1

  // Cleanup
  for (const g of [...gains, ...busInputs]) { try { g.disconnect() } catch (_) {} }

  const total = createMs + updateMs
  return {
    test: `sendThroughput_${numChannels}ch`,
    passed:  total < 100,
    durationMs: total,
    details: {
      channels:    numChannels,
      buses:       NUM_BUSES,
      totalNodes:  numChannels * (NUM_BUSES + 1),
      createMs:    +createMs.toFixed(2),
      updateMs:    +updateMs.toFixed(2),
      nodesPerMs:  +(numChannels * NUM_BUSES / createMs).toFixed(1),
    },
  }
}

// ── Test 2: feedback stress ───────────────────────────────────────────────────

function benchFeedbackStress(): FxBenchResult {
  const ITERATIONS  = 1_000
  let   maxObserved = 0
  let   violated    = 0

  const t0 = now()

  for (let i = 0; i < ITERATIONS; i++) {
    // Test full range including >1.0 (should be clamped)
    const raw    = Math.random() * 1.5
    const clamped = clampFeedback(raw)
    if (clamped > maxObserved) maxObserved = clamped
    if (clamped > MAX_FEEDBACK + 1e-9) violated++
  }

  const durationMs = now() - t0
  const passed = violated === 0 && maxObserved <= MAX_FEEDBACK

  return {
    test:    'feedbackStress',
    passed,
    durationMs,
    details: {
      iterations:    ITERATIONS,
      violations:    violated,
      maxObserved:   +maxObserved.toFixed(6),
      maxAllowed:    MAX_FEEDBACK,
      iterPerMs:     +(ITERATIONS / durationMs).toFixed(0),
    },
  }
}

// ── Test 3: processor swap ────────────────────────────────────────────────────

async function benchProcessorSwap(
  engine: any,   // FxBusEngineImpl — any to avoid circular at bench level
  busId: number,
  delay: DelayEngine,
  reverb: ReverbEngine,
): Promise<FxBenchResult> {
  const SWAPS = 10
  const times: number[] = []

  for (let i = 0; i < SWAPS; i++) {
    const proc = i % 2 === 0 ? delay : reverb
    const type = i % 2 === 0 ? 'delay' : 'reverb'
    const t0 = now()
    engine.attachProcessor(busId, proc, type)
    times.push(now() - t0)
  }

  // Cleanup: detach
  engine.detachProcessor(busId)

  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const max = Math.max(...times)

  return {
    test:    'processorSwap',
    passed:  avg < 5,   // hot swap should be < 5ms average
    durationMs: avg * SWAPS,
    details: { swaps: SWAPS, avgMs: +avg.toFixed(3), maxMs: +max.toFixed(3) },
  }
}

// ── Test 4: meter read ────────────────────────────────────────────────────────

function benchMeterRead(engine: any): FxBenchResult {
  const READS    = 1_000
  const NUM_BUSES = 4
  const t0 = now()

  for (let i = 0; i < READS; i++) {
    for (let b = 1; b <= NUM_BUSES; b++) {
      engine.getMeterValue(b)
    }
  }

  const durationMs = now() - t0
  const readsPerMs = (READS * NUM_BUSES) / durationMs

  return {
    test:      'meterRead',
    passed:    readsPerMs > 10,  // should be >10 reads/ms easily
    durationMs,
    details: {
      totalReads: READS * NUM_BUSES,
      readsPerMs: +readsPerMs.toFixed(1),
    },
  }
}

// ── Suite runner ──────────────────────────────────────────────────────────────

export async function runFxBenchmark(
  ctx:    AudioContext,
  engine: any,
  delay:  DelayEngine,
  reverb: ReverbEngine,
): Promise<FxBenchResult[]> {
  console.group('[FxBenchmark] Running Paso 12 FX benchmark suite…')
  const results: FxBenchResult[] = []

  // 1. Send throughput — 16ch
  const r16 = benchSendThroughput(ctx, 16)
  results.push(r16)
  console.log(`${r16.passed ? '✓' : '✗'} ${r16.test}: ${r16.durationMs.toFixed(2)}ms`, r16.details)

  // 2. Send throughput — 32ch
  const r32 = benchSendThroughput(ctx, 32)
  results.push(r32)
  console.log(`${r32.passed ? '✓' : '✗'} ${r32.test}: ${r32.durationMs.toFixed(2)}ms`, r32.details)

  // 3. Feedback stress
  const rfb = benchFeedbackStress()
  results.push(rfb)
  console.log(`${rfb.passed ? '✓' : '✗'} ${rfb.test}: ${rfb.durationMs.toFixed(2)}ms`, rfb.details)

  // 4. Processor swap
  const rswap = await benchProcessorSwap(engine, 1, delay, reverb)
  results.push(rswap)
  console.log(`${rswap.passed ? '✓' : '✗'} ${rswap.test}: avg=${rswap.details.avgMs}ms`, rswap.details)

  // 5. Meter read
  const rmeter = benchMeterRead(engine)
  results.push(rmeter)
  console.log(`${rmeter.passed ? '✓' : '✗'} ${rmeter.test}: ${rmeter.durationMs.toFixed(2)}ms`, rmeter.details)

  const allPassed = results.every(r => r.passed)
  console.log(`\n${allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'} — ${results.filter(r => r.passed).length}/${results.length}`)
  console.groupEnd()

  return results
}

// ── Console API exposure ──────────────────────────────────────────────────────

export function exposeFxBenchAPI(
  ctx:    AudioContext,
  engine: any,
  delay:  DelayEngine,
  reverb: ReverbEngine,
): void {
  ;(window as any).__ONA_FX_BENCH = {
    run:    () => runFxBenchmark(ctx, engine, delay, reverb),
    sends:  (n = 16) => { const r = benchSendThroughput(ctx, n); console.table(r.details); return r },
    feedback: () => { const r = benchFeedbackStress(); console.table(r.details); return r },
    meter:  () => { const r = benchMeterRead(engine); console.table(r.details); return r },
    help: () => {
      console.group('[FxBenchmark] Console API')
      console.log('__ONA_FX_BENCH.run()        — suite completa (16ch, 32ch, feedback, swap, meter)')
      console.log('__ONA_FX_BENCH.sends(n)     — throughput test con n canales (default 16)')
      console.log('__ONA_FX_BENCH.feedback()   — stress test de clampFeedback (1000 iter)')
      console.log('__ONA_FX_BENCH.meter()      — overhead de lectura de 4 AnalyserNodes')
      console.groupEnd()
    },
  }
}
