/**
 * DSPParameterManager.ts — Smooth, realtime-safe parameter transitions.
 *
 * Responsibilities:
 *   - applyChannelState(strip, state) — all DSP params of one channel, click-free
 *   - applySceneState(strips, snapshot) — full scene recall without node recreation
 *   - rampParam(audioParam, target, rampS) — low-level AudioParam ramp helper
 *
 * ChannelStrip setters already apply internal ramps (20ms). DSPParameterManager
 * orchestrates the ORDER of setter calls and provides a clear entrypoint
 * for scene recall and headless automation.
 *
 * Invariant: NEVER calls strip.dispose() or recreates nodes.
 */

import type { ChannelStrip }   from './ChannelStrip'
import type { ChannelState, EngineSnapshot } from '../state/StateEngine'

const DEFAULT_RAMP_S = 0.02  // 20ms — matches ChannelStrip internal ramps

class DSPParameterManager {
  private _ctx: AudioContext | null = null

  attach(ctx: AudioContext): void { this._ctx = ctx }

  // ── Low-level AudioParam ramp ─────────────────────────────────────────────

  /** rampParam — setTargetAtTime with TC = rampS/3 (reaches ~95% in rampS). */
  rampParam(param: AudioParam, target: number, rampS = DEFAULT_RAMP_S): void {
    if (!this._ctx) { param.value = target; return }
    param.setTargetAtTime(target, this._ctx.currentTime, rampS / 3)
  }

  // ── Channel state application ─────────────────────────────────────────────

  /**
   * applyChannelState — routes all state fields to their ChannelStrip setter.
   * Called during scene recall (safeRecall) and crash recovery.
   */
  applyChannelState(strip: ChannelStrip, state: ChannelState): void {
    strip.setVolume(state.volume, state.muted)
    strip.setPan(state.pan)
    strip.setRouting(state.toMain, state.toSub)
    strip.setHpf({ active: state.hpf.active, freq: state.hpf.freq })
    strip.setGate(state.gate)
    strip.setCompressor(state.compressor)
    state.eqBands.forEach((band, i) =>
      strip.setEqBand(i, { gain: band.gain, freq: band.freq, q: band.q })
    )
    strip.setReverbSend(state.reverbSend)
    strip.setDelaySend(state.delaySend)
  }

  /**
   * applySceneState — apply full scene snapshot to all channel strips.
   * Does NOT recreate nodes. Does NOT reset worklets.
   * Channels with no matching strip are silently skipped.
   */
  applySceneState(
    strips: Map<number, ChannelStrip>,
    snapshot: EngineSnapshot
  ): void {
    for (const ch of snapshot.channels) {
      const strip = strips.get(ch.id)
      if (strip) this.applyChannelState(strip, ch)
    }
  }
}

export const dspParamMgr = new DSPParameterManager()
export default dspParamMgr
