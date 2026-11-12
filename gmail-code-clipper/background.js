importScripts('config.js');
// Gemini Nano helpers (nano.js). Only ever used inside functions, so this file
// still loads where nano.js is absent (e.g. the eval scorer's vm sandbox).
importScripts('nano.js');
const GCP_TOPIC_NAME = CONFIG.GCP_TOPIC_NAME;
const VAPID_PUBLIC_KEY = CONFIG.VAPID_PUBLIC_KEY;
const REGISTER_PUSH_URL = CONFIG.REGISTER_PUSH_URL;

const MAX_PROCESSED_CACHE = 200;
const HEALTH_CHECK_MINUTES = 30;
const WATCH_RENEW_MARGIN_MS = 2 * 3600000;
// Per-email budget for one on-device run (create + fit + prompt).
const NANO_TIMEOUT_MS = 60000;
// Login codes expire in minutes. Anything older is never copied: this keeps a
// backlog drain (Chrome was closed, model still downloading) from putting a
// dead code on the clipboard, and bounds how long one failing message can
// block the queue.
const MAX_CODE_AGE_MS = 15 * 60000;
// Bounds the text handed to the model host; nano.js then cuts it further to
// fit the on-device context window. Real emails are far below it (largest
// seen after cleanup: ~20K chars). MAX_RAW_PART_CHARS just bounds work on
// pathological multi-MB parts; stripping is linear.
const MAX_RAW_PART_CHARS = 5000000;
const MAX_BODY_CHARS = 200000;
// Bump to force an unsubscribe/resubscribe cycle (e.g. after changing
// subscribe options).
const SUBSCRIPTION_VERSION = 2;

// --- State ---
// All mutable state lives in chrome.storage.local; these are the in-memory
// mirrors, valid only after restoreState() resolves.
let lastHistoryId = null;
let setupDone = false;
let pushActive = false;
let needsAuth = false;
let watchExpiration = 0;
let pendingMessageIds = [];
let processedMessageIds = new Set();
let detectorError = null; // { message, at, nano } while the on-device model can't run (not downloaded, unsupported)
let pushError = null; // last push setup/repair failure, for the popup

// Single promise so every entry point (push, alarm, message) awaits the SAME
// restore. Reset on rejection so one transient storage error doesn't poison
// every future event in this worker instance.
let statePromise = null;
function restoreState() {
  statePromise ??= (async () => {
    const s = await chrome.storage.local.get([
      'lastHistoryId', 'setupDone', 'pushActive', 'needsAuth', 'watchExpiration',
      'pendingMessageIds', 'processedMessageIds', 'pushError', 'detectorError',
    ]);
    detectorError = s.detectorError || null;
    pushError = s.pushError || null;
    lastHistoryId = s.lastHistoryId || null;
    // Installs from before setupDone existed: derive it from pushActive and
    // persist it, or the first failed repairPush (which writes
    // pushActive=false) would make a working install look "Not set up".
    setupDone = !!(s.setupDone || s.pushActive);
    if (setupDone && !s.setupDone) await chrome.storage.local.set({ setupDone: true });
    pushActive = !!s.pushActive;
    needsAuth = !!s.needsAuth;
    watchExpiration = s.watchExpiration || 0;
    pendingMessageIds = s.pendingMessageIds || [];
    processedMessageIds = new Set(s.processedMessageIds || []);
  })().catch((err) => {
    statePromise = null;
    throw err;
  });
  return statePromise;
}
restoreState().catch(() => {});

async function persistQueues() {
  await chrome.storage.local.set({
    pendingMessageIds,
    processedMessageIds: [...processedMessageIds].slice(-MAX_PROCESSED_CACHE),
  });
}

// historyIds are uint64 decimal strings — compare numerically, and never
// let the cursor move backwards (concurrent runs, out-of-order responses).
async function advanceCursor(newId) {
  if (!newId) return;
  if (lastHistoryId && BigInt(newId) <= BigInt(lastHistoryId)) return;
  lastHistoryId = String(newId);
  await chrome.storage.local.set({ lastHistoryId });
}

// --- Lifecycle ---

chrome.runtime.onInstalled.addListener(() => fullRestore());
chrome.runtime.onStartup.addListener(() => fullRestore());

async function fullRestore() {
  await restoreState();
  if (!setupDone) return;
  // Alarm first: if the drain below hangs or the worker is killed, the safety
  // net must already exist.
  await ensureHealthCheckAlarm();
  // Notifications don't survive a Chrome restart; re-raise the only recovery
  // signal the user has.
  if (needsAuth) await flagNeedsAuth(true);
  // Emails that arrived while Chrome was closed drain from the old cursor
  // (never reset it here); push is repaired alongside.
  await healthCheck();
}

// Null prototype: an alarm named e.g. 'toString' must not match.
const ALARM_HANDLERS = { __proto__: null, 'health-check': healthCheck, 'nano-ready-poll': pollNanoReady };

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badge-clear') {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const run = ALARM_HANDLERS[alarm.name];
  if (run) restoreState().then(() => run()).catch(console.error);
});

async function ensureHealthCheckAlarm() {
  const existing = await chrome.alarms.get('health-check');
  if (!existing) {
    chrome.alarms.create('health-check', { periodInMinutes: HEALTH_CHECK_MINUTES });
  }
}

