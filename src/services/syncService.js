import { io } from 'socket.io-client'

class SyncService {
  #socket  = null
  #cbs     = new Set()
  connected = false

  connect(url = 'http://localhost:3000') {
    if (this.#socket) return
    this.#socket = io(url, { autoConnect: true, reconnectionDelay: 2000 })
    this.#socket.on('connect',    () => { this.connected = true  })
    this.#socket.on('disconnect', () => { this.connected = false })
    this.#socket.on('state', (state) => {
      this.#cbs.forEach(cb => cb(state))
    })
  }

  disconnect() {
    this.#socket?.disconnect()
    this.#socket    = null
    this.connected  = false
  }

  emit(changes) {
    this.#socket?.emit('update', changes)
  }

  onState(cb) {
    this.#cbs.add(cb)
    return () => this.#cbs.delete(cb)
  }
}

export const syncService = new SyncService()
