(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const autoDetect = $('autoDetect');
  const autoSummarize = $('autoSummarize');
  const summaryLength = $('summaryLength');
  const theme = $('theme');
  const aiEnabled = $('aiEnabled');
  const aiSub = $('aiSub');
  const endpointInput = $('apiEndpoint');
  const saveEndpointBtn = $('saveEndpointBtn');
  const testBtn = $('testBtn');
  const endpointStatus = $('endpointStatus');
  const resetBtn = $('resetBtn');
  const savedBadge = $('saved');

  let settings = {};
  let savedTimer;

  // --- Helpers ---------------------------------------------------------------

  function send(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  function flash(text = 'Saved') {
    savedBadge.textContent = text;
    savedBadge.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => savedBadge.classList.remove('show'), 1600);
  }

  function setStatus(kind, text) {
    endpointStatus.className = 'status' + (kind ? ' ' + kind : '');
    endpointStatus.textContent = text;
  }

  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (e) {
      return null;
    }
  }

  // Gistly is only ever allowed to contact the one address you saved. When
  // that address changes or is removed, the old permission is withdrawn.
  async function dropPermission(oldEndpoint, keepOrigin) {
    const old = originOf(oldEndpoint);
    if (!old || old === keepOrigin) return;
    try {
      await chrome.permissions.remove({ origins: [`${old}/*`] });
    } catch (e) {
      /* nothing to remove */
    }
  }

  function render({ keepInput = false } = {}) {
    document.documentElement.dataset.theme = settings.theme || 'auto';
    autoDetect.checked = !!settings.autoDetect;
    autoSummarize.checked = !!settings.autoSummarize;
    summaryLength.value = settings.summaryLength || 'standard';
    theme.value = settings.theme || 'auto';

    const configured = !!settings.apiEndpoint;
    if (!keepInput) endpointInput.value = settings.apiEndpoint || '';
    testBtn.disabled = !configured;
    aiEnabled.disabled = !configured;
    aiEnabled.checked = configured && !!settings.aiEnabled;
    aiSub.textContent = !configured
      ? 'Save a proxy address above first.'
      : settings.aiEnabled
        ? 'Summaries are written by AI through your proxy.'
        : 'Off: Gistly uses the on-device summarizer.';
  }

  async function save(partial) {
    const res = await send({ type: 'GISTLY_SET_SETTINGS', settings: partial });
    if (res && res.ok) {
      settings = res.settings;
      render({ keepInput: true });
      flash();
    } else {
      flash('Couldn’t save');
    }
    return res;
  }

  // --- Simple settings -------------------------------------------------------------

  autoDetect.addEventListener('change', () => save({ autoDetect: autoDetect.checked }));
  autoSummarize.addEventListener('change', () => save({ autoSummarize: autoSummarize.checked }));
  summaryLength.addEventListener('change', () => save({ summaryLength: summaryLength.value }));
  theme.addEventListener('change', () => save({ theme: theme.value }));
  aiEnabled.addEventListener('change', () => save({ aiEnabled: aiEnabled.checked }));

  // --- AI endpoint -------------------------------------------------------------------

  saveEndpointBtn.addEventListener('click', async () => {
    const value = endpointInput.value.trim();
    const previous = settings.apiEndpoint;

    if (!value) {
      if (!previous) {
        setStatus('error', 'Paste your proxy address first.');
        return;
      }
      await dropPermission(previous, null);
      await save({ apiEndpoint: '', aiEnabled: false });
      setStatus('ok', 'Endpoint removed. Gistly is back to on-device summaries.');
      return;
    }

    let url = null;
    try {
      url = new URL(value);
    } catch (e) {
      /* handled below */
    }
    if (!url || url.protocol !== 'https:') {
      setStatus('error', 'Enter the full address starting with https://, for example https://gistly-proxy.your-name.workers.dev');
      return;
    }

    // permissions.request has to be the first await after the click, or
    // Chrome no longer sees the user gesture and refuses to show the prompt.
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) {
      setStatus('error', 'Access was declined, so Gistly can’t contact that address. Press Save endpoint again and choose Allow.');
      return;
    }

    await dropPermission(previous, url.origin);
    await save({ apiEndpoint: value });
    setStatus('ok', `Saved. Gistly may contact ${url.host}. Press “Test connection” to check that it works.`);
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    setStatus('', 'Asking your proxy for a sample summary…');

    const res = await send({ type: 'GISTLY_TEST_AI' });

    testBtn.textContent = 'Test connection';
    testBtn.disabled = !settings.apiEndpoint;

    if (res && res.ok) {
      setStatus('ok', `It works. Sample answer: “${res.sample}”${settings.aiEnabled ? '' : ' Now turn on “Use AI summaries” below.'}`);
    } else {
      const reason = ((res && res.error) || 'no answer from the extension').replace(/\.$/, '');
      setStatus('error', `That didn’t work: ${reason}.`);
    }
  });

  // --- Reset --------------------------------------------------------------------------

  resetBtn.addEventListener('click', async () => {
    if (!window.confirm('Reset all Gistly settings? This also removes your AI proxy address.')) return;
    await dropPermission(settings.apiEndpoint, null);
    const res = await send({ type: 'GISTLY_RESET_SETTINGS' });
    if (res && res.ok) {
      settings = res.settings;
      render();
      setStatus('', '');
      flash('Settings reset');
    }
  });

  // Changes made in the popup show up here straight away.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = changes.settings.newValue || {};
      render({ keepInput: document.activeElement === endpointInput });
    }
  });

  // --- Start ------------------------------------------------------------------------------

  (async function init() {
    const res = await send({ type: 'GISTLY_GET_SETTINGS' });
    if (res && res.ok) settings = res.settings;
    render();
    if (location.hash === '#ai') endpointInput.focus({ preventScroll: true });
  })();
})();
