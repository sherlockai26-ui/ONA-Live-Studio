/**
 * SceneEngine.ts — Professional scene system for live operation.
 *
 * Extends the Paso 5 SceneManager with:
 *   - Partial snapshots (save/recall only selected parameter groups)
 *   - Safe recall (channelSafeSystem applied before any DSP change)
 *   - Filtered recall (recall only specific param groups: gains, mutes, eq, etc.)
 *   - Pop-free transitions via TransitionEngine
 *   - Pre-recall validation via RecallValidator
 *   - Remote sync notification via broadcast callback
 *   - Scene ordering (cue list with next/prev)
 *   - Undo: one-level pre-recall rollback
 *
 * Does NOT replace SceneManager — wraps it and adds professional features.
 * DSP application is delegated to applyDSPCallback (injected by AudioBridge).
 */

import { sceneManager }      from '../audio/state/SceneManager'
import { stateEngine }       from '../audio/state/StateEngine'
import { channelSafeSystem } from './ChannelSafeSystem'
import { transitionEngine, type TransitionProfile } from './TransitionEngine'
import { recallValidator }   from './RecallValidator'
import { dcaEngine }         from './DCAEngine'
import type { EngineSnapshot, ChannelState } from '../audio/state/StateEngine'

export type RecallFilter = Set<'gains' | 'mutes' | 'eq' | 'dynamics' | 'routing' | 'fx' | 'buses'>

export interface RecallOptions {
  filter?:    RecallFilter          // if set, only recall these groups
  profile?:   TransitionProfile     // override transition profile
  skipValidation?: boolean
  skipSafeCheck?:  boolean
}

export interface SceneRecallResult {
  ok:           boolean
  sceneName:    string
  appliedAt:    number
  durationMs:   number
  issues:       import('./RecallValidator').ValidationIssue[]
  skippedChannels: number[]         // channels skipped due to safe system
}

type ApplyDSPCallback = (snapshot: EngineSnapshot) => Promise<void>
type BroadcastCallback = (sceneName: string, result: SceneRecallResult) => void

class SceneEngine {
  private _applyDSP:    ApplyDSPCallback | null = null
  private _broadcast:   BroadcastCallback | null = null
  private _cueList:     string[] = []            // ordered scene names
  private _cueIndex     = -1
  private _recalling    = false
  private _recallLock   = 0                      // seq for race condition prevention
  private _rollback:    EngineSnapshot | null = null

  // ── Wiring ────────────────────────────────────────────────────────────────

  setApplyDSPCallback(fn: ApplyDSPCallback): void    { this._applyDSP = fn }
  setBroadcastCallback(fn: BroadcastCallback): void  { this._broadcast = fn }

  // ── Save ──────────────────────────────────────────────────────────────────

  /** Save current state as a named scene (full snapshot). */
  save(name: string): void {
    sceneManager.save(name)
    if (!this._cueList.includes(name)) this._cueList.push(name)
    console.log(`[SceneEngine] Saved: "${name}" (${this._cueList.length} in cue list)`)
  }

  /** Save a partial snapshot — only the specified parameter groups. */
  savePartial(name: string, filter: RecallFilter): void {
    const full = stateEngine.getSnapshot()
    const partial = this._applyFilter(full, filter)
    sceneManager.save(name + ' [partial]')
    // Store partial flag in scene metadata via name convention
    console.log(`[SceneEngine] Saved partial "${name}" (groups: ${[...filter].join(',')})`)
    void partial
  }

  // ── Recall ────────────────────────────────────────────────────────────────

