// tests/ui-tests.mjs
//
// Everything that needs a browser-extension environment -- the popup, the
// Settings page, the content script, the service worker and the AI proxy --
// exercised in jsdom / Node against a mocked chrome.* API. This can't replace
// loading the extension in real Chrome (see README, "Testing"), but it does
// catch wrong element IDs, broken state transitions, unhandled error paths and
// proxy mistakes before they ever reach a browser.

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const sleep = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
// Objects created by code running inside jsdom live in another JS realm, so strict
// deepEqual (which compares prototypes) needs plain JSON copies.
const plain = (v) => JSON.parse(JSON.stringify(v));
const fileUrl = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const { localSummarize } = await import(fileUrl('summarizer.js'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  - ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

const COOKIE_TEXT = [
  'We and our partners use cookies and similar technologies to store and access information on your device, such as your IP address and unique device identifiers.',
  'We use this data to personalize ads and content, and to measure traffic and improve our service.',
].join('\n');

const AI_401 = 'the endpoint answered 401 (invalid x-api-key). The API key on your proxy was rejected';

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

async function openPopup({ url = 'https://shop.example/signup', settings = {}, scan = { ok: true, found: true, kind: 'cookie' }, tabFails = false, summarizeResult } = {}) {
  const dom = new JSDOM(read('popup/popup.html'), { runScripts: 'outside-only', url: 'chrome-extension://test/popup/popup.html' });
  const { window } = dom;
  const log = { runtime: [], tab: [], calls: [] };
  const store = { autoDetect: true, aiEnabled: false, apiEndpoint: '', theme: 'light', ...settings };

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`,
      openOptionsPage: () => log.calls.push('openOptionsPage'),
      sendMessage(msg, cb) {
        log.runtime.push(msg);
        setTimeout(() => {
          if (msg.type === 'GISTLY_GET_SETTINGS') cb({ ok: true, settings: { ...store } });
          else if (msg.type === 'GISTLY_SET_SETTINGS') { Object.assign(store, msg.settings); cb({ ok: true, settings: { ...store } }); }
          else if (msg.type === 'GISTLY_SUMMARIZE') cb({ ok: true, result: summarizeResult || localSummarize({ text: msg.payload.text }) });
          else cb({ ok: false, error: `unexpected ${msg.type}` });
        }, 0);
      },
    },
    tabs: {
      query: async () => [{ id: 7, url }],
      sendMessage(tabId, msg, cb) {
        log.tab.push(msg);
        setTimeout(() => {
          if (tabFails) {
            chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
            cb(undefined);
            chrome.runtime.lastError = null;
          } else if (msg.type === 'GISTLY_MANUAL_SCAN') cb(scan);
          else if (msg.type === 'GISTLY_EXTRACT_FOR_POPUP') cb({ ok: true, found: true, extraction: { text: COOKIE_TEXT, url, title: 'Shop' } });
          else cb({ ok: true });
        }, 0);
      },
      create: async (o) => { log.calls.push(['create', o.url]); },
      reload: async (id) => { log.calls.push(['reload', id]); },
    },
  };

  window.chrome = chrome;
  window.close = () => log.calls.push('close');
  window.eval(read('popup/popup.js'));
  await sleep();

  const $ = (id) => window.document.getElementById(id);
  const click = async (id) => { $(id).click(); await sleep(); };
  const toggle = async (id, checked) => {
    $(id).checked = checked;
    $(id).dispatchEvent(new window.Event('change'));
    await sleep();
  };
  return { window, $, log, store, click, toggle };
}

console.log('\nPopup\n');

await test('an agreement is found: one Summarize button, then the gist appears in the popup', async () => {
  const p = await openPopup();
  assert.equal(p.$('statusTitle').textContent, 'Cookie notice found');
  assert.ok(p.$('statusDot').classList.contains('found'));
  assert.equal(p.$('primaryBtn').hidden, false);
  assert.equal(p.$('primaryBtn').textContent, 'Summarize');
  assert.equal(p.window.document.documentElement.dataset.theme, 'light');

  await p.click('primaryBtn');
  assert.equal(p.$('mainView').hidden, true);
  assert.equal(p.$('resultView').hidden, false);
  assert.equal(p.$('mainFooter').hidden, true);
  const text = p.$('resultBody').textContent;
  assert.match(text, /The gist/);
  assert.match(text, /IP address/);
  assert.match(text, /On-device summary/);
  assert.ok(p.$('resultBody').querySelector('details.source'), 'shows what Gistly read');

  await p.click('backBtn');
  assert.equal(p.$('mainView').hidden, false);
  assert.equal(p.$('resultView').hidden, true);
});

await test('nothing found: the same button becomes "Scan again" and really re-scans', async () => {
  const p = await openPopup({ scan: { ok: true, found: false } });
  assert.equal(p.$('statusTitle').textContent, 'No agreement on this page');
  assert.equal(p.$('primaryBtn').textContent, 'Scan again');
  assert.ok(p.$('primaryBtn').classList.contains('is-secondary'));
  const scans = () => p.log.tab.filter((m) => m.type === 'GISTLY_MANUAL_SCAN').length;
  const before = scans();
  await p.click('primaryBtn');
  assert.equal(scans(), before + 1);
});

await test('a tab opened before install gets a "Reload this tab" button that works', async () => {
  const p = await openPopup({ tabFails: true });
  assert.match(p.$('statusTitle').textContent, /isn’t running on this tab yet/);
  assert.ok(p.$('statusDot').classList.contains('problem'));
  assert.equal(p.$('primaryBtn').textContent, 'Reload this tab');
  await p.click('primaryBtn');
  assert.deepEqual(p.log.calls.filter((c) => Array.isArray(c) && c[0] === 'reload'), [['reload', 7]]);
  assert.ok(p.log.calls.includes('close'));
});

await test('a local file explains the "Allow access to file URLs" switch instead of offering a dead button', async () => {
  const p = await openPopup({ url: 'file:///Users/me/fixture.html', tabFails: true });
  assert.match(p.$('statusTitle').textContent, /blocks extensions on local files/);
  assert.match(p.$('statusDetail').textContent, /Allow access to file URLs/);
  assert.equal(p.$('primaryBtn').hidden, true);
});

await test('browser pages (chrome://) are explained and nothing is sent to the tab', async () => {
  const p = await openPopup({ url: 'chrome://extensions' });
  assert.match(p.$('statusTitle').textContent, /can’t read this page/);
  assert.equal(p.$('primaryBtn').hidden, true);
  assert.equal(p.log.tab.length, 0);
});

await test('AI row shows "Set up" (not a dead switch) until an endpoint exists', async () => {
  const p = await openPopup();
  assert.equal(p.$('aiSetup').hidden, false);
  assert.equal(p.$('aiSwitch').hidden, true);
  assert.equal(p.$('aiSub').textContent, 'Needs a one-time setup');
  await p.click('aiSetup');
  assert.deepEqual(p.log.calls.find((c) => Array.isArray(c) && c[0] === 'create'), ['create', 'chrome-extension://test/options/options.html#ai']);
  assert.ok(p.log.calls.includes('close'));
});

await test('with an endpoint the AI switch works and saves', async () => {
  const p = await openPopup({ settings: { apiEndpoint: 'https://p.workers.dev' } });
  assert.equal(p.$('aiSwitch').hidden, false);
  assert.equal(p.$('aiSetup').hidden, true);
  assert.equal(p.$('aiSub').textContent, 'Using the on-device summarizer');
  await p.toggle('aiEnabled', true);
  assert.ok(p.log.runtime.some((m) => m.type === 'GISTLY_SET_SETTINGS' && m.settings.aiEnabled === true));
  assert.equal(p.$('aiSub').textContent, 'Using your AI endpoint');
});

await test('a failed AI summary is explained in the popup, not silent', async () => {
  const result = { ...localSummarize({ text: COOKIE_TEXT }), aiError: AI_401 };
  const p = await openPopup({ summarizeResult: result });
  await p.click('primaryBtn');
  const text = p.$('resultBody').textContent;
  assert.match(text, /AI summary didn’t work/);
  assert.match(text, /401/);
  assert.match(text, /On-device summary/);
});

await test('"Show full text on page" scrolls the page and closes the popup', async () => {
  const p = await openPopup();
  await p.click('primaryBtn');
  await p.click('showOnPageBtn');
  assert.ok(p.log.tab.some((m) => m.type === 'GISTLY_SCROLL_TO_AGREEMENT'));
  assert.ok(p.log.calls.includes('close'));
});

await test('"Detect automatically" saves, and "All settings" opens Settings', async () => {
  const p = await openPopup();
  await p.toggle('autoDetect', false);
  assert.ok(p.log.runtime.some((m) => m.type === 'GISTLY_SET_SETTINGS' && m.settings.autoDetect === false));
  await p.click('openOptions');
  assert.ok(p.log.calls.includes('openOptionsPage'));
});

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

const DEFAULTS = { autoDetect: true, autoSummarize: false, aiEnabled: false, apiEndpoint: '', summaryLength: 'standard', theme: 'auto' };

async function openOptions({ settings = {}, grant = true, hash = '' } = {}) {
  const dom = new JSDOM(read('options/options.html'), { runScripts: 'outside-only', url: `chrome-extension://test/options/options.html${hash}` });
  const { window } = dom;
  const log = { messages: [], permReq: [], permRemove: [] };
  const store = { ...DEFAULTS, ...settings };
  let testReply = { ok: true, sample: 'It collects your email address.' };

  window.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        log.messages.push(msg);
        setTimeout(() => {
          if (msg.type === 'GISTLY_GET_SETTINGS') cb({ ok: true, settings: { ...store } });
          else if (msg.type === 'GISTLY_SET_SETTINGS') { Object.assign(store, msg.settings); cb({ ok: true, settings: { ...store } }); }
          else if (msg.type === 'GISTLY_RESET_SETTINGS') { Object.assign(store, DEFAULTS); cb({ ok: true, settings: { ...store } }); }
          else if (msg.type === 'GISTLY_TEST_AI') cb(testReply);
          else cb({ ok: false, error: `unexpected ${msg.type}` });
        }, 0);
      },
    },
    permissions: {
      request: async (q) => { log.permReq.push(q); return grant; },
      remove: async (q) => { log.permRemove.push(q); return true; },
    },
    storage: { onChanged: { addListener() {} } },
  };
  window.confirm = () => true;
  window.eval(read('options/options.js'));
  await sleep();

  const $ = (id) => window.document.getElementById(id);
  const click = async (id) => { $(id).click(); await sleep(); };
  const sets = () => log.messages.filter((m) => m.type === 'GISTLY_SET_SETTINGS');
  return { window, $, log, store, click, sets, setTestReply: (r) => { testReply = r; } };
}

