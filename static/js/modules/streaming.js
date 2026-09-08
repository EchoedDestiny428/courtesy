// Courtesy IDE — Streaming Engine
// Uses rAF batching so marked.parse() runs at most once per animation frame,
// not on every token. This eliminates jank at high token rates.

export async function streamChat({ url, body, signal, onToken, onDone, onError }) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer courtesy-local'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Inference server responded with HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';
    let tokenCount = 0;
    let startTime = performance.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullText += delta;
              tokenCount++;
              onToken(fullText, tokenCount, startTime);
            }
          } catch(e) { /* skip malformed chunk */ }
        }
      }
    }

    onDone(fullText, tokenCount);
  } catch(err) {
    onError(err);
  }
}

// ── Incremental Markdown Renderer ─────────────────────────────────────
// Wraps a DOM element and renders markdown at rAF rate (≤60fps), never
// per-token. This is the key performance improvement.
export function createMarkdownRenderer(contentEl) {
  let _pendingText = null;
  let _rafId = null;
  let _isRendering = false;

  function _flush() {
    _rafId = null;
    if (_pendingText === null) return;
    const text = _pendingText;
    _pendingText = null;
    _isRendering = true;

    if (window.marked) {
      contentEl.innerHTML = marked.parse(text);
    } else {
      contentEl.textContent = text;
    }

    // Re-highlight any new code blocks
    if (window.hljs) {
      contentEl.querySelectorAll('pre code:not([data-highlighted])').forEach(block => {
        hljs.highlightElement(block);
        block.dataset.highlighted = 'true';
      });
    }
    _isRendering = false;
  }

  return {
    update(text) {
      _pendingText = text;
      if (!_rafId) {
        _rafId = requestAnimationFrame(_flush);
      }
    },
    flush() {
      if (_rafId) cancelAnimationFrame(_rafId);
      _flush();
    },
    destroy() {
      if (_rafId) cancelAnimationFrame(_rafId);
    }
  };
}

// ── Token Speed Counter ────────────────────────────────────────────────
export function calcTokensPerSecond(tokenCount, startTime) {
  const elapsedSec = (performance.now() - startTime) / 1000;
  return elapsedSec > 0.1 ? Math.round(tokenCount / elapsedSec) : 0;
}