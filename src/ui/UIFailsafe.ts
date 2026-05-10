/**
 * UIFailsafe.ts — Adaptive UI quality when FPS drops below threshold.
 *
 * Stages (triggered by sustained FPS drops):
 *   full     (≥45 fps): all layers active, meters at full rate
 *   reduced  (≥30 fps): LOW layer paused, meter fps halved
 *   minimal  (≥15 fps): MEDIUM + LOW paused, meter fps at 10fps minimum
 *   safe     (<15 fps): only CRITICAL layer, meters at 5fps
 *
 * Hysteresis: must sustain recovery for RECOVERY_TICKS before upgrading.
 * Integrates with RenderScheduler.setMaxPriority() and MeterSubscriber.setFps().
 */

import { renderScheduler, RENDER_PRIORITY, type SchedulePriority } from './RenderScheduler'

export type UIQualityStage = 'full' | 'reduced' | 'minimal' | 'safe'

interface StageConfig {
  minFps:      number
  maxPriority: SchedulePriority
  meterFps:    number
  label:       string
}

const STAGES: Record<UIQualityStage, StageConfig> = {
  full:    { minFps: 45, maxPriority: RENDER_PRIORITY.LOW,      meterFps: 60,  label: 'Full' },
  reduced: { minFps: 30, maxPriority: RENDER_PRIORITY.MEDIUM,   meterFps: 30,  label: 'Reduced' },
  minimal: { minFps: 15, maxPriority: RENDER_PRIORITY.HIGH,     meterFps: 10,  label: 'Minimal' },
  safe:    { minFps:  0, maxPriority: RENDER_PRIORITY.CRITICAL, meterFps:  5,  label: 'Safe' },
}

const STAGE_ORDER: UIQualityStage[] = ['full', 'reduced', 'minimal', 'safe']

const DROP_TICKS     = 5   // consecutive below-threshold ticks before downgrade
const RECOVERY_TICKS = 30  // consecutive above-threshold ticks before upgrade

class UIFailsafe {
  private _stage:         UIQualityStage = 'full'
  private _dropCount      = 0
  private _recoveryCount  = 0
  private _pollId:        ReturnType<typeof setInterval> | null = null
  private _meterFpsFn:    ((fps: number) => void) | null = null
  private _onStageChange: ((stage: UIQualityStage) => void) | null = null

  /**
   * Wire in the meter fps setter (e.g., from MeterSubscriber or networkClient.meters)
   */
  setMeterFpsSetter(fn: (fps: number) => void): void {
    this._meterFpsFn = fn
  }

  onStageChange(cb: (stage: UIQualityStage) => void): void {
    this._onStageChange = cb
  }

  start(pollIntervalMs = 1000): void {
    if (this._pollId !== null) return
    this._pollId = setInterval(() => this._poll(), pollIntervalMs)
  }

  stop(): void {
    if (this._pollId !== null) { clearInterval(this._pollId); this._pollId = null }
  }

  getStage(): UIQualityStage { return this._stage }

  getMetrics() {
    const cfg = STAGES[this._stage]
    return {
      stage:         this._stage,
      label:         cfg.label,
      fps:           renderScheduler.getFPS(),
      maxPriority:   cfg.maxPriority,
      meterFps:      cfg.meterFps,
      dropCount:     this._dropCount,
      recoveryCount: this._recoveryCount,
    }
  }

  forceStage(stage: UIQualityStage): void {
    this._dropCount     = 0
    this._recoveryCount = 0
    this._applyStage(stage)
  }

  private _poll(): void {
    const fps      = renderScheduler.getFPS()
    const stageIdx = STAGE_ORDER.indexOf(this._stage)
    const cfg      = STAGES[this._stage]

    // Check if we should downgrade
    if (fps < cfg.minFps && stageIdx < STAGE_ORDER.length - 1) {
      this._dropCount++
      this._recoveryCount = 0
      if (this._dropCount >= DROP_TICKS) {
        this._dropCount = 0
        this._applyStage(STAGE_ORDER[stageIdx + 1])
      }
      return
    }

    // Check if we can upgrade
    if (stageIdx > 0) {
      const prevCfg = STAGES[STAGE_ORDER[stageIdx - 1]]
      if (fps >= prevCfg.minFps) {
        this._recoveryCount++
        this._dropCount = 0
        if (this._recoveryCount >= RECOVERY_TICKS) {
          this._recoveryCount = 0
          this._applyStage(STAGE_ORDER[stageIdx - 1])
        }
        return
      }
    }

    this._dropCount     = 0
    this._recoveryCount = 0
  }

  private _applyStage(stage: UIQualityStage): void {
    if (stage === this._stage) return
    this._stage = stage
    const cfg = STAGES[stage]

    renderScheduler.setMaxPriority(cfg.maxPriority)
    this._meterFpsFn?.(cfg.meterFps)
    this._onStageChange?.(stage)

    console.warn(`[UIFailsafe] quality → ${cfg.label} (fps=${renderScheduler.getFPS()}, meterFps=${cfg.meterFps})`)
  }

  destroy(): void {
    this.stop()
    renderScheduler.resetMaxPriority()
  }
}

export const uiFailsafe = new UIFailsafe()
