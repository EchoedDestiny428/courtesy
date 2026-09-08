// Courtesy IDE — Integrated Terminal Panel
// Provides collapsible bottom terminal drawer for running commands in the workspace.

import { getState } from './state.js';
import { runCommand } from './workspace.js';
import { showToast } from './toast.js';

let _isOpen = false;
let _history = [];
let _historyIndex = -1;

export function initTerminal() {
  // Listen for Ctrl+` or toggle
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '`') {
      e.preventDefault();
      toggleTerminal();
    }
  });
}

export function toggleTerminal() {
  if (_isOpen) {
    closeTerminal();
  } else {
    openTerminal();
  }
}

export function openTerminal() {
  _isOpen = true;
  let panel = document.getElementById('ide-terminal-drawer');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'ide-terminal-drawer';
    panel.className = 'border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-[#0d0d12] flex flex-col transition-all duration-200 z-20 h-56 font-mono text-xs select-none';
    
    // Mount right above input bar wrapper or at bottom of ide-canvas
    const canvas = document.getElementById('ide-canvas');
    if (canvas) {
      canvas.appendChild(panel);
    } else {
      document.body.appendChild(panel);
    }
    renderTerminalLayout(panel);
  } else {
    panel.classList.remove('hidden');
  }

  const input = document.getElementById('ide-terminal-input');
  if (input) setTimeout(() => input.focus(), 50);
}

export function closeTerminal() {
  _isOpen = false;
  const panel = document.getElementById('ide-terminal-drawer');
  if (panel) panel.classList.add('hidden');
}

function renderTerminalLayout(panel) {
  const { workspaceFolder } = getState();
  const folderName = (workspaceFolder || '').split(/[/\\]/).pop() || 'terminal';

  panel.innerHTML = `
    <!-- Terminal Header -->
    <div class="h-8 px-3 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0a0a0e] select-none text-[11px]">
      <div class="flex items-center gap-2">
        <i data-lucide="terminal" class="w-3.5 h-3.5 text-neutral-500"></i>
        <span class="font-bold text-black dark:text-white">Terminal</span>
        <span class="text-neutral-400 text-[10px]">•</span>
        <span class="text-neutral-500 text-[10px] truncate max-w-xs" id="term-cwd">${escapeHtml(folderName)}</span>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="window._runQuickTermCommand('git status -s')" class="px-2 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-[10px] text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white transition">git status</button>
        <button onclick="window._clearTerminalOutput()" class="px-2 py-0.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-[10px] text-neutral-400 hover:text-black dark:hover:text-white transition">Clear</button>
        <button onclick="window.closeTerminal && window.closeTerminal()" class="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded text-neutral-400 hover:text-black dark:hover:text-white transition">
          <i data-lucide="x" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    </div>

    <!-- Terminal Output -->
    <div id="ide-terminal-output" class="flex-1 overflow-y-auto p-3 space-y-1 font-mono text-[11px] select-text text-neutral-800 dark:text-neutral-200">
      <div class="text-neutral-400 dark:text-neutral-500">Courtesy Autonomous Terminal ready. Type command and press Enter.</div>
    </div>

    <!-- Terminal Input Prompt -->
    <div class="h-9 px-3 border-t border-neutral-200 dark:border-neutral-800 flex items-center gap-2 bg-white dark:bg-[#0a0a0e]">
      <span class="text-emerald-500 font-bold">$</span>
      <input id="ide-terminal-input" type="text" placeholder="run command..."
        class="flex-1 bg-transparent text-xs text-black dark:text-white placeholder-neutral-400 focus:outline-none font-mono"
        autocomplete="off" spellcheck="false">
    </div>
  `;

  window._runQuickTermCommand = (cmd) => {
    const input = document.getElementById('ide-terminal-input');
    if (input) {
      input.value = cmd;
      executeTerminalCommand(cmd);
    }
  };

  window._clearTerminalOutput = () => {
    const output = document.getElementById('ide-terminal-output');
    if (output) output.innerHTML = '';
  };

  const input = document.getElementById('ide-terminal-input');
  if (input) {
    input.addEventListener('keydown', handleTerminalKeydown);
  }

  if (window.lucide) lucide.createIcons();
}

async function handleTerminalKeydown(e) {
  const input = e.target;
  if (e.key === 'Enter') {
    e.preventDefault();
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    _history.push(cmd);
    _historyIndex = _history.length;
    await executeTerminalCommand(cmd);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (_history.length > 0 && _historyIndex > 0) {
      _historyIndex--;
      input.value = _history[_historyIndex];
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (_historyIndex < _history.length - 1) {
      _historyIndex++;
      input.value = _history[_historyIndex];
    } else {
      _historyIndex = _history.length;
      input.value = '';
    }
  }
}

async function executeTerminalCommand(cmd) {
  const output = document.getElementById('ide-terminal-output');
  if (!output) return;

  const row = document.createElement('div');
  row.className = 'space-y-0.5 animate-seq-fade';
  row.innerHTML = `
    <div class="flex items-center gap-2 text-neutral-500 font-semibold">
      <span class="text-emerald-500">$</span>
      <span class="text-black dark:text-white">${escapeHtml(cmd)}</span>
    </div>
    <div class="text-neutral-400 text-[10px] pl-3 italic">running...</div>
  `;
  output.appendChild(row);
  output.scrollTop = output.scrollHeight;

  const result = await runCommand(cmd);

  const statusColor = result.exit_code === 0 ? 'text-neutral-700 dark:text-neutral-300' : 'text-rose-500';
  const outText = (result.stdout || '') + (result.stderr ? `\n${result.stderr}` : '');

  row.innerHTML = `
    <div class="flex items-center justify-between text-neutral-500 font-semibold">
      <div class="flex items-center gap-2">
        <span class="text-emerald-500">$</span>
        <span class="text-black dark:text-white">${escapeHtml(cmd)}</span>
      </div>
      <span class="text-[9px] ${result.exit_code === 0 ? 'text-emerald-500' : 'text-rose-500'} font-mono">exit ${result.exit_code}</span>
    </div>
    <pre class="pl-3 whitespace-pre-wrap ${statusColor} text-[10px] leading-relaxed font-mono">${escapeHtml(outText || '(no output)')}</pre>
  `;

  output.scrollTop = output.scrollHeight;
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
