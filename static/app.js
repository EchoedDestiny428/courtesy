// Courtesy Minimalist Codex & AI Cluster Fleet - Antigravity IDE Client

let currentTab = 'codex';
let selectedModelMode = '7b'; // '7b', '14b', 'auto'
let selectedNodeTarget = 'all'; // 'all', 'kraken', 'cst6', 'cst7'
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

// ================= Model Mode & Node Pinning =================
function selectModelMode(mode) {
  selectedModelMode = mode;
  ['7b', '14b', 'auto'].forEach(m => {
    const btn = document.getElementById(`mode-btn-${m}`);
    if (btn) {
      if (m === mode) {
        btn.className = "model-pill-btn active";
      } else {
        btn.className = "model-pill-btn";
      }
    }
  });

  const detailEl = document.getElementById('chat-route-detail');
  if (mode === '7b') {
    if (detailEl) detailEl.innerText = "⚡ qwen2.5-coder:7b (Fast)";
    showToast("Switched to 7B Fast Coder (Low Latency)");
  } else if (mode === '14b') {
    if (detailEl) detailEl.innerText = "🧠 qwen2.5-coder:14b (Heavy)";
    showToast("Switched to 14B Heavy Reasoning (Auto-Offload Active)");
  } else {
    if (detailEl) detailEl.innerText = "✨ Auto Cluster Routing";
    showToast("Switched to Auto Cluster Load-Balancing");
  }
}

function handleNodeTargetChange() {
  const sel = document.getElementById('node-target-select');
  selectedNodeTarget = sel ? sel.value : 'all';
  if (selectedNodeTarget !== 'all') {
    showToast(`Pinned to node: ${selectedNodeTarget}`);
  } else {
    showToast("Cluster load-balancing active");
  }
}

function getEffectiveModelTarget() {
  let baseModel = "auto";
  if (selectedModelMode === '7b') baseModel = "qwen2.5-coder:7b";
  else if (selectedModelMode === '14b') baseModel = "qwen2.5-coder:14b";

  if (selectedNodeTarget && selectedNodeTarget !== 'all') {
    return `${selectedNodeTarget}/${baseModel}`;
  }
  return baseModel;
}

// ================= Proactive VRAM Flush =================
async function triggerVramFlush() {
  showToast("Flushing cluster VRAM across dual GPUs...", "⏳");
  try {
    const res = await fetch(`${apiBaseUrl}/api/cluster/offload`, { method: 'POST' });
    if (res.ok) {
      showToast("Cluster VRAM cleared: 30GB Available", "✓");
      fetchServersRest();
    } else {
      showToast("Failed to offload VRAM", "⚠");
    }
  } catch (e) {
    showToast("Error connecting to cluster", "⚠");
  }
}

async function offloadSingleNode(nodeId) {
  try {
    const res = await fetch(`${apiBaseUrl}/api/servers/${nodeId}/offload`, { method: 'POST' });
    if (res.ok) {
      showToast(`Flushed VRAM on ${nodeId}`, "✓");
      fetchServersRest();
    }
  } catch (e) {}
}

// ================= Floating Toast Notification =================
function showToast(message, icon = "⚡") {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast-msg';
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px) scale(0.95)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => { toast.remove(); }, 250);
  }, 2400);
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
  if (ws) {
    try { ws.close(); } catch (e) {}
  }
  initWebSocket();
  fetchServersRest();
  showToast(`Connected to: ${url}`);
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
        btn.className = "px-3 py-1 rounded-lg font-bold flex items-center gap-1.5 transition bg-gold-gradient text-slate-950 shadow-sm";
      } else {
        sec.classList.add('hidden');
        btn.className = "px-3 py-1 rounded-lg font-medium flex items-center gap-1.5 transition text-[var(--text-muted)] hover:text-[var(--text-main)]";
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
      showToast("Cluster Telemetry Refreshed");
    }, 500);
  });
}

// ================= Cluster & Server Card Rendering =================
function renderClusterSummary(summary, metricsMap = null) {
  const titleGpusEl = document.getElementById('titlebar-gpus');
  const fleetCountEl = document.getElementById('tab-fleet-count');

  if (titleGpusEl) {
    titleGpusEl.innerText = `${summary.total_vram_gb || 30}GB`;
  }
  if (fleetCountEl) {
    fleetCountEl.innerText = summary.online_nodes || 3;
  }

  if (metricsMap) {
    renderGpuActivityStrip(metricsMap);
  }
}

