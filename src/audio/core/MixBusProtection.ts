/**
 * MixBusProtection.ts — Protección del bus de mezcla principal.
 *
 * Cadena insertada entre BusEngine.fader y ctx.destination (Paso 14):
 *   fader → [softSat?] → [limiter?] → clipGuard (AnalyserNode) → destination
 *
 * Soft saturation (WaveShaperNode):
 *   Curva tanh escalada — compresión suave por encima del umbral.
 *   Aporta armónicos naturales sin el sonido digital del clipping.
 *   Drive = 1.5: interviene ~-6dBFS, casi inaudible hasta -3dBFS.
 *   LOW CPU: WaveShaperNode nativo, sin callback en JS.
 *
 * Safety limiter (DynamicsCompressorNode):
 *   Threshold: -1 dBFS, Ratio: 20:1, Attack: 1ms, Release: 100ms, Knee: 0
 *   Efectivamente brickwall: nunca supera 0dBFS.
 *   LOW CPU: nativo WebAudio, sin polling en JS.
 *
 * Clip guard:
 *   AnalyserNode post-cadena — check cada 500ms (setInterval, no RAF).
 *   Si peak > -0.5 dBFS → onClipGuard() callback con nivel actual.
 *   Rate-limited: máx 1 callback cada 2s para evitar spam.
 *
 * Configuración típica para live FOH:
 *   softSat: true (control natural de transientes)
 *   limiter: true (seguro para PA — nunca overload)
 *   clipGuard: true (alerta al operador)
 */

const CURVE_SIZE    = 1024
const SAT_DRIVE     = 1.5
const LIMITER_THRESHOLD = -1   // dBFS
const CLIP_GUARD_THRESHOLD = -0.5  // dBFS = Math.pow(10, -0.5/20) ≈ 0.944
const CLIP_GUARD_INTERVAL  = 500   // ms
const CLIP_GUARD_COOLDOWN  = 2000  // ms

function buildSaturationCurve(drive: number): Float32Array {
  const curve  = new Float32Array(CURVE_SIZE)
  const denom  = Math.tanh(drive)
  for (let i = 0; i < CURVE_SIZE; i++) {
    const x   = (i * 2 / (CURVE_SIZE - 1)) - 1   // -1 to +1
    curve[i]  = Math.tanh(x * drive) / denom
  }
  return curve
}

export interface ProtectionConfig {
  softSatEnabled:   boolean
  limiterEnabled:   boolean
  clipGuardEnabled: boolean
  satDrive:         number   // 1.0–4.0 (1.5 = subtle)
  limiterThresholdDb: number // default -1
}

const DEFAULT_CONFIG: ProtectionConfig = {
  softSatEnabled:     false,   // off by default — user opt-in
  limiterEnabled:     true,    // on by default — safety critical
  clipGuardEnabled:   true,
  satDrive:           SAT_DRIVE,
  limiterThresholdDb: LIMITER_THRESHOLD,
}

export interface ClipEvent {
  peakDb:    number
  timestamp: number
}

type ClipGuardCallback = (event: ClipEvent) => void

class MixBusProtectionImpl {
  private _ctx:       AudioContext | null = null
  private _config:    ProtectionConfig = { ...DEFAULT_CONFIG }

  // Protection chain nodes
  private _softSat:   WaveShaperNode    | null = null
  private _limiter:   DynamicsCompressorNode | null = null
  private _clipGuard: AnalyserNode      | null = null
  private _clipBuf:   Float32Array      = new Float32Array(256)

  // Input/output connectors
  private _inputNode:  AudioNode | null = null
  private _outputDest: AudioNode | null = null

  // Clip guard
  private _clipInterval:  ReturnType<typeof setInterval> | null = null
  private _lastClipFired  = 0
  private _onClipGuard:   ClipGuardCallback | null = null
  private _clipCount      = 0

  // ── Attach to bus ─────────────────────────────────────────────────────────────

