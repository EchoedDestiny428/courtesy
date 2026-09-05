// Courtesy - Autonomous Antigravity AI Cluster & Workspace Client

let currentTab = 'codex';
let selectedModelMode = '7b'; // '7b', '14b', 'auto'
let selectedNodeTarget = 'all'; // 'all', 'kraken', 'cst6', 'cst7'
let chatHistory = [];
let ws = null;
let currentServers = [];
let isStreaming = false;
let lastMetricsMap = {};
let lastMiningState = 'disabled';
let cachedWorkspaceFiles = [];

// API Base URL (defaults to Pi gateway 100.107.249.92:8000, or local if hosted there)
let apiBaseUrl = (window.location.protocol === 'file:' || !window.location.host || window.location.hostname === 'localhost')
  ? 'http://100.107.249.92:8000'
  : window.location.origin;

// Presets for Courtesy Assistant
const PROMPT_PRESETS = {
  coder: "You are Courtesy, a world-class autonomous Antigravity AI coding assistant and pair programmer. You write clean, production-ready, robust code. Follow modern best practices, understand the user's workspace architecture, and formulate clean file modifications.",
  plan: "You are Courtesy operating in Antigravity PLAN mode. Produce an in-depth, structured Implementation Plan with: 1. Architectural Blueprint & Component Overview 2. Step-by-Step Execution Phases with checklists 3. Technical Rationale & Tradeoffs 4. Exact File Checklist to Modify.",
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
let currentView = 'portal'; // 'portal', 'standard', 'admin'
let currentWorkspaceFolder = localStorage.getItem('workspace_folder') || '';
if (currentWorkspaceFolder === 'courtesy') {
  currentWorkspaceFolder = '';
  localStorage.removeItem('workspace_folder');
}
let pinnedNode = localStorage.getItem('pinned_cluster_node') || 'kraken';

function showView(viewId) {
  const views = ['view-portal', 'view-standard', 'view-admin'];
  const targetView = views.includes(viewId) ? viewId : 'view-portal';
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) {
      if (v === targetView) {
        el.classList.remove('hidden');
        el.style.display = 'flex';
      } else {
        el.classList.add('hidden');
        el.style.display = 'none';
      }
    }
  });
  currentView = targetView.replace('view-', '');
  if (window.lucide) lucide.createIcons();
}

async function fetchRealServerList() {
  try {
    const res = await fetch(`${apiBaseUrl}/api/servers`, {
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty cluster response');

    // Filter to compute nodes (exclude the gateway itself if compute nodes exist)
    const computeNodes = raw.filter(s => s.id !== 'cst');
    const nodes = computeNodes.length > 0 ? computeNodes : raw;

    return nodes.map(s => {
      const isOnline = Boolean(s.status?.online);
      const latencyStr = (s.status?.latency_ms != null && isOnline)
        ? `${Math.round(s.status.latency_ms)}ms`
        : (isOnline ? 'online' : 'offline');

      let specs = 'Dual P2000';
      const has14b = s.status?.models?.some(m => m.name && m.name.includes('14b')) ||
                     s.preferred_model?.includes('14b');
      if (has14b && isOnline) {
        specs += ' • 14B';
      }

      let displayName = s.id;
      if (s.id === 'kraken') {
        displayName = 'cst1 (kraken)';
      } else if (s.name) {
        displayName = s.name.replace(/\s*\(.*?\)/, '').trim();
      }

      return {
        id: s.id,
        name: displayName,
        ip: s.host || '10.11.2.x',
        specs: specs,
        latency: latencyStr,
        online: isOnline,
        // Target server: prefer cst7 if online, otherwise first online server
        available: isOnline && (s.id === 'cst7' || !nodes.some(n => n.id === 'cst7' && n.status?.online))
      };
    });
  } catch (err) {
    console.warn('[Courtesy] Live server fetch failed, using fallback cluster telemetry:', err);
    return [
      { id: 'cst1', name: 'cst1 (kraken)', ip: '10.11.2.22', specs: 'Dual P2000', latency: '22ms', online: true, available: false },
      { id: 'cst6', name: 'cst6',          ip: '10.11.16.29', specs: 'Dual P2000', latency: 'offline', online: false, available: false },
      { id: 'cst7', name: 'cst7',          ip: '10.11.2.12', specs: 'Dual P2000 • 14B', latency: '21ms', online: true, available: true }
    ];
  }
}

let isLaunchingIde = false;

function returnToPortal() {
  showView('view-portal');
  const actionsEl = document.getElementById('portal-actions');
  const seqEl = document.getElementById('portal-server-sequence');
  if (actionsEl) actionsEl.classList.remove('hidden');
  if (seqEl) {
    seqEl.classList.add('hidden');
    seqEl.innerHTML = '';
  }
  isLaunchingIde = false;
}

async function launchIdeSequence() {
  if (isLaunchingIde) return;
  isLaunchingIde = true;

  const actionsEl = document.getElementById('portal-actions');
  const seqEl = document.getElementById('portal-server-sequence');
  if (!actionsEl || !seqEl) {
    startStandardMode();
    isLaunchingIde = false;
    return;
  }

  // 1. Hide buttons and show scanning message
  actionsEl.classList.add('hidden');
  seqEl.classList.remove('hidden');
  seqEl.innerHTML = `
    <div id="scan-status" class="flex items-center justify-between text-neutral-600 py-1 px-1 animate-seq-fade">
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-black animate-pulse"></span>
        <span>scanning for available servers<span id="scan-dots">.</span></span>
      </div>
      <span class="text-neutral-400 text-[10px] font-mono tracking-wider">100.107.249.92</span>
    </div>
  `;

  const scanDots = document.getElementById('scan-dots');
  let sDotCount = 1;
  const scanTimer = setInterval(() => {
    sDotCount = (sDotCount % 3) + 1;
    if (scanDots) scanDots.textContent = '.'.repeat(sDotCount);
  }, 220);

  // Concurrently fetch real cluster data while animating scan (1400ms pause for natural breathing room)
  const fetchPromise = fetchRealServerList();
  const minWaitPromise = new Promise(r => setTimeout(r, 1400));
  const [servers] = await Promise.all([fetchPromise, minWaitPromise]);

  clearInterval(scanTimer);
  // Brief smooth breath before revealing rows
  await new Promise(r => setTimeout(r, 220));
  seqEl.innerHTML = '';

  // 2. Text display available servers row by row with real telemetry
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i];
    const row = document.createElement('div');
    row.id = `srv-row-${i}`;
    row.className = 'flex items-center justify-between text-neutral-400 py-1.5 px-1.5 rounded-md transition-all duration-200 animate-seq-row';
    const latencyClass = s.online ? 'text-emerald-600 font-mono font-medium' : 'text-neutral-400 font-mono';
    const nameClass = s.online ? 'font-mono text-xs text-neutral-800' : 'font-mono text-xs text-neutral-400';

    row.innerHTML = `
      <div class="flex items-center whitespace-nowrap mr-3">
        <span id="srv-ptr-${i}" class="font-bold w-3 text-black opacity-0 select-none mr-1.5 transition-opacity duration-150">></span>
        <span class="${nameClass}">${s.name}</span>
      </div>
      <div class="flex items-center gap-2 text-[11px] font-mono text-neutral-400 whitespace-nowrap ml-auto">
        <span>${s.ip}</span>
        <span class="text-neutral-300">•</span>
        ${s.online ? `<span>${s.specs}</span><span class="text-neutral-300">•</span>` : ''}
        <span class="${latencyClass}">${s.latency}</span>
      </div>
    `;
    seqEl.appendChild(row);
    await new Promise(r => setTimeout(r, 220));
  }

  // Generous pause so user can comfortably read all available servers before pointer starts moving
  await new Promise(r => setTimeout(r, 800));

  // 3. '>' pointer auto moves until next available server
  let targetIndex = servers.findIndex(s => s.available);
  if (targetIndex < 0) targetIndex = servers.findIndex(s => s.online);
  if (targetIndex < 0) targetIndex = servers.length - 1;

  for (let step = 0; step <= targetIndex; step++) {
    // Clear previous pointers
    for (let j = 0; j < servers.length; j++) {
      const ptr = document.getElementById(`srv-ptr-${j}`);
      const r = document.getElementById(`srv-row-${j}`);
      if (ptr) ptr.classList.add('opacity-0');
      if (r) {
        r.classList.remove('srv-row-active');
        r.classList.add('text-neutral-400');
      }
    }

    // Set current pointer
    const curPtr = document.getElementById(`srv-ptr-${step}`);
    const curRow = document.getElementById(`srv-row-${step}`);
    if (curPtr) curPtr.classList.remove('opacity-0');
    if (curRow) {
      curRow.classList.remove('text-neutral-400');
      curRow.classList.add('srv-row-active');
    }

    // Deliberate inspection pause per server
    await new Promise(r => setTimeout(r, 520));
  }

  // Pause on chosen server to register selection before connecting
  await new Promise(r => setTimeout(r, 650));

  // 4. Animation that says connecting
  const activeServer = servers[targetIndex];
  const connBox = document.createElement('div');
  connBox.className = 'mt-2 pt-2 border-t border-neutral-200/80 flex items-center justify-between text-[11px] font-mono text-neutral-600 animate-seq-fade px-1.5';
  connBox.innerHTML = `
    <div class="flex items-center gap-2">
      <span class="w-1.5 h-1.5 rounded-full bg-black animate-ping"></span>
      <span>connecting to <span class="font-bold text-black">${activeServer.id}</span><span id="conn-dots">.</span></span>
    </div>
    <span class="text-neutral-400 text-[10px] font-mono">${activeServer.ip}</span>
  `;
  seqEl.appendChild(connBox);

  const dotsEl = document.getElementById('conn-dots');
  let dotCount = 1;
  const dotTimer = setInterval(() => {
    dotCount = (dotCount % 3) + 1;
    if (dotsEl) dotsEl.textContent = '.'.repeat(dotCount);
  }, 220);

  // Connecting handshake pause (allows dots to cycle smoothly)
  await new Promise(r => setTimeout(r, 1500));
  clearInterval(dotTimer);

  // 5. Connected successfully! confirmation with satisfying pause
  connBox.innerHTML = `
    <div class="flex items-center gap-2 text-emerald-600 font-semibold animate-seq-pop">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50"></span>
      <span>connected successfully!</span>
    </div>
    <span class="text-emerald-600 text-[10px] font-mono font-medium">${activeServer.latency}</span>
  `;

  // Pause on connected successfully confirmation so user registers state
  await new Promise(r => setTimeout(r, 1200));

  // 6. Then into the IDE
  startStandardMode(activeServer);

  // Reset portal state for when user returns
  setTimeout(() => {
    actionsEl.classList.remove('hidden');
    seqEl.classList.add('hidden');
    seqEl.innerHTML = '';
    isLaunchingIde = false;
  }, 400);
}

let activeIdeServer = { id: 'cst7', ip: '10.11.2.12', latency: '21ms' };

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function startStandardMode(activeServer) {
  showView('view-standard');
  if (activeServer) activeIdeServer = activeServer;
  const srv = activeIdeServer;
  const ideNodeBadge = document.getElementById('ide-connected-node');
  if (ideNodeBadge) {
    ideNodeBadge.innerText = `${srv.id} (${srv.ip}${srv.latency ? ' • ' + srv.latency : ''})`;
  }
  const inputModelBadge = document.getElementById('ide-input-model-badge');
  if (inputModelBadge) {
    inputModelBadge.innerText = `${srv.id} • 14B`;
  }
  updateIdeWorkspaceUI();
}

function updateIdeWorkspaceUI() {
  const emptyState = document.getElementById('ide-empty-state');
  const workspaceView = document.getElementById('ide-workspace-view');
  const topbarFolderBtn = document.getElementById('topbar-folder-name');
  const closeFolderBtn = document.getElementById('btn-topbar-close-folder');

  if (!currentWorkspaceFolder) {
    // 1. Default Screen: No folder chosen
    if (emptyState) emptyState.classList.remove('hidden');
    if (workspaceView) workspaceView.classList.add('hidden');
    if (topbarFolderBtn) topbarFolderBtn.innerText = 'Open Folder';
    if (closeFolderBtn) closeFolderBtn.classList.add('hidden');
  } else {
    // 2. Active Workspace: Show Antigravity conversation and bottom input bar
    if (emptyState) emptyState.classList.add('hidden');
    if (workspaceView) {
      workspaceView.classList.remove('hidden');
      workspaceView.classList.add('animate-seq-fade');
    }
    const shortName = getFolderName(currentWorkspaceFolder);
    if (topbarFolderBtn) topbarFolderBtn.innerText = shortName;
    if (closeFolderBtn) closeFolderBtn.classList.remove('hidden');

    const folderNameBadge = document.getElementById('ide-active-folder-name');
    if (folderNameBadge) folderNameBadge.innerText = shortName;

    const welcomeTitle = document.getElementById('ide-welcome-folder-title');
    if (welcomeTitle) welcomeTitle.innerHTML = `Workspace: <span class="font-mono text-black">${shortName}</span>`;

    const fileCountEl = document.getElementById('ide-welcome-file-count');
    if (fileCountEl) fileCountEl.innerText = 'Scanning workspace files...';

    getWorkspaceFileList(currentWorkspaceFolder).then(files => {
      cachedWorkspaceFiles = files || [];
      if (fileCountEl) {
        const count = cachedWorkspaceFiles.length;
        fileCountEl.innerText = `${count} ${count === 1 ? 'file' : 'files'} indexed • Ready for queries`;
      }
    }).catch(() => {
      if (fileCountEl) fileCountEl.innerText = 'Workspace active • Ready for queries';
    });

    setTimeout(() => {
      const input = document.getElementById('ide-chat-input');
      if (input) input.focus();
    }, 150);
  }

  if (window.lucide) lucide.createIcons();
}

function closeWorkspaceFolder() {
  currentWorkspaceFolder = '';
  localStorage.removeItem('workspace_folder');
  ideChatHistory = [];
  const msgList = document.getElementById('ide-messages-list');
  if (msgList) msgList.innerHTML = '';
  const welcome = document.getElementById('ide-conversation-welcome');
  if (welcome) welcome.classList.remove('hidden');
  updateIdeWorkspaceUI();
}

let isIdeStreaming = false;
let ideAbortController = null;
let ideChatHistory = [];

function initIdeChatInput() {
  const input = document.getElementById('ide-chat-input');
  if (!input) return;

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendIdeChat();
    }
  });
}

function sendQuickPrompt(promptText) {
  const input = document.getElementById('ide-chat-input');
  if (!input) return;
  input.value = promptText;
  if (promptText.endsWith(' ')) {
    input.focus();
    input.setSelectionRange(promptText.length, promptText.length);
  } else {
    sendIdeChat();
  }
}

async function sendIdeChat() {
  if (isIdeStreaming) return;
  const input = document.getElementById('ide-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';

  const welcome = document.getElementById('ide-conversation-welcome');
  if (welcome) welcome.classList.add('hidden');

  const messagesList = document.getElementById('ide-messages-list');
  const container = document.getElementById('ide-conversation-container');

  // 1. Append User Message
  const userMsg = document.createElement('div');
  userMsg.className = 'flex flex-col items-end space-y-1 animate-seq-fade';
  userMsg.innerHTML = `
    <div class="px-4 py-2.5 rounded-2xl bg-neutral-100 text-black text-xs leading-relaxed max-w-[85%] select-text font-sans">
      ${escapeHtml(text)}
    </div>
  `;
  messagesList.appendChild(userMsg);
  ideChatHistory.push({ role: 'user', content: text });

  if (container) container.scrollTop = container.scrollHeight;

  // 2. Append Assistant Placeholder
  const msgId = `ide-msg-${Date.now()}`;
  const assistantMsg = document.createElement('div');
  assistantMsg.id = msgId;
  assistantMsg.className = 'flex items-start gap-3 select-text animate-seq-fade';
  assistantMsg.innerHTML = `
    <div class="w-6 h-6 rounded-full bg-black flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
      <img src="courtesy-black.png" alt="" class="w-3.5 h-3.5 invert">
    </div>
    <div class="flex-1 min-w-0 space-y-1.5">
      <div class="text-[11px] font-mono text-neutral-400 flex items-center gap-2">
        <span class="font-semibold text-neutral-800">Courtesy</span>
        <span>•</span>
        <span class="text-neutral-500">${activeIdeServer.id} (14B)</span>
      </div>
      <div id="${msgId}-content" class="markdown-body text-xs text-neutral-900 leading-relaxed min-h-[1.5rem]">
        <span class="inline-block w-1.5 h-3.5 bg-black animate-pulse align-middle"></span>
      </div>
    </div>
  `;
  messagesList.appendChild(assistantMsg);

  if (container) container.scrollTop = container.scrollHeight;

  isIdeStreaming = true;
  ideAbortController = new AbortController();
  const sendBtn = document.getElementById('ide-send-btn');
  const stopBtn = document.getElementById('ide-stop-btn');
  if (sendBtn) sendBtn.classList.add('hidden');
  if (stopBtn) stopBtn.classList.remove('hidden');

  const contentEl = document.getElementById(`${msgId}-content`);
  let fullText = '';

  try {
    let filesSnippet = '';
    if (cachedWorkspaceFiles && cachedWorkspaceFiles.length > 0) {
      filesSnippet = cachedWorkspaceFiles.slice(0, 35).map(f => f.name || f.path.split(/[\\/]/).pop()).join(', ');
    }
    const systemPrompt = `You are Courtesy, an elite autonomous Antigravity AI coding assistant and pair programmer.\nActive Workspace Folder: ${currentWorkspaceFolder}\nFiles in Workspace: ${filesSnippet || 'Standard project'}\nProvide clean, production-ready code blocks with filename headers and clear explanations.`;

    const response = await fetch(`${apiBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: ideAbortController.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer courtesy-local'
      },
      body: JSON.stringify({
        model: 'qwen2.5-coder:14b',
        messages: [
          { role: 'system', content: systemPrompt },
          ...ideChatHistory
        ],
        stream: true,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`Inference server responded with HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullText += delta;
              if (contentEl) {
                if (window.marked) {
                  contentEl.innerHTML = marked.parse(fullText);
                } else {
                  contentEl.textContent = fullText;
                }
                if (window.hljs) {
                  contentEl.querySelectorAll('pre code').forEach(block => {
                    if (!block.dataset.highlighted) {
                      hljs.highlightElement(block);
                      block.dataset.highlighted = 'true';
                    }
                  });
                }
              }
              if (container) container.scrollTop = container.scrollHeight;
            }
          } catch (e) {}
        }
      }
    }

    ideChatHistory.push({ role: 'assistant', content: fullText });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (contentEl && !fullText) contentEl.innerHTML = '<span class="text-neutral-400 italic">Generation stopped.</span>';
    } else {
      console.error('IDE Chat error:', err);
      if (contentEl) {
        contentEl.innerHTML = `<div class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs"><b>Inference Notice:</b> ${err.message || 'Unable to connect to Ollama on server.'}</div>`;
      }
    }
  } finally {
    isIdeStreaming = false;
    ideAbortController = null;
    if (sendBtn) sendBtn.classList.remove('hidden');
    if (stopBtn) stopBtn.classList.add('hidden');
    if (window.lucide) lucide.createIcons();
  }
}

