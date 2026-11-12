// Unit/behavior tests for background.js run under Node with mocked chrome.* APIs.
// Run: node gmail-code-clipper/test/background.test.js
'use strict';
const assert = require('assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- chrome.* / service worker mocks ---

const EXT_DIR = path.join(__dirname, '..');

// Mock Prompt API (global LanguageModel). respond(promptText) -> login_code;
// measure(text) -> tokens (default: proportional to length). failPrompts:
// how many upcoming prompt() calls throw a generic UnknownError. hang: prompt()
// never settles until aborted. onPrompt() runs at the start of every prompt(),
// whether it then resolves, throws or hangs.
function mockLanguageModel({
  availability = 'available', respond = () => '', measure = (t) => Math.ceil(t.length / 4),
  contextWindow = 9216, failPrompts = 0, hang = false, onPrompt = () => {},
} = {}) {
  const lm = {
    availabilityValue: availability, failPrompts, hang,
    created: 0, destroyed: 0, prompts: [], promptOpts: [], createOpts: [],
    availability: async () => lm.availabilityValue,
    create: async (opts) => { lm.created++; lm.createOpts.push(opts); return session(); },
  };
  function session() {
    return {
      contextWindow, contextUsage: 0,
      measureContextUsage: async (text) => measure(text),
      destroy: () => { lm.destroyed++; },
      prompt: (text, opts) => {
        lm.prompts.push(text);
        lm.promptOpts.push(opts);
        onPrompt(text);
        if (lm.hang) {
          return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
        }
        if (lm.failPrompts > 0) {
          lm.failPrompts--;
          return Promise.reject(Object.assign(new Error('Other generic failures occurred.'), { name: 'UnknownError' }));
        }
        return Promise.resolve(JSON.stringify({ login_code: respond(text) }));
      },
    };
  }
  return lm;
}

// A second vm context running the real offscreen.html script (offscreen.js);
// send() delivers a message to its listeners the way Chrome would.
function makeOffscreen() {
  const listeners = [];
  const textarea = { value: '', select() {} };
  const sb = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    chrome: { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } },
    document: {
      getElementById: () => textarea,
      execCommand: () => true,
    },
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'offscreen.js'), 'utf8'), sb);
  return {
    textarea,
    send(msg) {
      return new Promise((resolve) => {
        let answered = false;
        const reply = (r) => { answered = true; resolve(r); };
        let async = false;
        for (const fn of listeners) if (fn(msg, { id: 'ext' }, reply) === true) async = true;
        if (!async && !answered) resolve(undefined);
      });
    },
  };
}

// Every URL any test environment fetched and every runtime message it sent,
// for the suite-wide checks at the end.
const ALL_FETCHES = [];
const ALL_SENT = [];

function makeEnv(initialStorage = {}, opts = {}) {
  const storage = { ...initialStorage };
  const alarms = {};
  const notifications = [];
  const listeners = { push: [], pushsubscriptionchange: [], message: [], alarm: [], storageChanged: [], installed: [], startup: [], notificationClicked: [] };
  let fetchHandler = () => { throw new Error('fetch not stubbed'); };
  let intervalSeq = 0;
  const fetchLog = [];

  const env = {
    storage, alarms, notifications, listeners, fetchLog, sentMessages: [],
    // Live setInterval timers (id -> { fn, ms }); they never fire on their own.
    intervals: new Map(), platformInfoCalls: 0,
    setFetch(fn) { fetchHandler = fn; },
    sandbox: null,
  };

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (opts.failGets > 0) { opts.failGets--; throw new Error('transient storage error'); }
          if (typeof keys === 'string') keys = [keys];
          const out = {};
          // Copy like real chrome.storage (which serializes): returning live
          // references hid missing persistQueues() calls from the tests.
          for (const k of keys) if (k in storage) out[k] = structuredClone(storage[k]);
          return out;
        },
        set: async (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) changes[k] = { oldValue: storage[k], newValue: structuredClone(v) };
          Object.assign(storage, structuredClone(obj));
          for (const fn of listeners.storageChanged) fn(changes, 'local');
        },
        remove: async (keys) => {
          if (typeof keys === 'string') keys = [keys];
          const changes = {};
          for (const k of keys) if (k in storage) { changes[k] = { oldValue: storage[k] }; delete storage[k]; }
          if (Object.keys(changes).length) for (const fn of listeners.storageChanged) fn(changes, 'local');
        },
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) },
    },
    alarms: {
      create: (name, opts) => { alarms[name] = opts; },
      get: async (name) => (name in alarms ? { name, ...alarms[name] } : undefined),
      clear: async (name) => { const had = name in alarms; delete alarms[name]; return had; },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    runtime: {
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      sendMessage: async (msg) => {
        env.sentMessages.push(msg.action);
        ALL_SENT.push(msg.action);
        // The offscreen document answers only clipboard writes.
        if (msg.action === 'clipboard-write') { env.clipboard = msg.text; return { copied: true }; }
        return undefined;
      },
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      getPlatformInfo: async () => { env.platformInfoCalls++; return { os: 'mac' }; },
      getURL: (p) => p,
      lastError: null,
    },
    identity: {
      getAuthToken: (opts, cb) => cb(env.authToken ?? 'tok'),
      removeCachedAuthToken: (opts, cb) => cb(),
    },
    notifications: {
      create: (id, opts) => notifications.push({ id, opts }),
      clear: () => {},
      onClicked: { addListener: (fn) => listeners.notificationClicked.push(fn) },
    },
    action: {
      setBadgeText: (o) => { env.badge = o.text; },
      setBadgeBackgroundColor: () => {},
    },
    offscreen: { createDocument: async () => {} },
  };

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    chrome,
    fetch: (...args) => { fetchLog.push(args[0]); ALL_FETCHES.push(String(args[0])); return fetchHandler(...args); },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextDecoder, TextEncoder, URLSearchParams, BigInt, Uint8Array, Promise,
    JSON, Math, Date, String, Number, Set, Array, Object, Error, RegExp, Buffer,
    // Collapse sleeps for fast tests. Long timers (the 60s Nano timeout) never
    // fire, unless opts.fireLongTimers makes them fire on the next turn.
    setTimeout: (fn, ms) => {
      if (ms > 30000) { if (opts.fireLongTimers) setImmediate(fn); return 0; }
      fn();
      return 0;
    },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { const id = ++intervalSeq; env.intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { env.intervals.delete(id); },
    AbortController,
    self: {},
    importScripts: (...files) => {
      for (const f of files) {
        if (f === 'config.js') {
          sandbox.CONFIG = {
            GCP_TOPIC_NAME: 'projects/test/topics/t',
            VAPID_PUBLIC_KEY: 'dGVzdGtleSE',
            REGISTER_PUSH_URL: 'https://register.example/',
          };
        } else {
          vm.runInContext(fs.readFileSync(path.join(EXT_DIR, f), 'utf8'), sandbox);
        }
      }
    },
  };
  // The Prompt API in the service worker, where Nano runs.
  if (opts.LanguageModel) sandbox.LanguageModel = opts.LanguageModel;
  sandbox.self.registration = {
    pushManager: {
      getSubscription: async () => env.subscription ?? null,
      subscribe: async (opts) => {
        env.subscribeOpts = opts;
        env.subscription = {
          options: { applicationServerKey: opts.applicationServerKey },
          toJSON: () => ({ endpoint: 'https://push.example/ep' }),
          unsubscribe: async () => { env.subscription = null; },
        };
        return env.subscription;
      },
    },
  };
  sandbox.self.addEventListener = (type, fn) => listeners[type].push(fn);
  sandbox.globalThis = sandbox;

  const code = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  env.sandbox = sandbox;
  return env;
}

function jsonResponse(obj, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    json: async () => obj, text: async () => JSON.stringify(obj),
  };
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function gmailMessage(id, body, subject = 'Your code', from = 'sec@example.com') {
  return {
    id,
    internalDate: String(Date.now()), // fresh by default (age gate is real, not NaN)
    snippet: 'snippet text',
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }],
      body: { data: b64url(body) },
    },
  };
}

const ask = (env, message) => new Promise((resolve) => {
  for (const fn of env.listeners.message) fn(message, {}, resolve);
});

async function firePush(env) {
  let done;
  const evt = { data: { json: () => ({ type: 'gmail_update', historyId: '999' }) }, waitUntil: (p) => { done = p; } };
  for (const fn of env.listeners.push) fn(evt);
  await done;
}

