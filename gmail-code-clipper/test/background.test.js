// Unit/behavior tests for background.js run under Node with mocked chrome.* APIs.
// Run: node gmail-code-clipper/test/background.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- chrome.* / service worker mocks ---

const EXT_DIR = path.join(__dirname, '..');

// Mock Prompt API (global LanguageModel). respond(promptText) -> login_code;
// measure(text) -> tokens (default: proportional to length). failPrompts:
// how many upcoming prompt() calls throw a generic UnknownError. hang: prompt()
// never settles until aborted.
function mockLanguageModel({
  availability = 'available', respond = () => '', measure = (t) => Math.ceil(t.length / 4),
  contextWindow = 9216, failPrompts = 0, hang = false,
} = {}) {
  const lm = {
    availabilityValue: availability, failPrompts, hang,
    created: 0, clones: 0, destroyed: 0, prompts: [], promptOpts: [], createOpts: [],
    availability: async () => lm.availabilityValue,
    create: async (opts) => { lm.created++; lm.createOpts.push(opts); return session(); },
  };
  function session() {
    return {
      contextWindow, contextUsage: 0,
      measureContextUsage: async (text) => measure(text),
      clone: async () => { lm.clones++; return session(); },
      destroy: () => { lm.destroyed++; },
      prompt: (text, opts) => {
        lm.prompts.push(text);
        lm.promptOpts.push(opts);
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

// A second vm context running the real offscreen.html scripts (nano.js +
// offscreen.js) with its own LanguageModel; the worker's sendMessage is routed
// to its listeners the way Chrome would.
function makeOffscreen(LanguageModel) {
  const listeners = [];
  const sb = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    chrome: { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } },
    document: {
      getElementById: () => ({ value: '', select() {} }),
      execCommand: () => true,
    },
    setTimeout: () => 0, clearTimeout: () => {}, AbortController, JSON, String, Promise, Error, Math,
  };
  if (LanguageModel) sb.LanguageModel = LanguageModel;
  sb.globalThis = sb;
  vm.createContext(sb);
  for (const f of ['nano.js', 'offscreen.js']) vm.runInContext(fs.readFileSync(path.join(EXT_DIR, f), 'utf8'), sb);
  const received = [];
  return {
    received,
    send(msg) {
      received.push(msg.action);
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

// Every URL any test environment fetched, for the suite-wide "never calls a
// cloud model" check at the end.
const ALL_FETCHES = [];

function makeEnv(initialStorage = {}, opts = {}) {
  const storage = { ...initialStorage };
  const alarms = {};
  const notifications = [];
  const listeners = { push: [], pushsubscriptionchange: [], message: [], alarm: [], storageChanged: [], installed: [], startup: [] };
  let fetchHandler = () => { throw new Error('fetch not stubbed'); };
  const fetchLog = [];

  const env = {
    storage, alarms, notifications, listeners, fetchLog, sentMessages: [], storageRemoves: 0,
    // true: the offscreen document never answers nano-* messages (model host unreachable).
    offscreenDown: false,
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
          env.storageRemoves++;
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
        if (msg.action === 'clipboard-write') { env.clipboard = msg.text; return { copied: true }; }
        if (msg.action.startsWith('nano-')) {
          if (env.offscreenDown) return undefined;
          if (env.offscreen) return env.offscreen.send(msg);
          // Real offscreen document in a Chrome without the Prompt API.
          if (msg.action === 'nano-availability') return { availability: 'unsupported' };
          return { error: 'NotSupportedError: LanguageModel is not defined' };
        }
        return undefined;
      },
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
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
      onClicked: { addListener: () => {} },
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
  // Prompt API in the service worker itself, or only in the offscreen document.
  // A browser with it in the worker has it in its pages too: the offscreen
  // document shares the same model (and mock), which the worker falls back to
  // after its own Prompt API fails.
  if (opts.LanguageModel) sandbox.LanguageModel = opts.LanguageModel;
  const offscreenLM = opts.offscreenLanguageModel || opts.LanguageModel;
  if (offscreenLM) env.offscreen = makeOffscreen(offscreenLM);
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

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// --- Tests ---

test('extractBody puts text/plain before the HTML rendering and decodes UTF-8', async () => {
  const env = makeEnv();
  const extractBody = env.sandbox.extractBody;
  const msg = {
    payload: {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<b>HTML wins?</b>') } },
        { mimeType: 'text/plain', body: { data: b64url('código: 123456 ✓') } },
      ],
    },
  };
  const body = extractBody(msg);
  assert.ok(body.includes('código: 123456 ✓'), `got: ${body}`);
  // Plain first, HTML rendering appended (stub plain parts can't be detected reliably).
  assert.ok(body.indexOf('código') < body.indexOf('HTML wins?'), `plain should come first: ${body}`);
  assert.ok(!body.includes('<b>'), 'HTML is rendered to text');
});

test('extractBody falls back to HTML-only email and strips tags', async () => {
  const env = makeEnv();
  const msg = {
    payload: {
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'text/html', body: { data: b64url('<div>Your code is <b>987654</b></div>') } }],
    },
  };
  const body = env.sandbox.extractBody(msg);
  assert.ok(body.includes('Your code is'), `got: ${body}`);
  assert.ok(body.includes('987654'));
  assert.ok(!body.includes('<b>'));
});

test('extractBody drops Outlook conditionals, <head>/<style> and preheader padding; code past the old 3000-char cut survives', async () => {
  const env = makeEnv();
  const css = '.x { color: #333; font-size: 100%; } '.repeat(400); // ~15K chars, like big retail newsletters
  const html = `<!DOCTYPE html><html><head><!--[if gte mso 9]><xml><o:OfficeDocumentSettings>`
    + `<o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->`
    + `<style>${css}</style></head><body><div>͏ ­ ​</div>`
    + `<p>Here's your passcode!</p><p>${'filler text '.repeat(400)}</p><td>975310</td></body></html>`;
  const body = env.sandbox.extractBody({ payload: { mimeType: 'text/html', body: { data: b64url(html) } } });
  assert.ok(!/\b96\b/.test(body), `Outlook PixelsPerInch leaked: ${body.slice(0, 80)}`);
  assert.ok(!body.includes('font-size'), 'CSS leaked into body');
  assert.ok(!/[͏­​]/.test(body), 'invisible padding leaked');
  assert.ok(body.includes('975310'), 'code beyond 3000 chars must not be truncated');
  assert.ok(body.startsWith("Here's your passcode!"), `got: ${body.slice(0, 80)}`);
});

test('extractBody handles deeply nested multipart', async () => {
  const env = makeEnv();
  const msg = {
    payload: {
      mimeType: 'multipart/mixed',
      parts: [{
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('nested plain 555') } },
          { mimeType: 'text/html', body: { data: b64url('<p>nested html</p>') } },
        ],
      }],
    },
  };
  assert.ok(env.sandbox.extractBody(msg).includes('nested plain 555'));
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
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '400', history: [] }); // stale response
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.strictEqual(env.storage.lastHistoryId, '500', 'cursor must not regress');
});