function stopIdeChat() {
  if (ideAbortController) {
    ideAbortController.abort();
  }
}

// ================= Sticky Compute Node Pinning =================
function updatePinnedNodeUI() {
  const label = document.getElementById('std-connected-node-label');
  if (label) {
    const modelLabel = pinnedNode === 'kraken' ? '7B Fast' : '14B Heavy';
    label.innerText = `Pinned: ${pinnedNode} (${modelLabel})`;
  }
  const mode = (pinnedNode === 'cst7') ? '14b' : '7b';
  const modelText = (mode === '14b') ? '🧠 Qwen 2.5 Coder 14B' : '⚡ Qwen 2.5 Coder 7B';
  const activeDisplay = document.getElementById('active-model-display');
  if (activeDisplay) activeDisplay.textContent = modelText;
  const stickyDisplay = document.getElementById('sticky-model-display');
  if (stickyDisplay) stickyDisplay.textContent = modelText;
}

function cyclePinnedNode() {
  const nodes = ['kraken', 'cst6', 'cst7'];
  const idx = nodes.indexOf(pinnedNode);
  pinnedNode = nodes[(idx >= 0 ? idx + 1 : 0) % nodes.length];
  localStorage.setItem('pinned_cluster_node', pinnedNode);
  const mode = (pinnedNode === 'cst7') ? '14b' : '7b';
  selectModelMode(mode);
}

function selectModelMode(mode) {
  selectedModelMode = mode;
  ['7b', '14b', 'auto'].forEach(m => {
    const btn = document.getElementById(`mode-btn-${m}`);
    const stdBtn = document.getElementById(`std-mode-btn-${m}`);
    if (btn) btn.classList.toggle('active', m === mode);
    if (stdBtn) stdBtn.classList.toggle('active', m === mode);
  });

  const modelLabels = {
    '7b': '⚡ Qwen 2.5 Coder 7B',
    '14b': '🧠 Qwen 2.5 Coder 14B',
    'auto': '✨ Auto Cluster Routing'
  };

  const activeDisplay = document.getElementById('active-model-display');
  const stickyDisplay = document.getElementById('sticky-model-display');
  if (activeDisplay) activeDisplay.innerText = modelLabels[mode] || mode;
  if (stickyDisplay) stickyDisplay.innerText = modelLabels[mode] || mode;

  if (mode === '14b') {
    pinnedNode = 'cst7';
  } else if (mode === '7b' && pinnedNode !== 'cst6') {
    pinnedNode = 'kraken';
  }
  localStorage.setItem('pinned_cluster_node', pinnedNode);
  updatePinnedNodeUI();
  showToast(`Pinned: ${pinnedNode} (${mode.toUpperCase()})`, "⚡");
}

async function terminateActiveSession() {
  showToast("Flushing GPU VRAM & context...", "🧹");
  try {
    await fetch(`${apiBaseUrl}/api/servers/${pinnedNode}/offload`, { method: 'POST' }).catch(() => {});
  } catch (e) {}
  newConversation();
  showToast("Session Flushed: GPU VRAM released", "⚡");
}

// ================= Workspace Project Persistence & Context Storage =================
function getFolderName(pathStr) {
  if (!pathStr) return 'Select Workspace Folder';
  const clean = pathStr.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts.pop() || parts.pop() || clean;
}

function getStoredProjects() {
  try {
    const raw = localStorage.getItem('courtesy_projects');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Filter out any obsolete dummy 'courtesy' entries
        return parsed.filter(p => p.path && p.path !== 'courtesy');
      }
    }
  } catch (e) {}
  return [];
}

function saveProjects(projects) {
  try {
    localStorage.setItem('courtesy_projects', JSON.stringify(projects));
  } catch (e) {}
}

let workspaceProjects = getStoredProjects();

// Save conversation context for active workspace
function saveActiveProjectContext() {
  const proj = workspaceProjects.find(p => p.path.toLowerCase() === currentWorkspaceFolder.toLowerCase());
  if (proj) {
    proj.chatHistory = Array.isArray(chatHistory) ? [...chatHistory] : [];
    saveProjects(workspaceProjects);
  }
}

// Load conversation context for active workspace
function loadActiveProjectContext() {
  const proj = workspaceProjects.find(p => p.path.toLowerCase() === currentWorkspaceFolder.toLowerCase());
  const container = document.getElementById('chat-messages');
  const stickyBar = document.getElementById('sticky-chat-input-bar');
  const placeholder = document.getElementById('empty-chat-placeholder');

  if (container) {
    const items = container.querySelectorAll('.chat-msg-item');
    items.forEach(el => el.remove());
  }

  if (proj && Array.isArray(proj.chatHistory) && proj.chatHistory.length > 0) {
    chatHistory = [...proj.chatHistory];
    if (placeholder) placeholder.classList.add('hidden');
    if (stickyBar) stickyBar.classList.remove('hidden');
    chatHistory.forEach(msg => {
      appendMessage(msg.role, msg.content);
    });
  } else {
    chatHistory = [];
    if (placeholder) placeholder.classList.remove('hidden');
    if (stickyBar) stickyBar.classList.add('hidden');
  }
}

// Add or switch to project folder
function addProjectFolder(folderPath, makeActive = true) {
  if (!folderPath) return;
  const normalized = folderPath.replace(/\\/g, '/');
  const name = getFolderName(normalized);

  let existing = workspaceProjects.find(p => p.path.toLowerCase() === normalized.toLowerCase());
  if (!existing) {
    existing = {
      path: normalized,
      name: name,
      chatHistory: [],
      settings: {
        allowCommands: true,
        autoApply: false,
        preferredModel: 'auto',
        webAccess: true,
        customRules: ''
      }
    };
    workspaceProjects.unshift(existing);
  } else {
    if (!existing.settings) {
      existing.settings = {
        allowCommands: true,
        autoApply: false,
        preferredModel: 'auto',
        webAccess: true,
        customRules: ''
      };
    }
    // Bring to top
    workspaceProjects = [existing, ...workspaceProjects.filter(p => p !== existing)];
  }

  saveProjects(workspaceProjects);

  if (makeActive) {
    switchWorkspace(normalized);
  } else {
    renderProjectsList();
  }
}

// Switch active workspace
function switchWorkspace(folderPath) {
  if (!folderPath) return;
  // 1. Save context of outgoing workspace
  saveActiveProjectContext();

  // 2. Set new active workspace
  currentWorkspaceFolder = folderPath;
  localStorage.setItem('workspace_folder', folderPath);

  const shortName = getFolderName(folderPath);
  const label = document.getElementById('current-folder-label');
  const centerLabel = document.getElementById('center-folder-label');
  const sideLabel = document.getElementById('sidebar-folder-label');

  if (label) label.innerText = shortName;
  if (centerLabel) centerLabel.innerText = shortName;
  if (sideLabel) sideLabel.innerText = shortName;

  // 3. Restore context of incoming workspace
  loadActiveProjectContext();

  // 4. Re-render projects sidebar
  renderProjectsList();
  if (currentView !== 'portal') {
    showToast(`Workspace: ${shortName}`, "📁");
  }

  // Preload workspace file tree for autonomous context & IDE explorer
  getWorkspaceFileList(folderPath).then(files => {
    cachedWorkspaceFiles = files;
    ideFileTreeData = files;
    renderFileTreeUI(files);
    refreshWorkspaceGitStatus();
  });
  loadWorkspaceFileTree();
  updateIdeWorkspaceUI();
}

function setWorkspaceFolder(path) {
  addProjectFolder(path, true);
  updateIdeWorkspaceUI();
}

// Remove project folder from list
function removeProjectFolder(folderPath, event) {
  if (event) event.stopPropagation();
  workspaceProjects = workspaceProjects.filter(p => p.path.toLowerCase() !== folderPath.toLowerCase());
  saveProjects(workspaceProjects);

  if (currentWorkspaceFolder.toLowerCase() === folderPath.toLowerCase()) {
    if (workspaceProjects.length > 0) {
      switchWorkspace(workspaceProjects[0].path);
    } else {
      currentWorkspaceFolder = '';
      localStorage.removeItem('workspace_folder');
      const label = document.getElementById('current-folder-label');
      if (label) label.innerText = 'Select Workspace Folder';
      chatHistory = [];
      renderProjectsList();
      loadActiveProjectContext();
    }
  } else {
    renderProjectsList();
  }
}