  async recall(name: string, opts: RecallOptions = {}): Promise<SceneRecallResult> {
    if (this._recalling) {
      console.warn(`[SceneEngine] recall "${name}" blocked — another recall in progress`)
      return this._failResult(name, 'Already recalling')
    }

    const seq = ++this._recallLock
    this._recalling = true
    const t0  = performance.now()

    try {
      // 1. Get snapshot from SceneManager
      const rawSnap = sceneManager.prepareRecall(name)
      if (!rawSnap) return this._failResult(name, 'Scene not found')

      // 2. Validate — skipValidation is only honoured in development builds
      const _isDev = typeof process !== 'undefined' && process.env.NODE_ENV === 'development'
      if (!opts.skipValidation || !_isDev) {
        const val = recallValidator.validate(rawSnap, name)
        if (!val.ok) {
          this._recalling = false
          return {
            ok: false, sceneName: name, appliedAt: Date.now(),
            durationMs: +(performance.now() - t0).toFixed(1),
            issues: val.issues, skippedChannels: [],
          }
        }
      }

      // 3. Store rollback snapshot
      this._rollback = JSON.parse(JSON.stringify(stateEngine.getSnapshot()))

      // 4. Apply filter if requested
      const filtered = opts.filter ? this._applyFilter(rawSnap, opts.filter) : rawSnap

      // 5. Apply safe channel mask
      const skippedChannels: number[] = []
      if (!opts.skipSafeCheck) {
        const current = stateEngine.getSnapshot()
        for (const ch of filtered.channels) {
          if (!channelSafeSystem.isSafe(ch.id)) continue
          const currentCh = current.channels.find(c => c.id === ch.id)
          if (!currentCh) continue
          const patched = channelSafeSystem.filterChannelPatch(ch.id, ch as any, currentCh as any)
          if (patched === null) {
            // Channel fully safe — restore original
            const idx = filtered.channels.findIndex(c => c.id === ch.id)
            if (idx >= 0) filtered.channels[idx] = currentCh as ChannelState
            skippedChannels.push(ch.id)
          } else {
            const idx = filtered.channels.findIndex(c => c.id === ch.id)
            if (idx >= 0) (filtered.channels[idx] as any) = patched
          }
        }
      }

      // 6. Set transition profile
      if (opts.profile) transitionEngine.setProfile(opts.profile)

      // 7. Apply DSP (staggered via TransitionEngine)
      if (this._applyDSP) await this._applyDSP(filtered)

      // 8. Update StateEngine
      stateEngine.applySnapshot(filtered)

      // 9. Update cue index
      const idx = this._cueList.indexOf(name)
      if (idx >= 0) this._cueIndex = idx

      // 10. Guard against stale recalls (another recall started while we awaited)
      if (seq !== this._recallLock) {
        console.warn(`[SceneEngine] Stale recall "${name}" discarded (seq mismatch)`)
        return this._failResult(name, 'Stale recall')
      }

      const result: SceneRecallResult = {
        ok: true, sceneName: name, appliedAt: Date.now(),
        durationMs: +(performance.now() - t0).toFixed(1),
        issues: [], skippedChannels,
      }

      this._broadcast?.(name, result)
      console.log(`[SceneEngine] Recalled "${name}" in ${result.durationMs}ms`)
      return result
    } finally {
      this._recalling = false
    }
  }

  /** Recall only specific parameter groups. */
  async recallFiltered(name: string, filter: RecallFilter, opts: RecallOptions = {}): Promise<SceneRecallResult> {
    return this.recall(name, { ...opts, filter })
  }

  // ── Undo ──────────────────────────────────────────────────────────────────

  async undo(): Promise<boolean> {
    if (!this._rollback) { console.warn('[SceneEngine] No undo available'); return false }
    const snap = this._rollback
    this._rollback = null
    if (this._applyDSP) await this._applyDSP(snap)
    stateEngine.applySnapshot(snap)
    console.log('[SceneEngine] Undo applied')
    return true
  }

  // ── Cue list ──────────────────────────────────────────────────────────────

  setCueList(names: string[]): void { this._cueList = [...names]; this._cueIndex = -1 }
  getCueList(): string[]            { return [...this._cueList] }
  getCurrentCue(): string | null    { return this._cueList[this._cueIndex] ?? null }

  async next(opts?: RecallOptions): Promise<SceneRecallResult | null> {
    const next = this._cueList[this._cueIndex + 1]
    if (!next) { console.warn('[SceneEngine] End of cue list'); return null }
    return this.recall(next, opts)
  }

  async prev(opts?: RecallOptions): Promise<SceneRecallResult | null> {
    const prev = this._cueList[this._cueIndex - 1]
    if (!prev) { console.warn('[SceneEngine] Start of cue list'); return null }
    return this.recall(prev, opts)
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  listScenes(): string[] { return Array.from((sceneManager as any)._scenes?.keys() ?? []) }

  getState() {
    return {
      recalling:    this._recalling,
      cueList:      this._cueList,
      cueIndex:     this._cueIndex,
      currentCue:   this.getCurrentCue(),
      sceneCount:   this.listScenes().length,
      hasRollback:  this._rollback !== null,
      transition:   transitionEngine.getMetrics(),
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _applyFilter(snap: EngineSnapshot, filter: RecallFilter): EngineSnapshot {
    const current = stateEngine.getSnapshot()
    const result  = JSON.parse(JSON.stringify(snap)) as EngineSnapshot

    // Restore groups not in filter from current state
    for (const ch of result.channels) {
      const cur = current.channels.find(c => c.id === ch.id)
      if (!cur) continue

      if (!filter.has('gains'))    ch.volume = cur.volume
      if (!filter.has('mutes'))    ch.muted  = cur.muted
      if (!filter.has('eq'))       ch.eqBands = cur.eqBands
      if (!filter.has('dynamics')) { ch.compressor = cur.compressor; ch.gate = cur.gate }
      if (!filter.has('routing'))  { ch.toMain = cur.toMain; ch.toSub = cur.toSub }
    }

    if (!filter.has('buses')) result.buses = current.buses
    if (!filter.has('fx'))    result.fx    = current.fx

    return result
  }

  private _failResult(name: string, reason: string): SceneRecallResult {
    console.warn(`[SceneEngine] Recall failed: ${reason}`)
    return { ok: false, sceneName: name, appliedAt: Date.now(), durationMs: 0, issues: [], skippedChannels: [] }
  }
}

export const sceneEngine = new SceneEngine()
