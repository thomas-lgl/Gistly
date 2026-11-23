/**
 * background/service-worker.js
 *  - Owns all network access (the optional AI summary call).
 *  - Owns the settings in chrome.storage.
 *  - Paints the Gistly logo onto the toolbar icon at runtime.
 *  - Never contains an API key. See README "AI summaries".
 *
 * Messages (from the popup, the Settings page and the content script):
 *   GISTLY_GET_SETTINGS | GISTLY_SET_SETTINGS | GISTLY_RESET_SETTINGS
 *   GISTLY_SUMMARIZE        { payload: { text, url, title } }
 *   GISTLY_TEST_AI          (sends a tiny sample through the configured endpoint)
 *   GISTLY_GET_OVERLAY_CSS  (stylesheet text for the on-page UI)
 */

import { localSummarize, buildAIRequest, parseAIResponse } from '../summarizer.js';

const DEFAULT_SETTINGS = {
  autoDetect: true,
  autoSummarize: false,   // wait for a click by default
  aiEnabled: false,       // AI is opt-in; the on-device summarizer works out of the box
  apiEndpoint: '',        // your own proxy address (see README "AI summaries")
  summaryLength: 'standard',
  theme: 'auto',
};

const FETCH_TIMEOUT_MS = 20000;

const TEST_TEXT =
  'We collect your email address and IP address to create your account and to show you ads. ' +
  'We share this information with advertising partners. Your subscription renews automatically every month.';

// --- Branded toolbar icon -------------------------------------------------
//
// Chrome refuses to load an unpacked extension whose manifest points at icon
// files that are missing, and a repository can't guarantee binary files
// survive every way of obtaining it. So the logo is embedded here (128px PNG,
// base64, about 1.3 KB) and painted onto the toolbar icon at runtime with
// chrome.action.setIcon(), which takes raw pixels. No file on disk is
// involved, so the logo always appears.

const LOGO_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAAwFBMVEUSIjv82A3c3N0TIDyQlqO5vcoOGTD97qJXYXURJEIAAP9vd4iKex+xmhpiXCe+wsrRsgv/62MADEU+Qjp4gJAUIT3+/v4AAAAIFTMXJEATID0PHTvX2eGJkJ44Q1oJGUKnrLYkMEoAAFXx0jLj5ez/9oEkLDBsYhcAAD4TIDzDxs4APT0TIDwTIDwhLUcAAH8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABr7soRAAAAMHRSTlMk//9T///y//8cAf/////////////+/wD//tcR////////A///////BK7/BHCM/wId3SntAAADxUlEQVR42u2b6XKbMBSFxRJwtiZpK2shqW3stIjFvP/bVdg4ZhFYGEnudHRm8if2cD9fXYRmOAegGwtYgJHPyiSL51eIs6S8BiCOVf7O4asNACTV371XMEZnirHCA6C+pCwAx428gkLCBWfqcA3KPHC4rBQA/x7I6fzSbQxYAGEX+gAlAgVUWr1mOCBcBOA/P9dR/oiQ99cBdIcPME3lDwgMoGwMIEOAaqxfNcHrDAJo1/egduVtAtDqv4H6kOStVQCm6x8IEhFAjAA0I+I17oUzQHkPjQkIOhAjRkzVJ/T8mAVf9T1irgN8DOIOQBlBowKdDsSoICbrE3ZqwYkkGti48CRNakHcAEhQLmoAxmQzSVAagRQtAHEDMPHd3VJeu2W6x2TiFIDhWwDv3eVU3UkTnHZkcFwBwQgSvJ5cf+dKE/AxLM9LkFFBAzbLKwB28j0AjRkQPQXwrysA3uUJ6icCOB4DiCoAeQIOkH0BFOoApAn4ECQ1gPg5dC2ALAGh6KEGKFGgEkCWgDaGkEKVALIEkTYASQKNAHIEOgGkCLQCyBDoBTgS3BKgIthgwwBd+aOLMAlg7X9clO93jy9rZQCLQOZIGJBUE8A6IFLCC00AvuQhozs3ygBSyRN38FPXDPh7KYCFtiFcLt33y+qd4VUCXCUL8P8AhM7W2Q6q+vAt1AkQOs/B7zF9cxwn1AfgOq+rUeHvT5xAH0DoPK0ubMGBuAXKAJ4vAKyqNXD1zcDW+TG+Bqtnx9lqHELXcZ7+jOmV13e17gOfb5+jCkO7E1oA3QB+71jupyYBhMdy3xyALzqWQ+iaAxBdiOAXYwApFtXf78zNwIdgBPZ3Ju8C9yXtym5EFsACWAALYAEsgAWwABbAAlgAC6AOQJ2BYRLA2cCgzsIxBaBh4RgwsWzmA4y97qsNdcM2Hojd2QCPYwD5l41HbGTqvQadrhTLGZnEVi7egseZ9cff3oOmm05saMWbR1/irfnAq/TF6OvWlpltYAj4KsySvJ0PDXqayQzJeGjOlk6zntaGq/VkagXQsNqm1n/A1oui2zSgYe3OTVq7i561m/+DmiOgUSwIOIAbLEA74OCZWoBm0KUV8TAzBnwAkqGQiwmCdv12zIcTmLwBhEEnD2puQt4Je3WiXpqjVoSCbuKuH3ZLCn1htyLqJf6ECTymJ+7HAEKlZOCxgMoDj0ycuRRGPjlmlDMlic8688ny6teX0qHX8nBe9XJG6extn7Lcu68aW06L/dZh4TKaqYdzjHdy8DnOlGSPxy9js+c3B/gLUiWU4q+wt/AAAAAASUVORK5CYII=';

