// Courtesy IDE — Workspace Module
// Handles all folder selection, file list, read/write, diff, and command execution.

import { getState, setState } from './state.js';
import { emit } from './event-bus.js';

let _apiBaseUrl = null;
export function initWorkspace(apiBaseUrl) { _apiBaseUrl = apiBaseUrl; }
function getApiBase() { return _apiBaseUrl || window.apiBaseUrl || 'http://100.107.249.92:8000'; }

// ── Folder Picker ──────────────────────────────────────────────────────────────
let _isPicking = false;

export async function pickWorkspaceFolder() {
  if (_isPicking) return;
  _isPicking = true;
  try {
    if (window.electronAPI?.selectDirectory) {
      const selected = await window.electronAPI.selectDirectory();
      if (selected) await setWorkspaceFolder(selected);
      return;
    }
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker();
        if (handle?.name) await setWorkspaceFolder(handle.name);
      } catch(e) {}
      return;
    }
    const { workspaceFolder } = getState();
    const input = prompt('Enter project folder path:', workspaceFolder || '');
    if (input?.trim()) await setWorkspaceFolder(input.trim());
  } catch(err) {
    console.warn('[Workspace] Folder picker error:', err);
  } finally {
    _isPicking = false;
  }
}

export async function setWorkspaceFolder(folderPath) {
  if (!folderPath) return;
  const normalized = folderPath.replace(/\\/g, '/');
  const prev = getState().workspaceFolder;
  setState({ workspaceFolder: normalized });
  recordRecentWorkspace(normalized);
  emit('workspace:changed', { folder: normalized, previous: prev });
  try {
    const files = await getFileList(normalized);
    setState({ cachedFiles: files, fileTreeData: files });
    emit('workspace:indexed', { folder: normalized, files });
  } catch(e) { console.warn('[Workspace] File index error:', e); }
}

export function closeWorkspaceFolder() {
  const prev = getState().workspaceFolder;
  setState({ workspaceFolder: '', cachedFiles: [], fileTreeData: [] });
  try { localStorage.removeItem('workspace_folder'); } catch(e) {}
  emit('workspace:closed', { previous: prev });
}

// ── Recent Workspaces ──────────────────────────────────────────────────────────
export function recordRecentWorkspace(folderPath) {
  if (!folderPath) return;
  try {
    let recents = JSON.parse(localStorage.getItem('courtesy_recent_workspaces') || '[]');
    recents = recents.filter(p => p.toLowerCase() !== folderPath.toLowerCase());
    recents.unshift(folderPath);
    if (recents.length > 6) recents = recents.slice(0, 6);
    localStorage.setItem('courtesy_recent_workspaces', JSON.stringify(recents));
    emit('workspace:recents-changed', { recents });
  } catch(e) {}
}

export function getRecentWorkspaces() {
  try { return JSON.parse(localStorage.getItem('courtesy_recent_workspaces') || '[]'); }
  catch(e) { return []; }
}

export function getFolderName(pathStr) {
  if (!pathStr) return '';
  const clean = pathStr.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts.pop() || parts.pop() || clean;
}

// ── File List ──────────────────────────────────────────────────────────────────
const IGNORED_DIRS = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.cache', 'venv', '.venv', 'env']);

export async function getFileList(folderPath) {
  if (!folderPath) return [];
  if (window.electronAPI?.listFiles) {
    try {
      const files = await window.electronAPI.listFiles(folderPath);
      return _filterIgnoredPaths(files);
    } catch(e) { console.warn('[Workspace] Electron listFiles failed:', e); }
  }
  try {
    const res = await fetch(`${getApiBase()}/api/workspace/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath })
    });
    if (res.ok) { const data = await res.json(); return _filterIgnoredPaths(data.files || []); }
  } catch(e) { console.warn('[Workspace] REST listFiles failed:', e); }
  return [];
}

function _filterIgnoredPaths(files) {
  return (files || []).filter(f => {
    const parts = (f.relative || f.name || '').split(/[/\\]/);
    return !parts.some(p => IGNORED_DIRS.has(p));
  });
}

// ── Path Sandboxing & Security ──────────────────────────────────────────────────
export function isPathStrictlyInWorkspace(targetPath, workspaceFolder) {
  const ws = workspaceFolder || getState().workspaceFolder;
  if (!targetPath || !ws) return false;

  const wsNorm = ws.replace(/\\/g, '/').replace(/\/+$/, '');
  let targetNorm = targetPath.replace(/\\/g, '/').trim();

  let fullPath = targetNorm;
  if (!fullPath.toLowerCase().startsWith(wsNorm.toLowerCase())) {
    fullPath = wsNorm + '/' + fullPath.replace(/^(\.\/|\/)/, '');
  }

  const segments = fullPath.split('/');
  const resolved = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (resolved.length === 0) return false;
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }

  const resolvedStr = (fullPath.startsWith('/') ? '/' : '') + resolved.join('/');
  const wsResolved = (wsNorm.startsWith('/') ? '/' : '') + wsNorm.split('/').filter(s => s && s !== '.').join('/');

  return resolvedStr.toLowerCase().startsWith((wsResolved + '/').toLowerCase()) || resolvedStr.toLowerCase() === wsResolved.toLowerCase();
}

// ── File Read / Write / Diff ───────────────────────────────────────────────────
export async function readFile(filePath) {
  if (!filePath) return '';
  if (window.electronAPI?.readFile) {
    try { const r = await window.electronAPI.readFile(filePath); if (r && !r.error) return r.content || ''; } catch(e) {}
  }
  try {
    const res = await fetch(`${getApiBase()}/api/workspace/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath })
    });
    if (res.ok) { const d = await res.json(); return d.content || ''; }
  } catch(e) {}
  return '';
}

