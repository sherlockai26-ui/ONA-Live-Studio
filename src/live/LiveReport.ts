/**
 * LiveReport.ts — Live readiness report for professional show operation.
 *
 * Sections:
 *   1. Scene system (count, cue list, undo available)
 *   2. Recall stability (from bench results or estimated)
 *   3. Transition safety (pop count, profile used)
 *   4. DCA / mute group config
 *   5. Safe channel coverage
 *   6. Show file status (loaded, autosave running)
 *   7. Remote sync status
 *   8. Issues + recommendations
 *   9. Use-case verdicts: festival / church / broadcast / theatre / touring
 */

import { sceneEngine }       from './SceneEngine'
import { transitionEngine }  from './TransitionEngine'
import { dcaEngine }         from './DCAEngine'
import { channelSafeSystem } from './ChannelSafeSystem'
import { showFileEngine }    from './ShowFileEngine'
import { remoteSyncBridge }  from './RemoteSyncBridge'
import { recallValidator }   from './RecallValidator'
import type { LiveBenchResult } from './LiveBenchmark'

export interface LiveUseCaseVerdict {
  festival:  'ready' | 'marginal' | 'not-ready'
  church:    'ready' | 'marginal' | 'not-ready'
  broadcast: 'ready' | 'marginal' | 'not-ready'
  theatre:   'ready' | 'marginal' | 'not-ready'
  touring:   'ready' | 'marginal' | 'not-ready'
}

export interface LiveFullReport {
  timestamp:        string
  sceneMeta:        ReturnType<typeof sceneEngine.getState>
  showMeta:         ReturnType<typeof showFileEngine.getMeta>
  transitionMeta:   ReturnType<typeof transitionEngine.getMetrics>
  safeState:        ReturnType<typeof channelSafeSystem.getState>
  remoteMeta:       ReturnType<typeof remoteSyncBridge.getMetrics>
  dcaGroups:        number
  activeMuteGroups: number
  benchResults?:    LiveBenchResult[]
  avgRecallMs:      number
  maxRecallMs:      number
  popCount:         number
  issues:           string[]
  recommendations:  string[]
  useCaseVerdict:   LiveUseCaseVerdict
  verdict:          'excellent' | 'good' | 'marginal' | 'poor'
}

export async function generateLiveReport(benchResults?: LiveBenchResult[]): Promise<LiveFullReport> {
  const issues: string[]          = []
  const recommendations: string[] = []

  const sceneMeta    = sceneEngine.getState()
  const showMeta     = showFileEngine.getMeta()
  const transition   = transitionEngine.getMetrics()
  const safeState    = channelSafeSystem.getState()
  const remoteMeta   = remoteSyncBridge.getMetrics()
  const dcaGroups    = dcaEngine.getAllDCAs().filter(d => d.members.length > 0).length
  const activeMutes  = dcaEngine.getAllMuteGroups().filter(g => g.active).length
  const popCount     = transitionEngine.getPopLog().length

  // Derive recall metrics from bench or defaults
  let avgRecallMs = -1, maxRecallMs = -1
  if (benchResults) {
    const speedBench = benchResults.find(r => r.test === 'recall_speed')
    if (speedBench && speedBench.avgMs >= 0) {
      avgRecallMs = speedBench.avgMs
      maxRecallMs = speedBench.maxMs
    }
  }

  // Issues
  if (sceneMeta.sceneCount === 0)
    issues.push('[CRIT] No scenes saved — create scenes before the show')
  if (sceneMeta.sceneCount < 3)
    issues.push('[WARN] Less than 3 scenes — typical shows need 5–20')
  if (safeState.safeChannels.length === 0)
    issues.push('[WARN] No safe channels defined — talkback/livestream/recording may be disrupted by recalls')
  if (popCount > 0)
    issues.push(`[WARN] ${popCount} pops detected during transitions — use "smooth" profile`)
  if (transition.profile === 'instant')
    issues.push('[WARN] Transition profile is "instant" — risk of audio pops during recall')
  if (avgRecallMs > 100)
    issues.push(`[WARN] Avg recall time ${avgRecallMs}ms — above 100ms (may feel slow for live operation)`)
  if (dcaGroups === 0)
    recommendations.push('Configure DCA groups for efficient level management (VCA-style control)')
  if (showMeta.name === 'Untitled Show')
    recommendations.push('Set show name, venue, and engineer info for documentation')
  if (!remoteMeta.hasBroadcast)
    recommendations.push('Wire RemoteSyncBridge to NetworkServer for multi-device recall sync')
  if (avgRecallMs > 0 && avgRecallMs < 100)
    recommendations.push(`Recall speed ${avgRecallMs}ms — well within live operation requirements`)

  // Use-case verdicts
  const crit  = issues.filter(i => i.startsWith('[CRIT]')).length
  const warns = issues.filter(i => i.startsWith('[WARN]')).length

  const baseVerdict = crit > 0 ? 'poor' : warns > 3 ? 'marginal' : warns > 0 ? 'good' : 'excellent'

  const useCaseVerdict: LiveUseCaseVerdict = {
    // Festival: needs many scenes, fast recall, DCA groups
    festival: crit > 0 ? 'not-ready'
      : (sceneMeta.sceneCount >= 5 && dcaGroups >= 2 && avgRecallMs < 80) ? 'ready' : 'marginal',

    // Church: needs safe channels, reliable recall, show file
    church: crit > 0 ? 'not-ready'
      : (safeState.safeChannels.length >= 1 && sceneMeta.sceneCount >= 3) ? 'ready' : 'marginal',

    // Broadcast: no pops, safe channels critical, reliable
    broadcast: crit > 0 || popCount > 0 ? 'not-ready'
      : (safeState.safeChannels.length >= 2 && transition.profile !== 'instant') ? 'ready' : 'marginal',

    // Theatre: needs cue list, stagger transitions, many scenes
    theatre: crit > 0 ? 'not-ready'
      : (sceneMeta.cueList.length >= 5 && transition.profile === 'slow' || transition.profile === 'smooth') ? 'ready' : 'marginal',

    // Touring: needs show file, DCA groups, full scene system, remote sync
    touring: crit > 0 ? 'not-ready'
      : (sceneMeta.sceneCount >= 10 && dcaGroups >= 4 && remoteMeta.hasBroadcast) ? 'ready' : 'marginal',
  }

  return {
    timestamp:        new Date().toISOString(),
    sceneMeta,
    showMeta,
    transitionMeta:   transition,
    safeState,
    remoteMeta,
    dcaGroups,
    activeMuteGroups: activeMutes,
    benchResults,
    avgRecallMs,
    maxRecallMs,
    popCount,
    issues,
    recommendations,
    useCaseVerdict,
    verdict: baseVerdict,
  }
}

