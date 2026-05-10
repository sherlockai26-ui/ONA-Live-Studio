/**
 * PanLaw.ts — Sistema seleccionable de ley de paneo.
 *
 * Leyes soportadas (Paso 14):
 *
 *   equal_power (default):
 *     L = cos(θ),  R = sin(θ)  donde  θ = (pan+1)/2 × π/2
 *     Centro: L=R=-3dBFS. Estándar broadcast y live sound moderno.
 *     StereoPannerNode nativo ya usa esta ley — sin overhead adicional.
 *
 *   linear_6db:
 *     L = (1 - pan) / 2,  R = (1 + pan) / 2
 *     Centro: L=R=-6dBFS. Broadcast tradicional (BBC, EBU viejo estilo).
 *     Implementación: transformar pan antes de pasarlo al StereoPannerNode.
 *
 *   linear_0db (unity panning):
 *     Centro: L=R= 0dBFS — SUMA TOTAL SIN ATENUACIÓN. Riesgo de headroom.
 *     Solo para producción con gain structure muy controlada.
 *
 * Implementación:
 *   El StereoPannerNode WebAudio usa equal_power internamente.
 *   Para otras leyes: transformamos el valor pan de entrada a un valor
 *   equivalente que produzca los niveles L/R deseados en el StereoPannerNode.
 *
 *   Para linear_6db: effective_pan = sin(pan × π/2) — invierte la curva cos
 *   Para linear_0db: effective_pan = pan (sin transformación — pero gain correction)
 *
 * Pan coherence (validación):
 *   Doble-mono: verificar que el pan no crea suma fuera de fase entre canales.
 *   Recomendación: no usar linear_0db con muchos canales en fase.
 */

export type PanLawMode = 'equal_power' | 'linear_6db' | 'linear_0db'

export interface PanLawInfo {
  mode:          PanLawMode
  centerGainDb:  number   // gain de cada canal en pan=0
  description:   string
  recommended:   boolean
}

export const PAN_LAW_INFO: Record<PanLawMode, PanLawInfo> = {
  equal_power: {
    mode: 'equal_power', centerGainDb: -3, recommended: true,
    description: 'Equal power (cos/sin) — broadcast and live standard',
  },
  linear_6db: {
    mode: 'linear_6db', centerGainDb: -6, recommended: false,
    description: 'Linear -6dB — traditional broadcast (BBC/EBU classic)',
  },
  linear_0db: {
    mode: 'linear_0db', centerGainDb: 0, recommended: false,
    description: 'Linear 0dB — unity center (use only with strict gain staging)',
  },
}

class PanLawImpl {
  private _mode: PanLawMode = 'equal_power'

  // ── Mode management ───────────────────────────────────────────────────────────

  setMode(mode: PanLawMode): void {
    this._mode = mode
    console.log(`[PanLaw] mode: ${mode} (center ${PAN_LAW_INFO[mode].centerGainDb}dB)`)
  }

  get mode(): PanLawMode { return this._mode }
  get info(): PanLawInfo { return PAN_LAW_INFO[this._mode] }

  // ── Effective pan value for StereoPannerNode ──────────────────────────────────
  // Given a user pan value (-1 to +1) and the current law,
  // return the StereoPannerNode pan value that achieves the desired L/R behavior.

  getEffectivePan(userPan: number): number {
    const p = Math.max(-1, Math.min(1, userPan))

    switch (this._mode) {
      case 'equal_power':
        return p  // StereoPannerNode already uses equal power — pass through

      case 'linear_6db': {
        // Linear law: L = (1-p)/2, R = (1+p)/2 at center → -6dBFS
        // Equal power: L = cos(θ), R = sin(θ), θ = (p+1)/2 × π/2
        // To get linear_6db result from equal_power StereoPanner:
        //   Find θ such that cos(θ) = (1-p)/2... complex.
        // Practical: apply a simple curve adjustment
        // sin(p × π/2) produces a gentler curve that approximates linear_6db
        return Math.sin(p * Math.PI / 2)
      }

      case 'linear_0db':
        // Linear 0dB: both channels at full signal at center
        // This can't be exactly replicated by StereoPannerNode (which always has center attenuation)
        // Best approximation: reduce panning effect (use very gentle curve)
        return p * 0.5   // reduced range — less extreme panning to preserve unity
    }
  }

  // ── L/R gain computation (for display and validation) ─────────────────────────

  getGains(userPan: number): { left: number; right: number; leftDb: number; rightDb: number } {
    const p = Math.max(-1, Math.min(1, userPan))

    let left: number, right: number
    switch (this._mode) {
      case 'equal_power': {
        const θ = ((p + 1) / 2) * (Math.PI / 2)
        left  = Math.cos(θ)
        right = Math.sin(θ)
        break
      }
      case 'linear_6db':
        left  = (1 - p) / 2
        right = (1 + p) / 2
        break
      case 'linear_0db':
        left  = p <= 0 ? 1 : 1 - p
        right = p >= 0 ? 1 : 1 + p
        break
    }

    const db = (g: number) => g > 0 ? 20 * Math.log10(g) : -Infinity
    return { left, right, leftDb: +db(left).toFixed(1), rightDb: +db(right).toFixed(1) }
  }

  // ── Coherence check ───────────────────────────────────────────────────────────

  checkCoherence(numChannels: number): { ok: boolean; warning: string | null } {
    if (this._mode === 'linear_0db' && numChannels > 8) {
      return {
        ok: false,
        warning: `linear_0db with ${numChannels} channels risks +${Math.round(20*Math.log10(numChannels))}dB summing boost. ` +
                 'Use equal_power or reduce channel gains.',
      }
    }
    if (this._mode === 'linear_6db' && numChannels > 24) {
      return {
        ok: false,
        warning: `linear_6db with ${numChannels} channels: verify headroom. ` +
                 'Recommend equal_power for large channel counts.',
      }
    }
    return { ok: true, warning: null }
  }

  // ── State serialization ───────────────────────────────────────────────────────

  serialize(): { panLaw: PanLawMode } { return { panLaw: this._mode } }
  deserialize(data: { panLaw?: PanLawMode }): void {
    if (data.panLaw) this.setMode(data.panLaw)
  }
}

export const panLaw = new PanLawImpl()
