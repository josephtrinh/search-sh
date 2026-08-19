#!/usr/bin/env bash
set -euo pipefail

model_dir="${QWEN_MODEL_DIR:-./temp/qwen3.5-0.8b}"
model_file="$model_dir/Qwen3.5-0.8B-Q4_K_S.gguf"
mmproj_file="$model_dir/mmproj-F16.gguf"
model_sha="5f7ccfa6e9df0d9ebbaff9ee095b18202bec1e0ac313ca688d2c57c9c80a6bc9"
mmproj_sha="56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453"

test -f "$model_file" || { echo "Missing $model_file" >&2; exit 1; }
test -f "$mmproj_file" || { echo "Missing $mmproj_file" >&2; exit 1; }
printf '%s  %s\n%s  %s\n' "$model_sha" "$model_file" "$mmproj_sha" "$mmproj_file" | shasum -a 256 -c -
