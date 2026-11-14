#!/bin/bash
# Isolated test dependency only; no project/runtime dependency is installed.
set -euo pipefail
ROOT="${HYMT_ARTIFACT_DIR:-/tmp/autotranslate-hymt2}"
# This producer-era PR revision uses tensor STQ1_0=42/file type=41.
# PR head 1e411d8 uses STQ1_0=43 and must not load the unchanged artifact.
COMMIT=f8b355a9eab32a23df26ae61ff1aacf2bb44ca38
REVISION=9df5c824a00a744fb0512a29c640466f4d97dfb0
MODEL=Hy-MT2-1.8B-1.25Bit.gguf
mkdir -p "$ROOT"
if [ ! -f "$ROOT/$MODEL" ]; then
  curl -fL "https://huggingface.co/tencent/Hy-MT2-1.8B-1.25Bit-GGUF/resolve/$REVISION/$MODEL" -o "$ROOT/$MODEL"
fi
printf '%s  %s\n' cc497fe8f033b52b3b8b00a7669e9661435432f9d4cd43f7ed24400c01507a93 "$ROOT/$MODEL" | shasum -a 256 -c -
if [ ! -d "$ROOT/llama.cpp-$COMMIT" ]; then
  curl -fL "https://github.com/sjl623/llama.cpp/archive/$COMMIT.tar.gz" -o "$ROOT/llama-compatible.tar.gz"
  printf '%s  %s\n' a973cf30ed7583d4e60fe256b0c2a579560a306f72e01f7e51c6b11d8d42be00 "$ROOT/llama-compatible.tar.gz" | shasum -a 256 -c -
  tar -xzf "$ROOT/llama-compatible.tar.gz" -C "$ROOT"
fi
cmake -S "$ROOT/llama.cpp-$COMMIT" -B "$ROOT/build-compatible" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=OFF -DGGML_BLAS=OFF -DGGML_ACCELERATE=ON \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_UI=OFF
cmake --build "$ROOT/build-compatible" --target llama-server -j "${HYMT_BUILD_JOBS:-6}"
printf 'Ready. Run: HYMT_ARTIFACT_DIR=%q node test/model-comparison/hymt2-benchmark.mjs\n' "$ROOT"