test('processing failure keeps message queued (cursor already advanced is OK)', async () => {
  // Retryable failure: the model host (offscreen document) doesn't answer.
  const lm = mockLanguageModel({ respond: () => '424242' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { offscreenLanguageModel: lm });
  env.offscreenDown = true;
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) {
      return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'mfail' } }] }] });
    }
    if (url.includes('/messages/mfail')) return jsonResponse(gmailMessage('mfail', 'your code is 424242'));
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.deepStrictEqual([...env.storage.pendingMessageIds], ['mfail'], 'failed message stays queued');
  assert.strictEqual(env.storage.lastHistoryId, '200');
  assert.ok(!env.storage.detectorError, 'an unreachable host is not "no model"');

  // Next push: the host answers again — message gets processed from the queue.
  env.offscreenDown = false;
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '201', history: [] });
    if (url.includes('/messages/mfail')) return jsonResponse(gmailMessage('mfail', 'your code is 424242'));
    throw new Error('unexpected fetch: ' + url);
  });
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

// detectCodeWithNano against a model that answers `answer.value`.
function nanoDetector(answer) {
  const env = makeEnv({}, { LanguageModel: mockLanguageModel({ respond: () => answer.value }) });
  return (subject, from, body) => env.sandbox.detectCodeWithNano(subject, from, body);
}

test('hallucination filter rejects junk codes', async () => {
  const answer = { value: '' };
  const detect = nanoDetector(answer);
  answer.value = 'Save 20% on your next order!';
  assert.strictEqual(await detect('s', 'f', 'b'), null, 'long junk rejected');
  answer.value = '123456';
  assert.strictEqual(await detect('s', 'f', 'Your code is 123 456'), '123456', 'grounded, spacing ignored');
  answer.value = '';
  assert.strictEqual(await detect('s', 'f', 'b'), null);
});

test('sanity filter rejects placeholder words and codes not present in the email', async () => {
  const answer = { value: '' };
  const detect = nanoDetector(answer);
  const body = 'None of your orders shipped. null true ---- 2025 SAVE20';
  for (const junk of ['None', 'null', 'true', '----']) {
    answer.value = junk;
    assert.strictEqual(await detect('s', 'f', body), null, `${junk} rejected`);
  }
  answer.value = '482913';
  assert.strictEqual(await detect('Your code', 'f', 'Thanks for shopping!'), null, 'hallucinated code rejected');
  assert.strictEqual(await detect('Your code is 482-913', 'f', 'x'), '482913', 'code found in subject');
});

test('duplicate messages are not reprocessed across pushes (persisted dedup)', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, processedMessageIds: ['dup1'] });
  let fetched = 0;
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'dup1' } }] }] });
    if (url.includes('/messages/dup1')) { fetched++; return jsonResponse(gmailMessage('dup1', 'code 909090')); }
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.strictEqual(fetched, 0, 'already-processed message not fetched again');
});

test('setupGmailWatch does NOT overwrite an existing cursor', async () => {
  const env = makeEnv({ lastHistoryId: '123', pushActive: true });
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/watch')) return jsonResponse({ historyId: '99999', expiration: String(Date.now() + 7 * 86400000) });
    throw new Error('unexpected fetch: ' + url);
  });
  await env.sandbox.restoreState();
  await env.sandbox.setupGmailWatch();
  assert.strictEqual(env.storage.lastHistoryId, '123', 'cursor preserved across watch renewal');
  assert.ok(env.alarms['gmail-watch-renew'], 'renewal alarm scheduled');
});

test('watch renewal failure schedules a retry alarm', async () => {
  const env = makeEnv({ pushActive: true });
  env.setFetch(async (url) => {
    if (String(url).includes('/watch')) return jsonResponse({ error: 'boom' }, 500);
    throw new Error('unexpected fetch: ' + url);
  });
  await env.sandbox.restoreState();
  await env.sandbox.renewWatchWithRetry();
  assert.ok(env.alarms['gmail-watch-renew'], 'retry alarm exists after failure');
  assert.strictEqual(env.alarms['gmail-watch-renew'].delayInMinutes, 15);
});

test('silent auth failure flags needsAuth and raises a notification', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true });
  env.sandbox.chrome.identity.getAuthToken = (opts, cb) => {
    env.sandbox.chrome.runtime.lastError = { message: 'OAuth2 not granted' };
    cb(undefined);
    env.sandbox.chrome.runtime.lastError = null;
  };
  await firePush(env);
  assert.strictEqual(env.storage.needsAuth, true);
  assert.ok(env.notifications.some((n) => n.id === 'needs-auth'), 'needs-auth notification shown');
});

test('stale VAPID key triggers unsubscribe + resubscribe', async () => {
  const env = makeEnv({ subVersion: 2 });
  let unsubscribed = false;
  env.subscription = {
    options: { applicationServerKey: new TextEncoder().encode('OLDKEY').buffer },
    toJSON: () => ({ endpoint: 'https://push.example/old' }),
    unsubscribe: async () => { unsubscribed = true; env.subscription = null; },
  };
  env.setFetch(async (url) => {
    if (String(url).startsWith('https://register.example/')) return jsonResponse({ success: true });
    throw new Error('unexpected fetch: ' + url);
  });
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
  const status = await new Promise((resolve) => {
    env.listeners.message[0]({ action: 'getStatus' }, null, resolve);
  });
  assert.strictEqual(status.pushActive, true, 'state restored after transient failure');
});

