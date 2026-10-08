# local-llm-gateway

Dockerized access to the two Ollama models already downloaded on this machine
(`D:\ollama\Models`), exposed as a local API **and** a ChatGPT/Claude-style
chat UI, with a real Postgres-backed database for chat history and project
tracking - so any project (or you, directly) can use them without
re-downloading anything or installing Ollama natively.

Models detected:
- `qwen2.5:7b-instruct-q4_K_M` - **the standard, fast default.** Use this for
  everyday chat and for any project (including RAG pipelines).
- `qwen2.5-coder:14b` - reserved for deliberate, heavy coding sessions. It
  and the 7b model together need ~21GB VRAM, more than a 16GB GPU has, so
  only one can be loaded at a time - switching between them costs ~60-90s
  to swap. Stick to the 7b model unless you specifically need 14b's extra
  coding strength and are OK paying that cost when you switch to it.

## Performance

Two settings matter a lot here and are on by default (`run.ps1`/`run.sh`/
`docker-compose.yml`):

- **`OLLAMA_FLASH_ATTENTION=1`** - roughly halves per-token generation time
  on this GPU (Ampere+). Free speed, no downside.
- **`OLLAMA_KEEP_ALIVE=-1`** - keeps a loaded model resident in VRAM
  indefinitely instead of Ollama's 5-minute default. Without this, any pause
  longer than 5 minutes between messages silently unloads the model, so your
  next message pays a ~40-90s reload cost - this is almost always the actual
  cause of "the chat UI feels slow." Override via `-KeepAlive`
  (`run.ps1`)/positional arg 5 (`run.sh`)/`.env` if you'd rather free VRAM
  between uses.

The one thing these can't fix: switching *between* the two models when they
don't both fit in VRAM (see above) always costs a real reload. The chat UI
shows a small "not loaded yet" warning next to the model picker when you've
selected a model that isn't currently resident, so this is never a surprise.

## How it works

Two containers (`docker-compose.yml` / `run.ps1` / `run.sh`), on a shared
Docker network:

- **`local-llm-db`** - a plain `postgres:16-alpine`, not exposed to the host,
  storing everything: chat history, registered projects, and usage logs.
  Data lives on disk at `./data/postgres`, so it survives container rebuilds.
- **`local-llm`** - built from `Dockerfile` on top of the official
  `ollama/ollama` image, runs three processes side by side
  (`docker/entrypoint.sh`):
  - `ollama serve` - the model itself, listening on `127.0.0.1:11500`
    (loopback-only inside the container - nothing reaches it directly).
  - `docker/proxy.py` - a small reverse proxy in front of it, listening on
    port `11434` (the one actually exposed to the host). Every request -
    from the bundled UI or from any other project - passes through here and
    gets attributed to a "project" from its `Authorization: Bearer <name>`
    header. For any project other than the bundled chat UI (`chat-ui`, which
    is deliberately excluded), the proxy:
    1. creates that project a dedicated folder under `./data/projects/<name>/`
       the first time it's seen (see **Project folders** below),
    2. logs the request to Postgres, and
    3. forwards it on to Ollama.
    It also serves the `/_usage/*` and `/_chats/*` JSON APIs the UI uses.
  - `nginx` - serves the chat UI (`ui/`) on port `80`, and reverse-proxies
    `/v1/*`, `/api/*`, `/_usage/*` and `/_chats/*` straight through to the
    proxy on the same origin, so the UI needs no CORS setup or configured
    base URL.

The existing `D:\ollama\Models` folder is bind-mounted straight into the
container's model directory. Nothing is copied or re-downloaded - the
container reads the same blobs/manifests already on disk, and any model you
pull later is written straight back to that same host folder.

## Project folders

The first time a project's name (its API key) is used against the API, it
gets a dedicated folder at `./data/projects/<name>/` - the same idea as a
Claude/ChatGPT Project's own workspace:

```
data/projects/my-project/
  README.md       - written automatically, explains the folder
  context/        - drop .md/.txt files here
```

Anything dropped into `context/` is automatically included as extra system
context on every request that project sends - no code changes needed on the
project's side, just add a file. It's capped at ~6000 characters total
across all files, so keep it to what actually matters (key facts, house
style, API conventions - not entire codebases). The folder and its files
persist even if you clear that project's usage history from the dashboard;
it's a workspace, not a log.

## Quick start (one command)

```powershell
.\run.ps1
```

Builds the image (first run only, or after editing `Dockerfile`/`ui/`) and
starts `local-llm-db` (Postgres) plus `local-llm`:

- **Chat UI** -> `http://localhost:3000`
- **API** (OpenAI-compatible) -> `http://localhost:11434/v1`

Open `http://localhost:3000` in a browser and start chatting. GPU
acceleration is used automatically if an NVIDIA GPU is available (this
machine has one - no config needed).

