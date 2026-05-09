const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('ona', {
  version: '0.1.0',
  platform: process.platform
})
