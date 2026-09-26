// Downloads e leitura de transcrição via aba em segundo plano.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'download') {
    const url = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(msg.content);
    chrome.downloads.download(
      { url, filename: msg.filename, conflictAction: 'uniquify', saveAs: false },
      (id) => sendResponse({ ok: !!id, error: chrome.runtime.lastError?.message })
    );
    return true;
  }
  if (msg.type === 'transcriptViaTab') {
    transcriptViaTab(msg.videoId).then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
});

function waitComplete(tabId) {
  return new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
  });
}

async function transcriptViaTab(videoId) {
  const tab = await chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: false });
  try {
    await chrome.tabs.update(tab.id, { muted: true });
    await Promise.race([waitComplete(tab.id), new Promise((r) => setTimeout(r, 20000))]);
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeTranscript });
    if (!res?.result) throw new Error('script não retornou');
    if (res.result.error) throw new Error(res.result.error);
    return res.result;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Roda dentro da aba do vídeo.
async function scrapeTranscript() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => {
    for (let t = 0; t < ms; t += 300) { const v = fn(); if (v) return v; await sleep(300); }
    return null;
  };
  document.querySelector('video')?.pause();

  const segSel = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
  const btn = await until(() =>
    document.querySelector('ytd-video-description-transcript-section-renderer button') ||
    [...document.querySelectorAll('button, yt-button-shape button')].find((b) =>
      /transcri/i.test(b.getAttribute('aria-label') || b.textContent || '')));
  if (!btn) return { error: 'botão "Mostrar transcrição" não encontrado (vídeo sem transcrição?)' };
  document.querySelector('video')?.pause();
  btn.click();

  const first = await until(() => document.querySelector(segSel), 20000);
  if (!first) return { error: 'painel de transcrição não carregou' };
  await sleep(800);

  const segments = [...document.querySelectorAll(segSel)].map((el) => {
    const ts = el.querySelector('.segment-timestamp, [class*="timestamp"]')?.textContent?.trim() || '0:00';
    const txt = el.querySelector('.segment-text, [class*="segment-text"], span[role="text"]')?.textContent
      || el.textContent.replace(ts, '');
    const ms = ts.split(':').reduce((a, n) => a * 60 + (+n || 0), 0) * 1000;
    return { ms, text: txt.trim() };
  }).filter((s) => s.text);
  if (!segments.length) return { error: 'transcrição vazia' };
  return { segments };
}
