/**
 * DSPBenchmarkRunner.ts — Benchmark real del pipeline DSP completo.
 *
 * Mide rendimiento en condiciones reales: múltiples canales simultáneos,
 * gate logic, metering, con y sin módulo Rust.
 *
 * Bench modes:
 *   channelBench(n)   — procesa N canales en paralelo (simula carga real)
 *   stabilityTest()   — simula sesión de 4h continua (GC drift, memory growth)
 *   rafJitterTest()   — mide jitter del RAF loop durante 30s
 *
 * Console API:
 *   window.__ONA_BENCH.channels(8)
 *   window.__ONA_BENCH.channels(16)
 *   window.__ONA_BENCH.channels(32)
 *   window.__ONA_BENCH.stability(durationMs)
 *   window.__ONA_BENCH.jitter(durationMs)
 */

import { acquireAudioBlock, releaseAudioBlock, getPoolStats } from './DSPObjectPool'
import { nativeDSPBridge } from '../native/NativeDSPBridge'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface ChannelBenchResult {
  numChannels:    number
  blockSize:      number
  sampleRate:     number
  numBlocks:      number
  totalMs:        number
  perBlockMs:     number
  perChannelNs:   number
  realtimeFactor: number
  backend:        string
  gcSpikes:       number  // número de frames con jitter > 10ms
}

export interface StabilityResult {
  durationMs:    number
  gcSpikes:      number
  maxJitterMs:   number
  memoryGrowthKB: number
  driftMs:       number
  verdict:       'stable' | 'unstable'
}

export interface JitterResult {
  durationMs:  number
  samplesN:    number
  avgMs:       number
  maxMs:       number
  p99Ms:       number
  gcSpikes:    number  // jitter > 50ms
}

// ─── Channel Benchmark ────────────────────────────────────────────────────────

export async function channelBench(
  numChannels = 8,
  blockSize   = 128,
  sampleRate  = 48000,
  numBlocks   = 5_000,
): Promise<ChannelBenchResult> {
  const backend = nativeDSPBridge.backend

  // Crear un canal DSP por cada canal del benchmark
  const channels = Array.from({ length: numChannels }, (_, i) =>
    nativeDSPBridge.getChannel(1000 + i)
  )

  // Inicializar con parámetros realistas
  channels.forEach((ch, i) => {
    ch.setGainDb(-6 + (i % 6))   // -6 a 0 dB
    ch.setPan((i / numChannels) * 2 - 1)  // pan distribuido
  })

  // Warm up — 100 bloques para estabilizar JIT
  const warmBuf = acquireAudioBlock(blockSize)
  for (let i = 0; i < 100; i++) {
    for (const ch of channels) ch.processBlock(warmBuf)
  }
  releaseAudioBlock(warmBuf)

  // Benchmark real
  let gcSpikes = 0
  const wallStart = performance.now()
  let lastBlockT  = wallStart

  for (let b = 0; b < numBlocks; b++) {
    const buf = acquireAudioBlock(blockSize)

    // Señal sintética (evita compilar a silencio)
    for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() - 0.5) * 0.1

    const t0 = performance.now()
    for (const ch of channels) ch.processBlock(buf)
    const elapsed = performance.now() - t0

    releaseAudioBlock(buf)

    if (elapsed > 10) gcSpikes++
    lastBlockT = performance.now()
  }

  const totalMs      = performance.now() - wallStart
  const samplesTotal = blockSize * numBlocks
  const audioSecs    = samplesTotal / sampleRate
  const wallSecs     = totalMs / 1000

  // Cleanup canales temporales
  for (let i = 0; i < numChannels; i++) nativeDSPBridge.destroyChannel(1000 + i)

  return {
    numChannels,
    blockSize,
    sampleRate,
    numBlocks,
    totalMs,
    perBlockMs:     totalMs / numBlocks,
    perChannelNs:   (totalMs * 1_000_000) / numBlocks / numChannels,
    realtimeFactor: audioSecs / wallSecs,
    backend,
    gcSpikes,
  }
}

function printChannelBench(r: ChannelBenchResult): void {
  const rt = r.realtimeFactor
  const ok = rt > 100 ? '✓✓' : rt > 10 ? '✓' : '⚠'
  console.group(`📊 Channel Bench — ${r.numChannels}ch × ${r.blockSize}smp [${r.backend}]`)
  console.log(`  Bloques:         ${r.numBlocks.toLocaleString()}`)
  console.log(`  Total:           ${r.totalMs.toFixed(1)} ms`)
  console.log(`  Por bloque:      ${r.perBlockMs.toFixed(3)} ms`)
  console.log(`  Por canal:       ${r.perChannelNs.toFixed(0)} ns`)
  console.log(`  Realtime:        ${rt.toFixed(0)}× ${ok}`)
  console.log(`  GC spikes:       ${r.gcSpikes}`)
  console.groupEnd()
}