function renderGpuActivityStrip(metricsMap) {
  const container = document.getElementById('gpu-activity-meters');
  if (!container) return;

  const items = [];
  Object.values(metricsMap).forEach(s => {
    if (s.online && s.gpus && s.gpus.length > 0) {
      const avgUtil = Math.round(s.gpus.reduce((acc, g) => acc + (g.util_percent || 0), 0) / s.gpus.length);
      const maxTemp = Math.max(...s.gpus.map(g => g.temp_c || 30));
      items.push(`
        <div class="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--bg-muted)] border border-[var(--border-app)]">
          <span class="text-[var(--text-secondary)] font-semibold">${s.id}</span>
          <span class="text-[var(--text-dim)]">${avgUtil}%</span>
          <span class="text-gold-500 font-bold">${maxTemp}°C</span>
        </div>
      `);
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
    container.innerHTML = `<div class="col-span-full py-8 text-center text-[var(--text-muted)] text-xs">No servers configured.</div>`;
    return;
  }

  container.innerHTML = serverIds.map(sId => {
    const s = metricsMap[sId];
    return createMinimalServerCardHtml(s);
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
    return createMinimalServerCardHtml(metrics);
  }).join('');

  if (window.lucide) lucide.createIcons();
}

function createMinimalServerCardHtml(s) {
  const isOnline = s.online;
  const isGateway = s.role === 'gateway' || s.type === 'system_only';
  const gpus = s.gpus || [];

  return `
    <div class="luxury-card rounded-xl p-3.5 flex flex-col justify-between gap-3 text-xs animate-fade-up">
      
      <!-- Card Header -->
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full ${isOnline ? 'bg-emerald-400 pulse-gold' : 'bg-rose-500'}"></span>
          <span class="font-bold text-[var(--text-main)]">${s.name || s.id}</span>
        </div>

        <div class="flex items-center gap-1">
          ${s.latency_ms ? `<span class="text-[10px] font-mono text-gold-500 px-1 py-0.5 rounded bg-[var(--gold-subtle)]">${s.latency_ms}ms</span>` : ''}
          <button onclick="toggleServer('${s.id}')" title="Toggle Node" class="p-1 rounded hover:bg-[var(--bg-muted)] text-[var(--text-dim)] hover:text-[var(--text-main)]">
            <i data-lucide="${s.enabled ? 'power' : 'power-off'}" class="w-3 h-3 ${s.enabled ? 'text-emerald-400' : 'text-slate-500'}"></i>
          </button>
        </div>
      </div>

      <!-- Specs & Minimal Gauges -->
      <div class="space-y-2 font-mono text-[11px]">
        
        <!-- RAM Bar -->
        <div>
          <div class="flex justify-between text-[10px] text-[var(--text-dim)] mb-0.5">
            <span>RAM</span>
            <span>${s.ram_used_gb || 0}/${s.ram_total_gb || 0}GB</span>
          </div>
          <div class="w-full bg-[var(--bg-input)] h-1 rounded-full overflow-hidden">
            <div class="gold-progress-bar h-full rounded-full" style="width: ${Math.min(100, s.ram_percent || 0)}%"></div>
          </div>
        </div>

        <!-- Dual GPUs -->
        ${gpus.length > 0 ? `
          <div class="space-y-1.5 pt-1.5 border-t border-[var(--border-app)]">
            ${gpus.map(gpu => `
              <div class="p-1.5 rounded-lg bg-[var(--bg-input)] space-y-1">
                <div class="flex items-center justify-between text-[10px]">
                  <span class="text-[var(--text-secondary)]">GPU ${gpu.index}</span>
                  <div class="flex items-center gap-1.5">
                    <span class="text-gold-500 font-bold">${gpu.temp_c}°C</span>
                    <span class="text-[var(--text-dim)]">${gpu.util_percent}%</span>
                  </div>
                </div>
                <div class="w-full bg-[var(--bg-muted)] h-1 rounded-full overflow-hidden">
                  <div class="gold-progress-bar h-full rounded-full" style="width: ${Math.min(100, gpu.vram_percent || 0)}%"></div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <!-- Models -->
        ${s.models && s.models.length > 0 ? `
          <div class="pt-1.5 border-t border-[var(--border-app)] flex flex-wrap gap-1">
            ${s.models.map(m => `
              <span class="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] text-gold-500 text-[9px] border border-gold font-medium">
                ${m.name.includes('14b') ? '🧠 14B' : '⚡ 7B'}
              </span>
            `).join('')}
          </div>
        ` : ''}

      </div>

      <!-- Action Footer -->
      <div class="pt-2 border-t border-[var(--border-app)] flex items-center justify-between text-[10px]">
        <span class="text-[var(--text-dim)] font-mono">${s.host}</span>
        ${!isGateway ? `
          <button onclick="offloadSingleNode('${s.id}')" class="text-[var(--text-dim)] hover:text-gold-500 flex items-center gap-1" title="Free VRAM on this node">
            <i data-lucide="sparkles" class="w-2.5 h-2.5"></i>
            <span>Flush</span>
          </button>
        ` : ''}
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
    role: "inference",
    type: "ollama",
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
      showToast("Node registered successfully");
    }
  } catch (e) {
    showToast("Failed to register node", "⚠");
  }
}

async function toggleServer(serverId) {
  try {
    await fetch(`${apiBaseUrl}/api/servers/${serverId}/toggle`, { method: 'POST' });
    triggerManualRefresh();
  } catch (e) {}
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
  showToast("Code copied to clipboard!", "📋");
}

function clearEditor() {
  document.getElementById('ide-code-area').value = '';
  showToast("Scratchpad cleared", "🗑️");
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
    showToast("Snippet sent to Scratchpad", "⚡");
  }
}

function sendEditorCodeToCodex(action) {
  const code = document.getElementById('ide-code-area').value.trim();
  const lang = document.getElementById('editor-language').value;
  if (!code) {
    showToast("Scratchpad is empty. Write or paste code first!", "⚠");
    return;
  }

  let promptText = "";
  if (action === 'refactor') {
    promptText = `Refactor the following ${lang} code for clean architecture, readability, and high performance:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  } else if (action === 'bugs') {
    promptText = `Audit this ${lang} code for bugs, race conditions, edge cases, and vulnerabilities. Provide corrected code:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  } else if (action === 'tests') {
    promptText = `Write comprehensive unit tests with edge cases and mocks for this ${lang} code:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  }

  const input = document.getElementById('chat-input');
  input.value = promptText;
  handleChatSubmit(new Event('submit'));
}

// ================= Codex Chat Playground =================
function applyPromptPreset() {
  const presetKey = document.getElementById('prompt-preset-select').value;
  showToast(`Persona: ${presetKey.toUpperCase()}`);
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
    <div class="flex items-start gap-3 max-w-xl animate-fade-up">
      <div class="h-7 w-7 rounded-lg bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-xs shrink-0 shadow-sm shadow-gold-glow">⚡</div>
      <div class="bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-2xl rounded-tl-sm p-3.5 text-xs text-[var(--text-main)] shadow-sm">
        Conversation cleared. Ready for your next coding task.
      </div>
    </div>
  `;
  showToast("Conversation cleared");
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
  document.getElementById('chat-status-msg').innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-gold-500 animate-ping"></span> Inferring...`;

  appendMessage('user', userText);
  chatHistory.push({ role: 'user', content: userText });

  const chosenModel = getEffectiveModelTarget();
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

    const targetServerHeader = response.headers.get('X-Courtesy-Server') || 'cluster';
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
        <span class="flex items-center gap-1 text-gold-500 font-bold">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span>${targetServerHeader}</span>
        </span>
        <span>•</span>
        <span><code class="text-[var(--text-main)] font-mono">${targetModelHeader}</code></span>
        <span>•</span>
        <span>${elapsedSeconds}s</span>
      `;
    }

    attachCodeBlockHeaders(contentEl);
    chatHistory.push({ role: 'assistant', content: fullResponseText });

  } catch (e) {
    contentEl.innerHTML = `<span class="text-rose-500 font-bold">Error communicating with cluster:</span> ${e.message}`;
  } finally {
    isStreaming = false;
    document.getElementById('chat-send-btn').disabled = false;
    document.getElementById('chat-status-msg').innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Ready`;
    scrollToBottom();
  }
}

function appendMessage(role, text) {
  const container = document.getElementById('chat-messages');
  const isUser = role === 'user';
  
  const msgHtml = `
    <div class="flex items-start gap-2.5 ${isUser ? 'justify-end' : 'justify-start'} animate-fade-up">
      ${!isUser ? `<div class="h-6 w-6 rounded-lg bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-xs shrink-0 shadow-sm shadow-gold-glow">⚡</div>` : ''}
      <div class="${isUser ? 'bg-gold-gradient text-slate-950 font-semibold rounded-2xl rounded-tr-sm max-w-lg p-2.5 text-xs shadow-sm' : 'bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-2xl rounded-tl-sm p-3.5 text-xs text-[var(--text-main)] max-w-2xl leading-relaxed shadow-sm'}">
        ${isUser ? `<p class="whitespace-pre-wrap">${escapeHtml(text)}</p>` : marked.parse(text)}
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', msgHtml);
  scrollToBottom();
}

function appendAssistantPlaceholder(id) {
  const container = document.getElementById('chat-messages');
  const msgHtml = `
    <div class="flex items-start gap-2.5 justify-start animate-fade-up">
      <div class="h-6 w-6 rounded-lg bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-xs shrink-0 shadow-sm shadow-gold-glow">⚡</div>
      <div class="bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-2xl rounded-tl-sm p-3 text-xs text-[var(--text-main)] max-w-2xl w-full leading-relaxed shadow-sm space-y-2">
        <div id="${id}-content" class="chat-markdown streaming-cursor">
          <span class="text-[var(--text-dim)] text-xs italic">Consulting GPU cluster...</span>
        </div>
        <div id="${id}-meta" class="pt-1.5 border-t border-[var(--border-app)] text-[10px] text-[var(--text-dim)] flex items-center gap-2"></div>
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
    scratchpadBtn.title = "Open snippet in Scratchpad editor";
    scratchpadBtn.onclick = () => {
      insertCodeIntoEditor(fullCode, lang);
    };

    // "Copy" button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-header-btn';
    copyBtn.innerHTML = `<span>Copy</span>`;
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(fullCode);
      copyBtn.innerHTML = `<span>✓</span>`;
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
    showToast("Configuration copied to clipboard!", "📋");
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
