/// Gain con suavizado exponencial (τ = 10ms) para evitar clicks en automación.
///
/// Fast path: si gain convergió, aplica constante sin branch por sample.
/// Slow path: interpolación exponencial muestra a muestra durante transiciones.
pub struct GainProcessor {
    target:  f32,
    current: f32,
    coeff:   f32,
}

impl GainProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let tau = 0.010; // 10ms smoothing
        Self {
            target:  1.0,
            current: 1.0,
            coeff:   (-1.0 / (tau * sample_rate)).exp(),
        }
    }

    #[inline]
    pub fn set_gain(&mut self, gain: f32) {
        self.target = gain.clamp(0.0, 4.0); // max +12 dB
    }

    #[inline]
    pub fn process_block(&mut self, samples: &mut [f32]) {
        if (self.target - self.current).abs() < 1e-6 {
            // Fast path: ganancia constante — sin rama por sample
            let g = self.target;
            for s in samples.iter_mut() {
                *s *= g;
            }
        } else {
            // Slow path: interpolación suave durante fade o automación
            let coeff  = self.coeff;
            let target = self.target;
            for s in samples.iter_mut() {
                self.current = target + coeff * (self.current - target);
                *s *= self.current;
            }
        }
    }
}
