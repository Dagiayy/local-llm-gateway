#!/usr/bin/env python3
"""Reverse proxy that sits in front of `ollama serve`.

It forwards every request through untouched (streaming included), but also:
  - attributes each generation request to a "project", read from the
    Authorization: Bearer <token> header (the API key field every OpenAI SDK
    already requires) or an X-Project-Name header,
  - gives each real project a dedicated folder on disk (/data/projects/<name>/)
    the first time it's seen, with a context/ subfolder whose files are
    automatically injected as extra system context on every request from
    that project - the same idea as "project knowledge" in Claude/ChatGPT
    Projects,
  - logs usage (model, prompt preview, token counts, latency) and the chat
    UI's own conversations to Postgres, and
  - serves small JSON APIs under /_usage/* and /_chats/* for the UI.

This is a local dev tool, not a production proxy: it trades HTTP-spec and
SQL-injection-proof completeness for something small enough to read in one
sitting (all values are still passed as query parameters, never
string-formatted into SQL, so it's not blindly unsafe - just unoptimized).
"""

import http.client
import http.server
import json
import os
import re
import socketserver
import time
import uuid
from urllib.parse import parse_qs, urlparse

import psycopg2

UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = int(os.environ.get("OLLAMA_INTERNAL_PORT", "11500"))
LISTEN_PORT = int(os.environ.get("PROXY_PORT", "11434"))
PROJECTS_DIR = os.environ.get("PROJECTS_DIR", "/data/projects")
PROJECT_CONTEXT_CHAR_LIMIT = 6000

PG_HOST = os.environ.get("POSTGRES_HOST", "local-llm-db")
PG_PORT = int(os.environ.get("POSTGRES_PORT", "5432"))
PG_DB = os.environ.get("POSTGRES_DB", "localllm")
PG_USER = os.environ.get("POSTGRES_USER", "localllm")
PG_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "localllm")

# Chat/generation endpoints - eligible for project-context injection (it only
# makes sense to add a system message / prepend a prompt for these).
CHAT_PATHS = {"/v1/chat/completions", "/v1/completions", "/api/chat", "/api/generate"}
# Embedding endpoints - logged and count towards a project's usage/existence,
# but never context-injected (that would corrupt the vector being embedded).
# RAG-style projects often call *only* these, never chat/completions.
EMBEDDING_PATHS = {"/v1/embeddings", "/api/embeddings", "/api/embed"}
# Things like /v1/models or /api/tags are just metadata lookups and aren't
# logged at all.
LOGGED_PATHS = CHAT_PATHS | EMBEDDING_PATHS

# Headers we never blindly forward as-is in either direction.
STRIP_REQUEST_HEADERS = {"host", "content-length", "connection", "accept-encoding"}
STRIP_RESPONSE_HEADERS = {
    "content-length", "connection", "transfer-encoding", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "te", "trailers", "upgrade",
}

PROJECT_README_TEMPLATE = """# {name}

This folder is this project's dedicated workspace for its connection to the
local model - created automatically the first time "{name}" was used as the
project name (the API key) on a request.

## context/

Drop text or markdown files in `context/` and their contents are
automatically included as extra context on every request this project sends
to the model, the same idea as "project knowledge" in Claude/ChatGPT
Projects. No code changes needed on the project's side - just add files here.
Keep it reasonably small: only the first ~{limit} characters across all
files are actually sent.
"""


def get_conn():
    return psycopg2.connect(
        host=PG_HOST, port=PG_PORT, dbname=PG_DB, user=PG_USER, password=PG_PASSWORD
    )


