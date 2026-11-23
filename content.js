/**
 * content.js
 * Orchestrates detector.js + extractor.js and renders Gistly's on-page UI (the
 * floating "Summarize terms" button and the summary card) inside a closed
 * Shadow DOM, so the host page's CSS can't touch it and ours can't leak out.
 *
 * Every piece of text that comes from the page or from an AI response is
 * rendered with textContent -- never innerHTML -- so there is no XSS surface.
 */
(function () {
  'use strict';

  if (window.top !== window.self) return; // top frame only
  if (window.__gistlyLoaded) return;
  window.__gistlyLoaded = true;

  const { scanPage, observe } = window.__gistlyDetector;
  const { extract } = window.__gistlyExtractor;

  const DEFAULT_SETTINGS = { autoDetect: true, autoSummarize: false, theme: 'auto' };
  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let overlayCss = '';
  let currentDetection = null;
  let currentExtraction = null;
  let dismissedForThisAgreement = false;
  let lastNotifiedKind = null;

  let host, shadow, styleEl, fab, card;

  // --- Messaging & settings ----------------------------------------------------

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response);
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  async function loadSettings() {
    const res = await sendMessage({ type: 'GISTLY_GET_SETTINGS' });
    if (res && res.ok) settings = { ...DEFAULT_SETTINGS, ...res.settings };
  }

  // The stylesheet is fetched by the service worker (an extension page can
  // read its own files) and applied inside our shadow root. That way it is
  // never injected into the host page and no web_accessible_resources entry
  // is needed -- which would otherwise let any website detect Gistly.
  async function loadOverlayCss() {
    const res = await sendMessage({ type: 'GISTLY_GET_OVERLAY_CSS' });
    if (res && res.ok) {
      overlayCss = res.css;
      applyCss();
    }
  }

  function applyCss() {
    if (!shadow || !overlayCss) return;
    try {
      // Constructable stylesheets are not blocked by a page's strict CSP,
      // unlike inline <style> elements.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(overlayCss);
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        shadow.prepend(styleEl);
      }
      styleEl.textContent = overlayCss;
    }
    host.style.visibility = '';
  }

  // --- UI shell --------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'gistly-host';
    host.style.all = 'initial';
    host.style.visibility = 'hidden'; // revealed once the stylesheet is in place
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'closed' });

    fab = el('button', 'gistly-fab');
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Summarize this agreement with Gistly');
    fab.appendChild(el('span', 'gistly-mark'));
    fab.appendChild(el('span', 'gistly-fab-label', 'Summarize terms'));
    fab.addEventListener('click', onFabClick);
    shadow.appendChild(fab);

    applyTheme();
    applyCss();
  }

  function applyTheme() {
    if (host) host.setAttribute('data-gistly-theme', settings.theme || 'auto');
  }

  function showFab(kind) {
    ensureUI();
    fab.dataset.kind = kind;
    fab.classList.add('gistly-visible');
  }

  function hideFab() {
    if (fab) fab.classList.remove('gistly-visible');
  }

  // --- Summary card -------------------------------------------------------------------

  function clearCard() {
    if (card) {
      card.remove();
      card = null;
    }
  }

  function renderCard({ loading, result, error }) {
    ensureUI();
    clearCard();

    card = el('div', 'gistly-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Gistly summary');

    const header = el('div', 'gistly-card-header');
    const brand = el('div', 'gistly-card-brand');
    brand.appendChild(el('span', 'gistly-mark gistly-mark--on-paper'));
    const titles = el('div', 'gistly-card-titles');
    titles.appendChild(el('span', 'gistly-card-title', 'Gistly'));
    titles.appendChild(el('span', 'gistly-card-badge',
      result ? (result.source === 'ai' ? 'AI summary' : 'On-device summary') : 'Reading…'));
    brand.appendChild(titles);
    header.appendChild(brand);

    const closeBtn = el('button', 'gistly-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => {
      dismissedForThisAgreement = true;
      clearCard();
    });
    header.appendChild(closeBtn);
    card.appendChild(header);

    const body = el('div', 'gistly-card-body');

    if (loading) {
      body.appendChild(el('div', 'gistly-loading', 'Reading the fine print…'));
    } else if (error) {
      body.appendChild(el('div', 'gistly-error', error));
    } else if (result) {
      if (result.aiError) {
        body.appendChild(el('div', 'gistly-callout',
          `The AI summary didn’t work (${result.aiError}), so this is the on-device summary instead. Check Settings → AI summaries.`));
      }

      body.appendChild(el('div', 'gistly-section-title', 'The gist'));
      const list = el('ul', 'gistly-summary-list');
      (result.summary || []).forEach((point) => list.appendChild(el('li', null, point)));
      body.appendChild(list);

      if (result.importantPoints && result.importantPoints.length > 0) {
        body.appendChild(el('div', 'gistly-section-title', 'Worth knowing'));
        const flags = el('div', 'gistly-callout gistly-callout--flags');
        result.importantPoints.forEach((p) => flags.appendChild(el('div', null, p)));
        body.appendChild(flags);
      }

      const actions = el('div', 'gistly-actions');
      const readBtn = el('button', 'gistly-read-full', 'Show the full text on the page');
      readBtn.type = 'button';
      readBtn.addEventListener('click', () => {
        currentDetection?.element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      actions.appendChild(readBtn);
      body.appendChild(actions);

      body.appendChild(el('div', 'gistly-disclaimer',
        (result.source === 'ai'
          ? 'Written by an AI model from the text on this page. '
          : 'Built on your device by pattern matching, so it can miss things. ') +
        'Not legal advice. Gistly never accepts, rejects or clicks anything for you.'));
    }

    card.appendChild(body);
    shadow.appendChild(card);
  }

  // --- Core flow ------------------------------------------------------------------------

  async function runSummarize() {
    if (!currentDetection) return;
    currentExtraction = extract(currentDetection.element);
    if (!currentExtraction || !currentExtraction.text) {
      renderCard({ error: 'No readable text was found in the detected area.' });
      return;
    }

    renderCard({ loading: true });

    const res = await sendMessage({
      type: 'GISTLY_SUMMARIZE',
      payload: {
        text: currentExtraction.text,
        url: currentExtraction.url,
        title: currentExtraction.title,
      },
    });

    if (res && res.ok) {
      renderCard({ result: res.result });
    } else {
      renderCard({ error: `Couldn’t summarize this: ${(res && res.error) || 'unknown error'}` });
    }
  }

  function onFabClick() {
    if (card) {
      clearCard();
      return;
    }
    runSummarize();
  }

  function onDetection(detection) {
    currentDetection = detection;

    if (!detection) {
      hideFab();
      return;
    }

    if (dismissedForThisAgreement && detection.kind === lastNotifiedKind) {
      return; // dismissed already for this same prompt; don't nag
    }
    if (detection.kind !== lastNotifiedKind) {
      dismissedForThisAgreement = false;
      lastNotifiedKind = detection.kind;
    }

    showFab(detection.kind);
    if (settings.autoSummarize) runSummarize();
  }

  // --- Detection on/off ------------------------------------------------------------------

  function startDetection() {
    if (observer) return;
    onDetection(scanPage());
    observer = observe(onDetection);
  }

  function stopDetection() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    hideFab();
    clearCard();
  }

  function applySettings() {
    applyTheme();
    if (settings.autoDetect) startDetection();
    else stopDetection();
  }

  // Settings changed in the popup or the Settings page apply to every open
  // tab immediately -- no reload, no messaging between pages.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
      applySettings();
    }
  });

  // --- Boot --------------------------------------------------------------------------------

  async function boot() {
    await Promise.all([loadSettings(), loadOverlayCss()]);
    applySettings();
  }

  // Requests from the popup.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
      case 'GISTLY_MANUAL_SCAN': {
        const detection = scanPage();
        onDetection(detection);
        sendResponse({ ok: true, found: !!detection, kind: detection ? detection.kind : null });
        return true;
      }
      case 'GISTLY_EXTRACT_FOR_POPUP': {
        // A plain data request: nothing is rendered on the page, the popup
        // summarizes and shows the result itself.
        if (!currentDetection) currentDetection = scanPage();
        if (!currentDetection) {
          sendResponse({ ok: true, found: false });
          return true;
        }
        currentExtraction = extract(currentDetection.element);
        sendResponse({
          ok: true,
          found: true,
          extraction: currentExtraction && currentExtraction.text
            ? { text: currentExtraction.text, url: currentExtraction.url, title: currentExtraction.title }
            : null,
        });
        return true;
      }
      case 'GISTLY_SCROLL_TO_AGREEMENT': {
        currentDetection?.element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        sendResponse({ ok: true });
        return true;
      }
    }
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }
})();