test('processing stops at first retryable failure preserving order', async () => {
  let env;
  // a1 is detected; right after, the model host stops answering, so a2 fails
  // retryably before reaching the model.
  const lm = mockLanguageModel({ respond: () => { env.offscreenDown = true; return '111111'; } });
  env = makeEnv({ lastHistoryId: '10', pushActive: true }, { offscreenLanguageModel: lm });
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) {
      return jsonResponse({ historyId: '20', history: [
        { messagesAdded: [{ message: { id: 'a1' } }, { message: { id: 'a2' } }, { message: { id: 'a3' } }] },
      ]});
    }
    if (url.includes('/messages/a1')) return jsonResponse(gmailMessage('a1', 'code 111111'));
    if (url.includes('/messages/a2')) return jsonResponse(gmailMessage('a2', 'code 222222'));
    if (url.includes('/messages/a3')) return jsonResponse(gmailMessage('a3', 'code 333333'));
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  // a1 processed; a2 failed -> stop; a3 still queued BEHIND a2 (order preserved)
  assert.deepStrictEqual([...env.storage.pendingMessageIds], ['a2', 'a3'], 'order preserved on failure');
  assert.strictEqual(env.clipboard, '111111');
  assert.strictEqual(lm.prompts.length, 1, 'only a1 reached the model');
});

test('16-char app password passes the sanity filter', async () => {
  const detect = nanoDetector({ value: 'abcd efgh ijkl mnop' });
  const code = await detect('s', 'f', 'Your app password: abcd efgh ijkl mnop');
  assert.strictEqual(code, 'abcdefghijklmnop');
});

// --- Regression tests for the deep-review fixes ---

test('no on-device model keeps messages queued and surfaces an error (not silently consumed)', async () => {
  // Chrome without the Prompt API anywhere (offscreen reports 'unsupported').
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true });
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'k1' } }] }] });
    if (url.includes('/messages/k1')) return jsonResponse(gmailMessage('k1', 'code 111111'));
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.deepStrictEqual(env.storage.pendingMessageIds, ['k1'], 'message stays queued');
  assert.ok(!(env.storage.processedMessageIds || []).includes('k1'), 'not marked processed');
  assert.strictEqual(env.storage.detectorError.nano, 'unsupported');
  const note = env.notifications.find((n) => n.id === 'detector-error');
  assert.ok(note, 'user is told');
  assert.match(note.opts.message, /Chrome 138\+/, 'names the requirements');
  assert.doesNotMatch(note.opts.message, /key/i, 'no API key advice');
});

test('startMonitoring refuses when this Chrome has no on-device model', async () => {
  const env = makeEnv({}); // offscreen reports 'unsupported'
  await assert.rejects(env.sandbox.startMonitoring(), /on-device model.*Chrome 138\+/);
  assert.ok(!env.storage.setupDone);
});

test('messages older than MAX_CODE_AGE_MS are skipped without calling the model', async () => {
  const lm = mockLanguageModel({ respond: () => '999999' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'old1' } }] }] });
    if (url.includes('/messages/old1')) return jsonResponse({ ...gmailMessage('old1', 'code 999999'), internalDate: String(Date.now() - 3600000) });
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.strictEqual(lm.prompts.length, 0);
  assert.strictEqual(env.clipboard, undefined, 'stale code not copied');
  assert.deepStrictEqual(env.storage.pendingMessageIds, [], 'consumed');
});

// Real-world case: an airline OTP sender's Date header was 12h in the past ("8:23:59 +0530"
// for 20:23:59), Gmail copied it into internalDate, and the age gate dropped a
// fresh code. Gmail's own Received stamp is the arrival time.
function withReceived(msg, receivedMs, internalMs) {
  const stamp = new Date(receivedMs).toUTCString().replace('GMT', '-0000');
  msg.internalDate = String(internalMs);
  msg.payload.headers.unshift(
    { name: 'Received', value: `by 2001:db8::1 with SMTP id test123abc;        ${stamp} (UTC)` },
    { name: 'Received', value: `from smtp.example (1.2.3.4) by relay; ${new Date(internalMs).toUTCString()}` },
  );
  return msg;
}

for (const [label, receivedAgoMin, expectCopied] of [
  ['fresh arrival with a 12h-stale internalDate is processed', 1, true],
  ['old arrival is still skipped even with a Received header', 60, false],
]) {
  test(`age gate: ${label}`, async () => {
    const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: mockLanguageModel({ respond: () => '246810' }) });
    const body = '246810 is your One Time Password. Do not share this OTP with anyone.';
    env.setFetch(async (url) => {
      url = String(url);
      if (url.includes('/history?')) return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'ind' } }] }] });
      if (url.includes('/messages/ind')) {
        return jsonResponse(withReceived(gmailMessage('ind', body, 'OTP for your airline account'),
          Date.now() - receivedAgoMin * 60000, Date.now() - 12 * 3600000));
      }
      throw new Error('unexpected fetch: ' + url);
    });
    await firePush(env);
    assert.strictEqual(env.clipboard, expectCopied ? '246810' : undefined);
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
  const env = makeEnv();
  const body = env.sandbox.extractBody(gmailMessage('p', 'Code expires in <10 minutes.\nYour code: 482913\nHelp: <https://help.x.com>'));
  assert.ok(body.includes('482913'), `got: ${body}`);
});

test('extractBody adds the HTML when the plain part is a stub without the code', async () => {
  const env = makeEnv();
  const msg = { payload: { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: { data: b64url('View this email in your browser: https://x.com/v') } },
    { mimeType: 'text/html', body: { data: b64url('<p>Your code is <b>482913</b></p>') } },
  ] } };
  assert.ok(env.sandbox.extractBody(msg).includes('482913'));
});

test('extractBody decodes the declared charset and numeric entities', async () => {
  const env = makeEnv();
  const latin1 = Buffer.from('Votre code: 482913 — café', 'latin1');
  const msg = { payload: { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-1"' }],
    body: { data: latin1.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } } };
  assert.ok(env.sandbox.extractBody(msg).includes('café'));
  const html = { payload: { mimeType: 'text/html', body: { data: b64url('<p>Code: &#52;&#56;&#50;&#57;&#49;&#51;</p>') } } };
  assert.ok(env.sandbox.extractBody(html).includes('482913'));
});

