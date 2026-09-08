// Courtesy IDE — Cross-Module Event Bus
// Modules communicate via events, never by directly calling each other.

const _handlers = {};

export function emit(event, data) {
  (_handlers[event] || []).forEach(fn => {
    try { fn(data); } catch(e) { console.error(`[bus] Error in handler for "${event}":`, e); }
  });
}

export function on(event, handler) {
  if (!_handlers[event]) _handlers[event] = [];
  _handlers[event].push(handler);
  return () => off(event, handler);
}

export function off(event, handler) {
  if (_handlers[event]) {
    _handlers[event] = _handlers[event].filter(h => h !== handler);
  }
}

export function once(event, handler) {
  const wrapper = (data) => { handler(data); off(event, wrapper); };
  on(event, wrapper);
}