console.log('\nSettings page\n');

await test('renders the stored settings and keeps AI controls off until an endpoint exists', async () => {
  const o = await openOptions({ settings: { theme: 'dark', autoSummarize: true, summaryLength: 'short' } });
  assert.equal(o.window.document.documentElement.dataset.theme, 'dark');
  assert.equal(o.$('theme').value, 'dark');
  assert.equal(o.$('summaryLength').value, 'short');
  assert.equal(o.$('autoSummarize').checked, true);
  assert.equal(o.$('aiEnabled').disabled, true);
  assert.equal(o.$('testBtn').disabled, true);
  assert.equal(o.$('aiSub').textContent, 'Save a proxy address above first.');
});

await test('a plain-switch change saves immediately and says so', async () => {
  const o = await openOptions();
  o.$('summaryLength').value = 'detailed';
  o.$('summaryLength').dispatchEvent(new o.window.Event('change'));
  await sleep();
  assert.deepEqual(plain(o.sets().map((m) => m.settings)), [{ summaryLength: 'detailed' }]);
  assert.equal(o.$('saved').textContent, 'Saved');
  assert.ok(o.$('saved').classList.contains('show'));
});

await test('rejects an address that is not https and never asks for permission', async () => {
  const o = await openOptions();
  o.$('apiEndpoint').value = 'http://x.example';
  await o.click('saveEndpointBtn');
  assert.ok(o.$('endpointStatus').classList.contains('error'));
  assert.match(o.$('endpointStatus').textContent, /https:\/\//);
  assert.equal(o.log.permReq.length, 0);
  assert.equal(o.sets().length, 0);
});

await test('saving a valid address asks permission for exactly that origin, saves, and unlocks Test and the AI switch', async () => {
  const o = await openOptions();
  o.$('apiEndpoint').value = 'https://gistly.example.workers.dev';
  await o.click('saveEndpointBtn');
  assert.deepEqual(plain(o.log.permReq), [{ origins: ['https://gistly.example.workers.dev/*'] }]);
  assert.deepEqual(plain(o.sets().map((m) => m.settings)), [{ apiEndpoint: 'https://gistly.example.workers.dev' }]);
  assert.ok(o.$('endpointStatus').classList.contains('ok'));
  assert.match(o.$('endpointStatus').textContent, /gistly\.example\.workers\.dev/);
  assert.equal(o.$('testBtn').disabled, false);
  assert.equal(o.$('aiEnabled').disabled, false);
});

await test('a declined permission saves nothing and says what to do', async () => {
  const o = await openOptions({ grant: false });
  o.$('apiEndpoint').value = 'https://gistly.example.workers.dev';
  await o.click('saveEndpointBtn');
  assert.match(o.$('endpointStatus').textContent, /declined/);
  assert.equal(o.sets().length, 0);
});

await test('changing the address withdraws the old permission (but not for a same-origin edit)', async () => {
  const o = await openOptions({ settings: { apiEndpoint: 'https://old.example.workers.dev' } });
  o.$('apiEndpoint').value = 'https://new.example.workers.dev';
  await o.click('saveEndpointBtn');
  assert.deepEqual(plain(o.log.permRemove), [{ origins: ['https://old.example.workers.dev/*'] }]);

  const same = await openOptions({ settings: { apiEndpoint: 'https://same.example.workers.dev' } });
  same.$('apiEndpoint').value = 'https://same.example.workers.dev/v1';
  await same.click('saveEndpointBtn');
  assert.equal(same.log.permRemove.length, 0);
});

await test('clearing the address removes the permission and switches AI off', async () => {
  const o = await openOptions({ settings: { apiEndpoint: 'https://old.example.workers.dev', aiEnabled: true } });
  o.$('apiEndpoint').value = '';
  await o.click('saveEndpointBtn');
  assert.deepEqual(plain(o.log.permRemove), [{ origins: ['https://old.example.workers.dev/*'] }]);
  assert.deepEqual(plain(o.sets().map((m) => m.settings)), [{ apiEndpoint: '', aiEnabled: false }]);
  assert.match(o.$('endpointStatus').textContent, /removed/);
  assert.equal(o.$('aiEnabled').disabled, true);
});

await test('Test connection reports success with a sample, and failure with the reason', async () => {
  const o = await openOptions({ settings: { apiEndpoint: 'https://p.workers.dev' } });
  await o.click('testBtn');
  assert.ok(o.$('endpointStatus').classList.contains('ok'));
  assert.match(o.$('endpointStatus').textContent, /It works.*email address/);
  assert.match(o.$('endpointStatus').textContent, /turn on/i);
  assert.equal(o.$('testBtn').textContent, 'Test connection');

  o.setTestReply({ ok: false, error: AI_401 });
  await o.click('testBtn');
  assert.ok(o.$('endpointStatus').classList.contains('error'));
  assert.match(o.$('endpointStatus').textContent, /401.*API key/);
});

await test('the AI switch saves once an endpoint is set', async () => {
  const o = await openOptions({ settings: { apiEndpoint: 'https://p.workers.dev' } });
  assert.equal(o.$('aiEnabled').disabled, false);
  o.$('aiEnabled').checked = true;
  o.$('aiEnabled').dispatchEvent(new o.window.Event('change'));
  await sleep();
  assert.deepEqual(plain(o.sets().map((m) => m.settings)), [{ aiEnabled: true }]);
});

await test('Reset all settings restores defaults, clears the field and withdraws permission', async () => {
  const o = await openOptions({ settings: { apiEndpoint: 'https://old.example.workers.dev', aiEnabled: true, theme: 'dark' } });
  await o.click('resetBtn');
  assert.ok(o.log.messages.some((m) => m.type === 'GISTLY_RESET_SETTINGS'));
  assert.deepEqual(plain(o.log.permRemove), [{ origins: ['https://old.example.workers.dev/*'] }]);
  assert.equal(o.$('apiEndpoint').value, '');
  assert.equal(o.$('theme').value, 'auto');
  assert.equal(o.$('saved').textContent, 'Settings reset');
});

await test('arriving from the popup (#ai) puts the cursor in the address field', async () => {
  const o = await openOptions({ hash: '#ai' });
  assert.equal(o.window.document.activeElement.id, 'apiEndpoint');
});

// ---------------------------------------------------------------------------
// Content script
// ---------------------------------------------------------------------------

async function openPage({ settings = {}, summarizeResult } = {}) {
  const dom = new JSDOM(read('tests/fixtures/div-cookie-banner.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://shop.example/' });
  const { window } = dom;

  // jsdom has no layout engine: report a plausible box for anything not hidden.
  window.Element.prototype.getBoundingClientRect = function () {
    const style = window.getComputedStyle(this);
    const hidden = style.display === 'none' || style.visibility === 'hidden';
    const size = hidden ? 0 : 100;
    return { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0, toJSON() {} };
  };
  let scrolled = 0;
  window.Element.prototype.scrollIntoView = function () { scrolled++; };

  // Gistly's shadow root is closed; keep a reference so the test can look inside.
  const roots = [];
  const realAttach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) {
    const root = realAttach.call(this, init);
    roots.push(root);
    return root;
  };

  const handlers = {};
  const store = { autoDetect: true, autoSummarize: false, theme: 'auto', ...settings };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        setTimeout(() => {
          if (msg.type === 'GISTLY_GET_SETTINGS') cb({ ok: true, settings: { ...store } });
          else if (msg.type === 'GISTLY_GET_OVERLAY_CSS') cb({ ok: true, css: read('styles/overlay.css') });
          else if (msg.type === 'GISTLY_SUMMARIZE') cb({ ok: true, result: summarizeResult || localSummarize({ text: msg.payload.text }) });
          else cb({ ok: false, error: `unexpected ${msg.type}` });
        }, 0);
      },
      onMessage: { addListener: (fn) => { handlers.onMessage = fn; } },
    },
    storage: { onChanged: { addListener: (fn) => { handlers.onChanged = fn; } } },
  };

  window.eval(read('detector.js'));
  window.eval(read('extractor.js'));
  window.eval(read('content.js'));
  await sleep(60);

  const shadow = () => roots[0];
  const fab = () => shadow().querySelector('.gistly-fab');
  const card = () => shadow().querySelector('.gistly-card');
  const host = () => window.document.getElementById('gistly-host');
  const ask = (msg) => new Promise((resolve) => {
    const returned = handlers.onMessage(msg, {}, resolve);
    assert.equal(returned, true, 'must keep the channel open for the async reply');
  });
  return { window, roots, shadow, fab, card, host, handlers, ask, scrolled: () => scrolled };
}

