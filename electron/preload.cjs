const { contextBridge, ipcRenderer } = require('electron')

// Safe Mode: detectado en main.cjs y pasado como additionalArgument
const SAFE_MODE = process.argv.includes('--safe-mode')

contextBridge.exposeInMainWorld('electronAPI', {
  // Grabación
  saveRecording:    (buf, file) => ipcRenderer.invoke('save-recording', buf, file),
  getRecordingsDir: ()          => ipcRenderer.invoke('get-recordings-dir'),

  // Escenas
  saveScene:   (name, json) => ipcRenderer.invoke('scenes-save', name, json),
  listScenes:  ()           => ipcRenderer.invoke('scenes-list'),
  loadScene:   (name)       => ipcRenderer.invoke('scenes-load', name),
  deleteScene: (name)       => ipcRenderer.invoke('scenes-delete', name),

  // Virtual Soundcheck
  showOpenDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),

  // Crash logging persistente — el renderer envía al main para escribir en disco
  crashLog: (msg) => {
    try { ipcRenderer.send('crash-log', String(msg)) } catch (_) {}
  },

  // Native audio probe (Paso 3) — detecta ASIO/WASAPI/CoreAudio vía naudiodon en main
  // Retorna: { available: boolean, devices: NativeAudioDevice[] }
  probeNativeAudio: () => ipcRenderer.invoke('native-audio-probe'),
})

contextBridge.exposeInMainWorld('ona', {
  version:  '0.2.0',
  platform: process.platform,
  safeMode: SAFE_MODE,  // true si se inició con: electron . --safe-mode
})

// ─── Paso 10: Multitrack Streaming Recording API ──────────────────────────────
//
// window.onaRecording — punto de acceso desde el renderer al sistema de
// grabación multipista. Implementa el protocolo de 3 fases:
//   createSession   → recording:create-session  (abre fds en main process)
//   writeChunk      → recording:write-chunk     (append PCM 24-bit por canal)
//   finalizeSession → recording:finalize-session (parcha header WAV, cierra fds)
//
// loadFile devuelve el WAV como ArrayBuffer para decodificarlo en el renderer
// (MultitrackPlayer.loadSessionTrack → AudioContext.decodeAudioData).
//
// ChunkCoalescer: acumula chunks del mismo canal hasta COALESCE_MS antes de enviar
// al main process. Reduce llamadas IPC en ráfagas y protege el pipe de escritura.
// finalizeSession() drena automáticamente los chunks pendientes antes de cerrar.

const COALESCE_MS = 50
// Map: `${sessionId}:${channelId}` → { bufs: ArrayBuffer[], timerId }
const _chunkPending = new Map()

function _chunkKey(sessionId, channelId) {
  return `${sessionId}:${channelId}`
}

function _flushChunkKey(key, sessionId, channelId) {
  const entry = _chunkPending.get(key)
  if (!entry || entry.bufs.length === 0) { _chunkPending.delete(key); return Promise.resolve() }
  clearTimeout(entry.timerId)
  _chunkPending.delete(key)

  const totalBytes = entry.bufs.reduce((s, b) => s + b.byteLength, 0)
  const merged = new Uint8Array(totalBytes)
  let off = 0
  for (const b of entry.bufs) { merged.set(new Uint8Array(b), off); off += b.byteLength }
  return ipcRenderer.invoke('recording:write-chunk', sessionId, channelId, merged.buffer)
}

function _queueChunk(sessionId, channelId, arrayBuffer) {
  const key = _chunkKey(sessionId, channelId)
  if (!_chunkPending.has(key)) {
    const entry = { bufs: [arrayBuffer], timerId: null }
    entry.timerId = setTimeout(() => _flushChunkKey(key, sessionId, channelId), COALESCE_MS)
    _chunkPending.set(key, entry)
  } else {
    _chunkPending.get(key).bufs.push(arrayBuffer)
  }
}

function _flushSession(sessionId) {
  const promises = []
  for (const key of [..._chunkPending.keys()]) {
    if (!key.startsWith(`${sessionId}:`)) continue
    const channelId = Number(key.split(':')[1])
    promises.push(_flushChunkKey(key, sessionId, channelId))
  }
  return Promise.all(promises)
}

contextBridge.exposeInMainWorld('onaRecording', {
  createSession:   (channels, sampleRate) =>
    ipcRenderer.invoke('recording:create-session', channels, sampleRate),
  writeChunk: (sessionId, channelId, arrayBuffer) => {
    _queueChunk(sessionId, channelId, arrayBuffer)
    return Promise.resolve(true)   // fire-and-forget; DiskStreamingQueue handles backpressure
  },
  finalizeSession: async (sessionId, latencyInfo) => {
    await _flushSession(sessionId)   // drain all pending chunks before sealing headers
    return ipcRenderer.invoke('recording:finalize-session', sessionId, latencyInfo)
  },
  listSessions:    () =>
    ipcRenderer.invoke('recording:list-sessions'),
  loadFile:        (filePath) =>
    ipcRenderer.invoke('recording:load-file', filePath),
})

// ─── Native DSP Engine (Rust) — binario no incluido en la build ──────────────
//
// La implementación Rust vive en native/ (ver native/README.md).
// NativeDSPBridge.ts y WebAudioDSPFallback.ts detectan en tiempo de ejecución
// si window.onaNative existe y usan WebAudio puro si no lo encuentran.
// No se expone window.onaNative aquí: la build actual opera 100% con WebAudio.
// Para habilitar el backend nativo, compila el crate (ver native/README.md) y
// descomenta el bloque loadNativeDSP en una rama separada.
