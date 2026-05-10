/**
 * @deprecated LEGACY — Reemplazado por src/network/client/NetworkClient.ts (Paso 16)
 *
 * Este módulo NO está importado activamente. Se conserva por referencia histórica.
 * NO usar en código nuevo. Para sync de red usar:
 *   import networkClient from '../network/client/NetworkClient'
 *   import { syncService } from '../network/client/NetworkClient'  // compat API
 *
 * Clasificación: LEGACY-D (probablemente removible tras confirmar no hay imports)
 *
 * syncService.js — Command-based Socket.IO client for ONA Live Studio.
 *
 * Architecture (Paso 5 refactor):
 *   BEFORE: emit full state diffs, receive full state objects
 *   AFTER:  emit typed commands, receive typed commands
 *
 * Commands are small (type + channelId + payload) — no full state syncs.
 * Server broadcasts each command to all connected clients.
 *
 * Command types match DSP operations 1:1:
 *   SET_GAIN, SET_MUTE, SET_PAN, SET_ROUTING
 *   SET_HPF, SET_GATE, SET_COMPRESSOR, SET_EQ
 *   SET_REVERB_SEND, SET_DELAY_SEND
 *   SET_MAIN_VOL, SET_SUB_VOL, SET_FX
 *   LOAD_SCENE, SAVE_SCENE
 *
 * Usage:
 *   syncService.connect()
 *   syncService.sendCommand('SET_GAIN', 1, { volume: 80, muted: false })
 *   syncService.onCommand(({ type, channelId, payload }) => { ... })
 */

import { io } from 'socket.io-client'

export const SYNC_COMMANDS = /** @type {const} */ ({
  SET_GAIN:        'SET_GAIN',
  SET_MUTE:        'SET_MUTE',
  SET_PAN:         'SET_PAN',
  SET_ROUTING:     'SET_ROUTING',
  SET_HPF:         'SET_HPF',
  SET_GATE:        'SET_GATE',
  SET_COMPRESSOR:  'SET_COMPRESSOR',
  SET_EQ:          'SET_EQ',
  SET_REVERB_SEND: 'SET_REVERB_SEND',
  SET_DELAY_SEND:  'SET_DELAY_SEND',
  SET_MAIN_VOL:    'SET_MAIN_VOL',
  SET_SUB_VOL:     'SET_SUB_VOL',
  SET_FX:          'SET_FX',
  LOAD_SCENE:      'LOAD_SCENE',
  SAVE_SCENE:      'SAVE_SCENE',
})

class SyncService {
  #socket  = null
  #cmdCbs  = new Set()
  connected = false

  connect(url = 'http://localhost:3000') {
    if (this.#socket) return
    this.#socket = io(url, { autoConnect: true, reconnectionDelay: 2000 })
    this.#socket.on('connect',    () => { this.connected = true  })
    this.#socket.on('disconnect', () => { this.connected = false })

    // Receive commands from server (broadcast from other clients)
    this.#socket.on('command', (cmd) => {
      this.#cmdCbs.forEach(cb => { try { cb(cmd) } catch (_) {} })
    })
  }

  disconnect() {
    this.#socket?.disconnect()
    this.#socket  = null
    this.connected = false
  }

  /**
   * sendCommand — emit a typed DSP command to all connected clients.
   * @param {string} type — one of SYNC_COMMANDS values
   * @param {number|null} channelId — channel (1-based) or null for global ops
   * @param {any} payload — command-specific data
   */
  sendCommand(type, channelId = null, payload = {}) {
    if (!this.#socket?.connected) return
    this.#socket.emit('command', { type, channelId, payload, ts: Date.now() })
  }

  /**
   * onCommand — register callback for incoming commands.
   * @param {function} cb — called with { type, channelId, payload, ts }
   * @returns {function} unsubscribe
   */
  onCommand(cb) {
    this.#cmdCbs.add(cb)
    return () => this.#cmdCbs.delete(cb)
  }
}

export const syncService = new SyncService()
