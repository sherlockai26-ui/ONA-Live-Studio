/// SharedAudioBuffer — acceso zero-copy a SharedArrayBuffer desde Rust.
///
/// Layout del SAB (bytes):
///   [0..3]   write_ptr: u32 (atomic — JS escribe, Rust lee)
///   [4..7]   read_ptr:  u32 (atomic — Rust escribe, JS lee)
///   [8..11]  flags:     u32 (FLAG_OVERFLOW | FLAG_UNDERRUN)
///   [12..63] reserved
///   [64..]   audio f32  (interleaved stereo)
///
/// SAFETY: El protocolo de sincronización es responsabilidad del caller.
/// Rust no asume nada sobre quién escribe concurrentemente — usa atomics.

use std::sync::atomic::{AtomicU32, Ordering};

pub const HEADER_SIZE: usize = 64;
pub const FLAG_OVERFLOW: u32 = 1 << 0;
pub const FLAG_UNDERRUN: u32 = 1 << 1;

pub struct SharedAudioBuffer {
    ptr:        *mut u8,
    total_len:  usize,
    block_size: usize,
    channels:   usize,
}

// SAFETY: El SAB es propiedad de JS. Rust accede solo cuando el protocolo lo permite.
unsafe impl Send for SharedAudioBuffer {}
unsafe impl Sync for SharedAudioBuffer {}

impl SharedAudioBuffer {
    /// Construye desde un puntero raw al SAB. Retorna None si el buffer es demasiado pequeño.
    pub fn new(ptr: *mut u8, total_len: usize, block_size: usize, channels: usize) -> Option<Self> {
        let audio_bytes = block_size * channels * size_of::<f32>();
        if total_len < HEADER_SIZE + audio_bytes {
            return None;
        }
        Some(Self { ptr, total_len, block_size, channels })
    }

    // ── Cabecera atómica ──────────────────────────────────────────────────────

    pub unsafe fn write_ptr(&self) -> &AtomicU32 {
        &*(self.ptr as *const AtomicU32)
    }

    pub unsafe fn read_ptr(&self) -> &AtomicU32 {
        &*(self.ptr.add(4) as *const AtomicU32)
    }

    pub unsafe fn flags(&self) -> &AtomicU32 {
        &*(self.ptr.add(8) as *const AtomicU32)
    }

    // ── Área de audio ─────────────────────────────────────────────────────────

    pub unsafe fn audio_slice_mut(&mut self) -> &mut [f32] {
        let audio_ptr = self.ptr.add(HEADER_SIZE) as *mut f32;
        std::slice::from_raw_parts_mut(audio_ptr, self.block_size * self.channels)
    }

    pub unsafe fn audio_slice(&self) -> &[f32] {
        let audio_ptr = self.ptr.add(HEADER_SIZE) as *const f32;
        std::slice::from_raw_parts(audio_ptr, self.block_size * self.channels)
    }

    // ── Métricas ──────────────────────────────────────────────────────────────

    pub fn audio_bytes(&self) -> usize {
        self.block_size * self.channels * size_of::<f32>()
    }

    pub fn total_len(&self) -> usize { self.total_len }
}
