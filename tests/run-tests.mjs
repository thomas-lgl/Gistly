// tests/run-tests.mjs
//
// A small, dependency-light test suite. Run with `npm install && npm test`
// from the tests/ directory.
//
// It exercises:
//   1. detector.js + extractor.js against the HTML fixtures in fixtures/,
//      loaded via jsdom (so the actual content-script code runs unmodified).
//   2. summarizer.js's local fallback, directly as a Node ES module (it has
//      no DOM dependency).
//
// This intentionally does NOT try to load the Chrome extension APIs
// (chrome.runtime, chrome.storage) — those are exercised manually per the
// README's "How to test it on several different websites" checklist.

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

/**
 * Loads a fixture HTML file plus detector.js and extractor.js into a fresh
 * jsdom window, waits `settleMs` for any fixture-internal timers (e.g. the
 * dynamic-modal fixture), and returns the window.
 */
async function loadFixture(name, { settleMs = 0 } = {}) {
  const html = readFileSync(path.join(FIXTURES, name), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/' });
  const { window } = dom;

  // jsdom doesn't implement layout, so getBoundingClientRect() always
  // returns zeros. detector.js's isVisible() treats that as "not visible",
  // which would make every fixture invisible. We patch it to report a
  // plausible non-zero box for any element that isn't display:none, so the
  // detection *logic* (keywords/buttons/overlay scoring) is what's under
  // test, not jsdom's lack of a layout engine.
  window.Element.prototype.getBoundingClientRect = function () {
    const style = window.getComputedStyle(this);
    const hidden = style.display === 'none' || style.visibility === 'hidden';
    const size = hidden ? 0 : 100;
    return { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0, toJSON() {} };
  };

  const detectorSrc = readFileSync(path.join(ROOT, 'detector.js'), 'utf8');
  const extractorSrc = readFileSync(path.join(ROOT, 'extractor.js'), 'utf8');
  window.eval(detectorSrc);
  window.eval(extractorSrc);

  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  return window;
}

async function run() {
  console.log('\nDetector / extractor tests (via jsdom fixtures)\n');

  await (async () => {
    const window = await loadFixture('terms-modal.html');
    test('terms-modal: detects an agreement', () => {
      const result = window.__gistlyDetector.scanPage();
      assert.ok(result, 'expected a detection result');
      assert.ok(result.hasButtons, 'expected agreement buttons to be found');
      assert.ok(result.hasCheckboxes, 'expected an agreement checkbox to be found');
    });
    test('terms-modal: extractor pulls clean text without button labels', () => {
      const result = window.__gistlyDetector.scanPage();
      const extracted = window.__gistlyExtractor.extract(result.element);
      assert.ok(extracted.text.length > 100, 'expected substantial extracted text');
      assert.ok(!/^I Agree$/m.test(extracted.text), 'button label text should be stripped');
      assert.ok(/arbitration/i.test(extracted.text), 'expected arbitration clause to survive extraction');
    });
  })();

  await (async () => {
    const window = await loadFixture('cookie-banner.html');
    test('cookie-banner: detects a cookie consent prompt', () => {
      const result = window.__gistlyDetector.scanPage();
      assert.ok(result, 'expected a detection result');
      assert.equal(result.kind, 'cookie');
    });
  })();

  await (async () => {
    const window = await loadFixture('privacy-policy-page.html');
    test('privacy-policy-page: detects a standalone policy page', () => {
      const result = window.__gistlyDetector.scanPage();
      assert.ok(result, 'expected a detection result');
      assert.equal(result.kind, 'privacy');
    });
  })();

  await (async () => {
    const window = await loadFixture('editorial-mention.html');
    test('editorial-mention: does NOT falsely detect an agreement', () => {
      const result = window.__gistlyDetector.scanPage();
      assert.equal(result, null, 'editorial content with no agreement UI should not trigger detection');
    });
  })();

  await (async () => {
    // No settle here: confirms the *initial* scan correctly finds nothing,
    // matching the "agreements loaded after several seconds" edge case.
    const window = await loadFixture('dynamic-modal.html', { settleMs: 0 });
    test('dynamic-modal: initial scan finds nothing before the modal appears', () => {
      const result = window.__gistlyDetector.scanPage();
      assert.equal(result, null);
    });
  })();

  await (async () => {
    const window = await loadFixture('dynamic-modal.html', { settleMs: 3000 });
    test('dynamic-modal: a later scan finds the delayed modal', () => {
      const result = window.__gistlyDetector.scanPage();
      assert.ok(result, 'expected the dynamically-injected modal to be detected once present');
    });
  })();

  await (async () => {
    const window = await loadFixture('long-tos-page.html');
    test('long-tos-page: detects a very long Terms of Service document', () => {
      const result = window.__gistlyDetector.scanPage();
      assert.ok(result, 'expected a detection result');
    });
    test('long-tos-page: extraction is capped at MAX_CHARS', () => {
      const result = window.__gistlyDetector.scanPage();
      const extracted = window.__gistlyExtractor.extract(result.element);
      assert.ok(extracted.text.length <= window.__gistlyExtractor.MAX_CHARS);
      assert.equal(extracted.truncated, true, 'expected the long document to be marked truncated');
    });
  })();

  await (async () => {
    const window = await loadFixture('div-cookie-banner.html');
    test('div-cookie-banner: extractor keeps text held in <div>/<span> wrappers with inline links', () => {
      const result = window.__gistlyDetector.scanPage();
      assert.ok(result, 'expected the banner to be detected');
      const extracted = window.__gistlyExtractor.extract(result.element);
      // Regression: a tag-whitelist extractor kept only the stray <p> and
      // dropped everything that matters.
      assert.match(extracted.text, /personalize ads/i);
      assert.match(extracted.text, /IP address/i);
      assert.doesNotMatch(extracted.text, /^Accept all$/m, 'button labels should be skipped');
    });
  })();

  console.log('\nSummarizer tests (local fallback, pure module)\n');

  const { localSummarize } = await import(path.join(ROOT, 'summarizer.js'));

  test('localSummarize: flags arbitration and auto-renewal as important points', () => {
    const text = [
      'We collect your email address and usage data to operate the service.',
      'Your subscription will automatically renew each month unless cancelled.',
      'Any dispute will be resolved through binding arbitration and you waive class action rights.',
    ].join(' ');
    const result = localSummarize({ text });
    assert.equal(result.source, 'local');
    assert.ok(result.summary.length > 0);
    assert.ok(result.importantPoints.some((p) => /arbitration/i.test(p)));
    assert.ok(result.importantPoints.some((p) => /renewal/i.test(p)));
  });

  test('localSummarize: does not invent a category it found no evidence for', () => {
    const result = localSummarize({ text: 'This document collects your email address for account creation.' });
    assert.match(result.categories.arbitration, /not clearly mentioned/i);
  });

  test('localSummarize: still matches categories inside realistically long legal sentences', () => {
    // Real Terms of Service / Privacy Policy sentences routinely run well
    // past 400 characters with nested clauses -- this guards against a past
    // regression where an overly strict sentence-length cap silently
    // discarded every real sentence before pattern matching ever ran,
    // making every summary fall back to "no clauses identified" regardless
    // of content.
    const longDataSharingSentence =
      'Notwithstanding anything to the contrary elsewhere in this Privacy Policy, and except as ' +
      'otherwise required by applicable law or regulation in the jurisdiction in which you reside, ' +
      'we may share certain categories of your personal information with third-party service ' +
      'providers, business partners, and affiliated companies who assist us in operating, ' +
      'maintaining, and improving the Service, subject in each case to appropriate contractual ' +
      'safeguards designed to protect the confidentiality of that information.';
    assert.ok(longDataSharingSentence.length > 400, 'fixture sentence should exceed the old 400-char cap');

    const longArbitrationSentence =
      'Any dispute, claim, or controversy arising out of or relating in any way to these Terms ' +
      'of Service, including without limitation the breach, termination, enforcement, ' +
      'interpretation, or validity thereof, or the determination of the scope or applicability of ' +
      'this agreement to arbitrate, shall be determined by binding arbitration administered on an ' +
      'individual basis, and you and the Company each irrevocably waive any right to a jury trial ' +
      'or to participate in a class action, collective action, or representative proceeding of any kind.';
    assert.ok(longArbitrationSentence.length > 400, 'fixture sentence should exceed the old 400-char cap');

    const text = `${longDataSharingSentence} ${longArbitrationSentence}`;
    const result = localSummarize({ text });

    assert.doesNotMatch(result.categories.dataSharing, /not clearly mentioned/i);
    assert.doesNotMatch(result.categories.arbitration, /not clearly mentioned/i);
    assert.ok(result.importantPoints.some((p) => /arbitration/i.test(p)));
  });

  test('localSummarize: names the specific data, purposes and recipients (not a generic label)', () => {
    const text = [
      'We collect your name, email address, IP address and device identifiers when you use the Service.',
      'We use this information to personalize ads, analyze usage, and prevent fraud.',
      'We share it with advertising partners and service providers.',
      'You can opt out of personalized advertising at any time.',
    ].join('\n');
    const joined = localSummarize({ text }).summary.join(' ');
    assert.match(joined, /email address/i);
    assert.match(joined, /IP address/i);
    assert.match(joined, /personalized ads/i);
    assert.match(joined, /advertising partners/i);
    assert.match(joined, /opt out/i);
  });

  test('localSummarize: understands list-style policies with no sentence punctuation', () => {
    const text = [
      '### Information we collect',
      'Full name',
      'Your email address',
      'Precise location data',
      'Browsing history and usage data',
    ].join('\n');
    const joined = localSummarize({ text }).summary.join(' ');
    assert.match(joined, /name/i);
    assert.match(joined, /email address/i);
    assert.match(joined, /location/i);
    assert.match(joined, /browsing/i);
  });

  test('localSummarize: "we do not sell your data" is reassurance, not a warning', () => {
    const text = 'We do not sell your personal information to anyone. We collect your email address to create your account.';
    const result = localSummarize({ text });
    assert.ok(!result.importantPoints.some((p) => /sell/i.test(p)), 'should not warn about selling');
    assert.match(result.summary.join(' '), /does not sell/i);
  });

  test('localSummarize: does not list data the text says it does NOT collect', () => {
    const text = 'We collect your email address. We do not collect your precise location or your phone number.';
    const dataBullet = localSummarize({ text }).summary.find((b) => /^It collects/i.test(b));
    assert.ok(dataBullet, 'expected a data bullet');
    assert.match(dataBullet, /email address/i);
    assert.doesNotMatch(dataBullet, /phone number/i);
    assert.doesNotMatch(dataBullet, /location/i);
  });

  test('localSummarize: names specific cookie categories instead of the bare word "cookies"', () => {
    const text = 'Necessary cookies are always active. Analytics cookies help us understand visitor behavior. Advertising cookies are used to show you relevant ads.';
    const dataBullet = localSummarize({ text }).summary.find((b) => /^It (?:collects|uses)/i.test(b));
    assert.ok(dataBullet, 'expected a data bullet');
    assert.match(dataBullet, /analytics.{0,20}cookies/i);
    assert.match(dataBullet, /advertising.{0,20}cookies/i);
    assert.doesNotMatch(dataBullet, /cookies and similar trackers/i);
  });

  test('localSummarize: never leaves a bare "cookies and similar trackers" bullet standing alone', () => {
    // Regression for the exact complaint: a summary whose only data-type
    // bullet was the generic catch-all with nothing else useful around it.
    const text = 'We use cookies to show you ads and for ad measurement and analytics. We may share information with our advertising partners.';
    const result = localSummarize({ text });
    assert.ok(
      !result.summary.some((b) => /^It uses cookies and similar trackers\.$/i.test(b)),
      'should not show the bare generic cookies bullet on its own'
    );
    assert.match(result.summary.join(' '), /It uses cookies and similar trackers, for/i);
    assert.match(result.summary.join(' '), /personalized ads/i);
  });

  test('localSummarize: honestly says so when cookies are mentioned with no category or purpose', () => {
    const result = localSummarize({ text: 'This website uses cookies to enhance your browsing experience.' });
    assert.match(result.summary.join(' '), /doesn't say what specific data/i);
  });

  test('localSummarize: recognises "renews automatically" wording as a subscription warning', () => {
    const text = 'Paid plans renew automatically each month unless you cancel before the renewal date. We collect your email address.';
    const result = localSummarize({ text });
    assert.ok(result.importantPoints.some((p) => /renewal/i.test(p)));
    assert.match(result.summary.join(' '), /Paid plans renew automatically/i);
  });

  test('localSummarize: lists user rights, but not when the company is the one accessing data', () => {
    const rights = localSummarize({ text: 'You may access, correct or delete your data, or opt out of personalized advertising, by contacting us.' });
    const choices = rights.summary.find((b) => /^You can/i.test(b));
    assert.ok(choices, 'expected a choices bullet');
    assert.match(choices, /access/i);
    assert.match(choices, /correct/i);
    assert.match(choices, /delete/i);
    assert.match(choices, /opt out/i);

    const notRights = localSummarize({ text: 'Our systems access your information in order to deliver the Service to you every day.' });
    assert.ok(!notRights.summary.some((b) => /^You can/i.test(b)), 'company access is not a user right');
  });

  test('localSummarize: never falls back to the old content-free message', () => {
    const text = 'Welcome to the ExampleApp community portal. Please read the following information carefully before you continue to use this website.';
    const result = localSummarize({ text });
    assert.ok(result.summary.length > 0);
    assert.doesNotMatch(result.summary.join(' '), /no specific high-signal clauses/i);
    // With no recognizable clauses it should at least show what the text says.
    assert.match(result.summary.join(' '), /community portal/i);
  });

  test('localSummarize: never repeats a sentence (a renewal clause that mentions "cancel" is reported once)', () => {
    const text = 'Paid plans renew automatically each month unless you cancel before the renewal date. We collect your email address.';
    const summary = localSummarize({ text }).summary;
    const mentions = summary.filter((b) => /renew automatically/i.test(b));
    assert.equal(mentions.length, 1, `expected one mention, got: ${JSON.stringify(summary)}`);
    assert.equal(new Set(summary).size, summary.length, 'no bullet appears twice');
  });

  test('localSummarize: still reports a separate cancellation or refund clause', () => {
    const text = 'Paid plans renew automatically each month unless you cancel before the renewal date. You may request a refund within 14 days of purchase.';
    const joined = localSummarize({ text }).summary.join(' ');
    assert.match(joined, /renew automatically/i);
    assert.match(joined, /refund/i);
  });

  test('localSummarize: warns when very little text was captured', () => {
    const result = localSummarize({ text: 'By continuing you agree to our terms.' });
    assert.match(result.summary.join(' '), /Only \d+ characters/i);
  });

  const bannerWindow = await loadFixture('div-cookie-banner.html');
  test('div-cookie-banner end to end: extracted text produces a specific cookie summary', () => {
    const detection = bannerWindow.__gistlyDetector.scanPage();
    const extracted = bannerWindow.__gistlyExtractor.extract(detection.element);
    const joined = localSummarize({ text: extracted.text }).summary.join(' ');
    assert.match(joined, /cookies/i);
    assert.match(joined, /IP address/i);
    assert.match(joined, /personalized ads/i);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run();
