/**
 * DCAEngine.ts — 8-group DCA (Digitally Controlled Attenuator) system.
 *
 * DCA = relative gain offset + mute applied on top of channel fader.
 * NO duplicate audio routing — the DCA offset is applied mathematically
 * at mix time by AudioBridge.setChannelVolume (adds dcaOffset before setting gain).
 *
 * Architecture:
 *   DCAGroup: { id, name, members: Set<channelId>, level (0–100), muted, spill }
 *   Channel can be member of multiple DCAs — offsets are summed.
 *   Spill mode: UI expands DCA to show constituent channels inline.
 *
 * Mute groups (8 groups): separate from DCA level control.
 *   MuteGroup: channels muted as a unit. Safe channels are immune.
 *   Emergency mute: mutes all groups instantly (non-safe channels only).
 */

import { channelSafeSystem } from './ChannelSafeSystem'

export interface DCAGroup {
  id:      number          // 1–8
  name:    string
  members: number[]        // channelIds
  level:   number          // 0–100, 80 = unity (0dB offset)
  muted:   boolean
  spill:   boolean         // UI hint: show constituent channels
}

export interface MuteGroup {
  id:      number          // 1–8
  name:    string
  members: number[]        // channelIds
  active:  boolean
}

type DCAChangeCallback = (dcaId: number, group: DCAGroup) => void
type MuteChangeCallback = (groupId: number, channelIds: number[], muted: boolean) => void

class DCAEngine {
  private _dcas:  Map<number, DCAGroup>  = new Map()
  private _mutes: Map<number, MuteGroup> = new Map()

  private _dcaCbs:  Set<DCAChangeCallback>  = new Set()
  private _muteCbs: Set<MuteChangeCallback> = new Set()

  constructor() {
    for (let i = 1; i <= 8; i++) {
      this._dcas.set(i, { id: i, name: `DCA ${i}`, members: [], level: 80, muted: false, spill: false })
      this._mutes.set(i, { id: i, name: `Mute ${i}`, members: [], active: false })
    }
  }

  // ── DCA API ───────────────────────────────────────────────────────────────

  setDCAName(id: number, name: string): void {
    const g = this._getDCA(id)
    g.name = name
    this._emitDCA(id)
  }

  assignChannel(dcaId: number, channelId: number): void {
    const g = this._getDCA(dcaId)
    if (!g.members.includes(channelId)) {
      g.members.push(channelId)
      this._emitDCA(dcaId)
    }
  }

  unassignChannel(dcaId: number, channelId: number): void {
    const g = this._getDCA(dcaId)
    g.members = g.members.filter(c => c !== channelId)
    this._emitDCA(dcaId)
  }

  setDCALevel(dcaId: number, level: number): void {
    const g = this._getDCA(dcaId)
    g.level = Math.max(0, Math.min(100, level))
    this._emitDCA(dcaId)
  }

  setDCAMute(dcaId: number, muted: boolean): void {
    const g = this._getDCA(dcaId)
    g.muted = muted
    this._emitDCA(dcaId)
  }

  setSpill(dcaId: number, spill: boolean): void {
    const g = this._getDCA(dcaId)
    g.spill = spill
    this._emitDCA(dcaId)
  }

  getDCA(id: number): DCAGroup | null { return this._dcas.get(id) ?? null }

  getAllDCAs(): DCAGroup[] { return Array.from(this._dcas.values()) }

  /**
   * Compute the effective channel level considering all DCA memberships.
   * Returns the DCA-adjusted volume (0–100) given base channel volume.
   * Muted DCA → returns 0.
   */
  getEffectiveLevel(channelId: number, baseLevel: number): number {
    let level = baseLevel
    let anyMuted = false

    for (const g of this._dcas.values()) {
      if (!g.members.includes(channelId)) continue
      if (g.muted) { anyMuted = true; break }
      // Offset relative to unity (80 = 0dB): clamp result
      const offset = g.level - 80
      level = Math.max(0, Math.min(100, level + offset))
    }

    return anyMuted ? 0 : level
  }

  onDCAChange(cb: DCAChangeCallback): () => void {
    this._dcaCbs.add(cb)
    return () => this._dcaCbs.delete(cb)
  }

  // ── Mute Group API ────────────────────────────────────────────────────────

  setMuteGroupName(id: number, name: string): void {
    const g = this._getMute(id)
    g.name = name
  }

  addToMuteGroup(groupId: number, channelId: number): void {
    const g = this._getMute(groupId)
    if (!g.members.includes(channelId)) g.members.push(channelId)
  }

  removeFromMuteGroup(groupId: number, channelId: number): void {
    const g = this._getMute(groupId)
    g.members = g.members.filter(c => c !== channelId)
  }

  activateMuteGroup(groupId: number): void {
    const g = this._getMute(groupId)
    g.active = true
    const affected = g.members.filter(id => !channelSafeSystem.isSafe(id))
    this._muteCbs.forEach(cb => { try { cb(groupId, affected, true) } catch (_) {} })
  }

  deactivateMuteGroup(groupId: number): void {
    const g = this._getMute(groupId)
    g.active = false
    const affected = g.members.filter(id => !channelSafeSystem.isSafe(id))
    this._muteCbs.forEach(cb => { try { cb(groupId, affected, false) } catch (_) {} })
  }

  /** Emergency mute — instantly mutes all channels not in safe list */
  emergencyMute(allChannelIds: number[]): number[] {
    const affected = allChannelIds.filter(id => !channelSafeSystem.isSafe(id))
    // Activate all mute groups
    for (const g of this._mutes.values()) {
      g.active = true
      this._muteCbs.forEach(cb => { try { cb(g.id, affected, true) } catch (_) {} })
    }
    console.warn(`[DCAEngine] EMERGENCY MUTE — ${affected.length} channels muted`)
    return affected
  }

  getMuteGroup(id: number): MuteGroup | null { return this._mutes.get(id) ?? null }

  getAllMuteGroups(): MuteGroup[] { return Array.from(this._mutes.values()) }

  /** Returns true if channel is muted by any active mute group */
  isChannelGroupMuted(channelId: number): boolean {
    for (const g of this._mutes.values()) {
      if (g.active && g.members.includes(channelId)) return true
    }
    return false
  }

  onMuteChange(cb: MuteChangeCallback): () => void {
    this._muteCbs.add(cb)
    return () => this._muteCbs.delete(cb)
  }

  // ── State ─────────────────────────────────────────────────────────────────

  getSnapshot() {
    return {
      dcas:       Array.from(this._dcas.values()),
      muteGroups: Array.from(this._mutes.values()),
    }
  }

  loadSnapshot(snap: ReturnType<typeof this.getSnapshot>): void {
    for (const d of snap.dcas) {
      this._dcas.set(d.id, { ...d })
    }
    for (const m of snap.muteGroups) {
      this._mutes.set(m.id, { ...m })
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _getDCA(id: number): DCAGroup {
    const g = this._dcas.get(id)
    if (!g) throw new Error(`DCA ${id} does not exist`)
    return g
  }

  private _getMute(id: number): MuteGroup {
    const g = this._mutes.get(id)
    if (!g) throw new Error(`MuteGroup ${id} does not exist`)
    return g
  }

  private _emitDCA(id: number): void {
    const g = this._dcas.get(id)!
    this._dcaCbs.forEach(cb => { try { cb(id, g) } catch (_) {} })
  }
}

export const dcaEngine = new DCAEngine()