console.log('\nContent script\n');

await test('detects the banner, shows the button, and keeps its styles out of the page', async () => {
  const c = await openPage();
  assert.equal(c.roots.length, 1, 'one shadow root');
  assert.ok(c.fab().classList.contains('gistly-visible'));
  assert.equal(c.fab().querySelector('.gistly-fab-label').textContent, 'Summarize terms');
  assert.equal(c.host().style.visibility, '', 'revealed once the stylesheet is applied');
  assert.equal(c.host().getAttribute('data-gistly-theme'), 'auto');
  const cssInShadow = c.shadow().querySelector('style')?.textContent.includes('.gistly-fab') || c.shadow().adoptedStyleSheets?.length > 0;
  assert.ok(cssInShadow, 'stylesheet lives inside the shadow root');
  const doc = c.window.document;
  assert.equal(doc.querySelectorAll('head style, head link[rel="stylesheet"]').length, 0, 'nothing injected into the page');
});

await test('clicking the button opens a card with the gist, and the close button removes it', async () => {
  const c = await openPage();
  c.fab().click();
  await sleep();
  assert.ok(c.card(), 'card appears');
  const text = c.card().textContent;
  assert.match(text, /The gist/);
  assert.match(text, /IP address/);
  assert.match(text, /On-device summary/);
  c.card().querySelector('.gistly-close').click();
  assert.equal(c.card(), null);
});