// Safety net: even if a push is lost, the watch died, or the subscription was
// clobbered server-side, this heals everything within HEALTH_CHECK_MINUTES.
// Gated on setupDone (not pushActive) so a transient failure during setup
// can't permanently disable the net — the next cycle repairs push too.
async function healthCheck() {
  if (!setupDone) return;
  const results = await Promise.allSettled([
    checkForNewEmails(),
    repairPush(),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.warn('Health check step failed:', r.reason?.message);
  }
}

// Re-registers the push subscription and renews the watch if needed (always,
// with forceWatch), and records the real outcome in pushActive for the popup.
// The watch is renewed only here: the health check runs well before expiry.
async function repairPush(forceWatch = false) {
  const results = await Promise.allSettled([
    registerPushSubscription(),
    forceWatch ? setupGmailWatch() : ensureWatch(),
  ]);
  const failure = results.find((r) => r.status === 'rejected');
  for (const r of results) {
    if (r.status === 'rejected') console.warn('Push repair step failed:', r.reason?.message);
  }
  await setPushState(!failure, failure?.reason?.message);
  return !failure;
}

// pushError is shown in the popup so config problems (e.g. account not on the
// server allow-list) aren't mislabeled "self-healing".
async function setPushState(ok, errorMessage) {
  pushActive = ok;
  pushError = ok ? null : (errorMessage || 'Push setup failed');
  await chrome.storage.local.set({ pushActive, pushError });
}

// --- Web Push ---

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    await restoreState();
    const data = event.data?.json();
    console.log('Push received:', data);
    if (data?.type === 'gmail_update') {
      await checkForNewEmails().catch((err) => console.error('Push drain failed:', err.message));
    }
  })());
});

