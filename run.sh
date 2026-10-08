#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODELS_PATH="${1:-D:/ollama/Models}"
PORT="${2:-11434}"
UI_PORT="${3:-3000}"
CONTEXT_LENGTH="${4:-8192}"
KEEP_ALIVE="${5:--1}"

DATA_PATH="${SCRIPT_DIR}/data"
PG_DATA_PATH="${DATA_PATH}/postgres"
PROJECTS_PATH="${DATA_PATH}/projects"
mkdir -p "${PG_DATA_PATH}" "${PROJECTS_PATH}"

PG_DB="localllm"
PG_USER="localllm"
PG_PASSWORD="localllm"

GPU_FLAG="--gpus=all"
if [ "${NO_GPU:-0}" = "1" ]; then
  GPU_FLAG=""
fi

docker network inspect local-llm-net >/dev/null 2>&1 || docker network create local-llm-net >/dev/null

docker build -t local-llm "${SCRIPT_DIR}" >/dev/null

docker rm -f local-llm-db >/dev/null 2>&1 || true
docker run -d \
  --name local-llm-db \
  --network local-llm-net \
  -v "${PG_DATA_PATH}:/var/lib/postgresql/data" \
  -e "POSTGRES_DB=${PG_DB}" \
  -e "POSTGRES_USER=${PG_USER}" \
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
  --restart unless-stopped \
  postgres:16-alpine >/dev/null

docker rm -f local-llm >/dev/null 2>&1 || true

# shellcheck disable=SC2086
docker run -d \
  --name local-llm \
  --network local-llm-net \
  $GPU_FLAG \
  -p "${PORT}:11434" \
  -p "${UI_PORT}:80" \
  -v "${MODELS_PATH}:/root/.ollama/models" \
  -v "${DATA_PATH}:/data" \
  -e "OLLAMA_CONTEXT_LENGTH=${CONTEXT_LENGTH}" \
  -e "OLLAMA_FLASH_ATTENTION=1" \
  -e "OLLAMA_KEEP_ALIVE=${KEEP_ALIVE}" \
  -e "POSTGRES_HOST=local-llm-db" \
  -e "POSTGRES_DB=${PG_DB}" \
  -e "POSTGRES_USER=${PG_USER}" \
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
  --restart unless-stopped \
  local-llm

echo ""
echo "Chat UI                    -> http://localhost:${UI_PORT}"
echo "Ollama API (OpenAI-compat) -> http://localhost:${PORT}/v1"
echo "Models: qwen2.5:7b-instruct-q4_K_M, qwen2.5-coder:14b"
echo "Chats/projects/usage in Postgres, data on disk at -> ${DATA_PATH}"
echo "Per-project folders appear under                  -> ${PROJECTS_PATH}"
echo ""
echo "Note: qwen2.5:7b (~7GB) and qwen2.5-coder:14b (~14GB) don't both fit in"
echo "16GB VRAM at once. Switching between them still costs ~60-90s to swap;"
echo "staying on one model keeps every response fast (models now stay loaded"
echo "indefinitely instead of unloading after 5 min idle)."