test('extractBody stays fast on hostile input (no quadratic regex)', async () => {
  const env = makeEnv();
  for (const evil of ['1 < 2 '.repeat(200000), '<!-- '.repeat(200000), '<style '.repeat(200000)]) {
    const msg = { payload: { mimeType: 'text/html', body: { data: b64url('Your code 123456 ' + evil) } } };
    const t = Date.now();
    env.sandbox.extractBody(msg);
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t}ms`);
  }
});

test('offline token failure does not raise the sticky re-authorization alert', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true });
  env.sandbox.chrome.identity.getAuthToken = (opts, cb) => {
    env.sandbox.chrome.runtime.lastError = { message: 'OAuth2 request failed: Connection failed (-106).' };
    cb(undefined);
    env.sandbox.chrome.runtime.lastError = null;
  };
  await firePush(env);
  assert.ok(!env.storage.needsAuth);
  assert.ok(!env.notifications.some((n) => n.id === 'needs-auth'));
});

test('needs-auth notification is raised once, not on every subsequent push', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true });
  env.sandbox.chrome.identity.getAuthToken = (opts, cb) => {
    env.sandbox.chrome.runtime.lastError = { message: 'OAuth2 not granted or revoked.' };
    cb(undefined);
    env.sandbox.chrome.runtime.lastError = null;
  };
  await firePush(env);
  await firePush(env);
  await firePush(env);
  assert.strictEqual(env.notifications.filter((n) => n.id === 'needs-auth').length, 1);
});

test('health check updates pushActive in both directions', async () => {
  const env = makeEnv({ setupDone: true, pushActive: false, lastHistoryId: '100', subVersion: 2, watchExpiration: Date.now() + 5 * 86400000 });
  let registerOk = true;
  env.setFetch(async (url) => {
    url = String(url);
    if (url.startsWith('https://register.example/')) return registerOk ? jsonResponse({ success: true }) : jsonResponse({ error: 'x' }, 500);
    if (url.includes('/history?')) return jsonResponse({ historyId: '100', history: [] });
    throw new Error('unexpected fetch: ' + url);
  });
  await env.sandbox.restoreState();
  await env.sandbox.healthCheck();
  assert.strictEqual(env.storage.pushActive, true, 'healed push is reported');
  registerOk = false;
  await env.sandbox.healthCheck();
  assert.strictEqual(env.storage.pushActive, false, 'dead push is reported');
});

test('register-push sends the OAuth token for server-side authentication', async () => {
  const env = makeEnv({ subVersion: 2 });
  let auth;
  env.setFetch(async (url, opts) => {
    if (String(url).startsWith('https://register.example/')) { auth = opts.headers.Authorization; return jsonResponse({ success: true }); }
    throw new Error('unexpected fetch: ' + url);
  });
  await env.sandbox.registerPushSubscription();
  assert.strictEqual(auth, 'Bearer tok');
});

// --- Regression tests for the second (fix-diff) review ---

test('stripHiddenBlocks keeps indices aligned when text contains İ (Turkish dotted capital I)', async () => {
  const env = makeEnv();
  const html = '<p>Merhaba, İŞ BANKASI İNTERNET ŞUBESİ giriş kodunuz: <b>482913</b></p><!-- c --><p>İyi günler</p>';
  const body = env.sandbox.extractBody({ payload: { mimeType: 'text/html', body: { data: b64url(html) } } });
  assert.ok(body.includes('kodunuz: 482913'), `got: ${body}`);
  assert.ok(!body.includes('<'), `markup leaked: ${body}`);
  assert.ok(body.endsWith('İyi günler'), `got: ${body}`);
});

test('an unclosed <head>/<style> no longer deletes the rest of the document; </header> does not close <head>', async () => {
  const env = makeEnv();
  const x = (html) => env.sandbox.extractBody({ payload: { mimeType: 'text/html', body: { data: b64url(html) } } });
  assert.ok(x('<html><head><meta charset=utf-8><body><p>Your code is 482913</p>').includes('482913'));
  assert.ok(x('<style>.a{}<p>Your code is 482913</p>').includes('482913'));
  const b = x('<head><title>t</title></header>hidden</head><p>Your code is 482913</p>');
  assert.ok(b.includes('482913') && !b.includes('hidden'), `got: ${b}`);
});

test('HTML is included even when a stub plain part contains a year/ZIP', async () => {
  const env = makeEnv();
  const msg = { payload: { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: { data: b64url('View this email in your browser. © 2026 Acme Inc, 548 Market St, San Francisco CA 94104') } },
    { mimeType: 'text/html', body: { data: b64url('<p>Your code is <b>482913</b></p>') } },
  ] } };
  assert.ok(env.sandbox.extractBody(msg).includes('482913'));
});

test('grounding accepts codes separated by non-breaking hyphen, en dash, middot or dot', async () => {
  const detect = nanoDetector({ value: '123456' });
  for (const shown of ['123‑456', '123–456', '123·456', '123.456', '123 456']) {
    assert.strictEqual(await detect('s', 'f', `Your code: ${shown}`), '123456', shown);
  }
});

test('age gate: 14-minute-old message is processed, 16-minute-old is skipped', async () => {
  for (const [mins, expectCopied] of [[14, true], [16, false]]) {
    const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: mockLanguageModel({ respond: () => '135790' }) });
    env.setFetch(async (url) => {
      url = String(url);
      if (url.includes('/history?')) return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'm' } }] }] });
      if (url.includes('/messages/m')) return jsonResponse({ ...gmailMessage('m', 'code 135790'), internalDate: String(Date.now() - mins * 60000) });
      throw new Error('unexpected fetch: ' + url);
    });
    await firePush(env);
    assert.strictEqual(env.clipboard === '135790', expectCopied, `${mins} min`);
  }
});

test('age gate uses Google\'s clock (Date header), so a fast local clock does not drop fresh codes', async () => {
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: mockLanguageModel({ respond: () => '246802' }) });
  const realNow = Date.now();
  const fastBy = 60 * 60000; // local clock 1h fast
  env.sandbox.Date = class extends Date { static now() { return realNow + fastBy; } };
  const serverDate = { date: new Date(realNow).toUTCString() };
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'm' } }] }] }, 200, serverDate);
    if (url.includes('/messages/m')) return jsonResponse({ ...gmailMessage('m', 'code 246802'), internalDate: String(realNow - 60000) }, 200, serverDate);
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.strictEqual(env.clipboard, '246802');
});

test('checkNow before setup does nothing (no bogus needs-auth alert for new users)', async () => {
  const env = makeEnv({});
  env.sandbox.chrome.identity.getAuthToken = (opts, cb) => {
    env.sandbox.chrome.runtime.lastError = { message: 'OAuth2 not granted or revoked.' };
    cb(undefined);
    env.sandbox.chrome.runtime.lastError = null;
  };
  const resp = await new Promise((resolve) => {
    for (const fn of env.listeners.message) fn({ action: 'checkNow' }, {}, resolve);
  });
  assert.strictEqual(resp.success, true);
  assert.ok(!env.storage.needsAuth);
  assert.ok(!env.notifications.some((n) => n.id === 'needs-auth'));
});

test('installs upgraded without setupDone persist it, so a failed repair keeps monitoring on', async () => {
  const env = makeEnv({ pushActive: true, lastHistoryId: '100', subVersion: 2, watchExpiration: Date.now() + 5 * 86400000 });
  env.setFetch(async (url) => {
    url = String(url);
    if (url.startsWith('https://register.example/')) return jsonResponse({ error: 'x' }, 500);
    if (url.includes('/history?')) return jsonResponse({ historyId: '100', history: [] });
    throw new Error('unexpected fetch: ' + url);
  });
  await env.sandbox.restoreState();
  assert.strictEqual(env.storage.setupDone, true, 'migrated');
  await env.sandbox.healthCheck();
  assert.strictEqual(env.storage.pushActive, false);
  const fresh = makeEnv({ ...env.storage });
  await fresh.sandbox.restoreState();
  const status = await new Promise((resolve) => { for (const fn of fresh.listeners.message) fn({ action: 'getStatus' }, {}, resolve); });
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

// One message `id` through a push. Any other fetch (e.g. a cloud model) throws.
function singleMessageFetch(env, id, body, subject) {
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id } }] }] });
    if (url.includes(`/messages/${id}`)) return jsonResponse(gmailMessage(id, body, subject));
    throw new Error('unexpected fetch: ' + url);
  });
}
const isCloudModelUrl = (u) => /generativelanguage\.googleapis\.com/.test(String(u));
const cloudFetches = (env) => env.fetchLog.filter(isCloudModelUrl).length;

test('pre-filter skips a marketing email without calling any model', async () => {
  const lm = mockLanguageModel({ respond: () => '123456' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
  singleMessageFetch(env, 'mk', 'Save 20% on order 123456 with SAVE20. Shop now!', 'Black Friday starts now');
  await firePush(env);
  assert.strictEqual(lm.prompts.length, 0, 'Nano not called');
  assert.strictEqual(env.clipboard, undefined);
  assert.deepStrictEqual(env.storage.pendingMessageIds, [], 'consumed');
  assert.ok(env.storage.processedMessageIds.includes('mk'));
});

test('pre-filter passes a blank-subject "Code is 9999" email (body-start rule)', async () => {
  const env = makeEnv();
  assert.strictEqual(env.sandbox.looksLikeCodeEmail('', 'Code is 9999'), true);
  assert.strictEqual(env.sandbox.looksLikeCodeEmail('', 'Hi! Here is the agenda for 9999 Main St.'), false);
  assert.strictEqual(env.sandbox.looksLikeCodeEmail('Hello', 'Your one-time password: 482913'), true);
  const lm = mockLanguageModel({ respond: () => '9999' });
  const env2 = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
  singleMessageFetch(env2, 'b', 'Code is 9999', '');
  await firePush(env2);
  assert.strictEqual(env2.clipboard, '9999');
});

test('pre-filter DONE rule skips "Your email address was verified..." unless the body leads with a code', async () => {
  const env = makeEnv();
  const gate = env.sandbox.looksLikeCodeEmail;
  assert.strictEqual(gate('Your email address was verified for Example DNS', 'Hello, you have successfully verified an email address. You can now start sending email.'), false);
  assert.strictEqual(gate('Your account has been verified', 'Welcome aboard!'), false);
  assert.strictEqual(gate('Your email was verified', 'Your verification code is 123456'), true, 'body-start wins');
  assert.strictEqual(gate('Verify your email', 'Enter 123456 to continue'), true);
  assert.strictEqual(gate('Your sign-in code', 'Enter 123456'), true);
});

test('Nano path copies a code with no cloud fetch, even with a legacy key still in storage', async () => {
  const lm = mockLanguageModel({ respond: () => '482913' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, geminiApiKey: 'old', setupDone: true }, { LanguageModel: lm });
  singleMessageFetch(env, 'n1', 'Your verification code is 482913. It expires in 10 minutes.', 'Your code');
  await firePush(env);
  assert.strictEqual(env.clipboard, '482913');
  assert.strictEqual(cloudFetches(env), 0, 'email text never left the machine');
  assert.strictEqual(lm.prompts.length, 1);
  assert.strictEqual(lm.clones, 1, 'one clone per email');
  assert.ok(lm.destroyed >= 1, 'clone destroyed');
  assert.ok(!env.sentMessages.includes('nano-detect'), 'ran in the worker, not offscreen');
});

test('Nano gets the shared prompt builder\'s text, the maxLength schema and English session options', async () => {
  const lm = mockLanguageModel({ respond: () => '' });
  const env = makeEnv({}, { LanguageModel: lm });
  await env.sandbox.detectCodeWithNano('Subj', 'a@b.c', 'Body 1');
  assert.strictEqual(lm.prompts[0], env.sandbox.buildCodePrompt('a@b.c', 'Subj', 'Body 1'));
  assert.ok(lm.prompts[0].includes('From: a@b.c\nSubject: Subj\nBody:\nBody 1'));
  assert.strictEqual(lm.promptOpts[0].responseConstraint.properties.login_code.maxLength, 21);
  assert.ok(lm.promptOpts[0].signal, 'abortable');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(lm.createOpts[0])), {
    expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }],
  });
});

test('Nano unavailable: mail stays queued and the error names the hardware requirements (a legacy key is ignored)', async () => {
  const lm = mockLanguageModel({ availability: 'unavailable', respond: () => '135790' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true, geminiApiKey: 'old' }, { LanguageModel: lm });
  singleMessageFetch(env, 'g1', 'Your code is 135790', 'Your code');
  await firePush(env);
  assert.strictEqual(env.clipboard, undefined);
  assert.strictEqual(lm.prompts.length, 0);
  assert.strictEqual(cloudFetches(env), 0);
  assert.deepStrictEqual(env.storage.pendingMessageIds, ['g1'], 'stays queued');
  assert.strictEqual(env.storage.detectorError.nano, 'unavailable');
  const note = env.notifications.find((n) => n.id === 'detector-error');
  assert.match(note.opts.message, /isn't available on this device.*RAM/);
  assert.doesNotMatch(note.opts.message, /key/i);
});

test('worker Prompt API says unavailable but the offscreen document has the model: monitoring starts and codes still copy there', async () => {
  const workerLM = mockLanguageModel({ availability: 'unavailable', respond: () => '000000' });
  const offscreenLM = mockLanguageModel({ respond: () => '864209' });
  const env = makeEnv({ subVersion: 2 }, { LanguageModel: workerLM, offscreenLanguageModel: offscreenLM });
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/profile')) return jsonResponse({ historyId: '77' });
    if (url.startsWith('https://register.example/')) return jsonResponse({ success: true });
    if (url.includes('/watch')) return jsonResponse({ historyId: '77', expiration: String(Date.now() + 7 * 86400000) });
    throw new Error('unexpected fetch: ' + url);
  });
  await env.sandbox.startMonitoring();
  assert.strictEqual(env.storage.setupDone, true);
  env.storage.pushActive = true;
  singleMessageFetch(env, 'w1', 'Your verification code is 864209', 'Your code');
  await firePush(env);
  assert.strictEqual(env.clipboard, '864209');
  assert.strictEqual(workerLM.prompts.length, 0, 'worker model never prompted');
  assert.strictEqual(offscreenLM.prompts.length, 1);
  assert.ok(env.sentMessages.includes('nano-detect'), 'ran in the offscreen document');
  assert.ok(!env.storage.detectorError);
  assert.strictEqual(cloudFetches(env), 0);
});

test('Nano downloadable: mail stays queued, detectorError set, a single notification; cleared once the model is ready', async () => {
  const lm = mockLanguageModel({ availability: 'downloadable', respond: () => '111111' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  singleMessageFetch(env, 'q1', 'Your login code is 111111', 'Sign in to Acme');
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
  const status = await new Promise((resolve) => { for (const fn of env.listeners.message) fn({ action: 'getStatus' }, {}, resolve); });
  assert.strictEqual(status.engine, 'none');
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
  singleMessageFetch(env, 'f1', 'Your code is 246810', 'Your code');
  await firePush(env);
  assert.strictEqual(env.clipboard, '246810');
  assert.strictEqual(lm.prompts.length, 2, 'one retry');
  assert.ok(lm.created >= 2, 'retry used a fresh base session');
  assert.ok(!env.storage.nanoFailStreak, 'a recovered email is not a failure');
});

test('Nano hangs: each try times out, the email is consumed and the queue continues', async () => {
  const lm = mockLanguageModel({ hang: true });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm, fireLongTimers: true });
  singleMessageFetch(env, 't1', 'Your code is 864200', 'Your code');
  await firePush(env);
  assert.strictEqual(env.clipboard, undefined);
  assert.strictEqual(lm.prompts.length, 2, 'tried twice');
  assert.deepStrictEqual(env.storage.pendingMessageIds, [], 'never blocks the queue');
  assert.strictEqual(env.storage.nanoFailStreak, 1);
});

test('Nano throws twice: that message is consumed without a copy and the queue continues', async () => {
  const lm = mockLanguageModel({ failPrompts: 2, respond: (t) => (t.includes('222222') ? '222222' : '111111') });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true }, { LanguageModel: lm });
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'x1' } }, { message: { id: 'x2' } }] }] });
    if (url.includes('/messages/x1')) return jsonResponse(gmailMessage('x1', 'Your code is 111111'));
    if (url.includes('/messages/x2')) return jsonResponse(gmailMessage('x2', 'Your code is 222222'));
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.strictEqual(lm.prompts.length, 3, 'x1 tried twice, x2 once');
  assert.ok(lm.created >= 2, 'retry used a fresh base session');
  assert.strictEqual(env.clipboard, '222222', 'x1 skipped, x2 copied');
  assert.deepStrictEqual(env.storage.pendingMessageIds, []);
  assert.ok(!env.storage.detectorError);
});

test('service worker without LanguageModel runs Nano in the offscreen document (nano-detect message)', async () => {
  const lm = mockLanguageModel({ respond: () => '192837' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { offscreenLanguageModel: lm });
  assert.strictEqual(typeof env.sandbox.LanguageModel, 'undefined');
  singleMessageFetch(env, 'o1', 'Your security code is 192837', 'Security code');
  await firePush(env);
  assert.strictEqual(env.clipboard, '192837');
  assert.ok(env.offscreen.received.includes('nano-availability'));
  assert.ok(env.offscreen.received.includes('nano-detect'));
  assert.strictEqual(lm.prompts.length, 1);
  // Errors cross the boundary as { error: 'Name: message' } and are retried once.
  lm.failPrompts = 2;
  const errResp = await env.offscreen.send({ action: 'nano-detect', from: 'f', subject: 's', body: 'b' });
  assert.match(errResp.error, /^UnknownError: /);
  // Other actions are left for the worker / popup listeners.
  assert.strictEqual(await env.offscreen.send({ action: 'getStatus' }), undefined);
  const status = await new Promise((resolve) => { for (const fn of env.listeners.message) fn({ action: 'getStatus' }, {}, resolve); });
  assert.strictEqual(status.engine, 'nano');
});

test('whole-token grounding rejects a 20-char prefix of a longer token', async () => {
  const env = makeEnv();
  const ok = env.sandbox.isPlausibleCode;
  const jwt = 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.sig';
  assert.strictEqual(ok('eyJhbGciOiJIUzUxMiIs', 'Sign in to Acme', `Click https://acme.com/magic?t=${jwt} to sign in`), false);
  assert.strictEqual(ok('123456', 's', 'Order 91234567 shipped'), false, 'digits inside a longer number');
  assert.strictEqual(ok('ABC123', 's', 'ref XABC123'), false, 'glued to a preceding letter');
  assert.strictEqual(ok('abc123', 's', 'Your code: ABC123.'), true, 'case-insensitive, trailing dot ok');
  assert.strictEqual(ok('123456', 's', 'code (123-456)'), true);
  assert.strictEqual(ok('123456', 's', 'code 12_3456'), false, 'underscore is not a grouping separator');
  const t = Date.now();
  ok('aaaaaaaaaaaaaaaaaaab', 's', ('a' + ' '.repeat(50)).repeat(20000));
  assert.ok(Date.now() - t < 1000, 'no catastrophic backtracking');
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
  lm.create = async () => ({ clone: async () => ({ contextWindow: 9216, measureContextUsage: async () => 1, prompt: async () => 'not json', destroy() {} }) });
  // Base is cached: force a fresh one through the failure path first.
  lm.failPrompts = 1;
  await assert.rejects(env.sandbox.nanoExtract({ body: 'b' }), /generic/);
  const r2 = await env.sandbox.nanoExtract({ body: 'b' });
  assert.strictEqual(r2.code, '');
});

