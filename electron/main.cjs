const { app, BrowserWindow, ipcMain, session, dialog } = require('electron')
const path = require('path')
const fs   = require('fs')

// Previene crash del renderer cuando Tone.js / WebAudio activa el AudioContext.
// El acelerador de GPU de Chromium puede colapsar el proceso renderer en
// Windows con ciertos drivers al primer uso de WebAudio.
app.disableHardwareAcceleration()

function getDocsDir(...parts) {
  return path.join(app.getPath('documents'), 'ONA Live Studio', ...parts)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function createWindow() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' || permission === 'audioCapture')
  })

  const win = new BrowserWindow({
    width: 1400, height: 850,
    minWidth: 1100, minHeight: 650,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Recarga automática si el renderer cae (evita pantalla negra permanente)
  win.webContents.on('render-process-gone', (event, details) => {
    console.error('[ONA] Renderer crash:', details.reason, '— recargando...')
    if (details.reason !== 'killed') win.reload()
  })

  win.webContents.on('unresponsive', () => {
    console.warn('[ONA] Renderer unresponsive — forzando recarga')
    win.reload()
  })

  win.loadURL('http://localhost:5173')
}

// ── Grabación ────────────────────────────────────────────────────────────────
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

// ── Virtual Soundcheck — selector de archivos ─────────────────────────────────
ipcMain.handle('show-open-dialog', async (_, opts = {}) => {
  const result = await dialog.showOpenDialog({
    title: opts.title ?? 'Seleccionar audio',
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'aac'] }],
    properties: ['openFile', ...(opts.multiSelections ? ['multiSelections'] : [])],
  })
  return result.canceled ? [] : result.filePaths
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
