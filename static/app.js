// Courtesy Luxury Codex & AI Cluster Fleet Desktop Client

let currentTab = 'fleet';
let chatHistory = [];
let ws = null;
let currentServers = [];
let isStreaming = false;

// API Base URL (defaults to current host in web browser, or 100.107.249.92:8000 in desktop Electron)
let apiBaseUrl = (window.location.protocol === 'file:' || !window.location.host) 
  ? 'http://100.107.249.92:8000' 
  : window.location.origin;

// Presets for the Codex Assistant
const PROMPT_PRESETS = {
  coder: "You are Courtesy Codex, a world-class autonomous AI coding assistant. You write production-ready, clean, well-tested, robust code. Follow modern best practices, handle edge cases, and provide concise, insightful explanations.",
  bughunter: "You are an elite software auditor and bug hunter. Analyze the code, identify edge cases, vulnerabilities, race conditions, and logic errors. Provide precise code fixes and explanations.",
  refactor: "You are an expert software architect. Refactor the given code for maximum readability, maintainability, modularity, and high performance while preserving exact functional correctness.",
  tests: "You are a senior test automation engineer. Write comprehensive unit and integration tests covering edge cases, happy paths, boundary conditions, and mocks where necessary."
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
    label.innerText = url.includes('100.107.249.92') ? 'Pi: 100.107.249.92' : 'Local: 8000';
  }
  if (ws) ws.close();
  initWebSocket();
  fetchServersRest();
}

