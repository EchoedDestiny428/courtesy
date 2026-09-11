// Courtesy IDE — Chat Engine Module
// Manages all conversation lifecycle: create, select, delete, rename, send, stream.

import { getState, setState, getStateRaw, createChatObject, loadChatsFromStorage, saveChatsToStorage, saveActiveChatId, loadActiveChatId } from './state.js';
import { emit, on } from './event-bus.js';
import { streamChat, createMarkdownRenderer, calcTokensPerSecond } from './streaming.js';

let _apiBaseUrl = null;
export function initChat(apiBaseUrl) { _apiBaseUrl = apiBaseUrl; }
function getApiBase() { return _apiBaseUrl || window.apiBaseUrl || 'http://100.107.249.92:8000'; }

// ── Load/Save ─────────────────────────────────────────────────────────────────
export function loadChats(autoSelect = false) {
  const { workspaceFolder } = getState();
  let chats = loadChatsFromStorage(workspaceFolder) || [];

  let activeChatId = null;
  if (autoSelect && chats.length > 0) {
    const saved = loadActiveChatId(workspaceFolder);
    if (saved && chats.some(c => c.id === saved)) {
      activeChatId = saved;
    } else {
      activeChatId = chats[0].id;
    }
  }

  setState({ workspaceChats: chats, activeChatId });
  emit('chat:loaded', { chats, activeChatId });
}

export function saveChats() {
  const { workspaceChats, workspaceFolder, activeChatId } = getState();
  saveChatsToStorage(workspaceChats, workspaceFolder);
  saveActiveChatId(activeChatId, workspaceFolder);
}

// ── CRUD ───────────────────────────────────────────────────────────────────────
export function getActiveChat() {
  const { workspaceChats, activeChatId } = getState();
  return workspaceChats.find(c => c.id === activeChatId) || null;
}

export function createNewChat() {
  const { workspaceChats, selectedModel } = getState();
  // If the current chat is empty, just focus input instead of creating duplicate
  const active = getActiveChat();
  if (active && (!active.messages || active.messages.length === 0) && active.title === 'New Conversation') {
    emit('chat:focus-input', {});
    return active;
  }

  const newChat = createChatObject('New Conversation', selectedModel);
  const updated = [newChat, ...workspaceChats];
  setState({ workspaceChats: updated, activeChatId: newChat.id });
  saveChats();
  emit('chat:created', { chat: newChat });
  emit('chat:selected', { chatId: newChat.id });
  return newChat;
}

export function selectChat(chatId) {
  const { activeChatId } = getState();
  if (activeChatId === chatId) return;
  setState({ activeChatId: chatId });
  saveChats();
  emit('chat:selected', { chatId });
}

export function deleteChat(chatId) {
  const { workspaceChats, activeChatId } = getState();
  const idx = workspaceChats.findIndex(c => c.id === chatId);
  if (idx < 0) return;

  const updated = [...workspaceChats];
  updated.splice(idx, 1);

  let newActiveId = activeChatId;
  if (updated.length === 0) {
    const fresh = createChatObject('New Conversation');
    updated.push(fresh);
    newActiveId = fresh.id;
  } else if (activeChatId === chatId) {
    newActiveId = updated[Math.min(idx, updated.length - 1)].id;
  }

  setState({ workspaceChats: updated, activeChatId: newActiveId });
  saveChats();
  emit('chat:deleted', { chatId });
  emit('chat:selected', { chatId: newActiveId });
}

export function renameChat(chatId, newTitle) {
  const { workspaceChats } = getState();
  const chat = workspaceChats.find(c => c.id === chatId);
  if (!chat || !newTitle?.trim()) return;
  chat.title = newTitle.trim().slice(0, 60);
  setState({ workspaceChats: [...workspaceChats] });
  saveChats();
  emit('chat:renamed', { chatId, title: chat.title });
}

// ── Sending ────────────────────────────────────────────────────────────────────
let _abortController = null;