await test('"Show the full text on the page" scrolls to the agreement', async () => {
  const c = await openPage();
  c.fab().click();
  await sleep();
  c.card().querySelector('.gistly-read-full').click();
  assert.equal(c.scrolled(), 1);
});

await test('a failed AI summary is explained on the card', async () => {
  const result = { ...localSummarize({ text: COOKIE_TEXT }), aiError: AI_401 };
  const c = await openPage({ summarizeResult: result });
  c.fab().click();
  await sleep();
  assert.match(c.card().textContent, /AI summary didn’t work/);
  assert.match(c.card().textContent, /401/);
});

await test('settings changes apply live: turning detection off hides the button, on brings it back', async () => {
  const c = await openPage();
  c.handlers.onChanged({ settings: { newValue: { autoDetect: false } } }, 'local');
  assert.ok(!c.fab().classList.contains('gistly-visible'));
  c.handlers.onChanged({ settings: { newValue: { autoDetect: true, theme: 'dark' } } }, 'local');
  assert.ok(c.fab().classList.contains('gistly-visible'));
  assert.equal(c.host().getAttribute('data-gistly-theme'), 'dark');

  c.handlers.onChanged({ settings: { newValue: { autoDetect: false } } }, 'sync'); // other areas are ignored
  assert.ok(c.fab().classList.contains('gistly-visible'));
});

