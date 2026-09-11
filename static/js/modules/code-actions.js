// Courtesy IDE — Code Block Action Headers & Permission Control
// Enforces workspace-only file additions/modifications and per-conversation permission gating.

import { showToast } from './toast.js';
import { writeFile, isPathStrictlyInWorkspace } from './workspace.js';
import { getState } from './state.js';

export function enhanceCodeBlocks(container) {
  if (!container) return;
  const preElements = container.querySelectorAll('pre:not([data-enhanced])');

  preElements.forEach(pre => {
    pre.setAttribute('data-enhanced', 'true');
    const code = pre.querySelector('code');
    if (!code) return;

    // Detect language from class (e.g. language-python)
    const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
    const lang = langClass ? langClass.replace('language-', '') : 'code';

    // Extract raw text
    const text = code.innerText || '';
    const lines = text.split('\n');

    // Detect filename from top lines comment, e.g.
    // // filename: app.js, # filename: main.py, /* filename: index.html */, <!-- filename: ui.html -->
    let filename = null;
    let filenameLineIndex = -1;
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      const match = lines[i].match(/^(?:\/\/|#|\/\*|<!--)\s*(?:filename|filepath|file):\s*([^\s*]+)/i);
      if (match) {
        filename = match[1].trim();
        filenameLineIndex = i;
        break;
      }
    }

    const { workspaceFolder, workspaceChats, activeChatId } = getState();
    const activeChat = (workspaceChats || []).find(c => c.id === activeChatId) ||
                       (typeof window.getActiveChat === 'function' ? window.getActiveChat() : null);
    const skipWritePermissions = Boolean(activeChat?.settings?.skipWritePermissions);

    // Verify path sandboxing strictly within workspace
    const isSandboxed = filename && workspaceFolder ? isPathStrictlyInWorkspace(filename, workspaceFolder) : false;
    const isOutsideWorkspace = filename && workspaceFolder && !isSandboxed;

    // Build header bar
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between px-3 py-1.5 bg-neutral-100 dark:bg-neutral-800/90 border-b border-neutral-200 dark:border-neutral-700/80 rounded-t-xl text-[11px] font-mono select-none text-neutral-600 dark:text-neutral-300';

    let badgesHtml = `<span class="font-semibold text-black dark:text-white uppercase tracking-wider text-[10px]">${escapeHtml(lang)}</span>`;

    if (filename) {
      badgesHtml += `<span class="px-1.5 py-0.2 rounded bg-neutral-200 dark:bg-neutral-700 text-[10px] font-mono text-neutral-700 dark:text-neutral-200">${escapeHtml(filename)}</span>`;

      if (isOutsideWorkspace) {
        badgesHtml += `<span class="px-1.5 py-0.2 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 text-[9px] font-mono flex items-center gap-1" title="Security: Target path escapes workspace"><i data-lucide="shield-alert" class="w-2.5 h-2.5"></i> Outside Workspace</span>`;
      } else if (skipWritePermissions) {
        badgesHtml += `<span class="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 text-[9px] font-mono flex items-center gap-1" title="Auto-approve file writes enabled for this conversation"><i data-lucide="zap" class="w-2.5 h-2.5"></i> Auto-Write</span>`;
      } else {
        badgesHtml += `<span class="px-1.5 py-0.2 rounded bg-neutral-200/70 dark:bg-neutral-700/70 text-neutral-600 dark:text-neutral-300 text-[9px] font-mono flex items-center gap-1" title="Permission required to write"><i data-lucide="shield" class="w-2.5 h-2.5"></i> Protected</span>`;
      }
    }

    let actionsHtml = '';
    if (filename && isSandboxed && skipWritePermissions) {
      actionsHtml += `
        <button class="btn-apply-code flex items-center gap-1 text-[10px] hover:text-black dark:hover:text-white transition" title="Apply directly to ${escapeHtml(filename)}">
          <i data-lucide="file-check" class="w-3 h-3"></i> Apply
        </button>
      `;
    }

    actionsHtml += `
      <button class="btn-copy-code flex items-center gap-1 text-[10px] hover:text-black dark:hover:text-white transition" title="Copy code">
        <i data-lucide="copy" class="w-3 h-3"></i> Copy
      </button>
    `;

    header.innerHTML = `
      <div class="flex items-center gap-1.5 min-w-0">
        ${badgesHtml}
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        ${actionsHtml}
      </div>
    `;

    // Wrap pre in card styling
    pre.classList.add('rounded-b-xl', 'rounded-t-none', 'mt-0', 'border-t-0');
    pre.parentNode.insertBefore(header, pre);

    // Security warning banner if path is outside workspace
    if (filename && isOutsideWorkspace) {
      const warnBanner = document.createElement('div');
      warnBanner.className = 'flex items-center gap-2 px-3 py-1.5 bg-rose-500/10 border-b border-rose-500/20 text-[10px] font-mono text-rose-700 dark:text-rose-400 select-none';
      warnBanner.innerHTML = `
        <i data-lucide="shield-alert" class="w-3.5 h-3.5 flex-shrink-0"></i>
        <span>Security Notice: AI modification blocked. "${escapeHtml(filename)}" is outside active workspace folder.</span>
      `;
      pre.parentNode.insertBefore(warnBanner, pre);
    }

    // Permission Prompt Card if protected write is required (default behavior)
    let permCard = null;
    if (filename && isSandboxed && !skipWritePermissions) {
      permCard = document.createElement('div');
      permCard.className = 'permission-request-card flex items-center justify-between px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 text-[11px] font-mono select-none';
      permCard.innerHTML = `
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse flex-shrink-0"></span>
          <span class="text-neutral-700 dark:text-neutral-300 truncate text-[10px]">
            Courtesy requests permission to write <b class="text-black dark:text-white font-mono">${escapeHtml(filename)}</b>
          </span>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <button class="btn-allow-write px-2 py-0.8 rounded-lg bg-black dark:bg-white text-white dark:text-black hover:bg-neutral-800 dark:hover:bg-neutral-200 text-[10px] font-medium transition flex items-center gap-1 shadow-xs">
            <i data-lucide="check" class="w-3 h-3"></i> Allow
          </button>
          <button class="btn-deny-write px-2 py-0.8 rounded-lg hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-500 hover:text-rose-600 text-[10px] transition">
            Deny
          </button>
        </div>
      `;
      pre.parentNode.insertBefore(permCard, pre);

      // Wire Allow button
      const allowBtn = permCard.querySelector('.btn-allow-write');
      if (allowBtn) {
        allowBtn.addEventListener('click', async () => {
          allowBtn.disabled = true;
          allowBtn.innerHTML = `<span class="w-2 h-2 rounded-full border-2 border-current border-t-transparent animate-spin mr-1"></span> Writing...`;
          const ok = await executeFileWrite(filename, text, filenameLineIndex);
          if (ok) {
            permCard.innerHTML = `
              <div class="flex items-center justify-between w-full text-[10px] font-mono text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded">
                <div class="flex items-center gap-1.5">
                  <i data-lucide="check-circle-2" class="w-3 h-3"></i>
                  <span>Written into <b>${escapeHtml(filename)}</b></span>
                </div>
                <span class="text-[9px] text-neutral-400">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            `;
            if (window.lucide) lucide.createIcons();
            showToast(`Written to ${filename}`, { icon: '✓', type: 'success' });
            if (typeof window.loadWorkspaceFileTree === 'function') window.loadWorkspaceFileTree();
          } else {
            allowBtn.disabled = false;
            allowBtn.innerText = 'Retry';
            showToast(`Failed to write to ${filename}`, { icon: '❌', type: 'error' });
          }
        });
      }

      // Wire Deny button
      const denyBtn = permCard.querySelector('.btn-deny-write');
      if (denyBtn) {
        denyBtn.addEventListener('click', () => {
          permCard.innerHTML = `
            <div class="flex items-center gap-1.5 text-[10px] font-mono text-neutral-400">
              <i data-lucide="x-circle" class="w-3 h-3"></i>
              <span>Write request declined for ${escapeHtml(filename)}</span>
            </div>
          `;
          if (window.lucide) lucide.createIcons();
          showToast(`Write declined for ${filename}`, { icon: '🛡️', type: 'info' });
        });
      }
    }

    // Wire Copy Button
    const copyBtn = header.querySelector('.btn-copy-code');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        let codeToCopy = text;
        if (filenameLineIndex >= 0) {
          codeToCopy = lines.filter((_, idx) => idx !== filenameLineIndex).join('\n');
        }
        navigator.clipboard.writeText(codeToCopy);
        showToast('Code copied to clipboard', { icon: '📋', type: 'success' });
      });
    }

    // Wire Direct Apply Button (for Auto-write mode)
    const applyBtn = header.querySelector('.btn-apply-code');
    if (applyBtn && filename && isSandboxed) {
      applyBtn.addEventListener('click', async () => {
        applyBtn.disabled = true;
        const originalHtml = applyBtn.innerHTML;
        applyBtn.innerHTML = `<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i> Writing...`;
        if (window.lucide) lucide.createIcons();

        const ok = await executeFileWrite(filename, text, filenameLineIndex);
        if (ok) {
          applyBtn.innerHTML = `<i data-lucide="check" class="w-3 h-3"></i> Applied`;
          if (window.lucide) lucide.createIcons();
          showToast(`Applied code to ${filename}`, { icon: '✓', type: 'success' });
          if (typeof window.loadWorkspaceFileTree === 'function') window.loadWorkspaceFileTree();
          setTimeout(() => {
            applyBtn.disabled = false;
            applyBtn.innerHTML = originalHtml;
            if (window.lucide) lucide.createIcons();
          }, 3000);
        } else {
          applyBtn.disabled = false;
          applyBtn.innerHTML = originalHtml;
          showToast(`Failed to apply to ${filename}`, { icon: '❌', type: 'error' });
        }
      });
    }
  });

  if (window.lucide) lucide.createIcons();
}

async function executeFileWrite(filename, rawText, filenameLineIndex) {
  const { workspaceFolder } = getState();
  const ws = workspaceFolder || (typeof window.currentWorkspaceFolder !== 'undefined' ? window.currentWorkspaceFolder : '');
  if (!ws) {
    showToast('Open a workspace folder first to modify files', { icon: '📁', type: 'warning' });
    return false;
  }

  if (!isPathStrictlyInWorkspace(filename, ws)) {
    showToast(`Blocked write outside workspace: ${filename}`, { icon: '🛡️', type: 'error' });
    return false;
  }

  let codeToWrite = rawText;
  if (filenameLineIndex >= 0) {
    const lines = rawText.split('\n');
    codeToWrite = lines.filter((_, idx) => idx !== filenameLineIndex).join('\n');
  }

  const cleanWs = ws.replace(/\\/g, '/').replace(/\/+$/, '');
  const cleanRel = filename.replace(/\\/g, '/').replace(/^\/+/, '');
  const targetPath = `${cleanWs}/${cleanRel}`;

  return await writeFile(targetPath, codeToWrite);
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

