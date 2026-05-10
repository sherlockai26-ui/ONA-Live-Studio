/**
 * RemoteSyncBridge.ts — Sync scene recalls and DCA changes to remote clients.
 *
 * Bridges SceneEngine → NetworkServer (Paso 16) without creating circular deps.
 * Uses an injected broadcaster function so this module has no direct import
 * of NetworkServer (which is Node.js-only).
 *
 * Race condition prevention:
 *   - Scene recalls are seq-tagged. Remotes ignore stale seq.
 *   - Only one recall active at a time (enforced by SceneEngine._recalling flag).
 *   - DCA changes are rate-limited to 60Hz (last-write-wins within 16ms).
 *
 * Remote → host path:
 *   Remote sends 'recall_scene' command via /ctrl namespace.
 *   RemoteSyncBridge receives it, validates, calls sceneEngine.recall().
 *   Result is broadcast back to all remotes.
 *
 * Host → remote path:
 *   SceneEngine calls setBroadcastCallback(fn) → this bridge's onRecallDone().
 *   Bridge emits 'scene_recalled' event to all /ctrl clients.
 */

import { sceneEngine, type SceneRecallResult } from './SceneEngine'
import { dcaEngine }                           from './DCAEngine'

type BroadcastFn = (type: string, channelId: number | null, payload: any) => void

class RemoteSyncBridge {
  private _broadcast:   BroadcastFn | null = null
  private _seq          = 0
  private _dcaThrottle: ReturnType<typeof setTimeout> | null = null
  private _pendingDCA:  any = null

  // ── Wiring ────────────────────────────────────────────────────────────────

  /**
   * Inject the NetworkServer broadcast function.
   * In Electron main: pass injectHostCommand from NetworkServer.js.
   * In dev/browser: can be a no-op.
   */
  attach(broadcastFn: BroadcastFn): void {
    this._broadcast = broadcastFn

    // Wire SceneEngine to broadcast recall results to remotes
    sceneEngine.setBroadcastCallback((name, result) => {
      this._onRecallDone(name, result)
    })

    // Wire DCA changes
    dcaEngine.onDCAChange((dcaId, group) => {
      this._onDCAChange(dcaId, group)
    })

    dcaEngine.onMuteChange((groupId, channelIds, muted) => {
      this._broadcast?.('MUTE_GROUP_CHANGE', null, { groupId, channelIds, muted, seq: ++this._seq })
    })

    console.log('[RemoteSyncBridge] attached')
  }

  // ── Host → Remote ─────────────────────────────────────────────────────────

  private _onRecallDone(name: string, result: SceneRecallResult): void {
    if (!this._broadcast) return
    this._broadcast('SCENE_RECALLED', null, {
      seq:             ++this._seq,
      sceneName:       name,
      ok:              result.ok,
      durationMs:      result.durationMs,
      skippedChannels: result.skippedChannels,
      ts:              Date.now(),
    })
  }

  private _onDCAChange(dcaId: number, group: any): void {
    this._pendingDCA = { dcaId, group, seq: ++this._seq }
    if (this._dcaThrottle !== null) return
    this._dcaThrottle = setTimeout(() => {
      if (this._pendingDCA && this._broadcast) {
        this._broadcast('DCA_CHANGE', null, this._pendingDCA)
      }
      this._pendingDCA   = null
      this._dcaThrottle  = null
    }, 16)
  }

  // ── Remote → Host ─────────────────────────────────────────────────────────

  /**
   * Call this from NetworkServer's command handler when a remote sends
   * a RECALL_SCENE command.
   */
  async handleRemoteRecall(payload: {
    sceneName:  string
    profile?:   string
    filter?:    string[]
    seq:        number
  }): Promise<void> {
    const { sceneName, seq } = payload

    // Ignore if seq is older than what we've processed
    if (seq <= this._seq - 5) {
      console.warn(`[RemoteSyncBridge] Stale remote recall seq=${seq}, current=${this._seq}`)
      return
    }

    console.log(`[RemoteSyncBridge] Remote recall: "${sceneName}" (seq=${seq})`)
    await sceneEngine.recall(sceneName, {
      profile: (payload.profile as any) ?? undefined,
    })
  }

  handleRemoteDCAChange(payload: { dcaId: number; level?: number; muted?: boolean }): void {
    const { dcaId, level, muted } = payload
    if (level !== undefined) dcaEngine.setDCALevel(dcaId, level)
    if (muted !== undefined) dcaEngine.setDCAMute(dcaId, muted)
  }

  handleRemoteMuteGroup(payload: { groupId: number; active: boolean }): void {
    if (payload.active) dcaEngine.activateMuteGroup(payload.groupId)
    else                dcaEngine.deactivateMuteGroup(payload.groupId)
  }

  // ── Scene list sync ───────────────────────────────────────────────────────

  /** Called when a new remote connects — sends full scene list */
  syncSceneList(): void {
    if (!this._broadcast) return
    const scenes  = sceneEngine.listScenes()
    const cueList = sceneEngine.getCueList()
    this._broadcast('SCENE_LIST_SYNC', null, { scenes, cueList, seq: ++this._seq, ts: Date.now() })
  }

  getMetrics() {
    return {
      seq:             this._seq,
      hasBroadcast:    this._broadcast !== null,
      pendingDCA:      this._pendingDCA !== null,
    }
  }
}

export const remoteSyncBridge = new RemoteSyncBridge()
