// Courtesy Luxury Codex & AI Cluster Fleet - Antigravity IDE Client

let currentTab = 'codex';
let chatHistory = [];
let ws = null;
let currentServers = [];
let isStreaming = false;

// API Base URL (defaults to Pi gateway 100.107.249.92:8000, or local if hosted there)
let apiBaseUrl = (window.location.protocol === 'file:' || !window.location.host || window.location.hostname === 'localhost')
  ? 'http://100.107.249.92:8000'
  : window.location.origin;

// Presets for the Codex Assistant
const PROMPT_PRESETS = {
  coder: "You are Courtesy Codex, a world-class autonomous AI coding assistant. You write production-ready, clean, well-tested, robust code. Follow modern best practices, handle edge cases, and provide concise, insightful explanations.",
  bughunter: "You are an elite software auditor and bug hunter. Analyze the code, identify edge cases, vulnerabilities, race conditions, and logic errors. Provide precise code fixes and explanations.",
  refactor: "You are an expert software architect. Refactor the given code for maximum readability, maintainability, modularity, and high performance while preserving exact functional correctness.",
  tests: "You are a senior test automation engineer. Write comprehensive unit and integration tests covering edge cases, happy paths, boundary conditions, and mocks where necessary.",
  explainer: "You are a senior codebase analyst and mentor. Explain the architectural decisions, mechanics, and patterns of the given code with clear examples."
};

// Language extensions map
const EXT_MAP = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  rust: 'rs',
  go: 'go',
  cpp: 'cpp',
  html: 'html',
  sql: 'sql',
  bash: 'sh',
  json: 'json'
};

// Initialize Marked.js
if (window.marked) {
  marked.setOptions({
    highlight: function(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch (e) {}
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true
  });
}

// ================= Dark / Light Theme Toggle =================
function initTheme() {
  const saved = localStorage.getItem('courtesy-theme') || 'dark';
  applyTheme(saved);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark');
}

function applyTheme(theme) {
  const html = document.documentElement;
  const sunIcon = document.getElementById('theme-icon-sun');
  const moonIcon = document.getElementById('theme-icon-moon');
  const hljsTheme = document.getElementById('hljs-theme');

  if (theme === 'light') {
    html.classList.remove('dark');
    html.classList.add('light');
    if (sunIcon) sunIcon.classList.remove('hidden');
    if (moonIcon) moonIcon.classList.add('hidden');
    if (hljsTheme) hljsTheme.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css";
  } else {
    html.classList.remove('light');
    html.classList.add('dark');
    if (sunIcon) sunIcon.classList.add('hidden');
    if (moonIcon) moonIcon.classList.remove('hidden');
    if (hljsTheme) hljsTheme.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css";
  }
  localStorage.setItem('courtesy-theme', theme);
  if (window.lucide) lucide.createIcons();
}

// ================= Electron Window Controls =================
function windowMinimize() {
  if (window.electronAPI) window.electronAPI.minimizeWindow();
}
function windowMaximize() {
  if (window.electronAPI) window.electronAPI.maximizeWindow();
}
function windowClose() {
  if (window.electronAPI) window.electronAPI.closeWindow();
}

// ================= Endpoint Switcher =================
function toggleEndpointSelector() {
  const next = apiBaseUrl.includes('100.107.249.92') 
    ? 'http://localhost:8000' 
    : 'http://100.107.249.92:8000';
  setApiEndpoint(next);
}

function setApiEndpoint(url) {
  apiBaseUrl = url;
  const label = document.getElementById('current-endpoint-label');
  if (label) {
    label.innerText = url.includes('100.107.249.92') ? 'Pi: 100.107.249.92:8000' : 'Local: 8000';
  }
  if (ws) {
    try { ws.close(); } catch (e) {}
  }
  initWebSocket();
  fetchServersRest();
}

// ================= Tab Switching =================
function switchTab(tabId) {
  currentTab = tabId;
  const tabs = ['codex', 'fleet', 'ide'];
  tabs.forEach(t => {
    const sec = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    if (sec && btn) {
      if (t === tabId) {
        sec.classList.remove('hidden');
        btn.className = "tab-btn px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-2 transition-all bg-gold-gradient text-slate-950 shadow-sm";
      } else {
        sec.classList.add('hidden');
        btn.className = "tab-btn px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all text-[var(--text-muted)] hover:text-[var(--text-main)]";
      }
    }
  });

  if (window.lucide) lucide.createIcons();
}

// ================= WebSocket Telemetry =================
function initWebSocket() {
  let wsUrl;
  if (apiBaseUrl.startsWith('https://')) {
    wsUrl = apiBaseUrl.replace('https://', 'wss://') + '/ws/metrics';
  } else {
    wsUrl = apiBaseUrl.replace('http://', 'ws://') + '/ws/metrics';
  }

  try {
    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.metrics && data.summary) {
          renderClusterSummary(data.summary, data.metrics);
          renderServers(data.metrics);
          renderGpuActivityStrip(data.metrics);
        }
      } catch (e) {
        console.error("Error parsing telemetry message:", e);
      }
    };

    ws.onclose = () => {
      setTimeout(initWebSocket, 3000);
    };

    ws.onerror = () => {
      try { ws.close(); } catch (e) {}
    };
  } catch (e) {
    setInterval(fetchServersRest, 3500);
  }
}