async function setBrandedIcon() {
  try {
    const res = await fetch(`data:image/png;base64,${LOGO_BASE64}`);
    const bitmap = await createImageBitmap(await res.blob());
    const imageData = {};
    for (const size of [16, 32, 48, 128]) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, size, size);
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    await chrome.action.setIcon({ imageData });
  } catch (e) {
    // Non-fatal: the extension works fine with Chrome's default icon.
    console.warn('[Gistly] Could not set the toolbar icon:', e.message);
  }
}

setBrandedIcon();
chrome.runtime.onStartup.addListener(setBrandedIcon);

// --- Settings ----------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function setSettings(partial) {
  const next = { ...(await getSettings()), ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('settings');
  if (!existing.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
});

// --- Summarizing ----------------------------------------------------------------

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the endpoint took too long to answer')), ms)),
  ]);
}

async function hasHostPermission(endpoint) {
  try {
    return await chrome.permissions.contains({ origins: [`${new URL(endpoint).origin}/*`] });
  } catch (e) {
    return false;
  }
}

/**
 * Calls the configured AI endpoint: your own small proxy that holds the real
 * API key (see proxy/cloudflare-worker.js). The extension never sees a key.
 * Every failure is thrown with a plain-language reason so Settings and the
 * summary card can show exactly what to fix.
 */
async function callAI(payload, settings) {
  if (!settings.apiEndpoint) throw new Error('no endpoint is saved in Settings');
  if (!(await hasHostPermission(settings.apiEndpoint))) {
    throw new Error('Gistly hasn’t been allowed to contact that address. Press “Save endpoint” again and choose Allow');
  }

  let res;
  try {
    res = await withTimeout(
      fetch(settings.apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAIRequest({ ...payload, length: settings.summaryLength })),
      }),
      FETCH_TIMEOUT_MS
    );
  } catch (e) {
    throw new Error(`couldn’t reach the endpoint (${e.message}). Check the address`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.error || '';
    } catch (e) { /* the body wasn't JSON */ }
    const hint =
      res.status === 401 ? '. The API key on your proxy was rejected'
      : res.status === 403
        ? (/allowed Gistly extension/.test(String(detail))
            ? '. Your proxy is locked to a different extension ID; check its ALLOWED_ORIGIN secret'
            : '. The API key on your proxy isn’t allowed to do this')
      : res.status === 404 ? '. Wrong address; it should look like https://something.workers.dev'
      : res.status === 429 ? '. Rate limit reached, try again shortly'
      : '';
    throw new Error(`the endpoint answered ${res.status}${typeof detail === 'string' && detail ? ` (${detail})` : ''}${hint}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('the endpoint didn’t return JSON. Is it the Gistly proxy?');
  }
  const block = Array.isArray(data.content) ? data.content.find((b) => b.type === 'text') : null;
  if (!block || !block.text) throw new Error('the endpoint returned no text. Is it the Gistly proxy?');

  try {
    return parseAIResponse(block.text);
  } catch (e) {
    throw new Error('the AI answered in an unexpected format');
  }
}

async function summarize(payload) {
  const settings = await getSettings();

  if (settings.aiEnabled && settings.apiEndpoint) {
    try {
      return await callAI(payload, settings);
    } catch (err) {
      console.warn('[Gistly] AI summary failed, using the on-device summary:', err.message);
      const fallback = localSummarize({ ...payload, length: settings.summaryLength });
      fallback.aiError = err.message; // shown in the UI, so a bad setup is never silent
      return fallback;
    }
  }
  return localSummarize({ ...payload, length: settings.summaryLength });
}

// --- Message router ----------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'GISTLY_GET_SETTINGS':
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case 'GISTLY_SET_SETTINGS':
          sendResponse({ ok: true, settings: await setSettings(message.settings || {}) });
          break;
        case 'GISTLY_RESET_SETTINGS':
          await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
          sendResponse({ ok: true, settings: DEFAULT_SETTINGS });
          break;
        case 'GISTLY_SUMMARIZE':
          sendResponse({ ok: true, result: await summarize(message.payload) });
          break;
        case 'GISTLY_TEST_AI': {
          try {
            const settings = await getSettings();
            const result = await callAI(
              { text: TEST_TEXT, url: 'https://example.com', title: 'Gistly connection test' },
              settings
            );
            sendResponse({ ok: true, sample: result.summary[0] || '' });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
          break;
        }
        case 'GISTLY_GET_OVERLAY_CSS': {
          const res = await fetch(chrome.runtime.getURL('styles/overlay.css'));
          sendResponse({ ok: true, css: await res.text() });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keep the channel open for the async response
});
