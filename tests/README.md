# Gistly tests

## Automated

```bash
cd tests
npm install
npm test
```

`npm test` runs two suites (needs Node 18 or newer):

- **`run-tests.mjs`** loads each HTML fixture in `fixtures/` into jsdom, runs the real `detector.js` and `extractor.js` unmodified, and unit-tests the on-device summarizer in `summarizer.js`.
- **`ui-tests.mjs`** runs the popup, the Settings page, the content script, the service worker and the AI proxy (`proxy/cloudflare-worker.js`) against a mocked `chrome.*` API. It covers every state of the popup's main button, permission handling for the AI address, every AI failure path (401, 403, 404, 429, unreachable, bad JSON, wrong shape, missing permission), live settings changes, and the proxy's validation and origin lock.

GitHub Actions runs both on every push.

## In real Chrome

The automated tests can't replace trying the extension in a browser.

1. Load Gistly (see the main README, section 1).
2. On `chrome://extensions` open Gistly's **Details** and turn on **Allow access to file URLs**. Chrome blocks extensions on `file://` pages by default, and without this the pages below silently do nothing.
3. Open a fixture, for example `file:///…/tests/fixtures/terms-modal.html`, and click the Gistly icon.

| Fixture | Case | Expected |
|---|---|---|
| `terms-modal.html` | Terms popup with a checkbox and "I Agree" | Detected as terms. The summary flags arbitration and automatic renewal. |
| `cookie-banner.html` | Plain cookie banner | Detected as a cookie notice. |
| `div-cookie-banner.html` | Banner whose text sits in `<div>` and `<span>` wrappers | Detected. The summary names the IP address, device identifiers and personalized ads. |
| `privacy-policy-page.html` | Structured policy page, no buttons | Detected from its structure as a privacy policy. |
| `editorial-mention.html` | News article that only mentions "Terms of Service" | **Not** detected. |
| `dynamic-modal.html` | Modal injected about 2.5 seconds after load | Not found at first, then detected once it appears. |
| `long-tos-page.html` | Very long Terms of Service | Detected. Extraction is capped at 12,000 characters. |
