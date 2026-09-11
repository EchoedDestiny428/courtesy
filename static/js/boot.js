// Courtesy IDE — Boot / Module Loader
// This is the single entry point for all IDE modules.
// Loaded as <script type="module" src="js/boot.js"></script> in index.html.
// app.js (legacy) is still loaded as a plain script for backward compat.

import { getState, setState, subscribe } from './modules/state.js';
import { emit, on } from './modules/event-bus.js';
import { initTheme, applyTheme, toggleTheme } from './modules/theme.js';
import { showToast, toast } from './modules/toast.js';
import { initKeymap, showKeymapModal } from './modules/keymap.js';
import { initWorkspace, pickWorkspaceFolder, setWorkspaceFolder, closeWorkspaceFolder,
         getFolderName, getFileList, readFile, writeFile, applyDiff,
         runCommand, refreshGitStatus, getRecentWorkspaces, searchWorkspace,
         createFile, deleteItem, renameItem, isPathStrictlyInWorkspace } from './modules/workspace.js';
import { initChat, loadChats, saveChats, createNewChat, selectChat, deleteChat,
         renameChat, sendMessage, stopStreaming, getActiveChat, formatChatTime } from './modules/chat.js';
import { initTelemetry, openTelemetryTray, toggleTelemetryTray, closeTelemetryTray, flushActiveNodeVram } from './modules/telemetry.js';
import { initAutocomplete, closePopup } from './modules/autocomplete.js';
import { initSidebar } from './modules/sidebar.js';
import { enhanceCodeBlocks } from './modules/code-actions.js';
import { initTerminal, openTerminal, toggleTerminal, closeTerminal } from './modules/terminal.js';

// ── API Base URL ───────────────────────────────────────────────────────────────
const apiBaseUrl = (window.location.protocol === 'file:' || !window.location.host || window.location.hostname === 'localhost')
  ? 'http://100.107.249.92:8000'
  : window.location.origin;

window.apiBaseUrl = apiBaseUrl;

// ── Module Init ────────────────────────────────────────────────────────────────
initTheme();
initWorkspace(apiBaseUrl);
initChat(apiBaseUrl);
initKeymap();

// ── Expose module functions globally for app.js backward compat ─────────────────
// These globals let the old app.js and HTML onclick="" handlers continue to work
// while we incrementally migrate.

window.showToast = (msg, icon) => showToast(msg, { icon: typeof icon === 'string' ? icon : undefined });
window.toast = toast;

window.toggleTheme   = toggleTheme;
window.applyTheme    = applyTheme;

// Workspace
window.pickWorkspaceFolder  = pickWorkspaceFolder;
window.setWorkspaceFolder   = (p) => setWorkspaceFolder(p).then(() => {
  if (typeof window.addActiveWorkspace === 'function') window.addActiveWorkspace(p);
  if (typeof window.updateIdeWorkspaceUI === 'function') window.updateIdeWorkspaceUI();
  if (typeof window.renderWorkspacesSidebar === 'function') window.renderWorkspacesSidebar();
});
window.closeWorkspaceFolder = () => {
  if (typeof window.closeActiveConversation === 'function') {
    window.closeActiveConversation();
  } else {
    closeWorkspaceFolder();
    if (typeof window.updateIdeWorkspaceUI === 'function') window.updateIdeWorkspaceUI();
  }
};
window.getFolderName            = getFolderName;
window.getWorkspaceFileList     = getFileList;
window.readWorkspaceFileContent = readFile;
window.writeWorkspaceFileContent= writeFile;
window.applyWorkspaceFileDiff   = applyDiff;
window.runWorkspaceCommand      = runCommand;
window.getRecentWorkspaces      = getRecentWorkspaces;
window.isPathStrictlyInWorkspace= isPathStrictlyInWorkspace;
window.enhanceCodeBlocks        = enhanceCodeBlocks;

// Chat & Workspaces — expose new module fns
window.createNewChatModern = createNewChat;
window.selectChatModern    = selectChat;
window.deleteChatModern    = deleteChat;
window.renameChatModern    = renameChat;
window.sendIdeChatModern   = sendMessage;
window.stopIdeChatModern   = stopStreaming;
window.getActiveChatModern = getActiveChat;
window.formatChatTime      = formatChatTime;

// Telemetry & Terminal
window.openTelemetryTray   = openTelemetryTray;
window.toggleTelemetryTray = toggleTelemetryTray;
window.closeTelemetryTray  = closeTelemetryTray;
window.flushActiveNodeVram = flushActiveNodeVram;
window.openTerminal        = openTerminal;
window.toggleTerminal      = toggleTerminal;
window.closeTerminal       = closeTerminal;
window.closePopup          = closePopup;

