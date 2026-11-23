/**
 * detector.js
 * Heuristic detection of Terms & Conditions / Privacy Policy / cookie-consent
 * prompts on a page. Runs entirely locally — no network access, no AI.
 *
 * Exposes `window.__gistlyDetector` with:
 *   - scanPage(): DetectionResult | null
 *   - observe(callback): starts a debounced MutationObserver
 */
(function () {
  'use strict';

  // --- Keyword sets -------------------------------------------------------

  const AGREEMENT_KEYWORDS = [
    'terms and conditions', 'terms & conditions', 'terms of service',
    'terms of use', 'privacy policy', 'cookie policy', 'cookie notice',
    'cookie consent', 'legal agreement', 'user agreement', 'end user license',
    'eula', 'data processing agreement'
  ];

  const ACTION_PHRASES = [
    'i agree', 'i accept', 'accept all', 'accept cookies', 'i consent',
    'by continuing', 'by clicking', 'by using this site', 'by signing up',
    'by creating an account', 'agree and continue', 'accept & continue',
    'agree & continue', 'i have read and agree', 'consent to'
  ];

  const BUTTON_TEXT_HINTS = [
    'accept', 'accept all', 'agree', 'i agree', 'got it', 'allow all',
    'accept cookies', 'consent', 'ok, got it', 'continue'
  ];

  const NEGATIVE_CONTEXT = [
    // Pages that merely *mention* these words editorially, e.g. news
    // articles, blog posts about privacy law, are not agreements.
    'article', 'blog', 'news', 'opinion', 'editorial'
  ];

  const MIN_LEGAL_TEXT_LENGTH = 400; // chars, for "this looks like real legal text"
  const MAX_SCAN_TEXT = 20000; // cap the text we scan for performance

  // Headings that real Terms/Privacy documents are built out of. A page
  // that merely *mentions* "terms of service" once in passing (e.g. a news
  // article about consumer rights) won't have two or more of these as
  // actual headings — this is what separates a real legal document from an
  // incidental keyword hit.
  const CLAUSE_HEADING_PATTERNS = [
    /acceptance of terms/i,
    /(data|information) we (collect|use)/i,
    /how we (share|use|collect)/i,
    /sharing of (data|information)/i,
    /(your|user) (choices|rights|options)/i,
    /changes? to (this|these|our) (policy|terms|agreement)/i,
    /cancellation/i,
    /termination/i,
    /subscri(ption|ptions)/i,
    /billing/i,
    /dispute resolution/i,
    /arbitration/i,
    /governing law/i,
    /limitation of liability/i,
    /disclaimers?/i,
    /intellectual property/i,
    /third[- ]part(y|ies)/i,
    /cookies?( policy)?/i,
    /privacy policy/i,
    /terms of (service|use)/i,
    /user agreement/i,
    /data (protection|retention|security)/i,
  ];

  const CLAUSE_HEADING_THRESHOLD = 2;

  // --- Helpers -------------------------------------------------------------

  function safeCssEscape(id) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(id);
    }
    return String(id).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  }

  function textOf(el) {
    return (el.innerText || el.textContent || '').trim();
  }

  function lower(s) {
    return (s || '').toLowerCase();
  }

  function countMatches(haystack, needles) {
    let count = 0;
    for (const n of needles) {
      if (haystack.includes(n)) count++;
    }
    return count;
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isLikelyOverlay(el) {
    const style = window.getComputedStyle(el);
    const highZ = parseInt(style.zIndex, 10);
    const fixedish = style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute';
    return fixedish && (!isNaN(highZ) ? highZ >= 0 : true);
  }

  /**
   * Finds candidate containers: dialogs, modals, banners, or large blocks
   * of text that look like a ToS/Privacy page.
   */
  function findCandidateContainers() {
    const selectors = [
      '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
      'dialog', '.modal', '.popup', '.overlay', '.consent', '.cookie',
      '.cookie-banner', '.cookie-consent', '.gdpr', '.cmp', '#onetrust-banner-sdk',
      '.terms', '.tos', '.privacy-policy', 'main', 'article'
    ];
    const found = new Set();
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (isVisible(el)) found.add(el);
        });
      } catch (e) {
        // invalid selector on this DOM, ignore
      }
    }
    return Array.from(found);
  }

  function findAgreementButtons(root) {
    const clickable = root.querySelectorAll('button, a[role="button"], [role="button"], input[type="submit"], input[type="button"]');
    const matches = [];
    clickable.forEach((el) => {
      if (!isVisible(el)) return;
      const label = lower(textOf(el) || el.getAttribute('aria-label') || el.value || '');
      if (!label) return;
      if (BUTTON_TEXT_HINTS.some((h) => label === h || label.includes(h))) {
        matches.push(el);
      }
    });
    return matches;
  }

  function findAgreementCheckboxes(root) {
    const checkboxes = root.querySelectorAll('input[type="checkbox"]');
    const matches = [];
    checkboxes.forEach((cb) => {
      let label = '';
      if (cb.id) {
        const labelEl = document.querySelector(`label[for="${safeCssEscape(cb.id)}"]`);
        if (labelEl) label = textOf(labelEl);
      }
      if (!label && cb.closest('label')) {
        label = textOf(cb.closest('label'));
      }
      const l = lower(label);
      if (AGREEMENT_KEYWORDS.some((k) => l.includes(k)) || ACTION_PHRASES.some((k) => l.includes(k))) {
        matches.push(cb);
      }
    });
    return matches;
  }

  function countClauseHeadings(root) {
    const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let count = 0;
    headings.forEach((h) => {
      const t = textOf(h);
      if (t && CLAUSE_HEADING_PATTERNS.some((p) => p.test(t))) count++;
    });
    return count;
  }

  function findAgreementLinks(root) {
    const links = root.querySelectorAll('a[href]');
    const matches = [];
    links.forEach((a) => {
      const href = lower(a.getAttribute('href') || '');
      const label = lower(textOf(a));
      if (/terms|privacy|cookie|legal|tos\b/.test(href) || AGREEMENT_KEYWORDS.some((k) => label.includes(k))) {
        matches.push(a);
      }
    });
    return matches;
  }

  /**
   * Scores a container on how likely it is to be an active consent prompt
   * (as opposed to incidental page content).
   */
  function scoreContainer(container) {
    const text = lower(textOf(container)).slice(0, MAX_SCAN_TEXT);
    if (!text) return { score: 0 };

    const keywordHits = countMatches(text, AGREEMENT_KEYWORDS);
    const actionHits = countMatches(text, ACTION_PHRASES);
    const buttons = findAgreementButtons(container);
    const checkboxes = findAgreementCheckboxes(container);
    const links = findAgreementLinks(container);
    const overlay = isLikelyOverlay(container);
    const clauseHeadingCount = countClauseHeadings(container);
    const structuredLegalDocument = clauseHeadingCount >= CLAUSE_HEADING_THRESHOLD;

    // A block of text only counts as "this looks like a real legal
    // document" if it's actually structured like one (multiple clause
    // headings) or it's paired with something actionable (a button/
    // checkbox). A lone keyword hit inside ordinary prose does not qualify
    // -- that's exactly the false-positive case we need to avoid.
    const longLegalText =
      textOf(container).length >= MIN_LEGAL_TEXT_LENGTH &&
      (structuredLegalDocument || checkboxes.length > 0 || buttons.length > 0);

    let score = 0;
    score += keywordHits * 2;
    score += actionHits * 2;
    score += buttons.length > 0 ? 3 : 0;
    score += checkboxes.length > 0 ? 3 : 0;
    score += links.length > 0 ? 1 : 0;
    score += overlay ? 2 : 0;
    score += longLegalText ? 2 : 0;
    score += structuredLegalDocument ? 4 : 0;

    // Penalize likely false positives: editorial/article content that just
    // discusses these topics without asking for agreement.
    const negativeHits = countMatches(text, NEGATIVE_CONTEXT);
    if (negativeHits > 0 && buttons.length === 0 && checkboxes.length === 0) {
      score -= 3;
    }

    return { score, keywordHits, actionHits, buttons, checkboxes, links, overlay, longLegalText, structuredLegalDocument };
  }

  /**
   * Determines a "kind" label for UX purposes.
   */
  function classifyKind(container, meta) {
    // Prefer the container's own primary heading (h1/h2) — this is far more
    // reliable than scanning the whole body, where an incidental mention
    // deep in the text could misclassify the prompt entirely.
    const heading = container.querySelector('h1, h2');
    const headingText = lower(heading ? textOf(heading) : '');
    if (headingText) {
      if (/cookie/.test(headingText)) return 'cookie';
      if (/privacy/.test(headingText)) return 'privacy';
      if (/terms (of|and)/.test(headingText) || /terms of use/.test(headingText)) return 'terms';
    }

    const text = lower(textOf(container));
    const counts = {
      cookie: countMatches(text, ['cookie policy', 'cookie notice', 'cookie consent']),
      privacy: countMatches(text, ['privacy policy', 'privacy notice']),
      terms: countMatches(text, ['terms of service', 'terms and conditions', 'terms of use']),
    };
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > 0) return best[0];

    if (meta.longLegalText || meta.structuredLegalDocument) return 'legal';
    return 'consent';
  }

  const CONFIDENCE_THRESHOLD = 6;

  /**
   * Full page scan. Returns the single best candidate, or null.
   */
  function scanPage() {
    const candidates = findCandidateContainers();
    let best = null;
    let bestMeta = null;

    for (const el of candidates) {
      const meta = scoreContainer(el);
      if (meta.score < CONFIDENCE_THRESHOLD) continue;

      // Prefer the higher-scoring candidate; on an exact tie, prefer the
      // more specific one (a container nested inside the current best).
      if (!best || meta.score > bestMeta.score) {
        best = el;
        bestMeta = meta;
      } else if (meta.score === bestMeta.score && best.contains(el)) {
        best = el;
        bestMeta = meta;
      }
    }

    if (!best) return null;

    return {
      element: best,
      score: bestMeta.score,
      kind: classifyKind(best, bestMeta),
      hasButtons: bestMeta.buttons.length > 0,
      hasCheckboxes: bestMeta.checkboxes.length > 0,
      hasLinks: bestMeta.links.length > 0,
      isOverlay: bestMeta.overlay,
    };
  }

  // --- Observation -----------------------------------------------------------

  let debounceTimer = null;
  const DEBOUNCE_MS = 800;

  function observe(callback) {
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          const result = scanPage();
          callback(result);
        } catch (e) {
          // Never let a detection error break the host page.
          console.warn('[Gistly] scan error', e);
        }
      }, DEBOUNCE_MS);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
    });

    return observer;
  }

  window.__gistlyDetector = { scanPage, observe, CONFIDENCE_THRESHOLD };
})();