async function fetchServersRest() {
  try {
    const res = await fetch(`${apiBaseUrl}/api/servers`);
    const servers = await res.json();
    const summaryRes = await fetch(`${apiBaseUrl}/api/cluster`);
    const summary = await summaryRes.json();
    currentServers = servers;

    renderClusterSummary(summary);
    renderServersFromRest(servers);

    const map = {};
    servers.forEach(s => {
      map[s.id] = { 
        id: s.id, 
        name: s.name,
        online: s.status?.online, 
        models: s.status?.models || [],
        gpus: s.status?.gpus || []
      };
    });
    updateModelDropdown(map);
    renderGpuActivityStrip(map);
  } catch (e) {
    console.debug("REST polling failed:", e);
  }
}

function triggerManualRefresh() {
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.classList.add('animate-spin');
  fetchServersRest().finally(() => {
    setTimeout(() => {
      if (icon) icon.classList.remove('animate-spin');
    }, 600);
  });
}

// ================= Cluster & Server Card Rendering =================
function renderClusterSummary(summary, metricsMap = null) {
  const titleNodesEl = document.getElementById('titlebar-nodes');
  const titleGpusEl = document.getElementById('titlebar-gpus');
  const fleetCountEl = document.getElementById('tab-fleet-count');

  if (titleNodesEl) {
    titleNodesEl.innerText = `${summary.online_nodes} / ${summary.total_nodes} Nodes Active`;
  }
  if (titleGpusEl) {
    titleGpusEl.innerText = `${summary.total_gpus}x Quadro P2000 (${summary.total_vram_gb}GB)`;
  }
  if (fleetCountEl) {
    fleetCountEl.innerText = summary.online_nodes;
  }

  if (metricsMap) {
    updateModelDropdown(metricsMap);
    renderGpuActivityStrip(metricsMap);
  }
}

function updateModelDropdown(metricsMap) {
  const select = document.getElementById('chat-model-select');
  if (!select) return;

  const currentVal = select.value;
  let optionsHtml = `
    <option value="auto">✨ Auto Load-Balance (Best Node)</option>
    <option value="qwen2.5-coder:7b">🚀 Cluster: Qwen 2.5 Coder 7B (Fastest)</option>
    <option value="qwen2.5-coder:14b">🧠 Cluster: Qwen 2.5 Coder 14B (Heavy Reasoning)</option>
  `;

  const nodeGroups = {};
  Object.values(metricsMap).forEach(s => {
    if (s.online && s.models && s.models.length > 0) {
      s.models.forEach(m => {
        const val = `${s.id}/${m.name}`;
        const is14b = m.name.includes('14b');
        const icon = is14b ? '🧠' : '⚡';
        const label = `${icon} [${s.id}] ${m.name} (${m.size_gb || '4.7'}GB)`;
        optionsHtml += `<option value="${val}">${label}</option>`;
      });
    }
  });

  select.innerHTML = optionsHtml;
  if (select.querySelector(`option[value="${currentVal}"]`)) {
    select.value = currentVal;
  }
}

