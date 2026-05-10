const { app, BrowserWindow, ipcMain, session, dialog } = require('electron')
const path = require('path')
const fs   = require('fs')

// ── Safe Mode — activar con: electron . --safe-mode ──────────────────────────
const SAFE_MODE = process.argv.includes('--safe-mode')
if (SAFE_MODE) console.log('[ONA MAIN] Safe Mode activo — DSP desactivado')

// ── Crash Logging industrial — main process ───────────────────────────────────
// Los logs van a Documentos/ONA Live Studio/Logs/crash_YYYY-MM-DD.log
// fs.appendFileSync es síncrono a propósito: en handlers de excepción el event
// loop está a punto de cerrarse y las escrituras async nunca terminarían.

function _getLogDir() {
  try { return path.join(app.getPath('documents'), 'ONA Live Studio', 'Logs') }
  catch (_) { return path.join(__dirname, '..', 'logs') }
}

function writeCrashLog(type, msg) {
  try {
    const dir  = _getLogDir()
    fs.mkdirSync(dir, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const file = path.join(dir, `crash_${date}.log`)
    const line = `[${new Date().toISOString()}] [${type}] ${msg}\n`
    fs.appendFileSync(file, line, 'utf-8')
    console.error('[ONA CRASH]', type, msg.slice(0, 200))
  } catch (_) { /* si no podemos escribir el log, al menos lo vemos en consola */ }
}

// Crasheos no capturados en el proceso principal
process.on('uncaughtException', (err) => {
  writeCrashLog('MAIN_CRASH', err.stack ?? err.message ?? String(err))
})

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  writeCrashLog('MAIN_REJECTION', msg)
})

// ── GPU: deshabilitar solo el rendering, NO el pipeline de audio ──────────────
// app.disableHardwareAcceleration() deshabilita también el proceso de audio
// del GPU en Windows (WASAPI routing), lo que rompe WebAudio/Tone.js.
// Usamos switches específicos de Chromium para deshabilitar solo lo visual:
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-gpu-rasterization')
app.commandLine.appendSwitch('disable-software-rasterizer')

// SharedArrayBuffer: habilitar en contexto desktop sin requerir COOP/COEP
// Necesario para el SAB de metering en AudioEngineSingleton.ts
app.commandLine.appendSwitch('enable-features', 'SharedArrayBufferOnDesktop')

// WebAudio: permitir AudioContext sin gesto previo del usuario
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// ─────────────────────────────────────────────────────────────────────────────
function getDocsDir(...parts) {
  return path.join(app.getPath('documents'), 'ONA Live Studio', ...parts)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function createWindow() {
  // ── Permisos de media ───────────────────────────────────────────────────────
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' || permission === 'audioCapture')
  })

  // ── CSP permisivo vía webRequest ────────────────────────────────────────────
  // Tone.js y WebAudio necesitan:
  //   script-src  'unsafe-eval'  → Tone.js usa eval en algunos paths
  //   worker-src  blob:          → AudioWorklets se cargan como blob URLs
  //   connect-src ws://localhost → Vite HMR + Socket.IO
  //   media-src   mediastream:   → getUserMedia streams
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
            "worker-src 'self' blob:",
            "connect-src 'self' blob: ws://localhost:* wss://localhost:* http://localhost:* http://localhost:3000",
            "media-src 'self' blob: mediastream:",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
          ].join('; ')
        ],
      },
    })
  })

  const win = new BrowserWindow({
    width: 1400, height: 850,
    minWidth: 1100, minHeight: 650,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
      // webSecurity en true — el CSP lo controlamos vía webRequest arriba
      additionalArguments: SAFE_MODE ? ['--safe-mode'] : [],
    },
  })

  // ── DevTools automático en dev ───────────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  // ── Crash handler — NO auto-reload (causaba el crash-loop) ──────────────────
  win.webContents.on('render-process-gone', (event, details) => {
    const msg = `reason=${details.reason} exitCode=${details.exitCode}`
    writeCrashLog('RENDERER_GONE', msg)
    console.error('[ONA] render-process-gone:', msg)
    console.error('[ONA] Recarga manual: Ctrl+R en la ventana, o reinicia con npm run dev.')
  })

  win.webContents.on('crashed', (event, killed) => {
    writeCrashLog('RENDERER_CRASHED', `killed=${killed}`)
  })

  // ── URL — safe mode pasa como query param ────────────────────────────────────
  const devUrl = SAFE_MODE
    ? 'http://localhost:5173?safeMode=1'
    : 'http://localhost:5173'

  win.loadURL(devUrl)
}