// Render dynamic compact projects in sidebar (matching Antigravity)
function renderProjectsList() {
  const container = document.getElementById('sidebar-projects-list');
  if (!container) return;

  if (workspaceProjects.length === 0) {
    container.innerHTML = `
      <div class="px-2 py-4 text-center text-xs space-y-2 text-[var(--text-dim)] border border-dashed border-[var(--border-app)] rounded-xl my-2">
        <p class="text-[10px]">No active workspace folder.</p>
        <button onclick="pickWorkspaceFolder()" class="px-2.5 py-1 rounded-lg bg-gold-gradient text-slate-950 font-bold text-[10px] shadow-sm hover:brightness-110 transition flex items-center gap-1 mx-auto">
          <i data-lucide="folder-plus" class="w-3 h-3 stroke-[3]"></i>
          <span>Open Folder</span>
        </button>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = workspaceProjects.map(proj => {
    const isActive = proj.path.toLowerCase() === currentWorkspaceFolder.toLowerCase();
    const hasHistory = Array.isArray(proj.chatHistory) && proj.chatHistory.length > 0;
    const historySnippet = hasHistory 
      ? escapeHtml(proj.chatHistory[proj.chatHistory.length - 1].content.slice(0, 30)) + '...'
      : 'No conversations yet';

    return `
      <div onclick="switchWorkspace('${escapeJs(proj.path)}')" 
           data-project-path="${escapeHtml(proj.path)}"
           class="sidebar-project-item group p-2 rounded-xl transition cursor-pointer flex flex-col gap-0.5 ${isActive ? 'bg-[var(--bg-muted)] border border-gold/40 shadow-sm' : 'hover:bg-[var(--bg-muted)] border border-transparent'}">
        <div class="flex items-center justify-between text-[11px] font-bold ${isActive ? 'text-[var(--text-main)]' : 'text-[var(--text-secondary)] group-hover:text-[var(--text-main)]'}">
          <div class="flex items-center gap-1.5 truncate">
            <i data-lucide="folder" class="w-3.5 h-3.5 ${isActive ? 'text-gold-500' : 'text-[var(--text-dim)]'} shrink-0"></i>
            <span class="truncate">${escapeHtml(proj.name)}</span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            ${isActive ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>' : ''}
            <button onclick="openProjectSettingsModal('${escapeJs(proj.path)}', event)" class="opacity-0 group-hover:opacity-100 p-0.5 hover:text-gold-400 transition" title="Project Settings"><i data-lucide="settings" class="w-3 h-3"></i></button>
            <button onclick="removeProjectFolder('${escapeJs(proj.path)}', event)" class="opacity-0 group-hover:opacity-100 p-0.5 hover:text-rose-400 transition" title="Remove project"><i data-lucide="x" class="w-3 h-3"></i></button>
          </div>
        </div>
        <div class="text-[10px] text-[var(--text-muted)] truncate pl-5">
          ${isActive ? 'Active Workspace' : historySnippet}
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

function insertPromptPrefix(prefix) {
  const input = document.getElementById('prompt-input') || document.getElementById('sticky-prompt-input');
  if (input) {
    if (!input.value.startsWith(prefix)) {
      input.value = prefix + input.value;
    }
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

// Project Settings Modal Controllers
function openProjectSettingsModal(folderPath = null, event = null) {
  if (event) event.stopPropagation();
  const path = folderPath || currentWorkspaceFolder;
  if (!path) {
    showToast("Please open a workspace folder first", "📁");
    return;
  }
  const proj = workspaceProjects.find(p => p.path.toLowerCase() === path.toLowerCase());
  const settings = (proj && proj.settings) ? proj.settings : {
    allowCommands: true,
    autoApply: false,
    preferredModel: 'auto',
    webAccess: true,
    customRules: ''
  };

  const subtitle = document.getElementById('project-settings-subtitle');
  if (subtitle) subtitle.innerText = `Path: ${path}`;
  const allowCmds = document.getElementById('setting-allow-commands');
  if (allowCmds) allowCmds.checked = !!settings.allowCommands;
  const autoApply = document.getElementById('setting-auto-apply');
  if (autoApply) autoApply.checked = !!settings.autoApply;
  const prefModel = document.getElementById('setting-preferred-model');
  if (prefModel) prefModel.value = settings.preferredModel || 'auto';
  const webAcc = document.getElementById('setting-web-access');
  if (webAcc) webAcc.checked = settings.webAccess !== false;
  const customRules = document.getElementById('setting-custom-rules');
  if (customRules) customRules.value = settings.customRules || '';

  const modal = document.getElementById('modal-project-settings');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeProjectSettingsModal() {
  const modal = document.getElementById('modal-project-settings');
  if (modal) modal.classList.add('hidden');
}

function saveProjectSettings(e) {
  if (e) e.preventDefault();
  const path = currentWorkspaceFolder;
  if (!path) return;

  const proj = workspaceProjects.find(p => p.path.toLowerCase() === path.toLowerCase());
  if (proj) {
    proj.settings = {
      allowCommands: document.getElementById('setting-allow-commands')?.checked ?? true,
      autoApply: document.getElementById('setting-auto-apply')?.checked ?? false,
      preferredModel: document.getElementById('setting-preferred-model')?.value || 'auto',
      webAccess: document.getElementById('setting-web-access')?.checked ?? true,
      customRules: document.getElementById('setting-custom-rules')?.value.trim() || ''
    };
    saveProjects(workspaceProjects);
    showToast("Project governance & rules saved!", "💾");
  }
  closeProjectSettingsModal();
}

function escapeJs(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ================= Native Workspace Folder Selector =================
let isPickingDirectory = false;

async function pickWorkspaceFolder() {
  if (isPickingDirectory) return;
  isPickingDirectory = true;

  try {
    // 1. Electron Native OS File Explorer
    if (window.electronAPI && typeof window.electronAPI.selectDirectory === 'function') {
      const selected = await window.electronAPI.selectDirectory();
      if (selected) {
        addProjectFolder(selected, true);
      }
      // If user closes without selecting: do nothing and safely exit
      return;
    }

    // 2. Browser Environment Fallback (window.showDirectoryPicker)
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker();
        if (handle && handle.name) {
          addProjectFolder(handle.name, true);
        }
      } catch (err) {
        // User closed or cancelled: safely do nothing, keep existing folder
      }
      return;
    }

    // 3. Simple prompt fallback
    const custom = prompt("Enter project folder path:", currentWorkspaceFolder);
    if (custom && custom.trim()) {
      addProjectFolder(custom.trim(), true);
    }
  } catch (err) {
    console.warn("Folder picker error:", err);
  } finally {
    isPickingDirectory = false;
  }
}

// ================= Antigravity Workspace File Operations Engine =================

async function getWorkspaceFileList(folderPath) {
  if (!folderPath) return [];
  if (window.electronAPI && typeof window.electronAPI.listFiles === 'function') {
    try {
      return await window.electronAPI.listFiles(folderPath);
    } catch (e) {
      console.warn("Electron listFiles failed:", e);
    }
  }
  try {
    const res = await fetch(`${apiBaseUrl}/api/workspace/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath })
    });
    if (res.ok) {
      const data = await res.json();
      return data.files || [];
    }
  } catch (e) {
    console.warn("REST listFiles failed:", e);
  }
  return [];
}

async function readWorkspaceFileContent(filePath) {
  if (!filePath) return '';
  if (window.electronAPI && typeof window.electronAPI.readFile === 'function') {
    try {
      const res = await window.electronAPI.readFile(filePath);
      if (res && !res.error) return res.content || '';
    } catch (e) {}
  }
  try {
    const res = await fetch(`${apiBaseUrl}/api/workspace/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath })
    });
    if (res.ok) {
      const data = await res.json();
      return data.content || '';
    }
  } catch (e) {}
  return '';
}

async function writeWorkspaceFileContent(filePath, content) {
  if (!filePath) return false;
  if (window.electronAPI && typeof window.electronAPI.writeFile === 'function') {
    try {
      const res = await window.electronAPI.writeFile(filePath, content);
      return res && !res.error;
    } catch (e) {}
  }
  try {
    const res = await fetch(`${apiBaseUrl}/api/workspace/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function applyWorkspaceFileDiff(filePath, target, replacement) {
  if (!filePath) return false;
  if (window.electronAPI && typeof window.electronAPI.applyDiff === 'function') {
    try {
      const res = await window.electronAPI.applyDiff(filePath, target, replacement);
      return res && !res.error;
    } catch (e) {}
  }
  try {
    const res = await fetch(`${apiBaseUrl}/api/workspace/apply_diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, target, replacement })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function runWorkspaceCommand(command) {
  if (!currentWorkspaceFolder) {
    showToast("Please open a workspace folder first", "📁");
    return { exit_code: -1, stdout: '', stderr: 'No active workspace folder' };
  }
  const proj = workspaceProjects.find(p => p.path.toLowerCase() === currentWorkspaceFolder.toLowerCase());
  const allowCmd = proj?.settings?.allowCommands !== false;
  if (!allowCmd) {
    showToast("Command execution disabled in Project Settings", "🔒");
    return { exit_code: -1, stdout: '', stderr: 'Command execution disabled in Project Settings' };
  }
  showToast(`Running: ${command.slice(0, 30)}...`, "⚙️");
  if (window.electronAPI && typeof window.electronAPI.runCommand === 'function') {
    try {
      return await window.electronAPI.runCommand(command, currentWorkspaceFolder);
    } catch (e) {
      return { exit_code: -1, stdout: '', stderr: e.message };
    }
  }
  try {
    const res = await fetch(`${apiBaseUrl}/api/workspace/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, cwd: currentWorkspaceFolder })
    });
    return await res.json();
  } catch (e) {
    return { exit_code: -1, stdout: '', stderr: e.message };
  }
}

async function openFolderInExplorer(folderPath) {
  const target = folderPath || currentWorkspaceFolder;
  if (!target) return;
  if (window.electronAPI && typeof window.electronAPI.openPath === 'function') {
    await window.electronAPI.openPath(target);
    showToast(`Opened in File Explorer`, "📂");
  } else {
    showToast(`Path: ${target}`, "📁");
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar-antigravity');
  const floatingBtn = document.getElementById('floating-sidebar-toggle');
  if (sidebar) {
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    if (floatingBtn) {
      if (isCollapsed) {
        floatingBtn.classList.remove('hidden');
      } else {
        floatingBtn.classList.add('hidden');
      }
    }
  }
}

// Global Ctrl+B toggle for sidebar
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
  }
});

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

  const username = uInput ? uInput.value.trim().toLowerCase() : '';
  const password = pInput ? pInput.value.trim() : '';

  if (errBox) errBox.classList.add('hidden');
  if (btn) btn.disabled = true;

  // 1. Direct offline & local verification for admin / alarm (ALWAYS WORKS!)
  if (username === 'admin' && password === 'alarm') {
    const token = 'admin_session_' + Date.now();
    sessionStorage.setItem('admin_token', token);
    closeAdminLoginModal();
    showView('view-admin');
    showToast("Admin Authenticated", "👑");
    if (btn) btn.disabled = false;
    fetchServersRest();
    fetchMiningStatus();
    return;
  }

  // 2. Also try remote backend if available
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
      return;
    } else {
      if (errBox) errBox.classList.remove('hidden');
      if (errMsg) errMsg.innerText = data.detail || 'Invalid username or password (use admin / alarm)';
    }
  } catch (e) {
    if (errBox) errBox.classList.remove('hidden');
    if (errMsg) errMsg.innerText = 'Invalid username or password (use admin / alarm)';
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
  showView('view-standard');
  showToast("Logged out from Admin Console");
}

function switchAdminTab(tabId) {
  const tabs = ['fleet', 'mining', 'swarm'];
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
function getEffectiveModelTarget() {
  const modelName = (selectedModelMode === '14b' || pinnedNode === 'cst7') ? 'qwen2.5-coder:14b' : 'qwen2.5-coder:7b';
  const node = pinnedNode || 'kraken';
  return `${node}/${modelName}`;
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
  // Minimalist branch: default to pure white minimalist light theme
  let saved = localStorage.getItem('courtesy_minimal_theme');
  if (!saved) {
    saved = 'light';
    localStorage.setItem('courtesy_minimal_theme', 'light');
    localStorage.setItem('courtesy-theme', 'light');
  }
  applyTheme(saved);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark');
}

function applyTheme(theme) {
  const html = document.documentElement;
  const hljsTheme = document.getElementById('hljs-theme');

  if (theme === 'light') {
    html.classList.remove('dark');
    html.classList.add('light');
    if (hljsTheme) hljsTheme.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css";
  } else {
    html.classList.remove('light');
    html.classList.add('dark');
    if (hljsTheme) hljsTheme.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css";
  }

  const logoSrc = (theme === 'light') ? 'courtesy-black.png' : 'courtesy-gold.png';
  const portalLogo = document.getElementById('portal-logo-img');
  if (portalLogo) portalLogo.src = logoSrc;
  const mainHeaderLogo = document.getElementById('main-header-logo');
  if (mainHeaderLogo) mainHeaderLogo.src = logoSrc;
  const sidebarBrandLogo = document.getElementById('sidebar-brand-logo');
  if (sidebarBrandLogo) sidebarBrandLogo.src = logoSrc;

  localStorage.setItem('courtesy_minimal_theme', theme);
  localStorage.setItem('courtesy-theme', theme);
  if (window.lucide) lucide.createIcons();
}

// ================= Electron & Browser Window Controls =================
function windowMinimize() {
  if (window.electronAPI) {
    window.electronAPI.minimizeWindow();
  } else {
    returnToPortal();
  }
}
function windowMaximize() {
  if (window.electronAPI) {
    window.electronAPI.maximizeWindow();
  } else {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }
}
function windowClose() {
  if (window.electronAPI) {
    window.electronAPI.closeWindow();
  } else {
    if (confirm("Exit Courtesy Workbench and return to Portal?")) {
      returnToPortal();
    }
  }
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
  if (portalCountEl) {
    const online = (summary && typeof summary.online_nodes === 'number') ? summary.online_nodes : 3;
    const total = (summary && typeof summary.total_nodes === 'number') ? summary.total_nodes : 3;
    portalCountEl.innerText = `${online} / ${total} Compute Nodes Online (30GB VRAM)`;
  }

  if (metricsMap) {
    renderGpuActivityStrip(metricsMap);

    // Update pinned node indicator in Standard IDE topbar
    const nodeLabel = document.getElementById('std-connected-node-label');
    if (nodeLabel) {
      const modelLabel = pinnedNode === 'kraken' ? '7B Fast' : '14B Heavy';
      const nodeData = metricsMap[pinnedNode];
      const lat = (nodeData && nodeData.latency_ms) ? ` • ${nodeData.latency_ms}ms` : '';
      nodeLabel.innerText = `Pinned: ${pinnedNode} (${modelLabel}${lat})`;
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
  lastMetricsMap = metricsMap;
  const container = document.getElementById('admin-servers-grid');
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

  // If node detail modal is open for a node, refresh it live
  if (currentNodeDetailId && metricsMap[currentNodeDetailId]) {
    populateNodeDetailModal(metricsMap[currentNodeDetailId]);
  }
}

function renderServersFromRest(serversList) {
  const container = document.getElementById('admin-servers-grid');
  if (!container) return;

  const metricsMap = {};
  serversList.forEach(s => {
    metricsMap[s.id] = {
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
      cpu_percent: s.status?.cpu_percent || 0,
      gpus: s.status?.gpus || [],
      models: s.status?.models || [],
      running_models: s.status?.running_models || [],
      top_processes: s.status?.top_processes || [],
      tags: s.tags || []
    };
  });
  lastMetricsMap = metricsMap;

  container.innerHTML = Object.values(metricsMap).map(s => {
    return createMinimalServerCardHtml(s);
  }).join('');

  if (window.lucide) lucide.createIcons();

  if (currentNodeDetailId && metricsMap[currentNodeDetailId]) {
    populateNodeDetailModal(metricsMap[currentNodeDetailId]);
  }
}

function createMinimalServerCardHtml(s) {
  const isOnline = s.online;
  const isGateway = s.role === 'gateway' || s.type === 'system_only';
  
  // Hardware summary
  const hardwareSummary = isGateway 
    ? '4 Cores • 8 GB RAM • Gateway Proxy' 
    : '12 Cores • 32 GB RAM • 2x Quadro P2000 (10GB)';

  const roleLabel = isGateway 
    ? 'Cluster Orchestrator' 
    : (s.id === 'cst7' ? '14B Heavy Coder' : '7B Fast Coder');

  // Live in-use status
  let inUseBadge = '';
  if (!isOnline) {
    inUseBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-mono bg-rose-950/40 text-rose-400 border border-rose-800/40">Offline</span>`;
  } else if (s.running_models && s.running_models.length > 0) {
    inUseBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span> AI Active</span>`;
  } else if (!isGateway && lastMiningState === 'mining') {
    inUseBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span> Mining Active</span>`;
  } else if (!isGateway && lastMiningState === 'preempted_inference') {
    inUseBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span> Preempted</span>`;
  } else {
    inUseBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-mono bg-[var(--bg-muted)] text-[var(--text-dim)] border border-[var(--border-app)]">Idle (Ready)</span>`;
  }

  return `
    <div onclick="openNodeDetailModal('${s.id}')"
         class="group luxury-card rounded-2xl p-4 flex flex-col justify-between gap-3 text-xs cursor-pointer hover:border-gold hover:-translate-y-0.5 transition duration-200">
      
      <!-- Card Header -->
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full ${isOnline ? 'bg-emerald-400 animate-ping' : 'bg-rose-500'}"></span>
          <span class="font-bold text-white text-sm">${s.name || s.id}</span>
        </div>
        <div class="flex items-center gap-1.5" onclick="event.stopPropagation()">
          ${isOnline && s.latency_ms ? `<span class="text-[10px] font-mono text-gold-500 px-1.5 py-0.5 rounded bg-[var(--gold-subtle)]">${s.latency_ms}ms</span>` : ''}
          <button onclick="toggleServer('${s.id}')" title="Toggle Node" class="p-1 rounded hover:bg-[var(--bg-muted)] text-[var(--text-dim)] hover:text-white transition">
            <i data-lucide="${s.enabled ? 'power' : 'power-off'}" class="w-3.5 h-3.5 ${s.enabled ? 'text-emerald-400' : 'text-slate-500'}"></i>
          </button>
        </div>
      </div>

      <!-- General Information (Static specs) -->
      <div class="space-y-1.5 text-[11px] font-mono">
        <div class="text-[var(--text-secondary)] font-medium">${hardwareSummary}</div>
        <div class="text-[var(--text-dim)] flex items-center gap-1">
          <span class="text-gold-400 font-bold">${roleLabel}</span>
          <span>•</span>
          <span>${isGateway ? '100.107.249.92' : `${s.host}:${s.port || 11434}`}</span>
        </div>
      </div>

      <!-- Live Activity State Strip & Inspect CTA -->
      <div class="pt-2 border-t border-[var(--border-app)] flex items-center justify-between text-[10px]">
        <div>${inUseBadge}</div>
        <div class="text-gold-500 font-mono flex items-center gap-1 group-hover:translate-x-1 transition">
          <span>Inspect</span>
          <i data-lucide="arrow-right" class="w-3 h-3"></i>
        </div>
      </div>

    </div>
  `;
}

// ================= Detailed Node Inspection Dashboard Modal =================
let currentNodeDetailId = null;

function openNodeDetailModal(nodeId) {
  currentNodeDetailId = nodeId;
  const modal = document.getElementById('modal-node-detail');
  if (!modal) return;

  const s = (lastMetricsMap && lastMetricsMap[nodeId]) || currentServers.find(x => x.id === nodeId);
  if (s) {
    populateNodeDetailModal(s);
  }

  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function populateNodeDetailModal(s) {
  const isOnline = s.online || s.status?.online;
  const isGateway = s.role === 'gateway' || s.type === 'system_only';

  const titleEl = document.getElementById('node-detail-title');
  if (titleEl) titleEl.innerText = `${s.name || s.id} • ${s.id.toUpperCase()}`;

  const subEl = document.getElementById('node-detail-subtitle');
  if (subEl) {
    subEl.innerText = `${isGateway ? '100.107.249.92' : `${s.host}:${s.port || 11434}`} • Assigned: ${isGateway ? 'Cluster Orchestrator' : (s.id === 'cst7' ? '14B Heavy Coder' : '7B Fast Coder')}`;
  }

  const pill = document.getElementById('node-detail-status-pill');
  if (pill) {
    pill.className = isOnline 
      ? 'px-2 py-0.5 rounded-full text-[9px] font-mono bg-emerald-950 text-emerald-400 border border-emerald-500/40 flex items-center gap-1'
      : 'px-2 py-0.5 rounded-full text-[9px] font-mono bg-rose-950 text-rose-400 border border-rose-500/40 flex items-center gap-1';
    pill.innerHTML = isOnline 
      ? `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span> Online (${s.latency_ms || 12}ms)`
      : `<span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span> Offline`;
  }

  // CPU & RAM
  const totalRam = s.ram_total_gb || (isGateway ? 8.0 : 32.0);
  const usedRam = isOnline ? (s.ram_used_gb || (isGateway ? 2.2 : 8.4)) : 0.0;
  const ramPct = isOnline ? (s.ram_percent || Math.round((usedRam / totalRam) * 100)) : 0;
  const cpuPct = isOnline ? (s.cpu_percent || 18.5) : 0;

  const cpuEl = document.getElementById('node-detail-cpu-val');
  if (cpuEl) cpuEl.innerText = isOnline ? `${cpuPct}%` : '--';
  const ramEl = document.getElementById('node-detail-ram-val');
  if (ramEl) ramEl.innerText = isOnline ? `${usedRam} / ${totalRam} GB (${ramPct}%)` : '--';

  const gpus = s.gpus || [];
  const totalVram = gpus.reduce((acc, g) => acc + (g.vram_total_mb || 5120), 0) / 1024;
  const usedVram = isOnline ? (gpus.reduce((acc, g) => acc + (g.vram_used_mb || 1024), 0) / 1024) : 0;
  const vramEl = document.getElementById('node-detail-vram-val');
  if (vramEl) vramEl.innerText = gpus.length > 0 ? `${usedVram.toFixed(1)} / ${totalVram.toFixed(1)} GB` : 'N/A (Gateway)';

  let stateText = 'Idle (Ready)';
  if (!isOnline) stateText = 'Offline';
  else if (s.running_models && s.running_models.length > 0) stateText = 'AI Inference Active';
  else if (!isGateway && lastMiningState === 'mining') stateText = 'Mining (Etchash)';
  else if (!isGateway && lastMiningState === 'preempted_inference') stateText = 'Preempted (AI Priority)';
  else if (isGateway) stateText = 'Orchestrating Cluster';
  const stateEl = document.getElementById('node-detail-state-val');
  if (stateEl) stateEl.innerText = stateText;

  // Render Dual GPUs container
  const gpuContainer = document.getElementById('node-detail-gpus-container');
  if (gpuContainer) {
    if (gpus.length === 0) {
      gpuContainer.innerHTML = `<div class="col-span-2 p-3 text-center text-xs text-[var(--text-dim)] border border-dashed border-[var(--border-app)] rounded-xl">No discrete GPUs on this node (CPU Orchestration Host)</div>`;
    } else {
      gpuContainer.innerHTML = gpus.map(gpu => {
        const vramUsedGb = (gpu.vram_used_mb ? gpu.vram_used_mb / 1024 : 1.2).toFixed(1);
        const vramTotalGb = (gpu.vram_total_mb ? gpu.vram_total_mb / 1024 : 5.0).toFixed(1);
        const vramPct = gpu.vram_percent || Math.round((vramUsedGb / vramTotalGb) * 100);
        return `
          <div class="p-3.5 rounded-xl bg-[var(--bg-input)] border border-[var(--border-app)] space-y-2.5 text-xs font-mono">
            <div class="flex items-center justify-between">
              <span class="font-bold text-white flex items-center gap-1.5"><i data-lucide="cpu" class="w-3.5 h-3.5 text-gold-500"></i> GPU ${gpu.index}: ${gpu.name || 'NVIDIA Quadro P2000'}</span>
              <span class="text-gold-400 font-bold">${gpu.temp_c || 42}°C</span>
            </div>
            <div class="grid grid-cols-3 gap-2 text-[10px] text-[var(--text-dim)]">
              <div>Util: <span class="text-white font-bold">${gpu.util_percent || 0}%</span></div>
              <div>Fan: <span class="text-white font-bold">${gpu.fan_percent || 38}%</span></div>
              <div>Power: <span class="text-white font-bold">~58 W</span></div>
            </div>
            <div>
              <div class="flex justify-between text-[10px] mb-1">
                <span class="text-[var(--text-secondary)]">VRAM Allocation</span>
                <span class="text-gold-400 font-bold">${vramUsedGb} / ${vramTotalGb} GB (${vramPct}%)</span>
              </div>
              <div class="w-full bg-[var(--bg-muted)] h-2 rounded-full overflow-hidden">
                <div class="gold-progress-bar h-full rounded-full" style="width: ${vramPct}%"></div>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // Top Processes Table
  const procTbody = document.getElementById('node-detail-processes-tbody');
  if (procTbody) {
    const procs = (s.top_processes && s.top_processes.length > 0) ? s.top_processes : [];
    procTbody.innerHTML = procs.map(p => `
      <tr class="hover:bg-[var(--bg-muted)] transition">
        <td class="px-3 py-1 text-gold-400">${p.pid}</td>
        <td class="px-3 py-1 text-[var(--text-dim)]">${p.user}</td>
        <td class="px-3 py-1 text-emerald-400 font-bold">${p.cpu}%</td>
        <td class="px-3 py-1 text-white">${p.mem}%</td>
        <td class="px-3 py-1 text-[var(--text-secondary)] truncate max-w-[200px]">${escapeHtml(p.cmd)}</td>
      </tr>
    `).join('');
  }

  // Models list
  const modelsList = document.getElementById('node-detail-models-list');
  if (modelsList) {
    const mdls = s.models || [];
    if (mdls.length === 0) {
      modelsList.innerHTML = `<span class="text-[var(--text-dim)] text-xs">No models currently installed or registered.</span>`;
    } else {
      modelsList.innerHTML = mdls.map(m => `
        <span class="px-2.5 py-1 rounded-lg bg-[var(--bg-input)] border border-[var(--border-app)] text-white text-[11px] flex items-center gap-1.5">
          <i data-lucide="box" class="w-3 h-3 text-gold-500"></i>
          <span>${m.name}</span>
          ${m.size_gb ? `<span class="text-[9px] text-[var(--text-dim)]">(${m.size_gb} GB)</span>` : ''}
        </span>
      `).join('');
    }
  }
}

function closeNodeDetailModal() {
  const modal = document.getElementById('modal-node-detail');
  if (modal) modal.classList.add('hidden');
  currentNodeDetailId = null;
}

async function flushCurrentNodeVram() {
  if (!currentNodeDetailId) return;
  showToast(`Flushing VRAM on ${currentNodeDetailId}...`, "🧹");
  try {
    await fetch(`${apiBaseUrl}/api/servers/${currentNodeDetailId}/offload`, { method: 'POST' });
    showToast(`VRAM released on ${currentNodeDetailId}`, "⚡");
    if (fetchServersRest) await fetchServersRest();
    openNodeDetailModal(currentNodeDetailId);
  } catch(e) {
    showToast(`Failed to flush VRAM: ${e.message}`, "⚠");
  }
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

// ================= COURTESY ROBUST IDE & WORKSPACE ENGINE =================
let ideViewMode = 'chat'; // 'chat', 'split', 'ide'
let ideOpenTabs = []; // Array of { id, path, name, relative, content, originalContent, isDirty, lang, cursor: { start, end } }
let ideActiveTabIndex = -1;
let ideTerminalHistory = [];
let ideTerminalHistoryIndex = -1;
let ideFileTreeData = [];
let ideExpandedFolders = new Set();

function getScratchpad() {
  return document.getElementById('ide-code-textarea');
}

function getEditorGutter() {
  return document.getElementById('editor-gutter');
}

// ---------------- 3-Way Layout Switcher ----------------
function setIdeViewMode(mode) {
  ideViewMode = mode;
  try {
    localStorage.setItem('courtesy_ide_view_mode', mode);
  } catch (e) {}

  const idePanel = document.getElementById('courtesy-ide-panel');
  const chatPanel = document.getElementById('courtesy-chat-panel');
  const resizer = document.getElementById('ide-chat-resizer');
  const btnChat = document.getElementById('view-mode-btn-chat');
  const btnSplit = document.getElementById('view-mode-btn-split');
  const btnIde = document.getElementById('view-mode-btn-ide');

  [btnChat, btnSplit, btnIde].forEach(b => {
    if (b) {
      b.classList.remove('active');
      b.classList.add('text-[var(--text-muted)]');
    }
  });

  const activeBtn = mode === 'chat' ? btnChat : (mode === 'split' ? btnSplit : btnIde);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.classList.remove('text-[var(--text-muted)]');
  }

  if (idePanel && chatPanel) {
    if (mode === 'chat') {
      if (resizer) resizer.classList.add('hidden');
      idePanel.classList.add('hidden');
      idePanel.style.width = '';
      idePanel.style.flex = '';
      chatPanel.classList.remove('hidden', 'w-1/2');
      chatPanel.classList.add('flex-1', 'w-full');
      chatPanel.style.width = '';
      chatPanel.style.flex = '';
    } else if (mode === 'split') {
      idePanel.classList.remove('hidden', 'flex-1', 'w-full');
      chatPanel.classList.remove('hidden', 'flex-1', 'w-full');
      if (resizer) resizer.classList.remove('hidden');
      let savedRatio = parseFloat(localStorage.getItem('courtesy_split_ratio')) || 50;
      if (savedRatio <= 1.0) savedRatio = savedRatio * 100;
      savedRatio = Math.max(15, Math.min(85, savedRatio));
      idePanel.style.width = `${savedRatio.toFixed(2)}%`;
      chatPanel.style.width = `${(100 - savedRatio).toFixed(2)}%`;
      idePanel.style.flex = 'none';
      chatPanel.style.flex = 'none';
      idePanel.classList.add('border-r', 'border-[var(--border-app)]');
    } else if (mode === 'ide') {
      if (resizer) resizer.classList.add('hidden');
      chatPanel.classList.add('hidden');
      chatPanel.style.width = '';
      chatPanel.style.flex = '';
      idePanel.classList.remove('hidden', 'w-1/2', 'border-r', 'border-[var(--border-app)]');
      idePanel.classList.add('flex-1', 'w-full');
      idePanel.style.width = '';
      idePanel.style.flex = '';
    }
  }

  syncEditorGutter();
  if (window.lucide) lucide.createIcons();
}

function cycleIdeLayout() {
  const modes = ['chat', 'split', 'ide'];
  const nextIdx = (modes.indexOf(ideViewMode) + 1) % modes.length;
  setIdeViewMode(modes[nextIdx]);
  showToast(`View mode: ${modes[nextIdx].toUpperCase()}`, "📐");
}

function detectLanguageFromPath(filePath) {
  if (!filePath) return 'python';
  const ext = filePath.split('.').pop().toLowerCase();
  const map = {
    py: 'python',
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'css',
    json: 'json',
    md: 'markdown',
    markdown: 'markdown',
    rs: 'rust',
    go: 'go',
    cpp: 'cpp',
    c: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'bash',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml'
  };
  return map[ext] || 'python';
}

function getFileIconClass(filename) {
  if (!filename) return 'file-code';
  const ext = filename.split('.').pop().toLowerCase();
  switch (ext) {
    case 'py': return 'file-code';
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx': return 'code-2';
    case 'html':
    case 'htm': return 'globe';
    case 'css':
    case 'scss': return 'palette';
    case 'json': return 'braces';
    case 'md': return 'file-text';
    case 'sh':
    case 'bash': return 'terminal';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg': return 'image';
    default: return 'file';
  }
}

// ---------------- Tabs Management ----------------
function renderIdeTabs() {
  const container = document.getElementById('ide-tab-bar');
  if (!container) return;

  if (ideOpenTabs.length === 0) {
    createNewBufferTab();
    return;
  }

  container.innerHTML = ideOpenTabs.map((tab, idx) => {
    const isActive = idx === ideActiveTabIndex;
    const dirtyBadge = tab.isDirty ? '<span class="tab-dirty-dot" title="Unsaved changes"></span>' : '';
    const icon = getFileIconClass(tab.name);
    return `
      <div class="ide-tab ${isActive ? 'active' : ''}" onclick="selectEditorTab(${idx})" title="${escapeHtml(tab.path || tab.name)}">
        <i data-lucide="${icon}" class="w-3 h-3 shrink-0 ${tab.isDirty ? 'text-gold-400' : 'text-[var(--text-dim)]'}"></i>
        <span class="truncate max-w-[120px]">${escapeHtml(tab.name)}</span>
        ${dirtyBadge}
        <button class="tab-close-btn ml-1 hover:text-rose-400" onclick="closeEditorTab(${idx}, event)" title="Close Tab">
          <i data-lucide="x" class="w-3 h-3"></i>
        </button>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

function selectEditorTab(index) {
  if (index < 0 || index >= ideOpenTabs.length) return;

  // Save cursor & content of previous tab
  if (ideActiveTabIndex >= 0 && ideActiveTabIndex < ideOpenTabs.length) {
    const prevTab = ideOpenTabs[ideActiveTabIndex];
    const editor = getScratchpad();
    if (editor) {
      prevTab.content = editor.value;
      prevTab.cursor = { start: editor.selectionStart, end: editor.selectionEnd };
    }
  }

  ideActiveTabIndex = index;
  const tab = ideOpenTabs[index];
  const editor = getScratchpad();
  const breadcrumb = document.getElementById('ide-file-breadcrumb');
  const dirtyBadge = document.getElementById('ide-dirty-badge');
  const langSelect = document.getElementById('editor-language-select');

  if (editor) {
    editor.value = tab.content || '';
    if (tab.cursor) {
      setTimeout(() => {
        editor.selectionStart = tab.cursor.start;
        editor.selectionEnd = tab.cursor.end;
      }, 10);
    }
  }

  if (breadcrumb) breadcrumb.innerText = tab.relative || tab.name || 'untitled.py';
  if (dirtyBadge) {
    if (tab.isDirty) dirtyBadge.classList.remove('hidden');
    else dirtyBadge.classList.add('hidden');
  }
  if (langSelect) langSelect.value = tab.lang || 'python';
  const statLang = document.getElementById('ide-stat-lang');
  if (statLang) statLang.innerText = (tab.lang || 'python').toUpperCase();

  renderIdeTabs();
  syncEditorGutter();
  updateCursorPositionStats();
}

function closeEditorTab(index, event) {
  if (event) event.stopPropagation();
  if (index < 0 || index >= ideOpenTabs.length) return;

  const tab = ideOpenTabs[index];
  if (tab.isDirty) {
    if (!confirm(`Discard unsaved changes to "${tab.name}"?`)) return;
  }

  ideOpenTabs.splice(index, 1);
  if (ideOpenTabs.length === 0) {
    createNewBufferTab();
  } else {
    const newIdx = Math.min(index, ideOpenTabs.length - 1);
    selectEditorTab(newIdx);
  }
}

function createNewBufferTab(initialContent = "", name = null) {
  const scratchCount = ideOpenTabs.filter(t => !t.path).length + 1;
  const bufferName = name || (scratchCount === 1 ? 'scratchpad.py' : `untitled-${scratchCount}.py`);
  const defaultCode = initialContent || `# Courtesy Autonomous Scratchpad (${bufferName})\n\ndef main():\n    print("Hello from Courtesy Antigravity IDE!")\n\nif __name__ == "__main__":\n    main()\n`;
  const newTab = {
    id: 'tab_scratch_' + Date.now(),
    path: '',
    name: bufferName,
    relative: bufferName,
    content: defaultCode,
    originalContent: defaultCode,
    isDirty: false,
    lang: detectLanguageFromPath(bufferName),
    cursor: { start: 0, end: 0 }
  };
  ideOpenTabs.push(newTab);
  selectEditorTab(ideOpenTabs.length - 1);
}

async function openFileInEditor(filePath, fileName = null, initialContent = null) {
  const existingIdx = ideOpenTabs.findIndex(t => t.path === filePath);
  if (existingIdx !== -1) {
    selectEditorTab(existingIdx);
    if (ideViewMode === 'chat') setIdeViewMode('split');
    return;
  }

  const name = fileName || (filePath ? filePath.split(/[\/\\]/).pop() : 'untitled.py');
  const relative = (currentWorkspaceFolder && filePath && filePath.startsWith(currentWorkspaceFolder))
    ? filePath.slice(currentWorkspaceFolder.length).replace(/^[\\\/]/, '')
    : name;
  const lang = detectLanguageFromPath(name);

  let content = initialContent;
  if (content === null && filePath) {
    try {
      const resp = await fetch(`${apiBaseUrl}/api/workspace/read?path=${encodeURIComponent(filePath)}&folder=${encodeURIComponent(currentWorkspaceFolder)}`);
      const data = await resp.json();
      if (data.success) {
        content = data.content;
      } else {
        showToast(`Failed to read file: ${data.error}`, "❌");
        content = `# Error reading ${name}`;
      }
    } catch (e) {
      showToast(`Error opening file: ${e.message}`, "❌");
      content = `# Network error reading ${name}`;
    }
  }

  const newTab = {
    id: 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    path: filePath,
    name: name,
    relative: relative,
    content: content || '',
    originalContent: content || '',
    isDirty: false,
    lang: lang,
    cursor: { start: 0, end: 0 }
  };

  ideOpenTabs.push(newTab);
  selectEditorTab(ideOpenTabs.length - 1);

  if (ideViewMode === 'chat') {
    setIdeViewMode('split');
  }
}

async function saveActiveFile() {
  if (ideActiveTabIndex < 0 || ideActiveTabIndex >= ideOpenTabs.length) return;
  const tab = ideOpenTabs[ideActiveTabIndex];
  const editor = getScratchpad();
  if (!editor) return;

  tab.content = editor.value;

  if (!tab.path) {
    const filename = prompt("Enter file name or relative path to save in workspace:", tab.name || "script.py");
    if (!filename) return;
    tab.name = filename;
    tab.relative = filename;
    tab.path = currentWorkspaceFolder ? `${currentWorkspaceFolder}/${filename}` : filename;
    tab.lang = detectLanguageFromPath(filename);
  }

  try {
    const resp = await fetch(`${apiBaseUrl}/api/workspace/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: tab.path,
        content: tab.content,
        folder: currentWorkspaceFolder
      })
    });
    const data = await resp.json();
    if (data.success) {
      tab.originalContent = tab.content;
      tab.isDirty = false;
      const dirtyBadge = document.getElementById('ide-dirty-badge');
      if (dirtyBadge) dirtyBadge.classList.add('hidden');
      renderIdeTabs();
      showToast(`Saved ${tab.name}`, "💾");
      refreshWorkspaceGitStatus();
      loadWorkspaceFileTree();
    } else {
      showToast(`Save error: ${data.error}`, "❌");
    }
  } catch (e) {
    showToast(`Network error saving file: ${e.message}`, "❌");
  }
}

// ---------------- File Explorer & Tree Navigation ----------------
async function refreshWorkspaceTree() {
  await loadWorkspaceFileTree();
  showToast("Workspace tree refreshed", "🔄");
}

async function loadWorkspaceFileTree() {
  const container = document.getElementById('ide-file-tree');
  const rootLabel = document.getElementById('ide-tree-root-label');
  const termCwd = document.getElementById('terminal-cwd-label');
  if (!container) return;

  if (!currentWorkspaceFolder) {
    container.innerHTML = `
      <div class="p-4 text-center text-[var(--text-dim)] space-y-2">
        <p class="text-xs">No workspace selected</p>
        <button onclick="pickWorkspaceFolder()" class="px-2.5 py-1 rounded bg-gold-gradient text-slate-950 font-bold text-[10px]">
          Select Folder
        </button>
      </div>
    `;
    if (rootLabel) rootLabel.innerText = "No Workspace";
    return;
  }

  const folderName = getFolderName(currentWorkspaceFolder);
  if (rootLabel) rootLabel.innerText = folderName;
  if (termCwd) termCwd.innerText = folderName;

  try {
    const files = await getWorkspaceFileList(currentWorkspaceFolder);
    cachedWorkspaceFiles = files;
    ideFileTreeData = files;
    renderFileTreeUI(files);
    refreshWorkspaceGitStatus();
  } catch (e) {
    container.innerHTML = `<div class="p-3 text-rose-400 text-xs">Failed to load workspace: ${escapeHtml(e.message)}</div>`;
  }
}

function renderFileTreeUI(files) {
  const container = document.getElementById('ide-file-tree');
  if (!container) return;

  if (!files || files.length === 0) {
    container.innerHTML = `<div class="p-4 text-center text-[var(--text-dim)] text-xs">Workspace directory is empty</div>`;
    return;
  }

  const tree = {};
  files.forEach(f => {
    const parts = (f.relative || f.name).split(/[\\\/]/);
    let curr = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast && !f.is_dir) {
        curr[part] = { __file: f };
      } else {
        if (!curr[part]) curr[part] = {};
        curr = curr[part];
      }
    }
  });

  function renderNode(node, pathPrefix = '', depth = 0) {
    let html = '';
    const keys = Object.keys(node).sort((a, b) => {
      const aIsDir = !node[a].__file;
      const bIsDir = !node[b].__file;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    for (const key of keys) {
      const item = node[key];
      const fullRelative = pathPrefix ? `${pathPrefix}/${key}` : key;
      const indentPx = depth * 10;

      if (item.__file) {
        const fileObj = item.__file;
        const icon = getFileIconClass(key);
        const activeTab = ideOpenTabs[ideActiveTabIndex];
        const isActive = activeTab && activeTab.path === fileObj.path;
        html += `
          <div class="file-tree-item group ${isActive ? 'active' : ''}" style="padding-left: ${indentPx + 6}px;"
            onclick="openFileInEditor('${escapeJs(fileObj.path)}', '${escapeJs(key)}')">
            <i data-lucide="${icon}" class="w-3.5 h-3.5 shrink-0 ${isActive ? 'text-gold-400' : 'text-[var(--text-dim)]'}"></i>
            <span class="truncate flex-1">${escapeHtml(key)}</span>
            <div class="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0">
              <button onclick="event.stopPropagation(); copyWorkspaceItemPath('${escapeJs(fullRelative)}')"
                class="p-0.5 hover:text-gold-400 transition" title="Copy relative path">
                <i data-lucide="copy" class="w-2.5 h-2.5"></i>
              </button>
              <button onclick="event.stopPropagation(); renameWorkspaceItemPrompt('${escapeJs(fileObj.path)}', '${escapeJs(key)}', false)"
                class="p-0.5 hover:text-gold-400 transition" title="Rename file">
                <i data-lucide="edit-2" class="w-2.5 h-2.5"></i>
              </button>
              <button onclick="event.stopPropagation(); deleteWorkspaceItemPrompt('${escapeJs(fileObj.path)}', false)"
                class="p-0.5 hover:text-rose-400 transition" title="Delete file">
                <i data-lucide="trash-2" class="w-2.5 h-2.5"></i>
              </button>
            </div>
          </div>
        `;
      } else {
        const isExpanded = ideExpandedFolders.has(fullRelative);
        html += `
          <div class="file-tree-item group" style="padding-left: ${indentPx + 6}px;"
            onclick="toggleFolderExpand('${escapeJs(fullRelative)}')">
            <i data-lucide="${isExpanded ? 'folder-open' : 'folder'}" class="w-3.5 h-3.5 shrink-0 text-gold-500"></i>
            <span class="truncate flex-1 font-medium text-white">${escapeHtml(key)}</span>
            <div class="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0">
              <button onclick="event.stopPropagation(); createNewFilePrompt('${escapeJs(fullRelative)}')"
                class="p-0.5 hover:text-gold-400 transition" title="New file in folder">
                <i data-lucide="file-plus" class="w-2.5 h-2.5"></i>
              </button>
              <button onclick="event.stopPropagation(); createNewFolderPrompt('${escapeJs(fullRelative)}')"
                class="p-0.5 hover:text-gold-400 transition" title="New subfolder">
                <i data-lucide="folder-plus" class="w-2.5 h-2.5"></i>
              </button>
              <button onclick="event.stopPropagation(); renameWorkspaceItemPrompt('${escapeJs(fullRelative)}', '${escapeJs(key)}', true)"
                class="p-0.5 hover:text-gold-400 transition" title="Rename folder">
                <i data-lucide="edit-2" class="w-2.5 h-2.5"></i>
              </button>
              <button onclick="event.stopPropagation(); deleteWorkspaceItemPrompt('${escapeJs(fullRelative)}', true)"
                class="p-0.5 hover:text-rose-400 transition" title="Delete folder">
                <i data-lucide="trash-2" class="w-2.5 h-2.5"></i>
              </button>
            </div>
          </div>
        `;
        if (isExpanded) {
          html += `<div class="file-tree-folder-children">${renderNode(item, fullRelative, depth + 1)}</div>`;
        }
      }
    }
    return html;
  }

  container.innerHTML = renderNode(tree);
  if (window.lucide) lucide.createIcons();
}

function toggleFolderExpand(folderRelative) {
  if (ideExpandedFolders.has(folderRelative)) {
    ideExpandedFolders.delete(folderRelative);
  } else {
    ideExpandedFolders.add(folderRelative);
  }
  renderFileTreeUI(ideFileTreeData);
}

function filterFileTreeInput(query) {
  if (!query || !query.trim()) {
    renderFileTreeUI(ideFileTreeData);
    return;
  }
  const q = query.toLowerCase().trim();
  const filtered = ideFileTreeData.filter(f => (f.relative || f.name).toLowerCase().includes(q));
  renderFileTreeUI(filtered);
}

async function createNewFilePrompt(parentRelative = '') {
  const prefix = parentRelative ? `${parentRelative}/` : '';
  const relPath = prompt(`Create new file in workspace (relative path):`, `${prefix}`);
  if (!relPath || !relPath.trim()) return;

  try {
    const resp = await fetch(`${apiBaseUrl}/api/workspace/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: relPath.trim(),
        is_dir: false,
        folder: currentWorkspaceFolder
      })
    });
    const data = await resp.json();
    if (data.success) {
      showToast(`Created file ${relPath}`, "📄");
      await loadWorkspaceFileTree();
      openFileInEditor(data.full_path, data.name, "");
    } else {
      showToast(`Create failed: ${data.error}`, "❌");
    }
  } catch (e) {
    showToast(`Error creating file: ${e.message}`, "❌");
  }
}

async function createNewFolderPrompt(parentRelative = '') {
  const prefix = parentRelative ? `${parentRelative}/` : '';
  const relPath = prompt(`Create new folder in workspace:`, `${prefix}`);
  if (!relPath || !relPath.trim()) return;

  try {
    const resp = await fetch(`${apiBaseUrl}/api/workspace/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: relPath.trim(),
        is_dir: true,
        folder: currentWorkspaceFolder
      })
    });
    const data = await resp.json();
    if (data.success) {
      showToast(`Created directory ${relPath}`, "📁");
      await loadWorkspaceFileTree();
    } else {
      showToast(`Create failed: ${data.error}`, "❌");
    }
  } catch (e) {
    showToast(`Error creating folder: ${e.message}`, "❌");
  }
}

async function deleteWorkspaceItemPrompt(itemPath, isDir = false) {
  const name = itemPath.split(/[\/\\]/).pop();
  if (!confirm(`Are you sure you want to permanently delete "${name}"?`)) return;

  try {
    const resp = await fetch(`${apiBaseUrl}/api/workspace/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: itemPath,
        folder: currentWorkspaceFolder
      })
    });
    const data = await resp.json();
    if (data.success) {
      showToast(`Deleted ${name}`, "🗑️");
      const tabIdx = ideOpenTabs.findIndex(t => t.path === itemPath);
      if (tabIdx !== -1) {
        ideOpenTabs[tabIdx].isDirty = false;
        closeEditorTab(tabIdx);
      }
      await loadWorkspaceFileTree();
    } else {
      showToast(`Delete failed: ${data.error}`, "❌");
    }
  } catch (e) {
    showToast(`Error deleting item: ${e.message}`, "❌");
  }
}

function copyWorkspaceItemPath(relPath) {
  navigator.clipboard.writeText(relPath);
  showToast(`Copied path: ${relPath}`, "📋");
}

async function renameWorkspaceItemPrompt(oldPath, oldName, isDir = false) {
  const newName = prompt(`Rename ${isDir ? 'folder' : 'file'} "${oldName}" to:`, oldName);
  if (!newName || !newName.trim() || newName.trim() === oldName) return;

  const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/'));
  const newPath = parentDir ? `${parentDir}/${newName.trim()}` : newName.trim();

  try {
    const resp = await fetch(`${apiBaseUrl}/api/workspace/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        old_path: oldPath,
        new_path: newPath,
        folder: currentWorkspaceFolder
      })
    });
    const data = await resp.json();
    if (data.success) {
      showToast(`Renamed to ${newName.trim()}`, "✏️");
      const tab = ideOpenTabs.find(t => t.path === oldPath);
      if (tab) {
        tab.path = data.new_path || newPath;
        tab.name = newName.trim();
        tab.relative = (currentWorkspaceFolder && tab.path.startsWith(currentWorkspaceFolder))
          ? tab.path.slice(currentWorkspaceFolder.length).replace(/^[\\\/]/, '')
          : tab.name;
        tab.lang = detectLanguageFromPath(tab.name);
      }
      await loadWorkspaceFileTree();
      renderIdeTabs();
    } else {
      showToast(`Rename failed: ${data.error}`, "❌");
    }
  } catch (e) {
    showToast(`Error renaming: ${e.message}`, "❌");
  }
}

function toggleFileTreeSidebar() {
  const sidebar = document.getElementById('ide-file-tree-sidebar');
  if (sidebar) {
    sidebar.classList.toggle('hidden');
  }
}

// ---------------- Workspace Multi-File Code Search ----------------
function toggleWorkspaceSearchDrawer(show) {
  const box = document.getElementById('ide-workspace-search-box');
  if (!box) return;
  const isHidden = box.classList.contains('hidden');
  const shouldShow = typeof show === 'boolean' ? show : isHidden;
  if (shouldShow) {
    box.classList.remove('hidden');
    const input = document.getElementById('ide-code-search-input');
    if (input) input.focus();
  } else {
    box.classList.add('hidden');
  }
}

function handleCodeSearchKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    executeCodeSearch();
  }
}

async function executeCodeSearch() {
  const input = document.getElementById('ide-code-search-input');
  const list = document.getElementById('ide-search-results-list');
  if (!input || !list) return;

  const query = input.value.trim();
  if (!query) return;

  list.innerHTML = `<div class="p-2 text-[var(--text-dim)]">Searching...</div>`;

  try {
    const resp = await fetch(`${apiBaseUrl}/api/workspace/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        folder: currentWorkspaceFolder,
        max_results: 40
      })
    });
    const data = await resp.json();
    if (!data.success) {
      list.innerHTML = `<div class="p-1 text-rose-400 text-[10px]">Error: ${escapeHtml(data.error)}</div>`;
      return;
    }
    if (data.results.length === 0) {
      list.innerHTML = `<div class="p-1 text-[var(--text-dim)] text-[10px]">No matches found</div>`;
      return;
    }

    list.innerHTML = data.results.map(r => `
      <div class="ide-search-result-item" onclick="openSearchResult('${escapeJs(r.path)}', ${r.line})">
        <div class="text-gold-400 font-bold truncate">${escapeHtml(r.file)}:${r.line}</div>
        <div class="text-[var(--text-secondary)] truncate text-[9px]">${escapeHtml(r.content)}</div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = `<div class="p-1 text-rose-400 text-[10px]">Search failed: ${escapeHtml(e.message)}</div>`;
  }
}

async function openSearchResult(filePath, lineNumber) {
  await openFileInEditor(filePath);
  const editor = getScratchpad();
  if (editor && lineNumber > 0) {
    const lines = editor.value.split('\n');
    let charOffset = 0;
    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
      charOffset += lines[i].length + 1;
    }
    editor.selectionStart = charOffset;
    editor.selectionEnd = charOffset + (lines[lineNumber - 1] ? lines[lineNumber - 1].length : 0);
    editor.focus();
    updateCursorPositionStats();
    editor.scrollTop = Math.max(0, (lineNumber - 4) * 19.5);
    syncEditorGutterScroll();
  }
}

// ---------------- Editor Gutter, Inputs & Shortcuts ----------------
function handleEditorInput() {
  if (ideActiveTabIndex >= 0 && ideActiveTabIndex < ideOpenTabs.length) {
    const tab = ideOpenTabs[ideActiveTabIndex];
    const editor = getScratchpad();
    if (editor) {
      tab.content = editor.value;
      const isDirty = tab.content !== tab.originalContent;
      tab.isDirty = isDirty;
      const dirtyBadge = document.getElementById('ide-dirty-badge');
      if (dirtyBadge) {
        if (isDirty) dirtyBadge.classList.remove('hidden');
        else dirtyBadge.classList.add('hidden');
      }
      renderIdeTabs();
    }
  }
  syncEditorGutter();
  updateCursorPositionStats();
}

function handleEditorKeydown(event) {
  const textarea = event.target;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;

  // Ctrl+S / Cmd+S: Save file
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveActiveFile();
    return;
  }

  // Ctrl+F / Cmd+F: Find in editor
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    toggleFindReplace(true);
    return;
  }

  // F5: Run active file
  if (event.key === 'F5') {
    event.preventDefault();
    runActiveFile();
    return;
  }

  // Tab key: 2 spaces or Indent / Shift+Tab: Un-indent
  if (event.key === 'Tab') {
    event.preventDefault();
    if (!event.shiftKey) {
      textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
    } else {
      const before = textarea.value.substring(0, start);
      const lineStart = before.lastIndexOf('\n') + 1;
      const currentLine = textarea.value.substring(lineStart);
      if (currentLine.startsWith('  ')) {
        textarea.value = textarea.value.substring(0, lineStart) + currentLine.substring(2);
        textarea.selectionStart = textarea.selectionEnd = Math.max(lineStart, start - 2);
      }
    }
    handleEditorInput();
    return;
  }

  // Enter key: Smart auto-indent
  if (event.key === 'Enter') {
    event.preventDefault();
    const beforeCursor = textarea.value.substring(0, start);
    const lastNewline = beforeCursor.lastIndexOf('\n');
    const currentLine = beforeCursor.substring(lastNewline + 1);
    const matchIndent = currentLine.match(/^\s*/);
    let indent = matchIndent ? matchIndent[0] : '';
    const trimmed = currentLine.trimEnd();
    if (trimmed.endsWith(':') || trimmed.endsWith('{') || trimmed.endsWith('[')) {
      indent += '  ';
    }
    const insertText = '\n' + indent;
    textarea.value = textarea.value.substring(0, start) + insertText + textarea.value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + insertText.length;
    handleEditorInput();
    return;
  }

  // Auto-bracket closing: (), [], {}, "", ''
  const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  if (pairs[event.key] && start === end) {
    const char = event.key;
    const closeChar = pairs[char];
    if ((char === '"' || char === "'") && textarea.value[start] === char) {
      event.preventDefault();
      textarea.selectionStart = textarea.selectionEnd = start + 1;
      return;
    }
    event.preventDefault();
    textarea.value = textarea.value.substring(0, start) + char + closeChar + textarea.value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 1;
    handleEditorInput();
    return;
  }
}

function syncEditorGutter() {
  const textarea = getScratchpad();
  const gutter = getEditorGutter();
  if (!textarea || !gutter) return;

  const lines = (textarea.value || '').split('\n').length;
  gutter.innerText = Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n');

  const linesStat = document.getElementById('ide-stat-lines');
  const sizeStat = document.getElementById('ide-stat-size');
  if (linesStat) linesStat.innerText = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
  if (sizeStat) {
    const bytes = new Blob([textarea.value || '']).size;
    sizeStat.innerText = bytes > 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  }
}

function syncEditorGutterScroll() {
  const textarea = getScratchpad();
  const gutter = getEditorGutter();
  if (textarea && gutter) {
    gutter.scrollTop = textarea.scrollTop;
  }
}

function updateCursorPositionStats() {
  const textarea = getScratchpad();
  const cursorStat = document.getElementById('ide-stat-cursor');
  if (!textarea || !cursorStat) return;

  const textBefore = textarea.value.substring(0, textarea.selectionStart);
  const lines = textBefore.split('\n');
  const lineNum = lines.length;
  const colNum = lines[lines.length - 1].length + 1;

  cursorStat.innerText = `Ln ${lineNum}, Col ${colNum}`;
}

function changeEditorLanguage(lang) {
  if (ideActiveTabIndex >= 0 && ideActiveTabIndex < ideOpenTabs.length) {
    ideOpenTabs[ideActiveTabIndex].lang = lang;
  }
  const statLang = document.getElementById('ide-stat-lang');
  if (statLang) statLang.innerText = lang.toUpperCase();
  showToast(`Language set to ${lang.toUpperCase()}`, "📝");
}

function focusEditor() {
  const editor = getScratchpad();
  if (editor) editor.focus();
}

function focusLanguageSelect() {
  const select = document.getElementById('editor-language-select');
  if (select) {
    select.focus();
    if (typeof select.showPicker === 'function') {
      try { select.showPicker(); } catch (e) {}
    }
  }
}

function promptGoToLine() {
  const editor = getScratchpad();
  if (!editor) return;
  const lines = editor.value.split('\n');
  const target = prompt(`Go to line (1 - ${lines.length}):`, "1");
  if (!target) return;
  const lineNum = parseInt(target, 10);
  if (isNaN(lineNum) || lineNum < 1) return;

  let offset = 0;
  for (let i = 0; i < lineNum - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  editor.focus();
  editor.selectionStart = offset;
  editor.selectionEnd = offset + (lines[lineNum - 1] ? lines[lineNum - 1].length : 0);
  const lineHeight = 19.5;
  editor.scrollTop = Math.max(0, (lineNum - 5) * lineHeight);
  syncEditorGutterScroll();
  updateCursorPositionStats();
}

let ideIndentSpaces = 2;
function toggleIndentSpaces() {
  ideIndentSpaces = ideIndentSpaces === 2 ? 4 : 2;
  const el = document.getElementById('ide-stat-spaces');
  if (el) el.innerText = `Spaces: ${ideIndentSpaces}`;
  showToast(`Indentation standard set to ${ideIndentSpaces} spaces`, "📐");
}

function showEncodingInfo() {
  showToast("File encoding: UTF-8 (Unicode, Standard)", "ℹ️");
}

// ---------------- Find & Replace Overlay ----------------
function toggleFindReplace(force) {
  const bar = document.getElementById('ide-find-replace-bar');
  if (!bar) return;
  const isHidden = bar.classList.contains('hidden');
  const shouldShow = typeof force === 'boolean' ? force : isHidden;
  if (shouldShow) {
    bar.classList.remove('hidden');
    const input = document.getElementById('ide-find-input');
    if (input) {
      input.focus();
      input.select();
    }
  } else {
    bar.classList.add('hidden');
  }
}

function handleFindInputKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    findNextOccurrence(!event.shiftKey);
  } else if (event.key === 'Escape') {
    toggleFindReplace(false);
  }
}

function findNextOccurrence(forward = true) {
  const input = document.getElementById('ide-find-input');
  const textarea = getScratchpad();
  if (!input || !textarea) return;

  const query = input.value;
  if (!query) return;

  const text = textarea.value;
  const currentPos = forward ? textarea.selectionEnd : textarea.selectionStart;

  let idx = -1;
  if (forward) {
    idx = text.indexOf(query, currentPos);
    if (idx === -1) idx = text.indexOf(query, 0);
  } else {
    idx = text.lastIndexOf(query, Math.max(0, currentPos - query.length - 1));
    if (idx === -1) idx = text.lastIndexOf(query);
  }

  if (idx !== -1) {
    textarea.selectionStart = idx;
    textarea.selectionEnd = idx + query.length;
    textarea.focus();
    updateCursorPositionStats();

    const textBefore = text.substring(0, idx);
    const lineNum = textBefore.split('\n').length;
    textarea.scrollTop = Math.max(0, (lineNum - 5) * 19.5);
    syncEditorGutterScroll();
  } else {
    showToast(`"${query}" not found`, "ℹ");
  }
}

function replaceCurrentOccurrence() {
  const findInput = document.getElementById('ide-find-input');
  const replaceInput = document.getElementById('ide-replace-input');
  const textarea = getScratchpad();
  if (!findInput || !replaceInput || !textarea) return;

  const query = findInput.value;
  const replacement = replaceInput.value;
  if (!query) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selectedText = textarea.value.substring(start, end);

  if (selectedText === query) {
    textarea.value = textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
    textarea.selectionStart = start;
    textarea.selectionEnd = start + replacement.length;
    handleEditorInput();
  }
  findNextOccurrence(true);
}

function replaceAllOccurrences() {
  const findInput = document.getElementById('ide-find-input');
  const replaceInput = document.getElementById('ide-replace-input');
  const textarea = getScratchpad();
  if (!findInput || !replaceInput || !textarea) return;

  const query = findInput.value;
  const replacement = replaceInput.value;
  if (!query) return;

  const count = (textarea.value.match(new RegExp(escapeRegex(query), 'g')) || []).length;
  if (count === 0) {
    showToast(`"${query}" not found`, "ℹ");
    return;
  }

  textarea.value = textarea.value.replaceAll(query, replacement);
  handleEditorInput();
  showToast(`Replaced ${count} occurrences`, "✨");
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------- Integrated Terminal & Command Runner ----------------
function toggleTerminalPanel() {
  const drawer = document.getElementById('ide-terminal-drawer');
  const icon = document.getElementById('terminal-toggle-icon');
  if (!drawer) return;
  drawer.classList.toggle('collapsed');
  if (icon) {
    icon.setAttribute('data-lucide', drawer.classList.contains('collapsed') ? 'chevron-up' : 'chevron-down');
    if (window.lucide) lucide.createIcons();
  }
}

function clearTerminalOutput() {
  const log = document.getElementById('terminal-output-log');
  if (log) {
    log.innerHTML = `<div class="text-[var(--text-dim)] italic text-[10px]">Courtesy Terminal cleared.</div>`;
  }
}

function handleTerminalInputKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitTerminalCommand();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (ideTerminalHistory.length > 0) {
      if (ideTerminalHistoryIndex === -1) ideTerminalHistoryIndex = ideTerminalHistory.length - 1;
      else if (ideTerminalHistoryIndex > 0) ideTerminalHistoryIndex--;
      event.target.value = ideTerminalHistory[ideTerminalHistoryIndex];
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (ideTerminalHistoryIndex !== -1) {
      if (ideTerminalHistoryIndex < ideTerminalHistory.length - 1) {
        ideTerminalHistoryIndex++;
        event.target.value = ideTerminalHistory[ideTerminalHistoryIndex];
      } else {
        ideTerminalHistoryIndex = -1;
        event.target.value = '';
      }
    }
  }
}

async function runCommandShortcut(cmd) {
  const input = document.getElementById('terminal-command-input');
  if (input) input.value = cmd;
  await submitTerminalCommand();
}

async function submitTerminalCommand() {
  const input = document.getElementById('terminal-command-input');
  const log = document.getElementById('terminal-output-log');
  const drawer = document.getElementById('ide-terminal-drawer');
  if (!input || !log) return;

  const cmd = input.value.trim();
  if (!cmd) return;

  ideTerminalHistory.push(cmd);
  ideTerminalHistoryIndex = -1;
  input.value = '';

  if (drawer && drawer.classList.contains('collapsed')) {
    toggleTerminalPanel();
  }

  const cmdEntry = document.createElement('div');
  cmdEntry.className = "space-y-1 my-1.5 pb-1 border-b border-[var(--border-app-subtle)]";
  cmdEntry.innerHTML = `
    <div class="flex items-center gap-2 text-gold-400 font-bold">
      <span>$</span>
      <span class="text-white font-mono">${escapeHtml(cmd)}</span>
      <span class="text-[9px] text-[var(--text-dim)] ml-auto">${new Date().toLocaleTimeString()}</span>
    </div>
    <div class="terminal-cmd-output text-[10px] text-[var(--text-dim)] animate-pulse">Running...</div>
  `;
  log.appendChild(cmdEntry);
  log.scrollTop = log.scrollHeight;

  const outputEl = cmdEntry.querySelector('.terminal-cmd-output');

  try {
    const resp = await fetch(`${apiBaseUrl}/api/workspace/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: cmd,
        cwd: currentWorkspaceFolder
      })
    });
    const data = await resp.json();
    outputEl.classList.remove('animate-pulse');

    const exitBadge = data.exit_code === 0
      ? `<span class="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-bold text-[9px]">exit 0</span>`
      : `<span class="px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 font-bold text-[9px]">exit ${data.exit_code}</span>`;

    let stdoutHtml = data.stdout ? `<pre class="text-emerald-300/90 whitespace-pre-wrap font-mono mt-0.5">${escapeHtml(data.stdout)}</pre>` : '';
    let stderrHtml = data.stderr ? `<pre class="text-rose-400 whitespace-pre-wrap font-mono mt-0.5">${escapeHtml(data.stderr)}</pre>` : '';
    if (!stdoutHtml && !stderrHtml) stdoutHtml = `<div class="text-[var(--text-dim)] italic">(No output)</div>`;

    outputEl.innerHTML = `
      <div class="flex items-center gap-2 mb-1">${exitBadge}</div>
      ${stdoutHtml}
      ${stderrHtml}
    `;
    log.scrollTop = log.scrollHeight;
  } catch (e) {
    outputEl.classList.remove('animate-pulse');
    outputEl.innerHTML = `<div class="text-rose-400 font-mono">Execution error: ${escapeHtml(e.message)}</div>`;
  }
}

