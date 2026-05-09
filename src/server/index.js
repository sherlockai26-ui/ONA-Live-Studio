import express    from 'express'
import http       from 'http'
import { Server } from 'socket.io'

const app    = express()
const server = http.createServer(app)
const io     = new Server(server, { cors: { origin: '*' } })

// Estado centralizado del mixer — espejo del Zustand store en el cliente
let mixerState = {
  channels: Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    name: `Canal ${i + 1}`,
    volume: 75,
    muted: false,
    soloed: false,
    toMain: true,
    toSub: false,
    inputSource: null,
  })),
  mainVolume: 80,
  subVolume: 80,
  fx: {
    reverb: { active: false, decay: 2.5, mix: 30 },
    delay:  { active: false, time: 300,  feedback: 30 },
  },
}

io.on('connection', (socket) => {
  console.log('Dispositivo conectado:', socket.id)
  socket.emit('state', mixerState)

  // Recibe cambios parciales del cliente y retransmite a todos
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
