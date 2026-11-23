<p align="center">
  <img src="branding/logo.svg" alt="Gistly logo" width="96" height="96">
</p>

<h1 align="center">Gistly</h1>

<p align="center">
  <a href="https://github.com/thomas-lgl/gistly/actions/workflows/test.yml"><img src="https://github.com/thomas-lgl/gistly/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
</p>

<p align="center"><strong>Terms, privacy policies and cookie banners, in plain words.</strong></p>

Gistly is a Chrome extension that notices when a page is asking you to agree to something (a sign-up form, a cookie banner, a privacy policy) and tells you the gist: what data it collects, what for, who it is shared with, and anything unusual. It **never clicks Accept or Reject for you**. It only reads and explains.

- Works out of the box, on your device, with nothing sent anywhere.
- Optional AI summaries through a small proxy that you run yourself (so no API key ever sits inside the extension).
- No account, no tracking, no history. The only thing it stores is its own settings.

> 📘 A printable step-by-step version of this page is in `docs/Installation-Setup-Guide.pdf`.

---

## 1. Install it from GitHub

You need Google Chrome (version 116 or newer). Edge, Brave and other Chromium browsers work the same way.

**1. Get the files** (pick one):

- **Download a ZIP:** on the repository page choose **Code → Download ZIP**, then unzip it.
- **Or clone it:** `git clone https://github.com/thomas-lgl/gistly.git`

**2. Load it into Chrome:**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder that **directly contains `manifest.json`**. After unzipping, that is sometimes one folder deeper than the one you unzipped. If Chrome says *"Manifest file is missing or unreadable"*, you picked the wrong level.
4. Click the puzzle-piece icon in Chrome's toolbar and **pin Gistly**.

You should now see the Gistly logo in the toolbar. Click it on any normal web page to try it.

**Updating:** download or `git pull` the new files, click the **reload** arrow on Gistly's card in `chrome://extensions`, then **refresh any tabs that were already open**. Reloading the extension does not reach into tabs that were loaded before. Gistly's popup notices this and offers a **Reload this tab** button.

---

## 2. Using Gistly

Click the toolbar icon. The popup has **one main button**, and what it does follows the page:

| What the popup says | The button | Why |
|---|---|---|
| *Cookie notice / Privacy policy / Terms of service found* | **Summarize** | Gistly found an agreement. The summary appears right in the popup. |
| *No agreement on this page* | **Scan again** | Open a sign-up form, banner or policy page, then press it. |
| *Gistly isn't running on this tab yet* | **Reload this tab** | The tab was open before Gistly was installed or updated. |
| *Chrome blocks extensions on local files* | (none) | See "Trying it on local files" below. |
| *Gistly can't read this page* | (none) | Browser pages such as `chrome://` and the Web Store are off limits to all extensions. |

When an agreement is detected, a small **Summarize terms** button also appears in the corner of the page. Click it for the same summary as a card on the page. Every summary has:

- **The gist**: a few plain sentences (what is collected, what for, who gets it, your choices, subscriptions).
- **Worth knowing**: flags such as arbitration clauses, automatic renewal, or data shared with advertisers.
- **What Gistly read** (in the popup): the exact text it analysed, so you can see whether it grabbed the right part.

Quick toggles in the popup: **Detect automatically** and **AI summaries**. Everything else is under **All settings**.

### Settings

| Setting | What it does |
|---|---|
| **Detect automatically** | Look for agreements as pages load and show the Summarize button. |
| **Summarize without asking** | Open the summary as soon as something is found. With AI on, this sends text to your proxy without a click. |
| **Length** | Aim for 3, 5 or 6 points. |
| **Appearance** | Match your system, light, or dark. Applies to the popup, Settings and the on-page card. |
| **AI summaries** | See section 3. |
| **Reset all settings** | Restores defaults and removes your proxy address and its permission. |

Changes save as you make them and apply to every open tab straight away.

### Trying it on local files

Chrome blocks every extension on `file://` pages unless you allow it. To try the pages in `tests/fixtures/`, go to `chrome://extensions` → Gistly → **Details** → turn on **Allow access to file URLs**, then reload the tab.

---

## 3. AI summaries (optional)

Gistly's built-in summarizer matches patterns on your device. It is quick and private, but it can miss unusual wording. AI summaries are written by a language model and read more naturally.

