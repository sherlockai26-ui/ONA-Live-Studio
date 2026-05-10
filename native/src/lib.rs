#![deny(clippy::all)]

mod dsp;
mod utils;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use dsp::block_processor::BlockProcessor;

// ─── Health / discovery ───────────────────────────────────────────────────────

/// Versión del engine — usada por NativeDSPBridge para detectar el módulo.
#[napi]
pub fn engine_version() -> String {
    format!("ona-dsp-engine {}", env!("CARGO_PKG_VERSION"))
}

/// Capacidades disponibles en este build.
#[napi(object)]
pub struct EngineCapabilities {
    pub gain:             bool,
    pub pan:              bool,
    pub peak_meter:       bool,
    pub rms_meter:        bool,
    pub block_processing: bool,
    pub shared_memory:    bool,
    pub simd:             bool,
}

#[napi]
pub fn get_capabilities() -> EngineCapabilities {
    EngineCapabilities {
        gain:             true,
        pan:              true,
        peak_meter:       true,
        rms_meter:        true,
        block_processing: true,
        shared_memory:    true,
        simd: cfg!(any(target_feature = "avx2", target_feature = "sse4.1")),
    }
}

// ─── BlockResult ─────────────────────────────────────────────────────────────

#[napi(object)]
pub struct BlockResult {
    pub peak_l:         f64,
    pub peak_r:         f64,
    pub rms_l:          f64,
    pub rms_r:          f64,
    /// Tiempo real de procesamiento en nanosegundos (sin overhead JS).
    pub processing_ns:  f64,
}

// ─── NativeChannelProcessor ───────────────────────────────────────────────────

/// Procesador DSP para un canal: gain + pan + peak/RMS meter.
/// Una instancia por canal — creada por NativeDSPBridge al inicializar.
#[napi]
pub struct NativeChannelProcessor {
    inner:      BlockProcessor,
    channel_id: u32,
}

#[napi]
impl NativeChannelProcessor {
    #[napi(constructor)]
    pub fn new(channel_id: u32, sample_rate: f64, block_size: u32) -> Self {
        Self {
            inner: BlockProcessor::new(sample_rate as f32, block_size as usize),
            channel_id,
        }
    }

    #[napi]
    pub fn channel_id(&self) -> u32 { self.channel_id }

    /// Establece ganancia en dB. -96 dB o menor → silencio absoluto.
    #[napi]
    pub fn set_gain_db(&mut self, db: f64) {
        let linear = if db <= -96.0 { 0.0f32 } else { 10f32.powf(db as f32 / 20.0) };
        self.inner.set_gain(linear);
    }

    /// Establece ganancia lineal [0..4] (4 = +12 dB).
    #[napi]
    pub fn set_gain_linear(&mut self, gain: f64) {
        self.inner.set_gain(gain as f32);
    }

    /// Pan: -1.0 (left) .. 0.0 (center) .. +1.0 (right).
    #[napi]
    pub fn set_pan(&mut self, pan: f64) {
        self.inner.set_pan(pan as f32);
    }

    #[napi]
    pub fn set_bypass(&mut self, bypass: bool) {
        self.inner.set_bypass(bypass);
    }

    #[napi]
    pub fn reset_meters(&mut self) {
        self.inner.reset_meters();
    }

    /// Procesa un bloque de audio Float32Array (interleaved stereo, in-place).
    /// Retorna datos de metering + tiempo de procesamiento.
    #[napi]
    pub fn process_block(&mut self, mut samples: Float32Array) -> BlockResult {
        let t0 = std::time::Instant::now();
        let m  = self.inner.process(samples.as_mut());
        BlockResult {
            peak_l:        m.peak_l as f64,
            peak_r:        m.peak_r as f64,
            rms_l:         m.rms_l  as f64,
            rms_r:         m.rms_r  as f64,
            processing_ns: t0.elapsed().as_nanos() as f64,
        }
    }

    /// Procesa desde Uint8Array view de un SharedArrayBuffer (zero-copy).
    /// `sample_offset` y `sample_count` en unidades de f32 (no bytes).
    ///
    /// SAFETY: El caller garantiza que JS no accede al buffer concurrentemente
    /// durante esta llamada. El protocolo SAB usa atomics para sincronización.
    #[napi]
    pub unsafe fn process_shared(
        &mut self,
        buffer:        Uint8Array,
        sample_offset: u32,
        sample_count:  u32,
    ) -> BlockResult {
        let t0      = std::time::Instant::now();
        let bytes   = buffer.as_ref();
        let b_off   = sample_offset as usize * 4;
        let b_len   = sample_count  as usize * 4;

        if b_off + b_len > bytes.len() {
            return BlockResult { peak_l: 0.0, peak_r: 0.0, rms_l: 0.0, rms_r: 0.0, processing_ns: 0.0 };
        }

        let ptr     = bytes.as_ptr().add(b_off) as *mut f32;
        let samples = std::slice::from_raw_parts_mut(ptr, sample_count as usize);
        let m       = self.inner.process(samples);

        BlockResult {
            peak_l:        m.peak_l as f64,
            peak_r:        m.peak_r as f64,
            rms_l:         m.rms_l  as f64,
            rms_r:         m.rms_r  as f64,
            processing_ns: t0.elapsed().as_nanos() as f64,
        }
    }
}

// ─── Benchmark ────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct BenchmarkResult {
    pub block_size:      u32,
    pub num_blocks:      u32,
    pub avg_ns:          f64,
    pub min_ns:          f64,
    pub max_ns:          f64,
    pub total_ms:        f64,
    pub realtime_factor: f64,
}

/// Ejecuta N bloques de audio sintético y mide rendimiento puro del DSP Rust.
/// No incluye overhead JS ni IPC — solo tiempo de procesamiento nativo.
#[napi]
pub fn benchmark_processing(
    block_size:  u32,
    num_blocks:  u32,
    sample_rate: f64,
) -> BenchmarkResult {
    let mut proc = BlockProcessor::new(sample_rate as f32, block_size as usize);
    // Señal de prueba: onda triangular en [-0.5, +0.5]
    let mut buf: Vec<f32> = (0..block_size as usize * 2)
        .map(|i| {
            let t = (i as f32 / (block_size as f32 * 2.0)) * 2.0 - 1.0;
            t * 0.5
        })
        .collect();

    let total_start = std::time::Instant::now();
    let mut max_ns = 0u128;
    let mut min_ns = u128::MAX;
    let mut sum_ns = 0u128;

    for _ in 0..num_blocks {
        let t0 = std::time::Instant::now();
        proc.process(&mut buf);
        let ns = t0.elapsed().as_nanos();
        sum_ns += ns;
        if ns > max_ns { max_ns = ns; }
        if ns < min_ns { min_ns = ns; }
    }

    let total_wall_us  = total_start.elapsed().as_micros() as f64;
    let samples_total  = block_size as f64 * num_blocks as f64;
    let duration_audio = samples_total / sample_rate;
    let duration_wall  = total_wall_us / 1_000_000.0;

    BenchmarkResult {
        block_size,
        num_blocks,
        avg_ns:          (sum_ns / num_blocks as u128) as f64,
        min_ns:          min_ns as f64,
        max_ns:          max_ns as f64,
        total_ms:        total_wall_us / 1000.0,
        realtime_factor: duration_audio / duration_wall,
    }
}
