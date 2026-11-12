// Chrome's built-in Gemini Nano (Prompt API, global `LanguageModel`).
// Plain script, no modules: loaded by the service worker (importScripts) and
// by offscreen.html / popup.html (<script>), so every name here is a global.
// Nothing at top level touches LanguageModel: contexts without the Prompt API
// can load this file safely.

// The prompt Nano sees for every email. Also used to measure context usage
// (nanoFitBody), so the measured text is exactly what gets prompted.
function buildCodePrompt(from, subject, body) {
  return `Extract the login verification code, OTP, or two-factor authentication code from this email. Only return a code if the email's primary purpose is delivering it; return an empty string for marketing emails, receipts, or anything else containing incidental numbers.\n\nFrom: ${from}\nSubject: ${subject}\nBody:\n${body}`;
}

// maxLength cuts slow magic-link emails from ~20s to 3-6s (Nano stops instead
// of spelling out a long token). The price: Nano can then return a 20-char
// PREFIX of a long token, which whole-token grounding in isPlausibleCode
// rejects. 21 > the 20-char shape limit, so a cut-off answer never passes.
const NANO_SCHEMA = {
  type: 'object',
  required: ['login_code'],
  properties: { login_code: { type: 'string', maxLength: 21 } },
};
const NANO_SESSION_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const NANO_DEFAULT_TIMEOUT_MS = 60000;
// Tokens kept free for the JSON answer.
const NANO_ANSWER_ROOM = 64;

// 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported'
async function nanoAvailability() {
  if (typeof LanguageModel === 'undefined') return 'unsupported';
  try {
    return await LanguageModel.availability(NANO_SESSION_OPTS);
  } catch {
    return 'unavailable';
  }
}

// One warm base session; each email gets a clone so emails never share
// context. Dropped after any failure so the next call starts fresh, and after
// NANO_IDLE_MS without use: the offscreen document lives all browser session,
// and a live session keeps the model loaded in RAM/VRAM.
let nanoBasePromise = null;
let nanoIdleTimer = null;
const NANO_IDLE_MS = 3 * 60000;

function nanoBase() {
  if (!nanoBasePromise) {
    const p = LanguageModel.create(NANO_SESSION_OPTS).catch((err) => {
      // Only if still cached: a late rejection must not evict a newer base.
      if (nanoBasePromise === p) nanoBasePromise = null;
      throw err;
    });
    nanoBasePromise = p;
  }
  return nanoBasePromise;
}

function nanoDropBase() {
  const stale = nanoBasePromise;
  nanoBasePromise = null;
  stale?.then((s) => { try { s.destroy(); } catch { /* already gone */ } }, () => {});
}

function nanoMeasure(session, text, signal) {
  const opts = { responseConstraint: NANO_SCHEMA, signal };
  return session.measureContextUsage
    ? session.measureContextUsage(text, opts)
    : session.measureInputUsage(text, opts);
}

// Largest body prefix whose prompt fits the context window, leaving room for
// the answer. Binary search, stopping within 200 chars.
async function nanoFitBody(session, from, subject, body, signal) {
  const limit = session.contextWindow ?? session.inputQuota;
  const used = session.contextUsage ?? session.inputUsage ?? 0;
  const room = limit - used - NANO_ANSWER_ROOM;
  const fits = async (b) => (await nanoMeasure(session, buildCodePrompt(from, subject, b), signal)) <= room;
  if (await fits(body)) return { body, truncated: false };
  let lo = 0;
  let hi = body.length;
  while (hi - lo > 200) {
    const mid = (lo + hi) >> 1;
    if (await fits(body.slice(0, mid))) lo = mid; else hi = mid;
  }
  return { body: body.slice(0, lo), truncated: true };
}

// -> { raw, code, truncated }. code is login_code with whitespace removed, or
// '' when the answer isn't valid JSON. Throws on model errors and timeouts.
async function nanoExtract({ from = '', subject = '', body = '' } = {}, { timeoutMs = NANO_DEFAULT_TIMEOUT_MS } = {}) {
  clearTimeout(nanoIdleTimer);
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Gemini Nano timed out after ${timeoutMs} ms`);
      err.name = 'TimeoutError';
      ac.abort(err);
      reject(err);
    }, timeoutMs);
  });

  const work = async () => {
    let session;
    try {
      const base = await nanoBase();
      session = await base.clone({ signal: ac.signal });
      const fit = await nanoFitBody(session, from, subject, body, ac.signal);
      const raw = await session.prompt(buildCodePrompt(from, subject, fit.body), {
        responseConstraint: NANO_SCHEMA,
        signal: ac.signal,
      });
      let code = '';
      try {
        code = String(JSON.parse(raw).login_code || '').replace(/\s+/g, '');
      } catch { /* not JSON: treated as no code */ }
      return { raw, code, truncated: fit.truncated };
    } finally {
      try { session?.destroy(); } catch { /* already gone */ }
    }
  };

  try {
    return await Promise.race([work(), timeout]);
  } catch (err) {
    // A wedged or crashed session must not be reused by the next email.
    nanoDropBase();
    throw err;
  } finally {
    clearTimeout(timer);
    nanoIdleTimer = setTimeout(() => { nanoIdleTimer = null; nanoDropBase(); }, NANO_IDLE_MS);
  }
}
