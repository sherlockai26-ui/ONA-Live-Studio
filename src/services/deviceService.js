/**
 * deviceService.js — Detección real de interfaces de audio en tiempo real
 *
 * IMPORTANTE: enumerateAudioDevices() YA NO llama getUserMedia() en startup.
 * getUserMedia() sin AudioContext activo + GPU desactivado mata el renderer
 * process de Electron (no lanza excepción — crash nativo inmanejable).
 *
 * Flujo seguro:
 *   1. Startup → enumerateDevices() sin permisos (labels vacíos si no hay permiso)
 *   2. Usuario click → AudioEngine.initialize() → Tone.start() crea AudioContext
 *   3. refreshWithPermission() → getUserMedia() ya dentro de un contexto válido
 */

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

export function identifyInterface(label) {
  if (!label) return null
  for (const iface of KNOWN_INTERFACES) {
    if (iface.pattern.test(label)) return { name: iface.name, inputCount: iface.inputCount }
  }
  if (/usb/i.test(label)) return { name: label.trim(), inputCount: 2 }
  return null
}

/**
 * Enumeración segura — NO llama getUserMedia().
 * En Chromium sin permiso previo, los labels aparecen vacíos.
 * Usar refreshWithPermission() después de que el AudioEngine esté listo.
 */
export async function enumerateAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return {
      inputs:  devices.filter(d => d.kind === 'audioinput'),
      outputs: devices.filter(d => d.kind === 'audiooutput'),
    }
  } catch (err) {
    console.warn('[ONA] enumerateDevices falló:', err.message)
    return { inputs: [], outputs: [] }
  }
}

/**
 * Re-enumeración CON permiso — llamar solo después de Tone.start().
 * getUserMedia() dentro de un AudioContext activo es seguro en Electron.
 */
export async function refreshWithPermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    stream.getTracks().forEach(t => t.stop())
  } catch (err) {
    console.warn('[ONA] Audio permission denied:', err.message)
  }
  return enumerateAudioDevices()
}

export function generateInputList(inputCount = 8) {
  const list   = ['—']
  const analog = Math.min(inputCount, 8)
  for (let i = 1; i <= analog; i++) list.push(`In ${i}`)
  if (inputCount > 8) {
    const adat = Math.min(inputCount - 8, 8)
    for (let i = 1; i <= adat; i++) list.push(`ADA ${i}`)
  }
  return list
}

export function onDeviceChange(callback) {
  const handler = async () => {
    // En devicechange siempre re-enumerar con permisos (ya fueron concedidos antes)
    const result = await refreshWithPermission().catch(() => enumerateAudioDevices())
    callback(result)
  }
  navigator.mediaDevices.addEventListener('devicechange', handler)
  return () => navigator.mediaDevices.removeEventListener('devicechange', handler)
}
