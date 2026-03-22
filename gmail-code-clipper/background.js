importScripts('config.js');
const GCP_TOPIC_NAME = CONFIG.GCP_TOPIC_NAME;
const VAPID_PUBLIC_KEY = CONFIG.VAPID_PUBLIC_KEY;
const REGISTER_PUSH_URL = CONFIG.REGISTER_PUSH_URL;
const MAX_PROCESSED_CACHE = 200;

// --- State ---
let lastHistoryId = null;
let isMonitoring = false;
let processedMessageIds = new Set();
let pushActive = false;
let stateRestored = false;

// --- Lifecycle ---

// Restore state on EVERY service worker start (not just onInstalled/onStartup).
// This is critical because Chrome can terminate and restart the service worker
// at any time (e.g. when a push arrives after 5min of inactivity).
async function restoreState() {
  if (stateRestored) return;
  const stored = await chrome.storage.local.get(['lastHistoryId', 'pushActive']);
  lastHistoryId = stored.lastHistoryId || null;
  pushActive = !!stored.pushActive;
  if (pushActive) isMonitoring = true;
  stateRestored = true;
}

// Quick restore runs immediately on every service worker start
restoreState();

// Full restore with re-registration runs on Chrome start/install
chrome.runtime.onInstalled.addListener(() => fullRestore());
chrome.runtime.onStartup.addListener(() => fullRestore());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'gmail-watch-renew') {
    restoreState().then(() => setupGmailWatch().catch(console.error));
  }
});

async function fullRestore() {
  await restoreState();
  if (pushActive) {
    await reregisterPushSubscription();
    setupGmailWatch().catch((err) => console.warn('Watch renewal on startup failed:', err.message));
  }
}

// --- Web Push ---

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    await restoreState();
    const data = event.data?.json();
    console.log('Push received:', data);
    if (data?.type === 'gmail_update') {
      await checkForNewEmails();
    }
  })());
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

