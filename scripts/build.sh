#!/usr/bin/env bash
# Builds the Rust engine to WebAssembly and places it where the web app loads it.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --release --target wasm32-unknown-unknown -p seosynth-engine
mkdir -p web/wasm
cp target/wasm32-unknown-unknown/release/seosynth_engine.wasm web/wasm/seosynth.wasm

# Optional size optimisation when binaryen is installed.
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int \
    web/wasm/seosynth.wasm -o web/wasm/seosynth.wasm
fi

ls -l web/wasm/seosynth.wasm | awk '{print "built web/wasm/seosynth.wasm (" $5 " bytes)"}'