test('nanoAvailability reports unsupported without the Prompt API', async () => {
  const env = makeEnv();
  assert.strictEqual(await env.sandbox.nanoAvailability(), 'unsupported');
  const env2 = makeEnv({}, { LanguageModel: mockLanguageModel({ availability: 'downloading' }) });
  assert.strictEqual(await env2.sandbox.nanoAvailability(), 'downloading');
});

test('getStatus reports the active engine', async () => {
  let st = await ask(makeEnv({}, { LanguageModel: mockLanguageModel() }), { action: 'getStatus' });
  assert.deepStrictEqual([st.engine, st.nanoAvailability], ['nano', 'available']);
  st = await ask(makeEnv({ geminiApiKey: 'old' }), { action: 'getStatus' });
  assert.deepStrictEqual([st.engine, st.nanoAvailability], ['none', 'unsupported'], 'a legacy key is not an engine');
  assert.ok(!('hasApiKey' in st) && !('geminiError' in st), 'no cloud fields');
  st = await ask(makeEnv({}, { LanguageModel: mockLanguageModel({ availability: 'downloading' }) }), { action: 'getStatus' });
  assert.deepStrictEqual([st.engine, st.nanoAvailability], ['none', 'downloading']);
});

test('startMonitoring is allowed while the model is downloadable or its host is unreachable; refused when unavailable', async () => {
  const okFetch = async (url) => {
    url = String(url);
    if (url.includes('/profile')) return jsonResponse({ historyId: '77' });
    if (url.startsWith('https://register.example/')) return jsonResponse({ success: true });
    if (url.includes('/watch')) return jsonResponse({ historyId: '77', expiration: String(Date.now() + 7 * 86400000) });
    throw new Error('unexpected fetch: ' + url);
  };
  const env = makeEnv({ subVersion: 2 }, { LanguageModel: mockLanguageModel({ availability: 'downloadable' }) });
  env.setFetch(okFetch);
  await env.sandbox.startMonitoring();
  assert.strictEqual(env.storage.setupDone, true);
  // Unreachable host: unknown, not "no model".
  const envU = makeEnv({ subVersion: 2 }, { offscreenLanguageModel: mockLanguageModel() });
  envU.offscreenDown = true;
  envU.setFetch(okFetch);
  await envU.sandbox.startMonitoring();
  assert.strictEqual(envU.storage.setupDone, true);
  const env2 = makeEnv({}, { LanguageModel: mockLanguageModel({ availability: 'unavailable' }) });
  await assert.rejects(env2.sandbox.startMonitoring(), /on-device model/);
  assert.ok(!env2.storage.setupDone);
});

