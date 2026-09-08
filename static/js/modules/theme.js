// Courtesy IDE — Theme System
import { setState, subscribe } from './state.js';

export function initTheme() {
  // Read from unified single key, with fallback to old keys
  const saved = localStorage.getItem('courtesy_theme')
    || localStorage.getItem('courtesy_minimal_theme')
    || localStorage.getItem('courtesy-theme')
    || 'light';
  applyTheme(saved, false);

  // Listen for OS preference changes (only if user hasn't set a preference)
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', (e) => {
    const userPref = localStorage.getItem('courtesy_theme_user_set');
    if (!userPref) applyTheme(e.matches ? 'dark' : 'light', false);
  });
}

export function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark', true);
}

export function applyTheme(theme, userInitiated = false) {
  const isDark = theme === 'dark';
  const html = document.documentElement;

  html.classList.toggle('dark', isDark);
  html.classList.toggle('light', !isDark);

  // Update meta
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = theme;

  // Update all theme-toggle icons
  document.querySelectorAll('.theme-toggle-icon').forEach(el => {
    el.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
  });

  // Swap highlight.js theme
  const hljsLink = document.getElementById('hljs-theme');
  if (hljsLink) {
    hljsLink.href = isDark
      ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
  }

  // Persist to single canonical key (plus legacy keys for backward compat)
  localStorage.setItem('courtesy_theme', theme);
  localStorage.setItem('courtesy_minimal_theme', theme);
  localStorage.setItem('courtesy-theme', theme);
  if (userInitiated) localStorage.setItem('courtesy_theme_user_set', '1');

  setState({ theme });
  if (window.lucide) lucide.createIcons();
}