// ── Keymap action handlers ─────────────────────────────────────────────────────
on('chat:new', () => {
  if (typeof window.createNewChat === 'function') window.createNewChat();
});
on('workspace:open', () => {
  pickWorkspaceFolder();
});
on('sidebar:toggle', () => {
  if (typeof window.toggleIdeSidebar === 'function') window.toggleIdeSidebar();
});
on('files:quickopen', () => {
  // Ctrl+P — open quick-open file palette (renders in DOM)
  _openQuickFilePalette();
});
on('terminal:toggle', () => {
  toggleTerminal();
});
on('chat:stop', () => {
  stopStreaming();
  if (typeof window.stopIdeChat === 'function') window.stopIdeChat();
});
on('editor:save', () => {
  if (typeof window.saveActiveFile === 'function') window.saveActiveFile();
});
on('layout:cycle', () => {
  if (typeof window.cycleIdeLayout === 'function') window.cycleIdeLayout();
});
on('keymap:show', () => {
  showKeymapModal();
});

// ── State sync → app.js globals ───────────────────────────────────────────────
// Keep legacy globals in sync with state changes so app.js still works.
subscribe('workspaceFolder', (val) => {
  window.currentWorkspaceFolder = val;
});
subscribe('selectedModel', (val) => {
  window.ideSelectedModel = val;
});
subscribe('sidebarOpen', (val) => {
  window.isIdeSidebarOpen = val;
});
subscribe('theme', (val) => {
  // theme.js already applied it, just sync the var if needed
});

// ── Workspace events → app.js UI handlers ─────────────────────────────────────
on('workspace:changed', ({ folder }) => {
  window.currentWorkspaceFolder = folder;
  if (typeof window.addActiveWorkspace === 'function') window.addActiveWorkspace(folder);
  if (typeof window.updateIdeWorkspaceUI === 'function') window.updateIdeWorkspaceUI();
  if (typeof window.renderWorkspacesSidebar === 'function') window.renderWorkspacesSidebar();
  if (typeof window.loadWorkspaceFileTree === 'function') window.loadWorkspaceFileTree();
});
on('workspace:indexed', ({ files }) => {
  window.cachedWorkspaceFiles = files;
  window.ideFileTreeData = files;
  if (typeof window.renderFileTreeUI === 'function') window.renderFileTreeUI(files);
});
on('workspace:git-status', ({ gitStatus }) => {
  window._gitStatus = gitStatus;
});
on('workspace:file-saved', () => {
  refreshGitStatus();
});

// ── Chat events → app.js UI handlers ──────────────────────────────────────────
on('chat:loaded', ({ chats, activeChatId }) => {
  window.workspaceChats = chats;
  window.activeChatId = activeChatId;
  if (typeof window.renderChatsSidebar === 'function') window.renderChatsSidebar();
  if (typeof window.loadActiveChatMessages === 'function') window.loadActiveChatMessages();
});
on('chat:created', ({ chat }) => {
  const s = getState();
  window.workspaceChats = s.workspaceChats;
  window.activeChatId = s.activeChatId;
  if (typeof window.renderChatsSidebar === 'function') window.renderChatsSidebar();
  if (typeof window.loadActiveChatMessages === 'function') window.loadActiveChatMessages();
});
on('chat:selected', ({ chatId }) => {
  window.activeChatId = chatId;
  if (typeof window.renderChatsSidebar === 'function') window.renderChatsSidebar();
  if (typeof window.loadActiveChatMessages === 'function') window.loadActiveChatMessages();
});
on('chat:deleted', () => {
  const s = getState();
  window.workspaceChats = s.workspaceChats;
  window.activeChatId = s.activeChatId;
  if (typeof window.renderChatsSidebar === 'function') window.renderChatsSidebar();
  if (typeof window.loadActiveChatMessages === 'function') window.loadActiveChatMessages();
});
on('chat:focus-input', () => {
  const input = document.getElementById('ide-chat-input');
  if (input) input.focus();
});

// ── Streaming events → DOM ─────────────────────────────────────────────────────
import { createMarkdownRenderer } from './modules/streaming.js';

const _activeRenderers = {};

