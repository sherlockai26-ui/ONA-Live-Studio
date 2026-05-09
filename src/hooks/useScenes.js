import { useState, useCallback } from 'react'
import { scenesService } from '../services/scenesService.js'
import useMixerStore from '../store/mixerStore.js'

export function useScenes() {
  const [scenes,  setScenes]  = useState([])
  const [loading, setLoading] = useState(false)
  const loadFullState = useMixerStore(s => s.loadFullState)

  const refresh = useCallback(async () => {
    const list = await scenesService.list()
    setScenes(list ?? [])
  }, [])

  const save = useCallback(async (name) => {
    if (!name.trim()) return
    const { channels, mainVolume, subVolume, fx } = useMixerStore.getState()
    await scenesService.save(name.trim(), { channels, mainVolume, subVolume, fx })
    await refresh()
  }, [refresh])

  const load = useCallback(async (name) => {
    setLoading(true)
    try {
      const snapshot = await scenesService.load(name)
      if (snapshot) loadFullState(snapshot)
    } finally {
      setLoading(false)
    }
  }, [loadFullState])

  const remove = useCallback(async (name) => {
    await scenesService.delete(name)
    await refresh()
  }, [refresh])

  return { scenes, loading, refresh, save, load, remove }
}
