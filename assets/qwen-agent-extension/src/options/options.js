/* Qwen Agent Studio - Options script */

function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

const $ = (sel) => document.querySelector(sel);
const DEFAULTS = {
  autoInjectSystemPrompt: true,
  showSidebar: true,
  maxToolCallsPerTurn: 12,
  allowWebFetch: true,
  terminalAllowlist: [
    'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'grep', 'find',
    'sort', 'uniq', 'tree', 'file', 'stat', 'du', 'df', 'env', 'whoami',
    'date', 'cal', 'which', 'type'
  ]
};

function render(settings) {
  $('#autoInject').checked = !!settings.autoInjectSystemPrompt;
  $('#showSidebar').checked = !!settings.showSidebar;
  $('#maxToolCalls').value = settings.maxToolCallsPerTurn;
  $('#allowWebFetch').checked = !!settings.allowWebFetch;
  $('#terminalAllowlist').value = (settings.terminalAllowlist || []).join(', ');
}

async function load() {
  const r = await bg({ type: 'GET_STATE' });
  if (r.ok) {
    render({ ...DEFAULTS, ...r.state.settings });
  } else {
    render(DEFAULTS);
  }
}

function showToast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

$('#save').addEventListener('click', async () => {
  const settings = {
    autoInjectSystemPrompt: $('#autoInject').checked,
    showSidebar: $('#showSidebar').checked,
    maxToolCallsPerTurn: parseInt($('#maxToolCalls').value, 10) || 12,
    allowWebFetch: $('#allowWebFetch').checked,
    terminalAllowlist: $('#terminalAllowlist').value
      .split(',').map(s => s.trim()).filter(Boolean)
  };
  const r = await bg({ type: 'UPDATE_SETTINGS', settings });
  if (r.ok) {
    showToast('Saved');
  } else {
    alert('Error: ' + r.error);
  }
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('Reset settings to defaults?')) return;
  const r = await bg({ type: 'UPDATE_SETTINGS', settings: DEFAULTS });
  if (r.ok) {
    render(DEFAULTS);
    showToast('Reset');
  }
});

document.addEventListener('DOMContentLoaded', load);
