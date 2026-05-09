const express    = require('express')
const http       = require('http')
const { Server } = require('socket.io')

const app    = express()
const server = http.createServer(app)
const io     = new Server(server, {
  cors: { origin: '*' }
})

let mixerState = {
  channels: [
    { id: 1, name: 'Tololoche 1', volume: 75, muted: false, soloed: false },
    { id: 2, name: 'Tololoche 2', volume: 75, muted: false, soloed: false },
    { id: 3, name: 'Voz 1',       volume: 75, muted: false, soloed: false },
    { id: 4, name: 'Voz 2',       volume: 75, muted: false, soloed: false },
    { id: 5, name: 'Armonía',     volume: 75, muted: false, soloed: false },
    { id: 6, name: 'Requinto',    volume: 75, muted: false, soloed: false },
  ],
  master: 80,
  fx: {
    reverb: { active: false, mix: 30, size: 50 },
    delay:  { active: false, time: 300, feedback: 30 }
  }
}

io.on('connection', (socket) => {
  console.log('Dispositivo conectado:', socket.id)
  socket.emit('state', mixerState)
  socket.on('update', (changes) => {
    mixerState = { ...mixerState, ...changes }
    socket.broadcast.emit('state', mixerState)
  })
  socket.on('disconnect', () => {
    console.log('Dispositivo desconectado:', socket.id)
  })
})

server.listen(3000, '0.0.0.0', () => {
  console.log('ONA Live Studio server corriendo en puerto 3000')
})