def init_db():
    os.makedirs(PROJECTS_DIR, exist_ok=True)

    conn = None
    last_err = None
    for _ in range(30):
        try:
            conn = get_conn()
            break
        except psycopg2.OperationalError as e:
            last_err = e
            time.sleep(1)
    if conn is None:
        raise RuntimeError(f"could not connect to postgres at {PG_HOST}:{PG_PORT}: {last_err}")

    cur = conn.cursor()
    cur.execute(
        """CREATE TABLE IF NOT EXISTS projects (
            name TEXT PRIMARY KEY,
            folder_path TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )"""
    )
    cur.execute(
        """CREATE TABLE IF NOT EXISTS requests (
            id SERIAL PRIMARY KEY,
            ts TIMESTAMPTZ NOT NULL DEFAULT now(),
            project TEXT NOT NULL,
            model TEXT,
            endpoint TEXT,
            prompt_preview TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            duration_ms INTEGER,
            status INTEGER
        )"""
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_requests_project ON requests(project)")
    cur.execute(
        """CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New chat',
            model TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )"""
    )
    cur.execute(
        """CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )"""
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)")
    conn.commit()
    cur.close()
    conn.close()


def project_from_headers(headers):
    auth = headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
        if token:
            return token
    x_project = (headers.get("X-Project-Name") or "").strip()
    if x_project:
        return x_project
    return "unlabeled"


def estimate_tokens(char_count):
    return max(0, round(char_count / 4))


def safe_slug(name):
    slug = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._")
    return (slug or "project")[:80]


def ensure_project(name):
    """Create the project's folder + registry row on first sight. Returns the
    folder path, or None for names that aren't a real external project."""
    if not name or name in ("chat-ui", "unlabeled"):
        return None

    folder = os.path.join(PROJECTS_DIR, safe_slug(name))
    os.makedirs(os.path.join(folder, "context"), exist_ok=True)

    readme_path = os.path.join(folder, "README.md")
    if not os.path.exists(readme_path):
        with open(readme_path, "w", encoding="utf-8") as f:
            f.write(PROJECT_README_TEMPLATE.format(name=name, limit=PROJECT_CONTEXT_CHAR_LIMIT))

    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO projects (name, folder_path) VALUES (%s, %s) ON CONFLICT (name) DO NOTHING",
        (name, folder),
    )
    conn.commit()
    cur.close()
    conn.close()
    return folder