// ── IPC — Crash log desde renderer ───────────────────────────────────────────
ipcMain.on('crash-log', (_, msg) => {
  writeCrashLog('RENDERER', String(msg).slice(0, 2000))
})

// ── IPC — Native audio probe (Paso 3 — ASIO/WASAPI/CoreAudio) ─────────────────
// Intenta cargar naudiodon en el proceso principal (donde node-gyp sí puede compilar).
// Si no está instalado devuelve { available: false }.
// Para instalar: npm install naudiodon (requiere node-gyp y compilación nativa)
ipcMain.handle('native-audio-probe', async () => {
  try {
    const naudiodon = require('naudiodon')
    const devices   = naudiodon.getDevices() ?? []
    return {
      available: true,
      devices:   devices.map(d => ({
        id:                d.id,
        name:              d.name,
        maxInputChannels:  d.maxInputChannels,
        maxOutputChannels: d.maxOutputChannels,
        defaultSampleRate: d.defaultSampleRate,
        isDefaultInput:    d.isDefaultInput  ?? false,
        isDefaultOutput:   d.isDefaultOutput ?? false,
      })),
    }
  } catch (_) {
    return { available: false, devices: [] }
  }
})

// ── Grabación (legacy — buffer completo en RAM) ───────────────────────────────
ipcMain.handle('save-recording', async (_, arrayBuffer, filename) => {
  const today = new Date().toISOString().slice(0, 10)
  const dir   = ensureDir(getDocsDir(`Session_${today}`))
  const fp    = path.join(dir, filename)
  fs.writeFileSync(fp, Buffer.from(arrayBuffer))
  return fp
})

ipcMain.handle('get-recordings-dir', async () => {
  const today = new Date().toISOString().slice(0, 10)
  return ensureDir(getDocsDir(`Session_${today}`))
})

// ── Grabación multipista streaming (Paso 10) ──────────────────────────────────
//
// Protocolo de 3 fases:
//   1. recording:create-session  — crea directorio + abre fd por canal, escribe header WAV placeholder
//   2. recording:write-chunk     — fs.writeSync append de bloques PCM 24-bit
//   3. recording:finalize-session — cierra fds, parchea sizes en header WAV (offset 4 y 40)
//
// El header WAV se escribe con sizes=0 al inicio y se actualiza al final porque
// no conocemos el tamaño total hasta que la grabación termina.

/** Map: sessionId → { dir, fds: Map<channelId, {fd, path, pos}>, sampleRate, channels, startTime } */
const _activeSessions = new Map()

/** Build a 44-byte WAV header Buffer with the given sizes (may be 0 for placeholder). */
function buildWavHeaderBuf(sampleRate, numChannels, dataSize) {
  const bps        = 24
  const byteRate   = sampleRate * numChannels * (bps / 8)
  const blockAlign = numChannels * (bps / 8)
  const buf        = Buffer.alloc(44)
  buf.write('RIFF', 0);                      buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12);                     buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)                   // PCM
  buf.writeUInt16LE(numChannels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bps, 34)
  buf.write('data', 36);                     buf.writeUInt32LE(dataSize, 40)
  return buf
}

ipcMain.handle('recording:create-session', async (_, channels, sampleRate) => {
  const today     = new Date().toISOString().slice(0, 10)
  const sessionId = `session_${Date.now()}`
  const dir       = ensureDir(getDocsDir(`Session_${today}`, sessionId))

  const fds = new Map()
  for (const channelId of channels) {
    const fp  = path.join(dir, `ch${channelId}.wav`)
    const fd  = fs.openSync(fp, 'w')
    const hdr = buildWavHeaderBuf(sampleRate, 1, 0)  // placeholder sizes
    fs.writeSync(fd, hdr, 0, hdr.length, 0)
    fds.set(channelId, { fd, path: fp, pos: 44 })
  }

  _activeSessions.set(sessionId, { dir, fds, sampleRate, channels, startTime: Date.now() })
  return sessionId
})