// Routes a push's Gmail fetches. History lists `history` (default: every id in
// `messages`) as messagesAdded; pass `history: []` to test draining the
// persisted queue. /messages/<id>? serves messages[id]: a body string (wrapped
// with gmailMessage and `subject`) or a full message. `routes` ({ urlPart: fn })
// are tried first. Anything else throws (e.g. a cloud model).
function mailFetch(env, { messages = {}, history = Object.keys(messages), historyId = '200', subject, routes = {}, headers } = {}) {
  env.setFetch(async (url, init) => {
    url = String(url);
    for (const [part, fn] of Object.entries(routes)) if (url.includes(part)) return fn(url, init);
    if (url.includes('/history?')) {
      const added = history.length ? [{ messagesAdded: history.map((id) => ({ message: { id } })) }] : [];
      return jsonResponse({ historyId, history: added }, 200, headers);
    }
    const id = /\/messages\/([^/?]+)\?/.exec(url)?.[1];
    if (id && Object.hasOwn(messages, id)) {
      const m = messages[id];
      return jsonResponse(typeof m === 'string' ? gmailMessage(id, m, subject) : m, 200, headers);
    }
    throw new Error('unexpected fetch: ' + url);
  });
}

// The one cloud model host this extension must never call.
const isCloudModelUrl = (u) => /generativelanguage\.googleapis\.com/.test(String(u));
const cloudFetches = (env) => env.fetchLog.filter(isCloudModelUrl).length;

// Everything startMonitoring fetches: profile, register-push, watch.
const monitoringRoutes = {
  '/profile': () => jsonResponse({ historyId: '77' }),
  'https://register.example/': () => jsonResponse({ success: true }),
  '/watch': () => jsonResponse({ historyId: '77', expiration: String(Date.now() + 7 * 86400000) }),
};

// Every getAuthToken call fails with `message` (Chrome's lastError).
function denyAuth(env, message) {
  env.sandbox.chrome.identity.getAuthToken = (opts, cb) => {
    env.sandbox.chrome.runtime.lastError = { message };
    cb(undefined);
    env.sandbox.chrome.runtime.lastError = null;
  };
}

// One background.js instance for the pure functions (extractBody,
// looksLikeCodeEmail, isPlausibleCode), which read and write no module state.
const pure = makeEnv().sandbox;
// Gmail payload builders: a text part (optionally with a declared charset), a
// multipart part, and extractBody over a payload.
const textPart = (mimeType, data, charset) => ({
  mimeType,
  ...(charset && { headers: [{ name: 'Content-Type', value: `${mimeType}; charset="${charset}"` }] }),
  body: { data: b64url(data) },
});
const plain = (s, charset) => textPart('text/plain', s, charset);
const html = (s) => textPart('text/html', s);
const multi = (mimeType, ...parts) => ({ mimeType, parts });
const extract = (payload) => pure.extractBody({ payload });

// --- Tests ---

test('extractBody puts text/plain before the HTML rendering and decodes UTF-8', async () => {
  const body = extract(multi('multipart/alternative', html('<b>HTML wins?</b>'), plain('código: 123456 ✓')));
  assert.ok(body.includes('código: 123456 ✓'), `got: ${body}`);
  // Plain first, HTML rendering appended (stub plain parts can't be detected reliably).
  assert.ok(body.indexOf('código') < body.indexOf('HTML wins?'), `plain should come first: ${body}`);
  assert.ok(!body.includes('<b>'), 'HTML is rendered to text');
});

test('extractBody falls back to HTML-only email and strips tags', async () => {
  const body = extract(multi('multipart/mixed', html('<div>Your code is <b>987654</b></div>')));
  assert.ok(body.includes('Your code is'), `got: ${body}`);
  assert.ok(body.includes('987654'));
  assert.ok(!body.includes('<b>'));
});

test('extractBody drops Outlook conditionals, <head>/<style> and preheader padding; code past the old 3000-char cut survives', async () => {
  const css = '.x { color: #333; font-size: 100%; } '.repeat(400); // ~15K chars, like big retail newsletters
  const page = `<!DOCTYPE html><html><head><!--[if gte mso 9]><xml><o:OfficeDocumentSettings>`
    + `<o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->`
    + `<style>${css}</style></head><body><div>͏ ­ ​</div>`
    + `<p>Here's your passcode!</p><p>${'filler text '.repeat(400)}</p><td>975310</td></body></html>`;
  const body = extract(html(page));
  assert.ok(!/\b96\b/.test(body), `Outlook PixelsPerInch leaked: ${body.slice(0, 80)}`);
  assert.ok(!body.includes('font-size'), 'CSS leaked into body');
  assert.ok(!/[͏­​]/.test(body), 'invisible padding leaked');
  assert.ok(body.includes('975310'), 'code beyond 3000 chars must not be truncated');
  assert.ok(body.startsWith("Here's your passcode!"), `got: ${body.slice(0, 80)}`);
});

test('extractBody handles deeply nested multipart', async () => {
  const msg = multi('multipart/mixed', multi('multipart/alternative', plain('nested plain 555'), html('<p>nested html</p>')));
  assert.ok(extract(msg).includes('nested plain 555'));
});

test('history pagination: drains all pages before advancing cursor', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: mockLanguageModel() });
  const seen = [];
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) {
      const hasPageToken = url.includes('pageToken=p2');
      if (!hasPageToken) {
        return jsonResponse({
          historyId: '300',
          nextPageToken: 'p2',
          history: [{ messagesAdded: [{ message: { id: 'm1' } }] }],
        });
      }
      return jsonResponse({
        historyId: '300',
        history: [{ messagesAdded: [{ message: { id: 'm2' } }] }],
      });
    }
    if (url.includes('/messages/m1')) { seen.push('m1'); return jsonResponse(gmailMessage('m1', 'code 111111')); }
    if (url.includes('/messages/m2')) { seen.push('m2'); return jsonResponse(gmailMessage('m2', 'code 222222')); }
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.deepStrictEqual(seen.sort(), ['m1', 'm2'], 'both pages fetched');
  assert.strictEqual(env.storage.lastHistoryId, '300');
});

test('cursor never moves backwards', async () => {
  const env = makeEnv({ lastHistoryId: '500', pushActive: true });
  mailFetch(env, { historyId: '400' }); // stale response
  await firePush(env);
  assert.strictEqual(env.storage.lastHistoryId, '500', 'cursor must not regress');
});

test('processing failure keeps message queued (cursor already advanced is OK)', async () => {
  // Retryable failure: Gmail errors fetching the message.
  const lm = mockLanguageModel({ respond: () => '424242' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
  mailFetch(env, { messages: { mfail: 'your code is 424242' }, routes: { '/messages/mfail?': () => jsonResponse({}, 503) } });
  await firePush(env);
  assert.deepStrictEqual([...env.storage.pendingMessageIds], ['mfail'], 'failed message stays queued');
  assert.strictEqual(env.storage.lastHistoryId, '200');
  assert.ok(!env.storage.detectorError, 'a Gmail error is not "no model"');
  assert.strictEqual(lm.prompts.length, 0);

  // Next push: Gmail answers again — message gets processed from the queue.
  mailFetch(env, { messages: { mfail: 'your code is 424242' }, history: [], historyId: '201' });
  await firePush(env);
  assert.deepStrictEqual([...env.storage.pendingMessageIds], [], 'queue drained');
  assert.strictEqual(env.clipboard, '424242', 'code copied on retry');
});

test('404 history recovery fetches recent messages instead of dropping them', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: mockLanguageModel({ respond: () => '777777' }) });
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ error: 'not found' }, 404);
    if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: 'recent1' }] });
    if (url.includes('/messages/recent1')) return jsonResponse(gmailMessage('recent1', 'code 777777'));
    if (url.includes('/profile')) return jsonResponse({ historyId: '900' });
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.strictEqual(env.clipboard, '777777', 'triggering email recovered after 404');
  assert.strictEqual(env.storage.lastHistoryId, '900');
});

test('null cursor path recovers triggering email via recent messages', async () => {
  const env = makeEnv({ pushActive: true }, { LanguageModel: mockLanguageModel({ respond: () => '313131' }) }); // no lastHistoryId at all
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: 'boot1' }] });
    if (url.includes('/messages/boot1')) return jsonResponse(gmailMessage('boot1', 'OTP 313131'));
    if (url.includes('/profile')) return jsonResponse({ historyId: '50' });
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.strictEqual(env.clipboard, '313131');
  assert.strictEqual(env.storage.lastHistoryId, '50');
});

