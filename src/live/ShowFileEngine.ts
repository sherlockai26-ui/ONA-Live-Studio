/**
 * ShowFileEngine.ts — Show file save/load with autosave and crash recovery.
 *
 * ShowFile schema:
 *   {
 *     version:     2,
 *     name:        string,
 *     venue:       string,
 *     date:        string (ISO),
 *     engineer:    string,
 *     scenes:      Scene[],
 *     cueList:     string[],
 *     dcaState:    DCASnapshot,
 *     safeList:    SafeChannelEntry[],
 *     muteGroups:  MuteGroup[],
 *     deviceMap:   Record<number, string>,   // channelId → deviceLabel
 *     notes:       string,
 *     createdAt:   number,
 *     savedAt:     number,
 *   }
 *
 * Persistence:
 *   - Electron IPC: 'show:save' / 'show:load' (filesystem, JSON)
 *   - Autosave: every 30s, keeps last 5 autosaves (localStorage key 'ona_autosave_*')
 *   - Recovery: on startup, if 'ona_crash_flag' is set → offer autosave restore
 *
 * In browser (no Electron): falls back to localStorage + Blob download.
 */

import { sceneManager }      from '../audio/state/SceneManager'
import { sceneEngine }       from './SceneEngine'
import { dcaEngine }         from './DCAEngine'
import { channelSafeSystem } from './ChannelSafeSystem'

const SHOW_VERSION   = 2
const LS_AUTOSAVE    = 'ona_autosave'
const LS_CRASH_FLAG  = 'ona_crash_flag'
const MAX_AUTOSAVES  = 5
const AUTOSAVE_MS    = 30_000

export interface ShowFileMeta {
  name:      string
  venue:     string
  date:      string
  engineer:  string
  notes:     string
}

export interface ShowFile {
  version:    number
  meta:       ShowFileMeta
  scenes:     any[]
  cueList:    string[]
  dcaState:   ReturnType<typeof dcaEngine.getSnapshot>
  safeList:   ReturnType<typeof channelSafeSystem.getState>
  deviceMap:  Record<number, string>
  createdAt:  number
  savedAt:    number
}

class ShowFileEngine {
  private _meta: ShowFileMeta = {
    name: 'Untitled Show', venue: '', date: new Date().toISOString().split('T')[0],
    engineer: '', notes: '',
  }
  private _deviceMap: Record<number, string> = {}
  private _autosaveId: ReturnType<typeof setInterval> | null = null
  private _createdAt = Date.now()

  // ── Metadata ──────────────────────────────────────────────────────────────

  setMeta(meta: Partial<ShowFileMeta>): void { Object.assign(this._meta, meta) }
  getMeta(): ShowFileMeta                    { return { ...this._meta } }
  setDeviceLabel(channelId: number, label: string): void { this._deviceMap[channelId] = label }

  // ── Serialize ─────────────────────────────────────────────────────────────

