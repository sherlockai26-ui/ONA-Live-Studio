/**
 * server/index.js — Socket.IO server for ONA Live Studio (command-based).
 *
 * Architecture (Paso 5 refactor):
 *   BEFORE: receives 'update' (partial state), broadcasts full state
 *   AFTER:  receives 'command' (typed DSP op), broadcasts same command to all
 *
 * Benefits:
 *   - No full-state serialization per change
 *   - Commands are small (type + channelId + payload)
 *   - Command log enables crash recovery / replay
 *   - Stateless server — no more mixerState object to keep in sync
 *
 * On new connection: server sends last 100 commands for state reconstruction.
 */

import express    from 'express'
import http       from 'http'
import { Server } from 'socket.io'

const app    = express()
const server = http.createServer(app)
const io     = new Server(server, { cors: { origin: '*' } })

// ── Command log — replay for new connections ──────────────────────────────────

const MAX_LOG    = 1000
const commandLog = []

const VALID_TYPES = new Set([
  'SET_GAIN', 'SET_MUTE', 'SET_PAN', 'SET_ROUTING',
  'SET_HPF', 'SET_GATE', 'SET_COMPRESSOR', 'SET_EQ',
  'SET_REVERB_SEND', 'SET_DELAY_SEND',
  'SET_MAIN_VOL', 'SET_SUB_VOL', 'SET_FX',
  'LOAD_SCENE', 'SAVE_SCENE',
])

// ── Socket events ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[ONA] Dispositivo conectado: ${socket.id} (total: ${io.engine.clientsCount})`)

  // Send recent command log so new client can reconstruct current state
  const recent = commandLog.slice(-100)
  if (recent.length > 0) {
    socket.emit('command_log', recent)
  }

  socket.on('command', (cmd) => {
    // Validate command type
    if (!cmd || !VALID_TYPES.has(cmd.type)) {
      console.warn(`[ONA] Comando desconocido: ${cmd?.type}`)
      return
    }

    // Append to log (oldest evicted when full)
    commandLog.push(cmd)
    if (commandLog.length > MAX_LOG) commandLog.shift()

    // Broadcast to ALL clients (including sender — for multi-instance ack)
    io.emit('command', cmd)

    if (process.env.ONA_VERBOSE) {
      console.log(`[CMD] ${cmd.type} ch${cmd.channelId ?? '-'}`)
    }
  })

  // Client requests full log (e.g., after reconnect)
  socket.on('request_log', () => {
    socket.emit('command_log', commandLog.slice(-100))
  })

  socket.on('disconnect', () => {
    console.log(`[ONA] Dispositivo desconectado: ${socket.id}`)
  })
})

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    clients:  io.engine.clientsCount,
    commands: commandLog.length,
  })
})

server.listen(3000, '0.0.0.0', () => {
  console.log('[ONA] Server corriendo en puerto 3000')
})
