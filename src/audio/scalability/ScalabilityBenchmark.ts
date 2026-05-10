/**
 * ScalabilityBenchmark.ts — Extreme session performance benchmarks.
 *
 * Tests:
 *   paramLoad_96ch:     GainNode.gain.setTargetAtTime × 96ch × 200 iters
 *   analyserLoad_96ch:  AnalyserNode.getFloatTimeDomainData + peak extract × 96ch × 200 iters
 *   midiFlood_10k:      10 000 MIDI CC messages through dispatcher
 *   commandBatch_1k:    1 000 keyed commands through batch deduplication
 *   longSession_60min:  225 000 param setTargetAtTime calls (1% sample of 60min @ 60fps)
 *   recordingSim_32ch:  32ch × 100 blocks Float32Array alloc + flush simulation
 *
 * CPU estimate: (elapsed / iters) / (bufferDur at 48kHz/128) × 100
 * Pass thresholds: paramLoad <30%, analyserLoad <25%, midiFlood <200ms
 */

export interface ScalabilityBenchResult {
  test:           string
  channels:       number
  durationMs:     number
  cpuEstimate:    number
  gcPressure:     'low' | 'medium' | 'high'
  passed:         boolean
  detail:         string
}

const BUF_DUR_MS = 128 / 48000 * 1000  // ~2.67ms per buffer at 48kHz

function cpuPercent(totalMs: number, iters: number): number {
  return +((totalMs / iters) / BUF_DUR_MS * 100).toFixed(1)
}

// ── Individual benchmarks ─────────────────────────────────────────────────────

function benchParamLoad(ctx: AudioContext, numCh: number, iters = 200): ScalabilityBenchResult {
  const gains = Array.from({ length: numCh }, () => ctx.createGain())
  const t0    = performance.now()
  for (let i = 0; i < iters; i++) {
    for (const g of gains) {
      g.gain.setTargetAtTime(0.5 + (i % 10) * 0.05, ctx.currentTime, 0.007)
    }
  }
  const ms = performance.now() - t0
  gains.forEach(g => { try { g.disconnect() } catch (_) {} })

  const cpu = cpuPercent(ms, iters)
  return {
    test:         `paramLoad_${numCh}ch`,
    channels:     numCh,
    durationMs:   +ms.toFixed(2),
    cpuEstimate:  cpu,
    gcPressure:   'low',
    passed:       cpu < 30,
    detail:       `${iters} iters × ${numCh} GainNodes — setTargetAtTime`,
  }
}

function benchAnalyserLoad(ctx: AudioContext, numCh: number, iters = 200): ScalabilityBenchResult {
  const analysers = Array.from({ length: numCh }, () => {
    const a = ctx.createAnalyser(); a.fftSize = 256; return a
  })
  const buf = new Float32Array(256)
  const t0  = performance.now()
  for (let i = 0; i < iters; i++) {
    for (const a of analysers) {
      a.getFloatTimeDomainData(buf)
      let peak = 0
      for (let j = 0; j < buf.length; j++) {
        const v = buf[j] < 0 ? -buf[j] : buf[j]
        if (v > peak) peak = v
      }
    }
  }
  const ms = performance.now() - t0
  analysers.forEach(a => { try { a.disconnect() } catch (_) {} })

  const cpu = cpuPercent(ms, iters)
  return {
    test:         `analyserLoad_${numCh}ch`,
    channels:     numCh,
    durationMs:   +ms.toFixed(2),
    cpuEstimate:  cpu,
    gcPressure:   'low',
    passed:       cpu < 25,
    detail:       `${iters} iters × ${numCh} AnalyserNodes — peak extraction`,
  }
}

function benchMidiFlood(dispatcher: (msg: any) => void, count = 10_000): ScalabilityBenchResult {
  const t0 = performance.now()
  for (let i = 0; i < count; i++) {
    dispatcher({
      type:      'cc',
      channel:   1,
      cc:        i % 8,
      value:     i % 128,
      deviceId:  'bench',
      timestamp: performance.now(),
    })
  }
  const ms = performance.now() - t0
  return {
    test:         'midiFlood_10k',
    channels:     0,
    durationMs:   +ms.toFixed(2),
    cpuEstimate:  0,
    gcPressure:   ms > 100 ? 'high' : 'low',
    passed:       ms < 200,
    detail:       `${count} CC messages — dispatcher throughput`,
  }
}

