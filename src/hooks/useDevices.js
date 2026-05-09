/**
 * useDevices.js — Hook para detección de hardware de audio en tiempo real.
 *
 * Detecta automáticamente interfaces conectadas/desconectadas.
 * Exporta la interfaz primaria (la de mayor inputCount) y la lista de entradas.
 */

import { useState, useEffect } from 'react'
import {
  enumerateAudioDevices,
  identifyInterface,
  generateInputList,
  onDeviceChange,
} from '../services/deviceService.js'

export function useDevices() {
  const [inputs,           setInputs]           = useState([])
  const [outputs,          setOutputs]          = useState([])
  const [primaryInterface, setPrimaryInterface] = useState(null)
  const [inputList,        setInputList]        = useState(['—'])
  const [status,           setStatus]           = useState('detectando') // 'detectando' | 'conectado' | 'sin_interfaz'

  const process = ({ inputs, outputs }) => {
    setInputs(inputs)
    setOutputs(outputs)

    // Identificar interfaces conocidas y elegir la principal (mayor inputCount)
    const identified = inputs
      .map(d => ({ device: d, info: identifyInterface(d.label) }))
      .filter(d => d.info !== null)
      .sort((a, b) => b.info.inputCount - a.info.inputCount)

    if (identified.length > 0) {
      const primary = identified[0]
      setPrimaryInterface(primary)
      setInputList(generateInputList(primary.info.inputCount))
      setStatus('conectado')
    } else if (inputs.length > 0) {
      // Hay dispositivos pero sin identificar
      setPrimaryInterface(null)
      setInputList(generateInputList(2))
      setStatus('conectado')
    } else {
      setPrimaryInterface(null)
      setInputList(['—'])
      setStatus('sin_interfaz')
    }
  }

  useEffect(() => {
    enumerateAudioDevices().then(process)
    const cleanup = onDeviceChange(process)
    return cleanup
  }, [])

  return { inputs, outputs, primaryInterface, inputList, status }
}
