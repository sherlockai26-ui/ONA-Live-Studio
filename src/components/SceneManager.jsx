import React, { useState, useEffect, useCallback } from 'react'
import { sceneEngine } from '../live/SceneEngine'
import { sceneManager } from '../audio/state/SceneManager'

export default function SceneManager() {
  const [scenes,  setScenes]  = useState([])
  const [newName, setNewName] = useState('')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    setScenes(sceneEngine.listScenes().map(name => ({ name })))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleSave = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    sceneEngine.save(trimmed)
    setNewName('')
    refresh()
  }

  const handleLoad = async (name) => {
    if (loading) return
    setLoading(true)
    try {
      await sceneEngine.recall(name, { profile: 'smooth' })
    } finally {
      setLoading(false)
    }
  }

  const handleRemove = (name) => {
    sceneManager.delete(name)
    refresh()
  }

  return (
    <div className="border-b border-[#2a2a2a] p-3">
      <p className="text-[10px] text-[#f97316] font-bold mb-3 tracking-widest">ESCENAS</p>

      {/* Guardar nueva escena */}
      <div className="flex gap-1 mb-3">
        <input
          type="text"
          placeholder="Nombre de escena..."
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          className="flex-1 text-[9px] bg-[#2a2a2a] text-[#e5e5e5] border border-[#3a3a3a] rounded px-1.5 py-1 outline-none focus:border-[#f97316]"
        />
        <button
          onClick={handleSave}
          disabled={!newName.trim()}
          className="text-[9px] px-2 py-1 rounded bg-[#f97316] text-black font-bold disabled:opacity-40 hover:bg-orange-400 transition-colors"
        >
          SAVE
        </button>
      </div>

      {/* Lista de escenas */}
      <div className="flex flex-col gap-1 max-h-28 overflow-y-auto">
        {scenes.length === 0 ? (
          <p className="text-[9px] text-[#4a4a4a] italic">Sin escenas guardadas</p>
        ) : (
          scenes.map(scene => (
            <div key={scene.name} className="flex items-center gap-1">
              <span className="flex-1 text-[9px] text-[#e5e5e5] truncate">{scene.name}</span>
              <button
                onClick={() => handleLoad(scene.name)}
                disabled={loading}
                className="text-[8px] px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#737373] hover:bg-[#3b82f6] hover:text-white transition-colors disabled:opacity-40"
              >
                LOAD
              </button>
              <button
                onClick={() => handleRemove(scene.name)}
                className="text-[8px] px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#737373] hover:bg-[#ef4444] hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
