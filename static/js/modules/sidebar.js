// Courtesy IDE — Sidebar Module
// Handles sidebar resizing, drag handle, toggle animations, and chat item operations.

import { getState, setState } from './state.js';
import { emit } from './event-bus.js';

let _isDragging = false;
let _startX = 0;
let _startWidth = 256;

export function initSidebar() {
  const sidebar = document.getElementById('ide-sidebar');
  if (!sidebar) return;

  // Restore saved width
  const savedWidth = localStorage.getItem('courtesy_sidebar_width');
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= 160 && w <= 500) {
      sidebar.style.width = `${w}px`;
    }
  }

  // Create drag handle if not already present
  if (!document.getElementById('ide-sidebar-resizer')) {
    const resizer = document.createElement('div');
    resizer.id = 'ide-sidebar-resizer';
    resizer.className = 'absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-black/20 dark:hover:bg-white/20 transition-colors z-30 select-none';
    resizer.title = 'Drag to resize sidebar';
    sidebar.style.position = 'relative';
    sidebar.appendChild(resizer);

    resizer.addEventListener('mousedown', onMouseDown);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseDown(e) {
  _isDragging = true;
  _startX = e.clientX;
  const sidebar = document.getElementById('ide-sidebar');
  _startWidth = sidebar ? sidebar.getBoundingClientRect().width : 256;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onMouseMove(e) {
  if (!_isDragging) return;
  const sidebar = document.getElementById('ide-sidebar');
  if (!sidebar) return;

  const dx = e.clientX - _startX;
  const newWidth = Math.max(180, Math.min(480, _startWidth + dx));
  sidebar.style.width = `${newWidth}px`;
  localStorage.setItem('courtesy_sidebar_width', newWidth.toString());
}

function onMouseUp() {
  if (_isDragging) {
    _isDragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
}
