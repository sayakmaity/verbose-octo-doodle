importScripts('config.js');
const GCP_TOPIC_NAME = CONFIG.GCP_TOPIC_NAME;
const VAPID_PUBLIC_KEY = CONFIG.VAPID_PUBLIC_KEY;
const REGISTER_PUSH_URL = CONFIG.REGISTER_PUSH_URL;
const OAUTH_CLIENT_ID = CONFIG.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = CONFIG.OAUTH_CLIENT_SECRET;
const MAX_PROCESSED_CACHE = 200;

// --- State ---
// accounts: { [email]: { accessToken, refreshToken, lastHistoryId, expiresAt } }
let accounts = {};
let isMonitoring = false;
let processedMessageIds = new Set();
let pushActive = false;

// --- Lifecycle ---

chrome.runtime.onInstalled.addListener(() => restoreAndStart());
chrome.runtime.onStartup.addListener(() => restoreAndStart());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'gmail-watch-renew') setupAllWatches().catch(console.error);
});

async function restoreAndStart() {
  const stored = await chrome.storage.local.get(['monitoring', 'accounts', 'pushActive']);
  pushActive = !!stored.pushActive;

  if (stored.accounts) {
    for (const [email, data] of Object.entries(stored.accounts)) {
      accounts[email] = {
        accessToken: null,
        refreshToken: data.refreshToken,
        lastHistoryId: data.lastHistoryId,
        expiresAt: 0,
      };
    }
  }

  if (stored.monitoring) {
    isMonitoring = true;
    if (pushActive) {
      await reregisterPushSubscription();
      setupAllWatches().catch((err) => console.warn('Watch renewal on startup failed:', err.message));
    }
  }
}

function persistAccounts() {
  const toStore = {};
  for (const [email, data] of Object.entries(accounts)) {
    toStore[email] = {
      refreshToken: data.refreshToken,
      lastHistoryId: data.lastHistoryId,
    };
  }
  chrome.storage.local.set({ accounts: toStore });
}

// --- OAuth via launchWebAuthFlow (PKCE) ---

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function launchOAuthFlow() {
  const redirectUrl = chrome.identity.getRedirectURL();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly email');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'select_account consent');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      (url) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(url);
      }
    );
  });

  const code = new URL(responseUrl).searchParams.get('code');
  if (!code) throw new Error('No auth code in response');

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUrl,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResp.ok) {
    throw new Error(`Token exchange failed: ${tokenResp.status} ${await tokenResp.text()}`);
  }

  return tokenResp.json();
}

async function refreshAccessToken(refreshToken) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!resp.ok) {
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

  return resp.json();
}

async function getTokenForAccount(email) {
  const acct = accounts[email];
  if (!acct) throw new Error(`No account: ${email}`);

  if (acct.accessToken && Date.now() < acct.expiresAt - 60000) {
    return acct.accessToken;
  }

  const data = await refreshAccessToken(acct.refreshToken);
  acct.accessToken = data.access_token;
  acct.expiresAt = Date.now() + data.expires_in * 1000;
  return acct.accessToken;
}

// --- Web Push ---