// FCM can rotate or expire the subscription; without this the pipeline dies
// silently until the next health check.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(restoreState().then(() => repairPush()).catch(console.error));
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function uint8ArrayToUrlBase64(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function registerPushSubscription() {
  if (!self.registration?.pushManager) {
    throw new Error('Push API not available');
  }

  // The server may report our endpoint as dead (push service returned 410);
  // in that case we must mint a fresh subscription, so allow one extra lap.
  for (let lap = 0; lap < 2; lap++) {
    let subscription = await self.registration.pushManager.getSubscription();

    // Resubscribe if the existing subscription was made with a different VAPID
    // key (server redeployed with new keys) or older subscribe options.
    const { subVersion } = await chrome.storage.local.get('subVersion');
    if (subscription) {
      const existingKey = subscription.options?.applicationServerKey
        ? uint8ArrayToUrlBase64(subscription.options.applicationServerKey)
        : null;
      if (existingKey !== VAPID_PUBLIC_KEY.replace(/=+$/, '') || subVersion !== SUBSCRIPTION_VERSION) {
        console.log('Push subscription stale (key or options changed) — resubscribing');
        await subscription.unsubscribe();
        subscription = null;
      }
    }

    if (!subscription) {
      subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: false, // extensions may send silent pushes since Chrome 121
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await chrome.storage.local.set({ subVersion: SUBSCRIPTION_VERSION });
    }

    // The server authenticates registrations with this token (it resolves the
    // Gmail address and checks an allow-list), so nobody else can hijack the
    // push channel by POSTing their own subscription.
    const resp = await authedFetch(REGISTER_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    if (resp.status === 403) {
      throw new Error('Push server rejected this Google account — add it to ALLOWED_EMAILS and redeploy');
    }
    if (!resp.ok) throw new Error(`Register push failed: ${resp.status}`);

    const result = await resp.json().catch(() => ({}));
    if (result.staleEndpoint && lap === 0) {
      // Server saw this exact endpoint fail with 410 — it's dead even though
      // it still exists locally. Drop it and subscribe fresh.
      console.warn('Server reports endpoint dead — minting a fresh subscription');
      await subscription.unsubscribe();
      continue;
    }

    console.log('Push subscription registered');
    return subscription;
  }
}

// --- Gmail watch ---

async function ensureWatch() {
  if (watchExpiration - Date.now() < WATCH_RENEW_MARGIN_MS) {
    await setupGmailWatch();
  }
}

// Never touches the cursor: only a drain or startMonitoring moves it.
async function setupGmailWatch() {
  const result = await fetchGmailApi('users/me/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topicName: GCP_TOPIC_NAME, labelIds: ['INBOX'] }),
  }).catch((err) => {
    // Say which step failed: this text is shown in the popup as pushError.
    throw new Error(`Gmail watch failed: ${err.message}`);
  });
  watchExpiration = Number(result.expiration);
  await chrome.storage.local.set({ watchExpiration });
  console.log('Gmail watch active, expires:', new Date(watchExpiration).toISOString());
  return result;
}

// --- Message handling from popup / notification ---

// Popup commands answered with { success, error? }. Null prototype: an
// action like 'toString' is not a command.
const COMMANDS = {
  __proto__: null,
  startMonitoring,
  // Before setup there's no grant yet: draining would raise a bogus
  // "needs re-authorization" alert for a brand-new user.
  checkNow: () => restoreState().then(() => (setupDone ? checkForNewEmails() : undefined)),
  watchNanoDownload,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const command = COMMANDS[message.action];
  if (command) {
    command()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === 'getStatus') {
    restoreState()
      .then(async () => {
        // 'unknown' when the model host didn't answer: not evidence of no model.
        const nanoAvailability = await getNanoAvailability().catch(() => 'unknown');
        if (nanoAvailability === 'available') await clearDetectorError();
        const { nanoFailStreak = 0 } = await chrome.storage.local.get('nanoFailStreak');
        sendResponse({
          setupDone, pushActive, needsAuth, pushError,
          nanoAvailability, detectorError,
          nanoFailing: nanoFailStreak >= NANO_FAIL_ALERT_STREAK,
        });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  // Every other action (clipboard-write, nano-*, codeDetected) is for other
  // listeners: don't pre-empt their sendResponse.
  return false;
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'needs-auth') {
    chrome.notifications.clear('needs-auth');
    // The click makes the user "active", so an interactive auth prompt is
    // allowed here even from the service worker.
    restoreState().then(() => interactiveRecover()).catch(console.error);
  }
});

// --- Start / Stop ---

async function startMonitoring() {
  await restoreState();

  // Refuse only when the on-device model can NEVER run here. 'downloadable' is
  // fine: the popup offers the download, and until it finishes mail stays
  // queued (detectorError) instead of being consumed as "no code". An
  // unreachable host is unknown, not "no model": don't refuse on it.
  const nano = await getNanoAvailability().catch(() => null);
  if (nano === 'unavailable' || nano === 'unsupported') {
    throw new Error(NANO_UNAVAILABLE_MESSAGE);
  }

  // Interactive is fine here: this runs from a popup click (user gesture).
  await getAuthToken(true);
  await clearNeedsAuth();

  // Initialize the cursor only if we don't have one; if we do, drain the
  // backlog instead of discarding it. interactive=true lets the 401-retry
  // prompt when the grant expired but a stale access token was cached.
  if (!lastHistoryId) {
    const profile = await fetchGmailApi('users/me/profile', undefined, true);
    await advanceCursor(profile.historyId);
    console.log('Monitoring started, historyId:', lastHistoryId);
  } else {
    await checkForNewEmails().catch((err) => console.warn('Backlog drain failed:', err.message));
  }

  // Auth + cursor are good — from here on the health check can repair
  // anything below, so record setup as done even if push setup fails.
  setupDone = true;
  await chrome.storage.local.set({ setupDone: true });
  await ensureHealthCheckAlarm();

  // A click on Start always re-creates the watch. On failure the health
  // check keeps retrying; the popup shows the first failing step.
  if (!(await repairPush(true))) throw new Error(pushError);
}

async function interactiveRecover() {
  try {
    await getAuthToken(true);
    await clearNeedsAuth();
  } catch (err) {
    console.error('Re-authorization failed:', err.message);
    // Re-raise the notification: the click cleared it, and without this a
    // dismissed consent window would leave no path back.
    await flagNeedsAuth(true);
    return;
  }
  console.log('Re-authorization successful');
  // Auth is fixed. Failures past this point are push/network problems, not
  // auth problems — don't misreport them as "needs re-authorization"; the
  // health check keeps repairing them. Mail that arrived meanwhile drains from
  // the old cursor.
  await healthCheck();
}

// --- Gmail Auth ---

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

// Background contexts (push, alarms) must never pop auth UI: Chrome rejects
// interactive requests when the user is idle, and a surprise consent window
// is wrong anyway. Fail silently here and surface a notification instead.
async function getTokenSilent() {
  try {
    const token = await getAuthToken(false);
    if (needsAuth) await clearNeedsAuth();
    return token;
  } catch (err) {
    // Offline on wake / flaky network is not a revoked grant: don't raise a
    // sticky "re-authorize" alert for it. The next push or health check retries.
    if (!isTransientAuthError(err)) await flagNeedsAuth();
    throw err;
  }
}

function isTransientAuthError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return /connection|network|timed? ?out|offline|-1\d\d\b/i.test(err?.message || '');
}

async function flagNeedsAuth(force = false) {
  // Only on the transition into needsAuth, or when forced (startup, click-then-
  // fail). Re-creating it on every failed background call made it pop up again
  // on every inbox change.
  if (needsAuth && !force) return;
  if (!needsAuth) {
    needsAuth = true;
    await chrome.storage.local.set({ needsAuth: true });
  }
  chrome.notifications.create('needs-auth', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title: 'Gmail Code Clipper needs re-authorization',
    message: 'Click here to sign in again — code monitoring is paused until you do.',
    priority: 2,
    requireInteraction: true,
  });
}

async function clearNeedsAuth() {
  if (!needsAuth) return;
  needsAuth = false;
  await chrome.storage.local.set({ needsAuth: false });
  chrome.notifications.clear('needs-auth');
}

class GmailApiError extends Error {
  constructor(status, body) {
    super(`Gmail API ${status}: ${body}`);
    this.status = status;
  }
}

// fetch with the user's Google token. Chrome may hand back a cached token
// Google no longer accepts: on 401, evict it and retry once with a fresh one.
async function authedFetch(url, init = {}, interactive = false) {
  const getToken = () => (interactive ? getAuthToken(true) : getTokenSilent());
  const send = (token) => fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  const token = await getToken();
  let response = await send(token);
  if (response.status === 401) {
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    response = await send(await getToken());
  }
  return response;
}