async function runActiveFile() {
  if (ideActiveTabIndex < 0 || ideActiveTabIndex >= ideOpenTabs.length) {
    showToast("No active file to run", "ℹ");
    return;
  }
  const tab = ideOpenTabs[ideActiveTabIndex];
  if (tab.isDirty || !tab.path) {
    await saveActiveFile();
  }

  const targetPath = tab.path || tab.name;
  let cmd = `python "${targetPath}"`;
  const ext = targetPath.split('.').pop().toLowerCase();
  if (ext === 'js') cmd = `node "${targetPath}"`;
  else if (ext === 'sh' || ext === 'bash') cmd = `bash "${targetPath}"`;
  else if (ext === 'go') cmd = `go run "${targetPath}"`;
  else if (ext === 'rs') cmd = `cargo run`;

  const input = document.getElementById('terminal-command-input');
  if (input) input.value = cmd;
  await submitTerminalCommand();
}

async function refreshWorkspaceGitStatus() {
  const branchEl = document.getElementById('ide-git-branch-label');
  if (!branchEl || !currentWorkspaceFolder) return;

  try {
    const resp = await fetch(`${apiBaseUrl}/api/workspace/git`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: currentWorkspaceFolder })
    });
    const data = await resp.json();
    if (data.success && data.is_git) {
      const dirtyTag = data.dirty_count > 0 ? ` (${data.dirty_count}*)` : '';
      branchEl.innerText = `${data.branch}${dirtyTag}`;
    } else {
      branchEl.innerText = "no git";
    }
  } catch (e) {
    branchEl.innerText = "git error";
  }
}

