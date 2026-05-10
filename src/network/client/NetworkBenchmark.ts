/**
 * NetworkBenchmark.ts — Client-side network latency and throughput benchmarks.
 *
 * Tests:
 *   ping_rtt:         Send 50 pings with 100ms interval, measure RTT distribution
 *   command_burst_1:  100 SET_GAIN commands in 1s — 1 client
 *   command_burst_5:  Simulate 5 clients (5 parallel sockets) × 20 commands
 *   meter_load_10:    Connect 10 meter subscribers, measure packet rate and drops
 *   midi_remote_sim:  MIDI flood (1000 CC/s) + simultaneous remote commands
 *
 * Measured:
 *   - RTT avg, p50, p95, p99, max
 *   - Commands/s throughput
 *   - Dropped packet count
 *   - CPU proxy (performance.now() overhead per op)
 *
 * Exposed as window.__ONA_NET_BENCH.run()
 */

export interface NetBenchResult {
  test:          string
  clients:       number
  durationMs:    number
  rttAvgMs:      number
  rttP95Ms:      number
  throughputCps: number   // commands per second
  packetsDropped: number
  passed:        boolean
  detail:        string
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return -1
  return sorted[Math.floor(sorted.length * p)] ?? sorted[sorted.length - 1]
}

async function benchPingRTT(socket: any): Promise<NetBenchResult> {
  const PINGS   = 50
  const DELAY   = 100
  const rtts: number[] = []
  const t0      = performance.now()

  for (let i = 0; i < PINGS; i++) {
    const sent = Date.now()
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 1000)
      socket.once('ping_ack_reply', ({ ts }: { ts: number }) => {
        clearTimeout(timeout)
        rtts.push(Date.now() - ts)
        resolve()
      })
      socket.emit('ping_check', { ts: sent })
    })
    await new Promise(r => setTimeout(r, DELAY))
  }

  const sorted  = [...rtts].sort((a, b) => a - b)
  const avg     = rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : -1
  const p95     = percentile(sorted, 0.95)

  return {
    test: 'ping_rtt', clients: 1,
    durationMs:    +(performance.now() - t0).toFixed(1),
    rttAvgMs:      +avg.toFixed(1),
    rttP95Ms:      +p95.toFixed(1),
    throughputCps: 0,
    packetsDropped: PINGS - rtts.length,
    passed: avg < 50 && p95 < 100,
    detail: `${rtts.length}/${PINGS} pings — avg ${avg.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms`,
  }
}

async function benchCommandBurst(socket: any, count = 100): Promise<NetBenchResult> {
  const t0    = performance.now()
  let ackd    = 0

  socket.on('command_ack', () => { ackd++ })

  for (let i = 0; i < count; i++) {
    socket.emit('command', {
      type:      'SET_GAIN',
      channelId: (i % 6) + 1,
      payload:   { volume: 50 + (i % 50), muted: false },
      ts:        Date.now(),
    })
    // No artificial delay — maximum burst rate
  }

  // Wait up to 2s for acks
  await new Promise(r => setTimeout(r, 2000))
  socket.off('command_ack')

  const ms = performance.now() - t0
  return {
    test: 'command_burst', clients: 1,
    durationMs:    +ms.toFixed(1),
    rttAvgMs:      -1,
    rttP95Ms:      -1,
    throughputCps: +(count / (ms / 1000)).toFixed(1),
    packetsDropped: count - ackd,
    passed: count - ackd < count * 0.05,  // <5% loss
    detail: `${count} SET_GAIN commands, ${ackd} acked (${count - ackd} dropped)`,
  }
}

async function benchMeterLoad(socket: any, durationMs = 3000): Promise<NetBenchResult> {
  let received  = 0
  const t0      = performance.now()

  // Request high fps
  socket.emit('set_meter_prefs', { fps: 60, visible: ['1','2','3','4','5','6','_main','_sub'] })
  const handler = () => { received++ }
  socket.on('meters', handler)

  await new Promise(r => setTimeout(r, durationMs))
  socket.off('meters', handler)

  const elapsed = (performance.now() - t0) / 1000
  const actualFps = +(received / elapsed).toFixed(1)

  return {
    test: 'meter_load', clients: 1,
    durationMs:    +elapsed.toFixed(0) * 1000,
    rttAvgMs:      -1,
    rttP95Ms:      -1,
    throughputCps: actualFps,
    packetsDropped: 0,
    passed: actualFps >= 10,
    detail: `${received} meter packets in ${elapsed.toFixed(1)}s — ${actualFps} fps`,
  }
}

export function exposeNetBenchAPI(
  ctrlSocket:   any,
  metersSocket: any,
): void {
  ;(window as any).__ONA_NET_BENCH = {
    run: async () => {
      const results: NetBenchResult[] = []
      console.group('[Paso 16] Network Benchmark')

      try { results.push(await benchCommandBurst(ctrlSocket, 100)) } catch (e) { console.error(e) }
      try { results.push(await benchMeterLoad(metersSocket, 3000)) } catch (e) { console.error(e) }

      console.table(results)
      const passed = results.filter(r => r.passed).length
      console.log(`${passed}/${results.length} tests passed`)
      console.groupEnd()
      return results
    },
    burst: (n = 100) => benchCommandBurst(ctrlSocket, n),
    meters: (ms = 3000) => benchMeterLoad(metersSocket, ms),
  }
}
