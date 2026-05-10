/**
 * NativeDSPBenchmark.ts — Comparativa Rust DSP vs WebAudio fallback.
 *
 * Mide:
 *   - Tiempo de procesamiento de bloque (ns por muestra)
 *   - Factor realtime (cuántas veces más rápido que realtime)
 *   - Jitter (max - min ns)
 *   - Overhead JS→Rust (diferencia entre processingNs reportado y wall time)
 *
 * Uso desde consola:
 *   window.__ONA_BENCHMARK.run()
 *   window.__ONA_BENCHMARK.compare()
 */

import type { BenchmarkResult, BlockResult } from './types'
import { nativeDSPBridge }         from './NativeDSPBridge'
import { WebAudioDSPChannel }      from './WebAudioDSPFallback'

interface LocalBenchResult {
  name:          string
  blockSize:     number
  numBlocks:     number
  avgNs:         number
  minNs:         number
  maxNs:         number
  totalMs:       number
  realtimeFactor: number
  jitterNs:      number
  overheadNs?:   number
}

// ─── Benchmark del fallback JS ────────────────────────────────────────────────

function benchmarkFallback(
  blockSize:  number,
  numBlocks:  number,
  sampleRate: number,
): LocalBenchResult {
  const ch  = new WebAudioDSPChannel(0, sampleRate)
  ch.setGainLinear(0.8)
  ch.setPan(0.1)

  const buf = new Float32Array(blockSize * 2)
  for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 2 - 1) * 0.5

  let maxNs  = 0
  let minNs  = Infinity
  let sumNs  = 0

  const wallStart = performance.now()

  for (let b = 0; b < numBlocks; b++) {
    const result: BlockResult = ch.processBlock(buf)
    const ns = result.processingNs
    sumNs += ns
    if (ns > maxNs) maxNs = ns
    if (ns < minNs) minNs = ns
  }

  const totalMs      = performance.now() - wallStart
  const samplesTotal = blockSize * numBlocks
  const audioSecs    = samplesTotal / sampleRate
  const wallSecs     = totalMs / 1000

  return {
    name:          'WebAudio JS Fallback',
    blockSize,
    numBlocks,
    avgNs:          sumNs / numBlocks,
    minNs,
    maxNs,
    totalMs,
    realtimeFactor: audioSecs / wallSecs,
    jitterNs:       maxNs - minNs,
  }
}

// ─── Benchmark del engine nativo Rust ────────────────────────────────────────

async function benchmarkNative(
  blockSize:  number,
  numBlocks:  number,
  sampleRate: number,
): Promise<LocalBenchResult | null> {
  const nativeResult: BenchmarkResult | null =
    await nativeDSPBridge.benchmarkNative(blockSize, numBlocks)

  if (!nativeResult) return null

  // Benchmark del overhead JS→Rust (llamadas individuales desde renderer)
  const ch = nativeDSPBridge.getChannel(9999)
  ch.setGainLinear(0.8)
  ch.setPan(0.1)

  const buf = new Float32Array(blockSize * 2)
  for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 2 - 1) * 0.5

  const warmup = 50
  for (let i = 0; i < warmup; i++) ch.processBlock(buf)

  let wallSumMs = 0
  const wallSamples = Math.min(500, numBlocks)
  for (let b = 0; b < wallSamples; b++) {
    const t0   = performance.now()
    const res  = ch.processBlock(buf)
    const wall = (performance.now() - t0) * 1_000_000 // → ns
    wallSumMs += wall
    void res
  }

  const avgWallNs   = wallSumMs / wallSamples
  const overheadNs  = Math.max(0, avgWallNs - nativeResult.avgNs)

  nativeDSPBridge.destroyChannel(9999)

  return {
    name:           'Rust Native DSP',
    blockSize:      nativeResult.blockSize,
    numBlocks:      nativeResult.numBlocks,
    avgNs:          nativeResult.avgNs,
    minNs:          nativeResult.minNs,
    maxNs:          nativeResult.maxNs,
    totalMs:        nativeResult.totalMs,
    realtimeFactor: nativeResult.realtimeFactor,
    jitterNs:       nativeResult.maxNs - nativeResult.minNs,
    overheadNs,
  }
}

// ─── Formato de resultados ────────────────────────────────────────────────────

function printResult(r: LocalBenchResult): void {
  console.group(`📊 ${r.name}`)
  console.log(`  Block size:     ${r.blockSize} samples (stereo)`)
  console.log(`  Blocks:         ${r.numBlocks.toLocaleString()}`)
  console.log(`  Avg:            ${r.avgNs.toFixed(1)} ns/bloque`)
  console.log(`  Min/Max:        ${r.minNs.toFixed(1)} / ${r.maxNs.toFixed(1)} ns`)
  console.log(`  Jitter:         ${r.jitterNs.toFixed(1)} ns`)
  console.log(`  Total:          ${r.totalMs.toFixed(1)} ms`)
  console.log(`  Realtime:       ${r.realtimeFactor.toFixed(0)}× (>${r.realtimeFactor > 100 ? '✓✓' : r.realtimeFactor > 10 ? '✓' : '⚠'})`)
  if (r.overheadNs !== undefined) {
    console.log(`  JS→Rust:        ${r.overheadNs.toFixed(1)} ns overhead`)
  }
  console.groupEnd()
}

// ─── API pública ──────────────────────────────────────────────────────────────

export class NativeDSPBenchmark {
  constructor(
    private readonly _sampleRate = 48000,
    private readonly _blockSize  = 128,
  ) {}

  async run(numBlocks = 10_000): Promise<LocalBenchResult> {
    console.log(`[BENCHMARK] Ejecutando fallback JS — ${numBlocks} bloques × ${this._blockSize} samples...`)
    const result = benchmarkFallback(this._blockSize, numBlocks, this._sampleRate)
    printResult(result)
    return result
  }

  async compare(numBlocks = 10_000): Promise<void> {
    console.group('[BENCHMARK] Comparativa DSP: Rust Native vs JS Fallback')

    const jsResult = benchmarkFallback(this._blockSize, numBlocks, this._sampleRate)
    printResult(jsResult)

    if (nativeDSPBridge.isNative) {
      const nResult = await benchmarkNative(this._blockSize, numBlocks, this._sampleRate)
      if (nResult) {
        printResult(nResult)
        const speedup = jsResult.avgNs / nResult.avgNs
        console.log(`\n  🚀 Rust es ${speedup.toFixed(1)}× más rápido que JS`)
        console.log(`  🔗 Overhead JS→Rust: ${(nResult.overheadNs ?? 0).toFixed(1)} ns`)
      }
    } else {
      console.warn('  Módulo nativo no disponible — solo se midió fallback JS')
      console.info('  Instala Rust y ejecuta: npm run build:native')
    }

    console.groupEnd()
  }

  async fullReport(blockSizes = [64, 128, 256, 512]): Promise<void> {
    console.group('[BENCHMARK] Reporte completo — múltiples block sizes')
    for (const bs of blockSizes) {
      const bench = new NativeDSPBenchmark(this._sampleRate, bs)
      await bench.run(5_000)
    }
    console.groupEnd()
  }
}

// Exponer en consola para diagnóstico en producción
export function exposeBenchmarkAPI(sampleRate: number, blockSize: number): void {
  const bench = new NativeDSPBenchmark(sampleRate, blockSize)
  ;(window as any).__ONA_BENCHMARK = {
    run:        (n?: number) => bench.run(n),
    compare:    (n?: number) => bench.compare(n),
    fullReport: (sizes?: number[]) => bench.fullReport(sizes),
  }
}