**Why you need a proxy.** Anything inside a browser extension can be read by whoever installs it, so an API key can't be hidden there. Instead, Gistly talks to a tiny service **you** run, which holds the key and forwards the request to Anthropic. The ready-made one is `proxy/cloudflare-worker.js`. It runs free on Cloudflare, and the whole setup takes about ten minutes.

**What it costs.** Cloudflare's free plan is plenty for this. The Anthropic API is billed **separately from a Claude.ai subscription**, by usage, from prepaid credits. A summary typically costs about a cent or less (check Anthropic's pricing page for current rates), so a few dollars of credit goes a long way.

**What is sent.** Only the agreement text Gistly detected (at most 12,000 characters), never the rest of the page. It goes to your proxy and on to Anthropic. Gistly stores nothing. If AI is off, nothing leaves your computer.

### Step 1. Get an Anthropic API key

1. Go to **console.anthropic.com** and sign in or create an account.
2. Add credit under **Settings → Billing** (a few dollars is plenty).
3. Open **Settings → API keys**, click **Create key**, name it "Gistly", and **copy the key now**. It is shown only once.

### Step 2. Create the proxy on Cloudflare

1. Create a free account at **dash.cloudflare.com** and sign in.
2. Go to **Workers & Pages**, click **Create**, choose the **Hello World** Worker template (or **Create Worker**), name it (for example `gistly-proxy`) and click **Deploy**.
3. Click **Edit code**. Delete everything in the editor, paste in the **entire contents of `proxy/cloudflare-worker.js`** from this project, and click **Deploy**.

### Step 3. Give the proxy your API key

1. On your Worker's page open **Settings → Variables and Secrets** and click **Add**.
2. Set **Type** to **Secret**, **Variable name** to exactly `ANTHROPIC_API_KEY`, and paste your key as the **Value**.
3. Click **Deploy**.

### Step 4. Check that it is alive

Copy your Worker's address (it looks like `https://gistly-proxy.your-name.workers.dev`) and open it in a browser tab. You should see:

> Gistly proxy is running. Paste this address into Gistly > Settings > AI summaries.

### Step 5. Connect Gistly

1. Click the Gistly icon → **Set up** next to *AI summaries* (or open **All settings**).
2. Paste your address into **Your proxy address** and click **Save endpoint**.
3. Chrome asks whether Gistly may contact that address. Click **Allow**. This permission is for that one address only.
4. Click **Test connection**. You should see *"It works"* with a sample answer.
5. Turn on **Use AI summaries**.

From now on summaries say **AI summary** in their badge. If the AI ever fails, Gistly shows you why and falls back to the on-device summary, so a bad setup is never silent.

### Step 6 (recommended). Lock the proxy to your extension

On `chrome://extensions`, copy Gistly's **ID** (a long string of letters). In Cloudflare, add a second **Secret** named `ALLOWED_ORIGIN` with the value `chrome-extension://` followed by that ID, then **Deploy**. The proxy then refuses requests from anywhere else. Keep your Worker address private either way.

### If something goes wrong

Gistly's messages are specific. Find yours:

| You see | What it means | Fix |
|---|---|---|
| `…answered 401 … The API key on your proxy was rejected` | The key is missing, mistyped or revoked. | Re-add the `ANTHROPIC_API_KEY` secret (Step 3) with a fresh key, and press **Deploy**. |
| `…answered 404 … Wrong address` | The address is wrong. | Copy it again from your Worker's page. It should look like `https://something.workers.dev`. |
| `…answered 429 … Rate limit` | Too many requests too quickly. | Wait a moment and try again. |
| `…answered 400/413 …` from the proxy | The request was refused as malformed or too big. | Make sure you pasted the unmodified `cloudflare-worker.js`. |
| `…answered 500 … ANTHROPIC_API_KEY secret is not set` | The Worker has no key. | Do Step 3, then **Deploy**. |
| `…answered 403 … allowed Gistly extension` | `ALLOWED_ORIGIN` doesn't match your extension's ID. | Fix the secret (Step 6) or delete it. |
| `couldn't reach the endpoint` | The address is unreachable or mistyped. | Open it in a browser tab. You should see *"Gistly proxy is running"*. |
| `hasn't been allowed to contact that address` | The Chrome permission was declined or removed. | Press **Save endpoint** again and click **Allow**. |
| `didn't return JSON` / `returned no text` | The address isn't the Gistly proxy. | Redo Step 2 with the code from this project. |
| `AI answered in an unexpected format` | The model's reply wasn't the expected JSON. | Try again. If it persists, use **Short** length. |