export async function writeFile(filePath, content) {
  if (!filePath) return false;
  const { workspaceFolder } = getState();
  if (workspaceFolder && !isPathStrictlyInWorkspace(filePath, workspaceFolder)) {
    console.warn(`[Courtesy Security] Blocked file write outside workspace: ${filePath}`);
    return false;
  }
  emit('workspace:file-saving', { path: filePath });
  if (window.electronAPI?.writeFile) {
    try { const r = await window.electronAPI.writeFile(filePath, content); if (r && !r.error) { emit('workspace:file-saved', { path: filePath }); return true; } } catch(e) {}
  }
  try {
    const res = await fetch(`${getApiBase()}/api/workspace/write`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content })
    });
    if (res.ok) { emit('workspace:file-saved', { path: filePath }); return true; }
  } catch(e) {}
  return false;
}

export async function applyDiff(filePath, target, replacement) {
  if (!filePath) return false;
  const { workspaceFolder } = getState();
  if (workspaceFolder && !isPathStrictlyInWorkspace(filePath, workspaceFolder)) {
    console.warn(`[Courtesy Security] Blocked diff outside workspace: ${filePath}`);
    return false;
  }
  if (window.electronAPI?.applyDiff) {
    try { const r = await window.electronAPI.applyDiff(filePath, target, replacement); if (r && !r.error) { emit('workspace:file-saved', { path: filePath }); return true; } } catch(e) {}
  }
  try {
    const res = await fetch(`${getApiBase()}/api/workspace/apply_diff`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, target, replacement })
    });
    if (res.ok) { emit('workspace:file-saved', { path: filePath }); return true; }
  } catch(e) {}
  return false;
}

// ── Command Execution ──────────────────────────────────────────────────────────
export async function runCommand(command, cwd) {
  const { workspaceFolder } = getState();
  const effectiveCwd = cwd || workspaceFolder;
  if (!effectiveCwd) return { exit_code: -1, stdout: '', stderr: 'No workspace folder set' };
  if (window.electronAPI?.runCommand) {
    try { return await window.electronAPI.runCommand(command, effectiveCwd); }
    catch(e) { return { exit_code: -1, stdout: '', stderr: e.message }; }
  }
  try {
    const res = await fetch(`${getApiBase()}/api/workspace/exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, cwd: effectiveCwd })
    });
    return await res.json();
  } catch(e) { return { exit_code: -1, stdout: '', stderr: e.message }; }
}

// ── Git Status ─────────────────────────────────────────────────────────────────
export async function refreshGitStatus() {
  const { workspaceFolder } = getState();
  if (!workspaceFolder) return;
  try {
    const result = await runCommand('git status --porcelain', workspaceFolder);
    if (result.exit_code !== 0) return;
    const gitStatus = {};
    (result.stdout || '').split('\n').forEach(line => {
      if (!line.trim()) return;
      const code = line.substring(0, 2).trim();
      const file = line.substring(3).trim();
      if (file) gitStatus[file] = code[0] || '?';
    });
    setState({ gitStatus });
    emit('workspace:git-status', { gitStatus });
  } catch(e) {}
}

// ── File Create / Delete / Rename ─────────────────────────────────────────────
export async function createFile(relPath, isDir = false) {
  const { workspaceFolder } = getState();
  const token = sessionStorage.getItem('admin_token') || '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${getApiBase()}/api/workspace/create`, {
    method: 'POST', headers,
    body: JSON.stringify({ path: relPath, is_dir: isDir, folder: workspaceFolder })
  });
  return res.ok ? await res.json() : { success: false, error: `HTTP ${res.status}` };
}

export async function deleteItem(itemPath) {
  const { workspaceFolder } = getState();
  const token = sessionStorage.getItem('admin_token') || '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${getApiBase()}/api/workspace/delete`, {
    method: 'POST', headers,
    body: JSON.stringify({ path: itemPath, folder: workspaceFolder })
  });
  if (res.ok) {
    const files = await getFileList(workspaceFolder);
    setState({ cachedFiles: files, fileTreeData: files });
    emit('workspace:indexed', { folder: workspaceFolder, files });
  }
  return res.ok ? await res.json() : { success: false };
}

export async function renameItem(oldPath, newPath) {
  const { workspaceFolder } = getState();
  const token = sessionStorage.getItem('admin_token') || '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${getApiBase()}/api/workspace/rename`, {
    method: 'POST', headers,
    body: JSON.stringify({ old_path: oldPath, new_path: newPath, folder: workspaceFolder })
  });
  return res.ok ? await res.json() : { success: false };
}

export async function searchWorkspace(query, maxResults = 40) {
  const { workspaceFolder } = getState();
  const res = await fetch(`${getApiBase()}/api/workspace/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, folder: workspaceFolder, max_results: maxResults })
  });
  return res.ok ? await res.json() : { success: false, results: [] };
}
