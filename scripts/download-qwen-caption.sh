#!/usr/bin/env bash
set -euo pipefail

model_dir="${QWEN_MODEL_DIR:-./temp/qwen3.5-0.8b}"
base_url="https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main"
mkdir -p "$model_dir"
curl -fL --retry 3 -C - -o "$model_dir/Qwen3.5-0.8B-Q4_K_S.gguf.part" "$base_url/Qwen3.5-0.8B-Q4_K_S.gguf"
mv "$model_dir/Qwen3.5-0.8B-Q4_K_S.gguf.part" "$model_dir/Qwen3.5-0.8B-Q4_K_S.gguf"
curl -fL --retry 3 -C - -o "$model_dir/mmproj-F16.gguf.part" "$base_url/mmproj-F16.gguf"
mv "$model_dir/mmproj-F16.gguf.part" "$model_dir/mmproj-F16.gguf"
bash scripts/verify-qwen-caption.sh
