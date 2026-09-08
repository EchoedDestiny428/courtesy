// Courtesy IDE — Telemetry Module
// Provides live cluster node monitoring and a sleek telemetry tray in the IDE.

import { getState } from './state.js';
import { showToast } from './toast.js';

let _isOpen = false;
let _pollTimer = null;
let _currentMetrics = null;

function getApiBase() {
  return window.apiBaseUrl || 'http://100.107.249.92:8000';
}

export function initTelemetry() {
  // Wire connected node badge click in topbar
  const badge = document.getElementById('ide-connected-node');
  if (badge) {
    const parent = badge.closest('div');
    if (parent) {
      parent.classList.add('cursor-pointer', 'hover:border-neutral-400', 'dark:hover:border-neutral-600', 'transition', 'select-none');
      parent.title = 'Click to inspect GPU telemetry & VRAM';
      parent.addEventListener('click', toggleTelemetryTray);
    }
  }

  // Close tray when clicking outside
  document.addEventListener('click', (e) => {
    if (!_isOpen) return;
    const tray = document.getElementById('ide-telemetry-tray');
    const badge = document.getElementById('ide-connected-node');
    const parent = badge ? badge.closest('div') : null;
    if (tray && !tray.contains(e.target) && (!parent || !parent.contains(e.target))) {
      closeTelemetryTray();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _isOpen) {
      closeTelemetryTray();
    }
  });
}

export function toggleTelemetryTray() {
  if (_isOpen) {
    closeTelemetryTray();
  } else {
    openTelemetryTray();
  }
}

export async function openTelemetryTray() {
  _isOpen = true;
  let tray = document.getElementById('ide-telemetry-tray');
  if (!tray) {
    tray = document.createElement('div');
    tray.id = 'ide-telemetry-tray';
    tray.className = 'fixed top-12 left-1/2 -translate-x-1/2 z-50 w-96 rounded-2xl bg-white/95 dark:bg-[#111116]/95 border border-neutral-200 dark:border-neutral-800 shadow-2xl backdrop-blur-xl p-4 text-xs font-mono select-none animate-seq-pop';
    document.body.appendChild(tray);
  } else {
    tray.classList.remove('hidden');
  }

  renderTelemetryLoading(tray);
  await fetchAndRenderActiveTelemetry();

  // Poll while open
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(fetchAndRenderActiveTelemetry, 3500);
}

export function closeTelemetryTray() {
  _isOpen = false;
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  const tray = document.getElementById('ide-telemetry-tray');
  if (tray) tray.classList.add('hidden');
}

function renderTelemetryLoading(tray) {
  const badgeText = document.getElementById('ide-connected-node')?.innerText || 'Active Node';
  tray.innerHTML = `
    <div class="flex items-center justify-between pb-2 border-b border-neutral-100 dark:border-neutral-800/80 mb-3">
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
        <span class="font-bold text-black dark:text-white text-xs">${escapeHtml(badgeText)}</span>
      </div>
      <span class="text-[10px] text-neutral-400">polling telemetry...</span>
    </div>
    <div class="py-4 text-center text-neutral-400 animate-pulse text-xs">
      Loading GPU & VRAM telemetry...
    </div>
  `;
}

