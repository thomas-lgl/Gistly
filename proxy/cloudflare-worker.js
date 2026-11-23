/**
 * Gistly AI proxy: a tiny Cloudflare Worker that sits between the Gistly
 * extension and the Anthropic API, so your API key never has to live inside
 * the extension (anything inside an extension can be read by whoever installs
 * it).
 *
 * Setup, in short (full walkthrough in the README and the installation guide):
 *   1. Cloudflare dashboard -> Workers & Pages -> Create -> Create Worker.
 *   2. Edit the code, replace everything with this file, and Deploy.
 *   3. Settings -> Variables and Secrets -> add a SECRET named ANTHROPIC_API_KEY.
 *   4. Copy the Worker's address (https://<name>.<you>.workers.dev) into
 *      Gistly -> Settings -> AI summaries -> Save endpoint -> Test connection.
 *
 * Optional secret ALLOWED_ORIGIN: set it to chrome-extension://<your Gistly
 * extension id> (shown on chrome://extensions) and the Worker will refuse
 * requests from anywhere else.
 *
 * What it will and won't do: it always uses the model below and a fixed output
 * size, accepts one short user message plus Gistly's system prompt, and
 * refuses anything bigger, so a leaked address can't be turned into a free
 * general-purpose AI endpoint.
 */

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 1000;
const MAX_BODY_BYTES = 60000;     // Gistly sends at most 12,000 characters of agreement text
const MAX_SYSTEM_CHARS = 6000;
const MAX_USER_CHARS = 40000;

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function errorResponse(status, message, cors) {
  return json({ type: 'error', error: { type: 'gistly_proxy_error', message } }, status, cors);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '';
    const cors = origin && (!allowed || origin === allowed)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          Vary: 'Origin',
        }
      : {};

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Opening the address in a browser tab is the quickest way to check the deploy worked.
    if (request.method === 'GET') {
      return new Response(
        'Gistly proxy is running. Paste this address into Gistly > Settings > AI summaries.',
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    if (request.method !== 'POST') return errorResponse(405, 'Use POST.', cors);

    if (allowed && origin !== allowed) {
      return errorResponse(403, 'This request did not come from the allowed Gistly extension.', cors);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return errorResponse(500, 'The ANTHROPIC_API_KEY secret is not set on this Worker.', cors);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return errorResponse(413, 'That request is too large.', cors);

    let body;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      return errorResponse(400, 'The request body was not valid JSON.', cors);
    }

    const system = typeof body.system === 'string' ? body.system : '';
    const first = Array.isArray(body.messages) ? body.messages[0] : null;
    const user = first && first.role === 'user' && typeof first.content === 'string' ? first.content : '';

    if (!user || user.length > MAX_USER_CHARS || system.length > MAX_SYSTEM_CHARS) {
      return errorResponse(400, 'Expected one user message and a system prompt of reasonable size.', cors);
    }

    // The model and output size are fixed here, whatever the caller asked for.
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });

    // Pass Anthropic's answer (or its error, which Gistly shows you) straight through.
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  },
};