async function fetchGmailApi(endpoint, init, interactive = false) {
  const response = await authedFetch(`https://gmail.googleapis.com/gmail/v1/${endpoint}`, init, interactive);
  noteServerTime(response);
  if (!response.ok) {
    throw new GmailApiError(response.status, await response.text());
  }
  return response.json();
}

// Offset between Google's clock (HTTP Date header) and ours, so the message
// age check isn't fooled by a local clock that runs fast or slow.
let serverClockOffsetMs = 0;
function noteServerTime(response) {
  const date = Date.parse(response.headers?.get?.('date') || '');
  if (!Number.isNaN(date)) serverClockOffsetMs = date - Date.now();
}

// --- Email Checking ---

// Single-flight: concurrent pushes coalesce into one run plus at most one
// follow-up, so two runs can never interleave cursor reads/writes.
let drainPromise = null;
let drainRequested = false;

function checkForNewEmails() {
  if (drainPromise) {
    drainRequested = true;
    return drainPromise;
  }
  drainPromise = (async () => {
    try {
      do {
        drainRequested = false;
        await drainOnce();
      } while (drainRequested);
    } finally {
      drainPromise = null;
    }
  })();
  return drainPromise;
}

// Expired-or-invalid-cursor detection: 404 is the documented signal; Gmail
// can also reject a bad startHistoryId with a 400.
function isCursorError(err) {
  return err instanceof GmailApiError
    && (err.status === 404 || (err.status === 400 && /historyid/i.test(err.message)));
}

async function drainOnce() {
  if (!lastHistoryId) {
    // No cursor (fresh install, cleared storage). The push that woke us was
    // caused by a real email — grab the most recent inbox messages so it
    // isn't dropped, then start the cursor from "now".
    await recoverFromRecentMessages();
  } else {
    try {
      await listNewMessages();
    } catch (err) {
      if (isCursorError(err)) {
        // Cursor expired (Gmail keeps history ~a week, sometimes less).
        // Docs say to full-sync: fetch recent messages, then reset cursor.
        console.warn('History cursor expired — recovering via recent messages');
        await recoverFromRecentMessages();
      } else {
        throw err;
      }
    }
  }

  await processPendingQueue();
}

// Enqueue durably BEFORE the cursor advances past these ids: if we die
// mid-processing, the queue survives and the next drain picks them up.
async function enqueueMessageIds(ids) {
  // Dedupe within the batch too: one message can appear in several history
  // records (messageAdded + labelAdded, or across pages).
  const seen = new Set([...pendingMessageIds, ...processedMessageIds]);
  const fresh = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      fresh.push(id);
    }
  }
  if (fresh.length) {
    pendingMessageIds.push(...fresh);
    await persistQueues();
  }
}

async function listNewMessages() {
  let pageToken = null;
  let latestHistoryId = null;
  const newIds = [];

  // Follow the token chain to completion: partial listing + full cursor
  // advance would permanently skip the unlisted pages. History is bounded
  // by Gmail's ~1 week retention, so this terminates.
  do {
    const params = new URLSearchParams({ startHistoryId: lastHistoryId, labelId: 'INBOX' });
    // labelAdded catches mail that reaches the inbox after creation: "Not
    // spam", or un-archiving. MAX_CODE_AGE_MS keeps old restored mail out.
    params.append('historyTypes', 'messageAdded');
    params.append('historyTypes', 'labelAdded');
    if (pageToken) params.set('pageToken', pageToken);
    const history = await fetchGmailApi(`users/me/history?${params}`);

    latestHistoryId = history.historyId || latestHistoryId;
    for (const h of history.history || []) {
      for (const msg of h.messagesAdded || []) {
        newIds.push(msg.message.id);
      }
      for (const added of h.labelsAdded || []) {
        if (added.labelIds?.includes('INBOX')) newIds.push(added.message.id);
      }
    }
    pageToken = history.nextPageToken;
  } while (pageToken);

  await enqueueMessageIds(newIds);
  await advanceCursor(latestHistoryId);
}

// Full-sync recovery (no cursor, or cursor expired). Order matters:
//  1. Read the profile historyId FIRST, so mail arriving while we list is
//     replayed by the next history.list instead of falling in a gap (the
//     overlap is harmless — enqueueMessageIds dedupes).
//  2. If listing fails, throw WITHOUT touching the cursor so the next drain
//     retries recovery instead of skipping the email that woke us.
//  3. Enqueue oldest-first, so when a code was re-sent the newest one is
//     copied last and stays on the clipboard.
async function recoverFromRecentMessages() {
  const profile = await fetchGmailApi('users/me/profile');
  // Only the last hour matters — older login codes are dead (and
  // MAX_CODE_AGE_MS filters further when processing).
  const q = encodeURIComponent('in:inbox newer_than:1h');
  const list = await fetchGmailApi(`users/me/messages?q=${q}&maxResults=10`);
  await enqueueMessageIds((list.messages || []).map((m) => m.id).reverse());
  lastHistoryId = String(profile.historyId);
  await chrome.storage.local.set({ lastHistoryId });
}