await test('answers the popup: scan, extract (without button labels) and scroll', async () => {
  const c = await openPage();
  assert.deepEqual(plain(await c.ask({ type: 'GISTLY_MANUAL_SCAN' })), { ok: true, found: true, kind: 'cookie' });
  const extracted = await c.ask({ type: 'GISTLY_EXTRACT_FOR_POPUP' });
  assert.equal(extracted.found, true);
  assert.match(extracted.extraction.text, /IP address/);
  assert.doesNotMatch(extracted.extraction.text, /Accept all/);
  assert.deepEqual(plain(await c.ask({ type: 'GISTLY_SCROLL_TO_AGREEMENT' })), { ok: true });
  assert.equal(c.scrolled(), 1);
});

await test('"Summarize without asking" opens the card with no click', async () => {
  const c = await openPage({ settings: { autoSummarize: true } });
  assert.ok(c.card(), 'card is already open');
  assert.match(c.card().textContent, /The gist/);
});

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

const swStore = {};
const swListeners = {};
const iconCalls = [];
const granted = new Set();
let fetchHandler = null;
let networkCalls = 0;

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { swListeners.message = fn; } },
    onStartup: { addListener() {} },
    onInstalled: { addListener: (fn) => { swListeners.installed = fn; } },
    getURL: (p) => `chrome-extension://test/${p}`,
  },
  action: { setIcon: async (a) => { iconCalls.push(a); } },
  storage: {
    local: {
      get: async (k) => (typeof k === 'string' ? (k in swStore ? { [k]: swStore[k] } : {}) : { ...swStore }),
      set: async (o) => { Object.assign(swStore, o); },
      remove: async (k) => { for (const key of [].concat(k)) delete swStore[key]; },
    },
  },
  permissions: { contains: async ({ origins }) => granted.has(origins[0]) },
};
globalThis.createImageBitmap = async () => ({});
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.w = w; this.h = h; }
  getContext() {
    return {
      drawImage() {},
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    };
  }
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('chrome-extension://test/')) return new Response(read(u.replace('chrome-extension://test/', '')));
  if (u.startsWith('data:')) return realFetch(url, init);
  networkCalls++;
  if (fetchHandler) return fetchHandler(u, init);
  throw new Error(`unexpected network call to ${u}`);
};

