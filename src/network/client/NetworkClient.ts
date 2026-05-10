/**
 * NetworkClient.ts — Professional multi-namespace Socket.IO client.
 *
 * Replaces src/services/syncService.js with:
 *   - Three separate namespaces: /ctrl, /sync, /meters
 *   - Priority command routing (via CommandChannel)
 *   - Visibility-based meter subscription (via MeterSubscriber)
 *   - Auto-discovery + reconnect (via DiscoveryClient)
 *   - Offline command queue (via CommandChannel)
 *   - Delta sync on reconnect (request_delta event)
 *   - Full backwards compatibility: onCommand/sendCommand still work
 *
 * Failsafe:
 *   - Audio on host machine is NEVER affected by network state
 *   - NetworkClient is output-only: host → remotes (and remote → host for commands)
 *   - If all sockets disconnect, local DSP keeps running normally
 *   - On reconnect: delta sync replays missed commands automatically
 *
 * Usage:
 *   networkClient.connect('http://192.168.1.100:3000')
 *   networkClient.sendCommand('SET_GAIN', 1, { volume: 80, muted: false })
 *   networkClient.onCommand(cmd => { ... })
 *   networkClient.meters.onMeterUpdate(data => { ... })
 */

import { io }                 from 'socket.io-client'
import { CommandChannel }     from './CommandChannel'
import { MeterSubscriber }    from './MeterSubscriber'
import { discoveryClient }    from './DiscoveryClient'
import { exposeNetBenchAPI }  from './NetworkBenchmark'
import {
  generateNetworkReport,
  printNetworkReport,
} from './NetworkReport'
import type { CommandMetrics, MeterMetrics } from './NetworkReport'

type CommandCallback = (cmd: { type: string; channelId: number | null; payload: any; seq?: number; ts: number }) => void
type StateCallback   = (state: { seq: number; state: Record<string, any> }) => void

// Backwards-compat command type map (legacy → new)
const LEGACY_COMPAT: Record<string, string> = {
  SET_GAIN:        'SET_GAIN',
  SET_MUTE:        'SET_MUTE',
  SET_MAIN_VOL:    'SET_MAIN_VOL',
  SET_SUB_VOL:     'SET_SUB_VOL',
}

class NetworkClient {
  readonly channel  = new CommandChannel()
  readonly meters   = new MeterSubscriber()

  private _ctrlSocket:   any = null
  private _syncSocket:   any = null
  private _metersSocket: any = null

  private _cmdCbs    = new Set<CommandCallback>()
  private _stateCbs  = new Set<StateCallback>()
  private _rttSamples: number[] = []
  private _startTime  = 0
  private _lastSeq    = 0

  get connected(): boolean { return this.channel.connected }

  // ── Connection ────────────────────────────────────────────────────────────────

  connect(url = 'http://localhost:3000'): void {
    if (this._ctrlSocket?.connected) return

    this._startTime = Date.now()
    console.log(`[NetworkClient] connecting to ${url}`)

    const opts = {
      autoConnect:       true,
      reconnection:      true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket', 'polling'],
    }

    this._ctrlSocket   = io(`${url}/ctrl`,   opts)
    this._syncSocket   = io(`${url}/sync`,   opts)
    this._metersSocket = io(`${url}/meters`, opts)

    this._wireCtrSocket()
    this._wireSyncSocket()
    this.meters.attach(this._metersSocket)
    this.channel.attach(this._ctrlSocket, this._syncSocket)

    exposeNetBenchAPI(this._ctrlSocket, this._metersSocket)
  }

  async connectAuto(onProgress?: (tried: number, total: number) => void): Promise<boolean> {
    const result = await discoveryClient.discover(onProgress)
    if (!result) return false
    this.connect(result.url)
    return true
  }