async function processPendingQueue() {
  await clearDetectorErrorIfReady();
  while (pendingMessageIds.length) {
    const msgId = pendingMessageIds[0];
    try {
      await processMessage(msgId);
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) {
        // Message deleted between listing and fetch — drop it.
        console.warn('Message gone, skipping:', msgId);
      } else if (err instanceof DetectorUnavailableError) {
        // On-device model not downloaded / unsupported: every message would
        // fail the same way, so stop and surface it instead of silently
        // consuming mail as "no code". Queued messages stay; once the model
        // is ready they are retried, and MAX_CODE_AGE_MS keeps stale ones off
        // the clipboard.
        await setDetectorError(err.message, err.nano);
        break;
      } else {
        // Retryable (model host unreachable, network blip): stop here so arrival
        // order is preserved; the queue is durable and the next push or
        // health check retries from this point. A message can't block the
        // queue for long: once older than MAX_CODE_AGE_MS it's skipped.
        console.warn('Processing failed, will retry next drain:', msgId, err.message);
        break;
      }
    }
    pendingMessageIds.shift();
    processedMessageIds.add(msgId);
    await persistQueues();
  }
}

// --- Process a single message ---

async function processMessage(messageId) {
  const message = await fetchGmailApi(`users/me/messages/${messageId}?format=full`);

  const ageMs = Date.now() + serverClockOffsetMs - receivedAt(message);
  if (ageMs > MAX_CODE_AGE_MS) {
    console.log(`Skipping message ${messageId}: ${Math.round(ageMs / 60000)} min old, any code has expired`);
    return;
  }

  const subject = getHeader(message, 'Subject') || '';
  const from = getHeader(message, 'From') || '';
  const body = extractBody(message) || message.snippet || '';
  if (!body) {
    console.warn('No body or snippet for message', messageId);
    return;
  }

  // Cheap gate before any model: Nano falsely returns a code on ~9% of
  // no-code mail, and most mail isn't about codes at all. Never log the
  // subject: it's email content.
  if (!looksLikeCodeEmail(subject, body)) {
    console.log(`Skipping message ${messageId}: doesn't look like a code email`);
    return;
  }

  const code = await detectCode(subject, from, body);
  if (!code) return;

  const copied = await copyToClipboard(code);

  chrome.notifications.create(`code-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title: copied ? 'Login Code Copied!' : 'Login code detected (copy failed — click extension icon)',
    message: `"${code}" from ${from}`,
    priority: 2,
  });

  chrome.action.setBadgeText({ text: code });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  // setTimeout dies with the service worker; an alarm survives it.
  chrome.alarms.create('badge-clear', { delayInMinutes: 1 });

  const { codeHistory = [] } = await chrome.storage.local.get('codeHistory');
  codeHistory.unshift({ code, subject, from, timestamp: Date.now() });
  await chrome.storage.local.set({ codeHistory: codeHistory.slice(0, 30) });

  chrome.runtime.sendMessage({ action: 'codeDetected', code, subject, from }).catch(() => {});
}

// When Gmail actually got the message. internalDate isn't reliable for this:
// Gmail often takes it from the sender's Date header, and some senders get
// that wrong (one airline sends "8:23:59 +0530" for 20:23:59, 12h in the past).
// The topmost Received header is stamped by Gmail itself on arrival. Take the
// later of the two, so a bogus-past Date never makes a fresh code look stale.
function receivedAt(message) {
  const internal = Number(message.internalDate) || 0;
  const received = getHeader(message, 'Received') || '';
  const stamp = Date.parse(received.slice(received.lastIndexOf(';') + 1).replace(/\(.*?\)/g, '').trim());
  return Number.isNaN(stamp) ? internal : Math.max(internal, stamp);
}

function getHeader(message, name) {
  return message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value;
}

function extractBody(message) {
  const found = [];
  (function walk(payload) {
    if (!payload) return;
    if (payload.body?.data && (payload.mimeType === 'text/plain' || payload.mimeType === 'text/html')) {
      found.push({ mime: payload.mimeType, data: payload.body.data, charset: partCharset(payload) });
    }
    for (const part of payload.parts || []) walk(part);
  })(message.payload);

  const decode = (p) => base64Decode(p.data, p.charset).slice(0, MAX_RAW_PART_CHARS);
  // Plain text is used as-is: running the HTML stripper on it deleted
  // everything between a literal "<" and the next ">" (e.g. "expires in <10
  // minutes ... code ... <https://help>").
  const plains = found.filter((p) => p.mime === 'text/plain').map((p) => normalizeText(decode(p))).filter(Boolean);
  const htmls = found.filter((p) => p.mime === 'text/html').map((p) => htmlToText(decode(p))).filter(Boolean);

  // Plain text first, then the HTML rendering. Some senders' plain part is a
  // stub ("View this email in your browser", a list footer) while the code is
  // only in the HTML, and stubs carry years/ZIPs/phone numbers, so no cheap
  // test can tell a stub from a real body. MAX_BODY_CHARS bounds the total.
  return plains.concat(htmls).join('\n').substring(0, MAX_BODY_CHARS);
}

function partCharset(part) {
  const ct = part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  return /charset\s*=\s*"?([^";\s]+)/i.exec(ct)?.[1];
}

// Visible text of an HTML document. Linear-time on purpose: the previous
// regexes ([\s\S]*? / [^>]*) went quadratic on hostile input (many "<" or
// "<!--" with no terminator) and could pin the service worker for minutes.
function htmlToText(html) {
  return normalizeText(decodeEntities(
    stripHiddenBlocks(html).replace(/<[^<>]*>/g, ' ')
  ));
}

// Removes comments (which also covers Outlook's <!--[if mso]> blocks, whose
// <o:PixelsPerInch>96</o:PixelsPerInch> used to be the first "word" of every
// travel and retail email) and <head>/<style>/<script> blocks, whose contents —
// ~10K chars of CSS — survive plain tag stripping.
function stripHiddenBlocks(html) {
  // ASCII-only lowercase keeps indices aligned with `html`: String#toLowerCase
  // can change length ("İ" -> "i̇"), which shifted every later slice and
  // corrupted codes in e.g. Turkish emails.
  const lower = html.replace(/[A-Z]+/g, (c) => c.toLowerCase());
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = lower.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (lower.startsWith('<!--', lt)) {
      // Search from lt+2 so "<!-->" and "<!--->" (empty comments) end correctly.
      const end = lower.indexOf('-->', lt + 2);
      i = end === -1 ? html.length : end + 3;
      out += ' ';
      continue;
    }
    const block = /^<(head|style|script)\b/.exec(lower.slice(lt, lt + 8));
    if (block) {
      i = endOfBlock(lower, lt, block[1]);
      out += ' ';
      continue;
    }
    out += '<';
    i = lt + 1;
  }
  return out;
}

// Index just past the block opened at `lt`. The close tag must be a real tag
// boundary ("</head>" / "</head " — not "</header>"). If it's missing (</head>
// is optional in HTML), drop only the opening tag — or for <head>, everything
// up to <body> — instead of the rest of the document.
function endOfBlock(lower, lt, tag) {
  const isBoundary = (at) => /[\s>/]/.test(lower[at] || '');
  let close = lower.indexOf(`</${tag}`, lt);
  while (close !== -1 && !isBoundary(close + 2 + tag.length)) {
    close = lower.indexOf(`</${tag}`, close + 1);
  }
  if (close !== -1) {
    const gt = lower.indexOf('>', close);
    return gt === -1 ? lower.length : gt + 1;
  }
  if (tag === 'head') {
    const body = lower.indexOf('<body', lt);
    if (body !== -1) return body;
  }
  const gt = lower.indexOf('>', lt);
  return gt === -1 ? lower.length : gt + 1;
}

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·',
  ndash: '-', mdash: '-', hyphen: '-', shy: '', zwnj: '', zwj: '',
};

// Decode rather than blank entities: senders sometimes encode digits
// (&#56;&#53;...) and blanking them erased the code.
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (_m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return ' '; }
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? ' ';
  });
}

function normalizeText(s) {
  return s
    // Invisible preheader padding: combining grapheme joiner, soft hyphen,
    // zero-width chars, direction marks, word joiner, BOM.
    .replace(/[͏­​-‏⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function base64Decode(data, charset) {
  // Gmail body data is base64url of the part's raw bytes in its DECLARED
  // charset (not transcoded) — decode with that charset, falling back to UTF-8
  // for unknown labels.
  const bytes = urlBase64ToUint8Array(data);
  let decoder;
  try {
    decoder = new TextDecoder(charset || 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes);
}

// --- Pre-filter ---

// Applied before ANY model. Measured on a year of real mail: Nano alone
// falsely returned a code for ~9% of no-code emails; this gate removes almost
// all of those without dropping any real code email (blank-subject senders
// are caught by the body-start test).
const CODE_SUBJECT_RE = /\b(codes?|otp|passcodes?|passwords?|verif(y|ication|ied)|one[- ]time|2fa|mfa|two[- ]?factor|2[- ]?step|authentication|security code|sign[- ]?in|log[- ]?in|pin)\b/i;
const CODE_BODY_START_RE = /(^\W*(your )?(code|passcode|otp) is\b|\bpasscode\b|\botp\b|\b(verification|security|login|log[- ]in|sign[- ]in|access|authentication|one[- ]time) code\b|\bone[- ]time (password|pin)\b)/i;
// "Your email address was verified for Example DNS": a finished
// verification, not a code. Only skipped when the body doesn't lead with one.
const VERIFIED_DONE_RE = /\b(was|been|successfully|now) verified\b|\bverified successfully\b/i;

function looksLikeCodeEmail(subject, body) {
  subject = subject || '';
  const bodyStart = CODE_BODY_START_RE.test((body || '').slice(0, 300));
  if (bodyStart) return true;
  return CODE_SUBJECT_RE.test(subject) && !VERIFIED_DONE_RE.test(subject);
}

// --- Code detection ---

// Gemini Nano, Chrome's on-device model, is the only engine: the email text
// never leaves the machine. -> a grounded code, or null.
async function detectCode(subject, from, body) {
  const nano = await getNanoAvailability().catch((err) => {
    console.warn('On-device model host unreachable:', err.message);
    return null;
  });
  // Host unreachable (offscreen document didn't answer): transient, retry the
  // drain later rather than reporting a missing model.
  if (nano === null) throw new Error('On-device model host unreachable');
  if (nano !== 'available') throw new DetectorUnavailableError(nano);

  for (let attempt = 1; ; attempt++) {
    try {
      const { code, truncated } = await runNano({ from, subject, body }, NANO_TIMEOUT_MS);
      await noteNanoSuccess();
      if (truncated) console.log('Email body truncated to fit the on-device model context');
      if (isPlausibleCode(code, subject, body)) return code;
      if (code) console.warn(`Discarding implausible code from Gemini Nano (${code.length} chars)`);
      return null;
    } catch (err) {
      if (attempt === 2) {
        // One bad email must not block the queue: consume it.
        console.warn('Gemini Nano failed twice, skipping this message:', err.message);
        await noteNanoFailure();
        return null;
      }
      // ~3% of runs throw a generic UnknownError (none seen on code emails).
      // The retry gets a fresh session (in the offscreen document if the
      // worker's Prompt API just failed).
      console.warn('Gemini Nano failed, retrying with a fresh session:', err.message);
    }
  }
}

// Consecutive code emails Nano failed on twice (persisted: the worker rarely
// lives from one code email to the next). A model that fails every time would
// otherwise consume every code silently while the popup shows green.
const NANO_FAIL_ALERT_STREAK = 3;

async function noteNanoFailure() {
  const { nanoFailStreak = 0 } = await chrome.storage.local.get('nanoFailStreak');
  const streak = nanoFailStreak + 1;
  await chrome.storage.local.set({ nanoFailStreak: streak });
  if (streak !== NANO_FAIL_ALERT_STREAK) return;
  console.error(`Gemini Nano failed on ${streak} code emails in a row`);
  chrome.notifications.create('nano-failing', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title: 'Codes may not be copied',
    message: `Chrome's on-device model failed on the last ${streak} code emails. Check chrome://on-device-internals, or restart Chrome.`,
    priority: 2,
  });
}

