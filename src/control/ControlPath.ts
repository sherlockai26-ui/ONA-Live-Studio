/**
 * ControlPath.ts — Ruta de control de alta prioridad: MIDI → DSP.
 *
 * Responsabilidades:
 *   - Recibir mensajes MIDI de MidiEngine
 *   - Aplicar rate limiting por tipo (protección contra MIDI floods)
 *   - Resolver acciones via MidiMapper
 *   - Despachar al dispatcher (set por AudioEngineSingleton) SIN pasar por React
 *
 * Rate limiter (token bucket por key):
 *   CC fader:   60 msgs/s max (16ms min interval)
 *   CC encoder: 30 msgs/s max (33ms min interval)
 *   Note/other: sin límite (botones no hacen flood)
 *   Burst:      hasta 3 mensajes acumulados antes de throttle
 *
 * Separación control-rate / UI-rate (Paso 13, tarea 3):
 *   El dispatcher recibe ControlAction y llama audioBridge directamente.
 *   React NO está en este hot path — los cambios llegan al DSP en < 2ms.
 *   La UI se actualiza en su propio ciclo (store de Zustand, polling o events).
 *
 * Métricas:
 *   processed   — total acciones despachadas
 *   dropped     — mensajes descartados por rate limit
 *   avgLatencyMs — promedio msg-receive → dispatch
 */

import type { MidiMessage } from './MidiEngine'
import type { MidiMapperImpl } from './MidiMapper'
import type { ControlAction } from './MidiMapper'

// ── Rate limiter — token bucket por key ───────────────────────────────────────

interface Bucket {
  tokens:     number
  lastRefill: number
}

interface RateConfig {
  maxTokens:   number    // burst capacity
  refillRate:  number    // tokens per millisecond
}

const RATE_CONFIGS: Record<string, RateConfig> = {
  cc_fader:   { maxTokens: 3, refillRate: 3 / 1000 * 60 / 1000 },   // 60/s
  cc_encoder: { maxTokens: 3, refillRate: 3 / 1000 * 30 / 1000 },   // 30/s
  cc_other:   { maxTokens: 8, refillRate: 8 / 1000 * 40 / 1000 },   // 40/s
  note:       { maxTokens: 16, refillRate: 1 },                       // unlimited
  default:    { maxTokens: 8,  refillRate: 8 / 1000 * 30 / 1000 },   // 30/s
}

// Fader CCs are commonly 0-7 (generic surfaces) — encoder CCs typically 16+
function getRateKey(msg: MidiMessage): string {
  if (msg.type === 'noteon' || msg.type === 'noteoff') return 'note'
  if (msg.type === 'cc') {
    const cc = msg.cc ?? 0
    return cc <= 7 || cc === 11 ? 'cc_fader' : cc >= 16 ? 'cc_encoder' : 'cc_other'
  }
  return 'default'
}

class RateLimiter {
  private _buckets = new Map<string, Bucket>()

  shouldProcess(key: string, configKey: string): boolean {
    const cfg = RATE_CONFIGS[configKey] ?? RATE_CONFIGS.default
    const now = performance.now()

    let bucket = this._buckets.get(key)
    if (!bucket) {
      bucket = { tokens: cfg.maxTokens, lastRefill: now }
      this._buckets.set(key, bucket)
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill
    bucket.tokens = Math.min(cfg.maxTokens, bucket.tokens + elapsed * cfg.refillRate)
    bucket.lastRefill = now

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return true
    }
    return false
  }

  reset(): void { this._buckets.clear() }
}

// ── Action dispatcher type ────────────────────────────────────────────────────

export type ControlDispatcher = (action: ControlAction) => void

// ── ControlPath ───────────────────────────────────────────────────────────────

export interface ControlMetrics {
  processed:   number
  dropped:     number
  avgLatencyMs: number
  messagesReceived: number
}

class ControlPathImpl {
  private _mapper:     any  // MidiMapperImpl — avoid import cycle
  private _dispatch:   ControlDispatcher | null = null
  private _rateLimiter = new RateLimiter()
  private _active      = false

  // Latency tracking (rolling window, 100 samples)
  private _latencies:  number[] = []

  // Metrics
  private _processed   = 0
  private _dropped     = 0
  private _received    = 0

  // ── Setup ─────────────────────────────────────────────────────────────────────

  /**
   * setMapper — inject mapper dependency (avoids circular import).
   * Call from AudioEngineSingleton during initialize().
   */
  setMapper(mapper: any): void { this._mapper = mapper }

  /**
   * setDispatcher — inject action dispatcher (audioBridge calls).
   * This is the ONLY connection to the audio layer.
   * No React, no Zustand — pure DSP control path.
   */
  setDispatcher(dispatch: ControlDispatcher): void {
    this._dispatch = dispatch
    this._active   = true
    console.log('[ControlPath] dispatcher registered — control path active')
  }

  // ── Hot path: MIDI message → DSP ─────────────────────────────────────────────
  // Called directly from MidiEngine.onMessage (Web MIDI callback).
  // Must complete in < 2ms. No allocations outside of rarely-hit branches.

  handleMessage(msg: MidiMessage): void {
    this._received++
    if (!this._active || !this._mapper || !this._dispatch) return

    const configKey = getRateKey(msg)
    const bucketKey = `${msg.deviceId}_${msg.type}_${msg.channel}_${msg.cc ?? msg.note ?? 0}`

    if (!this._rateLimiter.shouldProcess(bucketKey, configKey)) {
      this._dropped++
      return
    }

    const t0      = performance.now()
    const actions = this._mapper.processMessage(msg)

    for (const action of actions) {
      this._dispatch(action)
      this._processed++
    }

    // Track latency
    const latencyMs = performance.now() - t0
    if (this._latencies.length >= 100) this._latencies.shift()
    this._latencies.push(latencyMs)
  }

  // ── Metrics ───────────────────────────────────────────────────────────────────

  getMetrics(): ControlMetrics {
    const avg = this._latencies.length > 0
      ? this._latencies.reduce((a, b) => a + b, 0) / this._latencies.length
      : 0
    return {
      processed:        this._processed,
      dropped:          this._dropped,
      avgLatencyMs:     +avg.toFixed(3),
      messagesReceived: this._received,
    }
  }

  resetMetrics(): void {
    this._processed = 0
    this._dropped   = 0
    this._received  = 0
    this._latencies = []
    this._rateLimiter.reset()
  }

  get active(): boolean { return this._active }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    this._dispatch  = null
    this._mapper    = null
    this._active    = false
    this._rateLimiter.reset()
    this.resetMetrics()
  }
}

export const controlPath = new ControlPathImpl()
