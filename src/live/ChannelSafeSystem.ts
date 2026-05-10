/**
 * ChannelSafeSystem.ts — Protects designated channels from scene recall changes.
 *
 * Safe channels are never modified during any recall operation (full, partial,
 * or filtered). Typical safe channels: talkback, livestream, cue, recording.
 *
 * Safe modes per channel:
 *   FULL  — nothing changes (default for safe channels)
 *   EQ    — EQ bands are excluded from recall but fader/mute may change
 *   FADER — fader + mute excluded, EQ/comp/gate may change
 *   ROUTE — routing (toMain/toSub/auxSend) excluded, DSP may change
 *
 * Safe parameter groups (cross-channel):
 *   gains    — all channel volumes + main/sub volume
 *   mutes    — all channel mutes
 *   eq       — all EQ bands
 *   dynamics — compressor + gate
 *   routing  — toMain / toSub / aux sends
 */

export type SafeMode = 'FULL' | 'EQ' | 'FADER' | 'ROUTE'
export type SafeParamGroup = 'gains' | 'mutes' | 'eq' | 'dynamics' | 'routing'

export interface SafeChannelEntry {
  channelId: number
  mode:      SafeMode
  label:     string        // e.g. "talkback", "livestream"
  addedBy:   string        // who/what registered this
}

class ChannelSafeSystem {
  private _safeChannels = new Map<number, SafeChannelEntry>()
  private _safeGroups   = new Set<SafeParamGroup>()

  // ── Channel safe registration ─────────────────────────────────────────────

  addSafe(channelId: number, mode: SafeMode = 'FULL', label = '', addedBy = 'user'): void {
    this._safeChannels.set(channelId, { channelId, mode, label, addedBy })
    console.log(`[ChannelSafe] ch${channelId} safe: ${mode}${label ? ` (${label})` : ''}`)
  }

  removeSafe(channelId: number): void {
    this._safeChannels.delete(channelId)
    console.log(`[ChannelSafe] ch${channelId} safe removed`)
  }

  isSafe(channelId: number): boolean {
    return this._safeChannels.has(channelId)
  }

  getSafeMode(channelId: number): SafeMode | null {
    return this._safeChannels.get(channelId)?.mode ?? null
  }

  // ── Parameter group safe ──────────────────────────────────────────────────

  addGroupSafe(group: SafeParamGroup): void   { this._safeGroups.add(group) }
  removeGroupSafe(group: SafeParamGroup): void { this._safeGroups.delete(group) }
  isGroupSafe(group: SafeParamGroup): boolean  { return this._safeGroups.has(group) }

  // ── Filter a channel state patch before applying recall ───────────────────

  /**
   * Given the full target channel state from a scene, returns a filtered patch
   * that respects the channel's safe mode and active group safes.
   * Returns null if channel is fully safe (FULL mode or all params safe).
   */
  filterChannelPatch(
    channelId:   number,
    targetState: Record<string, any>,
    currentState: Record<string, any>,
  ): Record<string, any> | null {
    const mode = this.getSafeMode(channelId)

    if (mode === 'FULL') return null   // nothing changes

    const patch = { ...targetState }

    // Apply mode-specific exclusions
    if (mode === 'FADER') {
      patch.volume = currentState.volume
      patch.muted  = currentState.muted
    } else if (mode === 'EQ') {
      patch.eqBands = currentState.eqBands
    } else if (mode === 'ROUTE') {
      patch.toMain  = currentState.toMain
      patch.toSub   = currentState.toSub
    }

    // Apply group-level safes
    if (this._safeGroups.has('gains'))    patch.volume = currentState.volume
    if (this._safeGroups.has('mutes'))    patch.muted  = currentState.muted
    if (this._safeGroups.has('eq'))       patch.eqBands = currentState.eqBands
    if (this._safeGroups.has('dynamics')) {
      patch.compressor = currentState.compressor
      patch.gate       = currentState.gate
    }
    if (this._safeGroups.has('routing')) {
      patch.toMain = currentState.toMain
      patch.toSub  = currentState.toSub
    }

    return patch
  }

  getSafeList(): SafeChannelEntry[] {
    return Array.from(this._safeChannels.values())
  }

  getState() {
    return {
      safeChannels: this.getSafeList(),
      safeGroups:   Array.from(this._safeGroups),
    }
  }

  clear(): void {
    this._safeChannels.clear()
    this._safeGroups.clear()
  }
}

export const channelSafeSystem = new ChannelSafeSystem()
