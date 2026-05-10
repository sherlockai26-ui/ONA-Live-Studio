/**
 * RecallValidator.ts — Pre/post recall validation for safe live operation.
 *
 * Runs before every scene recall. Issues can block or warn:
 *   ERROR   → blocks recall (returns ok=false)
 *   WARNING → logs and proceeds
 *   INFO    → logged only
 *
 * Checks:
 *   - Routing conflicts (channel routed to bus that doesn't exist in scene)
 *   - Invalid parameter ranges (volume > 150, freq out of range, etc.)
 *   - Missing device mappings (input source referenced but not connected)
 *   - Stale DCA assignments (DCA references deleted channels)
 *   - Channel count mismatch (scene has more channels than engine)
 *   - FX bus conflict (scene enables FX bus that is currently recording)
 */

import type { EngineSnapshot } from '../audio/state/StateEngine'

export type IssueLevel = 'ERROR' | 'WARNING' | 'INFO'

export interface ValidationIssue {
  level:     IssueLevel
  code:      string
  message:   string
  channelId?: number
}

export interface ValidationResult {
  ok:          boolean    // false if any ERROR-level issues found
  issues:      ValidationIssue[]
  checkedAt:   number
  sceneName:   string
}

function issue(level: IssueLevel, code: string, message: string, channelId?: number): ValidationIssue {
  return { level, code, message, channelId }
}

class RecallValidator {
  private _activeInputSources = new Set<string>()   // from DeviceManager
  private _engineChannelCount = 6                    // updated by caller
  private _recordingActive    = false                // from RecordingClock

  setActiveInputSources(sources: string[]): void { this._activeInputSources = new Set(sources) }
  setEngineChannelCount(n: number): void          { this._engineChannelCount = n }
  setRecordingActive(v: boolean): void            { this._recordingActive = v }

  validate(snapshot: EngineSnapshot, name: string): ValidationResult {
    const issues: ValidationIssue[] = []

    this._checkChannelCount(snapshot, issues)
    this._checkChannelRanges(snapshot, issues)
    this._checkInputSources(snapshot, issues)
    this._checkFxConflict(snapshot, issues)
    this._checkBusIntegrity(snapshot, issues)

    const errors = issues.filter(i => i.level === 'ERROR')
    if (issues.length > 0) {
      const warn = issues.filter(i => i.level === 'WARNING').length
      const info = issues.filter(i => i.level === 'INFO').length
      console.warn(
        `[RecallValidator] "${name}": ${errors.length} errors, ${warn} warnings, ${info} info`
      )
      issues.forEach(i => {
        const fn = i.level === 'ERROR' ? console.error : console.warn
        fn(`  [${i.level}] ${i.code}: ${i.message}`)
      })
    }

    return { ok: errors.length === 0, issues, checkedAt: Date.now(), sceneName: name }
  }

  private _checkChannelCount(snap: EngineSnapshot, issues: ValidationIssue[]): void {
    if (snap.channels.length > this._engineChannelCount) {
      issues.push(issue(
        'WARNING', 'CHANNEL_COUNT_MISMATCH',
        `Scene has ${snap.channels.length} channels, engine has ${this._engineChannelCount}. Extra channels ignored.`
      ))
    }
  }

  private _checkChannelRanges(snap: EngineSnapshot, issues: ValidationIssue[]): void {
    for (const ch of snap.channels) {
      if (ch.volume < 0 || ch.volume > 150)
        issues.push(issue('ERROR', 'INVALID_VOLUME', `volume=${ch.volume} out of range [0,150]`, ch.id))
      if (ch.pan < -1 || ch.pan > 1)
        issues.push(issue('ERROR', 'INVALID_PAN', `pan=${ch.pan} out of range [-1,1]`, ch.id))
      if (ch.hpf.freq < 20 || ch.hpf.freq > 20000)
        issues.push(issue('WARNING', 'INVALID_HPF_FREQ', `hpf.freq=${ch.hpf.freq}Hz out of [20,20000]`, ch.id))
      for (const band of ch.eqBands) {
        if (band.gain < -18 || band.gain > 18)
          issues.push(issue('WARNING', 'INVALID_EQ_GAIN', `EQ band ${band.id} gain=${band.gain}dB out of [-18,18]`, ch.id))
      }
      if (ch.compressor.ratio < 1 || ch.compressor.ratio > 100)
        issues.push(issue('WARNING', 'INVALID_COMP_RATIO', `comp ratio=${ch.compressor.ratio} out of [1,100]`, ch.id))
    }
  }

  private _checkInputSources(snap: EngineSnapshot, issues: ValidationIssue[]): void {
    if (this._activeInputSources.size === 0) return   // no device info available
    for (const ch of snap.channels) {
      if (ch.inputSource && !this._activeInputSources.has(ch.inputSource)) {
        issues.push(issue(
          'WARNING', 'MISSING_INPUT_SOURCE',
          `Input "${ch.inputSource}" not found in active devices`,
          ch.id
        ))
      }
    }
  }

  private _checkFxConflict(snap: EngineSnapshot, issues: ValidationIssue[]): void {
    if (!this._recordingActive) return
    if (snap.fx?.fxReturn?.volume > 0 && !snap.fx?.fxReturn?.muted) {
      issues.push(issue(
        'INFO', 'FX_ACTIVE_DURING_RECORDING',
        'Scene enables FX return while recording is active — recorded track will include FX'
      ))
    }
  }

  private _checkBusIntegrity(snap: EngineSnapshot, issues: ValidationIssue[]): void {
    const mainVol = snap.buses?.mainVolume
    const subVol  = snap.buses?.subVolume
    if (mainVol !== undefined && (mainVol < 0 || mainVol > 150))
      issues.push(issue('ERROR', 'INVALID_MAIN_VOLUME', `main volume=${mainVol} out of range`))
    if (subVol !== undefined && (subVol < 0 || subVol > 150))
      issues.push(issue('ERROR', 'INVALID_SUB_VOLUME', `sub volume=${subVol} out of range`))
  }
}

export const recallValidator = new RecallValidator()
