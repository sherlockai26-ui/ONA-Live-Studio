/**
 * RoutingValidator.ts — Validación de routing para detectar problemas en vivo.
 *
 * Detecta:
 *   - Feedback loops en la matrix (A→B y B→A activos simultáneamente)
 *   - Conexiones duplicadas en la matrix
 *   - Clipping en buses (peak > -1 dBFS)
 *   - Headroom insuficiente (peak > -6 dBFS)
 *   - Phase issues en sends múltiples del mismo canal
 */

import type { MatrixConnection } from './RoutingMatrix'

export interface RoutingIssue {
  severity: 'error' | 'warning'
  type:     'feedback' | 'duplicate' | 'clipping' | 'level' | 'phase'
  message:  string
}

export interface RoutingValidationReport {
  issues:    RoutingIssue[]
  verdict:   'ok' | 'warning' | 'error'
  checkedAt: number
}

export class RoutingValidator {

  validateNoFeedback(connections: MatrixConnection[]): RoutingIssue[] {
    const issues: RoutingIssue[] = []
    const active = connections.filter(c => c.active)
    for (const c of active) {
      // Check if any active connection goes from c.dest back to c.source
      const reverse = active.find(r => (r.source as string) === (c.dest as string) && (r.dest as string) === (c.source as string))
      if (reverse) {
        issues.push({ severity: 'error', type: 'feedback', message: `Feedback loop: ${c.source} ↔ ${c.dest}` })
      }
    }
    return issues
  }

  validateNoDuplicates(connections: MatrixConnection[]): RoutingIssue[] {
    const issues: RoutingIssue[] = []
    const seen = new Set<string>()
    for (const c of connections) {
      const key = `${c.source}→${c.dest}`
      if (seen.has(key)) issues.push({ severity: 'warning', type: 'duplicate', message: `Ruta duplicada: ${key}` })
      seen.add(key)
    }
    return issues
  }

  validateLevels(buses: { id: string; peakDb: number }[]): RoutingIssue[] {
    const issues: RoutingIssue[] = []
    for (const b of buses) {
      if (!isFinite(b.peakDb)) continue
      if (b.peakDb > -1) {
        issues.push({ severity: 'error', type: 'clipping', message: `${b.id}: ${b.peakDb.toFixed(1)} dBFS — CLIPPING` })
      } else if (b.peakDb > -6) {
        issues.push({ severity: 'warning', type: 'level', message: `${b.id}: ${b.peakDb.toFixed(1)} dBFS — headroom < 6dB` })
      }
    }
    return issues
  }

  /** Warn if a channel sends to more than 2 groups (potential phase stacking) */
  validatePhase(channelGroupSends: Record<number, number[]>): RoutingIssue[] {
    const issues: RoutingIssue[] = []
    for (const [chId, groups] of Object.entries(channelGroupSends)) {
      if (groups.length > 2) {
        issues.push({
          severity: 'warning', type: 'phase',
          message:  `Canal ${chId}: enrutado a ${groups.length} grupos — verificar fase`,
        })
      }
    }
    return issues
  }

  runFullValidation(
    connections: MatrixConnection[],
    buses: { id: string; peakDb: number }[],
    channelGroupSends?: Record<number, number[]>,
  ): RoutingValidationReport {
    const issues = [
      ...this.validateNoFeedback(connections),
      ...this.validateNoDuplicates(connections),
      ...this.validateLevels(buses),
      ...(channelGroupSends ? this.validatePhase(channelGroupSends) : []),
    ]
    const verdict: RoutingValidationReport['verdict'] =
      issues.some(i => i.severity === 'error')   ? 'error' :
      issues.some(i => i.severity === 'warning') ? 'warning' : 'ok'
    return { issues, verdict, checkedAt: Date.now() }
  }
}

export const routingValidator = new RoutingValidator()
