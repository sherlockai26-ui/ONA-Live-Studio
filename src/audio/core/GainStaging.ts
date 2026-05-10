/**
 * GainStaging.ts — Sistema de gain staging para ONA Live Studio.
 *
 * Arquitectura de niveles internos (Paso 14):
 *   Input trim (±18dB) → HPF → gate → compressor → makeupGain → EQ → fader → bus
 *
 * Niveles nominales:
 *   BROADCAST = -18 dBFS (EBU R68 — standard europeo)
 *   LIVE      = -18 dBFS (headroom conservador para transientes)
 *   RECORDING = -20 dBFS (SMPTE — headroom extra para mastering)
 *
 * Headroom semaphore por canal:
 *   ok       — peak < nominal+6dB  (safe)
 *   low      — peak en nominal+6..+12dB  (approaching limiter)
 *   critical — peak > nominal+12dB  (limiter will engage)
 *
 * El trim no modifica el fader position — es un offset de pre-processing.
 * Permite compensar diferencias de ganancia entre fuentes sin tocar la mezcla.
 */

export type GainStagingProfile = 'broadcast' | 'live' | 'recording'
export type HeadroomRisk       = 'ok' | 'low' | 'critical'

export interface ChannelHeadroomReport {
  channelId:   number
  trimDb:      number
  peakDb:      number
  headroomDb:  number
  nominalDb:   number
  risk:        HeadroomRisk
}

export interface GainStagingReport {
  profile:   GainStagingProfile
  nominalDb: number
  channels:  ChannelHeadroomReport[]
  summary: {
    safe:     number
    lowRisk:  number
    critical: number
    avgPeakDb: number
  }
}

const NOMINAL_LEVELS: Record<GainStagingProfile, number> = {
  broadcast: -18,
  live:      -18,
  recording: -20,
}

function dbToGain(db: number): number { return Math.pow(10, db / 20) }

class GainStagingImpl {
  private _profile:  GainStagingProfile = 'live'
  private _trims     = new Map<number, number>()   // channelId → dB
  private _getMeter: ((id: number) => number) | null = null  // injected from engine

  // ── Setup ─────────────────────────────────────────────────────────────────────

  setProfile(profile: GainStagingProfile): void {
    this._profile = profile
    console.log(`[GainStaging] profile: ${profile} (nominal ${NOMINAL_LEVELS[profile]} dBFS)`)
  }

  get profile(): GainStagingProfile { return this._profile }
  get nominalDb(): number { return NOMINAL_LEVELS[this._profile] }

  setMeterReader(fn: (id: number) => number): void { this._getMeter = fn }

  // ── Trim management ───────────────────────────────────────────────────────────

  setTrim(channelId: number, db: number): number {
    const clamped = Math.max(-18, Math.min(18, db))
    this._trims.set(channelId, clamped)
    return clamped
  }

  getTrim(channelId: number): number { return this._trims.get(channelId) ?? 0 }

  // Returns the linear gain coefficient for the trim
  getTrimGain(channelId: number): number { return dbToGain(this.getTrim(channelId)) }

  // Auto-set trim to bring peak to nominal level (trim = nominal - currentPeak)
  autoTrim(channelId: number): number | null {
    if (!this._getMeter) return null
    const peakDb = this._getMeter(channelId)
    if (!isFinite(peakDb) || peakDb === -Infinity) return null
    const targetTrim = this.nominalDb - peakDb
    return this.setTrim(channelId, targetTrim)
  }

  // ── Headroom analysis ─────────────────────────────────────────────────────────

  getChannelHeadroom(channelId: number): ChannelHeadroomReport {
    const trimDb    = this.getTrim(channelId)
    const peakDb    = this._getMeter ? this._getMeter(channelId) : -Infinity
    const nominalDb = this.nominalDb
    const headroomDb = isFinite(peakDb) ? 0 - peakDb : Infinity

    let risk: HeadroomRisk = 'ok'
    if (isFinite(peakDb)) {
      const overNominal = peakDb - nominalDb
      if (overNominal > 12) risk = 'critical'
      else if (overNominal > 6) risk = 'low'
    }

    return { channelId, trimDb, peakDb, headroomDb, nominalDb, risk }
  }

  generateReport(channelIds: number[]): GainStagingReport {
    const channels = channelIds.map(id => this.getChannelHeadroom(id))
    const safe     = channels.filter(c => c.risk === 'ok').length
    const lowRisk  = channels.filter(c => c.risk === 'low').length
    const critical = channels.filter(c => c.risk === 'critical').length
    const finites  = channels.filter(c => isFinite(c.peakDb)).map(c => c.peakDb)
    const avgPeakDb = finites.length > 0 ? finites.reduce((a, b) => a + b, 0) / finites.length : -Infinity

    return {
      profile:   this._profile,
      nominalDb: this.nominalDb,
      channels,
      summary: { safe, lowRisk, critical, avgPeakDb: +avgPeakDb.toFixed(1) },
    }
  }

  // ── State serialization ───────────────────────────────────────────────────────

  serialize(): Record<string, any> {
    return {
      profile: this._profile,
      trims: Object.fromEntries(this._trims),
    }
  }

  deserialize(data: Record<string, any>): void {
    if (data.profile) this.setProfile(data.profile)
    if (data.trims) {
      for (const [id, db] of Object.entries(data.trims)) {
        this._trims.set(Number(id), Number(db))
      }
    }
  }
}

export const gainStaging = new GainStagingImpl()
