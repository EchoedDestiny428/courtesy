// Courtesy IDE — Global Keymap System
import { emit } from './event-bus.js';

// Registry: { keys: string, action: string, label: string, when?: 'editor'|'chat'|'always' }
const _registry = [];

// Default IDE keybindings
const DEFAULT_BINDINGS = [
  { keys: 'Ctrl+N',     action: 'chat:new',             label: 'New Chat',             when: 'always' },
  { keys: 'Ctrl+O',     action: 'workspace:open',       label: 'Open Folder',          when: 'always' },
  { keys: 'Ctrl+B',     action: 'sidebar:toggle',       label: 'Toggle Sidebar',       when: 'always' },
  { keys: 'Ctrl+P',     action: 'files:quickopen',      label: 'Quick Open File',      when: 'always' },
  { keys: 'Ctrl+K',     action: 'chat:stop',            label: 'Stop Generation',      when: 'always' },
  { keys: 'Ctrl+S',     action: 'editor:save',          label: 'Save File',            when: 'editor' },
  { keys: 'Alt+L',      action: 'layout:cycle',         label: 'Cycle Layout',         when: 'always' },
  { keys: 'Ctrl+`',     action: 'terminal:toggle',      label: 'Toggle Terminal',      when: 'always' },
  { keys: 'F1',         action: 'keymap:show',          label: 'Show Keybindings',     when: 'always' },
];

export function initKeymap(customBindings = []) {
  _registry.length = 0;
  [...DEFAULT_BINDINGS, ...customBindings].forEach(b => _registry.push(b));

  document.addEventListener('keydown', _handleKeydown);
}

export function registerBinding(binding) {
  _registry.push(binding);
}

export function showKeymapModal() {
  let modal = document.getElementById('keymap-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'keymap-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="bg-white dark:bg-[#111116] border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-black dark:text-white">Keyboard Shortcuts</h2>
        <button onclick="document.getElementById('keymap-modal').remove()" class="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded text-neutral-400">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>
      <div class="space-y-1.5 max-h-80 overflow-y-auto">
        ${_registry.map(b => `
          <div class="flex items-center justify-between py-1 px-2 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
            <span class="text-xs text-neutral-600 dark:text-neutral-300">${b.label}</span>
            <kbd class="text-[10px] font-mono bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 px-2 py-0.5 rounded">${b.keys}</kbd>
          </div>
        `).join('')}
      </div>
      <p class="text-[10px] text-neutral-400 dark:text-neutral-500 font-mono mt-4 text-center">Press F1 to toggle this panel</p>
    </div>
  `;

  if (window.lucide) lucide.createIcons();
}

function _parseKeys(keysStr) {
  const parts = keysStr.split('+');
  return {
    ctrl:  parts.includes('Ctrl'),
    alt:   parts.includes('Alt'),
    shift: parts.includes('Shift'),
    meta:  parts.includes('Meta'),
    key:   parts[parts.length - 1]
  };
}

function _matchesBinding(e, binding) {
  const parsed = _parseKeys(binding.keys);
  const keyMatch = (() => {
    const k = parsed.key;
    if (k === '`') return e.key === '`';
    if (k.length === 1) return e.key.toLowerCase() === k.toLowerCase();
    return e.key === k;
  })();
  return (
    keyMatch &&
    !!(e.ctrlKey || e.metaKey) === parsed.ctrl &&
    !!e.altKey === parsed.alt &&
    !!e.shiftKey === parsed.shift
  );
}

function _handleKeydown(e) {
  // Skip if typing in an input that's not the IDE chat input or a modal
  const target = e.target;
  const isEditorTextarea = target.id === 'ide-code-textarea';
  const isChatInput = target.id === 'ide-chat-input';
  const isOtherInput = (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') && !isEditorTextarea && !isChatInput;
  
  for (const binding of _registry) {
    if (!_matchesBinding(e, binding)) continue;
    
    // Context check
    if (binding.when === 'editor' && !isEditorTextarea) continue;
    if (isOtherInput && binding.when !== 'editor') continue;

    e.preventDefault();
    emit(binding.action, { originalEvent: e });
    
    // Built-in actions
    if (binding.action === 'keymap:show') showKeymapModal();
    break;
  }
}