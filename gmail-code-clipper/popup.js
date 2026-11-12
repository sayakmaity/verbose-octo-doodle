const setupBtn = document.getElementById('setup-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const historyEl = document.getElementById('history');
const statusNote = document.getElementById('status-note');
const downloadBtn = document.getElementById('download-btn');

// --- Init ---

refreshStatus();

loadHistory();

let lastStatus = {};

function refreshStatus() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      statusDot.className = 'dot warn';
      statusText.textContent = 'Extension busy — reopen popup';
      return;
    }
    lastStatus = response;
    updateUI(response);
  });
}

// --- Setup ---

let btnAction = 'startMonitoring';

setupBtn.addEventListener('click', () => {
  setupBtn.disabled = true;
  const action = btnAction;
  setupBtn.textContent = action === 'checkNow' ? 'Checking...' : 'Setting up...';
  chrome.runtime.sendMessage({ action }, (result) => {
    if (chrome.runtime.lastError || !result) {
      showToast(chrome.runtime.lastError?.message || 'No response — try again');
    } else if (!result.success) {
      showToast(result.error || 'Failed');
    } else if (action === 'checkNow') {
      showToast('Checked');
    }
    refreshStatus();
    loadHistory();
    setupBtn.disabled = false;
  });
});

// Why the on-device model can't run right now, and what to do about it.
function noEngineReason(nano) {
  if (nano === 'downloadable') return "Codes aren't being copied — download the on-device model below.";
  if (nano === 'downloading') return "Codes aren't being copied yet — the on-device model is downloading.";
  if (nano === 'unavailable') return "Codes aren't being copied — this device can't run the on-device model.";
  if (nano === 'unknown') return "Codes aren't being copied — couldn't reach the on-device model. Reopen the popup.";
  return "Codes aren't being copied — this Chrome has no on-device model (needs Chrome 138+).";
}

// Hardware/browser requirements, shown when the model can never run here.
const REQUIREMENTS_NOTE = 'Gemini Nano needs Chrome 138+, ~22 GB free disk, and 16 GB RAM or a GPU with more than 4 GB VRAM. See chrome://on-device-internals.';

function setNote(text) {
  statusNote.textContent = text || '';
  statusNote.hidden = !text;
}

function updateUI({ setupDone, pushActive, needsAuth, pushError, engine, nanoAvailability, nanoFailing }) {
  setupBtn.style.display = '';
  updateDownloadButton(nanoAvailability);
  const cantRun = nanoAvailability === 'unavailable' || nanoAvailability === 'unsupported';
  setNote(cantRun ? REQUIREMENTS_NOTE : '');
  if (needsAuth) {
    // First: nothing else can recover until the Google grant is renewed.
    statusDot.className = 'dot warn';
    statusText.textContent = 'Needs re-authorization';
    btnAction = 'startMonitoring';
    setupBtn.textContent = 'Re-authorize';
  } else if (setupDone && engine === 'none') {
    // No engine: codes are NOT being copied (mail stays queued), even though
    // Gmail monitoring is fine. Never show green here.
    statusDot.className = 'dot warn';
    statusText.textContent = noEngineReason(nanoAvailability);
    btnAction = 'checkNow';
    setupBtn.textContent = 'Check Now';
  } else if (setupDone && nanoFailing) {
    // Nano reports ready but keeps failing: code emails are being skipped.
    statusDot.className = 'dot warn';
    statusText.textContent = "On-device model keeps failing — recent codes weren't copied. Check chrome://on-device-internals or restart Chrome.";
    btnAction = 'checkNow';
    setupBtn.textContent = 'Check Now';
  } else if (setupDone && pushActive) {
    statusDot.className = 'dot on';
    statusText.textContent = 'Active · on-device (Gemini Nano)';
    btnAction = 'checkNow';
    setupBtn.textContent = 'Check Now';
  } else if (setupDone) {
    statusDot.className = 'dot warn';
    statusText.textContent = pushError
      ? `Push degraded — ${pushError} (checking every 30 min meanwhile)`
      : 'Active (push degraded — self-healing)';
    btnAction = 'startMonitoring';
    setupBtn.textContent = 'Retry Setup';
  } else if (engine === 'none') {
    // Not set up AND the model can't detect codes yet: say why, in yellow.
    statusDot.className = 'dot warn';
    statusText.textContent = `Not set up. ${noEngineReason(nanoAvailability)}`;
    btnAction = 'startMonitoring';
    setupBtn.textContent = 'Set Up Monitoring';
  } else {
    statusDot.className = 'dot off';
    statusText.textContent = 'Not set up · will use on-device (Gemini Nano)';
    btnAction = 'startMonitoring';
    setupBtn.textContent = 'Set Up Monitoring';
  }
}

// --- On-device model download ---

// LanguageModel.create() needs user activation to start a download, so it runs
// here, in the click handler, not in the service worker.
let downloading = false;

function updateDownloadButton(nano) {
  if (downloading) return;
  const canDownload = typeof LanguageModel !== 'undefined'
    && (nano === 'downloadable' || nano === 'downloading');
  downloadBtn.hidden = !canDownload;
  downloadBtn.disabled = false;
  // While Chrome is already downloading, a click attaches to it and shows %.
  downloadBtn.textContent = 'Download on-device model';
}

downloadBtn.addEventListener('click', async () => {
  downloading = true;
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Downloading… 0%';
  // The popup closes on blur long before a multi-GB download ends; the
  // background polls and retries the queue once the model is ready.
  chrome.runtime.sendMessage({ action: 'watchNanoDownload' }, () => { void chrome.runtime.lastError; });
  try {
    const session = await LanguageModel.create({
      ...NANO_SESSION_OPTS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          downloadBtn.textContent = `Downloading… ${Math.round(e.loaded * 100)}%`;
        });
      },
    });
    session.destroy();
    showToast('On-device model ready');
  } catch (err) {
    showToast(`Download failed: ${err.message}`);
  } finally {
    downloading = false;
  }
  // Retry anything queued while the model wasn't ready.
  if (lastStatus.setupDone) {
    chrome.runtime.sendMessage({ action: 'checkNow' }, () => {
      void chrome.runtime.lastError;
      refreshStatus();
      loadHistory();
    });
  } else {
    refreshStatus();
  }
});

// --- History ---

function loadHistory() {
  chrome.storage.local.get(['codeHistory'], ({ codeHistory }) => {
    renderHistory(codeHistory || []);
  });
}

// Built with DOM APIs, not innerHTML: code/subject/from are email-controlled
// strings (and older versions stored unfiltered model output), and the old
// escapeHtml didn't escape quotes inside the data-code attribute.
function renderHistory(items) {
  historyEl.replaceChildren();
  if (!items.length) {
    historyEl.append(el('div', 'empty', 'No codes detected yet'));
    return;
  }

  for (const item of items) {
    const code = String(item.code ?? '');
    const rawFrom = String(item.from ?? '');
    const from = rawFrom.replace(/<.*>/, '').trim() || rawFrom;
    const row = el('div', 'history-item');
    row.title = 'Click to copy';
    row.append(el('div', 'code', code), el('div', 'meta', `${from} · ${timeAgo(item.timestamp)}`));
    row.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        showToast('Copied!');
      } catch {
        showToast('Copy failed');
      }
    });
    historyEl.append(row);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'codeDetected') {
    loadHistory();
  }
});

// --- Helpers ---

function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function showToast(text) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1500);
}