To stop using AI, turn the switch off. To remove everything, clear **Your proxy address** and press **Save endpoint** (this also withdraws Chrome's permission), then delete the Worker in Cloudflare and revoke the key in the Anthropic Console.

---

## 4. Privacy and permissions

- Detection, extraction and the built-in summarizer run **entirely on your device**.
- The only network call Gistly can ever make is the optional AI request to **your own proxy**, and only if you turn it on.
- No history, no analytics, no sync. Gistly stores only its settings, locally.
- Its stylesheet lives inside its own sealed Shadow DOM and is not injected into the websites you visit. It also declares no `web_accessible_resources`, so websites cannot detect that Gistly is installed.

| Permission | Why |
|---|---|
| `storage` | Save your settings locally. |
| `activeTab` | Let the popup see the current tab's address and talk to it, only for the tab you click on. |
| Content script on all pages | So detection can run wherever you browse. It reads the page; it makes no network calls. |
| Optional host permission (`https://*/*`) | **Not granted by default.** Requested for **one address** only when you save an AI proxy address, and withdrawn when you change or clear it. HTTPS only. |

Gistly does not request `tabs`, `history`, `cookies`, `webRequest` or `bookmarks`.

---

## 5. How it works

| File | Job |
|---|---|
| `detector.js` | Scores page areas (dialogs, banners, policy pages) on keywords, buttons, checkboxes, links and structure. Favors missing an agreement over crying wolf. A debounced `MutationObserver` catches banners that appear late. |
| `extractor.js` | Reads the detected area's visible text (skipping buttons, navigation and hidden parts), de-duplicates it and caps it at 12,000 characters. |
| `summarizer.js` | The on-device summarizer, plus the AI request and response shaping. It names the specific data, purposes and recipients it finds and understands negation ("we do **not** sell…"). |
| `content.js` | Orchestrates the above and draws the on-page button and card in a closed Shadow DOM. |
| `background/service-worker.js` | Owns settings, the optional AI call, and paints the logo onto the toolbar icon. The only file that uses the network. |
| `popup/`, `options/` | The popup and the Settings page. |
| `styles/overlay.css` | Styles for the on-page UI. Delivered into the shadow root by the service worker. |
| `proxy/cloudflare-worker.js` | The optional AI proxy you deploy yourself. |
| `branding/logo.svg` | The logo source. |

The built-in summarizer is pattern matching, not language understanding. It can miss unusually worded clauses, which is what the AI option is for.

**About the logo.** Chrome will not load an extension whose manifest names missing icon files, and a repository can't guarantee binary files survive every download method. So the logo is embedded in the service worker and painted onto the toolbar icon at runtime. The only place Chrome shows its default icon instead is the card on `chrome://extensions`. If you want the logo there too, export `branding/logo.svg` as 16, 32, 48 and 128 pixel PNGs into an `icons/` folder and add an `"icons"` block to `manifest.json`.

---

## 6. Testing

```bash
cd tests
npm install
npm test
```

This runs two suites:

- **`run-tests.mjs`**: detection, extraction and summarizing against HTML fixtures in `tests/fixtures/`.
- **`ui-tests.mjs`**: the popup, Settings page, content script, service worker (including every AI failure path) and the proxy, in jsdom against a mocked `chrome.*` API.

These can't replace trying it in real Chrome. Open the fixtures in `tests/fixtures/` (see "Trying it on local files") and check the table in `tests/README.md`. GitHub Actions runs the same tests on every push.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| Nothing happens on a page I had open before installing | Reload the tab, or press **Reload this tab** in the popup. |
| "Manifest file is missing or unreadable" | You selected the wrong folder. Pick the one that directly contains `manifest.json`. |
| Chrome shows a generic icon on `chrome://extensions` | Expected. See "About the logo". The toolbar icon is the Gistly logo. |
| It doesn't detect a banner | Press **Scan again**. Some banners load late or live in an iframe, which Gistly does not read. |
| The summary says only a few words were captured | The full policy is probably on a linked page. Open that page and scan it. |
| A change I made to the code doesn't show | Reload the extension in `chrome://extensions`, then refresh the tab. |

Gistly is a reading aid, not legal advice.