export function printLiveReport(report: LiveFullReport): void {
  const icon = { excellent: '✓', good: '◑', marginal: '⚠', poor: '✗' }[report.verdict]
  console.group(`${icon} [Paso 18] Live Show Report — ${report.verdict.toUpperCase()} — ${report.timestamp}`)

  console.log('\n=== Show File ===')
  console.log(`  Name:      ${report.showMeta.name}`)
  console.log(`  Venue:     ${report.showMeta.venue || '(not set)'}`)
  console.log(`  Engineer:  ${report.showMeta.engineer || '(not set)'}`)

  console.log('\n=== Scene System ===')
  console.log(`  Scenes:     ${report.sceneMeta.sceneCount}`)
  console.log(`  Cue list:   ${report.sceneMeta.cueList.length} entries`)
  console.log(`  Current:    ${report.sceneMeta.currentCue ?? '(none)'}`)
  console.log(`  Transition: ${report.transitionMeta.profile}`)
  console.log(`  Pops:       ${report.popCount}`)

  if (report.avgRecallMs >= 0) {
    console.log('\n=== Recall Performance ===')
    console.log(`  Avg: ${report.avgRecallMs}ms  Max: ${report.maxRecallMs}ms`)
  }

  console.log('\n=== DCA / Mute Groups ===')
  console.log(`  DCA groups configured: ${report.dcaGroups}/8`)
  console.log(`  Active mute groups:    ${report.activeMuteGroups}/8`)
  console.log(`  Safe channels:         ${report.safeState.safeChannels.length}`)
  if (report.safeState.safeChannels.length > 0) {
    report.safeState.safeChannels.forEach(c =>
      console.log(`    ch${c.channelId}: ${c.label} [${c.mode}]`)
    )
  }

  console.log('\n=== Remote Sync ===')
  console.log(`  Attached: ${report.remoteMeta.hasBroadcast}`)
  console.log(`  Seq:      ${report.remoteMeta.seq}`)

  if (report.benchResults) {
    console.log('\n=== Benchmark ===')
    console.table(report.benchResults.map(r => ({
      test: r.test, avg: r.avgMs, max: r.maxMs, errors: r.errors, pops: r.pops, passed: r.passed,
    })))
  }

  console.log('\n=== Use-Case Readiness ===')
  Object.entries(report.useCaseVerdict).forEach(([uc, v]) => {
    const ucIcon = v === 'ready' ? '✓' : v === 'marginal' ? '⚠' : '✗'
    console.log(`  ${ucIcon} ${uc.padEnd(10)}: ${v}`)
  })

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
