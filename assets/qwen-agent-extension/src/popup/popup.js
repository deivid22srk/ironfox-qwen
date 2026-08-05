/* Qwen Agent Studio - Popup script */

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

async function refresh() {
  const r = await bg({ type: 'GET_STATE' });
  if (!r.ok) return;
  const { activeProject, projects } = r.state;
  $('#activeProject').textContent = activeProject || '(none)';
  const sel = $('#projectSelect');
  if (projects.length === 0) {
    sel.innerHTML = '<option value="" disabled>(no projects yet)</option>';
  } else {
    sel.innerHTML = projects
      .map(p => `<option value="${p.name}" ${p.name === activeProject ? 'selected' : ''}>${p.name}</option>`)
      .join('');
  }
  // Check active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('chat.qwen.ai')) {
    $('#tabStatus').textContent = '✓ on Qwen';
    $('#tabStatus').style.color = '#4ADE80';
  } else {
    $('#tabStatus').textContent = 'not on Qwen';
    $('#tabStatus').style.color = '#FBBF24';
  }
}

$('#openQwen').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'https://chat.qwen.ai/' });
  window.close();
});

$('#toggleSidebar').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('chat.qwen.ai')) {
    alert('Open chat.qwen.ai first.');
    return;
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {});
  window.close();
});

$('#newProject').addEventListener('click', async () => {
  const name = prompt('New project name:');
  if (!name) return;
  const r = await bg({ type: 'CREATE_PROJECT', name });
  if (!r.ok) {
    alert('Error: ' + r.error);
    return;
  }
  await refresh();
});

$('#selectBtn').addEventListener('click', async () => {
  const name = $('#projectSelect').value;
  if (!name) return;
  const r = await bg({ type: 'SELECT_PROJECT', name });
  if (!r.ok) {
    alert('Error: ' + r.error);
    return;
  }
  await refresh();
});

$('#exportBtn').addEventListener('click', async () => {
  const r = await bg({ type: 'EXPORT_PROJECT' });
  if (!r.ok) {
    alert('Error: ' + r.error);
    return;
  }
  alert(`Exported ${r.count} files (download started).`);
});

$('#deleteBtn').addEventListener('click', async () => {
  const name = $('#projectSelect').value;
  if (!name) return;
  if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
  const r = await bg({ type: 'DELETE_PROJECT', name });
  if (!r.ok) {
    alert('Error: ' + r.error);
    return;
  }
  await refresh();
});

$('#openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.addEventListener('DOMContentLoaded', refresh);