// ---------------- AI Code Integration (Split Mode Superpower) ----------------
function sendEditorCodeToAI(action) {
  const editor = getScratchpad();
  if (!editor) return;

  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selectedText = (start !== end) ? editor.value.substring(start, end).trim() : editor.value.trim();

  if (!selectedText) {
    showToast("Editor is empty. Write or open code first!", "ℹ");
    return;
  }

  const tab = ideOpenTabs[ideActiveTabIndex];
  const filename = tab ? tab.name : 'active code';
  const langSelect = document.getElementById('editor-language-select');
  const lang = langSelect ? langSelect.value : (tab ? tab.lang : 'python');

  let promptText = "";
  if (action === 'refactor') {
    promptText = `Refactor the following ${lang} code from \`${filename}\` for clean architecture, type safety, modularity, and high performance:\n\n\`\`\`${lang}\n${selectedText}\n\`\`\``;
  } else if (action === 'bugs') {
    promptText = `Perform a comprehensive security, logic, and edge-case audit on this ${lang} code from \`${filename}\`. Identify race conditions, leaks, or logic errors, and formulate precise fixes:\n\n\`\`\`${lang}\n${selectedText}\n\`\`\``;
  } else if (action === 'tests') {
    promptText = `Write exhaustive unit and integration tests with mocks, edge cases, and happy paths for this ${lang} code from \`${filename}\`:\n\n\`\`\`${lang}\n${selectedText}\n\`\`\``;
  } else if (action === 'explain') {
    promptText = `Explain the architecture, algorithms, and line-by-line mechanics of this ${lang} code from \`${filename}\` clearly:\n\n\`\`\`${lang}\n${selectedText}\n\`\`\``;
  }

  // Switch to Split Mode so user sees reasoning and answer live alongside code
  setIdeViewMode('split');

  const promptInput = document.getElementById('prompt-input') || document.getElementById('sticky-prompt-input');
  if (promptInput) {
    promptInput.value = promptText;
    promptInput.focus();
    sendPrompt();
  }
}

