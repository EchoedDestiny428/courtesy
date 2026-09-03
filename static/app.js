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
  // Safety guard: ensure viewId is valid, default to view-portal to avoid softlocks
  const targetView = views.includes(viewId) ? viewId : 'view-portal';
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) {
      if (v === targetView) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });
  currentView = targetView.replace('view-', '');
  if (targetView === 'view-standard') {
    updatePinnedNodeUI();
  }
  if (window.lucide) lucide.createIcons();
}

function returnToPortal() {
  showView('view-portal');
}

function startStandardMode() {
  showView('view-standard');
  if (!currentWorkspaceFolder || workspaceProjects.length === 0) {
    pickWorkspaceFolder();
  } else {
    loadActiveProjectContext();
  }
  updatePinnedNodeUI();
}

// ================= Sticky Compute Node Pinning =================
function updatePinnedNodeUI() {
  const label = document.getElementById('std-connected-node-label');
  if (label) {
    const modelLabel = pinnedNode === 'kraken' ? '7B Fast' : '14B Heavy';
    label.innerText = `Pinned: ${pinnedNode} (${modelLabel})`;
  }
}

function cyclePinnedNode() {
  pinnedNode = (pinnedNode === 'kraken') ? 'cst7' : 'kraken';
  localStorage.setItem('pinned_cluster_node', pinnedNode);
  selectModelMode(pinnedNode === 'kraken' ? '7b' : '14b');
  updatePinnedNodeUI();
  showToast(`Pinned compute node: ${pinnedNode}`, "📌");
}

function selectModelMode(mode) {
  selectedModelMode = mode;
  const btn7 = document.getElementById('std-mode-btn-7b');
  const btn14 = document.getElementById('std-mode-btn-14b');

  if (btn7) btn7.classList.toggle('active', mode === '7b');
  if (btn14) btn14.classList.toggle('active', mode === '14b');

  pinnedNode = (mode === '14b') ? 'cst7' : 'kraken';
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
  showToast(`Workspace: ${shortName}`, "📁");

  // Preload workspace file tree for autonomous context
  getWorkspaceFileList(folderPath).then(files => {
    cachedWorkspaceFiles = files;
  });
}