test('grounding refuses a capped prefix that continues with "_", "-" or "." + alphanumerics (incl. a 20-char JWT header)', async () => {
  const env = makeEnv();
  const ok = env.sandbox.isPlausibleCode;
  const p = 'abcdefghijklmnopqrst';
  assert.strictEqual(ok(p, '', `token=${p}_uvwxyz123`), false, 'underscore continuation');
  assert.strictEqual(ok(p, '', `token=${p}-uvwxyz123`), false, 'dash continuation');
  // {"alg":"HS256"} encodes to exactly 20 chars, so the cap lands on the '.'.
  const hs = 'eyJhbGciOiJIUzI1NiJ9';
  assert.strictEqual(ok(hs, 'Sign in to Acme', `https://acme.com/magic?token=${hs}.eyJzdWIiOiIxIn0.c2ln`), false, 'JWT segment');
  assert.strictEqual(ok('123456', 's', 'x_123456'), false, 'underscore before');
  // Ordinary punctuation around a real code still grounds.
  assert.strictEqual(ok('123456', 's', 'Your code is 123456.'), true);
  assert.strictEqual(ok('123456', 's', 'Your code is 123456. It expires soon'), true);
  assert.strictEqual(ok('123456', 's', '123456 - expires in 10 min'), true);
  assert.strictEqual(ok('123456', 's', 'G-123456 is your Google verification code'), true, 'prefix label');
  assert.strictEqual(ok('G-123456', 's', 'G-123456 is your Google verification code'), true);
});