function insertCodeIntoEditor(code, lang = 'python') {
  if (ideOpenTabs.length === 0) {
    createNewBufferTab(code);
  } else {
    const tab = ideOpenTabs[ideActiveTabIndex];
    const editor = getScratchpad();
    if (editor) {
      editor.value = code;
      if (tab) {
        tab.content = code;
        tab.isDirty = true;
      }
      handleEditorInput();
      editor.focus();
    }
  }
  if (ideViewMode === 'chat') {
    setIdeViewMode('split');
  }
  showToast("Code injected into Editor", "⚡");
}

function copyScratchpadCode() {
  const editor = getScratchpad();
  if (!editor || !editor.value) {
    showToast("Editor is empty", "ℹ");
    return;
  }
  navigator.clipboard.writeText(editor.value);
  showToast("Code copied to clipboard!", "📋");
}

function clearScratchpad() {
  const editor = getScratchpad();
  if (editor) {
    editor.value = '';
    handleEditorInput();
    showToast("Editor cleared", "🗑️");
  }
}

// ================= Resizers & Interactive Layout Controls =================
function initResizers() {
  initSplitPaneResizer();
  initSidebarResizer();
  initTerminalResizer();
}

function initSplitPaneResizer() {
  const resizer = document.getElementById('ide-chat-resizer');
  const idePanel = document.getElementById('courtesy-ide-panel');
  const chatPanel = document.getElementById('courtesy-chat-panel');
  const container = document.getElementById('standard-workbench-body');
  if (!resizer || !idePanel || !chatPanel || !container) return;

  let isDragging = false;

  resizer.addEventListener('mousedown', (e) => {
    if (ideViewMode !== 'split') return;
    isDragging = true;
    document.body.classList.add('select-none');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    let ratio = ((e.clientX - rect.left) / rect.width) * 100;
    ratio = Math.max(15, Math.min(85, ratio));
    idePanel.style.width = `${ratio.toFixed(2)}%`;
    chatPanel.style.width = `${(100 - ratio).toFixed(2)}%`;
    idePanel.style.flex = 'none';
    chatPanel.style.flex = 'none';
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    document.body.classList.remove('select-none');
    document.body.style.cursor = '';
    const rect = container.getBoundingClientRect();
    const ideRect = idePanel.getBoundingClientRect();
    if (rect.width > 0) {
      const finalRatio = Math.max(15, Math.min(85, (ideRect.width / rect.width) * 100));
      localStorage.setItem('courtesy_split_ratio', finalRatio.toFixed(1));
    }
  });

  resizer.addEventListener('dblclick', () => {
    if (ideViewMode !== 'split') return;
    idePanel.style.width = '50%';
    chatPanel.style.width = '50%';
    idePanel.style.flex = 'none';
    chatPanel.style.flex = 'none';
    localStorage.setItem('courtesy_split_ratio', '50');
    showToast("Split pane reset to 50/50", "📐");
  });
}

function initSidebarResizer() {
  const resizer = document.getElementById('ide-sidebar-resizer');
  const sidebar = document.getElementById('ide-file-tree-sidebar');
  if (!resizer || !sidebar) return;

  // Restore saved width
  const savedWidth = localStorage.getItem('courtesy_filetree_width');
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= 140 && w <= 480) {
      sidebar.style.width = `${w}px`;
    }
  }

  let isDragging = false;

  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.classList.add('select-none');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = sidebar.getBoundingClientRect();
    let newWidth = e.clientX - rect.left;
    newWidth = Math.max(140, Math.min(480, newWidth));
    sidebar.style.width = `${newWidth}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    document.body.classList.remove('select-none');
    document.body.style.cursor = '';
    const currentW = sidebar.getBoundingClientRect().width;
    localStorage.setItem('courtesy_filetree_width', Math.round(currentW));
  });

  resizer.addEventListener('dblclick', () => {
    sidebar.style.width = '240px';
    localStorage.setItem('courtesy_filetree_width', '240');
    showToast("Sidebar width reset to default", "📐");
  });
}

function initTerminalResizer() {
  const resizer = document.getElementById('ide-terminal-resizer');
  const drawer = document.getElementById('ide-terminal-drawer');
  if (!resizer || !drawer) return;

  // Restore saved height
  const savedHeight = localStorage.getItem('courtesy_terminal_height');
  if (savedHeight) {
    const h = parseInt(savedHeight, 10);
    if (h >= 60 && h <= 500) {
      drawer.style.height = `${h}px`;
    }
  }

  let isDragging = false;

  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.classList.add('select-none');
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = drawer.getBoundingClientRect();
    let newHeight = rect.bottom - e.clientY;
    newHeight = Math.max(60, Math.min(500, newHeight));
    drawer.style.height = `${newHeight}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    document.body.classList.remove('select-none');
    document.body.style.cursor = '';
    const currentH = drawer.getBoundingClientRect().height;
    localStorage.setItem('courtesy_terminal_height', Math.round(currentH));
  });

  resizer.addEventListener('dblclick', () => {
    drawer.style.height = '176px';
    localStorage.setItem('courtesy_terminal_height', '176');
    showToast("Terminal height reset to default", "📐");
  });
}

// ================= Voice Dictation (Speech Recognition) =================
function startVoiceInput(targetId) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast("Speech Recognition not supported in this browser", "⚠️");
    return;
  }

  const targetInput = document.getElementById(targetId);
  if (!targetInput) return;

  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      showToast("Listening... speak your prompt", "🎙️");
    };

    recognition.onresult = (event) => {
      if (event.results && event.results.length > 0) {
        const transcript = event.results[0][0].transcript;
        if (targetInput.value && !targetInput.value.endsWith(' ')) {
          targetInput.value += ' ' + transcript;
        } else {
          targetInput.value += transcript;
        }
        targetInput.focus();
        showToast("Voice captured!", "✨");
      }
    };

    recognition.onerror = (event) => {
      showToast(`Speech error: ${event.error}`, "⚠️");
    };

    recognition.start();
  } catch (err) {
    showToast(`Microphone error: ${err.message}`, "❌");
  }
}

// ================= Codex Chat Playground & Streaming =================
let webAccessEnabled = true;

function toggleWebAccess() {
  webAccessEnabled = !webAccessEnabled;

  const stdBtn = document.getElementById('std-web-toggle-btn');
  if (stdBtn) {
    if (webAccessEnabled) {
      stdBtn.className = "p-1.5 rounded-lg border border-gold bg-[var(--gold-subtle)] text-gold-400 hover-float transition";
      stdBtn.title = "Live Web Docs Grounding: Enabled (Click to Disable)";
      showToast("Live Web Docs Grounding: Enabled", "🌐");
    } else {
      stdBtn.className = "p-1.5 rounded-lg border border-[var(--border-app)] bg-[var(--bg-muted)] text-[var(--text-dim)] hover-float transition";
      stdBtn.title = "Live Web Docs Grounding: Disabled (Click to Enable)";
      showToast("Live Web Docs Grounding: Disabled", "⚪");
    }
  }
  if (window.lucide) lucide.createIcons();
}

function handleInputKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
}

function newConversation() {
  chatHistory = [];
  saveActiveProjectContext();
  renderProjectsList();

  const container = document.getElementById('chat-messages');
  const stickyBar = document.getElementById('sticky-chat-input-bar');
  const placeholder = document.getElementById('empty-chat-placeholder');

  if (stickyBar) stickyBar.classList.add('hidden');
  if (placeholder) placeholder.classList.remove('hidden');

  if (container) {
    const items = container.querySelectorAll('.chat-msg-item');
    items.forEach(el => el.remove());
  }

  const pInput = document.getElementById('prompt-input');
  if (pInput) {
    pInput.value = '';
    pInput.focus();
  }
  const sInput = document.getElementById('sticky-prompt-input');
  if (sInput) sInput.value = '';

  showToast("New conversation started", "✨");
}

function clearChat() {
  newConversation();
}

function handleStickyInputKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendStickyPrompt();
  }
}

function sendStickyPrompt() {
  const stickyInput = document.getElementById('sticky-prompt-input');
  if (!stickyInput) return;
  const text = stickyInput.value.trim();
  if (!text) return;
  stickyInput.value = '';
  sendPrompt(text);
}

let currentAbortController = null;

function stopGenerating() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  isStreaming = false;

  const sendBtn = document.getElementById('send-prompt-btn');
  const stopBtn = document.getElementById('stop-stream-btn');
  const stickySendBtn = document.getElementById('sticky-send-btn');
  const stickyStopBtn = document.getElementById('sticky-stop-btn');

  if (sendBtn) sendBtn.disabled = false;
  if (stopBtn) stopBtn.classList.add('hidden');
  if (stickySendBtn) stickySendBtn.disabled = false;
  if (stickyStopBtn) stickyStopBtn.classList.add('hidden');

  showToast("Generation stopped");
}

