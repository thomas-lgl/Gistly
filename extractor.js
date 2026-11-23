/**
 * extractor.js
 * Pulls clean, relevant legal text out of a detected container, skipping
 * nav/ads/buttons/hidden content and capping length before anything is
 * sent anywhere for summarization.
 *
 * Exposes `window.__gistlyExtractor.extract(element)` -> { title, url, text, truncated, length }
 *
 * How it works: it walks the container's DOM in order, collecting *every*
 * visible text node and starting a new line at block-level boundaries
 * (p, div, li, td, br, ...). It deliberately does NOT pick text out of a
 * fixed list of tags -- real-world consent banners and policy pages put
 * their text in <div>/<span> wrappers with inline links, and a tag
 * whitelist silently drops all of it.
 */
(function () {
  'use strict';

  const MAX_CHARS = 12000; // cap sent-to-summarizer text to control token usage
  const COLLECT_LIMIT = MAX_CHARS * 2; // stop walking huge pages early

  // Elements whose text is never part of the legal content itself.
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'svg', 'iframe', 'canvas', 'template',
    'nav', 'footer', 'button', 'input', 'select', 'textarea', 'option',
    'object', 'embed', 'video', 'audio', 'img', 'picture',
  ]);

  // Elements that start/end a line of text.
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'br', 'dd', 'details',
    'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'form',
    'header', 'hr', 'label', 'legend', 'li', 'main', 'ol', 'p', 'pre',
    'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
    'tr', 'ul',
  ]);

  const NOISE_SELECTOR = '.advertisement, .ad, .ads, .social-share, .breadcrumbs';

  function isSkippable(el, tag) {
    if (SKIP_TAGS.has(tag)) return true;
    if (el.id === 'gistly-host') return true; // never read our own UI
    if (el.hidden) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.getAttribute('role') === 'button') return true;
    try {
      if (el.matches(NOISE_SELECTOR)) return true;
    } catch (e) {
      /* ignore selector issues */
    }
    // Chrome 105+: skips display:none / visibility:hidden subtrees so that
    // hidden "vendor list" accordions etc. don't flood the text.
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility()) return true;
      } catch (e) {
        /* ignore */
      }
    }
    return false;
  }

  function dedupeLines(lines) {
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      const key = line.toLowerCase();
      if (line.length > 3 && seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  }

  function extract(element) {
    if (!element) return null;

    const lines = [];
    let current = '';
    let total = 0;
    let hitLimit = false;

    function flush() {
      const t = current.replace(/[\s\u00a0]+/g, ' ').trim();
      current = '';
      if (t.length > 1) {
        lines.push(t);
        total += t.length + 1;
      }
    }

    function walk(node) {
      if (hitLimit) return;
      if (node.nodeType === 3) {
        current += node.nodeValue;
        return;
      }
      if (node.nodeType !== 1) return;

      const tag = node.tagName.toLowerCase();
      if (node !== element && isSkippable(node, tag)) return;

      if (/^h[1-6]$/.test(tag)) {
        flush();
        const t = (node.textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
        if (t) {
          lines.push('### ' + t);
          total += t.length + 5;
        }
        return;
      }

      const block = BLOCK_TAGS.has(tag);
      if (block) flush();

      for (let child = node.firstChild; child; child = child.nextSibling) {
        walk(child);
        if (hitLimit) return;
      }
      // Open shadow roots (closed ones are unreachable by design).
      if (node.shadowRoot) {
        for (let child = node.shadowRoot.firstChild; child; child = child.nextSibling) {
          walk(child);
          if (hitLimit) return;
        }
      }

      if (block) flush();
      if (total > COLLECT_LIMIT) hitLimit = true;
    }

    walk(element);
    flush();

    let text = dedupeLines(lines).join('\n');
    let truncated = hitLimit;
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      truncated = true;
    }

    return {
      title: document.title || '',
      url: location.href,
      text,
      truncated,
      length: text.length,
    };
  }

  window.__gistlyExtractor = { extract, MAX_CHARS };
})();
