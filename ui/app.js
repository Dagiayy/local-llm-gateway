(() => {
  "use strict";

  const SETTINGS_KEY = "localllm.settings";
  // 7b first: it's the "standard" fast default (fits VRAM alongside nothing
  // else fighting it) - qwen2.5-coder:14b is the deliberate, slower choice
  // for heavy coding sessions (see the model-swap warning in the UI).
  const FALLBACK_MODELS = ["qwen2.5:7b-instruct-q4_K_M", "qwen2.5-coder:14b"];
  // Rough heuristic (chars/4) to flag when a chat is approaching the model's
  // default context window (OLLAMA_CONTEXT_LENGTH, 8192 by default - see .env.example).
  const CONTEXT_WARNING_TOKENS = 6000;

  const el = {
    messages: document.getElementById("messages"),
    emptyState: document.getElementById("emptyState"),
    conversationList: document.getElementById("conversationList"),
    modelSelect: document.getElementById("modelSelect"),
    modelSwapWarning: document.getElementById("modelSwapWarning"),
    statusDot: document.getElementById("statusDot"),
    composerForm: document.getElementById("composerForm"),
    promptInput: document.getElementById("promptInput"),
    sendBtn: document.getElementById("sendBtn"),
    stopBtn: document.getElementById("stopBtn"),
    newChatBtn: document.getElementById("newChatBtn"),
    clearAllBtn: document.getElementById("clearAllBtn"),
    contextInfo: document.getElementById("contextInfo"),
    clearContextBtn: document.getElementById("clearContextBtn"),
    settingsBtn: document.getElementById("settingsBtn"),
    settingsBackdrop: document.getElementById("settingsBackdrop"),
    baseUrlInput: document.getElementById("baseUrlInput"),
    systemPromptInput: document.getElementById("systemPromptInput"),
    settingsSave: document.getElementById("settingsSave"),
    settingsCancel: document.getElementById("settingsCancel"),
    integrateBtn: document.getElementById("integrateBtn"),
    integrateBackdrop: document.getElementById("integrateBackdrop"),
    integrateProjectInput: document.getElementById("integrateProjectInput"),
    integrateModelSelect: document.getElementById("integrateModelSelect"),
    integratePortInput: document.getElementById("integratePortInput"),
    testConnectionBtn: document.getElementById("testConnectionBtn"),
    connectionResult: document.getElementById("connectionResult"),
    snippetTabs: document.querySelectorAll(".snippet-tab"),
    snippetCode: document.getElementById("snippetCode"),
    snippetCopyBtn: document.getElementById("snippetCopyBtn"),
    integrateClose: document.getElementById("integrateClose"),
    viewInUsageBtn: document.getElementById("viewInUsageBtn"),
    usageBtn: document.getElementById("usageBtn"),
    usageBackdrop: document.getElementById("usageBackdrop"),
    usageSummary: document.getElementById("usageSummary"),
    usageProjectList: document.getElementById("usageProjectList"),
    usageHistoryTitle: document.getElementById("usageHistoryTitle"),
    usageHistoryFolder: document.getElementById("usageHistoryFolder"),
    usageHistoryTable: document.getElementById("usageHistoryTable"),
    clearProjectHistoryBtn: document.getElementById("clearProjectHistoryBtn"),
    clearAllUsageBtn: document.getElementById("clearAllUsageBtn"),
    usageClose: document.getElementById("usageClose"),
  };

  const state = {
    conversations: [],
    activeId: null,
    streaming: false,
    abortController: null,
    settings: loadSettings(),
    models: FALLBACK_MODELS.slice(),
    integrateTab: "curl",
    usageSelectedProject: null,
    usageProjectsCache: [],
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        return {
          baseUrl: "/v1", systemPrompt: "", externalApiPort: 11434, lastProjectName: "my-project",
          ...JSON.parse(raw),
        };
      }
    } catch (_) {}
    return { baseUrl: "/v1", systemPrompt: "", externalApiPort: 11434, lastProjectName: "my-project" };
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  // Conversations live in Postgres (via docker/proxy.py's /_chats/* API),
  // not localStorage - so chat history survives clearing the browser and
  // isn't tied to one machine's browser profile. Each conversation's
  // `messages` stays `undefined` until it's actually opened (lazy-loaded),
  // so listing chats doesn't mean fetching every message in every chat.

  async function loadConversations() {
    try {
      const res = await fetch("/_chats/conversations");
      const data = await res.json();
      return (data.conversations || []).map((c) => ({
        id: c.id, title: c.title, model: c.model, messages: undefined,
      }));
    } catch (_) {
      return [];
    }
  }

  async function ensureMessagesLoaded(convo) {
    if (convo.messages !== undefined) return;
    try {
      const res = await fetch(`/_chats/messages?conversation_id=${encodeURIComponent(convo.id)}`);
      const data = await res.json();
      convo.messages = (data.messages || []).map((m) => ({ role: m.role, content: m.content }));
    } catch (_) {
      convo.messages = [];
    }
  }

  function getActive() {
    return state.conversations.find((c) => c.id === state.activeId) || null;
  }

  async function newConversation() {
    const model = el.modelSelect.value || state.models[0] || FALLBACK_MODELS[0];
    let created;
    try {
      const res = await fetch("/_chats/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New chat", model }),
      });
      created = await res.json();
    } catch (_) {
      setStatus(false);
      return;
    }
    const convo = { id: created.id, title: created.title, model: created.model, messages: [] };
    state.conversations.unshift(convo);
    state.activeId = convo.id;
    renderConversationList();
    renderMessages();
    el.promptInput.focus();
  }

  async function deleteConversation(id) {
    fetch(`/_chats/conversations?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    state.conversations = state.conversations.filter((c) => c.id !== id);
    if (state.activeId === id) {
      const nextId = state.conversations[0]?.id || null;
      if (nextId) {
        await selectConversation(nextId);
        return;
      }
      state.activeId = null;
      renderMessages();
    }
    renderConversationList();
  }

  async function selectConversation(id) {
    state.activeId = id;
    const convo = getActive();
    if (convo) {
      el.modelSelect.value = convo.model;
      updateModelSwapWarning();
      await ensureMessagesLoaded(convo);
    }
    renderConversationList();
    renderMessages();
  }

  function renderConversationList() {
    el.conversationList.innerHTML = "";
    for (const convo of state.conversations) {
      const item = document.createElement("div");
      item.className = "conversation-item" + (convo.id === state.activeId ? " active" : "");
      item.innerHTML = `<span class="title"></span><button class="delete-btn" title="Delete">✕</button>`;
      item.querySelector(".title").textContent = convo.title;
      item.addEventListener("click", (e) => {
        if (e.target.closest(".delete-btn")) return;
        selectConversation(convo.id);
      });
      item.querySelector(".delete-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${convo.title}"? This can't be undone.`)) {
          deleteConversation(convo.id);
        }
      });
      el.conversationList.appendChild(item);
    }
  }

  function renderMarkdown(text) {
    if (window.marked) {
      return marked.parse(text, { breaks: true });
    }
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function highlightCodeBlocks(container) {
    if (!window.hljs) return;
    container.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightElement(block);
      if (!block.parentElement.querySelector(".copy-btn")) {
        const btn = document.createElement("button");
        btn.className = "copy-btn";
        btn.textContent = "Copy";
        btn.addEventListener("click", () => {
          navigator.clipboard.writeText(block.textContent).then(() => {
            btn.textContent = "Copied!";
            setTimeout(() => (btn.textContent = "Copy"), 1500);
          });
        });
        block.parentElement.style.position = "relative";
        block.parentElement.appendChild(btn);
      }
    });
  }

  function renderMessages() {
    const convo = getActive();
    el.messages.innerHTML = "";
    if (!convo || convo.messages.length === 0) {
      el.messages.appendChild(el.emptyState);
      updateContextInfo();
      return;
    }
    for (const msg of convo.messages) {
      el.messages.appendChild(buildMessageEl(msg.role, msg.content));
    }
    highlightCodeBlocks(el.messages);
    scrollToBottom();
    updateContextInfo();
  }

  function updateContextInfo() {
    const convo = getActive();
    if (!convo || convo.messages.length === 0) {
      el.contextInfo.textContent = "";
      el.clearContextBtn.classList.add("hidden");
      return;
    }
    const charCount = convo.messages.reduce((sum, m) => sum + m.content.length, 0);
    const approxTokens = Math.round(charCount / 4);
    el.contextInfo.textContent = `${convo.messages.length} msgs · ~${approxTokens.toLocaleString()} tokens in context`;
    el.contextInfo.classList.toggle("context-warning", approxTokens > CONTEXT_WARNING_TOKENS);
    el.clearContextBtn.classList.remove("hidden");
  }

  async function clearActiveContext() {
    const convo = getActive();
    if (!convo) return;
    if (!confirm("Clear this chat's memory? The tab stays, but the model will forget everything said so far.")) return;
    await fetch(`/_chats/messages?conversation_id=${encodeURIComponent(convo.id)}`, { method: "DELETE" }).catch(() => {});
    convo.messages = [];
    renderMessages();
  }

  async function clearAllConversations() {
    if (state.conversations.length === 0) return;
    if (!confirm(`Delete all ${state.conversations.length} chat(s)? This frees all stored history and can't be undone.`)) return;
    await fetch("/_chats/conversations", { method: "DELETE" }).catch(() => {});
    state.conversations = [];
    state.activeId = null;
    renderConversationList();
    renderMessages();
  }

  // --- Integrate-into-a-project panel ---

  function buildExternalBaseUrl(port) {
    return `http://localhost:${port}/v1`;
  }

  function buildSnippet(kind, model, port, projectName) {
    const baseUrl = buildExternalBaseUrl(port);
    const project = projectName || "my-project";
    switch (kind) {
      case "curl":
        return {
          lang: "bash",
          code: `curl ${baseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${project}" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
        };
      case "python":
        return {
          lang: "python",
          code: `# pip install openai
from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${project}",  # doubles as this project's name in the usage dashboard
)

response = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello!"}],
)

print(response.choices[0].message.content)`,
        };
      case "node":
        return {
          lang: "javascript",
          code: `// npm install openai
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: "${project}", // doubles as this project's name in the usage dashboard
});

