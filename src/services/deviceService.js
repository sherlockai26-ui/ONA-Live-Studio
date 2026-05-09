/**
 * deviceService.js — Detección real de interfaces de audio en tiempo real
 *
 * Usa navigator.mediaDevices.enumerateDevices() (disponible en Electron/Chromium).
 * Se actualiza automáticamente con el evento 'devicechange' cuando el usuario
 * conecta o desconecta hardware.
 *
 * Detecta y nombra:
 *   Focusrite Scarlett (todas las versiones), Behringer X2222USB / Xenyx,
 *   Yamaha, PreSonus, MOTU, RME, Universal Audio, M-Audio, y genéricos USB.
 */

// Catálogo de interfaces conocidas (pattern matching sobre el label del driver)
const KNOWN_INTERFACES = [
  { pattern: /scarlett 18i20/i,          name: 'Focusrite 18i20',      inputCount: 18 },
  { pattern: /scarlett 18i8/i,           name: 'Focusrite 18i8',       inputCount: 10 },
  { pattern: /scarlett 4i4/i,            name: 'Focusrite 4i4',        inputCount: 4  },
  { pattern: /scarlett 2i2/i,            name: 'Focusrite 2i2',        inputCount: 2  },
  { pattern: /scarlett solo/i,           name: 'Focusrite Solo',       inputCount: 2  },
  { pattern: /focusrite|scarlett/i,      name: 'Focusrite',            inputCount: 2  },
  { pattern: /x2222usb|x222|x1204usb/i, name: 'Behringer X2222USB',   inputCount: 2  },
  { pattern: /xenyx/i,                   name: 'Behringer Xenyx',      inputCount: 2  },
  { pattern: /behringer|uca202|umc/i,    name: 'Behringer',            inputCount: 2  },
  { pattern: /yamaha\s*(ag|tf|mg)/i,     name: 'Yamaha',               inputCount: 2  },
  { pattern: /presonus/i,                name: 'PreSonus',             inputCount: 2  },
  { pattern: /motu/i,                    name: 'MOTU',                 inputCount: 8  },
  { pattern: /rme/i,                     name: 'RME',                  inputCount: 16 },
  { pattern: /universal audio|ua\s/i,    name: 'Universal Audio',      inputCount: 2  },
  { pattern: /m-audio|maudio/i,          name: 'M-Audio',              inputCount: 2  },
  { pattern: /native instruments/i,      name: 'Native Instruments',   inputCount: 2  },
  { pattern: /steinberg/i,               name: 'Steinberg',            inputCount: 2  },
  { pattern: /audient/i,                 name: 'Audient',              inputCount: 2  },
  { pattern: /mackie/i,                  name: 'Mackie',               inputCount: 2  },
  { pattern: /roland/i,                  name: 'Roland',               inputCount: 2  },
]

/**
 * Identifica una interfaz conocida a partir del label del dispositivo.
 * @returns {{ name: string, inputCount: number } | null}
 */
export function identifyInterface(label) {
  if (!label) return null
  for (const iface of KNOWN_INTERFACES) {
    if (iface.pattern.test(label)) {
      return { name: iface.name, inputCount: iface.inputCount }
    }
  }
  // Dispositivo USB genérico
  if (/usb/i.test(label)) return { name: label.trim(), inputCount: 2 }
  return null
}

/**
 * Solicita permiso de audio y enumera todos los dispositivos.
 * En Electron el permiso se otorga automáticamente (ver main.cjs).
 * @returns {Promise<{ inputs: MediaDeviceInfo[], outputs: MediaDeviceInfo[] }>}
 */
export async function enumerateAudioDevices() {
  try {
    // getUserMedia desbloquea los labels de dispositivo en Chromium
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // Liberar el stream inmediatamente (solo necesitábamos el permiso)
    stream.getTracks().forEach(t => t.stop())
  } catch (err) {
    console.warn('[ONA] Permiso de audio no concedido:', err.message)
  }

  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    inputs:  devices.filter(d => d.kind === 'audioinput'),
    outputs: devices.filter(d => d.kind === 'audiooutput'),
  }
}

/**
 * Genera la lista de entradas disponibles para los dropdowns de canal.
 * Ej: ['—', 'In 1', 'In 2', ..., 'ADA 1', 'ADA 8']
 *
 * Si inputCount > 8 asumimos ADAT en canales 9-16.
 */
export function generateInputList(inputCount = 8) {
  const list = ['—']
  const analog = Math.min(inputCount, 8)
  for (let i = 1; i <= analog; i++) list.push(`In ${i}`)
  if (inputCount > 8) {
    const adat = Math.min(inputCount - 8, 8)
    for (let i = 1; i <= adat; i++) list.push(`ADA ${i}`)
  }
  return list
}

/**
 * Registra un listener para cambios de dispositivo en tiempo real.
 * @returns {() => void} función para desregistrar el listener
 */
export function onDeviceChange(callback) {
  const handler = async () => {
    const result = await enumerateAudioDevices()
    callback(result)
  }
  navigator.mediaDevices.addEventListener('devicechange', handler)
  return () => navigator.mediaDevices.removeEventListener('devicechange', handler)
}