async function fetchAndRenderActiveTelemetry() {
  const tray = document.getElementById('ide-telemetry-tray');
  if (!tray || !_isOpen) return;

  const { activeServer } = getState();
  const nodeId = activeServer?.id || window.pinnedNode || 'cst7';

  try {
    const res = await fetch(`${getApiBase()}/api/servers`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const servers = await res.json();
    const current = servers.find(s => s.id === nodeId) || servers.find(s => s.status?.online) || servers[0];
    if (!current) throw new Error('No server found');

    _currentMetrics = current;
    renderTelemetryContent(tray, current);
  } catch(err) {
    if (tray && _isOpen) {
      tray.innerHTML = `
        <div class="flex items-center justify-between pb-2 border-b border-neutral-100 dark:border-neutral-800/80 mb-3">
          <span class="font-bold text-black dark:text-white">${nodeId.toUpperCase()}</span>
          <button onclick="window.closeTelemetryTray && window.closeTelemetryTray()" class="text-neutral-400 hover:text-black dark:hover:text-white">✕</button>
        </div>
        <div class="text-xs text-rose-500 py-2">
          Unable to refresh live metrics: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }
}

function renderTelemetryContent(tray, s) {
  const isOnline = Boolean(s.status?.online);
  const latency = s.status?.latency_ms != null ? `${Math.round(s.status.latency_ms)}ms` : 'offline';
  const gpus = s.status?.gpus || s.specs?.gpus || [];
  const ramTotal = s.status?.ram_total_gb || 32;
  const ramUsed = s.status?.ram_used_gb || 0;
  const ramPct = s.status?.ram_percent || Math.round((ramUsed / (ramTotal || 1)) * 100);
  const cpuPct = s.status?.cpu_percent || 0;

  let totalVramMb = 0;
  let usedVramMb = 0;
  gpus.forEach(g => {
    totalVramMb += (g.vram_total_mb || 5120);
    usedVramMb += (g.vram_used_mb || 0);
  });
  const totalVramGb = (totalVramMb / 1024).toFixed(1);
  const usedVramGb = (usedVramMb / 1024).toFixed(1);
  const vramPct = totalVramMb > 0 ? Math.round((usedVramMb / totalVramMb) * 100) : 0;

  tray.innerHTML = `
    <!-- Header -->
    <div class="flex items-center justify-between pb-2.5 border-b border-neutral-100 dark:border-neutral-800/80 mb-3">
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-rose-500'}"></span>
        <span class="font-bold text-black dark:text-white text-xs">${s.name || s.id} (${s.id})</span>
        <span class="text-[10px] text-neutral-400 px-1.5 py-0.2 rounded bg-neutral-100 dark:bg-neutral-800">${s.host || s.ip}</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="text-[10px] ${isOnline ? 'text-emerald-500' : 'text-neutral-500'}">${latency}</span>
        <button onclick="window.closeTelemetryTray && window.closeTelemetryTray()" class="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded text-neutral-400 hover:text-black dark:hover:text-white transition">
          <i data-lucide="x" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    </div>

    <!-- Dual GPU Cards -->
    <div class="space-y-2 mb-3">
      ${gpus.length > 0 ? gpus.map((gpu, idx) => {
        const u = gpu.util_percent || 0;
        const temp = gpu.temp_c || 35;
        const vUsed = ((gpu.vram_used_mb || 0) / 1024).toFixed(1);
        const vTot = ((gpu.vram_total_mb || 5120) / 1024).toFixed(1);
        const vPct = gpu.vram_percent || Math.round(((gpu.vram_used_mb || 0) / (gpu.vram_total_mb || 5120)) * 100);
        return `
          <div class="p-2.5 rounded-xl bg-neutral-50 dark:bg-neutral-900 border border-neutral-200/70 dark:border-neutral-800/70 space-y-1.5">
            <div class="flex items-center justify-between text-[11px]">
              <span class="font-semibold text-black dark:text-neutral-200 flex items-center gap-1.5">
                <i data-lucide="cpu" class="w-3 h-3 text-neutral-500"></i> GPU ${gpu.index != null ? gpu.index : idx}: ${(gpu.name || 'Quadro').replace(/^NVIDIA\s+/i, '')}
              </span>
              <span class="font-bold ${temp > 75 ? 'text-rose-500' : 'text-neutral-600 dark:text-neutral-400'}">${temp}°C</span>
            </div>
            <div class="flex items-center justify-between text-[10px] text-neutral-500">
              <span>Util: <b class="text-black dark:text-white">${u}%</b></span>
              <span>VRAM: <b class="text-black dark:text-white">${vUsed} / ${vTot} GB</b> (${vPct}%)</span>
            </div>
            <div class="w-full bg-neutral-200 dark:bg-neutral-800 h-1.5 rounded-full overflow-hidden">
              <div class="bg-black dark:bg-white h-full rounded-full transition-all duration-300" style="width: ${vPct}%"></div>
            </div>
          </div>
        `;
      }).join('') : `
        <div class="p-3 text-center text-neutral-400 border border-dashed border-neutral-200 dark:border-neutral-800 rounded-xl">
          Host Controller Node (No discrete GPU)
        </div>
      `}
    </div>

    <!-- System Stats: CPU & RAM -->
    <div class="grid grid-cols-2 gap-2 mb-3 text-[10px]">
      <div class="p-2 rounded-lg bg-neutral-50 dark:bg-neutral-900 border border-neutral-200/50 dark:border-neutral-800/50">
        <span class="text-neutral-400">CPU Usage</span>
        <div class="text-xs font-bold text-black dark:text-white mt-0.5">${cpuPct}%</div>
      </div>
      <div class="p-2 rounded-lg bg-neutral-50 dark:bg-neutral-900 border border-neutral-200/50 dark:border-neutral-800/50">
        <span class="text-neutral-400">RAM Allocation</span>
        <div class="text-xs font-bold text-black dark:text-white mt-0.5">${ramUsed} / ${ramTotal} GB (${ramPct}%)</div>
      </div>
    </div>

    <!-- Actions -->
    <div class="pt-2 border-t border-neutral-100 dark:border-neutral-800/80 flex items-center justify-between">
      <span class="text-[10px] text-neutral-400">Total VRAM: ${usedVramGb} / ${totalVramGb} GB</span>
      <button onclick="window.flushActiveNodeVram && window.flushActiveNodeVram('${s.id}')"
        class="px-2.5 py-1 rounded-lg bg-black dark:bg-white text-white dark:text-black hover:opacity-85 transition text-[11px] font-medium flex items-center gap-1 shadow-xs">
        <i data-lucide="zap" class="w-3 h-3"></i>
        <span>Flush VRAM</span>
      </button>
    </div>
  `;

  if (window.lucide) lucide.createIcons();
}

export async function flushActiveNodeVram(nodeId) {
  showToast(`Flushing VRAM on ${nodeId}...`, { icon: '🧹' });
  try {
    const res = await fetch(`${getApiBase()}/api/servers/${nodeId}/offload`, { method: 'POST' });
    if (res.ok) {
      showToast(`VRAM released on ${nodeId}`, { icon: '⚡', type: 'success' });
      await fetchAndRenderActiveTelemetry();
    } else {
      showToast(`Failed to flush VRAM`, { icon: '⚠', type: 'error' });
    }
  } catch(e) {
    showToast(`Flush error: ${e.message}`, { icon: '⚠', type: 'error' });
  }
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