await import(fileUrl('background/service-worker.js'));
await sleep();
const call = (msg) => new Promise((resolve) => swListeners.message(msg, {}, resolve));

const AI_ANSWER = { summary: ['It collects your email address.'], importantPoints: ['Automatic subscription renewal'], categories: { dataCollection: 'email address' } };
const anthropicReply = (obj) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const PAYLOAD = { text: COOKIE_TEXT, url: 'https://shop.example/', title: 'Shop' };
const ENDPOINT = 'https://p.workers.dev/';

console.log('\nService worker\n');

await test('paints the logo onto the toolbar icon at runtime (no icon files needed)', async () => {
  assert.ok(iconCalls.length >= 1, 'setIcon was called');
  assert.deepEqual(Object.keys(iconCalls[0].imageData).sort(), ['128', '16', '32', '48']);
});

await test('defaults, persistence and reset', async () => {
  const first = await call({ type: 'GISTLY_GET_SETTINGS' });
  assert.equal(first.settings.autoDetect, true);
  assert.equal(first.settings.aiEnabled, false);
  assert.equal(first.settings.apiEndpoint, '');
  assert.equal('keepHistory' in first.settings, false, 'no history setting any more');

  await call({ type: 'GISTLY_SET_SETTINGS', settings: { theme: 'dark', summaryLength: 'short' } });
  const changed = await call({ type: 'GISTLY_GET_SETTINGS' });
  assert.equal(changed.settings.theme, 'dark');
  assert.equal(changed.settings.summaryLength, 'short');
  assert.equal(changed.settings.autoDetect, true, 'other settings are kept');

  const reset = await call({ type: 'GISTLY_RESET_SETTINGS' });
  assert.equal(reset.settings.theme, 'auto');
  assert.equal((await call({ type: 'GISTLY_GET_SETTINGS' })).settings.summaryLength, 'standard');
});