on('chat:streaming-start', ({ msgId, serverLabel, modelLabel }) => {
  window.isIdeStreaming = true;
  const sendBtn = document.getElementById('ide-send-btn');
  const stopBtn = document.getElementById('ide-stop-btn');
  if (sendBtn) sendBtn.classList.add('hidden');
  if (stopBtn) stopBtn.classList.remove('hidden');

  // Create the assistant message DOM element
  const messagesList = document.getElementById('ide-messages-list');
  const container = document.getElementById('ide-conversation-container');
  const welcome = document.getElementById('ide-conversation-welcome');
  if (welcome) welcome.classList.add('hidden');
  if (!messagesList) return;

  const assistantMsg = document.createElement('div');
  assistantMsg.id = msgId;
  assistantMsg.className = 'flex items-start gap-3 select-text animate-seq-fade';
  assistantMsg.innerHTML = `
    <div class="w-6 h-6 rounded-full bg-black dark:bg-white flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
      <img src="courtesy-black.png" alt="" class="w-3.5 h-3.5 invert dark:invert-0">
    </div>
    <div class="flex-1 min-w-0 space-y-1.5">
      <div class="text-[11px] font-mono text-neutral-400 dark:text-neutral-500 flex items-center gap-2">
        <span class="font-semibold text-neutral-800 dark:text-neutral-200">Courtesy</span>
        <span>•</span>
        <span class="text-neutral-500 dark:text-neutral-400" id="${msgId}-meta">${serverLabel} (${modelLabel})</span>
        <span class="text-neutral-400 dark:text-neutral-600 font-mono text-[10px] hidden" id="${msgId}-tps"></span>
      </div>
      <div id="${msgId}-content" class="markdown-body text-xs text-neutral-900 dark:text-neutral-100 leading-relaxed min-h-[1.5rem]">
        <span class="inline-block w-1.5 h-3.5 bg-black dark:bg-white animate-pulse align-middle"></span>
      </div>
    </div>
  `;
  messagesList.appendChild(assistantMsg);
  if (container) container.scrollTop = container.scrollHeight;

  const contentEl = document.getElementById(`${msgId}-content`);
  if (contentEl) {
    _activeRenderers[msgId] = createMarkdownRenderer(contentEl);
  }
});

on('chat:token', ({ msgId, fullText, tps }) => {
  const renderer = _activeRenderers[msgId];
  if (renderer) renderer.update(fullText);

  const tpsEl = document.getElementById(`${msgId}-tps`);
  if (tpsEl && tps > 0) {
    tpsEl.classList.remove('hidden');
    tpsEl.textContent = `${tps} t/s`;
  }

  const container = document.getElementById('ide-conversation-container');
  if (container) container.scrollTop = container.scrollHeight;
});

on('chat:streaming-done', ({ msgId, fullText }) => {
  const renderer = _activeRenderers[msgId];
  if (renderer) { renderer.flush(); delete _activeRenderers[msgId]; }

  const contentEl = document.getElementById(`${msgId}-content`);
  if (contentEl) {
    try { enhanceCodeBlocks(contentEl); } catch(e) {}
  }

  // Add action bar below completed message
  const msgEl = document.getElementById(msgId);
  if (msgEl && fullText) {
    const actionsBar = document.createElement('div');
    actionsBar.className = 'flex items-center gap-1.5 mt-1.5 pl-9 opacity-0 group-hover:opacity-100 transition-opacity';
    actionsBar.innerHTML = `
      <button onclick="navigator.clipboard.writeText(this.dataset.text); window.showToast('Copied', '📋')"
        data-text="${_escapeAttr(fullText)}"
        class="px-1.5 py-0.5 rounded text-[10px] font-mono text-neutral-400 hover:text-black dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 transition flex items-center gap-1" title="Copy response">
        <i data-lucide="copy" class="w-3 h-3"></i> Copy
      </button>
    `;
    msgEl.classList.add('group');
    msgEl.appendChild(actionsBar);
    if (window.lucide) lucide.createIcons();
  }

  _finishStreaming();
});

on('chat:streaming-aborted', ({ msgId }) => {
  const renderer = _activeRenderers[msgId];
  if (renderer) { renderer.flush(); delete _activeRenderers[msgId]; }
  const contentEl = document.getElementById(`${msgId}-content`);
  if (contentEl && !contentEl.textContent.trim()) {
    contentEl.innerHTML = '<span class="text-neutral-400 italic text-xs">Generation stopped.</span>';
  }
  _finishStreaming();
});

on('chat:streaming-error', ({ msgId, error }) => {
  const renderer = _activeRenderers[msgId];
  if (renderer) { renderer.destroy(); delete _activeRenderers[msgId]; }
  const contentEl = document.getElementById(`${msgId}-content`);
  if (contentEl) {
    contentEl.innerHTML = `<div class="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-xs"><b>Inference Notice:</b> ${error || 'Unable to connect to Ollama on server.'}</div>`;
  }
  _finishStreaming();
});

function _finishStreaming() {
  window.isIdeStreaming = false;
  const sendBtn = document.getElementById('ide-send-btn');
  const stopBtn = document.getElementById('ide-stop-btn');
  if (sendBtn) sendBtn.classList.remove('hidden');
  if (stopBtn) stopBtn.classList.add('hidden');
  if (window.lucide) lucide.createIcons();
  if (typeof window.renderChatsSidebar === 'function') window.renderChatsSidebar();
}

