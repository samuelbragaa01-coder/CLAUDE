const $ = (s) => document.querySelector(s);
const status = (t) => ($('#status').textContent = t);

function options() {
  return {
    format: document.querySelector('input[name=fmt]:checked').value,
    timestamps: $('#timestamps').checked,
    limit: Math.max(0, parseInt($('#limit').value, 10) || 0),
  };
}

chrome.storage.local.get('opts', ({ opts }) => {
  if (!opts) return;
  document.querySelector(`input[name=fmt][value=${opts.format}]`).checked = true;
  $('#timestamps').checked = opts.timestamps;
  $('#limit').value = opts.limit;
});

async function send(action) {
  const opts = options();
  chrome.storage.local.set({ opts });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://www.youtube.com/')) return status('Abra uma página do YouTube primeiro.');
  try {
    await chrome.tabs.sendMessage(tab.id, { action, opts });
    window.close();
  } catch {
    status('Recarregue a página do YouTube (F5) e tente de novo.');
  }
}

$('#absorb').onclick = () => send('absorb');
$('#start').onclick = () => send('select');
