chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'clipboard-write') {
    const textarea = document.getElementById('clipboard-area');
    textarea.value = message.text;
    textarea.select();
    const ok = document.execCommand('copy');
    console.log('Offscreen clipboard copy:', ok, message.text);
    sendResponse({ copied: ok });
  }
});
