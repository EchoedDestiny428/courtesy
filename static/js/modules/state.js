// Courtesy IDE — Central State Store
// All modules read/write state through here. Never maintain local copies.

const _state = {
  // Server / connection
  activeServer: null,           // { id, ip, latency, dns, gpuSummary }
  currentView: 'portal',        // 'portal' | 'standard' | 'admin'

  // Workspace
  workspaceFolder: localStorage.getItem('workspace_folder') || '',
  recentWorkspaces: [],
  cachedFiles: [],
  gitStatus: {},                // { [relativePath]: 'M' | 'A' | '?' | 'D' }

  // Chat / Conversation
  workspaceChats: [],           // Array<Chat>
  activeChatId: null,
  isStreaming: false,

  // Editor tabs
  openTabs: [],                 // Array<Tab>
  activeTabIndex: -1,
  expandedFolders: new Set(),
  fileTreeData: [],

  // UI
  theme: localStorage.getItem('courtesy_theme') || 'light',
  sidebarOpen: localStorage.getItem('courtesy_sidebar_open') !== 'false',
  selectedModel: localStorage.getItem('courtesy_selected_model') || '14b',
  ideViewMode: localStorage.getItem('courtesy_ide_view_mode') || 'chat',

  // Model
  pinnedNode: localStorage.getItem('pinned_cluster_node') || 'cst1',
};

const _subscribers = {};

export function getState() {
  return { ..._state };
}

export function getStateRaw() {
  // Returns direct reference (for mutable objects like Set)
  return _state;
}

export function setState(partial) {
  const changed = [];
  for (const key of Object.keys(partial)) {
    if (_state[key] !== partial[key]) {
      _state[key] = partial[key];
      changed.push(key);
    }
  }
  // Persist select keys to localStorage automatically
  const persistMap = {
    theme: 'courtesy_theme',
    sidebarOpen: 'courtesy_sidebar_open',
    selectedModel: 'courtesy_selected_model',
    ideViewMode: 'courtesy_ide_view_mode',
    pinnedNode: 'pinned_cluster_node',
    workspaceFolder: 'workspace_folder',
  };
  for (const key of changed) {
    if (persistMap[key]) {
      try { localStorage.setItem(persistMap[key], _state[key]); } catch(e) {}
    }
    // Notify subscribers
    (_subscribers[key] || []).forEach(fn => { try { fn(_state[key], key); } catch(e) { console.error(e); } });
    (_subscribers['*'] || []).forEach(fn => { try { fn(_state[key], key); } catch(e) { console.error(e); } });
  }
}

export function subscribe(key, handler) {
  if (!_subscribers[key]) _subscribers[key] = [];
  _subscribers[key].push(handler);
  // Return unsubscribe function
  return () => {
    _subscribers[key] = _subscribers[key].filter(h => h !== handler);
  };
}

// -- Chat schema helpers --------------------------------------------------

export function getWorkspaceStorageKey(workspaceFolder) {
  const folder = workspaceFolder || _state.workspaceFolder;
  if (!folder) return 'courtesy_chats___default__';
  const clean = folder.replace(/[\\/]+$/, '').toLowerCase();
  return `courtesy_chats_${encodeURIComponent(clean)}`;
}

export function loadChatsFromStorage(workspaceFolder) {
  const key = getWorkspaceStorageKey(workspaceFolder);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch(e) { console.error('Failed to load chats:', e); }
  // Run migration from old courtesy_projects schema
  return _migrateOldChats(workspaceFolder) || [];
}

export function saveChatsToStorage(chats, workspaceFolder) {
  const key = getWorkspaceStorageKey(workspaceFolder);
  try {
    localStorage.setItem(key, JSON.stringify(chats));
  } catch(e) { console.error('Failed to save chats:', e); }
}

export function saveActiveChatId(chatId, workspaceFolder) {
  const key = getWorkspaceStorageKey(workspaceFolder);
  try {
    if (chatId) localStorage.setItem(`courtesy_active_chat_${key}`, chatId);
  } catch(e) {}
}

export function loadActiveChatId(workspaceFolder) {
  const key = getWorkspaceStorageKey(workspaceFolder);
  return localStorage.getItem(`courtesy_active_chat_${key}`) || null;
}

function _migrateOldChats(workspaceFolder) {
  // Migrate from old courtesy_projects schema (chatHistory array on project)
  try {
    const raw = localStorage.getItem('courtesy_projects');
    if (!raw) return null;
    const projects = JSON.parse(raw);
    if (!Array.isArray(projects)) return null;
    const match = projects.find(p => p.path && workspaceFolder &&
      p.path.toLowerCase() === workspaceFolder.toLowerCase());
    if (!match || !Array.isArray(match.chatHistory) || match.chatHistory.length === 0) return null;
    // Convert old flat chatHistory to new chat object format
    const migratedChat = {
      id: `chat_migrated_${Date.now()}`,
      title: 'Migrated Conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: '14b',
      messages: match.chatHistory.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: Date.now()
      }))
    };
    console.log('[Courtesy] Migrated old chat history to new schema');
    return [migratedChat];
  } catch(e) { return null; }
}

export function createChatObject(title = 'New Conversation', model = null) {
  return {
    id: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: model || _state.selectedModel || '14b',
    messages: [],
    settings: {
      skipWritePermissions: false
    }
  };
}
