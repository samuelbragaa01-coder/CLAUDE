// Recebe arquivos Markdown do content script e baixa via chrome.downloads.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'download') return;
  const url = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(msg.content);
  chrome.downloads.download(
    { url, filename: msg.filename, conflictAction: 'uniquify', saveAs: false },
    (id) => sendResponse({ ok: !!id, error: chrome.runtime.lastError?.message })
  );
  return true;
});