function setWorkspaceFolder(path) {
  addProjectFolder(path, true);
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
function selectModelMode(mode) {
  selectedModelMode = mode;
  ['7b', '14b', 'auto'].forEach(m => {
    const btn = document.getElementById(`mode-btn-${m}`);
    const stdBtn = document.getElementById(`std-mode-btn-${m}`);
    if (btn) btn.className = m === mode ? "model-pill-btn active" : "model-pill-btn";
    if (stdBtn) stdBtn.className = m === mode ? "model-pill-btn active" : "model-pill-btn";
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

  const detailEl = document.getElementById('chat-route-detail');
  if (mode === '7b') {
    if (detailEl) detailEl.innerText = "⚡ qwen2.5-coder:7b (Fast)";
    showToast("Target: 7B Fast Coder");
  } else if (mode === '14b') {
    if (detailEl) detailEl.innerText = "🧠 qwen2.5-coder:14b (Heavy)";
    showToast("Target: 14B Heavy Coder");
  } else {
    if (detailEl) detailEl.innerText = "✨ Auto Cluster Routing";
    showToast("Target: Auto Cluster Routing");
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

  const portalLogo = document.getElementById('portal-logo-img');
  if (portalLogo) {
    portalLogo.src = (theme === 'light') ? 'courtesy-black.png' : 'courtesy-gold.png';
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

  // If node detail modal is open for a node, refresh it live
  if (currentNodeDetailId && metricsMap[currentNodeDetailId]) {
    populateNodeDetailModal(metricsMap[currentNodeDetailId]);
  }
}

function renderServersFromRest(serversList) {
  const container = document.getElementById('admin-servers-grid') || document.getElementById('servers-grid');
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
  } else if (lastMiningState === 'mining') {
    inUseBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span> Mining Active</span>`;
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
  else if (lastMiningState === 'mining') stateText = 'Mining (ETCHash + RandomX)';
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
    const procs = (s.top_processes && s.top_processes.length > 0) ? s.top_processes : [
      { pid: '1422', user: 'ollama', cpu: 12.4, mem: 8.2, cmd: 'ollama runner qwen2.5-coder:7b' },
      { pid: '1890', user: 'root', cpu: 4.1, mem: 1.2, cmd: 'nanominer config.ini' },
      { pid: '984', user: 'cst', cpu: 1.8, mem: 0.9, cmd: 'python3 -m courtesy.app' },
      { pid: '1', user: 'root', cpu: 0.1, mem: 0.2, cmd: '/sbin/init' }
    ];
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

  lastMiningState = data.state;

  // Dual mining hashrates
  const gpuHashEl = document.getElementById('mining-gpu-hashrate-val');
  const cpuHashEl = document.getElementById('mining-cpu-hashrate-val');
  const powerEl = document.getElementById('mining-power-val');

  const gpuMhs = data.gpu_hashrate_mhs || (data.state === 'mining' ? 92.1 : 0.0);
  const cpuHs = data.cpu_hashrate_hs || (data.state === 'mining' ? 6000 : 0);
  const powerW = data.power_watts || (data.state === 'mining' ? 540 : 120);

  if (gpuHashEl) gpuHashEl.innerText = `${gpuMhs.toFixed(1)} MH/s`;
  if (cpuHashEl) cpuHashEl.innerText = `${cpuHs.toLocaleString()} H/s`;
  if (powerEl) powerEl.innerText = `${powerW} Watts`;

  // Draw SVG live hashrate history chart
  if (data.history && data.history.length > 0) {
    drawMiningHistoryChart(data.history);
  }

  // Live Revenue & Crypto Earnings Telemetry (Live price from CoinGecko for ETC + XMR)
  const cryptoEl = document.getElementById('mining-crypto-val');
  const usdEl = document.getElementById('mining-usd-val');
  const dailyEl = document.getElementById('mining-daily-val');

  const coin = (data.coin || 'ETC').toUpperCase();

  // Fetch live spot prices asynchronously (cached, rate-limited to 1 call/min)
  Promise.all([fetchLiveCoinPrice('ETC'), fetchLiveCoinPrice('XMR')]).then(([etcPrice, xmrPrice]) => {
    let sessionMinedCrypto = parseFloat(localStorage.getItem('courtesy_mined_crypto') || '0.00000');
    if (data.state === 'mining') {
      // 6x P2000s (~92 MH/s ETC) + 36 Cores (~6000 H/s XMR)
      // At 6s poll interval: ~0.000003125 ETC per tick
      sessionMinedCrypto += 0.000003125;
      localStorage.setItem('courtesy_mined_crypto', sessionMinedCrypto.toString());
    }

    const usdValue = (sessionMinedCrypto * etcPrice) + ((sessionMinedCrypto * 0.04) * (xmrPrice || 160.0));
    // 0.045 ETC/day (~$1.10) + 0.0018 XMR/day (~$0.29) = ~$1.39 / day
    const dailyRateUsd = (data.state === 'mining') ? ((0.045 * etcPrice) + (0.0018 * (xmrPrice || 160.0))) : 0.00;

    if (cryptoEl) cryptoEl.innerText = `${sessionMinedCrypto.toFixed(5)} ETC`;
    if (usdEl) usdEl.innerText = `$${usdValue.toFixed(4)} USD`;
    if (dailyEl) {
      if (data.state === 'mining') {
        dailyEl.innerText = `~$${dailyRateUsd.toFixed(2)} / day`;
        dailyEl.title = `ETC: $${etcPrice.toFixed(2)} • XMR: $${(xmrPrice || 160).toFixed(2)} (Live CoinGecko)`;
      } else {
        dailyEl.innerText = '$0.00 / day';
        dailyEl.title = '';
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

    const isEditor = e.target.closest('textarea, input, pre, code');
    const chatMsg = e.target.closest('.chat-msg-item');
    const projectItem = e.target.closest('.sidebar-project-item');

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
  // Ctrl+L: Focus chat input
  if (e.ctrlKey && e.key === 'l' && currentView === 'standard') {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    if (input) input.focus();
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

  const editor = getScratchpad();
  if (editor) {
    editor.addEventListener('keydown', handleEditorTabKey);
    syncEditorGutter();
  }

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
          showView('view-portal');
        }
      }).catch(() => {
        showView('view-portal');
      });
    }
  } else {
    showView('view-portal');
  }

  if (window.lucide) lucide.createIcons();
});