// Shape + whole-token grounding. Each row: [code, subject, body, accepted, label].
const JWT = 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.sig';
const P20 = 'abcdefghijklmnopqrst';
// {"alg":"HS256"} encodes to exactly 20 chars, so Nano's cap lands on the '.'.
const HS = 'eyJhbGciOiJIUzI1NiJ9';
const JUNK_BODY = 'None of your orders shipped. null true ---- 2025 SAVE20';
for (const [code, subject, body, accepted, label] of [
  ['Save 20% on your next order!', 's', 'b', false, 'long junk'],
  ['', 's', 'b', false, 'empty answer'],
  ['123456', 's', 'Your code is 123 456', true, 'grounded, spacing ignored'],
  ['None', 's', JUNK_BODY, false, 'placeholder None'],
  ['null', 's', JUNK_BODY, false, 'placeholder null'],
  ['true', 's', JUNK_BODY, false, 'placeholder true'],
  ['----', 's', JUNK_BODY, false, 'no alphanumerics'],
  ['482913', 'Your code', 'Thanks for shopping!', false, 'hallucinated code'],
  ['482913', 'Your code is 482-913', 'x', true, 'code found in subject'],
  ['abcdefghijklmnop', 's', 'Your app password: abcd efgh ijkl mnop', true, '16-char app password'],
  ['123456', 's', 'Your code: 123‑456', true, 'non-breaking hyphen'],
  ['123456', 's', 'Your code: 123–456', true, 'en dash'],
  ['123456', 's', 'Your code: 123·456', true, 'middot'],
  ['123456', 's', 'Your code: 123.456', true, 'dot'],
  ['123456', 's', 'Your code: 123 456', true, 'space'],
  ['eyJhbGciOiJIUzUxMiIs', 'Sign in to Acme', `Click https://acme.com/magic?t=${JWT} to sign in`, false, '20-char prefix of a JWT'],
  ['123456', 's', 'Order 91234567 shipped', false, 'digits inside a longer number'],
  ['ABC123', 's', 'ref XABC123', false, 'glued to a preceding letter'],
  ['abc123', 's', 'Your code: ABC123.', true, 'case-insensitive, trailing dot ok'],
  ['123456', 's', 'code (123-456)', true, 'parenthesized and dashed'],
  ['123456', 's', 'code 12_3456', false, 'underscore is not a grouping separator'],
  [P20, '', `token=${P20}_uvwxyz123`, false, 'capped prefix, underscore continuation'],
  [P20, '', `token=${P20}-uvwxyz123`, false, 'capped prefix, dash continuation'],
  [HS, 'Sign in to Acme', `https://acme.com/magic?token=${HS}.eyJzdWIiOiIxIn0.c2ln`, false, '20-char JWT header segment'],
  ['123456', 's', 'x_123456', false, 'underscore before'],
  ['123456', 's', 'Your code is 123456.', true, 'sentence-final dot'],
  ['123456', 's', 'Your code is 123456. It expires soon', true, 'dot then more text'],
  ['123456', 's', '123456 - expires in 10 min', true, 'spaced dash after'],
  ['123456', 's', 'G-123456 is your Google verification code', true, 'prefix label'],
  ['G-123456', 's', 'G-123456 is your Google verification code', true, 'code with its prefix'],
]) {
  test(`isPlausibleCode ${accepted ? 'accepts' : 'rejects'}: ${label}`, () => {
    assert.strictEqual(pure.isPlausibleCode(code, subject, body), accepted);
  });
}

