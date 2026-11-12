const crypto = require('crypto');
const { Firestore } = require('@google-cloud/firestore');
const webpush = require('web-push');

const db = new Firestore();
const SUBSCRIPTIONS = 'pushSubscriptions';
// A handful of Chrome profiles/machines per Gmail account; oldest are pruned.
const MAX_DEVICES_PER_EMAIL = 5;

function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// VAPID details are read per send (not at module load) so register-push never
// needs the private key and a missing key can't crash it at cold start.
function vapidDetails() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw new Error('VAPID keys not configured');
  const subject = process.env.VAPID_SUBJECT || `mailto:${allowedEmails()[0] || 'admin@example.com'}`;
  return { subject, publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
}

function endpointId(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

class UpstreamError extends Error {}

// Resolve the caller's Gmail address from the OAuth access token the extension
// already holds (gmail.readonly). Returns null if the token is missing or
// rejected; throws UpstreamError if Google itself failed (429/5xx), so a
// Google outage isn't reported to the extension as a bad token.
async function emailFromToken(authHeader) {
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader || '');
  if (!m) return null;
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${m[1]}` },
  });
  if (resp.status === 401 || resp.status === 403) return null;
  if (!resp.ok) throw new UpstreamError(`Gmail profile lookup failed: ${resp.status}`);
  const profile = await resp.json();
  return typeof profile.emailAddress === 'string' ? profile.emailAddress.toLowerCase() : null;
}

function validSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  try {
    if (new URL(endpoint).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return !!keys && typeof keys.p256dh === 'string' && typeof keys.auth === 'string'
    && keys.p256dh.length < 256 && keys.auth.length < 256;
}

/**
 * HTTP-triggered: the extension calls this to register/update its push
 * subscription. Authenticated with the user's Google OAuth access token, and
 * restricted to ALLOWED_EMAILS, so nobody else can redirect or kill the push
 * channel. Subscriptions are stored per (email, endpoint), so several
 * devices/profiles no longer overwrite each other.
 *
 * Responds with staleEndpoint:true when the extension re-registers an endpoint
 * the push service already declared dead (410) — the extension then mints a
 * fresh subscription and registers again.
 *
 * No CORS headers on purpose: the extension's service worker isn't subject to
 * CORS (host_permissions), and refusing preflights keeps web pages out.
 */
exports.registerPush = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const allowed = allowedEmails();
  if (!allowed.length) {
    console.error('ALLOWED_EMAILS is not configured — refusing all registrations');
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  let email;
  try {
    email = await emailFromToken(req.get ? req.get('Authorization') : req.headers?.authorization);
  } catch (err) {
    // UpstreamError (Google 429/5xx) or a network failure: retryable, and
    // distinct from 401 so the extension doesn't treat it as a bad token.
    console.error('Token verification failed:', err.message);
    res.status(502).json({ error: 'Could not verify token' });
    return;
  }
  if (!email) {
    res.status(401).json({ error: 'Missing or invalid Google access token' });
    return;
  }
  if (!allowed.includes(email)) {
    console.warn('Registration from non-allow-listed account rejected');
    res.status(403).json({ error: 'Account not allowed' });
    return;
  }

  const { subscription } = req.body || {};
  if (!validSubscription(subscription)) {
    res.status(400).json({ error: 'Missing or invalid subscription' });
    return;
  }

  try {
    const ref = db.collection(SUBSCRIPTIONS).doc(endpointId(subscription.endpoint));
    const doc = await ref.get();
    if (doc.exists && doc.data().dead) {
      console.warn('Extension re-registered a dead endpoint — asking it to resubscribe');
      res.json({ success: false, staleEndpoint: true });
      return;
    }

    const { endpoint, keys } = subscription;
    await ref.set({ email, subscription: { endpoint, keys }, updatedAt: Date.now(), dead: false });
    await pruneDevices(email);
    console.log('Push subscription registered');
    res.json({ success: true });
  } catch (err) {
    console.error('registerPush failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
};

async function pruneDevices(email) {
  const snap = await db.collection(SUBSCRIPTIONS).where('email', '==', email).get();
  const docs = [...snap.docs].sort((a, b) => (b.data().updatedAt || 0) - (a.data().updatedAt || 0));
  await Promise.all(docs.slice(MAX_DEVICES_PER_EMAIL).map((d) => d.ref.delete()));
}

/**
 * Pub/Sub-triggered: Gmail pushes here when new mail arrives. Sends a Web
 * Push to every live subscription registered for that Gmail account.
 */
exports.gmailPushHandler = async (pubsubMessage) => {
  let data;
  try {
    data = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
  } catch (err) {
    console.error('Failed to parse Pub/Sub message:', err);
    return;
  }
  const email = String(data.emailAddress || '').toLowerCase();
  console.log(`Gmail notification, historyId: ${data.historyId}`);

  const snap = await db.collection(SUBSCRIPTIONS).where('email', '==', email).get();
  const live = snap.docs.filter((d) => !d.data().dead && d.data().subscription);
  if (!live.length) {
    // Migration fallback: before per-account subscriptions, the one
    // subscription lived in config/push. Keep delivering to it until the
    // extension (reloaded with the token-sending build) re-registers.
    const legacy = await db.collection('config').doc('push').get();
    const legacySub = legacy.exists ? legacy.data().subscription : null;
    if (legacySub) live.push({ data: () => ({ subscription: legacySub }), ref: null, legacy: true });
  }
  if (!live.length) {
    console.warn('No live push subscription for this account — the extension registers on setup/health check');
    return;
  }

  const payload = JSON.stringify({ type: 'gmail_update', historyId: String(data.historyId) });
  const options = {
    // TTL 24h: pushes queued while the laptop is closed overnight must still
    // deliver on wake (the wake-up drain is the fallback, not the primary).
    TTL: 86400,
    urgency: 'high',
    // Every push just means "drain now", so queued ones can collapse into one.
    topic: 'gmail-update',
    vapidDetails: vapidDetails(),
  };

  await Promise.all(live.map(async (doc) => {
    try {
      await webpush.sendNotification(doc.data().subscription, payload, options);
      console.log('Push notification sent');
    } catch (err) {
      if ((err.statusCode === 404 || err.statusCode === 410) && doc.ref) {
        // Dead endpoint. Marking THIS endpoint's own doc can't clobber a
        // freshly registered subscription (that's a different endpoint/doc).
        console.warn('Subscription gone (HTTP', err.statusCode, ') — marking dead');
        await doc.ref.set({ dead: true }, { merge: true });
      } else {
        console.error('Push send failed:', err.statusCode, err.body);
      }
    }
  }));
};