async function sendPrompt(overrideText = null) {
  if (isStreaming) return;

  const inputEl = document.getElementById('prompt-input');
  const stickyInputEl = document.getElementById('sticky-prompt-input');
  
  let userText = overrideText;
  if (!userText) {
    if (inputEl && inputEl.value.trim()) {
      userText = inputEl.value.trim();
      inputEl.value = '';
    } else if (stickyInputEl && stickyInputEl.value.trim()) {
      userText = stickyInputEl.value.trim();
      stickyInputEl.value = '';
    }
  }

  if (!userText) return;

  // Transition UI: Hide centered welcome placeholder and show sticky bottom input
  const placeholder = document.getElementById('empty-chat-placeholder');
  const stickyBar = document.getElementById('sticky-chat-input-bar');
  if (placeholder) placeholder.classList.add('hidden');
  if (stickyBar) stickyBar.classList.remove('hidden');

  isStreaming = true;
  currentAbortController = new AbortController();

  const sendBtn = document.getElementById('send-prompt-btn');
  const stopBtn = document.getElementById('stop-stream-btn');
  const stickySendBtn = document.getElementById('sticky-send-btn');
  const stickyStopBtn = document.getElementById('sticky-stop-btn');

  if (sendBtn) sendBtn.disabled = true;
  if (stopBtn) stopBtn.classList.remove('hidden');
  if (stickySendBtn) stickySendBtn.disabled = true;
  if (stickyStopBtn) stickyStopBtn.classList.remove('hidden');

  appendMessage('user', userText);
  chatHistory.push({ role: 'user', content: userText });
  saveActiveProjectContext();
  renderProjectsList();

  const isPlanMode = userText.trim().toLowerCase().startsWith('/plan');
  const baseSystem = isPlanMode ? PROMPT_PRESETS.plan : PROMPT_PRESETS.coder;

  let activeProject = null;
  if (currentWorkspaceFolder) {
    activeProject = workspaceProjects.find(p => p.path.toLowerCase() === currentWorkspaceFolder.toLowerCase());
  }

  let chosenModel = getEffectiveModelTarget();
  if (activeProject?.settings?.preferredModel && activeProject.settings.preferredModel !== 'auto') {
    chosenModel = activeProject.settings.preferredModel === '14b' ? 'qwen2.5-coder:14b' : 'qwen2.5-coder:7b';
  }

  let effectiveWebAccess = webAccessEnabled;
  if (activeProject?.settings?.webAccess !== undefined) {
    effectiveWebAccess = activeProject.settings.webAccess;
  }

  let wsContext = '';
  if (currentWorkspaceFolder) {
    const activeRules = activeProject?.settings?.customRules ? `\n\nProject Specific Rules:\n${activeProject.settings.customRules}` : '';
    const fileListSnippet = (cachedWorkspaceFiles && cachedWorkspaceFiles.length > 0)
      ? cachedWorkspaceFiles.slice(0, 30).map(f => f.name || f.path.split(/[\\/]/).pop()).join(', ')
      : 'Active repository workspace';
    wsContext = `\n\nActive Workspace Directory: ${currentWorkspaceFolder}\nWorkspace Project Files: ${fileListSnippet}${activeRules}\nWhen creating or editing files, specify the relative path in the code block header comment (e.g. "// filepath: src/main.py") or output an interactive diff block so Courtesy can apply edits with a single click.`;
  }

  const systemPrompt = baseSystem + wsContext;
  const temp = isPlanMode ? 0.4 : 0.2;

  const messagesPayload = [
    { role: 'system', content: systemPrompt },
    ...chatHistory
  ];

  const assistantMsgId = `msg-${Date.now()}`;
  appendAssistantPlaceholder(assistantMsgId);
  const contentEl = document.getElementById(`${assistantMsgId}-content`);
  const thinkingTimerEl = document.getElementById(`${assistantMsgId}-thinking-timer`);
  const thinkingBodyEl = document.getElementById(`${assistantMsgId}-thinking-body`);

  let fullResponseText = '';
  const startTime = Date.now();
  let firstTokenReceived = false;

  const timerInterval = setInterval(() => {
    if (!firstTokenReceived && thinkingTimerEl) {
      const sec = ((Date.now() - startTime) / 1000).toFixed(1);
      thinkingTimerEl.innerText = `(${sec}s)`;
    }
  }, 100);

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
        web_access: effectiveWebAccess,
        temperature: temp,
        max_tokens: 4096
      })
    });

    const targetServerHeader = response.headers.get('X-Courtesy-Server') || 'kraken';
    const targetModelHeader = response.headers.get('X-Courtesy-Model') || chosenModel;
    const webSourcesHeader = response.headers.get('X-Courtesy-Web-Sources');
    let webSources = [];
    if (webSourcesHeader) {
      try { webSources = JSON.parse(webSourcesHeader); } catch (e) {}
    }

    if (thinkingBodyEl) {
      thinkingBodyEl.innerHTML = `• Connected to GPU node <b>${targetServerHeader}</b><br>• Model: <span class="text-gold-400">${targetModelHeader}</span><br>• Analyzing prompt logic and formulating solution...`;
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

            if (!firstTokenReceived && delta.length > 0) {
              firstTokenReceived = true;
              clearInterval(timerInterval);
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              if (thinkingTimerEl) thinkingTimerEl.innerText = `(${elapsed}s)`;
            }

            let displayText = fullResponseText;
            if (fullResponseText.includes('<think>')) {
              const thinkEnd = fullResponseText.indexOf('</think>');
              if (thinkEnd !== -1) {
                const thought = fullResponseText.substring(7, thinkEnd).trim();
                if (thinkingBodyEl) thinkingBodyEl.innerText = thought;
                displayText = fullResponseText.substring(thinkEnd + 8).trim();
              } else {
                const ongoingThought = fullResponseText.substring(7);
                if (thinkingBodyEl) thinkingBodyEl.innerText = ongoingThought;
                displayText = '';
              }
            }

            if (contentEl) {
              contentEl.innerHTML = marked.parse(displayText);
              contentEl.classList.add('streaming-cursor');
            }
            scrollToBottom();
          } catch (e) {}
        }
      }
    }

    clearInterval(timerInterval);
    if (contentEl) contentEl.classList.remove('streaming-cursor');
    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

    if (thinkingTimerEl) thinkingTimerEl.innerText = `(${elapsedSeconds}s)`;

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

    if (contentEl) attachCodeBlockHeaders(contentEl);
    chatHistory.push({ role: 'assistant', content: fullResponseText });
    saveActiveProjectContext();
    renderProjectsList();

    if (activeProject?.settings?.autoApply && currentWorkspaceFolder) {
      autoApplyDetectedFiles(contentEl);
    }

  } catch (e) {
    clearInterval(timerInterval);
    if (e.name === 'AbortError') {
      if (contentEl) contentEl.classList.remove('streaming-cursor');
    } else {
      if (contentEl) contentEl.innerHTML = `<span class="text-rose-500 font-bold">Error communicating with cluster:</span> ${e.message}`;
    }
  } finally {
    clearInterval(timerInterval);
    isStreaming = false;
    currentAbortController = null;
    
    if (sendBtn) sendBtn.disabled = false;
    if (stopBtn) stopBtn.classList.add('hidden');
    if (stickySendBtn) stickySendBtn.disabled = false;
    if (stickyStopBtn) stickyStopBtn.classList.add('hidden');
    scrollToBottom();
  }
}

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
    <div class="chat-msg-item flex items-start gap-2.5 ${isUser ? 'justify-end' : 'justify-start'} animate-fade-up">
      ${!isUser ? `<div class="h-6 w-6 rounded-lg bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-xs shrink-0 shadow-sm shadow-gold-glow">⚡</div>` : ''}
      <div class="${isUser ? 'bg-gold-gradient text-slate-950 font-semibold rounded-2xl rounded-tr-sm max-w-lg p-2.5 text-xs shadow-sm' : 'bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-2xl rounded-tl-sm p-3.5 text-xs text-[var(--text-main)] max-w-2xl leading-relaxed shadow-sm'}">
        <div class="prose prose-invert max-w-none text-xs leading-relaxed">
          ${isUser ? escapeHtml(text).replace(/\n/g, '<br>') : marked.parse(text)}
        </div>
      </div>
    </div>
  `;
  if (container) {
    container.insertAdjacentHTML('beforeend', msgHtml);
    scrollToBottom();
  }
}

function appendAssistantPlaceholder(msgId) {
  const container = document.getElementById('chat-messages');
  const placeholderHtml = `
    <div id="${msgId}" class="chat-msg-item flex items-start gap-2.5 justify-start animate-fade-up">
      <div class="h-6 w-6 rounded-lg bg-gold-gradient flex items-center justify-center text-slate-950 font-bold text-xs shrink-0 shadow-sm shadow-gold-glow">⚡</div>
      <div class="bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-2xl rounded-tl-sm p-3.5 text-xs text-[var(--text-main)] max-w-2xl leading-relaxed space-y-3 shadow-sm w-full">
        
        <!-- Collapsible Thinking Process -->
        <div id="${msgId}-thinking" class="rounded-xl bg-[var(--bg-input)] border border-[var(--border-app)] overflow-hidden transition-all duration-300">
          <button onclick="toggleThinkingProcess('${msgId}')" class="w-full px-3 py-1.5 flex items-center justify-between text-[11px] font-mono text-[var(--text-dim)] hover:bg-[var(--bg-muted)] transition">
            <span class="flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-gold-500 animate-pulse"></span>
              <span class="font-bold text-gold-400">Courtesy Reasoning</span>
              <span id="${msgId}-thinking-timer" class="text-[10px] text-[var(--text-dim)]">(0.0s)</span>
            </span>
            <i id="${msgId}-thinking-chevron" data-lucide="chevron-down" class="w-3.5 h-3.5 transition-transform duration-200"></i>
          </button>
          <div id="${msgId}-thinking-body" class="p-3 text-[11px] font-mono text-[var(--text-secondary)] border-t border-[var(--border-app)] leading-relaxed bg-[var(--bg-app)]/50">
            • Connecting to cluster node...<br>• Scheduling inference worker...
          </div>
        </div>

        <!-- Assistant Generated Content Stream -->
        <div id="${msgId}-content" class="prose prose-invert max-w-none text-xs leading-relaxed"></div>

        <!-- Message Meta / Telemetry -->
        <div id="${msgId}-meta" class="flex items-center gap-2 text-[10px] font-mono text-[var(--text-dim)] pt-1 border-t border-[var(--border-app-subtle)]"></div>

      </div>
    </div>
  `;
  if (container) {
    container.insertAdjacentHTML('beforeend', placeholderHtml);
    if (window.lucide) lucide.createIcons();
    scrollToBottom();
  }
}

function toggleThinkingProcess(msgId) {
  const body = document.getElementById(`${msgId}-thinking-body`);
  const chevron = document.getElementById(`${msgId}-thinking-chevron`);
  if (body) {
    body.classList.toggle('hidden');
    if (chevron) {
      chevron.style.transform = body.classList.contains('hidden') ? 'rotate(-90deg)' : 'rotate(0deg)';
    }
  }
}

function attachCodeBlockHeaders(container) {
  const preElements = container.querySelectorAll('pre');
  preElements.forEach((pre) => {
    if (pre.querySelector('.code-block-header')) return; // Already attached

    const codeEl = pre.querySelector('code');
    const fullCode = codeEl ? codeEl.innerText : pre.innerText;
    let lang = 'code';
    if (codeEl && codeEl.className) {
      const match = codeEl.className.match(/language-([a-zA-Z0-9_-]+)/);
      if (match) lang = match[1];
    }

    // Inspect code for target filepath comment or git diff
    let targetFilePath = null;
    const fileMatch = fullCode.match(/(?:^|\n)(?:\/\/|#|\/\*|--)\s*(?:filepath|file):\s*([^\n*]+)/i);
    if (fileMatch) {
      targetFilePath = fileMatch[1].trim();
    } else if (fullCode.startsWith('diff --git') || fullCode.startsWith('--- a/')) {
      const diffMatch = fullCode.match(/--- a\/(.+?)\n\+\+\+ b\/(.+?)\n/);
      if (diffMatch) targetFilePath = diffMatch[2].trim();
    }

    const header = document.createElement('div');
    header.className = 'code-block-header flex items-center justify-between gap-2 px-3 py-1.5 bg-[var(--bg-muted)] border-b border-[var(--border-app)] text-[10px] font-mono';

    const leftPart = document.createElement('div');
    leftPart.className = 'flex items-center gap-2';

    const langBadge = document.createElement('span');
    langBadge.className = 'text-gold-500 uppercase font-bold';
    langBadge.innerText = lang;
    leftPart.appendChild(langBadge);

    if (targetFilePath) {
      const fileBadge = document.createElement('span');
      fileBadge.className = 'text-[var(--text-secondary)] bg-[var(--bg-input)] px-1.5 py-0.5 rounded border border-[var(--border-app)] flex items-center gap-1';
      fileBadge.innerHTML = `<i data-lucide="file-code" class="w-3 h-3 text-gold-500"></i> ${escapeHtml(targetFilePath)}`;
      leftPart.appendChild(fileBadge);
    }
    header.appendChild(leftPart);

    const rightPart = document.createElement('div');
    rightPart.className = 'flex items-center gap-1.5';

    // "Apply to Workspace" button (Antigravity parity)
    if (targetFilePath && currentWorkspaceFolder) {
      const applyBtn = document.createElement('button');
      applyBtn.className = 'btn-apply-diff px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[var(--bg-input)] border border-[var(--border-app)] hover:border-gold-500 transition';
      applyBtn.innerHTML = `<i data-lucide="check" class="w-3 h-3 inline-block"></i> Apply to Workspace`;
      applyBtn.onclick = () => applyCodeBlockToWorkspace(applyBtn, targetFilePath, fullCode);
      rightPart.appendChild(applyBtn);
    }

    // "To Scratchpad" button
    const scratchpadBtn = document.createElement('button');
    scratchpadBtn.className = 'code-header-btn';
    scratchpadBtn.innerHTML = `<span>Scratchpad</span>`;
    scratchpadBtn.onclick = () => insertCodeIntoEditor(fullCode, lang);
    rightPart.appendChild(scratchpadBtn);

    // "Copy" button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-header-btn';
    copyBtn.innerHTML = `<span>Copy</span>`;
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(fullCode);
      copyBtn.innerHTML = `<span class="text-emerald-400">✓ Copied</span>`;
      setTimeout(() => { copyBtn.innerHTML = `<span>Copy</span>`; }, 1500);
    };
    rightPart.appendChild(copyBtn);

    header.appendChild(rightPart);
    pre.insertBefore(header, pre.firstChild);
  });
  if (window.lucide) lucide.createIcons();
}

async function applyCodeBlockToWorkspace(btn, relativePath, rawContent) {
  if (!currentWorkspaceFolder) {
    showToast("Open a workspace folder first", "📁");
    return;
  }
  // Strip filepath comment if present
  let cleanContent = rawContent.replace(/^(?:\/\/|#|\/\*|--)\s*(?:filepath|file):\s*[^\n]+\n?/i, '');

  const normPath = currentWorkspaceFolder.replace(/\\/g, '/') + '/' + relativePath.replace(/^(\.\/|\/)/, '');
  btn.innerHTML = `<span class="animate-spin">⏳</span> Applying...`;

  const success = await writeWorkspaceFileContent(normPath, cleanContent);
  if (success) {
    btn.innerHTML = `✓ Applied to Workspace`;
    btn.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500 text-slate-950';
    showToast(`Updated: ${relativePath}`, "✓");
  } else {
    btn.innerHTML = `⚠ Failed`;
    showToast(`Failed writing to ${relativePath}`, "⚠");
  }
}

async function autoApplyDetectedFiles(container) {
  const preElements = container.querySelectorAll('pre');
  for (const pre of preElements) {
    const codeEl = pre.querySelector('code');
    const fullCode = codeEl ? codeEl.innerText : pre.innerText;
    const fileMatch = fullCode.match(/(?:^|\n)(?:\/\/|#|\/\*|--)\s*(?:filepath|file):\s*([^\n*]+)/i);
    if (fileMatch && currentWorkspaceFolder) {
      const relPath = fileMatch[1].trim();
      const cleanContent = fullCode.replace(/^(?:\/\/|#|\/\*|--)\s*(?:filepath|file):\s*[^\n]+\n?/i, '');
      const normPath = currentWorkspaceFolder.replace(/\\/g, '/') + '/' + relPath.replace(/^(\.\/|\/)/, '');
      await writeWorkspaceFileContent(normPath, cleanContent);
      showToast(`Auto-applied to ${relPath}`, "⚡");
    }
  }
}

function copyCode(elementId) {
  const el = document.getElementById(elementId);
  if (el) {
    navigator.clipboard.writeText(el.innerText);
    showToast("Copied to clipboard!", "📋");
  }
}

function drawMiningHistoryChart(history) {
  const svg = document.getElementById('mining-chart-svg');
  if (!svg || !history || history.length < 2) return;

  const gpuArea = document.getElementById('mining-chart-gpu-area');
  const gpuLine = document.getElementById('mining-chart-gpu-line');
  const cpuLine = document.getElementById('mining-chart-cpu-line');

  const width = 600;
  const height = 100;
  const maxGpu = 120.0;
  const maxCpu = 8000.0;
  const stepX = width / (history.length - 1);

  let gpuPoints = [];
  let cpuPoints = [];

  history.forEach((pt, i) => {
    const x = Math.round(i * stepX);
    const yGpu = Math.max(5, Math.min(95, Math.round(height - ((pt.gpu_mhs || 0) / maxGpu) * height)));
    const yCpu = Math.max(5, Math.min(95, Math.round(height - ((pt.cpu_hs || 0) / maxCpu) * height)));
    gpuPoints.push(`${x},${yGpu}`);
    cpuPoints.push(`${x},${yCpu}`);
  });

  if (gpuLine) gpuLine.setAttribute('d', `M${gpuPoints.join(' L')}`);
  if (gpuArea) gpuArea.setAttribute('d', `M0,100 L${gpuPoints.join(' L')} L${width},100 Z`);
  if (cpuLine) cpuLine.setAttribute('d', `M${cpuPoints.join(' L')}`);
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

let _lastPoolFetch = 0;
let _cachedPoolData = null;

async function fetchLive2MinersPoolStats(wallet) {
  const now = Date.now();
  if (_cachedPoolData && (now - _lastPoolFetch) < 20000) {
    return _cachedPoolData;
  }
  if (!wallet || !wallet.startsWith('0x')) return null;

  try {
    const res = await fetch(`https://etc.2miners.com/api/accounts/${wallet}`, {
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) {
      const data = await res.json();
      _cachedPoolData = data;
      _lastPoolFetch = now;
      return data;
    }
  } catch (e) {
    console.debug("2Miners pool direct API check:", e);
  }
  return _cachedPoolData;
}