test('grounding stays linear-time on hostile input (no catastrophic backtracking)', () => {
  const t = Date.now();
  pure.isPlausibleCode('aaaaaaaaaaaaaaaaaaab', 's', ('a' + ' '.repeat(50)).repeat(20000));
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t}ms`);
});

test('detectCode grounds the model answer on the live path (ungrounded -> null; spaced answer is stripped)', async () => {
  const answer = { value: '482913' };
  const env = makeEnv({}, { LanguageModel: mockLanguageModel({ respond: () => answer.value }) });
  const detect = (subject, body) => env.sandbox.detectCode(subject, 'f', body);
  assert.strictEqual(await detect('Your code', 'Thanks for shopping!'), null, 'hallucinated code rejected');
  assert.strictEqual(await detect('Your code is 482-913', 'x'), '482913');
  answer.value = 'abcd efgh ijkl mnop';
  assert.strictEqual(await detect('s', 'Your app password: abcd efgh ijkl mnop'), 'abcdefghijklmnop');
});

test('duplicate messages are not reprocessed across pushes (persisted dedup)', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, processedMessageIds: ['dup1'] });
  mailFetch(env, { messages: { dup1: 'code 909090' } });
  await firePush(env);
  assert.ok(!env.fetchLog.some((u) => String(u).includes('/messages/dup1')), 'already-processed message not fetched again');
});

test('setupGmailWatch does NOT overwrite an existing cursor; failures name the watch step', async () => {
  const env = makeEnv({ lastHistoryId: '123', pushActive: true });
  mailFetch(env, { routes: { '/watch': () => jsonResponse({ historyId: '99999', expiration: String(Date.now() + 7 * 86400000) }) } });
  await env.sandbox.restoreState();
  await env.sandbox.setupGmailWatch();
  assert.strictEqual(env.storage.lastHistoryId, '123', 'cursor preserved across watch renewal');
  mailFetch(env, { routes: { '/watch': () => jsonResponse({ error: 'denied' }, 403) } });
  await assert.rejects(env.sandbox.setupGmailWatch(), /^Error: Gmail watch failed: Gmail API 403/);
});

test('stale VAPID key triggers unsubscribe + resubscribe', async () => {
  const env = makeEnv({ subVersion: 2 });
  let unsubscribed = false;
  env.subscription = {
    options: { applicationServerKey: new TextEncoder().encode('OLDKEY').buffer },
    toJSON: () => ({ endpoint: 'https://push.example/old' }),
    unsubscribe: async () => { unsubscribed = true; env.subscription = null; },
  };
  mailFetch(env, { routes: monitoringRoutes });
  await env.sandbox.registerPushSubscription();
  assert.ok(unsubscribed, 'old subscription dropped');
  assert.ok(env.subscription, 'new subscription created');
  assert.strictEqual(env.subscribeOpts.userVisibleOnly, false, 'silent pushes enabled');
});

test('concurrent pushes coalesce into a single drain (single-flight)', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true });
  let historyCalls = 0;
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) {
      historyCalls++;
      await new Promise((r) => setImmediate(r));
      return jsonResponse({ historyId: '200', history: [] });
    }
    throw new Error('unexpected fetch: ' + url);
  });
  await env.sandbox.restoreState();
  const p1 = env.sandbox.checkForNewEmails();
  const p2 = env.sandbox.checkForNewEmails();
  await Promise.all([p1, p2]);
  assert.ok(historyCalls <= 2, `expected coalesced drains, got ${historyCalls}`);
  assert.strictEqual(p1, p2, 'second call returns the in-flight promise');
});

test('server staleEndpoint response mints a fresh subscription', async () => {
  const env = makeEnv({ subVersion: 2 });
  // Existing subscription with the CURRENT vapid key (so key check passes)
  const curKey = env.sandbox.urlBase64ToUint8Array('dGVzdGtleSE');
  let unsubCount = 0;
  env.subscription = {
    options: { applicationServerKey: curKey },
    toJSON: () => ({ endpoint: 'https://push.example/dead' }),
    unsubscribe: async () => { unsubCount++; env.subscription = null; },
  };
  let registerCalls = 0;
  env.setFetch(async (url, opts) => {
    if (String(url).startsWith('https://register.example/')) {
      registerCalls++;
      const body = JSON.parse(opts.body);
      if (body.subscription.endpoint === 'https://push.example/dead') {
        return jsonResponse({ success: false, staleEndpoint: true });
      }
      return jsonResponse({ success: true });
    }
    throw new Error('unexpected fetch: ' + url);
  });
  // Make subscribe() mint an endpoint distinct from the dead one
  env.sandbox.self.registration.pushManager.subscribe = async (o) => {
    env.subscription = {
      options: { applicationServerKey: o.applicationServerKey },
      toJSON: () => ({ endpoint: 'https://push.example/fresh-' + registerCalls }),
      unsubscribe: async () => { env.subscription = null; },
    };
    return env.subscription;
  };
  await env.sandbox.registerPushSubscription();
  assert.strictEqual(unsubCount, 1, 'dead subscription dropped');
  assert.strictEqual(registerCalls, 2, 'fresh subscription registered on second lap');
});

test('restoreState recovers after a transient storage failure', async () => {
  const opts = { failGets: 1 }; // module-load restoreState hits this failure
  const env = makeEnv({ lastHistoryId: '42', pushActive: true }, opts);
  // Joining the in-flight failed restore rejects (callers handle errors)...
  await assert.rejects(env.sandbox.restoreState(), /transient/);
  // ...but the poisoned-promise bug would cache that rejection forever; the
  // fix resets statePromise so the NEXT call re-reads storage successfully.
  // (let-bound module state isn't reachable on the vm global, so observe the
  // restored state through the getStatus handler.)
  const status = await ask(env, { action: 'getStatus' });
  assert.strictEqual(status.pushActive, true, 'state restored after transient failure');
});

test('processing stops at first retryable failure preserving order', async () => {
  let env;
  // a1 is detected; then Gmail errors on a2, so it fails retryably before
  // reaching the model.
  const lm = mockLanguageModel({ respond: () => '111111' });
  env = makeEnv({ lastHistoryId: '10', pushActive: true }, { LanguageModel: lm });
  mailFetch(env, {
    messages: { a1: 'code 111111', a2: 'code 222222', a3: 'code 333333' }, historyId: '20',
    routes: { '/messages/a2?': () => jsonResponse({}, 503) },
  });
  await firePush(env);
  // a1 processed; a2 failed -> stop; a3 still queued BEHIND a2 (order preserved)
  assert.deepStrictEqual([...env.storage.pendingMessageIds], ['a2', 'a3'], 'order preserved on failure');
  assert.strictEqual(env.clipboard, '111111');
  assert.strictEqual(lm.prompts.length, 1, 'only a1 reached the model');
});

// --- Regression tests for the deep-review fixes ---

// No usable on-device model: mail stays queued (not consumed as "no code") and
// the notification names what's missing.
for (const [opts, nano, advice] of [
  [{}, 'unsupported', /Chrome 138\+/], // no Prompt API in the worker
  [{ LanguageModel: mockLanguageModel({ availability: 'unavailable', respond: () => '135790' }) }, 'unavailable', /isn't available on this device.*RAM/],
]) {
  test(`Nano ${nano}: mail stays queued and the error names the requirements`, async () => {
    const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, opts);
    mailFetch(env, { messages: { k1: 'Your code is 135790' } });
    await firePush(env);
    assert.strictEqual(env.clipboard, undefined);
    assert.strictEqual(opts.LanguageModel?.prompts.length ?? 0, 0);
    assert.strictEqual(cloudFetches(env), 0);
    assert.deepStrictEqual(env.storage.pendingMessageIds, ['k1'], 'message stays queued');
    assert.ok(!(env.storage.processedMessageIds || []).includes('k1'), 'not marked processed');
    assert.strictEqual(env.storage.detectorError.nano, nano);
    const note = env.notifications.find((n) => n.id === 'detector-error');
    assert.ok(note, 'user is told');
    assert.match(note.opts.message, advice, 'names the requirements');
    assert.doesNotMatch(note.opts.message, /key/i, 'no API key advice');
  });
}

// Login codes expire: anything older than MAX_CODE_AGE_MS is consumed without
// a model call. Arrival is the later of internalDate and Gmail's own Received
// stamp. Real-world case for the Received rows: an airline OTP sender's Date
// header was 12h in the past ("8:23:59 +0530" for 20:23:59), Gmail copied it
// into internalDate, and the age gate dropped a fresh code.
function withReceived(msg, receivedMs, internalMs) {
  const stamp = new Date(receivedMs).toUTCString().replace('GMT', '-0000');
  msg.internalDate = String(internalMs);
  msg.payload.headers.unshift(
    { name: 'Received', value: `by 2001:db8::1 with SMTP id test123abc;        ${stamp} (UTC)` },
    { name: 'Received', value: `from smtp.example (1.2.3.4) by relay; ${new Date(internalMs).toUTCString()}` },
  );
  return msg;
}

for (const [internalAgoMin, receivedAgoMin, copied] of [
  [14, null, true], [16, null, false], [60, null, false],
  [720, 1, true], [720, 60, false],
]) {
  const received = receivedAgoMin === null ? '' : `, Received ${receivedAgoMin} min ago`;
  test(`age gate: internalDate ${internalAgoMin} min ago${received} -> ${copied ? 'copied' : 'skipped'}`, async () => {
    const lm = mockLanguageModel({ respond: () => '246810' });
    const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
    const msg = gmailMessage('m', '246810 is your One Time Password. Do not share this OTP with anyone.', 'OTP for your airline account');
    const internalMs = Date.now() - internalAgoMin * 60000;
    if (receivedAgoMin === null) msg.internalDate = String(internalMs);
    else withReceived(msg, Date.now() - receivedAgoMin * 60000, internalMs);
    mailFetch(env, { messages: { m: msg } });
    await firePush(env);
    assert.strictEqual(env.clipboard, copied ? '246810' : undefined);
    assert.strictEqual(lm.prompts.length, copied ? 1 : 0, 'no model call for a stale code');
    assert.deepStrictEqual(env.storage.pendingMessageIds, [], 'consumed');
  });
}

test('recovery processes recent messages oldest-first so the newest code ends on the clipboard', async () => {
  const lm = mockLanguageModel({ respond: (t) => (t.includes('222222') ? '222222' : '111111') });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ error: 'not found' }, 404);
    if (url.includes('/profile')) return jsonResponse({ historyId: '900' });
    // messages.list returns newest first
    if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: 'new' }, { id: 'old' }] });
    if (url.includes('/messages/new')) return jsonResponse(gmailMessage('new', 'code 222222'));
    if (url.includes('/messages/old')) return jsonResponse(gmailMessage('old', 'code 111111'));
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.ok(lm.prompts[0].includes('111111') && lm.prompts[1].includes('222222'), 'oldest first');
  assert.strictEqual(env.clipboard, '222222', 'resent (newest) code wins');
});

test('recovery that fails to list messages leaves the cursor alone so the next drain retries', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true });
  const order = [];
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ error: 'not found' }, 404);
    if (url.includes('/profile')) { order.push('profile'); return jsonResponse({ historyId: '900' }); }
    if (url.includes('/messages?')) { order.push('list'); return jsonResponse({ error: 'backend' }, 503); }
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.strictEqual(env.storage.lastHistoryId, '100', 'cursor not reset past the unprocessed email');
  assert.deepStrictEqual(order, ['profile', 'list'], 'profile historyId read BEFORE listing');
});

test('labelAdded INBOX (e.g. "Not spam") is enqueued, and duplicate ids in one batch are processed once', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: mockLanguageModel() });
  let fetches = 0;
  let historyUrl;
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) {
      historyUrl = url;
      return jsonResponse({ historyId: '200', history: [
        { messagesAdded: [{ message: { id: 'a' } }] },
        { labelsAdded: [{ message: { id: 'a' }, labelIds: ['INBOX'] }] },
        { labelsAdded: [{ message: { id: 'spam1' }, labelIds: ['INBOX'] }] },
        { labelsAdded: [{ message: { id: 'starred' }, labelIds: ['STARRED'] }] },
      ] });
    }
    if (url.includes('/messages/')) { fetches++; return jsonResponse(gmailMessage('x', 'nothing here')); }
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.ok(/historyTypes=messageAdded/.test(historyUrl) && /historyTypes=labelAdded/.test(historyUrl));
  assert.strictEqual(fetches, 2, 'a once + spam1; STARRED ignored');
});

test('extractBody leaves "<" in plain text alone (no tag stripping on text/plain)', async () => {
  const body = extract(plain('Code expires in <10 minutes.\nYour code: 482913\nHelp: <https://help.x.com>'));
  assert.ok(body.includes('482913'), `got: ${body}`);
});

test('extractBody adds the HTML when the plain part is a stub without the code', async () => {
  const msg = multi('multipart/alternative', plain('View this email in your browser: https://x.com/v'), html('<p>Your code is <b>482913</b></p>'));
  assert.ok(extract(msg).includes('482913'));
});

test('extractBody decodes the declared charset and numeric entities', async () => {
  assert.ok(extract(plain(Buffer.from('Votre code: 482913 — café', 'latin1'), 'ISO-8859-1')).includes('café'));
  assert.ok(extract(html('<p>Code: &#52;&#56;&#50;&#57;&#49;&#51;</p>')).includes('482913'));
});

test('extractBody stays fast on hostile input (no quadratic regex)', async () => {
  for (const evil of ['1 < 2 '.repeat(200000), '<!-- '.repeat(200000), '<style '.repeat(200000)]) {
    const t = Date.now();
    extract(html('Your code 123456 ' + evil));
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t}ms`);
  }
});

