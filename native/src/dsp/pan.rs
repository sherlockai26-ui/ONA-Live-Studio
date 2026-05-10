/// Equal-power stereo panning.
/// Pan: -1.0 (full left) → 0.0 (center) → +1.0 (full right).
///
/// Centro exacto: sin-op (no multiplica). Pregana ángulo en set_pan().
pub struct PanProcessor {
    pan:        f32,
    left_gain:  f32,
    right_gain: f32,
}

impl PanProcessor {
    pub fn new() -> Self {
        let mut p = Self { pan: 0.0, left_gain: 1.0, right_gain: 1.0 };
        p.recalculate();
        p
    }

    #[inline]
    pub fn set_pan(&mut self, pan: f32) {
        let clamped = pan.clamp(-1.0, 1.0);
        if (clamped - self.pan).abs() > 1e-6 {
            self.pan = clamped;
            self.recalculate();
        }
    }

    fn recalculate(&mut self) {
        // Mapea [-1, +1] → ángulo [0, π/2] para curva igual-potencia
        let angle = (self.pan + 1.0) * std::f32::consts::FRAC_PI_4;
        self.left_gain  = angle.cos();
        self.right_gain = angle.sin();
    }

    /// Procesa interleaved stereo [L0, R0, L1, R1, ...] in-place.
    #[inline]
    pub fn process_block(&self, samples: &mut [f32]) {
        if (self.left_gain - self.right_gain).abs() < 1e-6 {
            return; // Centro: sin-op
        }
        let lg = self.left_gain;
        let rg = self.right_gain;
        for chunk in samples.chunks_exact_mut(2) {
            chunk[0] *= lg;
            chunk[1] *= rg;
        }
    }
}
