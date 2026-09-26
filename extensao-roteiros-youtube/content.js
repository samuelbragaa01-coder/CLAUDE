// Absorvedor de Roteiros do YouTube — content script
(() => {
  const CARD_SEL = [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-grid-video-renderer',
    'ytd-compact-video-renderer', 'ytd-reel-item-renderer', 'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
  ].join(',');

  let opts = { format: 'separate', timestamps: false, limit: 0 };
  let selecting = false;
  let busy = false;
  const picked = new Map(); // videoId -> card element

  // ---------- utilidades ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function videoIdFromHref(href) {
    if (!href) return null;
    const u = new URL(href, location.origin);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  function extractJson(html, marker) {
    const i = html.indexOf(marker);
    if (i < 0) return null;
    const start = html.indexOf('{', i);
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < html.length; j++) {
      const c = html[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; }
      }
    }
    return null;
  }

  function findAll(obj, key, out = []) {
    if (obj && typeof obj === 'object') {
      for (const k in obj) {
        if (k === key) out.push(obj[k]);
        findAll(obj[k], key, out);
      }
    }
    return out;
  }

  const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join('') ?? t?.content ?? '';

  // Config completa do cliente (ytcfg) extraída do HTML da página
  function ytcfg(html) {
    const src = html || document.documentElement.innerHTML;
    const ctx = extractJson(src, '"INNERTUBE_CONTEXT":');
    const ver = src.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20250101.00.00';
    const key = src.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
    const visitor = src.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || ctx?.client?.visitorData;
    return {
      ver, key, visitor,
      context: ctx || { client: { clientName: 'WEB', clientVersion: ver, hl: document.documentElement.lang || 'pt' } },
    };
  }

  async function innertube(endpoint, body, html) {
    const cfg = ytcfg(html);
    const headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': cfg.ver,
    };
    if (cfg.visitor) headers['X-Goog-Visitor-Id'] = cfg.visitor;
    const r = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false${cfg.key ? '&key=' + cfg.key : ''}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context: cfg.context, ...body }),
    });
    if (!r.ok) throw new Error(`${endpoint} HTTP ${r.status}`);
    return r.json();
  }

  // Lê um arquivo de legenda (json3 ou XML) e devolve segmentos
  async function fetchCaptionTrack(baseUrl, credentials = 'include') {
    const url = baseUrl.replace(/&fmt=[^&]*/, '');
    for (const fmt of ['&fmt=json3', '']) {
      const r = await fetch(url + fmt, { credentials });
      const body = await r.text();
      if (!r.ok || !body.trim()) continue;
      if (body.trim().startsWith('{')) {
        const j = JSON.parse(body);
        const segs = (j.events || []).filter((e) => e.segs)
          .map((e) => ({ ms: e.tStartMs || 0, text: e.segs.map((x) => x.utf8).join('') }));
        if (segs.length) return segs;
      } else {
        const doc = new DOMParser().parseFromString(body, 'text/xml');
        const nodes = [...doc.querySelectorAll('text, p')];
        const segs = nodes.map((n) => ({
          ms: n.hasAttribute('start') ? parseFloat(n.getAttribute('start')) * 1000 : +n.getAttribute('t') || 0,
          text: (n.textContent || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
        }));
        if (segs.length) return segs;
      }
    }
    throw new Error('legenda vazia (YouTube bloqueou o download)');
  }

  const pickTrack = (tracks) => {
    const hl = (document.documentElement.lang || '').slice(0, 2);
    return tracks.find((t) => t.kind !== 'asr') || tracks.find((t) => t.languageCode?.startsWith(hl)) || tracks[0];
  };

  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
  };

  // ---------- transcrição ----------
  async function getTranscript(videoId) {
    const html = await (await fetch(`/watch?v=${videoId}`, { credentials: 'include' })).text();
    const player = extractJson(html, 'ytInitialPlayerResponse =');
    const initial = extractJson(html, 'ytInitialData =');
    const d = player?.videoDetails || {};
    const meta = {
      id: videoId,
      title: d.title || videoId,
      channel: d.author || '',
      published: player?.microformat?.playerMicroformatRenderer?.publishDate || '',
      views: d.viewCount || '',
      duration: d.lengthSeconds ? fmtTime(d.lengthSeconds * 1000) : '',
    };

    let segments = null;
    const errors = [];

    // 1) Painel "Mostrar transcrição" (get_transcript) com o contexto completo da página
    try {
      const params = findAll(initial, 'getTranscriptEndpoint')[0]?.params;
      if (!params) throw new Error('vídeo sem botão de transcrição');
      const data = await innertube('get_transcript', { params }, html);
      const segs = findAll(data, 'transcriptSegmentRenderer');
      if (!segs.length) throw new Error('resposta vazia');
      segments = segs.map((s) => ({ ms: +s.startMs || 0, text: text(s.snippet) }));
    } catch (e) { errors.push('painel: ' + e.message); }

    // 2) Legendas via cliente Android (não exige token do player web)
    if (!segments) {
      try {
        const r = await fetch('/youtubei/v1/player?prettyPrint=false', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'pt' } },
            videoId,
          }),
        });
        const pj = await r.json();
        const tracks = pj?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (!tracks.length) throw new Error('sem faixas de legenda');
        segments = await fetchCaptionTrack(pickTrack(tracks).baseUrl, 'omit');
      } catch (e) { errors.push('android: ' + e.message); }
    }

    // 3) Legendas do player web
    if (!segments) {
      try {
        const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (!tracks.length) throw new Error('sem faixas de legenda');
        segments = await fetchCaptionTrack(pickTrack(tracks).baseUrl);
      } catch (e) { errors.push('web: ' + e.message); }
    }

    // 4) Abre o vídeo numa aba em segundo plano e lê o painel "Mostrar transcrição"
    if (!segments) {
      log('  tentando pela aba do vídeo…');
      const r = await chrome.runtime.sendMessage({ type: 'transcriptViaTab', videoId });
      if (r?.ok) segments = r.segments;
      else errors.push('aba: ' + (r?.error || 'falhou'));
    }

    if (!segments) console.warn('[Roteiros]', videoId, errors);
    if (!segments || !segments.length) throw new Error(errors.join(' | ') || 'sem transcrição');
    segments = segments.map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() })).filter((s) => s.text);
    return { meta, segments };
  }

  function toMarkdown({ meta, segments }, level = 1) {
    const h = '#'.repeat(level);
    let body;
    if (opts.timestamps) {
      body = segments.map((s) => `**[${fmtTime(s.ms)}]** ${s.text}`).join('\n\n');
    } else {
      // junta em parágrafos (~ a cada frase terminada ou 6 segmentos)
      const paras = []; let cur = [];
      for (const s of segments) {
        cur.push(s.text);
        if ((/[.!?…]["”')]?$/.test(s.text) && cur.length >= 3) || cur.length >= 8) { paras.push(cur.join(' ')); cur = []; }
      }
      if (cur.length) paras.push(cur.join(' '));
      body = paras.join('\n\n');
    }
    return [
      `${h} ${meta.title}`, '',
      `- **Canal:** ${meta.channel}`,
      `- **Link:** https://www.youtube.com/watch?v=${meta.id}`,
      meta.published ? `- **Publicado:** ${meta.published}` : null,
      meta.duration ? `- **Duração:** ${meta.duration}` : null,
      meta.views ? `- **Visualizações:** ${Number(meta.views).toLocaleString('pt-BR')}` : null,
      '', `${h}# Roteiro`, '', body, '',
    ].filter((l) => l !== null).join('\n');
  }

  const safe = (s) => s.replace(/[\\/:*?"<>|#\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'roteiro';

  function download(filename, content) {
    return chrome.runtime.sendMessage({ type: 'download', filename, content });
  }

  async function processVideos(ids, folderName) {
    if (busy) return;
    busy = true;
    const folder = safe(folderName || 'Roteiros YouTube');
    const results = [];
    let ok = 0, fail = 0;
    for (let i = 0; i < ids.length; i++) {
      log(`(${i + 1}/${ids.length}) ${ids[i]}…`);
      try {
        const t = await getTranscript(ids[i]);
        ok++;
        if (opts.format === 'separate') {
          await download(`${folder}/${String(i + 1).padStart(3, '0')} - ${safe(t.meta.title)}.md`, toMarkdown(t));
        } else results.push(t);
        log(`✔ ${t.meta.title}`);
      } catch (e) {
        fail++;
        log(`✖ ${ids[i]}: ${e.message}`);
      }
      await sleep(400);
    }
    if (opts.format === 'single' && results.length) {
      const md = `# ${folderName}\n\n${results.length} roteiros\n\n` +
        results.map((r) => toMarkdown(r, 2)).join('\n---\n\n');
      await download(`${folder}.md`, md);
    }
    log(`Concluído: ${ok} salvos, ${fail} sem transcrição.`);
    busy = false;
  }

  // ---------- painel flutuante ----------
  let panel;
  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    panel.id = 'yra-panel';
    panel.innerHTML = `
      <b>🎬 Roteiros v${chrome.runtime.getManifest().version}</b> <span id="yra-count"></span>
      <div class="yra-row" id="yra-sel-row">
        <button class="yra-go" id="yra-save">Baixar selecionados</button>
        <button id="yra-clear">Limpar</button>
      </div>
      <div class="yra-row"><button id="yra-close">Fechar</button></div>
      <div id="yra-log"></div>`;
    document.body.appendChild(panel);
    panel.querySelector('#yra-save').onclick = () => {
      const ids = [...picked.keys()];
      if (!ids.length) return log('Nenhum vídeo selecionado.');
      stopSelecting(false);
      processVideos(ids, `Selecionados - ${channelName()}`);
    };
    panel.querySelector('#yra-clear').onclick = clearPicks;
    panel.querySelector('#yra-close').onclick = () => { stopSelecting(true); panel.remove(); };
    return panel;
  }

  function log(msg) {
    const el = ensurePanel().querySelector('#yra-log');
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function updateCount() {
    const el = panel?.querySelector('#yra-count');
    if (el) el.textContent = selecting ? `— ${picked.size} selecionado(s)` : '';
    panel?.querySelector('#yra-save')?.toggleAttribute('disabled', !picked.size);
    const row = panel?.querySelector('#yra-sel-row');
    if (row) row.style.display = selecting ? 'flex' : 'none';
  }

  // ---------- modo seleção ----------
  function renumber() {
    let n = 1;
    for (const card of picked.values()) {
      card.querySelector(':scope > .yra-badge')?.remove();
      const b = document.createElement('div');
      b.className = 'yra-badge';
      b.textContent = n++;
      card.appendChild(b);
    }
    updateCount();
  }

  function clearPicks() {
    for (const card of picked.values()) {
      card.classList.remove('yra-picked');
      card.querySelector(':scope > .yra-badge')?.remove();
    }
    picked.clear();
    updateCount();
  }

  function onClick(e) {
    if (!selecting || e.target.closest('#yra-panel')) return;
    const card = e.target.closest(CARD_SEL);
    if (!card) return;
    const a = card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    const id = videoIdFromHref(a?.getAttribute('href'));
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (picked.has(id)) {
      picked.get(id).classList.remove('yra-picked');
      picked.get(id).querySelector(':scope > .yra-badge')?.remove();
      picked.delete(id);
    } else {
      if (opts.limit && picked.size >= opts.limit) return log(`Limite de ${opts.limit} atingido.`);
      picked.set(id, card);
      card.classList.add('yra-picked');
    }
    renumber();
  }

  function startSelecting() {
    selecting = true;
    document.documentElement.classList.add('yra-selecting');
    ensurePanel();
    updateCount();
    log('Modo seleção ativo: clique nas thumbs dos vídeos.' + (opts.limit ? ` (máx. ${opts.limit})` : ''));
  }

  function stopSelecting(clear) {
    selecting = false;
    document.documentElement.classList.remove('yra-selecting');
    if (clear) clearPicks();
    updateCount();
  }

  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((t) =>
    window.addEventListener(t, (e) => {
      if (t === 'click') onClick(e);
      else if (selecting && !e.target.closest('#yra-panel') && e.target.closest(CARD_SEL)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }, true));

  // ---------- canal inteiro ----------
  function channelName() {
    return document.querySelector('yt-page-header-renderer h1, #channel-name #text, ytd-channel-name #text')?.textContent?.trim()
      || document.title.replace(/ - YouTube$/, '');
  }

  function channelBase() {
    const m = location.pathname.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/);
    if (m) return '/' + m[1];
    const a = document.querySelector('ytd-video-owner-renderer a[href^="/@"], ytd-video-owner-renderer a[href^="/channel/"]');
    return a ? a.getAttribute('href') : null;
  }

  async function listChannelVideos(base, tab, limit) {
    const html = await (await fetch(`${base}/${tab}`, { credentials: 'include' })).text();
    let data = extractJson(html, 'ytInitialData =');
    const ids = [];
    const collect = (d) => {
      for (const v of findAll(d, 'videoId')) {
        if (typeof v === 'string' && !ids.includes(v)) ids.push(v);
      }
    };
    // pega só o conteúdo da aba selecionada
    const selected = findAll(data, 'tabRenderer').find((t) => t.selected)?.content || data;
    collect(selected);
    let token = findAll(selected, 'continuationCommand')[0]?.token;
    while (token && (!limit || ids.length < limit)) {
      log(`${tab}: ${ids.length} vídeos encontrados…`);
      const next = await innertube('browse', { continuation: token }, html);
      const items = findAll(next, 'continuationItems')[0] || [];
      collect(items);
      token = findAll(items, 'continuationCommand')[0]?.token;
      await sleep(200);
    }
    return ids;
  }

  async function absorb() {
    const base = channelBase();
    if (!base) return log('Abra a página de um canal (ou um vídeo dele) antes de clicar em Absorver.');
    const name = channelName();
    log(`Listando vídeos de ${name}…`);
    let ids = [];
    try {
      ids = await listChannelVideos(base, 'videos', opts.limit);
    } catch (e) { return log('Erro ao listar vídeos: ' + e.message); }
    if (opts.limit) ids = ids.slice(0, opts.limit);
    if (!ids.length) return log('Nenhum vídeo encontrado.');
    log(`${ids.length} vídeos. Extraindo roteiros…`);
    await processVideos(ids, `${name} - Roteiros`);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.opts) opts = msg.opts;
    if (busy) return log('Aguarde o processo atual terminar.');
    if (msg.action === 'absorb') { stopSelecting(true); ensurePanel(); updateCount(); absorb(); }
    if (msg.action === 'select') startSelecting();
  });
})();
