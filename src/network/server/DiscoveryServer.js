/**
 * DiscoveryServer.js — LAN discovery + hotspot support.
 *
 * Discovery strategy:
 *   1. HTTP endpoint GET /api/discover — returns server identity JSON
 *   2. HTTP endpoint GET /api/clients  — returns connected client count (for UX)
 *   3. Periodic UDP broadcast on LAN port 3001 (if dgram available)
 *      → broadcasts { type: 'ONA_SERVER', host, port, name, version }
 *   4. mDNS-style: /api/discover also returns local IP addresses
 *
 * Hotspot mode:
 *   Windows hotspot default gateway: 192.168.137.1
 *   macOS: 192.168.2.1 (Internet Sharing)
 *   Clients scan common hotspot IPs if LAN discovery fails.
 *   Server announces hotspot mode via { hotspot: true } in discovery payload.
 *
 * Session persistence:
 *   Server stores session ID in memory. Clients that reconnect with the same
 *   sessionId get their last-known sequence for delta replay.
 */

import os   from 'os'
import dgram from 'dgram'

const DISCOVERY_PORT       = 3001
const BROADCAST_INTERVAL   = 3000
const SESSION_VERSION      = '16'

/** @returns {string[]} All non-loopback IPv4 addresses */
function getLocalIPs() {
  const ifaces = os.networkInterfaces()
  const ips    = []
  for (const list of Object.values(ifaces)) {
    for (const iface of (list ?? [])) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
    }
  }
  return ips
}

function isHotspotIP(ip) {
  return ip.startsWith('192.168.137.') || ip.startsWith('192.168.2.')
}

export class DiscoveryServer {
  _udpSocket  = null
  _broadcastTimer = null
  _clientMgr  = null
  _port       = 3000
  _name       = 'ONA Live Studio'

  /**
   * @param {import('express').Application} app
   * @param {import('./ClientManager.js').ClientManager} clientManager
   * @param {number} serverPort
   */
  attach(app, clientManager, serverPort = 3000) {
    this._clientMgr = clientManager
    this._port      = serverPort

    const ips    = getLocalIPs()
    const hotspot = ips.some(isHotspotIP)

    const payload = () => ({
      type:     'ONA_SERVER',
      name:     this._name,
      version:  SESSION_VERSION,
      port:     this._port,
      ips,
      hotspot,
      clients:  clientManager.count(),
      ts:       Date.now(),
    })

    // HTTP discovery endpoint
    app.get('/api/discover', (_req, res) => {
      res.json(payload())
    })

    // HTTP health + client count
    app.get('/api/clients', (_req, res) => {
      res.json({ count: clientManager.count(), stats: clientManager.getStats() })
    })

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', ...payload() })
    })

    // UDP broadcast for LAN auto-discovery
    try {
      this._udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      this._udpSocket.bind(() => {
        try { this._udpSocket.setBroadcast(true) } catch (_) {}
        this._broadcastTimer = setInterval(() => {
          const msg = Buffer.from(JSON.stringify(payload()))
          this._udpSocket.send(msg, DISCOVERY_PORT, '255.255.255.255', (err) => {
            if (err) console.debug('[Discovery] UDP broadcast error:', err.message)
          })
        }, BROADCAST_INTERVAL)
      })
      console.log(`[Discovery] UDP broadcast active on port ${DISCOVERY_PORT}`)
    } catch (err) {
      console.warn('[Discovery] UDP socket unavailable:', err.message)
    }
  }

  setName(name) { this._name = name }

  destroy() {
    clearInterval(this._broadcastTimer)
    try { this._udpSocket?.close() } catch (_) {}
  }
}
