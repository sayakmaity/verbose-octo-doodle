// Offscreen document: clipboard writes (execCommand needs a DOM) and, when the
// service worker has no Prompt API, Gemini Nano runs (nano.js, loaded first).
// Every other action (getStatus, codeDetected, ...) is for other listeners:
// return false without answering so their sendResponse isn't pre-empted.
const errorText = (err) => `${err?.name || 'Error'}: ${err?.message || err}`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'clipboard-write') {
    const textarea = document.getElementById('clipboard-area');
    textarea.value = message.text;
    textarea.select();
    const ok = document.execCommand('copy');
    // Never log the code itself: offscreen console logs persist in DevTools.
    console.log('Offscreen clipboard copy:', ok);
    sendResponse({ copied: ok });
    return false;
  }
  if (message.action === 'nano-availability') {
    nanoAvailability()
      .then((availability) => sendResponse({ availability }))
      .catch((err) => sendResponse({ error: errorText(err) }));
    return true; // async sendResponse
  }
  if (message.action === 'nano-detect') {
    // Never log the email or the answer: only the outcome crosses back.
    nanoExtract(
      { from: message.from, subject: message.subject, body: message.body },
      { timeoutMs: message.timeoutMs },
    )
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: errorText(err) }));
    return true; // async sendResponse
  }
  return false;
});