await test('summarizes on-device by default, with zero network calls', async () => {
  const before = networkCalls;
  const res = await call({ type: 'GISTLY_SUMMARIZE', payload: PAYLOAD });
  assert.equal(res.ok, true);
  assert.equal(res.result.source, 'local');
  assert.equal(res.result.aiError, undefined);
  assert.equal(networkCalls, before);
});

await test('AI path: calls only your proxy, sends no API key, forces nothing it shouldn’t, returns the AI summary', async () => {
  await call({ type: 'GISTLY_SET_SETTINGS', settings: { apiEndpoint: ENDPOINT, aiEnabled: true } });
  granted.add('https://p.workers.dev/*');
  let seen;
  fetchHandler = async (url, init) => { seen = { url, init }; return anthropicReply(AI_ANSWER); };

  const res = await call({ type: 'GISTLY_SUMMARIZE', payload: PAYLOAD });
  assert.equal(res.result.source, 'ai');
  assert.deepEqual(res.result.summary, AI_ANSWER.summary);
  assert.equal(seen.url, ENDPOINT);
  assert.equal(seen.init.method, 'POST');
  assert.doesNotMatch(JSON.stringify(seen.init.headers), /api-key|authorization/i, 'the extension never holds a key');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'claude-haiku-4-5-20251001');
  assert.equal(body.messages[0].role, 'user');
});

const FAILURES = [
  ['a rejected API key (401)', () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 }), /401.*invalid x-api-key.*API key on your proxy/],
  ['a proxy locked to another extension (403)', () => new Response(JSON.stringify({ type: 'error', error: { type: 'gistly_proxy_error', message: 'This request did not come from the allowed Gistly extension.' } }), { status: 403 }), /403.*allowed Gistly extension.*ALLOWED_ORIGIN/],
  ['a key that may not do this (403 from Anthropic)', () => new Response(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'forbidden' } }), { status: 403 }), /403.*forbidden.*API key on your proxy isn’t allowed/],
  ['a wrong address (404)', () => new Response('Not found', { status: 404 }), /404.*Wrong address/],
  ['a rate limit (429)', () => new Response('{}', { status: 429 }), /429.*Rate limit/],
  ['an unreachable endpoint', () => { throw new Error('Failed to fetch'); }, /couldn’t reach the endpoint.*Failed to fetch/],
  ['a reply that isn’t JSON', () => new Response('<html>hello</html>', { status: 200 }), /didn’t return JSON/],
  ['a reply with no text', () => new Response(JSON.stringify({ content: [] }), { status: 200 }), /returned no text/],
  ['an AI answer in the wrong shape', () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Sure! Here you go' }] }), { status: 200 }), /unexpected format/],
];
for (const [name, handler, expected] of FAILURES) {
  await test(`AI failure (${name}) falls back to the on-device summary and says why`, async () => {
    fetchHandler = async () => handler();
    const res = await call({ type: 'GISTLY_SUMMARIZE', payload: PAYLOAD });
    assert.equal(res.ok, true);
    assert.equal(res.result.source, 'local');
    assert.match(res.result.aiError, expected);
    assert.ok(res.result.summary.length > 0, 'still returns a real summary');
  });
}

await test('a missing permission is explained', async () => {
  granted.clear();
  fetchHandler = async () => anthropicReply(AI_ANSWER);
  const res = await call({ type: 'GISTLY_SUMMARIZE', payload: PAYLOAD });
  assert.equal(res.result.source, 'local');
  assert.match(res.result.aiError, /allowed to contact that address/);
  granted.add('https://p.workers.dev/*');
});

