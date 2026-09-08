// Courtesy IDE — Toast Notification System

const MAX_TOASTS = 3;
const TOAST_DURATION = 2600;

const typeConfig = {
  success: { icon: '✓', cls: 'toast-success' },
  error:   { icon: '✕', cls: 'toast-error' },
  warning: { icon: '⚠', cls: 'toast-warning' },
  info:    { icon: 'ℹ', cls: 'toast-info' },
  default: { icon: '⚡', cls: 'toast-default' }
};

let _queue = [];

export function showToast(message, options = {}) {
  // options: { type, icon, duration, action: { label, onClick }, persistent }
  const container = document.getElementById('toast-container');
  if (!container) return;

  // Limit visible toasts
  const visibleToasts = container.querySelectorAll('.toast-msg');
  if (visibleToasts.length >= MAX_TOASTS) {
    // Remove oldest
    visibleToasts[0].remove();
  }

  const type = options.type || 'default';
  const cfg = typeConfig[type] || typeConfig.default;
  const icon = options.icon || cfg.icon;
  const duration = options.duration || TOAST_DURATION;

  const toast = document.createElement('div');
  toast.className = `toast-msg ${cfg.cls}`;

  let actionHtml = '';
  if (options.action) {
    actionHtml = `<button class="toast-action-btn" onclick="this.closest('.toast-msg')._actionFn && this.closest('.toast-msg')._actionFn()">${options.action.label}</button>`;
  }

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-text">${message}</span>
    ${actionHtml}
    ${options.persistent ? `<button class="toast-close" onclick="this.closest('.toast-msg').remove()">×</button>` : ''}
  `;

  if (options.action?.onClick) {
    toast._actionFn = options.action.onClick;
  }

  container.appendChild(toast);

  if (!options.persistent) {
    setTimeout(() => {
      if (!toast.isConnected) return;
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px) scale(0.95)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  return toast;
}

// Typed convenience helpers
export const toast = {
  success: (msg, opts = {}) => showToast(msg, { ...opts, type: 'success' }),
  error:   (msg, opts = {}) => showToast(msg, { ...opts, type: 'error' }),
  warning: (msg, opts = {}) => showToast(msg, { ...opts, type: 'warning' }),
  info:    (msg, opts = {}) => showToast(msg, { ...opts, type: 'info' }),
};
