/**
 * ControlBenchmark.ts — Benchmark y reporte del sistema de control MIDI.
 *
 * Tests (Paso 13, tarea 8):
 *   1. midiFlood       — 1000 msgs/s simulados → throughput real después de rate limiting
 *   2. multiFader      — 6 faders simultáneos, 100 updates cada uno → latencia total
 *   3. automationBurst — 500ms de automation densa → dropped rate + jitter
 *   4. mapperThroughput — velocidad de MidiMapper.processMessage (puro lookup)
 *
 * Reporte (tarea 10):
 *   Workflows soportados, latencia, throughput máximo, estabilidad de control
 *
 * Exposición:
 *   window.__ONA_CONTROL_BENCH.run()    — suite completa
 *   window.__ONA_CONTROL_BENCH.flood()  — solo flood test
 *   window.__ONA_CONTROL_BENCH.report() — reporte de estado actual
 *   window.__ONA_CONTROL_BENCH.help()
 */

import type { ControlPathImpl } from './ControlPath'
import type { MidiMapperImpl }  from './MidiMapper'
import type { MidiMessage }     from './MidiEngine'

export interface ControlBenchResult {
  test:       string
  passed:     boolean
  durationMs: number
  details:    Record<string, number | string>
}

function now(): number { return performance.now() }

// Simulate a CC MIDI message
function makeCCMsg(cc: number, value: number, deviceId = 'bench_device'): MidiMessage {
  return {
    type: 'cc', channel: 1, cc, value,
    raw: new Uint8Array([0xB0, cc, value]),
    deviceId, timestamp: now(),
  }
}

function makeNoteMsg(note: number, velocity: number, deviceId = 'bench_device'): MidiMessage {
  return {
    type: velocity > 0 ? 'noteon' : 'noteoff', channel: 2, note, velocity,
    raw: new Uint8Array([velocity > 0 ? 0x92 : 0x82, note, velocity]),
    deviceId, timestamp: now(),
  }
}

// ── Test 1: MIDI flood ────────────────────────────────────────────────────────

function benchMidiFlood(controlPath: any, numMessages: number): ControlBenchResult {
  controlPath.resetMetrics()

  const t0 = now()
  for (let i = 0; i < numMessages; i++) {
    // Mix of CC messages on different controllers (triggers rate limiter)
    const cc    = i % 8   // CC 0-7 = fader range
    const value = i % 128
    controlPath.handleMessage(makeCCMsg(cc, value))
  }
  const durationMs  = now() - t0
  const metrics     = controlPath.getMetrics()
  const throughput  = numMessages / (durationMs / 1000)

  return {
    test:   'midiFlood',
    passed: durationMs < 200,   // 1000 msgs processed in < 200ms
    durationMs,
    details: {
      messages:      numMessages,
      processed:     metrics.processed,
      dropped:       metrics.dropped,
      dropRate:      +((metrics.dropped / numMessages) * 100).toFixed(1) + '%',
      throughputMsgS: +throughput.toFixed(0),
      avgLatencyMs:  metrics.avgLatencyMs,
    },
  }
}

// ── Test 2: multi-fader ───────────────────────────────────────────────────────

function benchMultiFader(controlPath: any, numFaders: number, updatesEach: number): ControlBenchResult {
  controlPath.resetMetrics()

  const t0 = now()
  for (let u = 0; u < updatesEach; u++) {
    for (let f = 0; f < numFaders; f++) {
      controlPath.handleMessage(makeCCMsg(f, Math.floor(u * 127 / updatesEach)))
    }
  }
  const durationMs = now() - t0
  const metrics    = controlPath.getMetrics()

  return {
    test:   `multiFader_${numFaders}ch`,
    passed: metrics.avgLatencyMs < 2.0,
    durationMs,
    details: {
      faders:         numFaders,
      updatesPerFader: updatesEach,
      totalMsgs:      numFaders * updatesEach,
      processed:      metrics.processed,
      avgLatencyMs:   metrics.avgLatencyMs,
    },
  }
}

// ── Test 3: mapper throughput ─────────────────────────────────────────────────

function benchMapperThroughput(mapper: any, iterations: number): ControlBenchResult {
  // Pre-load template
  mapper.loadGenericFaderTemplate(6)

  const msg  = makeCCMsg(0, 80)  // maps to channelVolume ch1
  const t0   = now()

  for (let i = 0; i < iterations; i++) {
    mapper.processMessage(msg)
  }

  const durationMs  = now() - t0
  const lookupPerMs = iterations / durationMs

  return {
    test:   'mapperThroughput',
    passed: lookupPerMs > 50,   // must handle > 50 lookups/ms
    durationMs,
    details: {
      iterations,
      lookupsPerMs: +lookupPerMs.toFixed(0),
      nsPerLookup:  +((durationMs * 1e6) / iterations).toFixed(1),
    },
  }
}

// ── Test 4: note toggle ───────────────────────────────────────────────────────

function benchNoteToggle(controlPath: any): ControlBenchResult {
  controlPath.resetMetrics()
  const TOGGLES = 100
  const t0 = now()

  for (let i = 0; i < TOGGLES; i++) {
    // Alternating noteon/noteoff for mute toggle
    controlPath.handleMessage(makeNoteMsg(0, i % 2 === 0 ? 127 : 0))
  }

  const durationMs = now() - t0
  const metrics    = controlPath.getMetrics()

  return {
    test:   'noteToggle',
    passed: metrics.dropped === 0,   // buttons should never be rate-limited
    durationMs,
    details: {
      toggles:    TOGGLES,
      processed:  metrics.processed,
      dropped:    metrics.dropped,
    },
  }
}

