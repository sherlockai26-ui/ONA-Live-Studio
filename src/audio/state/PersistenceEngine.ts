/**
 * PersistenceEngine.ts — Autosave, crash recovery, and project persistence.
 *
 * Storage keys:
 *   'ona_autosave'  — rolling autosave entry for crash recovery
 *   'ona_projects'  — named project saves (max 10, oldest evicted)
 *
 * Autosave: setInterval-based (default 30s). Writes StateEngine.getSnapshot()
 * to localStorage on each tick.
 *
 * Crash recovery:
 *   - On startup: call hasLastSession() / getLastSession()
 *   - If stale session exists, offer user to restore
 *   - clearLastSession() after successful restore or discard
 *
 * Future: extend saveProject() to call window.electronAPI.saveSession()
 * for full file-system persistence in Electron (IPC to main.cjs fs.writeFile).
 *
 * Exposed via window.__ONA_STATE.persist
 */

import { stateEngine } from './StateEngine'
import type { EngineSnapshot } from './StateEngine'

const LS_AUTOSAVE  = 'ona_autosave'
const LS_PROJECTS  = 'ona_projects'
const MAX_PROJECTS = 10

class PersistenceEngine {
  private _intervalId: ReturnType<typeof setInterval> | null = null
  private _lastSaveAt = 0

  // ── Autosave ──────────────────────────────────────────────────────────────

  startAutosave(intervalMs = 30_000): void {
    if (this._intervalId !== null) return
    this._intervalId = setInterval(() => this._doAutosave(), intervalMs)
    console.log(`[PERSIST] Autosave activo — cada ${intervalMs / 1000}s`)
  }

  stopAutosave(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
  }

  /** flushAutosave — force immediate write (call before app close). */
  flushAutosave(): void { this._doAutosave() }

  private _doAutosave(): void {
    try {
      const entry = { ...stateEngine.getSnapshot(), _savedAt: Date.now() }
      localStorage.setItem(LS_AUTOSAVE, JSON.stringify(entry))
      this._lastSaveAt = Date.now()
    } catch (err) {
      console.warn('[PERSIST] Autosave falló:', err)
    }
  }

  getLastSaveAge(): number {
    return this._lastSaveAt > 0 ? Date.now() - this._lastSaveAt : -1
  }

  // ── Crash recovery ────────────────────────────────────────────────────────

  hasLastSession(): boolean {
    return localStorage.getItem(LS_AUTOSAVE) !== null
  }

  getLastSession(): EngineSnapshot | null {
    try {
      const json = localStorage.getItem(LS_AUTOSAVE)
      return json ? JSON.parse(json) as EngineSnapshot : null
    } catch { return null }
  }

  clearLastSession(): void {
    localStorage.removeItem(LS_AUTOSAVE)
  }

  // ── Project persistence ───────────────────────────────────────────────────

  saveProject(name: string): boolean {
    try {
      const all = this._getProjects()
      all[name] = { ...stateEngine.getSnapshot(), _savedAt: Date.now() }

      const keys = Object.keys(all)
      if (keys.length > MAX_PROJECTS) {
        const oldest = keys.sort((a, b) => (all[a]._savedAt ?? 0) - (all[b]._savedAt ?? 0))[0]
        delete all[oldest]
      }

      localStorage.setItem(LS_PROJECTS, JSON.stringify(all))
      console.log(`[PERSIST] Proyecto guardado: "${name}"`)
      return true
    } catch (err) {
      console.warn('[PERSIST] saveProject falló:', err)
      return false
    }
  }

  loadProject(name: string): EngineSnapshot | null {
    try {
      const all = this._getProjects()
      return all[name] ?? null
    } catch { return null }
  }

  listProjects(): Array<{ name: string; savedAt: number }> {
    const all = this._getProjects()
    return Object.entries(all)
      .map(([name, v]: [string, any]) => ({ name, savedAt: v._savedAt ?? 0 }))
      .sort((a, b) => b.savedAt - a.savedAt)
  }

  deleteProject(name: string): boolean {
    const all = this._getProjects()
    if (!all[name]) return false
    delete all[name]
    try { localStorage.setItem(LS_PROJECTS, JSON.stringify(all)) } catch (_) {}
    return true
  }

  private _getProjects(): Record<string, any> {
    try {
      const json = localStorage.getItem(LS_PROJECTS)
      return json ? JSON.parse(json) : {}
    } catch { return {} }
  }
}

export const persistenceEngine = new PersistenceEngine()
export default persistenceEngine

// ── Console exposure ──────────────────────────────────────────────────────────
;(window as any).__ONA_STATE = {
  ...(window as any).__ONA_STATE,
  persist: {
    projects:    () => persistenceEngine.listProjects(),
    save:        (name: string) => persistenceEngine.saveProject(name),
    load:        (name: string) => persistenceEngine.loadProject(name),
    lastSession: () => persistenceEngine.getLastSession(),
    lastSaveAge: () => {
      const ms = persistenceEngine.getLastSaveAge()
      return ms < 0 ? 'nunca' : `${(ms / 1000).toFixed(0)}s atrás`
    },
  },
}
