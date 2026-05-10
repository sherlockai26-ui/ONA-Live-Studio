/**
 * SceneManager.ts — Named scene management for ONA Live Studio.
 *
 * Scenes: named, versioned snapshots of full DSP state (EngineSnapshot).
 *
 * Safe recall contract:
 *   - NEVER recreates AudioNodes
 *   - NEVER destroys worklets or buffers
 *   - DSP application done via DSPParameterManager (ChannelStrip setters only)
 *   - SceneManager only manages state; AudioEngineSingleton applies DSP changes
 *
 * Persistence: localStorage key 'ona_scenes' (max 32 scenes).
 * Rollback: one-level undo — stores pre-recall snapshot in memory.
 *
 * Exposed via window.__ONA_STATE.scenes
 */

import { stateEngine } from './StateEngine'
import type { EngineSnapshot } from './StateEngine'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Scene {
  id:        string
  name:      string
  timestamp: number
  snapshot:  EngineSnapshot
}

const LS_KEY     = 'ona_scenes'
const MAX_SCENES = 32

// ─── SceneManager ─────────────────────────────────────────────────────────────

class SceneManager {
  private _scenes:       Map<string, Scene>    = new Map()
  private _prevSnapshot: EngineSnapshot | null = null

  constructor() { this._loadFromStorage() }

  // ── Save ──────────────────────────────────────────────────────────────────

  /** save — capture current StateEngine snapshot under a given name. */
  save(name: string): Scene {
    const trimmed  = name.trim() || 'Escena'
    const snapshot = JSON.parse(JSON.stringify(stateEngine.getSnapshot())) as EngineSnapshot
    const scene: Scene = {
      id:        `scene_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name:      trimmed,
      timestamp: Date.now(),
      snapshot,
    }
    this._scenes.set(trimmed, scene)

    // Evict oldest if at capacity
    if (this._scenes.size > MAX_SCENES) {
      const oldest = Array.from(this._scenes.values())
        .sort((a, b) => a.timestamp - b.timestamp)[0]
      this._scenes.delete(oldest.name)
    }

    this._saveToStorage()
    console.log(`[SCENE] Guardada: "${trimmed}"`)
    return scene
  }

  // ── Recall ────────────────────────────────────────────────────────────────

  /**
   * prepareRecall — stores rollback snapshot, returns scene data for DSP apply.
   * AudioEngineSingleton must:
   *   1. Call prepareRecall(name) → get snapshot
   *   2. Call dspParamMgr.applySceneState(strips, snapshot)
   *   3. Call stateEngine.applySnapshot(snapshot)
   * This separation avoids circular dependency SceneManager → AudioEngineSingleton.
   */
  prepareRecall(name: string): EngineSnapshot | null {
    const scene = this._scenes.get(name)
    if (!scene) {
      console.warn(`[SCENE] No encontrada: "${name}"`)
      return null
    }
    this._prevSnapshot = JSON.parse(JSON.stringify(stateEngine.getSnapshot()))
    console.log(`[SCENE] Recall: "${name}"`)
    return JSON.parse(JSON.stringify(scene.snapshot)) as EngineSnapshot
  }

  // ── Rollback ──────────────────────────────────────────────────────────────

  /** getRollbackSnapshot — returns pre-recall snapshot for one-step undo. */
  getRollbackSnapshot(): EngineSnapshot | null {
    return this._prevSnapshot
      ? JSON.parse(JSON.stringify(this._prevSnapshot))
      : null
  }

  clearRollback(): void { this._prevSnapshot = null }

  // ── Introspection ─────────────────────────────────────────────────────────

  getScene(name: string): Scene | null {
    return this._scenes.get(name) ?? null
  }

  list(): Array<Pick<Scene, 'id' | 'name' | 'timestamp'>> {
    return Array.from(this._scenes.values())
      .map(({ id, name, timestamp }) => ({ id, name, timestamp }))
      .sort((a, b) => b.timestamp - a.timestamp)
  }

  delete(name: string): boolean {
    const deleted = this._scenes.delete(name)
    if (deleted) { this._saveToStorage(); console.log(`[SCENE] Eliminada: "${name}"`) }
    return deleted
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  private _loadFromStorage(): void {
    try {
      const json = localStorage.getItem(LS_KEY)
      if (!json) return
      const scenes = JSON.parse(json) as Scene[]
      for (const s of scenes) this._scenes.set(s.name, s)
      console.log(`[SCENE] ${this._scenes.size} escenas cargadas`)
    } catch (_) {}
  }

  private _saveToStorage(): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(Array.from(this._scenes.values())))
    } catch (err) {
      console.warn('[SCENE] Error al guardar escenas:', err)
    }
  }
}

export const sceneManager = new SceneManager()
export default sceneManager

// ── Console exposure ──────────────────────────────────────────────────────────
;(window as any).__ONA_STATE = {
  ...(window as any).__ONA_STATE,
  scenes: {
    list:   ()              => sceneManager.list(),
    save:   (name: string)  => sceneManager.save(name),
    delete: (name: string)  => sceneManager.delete(name),
    get:    (name: string)  => sceneManager.getScene(name),
  },
}