function _escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Quick-open File Palette (Ctrl+P) ───────────────────────────────────────────
function _openQuickFilePalette() {
  const { cachedFiles, workspaceFolder } = getState();
  if (!workspaceFolder || cachedFiles.length === 0) {
    showToast('Open a workspace folder first', { icon: '📁' });
    return;
  }

  let palette = document.getElementById('quick-open-palette');
  if (palette) { palette.remove(); return; } // toggle

  palette = document.createElement('div');
  palette.id = 'quick-open-palette';
  palette.className = 'fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/40 backdrop-blur-sm';
  palette.onclick = (e) => { if (e.target === palette) palette.remove(); };

  palette.innerHTML = `
    <div class="bg-white dark:bg-[#111116] border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-neutral-100 dark:border-neutral-800">
        <i data-lucide="search" class="w-4 h-4 text-neutral-400 flex-shrink-0"></i>
        <input id="quick-open-input" type="text" placeholder="Search files…"
          class="flex-1 bg-transparent text-sm text-black dark:text-white placeholder-neutral-400 focus:outline-none font-mono"
          autocomplete="off" spellcheck="false">
        <kbd class="text-[10px] font-mono bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-500 px-1.5 py-0.5 rounded">Esc</kbd>
      </div>
      <div id="quick-open-results" class="max-h-72 overflow-y-auto py-1"></div>
    </div>
  `;

  document.body.appendChild(palette);
  if (window.lucide) lucide.createIcons();

  const input = document.getElementById('quick-open-input');
  const resultsEl = document.getElementById('quick-open-results');

  function renderResults(query) {
    const q = query.toLowerCase();
    const matches = q
      ? cachedFiles.filter(f => (f.relative || f.name || '').toLowerCase().includes(q)).slice(0, 20)
      : cachedFiles.slice(0, 20);

    if (matches.length === 0) {
      resultsEl.innerHTML = `<div class="px-4 py-3 text-xs text-neutral-400 font-mono">No files match</div>`;
      return;
    }

    resultsEl.innerHTML = matches.map((f, i) => {
      const rel = f.relative || f.name || '';
      const name = rel.split(/[/\\]/).pop();
      const dir = rel.includes('/') || rel.includes('\\') ? rel.split(/[/\\]/).slice(0, -1).join('/') : '';
      return `
        <div class="quick-open-item flex items-center gap-2.5 px-4 py-2 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800 transition"
          onclick="_quickOpenSelect('${_escapeAttr(f.path || '')}', '${_escapeAttr(name)}')">
          <i data-lucide="${_getFileIcon(name)}" class="w-3.5 h-3.5 text-neutral-400 flex-shrink-0"></i>
          <div class="min-w-0">
            <div class="text-xs text-black dark:text-white font-medium truncate">${_escapeHtml(name)}</div>
            ${dir ? `<div class="text-[10px] font-mono text-neutral-400 truncate">${_escapeHtml(dir)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');
    if (window.lucide) lucide.createIcons();
  }

  renderResults('');
  input.focus();

  input.addEventListener('input', () => renderResults(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') palette.remove();
    if (e.key === 'Enter') {
      const first = resultsEl.querySelector('.quick-open-item');
      if (first) first.click();
    }
  });

  window._quickOpenSelect = (path, name) => {
    palette.remove();
    if (typeof window.openFileInEditor === 'function') {
      window.openFileInEditor(path, name);
    }
  };
}

function _getFileIcon(filename) {
  if (!filename) return 'file';
  const ext = filename.split('.').pop().toLowerCase();
  const map = { py: 'file-code', js: 'code-2', jsx: 'code-2', ts: 'code-2', tsx: 'code-2',
    html: 'globe', htm: 'globe', css: 'palette', scss: 'palette',
    json: 'braces', md: 'file-text', sh: 'terminal', bash: 'terminal',
    png: 'image', jpg: 'image', jpeg: 'image', svg: 'image' };
  return map[ext] || 'file';
}

function _escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── DOMContentLoaded bootstrap ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Sync initial state values to legacy globals
  const s = getState();
  window.currentWorkspaceFolder = s.workspaceFolder;
  window.ideSelectedModel = s.selectedModel;
  window.isIdeSidebarOpen = s.sidebarOpen;

  // Initialize UI interactive modules
  try { initTelemetry(); } catch(e) { console.warn('[Boot] initTelemetry error:', e); }
  try { initAutocomplete(); } catch(e) { console.warn('[Boot] initAutocomplete error:', e); }
  try { initSidebar(); } catch(e) { console.warn('[Boot] initSidebar error:', e); }
  try { initTerminal(); } catch(e) { console.warn('[Boot] initTerminal error:', e); }

  console.log('[Courtesy Boot] Modules loaded. State initialized.', {
    theme: s.theme,
    workspaceFolder: s.workspaceFolder,
    selectedModel: s.selectedModel,
  });
});
