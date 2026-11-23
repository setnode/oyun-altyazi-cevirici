// Mac uygulaması: eklentinin chrome.* API'lerini yerel uygulamaya bağlar.
// Eklentinin dosyaları (content.js, popup.js, ceviri-ag.js…) hiç değiştirilmeden burada çalışır.
(() => {
  if (window.chrome && window.chrome.__xct) return;
  const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.xct;
  if (!bridge) return;
  const post = (m) => bridge.postMessage(m);
  // Hata ayıklama günlüğü (yalnızca debug dosyası varsa uygulama yazar)
  const logOut = (lvl, args) => { try { post({ op: 'log', lvl, text: args.map((a) => a instanceof Error ? a.stack || String(a) : typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').slice(0, 2000) }); } catch (e) {} };
  for (const lvl of ['log', 'warn', 'error']) { const o = console[lvl].bind(console); console[lvl] = (...a) => { o(...a); logOut(lvl, a); }; }
  // Rol: bg (OCR/çeviri arka planı), host (yakalanan pencerenin katmanı), popup (ayarlar), page (xbox.com)
  const role = window.__xctRole || 'page';
  if (role !== 'page') {
    window.addEventListener('error', (e) => logOut('error', [e.message + ' @' + e.filename + ':' + e.lineno]));
    window.addEventListener('unhandledrejection', (e) => logOut('error', ['unhandled: ' + (e.reason && (e.reason.stack || e.reason))]));
  }

  // ---------- Ağ: Google/DeepL istekleri uygulama üzerinden (CORS yok) ----------
  const realFetch = window.fetch.bind(window);
  function headersObj(h) {
    const o = {};
    if (!h) return o;
    if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach((v, k) => { o[k] = v; }); return o; }
    if (Array.isArray(h)) { for (const [k, v] of h) o[k] = String(v); return o; }
    for (const k of Object.keys(h)) o[k] = String(h[k]);
    return o;
  }
  // Yalnızca çeviri servisleri uygulama üzerinden gider; sitenin kendi istekleri olduğu gibi kalır
  const PROXY = /^https:\/\/(translate\.googleapis\.com|clients5\.google\.com|api(-free)?\.deepl\.com)\//i;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    if (!PROXY.test(url || '')) return realFetch(input, init);
    init = init || {};
    const signal = init.signal;
    return new Promise((resolve, reject) => {
      const abortErr = () => new DOMException('İstek iptal edildi', 'AbortError');
      if (signal && signal.aborted) { reject(abortErr()); return; }
      let done = false;
      const onAbort = () => { if (!done) { done = true; reject(abortErr()); } };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let body = null;
      if (typeof init.body === 'string') body = init.body;
      else if (init.body instanceof URLSearchParams) body = init.body.toString();
      post({ op: 'net', url, method: (init.method || 'GET').toUpperCase(), headers: headersObj(init.headers), body })
        .then((r) => {
          if (done) return;
          done = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          if (!r || r.error) { reject(new TypeError((r && r.error) || 'Ağ hatası')); return; }
          const status = r.status >= 200 && r.status <= 599 ? r.status : 500;
          const nobody = status === 204 || status === 205 || status === 304;
          resolve(new Response(nobody ? null : r.body || '', { status, headers: r.headers || {} }));
        }, (e) => { if (!done) { done = true; reject(new TypeError(String(e))); } });
    });
  };

  // ---------- Depolama (uygulamanın klasöründe kalıcı) ----------
  const changeListeners = [];
  function fire(area, changes) {
    if (!Object.keys(changes).length) return;
    setTimeout(() => changeListeners.forEach((l) => { try { l(changes, area); } catch (e) { console.error(e); } }), 0);
  }
  window.__xctChanged = (area, raw) => {
    const changes = {};
    for (const [k, v] of Object.entries(raw || {})) {
      let nv;
      if (v != null) { try { nv = JSON.parse(v); } catch (e) { continue; } }
      changes[k] = { newValue: nv };
    }
    fire(area, changes);
  };
  function storageArea(name) {
    return {
      get(keys, cb) {
        const p = (async () => {
          let list = null, defs = {};
          if (typeof keys === 'string') list = [keys];
          else if (Array.isArray(keys)) list = keys;
          else if (keys && typeof keys === 'object') { defs = keys; list = Object.keys(keys); }
          const raw = await post({ op: 'get', area: name, keys: list });
          const out = { ...defs };
          for (const [k, v] of Object.entries(raw || {})) { try { out[k] = JSON.parse(v); } catch (e) { /* bozuk kayıt */ } }
          return out;
        })();
        if (typeof cb === 'function') p.then(cb);
        return p;
      },
      set(items, cb) {
        const enc = {}, changes = {};
        for (const [k, v] of Object.entries(items || {})) {
          if (v === undefined) continue;
          enc[k] = JSON.stringify(v);
          changes[k] = { newValue: JSON.parse(enc[k]) };
        }
        const p = post({ op: 'set', area: name, items: enc }).then(() => undefined);
        fire(name, changes);
        if (typeof cb === 'function') p.then(() => cb());
        return p;
      },
      remove(keys, cb) {
        const list = typeof keys === 'string' ? [keys] : keys || [];
        const p = post({ op: 'remove', area: name, keys: list }).then(() => undefined);
        fire(name, Object.fromEntries(list.map((k) => [k, { newValue: undefined }])));
        if (typeof cb === 'function') p.then(() => cb());
        return p;
      },
    };
  }

  // ---------- Mesajlar ----------
  const msgListeners = [];
  window.__xctToContent = (msg) => {
    msgListeners.forEach((l) => { try { l(msg, {}, () => {}); } catch (e) { console.error(e); } });
    return true;
  };
  async function runtimeMessage(msg) {
    if (!msg) return undefined;
    if (msg.target === 'bg' || msg.target === 'offscreen') {
      if (role === 'bg' && window.__xctBg) return window.__xctBg(msg);
      return post({ op: 'toBg', msg });
    }
    return undefined;
  }

  const chromeShim = {
    __xct: true,
    runtime: {
      id: 'mac',
      lastError: undefined,
      getManifest: () => ({ version: window.__xctVersion || '' }),
      getURL: (p) => new URL(String(p).replace(/^\//, ''), 'xct://app/ext/').href,
      sendMessage(msg, cb) {
        const p = runtimeMessage(msg).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        if (typeof cb === 'function') p.then((r) => cb(r));
        return p;
      },
      onMessage: { addListener: (l) => msgListeners.push(l) },
    },
    storage: {
      sync: storageArea('sync'),
      local: storageArea('local'),
      onChanged: { addListener: (l) => changeListeners.push(l) },
    },
    tabs: {
      // Ayar penceresi için "oyun sekmesi" her zaman uygulamanın kendi katmanıdır
      query(q, cb) {
        const tabs = [{ id: 1, url: 'https://www.xbox.com/play', active: true }];
        if (typeof cb === 'function') cb(tabs);
        return Promise.resolve(tabs);
      },
      sendMessage(id, msg) { return post({ op: 'toContent', msg }); },
    },
  };
  Object.defineProperty(window, 'chrome', { value: chromeShim, configurable: true, writable: true });

  if (role === 'popup') {
    // Ayar penceresi kapanınca uygulama gizler (bölge seçerken oyun görünsün)
    window.close = () => { post({ op: 'closeSettings' }); };
  }
})();
