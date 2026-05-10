/**
 * DSPValidator.ts — Guardias de calidad de audio en el pipeline DSP.
 *
 * Detecta problemas silenciosos que degradan la calidad sin producir errores JS:
 *   - NaN propagation (un NaN silencia todos los nodos posteriores en WebAudio)
 *   - Clipping (|sample| > 1.0 — distorsión)
 *   - DC offset (bias DC — fatiga de amplificadores, daño a drivers)
 *   - Denormals (valores sub-normales — CPU spike en algunas arquitecturas)
 *
 * Uso:
 *   const v = new DSPValidator(ctx, { label: 'post-EQ ch1' })
 *   v.tap(sourceNode)        // conecta el tap de análisis
 *   v.check()                // lee y valida el último bloque
 *   v.dispose()
 *
 * Console API: window.__ONA_VALIDATE.*
 */

export interface ValidationResult {
  label:        string
  hasNaN:       boolean
  clipCount:    number
  dcOffsetDb:   number   // dBFS — normal range: < -40 dB
  denormals:    number   // count of sub-normal samples
  rmsDb:        number
  peakDb:       number
  verdict:      'ok' | 'warning' | 'error'
  issues:       string[]
}

const NAN_THRESHOLD    = 0           // any NaN is an error
const CLIP_THRESHOLD   = 1.0         // |sample| >= this is a clip
const DC_WARN_DB       = -40         // DC offset above this → warning
const DENORMAL_MIN     = 5e-324      // below Number.MIN_VALUE
const DENORMAL_MAX     = 2.2e-308    // sub-normal upper bound

export class DSPValidator {
  private readonly _analyser: AnalyserNode
  private readonly _buf:      Float32Array
  private readonly _label:    string

  constructor(ctx: AudioContext, opts: { label?: string; fftSize?: number } = {}) {
    this._label   = opts.label ?? 'unnamed'
    this._analyser = ctx.createAnalyser()
    this._analyser.fftSize = opts.fftSize ?? 2048
    this._analyser.smoothingTimeConstant = 0
    this._buf = new Float32Array(this._analyser.fftSize)
  }

  get node(): AnalyserNode { return this._analyser }

  /** Connect a source node to this validator's tap */
  tap(src: AudioNode): void { src.connect(this._analyser) }

  /** Read latest block and validate — call from RAF or on-demand */
  check(): ValidationResult {
    this._analyser.getFloatTimeDomainData(this._buf)
    const buf = this._buf
    const n   = buf.length

    let hasNaN   = false
    let clips    = 0
    let denorms  = 0
    let dcSum    = 0
    let rmsSum   = 0
    let peak     = 0

    for (let i = 0; i < n; i++) {
      const s = buf[i]

      if (s !== s) { hasNaN = true; continue }  // NaN check

      const abs = s < 0 ? -s : s

      if (abs >= CLIP_THRESHOLD) clips++

      // Denormal: non-zero but below normal float range
      if (abs > 0 && abs < DENORMAL_MAX) denorms++

      dcSum  += s
      rmsSum += s * s
      if (abs > peak) peak = abs
    }

    const dcOffset  = dcSum / n
    const rms       = Math.sqrt(rmsSum / n)
    const rmsDb     = rms  > 0 ? 20 * Math.log10(rms)  : -Infinity
    const peakDb    = peak > 0 ? 20 * Math.log10(peak) : -Infinity
    const dcOffsetDb = Math.abs(dcOffset) > 0 ? 20 * Math.log10(Math.abs(dcOffset)) : -Infinity

    const issues: string[] = []
    if (hasNaN)    issues.push('NaN detected — DSP chain broken')
    if (clips > 0) issues.push(`${clips} clips (|sample| ≥ 1.0)`)
    if (isFinite(dcOffsetDb) && dcOffsetDb > DC_WARN_DB)
      issues.push(`DC offset ${dcOffsetDb.toFixed(1)} dBFS`)
    if (denorms > 0) issues.push(`${denorms} denormal samples`)

    const verdict: ValidationResult['verdict'] =
      hasNaN ? 'error' :
      clips > 0 || (isFinite(dcOffsetDb) && dcOffsetDb > DC_WARN_DB) ? 'warning' :
      'ok'

    return {
      label: this._label, hasNaN, clipCount: clips,
      dcOffsetDb: isFinite(dcOffsetDb) ? dcOffsetDb : -Infinity,
      denormals: denorms, rmsDb, peakDb, verdict, issues,
    }
  }

