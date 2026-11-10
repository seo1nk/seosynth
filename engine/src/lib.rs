//! Nami: a wavetable synthesizer engine.
//!
//! Pure Rust with no dependencies. Builds natively (for tests) and to
//! WebAssembly, where `api` exposes it to the browser.
//!
//! Signal flow:
//!
//! ```text
//! OSC A ─┐
//! OSC B ─┼─► FILTER ─► AMP (Env 1) ─► FX chain ─► MASTER
//! SUB   ─┤     ▲
//! NOISE ─┘     └ each source can also bypass the filter
//!
//! Envelopes, LFOs, macros, velocity... ─► mod matrix ─► any knob
//! ```

pub mod api;
pub mod env;
pub mod fft;
pub mod filter;
pub mod fx;
pub mod lfo;
pub mod osc;
pub mod params;
pub mod patch;
pub mod sources;
pub mod synth;
pub mod tables;
pub mod util;
pub mod voice;
pub mod wavetable;
