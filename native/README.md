# Native DSP Engine (Rust — experimental)

This directory contains a Rust crate that implements a high-performance DSP channel
processor using napi-rs. It is **not compiled or included in the standard build**.
The application runs fully on WebAudio when the native binary is absent.

## Status

| Component | Status |
|-----------|--------|
| Gain / Pan / Meter (Rust) | Prototype — untested in production |
| napi-rs bindings | Skeleton |
| Preload loader | Removed from `electron/preload.cjs` (see comment) |
| WebAudio fallback | Active — `NativeDSPBridge.ts` + `WebAudioDSPFallback.ts` |

## Architecture

```
NativeDSPBridge.ts
  ├── if window.onaNative exists → NativeChannelProcessor (Rust via napi-rs)
  └── else → WebAudioDSPFallback.ts (pure WebAudio, always works)
```

`window.onaNative` is exposed by `electron/preload.cjs` only when the compiled
`.node` binary is present. Without it the app boots normally using WebAudio.

## How to compile (optional)

Requirements: Rust stable toolchain, Node.js 18+, `@napi-rs/cli`.

```bash
cd native
npm install           # installs @napi-rs/cli locally
npm run build         # compiles and copies .node to native/
```

The output file is named `ona-dsp-engine.<platform>-<arch>-<abi>.node`.

To re-enable native DSP in the preload, add the loader block back to
`electron/preload.cjs` (the removed IIFE is preserved in git history).

## Why it's disabled

The WebAudio + scalability stack (Paso 1–18) already covers all production needs
with acceptable CPU usage. The Rust backend is kept as a template for future
low-latency work (sub-3ms block processing, SIMD, offline bounce) that requires
true native threads rather than the AudioWorklet model.