  dispose(): void {
    try { this._analyser.disconnect() } catch (_) {}
  }
}

// ─── Quick validation helpers ─────────────────────────────────────────────────

/** Validate a Float32Array buffer in-place (offline, no WebAudio needed) */
export function validateBuffer(buf: Float32Array, label = 'buffer'): ValidationResult {
  const n      = buf.length
  let hasNaN   = false
  let clips    = 0
  let denorms  = 0
  let dcSum    = 0
  let rmsSum   = 0
  let peak     = 0

  for (let i = 0; i < n; i++) {
    const s = buf[i]
    if (s !== s) { hasNaN = true; continue }
    const abs = s < 0 ? -s : s
    if (abs >= CLIP_THRESHOLD) clips++
    if (abs > 0 && abs < DENORMAL_MAX) denorms++
    dcSum  += s
    rmsSum += s * s
    if (abs > peak) peak = abs
  }

  const dcOffset   = dcSum / n
  const rms        = Math.sqrt(rmsSum / n)
  const rmsDb      = rms  > 0 ? 20 * Math.log10(rms)  : -Infinity
  const peakDb     = peak > 0 ? 20 * Math.log10(peak) : -Infinity
  const dcOffsetDb = Math.abs(dcOffset) > 0 ? 20 * Math.log10(Math.abs(dcOffset)) : -Infinity

  const issues: string[] = []
  if (hasNaN)    issues.push('NaN detected')
  if (clips > 0) issues.push(`${clips} clips`)
  if (isFinite(dcOffsetDb) && dcOffsetDb > DC_WARN_DB)
    issues.push(`DC offset ${dcOffsetDb.toFixed(1)} dBFS`)
  if (denorms > 0) issues.push(`${denorms} denormals`)

  const verdict: ValidationResult['verdict'] =
    hasNaN ? 'error' : clips > 0 || (isFinite(dcOffsetDb) && dcOffsetDb > DC_WARN_DB) ? 'warning' : 'ok'

  return {
    label, hasNaN, clipCount: clips,
    dcOffsetDb: isFinite(dcOffsetDb) ? dcOffsetDb : -Infinity,
    denormals: denorms, rmsDb, peakDb, verdict, issues,
  }
}

// ─── Console API ──────────────────────────────────────────────────────────────

let _validators: DSPValidator[] = []

export function exposeValidatorAPI(ctx: AudioContext, strips: Map<number, any>): void {
  ;(window as any).__ONA_VALIDATE = {
    /** Attach validators to all channel output taps */
    attachAll: () => {
      _validators.forEach(v => v.dispose())
      _validators = []
      for (const [id, strip] of strips) {
        const v = new DSPValidator(ctx, { label: `ch${id}-out` })
        strip.toMain?.connect(v.node)
        _validators.push(v)
      }
      console.log(`[VALIDATE] Attached ${_validators.length} validators`)
    },

    /** Run validation on all attached taps */
    check: () => {
      const results = _validators.map(v => v.check())
      for (const r of results) {
        const icon = r.verdict === 'ok' ? '✓' : r.verdict === 'warning' ? '⚠' : '✗'
        const msg  = r.issues.length > 0 ? r.issues.join(', ') : 'clean'
        console.log(`${icon} [${r.label}] peak=${r.peakDb === -Infinity ? '-∞' : r.peakDb.toFixed(1)}dBFS rms=${r.rmsDb === -Infinity ? '-∞' : r.rmsDb.toFixed(1)}dBFS — ${msg}`)
      }
      return results
    },

    /** Validate a Float32Array offline */
    buffer: (buf: Float32Array, label?: string) => {
      const r = validateBuffer(buf, label)
      console.table(r)
      return r
    },

    dispose: () => {
      _validators.forEach(v => v.dispose())
      _validators = []
      console.log('[VALIDATE] All validators disposed')
    },
  }
}
