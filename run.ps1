param(
  [string]$ModelsPath = "D:\ollama\Models",
  [int]$Port = 11434,
  [int]$UiPort = 3000,
  [int]$ContextLength = 8192,
  [string]$KeepAlive = "-1",
  [switch]$NoGpu
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataPath = Join-Path $scriptDir "data"
$pgDataPath = Join-Path $dataPath "postgres"
$projectsPath = Join-Path $dataPath "projects"
New-Item -ItemType Directory -Force -Path $pgDataPath | Out-Null
New-Item -ItemType Directory -Force -Path $projectsPath | Out-Null

$PG_DB = "localllm"
$PG_USER = "localllm"
$PG_PASSWORD = "localllm"

docker network inspect local-llm-net *> $null
if (-not $?) { docker network create local-llm-net | Out-Null }

docker build -t local-llm "$scriptDir" | Out-Null

docker rm -f local-llm-db 2>$null | Out-Null
docker run -d `
  --name local-llm-db `
  --network local-llm-net `
  -v "${pgDataPath}:/var/lib/postgresql/data" `
  -e "POSTGRES_DB=${PG_DB}" `
  -e "POSTGRES_USER=${PG_USER}" `
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" `
  --restart unless-stopped `
  postgres:16-alpine | Out-Null

docker rm -f local-llm 2>$null | Out-Null

$dockerArgs = @('run', '-d', '--name', 'local-llm', '--network', 'local-llm-net')
if (-not $NoGpu) { $dockerArgs += '--gpus=all' }
$dockerArgs += @(
  '-p', "${Port}:11434",
  '-p', "${UiPort}:80",
  '-v', "${ModelsPath}:/root/.ollama/models",
  '-v', "${dataPath}:/data",
  '-e', "OLLAMA_CONTEXT_LENGTH=${ContextLength}",
  '-e', "OLLAMA_FLASH_ATTENTION=1",
  '-e', "OLLAMA_KEEP_ALIVE=${KeepAlive}",
  '-e', "POSTGRES_HOST=local-llm-db",
  '-e', "POSTGRES_DB=${PG_DB}",
  '-e', "POSTGRES_USER=${PG_USER}",
  '-e', "POSTGRES_PASSWORD=${PG_PASSWORD}",
  '--restart', 'unless-stopped',
  'local-llm'
)

docker @dockerArgs

Write-Host ""
Write-Host "Chat UI                    -> http://localhost:$UiPort"
Write-Host "Ollama API (OpenAI-compat) -> http://localhost:$Port/v1"
Write-Host "Models: qwen2.5:7b-instruct-q4_K_M, qwen2.5-coder:14b"
Write-Host "Chats/projects/usage in Postgres, data on disk at -> $dataPath"
Write-Host "Per-project folders appear under                  -> $projectsPath"
Write-Host ""
Write-Host "Note: qwen2.5:7b (~7GB) and qwen2.5-coder:14b (~14GB) don't both fit in" -ForegroundColor DarkYellow
Write-Host "16GB VRAM at once. Switching between them still costs ~60-90s to swap;" -ForegroundColor DarkYellow
Write-Host "staying on one model keeps every response fast (models now stay loaded" -ForegroundColor DarkYellow
Write-Host "indefinitely instead of unloading after 5 min idle)." -ForegroundColor DarkYellow
