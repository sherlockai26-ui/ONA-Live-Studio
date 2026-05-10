/**
 * DiscoveryClient.ts — Auto-discover ONA server on LAN / hotspot.
 *
 * Discovery strategy (browser environment — no UDP):
 *   1. Try known/cached server URL (localStorage 'ona_server_url')
 *   2. Try localhost:3000 (same machine)
 *   3. Scan common LAN subnets via parallel fetch to /api/discover
 *      - 192.168.1.x, 192.168.0.x, 192.168.137.x (Windows hotspot)
 *      - 10.0.0.x, 172.16.0.x
 *   4. Try typical hotspot gateway IPs directly
 *
 * Each probe: fetch('/api/discover', timeout 500ms) — expects JSON with type='ONA_SERVER'
 *
 * Returns the first responding server's URL.
 * Caches successful URL in localStorage for fast reconnect.
 *
 * Manual: setManual(url) — skip discovery, always use this URL
 */

const PROBE_TIMEOUT_MS    = 500
const HOTSPOT_CANDIDATES  = [
  '192.168.137.1',  // Windows hotspot
  '192.168.2.1',    // macOS Internet Sharing
  '10.0.0.1',
  '172.16.0.1',
]
const SUBNET_SCAN_HOSTS   = [1, 100, 101, 102, 103, 200]
const CACHE_KEY           = 'ona_server_url'
const SERVER_PORT         = 3000

interface DiscoveryResult {
  url:      string
  name:     string
  version:  string
  hotspot:  boolean
  ips:      string[]
  clients:  number
}

async function probe(ip: string): Promise<DiscoveryResult | null> {
  const url = `http://${ip}:${SERVER_PORT}`
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res  = await fetch(`${url}/api/discover`, { signal: controller.signal })
    const json = await res.json()
    if (json?.type === 'ONA_SERVER') {
      return { url, name: json.name, version: json.version, hotspot: json.hotspot, ips: json.ips ?? [], clients: json.clients ?? 0 }
    }
  } catch (_) {
    // Not an ONA server at this address
  } finally {
    clearTimeout(timer)
  }
  return null
}

function buildCandidates(): string[] {
  const candidates = new Set<string>()

  // Cached URL from previous session
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached) candidates.add(cached.replace(/^https?:\/\//, '').replace(/:.*$/, ''))
  } catch (_) {}

  // Localhost
  candidates.add('localhost')
  candidates.add('127.0.0.1')

  // Hotspot gateways
  for (const ip of HOTSPOT_CANDIDATES) candidates.add(ip)

  // Subnet scan based on current page hostname (if running from LAN)
  try {
    const host = window.location.hostname
    if (host && host !== 'localhost') {
      const parts = host.split('.')
      if (parts.length === 4) {
        const base = parts.slice(0, 3).join('.')
        for (const h of SUBNET_SCAN_HOSTS) candidates.add(`${base}.${h}`)
      }
    }
  } catch (_) {}

  // Common private subnets scan
  for (const prefix of ['192.168.1', '192.168.0', '10.0.0', '172.16.0']) {
    for (const h of SUBNET_SCAN_HOSTS) candidates.add(`${prefix}.${h}`)
  }

  return [...candidates]
}

class DiscoveryClient {
  private _manual:   string | null     = null
  private _lastFound: DiscoveryResult | null = null
  private _onFound: ((result: DiscoveryResult) => void) | null = null

  onFound(cb: (result: DiscoveryResult) => void): void { this._onFound = cb }

  /** Skip discovery and always use this URL */
  setManual(url: string): void { this._manual = url }

  /**
   * Run discovery. Probes candidates in parallel batches of 8.
   * Resolves with the first responding server, or null if none found.
   */
  async discover(onProgress?: (tried: number, total: number) => void): Promise<DiscoveryResult | null> {
    if (this._manual) {
      const r = await probe(this._manual.replace(/^https?:\/\//, '').replace(/:.*$/, ''))
      if (r) { this._lastFound = r; this._persist(r.url); this._onFound?.(r) }
      return r
    }

    const candidates = buildCandidates()
    const BATCH      = 8
    let tried        = 0

    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch   = candidates.slice(i, i + BATCH)
      const results = await Promise.all(batch.map(ip => probe(ip)))
      tried += batch.length
      onProgress?.(tried, candidates.length)

      const found = results.find(r => r !== null)
      if (found) {
        this._lastFound = found
        this._persist(found.url)
        this._onFound?.(found)
        console.log(`[Discovery] server found: ${found.url} ("${found.name}")`)
        return found
      }
    }

    console.warn('[Discovery] no ONA server found on LAN')
    return null
  }

  private _persist(url: string): void {
    try { localStorage.setItem(CACHE_KEY, url) } catch (_) {}
  }

  getLastFound(): DiscoveryResult | null { return this._lastFound }

  clearCache(): void {
    try { localStorage.removeItem(CACHE_KEY) } catch (_) {}
    this._lastFound = null
  }
}

export const discoveryClient = new DiscoveryClient()
export type { DiscoveryResult }
