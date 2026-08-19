#!/usr/bin/env bash
set -euo pipefail

dotenv_uint() {
  local key="$1"
  local value=""

  if [[ -f .env ]]; then
    value="$(awk -F= -v key="$key" '
      $1 == key { value = substr($0, index($0, "=") + 1) }
      END {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        gsub(/^['\''"]|['\''"]$/, "", value)
        print value
      }
    ' .env)"
  fi

  printf '%s' "$value"
}

model_dir="${QWEN_MODEL_DIR:-./temp/qwen3.5-0.8b}"
server_bin="${LLAMA_SERVER_BIN:-llama-server}"
server_port="${QWEN_SERVER_PORT:-8200}"
context_size="${QWEN_CONTEXT_SIZE:-$(dotenv_uint QWEN_CONTEXT_SIZE)}"
image_max_tokens="${QWEN_IMAGE_MAX_TOKENS:-$(dotenv_uint QWEN_IMAGE_MAX_TOKENS)}"
context_size="${context_size:-8192}"
image_max_tokens="${image_max_tokens:-4096}"

[[ "$context_size" =~ ^[1-9][0-9]*$ ]] || { echo "QWEN_CONTEXT_SIZE must be a positive integer" >&2; exit 1; }
[[ "$image_max_tokens" =~ ^[1-9][0-9]*$ ]] || { echo "QWEN_IMAGE_MAX_TOKENS must be a positive integer" >&2; exit 1; }

bash scripts/verify-qwen-caption.sh
command -v "$server_bin" >/dev/null 2>&1 || { echo "llama-server is not installed; install llama.cpp first or set LLAMA_SERVER_BIN" >&2; exit 1; }
exec "$server_bin" \
  --model "$model_dir/Qwen3.5-0.8B-Q4_K_S.gguf" \
  --mmproj "$model_dir/mmproj-F16.gguf" \
  --alias "unsloth/Qwen3.5-0.8B-GGUF:Q4_K_S" \
  --host 127.0.0.1 \
  --port "$server_port" \
  --ctx-size "$context_size" \
  --image-max-tokens "$image_max_tokens" \
  --parallel 1 \
  --n-gpu-layers 99