await test('Test connection works even while the AI switch is off, and reports failures', async () => {
  await call({ type: 'GISTLY_SET_SETTINGS', settings: { aiEnabled: false } });
  fetchHandler = async () => anthropicReply(AI_ANSWER);
  assert.deepEqual(await call({ type: 'GISTLY_TEST_AI' }), { ok: true, sample: 'It collects your email address.' });

  fetchHandler = async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
  const bad = await call({ type: 'GISTLY_TEST_AI' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /401/);
});

await test('with AI off, nothing leaves the device', async () => {
  const before = networkCalls;
  const res = await call({ type: 'GISTLY_SUMMARIZE', payload: PAYLOAD });
  assert.equal(res.result.source, 'local');
  assert.equal(networkCalls, before);
});

await test('serves the overlay stylesheet to the content script, and refuses unknown messages', async () => {
  const css = await call({ type: 'GISTLY_GET_OVERLAY_CSS' });
  assert.equal(css.ok, true);
  assert.match(css.css, /\.gistly-fab/);
  assert.equal((await call({ type: 'NOPE' })).ok, false);
});

// ---------------------------------------------------------------------------
// AI proxy (Cloudflare Worker)
// ---------------------------------------------------------------------------

const proxy = (await import(fileUrl('proxy/cloudflare-worker.js'))).default;
let upstream = null;
function mockAnthropic(status = 200, body = { content: [{ type: 'text', text: '{}' }] }) {
  upstream = null;
  globalThis.fetch = async (url, init) => {
    upstream = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}
const fakeRequest = (method, { headers = {}, body = '' } = {}) => ({ method, headers: new Headers(headers), text: async () => body });
const goodBody = (extra = {}) => JSON.stringify({ system: 'You summarize.', messages: [{ role: 'user', content: 'hello' }], ...extra });
const ENV = { ANTHROPIC_API_KEY: 'sk-test' };

console.log('\nAI proxy\n');

await test('GET confirms the deploy worked; other methods are refused', async () => {
  const ok = await proxy.fetch(fakeRequest('GET'), ENV);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Gistly proxy is running/);
  assert.equal((await proxy.fetch(fakeRequest('PUT'), ENV)).status, 405);
  assert.equal((await proxy.fetch(fakeRequest('OPTIONS', { headers: { Origin: 'chrome-extension://abc' } }), ENV)).status, 204);
});

await test('says plainly when the API key secret is missing', async () => {
  const res = await proxy.fetch(fakeRequest('POST', { body: goodBody() }), {});
  assert.equal(res.status, 500);
  assert.match((await res.json()).error.message, /ANTHROPIC_API_KEY/);
});

await test('refuses bad JSON, oversized bodies and the wrong shape without calling Anthropic', async () => {
  mockAnthropic();
  assert.equal((await proxy.fetch(fakeRequest('POST', { body: 'not json' }), ENV)).status, 400);
  assert.equal((await proxy.fetch(fakeRequest('POST', { body: goodBody({ pad: 'x'.repeat(70000) }) }), ENV)).status, 413);
  assert.equal((await proxy.fetch(fakeRequest('POST', { body: JSON.stringify({ system: 's' }) }), ENV)).status, 400);
  assert.equal((await proxy.fetch(fakeRequest('POST', { body: JSON.stringify({ system: 's', messages: [{ role: 'assistant', content: 'hi' }] }) }), ENV)).status, 400);
  assert.equal((await proxy.fetch(fakeRequest('POST', { body: JSON.stringify({ system: 'x'.repeat(7000), messages: [{ role: 'user', content: 'hi' }] }) }), ENV)).status, 400);
  assert.equal(upstream, null, 'nothing was forwarded');
});

await test('forces the model and output size, strips everything else, and adds the key', async () => {
  mockAnthropic();
  const res = await proxy.fetch(fakeRequest('POST', {
    body: goodBody({ model: 'claude-opus-9', max_tokens: 99999, temperature: 2, tools: [{ name: 'x' }] }),
  }), ENV);
  assert.equal(res.status, 200);
  assert.equal(upstream.url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(upstream.body, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: 'You summarize.',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(upstream.headers['x-api-key'], 'sk-test');
  assert.equal(upstream.headers['anthropic-version'], '2023-06-01');
});

await test('passes Anthropic’s errors straight through so Gistly can show them', async () => {
  mockAnthropic(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  const res = await proxy.fetch(fakeRequest('POST', { body: goodBody() }), ENV);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.message, 'invalid x-api-key');
});

await test('ALLOWED_ORIGIN locks the proxy to your extension', async () => {
  mockAnthropic();
  const env = { ...ENV, ALLOWED_ORIGIN: 'chrome-extension://abc' };
  const evil = await proxy.fetch(fakeRequest('POST', { headers: { Origin: 'https://evil.example' }, body: goodBody() }), env);
  assert.equal(evil.status, 403);
  const none = await proxy.fetch(fakeRequest('POST', { body: goodBody() }), env);
  assert.equal(none.status, 403);
  const mine = await proxy.fetch(fakeRequest('POST', { headers: { Origin: 'chrome-extension://abc' }, body: goodBody() }), env);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
