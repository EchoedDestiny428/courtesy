// Courtesy IDE — Slash Commands & @file Mention Autocomplete
// Provides inline popup above the chat input for quick commands and file tags.

import { getState } from './state.js';

const SLASH_COMMANDS = [
  { cmd: '/plan', desc: 'Generate a step-by-step Implementation Plan', icon: 'list-ordered' },
  { cmd: '/refactor', desc: 'Refactor code for modularity, clean code, and performance', icon: 'refresh-cw' },
  { cmd: '/audit', desc: 'Audit code for bugs, race conditions, and security issues', icon: 'shield-alert' },
  { cmd: '/explain', desc: 'Explain architecture, functions, and core patterns', icon: 'help-circle' },
  { cmd: '/tests', desc: 'Write comprehensive unit and integration tests', icon: 'check-circle-2' },
];

let _activePopup = null;
let _selectedIndex = 0;
let _currentMode = null; // 'slash' | 'file'
let _currentMatches = [];

export function initAutocomplete() {
  const input = document.getElementById('ide-chat-input');
  if (!input) return;

  input.addEventListener('input', handleInputChange);
  input.addEventListener('keydown', handleInputKeydown);
  document.addEventListener('click', (e) => {
    if (_activePopup && !input.contains(e.target) && !_activePopup.contains(e.target)) {
      closePopup();
    }
  });
}

function handleInputChange(e) {
  const input = e.target;
  const val = input.value;
  const cursor = input.selectionStart;

  // Find token before cursor
  const textBefore = val.slice(0, cursor);
  const lastSlash = textBefore.lastIndexOf('/');
  const lastAt = textBefore.lastIndexOf('@');

  // Check if cursor is right after slash command
  if (lastSlash !== -1 && (lastSlash === 0 || /\s/.test(textBefore[lastSlash - 1]))) {
    const query = textBefore.slice(lastSlash);
    if (!/\s/.test(query)) {
      showSlashCommands(query, input, lastSlash);
      return;
    }
  }

  // Check if cursor is right after @ file mention
  if (lastAt !== -1 && (lastAt === 0 || /\s/.test(textBefore[lastAt - 1]))) {
    const query = textBefore.slice(lastAt + 1);
    if (!/\s/.test(query)) {
      showFileMentions(query, input, lastAt);
      return;
    }
  }

  closePopup();
}

function handleInputKeydown(e) {
  if (!_activePopup || _currentMatches.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _selectedIndex = (_selectedIndex + 1) % _currentMatches.length;
    renderPopupItems();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _selectedIndex = (_selectedIndex - 1 + _currentMatches.length) % _currentMatches.length;
    renderPopupItems();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (_currentMatches[_selectedIndex]) {
      e.preventDefault();
      applySelection(_currentMatches[_selectedIndex]);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePopup();
  }
}

function showSlashCommands(query, input, startIndex) {
  _currentMode = 'slash';
  _currentMatches = SLASH_COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(query.toLowerCase()));
  if (_currentMatches.length === 0) {
    closePopup();
    return;
  }
  _selectedIndex = 0;
  createOrUpdatePopup(input, startIndex);
}

function showFileMentions(query, input, startIndex) {
  _currentMode = 'file';
  const { cachedFiles } = getState();
  const q = query.toLowerCase();

  const files = (cachedFiles || []).filter(f => {
    const name = f.relative || f.name || '';
    return name.toLowerCase().includes(q);
  }).slice(0, 8);

  _currentMatches = files.map(f => {
    const name = (f.relative || f.name || '').split(/[/\\]/).pop();
    const rel = f.relative || f.name || '';
    return { name, rel, path: f.path, icon: 'file-code' };
  });

  if (_currentMatches.length === 0) {
    closePopup();
    return;
  }
  _selectedIndex = 0;
  createOrUpdatePopup(input, startIndex);
}

function createOrUpdatePopup(input, startIndex) {
  if (!_activePopup) {
    _activePopup = document.createElement('div');
    _activePopup.id = 'ide-autocomplete-popup';
    _activePopup.className = 'absolute z-50 rounded-xl bg-white/95 dark:bg-[#15151b]/95 border border-neutral-200 dark:border-neutral-800 shadow-xl backdrop-blur-md p-1 font-mono text-xs w-80 max-h-56 overflow-y-auto select-none';
    
    // Position above the input bar wrapper
    const wrapper = document.getElementById('ide-input-bar-wrapper') || input.parentElement;
    wrapper.style.position = 'relative';
    wrapper.appendChild(_activePopup);
    _activePopup.style.bottom = '100%';
    _activePopup.style.marginBottom = '8px';
    _activePopup.style.left = '16px';
  }

  _activePopup._startIndex = startIndex;
  renderPopupItems();
}

function renderPopupItems() {
  if (!_activePopup) return;

  _activePopup.innerHTML = _currentMatches.map((item, idx) => {
    const isSelected = idx === _selectedIndex;
    if (_currentMode === 'slash') {
      return `
        <div class="px-2.5 py-1.5 rounded-lg cursor-pointer flex items-center justify-between transition ${isSelected ? 'bg-black dark:bg-white text-white dark:text-black font-semibold' : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'}"
          onclick="window._applyAutocompleteItem(${idx})">
          <div class="flex items-center gap-2">
            <span class="font-bold">${item.cmd}</span>
          </div>
          <span class="text-[10px] opacity-70 truncate max-w-[170px]">${item.desc}</span>
        </div>
      `;
    } else {
      return `
        <div class="px-2.5 py-1.5 rounded-lg cursor-pointer flex items-center justify-between transition ${isSelected ? 'bg-black dark:bg-white text-white dark:text-black font-semibold' : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'}"
          onclick="window._applyAutocompleteItem(${idx})">
          <div class="flex items-center gap-2 truncate">
            <i data-lucide="file" class="w-3.5 h-3.5 shrink-0 opacity-70"></i>
            <span class="truncate">${item.name}</span>
          </div>
          <span class="text-[9px] opacity-50 truncate max-w-[120px] font-sans">${item.rel}</span>
        </div>
      `;
    }
  }).join('');

  window._applyAutocompleteItem = (idx) => {
    if (_currentMatches[idx]) {
      applySelection(_currentMatches[idx]);
    }
  };

  if (window.lucide) lucide.createIcons();
}

function applySelection(item) {
  const input = document.getElementById('ide-chat-input');
  if (!input || !_activePopup) return;

  const val = input.value;
  const start = _activePopup._startIndex;
  const cursor = input.selectionStart;

  let insertText = '';
  if (_currentMode === 'slash') {
    insertText = item.cmd + ' ';
  } else {
    insertText = `@${item.rel} `;
  }

  input.value = val.slice(0, start) + insertText + val.slice(cursor);
  const newCursor = start + insertText.length;
  input.setSelectionRange(newCursor, newCursor);
  input.focus();

  closePopup();
}

export function closePopup() {
  if (_activePopup) {
    _activePopup.remove();
    _activePopup = null;
  }
  _currentMatches = [];
  _currentMode = null;
}