  buildShowFile(): ShowFile {
    const scenes: any[] = []
    const names = sceneEngine.listScenes()
    for (const name of names) {
      const scene = (sceneManager as any)._scenes?.get(name)
      if (scene) scenes.push(scene)
    }

    return {
      version:   SHOW_VERSION,
      meta:      { ...this._meta },
      scenes,
      cueList:   sceneEngine.getCueList(),
      dcaState:  dcaEngine.getSnapshot(),
      safeList:  channelSafeSystem.getState(),
      deviceMap: { ...this._deviceMap },
      createdAt: this._createdAt,
      savedAt:   Date.now(),
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async save(pathHint?: string): Promise<boolean> {
    const show = this.buildShowFile()
    const json = JSON.stringify(show, null, 2)

    // Electron path
    if (typeof window !== 'undefined' && (window as any).electronAPI?.showSave) {
      try {
        await (window as any).electronAPI.showSave(json, pathHint ?? `${show.meta.name}.ona`)
        console.log(`[ShowFile] Saved: "${show.meta.name}"`)
        return true
      } catch (e) {
        console.error('[ShowFile] Electron save failed:', e)
      }
    }

    // Browser fallback: download JSON blob
    const blob = new Blob([json], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `${show.meta.name}.ona`
    a.click()
    URL.revokeObjectURL(url)
    return true
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  async load(pathOrJson?: string): Promise<ShowFile | null> {
    let json: string | null = null

    if (typeof window !== 'undefined' && (window as any).electronAPI?.showLoad && !pathOrJson) {
      try {
        json = await (window as any).electronAPI.showLoad()
      } catch (e) {
        console.error('[ShowFile] Electron load failed:', e)
        return null
      }
    } else if (pathOrJson) {
      json = pathOrJson
    } else {
      // Browser fallback: file picker
      json = await this._filePicker()
    }

    if (!json) return null

    try {
      const show = JSON.parse(json) as ShowFile
      if (!show.version || show.version < 1) throw new Error('Invalid show file version')
      this._applyShowFile(show)
      console.log(`[ShowFile] Loaded: "${show.meta.name}" (v${show.version}, ${show.scenes.length} scenes)`)
      return show
    } catch (e) {
      console.error('[ShowFile] Parse error:', e)
      return null
    }
  }

  private _applyShowFile(show: ShowFile): void {
    // Meta
    Object.assign(this._meta, show.meta)
    this._deviceMap = { ...show.deviceMap }
    this._createdAt = show.createdAt

    // Restore scenes into SceneManager
    const scenes = (sceneManager as any)._scenes
    if (scenes && show.scenes) {
      for (const s of show.scenes) {
        scenes.set(s.name, s)
      }
      ;(sceneManager as any)._saveToStorage?.()
    }

    // Restore cue list
    sceneEngine.setCueList(show.cueList ?? [])

    // Restore DCA + safe system
    if (show.dcaState) dcaEngine.loadSnapshot(show.dcaState)
    if (show.safeList?.safeChannels) {
      channelSafeSystem.clear()
      for (const entry of show.safeList.safeChannels) {
        channelSafeSystem.addSafe(entry.channelId, entry.mode, entry.label, entry.addedBy)
      }
    }
  }

  // ── Autosave ──────────────────────────────────────────────────────────────

  startAutosave(intervalMs = AUTOSAVE_MS): void {
    if (this._autosaveId !== null) return
    // Mark running — if crash occurs, flag will be found on next startup
    localStorage.setItem(LS_CRASH_FLAG, '1')

    this._autosaveId = setInterval(() => this._doAutosave(), intervalMs)
  }

  private _doAutosave(): void {
    try {
      const show = this.buildShowFile()
      const json = JSON.stringify(show)

      // Primary: persist to disk via Electron IPC (saves to scenes directory as __autosave__)
      const ipc = typeof window !== 'undefined' && (window as any).electronAPI
      if (ipc?.saveScene) {
        ;(ipc.saveScene('__autosave__', json) as Promise<void>).catch(() => {
          // IPC failed — localStorage backup below is sufficient
        })
      }

      // Secondary (backup): write to localStorage ring buffer (up to MAX_AUTOSAVES slots)
      const slot = `${LS_AUTOSAVE}_${Date.now()}`
      localStorage.setItem(slot, json)
      const keys = Object.keys(localStorage)
        .filter(k => k.startsWith(LS_AUTOSAVE + '_'))
        .sort()
      while (keys.length > MAX_AUTOSAVES) {
        localStorage.removeItem(keys.shift()!)
      }

      console.log('[ShowFile] Autosave written')
    } catch (e) {
      console.error('[ShowFile] Autosave failed:', e)
    }
  }

  stopAutosave(): void {
    if (this._autosaveId !== null) { clearInterval(this._autosaveId); this._autosaveId = null }
    localStorage.removeItem(LS_CRASH_FLAG)
  }

  /** Call on app startup — returns latest autosave if crash was detected */
  checkCrashRecovery(): ShowFile | null {
    if (!localStorage.getItem(LS_CRASH_FLAG)) return null

    const keys = Object.keys(localStorage)
      .filter(k => k.startsWith(LS_AUTOSAVE))
      .sort()
      .reverse()

    const latest = keys[0] ? localStorage.getItem(keys[0]) : null
    if (!latest) return null

    try {
      const show = JSON.parse(latest) as ShowFile
      console.warn(`[ShowFile] Crash recovery available: "${show.meta.name}" (saved ${new Date(show.savedAt).toLocaleTimeString()})`)
      return show
    } catch (_) {
      return null
    }
  }

  clearCrashFlag(): void { localStorage.removeItem(LS_CRASH_FLAG) }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _filePicker(): Promise<string | null> {
    return new Promise(resolve => {
      const input = document.createElement('input')
      input.type   = 'file'
      input.accept = '.ona,.json'
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) { resolve(null); return }
        const reader = new FileReader()
        reader.onload = e => resolve(e.target?.result as string ?? null)
        reader.onerror = () => resolve(null)
        reader.readAsText(file)
      }
      input.click()
    })
  }
}

export const showFileEngine = new ShowFileEngine()
