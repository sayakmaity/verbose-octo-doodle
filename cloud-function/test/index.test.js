// Behavior tests for the cloud function, with mocked Firestore, web-push and fetch.
// Run: node cloud-function/test/index.test.js
'use strict';
const assert = require('assert');
const { test, beforeEach } = require('node:test');
const path = require('path');
const Module = require('module');

// --- Mock @google-cloud/firestore and web-push before requiring index.js ---

const state = {
  docs: {}, // "collection/id" -> data
  sent: [],
  sendError: null, // Error, or (sub) => Error|null
  tokens: { 'good-token': 'Owner@Example.com', 'other-token': 'stranger@example.com' },
};

function docRef(name, id) {
  const key = `${name}/${id}`;
  return {
    id,
    get: async () => {
      const data = state.docs[key];
      return { exists: data !== undefined, data: () => data, ref: docRef(name, id) };
    },
    set: async (data, opts) => {
      state.docs[key] = opts?.merge ? { ...(state.docs[key] || {}), ...data } : { ...data };
    },
    delete: async () => { delete state.docs[key]; },
  };
}

const firestoreMock = {
  Firestore: class {
    collection(name) {
      return {
        doc: (id) => docRef(name, id),
        where: (field, op, value) => ({
          get: async () => ({
            docs: Object.entries(state.docs)
              .filter(([k, d]) => k.startsWith(`${name}/`) && d[field] === value)
              .map(([k, d]) => ({ id: k.split('/')[1], data: () => d, ref: docRef(name, k.split('/')[1]) })),
          }),
        }),
      };
    }
  },
};

const webpushMock = {
  setVapidDetails: () => { throw new Error('must not be called at module load'); },
  sendNotification: async (sub, payload, opts) => {
    const err = typeof state.sendError === 'function' ? state.sendError(sub) : state.sendError;
    if (err) throw err;
    state.sent.push({ sub, payload, opts });
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@google-cloud/firestore') return 'mock-firestore';
  if (request === 'web-push') return 'mock-webpush';
  return origResolve.call(this, request, ...args);
};
require.cache['mock-firestore'] = { exports: firestoreMock };
require.cache['mock-webpush'] = { exports: webpushMock };

// Gmail profile lookup used for token verification.
global.fetch = async (url, opts) => {
  const token = /^Bearer (\S+)$/.exec(opts?.headers?.Authorization || '')?.[1];
  if (token === 'google-down') return { ok: false, status: 503, json: async () => ({}) };
  if (String(url).endsWith('/users/me/profile') && state.tokens[token]) {
    return { ok: true, status: 200, json: async () => ({ emailAddress: state.tokens[token] }) };
  }
  return { ok: false, status: 401, json: async () => ({}) };
};

// No VAPID env at load: register-push must still work without the private key.
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
process.env.ALLOWED_EMAILS = 'owner@example.com';
const fns = require(path.join(__dirname, '..', 'index.js'));
process.env.VAPID_PUBLIC_KEY = 'pub';
process.env.VAPID_PRIVATE_KEY = 'priv';

function mockRes() {
  const res = { headers: {}, statusCode: 200, body: undefined };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function sub(endpoint) {
  return { endpoint, keys: { p256dh: 'p', auth: 'a' } };
}

function registerReq(subscription, token = 'good-token') {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return { method: 'POST', headers, get: (h) => headers[h.toLowerCase()], body: { subscription } };
}

async function register(subscription, token) {
  const res = mockRes();
  await fns.registerPush(registerReq(subscription, token), res);
  return res;
}

// A Gmail Pub/Sub notification for that account through the handler.
function notify(historyId, emailAddress = 'owner@example.com') {
  const data = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString('base64');
  return fns.gmailPushHandler({ data });
}

const sentEndpoints = () => state.sent.map((x) => x.sub.endpoint);

function subsFor(email) {
  return Object.values(state.docs).filter((d) => d.email === email);
}

beforeEach(() => { state.docs = {}; state.sent = []; state.sendError = null; });

// --- registerPush ---

test('registerPush stores a valid subscription keyed by the verified email, with no permissive CORS', async () => {
  const res = await register(sub('https://push.example/ep'));
  assert.deepStrictEqual(res.body, { success: true });
  assert.strictEqual(res.headers['Access-Control-Allow-Origin'], undefined);
  const stored = subsFor('owner@example.com');
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].subscription.endpoint, 'https://push.example/ep');
});

// 401 for a missing/invalid token, 502 (not 401) when Google itself fails the
// lookup, 403 for an account not on the allow-list. Nothing is stored.
for (const [token, status] of [[null, 401], ['forged', 401], ['google-down', 502], ['other-token', 403]]) {
  test(`registerPush with token ${token} -> ${status}`, async () => {
    assert.strictEqual((await register(sub('https://push.example/ep'), token)).statusCode, status);
    assert.strictEqual(Object.keys(state.docs).length, 0);
  });
}

