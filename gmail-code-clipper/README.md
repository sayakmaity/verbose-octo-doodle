# Gmail Code Clipper

Chrome extension that monitors your Gmail for login/verification codes and automatically copies them to your clipboard.

## How it works

1. Gmail `watch()` pushes notifications to Google Cloud Pub/Sub when new emails arrive
2. A Cloud Function relays the notification via Web Push to the Chrome extension
3. The extension reads the email, sends it to Gemini Flash Lite for code extraction
4. If a code is found, it's copied to your clipboard and a notification is shown
5. 3-second polling is used as a fallback if push setup fails

## Extension files

```
gmail-code-clipper/
  manifest.json      Chrome extension manifest (MV3)
  background.js      Service worker: auth, polling/push, Gmail API, Gemini, clipboard
  offscreen.html/js  Offscreen document for clipboard writes (MV3 requirement)
  popup.html/js/css  Extension popup: start/stop, API key config, code history
  icon*.png          Extension icons
```

## Setup

### 1. Google Cloud project

1. Create a GCP project and enable the **Gmail API**
2. Set up the **OAuth consent screen** (APIs & Services > OAuth consent screen)
3. Create an **OAuth client ID** of type "Chrome extension" with your extension's ID
4. Put the client ID in `manifest.json` under `oauth2.client_id`

### 2. Gemini API key

Get one at [Google AI Studio](https://aistudio.google.com/apikey).

### 3. Load the extension

1. Open `chrome://extensions/`, enable Developer mode
2. Click "Load unpacked" and select the `gmail-code-clipper` folder
3. Click the extension icon, paste your Gemini API key, click Save
4. Click "Start Monitoring"

The extension will prompt for Google sign-in on first use. After that, it polls Gmail every 3 seconds (or uses push if configured).

## Push notifications (optional)

Push mode eliminates polling — the extension only wakes up when a new email arrives.

See the `cloud-function/` directory for the Cloud Function that relays Gmail push notifications to the extension via Web Push. Run `deploy.sh` to set up the Pub/Sub topic and deploy the function.

The extension automatically attempts to enable push on "Start Monitoring". If the Cloud Function isn't deployed, it falls back to polling.
