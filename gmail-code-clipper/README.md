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
                   │  │ Worker   │  │ Nano    │  │ + Badge    │  │
                   │  │ (wakes   │  │ (on-    │  │ + Notify   │  │
                   │  │  on push)│  │ device) │  │            │  │
                   │  └──────────┘  └─────────┘  └────────────┘  │
                   │                                              │
                   └──────────────────────────────────────────────┘
```

No background polling. The extension makes zero network calls when idle. The only scheduled task is renewing the Gmail `watch()` subscription every ~6 days.

## Project structure

```
gmail-code-clipper/          # Chrome extension
  background.js              Service worker: push handler, Gmail API, pre-filter, engine selection, clipboard
  nano.js                    Gemini Nano (Chrome's on-device model) + the shared prompt
  config.js                  Your project-specific config (gitignored)
  config.example.js          Template — copy to config.js and fill in values
  manifest.json              Extension manifest (gitignored — has your OAuth client ID)
  manifest.example.json      Template — copy to manifest.json
  offscreen.html + .js       Offscreen document: clipboard writes (MV3 requirement)
  popup.html + .js + .css    Popup UI: setup/status, model download, code history
  icon{16,48,128}.png        Extension icons

cloud-function/              # GCP Cloud Function (push relay)
  index.js                   Pub/Sub handler + push subscription registration endpoint
  package.json               Dependencies: @google-cloud/firestore, web-push
  deploy.sh                  One-command setup: APIs, Pub/Sub, Firestore, deploy
  .env.yaml                  VAPID keys (gitignored)
```

## Code detection

Codes are found by **Gemini Nano, Chrome's built-in on-device model** (Prompt API), and only by it. There is no cloud model and nothing to configure.

- **Privacy:** the email text never leaves your machine. The extension reads the message from the Gmail API and the model runs locally, in the extension's service worker. The extension's only hosts are the Gmail API and your own push relay.
- **Requirements:** Chrome 138+, ~22 GB free disk on the drive with your Chrome profile (for the model), 16 GB RAM or a GPU with more than 4 GB VRAM, and macOS 13+, Windows 10+, Linux, or a ChromeOS Chromebook Plus. `chrome://on-device-internals` shows the model's state.
- **Download:** if the model isn't on the machine yet, the popup shows **Download on-device model**. Chrome only starts the download from a click. Until it finishes, code emails stay queued rather than dropped (codes older than 15 minutes are still skipped as expired).
- **Pre-filter:** before the model runs, a cheap subject/body check skips mail that isn't about a code: marketing, receipts, "your email was verified" notices. Most mail never reaches the model, and false copies drop sharply.
- **Grounding:** an answer is copied only if it appears in the email as a whole token, so a hallucinated code or a fragment of a longer link token never reaches the clipboard.
- **Failures:** if the model errors on an email, it's retried once with a fresh session, then skipped so one bad email can't block the queue. If it keeps failing, the extension tells you.

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
./deploy.sh YOUR_PROJECT_ID you@gmail.com
```

The second argument is a comma-separated allow-list of the Gmail accounts that may register for push. `register-push` is publicly reachable, so it verifies each caller's Google token and rejects any other account.

If `.env.yaml` already exists, its VAPID keys are reused. The script refuses to run if the file can't be parsed, rather than silently minting new keys. Pass `--rotate-vapid` as a third argument to deliberately generate new ones (the old file is backed up), then update `VAPID_PUBLIC_KEY` in `config.js` and reload the extension.

This enables all required APIs (Pub/Sub, Cloud Functions, Firestore), creates the Pub/Sub topic, grants Gmail publish access, generates VAPID keys, and deploys two Cloud Functions:

- **gmail-push-handler** (Pub/Sub trigger) — receives Gmail notifications, sends Web Push to extension
- **register-push** (HTTP trigger) — extension calls this, authenticated with its Google token, to register its push subscription (one per device, per account)

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
| `REGISTER_PUSH_URL` | Printed by `deploy.sh` (looks like `https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/register-push`, which must match the `host_permissions` entry) |

**`manifest.json`** — fill in these values:

| Field | Where to get it |
|---|---|
| `oauth2.client_id` | Same Chrome extension OAuth client ID as above |
| `host_permissions` (2nd entry) | Replace `YOUR_PROJECT_ID` with your GCP project ID |

**`.env.yaml`** (in `cloud-function/`) is also gitignored — `deploy.sh` generates this automatically with your VAPID keys.

### 5. Load the extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**, select the `gmail-code-clipper` folder
4. Note the **extension ID** — go back to step 3 and enter it as the Item ID if you haven't

### 6. Start it

1. Click the extension icon in the toolbar
2. If it shows **Download on-device model**, click it and wait for 100% (one time)
3. Click **Set Up Monitoring** (it refuses only when this Chrome or device can't run the on-device model)
4. Sign in with Google when prompted

The extension will set up Gmail `watch()` and register for push notifications. When a login code email arrives, it's automatically copied to your clipboard and the code appears as a badge on the extension icon.

## Self-hosting your own instance

Everything in this repo is designed to run on your own GCP project. Follow steps 1–6 above and you'll have your own fully independent instance — your own OAuth client, your own Cloud Functions, your own Pub/Sub topic. Nothing is shared with anyone else.

The whole setup takes about 15 minutes.
