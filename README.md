# Gmail Code Clipper

A Chrome extension that watches your Gmail for login codes and copies them to your clipboard instantly. Zero polling — uses push notifications so your laptop stays asleep until a code arrives.

## How it works

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Google Cloud Platform                        │
│                                                                     │
│  ┌───────────┐    watch()    ┌──────────────┐    ┌───────────────┐  │
│  │ Gmail API │──────────────>│  Cloud       │───>│ Cloud         │  │
│  │           │  "new email"  │  Pub/Sub     │    │ Function      │  │
│  └─────┬─────┘               └──────────────┘    └───────┬───────┘  │
│        │                                                 │          │
│        │                                          Web Push (FCM)    │
│        │                                                 │          │
└────────│─────────────────────────────────────────────────│──────────┘
         │                                                 │
         │  Gmail API                                      │
         │  (read email)                                   │
         │                                                 ▼
         │         ┌──────────────────────────────────────────────┐
         └────────>│            Chrome Extension                  │
                   │                                              │
                   │  ┌──────────┐  ┌─────────┐  ┌────────────┐  │
                   │  │ Service  │─>│ Gemini  │─>│ Clipboard  │  │
                   │  │ Worker   │  │ Flash   │  │ + Badge    │  │
                   │  │ (wakes   │  │ Lite    │  │ + Notify   │  │
                   │  │  on push)│  │         │  │            │  │
                   │  └──────────┘  └─────────┘  └────────────┘  │
                   │                                              │
                   └──────────────────────────────────────────────┘
```

No background polling. The extension makes zero network calls when idle. The only scheduled task is renewing the Gmail `watch()` subscription every ~6 days.

## Project structure

```
gmail-code-clipper/          # Chrome extension
  background.js              Service worker: push handler, Gmail API, Gemini, clipboard
  config.js                  Your project-specific config (gitignored)
  config.example.js          Template — copy to config.js and fill in values
  manifest.json              Extension manifest (gitignored — has your OAuth client ID)
  manifest.example.json      Template — copy to manifest.json
  offscreen.html + .js       Offscreen document for clipboard writes (MV3 requirement)
  popup.html + .js + .css    Popup UI: start/stop toggle, Gemini API key, code history
  icon{16,48,128}.png        Extension icons

cloud-function/              # GCP Cloud Function (push relay)
  index.js                   Pub/Sub handler + push subscription registration endpoint
  package.json               Dependencies: @google-cloud/firestore, web-push
  deploy.sh                  One-command setup: APIs, Pub/Sub, Firestore, deploy
  .env.yaml                  VAPID keys (gitignored)
```

## Setup

### 1. Google Cloud project

Create a project (or use an existing one) at [console.cloud.google.com](https://console.cloud.google.com).

Enable the **Gmail API**:
```
gcloud services enable gmail.googleapis.com --project=YOUR_PROJECT_ID
```

### 2. Deploy the Cloud Function

```bash
cd cloud-function
npm install
./deploy.sh YOUR_PROJECT_ID
```

This enables all required APIs (Pub/Sub, Cloud Functions, FCM, Firestore, Firebase), creates the Pub/Sub topic, grants Gmail publish access, generates VAPID keys, and deploys two Cloud Functions:

- **gmail-push-handler** (Pub/Sub trigger) — receives Gmail notifications, sends Web Push to extension
- **register-push** (HTTP trigger) — extension calls this to register its push subscription

The script prints the config values you'll need for the extension.

### 3. OAuth consent screen

Go to **Google Auth Platform** in the Cloud Console:

1. Configure **Branding** (app name, support email)
2. Under **Audience**, add your Gmail address as a test user
3. Under **Clients**, create a **Chrome extension** client with your extension's Item ID

You'll get the extension ID after loading it in step 5.

### 4. Configure the extension

Two files are gitignored because they contain project-specific secrets. You need to create them from the provided templates:

```bash
cd gmail-code-clipper
cp config.example.js config.js
cp manifest.example.json manifest.json
```

**`config.js`** — fill in these values:

| Field | Where to get it |
|---|---|
| `GCP_TOPIC_NAME` | `projects/YOUR_PROJECT_ID/topics/gmail-code-push` (your GCP project ID) |
| `VAPID_PUBLIC_KEY` | Printed by `deploy.sh` when you deployed the Cloud Function |
| `REGISTER_PUSH_URL` | Printed by `deploy.sh` (looks like `https://register-push-xxxxx-uc.a.run.app`) |
| `OAUTH_CLIENT_ID` | From the Chrome extension OAuth client you created in step 3 |

**`manifest.json`** — fill in these values:

| Field | Where to get it |
|---|---|
| `oauth2.client_id` | Same Chrome extension OAuth client ID as above |
| `host_permissions` (3rd entry) | Replace `YOUR_PROJECT_ID` with your GCP project ID |

**`.env.yaml`** (in `cloud-function/`) is also gitignored — `deploy.sh` generates this automatically with your VAPID keys.

### 5. Load the extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**, select the `gmail-code-clipper` folder
4. Note the **extension ID** — go back to step 3 and enter it as the Item ID if you haven't

### 6. Start it

1. Click the extension icon in the toolbar
2. Paste your **Gemini API key** ([get one here](https://aistudio.google.com/apikey)) and click Save
3. Click **Start Monitoring**
4. Sign in with Google when prompted

The extension will set up Gmail `watch()` and register for push notifications. When a login code email arrives, it's automatically copied to your clipboard and the code appears as a badge on the extension icon.

## Self-hosting your own instance

Everything in this repo is designed to run on your own GCP project. Follow steps 1–6 above and you'll have your own fully independent instance — your own OAuth client, your own Cloud Functions, your own Pub/Sub topic. Nothing is shared with anyone else.

The whole setup takes about 15 minutes and costs effectively $0 (GCP free tier covers all infrastructure; Gemini free tier gives 1,500 requests/day).
