const isElectron = () => typeof window !== 'undefined' && !!window.electronAPI

export const scenesService = {
  async save(name, state) {
    if (!isElectron()) return null
    return window.electronAPI.saveScene(name, JSON.stringify(state))
  },

  async list() {
    if (!isElectron()) return []
    return window.electronAPI.listScenes()
  },

  async load(name) {
    if (!isElectron()) return null
    const json = await window.electronAPI.loadScene(name)
    return json ? JSON.parse(json) : null
  },

  async delete(name) {
    if (!isElectron()) return
    return window.electronAPI.deleteScene(name)
  },
}