// ─── Stability Test ───────────────────────────────────────────────────────────

export function stabilityTest(
  durationMs  = 10_000,  // 10s por defecto; 4h = 14_400_000ms
  blockSize   = 128,
  sampleRate  = 48000,
  numChannels = 6,
): Promise<StabilityResult> {
  return new Promise(resolve => {
    const channels = Array.from({ length: numChannels }, (_, i) =>
      nativeDSPBridge.getChannel(2000 + i)
    )

    let gcSpikes    = 0
    let maxJitter   = 0
    let lastRaf     = performance.now()
    let lastMemory  = (performance as any).memory?.usedJSHeapSize ?? 0
    const startMem  = lastMemory
    let rafId: number
    let elapsedMs   = 0

    // Simular carga DSP en cada RAF frame (~1000 bloques por frame a 128 samples @ 48kHz)
    const blocksPerFrame = Math.ceil((sampleRate / 60) / blockSize)

    const tick = (now: number) => {
      const delta  = now - lastRaf
      const jitter = Math.abs(delta - 16.7)
      if (delta > 50) gcSpikes++
      if (jitter > maxJitter) maxJitter = jitter
      lastRaf   = now
      elapsedMs = now

      const buf = acquireAudioBlock(blockSize)
      for (let b = 0; b < blocksPerFrame; b++) {
        for (const ch of channels) ch.processBlock(buf)
      }
      releaseAudioBlock(buf)

      const curMem = (performance as any).memory?.usedJSHeapSize ?? startMem
      lastMemory = curMem

      if (elapsedMs - (performance.now() - durationMs) < durationMs) {
        rafId = requestAnimationFrame(tick)
      } else {
        cancelAnimationFrame(rafId)
        for (let i = 0; i < numChannels; i++) nativeDSPBridge.destroyChannel(2000 + i)

        const memGrowth = Math.max(0, (lastMemory - startMem) / 1024)
        resolve({
          durationMs,
          gcSpikes,
          maxJitterMs:    maxJitter,
          memoryGrowthKB: memGrowth,
          driftMs:        0,  // populated by DSPScheduler
          verdict: gcSpikes < 10 && memGrowth < 1024 ? 'stable' : 'unstable',
        })
      }
    }

    rafId = requestAnimationFrame(tick)
  })
}

// ─── RAF Jitter Test ──────────────────────────────────────────────────────────

export function rafJitterTest(durationMs = 5_000): Promise<JitterResult> {
  return new Promise(resolve => {
    const samples: number[] = []
    let lastT = performance.now()
    let rafId: number

    const tick = (now: number) => {
      const delta = now - lastT
      lastT = now
      if (samples.length > 0) samples.push(delta)  // skip first

      if (now - samples[0] < durationMs) {
        rafId = requestAnimationFrame(tick)
      } else {
        cancelAnimationFrame(rafId)
        samples.shift()

        const n   = samples.length
        const avg = samples.reduce((a, b) => a + b, 0) / n
        const max = Math.max(...samples)
        const sorted = [...samples].sort((a, b) => a - b)
        const p99 = sorted[Math.floor(n * 0.99)]
        const gcSpikes = samples.filter(s => s > 50).length

        resolve({ durationMs, samplesN: n, avgMs: avg, maxMs: max, p99Ms: p99, gcSpikes })
      }
    }

    rafId = requestAnimationFrame(tick)
  })
}

// ─── Suite completa ───────────────────────────────────────────────────────────

export async function runFullBenchmark(): Promise<void> {
  console.group('[BENCH] Suite completa de rendimiento DSP')

  for (const n of [8, 16, 32, 64]) {
    const r = await channelBench(n)
    printChannelBench(r)
    await new Promise(r => setTimeout(r, 100))  // pausa entre tests
  }

  console.log('\n[BENCH] Pool stats:', getPoolStats())
  console.groupEnd()
}

// ─── Console API ──────────────────────────────────────────────────────────────

export function exposeBenchmarkRunnerAPI(): void {
  ;(window as any).__ONA_BENCH = {
    channels:  (n?: number, bs?: number) => channelBench(n).then(r => { printChannelBench(r); return r }),
    full:      () => runFullBenchmark(),
    stability: (ms?: number) => stabilityTest(ms).then(r => { console.table(r); return r }),
    jitter:    (ms?: number) => rafJitterTest(ms).then(r => { console.table(r); return r }),
    pool:      () => console.table(getPoolStats()),
  }
}