async function noteNanoSuccess() {
  const { nanoFailStreak = 0 } = await chrome.storage.local.get('nanoFailStreak');
  if (!nanoFailStreak) return;
  await chrome.storage.local.set({ nanoFailStreak: 0 });
  chrome.notifications.clear('nano-failing');
}

const NANO_UNAVAILABLE_MESSAGE = "Chrome's on-device model (Gemini Nano) can't run here — it needs Chrome 138+ on a supported device";

// The on-device model isn't ready (not downloaded yet) or can't run here.
class DetectorUnavailableError extends Error {
  constructor(nano) {
    super(nano === 'downloadable' || nano === 'downloading'
      ? 'On-device model not downloaded yet'
      : `On-device model ${nano}`);
    this.nano = nano;
  }
}

async function setDetectorError(message, nano) {
  if (detectorError?.message === message && detectorError?.nano === nano) return;
  const isNew = !detectorError;
  detectorError = { message, at: isNew ? Date.now() : detectorError.at, nano };
  await chrome.storage.local.set({ detectorError });
  console.error('No code detector available:', message);
  // Chrome keeps downloading after the popup closes; notice when it's done.
  if (nano === 'downloading') await watchNanoDownload();
  if (isNew) {
    const downloadable = nano === 'downloadable' || nano === 'downloading';
    chrome.notifications.create('detector-error', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title: 'Codes aren\'t being copied',
      message: downloadable
        ? 'Chrome\'s on-device model needs downloading — open the extension and click Download. Queued emails are retried once it\'s ready.'
        : 'Chrome\'s on-device model isn\'t available on this device. It needs Chrome 138+, enough disk space, and 16 GB RAM or a GPU with more than 4 GB VRAM.',
      priority: 2,
    });
  }
}