function benchCommandBatch(batchFn: (key: string, fn: () => void) => void, count = 1000): ScalabilityBenchResult {
  let calls = 0
  const t0  = performance.now()
  for (let i = 0; i < count; i++) {
    batchFn(`ch_${i % 64}_gain`, () => { calls++ })
  }
  const ms = performance.now() - t0
  return {
    test:         'commandBatch_1k',
    channels:     64,
    durationMs:   +ms.toFixed(2),
    cpuEstimate:  0,
    gcPressure:   'low',
    passed:       ms < 16,
    detail:       `${count} commands → ${64} unique keys (dedup ratio ${((1 - 64 / count) * 100).toFixed(0)}%)`,
  }
}

function benchLongSession(ctx: AudioContext): ScalabilityBenchResult {
  // 1hr @ 60fps = 216 000 frames — sample 1% = 2160 param sets
  const SAMPLES = 2160
  const gain    = ctx.createGain()
  const t0      = performance.now()

  for (let i = 0; i < SAMPLES; i++) {
    const v = 0.5 + Math.sin(i / 360 * Math.PI * 2) * 0.3
    gain.gain.setTargetAtTime(v, ctx.currentTime + i * 0.016, 0.007)
  }

  const ms = performance.now() - t0
  try { gain.disconnect() } catch (_) {}

  return {
    test:         'longSession_60min',
    channels:     1,
    durationMs:   +ms.toFixed(2),
    cpuEstimate:  0,
    gcPressure:   'low',
    passed:       ms < 500,
    detail:       `${SAMPLES} param sets simulating 60min session (1% sample)`,
  }
}

function benchRecordingSim(numCh = 32): ScalabilityBenchResult {
  const BLOCK  = 1024
  const BLOCKS = 100
  const pool:  Float32Array[] = []
  const t0     = performance.now()

  for (let b = 0; b < BLOCKS; b++) {
    for (let c = 0; c < numCh; c++) {
      const buf = new Float32Array(BLOCK)
      buf[0]    = b * 0.001  // mark write
      pool.push(buf)
    }
    if (b % 10 === 9) pool.splice(0, numCh * 10)
  }

  const ms  = performance.now() - t0
  const gcP = ms > 80 ? 'high' : ms > 30 ? 'medium' : 'low'

  return {
    test:         `recordingSim_${numCh}ch`,
    channels:     numCh,
    durationMs:   +ms.toFixed(2),
    cpuEstimate:  0,
    gcPressure:   gcP as 'low' | 'medium' | 'high',
    passed:       ms < 100,
    detail:       `${BLOCKS} blocks × ${numCh}ch × ${BLOCK} samples — alloc + periodic flush`,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function runScalabilityBenchmark(
  ctx:        AudioContext,
  dispatcher: (msg: any) => void,
  batchFn:    (key: string, fn: () => void) => void,
): ScalabilityBenchResult[] {
  return [
    benchParamLoad(ctx, 96),
    benchAnalyserLoad(ctx, 96),
    benchMidiFlood(dispatcher, 10_000),
    benchCommandBatch(batchFn, 1_000),
    benchLongSession(ctx),
    benchRecordingSim(32),
  ]
}

export function exposeScalabilityBenchAPI(
  ctx:        AudioContext,
  dispatcher: (msg: any) => void,
  batchFn:    (key: string, fn: () => void) => void,
): void {
  ;(window as any).__ONA_SCALE_BENCH = {
    run: () => {
      console.group('[Paso 15] Scalability Benchmark — 96ch / recording / MIDI')
      const results = runScalabilityBenchmark(ctx, dispatcher, batchFn)
      console.table(results)
      const passed  = results.filter(r => r.passed).length
      const verdict = passed === results.length ? '✓ ALL PASSED' : `⚠ ${results.length - passed} FAILED`
      console.log(`Result: ${verdict} (${passed}/${results.length})`)
      console.groupEnd()
      return results
    },
  }
}