ipcMain.handle('recording:write-chunk', async (_, sessionId, channelId, arrayBuffer) => {
  const sess = _activeSessions.get(sessionId)
  if (!sess) return false
  const entry = sess.fds.get(channelId)
  if (!entry) return false
  const buf = Buffer.from(arrayBuffer)
  fs.writeSync(entry.fd, buf, 0, buf.length, entry.pos)
  entry.pos += buf.length
  return true
})

ipcMain.handle('recording:finalize-session', async (_, sessionId, latencyInfo) => {
  const sess = _activeSessions.get(sessionId)
  if (!sess) return { files: [] }

  const files = []
  for (const [, entry] of sess.fds) {
    const dataSize = entry.pos - 44   // bytes written after the 44-byte header
    // Patch RIFF chunk size at offset 4
    const riffBuf = Buffer.alloc(4);  riffBuf.writeUInt32LE(36 + dataSize, 0)
    fs.writeSync(entry.fd, riffBuf, 0, 4, 4)
    // Patch data chunk size at offset 40
    const dataBuf = Buffer.alloc(4);  dataBuf.writeUInt32LE(dataSize, 0)
    fs.writeSync(entry.fd, dataBuf, 0, 4, 40)
    fs.closeSync(entry.fd)
    files.push(entry.path)
  }

  const meta = {
    sessionId,
    channels:   sess.channels,
    sampleRate: sess.sampleRate,
    startTime:  sess.startTime,
    latency:    latencyInfo ?? null,
  }
  fs.writeFileSync(path.join(sess.dir, 'session.json'), JSON.stringify(meta, null, 2), 'utf-8')
  _activeSessions.delete(sessionId)
  return { files, meta }
})

ipcMain.handle('recording:list-sessions', async () => {
  const baseDir = getDocsDir()
  if (!fs.existsSync(baseDir)) return []
  const sessions = []
  for (const entry of fs.readdirSync(baseDir)) {
    const metaPath = path.join(baseDir, entry, 'session.json')
    if (!fs.existsSync(metaPath)) continue
    try {
      const meta  = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      const files = fs.readdirSync(path.join(baseDir, entry)).filter(f => f.endsWith('.wav'))
      sessions.push({ ...meta, dir: path.join(baseDir, entry), files })
    } catch (_) {}
  }
  return sessions.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
})

ipcMain.handle('recording:load-file', async (_, filePath) => {
  if (!fs.existsSync(filePath)) return null
  const buf = fs.readFileSync(filePath)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
})

// ── Escenas ──────────────────────────────────────────────────────────────────
ipcMain.handle('scenes-save', async (_, name, json) => {
  const dir = ensureDir(getDocsDir('Scenes'))
  const fp  = path.join(dir, `${name}.json`)
  fs.writeFileSync(fp, json, 'utf-8')
  return fp
})

ipcMain.handle('scenes-list', async () => {
  const dir = getDocsDir('Scenes')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const fp   = path.join(dir, f)
      const stat = fs.statSync(fp)
      return { name: f.replace('.json', ''), modified: stat.mtimeMs }
    })
    .sort((a, b) => b.modified - a.modified)
})

ipcMain.handle('scenes-load', async (_, name) => {
  const fp = path.join(getDocsDir('Scenes'), `${name}.json`)
  return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : null
})

ipcMain.handle('scenes-delete', async (_, name) => {
  const fp = path.join(getDocsDir('Scenes'), `${name}.json`)
  if (fs.existsSync(fp)) fs.unlinkSync(fp)
})

// ── Virtual Soundcheck ────────────────────────────────────────────────────────
ipcMain.handle('show-open-dialog', async (_, opts = {}) => {
  const result = await dialog.showOpenDialog({
    title:      opts.title ?? 'Seleccionar audio',
    filters:    [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'aac'] }],
    properties: ['openFile', ...(opts.multiSelections ? ['multiSelections'] : [])],
  })
  return result.canceled ? [] : result.filePaths
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