test('offline token failure does not raise the sticky re-authorization alert', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true });
  denyAuth(env, 'OAuth2 request failed: Connection failed (-106).');
  await firePush(env);
  assert.ok(!env.storage.needsAuth);
  assert.ok(!env.notifications.some((n) => n.id === 'needs-auth'));
});

test('silent auth failure flags needsAuth and notifies once, not on every subsequent push', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true });
  denyAuth(env, 'OAuth2 not granted or revoked.');
  await firePush(env);
  await firePush(env);
  await firePush(env);
  assert.strictEqual(env.storage.needsAuth, true);
  assert.strictEqual(env.notifications.filter((n) => n.id === 'needs-auth').length, 1);
});

test('health check updates pushActive in both directions', async () => {
  const env = makeEnv({ setupDone: true, pushActive: false, lastHistoryId: '100', subVersion: 2, watchExpiration: Date.now() + 5 * 86400000 });
  let registerOk = true;
  mailFetch(env, { historyId: '100', routes: {
    'https://register.example/': () => (registerOk ? jsonResponse({ success: true }) : jsonResponse({ error: 'x' }, 500)),
  } });
  await env.sandbox.restoreState();
  await env.sandbox.healthCheck();
  assert.strictEqual(env.storage.pushActive, true, 'healed push is reported');
  registerOk = false;
  await env.sandbox.healthCheck();
  assert.strictEqual(env.storage.pushActive, false, 'dead push is reported');
});

// Listeners that fire-and-forget a promise chain (alarms, startup, notification
// clicks): let it run to completion. Mock timers fire synchronously, so a few
// macrotask turns are enough.
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

const nearExpiry = () => Date.now() + 60000; // inside WATCH_RENEW_MARGIN_MS
const farExpiry = () => Date.now() + 5 * 86400000;

test('the health-check alarm renews a watch close to expiry; unknown and prototype-named alarms do nothing', async () => {
  const env = makeEnv({ setupDone: true, pushActive: true, lastHistoryId: '100', subVersion: 2, watchExpiration: nearExpiry() });
  const before = env.storage.watchExpiration;
  mailFetch(env, { historyId: '100', routes: monitoringRoutes });
  env.listeners.alarm[0]({ name: 'health-check' });
  await settle();
  assert.ok(env.fetchLog.some((u) => String(u).includes('/watch')), 'watch renewed');
  assert.ok(env.storage.watchExpiration > before + 86400000, 'expiration moved forward');
  assert.strictEqual(env.storage.pushActive, true);

  for (const name of ['toString', 'constructor', 'gmail-watch-renew']) {
    const quiet = makeEnv({ setupDone: true, lastHistoryId: '100', subVersion: 2, watchExpiration: nearExpiry() });
    mailFetch(quiet, { routes: monitoringRoutes });
    assert.doesNotThrow(() => quiet.listeners.alarm[0]({ name }), name);
    await settle();
    assert.deepStrictEqual(quiet.fetchLog, [], name);
  }
});

test('the health check leaves a watch that is far from expiry alone', async () => {
  const env = makeEnv({ setupDone: true, lastHistoryId: '100', subVersion: 2, watchExpiration: farExpiry() });
  mailFetch(env, { historyId: '100', routes: monitoringRoutes });
  await env.sandbox.restoreState();
  await env.sandbox.healthCheck();
  assert.ok(!env.fetchLog.some((u) => String(u).includes('/watch')));
  assert.ok(env.fetchLog.some((u) => String(u).includes('https://register.example/')), 'push re-registered');
});

test('Start always re-creates the watch, even one far from expiry', async () => {
  const env = makeEnv({ lastHistoryId: '100', subVersion: 2, watchExpiration: farExpiry() }, { LanguageModel: mockLanguageModel() });
  mailFetch(env, { historyId: '100', routes: monitoringRoutes });
  await env.sandbox.startMonitoring();
  assert.ok(env.fetchLog.some((u) => String(u).includes('/watch')));
});

for (const event of ['installed', 'startup']) {
  test(`on ${event}: health-check alarm exists, needs-auth alert re-raised, mail queued while Chrome was closed drains, push repaired`, async () => {
    const lm = mockLanguageModel({ respond: () => '135790' });
    const env = makeEnv({
      setupDone: true, needsAuth: true, pushActive: true, lastHistoryId: '100', subVersion: 2,
      watchExpiration: farExpiry(), pendingMessageIds: ['s1'],
    }, { LanguageModel: lm });
    mailFetch(env, { messages: { s1: 'Your code is 135790' }, history: [], historyId: '100', routes: monitoringRoutes });
    assert.strictEqual(env.listeners[event].length, 1);
    env.listeners[event][0]();
    await settle();
    assert.ok(env.alarms['health-check'], 'alarm scheduled');
    assert.ok(env.notifications.some((n) => n.id === 'needs-auth'), 'alert re-raised after restart');
    assert.deepStrictEqual(env.storage.pendingMessageIds, [], 'queue drained');
    assert.strictEqual(env.clipboard, '135790');
    assert.ok(env.fetchLog.some((u) => String(u).includes('https://register.example/')), 'push re-registered');
  });
}

test('on startup before setup: nothing is scheduled, raised or fetched', async () => {
  const env = makeEnv({ needsAuth: true });
  mailFetch(env, { routes: monitoringRoutes });
  env.listeners.startup[0]();
  await settle();
  assert.deepStrictEqual(env.alarms, {});
  assert.deepStrictEqual(env.notifications, []);
  assert.deepStrictEqual(env.fetchLog, []);
});

// Clicking the needs-auth notification re-authorizes. After setup it also
// drains and repairs push; before setup it re-authorizes only (draining would
// raise a bogus alert for a brand-new user).
for (const { setupDone, drains } of [{ setupDone: true, drains: true }, { setupDone: false, drains: false }]) {
  test(`needs-auth click with setupDone=${setupDone}: re-authorizes${drains ? ', drains and repairs push' : ' only, fetches nothing'}`, async () => {
    const lm = mockLanguageModel({ respond: () => '246813' });
    // No pushActive: restoreState would migrate it to setupDone=true.
    const env = makeEnv({
      setupDone, needsAuth: true, lastHistoryId: '100', subVersion: 2,
      watchExpiration: farExpiry(), pendingMessageIds: ['c1'],
    }, { LanguageModel: lm });
    mailFetch(env, { messages: { c1: 'Your code is 246813' }, history: [], historyId: '100', routes: monitoringRoutes });
    let interactive;
    const realGet = env.sandbox.chrome.identity.getAuthToken;
    env.sandbox.chrome.identity.getAuthToken = (opts, cb) => { interactive ??= opts.interactive; realGet(opts, cb); };
    env.listeners.notificationClicked[0]('needs-auth');
    await settle();
    assert.strictEqual(interactive, true, 'interactive prompt allowed on click');
    assert.strictEqual(env.storage.needsAuth, false);
    if (drains) {
      assert.deepStrictEqual(env.storage.pendingMessageIds, [], 'queue drained');
      assert.strictEqual(env.clipboard, '246813');
      assert.ok(env.fetchLog.some((u) => String(u).includes('https://register.example/')), 'push re-registered');
    } else {
      assert.deepStrictEqual(env.fetchLog, []);
      assert.deepStrictEqual(env.storage.pendingMessageIds, ['c1']);
    }
  });
}