  disconnect(): void {
    this._ctrlSocket?.disconnect()
    this._syncSocket?.disconnect()
    this._metersSocket?.disconnect()
    this._ctrlSocket   = null
    this._syncSocket   = null
    this._metersSocket = null
    this.meters.destroy()
  }

  // ── Command API (backwards compatible) ────────────────────────────────────────

  /**
   * Send a DSP command. Routes by priority automatically.
   * Equivalent to the old syncService.sendCommand().
   */
  sendCommand(type: string, channelId: number | null = null, payload: any = {}): void {
    this.channel.send(type, channelId, payload)
  }

  /**
   * Register callback for incoming commands from other clients.
   * Equivalent to the old syncService.onCommand().
   */
  onCommand(cb: CommandCallback): () => void {
    this._cmdCbs.add(cb)
    return () => this._cmdCbs.delete(cb)
  }

  /**
   * Register callback for full state sync (on connect/reconnect).
   */
  onStateSync(cb: StateCallback): () => void {
    this._stateCbs.add(cb)
    return () => this._stateCbs.delete(cb)
  }

  // ── Internal wiring ───────────────────────────────────────────────────────────

  private _wireCtrSocket(): void {
    this._ctrlSocket.on('connect', () => {
      console.log('[NetworkClient] /ctrl connected')
      // Request delta from last known sequence
      if (this._lastSeq > 0) {
        this._ctrlSocket.emit('request_delta', { fromSeq: this._lastSeq })
      }
    })

    this._ctrlSocket.on('disconnect', () => {
      console.warn('[NetworkClient] /ctrl disconnected')
    })

    this._ctrlSocket.on('command', (cmd: any) => {
      if (cmd.seq && cmd.seq > this._lastSeq) this._lastSeq = cmd.seq
      for (const cb of this._cmdCbs) { try { cb(cmd) } catch (_) {} }
    })

    this._ctrlSocket.on('command_log', (cmds: any[]) => {
      // Apply missed commands to local state
      const fresh = cmds.filter(c => c.seq > this._lastSeq)
      if (fresh.length > 0) {
        this._lastSeq = Math.max(...fresh.map(c => c.seq ?? 0))
        console.log(`[NetworkClient] replayed ${fresh.length} missed commands (delta)`)
      }
      for (const cmd of fresh) {
        for (const cb of this._cmdCbs) { try { cb(cmd) } catch (_) {} }
      }
    })

    this._ctrlSocket.on('state_full', (full: { seq: number; state: any }) => {
      console.log(`[NetworkClient] full state sync received (${Object.keys(full.state ?? {}).length} paths)`)
      this._lastSeq = full.seq
      for (const cb of this._stateCbs) { try { cb(full) } catch (_) {} }
    })

    // RTT measurement
    this._ctrlSocket.on('ping_check', ({ ts }: { ts: number }) => {
      const rtt = Date.now() - ts
      this._rttSamples.push(rtt)
      if (this._rttSamples.length > 100) this._rttSamples.shift()
      this._ctrlSocket.emit('ping_reply', { ts })
    })
  }

  private _wireSyncSocket(): void {
    this._syncSocket.on('command', (cmd: any) => {
      if (cmd.seq && cmd.seq > this._lastSeq) this._lastSeq = cmd.seq
      for (const cb of this._cmdCbs) { try { cb(cmd) } catch (_) {} }
    })
  }

  // ── Metrics ───────────────────────────────────────────────────────────────────

  getRTT() {
    if (this._rttSamples.length === 0) return { avg: -1, p95: -1, samples: 0 }
    const sorted = [...this._rttSamples].sort((a, b) => a - b)
    const avg    = this._rttSamples.reduce((a, b) => a + b, 0) / this._rttSamples.length
    const p95    = sorted[Math.floor(sorted.length * 0.95)]
    return { avg: +avg.toFixed(1), p95: +p95.toFixed(1), samples: this._rttSamples.length }
  }