def read_project_context(folder):
    context_dir = os.path.join(folder, "context")
    if not os.path.isdir(context_dir):
        return None
    chunks = []
    total = 0
    for fname in sorted(os.listdir(context_dir)):
        if total >= PROJECT_CONTEXT_CHAR_LIMIT:
            break
        fpath = os.path.join(context_dir, fname)
        if not os.path.isfile(fpath):
            continue
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read(PROJECT_CONTEXT_CHAR_LIMIT - total)
        except OSError:
            continue
        if not text:
            continue
        chunks.append(f"--- {fname} ---\n{text}")
        total += len(text)
    return "\n\n".join(chunks) if chunks else None


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # Postgres is the real log; keep container logs quiet

    def do_GET(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PATCH(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def do_HEAD(self):
        self._dispatch()

    def _dispatch(self):
        # One response per connection. Simpler and avoids any HTTP/1.1
        # keep-alive framing edge cases between the proxy and this tiny
        # server - not worth optimizing for a low-traffic local dev tool.
        self.close_connection = True
        try:
            if self.path.startswith("/_usage/"):
                self._usage_api()
            elif self.path.startswith("/_chats/"):
                self._chats_api()
            else:
                self._proxy()
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _query_param(self, name, default=None):
        qs = parse_qs(urlparse(self.path).query)
        return qs.get(name, [default])[0]

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    # ---------------------------------------------------------------
    # Usage + project dashboard API - handled locally, never forwarded.
    # ---------------------------------------------------------------
    def _usage_api(self):
        path = urlparse(self.path).path
        if path == "/_usage/summary":
            self._usage_summary()
        elif path == "/_usage/projects":
            self._usage_projects()
        elif path == "/_usage/context":
            self._usage_context()
        elif path == "/_usage/history" and self.command == "DELETE":
            self._usage_clear()
        elif path == "/_usage/history":
            self._usage_history()
        else:
            self._send_json(404, {"error": "not found"})

    def _usage_summary(self):
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*), COUNT(DISTINCT project), COALESCE(SUM(prompt_tokens + completion_tokens), 0), "
            "EXTRACT(EPOCH FROM MIN(ts))::float, EXTRACT(EPOCH FROM MAX(ts))::float FROM requests"
        )
        total, projects, tokens, first_seen, last_seen = cur.fetchone()
        cur.close()
        conn.close()
        self._send_json(200, {
            "total_requests": total,
            "total_projects": projects,
            "total_tokens": tokens,
            "first_seen": first_seen,
            "last_seen": last_seen,
        })

    def _usage_projects(self):
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            """SELECT r.project, COUNT(*), COALESCE(SUM(r.prompt_tokens), 0), COALESCE(SUM(r.completion_tokens), 0),
                      EXTRACT(EPOCH FROM MIN(r.ts))::float, EXTRACT(EPOCH FROM MAX(r.ts))::float,
                      STRING_AGG(DISTINCT r.model, ','), MAX(p.folder_path)
               FROM requests r
               LEFT JOIN projects p ON p.name = r.project
               GROUP BY r.project ORDER BY MAX(r.ts) DESC"""
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        projects = [
            {
                "project": r[0],
                "requests": r[1],
                "prompt_tokens": r[2],
                "completion_tokens": r[3],
                "first_seen": r[4],
                "last_seen": r[5],
                "models": sorted(set((r[6] or "").split(","))) if r[6] else [],
                "folder_path": r[7],
            }
            for r in rows
        ]
        self._send_json(200, {"projects": projects})

    def _usage_context(self):
        project = self._query_param("project")
        if not project:
            self._send_json(400, {"error": "missing project"})
            return
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT folder_path FROM projects WHERE name = %s", (project,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        if not row:
            self._send_json(200, {"folder_path": None, "files": []})
            return
        folder = row[0]
        context_dir = os.path.join(folder, "context")
        files = sorted(os.listdir(context_dir)) if os.path.isdir(context_dir) else []
        self._send_json(200, {"folder_path": folder, "files": files})

    def _usage_history(self):
        project = self._query_param("project")
        try:
            limit = int(self._query_param("limit", "100"))
        except (TypeError, ValueError):
            limit = 100
        conn = get_conn()
        cur = conn.cursor()
        base = (
            "SELECT EXTRACT(EPOCH FROM ts)::float, model, endpoint, prompt_preview, prompt_tokens, "
            "completion_tokens, duration_ms, status FROM requests"
        )
        if project:
            cur.execute(base + " WHERE project = %s ORDER BY ts DESC LIMIT %s", (project, limit))
        else:
            cur.execute(base + " ORDER BY ts DESC LIMIT %s", (limit,))
        rows = cur.fetchall()
        cur.close()
        conn.close()
        history = [
            {
                "ts": r[0], "model": r[1], "endpoint": r[2], "prompt_preview": r[3],
                "prompt_tokens": r[4], "completion_tokens": r[5], "duration_ms": r[6], "status": r[7],
            }
            for r in rows
        ]
        self._send_json(200, {"history": history})

    def _usage_clear(self):
        # Clears logged usage only - the project's folder/files are a
        # persistent workspace, like a Claude/ChatGPT Project, and aren't
        # touched by clearing its request history.
        project = self._query_param("project")
        conn = get_conn()
        cur = conn.cursor()
        if project:
            cur.execute("DELETE FROM requests WHERE project = %s", (project,))
        else:
            cur.execute("DELETE FROM requests")
        conn.commit()
        cur.close()
        conn.close()
        self._send_json(200, {"ok": True})

    # ---------------------------------------------------------------
    # Chat UI conversation storage - handled locally, never forwarded.
    # ---------------------------------------------------------------
    def _chats_api(self):
        path = urlparse(self.path).path
        if path == "/_chats/conversations":
            if self.command == "GET":
                self._chats_list_conversations()
            elif self.command == "POST":
                self._chats_create_conversation()
            elif self.command == "PATCH":
                self._chats_update_conversation()
            elif self.command == "DELETE":
                self._chats_delete_conversations()
            else:
                self._send_json(405, {"error": "method not allowed"})
        elif path == "/_chats/messages":
            if self.command == "GET":
                self._chats_list_messages()
            elif self.command == "POST":
                self._chats_create_message()
            elif self.command == "DELETE":
                self._chats_delete_messages()
            else:
                self._send_json(405, {"error": "method not allowed"})
        else:
            self._send_json(404, {"error": "not found"})

    def _chats_list_conversations(self):
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT id, title, model, EXTRACT(EPOCH FROM created_at)::float, EXTRACT(EPOCH FROM updated_at)::float "
            "FROM conversations ORDER BY updated_at DESC"
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        conversations = [
            {"id": r[0], "title": r[1], "model": r[2], "created_at": r[3], "updated_at": r[4]}
            for r in rows
        ]
        self._send_json(200, {"conversations": conversations})

    def _chats_create_conversation(self):
        data = self._read_json_body()
        conv_id = uuid.uuid4().hex
        title = (data.get("title") or "New chat")[:200]
        model = data.get("model") or ""
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO conversations (id, title, model) VALUES (%s, %s, %s)",
            (conv_id, title, model),
        )
        conn.commit()
        cur.close()
        conn.close()
        self._send_json(200, {"id": conv_id, "title": title, "model": model})

    def _chats_update_conversation(self):
        conv_id = self._query_param("id")
        if not conv_id:
            self._send_json(400, {"error": "missing id"})
            return
        data = self._read_json_body()
        fields = []
        values = []
        if "title" in data:
            fields.append("title = %s")
            values.append((data["title"] or "New chat")[:200])
        if "model" in data:
            fields.append("model = %s")
            values.append(data["model"] or "")
        if not fields:
            self._send_json(400, {"error": "nothing to update"})
            return
        fields.append("updated_at = now()")
        values.append(conv_id)
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(f"UPDATE conversations SET {', '.join(fields)} WHERE id = %s", values)
        conn.commit()
        cur.close()
        conn.close()
        self._send_json(200, {"ok": True})

    def _chats_delete_conversations(self):
        conv_id = self._query_param("id")
        conn = get_conn()
        cur = conn.cursor()
        if conv_id:
            cur.execute("DELETE FROM conversations WHERE id = %s", (conv_id,))
        else:
            cur.execute("DELETE FROM conversations")
        conn.commit()
        cur.close()
        conn.close()
        self._send_json(200, {"ok": True})

    def _chats_list_messages(self):
        conv_id = self._query_param("conversation_id")
        if not conv_id:
            self._send_json(400, {"error": "missing conversation_id"})
            return
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT role, content, EXTRACT(EPOCH FROM created_at)::float FROM messages "
            "WHERE conversation_id = %s ORDER BY created_at ASC, id ASC",
            (conv_id,),
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        messages = [{"role": r[0], "content": r[1], "ts": r[2]} for r in rows]
        self._send_json(200, {"messages": messages})

    def _chats_create_message(self):
        data = self._read_json_body()
        conv_id = data.get("conversation_id")
        role = data.get("role")
        content = data.get("content", "")
        if not conv_id or role not in ("user", "assistant", "system"):
            self._send_json(400, {"error": "invalid payload"})
            return
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO messages (conversation_id, role, content) VALUES (%s, %s, %s)",
            (conv_id, role, content),
        )
        cur.execute("UPDATE conversations SET updated_at = now() WHERE id = %s", (conv_id,))
        conn.commit()
        cur.close()
        conn.close()
        self._send_json(200, {"ok": True})

    def _chats_delete_messages(self):
        # Clears a conversation's messages but keeps the conversation/title -
        # this is "Clear context" in the UI.
        conv_id = self._query_param("conversation_id")
        if not conv_id:
            self._send_json(400, {"error": "missing conversation_id"})
            return
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM messages WHERE conversation_id = %s", (conv_id,))
        conn.commit()
        cur.close()
        conn.close()
        self._send_json(200, {"ok": True})

    # ---------------------------------------------------------------
    # Reverse proxy to the real Ollama server, with usage scraping and
    # per-project context injection.
    # ---------------------------------------------------------------
    def _proxy(self):
        content_length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(content_length) if content_length else b""

        req_json = {}
        if body:
            try:
                req_json = json.loads(body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                req_json = {}

        model = req_json.get("model", "")
        messages = req_json.get("messages") or []
        last_user_msg = next(
            (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), ""
        )
        prompt_chars = sum(len(m.get("content", "") or "") for m in messages)
        if not messages and req_json.get("prompt"):
            prompt_chars = len(req_json["prompt"])
            last_user_msg = req_json["prompt"]
        if not messages and not req_json.get("prompt") and req_json.get("input") is not None:
            # Embedding request (/v1/embeddings or /api/embed): "input" is a
            # string or a list of strings, never chat messages.
            raw_input = req_json["input"]
            texts = raw_input if isinstance(raw_input, list) else [raw_input]
            texts = [t for t in texts if isinstance(t, str)]
            prompt_chars = sum(len(t) for t in texts)
            last_user_msg = texts[0] if texts else ""

        endpoint_path = urlparse(self.path).path
        project = project_from_headers(self.headers)
        should_log = endpoint_path in LOGGED_PATHS and project != "chat-ui"

        # Real projects get a dedicated folder + "project knowledge" context
        # injected automatically, mirroring Claude/ChatGPT Projects. Only
        # chat/generation requests get context injected - never embeddings,
        # since altering the input text would corrupt the resulting vector.
        project_folder = ensure_project(project) if should_log else None
        if project_folder and endpoint_path in CHAT_PATHS:
            context_text = read_project_context(project_folder)
            if context_text:
                context_msg = f'Project context for "{project}":\n\n{context_text}'
                if messages:
                    req_json["messages"] = [{"role": "system", "content": context_msg}] + messages
                    body = json.dumps(req_json).encode("utf-8")
                elif req_json.get("prompt"):
                    req_json["prompt"] = f"{context_msg}\n\n{req_json['prompt']}"
                    body = json.dumps(req_json).encode("utf-8")

        forward_headers = {
            k: v for k, v in self.headers.items() if k.lower() not in STRIP_REQUEST_HEADERS
        }
        forward_headers["Host"] = f"{UPSTREAM_HOST}:{UPSTREAM_PORT}"

        start = time.time()
        try:
            upstream = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=600)
            upstream.request(self.command, self.path, body=body or None, headers=forward_headers)
            resp = upstream.getresponse()
        except OSError as e:
            self._send_json(502, {"error": f"cannot reach model server: {e}"})
            return

        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in STRIP_RESPONSE_HEADERS:
                self.send_header(k, v)
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.end_headers()

        parse_buffer = ""
        completion_chars = 0
        usage = None

        def consume_line(line):
            nonlocal usage, completion_chars
            line = line.strip()
            if line.startswith("data:"):
                line = line[5:].strip()
            if not line or line == "[DONE]":
                return
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                return
            if not isinstance(obj, dict):
                return
            if obj.get("usage"):
                usage = obj["usage"]
            if obj.get("prompt_eval_count") is not None or obj.get("eval_count") is not None:
                usage = {
                    "prompt_tokens": obj.get("prompt_eval_count", 0),
                    "completion_tokens": obj.get("eval_count", 0),
                }
            for choice in obj.get("choices") or []:
                delta_content = (choice.get("delta") or {}).get("content")
                if delta_content:
                    completion_chars += len(delta_content)
                msg_content = (choice.get("message") or {}).get("content")
                if msg_content:
                    completion_chars += len(msg_content)
            msg = obj.get("message")
            if isinstance(msg, dict) and msg.get("content"):
                completion_chars += len(msg["content"])
            if isinstance(obj.get("response"), str):
                completion_chars += len(obj["response"])

        try:
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(f"{len(chunk):x}\r\n".encode("ascii"))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                if should_log:
                    parse_buffer += chunk.decode("utf-8", errors="ignore")
                    lines = parse_buffer.split("\n")
                    parse_buffer = lines.pop()
                    for line in lines:
                        consume_line(line)
            if should_log and parse_buffer:
                consume_line(parse_buffer)
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()

        if should_log:
            duration_ms = int((time.time() - start) * 1000)
            prompt_tokens = usage.get("prompt_tokens") if usage else None
            completion_tokens = usage.get("completion_tokens") if usage else None
            if prompt_tokens is None:
                prompt_tokens = estimate_tokens(prompt_chars)
            if completion_tokens is None:
                completion_tokens = estimate_tokens(completion_chars)
            conn = get_conn()
            cur = conn.cursor()
            cur.execute(
                """INSERT INTO requests
                   (project, model, endpoint, prompt_preview, prompt_tokens, completion_tokens, duration_ms, status)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (project, model, endpoint_path, last_user_msg[:200], prompt_tokens, completion_tokens,
                 duration_ms, resp.status),
            )
            conn.commit()
            cur.close()
            conn.close()


def main():
    init_db()
    server = socketserver.ThreadingTCPServer(("0.0.0.0", LISTEN_PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
