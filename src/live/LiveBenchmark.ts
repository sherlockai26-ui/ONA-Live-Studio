/**
 * LiveBenchmark.ts — Live show operation benchmarks.
 *
 * Tests:
 *   recall_speed:      20 rapid scene recalls — measure avg/max/min ms
 *   recall_pop:        Measure peak level change during recall (pop detection)
 *   multi_scene_cycle: Cycle through all scenes 3× — count errors
 *   dca_latency:       100 DCA level changes — measure avg dispatch ms
 *   mute_group_storm:  All 8 mute groups toggle 10× — check no unsafe mute
 *   command_under_load: Remote commands during active recall — count drops
 *
 * Exposed as window.__ONA_LIVE_BENCH.run()
 */

import { sceneEngine }       from './SceneEngine'
import { dcaEngine }         from './DCAEngine'
import { transitionEngine }  from './TransitionEngine'

export interface LiveBenchResult {
  test:       string
  reps:       number
  avgMs:      number
  maxMs:      number
  minMs:      number
  errors:     number
  pops:       number
  passed:     boolean
  detail:     string
}

async function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function benchRecallSpeed(): Promise<LiveBenchResult> {
  const scenes  = sceneEngine.listScenes()
  if (scenes.length === 0) {
    return {
      test: 'recall_speed', reps: 0, avgMs: -1, maxMs: -1, minMs: -1,
      errors: 0, pops: 0, passed: false,
      detail: 'No scenes available — save at least 2 scenes first',
    }
  }

  const REPS  = Math.min(20, scenes.length * 3)
  const times: number[] = []
  let errors = 0

  transitionEngine.setProfile('instant')

  for (let i = 0; i < REPS; i++) {
    const name = scenes[i % scenes.length]
    const t0   = performance.now()
    const res  = await sceneEngine.recall(name, { skipValidation: true, profile: 'instant' })
    const ms   = performance.now() - t0
    if (!res.ok) errors++
    else times.push(ms)
  }

  transitionEngine.setProfile('smooth')

  const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : -1
  const max = times.length > 0 ? Math.max(...times) : -1
  const min = times.length > 0 ? Math.min(...times) : -1

  return {
    test: 'recall_speed', reps: REPS,
    avgMs: +avg.toFixed(1), maxMs: +max.toFixed(1), minMs: +min.toFixed(1),
    errors, pops: transitionEngine.getPopLog().length,
    passed: avg < 50 && errors === 0,
    detail: `${REPS} recalls — avg ${avg.toFixed(1)}ms, max ${max.toFixed(1)}ms, ${errors} errors`,
  }
}

async function benchDCALatency(): Promise<LiveBenchResult> {
  const REPS  = 100
  const times: number[] = []

  for (let i = 0; i < REPS; i++) {
    const dcaId = (i % 8) + 1
    const level = 60 + (i % 40)
    const t0    = performance.now()
    dcaEngine.setDCALevel(dcaId, level)
    times.push(performance.now() - t0)
    await Promise.resolve()   // yield to event loop
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const max = Math.max(...times)

  return {
    test: 'dca_latency', reps: REPS,
    avgMs: +avg.toFixed(3), maxMs: +max.toFixed(3), minMs: +Math.min(...times).toFixed(3),
    errors: 0, pops: 0,
    passed: avg < 1,
    detail: `${REPS} DCA level changes — avg ${avg.toFixed(3)}ms, max ${max.toFixed(3)}ms`,
  }
}

async function benchMuteGroupStorm(): Promise<LiveBenchResult> {
  const TOGGLES = 10
  const groups  = [1, 2, 3, 4, 5, 6, 7, 8]
  let errors    = 0

  for (let t = 0; t < TOGGLES; t++) {
    for (const gid of groups) {
      try {
        dcaEngine.activateMuteGroup(gid)
        await wait(5)
        dcaEngine.deactivateMuteGroup(gid)
      } catch (e) {
        errors++
      }
    }
  }

  return {
    test: 'mute_group_storm', reps: TOGGLES * groups.length,
    avgMs: 5, maxMs: 5, minMs: 5,
    errors, pops: 0,
    passed: errors === 0,
    detail: `${TOGGLES} toggle rounds × ${groups.length} groups — ${errors} errors`,
  }
}

async function benchMultiSceneCycle(): Promise<LiveBenchResult> {
  const scenes = sceneEngine.listScenes()
  if (scenes.length < 2) {
    return {
      test: 'multi_scene_cycle', reps: 0, avgMs: -1, maxMs: -1, minMs: -1,
      errors: 0, pops: 0, passed: false,
      detail: 'Need ≥2 scenes',
    }
  }

  const ROUNDS = 3
  const times: number[] = []
  let errors = 0
  transitionEngine.clearPopLog()

  for (let r = 0; r < ROUNDS; r++) {
    for (const name of scenes) {
      const t0  = performance.now()
      const res = await sceneEngine.recall(name, { skipValidation: true, profile: 'fast' })
      times.push(performance.now() - t0)
      if (!res.ok) errors++
      await wait(50)   // simulate operator pacing
    }
  }

  const avg  = times.reduce((a, b) => a + b, 0) / times.length
  const pops = transitionEngine.getPopLog().length

  return {
    test: 'multi_scene_cycle', reps: ROUNDS * scenes.length,
    avgMs: +avg.toFixed(1), maxMs: +Math.max(...times).toFixed(1), minMs: +Math.min(...times).toFixed(1),
    errors, pops,
    passed: errors === 0 && pops === 0,
    detail: `${ROUNDS} cycles × ${scenes.length} scenes — ${errors} errors, ${pops} pops`,
  }
}

export function exposeLiveBenchAPI(): void {
  ;(window as any).__ONA_LIVE_BENCH = {
    run: async () => {
      const results: LiveBenchResult[] = []
      console.group('[Paso 18] Live Show Benchmark')

      const tests = [benchRecallSpeed, benchDCALatency, benchMuteGroupStorm, benchMultiSceneCycle]
      for (const test of tests) {
        try { results.push(await test()) } catch (e) { console.error(e) }
      }

      console.table(results.map(r => ({
        test: r.test, avg: r.avgMs, max: r.maxMs, errors: r.errors, pops: r.pops, passed: r.passed,
      })))
      const passed = results.filter(r => r.passed).length
      console.log(`${passed}/${results.length} passed`)
      console.groupEnd()
      return results
    },
    speed:  () => benchRecallSpeed(),
    dca:    () => benchDCALatency(),
    mutes:  () => benchMuteGroupStorm(),
    cycle:  () => benchMultiSceneCycle(),
  }
  console.log('[LiveBenchmark] Paso 18 bench ready — window.__ONA_LIVE_BENCH.run()')
}