test('detectorError clears once an engine is usable, even if the backlog never reaches a model', async () => {
  const lm = mockLanguageModel({ availability: 'downloadable' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  singleMessageFetch(env, 'd1', 'Your login code is 111111', 'Sign in to Acme');
  await firePush(env);
  assert.ok(env.storage.detectorError);
  lm.availabilityValue = 'available';
  // The queued mail is now too old: consumed by the age gate, no model call.
  env.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '300', history: [] });
    if (url.includes('/messages/d1')) return jsonResponse({ ...gmailMessage('d1', 'Your login code is 111111'), internalDate: String(Date.now() - 3600000) });
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env);
  assert.strictEqual(lm.prompts.length, 0);
  assert.strictEqual(env.storage.detectorError, null);
  // getStatus clears it too.
  const env2 = makeEnv({ detectorError: { message: 'x', at: 1, nano: 'downloadable' } }, { LanguageModel: mockLanguageModel() });
  const st = await new Promise((resolve) => { for (const fn of env2.listeners.message) fn({ action: 'getStatus' }, {}, resolve); });
  assert.strictEqual(st.detectorError, null);
});

test('the download poll alarm notices the model is ready, clears detectorError and drains the queue', async () => {
  const lm = mockLanguageModel({ availability: 'downloading', respond: () => '424242' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  singleMessageFetch(env, 'p1', 'Your login code is 424242', 'Sign in to Acme');
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
  await new Promise((resolve) => { for (const fn of env2.listeners.message) fn({ action: 'watchNanoDownload' }, {}, resolve); });
  assert.ok(env2.alarms['nano-ready-poll']);
});

test('a failing in-worker Prompt API moves Nano to the offscreen document; repeated double failures raise one alert', async () => {
  const workerLM = mockLanguageModel({ failPrompts: 99 });
  const pageLM = mockLanguageModel({ respond: () => '515151' });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: workerLM, offscreenLanguageModel: pageLM });
  singleMessageFetch(env, 'w1', 'Your code is 515151', 'Your code');
  await firePush(env);
  assert.strictEqual(env.clipboard, '515151', 'retry ran in the offscreen document');
  assert.strictEqual(workerLM.prompts.length, 1);
  assert.strictEqual(pageLM.prompts.length, 1);

  // A model that fails everywhere: each code email is consumed, and after
  // NANO_FAIL_ALERT_STREAK in a row the user is told (once).
  const lm = mockLanguageModel({ failPrompts: 99 });
  const env2 = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { LanguageModel: lm });
  for (let i = 0; i < 4; i++) {
    singleMessageFetch(env2, `z${i}`, 'Your code is 777777', 'Your code');
    await firePush(env2);
  }
  assert.deepStrictEqual(env2.storage.pendingMessageIds, [], 'never blocks');
  assert.strictEqual(env2.notifications.filter((n) => n.id === 'nano-failing').length, 1);
  let st = await new Promise((resolve) => { for (const fn of env2.listeners.message) fn({ action: 'getStatus' }, {}, resolve); });
  assert.strictEqual(st.nanoFailing, true);
  lm.failPrompts = 0;
  lm.availabilityValue = 'available';
  singleMessageFetch(env2, 'z9', 'Your code is 777777', 'Your code');
  await firePush(env2);
  st = await new Promise((resolve) => { for (const fn of env2.listeners.message) fn({ action: 'getStatus' }, {}, resolve); });
  assert.strictEqual(st.nanoFailing, false, 'a success resets the streak');
});

