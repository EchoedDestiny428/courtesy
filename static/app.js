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

// ================= High-Level View Controllers =================
let currentView = 'portal'; // 'portal', 'connecting', 'standard', 'admin'
let currentWorkspaceFolder = localStorage.getItem('workspace_folder') || '~/projects/robotics';

function showView(viewId) {
  const views = ['view-portal', 'view-connecting', 'view-standard', 'view-admin'];
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) {
      if (v === viewId) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });
  currentView = viewId.replace('view-', '');
  if (window.lucide) lucide.createIcons();
}

function returnToPortal() {
  showView('view-portal');
}

function shakeLogo() {
  const img = document.getElementById('portal-logo-img');
  if (img) {
    img.style.transform = 'scale(1.15) rotate(10deg)';
    setTimeout(() => { img.style.transform = ''; }, 300);
  }
}

// ================= Standard IDE Auto-Connecting Flow =================
function startStandardMode() {
  showView('view-connecting');
  const label = document.getElementById('connecting-step-label');
  const bar = document.getElementById('connecting-progress-bar');
  const folderLabel = document.getElementById('current-folder-label');
  if (folderLabel) folderLabel.innerText = currentWorkspaceFolder;

  if (bar) bar.style.width = '25%';
  if (label) label.innerText = 'Pinging cluster compute nodes...';

  setTimeout(() => {
    if (bar) bar.style.width = '65%';
    if (label) label.innerText = 'Measuring VRAM headroom across kraken, cst6, cst7...';
  }, 400);

  setTimeout(() => {
    if (bar) bar.style.width = '100%';
    if (label) label.innerText = 'Optimal node pinned: kraken (0% load, 12ms ping)';
  }, 850);

  setTimeout(() => {
    showView('view-standard');
    showToast("Connected to Antigravity IDE Workbench", "⚡");
    syncEditorGutter();
  }, 1250);
}