  attach(
    ctx:       AudioContext,
    fader:     AudioNode,
    destInput: AudioNode,
    onClipGuard?: ClipGuardCallback,
  ): void {
    this._ctx       = ctx
    this._inputNode  = fader
    this._outputDest = destInput
    this._onClipGuard = onClipGuard ?? null

    // Build nodes
    this._softSat   = ctx.createWaveShaper()
    this._softSat.curve     = buildSaturationCurve(this._config.satDrive)
    this._softSat.oversample = '2x'

    this._limiter   = ctx.createDynamicsCompressor()
    this._limiter.threshold.value = this._config.limiterThresholdDb
    this._limiter.ratio.value     = 20
    this._limiter.attack.value    = 0.001
    this._limiter.release.value   = 0.1
    this._limiter.knee.value      = 0

    this._clipGuard = ctx.createAnalyser()
    this._clipGuard.fftSize               = 256
    this._clipGuard.smoothingTimeConstant = 0
    this._clipBuf = new Float32Array(256)

    // Disconnect fader from direct destination
    try { fader.disconnect(destInput) } catch (_) {}

    // Build protection chain and reconnect
    this._rebuildChain()

    // Start clip guard polling (not RAF — 500ms interval, minimal CPU)
    if (this._config.clipGuardEnabled) {
      this._clipInterval = setInterval(() => this._checkClip(), CLIP_GUARD_INTERVAL)
    }

    console.log('[MixBusProtection] attached — ' +
      `softSat:${this._config.softSatEnabled} limiter:${this._config.limiterEnabled} clipGuard:${this._config.clipGuardEnabled}`)
  }

  // ── Configuration ─────────────────────────────────────────────────────────────

  setConfig(cfg: Partial<ProtectionConfig>): void {
    Object.assign(this._config, cfg)
    if (!this._ctx || !this._inputNode) return

    // Update limiter threshold live
    if (cfg.limiterThresholdDb !== undefined && this._limiter) {
      this._limiter.threshold.setTargetAtTime(cfg.limiterThresholdDb, this._ctx.currentTime, 0.01)
    }
    // Rebuild saturation curve if drive changed
    if (cfg.satDrive !== undefined && this._softSat) {
      this._softSat.curve = buildSaturationCurve(cfg.satDrive)
    }
    // Reconnect chain based on enabled flags
    this._rebuildChain()
  }

  getConfig(): ProtectionConfig { return { ...this._config } }

  // ── Meter ─────────────────────────────────────────────────────────────────────

  getPostProtectionPeakDb(): number {
    if (!this._clipGuard) return -Infinity
    this._clipGuard.getFloatTimeDomainData(this._clipBuf)
    let peak = 0
    for (let i = 0; i < this._clipBuf.length; i++) {
      const a = Math.abs(this._clipBuf[i])
      if (a > peak) peak = a
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity
  }

  getLimiterReduction(): number {
    return this._limiter?.reduction ?? 0
  }

  get clipCount(): number { return this._clipCount }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private _rebuildChain(): void {
    if (!this._inputNode || !this._outputDest || !this._softSat || !this._limiter || !this._clipGuard) return

    // Disconnect everything in chain
    try { this._inputNode.disconnect(this._softSat)   } catch (_) {}
    try { this._inputNode.disconnect(this._limiter)   } catch (_) {}
    try { this._inputNode.disconnect(this._clipGuard) } catch (_) {}
    try { this._inputNode.disconnect(this._outputDest)} catch (_) {}
    try { this._softSat.disconnect()  } catch (_) {}
    try { this._limiter.disconnect()  } catch (_) {}
    try { this._clipGuard.disconnect()} catch (_) {}

    // Build enabled chain: input → [softSat?] → [limiter?] → clipGuard → dest
    let current: AudioNode = this._inputNode

    if (this._config.softSatEnabled) {
      current.connect(this._softSat)
      current = this._softSat
    }
    if (this._config.limiterEnabled) {
      current.connect(this._limiter)
      current = this._limiter
    }
    // clipGuard is always in chain (post-protection metering)
    current.connect(this._clipGuard)
    this._clipGuard.connect(this._outputDest)
  }

  private _checkClip(): void {
    if (!this._clipGuard || !this._config.clipGuardEnabled) return
    const peakDb = this.getPostProtectionPeakDb()
    if (!isFinite(peakDb)) return

    if (peakDb > CLIP_GUARD_THRESHOLD) {
      this._clipCount++
      const now = performance.now()
      if (now - this._lastClipFired > CLIP_GUARD_COOLDOWN) {
        this._lastClipFired = now
        this._onClipGuard?.({ peakDb, timestamp: now })
        console.warn(`[MixBusProtection] clip guard: ${peakDb.toFixed(1)} dBFS`)
      }
    }
  }

  // ── Destroy ───────────────────────────────────────────────────────────────────

  destroy(): void {
    if (this._clipInterval !== null) clearInterval(this._clipInterval)
    // Reconnect fader directly to destination before disconnecting protection chain
    if (this._inputNode && this._outputDest) {
      try { this._inputNode.connect(this._outputDest) } catch (_) {}
    }
    for (const n of [this._softSat, this._limiter, this._clipGuard]) {
      if (n) try { n.disconnect() } catch (_) {}
    }
    this._softSat   = null
    this._limiter   = null
    this._clipGuard = null
    this._ctx       = null
    this._onClipGuard = null
  }
}

export const mixBusProtection = new MixBusProtectionImpl()
