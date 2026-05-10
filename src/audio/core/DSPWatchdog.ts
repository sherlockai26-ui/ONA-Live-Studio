/**
 * DSPWatchdog.ts — Health monitoring and auto-recovery for the DSP engine.
 *
 * Paso 7 tuning:
 *   - WORKLET_STALE_MS: 500 → 2000ms (reduce falsos positivos en startup)
 *   - Cooldown de 5s entre warnings del mismo tipo (evita spam)
 *   - No warn si worklet nunca superó -100dBFS (silencio total = normal)
 *   - CHECK_INTERVAL_MS: 1000 → 2000ms (menor polling overhead)
 *
 * Checks:
 *   1. AudioContext.state — auto-resume si 'suspended'
 *   2. AudioContext.state === 'closed' — fatal, detiene watchdog
 *   3. Worklet SAB freshness — frozen audio thread (> STALE_MS sin cambios)
 */

import { workletManager } from './WorkletManager'

const CHECK_INTERVAL_MS = 2000   // Paso 7: 1000 → 2000ms
const WORKLET_STALE_MS  = 2000   // Paso 7: 500 → 2000ms
const WARN_COOLDOWN_MS  = 5000   // Paso 7: mínimo 5s entre warnings del mismo tipo

class DSPWatchdog {
  private _ctx:          AudioContext | null                    = null
  private _intervalId:   ReturnType<typeof setInterval> | null = null
  private _lastSABValue: number                                 = -200
  private _lastSABAt:    number                                 = 0
  private _warnCount:    number                                 = 0
  private _sabEverActive: boolean                               = false  // Paso 7: SAB tuvo señal real

  // Paso 7: cooldown por tipo de warning — evita spam en logs
  private _lastWarnAt = new Map<string, number>()

  private _onWarnCbs:     Array<(issue: string) => void>  = []
  private _onRecoveryCbs: Array<(reason: string) => void> = []

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  attach(ctx: AudioContext): void { this._ctx = ctx }

  start(): void {
    if (this._intervalId !== null) return
    this._intervalId = setInterval(() => this._check(), CHECK_INTERVAL_MS)
    console.log('[WATCHDOG] Iniciado')
  }

  stop(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
    this._ctx = null
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  onWarning(cb: (issue: string) => void): void  { this._onWarnCbs.push(cb) }
  onRecovery(cb: (reason: string) => void): void { this._onRecoveryCbs.push(cb) }

  // ── Health check ──────────────────────────────────────────────────────────

  private _check(): void {
    if (!this._ctx) return

    const state = this._ctx.state

    if (state === 'closed') {
      this._warn('ctx_closed', 'AudioContext cerrado — engine requiere reinicio completo')
      this.stop()
      return
    }

    if (state === 'suspended') {
      this._warn('ctx_suspended', 'AudioContext suspendido — intentando resume()')
      this._ctx.resume()
        .then(() => this._recover('AudioContext reanudado correctamente'))
        .catch(err => this._warn('ctx_resume_fail', `resume() falló: ${String(err)}`))
      return
    }

    // Worklet SAB freshness check
    if (workletManager.isReady()) {
      const sab = workletManager.getSAB()
      if (sab) {
        const current = sab[1]  // ch1 output peak
        const now     = performance.now()

        // Paso 7: detectar si SAB alguna vez tuvo señal real (> -100 dBFS)
        if (current > -100) this._sabEverActive = true

        if (this._lastSABAt > 0) {
          const elapsed = now - this._lastSABAt
          // Paso 7: warn solo si SAB estuvo activo Y lleva > STALE_MS sin cambios
          if (elapsed > WORKLET_STALE_MS && current === this._lastSABValue && this._sabEverActive) {
            this._warn('worklet_frozen',
              `Worklet posiblemente congelado — SAB sin cambios en ${elapsed.toFixed(0)}ms`)
          }
        }

        if (current !== this._lastSABValue) {
          this._lastSABValue = current
          this._lastSABAt    = now
        } else if (this._lastSABAt === 0) {
          this._lastSABAt = now
        }
      }
    }
  }

  // Paso 7: cooldown por tipo — sin spam de warnings repetidos
  private _warn(type: string, issue: string): void {
    const now  = performance.now()
    const last = this._lastWarnAt.get(type) ?? 0
    if (now - last < WARN_COOLDOWN_MS) return

    this._lastWarnAt.set(type, now)
    this._warnCount++
    console.warn(`[WATCHDOG] ${issue}`)
    for (const cb of this._onWarnCbs) { try { cb(issue) } catch (_) {} }
  }

  private _recover(reason: string): void {
    console.log(`[WATCHDOG] Recovery: ${reason}`)
    for (const cb of this._onRecoveryCbs) { try { cb(reason) } catch (_) {} }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getStatus() {
    return {
      contextState:   this._ctx?.state ?? 'none',
      workletAlive:   workletManager.isReady(),
      sabEverActive:  this._sabEverActive,
      warnCount:      this._warnCount,
      running:        this._intervalId !== null,
    }
  }
}

export const dspWatchdog = new DSPWatchdog()
export default dspWatchdog

// ── Console exposure ──────────────────────────────────────────────────────────
;(window as any).__ONA_WATCHDOG = {
  status: () => dspWatchdog.getStatus(),
}