async function registerPushSubscription() {
  if (!self.registration?.pushManager) {
    throw new Error('Push API not available');
  }

  let subscription = await self.registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  // Send to Cloud Function so it can push to us
  const resp = await fetch(REGISTER_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  if (!resp.ok) throw new Error(`Register push failed: ${resp.status}`);

  console.log('Push subscription registered');
  return subscription;
}

async function reregisterPushSubscription() {
  try {
    await registerPushSubscription();
  } catch (err) {
    console.error('Failed to re-register push on startup:', err);
  }
}

async function setupGmailWatch() {
  const token = await getAuthToken();
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topicName: GCP_TOPIC_NAME,
      labelIds: ['INBOX'],
    }),
  });

  if (!response.ok) {
    throw new Error(`Gmail watch failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  lastHistoryId = result.historyId;
  await chrome.storage.local.set({ lastHistoryId });

  // Renew 1 hour before expiry
  const renewInMs = Math.max(Number(result.expiration) - Date.now() - 3600000, 60000);
  chrome.alarms.create('gmail-watch-renew', { delayInMinutes: renewInMs / 60000 });
  console.log('Gmail watch active, expires:', new Date(Number(result.expiration)).toISOString());
  return result;
}

// --- Message handling from popup ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startMonitoring') {
    startMonitoring().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'getStatus') {
    sendResponse({ monitoring: isMonitoring, pushActive });
  }
  return false;
});

// --- Start / Stop ---

async function startMonitoring() {
  isMonitoring = true;

  try {
    const token = await getAuthToken();
    const profile = await fetchGmailApi(token, 'users/me/profile');
    lastHistoryId = profile.historyId;
    await chrome.storage.local.set({ lastHistoryId });
    console.log('Monitoring started, historyId:', lastHistoryId);
  } catch (err) {
    console.error('Failed to initialize:', err);
  }

  // Enable push (watch + subscription)
  try {
    await registerPushSubscription();
    await setupGmailWatch();
    pushActive = true;
    await chrome.storage.local.set({ pushActive: true });
    console.log('Push mode active — no polling');
  } catch (err) {
    console.error('Push setup failed:', err.message);
    pushActive = false;
    await chrome.storage.local.set({ pushActive: false });
  }
}

// No stopMonitoring — once set up, monitoring is always on

// --- Gmail Auth ---

async function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

async function fetchGmailApi(token, endpoint) {
  let response = await fetch(`https://gmail.googleapis.com/gmail/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    const newToken = await getAuthToken();
    response = await fetch(`https://gmail.googleapis.com/gmail/v1/${endpoint}`, {
      headers: { Authorization: `Bearer ${newToken}` },
    });
  }

  if (!response.ok) {
    throw new Error(`Gmail API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// --- Email Checking ---

async function checkForNewEmails() {
  const token = await getAuthToken();

  if (!lastHistoryId) {
    const profile = await fetchGmailApi(token, 'users/me/profile');
    lastHistoryId = profile.historyId;
    await chrome.storage.local.set({ lastHistoryId });
    return;
  }

  try {
    const history = await fetchGmailApi(
      token,
      `users/me/history?startHistoryId=${lastHistoryId}&historyTypes=messageAdded&labelId=INBOX`
    );

    if (history.historyId) {
      lastHistoryId = history.historyId;
      await chrome.storage.local.set({ lastHistoryId });
    }

    if (!history.history) return;

    const newMessageIds = [];
    for (const h of history.history) {
      if (h.messagesAdded) {
        for (const msg of h.messagesAdded) {
          const id = msg.message.id;
          if (!processedMessageIds.has(id)) {
            newMessageIds.push(id);
            processedMessageIds.add(id);
          }
        }
      }
    }

    if (processedMessageIds.size > MAX_PROCESSED_CACHE) {
      const arr = [...processedMessageIds];
      processedMessageIds = new Set(arr.slice(-100));
    }

    for (const msgId of newMessageIds) {
      await processMessage(token, msgId);
    }
  } catch (err) {
    if (err.message.includes('404') || err.message.includes('historyId')) {
      const profile = await fetchGmailApi(token, 'users/me/profile');
      lastHistoryId = profile.historyId;
      await chrome.storage.local.set({ lastHistoryId });
    } else {
      throw err;
    }
  }
}

// --- Process a single message ---

async function processMessage(token, messageId) {
  const message = await fetchGmailApi(token, `users/me/messages/${messageId}?format=full`);

  const subject = getHeader(message, 'Subject') || '';
  const from = getHeader(message, 'From') || '';
  const body = extractBody(message);
  if (!body) return;

  const code = await detectCodeWithGemini(subject, from, body);
  if (!code) return;

  await copyToClipboard(code);

  chrome.notifications.create(`code-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title: 'Login Code Copied!',
    message: `"${code}" from ${from}`,
    priority: 2,
  });

  chrome.action.setBadgeText({ text: code });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 30000);

  const { codeHistory = [] } = await chrome.storage.local.get('codeHistory');
  codeHistory.unshift({ code, subject, from, timestamp: Date.now() });
  await chrome.storage.local.set({ codeHistory: codeHistory.slice(0, 30) });

  chrome.runtime.sendMessage({ action: 'codeDetected', code, subject, from }).catch(() => {});
}

function getHeader(message, name) {
  return message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value;
}

function extractBody(message) {
  const parts = [];

  function walk(payload) {
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      parts.push(base64Decode(payload.body.data));
      return;
    }
    if (payload.parts) {
      const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
      if (textPart) {
        walk(textPart);
      } else {
        for (const part of payload.parts) walk(part);
      }
    }
    if (!payload.parts && payload.body?.data && parts.length === 0) {
      parts.push(base64Decode(payload.body.data));
    }
  }

  walk(message.payload);

  let body = parts.join('\n');
  body = body.replace(/<[^>]*>/g, ' ').replace(/&[a-zA-Z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  return body.substring(0, 3000);
}

function base64Decode(data) {
  return atob(data.replace(/-/g, '+').replace(/_/g, '/'));
}

// --- Gemini Code Detection ---

async function detectCodeWithGemini(subject, from, body) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) {
    console.warn('Gemini API key not set');
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${geminiApiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text: `Extract the login verification code, OTP, or two-factor authentication code from this email. Return empty string if none found.\n\nFrom: ${from}\nSubject: ${subject}\nBody:\n${body}`,
          }],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            required: ['login_code'],
            properties: { login_code: { type: 'STRING' } },
          },
        },
      }),
    });

    if (!response.ok) {
      console.error('Gemini API error:', response.status);
      return null;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const result = JSON.parse(text);
    return result.login_code || null;
  } catch (err) {
    console.error('Gemini detection error:', err);
    return null;
  }
}

// --- Clipboard via Offscreen Document ---

async function copyToClipboard(text) {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });

    if (!existingContexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Copy login code to clipboard',
      });
      await new Promise((r) => setTimeout(r, 300));
    }

    await chrome.runtime.sendMessage({ action: 'clipboard-write', text });
  } catch (err) {
    console.error('Clipboard copy failed:', err);
  }
}
