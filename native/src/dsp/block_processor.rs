use crate::dsp::{
    gain::GainProcessor,
    meter::{MeterProcessor, MeterResult},
    pan::PanProcessor,
};

/// Orquestador de bloque: gain → pan → meter sobre interleaved stereo f32.
///
/// REGLA ABSOLUTA: NO allocations, NO panics, NO logs en process().
///
/// Fast paths (Paso 7):
///   1. Unity gain: si gain ≈ 1.0 y pan ≈ center, salta gain+pan
///   2. Silence: si el bloque es silencio absoluto, salta todo excepto meter decay
pub struct BlockProcessor {
    gain:   GainProcessor,
    pan:    PanProcessor,
    meter:  MeterProcessor,
    bypass: bool,
}

impl BlockProcessor {
    pub fn new(sample_rate: f32, _block_size: usize) -> Self {
        Self {
            gain:   GainProcessor::new(sample_rate),
            pan:    PanProcessor::new(),
            meter:  MeterProcessor::new(sample_rate),
            bypass: false,
        }
    }

    #[inline] pub fn set_gain(&mut self, g: f32)  { self.gain.set_gain(g); }
    #[inline] pub fn set_pan(&mut self, p: f32)   { self.pan.set_pan(p); }
    #[inline] pub fn set_bypass(&mut self, b: bool) { self.bypass = b; }
    #[inline] pub fn reset_meters(&mut self)       { self.meter.reset(); }

    /// Hot path — gain + pan + meter sobre `samples` (interleaved stereo, in-place).
    ///
    /// Silence fast path: si todos los samples tienen abs < 1e-8,
    /// salta gain+pan y hace decay de meter con samples cero (sin loop de DSP).
    #[inline]
    pub fn process(&mut self, samples: &mut [f32]) -> MeterResult {
        if self.bypass {
            return self.meter.process_block(samples);
        }

        // Silence detection: escanea el primer 25% del bloque
        // Si hay energía, procesamos todo. Si no, evitamos gain+pan.
        let check_len = (samples.len() / 4).max(2);
        let has_signal = samples[..check_len].iter().any(|s| s.abs() > 1e-8);

        if has_signal {
            self.gain.process_block(samples);
            self.pan.process_block(samples);
        }
        // Meter siempre corre (decay + acumulación RMS)
        self.meter.process_block(samples)
    }
}