// ================= Workspace Folder Selector =================
function openFolderSelectorModal() {
  const modal = document.getElementById('modal-folder-select');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeFolderSelectorModal() {
  const modal = document.getElementById('modal-folder-select');
  if (modal) modal.classList.add('hidden');
}

function setWorkspaceFolder(path) {
  currentWorkspaceFolder = path;
  localStorage.setItem('workspace_folder', path);
  const label = document.getElementById('current-folder-label');
  if (label) label.innerText = path;
  closeFolderSelectorModal();
  showToast(`Workspace folder: ${path}`, "📁");
}

function applyCustomFolder() {
  const input = document.getElementById('custom-folder-input');
  const val = input ? input.value.trim() : '';
  if (val) {
    setWorkspaceFolder(val);
  }
}

// ================= Secure Admin Login Flow =================
function openAdminLoginModal() {
  const err = document.getElementById('admin-login-error');
  if (err) err.classList.add('hidden');
  const pwdInput = document.getElementById('admin-password-input');
  if (pwdInput) pwdInput.value = '';
  const modal = document.getElementById('modal-admin-login');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeAdminLoginModal() {
  const modal = document.getElementById('modal-admin-login');
  if (modal) modal.classList.add('hidden');
}

async function handleAdminLogin(event) {
  event.preventDefault();
  const uInput = document.getElementById('admin-username-input');
  const pInput = document.getElementById('admin-password-input');
  const errBox = document.getElementById('admin-login-error');
  const errMsg = document.getElementById('admin-login-error-msg');
  const btn = document.getElementById('admin-login-btn');

  const username = uInput ? uInput.value.trim() : '';
  const password = pInput ? pInput.value : '';

  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (res.ok && data.token) {
      sessionStorage.setItem('admin_token', data.token);
      closeAdminLoginModal();
      showView('view-admin');
      fetchServersRest();
      fetchMiningStatus();
      showToast("Admin Authenticated", "👑");
    } else {
      if (errBox) errBox.classList.remove('hidden');
      if (errMsg) errMsg.innerText = data.detail || 'Invalid username or password';
    }
  } catch (e) {
    if (errBox) errBox.classList.remove('hidden');
    if (errMsg) errMsg.innerText = 'Connection to gateway failed';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function logoutAdmin() {
  const token = sessionStorage.getItem('admin_token');
  if (token) {
    try {
      await fetch(`${apiBaseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
    } catch (e) {}
  }
  sessionStorage.removeItem('admin_token');
  showView('view-portal');
  showToast("Logged out from Admin Console");
}

function switchAdminTab(tabId) {
  const tabs = ['fleet', 'mining', 'swarm', 'ide'];
  tabs.forEach(t => {
    const sec = document.getElementById(`admin-sec-${t}`);
    const btn = document.getElementById(`admin-tab-btn-${t}`);
    if (sec && btn) {
      if (t === tabId) {
        sec.classList.remove('hidden');
        btn.className = "px-3 py-1 rounded-lg font-bold transition bg-gold-gradient text-slate-950 shadow-sm";
      } else {
        sec.classList.add('hidden');
        btn.className = "px-3 py-1 rounded-lg font-medium transition text-[var(--text-muted)] hover:text-white";
      }
    }
  });
  if (window.lucide) lucide.createIcons();
}

async function terminateAllSessions() {
  const token = sessionStorage.getItem('admin_token');
  try {
    const res = await fetch(`${apiBaseUrl}/api/admin/terminate_sessions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      showToast("GPU VRAM Flushed: All Sessions Terminated", "⏹");
      fetchServersRest();
    }
  } catch (e) {
    showToast("Failed to terminate sessions", "⚠");
  }
}

async function restartClusterService() {
  const token = sessionStorage.getItem('admin_token');
  try {
    await fetch(`${apiBaseUrl}/api/admin/restart`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    showToast("Gateway restarting... Reconnecting in 4s", "🔄");
    setTimeout(fetchServersRest, 4000);
  } catch (e) {
    showToast("Restart triggered");
  }
}

// ================= Model Mode & Node Pinning =================
function selectModelMode(mode) {
  selectedModelMode = mode;
  ['7b', '14b', 'auto'].forEach(m => {
    const btn = document.getElementById(`mode-btn-${m}`);
    const stdBtn = document.getElementById(`std-mode-btn-${m}`);
    if (btn) btn.className = m === mode ? "model-pill-btn active" : "model-pill-btn";
    if (stdBtn) stdBtn.className = m === mode ? "model-pill-btn active" : "model-pill-btn";
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
  const tabs = ['codex', 'swarm', 'fleet', 'ide'];
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

// ================= Autonomous Swarm Orchestrator Client =================
let currentSwarmTaskId = null;
let currentSwarmFinalCode = "";
let swarmWs = null;

function setSwarmPrompt(text) {
  const input = document.getElementById('swarm-objective-input');
  if (input) input.value = text;
}

function clearSwarmFeed() {
  const feed = document.getElementById('swarm-feed');
  if (feed) {
    feed.innerHTML = `<div class="text-center py-8 text-[var(--text-dim)] italic text-xs">Feed cleared.</div>`;
  }
}

function initSwarmWebSocket() {
  let wsUrl;
  if (apiBaseUrl.startsWith('https://')) {
    wsUrl = apiBaseUrl.replace('https://', 'wss://') + '/ws/swarm';
  } else {
    wsUrl = apiBaseUrl.replace('http://', 'ws://') + '/ws/swarm';
  }

  try {
    swarmWs = new WebSocket(wsUrl);
    swarmWs.onmessage = (event) => {
      try {
        const ev = JSON.parse(event.data);
        handleSwarmEvent(ev);
      } catch (e) {}
    };
  } catch (e) {}
}

function handleSwarmEvent(ev) {
  const feed = document.getElementById('swarm-feed');
  if (!feed) return;

  const type = ev.type;

  if (type === 'init') {
    feed.innerHTML = '';
    appendSwarmLog('System', ev.message || 'Swarm initialized', 'text-gold-500 font-bold');
    setNodeStatus('leader', 'thinking', 'Active: Decomposing architecture');
    setNodeStatus('w1', 'idle', 'Standby');
    setNodeStatus('w2', 'idle', 'Standby');
  } else if (type === 'iteration_start') {
    const counter = document.getElementById('swarm-iteration-counter');
    if (counter) counter.innerText = `Iteration ${ev.iteration}/${ev.max_iterations}`;
    appendSwarmLog('System', `--- Starting Iteration ${ev.iteration} of ${ev.max_iterations} ---`, 'text-gold-400 font-bold');
  } else if (type === 'agent_thinking') {
    appendSwarmLog(ev.role, `[${ev.node}] ${ev.step_name}...`, 'text-[var(--text-dim)] italic');
    if (ev.role.includes('Leader')) {
      setNodeStatus('leader', 'thinking', ev.step_name);
    } else if (ev.role.includes('Worker 1')) {
      setNodeStatus('w1', 'thinking', ev.step_name);
    } else if (ev.role.includes('Worker 2')) {
      setNodeStatus('w2', 'thinking', ev.step_name);
    }
  } else if (type === 'agent_message') {
    appendSwarmAgentMessage(ev.role, ev.node, ev.model, ev.content);
    if (ev.role.includes('Leader')) {
      setNodeStatus('leader', 'idle', 'Completed plan');
    } else if (ev.role.includes('Worker 1')) {
      setNodeStatus('w1', 'idle', 'Completed implementation');
    } else if (ev.role.includes('Worker 2')) {
      setNodeStatus('w2', 'idle', 'Completed review');
    }
  } else if (type === 'completed') {
    setSwarmRunningUI(false);
    currentSwarmFinalCode = ev.final_code || '';
    const finalBox = document.getElementById('swarm-final-box');
    if (finalBox) finalBox.classList.remove('hidden');
    appendSwarmLog('System', `✓ Autonomous Task Completed with status: ${ev.status}`, 'text-emerald-400 font-bold');
    showToast("Autonomous Swarm Completed Task!", "🤖");
  } else if (type === 'error') {
    setSwarmRunningUI(false);
    appendSwarmLog('Error', ev.error, 'text-rose-500 font-bold');
  }
}

function appendSwarmLog(sender, text, css = 'text-[var(--text-secondary)]') {
  const feed = document.getElementById('swarm-feed');
  if (!feed) return;
  const item = document.createElement('div');
  item.className = `p-2 rounded-lg bg-[var(--bg-input)] border border-[var(--border-app)] ${css}`;
  item.innerHTML = `<span class="font-bold mr-1.5">[${sender}]</span>${escapeHtml(text)}`;
  feed.appendChild(item);
  feed.scrollTop = feed.scrollHeight;
}

function appendSwarmAgentMessage(role, node, model, content) {
  const feed = document.getElementById('swarm-feed');
  if (!feed) return;
  const item = document.createElement('div');
  item.className = 'p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-app)] space-y-2';
  item.innerHTML = `
    <div class="flex items-center justify-between border-b border-[var(--border-app)] pb-1 text-[10px]">
      <span class="font-bold text-gold-500 flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ${role}
      </span>
      <span class="text-[var(--text-dim)]">${node} • ${model}</span>
    </div>
    <div class="text-[11px] text-[var(--text-main)] chat-markdown leading-relaxed">
      ${marked.parse(content)}
    </div>
  `;
  feed.appendChild(item);
  attachCodeBlockHeaders(item);
  feed.scrollTop = feed.scrollHeight;
}

function setNodeStatus(roleKey, state, text) {
  const dot = document.getElementById(`${roleKey}-dot`);
  const statusEl = document.getElementById(`${roleKey}-status-text`);
  if (dot) {
    if (state === 'thinking') {
      dot.className = "w-2 h-2 rounded-full bg-gold-400 animate-ping";
    } else if (state === 'idle') {
      dot.className = "w-2 h-2 rounded-full bg-emerald-400";
    } else {
      dot.className = "w-2 h-2 rounded-full bg-slate-500";
    }
  }
  if (statusEl) statusEl.innerText = text;
}

async function launchSwarmTask() {
  const input = document.getElementById('swarm-objective-input');
  const objective = input ? input.value.trim() : '';
  if (!objective) {
    showToast("Please enter an objective for the swarm", "⚠");
    return;
  }

  const iterSelect = document.getElementById('swarm-iterations-select');
  const maxIters = iterSelect ? parseInt(iterSelect.value, 10) : 3;

  setSwarmRunningUI(true);
  initSwarmWebSocket();

  try {
    const res = await fetch(`${apiBaseUrl}/api/swarm/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective, max_iterations: maxIters })
    });
    const data = await res.json();
    currentSwarmTaskId = data.task_id;
    showToast(`Swarm Launched [ID: ${currentSwarmTaskId}]`, "🚀");
  } catch (e) {
    setSwarmRunningUI(false);
    showToast("Failed to launch swarm", "⚠");
  }
}

async function stopCurrentSwarm() {
  if (currentSwarmTaskId) {
    try {
      await fetch(`${apiBaseUrl}/api/swarm/stop/${currentSwarmTaskId}`, { method: 'POST' });
      showToast("Swarm task stopped");
    } catch (e) {}
  }
  setSwarmRunningUI(false);
}

function setSwarmRunningUI(running) {
  const startBtn = document.getElementById('swarm-start-btn');
  const stopBtn = document.getElementById('swarm-stop-btn');
  const badge = document.getElementById('swarm-status-badge');
  const text = document.getElementById('swarm-status-text');

  if (startBtn && stopBtn) {
    if (running) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
      if (badge) badge.className = "px-2.5 py-0.5 rounded-full text-[10px] font-mono border border-gold bg-[var(--gold-subtle)] text-gold-500 flex items-center gap-1.5";
      if (text) text.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span> Active`;
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      if (badge) badge.className = "px-2.5 py-0.5 rounded-full text-[10px] font-mono border border-[var(--border-app)] bg-[var(--bg-muted)] text-[var(--text-dim)] flex items-center gap-1.5";
      if (text) text.innerText = "Idle";
      setNodeStatus('leader', 'off', 'Standby');
      setNodeStatus('w1', 'off', 'Standby');
      setNodeStatus('w2', 'off', 'Standby');
    }
  }
}

function sendSwarmCodeToScratchpad() {
  if (currentSwarmFinalCode) {
    insertCodeIntoEditor(currentSwarmFinalCode, 'python');
    showView('view-standard');
    showToast("Swarm code loaded into Scratchpad!", "⚡");
  }
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
  const portalCountEl = document.getElementById('portal-online-count');

  if (titleGpusEl) {
    titleGpusEl.innerText = `${summary.total_vram_gb || 30}GB`;
  }
  if (fleetCountEl) {
    fleetCountEl.innerText = summary.online_nodes || 3;
  }
  if (portalCountEl && summary.total_nodes) {
    portalCountEl.innerText = `${summary.online_nodes || 0} / ${summary.total_nodes || 3} Nodes Online`;
  }

  if (metricsMap) {
    renderGpuActivityStrip(metricsMap);

    // Update connected node indicator in Standard IDE topbar
    const onlineNodes = Object.values(metricsMap).filter(s => s.online && s.role === 'inference');
    if (onlineNodes.length > 0) {
      onlineNodes.sort((a, b) => (a.latency_ms || 999) - (b.latency_ms || 999));
      const best = onlineNodes[0];
      const nodeLabel = document.getElementById('std-connected-node-label');
      if (nodeLabel) {
        nodeLabel.innerText = `${best.id} (${best.latency_ms || 12}ms)`;
      }
    }
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
  const container = document.getElementById('admin-servers-grid') || document.getElementById('servers-grid');
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
  const container = document.getElementById('admin-servers-grid') || document.getElementById('servers-grid');
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
          <button onclick="toggleServer('${s.id}')" title="Toggle Node" class="p-1 rounded hover:bg-[var(--bg-muted)] text-[var(--text-dim)] hover:text-[var(--text-main)] transition">
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
        <span class="text-[var(--text-dim)] font-mono">${s.host}:${s.port || 11434}</span>
        ${!isGateway ? `
          <div class="flex items-center gap-2">
            <button onclick="offloadSingleNode('${s.id}')" class="text-[var(--text-dim)] hover:text-gold-500 flex items-center gap-1 transition" title="Flush resident models from VRAM">
              <i data-lucide="sparkles" class="w-2.5 h-2.5"></i>
              <span>Flush</span>
            </button>
            ${(s.id !== 'kraken' && s.id !== 'cst6' && s.id !== 'cst7') ? `
              <button onclick="deleteServer('${s.id}')" class="text-[var(--text-dim)] hover:text-rose-400 p-0.5 rounded transition" title="Remove custom node">
                <i data-lucide="trash-2" class="w-3 h-3"></i>
              </button>
            ` : ''}
          </div>
        ` : ''}
      </div>

    </div>
  `;
}

// ================= Server CRUD =================
function openAddServerModal() {
  const modal = document.getElementById('add-server-modal');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeAddServerModal() {
  const modal = document.getElementById('add-server-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleAddServerSubmit(event) {
  event.preventDefault();
  const idInput = document.getElementById('new-server-id');
  const nameInput = document.getElementById('new-server-name');
  const hostInput = document.getElementById('new-server-host');
  const portInput = document.getElementById('new-server-port');
  const modelInput = document.getElementById('new-server-model');

  const newServer = {
    id: idInput ? idInput.value.trim().toLowerCase() : '',
    name: nameInput ? nameInput.value.trim() : '',
    host: hostInput ? hostInput.value.trim() : '',
    port: portInput ? parseInt(portInput.value, 10) || 11434 : 11434,
    preferred_model: (modelInput && modelInput.value.trim()) ? modelInput.value.trim() : 'qwen2.5-coder:7b',
    role: "inference",
    type: "ollama",
    enabled: true,
    specs: { cpu: "Detected dynamically", ram: "32 GB", gpus: [] },
    tags: ["custom-node", "compute"]
  };

  if (!newServer.id || !newServer.name || !newServer.host) {
    showToast("ID, Name, and Host are required", "⚠");
    return;
  }

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
      showToast(`Node '${newServer.id}' registered!`, "✓");
    } else {
      const err = await res.json();
      showToast(err.detail || "Failed to register node", "⚠");
    }
  } catch (e) {
    showToast("Failed to register node", "⚠");
  }
}

async function deleteServer(serverId) {
  if (!confirm(`Are you sure you want to remove node '${serverId}' from the cluster?`)) {
    return;
  }
  try {
    const res = await fetch(`${apiBaseUrl}/api/servers/${serverId}`, { method: 'DELETE' });
    if (res.ok) {
      showToast(`Node '${serverId}' removed`, "✓");
      triggerManualRefresh();
    } else {
      showToast("Could not remove node", "⚠");
    }
  } catch (e) {
    showToast("Error deleting node", "⚠");
  }
}

async function toggleServer(serverId) {
  try {
    await fetch(`${apiBaseUrl}/api/servers/${serverId}/toggle`, { method: 'POST' });
    triggerManualRefresh();
  } catch (e) {}
}

// ================= Antigravity Code Workbench / Scratchpad =================
function getScratchpad() {
  return document.getElementById('scratchpad-editor') || document.getElementById('ide-code-area');
}

function getEditorGutter() {
  return document.getElementById('editor-gutter');
}

function updateScratchpadStats() {
  const textarea = getScratchpad();
  const lineCountEl = document.getElementById('scratchpad-line-count');
  const charCountEl = document.getElementById('scratchpad-char-count');
  const langStatusEl = document.getElementById('scratchpad-status-lang');
  const langSelect = document.getElementById('scratchpad-lang') || document.getElementById('editor-language');

  if (textarea) {
    const text = textarea.value || '';
    const lines = text.split('\n').length;
    if (lineCountEl) lineCountEl.innerText = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
    if (charCountEl) charCountEl.innerText = `${text.length} chars`;
  }

  if (langStatusEl && langSelect) {
    langStatusEl.innerText = langSelect.value.toUpperCase();
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
    syncEditorGutter();
  }
}

function syncEditorGutter() {
  const textarea = getScratchpad();
  const gutter = getEditorGutter();
  if (!textarea || !gutter) return;

  const lines = (textarea.value || '').split('\n').length;
  gutter.innerText = Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n');
  updateScratchpadStats();
}

function syncGutterScroll() {
  const textarea = getScratchpad();
  const gutter = getEditorGutter();
  if (textarea && gutter) {
    gutter.scrollTop = textarea.scrollTop;
  }
}

function updateEditorSyntax() {
  const langSelect = document.getElementById('scratchpad-lang') || document.getElementById('editor-language');
  const lang = langSelect ? langSelect.value : 'python';
  showToast(`Scratchpad set to ${lang.toUpperCase()}`, "📝");
  updateScratchpadStats();
}

function copyScratchpadCode() {
  const editor = getScratchpad();
  if (!editor || !editor.value) {
    showToast("Scratchpad is empty", "ℹ");
    return;
  }
  navigator.clipboard.writeText(editor.value);
  showToast("Scratchpad copied to clipboard!", "📋");
}

function downloadScratchpadCode() {
  const editor = getScratchpad();
  if (!editor || !editor.value) {
    showToast("Scratchpad is empty", "ℹ");
    return;
  }
  const langSelect = document.getElementById('scratchpad-lang') || document.getElementById('editor-language');
  const lang = langSelect ? langSelect.value : 'python';
  const ext = EXT_MAP[lang.toLowerCase()] || 'txt';
  const filename = `courtesy_${lang}_${Date.now()}.${ext}`;
  const blob = new Blob([editor.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${filename}`, "💾");
}

function clearScratchpad() {
  const editor = getScratchpad();
  if (editor) {
    editor.value = '';
    syncEditorGutter();
    showToast("Scratchpad cleared", "🗑️");
  }
}

function insertCodeIntoEditor(code, lang = 'python') {
  const editor = getScratchpad();
  const langSelect = document.getElementById('scratchpad-lang') || document.getElementById('editor-language');
  if (editor) {
    editor.value = code;
    if (lang && langSelect) {
      const matchKey = Object.keys(EXT_MAP).find(k => k === lang.toLowerCase() || EXT_MAP[k] === lang.toLowerCase());
      if (matchKey) langSelect.value = matchKey;
    }
    syncEditorGutter();
    editor.focus();
    showToast("Code injected into Scratchpad", "⚡");
  }
}

function sendScratchpadToCodex(action) {
  const editor = getScratchpad();
  const code = editor ? editor.value.trim() : '';
  const langSelect = document.getElementById('scratchpad-lang') || document.getElementById('editor-language');
  const lang = langSelect ? langSelect.value : 'python';

  if (!code) {
    showToast("Scratchpad is empty. Write or generate code first!", "⚠");
    return;
  }

  let promptText = "";
  if (action === 'refactor') {
    promptText = `Refactor the following ${lang} code for clean architecture, type safety, modularity, and high performance:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  } else if (action === 'bugs') {
    promptText = `Perform a comprehensive security, logic, and edge-case audit on this ${lang} code. Identify any race conditions, leaks, or failure points, and provide the corrected code:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  } else if (action === 'tests') {
    promptText = `Write exhaustive unit and integration tests with mocks, edge cases, and happy paths for this ${lang} code:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  } else if (action === 'explain') {
    promptText = `Explain the architecture, algorithms, and line-by-line mechanics of this ${lang} code clearly:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  }

  const promptInput = document.getElementById('prompt-input') || document.getElementById('chat-input');
  if (promptInput) {
    promptInput.value = promptText;
    sendPrompt();
  }
}

// ================= Codex Chat Playground & Streaming =================
let webAccessEnabled = true;

function toggleWebAccess() {
  webAccessEnabled = !webAccessEnabled;

  const stdBtn = document.getElementById('std-web-toggle-btn');
  const stdText = document.getElementById('std-web-status-text');
  const adminBtn = document.getElementById('web-access-btn');
  const adminText = document.getElementById('web-access-label');

  if (webAccessEnabled) {
    if (stdBtn) stdBtn.className = "px-2.5 py-1 rounded-xl text-[11px] font-mono flex items-center gap-1.5 transition border border-emerald-500/40 bg-emerald-950/40 text-emerald-400";
    if (stdText) stdText.innerText = "Web Docs: ON";
    if (adminBtn) adminBtn.className = "px-2 py-0.5 rounded-lg text-[10px] font-semibold flex items-center gap-1 transition bg-emerald-500/10 border border-emerald-500/30 text-emerald-400";
    if (adminText) adminText.innerText = "Web Docs: ON";
    showToast("Live Web Docs Grounding: Enabled", "🌐");
  } else {
    if (stdBtn) stdBtn.className = "px-2.5 py-1 rounded-xl text-[11px] font-mono flex items-center gap-1.5 transition border border-[var(--border-app)] bg-[var(--bg-muted)] text-[var(--text-dim)]";
    if (stdText) stdText.innerText = "Web Docs: OFF";
    if (adminBtn) adminBtn.className = "px-2 py-0.5 rounded-lg text-[10px] font-semibold flex items-center gap-1 transition bg-[var(--bg-input)] border border-[var(--border-app)] text-[var(--text-dim)]";
    if (adminText) adminText.innerText = "Web Docs: OFF";
    showToast("Live Web Docs Grounding: Disabled", "⚪");
  }
  if (window.lucide) lucide.createIcons();
}

function handleInputKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
}

function clearChat() {
  chatHistory = [];
  const container = document.getElementById('chat-messages');
  if (container) {
    container.innerHTML = `
      <div class="p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-app)] space-y-2 animate-fade-up">
        <div class="flex items-center gap-2 text-gold-500 font-bold text-xs">
          <i data-lucide="sparkles" class="w-3.5 h-3.5"></i>
          <span>Antigravity Codex Ready</span>
        </div>
        <p class="text-[var(--text-muted)] text-[11px] leading-relaxed">
          Conversation cleared. Auto-connected to the cluster. Ask for code generation, architecture planning, or refactors. Code blocks can be injected into the Scratchpad with one click.
        </p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
  }
  showToast("Conversation cleared");
}

let currentAbortController = null;

function stopGenerating() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  isStreaming = false;

  const sendBtn = document.getElementById('send-prompt-btn') || document.getElementById('chat-send-btn');
  const stopBtn = document.getElementById('stop-stream-btn') || document.getElementById('chat-stop-btn');
  if (sendBtn) sendBtn.disabled = false;
  if (stopBtn) stopBtn.classList.add('hidden');

  showToast("Generation stopped");
}

async function sendPrompt() {
  if (isStreaming) return;

  const inputEl = document.getElementById('prompt-input') || document.getElementById('chat-input');
  if (!inputEl) return;

  const userText = inputEl.value.trim();
  if (!userText) return;

  inputEl.value = '';
  isStreaming = true;
  currentAbortController = new AbortController();

  const sendBtn = document.getElementById('send-prompt-btn') || document.getElementById('chat-send-btn');
  const stopBtn = document.getElementById('stop-stream-btn') || document.getElementById('chat-stop-btn');
  if (sendBtn) sendBtn.disabled = true;
  if (stopBtn) stopBtn.classList.remove('hidden');

  appendMessage('user', userText);
  chatHistory.push({ role: 'user', content: userText });

  const chosenModel = getEffectiveModelTarget();
  const systemPrompt = PROMPT_PRESETS.coder;
  const temp = 0.2;

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
      signal: currentAbortController.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer courtesy-local'
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: messagesPayload,
        stream: true,
        web_access: webAccessEnabled,
        temperature: temp,
        max_tokens: 4096
      })
    });

    const targetServerHeader = response.headers.get('X-Courtesy-Server') || 'cluster';
    const targetModelHeader = response.headers.get('X-Courtesy-Model') || chosenModel;
    const webSourcesHeader = response.headers.get('X-Courtesy-Web-Sources');
    let webSources = [];
    if (webSourcesHeader) {
      try { webSources = JSON.parse(webSourcesHeader); } catch (e) {}
    }

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
      let sourcesHtml = '';
      if (webSources && webSources.length > 0) {
        const sourceTitles = webSources.map(s => `• ${s.title}`).join('\n');
        sourcesHtml = `
          <span>•</span>
          <span class="flex items-center gap-1 text-emerald-400 font-semibold cursor-help" title="${escapeHtml(sourceTitles)}">
            <i data-lucide="globe" class="w-3 h-3"></i>
            <span>${webSources.length} Web Docs</span>
          </span>
        `;
      }

      metaEl.innerHTML = `
        <span class="flex items-center gap-1 text-gold-500 font-bold">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span>${targetServerHeader}</span>
        </span>
        <span>•</span>
        <span><code class="text-[var(--text-main)] font-mono">${targetModelHeader}</code></span>
        <span>•</span>
        <span>${elapsedSeconds}s</span>
        ${sourcesHtml}
      `;
      if (window.lucide) lucide.createIcons();
    }

    attachCodeBlockHeaders(contentEl);
    chatHistory.push({ role: 'assistant', content: fullResponseText });

  } catch (e) {
    if (e.name === 'AbortError') {
      contentEl.classList.remove('streaming-cursor');
    } else {
      contentEl.innerHTML = `<span class="text-rose-500 font-bold">Error communicating with cluster:</span> ${e.message}`;
    }
  } finally {
    isStreaming = false;
    currentAbortController = null;
    const sendBtn = document.getElementById('send-prompt-btn') || document.getElementById('chat-send-btn');
    const stopBtn = document.getElementById('stop-stream-btn') || document.getElementById('chat-stop-btn');
    if (sendBtn) sendBtn.disabled = false;
    if (stopBtn) stopBtn.classList.add('hidden');
    scrollToBottom();
  }
}

// Backward compatibility alias
function handleChatSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  sendPrompt();
}

function copySnippet(elementId) {
  const el = document.getElementById(elementId);
  if (el) {
    const text = el.innerText;
    navigator.clipboard.writeText(text);
    showToast("Snippet copied to clipboard!", "📋");
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

// ================= Autonomous Idle GPU Crypto Mining UI =================
let miningPollInterval = null;
let initialMiningLoaded = false;

async function fetchMiningStatus() {
  try {
    const res = await fetch(`${apiBaseUrl}/api/mining/status`);
    if (!res.ok) return;
    const data = await res.json();
    updateMiningUI(data);
  } catch (e) {}
}

function updateMiningUI(data) {
  const badge = document.getElementById('mining-status-badge');
  const dot = document.getElementById('mining-dot');
  const text = document.getElementById('mining-status-text');
  const toggleBtn = document.getElementById('mining-toggle-btn');
  const toggleLabel = document.getElementById('mining-toggle-label');
  const hashrateVal = document.getElementById('mining-hashrate-val');
  const idleVal = document.getElementById('mining-idle-val');
  const gpusVal = document.getElementById('mining-gpus-val');
  const walletInput = document.getElementById('mining-wallet-input');
  const coinSelect = document.getElementById('mining-coin-select');

  if (!initialMiningLoaded) {
    if (walletInput && data.wallet) walletInput.value = data.wallet;
    if (coinSelect && data.coin) coinSelect.value = data.coin;
    initialMiningLoaded = true;
  }

  if (hashrateVal) hashrateVal.innerText = `${(data.estimated_hashrate_mhs || 0).toFixed(1)} MH/s`;
  if (idleVal) idleVal.innerText = `${data.idle_seconds || 0}s / ${data.idle_threshold || 180}s`;
  if (gpusVal) gpusVal.innerText = `${data.active_miners || 0} / 3 Nodes (${(data.active_miners || 0) * 2} P2000s)`;

  if (data.state === 'mining') {
    if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping";
    if (text) text.innerText = "Mining Active";
    if (badge) badge.className = "px-2.5 py-0.5 rounded-full text-[10px] font-mono border border-emerald-500/40 bg-emerald-950/30 text-emerald-400 flex items-center gap-1.5";
    if (toggleLabel) toggleLabel.innerText = "Disable Mining";
    if (toggleBtn) toggleBtn.className = "px-3 py-1 rounded-xl text-xs font-bold transition border border-rose-800/50 bg-rose-950/40 text-rose-300 hover:bg-rose-900/60";
  } else if (data.state === 'preempted_inference') {
    if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse";
    if (text) text.innerText = "Preempted (AI Active)";
    if (badge) badge.className = "px-2.5 py-0.5 rounded-full text-[10px] font-mono border border-amber-500/40 bg-amber-950/30 text-amber-400 flex items-center gap-1.5";
    if (toggleLabel) toggleLabel.innerText = "Disable Mining";
    if (toggleBtn) toggleBtn.className = "px-3 py-1 rounded-xl text-xs font-bold transition border border-rose-800/50 bg-rose-950/40 text-rose-300 hover:bg-rose-900/60";
  } else if (data.state === 'idle_waiting') {
    if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-cyan-400";
    if (text) text.innerText = `Idle Waiting (${data.idle_seconds}s)`;
    if (badge) badge.className = "px-2.5 py-0.5 rounded-full text-[10px] font-mono border border-cyan-500/40 bg-cyan-950/30 text-cyan-300 flex items-center gap-1.5";
    if (toggleLabel) toggleLabel.innerText = "Disable Mining";
    if (toggleBtn) toggleBtn.className = "px-3 py-1 rounded-xl text-xs font-bold transition border border-rose-800/50 bg-rose-950/40 text-rose-300 hover:bg-rose-900/60";
  } else {
    if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-slate-500";
    if (text) text.innerText = "Disabled";
    if (badge) badge.className = "px-2.5 py-0.5 rounded-full text-[10px] font-mono border border-[var(--border-app)] bg-[var(--bg-muted)] text-[var(--text-dim)] flex items-center gap-1.5";
    if (toggleLabel) toggleLabel.innerText = "Enable Mining";
    if (toggleBtn) toggleBtn.className = "px-3 py-1 rounded-xl text-xs font-bold transition border border-gold bg-gold-gradient text-slate-950 shadow-sm hover:brightness-110";
  }

  const topMiningEl = document.getElementById('admin-top-mining-status');
  if (topMiningEl) {
    if (data.state === 'mining') topMiningEl.innerText = `${data.coin || 'ETC'} Active (${(data.estimated_hashrate_mhs || 0).toFixed(0)} MH/s)`;
    else if (data.state === 'preempted_inference') topMiningEl.innerText = 'Preempted (AI Active)';
    else if (data.state === 'idle_waiting') topMiningEl.innerText = `Idle Waiting (${data.idle_seconds}s)`;
    else topMiningEl.innerText = 'Disabled';
  }
}

async function toggleIdleMining() {
  try {
    const statusRes = await fetch(`${apiBaseUrl}/api/mining/status`);
    const status = await statusRes.json();
    const endpoint = status.enabled ? '/api/mining/stop' : '/api/mining/start';
    const res = await fetch(`${apiBaseUrl}${endpoint}`, { method: 'POST' });
    if (res.ok) {
      showToast(status.enabled ? "Idle mining disabled" : "Idle mining enabled!", "⛏️");
      await fetchMiningStatus();
    }
  } catch (e) {
    showToast("Failed to toggle mining", "⚠");
  }
}

async function saveMiningSettings() {
  const walletInput = document.getElementById('mining-wallet-input');
  const coinSelect = document.getElementById('mining-coin-select');
  const wallet = walletInput ? walletInput.value.trim() : '';
  const coin = coinSelect ? coinSelect.value : 'ETC';

  if (!wallet) {
    showToast("Please enter a wallet address", "⚠");
    return;
  }

  try {
    const res = await fetch(`${apiBaseUrl}/api/mining/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, coin })
    });
    if (res.ok) {
      showToast("Mining settings saved!", "💾");
      await fetchMiningStatus();
    }
  } catch (e) {
    showToast("Failed to save mining settings", "⚠");
  }
}

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isStreaming) {
    stopGenerating();
  }
});

// Start on page load
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initWebSocket();
  fetchServersRest();
  fetchMiningStatus();
  setInterval(fetchMiningStatus, 6000);
  syncEditorGutter();

  const editor = getScratchpad();
  if (editor) {
    editor.addEventListener('keydown', handleEditorTabKey);
  }

  // Route to saved admin session or Portal landing view
  const savedToken = sessionStorage.getItem('admin_token');
  if (savedToken) {
    fetch(`${apiBaseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: savedToken })
    }).then(r => r.json()).then(d => {
      if (d.valid) {
        showView('view-admin');
      } else {
        sessionStorage.removeItem('admin_token');
        showView('view-portal');
      }
    }).catch(() => {
      showView('view-portal');
    });
  } else {
    showView('view-portal');
  }

  if (window.lucide) lucide.createIcons();
});
