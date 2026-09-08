// Courtesy IDE — Code Block Action Headers
// Enhances rendered Markdown code blocks with language pills, filename tags,
// copy buttons, and "Apply to File" integration.

import { showToast } from './toast.js';
import { writeFile } from './workspace.js';
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

    // Check first lines for filename header comment, e.g. // filename: app.js or # filename: main.py
    const text = code.innerText || '';
    const firstLine = text.split('\n')[0] || '';
    const fileMatch = firstLine.match(/^(?:\/\/|#|\/\*|<!--)\s*filename:\s*([^\s*]+)/i);
    const filename = fileMatch ? fileMatch[1].trim() : null;

    // Build header bar
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between px-3 py-1.5 bg-neutral-100 dark:bg-neutral-800/90 border-b border-neutral-200 dark:border-neutral-700/80 rounded-t-xl text-[11px] font-mono select-none text-neutral-600 dark:text-neutral-300';
    
    header.innerHTML = `
      <div class="flex items-center gap-1.5">
        <span class="font-semibold text-black dark:text-white uppercase tracking-wider text-[10px]">${lang}</span>
        ${filename ? `<span class="px-1.5 py-0.2 rounded bg-neutral-200 dark:bg-neutral-700 text-[10px] font-mono text-neutral-700 dark:text-neutral-200">${escapeHtml(filename)}</span>` : ''}
      </div>
      <div class="flex items-center gap-2">
        ${filename ? `
          <button class="btn-apply-code flex items-center gap-1 text-[10px] hover:text-black dark:hover:text-white transition" title="Apply to ${escapeHtml(filename)}">
            <i data-lucide="file-check" class="w-3 h-3"></i> Apply
          </button>
        ` : ''}
        <button class="btn-copy-code flex items-center gap-1 text-[10px] hover:text-black dark:hover:text-white transition" title="Copy code">
          <i data-lucide="copy" class="w-3 h-3"></i> Copy
        </button>
      </div>
    `;

    // Wrap pre in card
    pre.classList.add('rounded-b-xl', 'rounded-t-none', 'mt-0', 'border-t-0');
    pre.parentNode.insertBefore(header, pre);

    // Copy action
    const copyBtn = header.querySelector('.btn-copy-code');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        // Strip the first filename line if it was just a filename tag
        let codeToCopy = text;
        if (fileMatch) {
          codeToCopy = text.substring(firstLine.length).replace(/^\n/, '');
        }
        navigator.clipboard.writeText(codeToCopy);
        showToast('Code copied to clipboard', { icon: '📋', type: 'success' });
      });
    }

    // Apply action
    const applyBtn = header.querySelector('.btn-apply-code');
    if (applyBtn && filename) {
      applyBtn.addEventListener('click', async () => {
        const { workspaceFolder } = getState();
        if (!workspaceFolder) {
          showToast('Open a workspace folder first to apply files', { icon: '📁', type: 'warning' });
          return;
        }

        let codeToWrite = text;
        if (fileMatch) {
          codeToWrite = text.substring(firstLine.length).replace(/^\n/, '');
        }

        const targetPath = `${workspaceFolder}/${filename}`.replace(/\\/g, '/');
        const ok = await writeFile(targetPath, codeToWrite);
        if (ok) {
          showToast(`Applied code to ${filename}`, { icon: '✓', type: 'success' });
          if (typeof window.loadWorkspaceFileTree === 'function') window.loadWorkspaceFileTree();
        } else {
          showToast(`Failed to apply to ${filename}`, { icon: '❌', type: 'error' });
        }
      });
    }
  });

  if (window.lucide) lucide.createIcons();
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
