const toggleBtn = document.getElementById('toggle-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const apiKeyInput = document.getElementById('api-key');
const saveKeyBtn = document.getElementById('save-key');
const historyEl = document.getElementById('history');
const accountsEl = document.getElementById('accounts');
const addAccountBtn = document.getElementById('add-account');

let monitoring = false;

// --- Init ---

chrome.storage.local.get(['geminiApiKey'], (stored) => {
  if (stored.geminiApiKey) apiKeyInput.value = stored.geminiApiKey;
});

chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
  if (response) {
    monitoring = response.monitoring;
    updateUI();
    renderAccounts(response.accounts || []);
  }
});

loadHistory();

// --- Toggle monitoring ---

toggleBtn.addEventListener('click', () => {
  const action = monitoring ? 'stopMonitoring' : 'startMonitoring';
  chrome.runtime.sendMessage({ action }, () => {
    monitoring = !monitoring;
    updateUI();
    // Refresh account list after starting
    if (monitoring) {
      setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'getStatus' }, (r) => {
          if (r) renderAccounts(r.accounts || []);
        });
      }, 1000);
    }
  });
});

function updateUI() {
  if (monitoring) {
    statusDot.className = 'dot on';
    statusText.textContent = 'Monitoring';
    toggleBtn.textContent = 'Stop';
    toggleBtn.classList.add('active');
  } else {
    statusDot.className = 'dot off';
    statusText.textContent = 'Stopped';
    toggleBtn.textContent = 'Start Monitoring';
    toggleBtn.classList.remove('active');
  }
}

// --- Save API Key ---

saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  chrome.storage.local.set({ geminiApiKey: key }, () => {
    showToast('API key saved');
  });
});

// --- Accounts ---

addAccountBtn.addEventListener('click', () => {
  addAccountBtn.disabled = true;
  addAccountBtn.textContent = 'Signing in...';
  chrome.runtime.sendMessage({ action: 'addAccount' }, (response) => {
    addAccountBtn.disabled = false;
    addAccountBtn.textContent = '+ Add Account';
    if (response?.error) {
      showToast('Error: ' + response.error);
      return;
    }
    if (response?.email) {
      showToast('Added ' + response.email);
      chrome.runtime.sendMessage({ action: 'getStatus' }, (r) => {
        if (r) renderAccounts(r.accounts || []);
      });
    }
  });
});

function renderAccounts(emails) {
  if (!emails.length) {
    accountsEl.innerHTML = '<div class="empty">No accounts — click Start Monitoring to add one</div>';
    return;
  }
  accountsEl.innerHTML = emails
    .map(
      (email) => `
      <div class="account-item">
        <span class="account-email">${escapeHtml(email)}</span>
        <button class="btn-remove" data-email="${escapeHtml(email)}" title="Remove">&times;</button>
      </div>`
    )
    .join('');

  accountsEl.querySelectorAll('.btn-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const email = btn.dataset.email;
      chrome.runtime.sendMessage({ action: 'removeAccount', email }, () => {
        showToast('Removed ' + email);
        chrome.runtime.sendMessage({ action: 'getStatus' }, (r) => {
          if (r) renderAccounts(r.accounts || []);
        });
      });
    });
  });
}

// --- History ---

function loadHistory() {
  chrome.storage.local.get(['codeHistory'], ({ codeHistory }) => {
    renderHistory(codeHistory || []);
  });
}

function renderHistory(items) {
  if (!items.length) {
    historyEl.innerHTML = '<div class="empty">No codes detected yet</div>';
    return;
  }

  historyEl.innerHTML = items
    .map((item) => {
      const ago = timeAgo(item.timestamp);
      const from = item.from.replace(/<.*>/, '').trim() || item.from;
      const acct = item.email ? ` · ${item.email}` : '';
      return `
        <div class="history-item" data-code="${escapeHtml(item.code)}" title="Click to copy">
          <div class="code">${escapeHtml(item.code)}</div>
          <div class="meta">${escapeHtml(from)}${escapeHtml(acct)} · ${ago}</div>
        </div>`;
    })
    .join('');

  historyEl.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(el.dataset.code);
      showToast('Copied!');
    });
  });
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