test('legacy config/push subscription still gets pushes until the extension re-registers', async () => {
  state.docs['config/push'] = { subscription: sub('https://push.example/legacy') };
  await notify(7);
  assert.deepStrictEqual(sentEndpoints(), ['https://push.example/legacy']);
  // Once a new-style registration exists, the legacy doc is no longer used.
  state.sent = [];
  await register(sub('https://push.example/new'));
  await notify(8);
  assert.deepStrictEqual(sentEndpoints(), ['https://push.example/new']);
});

test('registerPush fails closed when ALLOWED_EMAILS is unset', async () => {
  const saved = process.env.ALLOWED_EMAILS;
  delete process.env.ALLOWED_EMAILS;
  try {
    assert.strictEqual((await register(sub('https://push.example/ep'))).statusCode, 500);
  } finally {
    process.env.ALLOWED_EMAILS = saved;
  }
});

test('registerPush rejects malformed subscriptions', async () => {
  for (const bad of [undefined, {}, { endpoint: 'https://p/x' }, sub('http://insecure/x'), sub('not a url')]) {
    assert.strictEqual((await register(bad)).statusCode, 400, JSON.stringify(bad));
  }
});

test('registrations beyond the per-account cap prune the oldest', async () => {
  for (let i = 0; i < 7; i++) {
    state.docs[`pushSubscriptions/old${i}`] = { email: 'owner@example.com', subscription: sub(`https://p/${i}`), updatedAt: i };
  }
  await register(sub('https://push.example/newest'));
  const left = subsFor('owner@example.com');
  assert.strictEqual(left.length, 5);
  assert.ok(left.some((d) => d.subscription.endpoint === 'https://push.example/newest'));
  assert.ok(!left.some((d) => d.updatedAt === 0), 'oldest pruned');
});

test('registerPush answers staleEndpoint for a dead endpoint; a fresh one registers', async () => {
  await register(sub('https://push.example/dead'));
  state.sendError = Object.assign(new Error('gone'), { statusCode: 410 });
  await notify(1);
  assert.deepStrictEqual((await register(sub('https://push.example/dead'))).body, { success: false, staleEndpoint: true });
  assert.deepStrictEqual((await register(sub('https://push.example/fresh'))).body, { success: true });
});

// --- gmailPushHandler ---

test('gmailPushHandler sends push with TTL, urgency, topic and VAPID details', async () => {
  await register(sub('https://push.example/ep'));
  await notify(12345);
  assert.strictEqual(state.sent.length, 1);
  const { payload, opts } = state.sent[0];
  assert.deepStrictEqual(JSON.parse(payload), { type: 'gmail_update', historyId: '12345' });
  assert.strictEqual(opts.TTL, 86400);
  assert.strictEqual(opts.urgency, 'high');
  assert.strictEqual(opts.topic, 'gmail-update');
  assert.strictEqual(opts.vapidDetails.privateKey, 'priv');
});

test('gmailPushHandler fans out to every device of that account only', async () => {
  await register(sub('https://push.example/laptop'));
  await register(sub('https://push.example/desktop'));
  state.docs['pushSubscriptions/x'] = { email: 'someone@else.com', subscription: sub('https://push.example/other') };
  await notify(1, 'Owner@Example.com');
  assert.deepStrictEqual(sentEndpoints().sort(), ['https://push.example/desktop', 'https://push.example/laptop']);
});

test('a 410 only marks that endpoint dead and never clobbers a fresh registration', async () => {
  await register(sub('https://push.example/dead'));
  await register(sub('https://push.example/fresh'));
  state.sendError = (s) => (s.endpoint.endsWith('/dead') ? Object.assign(new Error('gone'), { statusCode: 410 }) : null);
  await notify(1);
  state.sendError = null;
  const docs = subsFor('owner@example.com');
  assert.strictEqual(docs.find((d) => d.subscription.endpoint.endsWith('/dead')).dead, true);
  assert.strictEqual(docs.find((d) => d.subscription.endpoint.endsWith('/fresh')).dead, false);
  state.sent = [];
  await notify(2);
  assert.deepStrictEqual(sentEndpoints(), ['https://push.example/fresh']);
});

test('gmailPushHandler survives malformed pubsub data', async () => {
  await fns.gmailPushHandler({ data: Buffer.from('not json').toString('base64') });
  // no throw = pass (message ACKed rather than infinite redelivery)
});

test('gmailPushHandler no-ops when no subscription registered', async () => {
  await notify(2);
  assert.strictEqual(state.sent.length, 0);
});