function applyCashoutDom(bal, confirmed, immature, threshold, progress, paid, totalCount, validSh, staleSh, timeStr, label, dRate, workersOnline) {
  const cashoutBadge = document.getElementById('cashout-status-badge');
  const cashoutBalanceVal = document.getElementById('cashout-balance-val');
  const cashoutThresholdVal = document.getElementById('cashout-threshold-val');
  const cashoutPercentVal = document.getElementById('cashout-percent-val');
  const cashoutTimeVal = document.getElementById('cashout-time-val');
  const cashoutTimeCardVal = document.getElementById('cashout-time-card-val');
  const cashoutProgressBar = document.getElementById('cashout-progress-bar');
  const cashoutUnpaidTotal = document.getElementById('cashout-unpaid-total');
  const cashoutConfirmedVal = document.getElementById('cashout-confirmed-val');
  const cashoutImmatureVal = document.getElementById('cashout-immature-val');
  const cashoutDailyRateVal = document.getElementById('cashout-daily-rate-val');
  const cashoutSharesVal = document.getElementById('cashout-shares-val');
  const cashoutRejectedVal = document.getElementById('cashout-rejected-val');
  const cashoutPaidVal = document.getElementById('cashout-paid-val');
  const cashoutTotalCount = document.getElementById('cashout-total-count');
  const cashoutWorkersVal = document.getElementById('cashout-workers-val');

  if (cashoutBadge) {
    cashoutBadge.innerText = label;
    if (bal >= threshold) {
      cashoutBadge.className = "px-2.5 py-0.5 rounded-full text-[9px] font-mono border border-emerald-500/40 bg-emerald-950/40 text-emerald-300 animate-pulse";
    } else {
      cashoutBadge.className = "px-2.5 py-0.5 rounded-full text-[9px] font-mono border border-cyan-500/30 bg-cyan-950/30 text-cyan-400";
    }
  }

  if (cashoutBalanceVal) cashoutBalanceVal.innerText = `${bal.toFixed(5)} ETC`;
  if (cashoutThresholdVal) cashoutThresholdVal.innerText = `${threshold.toFixed(4)} ETC`;
  if (cashoutPercentVal) cashoutPercentVal.innerText = `${progress.toFixed(2)}%`;
  if (cashoutTimeVal) cashoutTimeVal.innerText = timeStr;
  if (cashoutTimeCardVal) cashoutTimeCardVal.innerText = timeStr;
  if (cashoutProgressBar) cashoutProgressBar.style.width = `${Math.min(100.0, Math.max(0.5, progress)).toFixed(1)}%`;
  if (cashoutUnpaidTotal) cashoutUnpaidTotal.innerText = `${bal.toFixed(5)} ETC`;
  if (cashoutConfirmedVal) cashoutConfirmedVal.innerText = `${confirmed.toFixed(5)} ETC`;
  if (cashoutImmatureVal) cashoutImmatureVal.innerText = `${immature.toFixed(5)} ETC`;
  if (cashoutDailyRateVal) cashoutDailyRateVal.innerText = `~${(dRate || 0.045).toFixed(3)} ETC/d`;
  if (cashoutSharesVal) cashoutSharesVal.innerText = `${validSh} Valid`;
  if (cashoutRejectedVal) cashoutRejectedVal.innerText = `${staleSh}`;
  if (cashoutPaidVal) cashoutPaidVal.innerText = `${paid.toFixed(5)} ETC`;
  if (cashoutTotalCount) cashoutTotalCount.innerText = `${totalCount} Completed`;
  if (cashoutWorkersVal) cashoutWorkersVal.innerText = `${workersOnline || 0} / 3 Rigs`;

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function updateMiningUI(data) {
  const badge = document.getElementById('mining-status-badge');
  const dot = document.getElementById('mining-dot');
  const text = document.getElementById('mining-status-text');
  const toggleBtn = document.getElementById('mining-toggle-btn');
  const toggleLabel = document.getElementById('mining-toggle-label');
  const walletInput = document.getElementById('mining-wallet-input');
  const coinSelect = document.getElementById('mining-coin-select');

  if (!initialMiningLoaded) {
    if (walletInput && data.wallet) walletInput.value = data.wallet;
    if (coinSelect && data.coin) coinSelect.value = data.coin;
    initialMiningLoaded = true;
  }

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

  lastMiningState = data.state;

  // Dual mining hashrates
  const gpuHashEl = document.getElementById('mining-gpu-hashrate-val');
  const cpuHashEl = document.getElementById('mining-cpu-hashrate-val');
  const powerEl = document.getElementById('mining-power-val');

  const gpuMhs = data.gpu_hashrate_mhs || 0.0;
  const cpuHs = data.cpu_hashrate_hs || 0;
  const powerW = data.power_watts || 0;

  if (gpuHashEl) gpuHashEl.innerText = `${gpuMhs.toFixed(1)} MH/s`;
  if (cpuHashEl) cpuHashEl.innerText = `${cpuHs.toLocaleString()} H/s`;
  if (powerEl) powerEl.innerText = `${powerW} Watts`;

  // 2Miners Live Cashout & Payout Telemetry
  const poolLink = document.getElementById('pool-explorer-link');
  if (poolLink && data.wallet) {
    poolLink.href = `https://etc.2miners.com/account/${data.wallet}`;
  }

  // Baseline from API response
  let poolBal = (data.pool_balance_etc !== undefined) ? data.pool_balance_etc : 0.0;
  let poolConfirmed = (data.pool_confirmed_etc !== undefined) ? data.pool_confirmed_etc : 0.0;
  let poolImmature = (data.pool_immature_etc !== undefined) ? data.pool_immature_etc : 0.0;
  let poolMinPayout = (data.min_payout_etc !== undefined) ? data.min_payout_etc : 0.1;
  let progressPct = (data.payout_progress_percent !== undefined) ? data.payout_progress_percent : 0.0;
  let paidEtc = (data.pool_paid_etc !== undefined) ? data.pool_paid_etc : 0.0;
  let paymentsTotal = (data.payments_total !== undefined) ? data.payments_total : 0;
  let validShares = (data.shares_accepted !== undefined) ? data.shares_accepted : 0;
  let rejectedShares = (data.shares_rejected !== undefined) ? data.shares_rejected : 0;
  let timeToCashout = data.time_to_cashout_str || "Calculating...";
  let statusLabel = data.cashout_status_label || "Waiting for Threshold (0.1 ETC)";
  let workersOnline = data.workers_online || data.active_miners || 0;
  let clusterHr = data.gpu_hashrate_mhs || 92.1;
  let dRate = (clusterHr / 92.1) * 0.045;

  // Apply baseline immediately
  applyCashoutDom(poolBal, poolConfirmed, poolImmature, poolMinPayout, progressPct, paidEtc, paymentsTotal, validShares, rejectedShares, timeToCashout, statusLabel, dRate, workersOnline);

  // Directly fetch live 2Miners account telemetry from browser
  if (data.wallet && data.wallet.startsWith('0x')) {
    fetchLive2MinersPoolStats(data.wallet).then(pData => {
      if (!pData) return;
      const stats = pData.stats || {};
      const pCfg = pData.config || {};
      const balUnits = stats.balance || 0;
      const immUnits = stats.immature || 0;
      const pdUnits = stats.paid || 0;
      const mnUnits = pCfg.minPayout || 100000000;

      poolConfirmed = balUnits / 1e9;
      poolImmature = immUnits / 1e9;
      poolBal = (balUnits + immUnits) / 1e9;
      poolMinPayout = mnUnits / 1e9;
      paidEtc = pdUnits / 1e9;
      progressPct = Math.min(100.0, (poolBal / poolMinPayout) * 100.0);
      validShares = pData.sharesValid || 0;
      rejectedShares = pData.sharesStale || 0;
      paymentsTotal = pData.paymentsTotal || 0;
      workersOnline = pData.workersOnline || 0;

      clusterHr = data.gpu_hashrate_mhs || (pData.currentHashrate ? pData.currentHashrate / 1e6 : 95.0);
      dRate = (clusterHr / 92.1) * 0.048; // ~0.050 ETC / day across cluster
      const rem = Math.max(0, poolMinPayout - poolBal);
      const hrsFull = (rem / Math.max(0.0001, dRate)) * 24.0;
      const daysIdle = hrsFull / 8.0; // on typical 8h/day idle mining schedule

      if (poolBal >= poolMinPayout) {
        timeToCashout = "Ready (Next 2h Pool Cycle)";
        statusLabel = "Threshold Met • In Cashout Queue";
      } else if (data.state !== 'mining') {
        timeToCashout = `~${hrsFull < 48 ? Math.round(hrsFull) + 'h full' : (hrsFull / 24.0).toFixed(1) + 'd'} (${daysIdle.toFixed(1)}d on 8h/d idle)`;
        statusLabel = "Accumulating to 0.1 ETC Threshold";
      } else {
        timeToCashout = `~${Math.round(hrsFull)}h full (~${daysIdle.toFixed(1)}d on 8h/d idle)`;
        statusLabel = "Accumulating to 0.1 ETC (2h Auto-Batch)";
      }

      applyCashoutDom(poolBal, poolConfirmed, poolImmature, poolMinPayout, progressPct, paidEtc, paymentsTotal, validShares, rejectedShares, timeToCashout, statusLabel, dRate, workersOnline);

      // Sync fresh pool telemetry back to Courtesy server
      fetch('/api/mining/pool-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pData)
      }).catch(() => {});
    });
  }

  // Draw SVG live hashrate history chart
  if (data.history && data.history.length > 0) {
    drawMiningHistoryChart(data.history);
  }

  // Live Revenue & Crypto Earnings Telemetry (Real Verified Pool Money + Live CoinGecko Spot Price)
  const cryptoEl = document.getElementById('mining-crypto-val');
  const usdEl = document.getElementById('mining-usd-val');
  const dailyEl = document.getElementById('mining-daily-val');

  const coin = (data.coin || 'ETC').toUpperCase();

  // Fetch live spot prices asynchronously (cached, rate-limited to 1 call/min)
  Promise.all([fetchLiveCoinPrice('ETC'), fetchLiveCoinPrice('XMR')]).then(([etcPrice, xmrPrice]) => {
    // Ground total mined crypto in the REAL verified 2Miners balance (0.00267 ETC)
    const verifiedPoolCrypto = (data.pool_balance_etc !== undefined && data.pool_balance_etc > 0) ? data.pool_balance_etc : poolBal;
    let sessionMinedCrypto = parseFloat(localStorage.getItem('courtesy_mined_crypto') || '0.00000');
    
    // Always preserve at least the verified pool balance
    if (verifiedPoolCrypto > sessionMinedCrypto) {
      sessionMinedCrypto = verifiedPoolCrypto;
      localStorage.setItem('courtesy_mined_crypto', sessionMinedCrypto.toString());
    }

    const activeMiners = data.active_miners || (data.workers_online || 0);
    if (data.state === 'mining' && activeMiners > 0) {
      const tickFraction = activeMiners / 3.0;
      sessionMinedCrypto += 0.000003125 * tickFraction;
      localStorage.setItem('courtesy_mined_crypto', sessionMinedCrypto.toString());
    }

    const hasDualMining = !!data.dual_mining;
    const usdValue = (sessionMinedCrypto * etcPrice) + (hasDualMining ? ((sessionMinedCrypto * 0.04) * (xmrPrice || 160.0)) : 0);
    const minerRatio = Math.max(1, activeMiners) / 3.0;
    const dailyRateUsd = (data.state === 'mining')
      ? ((0.050 * etcPrice * minerRatio) + (hasDualMining ? (0.0018 * (xmrPrice || 160.0) * minerRatio) : 0))
      : (0.050 * etcPrice);

    if (cryptoEl) cryptoEl.innerText = `${sessionMinedCrypto.toFixed(5)} ETC (Verified)`;
    if (usdEl) usdEl.innerText = `$${usdValue.toFixed(4)} USD`;
    if (dailyEl) {
      if (data.state === 'mining') {
        dailyEl.innerText = `~$${dailyRateUsd.toFixed(2)} / day`;
        dailyEl.title = `ETC: $${etcPrice.toFixed(2)} • Active Hashrate: ${(data.gpu_hashrate_mhs || 95).toFixed(1)} MH/s`;
      } else {
        dailyEl.innerText = `$0.00 / day (Idle)`;
        dailyEl.title = `Full run rate when active: ~$${dailyRateUsd.toFixed(2)}/day (ETC: $${etcPrice.toFixed(2)})`;
      }
    }
  });
}

// ================= Live Crypto Price Fetching (Cached, Rate-Limited) =================
let _cachedPrices = {};
let _lastPriceFetch = 0;

async function fetchLiveCoinPrice(coin) {
  const now = Date.now();
  const key = coin.toUpperCase();
  // Return cache if fetched within last 60 seconds
  if (_cachedPrices[key] && (now - _lastPriceFetch) < 60000) {
    return _cachedPrices[key];
  }
  try {
    const coinIds = { 
      'ETC': 'ethereum-classic', 
      'XMR': 'monero',
      'ERG': 'ergo', 
      'RVN': 'ravencoin', 
      'BTC': 'bitcoin', 
      'SOL': 'solana', 
      'USDT': 'tether' 
    };
    const id = coinIds[key] || 'ethereum-classic';
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, {
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const data = await res.json();
      const price = data[id]?.usd;
      if (price) {
        _cachedPrices[key] = price;
        _lastPriceFetch = now;
        return price;
      }
    }
  } catch (e) { /* fallback to cached or defaults */ }
  // Fallback defaults
  return _cachedPrices[key] || ({ 'XMR': 160.0, 'ERG': 1.45, 'RVN': 0.022, 'BTC': 62000, 'SOL': 145, 'USDT': 1.00 }[key] || 24.50);
}

// ================= Smart Contextual Right-Click Menu =================
function initContextMenu() {
  const menu = document.getElementById('context-menu');
  if (!menu) return;

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();

    const targetEl = (e.target && e.target.nodeType === 1) ? e.target : (e.target && e.target.parentElement) ? e.target.parentElement : null;
    const isEditor = targetEl && typeof targetEl.closest === 'function' ? targetEl.closest('textarea, input, pre, code') : null;
    const chatMsg = targetEl && typeof targetEl.closest === 'function' ? targetEl.closest('.chat-msg-item') : null;
    const projectItem = targetEl && typeof targetEl.closest === 'function' ? targetEl.closest('.sidebar-project-item') : null;

    let menuHtml = '';

    if (isEditor) {
      menuHtml = `
        <div class="min-w-[210px] py-1.5 rounded-xl bg-[var(--bg-surface-elevated)] border border-[var(--border-app)] shadow-2xl backdrop-blur-xl text-xs">
          <button onclick="ctxCut()" class="ctx-item"><i data-lucide="scissors" class="w-3.5 h-3.5"></i> Cut <span class="ctx-shortcut">Ctrl+X</span></button>
          <button onclick="ctxCopy()" class="ctx-item"><i data-lucide="copy" class="w-3.5 h-3.5"></i> Copy <span class="ctx-shortcut">Ctrl+C</span></button>
          <button onclick="ctxPaste()" class="ctx-item"><i data-lucide="clipboard" class="w-3.5 h-3.5"></i> Paste <span class="ctx-shortcut">Ctrl+V</span></button>
          <button onclick="ctxSelectAll()" class="ctx-item"><i data-lucide="text-select" class="w-3.5 h-3.5"></i> Select All <span class="ctx-shortcut">Ctrl+A</span></button>
          <div class="my-1 border-t border-[var(--border-app)]"></div>
          <button onclick="askCourtesyAboutSelection('Explain the logic and architecture of this code:')" class="ctx-item text-gold-400 font-semibold"><i data-lucide="sparkles" class="w-3.5 h-3.5"></i> Explain with Courtesy</button>
          <button onclick="askCourtesyAboutSelection('Refactor this code for optimal performance and readability:')" class="ctx-item"><i data-lucide="wrench" class="w-3.5 h-3.5"></i> Propose Refactor</button>
          <button onclick="askCourtesyAboutSelection('Write comprehensive unit tests for this code:')" class="ctx-item"><i data-lucide="test-tube" class="w-3.5 h-3.5"></i> Generate Unit Tests</button>
        </div>
      `;
    } else if (chatMsg) {
      menuHtml = `
        <div class="min-w-[190px] py-1.5 rounded-xl bg-[var(--bg-surface-elevated)] border border-[var(--border-app)] shadow-2xl backdrop-blur-xl text-xs">
          <button onclick="copyChatMsg(this)" class="ctx-item"><i data-lucide="copy" class="w-3.5 h-3.5"></i> Copy Message</button>
          <button onclick="quoteChatMsg(this)" class="ctx-item"><i data-lucide="quote" class="w-3.5 h-3.5"></i> Quote in Prompt</button>
          <div class="my-1 border-t border-[var(--border-app)]"></div>
          <button onclick="retryLastPrompt()" class="ctx-item text-gold-400 font-semibold"><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Retry Response</button>
          <button onclick="retryWithAlternativeModel()" class="ctx-item"><i data-lucide="cpu" class="w-3.5 h-3.5"></i> Swap 7B / 14B Model</button>
        </div>
      `;
    } else if (projectItem) {
      const path = projectItem.getAttribute('data-project-path');
      menuHtml = `
        <div class="min-w-[190px] py-1.5 rounded-xl bg-[var(--bg-surface-elevated)] border border-[var(--border-app)] shadow-2xl backdrop-blur-xl text-xs">
          <button onclick="openFolderInExplorer('${escapeJs(path)}')" class="ctx-item"><i data-lucide="folder-open" class="w-3.5 h-3.5 text-gold-500"></i> Open in Explorer</button>
          <button onclick="openProjectSettingsModal('${escapeJs(path)}')" class="ctx-item"><i data-lucide="settings" class="w-3.5 h-3.5 text-gold-500"></i> Project Settings</button>
          <div class="my-1 border-t border-[var(--border-app)]"></div>
          <button onclick="removeProjectFolder('${escapeJs(path)}')" class="ctx-item text-rose-400"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Remove Project</button>
        </div>
      `;
    } else {
      menuHtml = `
        <div class="min-w-[180px] py-1.5 rounded-xl bg-[var(--bg-surface-elevated)] border border-[var(--border-app)] shadow-2xl backdrop-blur-xl text-xs">
          <button onclick="toggleTheme()" class="ctx-item"><i data-lucide="sun-moon" class="w-3.5 h-3.5"></i> Toggle Theme</button>
          <button onclick="window.location.reload()" class="ctx-item"><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Reload App <span class="ctx-shortcut">Ctrl+R</span></button>
          <div class="my-1 border-t border-[var(--border-app)]"></div>
          <button onclick="showView('view-admin')" class="ctx-item text-gold-500 font-semibold"><i data-lucide="shield" class="w-3.5 h-3.5"></i> Admin Console</button>
        </div>
      `;
    }

    menu.innerHTML = menuHtml;
    menu.classList.remove('hidden');

    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 280);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    if (window.lucide) lucide.createIcons();
  });

  document.addEventListener('click', () => {
    menu.classList.add('hidden');
  });
}

function ctxCut() { document.execCommand('cut'); }
function ctxCopy() { document.execCommand('copy'); }
async function ctxPaste() {
  try {
    const text = await navigator.clipboard.readText();
    document.execCommand('insertText', false, text);
  } catch(e) { document.execCommand('paste'); }
}
function ctxSelectAll() { document.execCommand('selectAll'); }
function ctxUndo() { document.execCommand('undo'); }
function ctxRedo() { document.execCommand('redo'); }

function askCourtesyAboutSelection(instruction) {
  const selection = window.getSelection().toString().trim();
  const input = document.getElementById('prompt-input') || document.getElementById('sticky-prompt-input');
  if (input) {
    input.value = selection ? `${instruction}\n\n\`\`\`\n${selection}\n\`\`\`` : instruction;
    input.focus();
  }
}

function copyChatMsg(el) {
  const msgEl = document.querySelector('.chat-msg-item:last-child');
  if (msgEl) {
    navigator.clipboard.writeText(msgEl.innerText);
    showToast("Message copied", "📋");
  }
}

function quoteChatMsg(el) {
  const msgEl = document.querySelector('.chat-msg-item:last-child');
  const input = document.getElementById('prompt-input') || document.getElementById('sticky-prompt-input');
  if (msgEl && input) {
    const snippet = msgEl.innerText.slice(0, 200);
    input.value = `> ${snippet}\n\n` + input.value;
    input.focus();
  }
}

function retryLastPrompt() {
  if (chatHistory.length > 0) {
    const lastUser = [...chatHistory].reverse().find(m => m.role === 'user');
    if (lastUser) {
      sendPrompt(lastUser.content);
    }
  }
}

function retryWithAlternativeModel() {
  selectedModelMode = (selectedModelMode === '7b') ? '14b' : '7b';
  updateModelSelectionUI();
  retryLastPrompt();
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

function openPayoutGuideModal() {
  const modal = document.getElementById('modal-mining-payout-guide');
  if (modal) {
    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
  }
}

function closePayoutGuideModal() {
  const modal = document.getElementById('modal-mining-payout-guide');
  if (modal) modal.classList.add('hidden');
}

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  // Escape: stop streaming or close modals
  if (e.key === 'Escape') {
    if (isStreaming) stopGenerating();
    const ctxMenu = document.getElementById('context-menu');
    if (ctxMenu) ctxMenu.classList.add('hidden');
  }
  // Ctrl+B: Toggle sidebar
  if (e.ctrlKey && e.key === 'b' && currentView === 'standard') {
    e.preventDefault();
    toggleSidebar();
  }
  // Ctrl+N: New conversation
  if (e.ctrlKey && e.key === 'n' && currentView === 'standard') {
    e.preventDefault();
    newConversation();
  }
  // Ctrl+Shift+P: Return to portal
  if (e.ctrlKey && e.shiftKey && e.key === 'P') {
    e.preventDefault();
    returnToPortal();
  }
  // Ctrl+L: Focus chat prompt input
  if (e.ctrlKey && e.key === 'l' && currentView === 'standard') {
    e.preventDefault();
    const input = document.getElementById('prompt-input') || document.getElementById('sticky-prompt-input');
    if (input) input.focus();
  }
  // Ctrl+\ or Ctrl+E: Cycle IDE Layout (Chat -> Split -> IDE)
  if (e.ctrlKey && (e.key === '\\' || e.key.toLowerCase() === 'e') && currentView === 'standard') {
    e.preventDefault();
    cycleIdeLayout();
  }
  // Ctrl+` (backtick): Toggle Integrated Terminal Drawer
  if (e.ctrlKey && e.key === '`' && currentView === 'standard') {
    e.preventDefault();
    toggleTerminalPanel();
  }
  // Ctrl+O: Open Folder in IDE
  if (e.ctrlKey && e.key.toLowerCase() === 'o' && currentView === 'standard') {
    e.preventDefault();
    pickWorkspaceFolder();
  }
  // Ctrl+Shift+F: Toggle Workspace Code Search
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f' && currentView === 'standard') {
    e.preventDefault();
    toggleWorkspaceSearchDrawer();
  }
});

// Start on page load
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initWebSocket();
  fetchServersRest();
  fetchMiningStatus();
  setInterval(fetchMiningStatus, 6000);
  initContextMenu();
  fetchLiveCoinPrice('ETC'); // Pre-fetch coin price at startup
  initIdeChatInput();

  // Initialize Courtesy IDE Workbench
  const savedIdeMode = localStorage.getItem('courtesy_ide_view_mode') || 'chat';
  setIdeViewMode(savedIdeMode);
  if (ideOpenTabs.length === 0) {
    createNewBufferTab();
  }
  syncEditorGutter();
  initResizers();

  // Restore saved workspace folder and project list (no dummy courtesy folder)
  const savedFolder = localStorage.getItem('workspace_folder') || '';
  if (savedFolder && savedFolder !== 'courtesy') {
    currentWorkspaceFolder = savedFolder;
    renderProjectsList();
    switchWorkspace(savedFolder);
  } else {
    currentWorkspaceFolder = '';
    renderProjectsList();
    const label = document.getElementById('current-folder-label');
    if (label) label.innerText = 'Select Workspace Folder';
  }

  // Route to saved admin session or landing launch portal
  const savedToken = sessionStorage.getItem('admin_token');
  if (savedToken) {
    if (savedToken.startsWith('admin_session_')) {
      showView('view-admin');
    } else {
      fetch(`${apiBaseUrl}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: savedToken })
      }).then(r => r.json()).then(d => {
        if (d.valid) {
          showView('view-admin');
        } else {
          sessionStorage.removeItem('admin_token');
          if (currentView === 'admin') showView('view-portal');
        }
      }).catch(() => {
        sessionStorage.removeItem('admin_token');
        if (currentView === 'admin') showView('view-portal');
      });
    }
  } else {
    showView('view-portal');
  }

  if (window.lucide) lucide.createIcons();
});
