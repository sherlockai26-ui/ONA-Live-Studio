import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// ── Storage utilities expuestas en consola ────────────────────────────────────
window.__ONA_RESET_STORAGE = () => {
  localStorage.clear()
  sessionStorage.clear()
  try {
    indexedDB.databases?.().then(dbs =>
      dbs.forEach(db => indexedDB.deleteDatabase(db.name))
    )
  } catch (_) {}
  console.log('[BOOT] STORAGE CLEARED — recarga la app para aplicar')
}

// ── Detección de Safe Mode ────────────────────────────────────────────────────
// Prioridad (mayor a menor):
//   1. window.ona.safeMode   → flag CLI --safe-mode pasado desde main.cjs
//   2. ?safeMode=1 en URL    → query param inyectado por main.cjs
//   3. localStorage          → activar desde consola: localStorage.setItem('__ONA_SAFE_MODE','1')
//
// Desactivar: localStorage.removeItem('__ONA_SAFE_MODE'); location.reload()

const SAFE_MODE = (
  window.ona?.safeMode === true ||
  new URLSearchParams(window.location.search).get('safeMode') === '1' ||
  localStorage.getItem('__ONA_SAFE_MODE') === '1'
)

window.__ONA_SAFE_MODE = SAFE_MODE

if (SAFE_MODE) {
  console.log('[BOOT] SAFE MODE — Audio engine, metering y syncService desactivados')
  window.__ONA_METERING_DISABLED = true
} else {
  console.log('[BOOT] CLEAN START')
}

// ── Crash logging global — renderer ──────────────────────────────────────────
// Escribe en consola Y envía al main process para persistir en disco.

function _logCrash(type, msg) {
  const full = `[${type}] ${msg}`
  console.error('[ONA RENDERER]', full)
  try { window.electronAPI?.crashLog?.(full) } catch (_) {}
}

window.onerror = (msg, src, line, col, err) => {
  _logCrash('ERROR', `${msg} @ ${src}:${line}:${col}\n${err?.stack ?? ''}`)
  return false
}

window.onunhandledrejection = (e) => {
  const reason = e.reason instanceof Error
    ? (e.reason.stack ?? e.reason.message)
    : String(e.reason ?? e)
  _logCrash('REJECTION', reason)
}

// ── ErrorBoundary React ───────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(err) {
    return { error: err }
  }

  componentDidCatch(err, info) {
    _logCrash('REACT_CRASH', `${err.message}\n${info.componentStack}`)
  }

  render() {
    const { error } = this.state
    if (error) {
      return (
        <div style={{
          padding: 32, color: '#e5e5e5', background: '#0a0a0a',
          fontFamily: 'monospace', height: '100vh',
        }}>
          <p style={{ color: '#f97316', fontWeight: 'bold', fontSize: 14, marginBottom: 12 }}>
            ONA LIVE STUDIO — Renderer Error
          </p>
          <pre style={{ fontSize: 11, color: '#ef4444', whiteSpace: 'pre-wrap', marginBottom: 8 }}>
            {error.message}
          </pre>
          <p style={{ fontSize: 9, color: '#737373', marginBottom: 16 }}>
            Log guardado en Documentos/ONA Live Studio/Logs/
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => this.setState({ error: null })}
              style={{ padding: '6px 16px', background: '#f97316', color: 'black', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}
            >
              Reintentar
            </button>
            <button
              onClick={() => {
                window.__ONA_RESET_STORAGE()
                setTimeout(() => location.reload(), 300)
              }}
              style={{ padding: '6px 16px', background: '#2a2a2a', color: '#737373', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >
              Reset Storage + Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Sin StrictMode: en dev duplica effects → presión GC bajo software rendering
ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
