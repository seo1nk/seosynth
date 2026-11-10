#!/usr/bin/env bash
# Builds the Rust engine to WebAssembly and places it where the web app loads it.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --release --target wasm32-unknown-unknown -p nami-engine
mkdir -p web/wasm
cp target/wasm32-unknown-unknown/release/nami_engine.wasm web/wasm/nami.wasm

# Optional size optimisation when binaryen is installed.
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int \
    web/wasm/nami.wasm -o web/wasm/nami.wasm
fi

ls -l web/wasm/nami.wasm | awk '{print "built web/wasm/nami.wasm (" $5 " bytes)"}'
