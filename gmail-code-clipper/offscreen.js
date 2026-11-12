// Offscreen document: clipboard writes (execCommand needs a DOM). Every other
// action (getStatus, codeDetected, ...) is for other listeners: return false
// without answering so their sendResponse isn't pre-empted.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'clipboard-write') {
    const textarea = document.getElementById('clipboard-area');
    textarea.value = message.text;
    textarea.select();
    const ok = document.execCommand('copy');
    // Never log the code itself: offscreen console logs persist in DevTools.
    console.log('Offscreen clipboard copy:', ok);
    sendResponse({ copied: ok });
  }
  return false;
});