async function clearDetectorError() {
  if (!detectorError) return;
  detectorError = null;
  await chrome.storage.local.set({ detectorError: null });
  chrome.notifications.clear('detector-error');
}

// Once the model is ready, clear the error even when nothing queued reaches
// it (aged out, filtered by the gate).
async function clearDetectorErrorIfReady() {
  if (!detectorError) return;
  if ((await getNanoAvailability().catch(() => null)) === 'available') await clearDetectorError();
}

// The popup starts the download (it needs a user click) but closes long before
// it finishes; poll until the model is ready, then retry the queue.
const NANO_POLL_MAX_MS = 2 * 3600000;

async function watchNanoDownload() {
  await chrome.storage.local.set({ nanoPollUntil: Date.now() + NANO_POLL_MAX_MS });
  chrome.alarms.create('nano-ready-poll', { periodInMinutes: 1 });
}

async function pollNanoReady() {
  const { nanoPollUntil = 0 } = await chrome.storage.local.get('nanoPollUntil');
  const nano = await getNanoAvailability().catch(() => null);
  if (nano === 'available') {
    chrome.alarms.clear('nano-ready-poll');
    await clearDetectorError();
    if (setupDone) await checkForNewEmails();
    return;
  }
  const waiting = nano === null || nano === 'downloading' || nano === 'downloadable';
  if (!waiting || Date.now() > nanoPollUntil) chrome.alarms.clear('nano-ready-poll');
}

// --- On-device model host ---
// The Prompt API isn't available in Web Workers, and whether an extension
// service worker exposes it is unconfirmed. Use it here when it exists;
// otherwise run nano.js in the offscreen document (a top-level page).

// Set after the worker's own Prompt API fails once: whether it really works in
// an extension service worker is unconfirmed, and the offscreen document (a
// top-level page) is known to. Lasts for this worker's lifetime.
let nanoWorkerBroken = false;