test('needs-auth click whose consent fails re-raises the alert; other notification clicks are ignored', async () => {
  const env = makeEnv({ setupDone: true, needsAuth: true, lastHistoryId: '100' });
  mailFetch(env, { routes: monitoringRoutes });
  denyAuth(env, 'The user did not approve access.');
  env.listeners.notificationClicked[0]('needs-auth');
  await settle();
  assert.strictEqual(env.notifications.filter((n) => n.id === 'needs-auth').length, 1, 're-raised');
  assert.strictEqual(env.storage.needsAuth, true);
  assert.deepStrictEqual(env.fetchLog, []);

  const other = makeEnv({ setupDone: true, needsAuth: true, lastHistoryId: '100' });
  mailFetch(other, { routes: monitoringRoutes });
  other.listeners.notificationClicked[0]('code-copied');
  await settle();
  assert.deepStrictEqual(other.fetchLog, []);
  assert.strictEqual(other.storage.needsAuth, true);
});

test('register-push sends the OAuth token for server-side authentication', async () => {
  const env = makeEnv({ subVersion: 2 });
  let auth;
  mailFetch(env, { routes: {
    'https://register.example/': (url, opts) => { auth = opts.headers.Authorization; return jsonResponse({ success: true }); },
  } });
  await env.sandbox.registerPushSubscription();
  assert.strictEqual(auth, 'Bearer tok');
});

// --- Regression tests for the second (fix-diff) review ---

test('stripHiddenBlocks keeps indices aligned when text contains İ (Turkish dotted capital I)', async () => {
  const body = extract(html('<p>Merhaba, İŞ BANKASI İNTERNET ŞUBESİ giriş kodunuz: <b>482913</b></p><!-- c --><p>İyi günler</p>'));
  assert.ok(body.includes('kodunuz: 482913'), `got: ${body}`);
  assert.ok(!body.includes('<'), `markup leaked: ${body}`);
  assert.ok(body.endsWith('İyi günler'), `got: ${body}`);
});

test('an unclosed <head>/<style> no longer deletes the rest of the document; </header> does not close <head>', async () => {
  const x = (page) => extract(html(page));
  assert.ok(x('<html><head><meta charset=utf-8><body><p>Your code is 482913</p>').includes('482913'));
  assert.ok(x('<style>.a{}<p>Your code is 482913</p>').includes('482913'));
  const b = x('<head><title>t</title></header>hidden</head><p>Your code is 482913</p>');
  assert.ok(b.includes('482913') && !b.includes('hidden'), `got: ${b}`);
});

test('HTML is included even when a stub plain part contains a year/ZIP', async () => {
  const msg = multi('multipart/alternative',
    plain('View this email in your browser. © 2026 Acme Inc, 548 Market St, San Francisco CA 94104'),
    html('<p>Your code is <b>482913</b></p>'));
  assert.ok(extract(msg).includes('482913'));
});

test('age gate uses Google\'s clock (Date header), so a fast local clock does not drop fresh codes', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: mockLanguageModel({ respond: () => '246802' }) });
  const realNow = Date.now();
  const fastBy = 60 * 60000; // local clock 1h fast
  env.sandbox.Date = class extends Date { static now() { return realNow + fastBy; } };
  mailFetch(env, {
    messages: { m: { ...gmailMessage('m', 'code 246802'), internalDate: String(realNow - 60000) } },
    headers: { date: new Date(realNow).toUTCString() },
  });
  await firePush(env);
  assert.strictEqual(env.clipboard, '246802');
});

test('checkNow before setup does nothing (no bogus needs-auth alert for new users)', async () => {
  const env = makeEnv({});
  denyAuth(env, 'OAuth2 not granted or revoked.');
  const resp = await ask(env, { action: 'checkNow' });
  assert.strictEqual(resp.success, true);
  assert.ok(!env.storage.needsAuth);
  assert.ok(!env.notifications.some((n) => n.id === 'needs-auth'));
});

test('popup commands answer through one table; unknown and prototype-named actions are left for other listeners', async () => {
  const env = makeEnv({});
  for (const action of ['toString', 'constructor', 'clipboard-write', 'codeDetected']) {
    let answered = false;
    const ret = env.listeners.message[0]({ action }, {}, () => { answered = true; });
    assert.strictEqual(ret, false, action);
    assert.strictEqual(answered, false, action);
  }
});

test('installs upgraded without setupDone persist it, so a failed repair keeps monitoring on', async () => {
  const env = makeEnv({ pushActive: true, lastHistoryId: '100', subVersion: 2, watchExpiration: Date.now() + 5 * 86400000 });
  mailFetch(env, { historyId: '100', routes: { 'https://register.example/': () => jsonResponse({ error: 'x' }, 500) } });
  await env.sandbox.restoreState();
  assert.strictEqual(env.storage.setupDone, true, 'migrated');
  await env.sandbox.healthCheck();
  assert.strictEqual(env.storage.pushActive, false);
  const fresh = makeEnv({ ...env.storage });
  await fresh.sandbox.restoreState();
  const status = await ask(fresh, { action: 'getStatus' });
  assert.strictEqual(status.setupDone, true, 'still set up after restart');
  assert.match(status.pushError, /500/);
});

test('register-push: 401 evicts the cached token and retries; 403 surfaces an allow-list error', async () => {
  const env = makeEnv({ subVersion: 2 });
  let evicted = false;
  env.sandbox.chrome.identity.removeCachedAuthToken = (o, cb) => { evicted = true; env.authToken = 'tok2'; cb(); };
  const seen = [];
  env.setFetch(async (url, opts) => {
    seen.push(opts.headers.Authorization);
    return opts.headers.Authorization === 'Bearer tok2' ? jsonResponse({ success: true }) : jsonResponse({}, 401);
  });
  await env.sandbox.registerPushSubscription();
  assert.ok(evicted);
  assert.deepStrictEqual(seen, ['Bearer tok', 'Bearer tok2']);
  env.setFetch(async () => jsonResponse({ error: 'Account not allowed' }, 403));
  await assert.rejects(env.sandbox.registerPushSubscription(), /ALLOWED_EMAILS/);
});

// --- Gemini Nano (on-device) ---

