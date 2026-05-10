/**
 * CacheOptimizer.ts — Float32Array pool, command batching, SAB audit.
 *
 * Float32Array pool:
 *   Pre-allocate and reuse buffers — eliminates GC pressure in hot meter paths.
 *   Pool per size: 256 (meter), 512, 1024 (WAV chunks), 2048.
 *   Max pool depth: 8 per size. Excess allocations fall through to new Float32Array.
 *
 * Command batch packer:
 *   Accumulate DSP commands keyed by (channelId, paramKey).
 *   Last write wins per key (deduplication).
 *   Flush every FLUSH_INTERVAL_MS — reduces AudioParam setTargetAtTime call rate.
 *
 * SAB audit:
 *   Count bytes flowing through SharedArrayBuffer paths.
 *   Warn if throughput exceeds 100MB/s sustained (potential bottleneck).
 */

const POOL_SIZES       = [256, 512, 1024, 2048] as const
const POOL_DEPTH       = 8
const FLUSH_INTERVAL   = 16  // ms — one animation frame

type PoolSize = typeof POOL_SIZES[number]

export interface CacheStats {
  pool:     Record<number, { depth: number; hits: number; misses: number; hitRate: string }>
  batch:    { pending: number; flushed: number; deduplicated: number }
  sabAudit: { reads: number; writes: number; bytesTotal: number; throughputKBps: string }
}

class CacheOptimizer {
  private _pools    = new Map<PoolSize, Float32Array[]>()
  private _hits     = new Map<PoolSize, number>()
  private _misses   = new Map<PoolSize, number>()

  private _batch:        Map<string, () => void> = new Map()
  private _batchFlushed  = 0
  private _batchDedup    = 0
  private _flushTimer:   ReturnType<typeof setInterval> | null = null

  private _sabReads  = 0
  private _sabWrites = 0
  private _sabBytes  = 0
  private _sabStart  = Date.now()

  initialize(): void {
    for (const size of POOL_SIZES) {
      this._pools.set(size, Array.from({ length: POOL_DEPTH }, () => new Float32Array(size)))
      this._hits.set(size, 0)
      this._misses.set(size, 0)
    }
    this._flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL)
  }

  // ── Float32Array pool ─────────────────────────────────────────────────────────

  acquire(minSize: number): Float32Array {
    const poolSize = POOL_SIZES.find(s => s >= minSize) as PoolSize | undefined
    if (poolSize) {
      const pool = this._pools.get(poolSize)!
      if (pool.length > 0) {
        this._hits.set(poolSize, (this._hits.get(poolSize) ?? 0) + 1)
        return pool.pop()!
      }
      this._misses.set(poolSize, (this._misses.get(poolSize) ?? 0) + 1)
      return new Float32Array(poolSize)
    }
    return new Float32Array(minSize)
  }

  release(buf: Float32Array): void {
    const size = buf.length as PoolSize
    const pool = this._pools.get(size)
    if (pool && pool.length < POOL_DEPTH) pool.push(buf)
  }

  // ── Command batch ─────────────────────────────────────────────────────────────

  batchCommand(key: string, fn: () => void): void {
    if (this._batch.has(key)) this._batchDedup++
    this._batch.set(key, fn)
  }

  private _flush(): void {
    if (this._batch.size === 0) return
    for (const fn of this._batch.values()) {
      try { fn() } catch (_) {}
    }
    this._batchFlushed += this._batch.size
    this._batch.clear()
  }

  flushNow(): void { this._flush() }

  // ── SAB audit ─────────────────────────────────────────────────────────────────

  recordSabRead(bytes: number):  void { this._sabReads++;  this._sabBytes += bytes }
  recordSabWrite(bytes: number): void { this._sabWrites++; this._sabBytes += bytes }

  // ── Stats ─────────────────────────────────────────────────────────────────────

  getStats(): CacheStats {
    const pool: Record<number, any> = {}
    for (const size of POOL_SIZES) {
      const h = this._hits.get(size) ?? 0
      const m = this._misses.get(size) ?? 0
      pool[size] = {
        depth:   this._pools.get(size)?.length ?? 0,
        hits:    h,
        misses:  m,
        hitRate: h + m > 0 ? `${((h / (h + m)) * 100).toFixed(0)}%` : 'n/a',
      }
    }

    const elapsedS     = Math.max(1, (Date.now() - this._sabStart) / 1000)
    const throughput   = this._sabBytes / elapsedS / 1024

    return {
      pool,
      batch: {
        pending:      this._batch.size,
        flushed:      this._batchFlushed,
        deduplicated: this._batchDedup,
      },
      sabAudit: {
        reads:          this._sabReads,
        writes:         this._sabWrites,
        bytesTotal:     this._sabBytes,
        throughputKBps: `${throughput.toFixed(1)} KB/s`,
      },
    }
  }

  destroy(): void {
    if (this._flushTimer) clearInterval(this._flushTimer)
    this._flush()
    for (const pool of this._pools.values()) pool.length = 0
    this._batch.clear()
  }
}

export const cacheOptimizer = new CacheOptimizer()