No GPU / want CPU only:

```powershell
.\run.ps1 -NoGpu
```

Custom ports, models path, or context window:

```powershell
.\run.ps1 -ModelsPath "D:\ollama\Models" -Port 11434 -UiPort 3000 -ContextLength 8192
```

On macOS/Linux/WSL, use `./run.sh` instead (same options, positional:
`./run.sh <models_path> <port> <ui_port> <context_length>`; `NO_GPU=1` works
the same as `-NoGpu`).

### Or via Docker Compose

```powershell
docker compose up -d --build
```

Copy `.env.example` to `.env` first if you want to override the default
ports, models path, or context window.

## Chat UI (`ui/`)

A small, dependency-free chat UI (plain HTML/CSS/JS) that works like
ChatGPT/Claude:

- **Sessions** - each chat is its own entry in the left sidebar, switch
  between them freely. Conversations and messages are stored in Postgres
  (via `/_chats/*`), not browser `localStorage`, so history survives
  clearing the browser, isn't tied to one machine's profile, and would
  support more than one client if you ever pointed a second browser at it.
- **Context per session** - each session sends its own full message history
  with every request, so the model keeps track of the conversation the same
  way ChatGPT/Claude do. The topbar shows a live message/token count for the
  active chat, and turns amber as it approaches the model's context window
  (`OLLAMA_CONTEXT_LENGTH`, 8192 tokens by default - raise it with
  `-ContextLength` / `.env` if you want longer chats, at the cost of more
  VRAM per request).
- **Clearing memory** - three levels, so you can free things up without
  losing everything:
  - **Clear context** (topbar button) - wipes the active chat's history so
    the model "forgets," but keeps the tab/title.
  - **✕ on a chat** (sidebar) - deletes that one session entirely.
  - **Clear all chats** (sidebar) - wipes every session in one go.
- **Settings** (gear icon) - override the API base URL (defaults to `/v1`,
  routed through the bundled nginx proxy) or set a system prompt applied to
  new messages.
- **Integrate into a project** (sidebar button) - the fast path for wiring
  this model into whatever you're building locally: give it a project name,
  pick a model, and copy a ready-to-paste snippet (cURL, Python, Node.js,
  LangChain Python/JS, or a `.env` block) that points straight at
  `http://localhost:11434/v1`. The project name becomes the snippet's API
  key, which is exactly what shows up in **Projects using this model** below
  - no extra setup needed for it to be tracked. Includes a "Test connection"
  check, and a "View this project's usage" link straight into its dashboard
  entry.
- **Projects using this model** (sidebar button) - a live dashboard of the
  actual external projects calling the API through port `11434` (the ones
  set up via "Integrate into a project," or any other script/app pointed at
  it): request counts, total tokens, and when each was last used. Click a
  project to see its request history (timestamp, model, prompt preview,
  tokens, latency). This only tracks real project integrations - the
  bundled chat UI's own conversations are deliberately excluded, so it's not
  cluttered with your own chat history. Clear a single project's history or
  wipe everything, right from the dashboard.
- Streaming responses, markdown + syntax-highlighted code blocks with a copy
  button, model picker.

After editing anything in `ui/`, rebuild with `.\run.ps1` (or
`docker compose up -d --build`) to pick up the changes.

## Using it from a project (development mode)

The container exposes an **OpenAI-compatible API** on port `11434`, so any
tool or SDK that can talk to OpenAI can talk to this instead - just point it
at `http://localhost:11434/v1`. The API key field is otherwise ignored, but
worth setting to something recognizable (e.g. the project's name) since
that's exactly what's used to attribute requests in the usage dashboard.

```
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=my-project
```

Working examples:

- `examples/python/chat.py` - Python, using the `openai` package
- `examples/node/chat.mjs` - Node.js, using the `openai` package

Run them with `OLLAMA_MODEL` set to whichever model you want
(`qwen2.5:7b-instruct-q4_K_M` or `qwen2.5-coder:14b`).

Ollama's native API is also available if you need features beyond the
OpenAI-compatible subset (e.g. `/api/generate`, `/api/chat`, `/api/embeddings`) -
see the [Ollama API docs](https://github.com/ollama/ollama/blob/main/docs/api.md).

## Managing the containers

```powershell
docker ps                        # check they're running
docker logs -f local-llm         # tail app logs (ollama, nginx, proxy)
docker logs -f local-llm-db      # tail Postgres logs
docker stop local-llm local-llm-db
docker start local-llm local-llm-db   # survives reboot with --restart unless-stopped
docker rm -f local-llm local-llm-db   # remove containers (data on disk in ./data is untouched)
```

## Adding more models later

Pull into the running container - it lands directly in `D:\ollama\Models`,
same as if you'd run `ollama pull` locally:

```powershell
docker exec local-llm ollama pull <model>
```
