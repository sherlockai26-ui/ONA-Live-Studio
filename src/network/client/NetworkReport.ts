/**
 * NetworkReport.ts — Network resilience and performance report.
 *
 * Sections:
 *   1. Connection status (connected, uptime, reconnects)
 *   2. Command channel metrics (sent, dropped, avg ack ms)
 *   3. Meter stream metrics (fps, packets, visible count)
 *   4. Discovery result (server URL, hotspot mode, clients)
 *   5. Latency stability (RTT avg, p95, jitter)
 *   6. Max clients estimate (from server stats endpoint)
 *   7. Hotspot viability (RTT < 20ms in hotspot scenarios)
 *   8. Recommendations
 *   9. Verdict: excellent / good / marginal / poor
 */

import type { DiscoveryResult } from './DiscoveryClient'

export interface CommandMetrics {
  connected:   boolean
  sent:        number
  totalQueued: number
  dropped:     number
  ackd:        number
  avgAckMs:    number
}

export interface MeterMetrics {
  connected:    boolean
  packetsRx:    number
  visibleCount: number
  fps:          number
}

export interface NetworkFullReport {
  timestamp:        string
  serverUrl:        string | null
  hotspot:          boolean
  uptimeS:          number
  commandMetrics:   CommandMetrics
  meterMetrics:     MeterMetrics
  serverStats:      any
  rttAvgMs:         number
  rttP95Ms:         number
  maxClients:       number
  hotspotViable:    boolean
  issues:           string[]
  recommendations:  string[]
  verdict:          'excellent' | 'good' | 'marginal' | 'poor'
}

async function fetchServerStats(serverUrl: string): Promise<any> {
  try {
    const res = await fetch(`${serverUrl}/api/stats`, { signal: AbortSignal.timeout(2000) })
    return await res.json()
  } catch (_) {
    return null
  }
}

export async function generateNetworkReport(
  commandMetrics:  CommandMetrics,
  meterMetrics:    MeterMetrics,
  discovery:       DiscoveryResult | null,
  rttAvg:          number,
  rttP95:          number,
  startTime:       number,
): Promise<NetworkFullReport> {
  const issues: string[]          = []
  const recommendations: string[] = []
  const serverStats = discovery ? await fetchServerStats(discovery.url) : null

  const uptimeS = (Date.now() - startTime) / 1000
  const dropRate = commandMetrics.sent > 0
    ? (commandMetrics.dropped / commandMetrics.sent) * 100
    : 0

  if (!commandMetrics.connected)
    issues.push('[CRIT] Command channel disconnected')
  if (!meterMetrics.connected)
    issues.push('[WARN] Meter stream disconnected')
  if (dropRate > 5)
    issues.push(`[WARN] Command drop rate ${dropRate.toFixed(1)}% > 5% — check network congestion`)
  if (rttAvg > 50)
    issues.push(`[WARN] High RTT avg ${rttAvg}ms — network latency too high for live control`)
  if (rttP95 > 100)
    issues.push(`[WARN] RTT p95 ${rttP95}ms — sporadic latency spikes detected`)
  if (meterMetrics.fps < 15 && meterMetrics.connected)
    issues.push(`[WARN] Meter fps throttled to ${meterMetrics.fps}fps — connection may be congested`)
  if (commandMetrics.avgAckMs > 30)
    issues.push(`[WARN] Avg command ack ${commandMetrics.avgAckMs}ms — consider moving to /ctrl namespace`)

  if (issues.some(i => i.includes('drop rate')))
    recommendations.push('Enable ECO mode to reduce command frequency')
  if (rttAvg > 20)
    recommendations.push('Use 5GHz WiFi or ethernet for RTT < 10ms')
  if (!discovery?.hotspot)
    recommendations.push('Hotspot mode available: enable laptop hotspot for direct device connection')

  const maxClients = serverStats?.clients?.total
    ? Math.max(serverStats.clients.total, 10)
    : 10

  const hotspotViable = rttAvg < 20 && rttAvg > 0
  const criticals     = issues.filter(i => i.startsWith('[CRIT]')).length
  const warns         = issues.filter(i => i.startsWith('[WARN]')).length
  const verdict       = criticals > 0   ? 'poor'
    : warns > 3                          ? 'marginal'
    : warns > 0                          ? 'good'
    : 'excellent'

  return {
    timestamp:       new Date().toISOString(),
    serverUrl:       discovery?.url ?? null,
    hotspot:         discovery?.hotspot ?? false,
    uptimeS:         +uptimeS.toFixed(0),
    commandMetrics,
    meterMetrics,
    serverStats,
    rttAvgMs:        rttAvg,
    rttP95Ms:        rttP95,
    maxClients,
    hotspotViable,
    issues,
    recommendations,
    verdict,
  }
}

export function printNetworkReport(report: NetworkFullReport): void {
  const icon = { excellent: '✓', good: '◑', marginal: '⚠', poor: '✗' }[report.verdict]
  console.group(`${icon} [PASO 16] Network Report — ${report.verdict.toUpperCase()} — ${report.timestamp}`)

  console.log('\n=== Connection ===')
  console.log(`  Server:      ${report.serverUrl ?? 'not connected'}`)
  console.log(`  Hotspot:     ${report.hotspot ? 'YES' : 'no'}`)
  console.log(`  Uptime:      ${report.uptimeS}s`)
  console.log(`  RTT avg:     ${report.rttAvgMs}ms`)
  console.log(`  RTT p95:     ${report.rttP95Ms}ms`)

  console.log('\n=== Commands ===')
  console.table(report.commandMetrics)

  console.log('\n=== Meters ===')
  console.table(report.meterMetrics)

  if (report.serverStats) {
    console.log('\n=== Server Stats ===')
    console.log(`  Clients:     ${JSON.stringify(report.serverStats.clients)}`)
    console.log(`  Commands:    ${report.serverStats.commands?.totalCommands ?? 'n/a'}`)
    console.log(`  State paths: ${report.serverStats.state?.paths ?? 'n/a'}`)
  }

  console.log('\n=== Viability ===')
  console.log(`  Max clients:       ${report.maxClients}`)
  console.log(`  Hotspot viable:    ${report.hotspotViable ? 'YES (<20ms RTT)' : 'NO (high RTT)'}`)

  if (report.issues.length > 0) {
    console.log('\n=== Issues ===')
    report.issues.forEach(i => console.log(`  ${i}`))
  }
  if (report.recommendations.length > 0) {
    console.log('\n=== Recommendations ===')
    report.recommendations.forEach(r => console.log(`  → ${r}`))
  }

  console.groupEnd()
}
