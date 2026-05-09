const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Grabación
  saveRecording:   (buf, file) => ipcRenderer.invoke('save-recording', buf, file),
  getRecordingsDir: ()         => ipcRenderer.invoke('get-recordings-dir'),
  // Escenas
  saveScene:    (name, json) => ipcRenderer.invoke('scenes-save', name, json),
  listScenes:   ()           => ipcRenderer.invoke('scenes-list'),
  loadScene:    (name)       => ipcRenderer.invoke('scenes-load', name),
  deleteScene:  (name)       => ipcRenderer.invoke('scenes-delete', name),
  // Virtual Soundcheck
  showOpenDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),
})

contextBridge.exposeInMainWorld('ona', {
  version: '0.2.0',
  platform: process.platform,
})