test('offscreen host: a {error} reply makes the worker retry once, then consume', async () => {
  const lm = mockLanguageModel({ respond: () => '606060', failPrompts: 1 });
  const env = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { offscreenLanguageModel: lm });
  singleMessageFetch(env, 'e1', 'Your code is 606060', 'Your code');
  await firePush(env);
  assert.strictEqual(env.clipboard, '606060', 'retried and copied');
  assert.strictEqual(env.offscreen.received.filter((a) => a === 'nano-detect').length, 2);

  const lm2 = mockLanguageModel({ respond: (t) => (t.includes('717171') ? '717171' : '606060'), failPrompts: 2 });
  const env2 = makeEnv({ lastHistoryId: '100', pushActive: true, setupDone: true }, { offscreenLanguageModel: lm2 });
  env2.setFetch(async (url) => {
    url = String(url);
    if (url.includes('/history?')) return jsonResponse({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'e1' } }, { message: { id: 'e2' } }] }] });
    if (url.includes('/messages/e1')) return jsonResponse(gmailMessage('e1', 'Your code is 606060'));
    if (url.includes('/messages/e2')) return jsonResponse(gmailMessage('e2', 'Your code is 717171'));
    throw new Error('unexpected fetch: ' + url);
  });
  await firePush(env2);
  assert.strictEqual(env2.offscreen.received.filter((a) => a === 'nano-detect').length, 3, 'e1 twice, e2 once');
  assert.strictEqual(env2.clipboard, '717171', 'e1 consumed, e2 copied');
  assert.deepStrictEqual(env2.storage.pendingMessageIds, []);
});

test('nanoBase: a late create() rejection does not evict a newer cached base session', async () => {
  let rejectFirst;
  let calls = 0;
  const lm = mockLanguageModel();
  const realCreate = lm.create;
  lm.create = (opts) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => { rejectFirst = reject; });
    return realCreate(opts);
  };
  const env = makeEnv({}, { LanguageModel: lm });
  const first = env.sandbox.nanoBase();
  env.sandbox.nanoDropBase(); // e.g. the call timed out
  const second = env.sandbox.nanoBase();
  await second;
  rejectFirst(new Error('late'));
  await assert.rejects(first, /late/);
  assert.strictEqual(env.sandbox.nanoBase(), second, 'newer base still cached');
});

test('nanoExtract releases the base session after an idle period', async () => {
  const lm = mockLanguageModel({ respond: () => '' });
  const env = makeEnv({}, { LanguageModel: lm, fireLongTimers: true });
  await env.sandbox.nanoExtract({ body: 'b' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(lm.destroyed, 2, 'clone and (after idle) base destroyed');
});

test('ensureOffscreenDocument tolerates losing the creation race', async () => {
  const env = makeEnv();
  env.sandbox.chrome.runtime.getContexts = async () => [];
  env.sandbox.chrome.offscreen.createDocument = async () => { throw new Error('Only a single offscreen document may be created.'); };
  await env.sandbox.ensureOffscreenDocument();
  env.sandbox.chrome.offscreen.createDocument = async () => { throw new Error('boom'); };
  await assert.rejects(env.sandbox.ensureOffscreenDocument(), /boom/);
});

test('install, update and startup delete the legacy cloud API key and its error, and nothing else', async () => {
  const env = makeEnv({ geminiApiKey: 'AIza-old', geminiError: { message: 'Gemini 402', at: 1 }, lastHistoryId: '5', codeHistory: [] });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  assert.strictEqual(env.listeners.installed.length, 1);
  assert.strictEqual(env.listeners.startup.length, 1);
  env.listeners.installed[0]({ reason: 'update' });
  await flush();
  assert.ok(!('geminiApiKey' in env.storage) && !('geminiError' in env.storage), 'legacy keys removed');
  assert.strictEqual(env.storage.lastHistoryId, '5', 'other state kept');
  assert.ok('codeHistory' in env.storage);
  assert.strictEqual(env.storageRemoves, 1, 'one storage call');
  // Idempotent: running again (next Chrome start) is a harmless no-op.
  env.listeners.startup[0]();
  await flush();
  assert.strictEqual(env.storageRemoves, 2);
  assert.strictEqual(env.storage.lastHistoryId, '5');
  // A storage failure here must not break startup.
  env.sandbox.chrome.storage.local.remove = async () => { throw new Error('quota'); };
  env.listeners.startup[0]();
  await flush();
});

test('popup and manifests have no API key field or cloud model host', async () => {
  const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
  assert.ok(!/api-key|save-key|type="password"/i.test(html), 'no key input');
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

// Must stay the last test: it checks what every environment above fetched.
test('no code path in this suite ever fetched generativelanguage.googleapis.com', async () => {
  assert.ok(ALL_FETCHES.length > 50, 'the suite exercised real fetch paths');
  assert.deepStrictEqual(ALL_FETCHES.filter(isCloudModelUrl), []);
});

// --- Runner ---

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