function renderGpuActivityStrip(metricsMap) {
  const container = document.getElementById('gpu-activity-meters');
  if (!container) return;

  const items = [];
  Object.values(metricsMap).forEach(s => {
    if (s.online && s.gpus && s.gpus.length > 0) {
      s.gpus.forEach(g => {
        const pct = g.vram_percent || Math.round((g.vram_used_mb / (g.vram_total_mb || 5120)) * 100);
        items.push(`
          <div class="flex items-center gap-2 px-2 py-0.5 rounded-lg bg-[var(--bg-muted)] border border-[var(--border-app)]">
            <span class="text-[var(--text-secondary)] font-semibold">${s.id}/GPU${g.index}</span>
            <div class="w-12 bg-[var(--bg-input)] h-1.5 rounded-full overflow-hidden">
              <div class="gold-progress-bar h-full rounded-full" style="width: ${Math.max(4, pct)}%"></div>
            </div>
            <span class="text-[10px] text-gold-500 font-bold">${g.temp_c || 30}°C</span>
          </div>
        `);
      });
    }
  });

  if (items.length > 0) {
    container.innerHTML = items.join('');
  }
}

function renderServers(metricsMap) {
  const container = document.getElementById('servers-grid');
  if (!container) return;

  const serverIds = Object.keys(metricsMap);
  if (serverIds.length === 0) {
    container.innerHTML = `<div class="col-span-full py-8 text-center text-[var(--text-muted)]">No servers configured. Click "+ Add Server" to register a node.</div>`;
    return;
  }

  container.innerHTML = serverIds.map(sId => {
    const s = metricsMap[sId];
    return createServerCardHtml(s);
  }).join('');

  if (window.lucide) lucide.createIcons();
}

function renderServersFromRest(serversList) {
  const container = document.getElementById('servers-grid');
  if (!container) return;

  container.innerHTML = serversList.map(s => {
    const metrics = {
      id: s.id,
      name: s.name,
      role: s.role,
      type: s.type,
      host: s.host,
      port: s.port,
      enabled: s.enabled,
      online: s.status?.online || false,
      latency_ms: s.status?.latency_ms,
      ram_total_gb: s.status?.ram_total_gb || 0,
      ram_used_gb: s.status?.ram_used_gb || 0,
      ram_percent: s.status?.ram_percent || 0,
      gpus: s.status?.gpus || [],
      models: s.status?.models || [],
      tags: s.tags || []
    };
    return createServerCardHtml(metrics);
  }).join('');

  if (window.lucide) lucide.createIcons();
}

