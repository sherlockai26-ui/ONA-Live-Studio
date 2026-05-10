/// Peak hold + RMS con coeficiente exponencial — modo read-only sobre el bloque.
///
/// Peak: mantiene máximo con hold de 1.5s, luego decae -20 dB/s por sample.
/// RMS:  acumulador exponencial (τ = 300ms), raíz al retornar resultado.
pub struct MeterProcessor {
    peak_l:          f32,
    peak_r:          f32,
    rms_acc_l:       f32,
    rms_acc_r:       f32,
    rms_coeff:       f32,
    peak_hold_l:     u32,
    peak_hold_r:     u32,
    peak_hold_total: u32,
    peak_decay:      f32,
}

pub struct MeterResult {
    pub peak_l: f32,
    pub peak_r: f32,
    pub rms_l:  f32,
    pub rms_r:  f32,
}

impl MeterProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let rms_time   = 0.300f32; // 300 ms
        let hold_time  = 1.500f32; // 1.5 s
        // Decaimiento por sample tras hold: -20 dB/s en lineal
        let decay_per_s = 10f32.powf(-20.0 / 20.0 / sample_rate);
        Self {
            peak_l:          0.0,
            peak_r:          0.0,
            rms_acc_l:       0.0,
            rms_acc_r:       0.0,
            rms_coeff:       (-1.0 / (rms_time * sample_rate)).exp(),
            peak_hold_l:     0,
            peak_hold_r:     0,
            peak_hold_total: (hold_time * sample_rate) as u32,
            peak_decay:      decay_per_s,
        }
    }

    pub fn reset(&mut self) {
        self.peak_l      = 0.0;
        self.peak_r      = 0.0;
        self.rms_acc_l   = 0.0;
        self.rms_acc_r   = 0.0;
        self.peak_hold_l = 0;
        self.peak_hold_r = 0;
    }

    /// Procesa interleaved stereo [L0, R0, ...] — solo lectura (no modifica samples).
    #[inline]
    pub fn process_block(&mut self, samples: &[f32]) -> MeterResult {
        let rms_coeff = self.rms_coeff;

        for chunk in samples.chunks_exact(2) {
            let l = chunk[0].abs();
            let r = chunk[1].abs();

            // Peak left
            if l > self.peak_l {
                self.peak_l      = l;
                self.peak_hold_l = self.peak_hold_total;
            } else if self.peak_hold_l > 0 {
                self.peak_hold_l -= 1;
            } else {
                self.peak_l *= self.peak_decay;
            }

            // Peak right
            if r > self.peak_r {
                self.peak_r      = r;
                self.peak_hold_r = self.peak_hold_total;
            } else if self.peak_hold_r > 0 {
                self.peak_hold_r -= 1;
            } else {
                self.peak_r *= self.peak_decay;
            }

            // RMS exponential (acumula energía, sqrt al final)
            let l2 = l * l;
            let r2 = r * r;
            self.rms_acc_l = l2 + rms_coeff * (self.rms_acc_l - l2);
            self.rms_acc_r = r2 + rms_coeff * (self.rms_acc_r - r2);
        }

        MeterResult {
            peak_l: self.peak_l,
            peak_r: self.peak_r,
            rms_l:  self.rms_acc_l.sqrt(),
            rms_r:  self.rms_acc_r.sqrt(),
        }
    }
}
