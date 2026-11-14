//! seosynth: a wavetable synthesizer engine.
//!
//! Pure Rust with no dependencies. Builds natively (for tests) and to
//! WebAssembly, where `api` exposes it to the browser.
//!
//! Signal flow:
//!
//! ```text
//! keys ─► CLIP or ARP (when on) ─► voices, each of them:
//!
//! OSC A ─┐
//! OSC B ─┤
//! OSC C ─┼─► FILTER 1 ─► FILTER 2 ─► AMP (Env 1) ─► FX chain ─► MASTER
//! SUB   ─┤     ▲  (filter 2 in series, or beside filter 1)
//! NOISE ─┘     └ each source can also bypass the filters
//!
//! Envelopes, LFOs, macros, velocity... ─► mod matrix ─► any knob
//! ```

pub mod api;
pub mod arp;
pub mod clip;
pub mod env;
pub mod fft;
pub mod filter;
pub mod fx;
pub mod lfo;
pub mod osc;
pub mod params;
pub mod patch;
pub mod serum;
pub mod sources;
pub mod synth;
pub mod tablejobs;
pub mod tables;
pub mod util;
pub mod voice;
pub mod wavetable;
