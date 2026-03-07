const { Firestore } = require('@google-cloud/firestore');
const webpush = require('web-push');

const db = new Firestore();

webpush.setVapidDetails(
  'mailto:sayak@generalintel.co',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/**
 * HTTP-triggered: extension calls this to register/update its push subscription.
 */
exports.registerPush = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    res.status(400).json({ error: 'Missing or invalid subscription' });
    return;
  }

  await db.collection('config').doc('push').set({ subscription });
  console.log('Push subscription registered:', subscription.endpoint);
  res.json({ success: true });
};

/**
 * Pub/Sub-triggered: Gmail pushes here when new mail arrives.
 * Reads the current push subscription from Firestore and sends a Web Push notification.
 */
exports.gmailPushHandler = async (pubsubMessage) => {
  const doc = await db.collection('config').doc('push').get();
  if (!doc.exists) {
    console.warn('No push subscription in Firestore — call registerPush first');
    return;
  }

  const { subscription } = doc.data();

  let data;
  try {
    data = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
  } catch (err) {
    console.error('Failed to parse Pub/Sub message:', err);
    return;
  }

  console.log(`Gmail notification for ${data.emailAddress}, historyId: ${data.historyId}`);

  const payload = JSON.stringify({
    type: 'gmail_update',
    historyId: String(data.historyId),
  });

  try {
    await webpush.sendNotification(subscription, payload);
    console.log('Push notification sent');
  } catch (err) {
    console.error('Push send failed:', err.statusCode, err.body);
  }
};