  async getReport() {
    const rtt    = this.getRTT()
    const cmdM   = this.channel.getMetrics() as unknown as CommandMetrics
    const mtrM   = this.meters.getMetrics() as unknown as MeterMetrics
    const found  = discoveryClient.getLastFound()
    const report = await generateNetworkReport(cmdM, mtrM, found, rtt.avg, rtt.p95, this._startTime)
    printNetworkReport(report)
    return report
  }

  exposeConsoleAPI(): void {
    ;(window as any).__ONA_PASO16 = {
      connect:    (url?: string) => { this.connect(url ?? 'http://localhost:3000'); console.log(`[PASO 16] connecting to ${url ?? 'localhost:3000'}`) },
      connectAuto: async () => {
        console.log('[PASO 16] discovering server...')
        const ok = await this.connectAuto((tried, total) => console.log(`[PASO 16] probing ${tried}/${total}...`))
        console.log(ok ? `[PASO 16] connected: ${discoveryClient.getLastFound()?.url}` : '[PASO 16] server not found')
        return ok
      },
      disconnect: () => { this.disconnect(); console.log('[PASO 16] disconnected') },
      status:     () => {
        const rtt = this.getRTT()
        const m   = this.channel.getMetrics()
        console.group('[PASO 16] Network Status')
        console.log(`Connected: ${this.connected}`)
        console.log(`RTT: avg=${rtt.avg}ms p95=${rtt.p95}ms`)
        console.table(m)
        console.log('Meters:', this.meters.getMetrics())
        console.groupEnd()
        return { connected: this.connected, rtt, cmd: m, meters: this.meters.getMetrics() }
      },
      meters: {
        fps:     (n: number) => { this.meters.setFps(n); console.log(`[PASO 16] meter fps → ${n}`) },
        visible: (ids: string[]) => { this.meters.setVisible(ids); console.log(`[PASO 16] visible meters: ${ids.join(', ')}`) },
      },
      discovery: {
        scan:  async () => {
          const r = await discoveryClient.discover()
          if (r) { console.table(r) } else { console.warn('[PASO 16] no server found') }
          return r
        },
        manual: (url: string) => { discoveryClient.setManual(url); console.log(`[PASO 16] discovery manual: ${url}`) },
        clear:  () => { discoveryClient.clearCache(); console.log('[PASO 16] discovery cache cleared') },
      },
      report: () => this.getReport(),
      bench:  () => (window as any).__ONA_NET_BENCH?.run(),
      help: () => {
        console.group('[PASO 16] Console API — Network Control')
        console.log('__ONA_PASO16.connect("http://ip:3000")   — manual connect')
        console.log('__ONA_PASO16.connectAuto()               — auto-discover + connect')
        console.log('__ONA_PASO16.disconnect()                — disconnect all sockets')
        console.log('__ONA_PASO16.status()                    — RTT + command + meter metrics')
        console.log('__ONA_PASO16.meters.fps(25)              — set meter frame rate')
        console.log('__ONA_PASO16.meters.visible(["1","2"])   — set visible meter IDs')
        console.log('__ONA_PASO16.discovery.scan()            — scan LAN for server')
        console.log('__ONA_PASO16.discovery.manual("url")     — skip discovery')
        console.log('__ONA_PASO16.report()                    — full network report')
        console.log('__ONA_PASO16.bench()                     — network benchmark suite')
        console.groupEnd()
      },
    }
    console.log('[NetworkClient] Paso 16 API ready — window.__ONA_PASO16')
  }
}

export const networkClient = new NetworkClient()

// Backwards compatibility: syncService-compatible API
export const syncService = {
  get connected() { return networkClient.connected },
  connect: (url?: string) => networkClient.connect(url),
  disconnect: ()           => networkClient.disconnect(),
  sendCommand: (type: string, channelId: number | null, payload: any) =>
    networkClient.sendCommand(type, channelId, payload),
  onCommand: (cb: CommandCallback) => networkClient.onCommand(cb),
}

export default networkClient
