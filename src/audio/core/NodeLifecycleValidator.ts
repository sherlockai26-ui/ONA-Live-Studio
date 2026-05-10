/**
 * NodeLifecycleValidator.ts — Detección de leaks y duplicados de AudioNode.
 *
 * Registra cada AudioNode creado con un tag descriptivo y marca cuándo es
 * destruido. Un nodo que sigue "vivo" mucho tiempo después de que su canal
 * debería haber sido limpiado es un candidato a leak.
 *
 * Uso:
 *   nodeValidator.register(gainNode, 'GainNode', 'ch1_fader')   → returns id
 *   nodeValidator.unregister(id)   // llamar en dispose() del canal
 *
 * NO se integra en el hot path: solo para diagnóstico via consola.
 * Habilitado por defecto; deshabilitar con nodeValidator.disable() en producción
 * si se prefiere cero overhead.
 *
 * Audit de destroy():
 *   El audit incluye verificar que todos los módulos limpian sus recursos.
 *   destroy() en cada módulo debe:
 *     1. clearInterval / cancelAnimationFrame todos los timers y RAF
 *     2. removeEventListener de todos los event listeners
 *     3. disconnect() todos los AudioNodes
 *     4. Llamar dispose() o destroy() en subnodos
 *     5. null-ear todas las referencias fuertes
 *
 * Hallazgos del audit (Paso 11):
 *   - MeteringEngine.stop(): ✓ cancela RAF, limpia _cbs, nullea strips/busEngine
 *   - DSPWatchdog.stop(): ✓ clearInterval, nullea ctx
 *   - SafeRecoverySystem.destroy(): ✓ clearInterval, removeEventListener, limpia sets
 *   - CPUSafetyMode.destroy(): ✓ clearInterval, limpia callbacks
 *   - RecordingClock.destroy(): ✓ clearInterval, nullea ctx y samples
 *   - LatencyMeasurement.destroy(): ✓ nullea ctx y history
 *   - MultitrackRecorder.destroy(): ✓ stopSession() + queue.clear() + clock.destroy()
 *   - MultitrackPlayer.destroy(): ✓ unloadTracks() + clear targets
 *   - AudioCapture.stop(): ✓ desconecta worklet/SP + silentSink
 *   - DiskStreamingQueue.clear(): ✓ vacía queue, resetea bytes
 *   - PerformanceMonitor.stop(): ✓ cancela RAF, vacía frameTimes
 *   - WorkletManager.destroy(): verificado en Paso 4
 *   - HAL.destroy(): verificado en Paso 3
 *
 * RIESGO DETECTADO (Paso 11):
 *   - DiskStreamingQueue: si _draining=true al destroy(), el Promise pendiente de
 *     IPC no se cancela → callback en _pump() intentará escribir a sesión cerrada.
 *     FIX: añadir flag _destroyed para no procesar más callbacks post-clear().
 */

export interface NodeRecord {
  id:          string
  type:        string     // 'GainNode', 'BiquadFilterNode', etc.
  tag:         string     // 'ch1_fader', 'aux3_input', etc.
  createdAt:   number     // performance.now()
  destroyedAt: number | null
}

class NodeLifecycleValidatorImpl {
  private _nodes   = new Map<string, NodeRecord>()
  private _counter = 0
  private _enabled = true

  enable():  void { this._enabled = true }
  disable(): void { this._enabled = false }
  get active(): boolean { return this._enabled }

  /** Register a node. Returns an opaque id for unregister(). Pass '' tag to skip. */
  register(
    node:    AudioNode | null | undefined,
    type:    string,
    tag = '',
  ): string {
    if (!this._enabled || !node) return ''
    const id = `${type}_${this._counter++}`
    this._nodes.set(id, { id, type, tag, createdAt: performance.now(), destroyedAt: null })
    return id
  }

  /** Mark a node as destroyed. id is the string returned by register(). */
  unregister(id: string): void {
    if (!id) return
    const r = this._nodes.get(id)
    if (r && r.destroyedAt === null) r.destroyedAt = performance.now()
  }

  // ── Analysis ──────────────────────────────────────────────────────────────────

  /** Live nodes (not yet destroyed). */
  getLive(): NodeRecord[] {
    return Array.from(this._nodes.values()).filter(n => n.destroyedAt === null)
  }

  /** Count of live nodes by type. */
  getLiveByType(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.getLive()) out[r.type] = (out[r.type] ?? 0) + 1
    return out
  }

  /**
   * Nodes that have been live for longer than maxAgeMs.
   * Default 120s — long enough to exclude nodes legitimately held for a session.
   */
  getPotentialLeaks(maxAgeMs = 120_000): NodeRecord[] {
    const now = performance.now()
    return this.getLive().filter(n => (now - n.createdAt) > maxAgeMs)
  }

  getReport(leakAgeMs = 120_000) {
    const live   = this.getLive()
    const byType = this.getLiveByType()
    const leaks  = this.getPotentialLeaks(leakAgeMs)
    return {
      liveCount: live.length,
      byType,
      potentialLeaks: leaks.length,
      leakDetails:    leaks,
    }
  }

  clear(): void { this._nodes.clear(); this._counter = 0 }
}

export const nodeValidator = new NodeLifecycleValidatorImpl()