test('pre-filter skips a marketing email without calling any model', async () => {
  const lm = mockLanguageModel({ respond: () => '123456' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
  mailFetch(env, { messages: { mk: 'Save 20% on order 123456 with SAVE20. Shop now!' }, subject: 'Black Friday starts now' });
  await firePush(env);
  assert.strictEqual(lm.prompts.length, 0, 'Nano not called');
  assert.strictEqual(env.clipboard, undefined);
  assert.deepStrictEqual(env.storage.pendingMessageIds, [], 'consumed');
  assert.ok(env.storage.processedMessageIds.includes('mk'));
});

test('pre-filter passes a blank-subject "Code is 9999" email (body-start rule)', async () => {
  assert.strictEqual(pure.looksLikeCodeEmail('', 'Code is 9999'), true);
  assert.strictEqual(pure.looksLikeCodeEmail('', 'Hi! Here is the agenda for 9999 Main St.'), false);
  assert.strictEqual(pure.looksLikeCodeEmail('Hello', 'Your one-time password: 482913'), true);
  const lm = mockLanguageModel({ respond: () => '9999' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
  mailFetch(env, { messages: { b: 'Code is 9999' }, subject: '' });
  await firePush(env);
  assert.strictEqual(env.clipboard, '9999');
});

test('pre-filter DONE rule skips "Your email address was verified..." unless the body leads with a code', async () => {
  const gate = pure.looksLikeCodeEmail;
  assert.strictEqual(gate('Your email address was verified for Example DNS', 'Hello, you have successfully verified an email address. You can now start sending email.'), false);
  assert.strictEqual(gate('Your account has been verified', 'Welcome aboard!'), false);
  assert.strictEqual(gate('Your email was verified', 'Your verification code is 123456'), true, 'body-start wins');
  assert.strictEqual(gate('Verify your email', 'Enter 123456 to continue'), true);
  assert.strictEqual(gate('Your sign-in code', 'Enter 123456'), true);
});

test('Nano path copies a code in the worker with no cloud fetch, one session per email', async () => {
  const lm = mockLanguageModel({ respond: () => '482913' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  mailFetch(env, { messages: { n1: 'Your verification code is 482913. It expires in 10 minutes.' } });
  await firePush(env);
  assert.strictEqual(env.clipboard, '482913');
  assert.strictEqual(cloudFetches(env), 0, 'email text never left the machine');
  assert.strictEqual(lm.prompts.length, 1);
  assert.strictEqual(lm.created, 1, 'one session per email');
  assert.strictEqual(lm.destroyed, 1, 'session destroyed');
  assert.ok(env.sentMessages.includes('clipboard-write'));
  assert.ok(!env.sentMessages.some((a) => a.startsWith('nano-')), 'ran in the worker, not offscreen');
});

test('Nano gets the shared prompt builder\'s text, the maxLength schema and English session options', async () => {
  const lm = mockLanguageModel({ respond: () => '' });
  const env = makeEnv({}, { LanguageModel: lm });
  await env.sandbox.detectCode('Subj', 'a@b.c', 'Body 1');
  assert.strictEqual(lm.prompts[0], env.sandbox.buildCodePrompt('a@b.c', 'Subj', 'Body 1'));
  assert.ok(lm.prompts[0].includes('From: a@b.c\nSubject: Subj\nBody:\nBody 1'));
  assert.strictEqual(lm.promptOpts[0].responseConstraint.properties.login_code.maxLength, 21);
  assert.ok(lm.promptOpts[0].signal, 'abortable');
  const { signal, ...sessionOpts } = lm.createOpts[0];
  assert.ok(signal, 'create() is abortable');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sessionOpts)), {
    expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }],
  });
});

test('Nano downloadable: mail stays queued, detectorError set, a single notification; cleared once the model is ready', async () => {
  const lm = mockLanguageModel({ availability: 'downloadable', respond: () => '111111' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  mailFetch(env, { messages: { q1: 'Your login code is 111111' }, subject: 'Sign in to Acme' });
  await firePush(env);
  await firePush(env);
  assert.deepStrictEqual(env.storage.pendingMessageIds, ['q1'], 'stays queued');
  assert.strictEqual(env.storage.detectorError.nano, 'downloadable');
  const notes = env.notifications.filter((n) => n.id === 'detector-error');
  assert.strictEqual(notes.length, 1, 'notified once, not on every drain');
  assert.strictEqual(notes[0].opts.title, "Codes aren't being copied");
  assert.match(notes[0].opts.message, /download/i);
  assert.doesNotMatch(notes[0].opts.message, /key/i, 'download is the only advice');
  assert.strictEqual(lm.prompts.length, 0);
  const status = await ask(env, { action: 'getStatus' });
  assert.strictEqual(status.nanoAvailability, 'downloadable');
  assert.ok(status.detectorError);

  lm.availabilityValue = 'available'; // user downloaded it from the popup
  await firePush(env);
  assert.strictEqual(env.clipboard, '111111');
  assert.deepStrictEqual(env.storage.pendingMessageIds, []);
  assert.strictEqual(env.storage.detectorError, null, 'cleared on the next successful detection');
});

test('Nano throws once: retried on a fresh session and the code is copied', async () => {
  const lm = mockLanguageModel({ failPrompts: 1, respond: () => '246810' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  mailFetch(env, { messages: { f1: 'Your code is 246810' } });
  await firePush(env);
  assert.strictEqual(env.clipboard, '246810');
  assert.strictEqual(lm.prompts.length, 2, 'one retry');
  assert.strictEqual(lm.created, 2, 'retry used a fresh session');
  assert.ok(!env.storage.nanoFailStreak, 'a recovered email is not a failure');
});

test('Nano throws twice: that message is consumed without a copy and the queue continues', async () => {
  const lm = mockLanguageModel({ failPrompts: 2, respond: (t) => (t.includes('222222') ? '222222' : '111111') });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
  mailFetch(env, { messages: { x1: 'Your code is 111111', x2: 'Your code is 222222' } });
  await firePush(env);
  assert.strictEqual(lm.prompts.length, 3, 'x1 tried twice, x2 once');
  assert.strictEqual(lm.created, 3, 'each try used a fresh session');
  assert.strictEqual(env.clipboard, '222222', 'x1 skipped, x2 copied');
  assert.deepStrictEqual(env.storage.pendingMessageIds, []);
  assert.ok(!env.storage.detectorError);
});

test('Nano hangs: each try times out, the email is consumed and the queue continues', async () => {
  const lm = mockLanguageModel({ hang: true });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm, fireLongTimers: true });
  mailFetch(env, { messages: { t1: 'Your code is 864200' } });
  await firePush(env);
  assert.strictEqual(env.clipboard, undefined);
  assert.strictEqual(lm.prompts.length, 2, 'tried twice');
  assert.deepStrictEqual(env.storage.pendingMessageIds, [], 'never blocks the queue');
  assert.strictEqual(env.storage.nanoFailStreak, 1);
});

// A pending prompt() is not worker activity, so a long Nano call would hit the
// 30s idle timeout without the keep-alive ping.
test('Nano keeps the worker alive while a prompt is pending and stops once it settles (success, throw, hang)', async () => {
  const cases = [
    [{ respond: () => '482913' }, {}, '482913'],
    [{ failPrompts: 2 }, {}, undefined],
    [{ hang: true }, { fireLongTimers: true }, undefined],
  ];
  for (const [lmOpts, envOpts, copied] of cases) {
    let env;
    const during = [];
    const lm = mockLanguageModel({
      ...lmOpts,
      onPrompt: () => {
        const live = [...env.intervals.values()];
        const before = env.platformInfoCalls;
        for (const { fn } of live) fn();
        during.push({ live: live.length, ms: live.map((i) => i.ms), pinged: env.platformInfoCalls - before });
      },
    });
    env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { ...envOpts, LanguageModel: lm });
    mailFetch(env, { messages: { k1: 'Your code is 482913' } });
    await firePush(env);
    const label = JSON.stringify(lmOpts);
    assert.strictEqual(env.clipboard, copied, label);
    assert.ok(during.length >= 1, label);
    for (const d of during) {
      assert.strictEqual(d.live, 1, `${label}: one keep-alive interval during the prompt`);
      assert.ok(d.ms[0] > 0 && d.ms[0] < 30000, `${label}: pings inside the 30s idle window`);
      assert.ok(d.pinged >= 1, `${label}: the ping calls an extension API`);
    }
    assert.strictEqual(env.intervals.size, 0, `${label}: keep-alive cleared afterwards`);
  }
});

test('offscreen.js answers clipboard writes only; Nano and every other action are left unanswered', async () => {
  const doc = makeOffscreen();
  assert.strictEqual((await doc.send({ action: 'clipboard-write', text: '192837' })).copied, true);
  assert.strictEqual(doc.textarea.value, '192837');
  for (const action of ['nano-detect', 'nano-availability', 'getStatus', 'codeDetected']) {
    assert.strictEqual(await doc.send({ action }), undefined, `${action} is not answered`);
  }
  const page = fs.readFileSync(path.join(EXT_DIR, 'offscreen.html'), 'utf8');
  assert.doesNotMatch(page, /nano\.js/, 'the offscreen document does not load Nano');
});

test('a body longer than the context window is truncated by fitBody to fit', async () => {
  const lm = mockLanguageModel({ contextWindow: 1000, respond: () => '' });
  const env = makeEnv({}, { LanguageModel: lm });
  const body = 'Your code is 482913. ' + 'lorem ipsum dolor sit amet '.repeat(2000);
  const r = await env.sandbox.nanoExtract({ from: 'f', subject: 's', body }, { timeoutMs: 60000 });
  assert.strictEqual(r.truncated, true);
  const sent = lm.prompts[0];
  assert.ok(Math.ceil(sent.length / 4) <= 1000 - 64, `prompt too long: ${sent.length} chars`);
  assert.ok(Math.ceil(sent.length / 4) > 1000 - 64 - 200, 'kept close to the largest prefix that fits');
  assert.ok(sent.includes('Your code is 482913.'), 'prefix kept');
  const small = await env.sandbox.nanoExtract({ from: 'f', subject: 's', body: 'Your code is 1' }, {});
  assert.strictEqual(small.truncated, false);
});

test('nanoExtract parses login_code, strips whitespace, and returns "" on non-JSON', async () => {
  const lm = mockLanguageModel({ respond: () => ' 123 456 ' });
  const env = makeEnv({}, { LanguageModel: lm });
  const r = await env.sandbox.nanoExtract({ from: 'f', subject: 's', body: 'b' });
  assert.strictEqual(r.code, '123456');
  assert.strictEqual(r.raw, JSON.stringify({ login_code: ' 123 456 ' }));
  lm.create = async () => ({ contextWindow: 9216, measureContextUsage: async () => 1, prompt: async () => 'not json', destroy() {} });
  const r2 = await env.sandbox.nanoExtract({ body: 'b' });
  assert.strictEqual(r2.code, '');
});

test('nanoAvailability reports unsupported without the Prompt API', async () => {
  assert.strictEqual(await pure.nanoAvailability(), 'unsupported');
  const env2 = makeEnv({}, { LanguageModel: mockLanguageModel({ availability: 'downloading' }) });
  assert.strictEqual(await env2.sandbox.nanoAvailability(), 'downloading');
});

test('getStatus reports the model availability and no cloud fields', async () => {
  let st = await ask(makeEnv({}, { LanguageModel: mockLanguageModel() }), { action: 'getStatus' });
  assert.strictEqual(st.nanoAvailability, 'available');
  st = await ask(makeEnv(), { action: 'getStatus' });
  assert.strictEqual(st.nanoAvailability, 'unsupported');
  assert.ok(!('hasApiKey' in st) && !('geminiError' in st) && !('engine' in st), 'no cloud or engine fields');
  st = await ask(makeEnv({}, { LanguageModel: mockLanguageModel({ availability: 'downloading' }) }), { action: 'getStatus' });
  assert.strictEqual(st.nanoAvailability, 'downloading');
  // A failed status read is an error, not a "Not set up" install.
  st = await ask(makeEnv({}, { failGets: 2 }), { action: 'getStatus' });
  assert.deepStrictEqual(Object.keys(st), ['error']);
});

test('startMonitoring is allowed while the model is downloadable; refused when unavailable or unsupported', async () => {
  const env = makeEnv({ subVersion: 2 }, { LanguageModel: mockLanguageModel({ availability: 'downloadable' }) });
  mailFetch(env, { routes: monitoringRoutes });
  await env.sandbox.startMonitoring();
  assert.strictEqual(env.storage.setupDone, true);
  assert.strictEqual(env.storage.pushActive, true);
  const env2 = makeEnv({}, { LanguageModel: mockLanguageModel({ availability: 'unavailable' }) });
  await assert.rejects(env2.sandbox.startMonitoring(), /on-device model/);
  assert.ok(!env2.storage.setupDone);
  const env3 = makeEnv({}); // no Prompt API in the worker
  await assert.rejects(env3.sandbox.startMonitoring(), /on-device model.*Chrome 138\+/);
  assert.ok(!env3.storage.setupDone);
});

test('startMonitoring surfaces a push setup failure but still records setup as done', async () => {
  const env = makeEnv({ subVersion: 2 }, { LanguageModel: mockLanguageModel() });
  mailFetch(env, { routes: { ...monitoringRoutes, 'https://register.example/': () => jsonResponse({}, 403) } });
  await assert.rejects(env.sandbox.startMonitoring(), /ALLOWED_EMAILS/);
  assert.strictEqual(env.storage.setupDone, true, 'the health check keeps repairing push');
  assert.strictEqual(env.storage.pushActive, false);
  assert.match(env.storage.pushError, /ALLOWED_EMAILS/);
  assert.ok(env.fetchLog.some((u) => String(u).includes('/watch')), 'the watch is still attempted');
});

test('detectorError clears once an engine is usable, even if the backlog never reaches a model', async () => {
  const lm = mockLanguageModel({ availability: 'downloadable' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  mailFetch(env, { messages: { d1: 'Your login code is 111111' }, subject: 'Sign in to Acme' });
  await firePush(env);
  assert.ok(env.storage.detectorError);
  lm.availabilityValue = 'available';
  // The queued mail is now too old: consumed by the age gate, no model call.
  mailFetch(env, {
    messages: { d1: { ...gmailMessage('d1', 'Your login code is 111111'), internalDate: String(Date.now() - 3600000) } },
    history: [], historyId: '300',
  });
  await firePush(env);
  assert.strictEqual(lm.prompts.length, 0);
  assert.strictEqual(env.storage.detectorError, null);
  // getStatus clears it too.
  const env2 = makeEnv({ detectorError: { message: 'x', at: 1, nano: 'downloadable' } }, { LanguageModel: mockLanguageModel() });
  const st = await ask(env2, { action: 'getStatus' });
  assert.strictEqual(st.detectorError, null);
});

test('the download poll alarm notices the model is ready, clears detectorError and drains the queue', async () => {
  const lm = mockLanguageModel({ availability: 'downloading', respond: () => '424242' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  mailFetch(env, { messages: { p1: 'Your login code is 424242' }, subject: 'Sign in to Acme' });
  await firePush(env);
  assert.ok(env.alarms['nano-ready-poll'], 'polling while Chrome downloads');
  assert.deepStrictEqual(env.storage.pendingMessageIds, ['p1']);
  await env.sandbox.pollNanoReady();
  assert.ok(env.alarms['nano-ready-poll'], 'still downloading: keep polling');
  lm.availabilityValue = 'available';
  await env.sandbox.pollNanoReady();
  assert.ok(!env.alarms['nano-ready-poll'], 'stopped');
  assert.strictEqual(env.storage.detectorError, null);
  assert.strictEqual(env.clipboard, '424242');
  // The popup starts the same poll when its Download button is clicked.
  const env2 = makeEnv({}, { LanguageModel: mockLanguageModel({ availability: 'downloadable' }) });
  await ask(env2, { action: 'watchNanoDownload' });
  assert.ok(env2.alarms['nano-ready-poll']);
});

test('repeated double failures raise one alert; a success resets the streak', async () => {
  // A model that always fails: each code email is consumed, and after
  // NANO_FAIL_ALERT_STREAK in a row the user is told (once).
  const lm = mockLanguageModel({ failPrompts: 99 });
  const env2 = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  for (let i = 0; i < 4; i++) {
    mailFetch(env2, { messages: { [`z${i}`]: 'Your code is 777777' } });
    await firePush(env2);
  }
  assert.deepStrictEqual(env2.storage.pendingMessageIds, [], 'never blocks');
  assert.strictEqual(env2.notifications.filter((n) => n.id === 'nano-failing').length, 1);
  let st = await ask(env2, { action: 'getStatus' });
  assert.strictEqual(st.nanoFailing, true);
  lm.failPrompts = 0;
  lm.availabilityValue = 'available';
  mailFetch(env2, { messages: { z9: 'Your code is 777777' } });
  await firePush(env2);
  st = await ask(env2, { action: 'getStatus' });
  assert.strictEqual(st.nanoFailing, false, 'a success resets the streak');
});

test('ensureOffscreenDocument tolerates losing the creation race', async () => {
  const env = makeEnv();
  env.sandbox.chrome.runtime.getContexts = async () => [];
  env.sandbox.chrome.offscreen.createDocument = async () => { throw new Error('Only a single offscreen document may be created.'); };
  await env.sandbox.ensureOffscreenDocument();
  env.sandbox.chrome.offscreen.createDocument = async () => { throw new Error('boom'); };
  await assert.rejects(env.sandbox.ensureOffscreenDocument(), /boom/);
});

test('popup and manifests have no API key field or cloud model host', async () => {
  const page = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
  assert.ok(!/api-key|save-key|type="password"/i.test(page), 'no key input');
  for (const f of ['manifest.example.json', 'manifest.json']) {
    const file = path.join(EXT_DIR, f);
    if (!fs.existsSync(file)) continue; // manifest.json is gitignored
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!manifest.host_permissions.some(isCloudModelUrl), `${f} grants no cloud model host`);
  }
  for (const f of ['background.js', 'nano.js', 'offscreen.js', 'popup.js']) {
    const src = fs.readFileSync(path.join(EXT_DIR, f), 'utf8');
    assert.ok(!isCloudModelUrl(src), `${f} references no cloud model endpoint`);
  }
});

test('popup.css keeps the hidden attribute authoritative over .btn display', async () => {
  const css = fs.readFileSync(path.join(EXT_DIR, 'popup.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('no code path in this suite ever sent a nano-* message (Nano runs only in the worker)', async () => {
  assert.ok(ALL_SENT.includes('clipboard-write'), 'the suite exercised the offscreen clipboard path');
  assert.deepStrictEqual(ALL_SENT.filter((a) => /^nano-/.test(a)), []);
});

// Must stay the last test (node:test runs top-level tests in order): it checks
// what every environment above fetched.
test('no code path in this suite ever fetched generativelanguage.googleapis.com', async () => {
  assert.ok(ALL_FETCHES.length > 50, 'the suite exercised real fetch paths');
  assert.deepStrictEqual(ALL_FETCHES.filter(isCloudModelUrl), []);
});
