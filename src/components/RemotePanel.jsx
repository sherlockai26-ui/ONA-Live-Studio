/**
 * RemotePanel.jsx — Control remoto por red
 *
 * Muestra las IPs locales del servidor, genera un QR code para cada una
 * y permite copiar la URL al portapapeles. No usa estado para el QR (canvas directo).
 *
 * Datos: GET http://localhost:3000/api/discover → { ips, port }
 */

import React, { useState, useEffect, useRef, memo } from 'react'
import QRCode from 'qrcode'

const SERVER_PORT = 3000

async function fetchServerInfo() {
  try {
    const res  = await fetch(`http://localhost:${SERVER_PORT}/api/discover`, { signal: AbortSignal.timeout(2000) })
    const json = await res.json()
    if (json?.type === 'ONA_SERVER') return { ips: json.ips ?? [], port: json.port ?? SERVER_PORT }
  } catch (_) {}
  return null
}

function QRCanvas({ url }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (!canvasRef.current || !url) return
    QRCode.toCanvas(canvasRef.current, url, {
      width:           128,
      margin:          1,
      color: { dark: '#e5e5e5', light: '#141414' },
    }).catch(err => console.warn('[RemotePanel] QRCode error:', err))
  }, [url])

  return <canvas ref={canvasRef} className="rounded" style={{ width: 128, height: 128 }} />
}

function IPRow({ ip, port }) {
  const url            = `http://${ip}:${port}`
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] text-[#e5e5e5] font-mono">{url}</span>
        <button
          onClick={handleCopy}
          className={`text-[8px] px-2 py-0.5 rounded transition-colors ml-2 shrink-0 ${
            copied ? 'bg-[#22c55e] text-black font-bold' : 'bg-[#2a2a2a] text-[#737373] hover:bg-[#3a3a3a]'
          }`}
        >
          {copied ? 'OK' : 'COPIAR'}
        </button>
      </div>
      <QRCanvas url={url} />
    </div>
  )
}

function RemotePanel() {
  const [info,    setInfo]    = useState(null)   // { ips, port } | null
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(false)

  const probe = () => {
    setLoading(true)
    setError(false)
    fetchServerInfo().then(result => {
      setLoading(false)
      if (result) { setInfo(result) } else { setError(true) }
    })
  }

  useEffect(() => {
    probe()
    // Re-probe every 10s in case server IP changes (DHCP, hotspot toggle)
    const timer = setInterval(probe, 10_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="border-b border-[#2a2a2a] p-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] text-[#f97316] font-bold tracking-widest">REMOTO</p>
        <button
          onClick={probe}
          disabled={loading}
          className="text-[8px] px-2 py-0.5 rounded bg-[#2a2a2a] text-[#737373] hover:bg-[#3a3a3a] transition-colors disabled:opacity-50"
        >
          {loading ? '...' : 'SCAN'}
        </button>
      </div>

      {error && (
        <div className="text-[9px] text-[#737373] text-center py-2">
          <p>Servidor no encontrado.</p>
          <p className="text-[8px] mt-1">Inicia el servidor de red primero.</p>
        </div>
      )}

      {!error && !info && loading && (
        <p className="text-[9px] text-[#737373] text-center py-2">Buscando servidor...</p>
      )}

      {info && info.ips.length === 0 && (
        <p className="text-[9px] text-[#737373] text-center py-2">
          Sin interfaces de red detectadas.
        </p>
      )}

      {info && info.ips.map(ip => (
        <IPRow key={ip} ip={ip} port={info.port} />
      ))}

      <p className="text-[7px] text-[#3a3a3a] mt-1 text-center">
        Escanea con ONA Remote App o cualquier navegador
      </p>
    </div>
  )
}

export default memo(RemotePanel)