function nanoInWorker() {
  return !nanoWorkerBroken && typeof LanguageModel !== 'undefined' && typeof nanoExtract === 'function';
}

async function getNanoAvailability() {
  if (nanoInWorker()) {
    // nanoAvailability() maps a throw to 'unavailable'. Don't trust a "no" from
    // the worker alone: switch to the offscreen document and let it decide.
    const worker = await nanoAvailability();
    if (worker !== 'unavailable' && worker !== 'unsupported') return worker;
    nanoWorkerBroken = true;
  }
  const resp = await offscreenRequest({ action: 'nano-availability' });
  if (resp.error) throw new Error(resp.error);
  return resp.availability;
}

async function runNano(input, timeoutMs) {
  return withKeepAlive(async () => {
    if (nanoInWorker()) {
      try {
        return await nanoExtract(input, { timeoutMs });
      } catch (err) {
        nanoWorkerBroken = true;
        throw err;
      }
    }
    // nano.js enforces timeoutMs in the document; this guards a document
    // that never answers at all.
    let timer;
    const hung = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Offscreen model host timed out')), timeoutMs + 15000);
    });
    try {
      const resp = await Promise.race([offscreenRequest({ action: 'nano-detect', ...input, timeoutMs }), hung]);
      if (resp.error) throw new Error(resp.error);
      return resp;
    } finally {
      clearTimeout(timer);
    }
  });
}

// A Nano call can outlast the worker's 30s idle timer, and neither prompt()
// nor waiting on the offscreen reply counts as activity. Any extension API
// call resets it.
async function withKeepAlive(fn) {
  const ping = typeof setInterval === 'function'
    ? setInterval(() => { chrome.runtime.getPlatformInfo?.()?.catch?.(() => {}); }, 20000)
    : null;
  try {
    return await fn();
  } finally {
    if (ping !== null) clearInterval(ping);
  }
}

// Retry instead of a fixed delay: a just-created document's listener may not
// be registered yet.
async function offscreenRequest(message) {
  await ensureOffscreenDocument();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await chrome.runtime.sendMessage(message);
      if (resp) return resp;
    } catch { /* receiving end not ready yet */ }
    await sleep(150);
  }
  throw new Error('Offscreen document did not answer');
}

// --- Code sanity filter ---

// Sanity filter against hallucinated or junk answers overwriting the
// clipboard. Shape: wide enough for real formats (6-digit OTPs, Steam 5-char,
// 16-char grouped app passwords, 14-16 digit bank auth codes). Grounding: the
// code must appear in what the model was shown as a WHOLE token — this
// rejects "None", "null", made-up strings, most prompt-injected payloads, and
// the 20-char prefix of a long token that Nano's maxLength can produce
// ("eyJhbGciOiJIUzUxMiIs" out of a JWT).
function isPlausibleCode(code, subject, body) {
  if (!/^[A-Za-z0-9-]{4,20}$/.test(code)) return false;
  if (!/[A-Za-z0-9]/.test(code)) return false;
  if (/^(null|none|nil|undefined|true|false|n-?a|empty|code|otp)$/i.test(code)) return false;
  return groundingRegex(code).test(`${subject}\n${body}`);
}

// Between the code's characters, allow only the separators senders use for
// grouping: whitespace, '-', U+2010-U+2015 dashes (incl. the U+2011
// non-breaking hyphen), U+00B7 middot, '.'. Not glued to other alphanumerics.
// The end must also not continue the token: '_' (base64url), or a '-'/'.'
// joined straight to more alphanumerics ('eyJhbGciOiJIUzI1NiJ9.eyJz...', a JWT
// whose first segment is exactly 20 chars). "is 123456." and "123456 - " pass.
// The start only refuses '_': "G-123456" must still ground "123456".
// Linear-time: the code is <= 20 alphanumerics, none of which can match a
// separator, so the [..]* runs never backtrack into each other.
const GROUP_SEPARATORS = '[\\s\\-\\u2010-\\u2015\\u00B7.]*';
function groundingRegex(code) {
  const chars = code.replace(/[^A-Za-z0-9]/g, '').split('');
  return new RegExp(
    `(?<![A-Za-z0-9_])${chars.join(GROUP_SEPARATORS)}(?![A-Za-z0-9_]|[\\-\\u2010-\\u2015\\u00B7.][A-Za-z0-9_])`,
    'i',
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Clipboard via Offscreen Document ---

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length) return;

  // Two codes in one batch must not race createDocument ("Only a single
  // offscreen document may be created" throws).
  offscreenCreating ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    // CLIPBOARD is the only fitting reason; the same document also hosts the
    // on-device model when the service worker has no Prompt API.
    justification: 'Copy login codes to the clipboard, and run Chrome\'s on-device model (Gemini Nano) to find them in new emails',
  }).finally(() => { offscreenCreating = null; });
  try {
    await offscreenCreating;
  } catch (err) {
    // Lost a race: our getContexts() answered before another caller's
    // document existed, and that caller's create finished first.
    if (!/single offscreen/i.test(err?.message || '')) throw err;
  }
}

async function copyToClipboard(text) {
  try {
    return !!(await offscreenRequest({ action: 'clipboard-write', text })).copied;
  } catch (err) {
    console.error('Clipboard copy failed:', err.message);
    return false;
  }
}