// ================= Tab Switching =================
function switchTab(tabId) {
  currentTab = tabId;
  const tabs = ['fleet', 'codex', 'ide'];
  tabs.forEach(t => {
    const sec = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    if (t === tabId) {
      sec.classList.remove('hidden');
      btn.className = "tab-btn px-4 py-1.5 rounded-lg text-xs font-bold flex items-center gap-2 transition-all bg-gold-gradient text-slate-950 shadow-sm";
    } else {
      sec.classList.add('hidden');
      btn.className = "tab-btn px-4 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all text-[var(--text-muted)] hover:text-[var(--text-main)]";
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
        }
      } catch (e) {
        console.error("Error parsing telemetry message:", e);
      }
    };

    ws.onclose = () => {
      setTimeout(initWebSocket, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch (e) {
    setInterval(fetchServersRest, 4000);
  }
}

async function fetchServersRest() {
  try {
    const res = await fetch(`${apiBaseUrl}/api/servers`);
    const servers = await res.json();
    const summaryRes = await fetch(`${apiBaseUrl}/api/cluster`);
    const summary = await summaryRes.json();
    renderClusterSummary(summary);
    renderServersFromRest(servers);

    const map = {};
    servers.forEach(s => {
      map[s.id] = { id: s.id, online: s.status?.online, models: s.status?.models || [] };
    });
    updateModelDropdown(map);
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

  if (titleNodesEl) {
    titleNodesEl.innerText = `${summary.online_nodes} / ${summary.total_nodes} Nodes Active`;
  }
  if (titleGpusEl) {
    titleGpusEl.innerText = `${summary.total_gpus}x GPUs (${summary.total_vram_gb} GB VRAM)`;
  }

  if (metricsMap) {
    updateModelDropdown(metricsMap);
  }
}

function updateModelDropdown(metricsMap) {
  const select = document.getElementById('chat-model-select');
  if (!select) return;

  const currentVal = select.value;
  let optionsHtml = `<option value="auto">✨ Auto Load-Balance (Best Node)</option>`;

  Object.values(metricsMap).forEach(s => {
    if (s.online && s.models && s.models.length > 0) {
      s.models.forEach(m => {
        const val = `${s.id}/${m.name}`;
        const label = `[${s.id}] ${m.name} (${m.size_gb}GB)`;
        optionsHtml += `<option value="${val}">${label}</option>`;
      });
    }
  });

  select.innerHTML = optionsHtml;
  if (select.querySelector(`option[value="${currentVal}"]`)) {
    select.value = currentVal;
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
    <div class="luxury-card rounded-2xl p-5 flex flex-col justify-between gap-4">
      
      <!-- Card Header -->
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 rounded-full ${isOnline ? 'bg-emerald-400 pulse-gold' : 'bg-rose-500'}"></span>
            <h3 class="font-bold text-[var(--text-main)] text-sm tracking-tight">${s.name || s.id}</h3>
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="font-mono text-[11px] text-[var(--text-dim)]">${s.host}:${s.port}</span>
            ${s.latency_ms ? `<span class="text-[10px] px-1.5 py-0.5 rounded font-mono border border-gold text-gold-500 bg-[var(--gold-subtle)]">${s.latency_ms} ms</span>` : ''}
          </div>
        </div>

        <div class="flex items-center gap-1.5">
          <span class="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${isGateway ? 'bg-[var(--gold-subtle)] border border-gold text-gold-500' : 'bg-[var(--bg-muted)] border border-[var(--border-app)] text-[var(--text-muted)]'}">
            ${s.role || 'node'}
          </span>
          <button onclick="toggleServer('${s.id}')" title="Toggle Node" class="p-1 rounded-lg bg-[var(--bg-muted)] hover:border-gold border border-[var(--border-app)] text-[var(--text-muted)] hover:text-[var(--text-main)] transition">
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
                  <span class="text-[var(--text-dim)] text-[9px]">(${m.size_gb}GB)</span>
                </span>
              `).join('')}
            </div>
          </div>
        ` : (isGateway ? `
          <div class="text-[11px] text-[var(--text-muted)] bg-[var(--bg-surface)] p-2 rounded-xl border border-[var(--border-app)]">
            Role: Gateway & Tailscale Orchestrator.
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

// ================= Codex Chat Playground =================
function applyPromptPreset() {
  const presetKey = document.getElementById('prompt-preset-select').value;
  const sys = PROMPT_PRESETS[presetKey] || PROMPT_PRESETS.coder;
  const infoEl = document.getElementById('chat-route-detail');
  if (infoEl) {
    infoEl.innerText = `Mode: ${presetKey.toUpperCase()} • ${sys.substring(0, 70)}...`;
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
    <div class="flex items-start gap-3.5 max-w-2xl">
      <div class="h-8 w-8 rounded-xl bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-sm shrink-0 shadow-sm">⚡</div>
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
  document.getElementById('chat-status-msg').innerText = "Streaming response from cluster...";

  appendMessage('user', userText);
  chatHistory.push({ role: 'user', content: userText });

  const chosenModel = document.getElementById('chat-model-select').value;
  const presetKey = document.getElementById('prompt-preset-select').value;
  const systemPrompt = PROMPT_PRESETS[presetKey] || PROMPT_PRESETS.coder;
  const temp = parseFloat(document.getElementById('chat-temp').value) || 0.2;
  const maxTokens = parseInt(document.getElementById('chat-max-tokens').value, 10) || 4096;

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
        max_tokens: maxTokens
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

    attachCopyButtons(contentEl);
    chatHistory.push({ role: 'assistant', content: fullResponseText });

  } catch (e) {
    contentEl.innerHTML = `<span class="text-rose-500 font-bold">Error communicating with cluster:</span> ${e.message}`;
  } finally {
    isStreaming = false;
    document.getElementById('chat-send-btn').disabled = false;
    document.getElementById('chat-status-msg').innerText = "Ready for coding tasks.";
    scrollToBottom();
  }
}

function appendMessage(role, text) {
  const container = document.getElementById('chat-messages');
  const isUser = role === 'user';
  
  const msgHtml = `
    <div class="flex items-start gap-3.5 ${isUser ? 'justify-end' : 'justify-start'} animate-fade-up">
      ${!isUser ? `<div class="h-8 w-8 rounded-xl bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-sm shrink-0 shadow-sm">⚡</div>` : ''}
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
    <div class="flex items-start gap-3.5 justify-start animate-fade-up">
      <div class="h-8 w-8 rounded-xl bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-sm shrink-0 shadow-sm">⚡</div>
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

function attachCopyButtons(containerEl) {
  const codeBlocks = containerEl.querySelectorAll('pre');
  codeBlocks.forEach(pre => {
    if (pre.querySelector('.copy-code-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.innerText = 'Copy';
    btn.onclick = () => {
      const code = pre.querySelector('code')?.innerText || pre.innerText;
      navigator.clipboard.writeText(code);
      btn.innerText = 'Copied!';
      setTimeout(() => { btn.innerText = 'Copy'; }, 1500);
    };
    pre.appendChild(btn);
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
  initWebSocket();
  fetchServersRest();
  if (window.lucide) lucide.createIcons();
});
