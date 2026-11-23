(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusDot = $('statusDot');
  const statusTitle = $('statusTitle');
  const statusDetail = $('statusDetail');
  const primaryBtn = $('primaryBtn');
  const autoDetect = $('autoDetect');
  const aiEnabled = $('aiEnabled');
  const aiSub = $('aiSub');
  const aiSetup = $('aiSetup');
  const aiSwitch = $('aiSwitch');
  const mainView = $('mainView');
  const mainFooter = $('mainFooter');
  const resultView = $('resultView');
  const resultBody = $('resultBody');

  const KIND_LABEL = {
    cookie: 'Cookie notice',
    privacy: 'Privacy policy',
    terms: 'Terms of service',
    legal: 'Legal document',
    consent: 'Consent request',
  };

  // Pages where Chrome never lets an extension run.
  const WEB_STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

  let activeTabId = null;
  let tabUrl = '';
  let primaryMode = null; // 'summarize' | 'scan' | 'reload'
  let settings = { autoDetect: true, aiEnabled: false, apiEndpoint: '', theme: 'auto' };

  // --- Helpers ----------------------------------------------------------------

  function sendToBackground(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, (res) => resolve(res)));
  }

  function sendToTab(tabId, msg) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res);
      });
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(kind, title, detail = '') {
    statusDot.className = 'dot' + (kind ? ' ' + kind : '');
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
  }

  // One primary button whose meaning follows the page's state, so it is
  // never a dead control: Summarize / Scan again / Reload this tab.
  function setPrimary(mode, label, secondary = false) {
    primaryMode = mode;
    primaryBtn.hidden = !mode;
    if (mode) {
      primaryBtn.textContent = label;
      primaryBtn.classList.toggle('is-secondary', secondary);
    }
  }

  function showMain() {
    resultView.hidden = true;
    mainView.hidden = false;
    mainFooter.hidden = false;
  }

  function showResult() {
    mainView.hidden = true;
    mainFooter.hidden = true;
    resultView.hidden = false;
  }

  // --- Quick settings ------------------------------------------------------------

  function renderSettings() {
    document.documentElement.dataset.theme = settings.theme || 'auto';
    autoDetect.checked = !!settings.autoDetect;

    const configured = !!settings.apiEndpoint;
    aiSwitch.hidden = !configured;
    aiSetup.hidden = configured;
    aiEnabled.checked = configured && !!settings.aiEnabled;
    aiSub.textContent = !configured
      ? 'Needs a one-time setup'
      : settings.aiEnabled
        ? 'Using your AI endpoint'
        : 'Using the on-device summarizer';
  }

  // The content script in every open tab listens for storage changes, so
  // saving here is all it takes for the setting to apply everywhere.
  async function saveSetting(partial) {
    const res = await sendToBackground({ type: 'GISTLY_SET_SETTINGS', settings: partial });
    if (res && res.ok) {
      settings = res.settings;
      renderSettings();
    }
  }

  autoDetect.addEventListener('change', () => saveSetting({ autoDetect: autoDetect.checked }));
  aiEnabled.addEventListener('change', () => saveSetting({ aiEnabled: aiEnabled.checked }));

  aiSetup.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#ai') });
    window.close();
  });

  $('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // --- Scanning -----------------------------------------------------------------------

  async function scan() {
    setStatus('', 'Looking at this page…');
    setPrimary(null);

    const res = await sendToTab(activeTabId, { type: 'GISTLY_MANUAL_SCAN' });

    if (!res || !res.ok) {
      if (tabUrl.startsWith('file:')) {
        setStatus(
          'problem',
          'Chrome blocks extensions on local files',
          'Turn on “Allow access to file URLs” for Gistly in chrome://extensions → Details, then reload this tab.'
        );
        setPrimary(null);
      } else {
        setStatus(
          'problem',
          'Gistly isn’t running on this tab yet',
          'This tab was open before Gistly was installed or updated. A reload fixes it.'
        );
        setPrimary('reload', 'Reload this tab');
      }
      return;
    }

    if (res.found) {
      setStatus('found', `${KIND_LABEL[res.kind] || 'Agreement'} found`, 'Gistly can read it and tell you the gist.');
      setPrimary('summarize', 'Summarize');
    } else {
      setStatus('', 'No agreement on this page', 'Open a sign-up form, cookie banner or policy page, then scan again.');
      setPrimary('scan', 'Scan again', true);
    }
  }

  primaryBtn.addEventListener('click', async () => {
    if (primaryMode === 'scan') return scan();
    if (primaryMode === 'reload') {
      await chrome.tabs.reload(activeTabId);
      window.close();
      return;
    }
    if (primaryMode === 'summarize') return summarizeNow();
  });

  // --- Summarizing -------------------------------------------------------------------------
  //
  // Two steps, both visible right here in the popup:
  //  1. Ask the page's content script for the already-detected agreement's text
  //     (a plain data request -- nothing is drawn on the page).
  //  2. Send that text to the background worker to summarize, then render the
  //     result in this popup.
  // So a summary either appears here or a specific message says why not.

  async function summarizeNow() {
    showResult();
    renderResult({ loading: true });

    const extractRes = await sendToTab(activeTabId, { type: 'GISTLY_EXTRACT_FOR_POPUP' });
    if (!extractRes || !extractRes.ok) {
      renderResult({ error: 'Couldn’t reach this page. Reload the tab and try again.' });
      return;
    }
    if (!extractRes.found) {
      renderResult({ error: 'The agreement isn’t on this page any more. Go back and scan again.' });
      return;
    }
    if (!extractRes.extraction) {
      renderResult({ error: 'No readable text was found in the detected area.' });
      return;
    }

    const sumRes = await sendToBackground({ type: 'GISTLY_SUMMARIZE', payload: extractRes.extraction });
    if (sumRes && sumRes.ok) {
      renderResult({ result: sumRes.result, extraction: extractRes.extraction });
    } else {
      renderResult({ error: `Couldn’t summarize this: ${(sumRes && sumRes.error) || 'unknown error'}` });
    }
  }

  function renderResult({ loading, error, result, extraction }) {
    resultBody.textContent = '';

    if (loading) {
      resultBody.appendChild(el('div', 'result-loading', 'Reading the fine print…'));
      return;
    }
    if (error) {
      resultBody.appendChild(el('div', 'result-error', error));
      return;
    }

    resultBody.appendChild(el('span', 'result-badge', result.source === 'ai' ? 'AI summary' : 'On-device summary'));

    if (result.aiError) {
      resultBody.appendChild(el(
        'div',
        'callout callout-spaced',
        `The AI summary didn’t work (${result.aiError}), so this is the on-device summary instead. Check All settings → AI summaries.`
      ));
    }

    resultBody.appendChild(el('div', 'section-title', 'The gist'));
    const list = el('ul', 'gist-list');
    (result.summary || []).forEach((point) => list.appendChild(el('li', null, point)));
    resultBody.appendChild(list);

    if (result.importantPoints && result.importantPoints.length > 0) {
      resultBody.appendChild(el('div', 'section-title', 'Worth knowing'));
      const flags = el('div', 'callout');
      result.importantPoints.forEach((p) => flags.appendChild(el('div', null, p)));
      resultBody.appendChild(flags);
    }

    if (extraction && extraction.text) {
      const details = el('details', 'source');
      details.appendChild(el('summary', null, `What Gistly read (${extraction.text.length.toLocaleString()} characters)`));
      const preview = extraction.text.length > 1500 ? extraction.text.slice(0, 1500) + '…' : extraction.text;
      details.appendChild(el('div', 'source-text', preview));
      resultBody.appendChild(details);
    }

    resultBody.appendChild(el(
      'div',
      'disclaimer',
      (result.source === 'ai'
        ? 'Written by an AI model from the text on this page. '
        : 'Built on your device by pattern matching, so it can miss things. ') +
      'Not legal advice. Gistly never accepts, rejects or clicks anything for you.'
    ));
  }

  $('backBtn').addEventListener('click', showMain);

  $('showOnPageBtn').addEventListener('click', async () => {
    if (activeTabId) await sendToTab(activeTabId, { type: 'GISTLY_SCROLL_TO_AGREEMENT' });
    window.close();
  });

  // --- Start -----------------------------------------------------------------------------------

  async function init() {
    const res = await sendToBackground({ type: 'GISTLY_GET_SETTINGS' });
    if (res && res.ok) settings = res.settings;
    renderSettings();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = (tab && tab.url) || '';

    if (!tab || !tab.id || !/^(https?|file):/.test(url) || WEB_STORE.test(url)) {
      setStatus('problem', 'Gistly can’t read this page', 'Browser pages such as chrome:// and the Web Store are off limits to extensions.');
      setPrimary(null);
      return;
    }

    activeTabId = tab.id;
    tabUrl = url;
    await scan();
  }

  init();
})();
