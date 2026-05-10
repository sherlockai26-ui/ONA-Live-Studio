/**
 * useDevices.js — Detección de hardware de audio en tiempo real.
 *
 * FLUJO SEGURO:
 *   Mount: enumerateAudioDevices() — sin getUserMedia (seguro en startup)
 *   devicechange: refreshWithPermission() — con getUserMedia (solo si ya hay AudioContext)
 *
 * refreshDeviceLabels() se exporta para que App.jsx la llame después de
 * que Tone.start() haya creado el AudioContext.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  enumerateAudioDevices,
  refreshWithPermission,
  identifyInterface,
  generateInputList,
  onDeviceChange,
} from '../services/deviceService.js'

export function useDevices() {
  const [inputs,           setInputs]           = useState([])
  const [outputs,          setOutputs]          = useState([])
  const [primaryInterface, setPrimaryInterface] = useState(null)
  const [inputList,        setInputList]        = useState(['—'])
  const [status,           setStatus]           = useState('detectando')

  const process = useCallback(({ inputs, outputs }) => {
    setInputs(inputs)
    setOutputs(outputs)

    const identified = inputs
      .map(d => ({ device: d, info: identifyInterface(d.label) }))
      .filter(d => d.info !== null)
      .sort((a, b) => b.info.inputCount - a.info.inputCount)

    if (identified.length > 0) {
      setPrimaryInterface(identified[0])
      setInputList(generateInputList(identified[0].info.inputCount))
      setStatus('conectado')
    } else if (inputs.length > 0) {
      setPrimaryInterface(null)
      setInputList(generateInputList(2))
      setStatus('conectado')
    } else {
      setPrimaryInterface(null)
      setInputList(['—'])
      setStatus('sin_interfaz')
    }
  }, [])

  // Enumeración inicial SIN getUserMedia — segura en startup
  useEffect(() => {
    enumerateAudioDevices().then(process)
    const cleanup = onDeviceChange(process)
    return cleanup
  }, [process])

  // refreshDeviceLabels: llamar después de Tone.start() para obtener labels reales
  const refreshDeviceLabels = useCallback(async () => {
    const result = await refreshWithPermission()
    process(result)
  }, [process])

  return { inputs, outputs, primaryInterface, inputList, status, refreshDeviceLabels }
}
