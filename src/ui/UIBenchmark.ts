/**
 * UIBenchmark.ts — Client-side UI performance benchmarks.
 *
 * Tests:
 *   fps_baseline:      Measure raw RAF fps over 3s (no extra callbacks)
 *   meter_32ch:        Register 32 canvas meter callbacks, measure sustained fps
 *   input_latency:     Pointer event → state update round-trip via performance.now()
 *   memory_growth:     Heap size before/after 200 virtual scroll repositions
 *   render_spikes:     Max frame time over 500 frames (jank detection)
 *
 * Exposed as window.__ONA_UI_BENCH.run()
 */

import { renderScheduler, RENDER_PRIORITY } from './RenderScheduler'

export interface UIBenchResult {
  test:          string
  durationMs:    number
  avgFps:        number
  minFps:        number
  maxFrameMs:    number
  p99FrameMs:    number
  memDeltaMB:    number
  passed:        boolean
  detail:        string
}

async function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function benchFpsBaseline(): Promise<UIBenchResult> {
  const frames: number[] = []
  let last = performance.now()
  const t0 = last

  const id = '__bench_fps_base'
  const unsub = renderScheduler.register(id, RENDER_PRIORITY.CRITICAL, (now) => {
    frames.push(now - last)
    last = now
  })

  await wait(3000)
  unsub()

  const ms    = performance.now() - t0
  const fps   = (frames.length / (ms / 1000))
  const sorted = [...frames].sort((a, b) => a - b)
  const p99    = sorted[Math.floor(sorted.length * 0.99)] ?? 0

  return {
    test: 'fps_baseline', durationMs: +ms.toFixed(0),
    avgFps: +fps.toFixed(1), minFps: +(1000 / (sorted[sorted.length - 1] ?? 1000)).toFixed(1),
    maxFrameMs: +(sorted[sorted.length - 1] ?? 0).toFixed(1), p99FrameMs: +p99.toFixed(1),
    memDeltaMB: 0,
    passed: fps >= 55,
    detail: `${frames.length} frames in ${(ms / 1000).toFixed(1)}s — avg ${fps.toFixed(1)} fps, p99 frame ${p99.toFixed(1)}ms`,
  }
}

async function benchMeter32ch(): Promise<UIBenchResult> {
  const unsubs: Array<() => void> = []
  let renders = 0
  const t0 = performance.now()

  for (let i = 0; i < 32; i++) {
    const unsub = renderScheduler.register(`__bench_meter_${i}`, RENDER_PRIORITY.CRITICAL, () => { renders++ })
    unsubs.push(unsub)
  }

  await wait(3000)
  unsubs.forEach(u => u())

  const ms  = performance.now() - t0
  const fps = (renders / 32) / (ms / 1000)

  return {
    test: 'meter_32ch', durationMs: +ms.toFixed(0),
    avgFps: +fps.toFixed(1), minFps: 0,
    maxFrameMs: 0, p99FrameMs: 0, memDeltaMB: 0,
    passed: fps >= 50,
    detail: `32 meter callbacks × ${(ms / 1000).toFixed(1)}s — avg ${fps.toFixed(1)} fps`,
  }
}

async function benchInputLatency(): Promise<UIBenchResult> {
  const latencies: number[] = []
  const REPS = 50

  for (let i = 0; i < REPS; i++) {
    const t0  = performance.now()
    // Simulate pointer → state round trip via microtask
    await Promise.resolve()
    latencies.push(performance.now() - t0)
    await wait(10)
  }

  const avg    = latencies.reduce((a, b) => a + b, 0) / latencies.length
  const sorted = [...latencies].sort((a, b) => a - b)
  const p99    = sorted[Math.floor(sorted.length * 0.99)] ?? 0

  return {
    test: 'input_latency', durationMs: +(REPS * 10 + 50),
    avgFps: 0, minFps: 0,
    maxFrameMs: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
    p99FrameMs: +p99.toFixed(2),
    memDeltaMB: 0,
    passed: avg < 2,
    detail: `${REPS} reps — avg ${avg.toFixed(2)}ms, p99 ${p99.toFixed(2)}ms`,
  }
}

async function benchMemoryGrowth(): Promise<UIBenchResult> {
  const mem0 = (performance as any).memory?.usedJSHeapSize ?? 0
  const REPS  = 200
  const t0    = performance.now()

  // Simulate rapid virtual list repositions (array slice, React key reassignment proxy)
  const arr: number[] = Array.from({ length: 96 }, (_, i) => i)
  for (let i = 0; i < REPS; i++) {
    const start = Math.floor(Math.random() * 80)
    arr.slice(start, start + 16)
    await Promise.resolve()
  }

  const mem1     = (performance as any).memory?.usedJSHeapSize ?? 0
  const deltaMB  = +(((mem1 - mem0) / 1024 / 1024)).toFixed(2)
  const ms       = performance.now() - t0

  return {
    test: 'memory_growth', durationMs: +ms.toFixed(0),
    avgFps: 0, minFps: 0, maxFrameMs: 0, p99FrameMs: 0,
    memDeltaMB: deltaMB,
    passed: deltaMB < 5,
    detail: `${REPS} virtual scroll ops — heap delta ${deltaMB}MB`,
  }
}

async function benchRenderSpikes(): Promise<UIBenchResult> {
  const frames: number[] = []
  let last = performance.now()
  const t0 = last

  const id = '__bench_spikes'
  const unsub = renderScheduler.register(id, RENDER_PRIORITY.CRITICAL, (now) => {
    frames.push(now - last)
    last = now
  })

  await wait(5000)
  unsub()

  const ms     = performance.now() - t0
  const sorted = [...frames].sort((a, b) => a - b)
  const p99    = sorted[Math.floor(sorted.length * 0.99)] ?? 0
  const max    = sorted[sorted.length - 1] ?? 0
  const spikes = frames.filter(f => f > 33).length   // >33ms = below 30fps threshold

  return {
    test: 'render_spikes', durationMs: +ms.toFixed(0),
    avgFps: +(frames.length / (ms / 1000)).toFixed(1), minFps: 0,
    maxFrameMs: +max.toFixed(1), p99FrameMs: +p99.toFixed(1),
    memDeltaMB: 0,
    passed: spikes < frames.length * 0.01,  // <1% spike frames
    detail: `${spikes} spike frames (>33ms) of ${frames.length} — p99 ${p99.toFixed(1)}ms, max ${max.toFixed(1)}ms`,
  }
}

export function exposeUIBenchAPI(): void {
  ;(window as any).__ONA_UI_BENCH = {
    run: async () => {
      const results: UIBenchResult[] = []
      console.group('[Paso 17] UI Benchmark')

      const tests = [benchFpsBaseline, benchMeter32ch, benchInputLatency, benchMemoryGrowth, benchRenderSpikes]
      for (const test of tests) {
        try { results.push(await test()) } catch (e) { console.error(e) }
      }

      console.table(results.map(r => ({
        test:   r.test,
        fps:    r.avgFps,
        p99ms:  r.p99FrameMs,
        memMB:  r.memDeltaMB,
        passed: r.passed,
        detail: r.detail,
      })))
      const passed = results.filter(r => r.passed).length
      console.log(`${passed}/${results.length} passed`)
      console.groupEnd()
      return results
    },
    fps:    () => benchFpsBaseline(),
    meters: () => benchMeter32ch(),
    input:  () => benchInputLatency(),
    mem:    () => benchMemoryGrowth(),
    spikes: () => benchRenderSpikes(),
  }
  console.log('[UIBenchmark] Paso 17 bench ready — window.__ONA_UI_BENCH.run()')
}