const response = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);`,
        };
      case "langchain-py":
        return {
          lang: "python",
          code: `# pip install langchain-openai
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="${baseUrl}",
    api_key="${project}",
    model="${model}",
)

print(llm.invoke("Hello!").content)`,
        };
      case "langchain-js":
        return {
          lang: "javascript",
          code: `// npm install @langchain/openai
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({
  configuration: { baseURL: "${baseUrl}" },
  apiKey: "${project}",
  model: "${model}",
});

console.log((await llm.invoke("Hello!")).content);`,
        };
      case "env":
        return {
          lang: "plaintext",
          code: `OPENAI_BASE_URL=${baseUrl}
OPENAI_API_KEY=${project}
OPENAI_MODEL=${model}`,
        };
      default:
        return { lang: "plaintext", code: "" };
    }
  }

  function renderSnippet() {
    const model = el.integrateModelSelect.value || state.models[0];
    const port = parseInt(el.integratePortInput.value, 10) || 11434;
    const project = el.integrateProjectInput.value.trim() || "my-project";
    const { lang, code } = buildSnippet(state.integrateTab, model, port, project);
    el.snippetCode.className = `language-${lang}`;
    el.snippetCode.textContent = code;
    if (window.hljs) hljs.highlightElement(el.snippetCode);
  }

  function openIntegrateModal() {
    const activeModel = getActive()?.model || el.modelSelect.value;
    populateSelect(el.integrateModelSelect, state.models);
    if (state.models.includes(activeModel)) el.integrateModelSelect.value = activeModel;
    el.integratePortInput.value = state.settings.externalApiPort || 11434;
    el.integrateProjectInput.value = state.settings.lastProjectName || "my-project";
    el.connectionResult.textContent = "";
    el.connectionResult.className = "connection-result";
    for (const tab of el.snippetTabs) {
      tab.classList.toggle("active", tab.dataset.snippet === state.integrateTab);
    }
    renderSnippet();
    el.integrateBackdrop.classList.remove("hidden");
  }

  async function testConnection() {
    const port = parseInt(el.integratePortInput.value, 10) || 11434;
    el.connectionResult.textContent = "Checking...";
    el.connectionResult.className = "connection-result";
    try {
      const res = await fetch(`${buildExternalBaseUrl(port)}/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const count = (data.data || []).length;
      el.connectionResult.textContent = `Reachable at localhost:${port} - ${count} model(s) available.`;
      el.connectionResult.className = "connection-result ok";
    } catch (err) {
      el.connectionResult.textContent = `Can't reach localhost:${port} - is the container running with that port mapped?`;
      el.connectionResult.className = "connection-result fail";
    }
  }

  // --- Projects-using-this-model dashboard ---
  // Backed by docker/proxy.py, which every request (chat UI included) passes
  // through on its way to Ollama. /_usage/* is same-origin via the nginx
  // proxy, so these are always plain relative fetches.

  function timeAgo(epochSeconds) {
    if (!epochSeconds) return "";
    const seconds = Math.round(Date.now() / 1000 - epochSeconds);
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  async function openUsageModal(preselectProject) {
    state.usageSelectedProject = preselectProject || null;
    el.usageBackdrop.classList.remove("hidden");
    await refreshUsageSummary();
    await refreshUsageProjects();
    if (state.usageSelectedProject) {
      loadUsageHistory(state.usageSelectedProject);
    } else {
      renderUsageHistory(null);
    }
  }

  async function refreshUsageSummary() {
    try {
      const res = await fetch("/_usage/summary");
      const data = await res.json();
      if (!data.total_requests) {
        el.usageSummary.textContent =
          "No usage recorded yet - integrate the model into a project (see “Integrate into a project”) and it'll show up here.";
      } else {
        const since = data.first_seen ? new Date(data.first_seen * 1000).toLocaleDateString() : "";
        el.usageSummary.textContent =
          `${data.total_requests} request(s) across ${data.total_projects} project(s) · ` +
          `~${data.total_tokens.toLocaleString()} tokens total · tracking since ${since}.`;
      }
    } catch (_) {
      el.usageSummary.textContent = "Couldn't load usage data - is the container running?";
    }
  }

  async function refreshUsageProjects() {
    el.usageProjectList.innerHTML = '<div class="usage-empty">Loading...</div>';
    try {
      const res = await fetch("/_usage/projects");
      const data = await res.json();
      const projects = data.projects || [];
      state.usageProjectsCache = projects;
      if (projects.length === 0) {
        el.usageProjectList.innerHTML = '<div class="usage-empty">No projects yet.</div>';
        return;
      }
      el.usageProjectList.innerHTML = "";
      for (const p of projects) {
        const item = document.createElement("div");
        item.className = "usage-project-item" + (p.project === state.usageSelectedProject ? " active" : "");
        item.innerHTML = `<div class="name"></div><div class="meta"></div>`;
        item.querySelector(".name").textContent = p.project;
        const totalTokens = (p.prompt_tokens + p.completion_tokens).toLocaleString();
        item.querySelector(".meta").textContent =
          `${p.requests} req · ${totalTokens} tok · ${timeAgo(p.last_seen)}`;
        item.addEventListener("click", () => {
          state.usageSelectedProject = p.project;
          refreshUsageProjects();
          loadUsageHistory(p.project);
        });
        el.usageProjectList.appendChild(item);
      }
    } catch (_) {
      el.usageProjectList.innerHTML = '<div class="usage-empty">Couldn\'t load projects.</div>';
    }
  }

  async function loadUsageHistory(project) {
    el.usageHistoryTitle.textContent = project;
    el.clearProjectHistoryBtn.classList.remove("hidden");
    const cached = state.usageProjectsCache.find((p) => p.project === project);
    if (cached && cached.folder_path) {
      el.usageHistoryFolder.textContent = `📁 ${cached.folder_path} - drop files in its context/ folder to give this project persistent knowledge`;
      el.usageHistoryFolder.classList.remove("hidden");
    } else {
      el.usageHistoryFolder.classList.add("hidden");
    }
    el.usageHistoryTable.innerHTML = '<div class="usage-empty">Loading...</div>';
    try {
      const res = await fetch(`/_usage/history?project=${encodeURIComponent(project)}`);
      const data = await res.json();
      renderUsageHistory(data.history || []);
    } catch (_) {
      el.usageHistoryTable.innerHTML = '<div class="usage-empty">Couldn\'t load history.</div>';
    }
  }

  function renderUsageHistory(rows) {
    if (rows === null) {
      el.usageHistoryTitle.textContent = "Select a project";
      el.clearProjectHistoryBtn.classList.add("hidden");
      el.usageHistoryFolder.classList.add("hidden");
      el.usageHistoryTable.innerHTML =
        '<div class="usage-empty">Pick a project on the left to see its request history.</div>';
      return;
    }
    if (rows.length === 0) {
      el.usageHistoryTable.innerHTML = '<div class="usage-empty">No requests logged yet.</div>';
      return;
    }
    el.usageHistoryTable.innerHTML = "";
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "usage-row";
      row.innerHTML = `<div class="top"><span></span><span></span></div><div class="prompt"></div>`;
      const spans = row.querySelectorAll(".top span");
      spans[0].textContent = `${r.model || "?"} · ${new Date(r.ts * 1000).toLocaleString()}`;
      spans[1].textContent = `${r.prompt_tokens}+${r.completion_tokens} tok · ${r.duration_ms}ms`;
      row.querySelector(".prompt").textContent = r.prompt_preview || "(no preview)";
      el.usageHistoryTable.appendChild(row);
    }
  }

  async function clearProjectHistory() {
    const project = state.usageSelectedProject;
    if (!project) return;
    if (!confirm(`Clear all usage history for "${project}"? This can't be undone.`)) return;
    await fetch(`/_usage/history?project=${encodeURIComponent(project)}`, { method: "DELETE" });
    state.usageSelectedProject = null;
    await refreshUsageSummary();
    await refreshUsageProjects();
    renderUsageHistory(null);
  }

  async function clearAllUsage() {
    if (!confirm("Clear ALL usage history for every project? This can't be undone.")) return;
    await fetch("/_usage/history", { method: "DELETE" });
    state.usageSelectedProject = null;
    await refreshUsageSummary();
    await refreshUsageProjects();
    renderUsageHistory(null);
  }

  function buildMessageEl(role, content) {
    const wrap = document.createElement("div");
    wrap.className = `message ${role}`;
    const roleLabel = role === "user" ? "You" : "Assistant";
    wrap.innerHTML = `<div class="role">${roleLabel}</div><div class="bubble"></div>`;
    wrap.querySelector(".bubble").innerHTML = renderMarkdown(content);
    return wrap;
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  async function loadModels() {
    try {
      const res = await fetch(`${state.settings.baseUrl}/models`);
      if (!res.ok) throw new Error("bad status");
      const data = await res.json();
      const ids = (data.data || []).map((m) => m.id);
      state.models = ids.length ? ids : FALLBACK_MODELS;
      populateModelSelect(ids.length ? ids : FALLBACK_MODELS);
      setStatus(true);
    } catch (_) {
      state.models = FALLBACK_MODELS.slice();
      populateModelSelect(FALLBACK_MODELS);
      setStatus(false);
    }
  }

  // Labels only - option.value stays the raw model id used in API calls.
  function modelDisplayLabel(id) {
    if (id === "qwen2.5:7b-instruct-q4_K_M") return `${id} — standard, fast`;
    if (id === "qwen2.5-coder:14b") return `${id} — heavy coding, slow to swap in`;
    return id;
  }

  function populateSelect(selectEl, ids, labelFn) {
    const current = selectEl.value;
    selectEl.innerHTML = "";
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = labelFn ? labelFn(id) : id;
      selectEl.appendChild(opt);
    }
    if (ids.includes(current)) selectEl.value = current;
  }

  function populateModelSelect(ids) {
    populateSelect(el.modelSelect, ids, modelDisplayLabel);
  }

  async function updateModelSwapWarning() {
    const selected = el.modelSelect.value;
    if (!selected) {
      el.modelSwapWarning.classList.add("hidden");
      return;
    }
    try {
      const res = await fetch("/api/ps");
      const data = await res.json();
      const loaded = (data.models || []).map((m) => m.name);
      if (!loaded.includes(selected)) {
        el.modelSwapWarning.textContent = "⏳ not loaded yet - first message will take a while to load";
        el.modelSwapWarning.classList.remove("hidden");
      } else {
        el.modelSwapWarning.classList.add("hidden");
      }
    } catch (_) {
      el.modelSwapWarning.classList.add("hidden");
    }
  }

  function setStatus(online) {
    el.statusDot.classList.toggle("online", online);
    el.statusDot.classList.toggle("offline", !online);
    el.statusDot.title = online ? "Connected" : "Cannot reach API";
  }

  function autoResizeTextarea() {
    el.promptInput.style.height = "auto";
    el.promptInput.style.height = Math.min(el.promptInput.scrollHeight, 200) + "px";
  }

  function setStreamingUi(streaming) {
    state.streaming = streaming;
    el.sendBtn.classList.toggle("hidden", streaming);
    el.stopBtn.classList.toggle("hidden", !streaming);
    el.promptInput.disabled = streaming;
  }

  async function sendMessage(text) {
    let convo = getActive();
    if (!convo) {
      await newConversation();
      convo = getActive();
      if (!convo) return; // couldn't create a conversation - server unreachable
    }
    convo.messages.push({ role: "user", content: text });
    let titleChanged = false;
    if (convo.title === "New chat") {
      convo.title = text.slice(0, 40) + (text.length > 40 ? "..." : "");
      titleChanged = true;
    }
    renderConversationList();
    renderMessages();

    fetch("/_chats/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: convo.id, role: "user", content: text }),
    }).catch(() => {});
    if (titleChanged) {
      fetch(`/_chats/conversations?id=${encodeURIComponent(convo.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: convo.title }),
      }).catch(() => {});
    }

    const assistantMsg = { role: "assistant", content: "" };
    convo.messages.push(assistantMsg);
    const assistantEl = buildMessageEl("assistant", "");
    el.messages.appendChild(assistantEl);
    const bubble = assistantEl.querySelector(".bubble");
    bubble.classList.add("cursor-blink");
    scrollToBottom();

    const payloadMessages = [];
    if (state.settings.systemPrompt) {
      payloadMessages.push({ role: "system", content: state.settings.systemPrompt });
    }
    for (const m of convo.messages.slice(0, -1)) {
      payloadMessages.push({ role: m.role, content: m.content });
    }

    setStreamingUi(true);
    state.abortController = new AbortController();

    try {
      const res = await fetch(`${state.settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer chat-ui" },
        signal: state.abortController.signal,
        body: JSON.stringify({
          model: convo.model,
          messages: payloadMessages,
          stream: true,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              assistantMsg.content += delta;
              bubble.innerHTML = renderMarkdown(assistantMsg.content);
              highlightCodeBlocks(assistantEl);
              scrollToBottom();
            }
          } catch (_) {
            // ignore malformed SSE chunk
          }
        }
      }
      setStatus(true);
    } catch (err) {
      if (err.name === "AbortError") {
        assistantMsg.content += "\n\n*(stopped)*";
      } else {
        assistantMsg.content = assistantMsg.content || "";
        const errEl = document.createElement("div");
        errEl.className = "error-bubble";
        errEl.textContent = `Error: ${err.message}. Is the API running at ${state.settings.baseUrl}?`;
        assistantEl.appendChild(errEl);
        setStatus(false);
      }
    } finally {
      bubble.classList.remove("cursor-blink");
      bubble.innerHTML = renderMarkdown(assistantMsg.content);
      highlightCodeBlocks(assistantEl);
      renderConversationList();
      updateContextInfo();
      updateModelSwapWarning();
      setStreamingUi(false);
      state.abortController = null;
      if (assistantMsg.content) {
        fetch("/_chats/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: convo.id, role: "assistant", content: assistantMsg.content }),
        }).catch(() => {});
      }
    }
  }

  // Event wiring
  el.newChatBtn.addEventListener("click", newConversation);
  el.clearAllBtn.addEventListener("click", clearAllConversations);
  el.clearContextBtn.addEventListener("click", clearActiveContext);

  el.composerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.promptInput.value.trim();
    if (!text || state.streaming) return;
    el.promptInput.value = "";
    autoResizeTextarea();
    sendMessage(text);
  });

  el.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el.composerForm.requestSubmit();
    }
  });

  el.promptInput.addEventListener("input", autoResizeTextarea);

  el.stopBtn.addEventListener("click", () => {
    if (state.abortController) state.abortController.abort();
  });

  el.modelSelect.addEventListener("change", () => {
    updateModelSwapWarning();
    const convo = getActive();
    if (convo) {
      convo.model = el.modelSelect.value;
      fetch(`/_chats/conversations?id=${encodeURIComponent(convo.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: convo.model }),
      }).catch(() => {});
    }
  });

  el.settingsBtn.addEventListener("click", () => {
    el.baseUrlInput.value = state.settings.baseUrl;
    el.systemPromptInput.value = state.settings.systemPrompt || "";
    el.settingsBackdrop.classList.remove("hidden");
  });

  el.settingsCancel.addEventListener("click", () => {
    el.settingsBackdrop.classList.add("hidden");
  });

  el.settingsSave.addEventListener("click", () => {
    state.settings.baseUrl = el.baseUrlInput.value.trim().replace(/\/$/, "") || "/v1";
    state.settings.systemPrompt = el.systemPromptInput.value;
    saveSettings();
    el.settingsBackdrop.classList.add("hidden");
    loadModels();
  });

  el.settingsBackdrop.addEventListener("click", (e) => {
    if (e.target === el.settingsBackdrop) el.settingsBackdrop.classList.add("hidden");
  });

  el.integrateBtn.addEventListener("click", openIntegrateModal);

  el.integrateClose.addEventListener("click", () => {
    el.integrateBackdrop.classList.add("hidden");
  });

  el.integrateBackdrop.addEventListener("click", (e) => {
    if (e.target === el.integrateBackdrop) el.integrateBackdrop.classList.add("hidden");
  });

  el.integrateModelSelect.addEventListener("change", renderSnippet);

  el.integratePortInput.addEventListener("input", () => {
    state.settings.externalApiPort = parseInt(el.integratePortInput.value, 10) || 11434;
    saveSettings();
    renderSnippet();
  });

  el.integrateProjectInput.addEventListener("input", () => {
    state.settings.lastProjectName = el.integrateProjectInput.value.trim() || "my-project";
    saveSettings();
    renderSnippet();
  });

  el.testConnectionBtn.addEventListener("click", testConnection);

  for (const tab of el.snippetTabs) {
    tab.addEventListener("click", () => {
      state.integrateTab = tab.dataset.snippet;
      for (const t of el.snippetTabs) t.classList.toggle("active", t === tab);
      renderSnippet();
    });
  }

  el.snippetCopyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(el.snippetCode.textContent).then(() => {
      el.snippetCopyBtn.textContent = "Copied!";
      setTimeout(() => (el.snippetCopyBtn.textContent = "Copy"), 1500);
    });
  });

  el.usageBtn.addEventListener("click", () => openUsageModal());

  el.viewInUsageBtn.addEventListener("click", () => {
    const project = el.integrateProjectInput.value.trim() || "my-project";
    el.integrateBackdrop.classList.add("hidden");
    openUsageModal(project);
  });

  el.usageClose.addEventListener("click", () => {
    el.usageBackdrop.classList.add("hidden");
  });

  el.usageBackdrop.addEventListener("click", (e) => {
    if (e.target === el.usageBackdrop) el.usageBackdrop.classList.add("hidden");
  });

  el.clearProjectHistoryBtn.addEventListener("click", clearProjectHistory);
  el.clearAllUsageBtn.addEventListener("click", clearAllUsage);

  // Init
  (async () => {
    state.conversations = await loadConversations();
    renderConversationList();
    await loadModels();
    if (state.conversations.length) {
      await selectConversation(state.conversations[0].id);
    } else {
      updateModelSwapWarning();
      renderMessages();
    }
    autoResizeTextarea();
  })();
})();
