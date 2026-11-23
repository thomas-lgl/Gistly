/**
 * summarizer.js
 * Converts extracted legal text into a short, structured summary.
 *
 * This module is imported by background/service-worker.js (as an ES module)
 * because that's where network calls to the configured AI endpoint happen —
 * NOT in the content script, and NOT with any API key embedded here.
 *
 * Input:  { text, url, title, length }  (length: 'short' | 'standard' | 'detailed')
 * Output: {
 *   summary: string[],
 *   importantPoints: string[],
 *   categories: { dataCollection, dataSharing, payment, cancellation, arbitration },
 *   source: 'ai' | 'local'
 * }
 *
 * The local (offline) summarizer is deliberately *specific*: rather than
 * saying "mentions data collection", it lists the concrete kinds of data,
 * purposes and recipients the text names, and it understands simple
 * negation ("we do not sell your personal information" is reassurance, not
 * a warning). It is still pattern matching -- not language understanding --
 * so it can miss unusually-worded clauses; the AI path is more capable.
 */

// --- Vocabulary ---------------------------------------------------------

// What kinds of data does the text say it collects or accesses?
const DATA_TYPES = [
  ['name', /\b(?:your (?:full |first |last )?name|full name|first name|last name)\b/i],
  ['email address', /\be-?mail address(?:es)?\b|\byour e-?mail\b/i],
  ['phone number', /\b(?:phone|telephone|mobile|cell)(?: phone)? numbers?\b/i],
  ['postal or billing address', /\b(?:postal|mailing|home|billing|shipping|street) address(?:es)?\b/i],
  ['contact details', /\bcontact (?:details|information|data)\b/i],
  ['date of birth / age', /\b(?:date of birth|birth ?date|birthday|your age)\b/i],
  ['payment or card details', /\b(?:credit|debit|payment) cards?\b|\bcard (?:number|details|information)\b|\bpayment (?:information|details|method)s?\b|\bbank account\b/i],
  ['government ID', /\b(?:government[- ]issued|passport|driver'?s licen[sc]e|social security|national id|tax id)\b/i],
  ['account or login details', /\b(?:username|user name|passwords?|account (?:information|details|credentials)|login (?:details|credentials))\b/i],
  ['IP address', /\bIP address(?:es)?\b/i],
  ['device information', /\bdevice (?:information|identifiers?|ids?|type|model|settings)\b|\bunique (?:device )?identifiers?\b|\badvertising identifiers?\b|\bmobile device ids?\b|\bbrowser (?:type|version|settings)\b|\boperating system\b/i],
  ['location', /\b(?:gps|geo-?location|precise location|approximate location|location (?:data|information)|your (?:physical )?location)\b/i],
  ['browsing or usage activity', /\b(?:browsing (?:history|activity|behaviou?r|data)|search (?:history|queries)|pages? you (?:visit|view)|clickstream|usage (?:data|information|activity)|how you (?:use|interact with)|interactions? with (?:our|the) (?:site|service|website|app))\b/i],
  ['cookies and similar trackers', /\b(?:cookies?|web beacons?|tracking pixels?|pixel tags?|local storage|tracking technologies|similar technologies|fingerprinting)\b/i],
  ['purchase history', /\b(?:purchase history|transaction (?:history|data|information)|order history|purchases you make)\b/i],
  ['content you submit', /\b(?:content you (?:post|submit|upload|create|provide)|user[- ]generated content|messages you (?:send|post))\b/i],
  ['photos, audio or video', /\b(?:photos?|videos?|voice recordings?|audio recordings?|microphone|camera)\b/i],
  ['contacts', /\b(?:address book|contacts? list|your contacts)\b/i],
  ['biometric / health data', /\b(?:biometric|facial recognition|health (?:data|information)|medical (?:data|information))\b/i],
  ['social media account info', /\bsocial (?:media|network(?:ing)?) (?:account|profile|information|login)s?\b/i],
];

// Real cookie banners almost always categorize cookies (essential,
// functional, analytics, advertising) -- these are far more useful to show
// than the bare word "cookies", so they're detected separately and used in
// place of the generic catch-all in DATA_TYPES when present.
const COOKIE_CATEGORIES = [
  ['essential/necessary cookies', /\b(?:strictly necessary|essential|required) cookies?\b/i],
  ['functional/preference cookies', /\b(?:functional|preference[s]?) cookies?\b/i],
  ['analytics/performance cookies', /\b(?:analytics|performance|statistics|measurement) cookies?\b/i],
  ['advertising/targeting cookies', /\b(?:advertising|targeting|marketing) cookies?\b/i],
  ['social media cookies', /\bsocial (?:media )?cookies?\b/i],
];

// Why does it want that data?
const PURPOSES = [
  ['personalized ads and marketing', /\bpersonali[sz]e[ds]?\s+(?:ads?|advertis\w+|content|offers?)\b|\btargeted (?:ads?|advertis\w+)\b|\binterest[- ]based (?:ads?|advertis\w+)\b|\badvertis\w+\b|\bad (?:personali[sz]ation|measurement|targeting|selection|delivery)\b|\bshow(?:ing)? you (?:relevant |targeted )?ads?\b|\brelevant ads?\b|\bmarketing\b|\bpromotional\b/i],
  ['analytics and improving the service', /\banalytics\b|\banaly[sz]e\b|\bmeasure (?:the )?(?:performance|usage|traffic|effectiveness)\b|\bimprove (?:our|the) (?:service|site|website|products?|app)\b|\bresearch and development\b/i],
  ['personalization', /\bpersonali[sz]e\b|\bpersonali[sz]ation\b|\bcustomi[sz]e\b|\btailor\b/i],
  ['security and fraud prevention', /\bsecurity\b|\bfraud\b|\babuse\b|\bunauthori[sz]ed\b/i],
  ['legal compliance', /\bcomply with (?:applicable )?(?:laws?|legal|regulations?)\b|\blegal obligations?\b|\blaw enforcement\b|\bcourt order\b|\bsubpoena\b|\blegal process\b/i],
  ['communicating with you or providing support', /\bcommunicate with you\b|\bsend you (?:e-?mails?|updates|newsletters?|notifications?)\b|\bcustomer (?:support|service)\b|\brespond to (?:your )?(?:requests|inquiries)\b/i],
  ['processing payments', /\bprocess(?:ing)? (?:your )?(?:payments?|transactions?|orders?)\b/i],
  ['running the service', /\b(?:provide|operate|maintain|deliver)\b[^.]{0,40}\b(?:service|site|website|platform|app)\b/i],
];

// Who else gets the data?
const RECIPIENTS = [
  ['advertising partners', /\badvertis(?:ers?|ing (?:partners?|networks?|companies))\b|\bad networks?\b|\bad partners?\b|\bmarketing partners?\b/i],
  ['analytics providers', /\banalytics (?:providers?|partners?|companies|services)\b|\bgoogle analytics\b/i],
  ['service providers or vendors', /\bservice providers?\b|\bvendors?\b|\bcontractors?\b|\bprocessors?\b|\bsuppliers?\b/i],
  ['affiliates or group companies', /\baffiliat\w*\b|\bsubsidiar(?:y|ies)\b|\bparent compan(?:y|ies)\b|\bgroup compan(?:y|ies)\b/i],
  ['business partners or third parties', /\bbusiness partners?\b|\bthird[- ]part(?:y|ies)\b|\bour partners\b|\btrusted partners\b/i],
  ['law enforcement or regulators', /\blaw enforcement\b|\bgovernment(?:al)? (?:authorities|agencies|requests?)\b|\bregulators?\b|\bpublic authorities\b/i],
  ['a buyer if the company is sold', /\bmerger\b|\bacquisition\b|\bsale of (?:all or )?(?:a portion of )?(?:our|the) (?:assets|business)\b|\bbankruptcy\b|\breorgani[sz]ation\b/i],
];

// What can the user do about it? These are only evaluated inside sentences
// that talk about the user's own rights/choices (see RIGHTS_CONTEXT), so
// "we access your information" isn't mistaken for "you can access your data".
const RIGHTS = [
  ['access your data', /\bright to access\b|\baccess\b[^.]{0,40}\byour (?:personal )?(?:data|information)\b|\brequest (?:a )?cop(?:y|ies)\b/i],
  ['correct it', /\bright to (?:correct|rectif\w+)\b|\b(?:correct|rectif\w+)\b[^.]{0,40}\byour (?:personal )?(?:data|information)\b/i],
  ['delete it', /\bright to (?:delet\w+|erasure)\b|\bright to be forgotten\b|\b(?:delet\w+|eras\w+)\b[^.]{0,40}\byour (?:personal )?(?:data|information|account)\b/i],
  ['opt out of some uses', /\bopt[- ]?out\b/i],
  ['withdraw consent', /\bwithdraw (?:your )?consent\b/i],
  ['object to or restrict processing', /\bright to (?:object|restrict)\b|\bobject to (?:the )?processing\b|\brestrict (?:the )?processing\b/i],
  ['take your data elsewhere', /\bportab\w+\b/i],
];
const RIGHTS_CONTEXT = /\byou (?:may|can|have the right|are able|have)\b|\byour (?:rights|choices|options)\b|\bright to\b|\brequest\b|\bopt[- ]?out\b|\bwithdraw\b/i;

// Sentence-level patterns for the clauses we quote back or flag.
const CATEGORY_PATTERNS = {
  dataCollection: [
    /(?:collect|gather|obtain)(?:s|ion)? (?:of )?(?:your |personal )?(?:information|data)/i,
    /information we collect/i,
    /device information|ip address|location data|cookies and similar technolog/i,
  ],
  dataSharing: [
    /share.{0,90}(third[- ]part|affiliat|partner|vendor)/i,
    /disclose.{0,90}(third[- ]part|affiliat|partner)/i,
    /sell (?:your )?(?:personal )?(?:information|data)/i,
  ],
  renewal: [
    /subscription.{0,60}(renew|auto)/i,
    /auto[- ]?renew/i,
    /automatically renew/i,
    /renew(?:s|ed)? automatically/i,
    /recurring (?:billing|charges?|payments?|subscription)/i,
  ],
  payment: [/\b(?:billing|charged?|fees?|payments?)\b/i],
  cancellation: [
    /cancel(?:lation)?/i,
    /refund/i,
    /terminate (?:your )?account/i,
  ],
  arbitration: [
    /arbitrat/i,
    /class action/i,
    /waive.{0,60}(jury|right)/i,
    /dispute resolution/i,
  ],
  retention: [
    /\b(?:retain|retention|keep|store)\b.{0,80}\b(?:for as long as|for (?:up to )?\d+|until|as necessary|period of)\b/i,
  ],
};

// Things worth flagging to the user. Each pattern is checked with a simple
// negation guard, so "we do not sell your data" doesn't raise a warning.
const RISK_SIGNALS = [
  { key: 'arbitration', label: 'Arbitration / class-action waiver', patterns: CATEGORY_PATTERNS.arbitration },
  { key: 'auto-renewal', label: 'Automatic subscription renewal', patterns: [/auto[- ]?renew/i, /automatically renew/i, /renew(?:s|ed)? automatically/i] },
  { key: 'data-sale', label: 'The text mentions selling personal data', patterns: [/\b(?:sell|selling|sale of)\s+(?:your\s+|the\s+)?(?:personal\s+)?(?:information|data)\b/i] },
  { key: 'data-sharing', label: 'Your data may be shared with third parties or advertisers', patterns: [/share.{0,90}(third[- ]part|advertis|marketing partner)/i] },
  { key: 'terms-change', label: 'The company can change these terms unilaterally', patterns: [/(?:we|company) (?:may|reserve[s]? the right to) (?:change|modify|update).{0,40}terms/i] },
  { key: 'account-termination', label: 'Your account can be suspended or terminated at their discretion', patterns: [/(?:suspend|terminate).{0,60}(?:your )?account.{0,60}(?:at (?:our|its) (?:sole )?discretion|without notice)/i] },
  { key: 'license-grant', label: 'You may be granting a broad license to content you submit', patterns: [/(?:grant|license).{0,90}(?:royalty[- ]free|perpetual|worldwide).{0,90}(?:license|right)/i] },
];

const SELL_DENIAL = /\b(?:do(?:es)?\s+not|don'?t|doesn'?t|never|will\s+not|won'?t)\s+(?:\w+\s+){0,3}?(?:sell|rent)\b/i;
const NEGATION_NEAR = /\b(?:not|never|don'?t|doesn'?t|won'?t|cannot|can'?t)\b/i;

// --- Helpers ---------------------------------------------------------------

/** True if `re` matches somewhere in `text` without a nearby negation. */
function hasAffirmative(text, re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const g = new RegExp(re.source, flags);
  let m;
  while ((m = g.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 45), m.index).split(/[.;!?\n]/).pop();
    if (!NEGATION_NEAR.test(before)) return true;
    if (m[0].length === 0) g.lastIndex++;
  }
  return false;
}

function detectLabels(text, table) {
  return table.filter(([, re]) => hasAffirmative(text, re)).map(([label]) => label);
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function cap(items, max) {
  return items.length > max ? [...items.slice(0, max), 'more'] : items;
}

/**
 * Splits text into readable units. Lines are respected (list items and
 * headings often have no punctuation), then each line is split into
 * sentences. Over-long units are chunked -- never discarded -- because real
 * legal sentences routinely run past 500 characters.
 */
function toUnits(text) {
  const units = [];
  for (const rawLine of String(text || '').split(/\n+/)) {
    const line = rawLine.replace(/^#{1,6}\s+/, '').trim();
    if (!line) continue;
    for (const s0 of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u201c(])/)) {
      const s = s0.trim();
      if (s.length < 15) continue;
      if (s.length <= 900) {
        units.push(s);
      } else {
        for (const piece of chunkLong(s)) if (piece.length >= 15) units.push(piece);
      }
    }
  }
  return units;
}

function chunkLong(s) {
  const out = [];
  for (const part of s.split(/(?<=[;:])\s+/)) {
    let rest = part;
    while (rest.length > 900) {
      let cut = rest.lastIndexOf(' ', 700);
      if (cut < 200) cut = 700;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

function findCategorySentence(units, patterns) {
  for (const u of units) {
    if (patterns.some((p) => p.test(u))) return u;
  }
  return null;
}

function trimSentence(s, maxLen = 160) {
  if (!s) return null;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

// Used to pick the most informative sentences when we have little else.
const SCORERS = [...DATA_TYPES, ...PURPOSES, ...RECIPIENTS, ...RIGHTS].map(([, re]) => re);
function scoreUnit(u) {
  let n = 0;
  for (const re of SCORERS) if (re.test(u)) n++;
  return n;
}

function keySentences(units, count) {
  return units
    .map((u, i) => ({ u, i, score: scoreUnit(u) }))
    .filter((x) => x.score > 0 && x.u.length >= 40)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, count)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.u);
}

// --- Local summarizer ------------------------------------------------------

/**
 * Local, offline fallback summarizer. Pure pattern matching -- no network
 * access, no AI. Every claim it makes points at words that are actually in
 * the extracted text.
 */
function localSummarize({ text, length = 'standard' }) {
  const fullText = String(text || '');
  const units = toUnits(fullText);
  const maxBullets = { short: 3, standard: 5, detailed: 6 }[length] || 5;
  const NOT_FOUND = 'Not clearly mentioned in the extracted text.';

  let dataTypes = detectLabels(fullText, DATA_TYPES);
  const cookieCategories = detectLabels(fullText, COOKIE_CATEGORIES);
  // Prefer specific cookie categories ("analytics cookies", "advertising
  // cookies") over the generic "cookies and similar trackers" catch-all --
  // real consent banners almost always name the category, and the bare
  // word "cookies" alone isn't useful to a reader.
  if (cookieCategories.length) {
    dataTypes = dataTypes.filter((d) => d !== 'cookies and similar trackers').concat(cookieCategories);
  }
  const purposes = detectLabels(fullText, PURPOSES);
  const recipients = detectLabels(fullText, RECIPIENTS);
  const rights = detectLabels(units.filter((u) => RIGHTS_CONTEXT.test(u)).join(' '), RIGHTS);

  const collectSentence = findCategorySentence(units, CATEGORY_PATTERNS.dataCollection);
  const sharingSentence = findCategorySentence(units, CATEGORY_PATTERNS.dataSharing);
  const renewalSentence = findCategorySentence(units, CATEGORY_PATTERNS.renewal);
  const paymentSentence = renewalSentence || findCategorySentence(units, CATEGORY_PATTERNS.payment);
  // Don't re-find the renewal sentence: "unless you cancel before the renewal date"
  // mentions cancelling, but it's already reported as the subscription point.
  const cancelSentence = findCategorySentence(
    units.filter((u) => u !== renewalSentence),
    CATEGORY_PATTERNS.cancellation
  );
  const arbitrationSentence = findCategorySentence(units, CATEGORY_PATTERNS.arbitration);
  const retentionSentence = findCategorySentence(units, CATEGORY_PATTERNS.retention);

  const deniesSelling = units.some((u) => SELL_DENIAL.test(u));

  // --- Bullets: composed as natural sentences, not label:value dumps ------
  //
  // The point of a summary is to synthesize findings from across the whole
  // document into readable sentences -- not to join whatever keywords
  // matched with commas under a field label. Each bullet below is built as
  // a sentence a person would actually write, combining related signals
  // (what data + why it's collected; who it's shared with + any stated
  // limits) rather than listing them as separate "Category: a, b, c" lines.
  const bullets = [];

  const cookieLabelSet = new Set(COOKIE_CATEGORIES.map(([label]) => label));
  const cookieLabels = dataTypes.filter((d) => cookieLabelSet.has(d) || d === 'cookies and similar trackers');
  const otherTypes = dataTypes.filter((d) => !cookieLabelSet.has(d) && d !== 'cookies and similar trackers');
  const onlyGenericCookies = dataTypes.length === 1 && dataTypes[0] === 'cookies and similar trackers';

  if (onlyGenericCookies && purposes.length === 0) {
    // The text only says "cookies" with no category and no stated purpose --
    // rather than repeat that unhelpful bare word, say so plainly and point
    // at where the real detail likely lives.
    bullets.push('The text mentions cookies but doesn\'t say what specific data they collect or what for — check the linked Cookie Policy for the full breakdown.');
  } else if (otherTypes.length || cookieLabels.length) {
    let sentence;
    if (otherTypes.length && cookieLabels.length) {
      sentence = `It collects ${joinList(cap(otherTypes, 6))}, and uses ${joinList(cap(cookieLabels, 4))}`;
    } else if (otherTypes.length) {
      sentence = `It collects ${joinList(cap(otherTypes, 8))}`;
    } else {
      sentence = `It uses ${joinList(cap(cookieLabels, 4))}`;
    }
    if (purposes.length) {
      sentence += `, for ${joinList(cap(purposes, 4))}`;
    }
    bullets.push(sentence + '.');
  } else if (collectSentence) {
    bullets.push(trimSentence(collectSentence, 180));
  }

  const sellNote = deniesSelling ? ', though it states it does not sell your personal information' : '';
  if (recipients.length) {
    bullets.push(`It may share this with ${joinList(cap(recipients, 5))}${sellNote}.`);
  } else if (sharingSentence) {
    bullets.push(trimSentence(sharingSentence, 170) + (deniesSelling ? ' It also states that it does not sell your personal information.' : ''));
  } else if (deniesSelling) {
    bullets.push('It states that it does not sell your personal information.');
  }

  if (renewalSentence) {
    bullets.push(trimSentence(renewalSentence, 170));
  }
  if (rights.length) {
    bullets.push(`You can ${joinList(rights)}.`);
  }
  if (retentionSentence) {
    bullets.push(trimSentence(retentionSentence, 170));
  }
  if (!renewalSentence && paymentSentence) {
    bullets.push(trimSentence(paymentSentence, 170));
  }
  if (cancelSentence) {
    bullets.push(trimSentence(cancelSentence, 170));
  }

  // Fallbacks: never leave the user with a content-free answer.
  if (bullets.length < 2) {
    for (const s of keySentences(units, 3 - bullets.length)) {
      bullets.push(`Key point: ${trimSentence(s, 180)}`);
    }
  }
  if (bullets.length === 0) {
    const lead = units.filter((u) => u.length >= 40).slice(0, 2);
    for (const s of lead) bullets.push(`The text says: ${trimSentence(s, 180)}`);
  }
  if (bullets.length === 0) {
    bullets.push('No readable sentences were found in the text Gistly captured.');
  }

  const unique = [...new Set(bullets)]; // never say the same thing twice
  let summary = unique.slice(0, maxBullets);
  if (fullText.length < 600) {
    const note =
      `Only ${fullText.length} characters of text were captured, so this may just be a short notice — ` +
      'the full policy may be on a linked page (open it and scan that page instead).';
    summary = unique.slice(0, Math.max(1, maxBullets - 1)).concat(note);
  }

  // --- Things worth flagging ------------------------------------------------
  const importantPoints = [];
  for (const signal of RISK_SIGNALS) {
    const hit = units.some((u) => signal.patterns.some((p) => hasAffirmative(u, p)));
    if (hit) importantPoints.push(signal.label);
  }

  // --- Structured categories (same shape the AI path returns) ---------------
  const categories = {
    dataCollection: dataTypes.length ? joinList(dataTypes) : trimSentence(collectSentence) || NOT_FOUND,
    dataSharing: recipients.length ? joinList(recipients) : trimSentence(sharingSentence) || NOT_FOUND,
    payment: trimSentence(paymentSentence) || NOT_FOUND,
    cancellation: trimSentence(cancelSentence) || NOT_FOUND,
    arbitration: trimSentence(arbitrationSentence) || NOT_FOUND,
  };

  return { summary, importantPoints, categories, source: 'local' };
}

// --- AI request/response shaping ---------------------------------------------

/**
 * Builds the request body sent to the configured AI endpoint. Kept separate
 * from the fetch call itself so background/service-worker.js can own all
 * network/auth concerns.
 */
function buildAIRequest({ text, url, title, length = 'standard' }) {
  const bulletCounts = { short: 3, standard: 5, detailed: 6 };
  const bulletCount = bulletCounts[length] || 5;

  const system = [
    'You are a neutral assistant that explains legal/consent text (Terms of',
    'Service, Privacy Policy, cookie consent, etc.) to a non-lawyer in plain',
    'language. You never give legal advice and never claim something is',
    '"safe" or "unsafe", "legal" or "illegal". You only describe what the',
    'text says. Respond ONLY with a single JSON object, no markdown fences,',
    'matching exactly this shape:',
    '{"summary": string[], "importantPoints": string[], "categories": {',
    ' "dataCollection": string, "dataSharing": string, "payment": string,',
    ' "cancellation": string, "arbitration": string }}',
    `The "summary" array should have about ${bulletCount} short bullet points`,
    'covering only what a typical user would actually care about (what data',
    'is collected, how it is used/shared, fees or auto-renewal, cancellation',
    'terms, ability to change terms, arbitration/class-action waivers, and',
    'any unusual restrictions). Be specific: name the actual kinds of data,',
    'purposes and recipients the text mentions. "importantPoints" should list',
    'only genuinely notable or unusual items (may be empty). Each "categories"',
    'value should be one short sentence, or "Not mentioned" if the text does',
    'not cover it.',
  ].join(' ');

  const user = JSON.stringify({ url, title, text });

  return {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system,
    messages: [{ role: 'user', content: user }],
  };
}

/**
 * Parses a model's text response into the structured shape, tolerating
 * accidental markdown code fences.
 */
function parseAIResponse(rawText) {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed.summary)) throw new Error('Malformed AI response: summary');

  return {
    summary: parsed.summary.slice(0, 8),
    importantPoints: Array.isArray(parsed.importantPoints) ? parsed.importantPoints.slice(0, 6) : [],
    categories: parsed.categories && typeof parsed.categories === 'object' ? parsed.categories : {},
    source: 'ai',
  };
}

export { localSummarize, buildAIRequest, parseAIResponse, CATEGORY_PATTERNS, RISK_SIGNALS };