export async function sendMessage(text) {
  const { isStreaming, selectedModel, activeServer, workspaceFolder, cachedFiles } = getState();
  if (isStreaming || !text?.trim()) return;

  let activeChat = getActiveChat();
  if (!activeChat) {
    activeChat = createNewChat();
  }

  const cleanText = text.trim();

  // Auto-generate title from first message
  if (!activeChat.title || activeChat.title === 'New Conversation') {
    let autoTitle = cleanText.replace(/^(\/plan|\/explain|\/refactor|\/audit|\/tests)\s*/i, '').trim();
    autoTitle = autoTitle.split('\n')[0].trim();
    if (autoTitle.length > 40) autoTitle = autoTitle.substring(0, 40).trim() + '…';
    activeChat.title = autoTitle || 'Conversation';
  }

  // Add user message
  activeChat.messages.push({ role: 'user', content: cleanText, timestamp: Date.now() });
  activeChat.updatedAt = Date.now();

  // Bubble to top
  const { workspaceChats } = getState();
  const idx = workspaceChats.findIndex(c => c.id === activeChat.id);
  if (idx > 0) {
    workspaceChats.splice(idx, 1);
    workspaceChats.unshift(activeChat);
    setState({ workspaceChats: [...workspaceChats] });
  }

  saveChats();
  emit('chat:message-added', { role: 'user', content: cleanText, chatId: activeChat.id });

  // Build system prompt with workspace context
  const filesSnippet = cachedFiles.slice(0, 35).map(f => f.name || (f.path || '').split(/[/\\]/).pop()).join(', ');
  const systemPrompt = `You are Courtesy, an elite autonomous Antigravity AI coding assistant and pair programmer.\nActive Workspace Folder: ${workspaceFolder || 'Workspace'}\nFiles in Workspace: ${filesSnippet || 'Standard project'}\nProvide clean, production-ready code blocks with filename headers and clear explanations.`;

  const modelName = selectedModel === '7b' ? 'qwen2.5-coder:7b' : 'qwen2.5-coder:14b';
  const historyMessages = activeChat.messages.map(m => ({ role: m.role, content: m.content }));

  // Placeholder assistant message
  const msgId = `ide-msg-${Date.now()}`;
  emit('chat:streaming-start', {
    msgId,
    serverLabel: activeServer?.id || 'cst7',
    modelLabel: modelName.includes('14b') ? '14B' : '7B'
  });

  setState({ isStreaming: true });
  _abortController = new AbortController();

  let fullText = '';

  await streamChat({
    url: `${getApiBase()}/api/chat`,
    body: {
      model: modelName,
      messages: [{ role: 'system', content: systemPrompt }, ...historyMessages],
      stream: true,
      temperature: 0.2
    },
    signal: _abortController.signal,
    onToken: (text, tokenCount, startTime) => {
      fullText = text;
      const tps = calcTokensPerSecond(tokenCount, startTime);
      emit('chat:token', { msgId, fullText, tokenCount, tps });
    },
    onDone: (text) => {
      fullText = text;
      if (fullText) {
        activeChat.messages.push({
          role: 'assistant',
          content: fullText,
          model: selectedModel,
          timestamp: Date.now()
        });
        activeChat.updatedAt = Date.now();
        saveChats();
        emit('chat:message-added', { role: 'assistant', content: fullText, chatId: activeChat.id });
      }
      emit('chat:streaming-done', { msgId, fullText });
      setState({ isStreaming: false });
      _abortController = null;
    },
    onError: (err) => {
      if (err.name === 'AbortError') {
        emit('chat:streaming-aborted', { msgId });
      } else {
        emit('chat:streaming-error', { msgId, error: err.message });
      }
      setState({ isStreaming: false });
      _abortController = null;
    }
  });
}

export function stopStreaming() {
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
export function formatChatTime(timestamp) {
  if (!timestamp) return 'Just now';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