function createServerCardHtml(s) {
  const isOnline = s.online;
  const isGateway = s.role === 'gateway' || s.type === 'system_only';
  const gpus = s.gpus || [];

  return `
    <div class="luxury-card rounded-2xl p-5 flex flex-col justify-between gap-4 animate-fade-up">
      
      <!-- Card Header -->
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 rounded-full ${isOnline ? 'bg-emerald-400 pulse-gold' : 'bg-rose-500'}"></span>
            <h3 class="font-bold text-[var(--text-main)] text-sm tracking-tight">${s.name || s.id}</h3>
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="font-mono text-[11px] text-[var(--text-dim)]">${s.host}:${s.port}</span>
            ${s.latency_ms ? `<span class="text-[10px] px-1.5 py-0.5 rounded font-mono border border-gold text-gold-500 bg-[var(--gold-subtle)] font-bold">${s.latency_ms} ms</span>` : ''}
          </div>
        </div>

        <div class="flex items-center gap-1.5">
          <span class="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${isGateway ? 'bg-[var(--gold-subtle)] border border-gold text-gold-500' : 'bg-[var(--bg-muted)] border border-[var(--border-app)] text-[var(--text-muted)]'}">
            ${s.role || 'node'}
          </span>
          <button onclick="toggleServer('${s.id}')" title="Toggle Node Power" class="p-1 rounded-lg bg-[var(--bg-muted)] hover:border-gold border border-[var(--border-app)] text-[var(--text-muted)] hover:text-[var(--text-main)] transition">
            <i data-lucide="${s.enabled ? 'power' : 'power-off'}" class="w-3.5 h-3.5 ${s.enabled ? 'text-emerald-400' : 'text-slate-500'}"></i>
          </button>
        </div>
      </div>

      <!-- Specs & Telemetry -->
      <div class="space-y-3 py-1">
        
        <!-- System RAM -->
        <div>
          <div class="flex justify-between text-[11px] mb-1">
            <span class="text-[var(--text-muted)] flex items-center gap-1">
              <i data-lucide="layers" class="w-3 h-3 text-gold-500"></i> System RAM
            </span>
            <span class="font-mono text-[var(--text-main)] font-semibold">${s.ram_used_gb || 0} / ${s.ram_total_gb || 0} GB (${s.ram_percent || 0}%)</span>
          </div>
          <div class="w-full bg-[var(--bg-muted)] h-1.5 rounded-full overflow-hidden">
            <div class="gold-progress-bar h-full rounded-full" style="width: ${Math.min(100, s.ram_percent || 0)}%"></div>
          </div>
        </div>

        <!-- GPUs -->
        ${gpus.length > 0 ? `
          <div class="space-y-2 pt-1 border-t border-[var(--border-app)]">
            <div class="text-[11px] font-bold text-gold-500 flex items-center justify-between">
              <span class="flex items-center gap-1"><i data-lucide="cpu" class="w-3 h-3"></i> Dual Accelerators (${gpus.length}x)</span>
            </div>
            ${gpus.map(gpu => `
              <div class="bg-[var(--bg-surface)] p-2.5 rounded-xl border border-[var(--border-app)] space-y-1.5 shadow-sm">
                <div class="flex items-center justify-between text-[11px]">
                  <span class="font-bold text-[var(--text-main)]">GPU ${gpu.index}: ${gpu.name.replace('NVIDIA ', '')}</span>
                  <div class="flex items-center gap-2">
                    <span class="px-1.5 py-0.2 rounded text-[10px] font-mono ${gpu.temp_c > 65 ? 'bg-rose-950 text-rose-300' : 'bg-[var(--gold-subtle)] border border-gold text-gold-500 font-bold'}">${gpu.temp_c}°C</span>
                    <span class="text-[10px] text-[var(--text-muted)] font-mono">${gpu.util_percent || 0}% Compute</span>
                  </div>
                </div>
                <!-- VRAM Bar -->
                <div>
                  <div class="flex justify-between text-[10px] text-[var(--text-dim)] font-mono">
                    <span>VRAM Usage</span>
                    <span>${gpu.vram_used_mb || 0} / ${gpu.vram_total_mb || 5120} MB (${gpu.vram_percent || 0}%)</span>
                  </div>
                  <div class="w-full bg-[var(--bg-muted)] h-1 rounded-full overflow-hidden">
                    <div class="gold-progress-bar h-full rounded-full" style="width: ${Math.min(100, gpu.vram_percent || 0)}%"></div>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <!-- Active Models -->
        ${s.models && s.models.length > 0 ? `
          <div class="pt-2 border-t border-[var(--border-app)]">
            <span class="text-[10px] font-bold text-gold-500 uppercase tracking-wider block mb-1.5">Loaded Models (${s.models.length})</span>
            <div class="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto pr-1">
              ${s.models.map(m => `
                <span class="px-2 py-0.5 rounded-md bg-[var(--bg-surface)] text-gold-500 text-[10px] font-mono border border-gold flex items-center gap-1 shadow-sm font-medium">
                  <span>${m.name}</span>
                  <span class="text-[var(--text-dim)] text-[9px]">(${m.size_gb || '4.7'}GB)</span>
                </span>
              `).join('')}
            </div>
          </div>
        ` : (isGateway ? `
          <div class="text-[11px] text-[var(--text-muted)] bg-[var(--bg-surface)] p-2 rounded-xl border border-[var(--border-app)]">
            Role: Gateway & Tailscale Mesh Orchestrator.
          </div>
        ` : `
          <div class="text-[11px] text-[var(--text-dim)] italic">No models detected on node.</div>
        `)}

      </div>

      <!-- Footer Actions -->
      <div class="pt-3 border-t border-[var(--border-app)] flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span class="text-[10px] font-mono text-[var(--text-dim)]">${(s.tags || []).join(' • ')}</span>
        <button onclick="deleteServer('${s.id}')" class="text-[var(--text-dim)] hover:text-rose-500 p-1 rounded-lg transition" title="Remove Server">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>

    </div>
  `;
}

// ================= Server CRUD =================
function openAddServerModal() {
  document.getElementById('add-server-modal').classList.remove('hidden');
}

function closeAddServerModal() {
  document.getElementById('add-server-modal').classList.add('hidden');
}

async function handleAddServerSubmit(event) {
  event.preventDefault();
  const newServer = {
    id: document.getElementById('new-server-id').value.trim().toLowerCase(),
    name: document.getElementById('new-server-name').value.trim(),
    host: document.getElementById('new-server-host').value.trim(),
    port: parseInt(document.getElementById('new-server-port').value, 10) || 11434,
    role: document.getElementById('new-server-role').value,
    type: document.getElementById('new-server-type').value,
    enabled: true
  };

  try {
    const res = await fetch(`${apiBaseUrl}/api/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newServer)
    });
    if (res.ok) {
      closeAddServerModal();
      document.getElementById('add-server-form').reset();
      triggerManualRefresh();
    } else {
      const err = await res.json();
      alert(`Failed to add server: ${err.detail || 'Unknown error'}`);
    }
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

async function toggleServer(serverId) {
  try {
    await fetch(`${apiBaseUrl}/api/servers/${serverId}/toggle`, { method: 'POST' });
    triggerManualRefresh();
  } catch (e) {
    console.error("Toggle failed:", e);
  }
}

async function deleteServer(serverId) {
  if (!confirm(`Are you sure you want to remove '${serverId}' from the cluster registry?`)) return;
  try {
    await fetch(`${apiBaseUrl}/api/servers/${serverId}`, { method: 'DELETE' });
    triggerManualRefresh();
  } catch (e) {
    console.error("Delete failed:", e);
  }
}

// ================= Antigravity Code Workbench / Scratchpad =================
function handleLanguageChange() {
  const lang = document.getElementById('editor-language').value;
  const ext = EXT_MAP[lang] || 'txt';
  const nameInput = document.getElementById('editor-filename');
  const parts = nameInput.value.split('.');
  if (parts.length > 1) {
    parts.pop();
    nameInput.value = `${parts.join('.')}.${ext}`;
  } else {
    nameInput.value = `${nameInput.value}.${ext}`;
  }
}

function handleEditorTabKey(event) {
  if (event.key === 'Tab') {
    event.preventDefault();
    const textarea = event.target;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
  }
}

function copyEditorCode() {
  const code = document.getElementById('ide-code-area').value;
  navigator.clipboard.writeText(code);
  const status = document.getElementById('editor-line-col');
  const original = status.innerText;
  status.innerText = "✓ Copied to clipboard!";
  setTimeout(() => { status.innerText = original; }, 1500);
}

function clearEditor() {
  document.getElementById('ide-code-area').value = '';
}

function insertCodeIntoEditor(code, lang = 'python') {
  const editor = document.getElementById('ide-code-area');
  const langSelect = document.getElementById('editor-language');
  if (editor) {
    editor.value = code;
    if (lang && EXT_MAP[lang.toLowerCase()]) {
      langSelect.value = lang.toLowerCase();
      handleLanguageChange();
    }
    editor.focus();
    const status = document.getElementById('editor-line-col');
    status.innerText = "✓ Loaded from Codex!";
    setTimeout(() => { status.innerText = "UTF-8 • 2 Spaces"; }, 2000);
  }
}

function sendEditorCodeToCodex(action) {
  const code = document.getElementById('ide-code-area').value.trim();
  const lang = document.getElementById('editor-language').value;
  if (!code) {
    alert("The scratchpad editor is empty. Write or paste code first!");
    return;
  }

  let promptText = "";
  if (action === 'refactor') {
    promptText = `Please refactor the following ${lang} code for clean architecture, readability, performance, and best practices:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  } else if (action === 'bugs') {
    promptText = `Please perform a security and bug audit on this ${lang} code. Identify race conditions, edge cases, vulnerabilities, and provide corrected code:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  } else if (action === 'tests') {
    promptText = `Please generate comprehensive unit and integration tests with edge cases for this ${lang} code:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  }

  const input = document.getElementById('chat-input');
  input.value = promptText;
  handleChatSubmit(new Event('submit'));
}

// ================= Codex Chat Playground =================
function applyPromptPreset() {
  const presetKey = document.getElementById('prompt-preset-select').value;
  const sys = PROMPT_PRESETS[presetKey] || PROMPT_PRESETS.coder;
  const infoEl = document.getElementById('chat-route-detail');
  if (infoEl) {
    infoEl.innerText = `${presetKey.toUpperCase()} • Multi-GPU Cluster`;
  }
}

function handleTextareaKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleChatSubmit(event);
  }
}

function sendQuickPrompt(text) {
  const input = document.getElementById('chat-input');
  input.value = text;
  handleChatSubmit(new Event('submit'));
}

function clearChatHistory() {
  chatHistory = [];
  const container = document.getElementById('chat-messages');
  container.innerHTML = `
    <div class="flex items-start gap-3 max-w-2xl animate-fade-up">
      <div class="h-8 w-8 rounded-xl bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-sm shrink-0 shadow-sm shadow-gold-glow">⚡</div>
      <div class="bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-2xl rounded-tl-sm p-4 text-sm text-[var(--text-main)] shadow-sm">
        Conversation cleared. Ready for your next coding task.
      </div>
    </div>
  `;
}

async function handleChatSubmit(event) {
  event.preventDefault();
  if (isStreaming) return;

  const inputEl = document.getElementById('chat-input');
  const userText = inputEl.value.trim();
  if (!userText) return;

  inputEl.value = '';
  isStreaming = true;
  document.getElementById('chat-send-btn').disabled = true;
  document.getElementById('chat-status-msg').innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-gold-500 animate-ping"></span> Consulting GPU cluster...`;

  appendMessage('user', userText);
  chatHistory.push({ role: 'user', content: userText });

  const chosenModel = document.getElementById('chat-model-select').value;
  const presetKey = document.getElementById('prompt-preset-select').value;
  const systemPrompt = PROMPT_PRESETS[presetKey] || PROMPT_PRESETS.coder;
  const temp = parseFloat(document.getElementById('chat-temp').value) || 0.2;

  const messagesPayload = [
    { role: 'system', content: systemPrompt },
    ...chatHistory
  ];

  const assistantMsgId = `msg-${Date.now()}`;
  appendAssistantPlaceholder(assistantMsgId);
  const contentEl = document.getElementById(`${assistantMsgId}-content`);

  let fullResponseText = '';
  const startTime = Date.now();

  try {
    const response = await fetch(`${apiBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer courtesy-local'
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: messagesPayload,
        stream: true,
        temperature: temp,
        max_tokens: 4096
      })
    });

    const targetServerHeader = response.headers.get('X-Courtesy-Server') || 'auto';
    const targetModelHeader = response.headers.get('X-Courtesy-Model') || chosenModel;

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine || cleanLine.startsWith(':')) continue;
        if (cleanLine === 'data: [DONE]') break;

        if (cleanLine.startsWith('data: ')) {
          try {
            const data = JSON.parse(cleanLine.substring(6));
            const delta = data.choices?.[0]?.delta?.content || '';
            fullResponseText += delta;
            
            contentEl.innerHTML = marked.parse(fullResponseText);
            contentEl.classList.add('streaming-cursor');
            scrollToBottom();
          } catch (e) {}
        }
      }
    }

    contentEl.classList.remove('streaming-cursor');
    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    
    const metaEl = document.getElementById(`${assistantMsgId}-meta`);
    if (metaEl) {
      metaEl.innerHTML = `
        <span class="flex items-center gap-1.5 text-gold-500 font-bold">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span>Node: ${targetServerHeader}</span>
        </span>
        <span>•</span>
        <span>Model: <code class="text-[var(--text-main)] font-mono">${targetModelHeader}</code></span>
        <span>•</span>
        <span>Time: ${elapsedSeconds}s</span>
      `;
    }

    attachCodeBlockHeaders(contentEl);
    chatHistory.push({ role: 'assistant', content: fullResponseText });

  } catch (e) {
    contentEl.innerHTML = `<span class="text-rose-500 font-bold">Error communicating with cluster:</span> ${e.message}`;
  } finally {
    isStreaming = false;
    document.getElementById('chat-send-btn').disabled = false;
    document.getElementById('chat-status-msg').innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Ready for coding tasks.`;
    scrollToBottom();
  }
}

function appendMessage(role, text) {
  const container = document.getElementById('chat-messages');
  const isUser = role === 'user';
  
  const msgHtml = `
    <div class="flex items-start gap-3.5 ${isUser ? 'justify-end' : 'justify-start'} animate-fade-up">
      ${!isUser ? `<div class="h-8 w-8 rounded-xl bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-sm shrink-0 shadow-sm shadow-gold-glow">⚡</div>` : ''}
      <div class="${isUser ? 'bg-gold-gradient text-slate-950 font-medium rounded-2xl rounded-tr-sm max-w-xl p-3.5 text-sm shadow-md' : 'bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-2xl rounded-tl-sm p-4 text-sm text-[var(--text-main)] max-w-2xl leading-relaxed shadow-sm'}">
        ${isUser ? `<p class="whitespace-pre-wrap">${escapeHtml(text)}</p>` : marked.parse(text)}
      </div>
      ${isUser ? `<div class="h-8 w-8 rounded-xl bg-[var(--bg-muted)] border border-[var(--border-app)] flex items-center justify-center text-[var(--text-main)] font-bold text-xs shrink-0">YOU</div>` : ''}
    </div>
  `;
  container.insertAdjacentHTML('beforeend', msgHtml);
  scrollToBottom();
}

function appendAssistantPlaceholder(id) {
  const container = document.getElementById('chat-messages');
  const msgHtml = `
    <div class="flex items-start gap-3 justify-start animate-fade-up">
      <div class="h-8 w-8 rounded-xl bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-sm shrink-0 shadow-sm shadow-gold-glow">⚡</div>
      <div class="bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-2xl rounded-tl-sm p-4 text-sm text-[var(--text-main)] max-w-3xl w-full leading-relaxed shadow-md space-y-2">
        <div id="${id}-content" class="chat-markdown streaming-cursor">
          <span class="text-[var(--text-dim)] text-xs italic">Consulting GPU cluster...</span>
        </div>
        <div id="${id}-meta" class="pt-2 border-t border-[var(--border-app)] text-[10px] text-[var(--text-dim)] flex items-center gap-2"></div>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', msgHtml);
  scrollToBottom();
}

function attachCodeBlockHeaders(containerEl) {
  const codeBlocks = containerEl.querySelectorAll('pre');
  codeBlocks.forEach(pre => {
    if (pre.querySelector('.code-block-header')) return;

    const codeEl = pre.querySelector('code');
    const fullCode = codeEl ? codeEl.innerText : pre.innerText;
    
    // Detect language from class
    let lang = 'code';
    if (codeEl && codeEl.className) {
      const match = codeEl.className.match(/language-([a-zA-Z0-9_-]+)/);
      if (match) lang = match[1];
    }

    const header = document.createElement('div');
    header.className = 'code-block-header';

    // "Send to Scratchpad" button
    const scratchpadBtn = document.createElement('button');
    scratchpadBtn.className = 'code-header-btn';
    scratchpadBtn.innerHTML = `<span>⚡ Scratchpad</span>`;
    scratchpadBtn.title = "Open this code snippet in the Antigravity Scratchpad editor";
    scratchpadBtn.onclick = () => {
      insertCodeIntoEditor(fullCode, lang);
    };

    // "Copy" button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-header-btn';
    copyBtn.innerHTML = `<span>Copy</span>`;
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(fullCode);
      copyBtn.innerHTML = `<span>✓ Copied!</span>`;
      setTimeout(() => { copyBtn.innerHTML = `<span>Copy</span>`; }, 1500);
    };

    header.appendChild(scratchpadBtn);
    header.appendChild(copyBtn);
    pre.appendChild(header);
  });
}

function copyCode(elementId) {
  const el = document.getElementById(elementId);
  if (el) {
    navigator.clipboard.writeText(el.innerText);
    alert("Configuration copied to clipboard!");
  }
}

function scrollToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

function escapeHtml(string) {
  return String(string).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

// Start on page load
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  if (!window.electronAPI) {
    const winControls = document.getElementById('window-controls');
    if (winControls) winControls.classList.add('hidden');
  }
  initWebSocket();
  fetchServersRest();
  if (window.lucide) lucide.createIcons();
});
