/**
 * DSPObjectPool.ts — Pool de buffers reutilizables para el hot path DSP.
 *
 * Objetivo: cero allocations en callbacks de audio y RAF loop.
 *
 * Pools disponibles:
 *   Float32Pool  — Float32Array de tamaño fijo (bloques de audio)
 *   Uint8Pool    — Uint8Array para SAB views
 *
 * Uso:
 *   const pool = new Float32Pool(128 * 2, 8)  // 8 buffers de 256 floats
 *   const buf = pool.acquire()
 *   // ... procesar ...
 *   pool.release(buf)
 *
 * REGLA: release() siempre. Si no se libera, el pool se vacía y acquire()
 * aloca un buffer nuevo (sin crash, pero con GC). El pool es LIFO (stack)
 * para mejor localidad de caché.
 */

export class Float32Pool {
  private readonly _stack: Float32Array[]
  private readonly _size:  number
  private _allocated = 0
  private _misses    = 0

  constructor(frameSize: number, poolSize = 8) {
    this._size  = frameSize
    this._stack = []
    for (let i = 0; i < poolSize; i++) {
      this._stack.push(new Float32Array(frameSize))
    }
  }

  acquire(): Float32Array {
    if (this._stack.length > 0) {
      this._allocated++
      return this._stack.pop()!
    }
    // Pool agotado — aloca nuevo (GC, pero no crash)
    this._misses++
    return new Float32Array(this._size)
  }

  release(buf: Float32Array): void {
    if (buf.length !== this._size) return  // tamaño incorrecto — descartar
    buf.fill(0)  // limpiar antes de regresar al pool
    this._stack.push(buf)
    if (this._allocated > 0) this._allocated--
  }

  get inUse():   number { return this._allocated }
  get poolSize(): number { return this._stack.length }
  get misses():   number { return this._misses }
}

export class Uint8Pool {
  private readonly _stack: Uint8Array[]
  private readonly _size:  number

  constructor(byteSize: number, poolSize = 4) {
    this._size  = byteSize
    this._stack = []
    for (let i = 0; i < poolSize; i++) this._stack.push(new Uint8Array(byteSize))
  }

  acquire(): Uint8Array {
    return this._stack.length > 0 ? this._stack.pop()! : new Uint8Array(this._size)
  }

  release(buf: Uint8Array): void {
    if (buf.length !== this._size) return
    this._stack.push(buf)
  }
}

// ─── Pool singleton para los tamaños más comunes ──────────────────────────────

const BLOCK_SIZES = [64, 128, 256, 512] as const

/** Pool global para bloques de audio (stereo interleaved) */
const _pools = new Map<number, Float32Pool>()

for (const bs of BLOCK_SIZES) {
  _pools.set(bs * 2, new Float32Pool(bs * 2, 8))
}

export function acquireAudioBlock(blockSize: number): Float32Array {
  const key  = blockSize * 2
  const pool = _pools.get(key)
  return pool ? pool.acquire() : new Float32Array(key)
}

export function releaseAudioBlock(buf: Float32Array): void {
  const pool = _pools.get(buf.length)
  if (pool) pool.release(buf)
}

export function getPoolStats(): Record<string, { inUse: number; poolSize: number; misses: number }> {
  const stats: Record<string, { inUse: number; poolSize: number; misses: number }> = {}
  for (const [size, pool] of _pools) {
    stats[`bs${size / 2}`] = { inUse: pool.inUse, poolSize: pool.poolSize, misses: pool.misses }
  }
  return stats
}

;(window as any).__ONA_POOL = {
  stats: getPoolStats,
}