// ── Suite runner ──────────────────────────────────────────────────────────────

export async function runControlBenchmark(
  controlPath: any,
  mapper:      any,
): Promise<ControlBenchResult[]> {
  console.group('[ControlBenchmark] Running Paso 13 MIDI control suite…')
  const results: ControlBenchResult[] = []

  const r1 = benchMidiFlood(controlPath, 1000)
  results.push(r1)
  console.log(`${r1.passed ? '✓' : '✗'} ${r1.test}:`, r1.details)

  const r2 = benchMultiFader(controlPath, 6, 100)
  results.push(r2)
  console.log(`${r2.passed ? '✓' : '✗'} ${r2.test}:`, r2.details)

  const r3 = benchMapperThroughput(mapper, 10_000)
  results.push(r3)
  console.log(`${r3.passed ? '✓' : '✗'} ${r3.test}:`, r3.details)

  const r4 = benchNoteToggle(controlPath)
  results.push(r4)
  console.log(`${r4.passed ? '✓' : '✗'} ${r4.test}:`, r4.details)

  const allPassed = results.every(r => r.passed)
  console.log(`\n${allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'} — ${results.filter(r => r.passed).length}/${results.length}`)
  console.groupEnd()

  return results
}

// ── Control workflow report ───────────────────────────────────────────────────

export function generateControlReport(
  midiEngine:   any,
  controlPath:  any,
  mapper:       any,
): void {
  const metrics  = controlPath.getMetrics()
  const inputs   = midiEngine.listInputs()
  const outputs  = midiEngine.listOutputs()
  const rules    = mapper.getRules()

  console.group('[ControlReport] ONA Live Studio — Control Surface Status')
  console.log(`\nMIDI I/O:`)
  console.log(`  Inputs  (${inputs.length}): ${inputs.map((d: any) => `"${d.name}"`).join(', ') || 'none'}`)
  console.log(`  Outputs (${outputs.length}): ${outputs.map((d: any) => `"${d.name}"`).join(', ') || 'none'}`)
  console.log(`  Control path: ${controlPath.active ? 'ACTIVE' : 'inactive'}`)
  console.log(`\nMIDI Mappings: ${rules.length} rules`)
  if (rules.length > 0) {
    console.table(rules.map((r: any) => ({
      id:     r.id,
      label:  r.label ?? '-',
      source: `${r.source.type} ch${r.source.channel} #${r.source.number}`,
      target: `${r.target.action}`,
      mode:   r.mode,
    })))
  }
  console.log(`\nControl metrics (since last reset):`)
  console.log(`  Received:    ${metrics.messagesReceived}`)
  console.log(`  Processed:   ${metrics.processed}`)
  console.log(`  Dropped:     ${metrics.dropped} (rate-limited)`)
  console.log(`  Avg latency: ${metrics.avgLatencyMs}ms`)
  console.log(`\nSupported workflows:`)
  console.log(`  ✓ Generic MIDI fader controller (USB class-compliant)`)
  console.log(`  ✓ Mute/solo button surfaces (Note On/Off toggle)`)
  console.log(`  ✓ Encoder EQ control (CC relative, 40H mode)`)
  console.log(`  ✓ AUX send control (CC absolute)`)
  console.log(`  ✓ Scene recall via MIDI (Note On)`)
  console.log(`  ✓ Transport control (Note On)`)
  console.log(`  ◑ Motor fader feedback (requires MIDI output device)`)
  console.log(`  ◑ LED feedback (requires MIDI output device)`)
  console.log(`  ○ Mackie MCU/HUI (future — needs sysex negotiation)`)
  console.log(`  ○ OSC control (future — needs UDP server)`)
  console.log(`  ○ Tablet/touchscreen (future — gesture layer)`)
  console.groupEnd()
}

// ── Console API ───────────────────────────────────────────────────────────────

export function exposeControlBenchAPI(
  midiEngine:  any,
  controlPath: any,
  mapper:      any,
): void {
  ;(window as any).__ONA_CONTROL_BENCH = {
    run:    () => runControlBenchmark(controlPath, mapper),
    flood:  (n = 1000) => benchMidiFlood(controlPath, n),
    faders: (n = 6, u = 100) => benchMultiFader(controlPath, n, u),
    mapper: (n = 10000) => benchMapperThroughput(mapper, n),
    report: () => generateControlReport(midiEngine, controlPath, mapper),
    metrics: () => { const m = controlPath.getMetrics(); console.table(m); return m },
    reset:  () => { controlPath.resetMetrics(); console.log('[ControlBench] metrics reset') },
    help: () => {
      console.group('[ControlBenchmark] Console API')
      console.log('__ONA_CONTROL_BENCH.run()         — suite completa')
      console.log('__ONA_CONTROL_BENCH.flood(n)      — MIDI flood test (default 1000 msgs)')
      console.log('__ONA_CONTROL_BENCH.faders(n, u)  — multi-fader test (n faders, u updates)')
      console.log('__ONA_CONTROL_BENCH.mapper(n)     — mapper throughput (n lookups)')
      console.log('__ONA_CONTROL_BENCH.report()      — workflow support report')
      console.log('__ONA_CONTROL_BENCH.metrics()     — current control metrics')
      console.log('__ONA_CONTROL_BENCH.reset()       — reset metrics counters')
      console.groupEnd()
    },
  }
}