self.addEventListener('push', (event) => {
  const data = event.data?.json();
  console.log('Push received:', data);
  if (data?.type === 'gmail_update') {
    const email = data.emailAddress;
    if (email && accounts[email]) {
      event.waitUntil(checkAccountForNewEmails(email));
    } else {
      event.waitUntil(checkAllAccountsForNewEmails());
    }
  }
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
  if (!self.registration?.pushManager) throw new Error('Push API not available');

  let subscription = await self.registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const resp = await fetch(REGISTER_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  if (!resp.ok) throw new Error(`Register push failed: ${resp.status}`);
  return subscription;
}

async function reregisterPushSubscription() {
  try { await registerPushSubscription(); } catch (err) {
    console.error('Push re-register failed:', err);
  }
}

async function setupGmailWatch(token) {
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ topicName: GCP_TOPIC_NAME, labelIds: ['INBOX'] }),
  });
  if (!response.ok) throw new Error(`Gmail watch failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function setupAllWatches() {
  let earliestExpiry = Infinity;
  for (const email of Object.keys(accounts)) {
    try {
      const token = await getTokenForAccount(email);
      const result = await setupGmailWatch(token);
      accounts[email].lastHistoryId = result.historyId;
      const expiry = Number(result.expiration);
      if (expiry < earliestExpiry) earliestExpiry = expiry;
      console.log(`Watch active for ${email}`);
    } catch (err) {
      console.warn(`Watch failed for ${email}:`, err.message);
    }
  }
  persistAccounts();
  if (earliestExpiry < Infinity) {
    const renewInMs = Math.max(earliestExpiry - Date.now() - 3600000, 60000);
    chrome.alarms.create('gmail-watch-renew', { delayInMinutes: renewInMs / 60000 });
  }
}

// --- Message handling from popup ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startMonitoring') {
    startMonitoring().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'stopMonitoring') {
    stopMonitoring();
    sendResponse({ success: true });
  }
  if (message.action === 'getStatus') {
    sendResponse({ monitoring: isMonitoring, pushActive, accounts: Object.keys(accounts) });
  }
  if (message.action === 'addAccount') {
    addAccount()
      .then((email) => sendResponse({ email }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (message.action === 'removeAccount') {
    removeAccount(message.email);
    sendResponse({ success: true });
  }
  return false;
});

// --- Account Management ---

async function addAccount() {
  const tokenData = await launchOAuthFlow();

  const profileResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileResp.ok) throw new Error('Failed to get profile');
  const profile = await profileResp.json();
  const email = profile.emailAddress;

  if (accounts[email]) {
    accounts[email].accessToken = tokenData.access_token;
    accounts[email].refreshToken = tokenData.refresh_token || accounts[email].refreshToken;
    accounts[email].expiresAt = Date.now() + tokenData.expires_in * 1000;
    accounts[email].lastHistoryId = profile.historyId;
  } else {
    accounts[email] = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      lastHistoryId: profile.historyId,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
    };
  }

  persistAccounts();
  console.log('Added account:', email);

  if (isMonitoring && pushActive) {
    try { await setupGmailWatch(tokenData.access_token); } catch (err) {
      console.warn(`Watch setup failed for ${email}:`, err.message);
    }
  }

  return email;
}

function removeAccount(email) {
  delete accounts[email];
  persistAccounts();
  console.log('Removed account:', email);
}

// --- Start / Stop ---

async function startMonitoring() {
  isMonitoring = true;
  await chrome.storage.local.set({ monitoring: true });

  if (Object.keys(accounts).length === 0) {
    try { await addAccount(); } catch (err) {
      console.error('Failed to add initial account:', err);
    }
  } else {
    for (const email of Object.keys(accounts)) {
      try {
        const token = await getTokenForAccount(email);
        const profile = await fetchGmailApi(token, 'users/me/profile');
        accounts[email].lastHistoryId = profile.historyId;
      } catch (err) {
        console.error(`Failed to init ${email}:`, err);
      }
    }
    persistAccounts();
  }

  console.log('Monitoring:', Object.keys(accounts).join(', '));

  // Enable push (watch + subscription)
  try {
    await registerPushSubscription();
    await setupAllWatches();
    pushActive = true;
    await chrome.storage.local.set({ pushActive: true });
    console.log('Push mode active — no polling');
  } catch (err) {
    console.error('Push setup failed:', err.message);
    pushActive = false;
    await chrome.storage.local.set({ pushActive: false });
  }
}

function stopMonitoring() {
  isMonitoring = false;
  chrome.storage.local.set({ monitoring: false });
  chrome.alarms.clear('gmail-watch-renew');
}

// --- Gmail API ---

async function fetchGmailApi(token, endpoint) {
  let response = await fetch(`https://gmail.googleapis.com/gmail/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Gmail API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// --- Email Checking ---

async function checkAllAccountsForNewEmails() {
  for (const email of Object.keys(accounts)) {
    try { await checkAccountForNewEmails(email); } catch (err) {
      console.error(`Check failed for ${email}:`, err.message);
    }
  }
}

async function checkAccountForNewEmails(email) {
  const acct = accounts[email];
  if (!acct) return;

  let token;
  try { token = await getTokenForAccount(email); } catch (err) {
    console.error(`Auth failed for ${email}:`, err.message);
    return;
  }

  if (!acct.lastHistoryId) {
    const profile = await fetchGmailApi(token, 'users/me/profile');
    acct.lastHistoryId = profile.historyId;
    persistAccounts();
    return;
  }

  try {
    const history = await fetchGmailApi(
      token,
      `users/me/history?startHistoryId=${acct.lastHistoryId}&historyTypes=messageAdded&labelId=INBOX`
    );

    if (history.historyId) {
      acct.lastHistoryId = history.historyId;
      persistAccounts();
    }

    if (!history.history) return;

    const newMessageIds = [];
    for (const h of history.history) {
      if (h.messagesAdded) {
        for (const msg of h.messagesAdded) {
          const id = `${email}:${msg.message.id}`;
          if (!processedMessageIds.has(id)) {
            newMessageIds.push(msg.message.id);
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
      await processMessage(token, msgId, email);
    }
  } catch (err) {
    if (err.message.includes('404') || err.message.includes('historyId')) {
      const profile = await fetchGmailApi(token, 'users/me/profile');
      acct.lastHistoryId = profile.historyId;
      persistAccounts();
    } else {
      throw err;
    }
  }
}

// --- Process a single message ---

async function processMessage(token, messageId, email) {
  const message = await fetchGmailApi(token, `users/me/messages/${messageId}?format=full`);

  const subject = getHeader(message, 'Subject') || '';
  const from = getHeader(message, 'From') || '';
  const body = extractBody(message);
  if (!body) return;

  const code = await detectCodeWithGemini(subject, from, body);
  if (!code) return;

  await copyToClipboard(code);

  const accountLabel = Object.keys(accounts).length > 1 ? ` (${email})` : '';
  chrome.notifications.create(`code-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title: 'Login Code Copied!',
    message: `"${code}" from ${from}${accountLabel}`,
    priority: 2,
  });

  chrome.action.setBadgeText({ text: code });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 30000);

  const { codeHistory = [] } = await chrome.storage.local.get('codeHistory');
  codeHistory.unshift({ code, subject, from, email, timestamp: Date.now() });
  await chrome.storage.local.set({ codeHistory: codeHistory.slice(0, 30) });

  chrome.runtime.sendMessage({ action: 'codeDetected', code, subject, from, email }).catch(() => {});
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
      if (textPart) { walk(textPart); }
      else { for (const part of payload.parts) walk(part); }
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
  if (!geminiApiKey) { console.warn('Gemini API key not set'); return null; }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${geminiApiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{
          text: `Extract the login verification code, OTP, or two-factor authentication code from this email. Return empty string if none found.\n\nFrom: ${from}\nSubject: ${subject}\nBody:\n${body}`,
        }] }],
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

    if (!response.ok) { console.error('Gemini API error:', response.status); return null; }
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const result = JSON.parse(text);
    return result.login_code || null;
  } catch (err) { console.error('Gemini detection error:', err); return null; }
}

// --- Clipboard via Offscreen Document ---

async function copyToClipboard(text) {
  try {
    const existingContexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!existingContexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['CLIPBOARD'],
        justification: 'Copy login code to clipboard',
      });
      await new Promise((r) => setTimeout(r, 300));
    }
    await chrome.runtime.sendMessage({ action: 'clipboard-write', text });
  } catch (err) { console.error('Clipboard copy failed:', err); }
}
