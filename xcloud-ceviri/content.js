// xCloud Altyazı Çevirici — sayfa betiği.
// Oyun videosunun altyazı bölgesini okur (OCR), çevirir ve sinema altyazısı gibi gösterir.
(() => {
  if (window.__xctLoaded) return;
  window.__xctLoaded = true;

  const SETTINGS_VERSION = 6;
  const DEFAULTS = {
    v: SETTINGS_VERSION,
    enabled: false,
    engine: 'auto',      // auto | builtin | google
    from: 'en',
    to: 'tr',
    overlay: 'above',    // above: İngilizcenin üstünde (sabit), below: altında, game: İngilizce silinir, replace: koyu kutu
    style: 'cinema',     // cinema: çerçeveli yazı, box: yarı saydam şerit
    fontSize: 30,        // 720p videoya göre piksel; video büyüdükçe orantılı büyür
    offsetY: 0,          // dikey ince ayar (720p'ye göre piksel; artı = yukarı)
    textMode: 'bright',  // bright: açık renkli altyazı, auto: her renk
    threshold: 175,
    interval: 100,
    region: { x: 0.12, y: 0.8, w: 0.76, h: 0.19 },
    msgOn: true,         // sağ alttaki telefon mesajı kutusunu da çevir (sarı, kutunun üstünde)
    hintOn: true,        // sol üstteki ipucu/bildirim kutusunu da çevir (kutunun hemen altında)
    cardOn: true,        // harita/menü bilgi kartını da çevir ("BIFF'S GUN SUPPLY / Ammu-Nation distributor…")
  };
  let S = { ...DEFAULTS };

  // Eski sürüm ayarlarını yeniye taşı
  function migrate(stored) {
    const s = { ...DEFAULTS, ...stored };
    if (!stored.v || stored.v < SETTINGS_VERSION) {
      if (!stored.v || stored.v < 2) {
        s.overlay = stored.overlay === 'cover' ? 'replace' : 'above';
        s.style = 'cinema';
        s.fontSize = 30;
        s.interval = 100;
      }
      // 1.5.4: İngilizce silinmez; çeviri sabit konumda, İngilizcenin üstünde durur
      if (stored.v < 4 && s.overlay === 'game') { s.overlay = 'above'; s.style = 'cinema'; }
      // 1.6.0: yeni altyazı daha çabuk fark edilsin (eski varsayılan 150 ms)
      if (stored.v < 5 && (stored.interval == null || stored.interval >= 120)) s.interval = 100;
      // 1.6.1: ayar penceresi her kayıtta sürümü 5 yazıyordu, eski yavaş tarama aralıkları (ör. 300 ms) taşınmamıştı
      if (stored.v < 6 && s.interval >= 120) s.interval = 100;
      s.v = SETTINGS_VERSION;
      try { chrome.storage.sync.set({ v: s.v, overlay: s.overlay, style: s.style, fontSize: s.fontSize, interval: s.interval }); } catch (e) {}
    }
    if (!['game', 'above', 'below', 'replace'].includes(s.overlay)) s.overlay = 'above';
    return s;
  }

  // ---------- Eklenti ile haberleşme ----------
  // Eklenti yeniden yüklenince eski sayfa betiği "yetim" kalır; bunu fark edip temizce dururuz
  let orphaned = false;
  const alive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };

  function send(msg) {
    return new Promise((resolve) => {
      if (!alive()) { orphan(); resolve({ ok: false, error: 'Eklenti güncellendi — sayfayı yenileyin' }); return; }
      const limit = msg.type === 'warmup' ? 30000 : 10000; // ilk OCR yüklemesine pay
      const timer = setTimeout(() => resolve({ ok: false, error: 'İstek zaman aşımına uğradı' }), limit);
      try {
        chrome.runtime.sendMessage({ target: 'bg', ...msg }, (r) => {
          clearTimeout(timer);
          void chrome.runtime.lastError;
          resolve(r || { ok: false, error: 'Eklenti yanıt vermedi' });
        });
      } catch (e) {
        clearTimeout(timer);
        orphan();
        resolve({ ok: false, error: 'Eklenti güncellendi — sayfayı yenileyin' });
      }
    });
  }

  // OCR isteği doğrudan offscreen belgeye (servis çalışanına uğramadan: görüntü bir kez taşınır).
  // Offscreen belge henüz yoksa servis çalışanı üzerinden gider, o da belgeyi oluşturur.
  let directOcr = true;
  function ocrImage(image) { return direct({ type: 'ocr', image }); }
  // Offscreen belgeye doğrudan istek (OCR, çeviri): servis çalışanı uyuyorsa uyandırmayı beklemez.
  // Belge yoksa servis çalışanı üzerinden gider (o da belgeyi oluşturur).
  function direct(msg, limit = 10000) {
    if (!directOcr) return send(msg);
    return new Promise((resolve) => {
      let done = false;
      const fallback = () => { if (done) return; done = true; send(msg).then(resolve); };
      const timer = setTimeout(fallback, limit);
      try {
        chrome.runtime.sendMessage({ target: 'offscreen', ...msg }, (r) => {
          clearTimeout(timer);
          void chrome.runtime.lastError;
          if (done) return;
          if (r) { done = true; resolve(r); } else fallback(); // belge yok → servis çalışanı oluşturur
        });
      } catch (e) { clearTimeout(timer); fallback(); }
    });
  }

  // Hata ayıklama: sayfada localStorage.xctDebug = '1' ise her altyazının adım süreleri kaydedilir
  // (host öğesinin data-xct-log özniteliğinde son 40 kayıt). Normalde kapalıdır.
  let debugOn = false;
  try { debugOn = localStorage.getItem('xctDebug') === '1'; } catch (e) {}
  const debugLog = [];
  function dbg(entry) {
    if (!debugOn) return;
    entry.vt = currentVideo ? +currentVideo.currentTime.toFixed(2) : 0;
    debugLog.push(entry);
    if (debugLog.length > 60) debugLog.shift();
    try { host.dataset.xctLog = JSON.stringify(debugLog); } catch (e) {}
  }
  // Tanı modunda: başka sekmenin (oyun) son telefon okumasını bu sayfaya da koy (data-xct-phone)
  if (debugOn) {
    try {
      const put = (v) => { try { host.dataset.xctPhone = JSON.stringify(v || null); } catch (e) {} };
      chrome.storage.local.get('xctPhoneDbg', (r) => put(r && r.xctPhoneDbg));
      chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.xctPhoneDbg) put(c.xctPhoneDbg.newValue); });
    } catch (e) { /* sessiz */ }
  }

  // ---------- Arayüz (Shadow DOM: sitenin CSS'i karışmaz) ----------
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;' +
    'border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;color-scheme:normal;';
  // Popover "top layer"a çıkar: oynatıcının kendi katmanları bizi örtemez
  const canPopover = typeof host.showPopover === 'function';
  if (canPopover) host.setAttribute('popover', 'manual');
  const shadow = host.attachShadow({ mode: 'open' });
  // Not: innerHTML kullanılmıyor — Trusted Types zorunlu sitelerde de sorunsuz çalışsın
  const styleEl = document.createElement('style');
  styleEl.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .ui { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
      /* Sağ üstte; oyun sırasında tamamen gizli, fare sağ üst köşeye gidince belirir */
      #panel { position: fixed; top: 10px; right: 10px; display: flex; flex-direction: row-reverse; gap: 6px;
        align-items: center; opacity: 0; pointer-events: none; transform: translateY(-6px);
        transition: opacity .2s ease, transform .2s ease; }
      #panel.show { opacity: 1; pointer-events: auto; transform: none; }
      button { all: unset; cursor: pointer; background: rgba(16,16,16,.85); color: #fff; font-size: 12px;
        font-weight: 600; padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,.18); }
      button.on { background: #107c10; border-color: #2fbf2f; }
      button:focus-visible { outline: 2px solid #9bf09b; }
      #status { color: #fff; font-size: 11px; background: rgba(0,0,0,.6); padding: 4px 8px; border-radius: 6px;
        max-width: 360px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #status:empty { display: none; }
      #frame { position: fixed; border: 2px dashed #2fbf2f; border-radius: 4px; display: none; }

      /* ---- Altyazı ---- */
      #sub { position: fixed; display: block; text-align: center; opacity: 0; visibility: hidden;
        transition: opacity .12s ease, visibility 0s linear .12s; }
      #sub.show { opacity: 1; visibility: visible; transition: opacity .06s ease; }
      #subText { color: #fff; font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
        font-weight: 700; line-height: 1.28; letter-spacing: .005em; white-space: pre-line;
        overflow-wrap: break-word; text-wrap: balance; }
      /* Sinema: siyah çerçeve + yumuşak gölge, arka plan yok */
      #sub.cinema #subText { -webkit-text-stroke: .11em rgba(0,0,0,.9); paint-order: stroke fill;
        text-shadow: 0 0 .06em #000, 0 .05em .14em rgba(0,0,0,.85), 0 0 .5em rgba(0,0,0,.35); }
      /* Şerit: her satırın arkasında yarı saydam bant (YouTube tarzı) */
      #sub.box #subText { background: rgba(8,8,8,.72); padding: .08em .45em; border-radius: .2em;
        -webkit-box-decoration-break: clone; box-decoration-break: clone; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
      /* Yerine: İngilizceyi tamamen örten koyu alan */
      #sub.replace { display: flex; align-items: center; justify-content: center;
        background: #0b0b0b; border-radius: 8px; padding: .2em .6em; }
      #sub.replace:not(.show) { display: flex; }

      /* Oyundaki gibi: İngilizce yazı videodan silinir, Türkçesi aynı yere aynı boyda yazılır */
      #game { position: fixed; inset: 0; display: none; }
      #game.show { display: block; }
      #patch { position: fixed; display: block; }
      .gline { position: fixed; display: block; text-align: center; color: #fff; white-space: pre-line;
        font-family: "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif; font-weight: 500; line-height: 1.24;
        letter-spacing: .003em; overflow-wrap: break-word; text-wrap: balance;
        text-shadow: 0 0 .07em rgba(0,0,0,.95), 0 .03em .1em rgba(0,0,0,.9), 0 0 .3em rgba(0,0,0,.45); }
      .gline.bold { font-weight: 700; }
      /* Görev hedefi ("Follow Moses") diyalogdan ayrı renkte */
      #subText .obj, .gline.obj { color: #ff7ac8; }
      #subText .obj.alt, .gline.obj.alt { color: #ffd75e; }
      /* Telefon mesajı (sağ alt kutu): sarı, kutunun hemen üstünde, altyazıdan ayrı */
      #msg { position: fixed; display: block; opacity: 0; visibility: hidden; text-align: left; color: #ffd75e;
        font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif; font-weight: 700; line-height: 1.25;
        background: rgba(8,8,8,.72); padding: .3em .55em; border-radius: .35em; white-space: pre-line; overflow-wrap: break-word;
        text-shadow: 0 1px 2px rgba(0,0,0,.8); transition: opacity .12s ease, visibility 0s linear .12s; }
      #msg.show { opacity: 1; visibility: visible; transition: opacity .06s ease; }
      #msg b { color: #fff; font-weight: 700; }
      /* Sol üstteki ipucu kutusunun çevirisi: kutunun hemen altında, beyaz */
      #hintTr { position: fixed; display: block; opacity: 0; visibility: hidden; text-align: left; color: #fff;
        font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif; font-weight: 600; line-height: 1.25;
        background: rgba(8,8,8,.78); padding: .3em .55em; border-radius: .3em; white-space: pre-line; overflow-wrap: break-word;
        border-left: 3px solid #ffd75e; text-shadow: 0 1px 2px rgba(0,0,0,.8); transition: opacity .12s ease, visibility 0s linear .12s; }
      #hintTr.show { opacity: 1; visibility: visible; transition: opacity .06s ease; }
      /* Harita/menü bilgi kartının çevirisi: kartın hemen altında (yer yoksa üstünde), kart genişliğinde */
      #cardTr { position: fixed; display: block; opacity: 0; visibility: hidden; text-align: left; color: #fff; box-sizing: border-box;
        font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif; font-weight: 600; line-height: 1.28;
        background: rgba(8,8,8,.84); padding: .45em .7em; border-radius: .3em; overflow-wrap: break-word;
        border-left: 3px solid #ffd75e; text-shadow: 0 1px 2px rgba(0,0,0,.8); transition: opacity .12s ease, visibility 0s linear .12s; }
      #cardTr.show { opacity: 1; visibility: visible; transition: opacity .06s ease; }
      #cardTr .c-title { font-weight: 800; letter-spacing: .02em; margin-bottom: .2em; }
      #cardTr .c-body { color: #ffd75e; }
      #cardTr .c-row { margin-top: .25em; font-size: .9em; opacity: .9; }
      /* Elde tutulan telefon ekranının çevirisi: telefonun solunda, sohbet düzeninde */
      #phone { position: fixed; display: flex; flex-direction: column; justify-content: flex-end; gap: .4em;
        opacity: 0; visibility: hidden; overflow: hidden; box-sizing: border-box;
        font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif; font-weight: 600; line-height: 1.28;
        background: rgba(10,10,12,.80); padding: .65em .75em .75em; border-radius: .9em;
        box-shadow: 0 .3em 1.2em rgba(0,0,0,.35); transition: opacity .12s ease, visibility 0s linear .12s; }
      #phone.show { opacity: 1; visibility: visible; transition: opacity .08s ease; }
      #phone .ph-head { color: #fff; font-weight: 700; font-size: 1.05em; padding-bottom: .35em; margin-bottom: .1em;
        border-bottom: 1px solid rgba(255,255,255,.14); flex: 0 0 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #phone .ph-list { display: flex; flex-direction: column; gap: .4em; min-height: 0; overflow: hidden; justify-content: flex-end; }
      #phone .ph-b { max-width: 88%; padding: .35em .6em; border-radius: .8em; overflow-wrap: break-word; flex: 0 0 auto; }
      #phone .ph-in { align-self: flex-start; color: #ffd75e; background: rgba(255,255,255,.08); border-bottom-left-radius: .25em; }
      #phone .ph-b b { color: #fff; font-weight: 700; }
      #phone .ph-out { align-self: flex-end; color: #dbe7ff; background: rgba(90,130,255,.28); border-bottom-right-radius: .25em; }

      #select { position: fixed; display: none; pointer-events: auto; cursor: crosshair; background: rgba(0,0,0,.35); }
      #rect { position: absolute; border: 2px solid #2fbf2f; background: rgba(47,191,47,.15); display: none; }
      #hint { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); color: #fff; font-size: 14px;
        background: rgba(0,0,0,.8); padding: 8px 14px; border-radius: 6px; white-space: nowrap; }
  `;
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    for (const k of kids) e.append(k);
    return e;
  }
  shadow.append(
    styleEl,
    el('div', { id: 'panel', class: 'ui' },
      el('button', { id: 'toggle', title: 'Çeviriyi aç/kapat (Alt+T)' }, 'ÇEVİRİ: KAPALI'),
      el('button', { id: 'regionBtn', title: 'Altyazı bölgesini seç (Alt+R)' }, 'Bölge seç'),
      el('span', { id: 'status' })),
    el('div', { id: 'frame' }),
    el('div', { id: 'sub', class: 'cinema' }, el('span', { id: 'subText' })),
    el('div', { id: 'msg' }),
    el('div', { id: 'hintTr' }),
    el('div', { id: 'cardTr' }),
    el('div', { id: 'phone' }),
    el('div', { id: 'game' }, el('canvas', { id: 'patch' })),
    el('div', { id: 'select', class: 'ui' },
      el('div', { id: 'rect' }),
      el('div', { id: 'hint' }, 'Sadece İngilizce altyazının çıktığı alanı çiz · Esc: iptal')),
  );
  const $ = (id) => shadow.getElementById(id);
  const ui = {
    panel: $('panel'), toggle: $('toggle'), regionBtn: $('regionBtn'), status: $('status'),
    frame: $('frame'), sub: $('sub'), subText: $('subText'), select: $('select'), rect: $('rect'),
    game: $('game'), patch: $('patch'), msg: $('msg'), phone: $('phone'), hint: $('hintTr'), card: $('cardTr'),
  };

  let mounted = false;
  function mount() {
    // Arayüzü sadece oyun videosu olan çerçevede göster
    if (!mounted && !document.querySelector('video')) return;
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.body || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    if (!mounted) {
      mounted = true;
      send({ type: 'hello' });
    }
    if (canPopover) {
      try { if (!host.matches(':popover-open')) host.showPopover(); } catch (e) { /* z-index yeterli */ }
    }
  }
  document.addEventListener('fullscreenchange', () => {
    if (canPopover && host.matches(':popover-open')) { try { host.hidePopover(); } catch (e) {} }
    mount(); layout();
  });
  mount();

  // ---------- Paneli gizle / göster ----------
  let hideTimer = null;
  let overPanel = false;
  function reveal(ms) {
    ui.panel.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!overPanel) ui.panel.classList.remove('show'); }, ms);
  }
  ui.panel.addEventListener('mouseenter', () => { overPanel = true; reveal(2500); });
  ui.panel.addEventListener('mouseleave', () => { overPanel = false; reveal(1200); });
  document.addEventListener('mousemove', (e) => {
    if (e.clientX > window.innerWidth - 260 && e.clientY < 90) reveal(2500);
  }, { capture: true, passive: true });

  let statusTimer = null;
  let lastStatus = '';
  function status(text, sticky) {
    text = text || '';
    if (text === lastStatus && sticky) return; // aynı mesajla paneli tekrar tekrar açma
    lastStatus = text;
    ui.status.textContent = text;
    clearTimeout(statusTimer);
    if (text) reveal(sticky ? 6000 : 3000);
    if (text && !sticky) statusTimer = setTimeout(() => { ui.status.textContent = ''; lastStatus = ''; }, 4000);
  }

  function renderToggle() {
    ui.toggle.textContent = S.enabled ? 'ÇEVİRİ: AÇIK' : 'ÇEVİRİ: KAPALI';
    ui.toggle.classList.toggle('on', S.enabled);
  }

  function orphan() {
    if (orphaned) return;
    orphaned = true;
    clearInterval(loop);
    hideSubtitle(true);
    S.enabled = false;
    renderToggle();
    status('Eklenti güncellendi — sayfayı yenileyin (⌘R / F5)', true);
  }

  // ---------- Video ve bölge hesapları ----------
  function findVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (!v.videoWidth || v.readyState < 2) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  // Videonun ekranda gerçekten görüntü olan kısmı (siyah şeritler hariç)
  function contentRect(v) {
    const r = v.getBoundingClientRect();
    const fit = getComputedStyle(v).objectFit;
    if (fit === 'fill' || !v.videoWidth) return { left: r.left, top: r.top, width: r.width, height: r.height };
    const vr = v.videoWidth / v.videoHeight, er = r.width / r.height;
    const coverMode = fit === 'cover';
    let w, h;
    if ((er > vr) !== coverMode) { h = r.height; w = h * vr; } else { w = r.width; h = w / vr; }
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
  }

  function regionScreenRect(c) {
    const g = S.region;
    return { left: c.left + g.x * c.width, top: c.top + g.y * c.height, width: g.w * c.width, height: g.h * c.height };
  }

  function regionVideoRect(v) {
    const g = S.region, vw = v.videoWidth, vh = v.videoHeight;
    const sx = Math.max(0, Math.round(g.x * vw)), sy = Math.max(0, Math.round(g.y * vh));
    return {
      sx, sy,
      sw: Math.max(8, Math.min(vw - sx, Math.round(g.w * vw))),
      sh: Math.max(8, Math.min(vh - sy, Math.round(g.h * vh))),
    };
  }

  let currentVideo = null;
  let frameFlashUntil = 0;

  function place(el, r) {
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.width = r.width + 'px';
    el.style.height = r.height + 'px';
  }

  // ---------- Altyazı yerleşimi ----------
  function layoutSub(c, rr) {
    const sub = ui.sub;
    const mode = S.overlay;
    const fontPx = Math.round(Math.min(64, Math.max(14, (S.fontSize * c.height) / 720)));
    sub.classList.toggle('cinema', S.style !== 'box' && mode !== 'replace');
    sub.classList.toggle('box', S.style === 'box' && mode !== 'replace');
    sub.classList.toggle('replace', mode === 'replace');
    sub.style.fontSize = fontPx + 'px';
    sub.style.top = sub.style.bottom = sub.style.height = sub.style.minHeight = '';

    if (mode === 'replace') {
      place(sub, rr);
      sub.style.height = '';
      sub.style.minHeight = rr.height + 'px';
      sub.style.top = '';
      sub.style.bottom = (window.innerHeight - (rr.top + rr.height)) + 'px';
      return;
    }

    // Okunaklı satır genişliği: bölge kadar, en az videonun %55'i, en çok %88'i; videonun içinde kalsın
    const width = Math.min(c.width * 0.88, Math.max(rr.width, c.width * 0.55));
    const center = rr.left + rr.width / 2;
    const left = Math.min(Math.max(center - width / 2, c.left), c.left + c.width - width);
    sub.style.left = left + 'px';
    sub.style.width = width + 'px';
    // İngilizcenin üstünde: aralarında yarım satır kadar boşluk (iki altyazı birbirine yapışık durmasın)
    const gap = Math.round(fontPx * (mode === 'below' ? 0.15 : 0.6));
    const below = mode === 'below' && rr.top + rr.height + fontPx * 2.8 < c.top + c.height;
    if (below) sub.style.top = (rr.top + rr.height + gap) + 'px';
    else {
      // Sabit konum: Türkçe her zaman aynı yükseklikte durur (İngilizcenin olağan üst kenarının
      // hemen üstü). İngilizce iki satıra çıkıp bu konuma taşarsa yalnızca o kadar yukarı kayar.
      const fr = anchorFrac();
      const textTop = rr.top + fr * rr.height;
      const nudge = Math.round(((S.offsetY || 0) * c.height) / 720);
      sub.style.bottom = Math.round(window.innerHeight - textTop + gap + nudge) + 'px';
    }
  }

  // ---------- Sabit konum ----------
  // Çeviri hep aynı yerde durur: ilk altyazıda, İngilizcenin iki satıra çıktığı duruma da yetecek
  // yükseklikte bir konum seçilir ve bölgeyle birlikte kaydedilir (sayfa yenilense de aynı yer).
  // Satırdan satıra hiç kaymaz; yalnızca İngilizce bu konumun da üstüne çıkarsa (3 satır gibi)
  // bir kez yukarı alınır ve orada kalır.
  const ANCHOR_KEY = 'xctSabitKonum';
  let anchor = null;          // bölge içinde 0–1 (Türkçenin alt kenarı buraya oturur)
  let anchorRegion = '';
  const regionKey = () => JSON.stringify(S.region);
  function loadAnchor() {
    anchorRegion = regionKey(); anchor = null;
    try {
      chrome.storage.local.get(ANCHOR_KEY, (o) => {
        const m = (o && o[ANCHOR_KEY]) || {};
        if (anchorRegion === regionKey() && typeof m[anchorRegion] === 'number') { anchor = m[anchorRegion]; layout(); }
      });
    } catch (e) {}
  }
  function saveAnchor() {
    try {
      chrome.storage.local.get(ANCHOR_KEY, (o) => {
        const m = (o && o[ANCHOR_KEY]) || {};
        m[anchorRegion] = anchor;
        chrome.storage.local.set({ [ANCHOR_KEY]: m });
      });
    } catch (e) {}
  }
  function noteTextTop(fr, lineFrac) {
    if (!(fr >= 0 && fr <= 1)) return;
    if (anchorRegion !== regionKey()) loadAnchor();
    const lf = Math.min(0.5, Math.max(0.08, lineFrac || 0.2));
    if (anchor == null) { anchor = Math.max(0, fr - lf); saveAnchor(); }          // iki satıra yer
    else if (fr < anchor - 0.03) { anchor = Math.max(0, fr); saveAnchor(); }       // nadiren: daha da yukarı
  }
  function anchorFrac() {
    if (anchorRegion !== regionKey()) loadAnchor();
    return anchor != null ? anchor : Math.min(Math.max(textTopFrac || 0, 0), 0.9);
  }
  loadAnchor();

  function layout() {
    const v = currentVideo && currentVideo.isConnected ? currentVideo : findVideo();
    currentVideo = v;
    if (!v) { ui.frame.style.display = 'none'; hideSubtitle(true); return; }
    const c = contentRect(v);
    const rr = regionScreenRect(c);
    if (Date.now() < frameFlashUntil) { place(ui.frame, rr); ui.frame.style.display = 'block'; }
    else ui.frame.style.display = 'none';
    layoutSub(c, rr);
    gameLayout();
    msgLayout(v, c);
    hintLayout(v, c);
    cardLayout(v, c);
    phoneLayout(v, c);
  }
  window.addEventListener('resize', layout);

  // ---------- Altyazıyı göster / gizle ----------
  let textTopFrac = 0;   // İngilizce yazının bölge içindeki üst kenarı (0–1)
  let shownText = '';
  let shownAt = 0;
  let hideLater = null;
  const MIN_SHOW_MS = 800;

  function showSubtitle(t, blocks, obj) {
    clearTimeout(hideLater); hideLater = null;
    shownText = t;
    shownAt = performance.now();
    const parts = t.split('\n');
    if (!obj || obj.length !== parts.length) obj = null;
    if (S.overlay === 'game' && blocks && blocks.geom && blocks.length === parts.length && blocks.every(Boolean)) {
      ui.sub.classList.remove('show');
      gameShow(parts, blocks, obj);
      return;
    }
    gameHide();
    if (obj && obj.some(Boolean)) {
      ui.subText.textContent = '';
      parts.forEach((p, i) => {
        if (i) ui.subText.append('\n');
        if (obj[i]) { const sp = document.createElement('span'); sp.className = obj[i] === 'y' ? 'obj alt' : 'obj'; sp.textContent = p; ui.subText.append(sp); }
        else ui.subText.append(p);
      });
    } else ui.subText.textContent = t;
    layout();
    ui.sub.classList.add('show');
  }

  function hideSubtitle(now) {
    clearTimeout(hideLater); hideLater = null;
    if (!shownText) return;
    const wait = now ? 0 : Math.max(0, MIN_SHOW_MS - (performance.now() - shownAt));
    const doHide = () => { shownText = ''; ui.sub.classList.remove('show'); gameHide(); };
    if (wait === 0) doHide(); else hideLater = setTimeout(doHide, wait);
  }

  // ---------- Oyundaki gibi görünüm ----------
  // İngilizce yazının bulunduğu yer videonun her karesinde çevresindeki renklerle doldurulur
  // (yazı "silinir"), Türkçesi de tam o noktaya, oyunun yazısıyla aynı boyda ve gölgeyle yazılır.
  let game = null;   // { items: [{ el, box }], geom, raf, last }
  const patchCtx = ui.patch.getContext('2d');
  const workCanvas = document.createElement('canvas');
  const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

  // OCR görüntüsündeki konum → video pikseli
  const toVideo = (g, x, y) => ({ x: g.sx + (x - g.pad) / g.scale, y: g.sy + (y - g.pad) / g.scale });

  function gameShow(parts, blocks, obj) {
    gameHide(true);
    const items = parts.map((text, i) => {
      const e = el('div', { class: obj && obj[i] ? (obj[i] === 'y' ? 'gline obj alt' : 'gline obj') : 'gline' });
      e.textContent = text;
      ui.game.append(e);
      return { el: e, box: blocks[i] };
    });
    game = { items, geom: blocks.geom, raf: 0, last: 0, boldDone: false };
    ui.game.classList.add('show');
    gameLayout();
    gamePatch();
    const loopFn = (ts) => {
      if (!game) return;
      // ~30 kare/sn yeter; video duruyorsa son kare kalsın
      if (ts - game.last > 30 && currentVideo && !currentVideo.paused) { game.last = ts; gamePatch(); }
      game.raf = requestAnimationFrame(loopFn);
    };
    game.raf = requestAnimationFrame(loopFn);
  }

  function gameHide(keepLayer) {
    if (game) cancelAnimationFrame(game.raf);
    game = null;
    for (const e of [...ui.game.querySelectorAll('.gline')]) e.remove();
    if (!keepLayer) { ui.game.classList.remove('show'); ui.patch.style.display = 'none'; }
  }

  function gameLayout() {
    const v = currentVideo;
    if (!game || !v || !v.videoWidth) return;
    const c = contentRect(v), kx = c.width / v.videoWidth, ky = c.height / v.videoHeight, g = game.geom;
    for (const { el: e, box } of game.items) {
      const a = toVideo(g, box.x0, box.top), b = toVideo(g, box.x1, box.bottom);
      const glyph = (box.hRef / g.scale) * ky;              // İngilizce harf yüksekliği (ekran pikseli)
      const fontPx = Math.max(11, glyph * 1.06);
      const width = Math.min(c.width * 0.9, Math.max((b.x - a.x) * kx * 1.15, c.width * 0.4));
      const cx = c.left + ((a.x + b.x) / 2) * kx;
      const left = Math.min(Math.max(cx - width / 2, c.left), c.left + c.width - width);
      e.style.fontSize = fontPx.toFixed(1) + 'px';
      e.style.width = width.toFixed(1) + 'px';
      e.style.left = left.toFixed(1) + 'px';
      // Son satır İngilizcenin son satırına otursun; Türkçe uzunsa yukarı doğru büyür
      e.style.bottom = (window.innerHeight - (c.top + b.y * ky) - fontPx * 0.18).toFixed(1) + 'px';
    }
  }

  // Ayrılabilir kutu bulanıklaştırma (yerinde), yarıçap r
  function boxBlur(a, tmp, W, H, r) {
    const n = 2 * r + 1;
    for (let y = 0; y < H; y++) {
      const o = y * W; let s = 0;
      for (let x = -r; x <= r; x++) s += a[o + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        tmp[o + x] = s / n;
        s += a[o + Math.min(W - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = s / n;
        s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
      }
    }
  }

  function gamePatch() {
    const v = currentVideo;
    if (!game || !v || !v.videoWidth) return;
    const g = game.geom, vw = v.videoWidth, vh = v.videoHeight;
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity, hV = 0;
    const rects = game.items.map(({ box }) => {
      const a = toVideo(g, box.x0, box.top), b = toVideo(g, box.x1, box.bottom), h = box.hRef / g.scale;
      hV = Math.max(hV, h);
      return { x0: a.x - h * 0.35, y0: a.y - h * 0.3, x1: b.x + h * 0.35, y1: b.y + h * 0.3 };
    });
    for (const r of rects) { X0 = Math.min(X0, r.x0); Y0 = Math.min(Y0, r.y0); X1 = Math.max(X1, r.x1); Y1 = Math.max(Y1, r.y1); }
    X0 = Math.max(0, X0 - hV); Y0 = Math.max(0, Y0 - hV * 0.6); X1 = Math.min(vw, X1 + hV); Y1 = Math.min(vh, Y1 + hV * 0.6);
    if (X1 - X0 < 4 || Y1 - Y0 < 4) return;
    const k = Math.min(1, 640 / (X1 - X0));
    const W = Math.max(4, Math.round((X1 - X0) * k)), H = Math.max(4, Math.round((Y1 - Y0) * k));
    workCanvas.width = W; workCanvas.height = H;
    workCtx.drawImage(v, X0, Y0, X1 - X0, Y1 - Y0, 0, 0, W, H);
    const img = workCtx.getImageData(0, 0, W, H), d = img.data, N = W * H;

    // 1) Yazı pikselleri: kutuların içinde, yazının kendi parlaklığına yakın ve yanında koyu gölge olan
    //    pikseller (açık renk zemin — çakıl, tekne — silinmesin, sadece harfler)
    const m = new Float32Array(N), tmp = new Float32Array(N);
    const pr = rects.map((r) => [(r.x0 - X0) * k, (r.y0 - Y0) * k, (r.x1 - X0) * k, (r.y1 - Y0) * k]);
    const boxOf = new Int8Array(N).fill(-1);
    const L = new Uint8Array(N), hist = new Uint32Array(256);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x, i = p * 4;
        L[p] = lum(d, i);
        for (let j = 0; j < pr.length; j++) { const b = pr[j]; if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) { boxOf[p] = j; break; } }
        if (boxOf[p] >= 0 && sat(d, i) <= 45) hist[L[p]]++;
      }
    }
    // Kutulardaki en parlak %4'lük kısım yazının kendisidir
    let total = 0; for (let v = 0; v < 256; v++) total += hist[v];
    let acc = 0, textLum = 255;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.04) { textLum = v; break; } }
    const lumMin = Math.max(S.threshold - 35, textLum - 40);
    // Zaman: altyazı ekranda sabit durur; kamera oynadıkça altındaki çakıl/taş bir an kararır.
    // Son ~1 sn içinde kararmış piksel yazı değildir (yoksa bütün satır bulanık bir şeritle dolar).
    const hk = W + 'x' + H + '@' + Math.round(X0) + ',' + Math.round(Y0);
    if (!game.hist || game.hist.key !== hk) game.hist = { key: hk, minL: Float32Array.from(L) };
    const mL = game.hist.minL;
    for (let p = 0; p < N; p++) mL[p] = Math.min(L[p], mL[p] + 3);
    const Lmin = new Uint8Array(N), Ltmp = new Uint8Array(N);
    localMin(L, Ltmp, Lmin, W, H, Math.max(1, Math.round(hV * k * 0.12)));
    // Konturlu (GTA tarzı) yazıda: yazı pikselinin hemen yanında simsiyah kontur olmalı
    let Tout = 255;
    if (g.outline) {
      const ha = new Uint32Array(256); for (let p = 0; p < N; p++) ha[L[p]]++;
      let a = 0, dk = 255; for (let x = 0; x < 256; x++) { a += ha[x]; if (a >= N * 0.0004) { dk = x; break; } }
      Tout = Math.min(40, dk + 18);
    }
    const ink = new Array(pr.length).fill(0);
    for (let p = 0; p < N; p++) {
      const j = boxOf[p];
      if (j < 0) continue;
      const i = p * 4, s = sat(d, i), edge = L[p] - Lmin[p];
      const white = L[p] >= lumMin && s <= 45 && edge >= 45 && mL[p] >= lumMin - 20 && Lmin[p] <= Tout;
      const vivid = s >= 60 && Math.max(d[i], d[i + 1], d[i + 2]) >= 170 && edge >= 35;
      if (white || vivid) { m[p] = 1; ink[j]++; }
    }
    // Kalın yazılan görev hedefini ("Follow Moses") kalın yaz
    if (!game.boldDone && game.items.length > 1) {
      game.boldDone = true;
      const dens = pr.map((b, j) => ink[j] / Math.max(1, (b[2] - b[0]) * (b[3] - b[1])));
      const lo = Math.min(...dens);
      game.items.forEach((it, j) => it.el.classList.toggle('bold', dens[j] > lo * 1.35));
    }
    // 2) Yazının gölgesini/çerçevesini de kapsayacak kadar genişlet
    const dil = Math.max(1, Math.round(hV * k * 0.16));
    boxBlur(m, tmp, W, H, dil);
    for (let p = 0; p < N; p++) m[p] = m[p] > 0.001 ? 1 : 0;
    // 3) Maskenin dışındaki renklerden doldur (normalize bulanıklaştırma)
    const R = Math.max(2, Math.round(hV * k * 0.8));
    const wgt = new Float32Array(N), cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
    for (let p = 0, i = 0; p < N; p++, i += 4) {
      const w = 1 - m[p]; wgt[p] = w; cr[p] = d[i] * w; cg[p] = d[i + 1] * w; cb[p] = d[i + 2] * w;
    }
    for (const a of [wgt, cr, cg, cb]) { boxBlur(a, tmp, W, H, R); boxBlur(a, tmp, W, H, R); }
    // 4) Yumuşak kenar
    const alpha = Float32Array.from(m);
    boxBlur(alpha, tmp, W, H, 1);
    for (let p = 0, i = 0; p < N; p++, i += 4) {
      const w = wgt[p];
      if (alpha[p] <= 0.001 || w < 1e-3) { d[i + 3] = 0; continue; }
      d[i] = cr[p] / w; d[i + 1] = cg[p] / w; d[i + 2] = cb[p] / w; d[i + 3] = Math.min(255, alpha[p] * 300);
    }
    ui.patch.width = W; ui.patch.height = H;
    patchCtx.putImageData(img, 0, 0);
    const c = contentRect(v), kx = c.width / vw, ky = c.height / vh;
    place(ui.patch, { left: c.left + X0 * kx, top: c.top + Y0 * ky, width: (X1 - X0) * kx, height: (Y1 - Y0) * ky });
    ui.patch.style.display = 'block';
  }

  // ---------- Görüntü işleme ----------
  // İnce altyazılar küçültmede silinir; parmak izi videonun kendi çözünürlüğünde alınır
  const SIG_MAX_W = 1280;
  const sigCanvas = document.createElement('canvas');
  const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });
  const ocrCanvas = document.createElement('canvas');
  const ocrCtx = ocrCanvas.getContext('2d', { willReadFrequently: true });

  let ocrGeom = { pad: 0, h: 1 };
  let lastPrep = null; // son OCR görüntüsü (gri) + canlı renkli pikseller
  const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const sat = (d, i) => Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
  const NEUTRAL_SAT = 15;   // bunun üstündeki doygunluk "renkli" sayılır (altyazı beyazı ≈ 0–10, tekne/tişört beyazı ≈ 15–30)
  const MIN_INK = 0.0008;   // bölgede yazı var sayılması için gereken parlak piksel oranı

  function signature(v) {
    const { sx, sy, sw, sh } = regionVideoRect(v);
    const W = Math.min(sw, SIG_MAX_W);
    const H = Math.max(8, Math.round((W * sh) / sw));
    if (sigCanvas.width !== W || sigCanvas.height !== H) { sigCanvas.width = W; sigCanvas.height = H; }
    sigCtx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
    maskMsg(sigCtx, sx, sy, W / sw, 0, S.textMode === 'bright' ? '#000' : '#fff');
    const d = sigCtx.getImageData(0, 0, W, H).data;
    const n = W * H;
    const values = new Uint8Array(n);
    let bright = 0;
    const bm = S.textMode === 'bright', thr = S.threshold;
    if (!bm) {
      for (let p = 0, i = 0; p < n; p++, i += 4) values[p] = lum(d, i);
      return { values, bright, n, colored: false };
    }
    // Altyazılar neredeyse renksiz beyazdır; beyaz gömlek, el, ışık gibi parlak ama
    // renkli sahne nesneleri yazı sayılmaz. (1 = renksiz parlak, 2 = renkli parlak)
    // Ayrıca yazının hemen yanında koyu gölge/kontur olur: beyaz tekne, beyaz tişört gibi
    // düz parlak yüzeylerin içi yazı sayılmaz — yoksa küçük altyazının gelişi fark edilmez.
    if (!sigL || sigL.length !== n) { sigL = new Uint8Array(n); sigTmp = new Uint8Array(n); sigMin = new Uint8Array(n); }
    for (let p = 0, i = 0; p < n; p++, i += 4) sigL[p] = lum(d, i);
    localMin(sigL, sigTmp, sigMin, W, H, 2);
    let colorBright = 0, oBright = 0;
    const ovalues = new Uint8Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const L = sigL[p];
      if (L <= thr || L - sigMin[p] < EDGE_CONTRAST) continue;
      if (sat(d, i) <= NEUTRAL_SAT) {
        values[p] = 1; bright++;
        // Simsiyah kontura değen parlak piksel (GTA tarzı yazı): çakıl/beton dokusu buna pek girmez
        if (sigMin[p] <= OUTLINE_DARK) { ovalues[p] = 1; oBright++; }
      } else { values[p] = 2; colorBright++; }
    }
    // Hiç renksiz yazı yoksa ama renkli parlak yazı varsa (ör. sarı altyazı) → renkleri de say
    const colored = bright / n < MIN_INK && colorBright / n >= MIN_INK;
    for (let p = 0; p < n; p++) values[p] = colored ? (values[p] ? 1 : 0) : (values[p] === 1 ? 1 : 0);
    // Açık renk, dokulu zemin (çakıl, beton): parlak kenarların çoğu zemindir; yeni altyazı
    // toplam içinde kaybolur. Konturlu pikseller ayrıca izlenir (bkz. sigDiff / newInkRatio).
    // Konturlu yazılı oyunda (GTA) değişim her zaman yalnızca konturlu piksellerle izlenir: zemin dokusu
    // %2,5 eşiğinin altında kalsa da kamera kaydıkça gevşek fark sürekli yüksek çıkıyor, okuma boşuna zorlanıyordu
    const textured = !colored && (bright / n >= TEXTURED || outlineGame);
    return { values, bright: colored ? bright + colorBright : bright, n, colored,
      ovalues: textured ? ovalues : null, obright: oBright, W, sw };
  }

  let sigL = null, sigTmp = null, sigMin = null;
  const EDGE_CONTRAST = 60; // yazı pikseli ile yanındaki gölge arasındaki en az parlaklık farkı
  const OUTLINE_DARK = 45;  // yazı konturu sayılacak kadar koyu komşu
  const TEXTURED = 0.025;   // bölgenin bu kadarı parlak kenarsa zemin dokulu sayılır (yazı tek başına ≈ %1–2)

  // r yarıçaplı kare komşulukta en koyu değer (ayrılabilir: önce yatay, sonra dikey)
  function localMin(src, tmp, out, W, H, r) {
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let m = 255;
        for (let xx = Math.max(0, x - r), e = Math.min(W - 1, x + r); xx <= e; xx++) if (src[o + xx] < m) m = src[o + xx];
        tmp[o + x] = m;
      }
    }
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let m = 255;
        for (let yy = Math.max(0, y - r), e = Math.min(H - 1, y + r); yy <= e; yy++) if (tmp[yy * W + x] < m) m = tmp[yy * W + x];
        out[o + x] = m;
      }
    }
  }

  function sigDiff(a, b) {
    if (!a || !b || a.values.length !== b.values.length) return Infinity;
    let s = 0;
    const A = a.values, B = b.values;
    if (S.textMode === 'bright') {
      for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) s++;
      const d = (s / Math.max(a.bright, b.bright, 20)) * 100; // yazı piksellerinin yüzde kaçı değişti
      if (!a.ovalues || !b.ovalues) return d;
      // Dokulu zeminde yalnızca konturlu yazı piksellerine bakılır: kamera hareket ettikçe zemin
      // dokusu sürekli "değişiyor" görünür ve okuma boşuna bekler
      let o = 0;
      for (let i = 0; i < A.length; i++) if (a.ovalues[i] !== b.ovalues[i]) o++;
      // Ekranda çeviri varken: değişen konturlu piksel, gösterilen yazının kendi büyüklüğüne göre de
      // ölçülür. Kum/çakıl zeminde toplam parlak kenarın çoğu dokudur; kısa bir yazının gelip gitmesi
      // toplam içinde %30'a ulaşmıyor ve hiç fark edilmiyordu ("Oh, hey.").
      const d0 = (o / Math.max(a.obright, b.obright, 20)) * 100;
      if (acceptedInk >= 15) return Math.max(d0, Math.min(100, (o / acceptedInk) * 100) * 0.5);
      return d0;
    }
    for (let i = 0; i < A.length; i++) s += Math.abs(A[i] - B[i]);
    return s / A.length;
  }

  // Son okunan kareye göre YENİ yanan yazı piksellerinin oranı.
  // Yazı solarken sadece piksel söner, yeni piksel yanmaz → tekrar okumaya gerek yok
  // (yarım okunan "…ettle down man" gibi saçma çevirileri bu engeller).
  // Gösterilen yazının bir satırı tamamen kalktı mı? ("Nope." / "It's the one…" → yalnız alttaki).
  // Kısa satırın kalkması toplam değişimde kaybolur (sigDiff eşiği aşılmaz), satır satır bakılır.
  function satirKalkti(a, b) {
    if (!a || !b || !a.W || a.values.length !== b.values.length) return false;
    const useO = a.ovalues && b.ovalues;
    const A = useO ? a.ovalues : a.values, B = useO ? b.ovalues : b.values;
    const W = a.W, H = Math.floor(A.length / W);
    const ra = new Array(H).fill(0), rb = new Array(H).fill(0);
    let tot = 0;
    for (let y = 0; y < H; y++) for (let x = 0, i = y * W; x < W; x++, i++) { if (A[i]) { ra[y]++; tot++; } if (B[i]) rb[y]++; }
    if (tot < 20) return false;
    // Ardışık mürekkepli satırlar bir yazı satırıdır; o bantta yeni karede mürekkep neredeyse yoksa satır kalkmıştır
    for (let y = 0; y < H;) {
      if (ra[y] < 2) { y++; continue; }
      let sa = 0, sb = 0;
      while (y < H && ra[y] >= 2) { sa += ra[y]; sb += rb[y]; y++; }
      if (sa >= Math.max(8, tot * 0.05) && sb <= sa * 0.15) return true;
    }
    return false;
  }
  // Eski yazının belirgin bir kısmı silindi: okunmalı (kalan blok gösterilsin ya da altyazı kalksın)
  function blokKalkti(a, b) {
    if (!a || !b || a.values.length !== b.values.length) return false;
    const useO = a.ovalues && b.ovalues;
    const A = useO ? a.ovalues : a.values, B = useO ? b.ovalues : b.values;
    let had = 0, gone = 0, left = 0;
    for (let i = 0; i < A.length; i++) { if (A[i]) { had++; if (B[i]) left++; else gone++; } }
    return had >= 20 && gone >= had * 0.2; // bir blok kalktı ya da yazının tamamı gitti (dokulu zeminde)
  }
  function newInkRatio(a, b) {
    if (!a || !b || a.values.length !== b.values.length) return 1;
    let added = 0;
    const A = a.values, B = b.values;
    for (let i = 0; i < A.length; i++) if (B[i] && !A[i]) added++;
    const r = added / Math.max(b.bright, 20);
    if (!a.ovalues || !b.ovalues) return r;
    let oAdded = 0;
    for (let i = 0; i < A.length; i++) if (b.ovalues[i] && !a.ovalues[i]) oAdded++;
    // Dokulu zeminde payda yazının kendi büyüklüğü (bkz. sigDiff)
    return oAdded / Math.max(acceptedInk >= 15 ? Math.min(b.obright, acceptedInk) : b.obright, 20);
  }

  // OCR için: büyüt, yumuşak eşikle beyaz zeminde siyah yazıya çevir
  // GTA tarzı altyazı: beyaz dolgu + ince simsiyah kontur. Kontur modunda yalnızca siyah konturun
  // hemen yanındaki çok parlak pikseller yazı sayılır — açık renk zemin (çakıl, beton, gökyüzü) yazıya karışmaz.
  // Konturu olmayan oyunlarda bu mod yazıyı siler; bu yüzden step() iki yolu da dener ve iyi okunanı seçer.
  // GTA tarzı konturlu yazı: siyah konturla çevrili parlak bölgeler harftir. Piksel piksel parlaklık
  // eşiği açık zeminde işe yaramıyor (çakıl, harf dolgusuyla aynı parlaklıkta): bunun yerine parlak
  // bölgeler bütün olarak sınıflandırılır:
  //  - kenarının neredeyse tamamı simsiyah kontura değmeli (çakıl taşının kenarı gri gölgedir),
  //  - satır yüksekliğini aşmamalı, renkli olmamalı,
  //  - başka bir harfin içinde kalmamalı ("o"/"c"/"e" içindeki çakıl → yoksa "o" "e" okunur: "too"→"tee").
  // Dönen dizide 1 = yazı.
  let otBuf = null;
  function outlineText(d, W, H, vh, scale) {
    const N = W * H;
    if (!otBuf || otBuf.N !== N) otBuf = { N, L: new Uint8Array(N), col: new Uint8Array(N), tmp: new Uint8Array(N), near: new Uint8Array(N), lab: new Int32Array(N), st: new Int32Array(N), mask: new Uint8Array(N) };
    const { L, col, tmp, near, lab, st, mask } = otBuf;
    for (let i = 0, k = 0; k < N; i += 4, k++) { L[k] = lum(d, i); col[k] = sat(d, i) > 25 ? 1 : 0; }
    localMin(L, tmp, near, W, H, 3);
    const BAR = 150, TD = 45, MAXH = Math.round(0.048 * vh * scale);
    lab.fill(-1); mask.fill(0);
    const C = []; // [n, kenar, konturlu kenar, renkli, x0, x1, y0, y1]
    for (let s = 0; s < N; s++) {
      if (lab[s] >= 0 || L[s] < BAR) continue;
      const id = C.length;
      let sp = 0, n = 0, sum = 0, pe = 0, pn = 0, nc = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
      st[sp++] = s; lab[s] = id;
      while (sp) {
        const p = st[--sp], x = p % W, y = (p - x) / W;
        n++; sum += L[p]; nc += col[p];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        let edge = false;
        if (x > 0) { const q = p - 1; if (L[q] < BAR) edge = true; else if (lab[q] < 0) { lab[q] = id; st[sp++] = q; } }
        if (x < W - 1) { const q = p + 1; if (L[q] < BAR) edge = true; else if (lab[q] < 0) { lab[q] = id; st[sp++] = q; } }
        if (y > 0) { const q = p - W; if (L[q] < BAR) edge = true; else if (lab[q] < 0) { lab[q] = id; st[sp++] = q; } }
        if (y < H - 1) { const q = p + W; if (L[q] < BAR) edge = true; else if (lab[q] < 0) { lab[q] = id; st[sp++] = q; } }
        if (edge) { pe++; if (near[p] <= TD) pn++; }
      }
      C.push({ n, ok: n >= 4 && y1 - y0 < MAXH && x1 - x0 < MAXH * 4 && pe > 0 && pn >= pe * 0.85 && nc < n * 0.3 && sum >= n * 170, x0, x1, y0, y1 });
    }
    // Harfin içindeki bölge (sayaç): daha büyük bir harfin kutusunun içinde, üst/alt kenarına değmeden
    const ids = [];
    for (let i = 0; i < C.length; i++) if (C[i].ok) ids.push(i);
    ids.sort((a, b) => C[a].x0 - C[b].x0);
    for (const a of ids) {
      const A = C[a];
      for (const b of ids) {
        const B = C[b];
        if (B.x0 > A.x0) break;
        if (B.n > A.n && (A.x0 + A.x1) / 2 < B.x1 && B.y0 < A.y0 - 1 && B.y1 > A.y1 + 1) { A.inner = true; break; }
      }
    }
    for (let k = 0; k < N; k++) { const id = lab[k]; if (id >= 0 && C[id].ok && !C[id].inner) mask[k] = 1; }
    return mask;
  }

  function preprocess(v, colored, outline, mul = 1) {
    const { sx, sy, sw, sh } = regionVideoRect(v);
    // 720p–1080p'de büyüt, 1440p/4K gibi büyük videolarda küçült (OCR ve görüntü taşıma hızlı kalsın;
    // bu boyutta Tesseract'ın doğruluğu düşmüyor). mul: zayıf okumada farklı ölçekle tekrar denemek için.
    const base = sw >= 2400 ? 0.5 : sw >= 1700 ? 1.1 : 1.5;
    const scale = Math.min(3, Math.max(base, 2200 / sw)) * mul;
    const W = Math.round(sw * scale), H = Math.round(sh * scale), PAD = 12;
    ocrCanvas.width = W + PAD * 2; ocrCanvas.height = H + PAD * 2;
    ocrCtx.fillStyle = '#fff';
    ocrCtx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
    ocrCtx.imageSmoothingQuality = 'high';
    ocrCtx.drawImage(v, sx, sy, sw, sh, PAD, PAD, W, H);
    maskMsg(ocrCtx, sx, sy, scale, PAD, S.textMode === 'bright' ? '#000' : '#fff');
    const img = ocrCtx.getImageData(PAD, PAD, W, H);
    const d = img.data;
    lastPrep = null;
    if (S.textMode === 'bright') {
      const M = outline && !colored ? outlineText(d, W, H, v.videoHeight || sh, scale) : null;
      const lo = S.threshold - 65, span = 80;
      const gray = new Uint8ClampedArray(W * H), vivid = new Uint8Array(W * H);
      let nv = 0;
      for (let i = 0, k = 0; i < d.length; i += 4, k++) {
        let c = 255 - ((lum(d, i) - lo) * 255) / span;
        if (!colored) {
          // Renkli parlak pikselleri (gömlek, ten, ışık) arka plana it
          const s = sat(d, i);
          if (s > NEUTRAL_SAT) c += (255 - c) * Math.min(1, (s - NEUTRAL_SAT) / 15);
          // Canlı renkli parlak piksel: görev hedefindeki renkli kelime olabilir ("Follow Moses")
          // (konturlu oyunda yalnızca kontura yakın olanlar: çakıldaki kırmızı taşlar kelime sanılmasın)
          if (s >= 60 && Math.max(d[i], d[i + 1], d[i + 2]) >= 170 && (!M || otBuf.near[k] <= 45)) { vivid[k] = 1; nv++; }
        }
        if (M) c = M[k] ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = gray[k] = c < 0 ? 0 : c > 255 ? 255 : c;
      }
      lastPrep = { W, H, PAD, gray, vivid: nv ? vivid : null };
    } else {
      let min = 255, max = 0, sum = 0;
      for (let i = 0; i < d.length; i += 4) { const L = lum(d, i); if (L < min) min = L; if (L > max) max = L; sum += L; }
      const darkBg = sum / (d.length / 4) < (min + max) / 2;
      const range = Math.max(1, max - min);
      for (let i = 0; i < d.length; i += 4) {
        let c = ((lum(d, i) - min) / range) * 255;
        if (darkBg) c = 255 - c;
        d[i] = d[i + 1] = d[i + 2] = c;
      }
    }
    ocrCtx.putImageData(img, PAD, PAD);
    ocrGeom = { pad: PAD, h: H, scale, sx, sy, outline: !!(outline && !colored && S.textMode === 'bright') };
    return ocrCanvas.toDataURL('image/png');
  }

  // ---------- Metin temizleme ve doğrulama ----------
  // Kelime düzeyinde eleme: sahnedeki parlak nesnelerden çıkan "kelimeler" ya gerçek
  // harflerden çok daha büyük/küçüktür, ya cümleden uzakta durur, ya da güveni düşüktür.
  const letterCount = (w) => (w.match(/\p{L}/gu) || []).length;
  const isAnchor = (w) => w.confidence >= 65 && letterCount(w.text) >= 2;
  const TUS_BAG = /^(use|hold|press|tap|push|pull|rotate|move|and|or|to|then)[,.]?$/i;
  function filterWords(lines) {
    const all = lines.flatMap((l) => l.words || []);
    const anchors = all.filter(isAnchor);
    // Tek, kısa ve az güvenli bir "kelime" (ör. "ya", "wd") sahne kırıntısıdır
    if (!anchors.length) return [];
    if (anchors.reduce((n, w) => n + letterCount(w.text), 0) < 4 && !anchors.some((w) => w.confidence >= 85)) return [];
    const hs = anchors.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
    const hRef = hs[Math.floor(hs.length / 2)];
    const out = [];
    for (const l of lines) {
      let junk = 0; // sözlükte olmadığı için atılan harf sayısı
      // Tek kelime kutusunun içinde boşluk olamaz: OCR ismi bölmüş ("Sha nese!" → "Shanese!");
      // Google bölünmüş ismi "Şa nese" yapıyor
      let ws = (l.words || []).map((w) => (w.fix ? { ...w, text: w.fix } : w))
        .map((w) => (/\p{L}\s+\p{Ll}/u.test(w.text) ? { ...w, text: w.text.replace(/(\p{L})\s+(?=\p{Ll})/gu, '$1') } : w)).filter((w) => {
        const h = w.y1 - w.y0, n = letterCount(w.text);
        // Sözlükte olmayan, güveni düşük ya da uzun küçük harfli kelime: "fuekingiloeer", "yachigiilessem"
        // (büyük harfle başlayan, güvenli okunan bilinmeyen kelimeler isimdir: "Bennie", "Leonida")
        if (w.known === false && (w.confidence < 65 || (n >= 7 && !/\p{Lu}/u.test(w.text)))) { junk += n; return false; }
        if (h > hRef * 1.6) return false;                       // dev leke
        if (n >= 2 && h < hRef * 0.45) return false;            // ufak kırıntı
        if (w.confidence < 60 && (n < 4 || !/[aeiouy]/i.test(w.text))) return false;
        // "DURRe0ps", "HURINCOeS": güveni düşük, harf/rakam karışık uydurma kelime
        if (w.confidence < 40 && /\p{Ll}\p{Lu}|\d\p{L}|\p{L}\d/u.test(w.text.replace(/^\p{Lu}/u, ''))) return false;
        return true;
      });
      // Cümleden kopuk duran kenar kelimeleri at
      const gap = hRef * 2.2;
      // Tuş simgesi bırakan boşluklar ("Use (L) and (R) to center…"): bağlaç/tuş fiili yanındaki boşluk kopukluk değil
      const ikonBag = (a, b) => b.x0 - a.x1 <= hRef * 6 && (TUS_BAG.test(a.text) || TUS_BAG.test(b.text));
      while (ws.length > 1 && ws[1].x0 - ws[0].x1 > gap && !ikonBag(ws[0], ws[1]) && !(ws[0].confidence >= 90 && letterCount(ws[0].text) >= 3)) ws.shift();
      while (ws.length > 1 && ws[ws.length - 1].x0 - ws[ws.length - 2].x1 > gap
        && !(ws[ws.length - 1].confidence >= 90 && letterCount(ws[ws.length - 1].text) >= 3)) ws.pop();
      if (!ws.some(isAnchor)) continue;
      // Satırın çoğu saçma çıktıysa geri kalan kırıntı da güvenilmez ("…thatAndiew Node" → "Node")
      if (junk > ws.reduce((k, w) => k + letterCount(w.text), 0)) continue;
      // Aynı hizada ama arasında büyük boşluk olan yazılar ayrı yazılardır: sol alttaki menü yazısı
      // ("Not owned") + ortadaki görev ("Buy a new outfit…"). Parçalara böl; en dolu parça sona
      // (sonraki satır ona bağlansın), ötekiler ayrı blok olur ve ortadan uzak olan elenir.
      const segs = [[ws[0]]];
      for (let i = 1; i < ws.length; i++) {
        if (ws[i].x0 - ws[i - 1].x1 > hRef * 3 && !ikonBag(ws[i - 1], ws[i])) segs.push([]);
        segs[segs.length - 1].push(ws[i]);
      }
      const segLetters = (sg) => sg.reduce((k, w) => k + letterCount(w.text), 0);
      if (segs.length > 1) {
        const big = segs.reduce((m, sg) => (segLetters(sg) > segLetters(m) ? sg : m));
        segs.splice(segs.indexOf(big), 1); segs.push(big);
      }
      segs.forEach((sg, si) => {
        const core = sg.filter(isAnchor);
        if (!core.length) return;
        out.push({
          text: sg.map((w) => w.text).join(' '), words: sg, split: si > 0,
          top: Math.min(...core.map((w) => w.y0)), bottom: Math.max(...core.map((w) => w.y1)),
          x0: Math.min(...sg.map((w) => w.x0)), x1: Math.max(...sg.map((w) => w.x1)),
        });
      });
    }
    // Aralarında boşluk olan satırlar ayrı yazılardır: diyalog + altındaki görev hedefi
    // ("…worth my time." / "Follow Moses"), ya da silah/ödül bildirimi ("NIPPER .38 PISTOL")
    // Küçük harfle başlayan satır, noktayla bitmeyen üst satırın devamıdır ("…my boss told me" / "to ask you…"):
    // satır aralığı biraz geniş okunsa da ayrı blok sayma (görev satırları büyük harfle başlar)
    const devam = (u, a) => /^[\p{Ll}]/u.test(a.text) && !/[.!?…"”:]\s*$/u.test(u.text);
    for (let i = 1; i < out.length; i++) {
      const g = out[i].top - out[i - 1].bottom;
      out[i].newBlock = out[i].split || (g > hRef * 0.9 && !(g < hRef * 1.6 && devam(out[i - 1], out[i])));
    }
    out.hRef = hRef;
    out.trusted = true;
    if (debugOn) try { window.__xctGeo = { hRef, l: out.map((o) => [o.text.slice(0, 20), Math.round(o.top), Math.round(o.bottom), !!o.newBlock]) }; } catch (e) {}
    return out;
  }

  // Renkli kelime kurtarma: OCR renkli pikselleri bilerek arka plan sayar (gömlek, ışık…).
  // Ama oyunlar görev hedefindeki isimleri renkli yazar ("Follow Moses", "Stow the bag in the trunk").
  // Okunan bir satırın hizasında canlı renk varsa yalnızca o şeridi renkler dahil tekrar okur;
  // yeni kelimeyi ancak sözlükte varsa ve net okunduysa ekler — diğer satırlar hiç etkilenmez.
  let stripCanvas = null;
  async function recoverColored(picked, P, ocrFn) {
    const meta = picked.lines;
    if (!P || !P.vivid || !meta || !meta.length || !meta.hRef) return;
    const h = meta.hRef;
    const key = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    for (let li = 0; li < meta.length; li++) {
      const L = meta[li];
      if (!L.words) continue;
      const y0 = Math.max(0, Math.round(L.top - P.PAD - h * 0.35)), y1 = Math.min(P.H, Math.round(L.bottom - P.PAD + h * 0.35));
      const x0 = Math.max(0, Math.round(L.x0 - P.PAD - h * 8)), x1 = Math.min(P.W, Math.round(L.x1 - P.PAD + h * 8));
      if (y1 - y0 < 4 || x1 - x0 < 4) continue;
      let nv = 0;
      for (let y = y0; y < y1; y++) for (let x = x0, k = y * P.W + x0; x < x1; x++, k++) nv += P.vivid[k];
      if (nv < h * h * 0.25) continue;
      const pad = 12, sw = x1 - x0, sh = y1 - y0;
      stripCanvas = stripCanvas || document.createElement('canvas');
      stripCanvas.width = sw + pad * 2; stripCanvas.height = sh + pad * 2;
      const sc = stripCanvas.getContext('2d');
      sc.fillStyle = '#fff'; sc.fillRect(0, 0, stripCanvas.width, stripCanvas.height);
      const img = sc.createImageData(sw, sh), d = img.data;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const k = (y + y0) * P.W + x + x0, i = (y * sw + x) * 4;
          const c = P.vivid[k] ? 0 : P.gray[k];
          d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255;
        }
      }
      sc.putImageData(img, pad, pad);
      let r;
      try { r = await ocrFn(stripCanvas.toDataURL('image/png')); } catch (e) { continue; }
      if (!r || !r.ok || !r.lines) continue;
      const dx = x0 - pad + P.PAD, dy = y0 - pad + P.PAD;
      const w2 = r.lines.flatMap((l) => l.words || [])
        .map((w) => ({ ...w, text: w.fix || w.text, x0: w.x0 + dx, x1: w.x1 + dx, y0: w.y0 + dy, y1: w.y1 + dy }));
      // Eski kelimelerin hepsi yeni okumada (aynı sırayla) olmalı; yoksa ikinci okuma daha kötü
      let j = 0;
      const used = new Set();
      let ok = true;
      for (const w of L.words) {
        if (!isAnchor(w)) continue;
        while (j < w2.length && key(w2[j].text) !== key(w.text)) j++;
        if (j >= w2.length) { ok = false; break; }
        used.add(j++);
      }
      if (!ok) continue;
      const cand = w2.filter((w, i) => {
        if (used.has(i)) return false;
        const n = letterCount(w.text), wh = w.y1 - w.y0;
        if (n < 2 || w.confidence < (n >= 5 && w.known === true ? 55 : 70) || w.known === false || wh < h * 0.6 || wh > h * 1.6) return false;
        // Eski bir kelimenin üstüne binmemeli (aynı kelimenin farklı okunuşu: "yous" / "you")
        return !L.words.some((o) => Math.min(o.x1, w.x1) - Math.max(o.x0, w.x0) > 0.3 * Math.min(o.x1 - o.x0, w.x1 - w.x0));
      });
      // Satırın hemen yanında olmalı (aynı cümlenin parçası). Zincirleme: renkli ikinci kelime ilkinin yanındadır
      // ("Get on the dirt bike", "Handle the security guard" — "bike"/"guard" satır sonundan uzak kalıp atılıyordu)
      const added = [];
      let ax0 = L.x0, ax1 = L.x1;
      for (let more = true; more;) {
        more = false;
        for (const w of cand) {
          if (added.includes(w) || w.x1 < ax0 - h * 3 || w.x0 > ax1 + h * 3) continue;
          if (added.some((o) => Math.min(o.x1, w.x1) - Math.max(o.x0, w.x0) > 0.3 * Math.min(o.x1 - o.x0, w.x1 - w.x0))) continue;
          added.push(w); ax0 = Math.min(ax0, w.x0); ax1 = Math.max(ax1, w.x1); more = true;
        }
      }
      if (!added.length) continue;
      const ws = [...L.words, ...added].sort((a, b) => a.x0 - b.x0);
      L.words = ws;
      L.text = picked[li] = ws.map((w) => w.text).join(' ');
      L.x0 = Math.min(L.x0, ...added.map((w) => w.x0));
      L.x1 = Math.max(L.x1, ...added.map((w) => w.x1));
    }
  }

  function pickLines(r) {
    if (Array.isArray(r.lines) && r.lines.length) {
      let kept = r.lines.some((l) => l.words && l.words.length) ? filterWords(r.lines) : null;
      if (!kept) {
        // Kelime bilgisi yoksa: güveni düşük ve diğerlerinden çok küçük satırları (sahne kırıntıları) at
        const good = r.lines.filter((l) => l.text && l.confidence >= 50);
        const maxH = Math.max(0, ...good.map((l) => l.height || 0));
        kept = good.filter((l) => !maxH || (l.height || 0) >= maxH * 0.6);
      }
      const out = kept.map((l) => l.text);
      out.trusted = !!kept.trusted; // kelimeler tek tek güvenle süzüldü
      out.lines = kept; // blok ayrımı ve yazının konumu (oyun içi görünüm) için
      // Yazının bölge içindeki üst kenarı → Türkçe tam İngilizcenin üstüne otursun
      const tops = kept.map((l) => l.top).filter((t) => typeof t === 'number');
      out.top = tops.length ? Math.max(0, (Math.min(...tops) - ocrGeom.pad) / ocrGeom.h - 0.03) : 0;
      // Bir satırın yüksekliği (bölge yüksekliğine oranla): sabit konuma iki satırlık yer ayırmak için
      const hs = kept.map((l) => l.height).filter((h) => h > 0).sort((a, b) => a - b);
      out.lineFrac = hs.length ? (hs[hs.length >> 1] * 1.3) / ocrGeom.h : 0;
      return out;
    }
    const out = r.confidence >= 45 ? (r.text || '').split('\n') : [];
    out.top = 0;
    return out;
  }

  const isCaps = (t) => { const L = t.match(/\p{L}/gu) || []; return L.length >= 3 && L.filter((c) => c !== c.toLowerCase()).length / L.length >= 0.8; };
  // Satırları bloklara ayırıp her bloğu ayrı temizle; bloklar "\n" ile birleşir
  let lastBlocks = []; // son temizlenen blokların konumu (OCR pikseli): { x0, x1, top, bottom, hRef }
  function cleanText(rawLines) {
    const meta = rawLines.lines || [];
    const groups = [];
    rawLines.forEach((l, i) => {
      const m = meta[i];
      if (!groups.length || (m && m.newBlock)) groups.push({ lines: [], boxes: [] });
      const g = groups[groups.length - 1];
      g.lines.push(l);
      if (m) g.boxes.push(m);
    });
    const blocks = [];
    for (const g of groups) {
      g.lines.trusted = rawLines.trusted;
      const t = cleanBlock(g.lines);
      if (t) blocks.push({ text: t, boxes: g.boxes });
    }
    // Ana yazının yanında tek başına duran kırıntı blok ("at OS": renkli kelimeleri okunamamış görev
    // satırı) saçma çeviri üretir ("işletim sisteminde"): 4+ harfli kelimesi yoksa ve bilinen kısa
    // replik ("No.", "Hey!") değilse at
    if (blocks.length > 1) {
      const kirinti = (b) => !(b.text.match(/\p{L}{4,}/gu)) && letterCount(b.text) < 6 && !shortLine(b.text);
      const rest = blocks.filter((b) => !kirinti(b));
      if (rest.length) blocks.splice(0, blocks.length, ...rest);
    }
    // TAMAMI BÜYÜK HARF blok, yanında normal yazılı altyazı varsa oyun arayüzüdür (silah, ödül, menü)
    let kept = blocks.some((b) => !isCaps(b.text)) ? blocks.filter((b) => !isCaps(b.text)) : blocks;
    // Altyazılar ortalıdır: ana yazıdan yatayda uzak duran küçük blok arayüzdür (harita, sayaç…)
    const span = (b) => b.boxes.length ? [Math.min(...b.boxes.map((x) => x.x0)), Math.max(...b.boxes.map((x) => x.x1))] : null;
    const main = kept.reduce((m, b) => (!m || letterCount(b.text) > letterCount(m.text) ? b : m), null);
    const ms = main && span(main);
    if (ms && meta.hRef) {
      const mc = (ms[0] + ms[1]) / 2, tol = Math.max((ms[1] - ms[0]) * 0.6, meta.hRef * 6);
      kept = kept.filter((b) => { const sp = span(b); return b === main || !sp || Math.abs((sp[0] + sp[1]) / 2 - mc) <= tol; });
    }
    lastBlocks = kept.map((b) => b.boxes.length ? {
      x0: Math.min(...b.boxes.map((x) => x.x0)), x1: Math.max(...b.boxes.map((x) => x.x1)),
      top: Math.min(...b.boxes.map((x) => x.top)), bottom: Math.max(...b.boxes.map((x) => x.bottom)),
      lines: b.boxes.length, hRef: meta.hRef,
    } : null);
    return kept.map((b) => b.text).join('\n');
  }

  function cleanBlock(rawLines) {
    const lines = rawLines
      .map((l) => l
        .replace(/(^|\s)[|!l1](?=\s+\p{Ll})/gu, '$1I') // "| don't" → "I don't"
        .replace(/[|_~`^{}\[\]<>\\@#*=]+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((l) => {
        const letters = (l.match(/\p{L}/gu) || []).length;
        return l.length >= 2 && letters >= 2 && letters / l.length >= (rawLines.trusted ? 0.3 : 0.55);
      });
    // "…told me..." + "to ask you…" gibi devam eden satırları tek cümle yap
    const joined = lines.reduce((acc, line) => {
      if (!acc) return line;
      return /^\p{Ll}/u.test(line) ? acc.replace(/[.…]+$/u, '') + ' ' + line : acc + ' ' + line;
    }, '');
    let text = joined.replace(/\s+([,.!?;:])/g, '$1').trim();
    // Cümle bittikten sonra kalan tek harflik kırıntıyı at ("aren't you? I)" → "aren't you?")
    // — sahnedeki saat, ışık gibi parlak noktalardan gelir
    text = text.replace(/([.?!…"'”])\s+[^\s\p{L}]*(\p{Lu}{1,2}|\p{L})?[^\s\p{L}.?!]*$/u, '$1');
    // Baştaki harfsiz kırıntıyı at
    text = text.replace(/^[^\s\p{L}\p{N}"'“(]{1,3}\s+/u, '');
    return looksLikeSentence(text, rawLines.trusted) ? text : '';
  }

  // Gerçek altyazı mı, yoksa sahnedeki doku/çizgilerden çıkan anlamsız harfler mi?
  function looksLikeSentence(t, trusted) {
    const words = t.split(' ').filter(Boolean);
    const letters = (t.match(/\p{L}/gu) || []).length;
    const nonSpace = t.replace(/\s/g, '').length;
    // Kelimeler güvenle süzüldüyse "Ow!", "No. I'm 15." gibi kısa cümleler de geçerli
    if (trusted) return letters >= 2 && letters / nonSpace >= 0.35;
    if (t.length < 3) return false;
    if (letters < 4 || letters / nonSpace < 0.7) return false;
    if (!words.some((w) => letterCount(w) >= 3)) return false;
    const junk = words.filter((w) => letterCount(w) <= 1 && !/^(I|a|A)$/.test(w.replace(/[^\p{L}]/gu, ''))).length;
    if (words.length >= 3 && junk / words.length > 0.35) return false;
    const vowelless = words.filter((w) => letterCount(w) >= 4 && !/[aeıioöuüy]/iu.test(w)).length;
    if (vowelless > Math.max(1, Math.floor(words.length / 3))) return false;
    return true;
  }

  // Yeni okumanın kelimelerinin çoğu bir önceki altyazıda varsa ve metin uzamadıysa aynı altyazıdır
  function sameSubtitle(a, b) {
    if (!b) return false;
    const words = (t) => t.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length >= 2);
    const wa = words(a), wb = new Set(words(b));
    if (wa.length < 3 || wa.length > wb.size) return false; // kısa tekrarlar ("Two bucks?") gerçek altyazı olabilir
    return wa.filter((w) => wb.has(w)).length / wa.length >= 0.75;
  }

  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  // Bloklardan biri (ör. görev satırı "Follows" → "Follow Moses") belirgin değiştiyse yeni altyazıdır:
  // uzun diyalog bloğu aynı kaldığı için bütün metin "benzer" çıkar, yanlış görev çevirisi ekranda kalırdı
  function blokDegisti(a, b) {
    const pa = a.split('\n'), pb = b.split('\n');
    // Tek blokta bütün metin karşılaştırması yeter; yarım okuma ("Break into the" ⊂ "Break into the Montagne")
    // değişiklik sayılmaz, yoksa yarım ve tam okuma arasında gidip gelir
    if (!b || pa.length < 2 || pa.length !== pb.length) return false;
    return pa.some((x, i) => {
      const na = norm(x), nb = norm(pb[i]);
      if (Math.min(na.length, nb.length) < 4 || na === nb || na.includes(nb) || nb.includes(na)) return false;
      return editRatio(na, nb, 1) > 0.3;
    });
  }

  function similar(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return false;
    if (a === b) return true;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > Math.max(m, n) * 0.2) return false;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n] / Math.max(m, n) < 0.15;
  }

  // ---------- Çeviri ----------
  const cache = new Map();
  let translator = null;
  let translatorFailed = false;

  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' zaman aşımı')), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function ensureBuiltin(fromGesture) {
    if (translator) return translator;
    if (translatorFailed || typeof Translator === 'undefined') return null;
    const opts = { sourceLanguage: S.from, targetLanguage: S.to };
    try {
      let availability;
      try {
        availability = await withTimeout(Translator.availability(opts), 3000, 'Chrome çevirmeni');
      } catch (e) {
        translatorFailed = true; // yanıt vermiyor → Google'a geç
        return null;
      }
      if (availability === 'unavailable') { translatorFailed = true; return null; }
      if (availability !== 'available' && !fromGesture) return null; // indirme için tıklama gerekir
      const creating = Translator.create({
        ...opts,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) =>
            status(`Chrome dil modeli indiriliyor… %${Math.round(e.loaded * 100)}`, true));
        },
      });
      translator = fromGesture ? await creating : await withTimeout(creating, 5000, 'Chrome çevirmeni');
      return translator;
    } catch (e) {
      if (fromGesture) translatorFailed = true;
      return null;
    }
  }

  // TAMAMI BÜYÜK HARF altyazılar çeviride bozulur ("GET OFF MAN." → "DEFİN ADAM.")
  // → çeviriye cümle düzeninde gönder ("Get off man." → "Defol dostum.")
  // OCR kesme işaretini kaçırırsa ("You ve just", "Youve", "don t") Google kelimeleri çevirmeden bırakır
  // → kısaltmayı onar ("You've just"). Yalnız zamir/yardımcı fiil kökleriyle: gerçek kelimeleri bozmaz
  const KISALT_ARA = "(?:\\s*[`´‘’'\"]\\s*|\\s+)";
  const KISALT = [
    [new RegExp("\\b(I|you|we|they|who|would|could|should|might|must)" + KISALT_ARA + "(ve)\\b", 'gi'), "$1'$2"],
    [new RegExp("\\b(you|we|they|who|what)" + KISALT_ARA + "(re)\\b", 'gi'), "$1'$2"],
    [new RegExp("\\b(I|you|we|they|he|she|it|that|there|who)" + KISALT_ARA + "(ll)\\b", 'gi'), "$1'$2"],
    [new RegExp("\\b(I)" + KISALT_ARA + "(m)\\b", 'g'), "$1'$2"],
    [new RegExp("\\b(I|you|we|they|he|she)" + KISALT_ARA + "(d)\\b", 'gi'), "$1'$2"],
    [new RegExp("\\b(it|that|what|there|here|he|she|who|let)" + KISALT_ARA + "(s)\\b", 'gi'), "$1'$2"],
    [new RegExp("\\b(don|doesn|didn|isn|aren|wasn|weren|haven|hasn|hadn|won|wouldn|couldn|shouldn|can|ain|mustn|needn)" + KISALT_ARA + "(t)\\b", 'gi'), "$1'$2"],
    [/\b(you|they)(ve|re)\b/gi, "$1'$2"], // "were" gerçek kelime: yalnız "weve"
    [/\b(we)(ve)\b/gi, "$1'$2"],
    [/\b(you|they|it|that)(ll)\b/gi, "$1'$2"],
    [/\b(I)(ve|m)\b/g, "$1'$2"],
    [/\b(could|would|should)(ve)\b/gi, "$1'$2"],
    [/\b(that|what|there)(s)\b/gi, "$1'$2"],
    [/\b(don|doesn|didn|isn|aren|wasn|haven|hasn|hadn|couldn|wouldn|shouldn|won)(t)\b/gi, "$1'$2"],
  ];
  function kisaltmaOnar(text) {
    return KISALT.reduce((t, [re, r]) => t.replace(re, r), text);
  }
  function prepForMT(text) {
    text = kisaltmaOnar(text);
    const letters = text.match(/\p{L}/gu) || [];
    const upper = letters.filter((c) => c !== c.toLowerCase()).length;
    if (letters.length < 4 || upper / letters.length < 0.8) return text;
    return text.toLowerCase()
      .replace(/(^|[.!?…:]\s+|["“(]\s*)(\p{L})/gu, (m, p, c) => p + c.toUpperCase())
      .replace(/\bi\b/g, 'I');
  }

  // ---------- Oyun sözlüğü (sozluk.js) ----------
  const SOZLUK = globalThis.XCT_SOZLUK || { kisa: {}, argo: [] };
  const ARGO = [];
  for (const [p, r] of SOZLUK.argo || []) { try { ARGO.push([new RegExp(p, 'giu'), r]); } catch (e) { /* bozuk kural */ } }

  // Görev kalıpları: "Follow Donnie" → "Donnie'yi takip et" (isim + Türkçe ek, internete gitmeden)
  const AD = "(\\p{Lu}\\p{L}+(?:[ -]\\p{Lu}\\p{L}+)?)";
  // Görev hedefi mi? Diyalogun altında boşlukla ayrı duran son blok görev hedefidir ("…worth my time." /
  // "Follow Moses"). Tek başına duran blok: emir kipiyle başlıyor, kısa ve kişi zamiri yoksa hedef sayılır.
  const OBJ_VERB = new RegExp('^(go|head|drive|get|follow|tail|chase|find|locate|lose|evade|escape|collect|pick|grab|take|' +
    'deliver|steal|park|return|reach|enter|leave|buy|purchase|change|land|fly|shoot|kill|destroy|defend|protect|rescue|' +
    'meet|talk|speak|call|text|answer|use|hide|search|investigate|stay|avoid|survive|hack|climb|swim|ride|board|' +
    'place|plant|stow|bring|load|unload|tow|catch|wake|drop|select|equip|eliminate|defeat|clear|exit|inspect|sell|rob|' +
    'cross|track|retrieve|recover|sneak|crouch|ascend|descend|swap|switch|spray|refuel|repair|investigate|' +
    'beat|win|finish|complete|wait|watch|overtake|outrun|race|ram|join|rent|register|sign|start|open|check|break|' +
    'jump|pass|perform|photograph|record|wear|try|visit|withdraw|deposit|pay|order|dance|signal)\\b', 'i');
  // Görev satırının ilk harfi kesik okunduysa ("ollow Meses" → "Follow Moses"): satır küçük harfle
  // başlıyor ve ilk kelime bilinen bir görev fiilinin baş harfsiz hali (gerçek İngilizce kelime değil)
  const OBJ_KESIK = {"ollow":"follow","ocate":"locate","vade":"evade","ollect":"collect","eliver":"deliver","eturn":"return",
    "nter":"enter","urchase":"purchase","hange":"change","estroy":"destroy","efend":"defend","rotect":"protect","escue":"rescue",
    "nswer":"answer","nvestigate":"investigate","urvive":"survive","oard":"board","nload":"unload","liminate":"eliminate",
    "efeat":"defeat","xit":"exit","nspect":"inspect","etrieve":"retrieve","ecover":"recover","neak":"sneak","rouch":"crouch",
    "scend":"ascend","escend":"descend","efuel":"refuel","epair":"repair"};
  const OBJ_KESIK_OZEL = [[/^o to\b/, 'Go to'], [/^et (in|to|out|back|the|on|off|away)\b/, 'Get $1'],
    [/^rive (to|the|back|home)\b/, 'Drive $1'], [/^ead (to|back|home|over)\b/, 'Head $1']];
  // Görev satırlarındaki karakter adları: OCR bir harfi yanlış okursa ("Meses") düzelt
  const ADLAR = ['Jason', 'Lucia', 'Brian', 'Moses', 'Kenton', 'Tommy', 'Donnie', 'Vicki', 'Andy', 'Mattia', 'Boobie',
    'Raul', 'Wade', 'Billy', 'Frankie', 'Martin', 'Phillip', 'Johnny', 'Marcelo', 'Arnold', 'Peggy', 'Shirley', 'Mandy',
    'Mickey', 'Declan', 'Floyd', 'Wanda', 'Lori', 'Dunk', 'Doug', 'Kyle'];
  function birFark(a, b) { // tek harf değişikliği (aynı uzunluk)
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
    return d === 1;
  }
  function gorevOnar(text) {
    return text.split('\n').map((line) => {
      let l = line;
      const m = l.match(/^(\p{Ll}+)\b/u);
      if (m && OBJ_KESIK[m[1]]) { const v = OBJ_KESIK[m[1]]; l = v[0].toUpperCase() + v.slice(1) + l.slice(m[1].length); }
      else for (const [re, r] of OBJ_KESIK_OZEL) if (re.test(l)) { l = l.replace(re, r); break; }
      if (OBJ_VERB.test(l) && !OBJ_PRONOUN.test(l)) {
        l = l.replace(/\b\p{Lu}\p{Ll}{3,}\b/gu, (w) => ADLAR.find((a) => birFark(w, a)) || w);
      }
      return l;
    }).join('\n');
  }
  const OBJ_PRONOUN = /\b(i|i'm|i'll|me|my|we|we're|us|our|you|you're|your|ya)\b/i;
  function objectiveFlags(text) {
    const parts = text.split('\n');
    return parts.map((p, i) => {
      const t = p.trim(), words = t.split(/\s+/).length;
      if (/[?!]$/.test(t) || words > 14) return false;
      const gorev = (!!kalipLine(t) || (words <= 8 && OBJ_VERB.test(t))) && !OBJ_PRONOUN.test(t);
      // Diyalogun altındaki son blok: görev hedefiyse pembe ("Rent a vehicle at Rooster's Rentals"),
      // değilse ikinci konuşmacı → sarı
      if (parts.length > 1) return i === parts.length - 1 ? (gorev && !/[.,]$/.test(t) ? 'p' : 'y') : false;
      return gorev ? 'p' : false; // görev → pembe
    });
  }

  const KALIP = [];
  for (const [p, t] of SOZLUK.kalip || []) { try { KALIP.push([new RegExp(p.split('<AD>').join(AD), 'u'), t]); } catch (e) { /* bozuk kalıp */ } }
  function kalipLine(text) {
    const m0 = text.trim().match(/^(.*?)([.!?…]*)$/u);
    for (const [re, t] of KALIP) {
      const m = m0[1].match(re);
      if (!m) continue;
      const names = m.slice(1);
      if (names.some((n) => !n || n.split(/[ -]/).some((w) => NAME_SKIP.test(w)))) continue;
      names.forEach((n) => seenNames.add(n));
      return t.replace(/\{(\d)(?::([^}]+))?\}/g, (_, i, suf) => {
        const n = names[+i - 1] || '';
        return suf ? n + "'" + harmonize(n.split(/[ -]/).pop(), suf) : n;
      }) + m0[2];
    }
    return null;
  }

  // "Wait!" → "Bekle!" — sık geçen kısa replikler internete gitmeden, anında
  function shortLine(text) {
    const m = text.trim().match(/^(.*?)([.!?…]*)$/u);
    const key = m[1].toLowerCase().replace(/[,.!?…]/g, ' ').replace(/\s+/g, ' ').trim();
    const tr = SOZLUK.kisa && Object.prototype.hasOwnProperty.call(SOZLUK.kisa, key) ? SOZLUK.kisa[key] : null;
    return tr ? tr + m[2] : null;
  }

  // Google'ın yanlış anladığı argoyu düz İngilizceye çevir ("let's bounce" → "let's leave")
  function normalizeSlang(text) {
    return ARGO.reduce((t, [re, r]) => t.replace(re, (...a) => {
      let out = r.replace(/\$(\d)/g, (_, i) => (typeof a[+i] === 'string' ? a[+i] : ''));
      const first = (a[0].match(/\p{L}/u) || [''])[0];
      if (first && first !== first.toLowerCase()) out = out.replace(/\S/, (c) => c.toUpperCase());
      return out;
    }), text);
  }

  // ---------- Kalıcı önbellek: tekrar eden cümleler sonraki oturumlarda da anında gelir ----------
  const STORE_KEY = 'xctCeviriOnbellek';
  const CACHE_MAX = 20000; // uzun bir oyunun tüm diyaloglarına yeter (~3 MB)
  let saveTimer = null;
  try {
    chrome.storage.local.get(STORE_KEY, (o) => {
      const saved = (o && o[STORE_KEY]) || {};
      for (const k of Object.keys(saved)) if (!cache.has(k)) cache.set(k, saved[k]);
    });
  } catch (e) { /* önbellek olmadan da çalışır */ }
  // Hazır havuz bu betiğin içinde (ayrı belgeye mesaj gitmeden, <1 ms) ve önbellekten ÖNCE aranır:
  // havuzda düzeltilen bir cümlenin bellekte kalmış eski Google çevirisi böylece hiç gösterilmez.
  // ~600 KB; yalnızca çeviri ilk kez istendiğinde yüklenir (çerçevelerin çoğunda hiç yüklenmez).
  const HAVUZ = typeof XCT_HAVUZ !== 'undefined' ? XCT_HAVUZ : null; // havuz.js'teki const (globalThis'e düşmez)
  let havuzHazir = false, havuzYukleniyor = null;
  function havuzYukle() {
    if (!HAVUZ || havuzYukleniyor) return havuzYukleniyor;
    // Dosya sayfadan doğrudan okunamaz (Chrome "Unsafe attempt to load URL" der): servis çalışanından gelir
    havuzYukleniyor = send({ type: 'havuzVeri' })
      .then((r) => { if (r && r.ok && r.items) { HAVUZ.load(r.items); havuzHazir = HAVUZ.size > 0; } else havuzYukleniyor = null; })
      .catch(() => { havuzYukleniyor = null; });
    return havuzYukleniyor;
  }
  // Yaklaşık eşleşme: OCR aynı cümleyi bir iki harf farklı okusa da ("yeu"/"you") bellekteki çeviri kullanılır
  let fuzzyIndex = null, fuzzySize = -1;
  const fuzzyNorm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  function editRatio(a, b, limit) {
    const m = a.length, n = b.length;
    const maxD = Math.floor(Math.max(m, n) * limit);
    if (Math.abs(m - n) > maxD) return 1;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      let rowMin = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > maxD) return 1; // sınır aşıldı, devam etmeye gerek yok
      [prev, cur] = [cur, prev];
    }
    return prev[n] / Math.max(m, n);
  }
  function fuzzyCache(prefix, src) {
    const q = fuzzyNorm(src);
    if (q.length < 14) return null; // kısa cümlelerde bir harf bile anlamı değiştirir
    if (!fuzzyIndex || fuzzySize !== cache.size) {
      fuzzyIndex = [];
      for (const [k, v] of cache) if (k.startsWith(prefix)) fuzzyIndex.push([fuzzyNorm(k.slice(prefix.length)), v]);
      fuzzySize = cache.size;
    }
    // Kısa cümlede tek kelime farkı anlamı değiştirir ("cash"/"car"): eşik uzunlukla gevşer
    const limit = q.length >= 40 ? FUZZY_LIMIT : 0.06;
    let best = null, bestR = limit;
    for (const [n, v] of fuzzyIndex) {
      if (Math.abs(n.length - q.length) > q.length * limit) continue;
      const r = editRatio(q, n, limit);
      if (r < bestR) { bestR = r; best = v; if (r === 0) break; }
    }
    return best;
  }
  const FUZZY_LIMIT = 0.1;

  function saveCacheNow() {
    clearTimeout(saveTimer); saveTimer = null;
    try {
      const entries = [...cache.entries()].slice(-CACHE_MAX);
      chrome.storage.local.set({ [STORE_KEY]: Object.fromEntries(entries) });
    } catch (e) { /* eklenti yenilendiyse sessiz geç */ }
  }
  function persistCache() {
    // Kısa gecikmeyle toplu kaydet; sekme kapanırken/gizlenirken bekleyen kayıt hemen yazılır
    if (!saveTimer) saveTimer = setTimeout(saveCacheNow, 1500);
  }
  addEventListener('pagehide', () => { if (saveTimer) saveCacheNow(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) saveCacheNow(); });

  async function googleTranslate(text, raw) {
    // Önce hazır havuz (GTA 6 diyalogları, bkz. havuz.js), yoksa iki Google uç noktası offscreen belgede
    // yarışır (bkz. ceviri-ag.js); orada 3 sn sınırı var
    const r = await withTimeout(direct({ type: 'translate', text, raw, from: S.from, to: S.to }, 3500), 3800, 'Google çeviri');
    if (!r.ok) throw new Error(r.error);
    if (r.havuz) { havuzMetin.add(String(r.text).trim()); if (havuzMetin.size > 5000) havuzMetin.clear(); }
    if (!r.havuz && S.from === 'en' && S.to === 'tr') gta6Kaydet(raw || text, r.text);
    return r.text;
  }
  const havuzMetin = new Set(); // havuzdan gelen çeviriler DeepL'e sorulmaz

  // DeepL (açılır pencerede anahtar girildiyse): ekrandaki çeviriyi beklemez. Google'ınki gösterildikten
  // 0,7 sn sonra altyazı hâlâ ekrandaysa (OCR'ın yarım okumaları kota harcamasın) DeepL'e bir kez sorulur;
  // gelen çeviri önbelleğe ve GTA 6 kaydına yazılır, cümle bir dahaki sefere DeepL kalitesinde gelir.
  let deeplOn = false;
  const deeplSorulan = new Set();
  try {
    chrome.storage.local.get('xctDeeplKey', (o) => { deeplOn = !!(o && o.xctDeeplKey); });
    chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.xctDeeplKey) deeplOn = !!c.xctDeeplKey.newValue; });
  } catch (e) { /* sessiz */ }
  function deeplSonra(key, src, raw) {
    if (!deeplOn || S.to === S.from || deeplSorulan.has(key)) return;
    // OCR kırıntısı ("BAC I ol") kota harcamasın: en az 3 gerçek kelime (2+ harf) olsun
    if ((String(src).match(/\p{L}{2,}/gu) || []).length < 3) return;
    deeplSorulan.add(key);
    setTimeout(async () => {
      const r0 = String(raw || src).trim();
      if (!(lastSource && lastSource.includes(r0)) && !(liveShow && liveShow.tr.includes(r0)) && !(msgShown && msgShown.src.includes(r0)) && !(phoneShown && phoneShown.srcs.some((x) => smsAc(x).includes(r0) || x.includes(r0)))) { deeplSorulan.delete(key); return; }
      const r = await send({ type: 'deepl', text: src, from: S.from, to: S.to }).catch(() => null);
      if (!r || !r.ok || !r.text) { dbg({ deepl: 'hata', err: r && r.error }); return; }
      const t = r.text.trim();
      cache.set(key, t);
      persistCache();
      if (S.from === 'en' && S.to === 'tr') gta6Kaydet(raw || src, t);
      dbg({ deepl: 'ok', src, t });
      // Ekrandaki çeviri DEĞİŞTİRİLMEZ: okunurken yazının değişmesi rahatsız edici. DeepL çevirisi
      // önbelleğe yazılır; aynı cümle bir daha geldiğinde (ve havuz kaydında) DeepL'inki gösterilir.
    }, 300);
  }

  // GTA 6 kaydı: havuzda olmayıp Google'dan gelen her çeviri ayrıca saklanır. Açılır pencereden
  // "GTA 6 kaydını indir" ile dışa aktarılır, denetlenip havuza eklenir (havuz/kayit-ekle.js).
  const KAYIT_KEY = 'xctGta6Kayit', KAYIT_MAX = 50000;
  let kayit = null, kayitTimer = null;
  function gta6Kaydet(en, tr) {
    en = String(en || '').replace(/\s+/g, ' ').trim(); tr = String(tr || '').trim();
    if (!en || !tr || en.length > 400 || AD_TUT_RE.test(en)) return;
    const write = () => {
      if (kayit[en] === tr) return;
      kayit[en] = tr;
      if (!kayitTimer) kayitTimer = setTimeout(() => {
        kayitTimer = null;
        const keys = Object.keys(kayit);
        if (keys.length > KAYIT_MAX) for (const k of keys.slice(0, keys.length - KAYIT_MAX)) delete kayit[k];
        try { chrome.storage.local.set({ [KAYIT_KEY]: kayit }); } catch (e) { /* eklenti yenilendiyse sessiz geç */ }
      }, 3000);
    };
    if (kayit) { write(); return; }
    try {
      chrome.storage.local.get(KAYIT_KEY, (d) => { kayit = kayit || (d && d[KAYIT_KEY]) || {}; write(); });
    } catch (e) { /* sessiz */ }
  }

  async function builtinTranslate(text) {
    const t = await ensureBuiltin(false);
    if (!t) throw new Error('Chrome çevirmeni hazır değil — ÇEVİRİ düğmesine tıklayarak başlat');
    return withTimeout(t.translate(text), 3000, 'Chrome çevirisi');
  }

  // Otomatik: önce Google (daha doğal, argoyu daha iyi anlıyor), olmazsa cihaz içi Chrome çevirmeni
  // onLate: Google geç kaldığı için önce cihaz içi çeviri döndüyse, Google'ınki gelince çağrılır
  // ---------- Oyun adları (yer, marka) çevrilmesin ----------
  // "Los Santos Customs" → "Los Santos Gümrüğü", "Port Gellhorn" → "Gellhorn Limanı" olmasın: çeviriden önce ad, Google'ın
  // dokunmadığı uydurma bir isimle değiştirilir ("Zorvax'a götür"), sonra asıl ad geri yazılır, eki Türkçe ses uyumuna
  // göre düzeltilir ("Vice City'ye", "Leonida'nın"). Liste: sozluk.js → "adlar".
  const AD_TUT = ['Zorvax', 'Kelbrin', 'Drunvel', 'Quorix', 'Talvex', 'Morbek'];
  const AD_TUT_RE = /Zorvax|Kelbrin|Drunvel|Quorix|Talvex|Morbek/i;
  const YER_ADLARI = (SOZLUK.adlar || []).filter((n) => typeof n === 'string' && n.trim()).sort((a, b) => b.length - a.length).map((n) => {
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]");
    try { return [n, new RegExp('(?<![\\p{L}\\p{N}])(?:' + esc(n) + '|' + esc(n.toUpperCase()) + ')(?![\\p{L}\\p{N}])', 'gu')]; } catch (e) { return null; }
  }).filter(Boolean);
  function adKoru(text) {
    const map = [];
    let t = text;
    for (const [n, re] of YER_ADLARI) {
      if (!re.test(t)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      t = t.replace(re, (m) => {
        let i = map.indexOf(n);
        if (i < 0) { if (map.length >= AD_TUT.length) return m; i = map.length; map.push(n); }
        return AD_TUT[i];
      });
    }
    // Sosyal medya adları ve etiketler çevrilmez ("@Swampinator" → "@Bataklıkçı" olmasın)
    t = t.replace(/(?<![\p{L}\p{N}])[@#][\p{L}\p{N}_.]*\p{L}[\p{L}\p{N}_]*/gu, (m) => {
      let i = map.indexOf(m);
      if (i < 0) { if (map.length >= AD_TUT.length) return m; i = map.length; map.push(m); }
      return AD_TUT[i];
    });
    return { t, map };
  }
  // Uydurma ad ünsüzle bitiyor ("Zorvax'a"); asıl ad ünlüyle bitiyorsa kaynaştırma harfi gerekir ("City'ye", "Leonida'nın")
  function adEki(name, suf) {
    let s = suf.toLowerCase();
    if (/^[aeıioöuü]/.test(s)) s = (/^[ıiuü]n(?![aeıioöuü])/.test(s) ? 'n' : 'y') + s;
    return harmonize(name, s);
  }
  function adGeri(out, map) {
    if (!out) return null;
    for (let i = 0; i < map.length; i++) {
      const re = new RegExp(AD_TUT[i] + "(?:['’](\\p{L}+))?", 'giu');
      if (!re.test(out)) return null; // ad çeviride kayboldu → korumasız çevir
      re.lastIndex = 0;
      out = out.replace(re, (m, suf) => map[i] + (suf ? "'" + adEki(map[i], suf) : ''));
    }
    return out;
  }
  async function translate(text, onLate) {
    if (S.from !== 'en' || S.to !== 'tr' || !YER_ADLARI.length) return translateCore(text, onLate);
    const { t, map } = adKoru(text);
    if (!map.length) return translateCore(text, onLate);
    // Koruma yokken önceden çevrilmiş cümle Google'a yeniden sorulmaz
    // (@ad içeren eski kayıtlarda ad çevrilmiş olabilir: onlarda önbellek kısayolu yok)
    if (!/[@#]\p{L}/u.test(text) && (cache.has('en>tr:' + normalizeSlang(prepForMT(text))) || (havuzHazir && HAVUZ.lookup(text)))) return translateCore(text, onLate);
    const back = adGeri(await translateCore(t, onLate), map);
    if (back == null) return translateCore(text, onLate);
    gta6Kaydet(text, back);
    return back;
  }
  async function translateCore(text, onLate) {
    let src = prepForMT(text);
    if (S.from === 'en') {
      if (S.to === 'tr') { const hit = shortLine(src) || kalipLine(src); if (hit) return hit; }
      src = normalizeSlang(src);
    }
    const key = S.from + '>' + S.to + ':' + src;
    if (S.from === 'en' && S.to === 'tr') {
      if (havuzHazir) { const hit = HAVUZ.lookup(text); if (hit) return hit; } else havuzYukle();
    }
    if (cache.has(key)) return cache.get(key);
    const near = fuzzyCache(S.from + '>' + S.to + ':', src);
    if (near) { cache.set(key, near); persistCache(); return near; } // bu yazımı da hatırla: bir dahaki sefere tam eşleşme
    // Aynı cümle şu an çevriliyorsa ikinci kez Google'a sorma, aynı sonucu bekle
    let job = inflight.get(key);
    if (!job) {
      job = translateNet(key, src, text);
      inflight.set(key, job);
      job.finally(() => inflight.delete(key)).catch(() => {});
    }
    // Ağ yavaşsa beklemeden cihaz içi çeviriyi göster (~50 ms); Google'ınki gelince yerine geçer ve saklanır
    if (S.engine === 'auto' && translator) {
      const SLOW = Symbol('slow');
      const first = await Promise.race([job, new Promise((r) => setTimeout(() => r(SLOW), NET_PATIENCE))]).catch(() => SLOW);
      if (first !== SLOW) return first;
      try {
        const quick = ((await withTimeout(translator.translate(src), 1500, 'Chrome çevirisi')) || '').trim();
        if (quick) { if (onLate) job.then(onLate, () => {}); return quick; }
      } catch (e) { /* cihaz içi de olmadı → Google'ı bekle */ }
    }
    return job;
  }
  const NET_PATIENCE = 600; // Google bu kadar sürede gelmezse cihaz içi çeviri gösterilir
  const inflight = new Map();
  async function translateNet(key, src, raw) {
    const engines = S.engine === 'google' ? [googleTranslate]
      : S.engine === 'builtin' ? [builtinTranslate]
      : [googleTranslate, builtinTranslate];
    let lastErr = null;
    for (const fn of engines) {
      try {
        const out = ((await fn(src, raw)) || '').trim();
        if (out) {
          if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
          cache.set(key, out);
          persistCache();
          if (fn === googleTranslate && !havuzMetin.has(out.trim())) deeplSonra(key, src, raw);
          return out;
        }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Çeviri boş döndü');
  }

  // Her blok (diyalog, görev hedefi) ayrı çevrilir; böylece ikisi tek cümleye karışmaz
  function translateAll(text, onLate, fresh) {
    let late = false;
    const later = onLate ? () => { if (!late) { late = true; setTimeout(onLate, 0); } } : null;
    const flags = objectiveFlags(text);
    return Promise.all(text.split('\n').map((t, i) => {
      t = t.replace(/\s+[-–—]+\s*$/u, ''); // satır sonunda tek başına kalan "-" (OCR kırıntısı)
      // Az önce ekranda gösterilen satır yeniden çizilirse (ör. üstündeki diyalog kalktı) aynı çeviri
      // kullanılır: arada önbelleğe DeepL çevirisi yazılmış olsa bile ekrandaki yazı değişmesin
      // "Mmhmm…", "Hmm.", "Uh-huh" gibi mırıltılar çevrilmez (Google "Mıhmm…" yapıyor)
      if (MIRILTI.test(t)) return Promise.resolve(t);
      const now = performance.now(), seen = recentTr.get(t);
      if (!fresh && seen && now - seen.at < 90000) { seen.at = now; return Promise.resolve(seen.tr); }
      // "Chester! Shanese!": yalnızca büyük harfli tek kelimelerden oluşan seslenme. Google bütün satırı
      // çevirince isimleri bozuyor ("Şa nese"); her kelime tek başına çevrilince aynı kalıyorsa hepsi isimdir.
      const normal = () => translate(t, later).then((out) => keepNames(t, out)).then((out) => trDuzelt(out, flags[i] === 'p', t));
      let p;
      if (S.from === 'en' && /^(?:\p{Lu}\p{Ll}{2,}[!?,.…]*\s*){2,4}$/u.test(t)) {
        const ws = t.match(/\p{Lu}\p{Ll}+/gu);
        p = Promise.all(ws.map((w) => translate(w).then((x) => (x || '').trim().replace(/[.!?]+$/u, '').toLowerCase() === w.toLowerCase(), () => false)))
          .then((same) => {
            if (same.every(Boolean)) { ws.forEach((w) => seenNames.add(w)); return t; }
            return normal();
          });
      } else p = normal();
      return p
        .then((out) => {
          if (out) {
            recentTr.set(t, { tr: out, at: performance.now() });
            if (recentTr.size > 200) recentTr.delete(recentTr.keys().next().value);
          }
          return out;
        });
    })).then((a) => a.join('\n'));
  }
  const MIRILTI = /^(?:[\s.,!?…"'“”-]*(?:m+h*m+|m*h+m+|mm+-?hm+|uh+-?h?uh+|uh+-?uh+|u+m+|u+h+|e+r+m+|hm+-?mm*))+[\s.,!?…"'“”-]*$/i;
  const recentTr = new Map(); // son gösterilen satır → çevirisi (ekrandaki yazı sonradan değişmesin)
  // Çeviri sonrası küçük düzeltmeler:
  //  "Billy's'ten" → "Billy'den" (Google İngilizce iyelik ekini bırakıp üstüne Türkçe ek koyuyor)
  //  Görev satırı emir kipinde olmalı: "Billy'nin ekibinden birini yenmek" → "… yen"
  // Google "Okay!" → "Tamam aşkım!" gibi kaynakta olmayan hitap uyduruyor: kaynakta sevgi sözcüğü yoksa at
  const SEVGI_EN = /\b(love|lover|babe|baby|bae|honey|hun|darling|sweetheart|sweetie|sweety|dear|dearest|sugar|cutie|princess|angel|my girl|my boy)\b/i;
  const DUZELT = [];
  for (const [p, r] of SOZLUK.duzelt || []) { try { DUZELT.push([new RegExp(p, 'gu'), r]); } catch (e) { /* bozuk kural */ } }
  function trDuzelt(out, gorev, src) {
    if (!out) return out;
    for (const [re, r] of DUZELT) out = out.replace(re, r); // oyun terimleri: "aranan seviye" → "aranma seviyesi"
    if (src && !SEVGI_EN.test(src)) {
      out = out.replace(/,?\s+(aşkım|canım|bebeğim|tatlım|sevgilim)(?=[\s.!?,…]|$)/giu, '');
    }
    // Nokta/ünlemden sonra küçük harf kalmasın ("Hey. yani…"); üç nokta sonrası devamdır, dokunma
    out = out.replace(/(^|[^.…][.!?]\s+)(\p{Ll})/gu, (m, p, c) => p + c.toLocaleUpperCase('tr'));
    out = out.replace(/(\p{Lu}\p{L}+)['’]s['’](\p{L}+)/gu, (m, n, suf) => n + "'" + harmonize(n, suf));
    if (gorev && !/[.?!…]\s+\S/u.test(out)) {
      out = out.replace(/(\p{L}{2,})(m[ae]k)([.!]?)\s*$/u, (m, kok, _, p) => kok + p);
    }
    return out;
  }

  // ---------- İsimler çevrilmesin ("Follow Moses" → "Musa'yı takip et" değil "Moses'i takip et") ----------
  // Cümle ortasında büyük harfle başlayan kelime isimdir; çeviride kaybolduysa tek başına çevirisini
  // bulup yerine asıl ismi koy, ekini de Türkçe ses uyumuna göre düzelt.
  // Gerçekten çevrilmesi gerekenler hariç: günler, aylar, milliyetler, diller, "God", "Mom"…
  const NAME_SKIP = new RegExp('^(God|Lord|Jesus|Christ|Heaven|Hell|Mom|Mum|Mommy|Mama|Dad|Daddy|Papa|Sir|Madam|Mister|Mr|Mrs|Ms|Miss|' +
    'Doctor|Doc|Officer|Sergeant|Detective|Captain|Chief|Boss|Uncle|Aunt|Auntie|Grandma|Grandpa|Granny|' +
    'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|' +
    'September|October|November|December|Christmas|Easter|Halloween|Thanksgiving|English|Spanish|French|German|' +
    'Russian|Italian|Chinese|Japanese|Korean|Dutch|Greek|Turkish|Arabic|Irish|Scottish|British|Polish|Swedish|' +
    'Danish|Finnish|Thai|Swiss|Earth|Moon|Sun|North|South|East|West|Internet|Okay|Yes|No|Hey|Oh|Uh|Um|Hmm|Yeah)$', 'i');
  const NATIONALITY = /(ian|ean|can|ese|ish)$/i;
  const seenNames = new Set(); // bu oturumda cümle ortasında isim olarak geçenler ("Moses")
  function harmonize(name, suf) {
    let n = name.toLowerCase();
    let lastV = [...n].reverse().find((c) => 'aeiou'.includes(c)) || 'e';
    let endsVowel = /[aeiou]$/.test(n);
    // İngilizce okunuş: sondaki "e" okunmaz (Pete'i, Steve'i, Mike'ı); -son/-ton/-er/-or belirsiz "ı" (Jason'ın, Parker'ı)
    if (n.length >= 4 && /[^aeiouy]e$/.test(n) && /[aeiouy]/.test(n.slice(0, -2))) {
      endsVowel = false; n = n.slice(0, -1);
      lastV = /[iy][^aeiouy]$/.test(n) ? 'ı' : [...n].reverse().find((c) => 'aeiou'.includes(c)) || 'e';
      if (lastV === 'a') lastV = 'e';                                    // Dave → Deyv
    } else if (n.length >= 4 && /([sdt]on|er|or)$/.test(n)) lastV = 'ı';
    else if (/[^aeiou]y$/.test(n)) { endsVowel = true; lastV = 'i'; }   // Billy'yi, Kenny'ye
    else if (/[ae]y$/.test(n)) lastV = 'e';                              // Jay'i, Ray'e
    const back = 'aouı'.includes(lastV), round = 'ou'.includes(lastV);
    let s = suf.toLowerCase();
    if (!endsVowel && /^[yn][aeıioöuü]/.test(s)) s = s.slice(1);        // Musa'yı → Moses'i, Musa'nın → Moses'in
    else if (!endsVowel && /^yl/.test(s)) s = s.slice(1);              // Musa'yla → Moses'le
    s = s.replace(/[aeıioöuü]/g, (v) => ('ae'.includes(v) ? (back ? 'a' : 'e') : back ? (round ? 'u' : 'ı') : round ? 'ü' : 'i'));
    if (/[pçtkfhsş]$/.test(n)) s = s.replace(/^d/, 't');               // Moses'de → Moses'te
    else if (/^t[ae]n?$/.test(s)) s = 'd' + s.slice(1);                // Billy'ten → Billy'den
    return s;
  }
  async function keepNames(src, out) {
    if (S.from !== 'en' || !out) return out;
    const toks = src.split(/\s+/);
    const names = new Set();
    toks.forEach((t, i) => {
      const w = t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (!/^\p{Lu}\p{Ll}{2,}$/u.test(w) || NAME_SKIP.test(w) || NATIONALITY.test(w)) return;
      // Cümle başında isim olduğu bilinemez — daha önce cümle ortasında isim olarak geçtiyse bilinir
      if (i === 0 || /[.!?…:"”]$/.test(toks[i - 1])) { if (seenNames.has(w)) names.add(w); return; }
      names.add(w);
      seenNames.add(w);
    });
    for (const n of names) {
      if (out.toLowerCase().includes(n.toLowerCase())) continue;
      let tr;
      try { tr = (await translate(n)).trim().replace(/[.!?]+$/u, ''); } catch (e) { continue; }
      if (!tr || /\s/.test(tr) || tr.toLowerCase() === n.toLowerCase()) continue;
      const esc = tr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('(?<!\\p{L})' + esc + "(?:['’](\\p{L}+))?(?!\\p{L})", 'giu'),
        (m, suf) => n + (suf ? "'" + harmonize(n, suf) : ''));
    }
    return out;
  }

  // ---------- Ana döngü ----------
  let busy = false;
  let prevSig = null;
  let pending = true;          // yeni metin okunmayı bekliyor
  let pendingSince = 0;
  let stableTicks = 0;
  let lastSource = '';
  let emptyCount = 0;
  let errorCount = 0;
  let lastReadSig = null;      // en son OCR yapılan karenin parmak izi
  let mixedCaseSeen = 0;       // son altyazılar normal (küçük harfli) yazılıyor mu
  let changing = false;        // görüntü bir önceki karede de değişiyordu
  let freshAgain = false;      // ilk karede yapılan okuma zayıftı: değişim sürerken bir kez daha hemen oku
  let lastWarm = 0;
  // Boş okumada altyazıyı tut: parlak zeminde (gökyüzü, beton) OCR bir an hiçbir şey okuyamıyor ama
  // ekrandaki yazı pikselleri hâlâ yerinde. Bu durumda çeviri silinmez (titreme olmasın), en fazla 2,5 sn.
  const HOLD_MS = 2500;
  let shownSig = null;         // ekrandaki altyazının okunduğu kare
  let yokla = false;           // gösterilen yazı söndü: "yeni yazı yok" kısayolu atlanıp okunur
  let holdSince = 0;           // boş okumalar yüzünden tutmaya ne zaman başlandı

  function resetDetection() { prevSig = null; pending = true; stableTicks = 0; lastSource = ''; lastReadSig = null; }

  // a'daki yazı piksellerinin yüzde kaçı b'de hâlâ yanıyor (konturlu oyunda konturlu pikseller)
  function keptInkRatio(a, b) {
    if (!a || !b || a.values.length !== b.values.length) return 0;
    const useO = a.ovalues && b.ovalues;
    const A = useO ? a.ovalues : a.values, B = useO ? b.ovalues : b.values;
    let ink = 0, kept = 0;
    for (let i = 0; i < A.length; i++) if (A[i]) { ink++; if (B[i]) kept++; }
    return ink < 20 ? 0 : kept / ink;
  }

  function clearText() {
    lastSource = ''; shownSig = null; holdSince = 0; acceptedInk = 0;
    hideSubtitle(false);
  }

  async function tick() {
    if (orphaned || !S.enabled || busy || selecting) return;
    if (!alive()) { orphan(); return; }
    busy = true;
    try {
      await step();
      errorCount = 0;
    } catch (e) {
      // Tek seferlik hatalar oyunu bozmasın; üst üste gelirse kullanıcıya göster
      if (++errorCount >= 3) status('Hata: ' + String((e && e.message) || e), true);
      pending = true;
    } finally {
      busy = false;
    }
  }

  // OCR sonucunun ne kadar "gerçek İngilizce" olduğu: sözlükteki harfler artı, uydurma kelimeler eksi
  function ocrQuality(r) {
    let good = 0, bad = 0;
    for (const l of (r && r.lines) || []) {
      if ((l.confidence || 0) < 40) continue;
      for (const w of l.words || []) {
        const n = letterCount(w.text || '');
        if (n < 2) continue;
        if (w.known === false || w.confidence < 50) bad += n; else good += n * (w.confidence / 100);
      }
    }
    return { score: good - bad, ok: good >= 6 && good >= (good + bad) * 0.85 };
  }
  let outlinePref = 0; // >0: önce kontur modu (GTA), <0: önce düz mod
  // Kontur modu üst üste iyi okuduysa oyun konturlu yazı kullanıyor demektir (GTA): bundan sonra yalnızca
  // konturlu okuma yapılır. Düz okuma çakıl/beton zeminde 2–5 sn sürüyor ve bu sırada gelen satırlar kaçıyordu.
  let outlineGame = false, outlineHits = 0;
  function noteOutline(ok) { if (outlineGame) return; outlineHits = ok ? outlineHits + 1 : 0; if (outlineHits >= 3) outlineGame = true; }
  // Yazı değişirken en fazla bu kadar beklenir; sonra okunur (yarım okuma gösterilmez, durulunca yeniden okunur)
  const MAX_WAIT = 400;
  // Konturlu oyunda (GTA) okuma ~0,1 sn sürer: kamera hareket ederken (görüntü hep değişiyor) yeni satır
  // 0,4 sn beklemesin, 0,2 sn'de bir okunur
  const MAX_WAIT_OUTLINE = 200;

  // Gösterilen yazının imzadaki konturlu piksel sayısı (blok kutularının içinde)
  let acceptedInk = 0, acceptedBlocks = null, acceptedGeom = null; // kabul edilen yazının kutuları (mürekkep ölçümü için)
  function textInk(sig, blocks, geom) {
    if (!sig || !sig.ovalues || !sig.W || !geom || !geom.scale || !blocks) return 0;
    const k = sig.W / sig.sw / geom.scale, W = sig.W, H = sig.n / W;
    let c = 0;
    for (const b of blocks) {
      if (!b) continue;
      const m = (b.hRef || 10) * 0.3;
      const x0 = Math.max(0, Math.floor((b.x0 - geom.pad - m) * k)), x1 = Math.min(W - 1, Math.ceil((b.x1 - geom.pad + m) * k));
      const y0 = Math.max(0, Math.floor((b.top - geom.pad - m) * k)), y1 = Math.min(H - 1, Math.ceil((b.bottom - geom.pad + m) * k));
      for (let y = y0; y <= y1; y++) for (let x = x0, i = y * W + x0; x <= x1; x++, i++) c += sig.ovalues[i];
    }
    return c;
  }
  let liveShow = null, prevAccSrc = '', prevAccAt = 0, joinBase = ''; // önceki altyazı (cümle devamı için) // ekrandaki altyazı ve onu yeniden gösterme işlevi (DeepL gelince)
  let fragKey = '', fragCount = 0, fragTimer = 0, confirmTimer = 0, acceptedSig = null, confirmFor = ''; // üst üste okunan "parça" (yazının bir kısmı kalktı mı?)
  async function step() {
    const v = findVideo();
    if (v !== currentVideo) { currentVideo = v; resetDetection(); }
    if (!v) { status('Oyun videosu bekleniyor…', true); clearText(); return; }
    if (lastStatus === 'Oyun videosu bekleniyor…') status('');
    if (v.paused || document.hidden) return;

    const sig = signature(v);

    // Açık renk modunda bölgede parlak piksel yoksa altyazı yok demektir
    // Konturlu yazı okunan oyunda (GTA) dokulu zeminde konturlu piksel kalmadıysa altyazı bitmiştir
    const outlineGone = sig.ovalues && ocrGeom.outline && sig.obright / sig.n < MIN_INK;
    if (S.textMode === 'bright' && (sig.bright / sig.n < MIN_INK || outlineGone)) {
      prevSig = sig; pending = true; pendingSince = performance.now(); stableTicks = 0; lastReadSig = null; changing = false;
      if (++emptyCount >= 2) clearText();
      return;
    }
    emptyCount = 0;

    const d = sigDiff(prevSig, sig);
    prevSig = sig;
    const changeLimit = S.textMode === 'bright' ? 30 : 8;
    const now = performance.now();
    if (now - lastWarm > 15000) { lastWarm = now; direct({ type: 'netwarm' }, 3000); } // çeviri bağlantısı soğumasın
    let forced = false; // görüntü hâlâ değişirken, beklemekten vazgeçip okuyoruz
    if (d > changeLimit) {
      // Yeni bir değişim başladı ya da eski yazı sönerken okuma bitmişti (yeni satır sönmenin hemen
      // ardından geliyor): ikisinde de beklemeden oku
      const fresh = !changing || !pending || freshAgain;
      freshAgain = false;
      changing = true;
      if (!pending) { pending = true; pendingSince = now; }
      stableTicks = 0;
      // Konturlu oyunda (GTA) okuma ~0,1 sn: yeni yazının ilk karesinde hemen oku. İyi okunduysa hemen
      // gösterilir (çeviri de o an başlar), görüntü durulunca bir kez daha okunup gerekirse düzeltilir.
      // Diğer oyunlarda yazının belirmesi (daktilo efekti) beklenir, en fazla 0,4 sn.
      if (!(fresh && outlineGame) && now - pendingSince < (outlineGame ? MAX_WAIT_OUTLINE : MAX_WAIT)) return;
      forced = true;
    } else {
      changing = false;
      stableTicks++;
      // Gösterilen yazının bir satırı kalktıysa (kısa replik bitti, alttaki sürüyor) yeniden oku
      if (!pending && lastSource && satirKalkti(shownSig, sig)) { pending = true; pendingSince = now; dbg({ red: 'satır-kalktı' }); }
      // Gösterilen yazının mürekkebi çoğunlukla söndü ama değişim eşiği aşılmadı (dokulu/parlak zeminde altyazı
      // bitti, zemin pikselleri değişimi "küçük" gösteriyor): yeniden oku — boş çıkarsa çeviri kalkar
      else if (!pending && lastSource && shownSig && keptInkRatio(shownSig, sig) < 0.5) { pending = true; pendingSince = now; yokla = true; dbg({ red: 'mürekkep-söndü' }); }
    }
    if (!pending) return;
    // Geçiş anında okumamak için en az bir sabit kare bekle
    if (!forced && stableTicks < 1 && now - pendingSince < MAX_WAIT) return;
    // Açık renk modunda: ekranda yeni yazı yoksa (sadece eski yazı sönüyorsa) okuma
    // Ama yazının bir bloğu kalkıp geri kalanı duruyorsa ("Nope." / "It's the one…" → yalnız alttaki) yine oku:
    // yoksa kalkan satırın çevirisi ekranda kalır
    if (S.textMode === 'bright' && !yokla && lastReadSig && newInkRatio(lastReadSig, sig) < 0.12 && !blokKalkti(lastReadSig, sig) && !satirKalkti(shownSig, sig)) { pending = false; dbg({ red: 'yeni-yazı-yok' }); return; }
    yokla = false;
    // Sahne geçişinde (yazı yeni belirirken) yapılan zorunlu okuma yarım/bozuk olabilir: bu kare
    // "okundu" sayılmaz ve görüntü durulunca bir kez daha okunur — yoksa altyazı tamamen kaçar
    lastReadSig = forced ? null : sig;

    const T0 = performance.now(), tm = { since: Math.round(T0 - pendingSince), forced };
    const first = S.textMode === 'bright' && !sig.colored && outlinePref > 0;
    let r, qf;
    if (S.textMode === 'bright' && !sig.colored && sig.ovalues) {
      // Dokulu açık zemin (çakıl, beton): düz okuma burada hem çöp üretir hem de çok yavaştır (~2 sn).
      // Yalnızca konturlu okuma; o da hiçbir şey bulamazsa (konturu olmayan oyun) düz okumaya düş.
      r = await ocrImage(preprocess(v, false, true));
      tm.ocr = Math.round(performance.now() - T0); tm.path = 'doku';
      if (!r.ok) { if (/güncellendi/.test(r.error)) return; throw new Error('OCR: ' + r.error); }
      qf = ocrQuality(r);
      if (qf.ok) noteOutline(true);
      // Konturlu oyunda ya da geçiş anında yavaş düz okumaya düşülmez
      if (!qf.ok && qf.score < 3 && !outlineGame && !forced) {
        const keep = { prep: lastPrep, geom: ocrGeom };
        const r2 = await ocrImage(preprocess(v, false, false));
        const q2 = r2 && r2.ok ? ocrQuality(r2) : { score: -Infinity, ok: false };
        if (q2.score > qf.score + 3) { r = r2; qf = q2; } else { lastPrep = keep.prep; ocrGeom = keep.geom; }
        tm.plain = Math.round(performance.now() - T0);
      }
    } else if (S.textMode === 'bright' && !sig.colored) {
      // Düz ve konturlu okuma yarışır (iki OCR işçisi): ilk biten iyi okuduysa öbürü beklenmez
      const imgA = preprocess(v, false, first), pa = { prep: lastPrep, geom: ocrGeom };
      const imgB = preprocess(v, false, !first), pb = { prep: lastPrep, geom: ocrGeom };
      tm.prep = Math.round(performance.now() - T0);
      const run = (img, p, isFirst) => ocrImage(img).then((res) =>
        ({ res, p, isFirst, q: res.ok ? ocrQuality(res) : { score: -Infinity, ok: false } }));
      const jobs = [run(imgA, pa, true), run(imgB, pb, false)];
      let win = await Promise.race(jobs);
      if (!win.q.ok) {
        const [ja, jb] = await Promise.all(jobs);
        // Tercih edilen yol (öncekilerden öğrenilen) iyi okuduysa o; diğeri belirgin daha iyiyse diğeri
        const useB = (!ja.q.ok && jb.q.ok) || (ja.q.ok === jb.q.ok && jb.q.score > ja.q.score + 3);
        win = useB ? jb : ja;
        const jo = first ? ja : jb, jp = first ? jb : ja; // kontur / düz
        if (jp.q.ok && !jo.q.ok) noteOutline(false);
        if (ja.q.ok !== jb.q.ok || Math.abs(ja.q.score - jb.q.score) > 3) {
          const outlineWon = useB ? !first : first;
          outlinePref = Math.max(-3, Math.min(3, outlinePref + (outlineWon ? 1 : -1)));
        }
      }
      tm.ocr = Math.round(performance.now() - T0) - tm.prep; tm.path = win.isFirst ? 'ilk' : 'ikinci';
      r = win.res; qf = win.q;
      if (win.q.ok && win.isFirst === first) noteOutline(true); // kazanan kontur okumasıysa
      if (!r.ok) { if (/güncellendi/.test(r.error)) return; throw new Error('OCR: ' + r.error); }
      ({ prep: lastPrep, geom: ocrGeom } = win.p);
    } else {
      r = await ocrImage(preprocess(v, sig.colored, false));
      tm.ocr = Math.round(performance.now() - T0);
      if (!r.ok) { if (/güncellendi/.test(r.error)) return; throw new Error('OCR: ' + r.error); }
      qf = ocrQuality(r);
    }
    // Hâlâ zayıfsa aynı yolu biraz daha büyük ölçekle dene: OCR hataları ölçeğe göre değişir
    // ("Sounds easy eng ugh" ↔ "Sounds easy enough"); en iyi okunan seçilir
    // (geçiş anındaki zorunlu okumada ve hiç yazı yokken yapılmaz: kare zaten yarım, durulunca yeniden okunur)
    if (!qf.ok && !forced && qf.score >= 3) {
      const keep = { prep: lastPrep, geom: ocrGeom };
      const r3 = await ocrImage(preprocess(v, sig.colored, !!ocrGeom.outline, 1.35));
      const q3 = r3 && r3.ok ? ocrQuality(r3) : { score: -Infinity, ok: false };
      if (q3.score > qf.score) { r = r3; qf = q3; } else { lastPrep = keep.prep; ocrGeom = keep.geom; }
      tm.retry = Math.round(performance.now() - T0);
    }
    pending = forced;
    // Sahne geçişinde yapılan zorunlu okuma zayıfsa gösterme: görüntü durulunca yapılacak okumayı bekle
    // (yarım okunan satırın saçma çevirisi ekrana gelmesin)
    // Ama kamera sürekli hareket ederken (yarış, kovalamaca) her okuma "zorunlu"dur: zemin dokusundan
    // gelen kırıntılar puanı düşürür ve kısa replik ("Oh, that was a crash!") hiç gösterilmezdi.
    // Kırıntılar süzüldükten sonra kalan satır net okunmuş bilinen kelimelerden oluşuyorsa kabul et.
    let netSatir = false;
    if (forced && !qf.ok && qf.score < 15) {
      const ws = (pickLines(r).lines || []).flatMap((l) => l.words || []).filter((w) => letterCount(w.text) >= 2);
      const net = ws.filter((w) => w.known !== false && w.confidence >= 75);
      netSatir = net.length >= 3 && net.length >= ws.length * 0.8 && net.reduce((k, w) => k + letterCount(w.text), 0) >= 10;
    }
    if (forced && !qf.ok && qf.score < 15 && !netSatir) {
      // Kamera sürekli hareket ederken (motor, araba, koşu) her okuma "zorunlu"dur: altyazı bittiğinde gelen boş
      // okuma da burada eleniyordu ve eski çeviri saniyelerce ekranda kalıyordu. Okumada yazı yoksa ve gösterilen
      // yazının mürekkebi yarıdan fazla söndüyse altyazı bitmiştir: kaldır.
      if (lastSource && shownSig && keptInkRatio(shownSig, sig) < 0.5 && !cleanText(pickLines(r))) {
        dbg({ ...tm, red: 'geçişte-bitti' });
        clearText();
      }
      pendingSince = performance.now(); stableTicks = 0; freshAgain = outlineGame;
      dbg({ ...tm, q: Math.round(qf.score), red: 'zayıf-geçiş', raw: (r.lines || []).map((l) => l.text).join(' / ').slice(0, 60) });
      return;
    }
    if (forced) { pendingSince = performance.now(); stableTicks = 0; }
    const picked = pickLines(r);
    await recoverColored(picked, lastPrep, ocrImage);
    let text = cleanText(picked);
    tm.read = Math.round(performance.now() - T0);
    tm.q = Math.round(qf.score); tm.mode = ocrGeom.outline ? 'kontur' : 'düz'; tm.text = text;
    const topFrac = picked.top;
    // Oyun altyazıları normal yazılıyken tek başına çıkan BÜYÜK HARF yazı arayüzdür ("NIPPER .38 PISTOL")
    const capsOnly = !!text && isCaps(text);
    // (OCR hiç harf görmediyse yazı gerçekten gitmiştir: kum/çakıl zemindeki parlak noktalar
    // "mürekkep yerinde" sanılıp eski çeviri saniyelerce ekranda kalıyordu)
    const harfGordu = (r.lines || []).some((l) => letterCount(l.text || '') >= 4 && (l.confidence || 0) >= 40);
    // Yazının kendi mürekkebi (kabul edilen satır kutularının içindeki konturlu pikseller) de yerinde olmalı:
    // asfalt/beton gibi açık-gri zeminde "parlak piksel yerinde" ölçüsü yazı gittikten sonra da yüksek kalıyor ve
    // eski çeviri 4 sn ekranda tutuluyordu
    const yaziYerinde = !(acceptedInk >= 15 && acceptedBlocks) || textInk(sig, acceptedBlocks, acceptedGeom) >= acceptedInk * 0.6;
    if (!text && lastSource && harfGordu && S.textMode === 'bright' && yaziYerinde && keptInkRatio(shownSig, sig) >= 0.75) {
      const tNow = performance.now();
      if (!holdSince) holdSince = tNow;
      if (tNow - holdSince < HOLD_MS) {
        // Yazı yerinde, okuma boş: altyazıyı bırakma, kısa süre sonra yeniden dene
        pending = true; lastReadSig = null;
        dbg({ ...tm, red: 'tut', raw: (r.lines || []).map((l) => l.text).join(' / ').slice(0, 60) });
        return;
      }
    }
    if (!text || (capsOnly && mixedCaseSeen >= 2)) {
      dbg({ ...tm, red: text ? 'büyük-harf' : 'boş', raw: (r.lines || []).map((l) => l.text).join(' / ').slice(0, 60) });
      // Gösterilen yazının mürekkebi çoğunlukla gittiyse (dokulu/parlak zeminde altyazı bitti) hemen kaldır:
      // aynı kare bir daha okunmayacağı için ikinci boş okumayı beklemek çeviriyi ekranda bırakıyordu
      if (++emptyCount >= 2 || (!text && shownSig && keptInkRatio(shownSig, sig) < 0.5)) clearText();
      return;
    }
    holdSince = 0; shownSig = sig;
    mixedCaseSeen = capsOnly ? Math.max(0, mixedCaseSeen - 1) : Math.min(3, mixedCaseSeen + 1);
    text = gorevOnar(text);
    const nt = norm(text), nl = norm(lastSource);
    // Altyazı belirirken yarım okunduysa ("Break into the" → "Break into the Montagne", "a natural." →
    // "Oh, guess I'm a natural.") tamamı gelince yeniden çevir: benzer sayılıp yarım çeviri ekranda kalmasın
    const uzadi = nl.length >= 4 && nt.length >= nl.length + 3 && nt.includes(nl);
    // Doğrulama okuması yalnızca eksik okunan altyazıyı tamamlar ("uzadı"); harf farkı yüzünden
    // yeniden çevirip ekrandaki yazıyı değiştirmez (görüntü değişmediyse)
    // Bloklardan biri kalktı, kalanlar aynı (sönen eski replik "Shut up…" ilk okumaya karışmıştı ya da
    // diyalog bitti, görev kaldı): kalanları göster. Kalan satırların çevirisi değişmez (recentTr).
    // Yazı gerçekten azaldıysa hemen, değilse 2 tutarlı okumadan sonra.
    let blokEksildi = false;
    {
      const tb = text.split('\n').map(norm), lb = lastSource ? lastSource.split('\n').map(norm) : [];
      if (tb.length < lb.length && tb.every((b) => b && lb.some((x) => x === b || similar(x, b)))) {
        const inkDrop = acceptedSig && sig.bright < acceptedSig.bright * 0.9;
        fragCount = fragKey === nt ? fragCount + 1 : 1; fragKey = nt;
        if (!inkDrop && fragCount < 2) {
          dbg({ ...tm, red: 'blok-eksildi-bekle' });
          clearTimeout(fragTimer);
          fragTimer = setTimeout(() => { if (fragKey === nt) { pending = true; lastReadSig = null; } }, 300);
          return;
        }
        blokEksildi = true; confirmFor = '';
      }
    }
    if (!blokEksildi && confirmFor && confirmFor === lastSource) {
      const still = acceptedSig && sigDiff(acceptedSig, sig) <= changeLimit;
      confirmFor = '';
      if (!uzadi && still) { dbg({ ...tm, red: 'doğrulama-aynı' }); return; }
    }
    if (!blokEksildi && !uzadi && !blokDegisti(text, lastSource)) {
      if (similar(text, lastSource)) { fragKey = ''; dbg({ ...tm, red: 'aynı' }); return; }
      // Önceki altyazının bir parçasıysa (yarım okuma) yeni altyazı sayma
      // (diyalog bitip sadece görev hedefi kaldıysa — daha az blok — bu yeni bir durumdur)
      const fewerBlocks = text.split('\n').length < lastSource.split('\n').length;
      const parca = nl && !fewerBlocks && nt.length < nl.length && nl.includes(nt);
      // Sahne değişirken aynı altyazı tekrar (kısmen bozuk) okunduysa yeni altyazı sayma
      if (parca || sameSubtitle(text, lastSource)) {
        // Ama aynı "parça" üst üste okunuyorsa yarım okuma değildir: yazının bir kısmı gerçekten
        // kalktı ("Not owned" + "Leave the store" → yalnız "Leave the store"). Eski çeviri ekranda
        // kalmasın: kısa aralıkla yeniden oku, 3 kez aynı çıkarsa yeni altyazı say.
        fragCount = fragKey === nt ? fragCount + 1 : 1; fragKey = nt;
        // Yalnızca ekrandaki yazı gerçekten azaldıysa (parlak piksel düştü): kötü bir yeniden okuma
        // iyi çeviriyi eksik olanla değiştirmesin
        // Ölçüm kabul edilen yazının kutularında yapılır: başka bir satırın (kısa replik) kalkması, kalan
        // satırın eksik okunmasını ("t's the one, the ony." → "t's the one, the") haklı çıkarmasın
        const inkDrop = acceptedSig && (acceptedInk >= 15 && acceptedBlocks
          ? textInk(sig, acceptedBlocks, acceptedGeom) < acceptedInk * 0.85
          : sig.bright < acceptedSig.bright * 0.85);
        if (!inkDrop) { dbg({ ...tm, red: parca ? 'parça' : 'benzer' }); return; }
        if (fragCount < 3) {
          dbg({ ...tm, red: 'parça-bekle' });
          clearTimeout(fragTimer);
          fragTimer = setTimeout(() => { if (fragKey === nt) { pending = true; lastReadSig = null; } }, 450);
          return;
        }
      }
    }
    fragKey = '';
    lastSource = text; acceptedSig = sig; acceptedInk = textInk(sig, lastBlocks, ocrGeom); acceptedBlocks = lastBlocks.slice(); acceptedGeom = ocrGeom && { ...ocrGeom };
    // Doğrulama okuması: yeni altyazı bir kez daha okunur. Açık zeminde (kum, gökyüzü) ilk okuma
    // kelime yutabiliyor ("Alright, guys, get in there." → "Alright, guys,"); tamamı okununca
    // "uzadı" kuralıyla yeniden çevrilir. Aynı çıkarsa hiçbir şey değişmez (çeviri önbellekten).
    if (!forced) {
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { if (lastSource === text) { pending = true; lastReadSig = null; confirmFor = text; } }, 350);
    }
    const blocks = lastBlocks;
    blocks.geom = { ...ocrGeom };
    // Çeviri arka planda: OCR döngüsü beklemez, ağ yavaşken gelen yeni altyazı da kaçmaz
    noteTextTop(topFrac, picked.lineFrac);
    const obj = objectiveFlags(text);
    // GTA uzun cümleyi iki altyazıya böler ("And I thought you were just out there" /
    // "selling liquor to locals when you were in the army."). Devam satırı küçük harfle başlıyor ve
    // önceki parça noktalamasız bittiyse ikisi birlikte çevrilir: tek başına çevrilen parçalar anlamsız.
    const tNow = performance.now();
    if (!uzadi) joinBase = prevAccSrc && tNow - prevAccAt < 8000 ? prevAccSrc : '';
    const join = joinBase && !text.includes('\n') && !joinBase.includes('\n') &&
      /^\p{Ll}/u.test(text.trim()) && !/[.!?…"”]$/.test(joinBase.trim());
    const trText = join ? joinBase.trim() + ' ' + text.trim() : text;
    prevAccSrc = trText; prevAccAt = tNow;
    const show = (t) => { if (lastSource === text && S.enabled && t) { textTopFrac = topFrac; showSubtitle(t, blocks, obj); } };
    liveShow = { text, tr: trText, show };
    const T1 = performance.now();
    // Google geç kalıp önce cihaz içi çeviri gösterildiyse, Google'ınki gelince onunla değiştir
    const upgrade = () => { if (lastSource === text) translateAll(trText, null, true).then(show, () => {}); }; // cihaz içi → Google
    translateAll(trText, upgrade).then((t) => { tm.tr = Math.round(performance.now() - T1); tm.total = Math.round(performance.now() - T0 + tm.since); tm.join = join; dbg(tm); show(t); }, () => {
      show(text); // çeviri gelmezse en azından orijinal yazı ekranda kalsın
      setTimeout(() => {
        if (lastSource !== text) return;
        translateAll(trText).then((t) => { show(t); if (lastStatus.startsWith('Çeviri')) status(''); },
          (e) => { if (lastSource === text) status('Çeviri yapılamadı: ' + String((e && e.message) || e), true); });
      }, 800);
    });
  }

  // ---------- Telefon mesajları (sağ alttaki açık renk kutu) ----------
  // Altyazıdan tamamen ayrı: kendi bölgesi, kendi OCR işçisi (ikinci işçi; altyazı okumasını bekletmez),
  // kendi gösterimi (sarı, kutunun hemen üstünde). Kutu görünürken o alan altyazı okumasında maskelenir:
  // mesaj metni ("$5k - hit the target…") altyazı sanılmaz. Koyu yazı + açık zemin aranır.
  const MSG_REGION = { x: 0.765, y: 0.58, w: 0.228, h: 0.41 };
  const msgSigCanvas = document.createElement('canvas');
  const msgSigCtx = msgSigCanvas.getContext('2d', { willReadFrequently: true });
  const msgCanvas = document.createElement('canvas');
  const msgCtx = msgCanvas.getContext('2d', { willReadFrequently: true });
  // var: imza/çeviri kodu bu satırdan önce çalışsa da güvenli (undefined = mesaj yok)
  var msgBusy = false, msgLastSig = null, msgMiss = 0, msgShown = null, msgMask = null, msgLastOcr = 0;

  function msgRect(v) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const sx = Math.round(MSG_REGION.x * vw), sy = Math.round(MSG_REGION.y * vh);
    return { sx, sy, sw: Math.max(8, Math.min(vw - sx, Math.round(MSG_REGION.w * vw))), sh: Math.max(8, Math.min(vh - sy, Math.round(MSG_REGION.h * vh))) };
  }
  // Mesaj kutusu görünürken altyazı görüntüsünde o alanı boya (yazı sayılmasın)
  function maskMsg(ctx, sx, sy, k, pad, color) {
    const list = msgMask ? [msgMask] : [];
    // Sağ alttaki tuş ipuçları ("SELECT Ⓐ / BACK Ⓑ / EXIT Ⓑ") hiçbir zaman altyazı değildir (altyazı ortalıdır)
    const vv = currentVideo;
    if (S.msgOn && vv && vv.videoWidth) {
      list.push({ x0: vv.videoWidth * 0.85, y0: vv.videoHeight * 0.78, x1: vv.videoWidth, y1: vv.videoHeight });
      // Sağ alttaki arama/mesaj bildirimi ("Brian · Call Ended"): altyazı satırına "Brian" eklenmesin (altyazı x≤~0,72)
      list.push({ x0: vv.videoWidth * 0.77, y0: vv.videoHeight * 0.86, x1: vv.videoWidth, y1: vv.videoHeight });
    }
    if (phoneMasks) list.push(...phoneMasks);
    if (!list.length) return;
    ctx.fillStyle = color;
    for (const m of list) ctx.fillRect(pad + (m.x0 - sx) * k, pad + (m.y0 - sy) * k, (m.x1 - m.x0) * k, (m.y1 - m.y0) * k);
  }
  // r yarıçaplı en parlak komşu (localMin'in tersi)
  function localMax(src, tmp, out, W, H, r) {
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let m = 0;
        for (let xx = Math.max(0, x - r), e = Math.min(W - 1, x + r); xx <= e; xx++) if (src[o + xx] > m) m = src[o + xx];
        tmp[o + x] = m;
      }
    }
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let m = 0;
        for (let yy = Math.max(0, y - r), e = Math.min(H - 1, y + r); yy <= e; yy++) if (tmp[yy * W + x] > m) m = tmp[yy * W + x];
        out[o + x] = m;
      }
    }
  }
  // Koyu yazı pikseli: yanında açık, renksize yakın zemin var (mesaj kutusu)
  // colorCut: bu doygunluğun üstündeki renkli pikseller yazı sayılmaz (mesaj kutusu: yayın logosu gibi kırmızı/pembe
  // çıkartmalar kutuya binince harf gibi okunmasın). Telefonda kullanılmaz: mavi baloncuktaki beyaz yazı korunur.
  function msgInk(ctx, W, H, r, colorCut) {
    const d = ctx.getImageData(0, 0, W, H).data, n = W * H;
    const L = new Uint8Array(n), S2 = new Uint8Array(n), tmp = new Uint8Array(n), mx = new Uint8Array(n), C = colorCut ? new Uint8Array(n) : null;
    for (let p = 0, i = 0; p < n; p++, i += 4) { L[p] = lum(d, i); const sa = sat(d, i); S2[p] = sa <= 40 && L[p] >= 115 ? L[p] : 0; if (C && sa > colorCut && L[p] >= 60) C[p] = 1; }
    localMax(S2, tmp, mx, W, H, r);
    const ink = new Uint8Array(n);
    let k = 0, bg = 0, run = 0;
    for (let p = 0; p < n; p++) { if (S2[p]) bg++; if (mx[p] >= 115 && mx[p] - L[p] >= 55 && !(C && C[p])) { ink[p] = 1; k++; } }
    // En uzun kesintisiz açık zemin şeridi (kutunun satır arası boşluğu); küçük etiket/filigran bunu geçemez
    for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) { c = S2[y * W + x] ? c + 1 : 0; if (c > run) run = c; } }
    return { ink, k, n, bg: bg / n, run: run / W };
  }
  function msgSignature(v, r) {
    const W = 120, H = Math.max(8, Math.round((W * r.sh) / r.sw));
    if (msgSigCanvas.width !== W || msgSigCanvas.height !== H) { msgSigCanvas.width = W; msgSigCanvas.height = H; }
    msgSigCtx.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
    const { ink, k, n, bg, run } = msgInk(msgSigCtx, W, H, 2, 90);
    return { ink, ratio: k / n, k, bg, run };
  }
  function msgSigDiff(a, b) {
    let d = 0;
    for (let p = 0; p < a.ink.length; p++) if (a.ink[p] !== b.ink[p]) d++;
    return d / Math.max(1, a.k, b.k);
  }
  function msgPrep(v, r) {
    const scale = Math.min(3, Math.max(1, 1000 / r.sw)), PAD = 10;
    const W = Math.round(r.sw * scale), H = Math.round(r.sh * scale);
    msgCanvas.width = W + PAD * 2; msgCanvas.height = H + PAD * 2;
    msgCtx.fillStyle = '#fff'; msgCtx.fillRect(0, 0, msgCanvas.width, msgCanvas.height);
    msgCtx.imageSmoothingQuality = 'high';
    msgCtx.drawImage(v, r.sx, r.sy, r.sw, r.sh, PAD, PAD, W, H);
    const img = msgCtx.getImageData(PAD, PAD, W, H);
    // Yazı siyah, geri kalan her şey beyaz
    const tmpCtx = { getImageData: () => img };
    const { ink } = msgInk(tmpCtx, W, H, Math.max(2, Math.round(scale * 2)), 90);
    const d = img.data;
    for (let p = 0, i = 0; p < ink.length; p++, i += 4) { const c = ink[p] ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255; }
    msgCtx.putImageData(img, PAD, PAD);
    return { url: msgCanvas.toDataURL('image/png'), scale, PAD, r };
  }
  // OCR satırlarından gönderen + mesaj gövdesi
  function msgParse(lines, prep) {
    const good = [];
    for (const l of lines || []) {
      const ws = (l.words || []).filter((w) => w.confidence >= 45 && /\p{L}/u.test(w.text));
      if (!ws.length) continue;
      const letters = ws.reduce((n, w) => n + letterCount(w.text), 0);
      const okLetters = ws.filter((w) => w.known !== false || /^\p{Lu}/u.test(w.text)).reduce((n, w) => n + letterCount(w.text), 0);
      if (letters < 3 || okLetters < letters * 0.6) continue;
      good.push({ ws, text: ws.map((w) => w.text).join(' '), y0: Math.min(...ws.map((w) => w.y0)), x0: Math.min(...ws.map((w) => w.x0)) });
    }
    if (!good.length) return null;
    good.sort((a, b) => a.y0 - b.y0);
    const usedWs = good.flatMap((g) => g.ws); // kutu sınırı yalnızca gerçek metin satırlarından (simgeler hariç)
    let sender = '';
    const first = good[0];
    if (good.length > 1 && first.ws.length <= 3 && /^\p{Lu}/u.test(first.ws[0].text)) {
      sender = first.ws.filter((w) => /^\p{Lu}[\p{L}'.-]+$/u.test(w.text)).map((w) => w.text).join(' ');
      good.shift();
    }
    // Gönderen adı yoksa gerçek mesaj kutusu değil (ya da kutu daha belirmekte): gösterme
    if (!sender || !good.length) return null;
    // Mesaj satırları kutunun sol kenarından başlar; sağa kaymış tek kelimelik satır yanıt göstergesidir ("→ Lucia")
    const minX = Math.min(...good.map((g) => g.x0)), tol = msgCanvas.width * 0.06;
    // Tek kelimelik satırlar (yanıt göstergesi "→ Lucia", tik işaretleri) mesaj değildir
    const bodyLines = good.filter((g) => g.x0 <= minX + tol || g.ws.length > 3); // "→ Brian" (avatarla 2-3 kelime okunabilir)
    let body = bodyLines.map((g) => g.text).join(' ')
      .replace(/(\p{L})- (\p{L})/gu, '$1$2').replace(/\s+/g, ' ').trim()
      // Baştaki simge kırıntısı ("a Meet here." → "Meet here.")
      .replace(/^(?:[a-z]\s+)+(?=\p{Lu})/u, '');
    // Kutu sağdan kesilmiş (yayın logosu / önizleme): "Bring a" gibi yarım biten cümle → "Bring a…"
    if (/\b(a|an|the|to|of|for|my|your|his|her|our|their|some|and|with|in|on|at)$/i.test(body)) body += '…';
    if ((body.match(/\p{L}{2,}/gu) || []).length < 3) return null;
    // Gerçek mesaj mı? 3+ harfli kelimelerin çoğu sözlükte olmalı (arama göstergesi, HUD kırıntısı elenir)
    const bodyWs = bodyLines.flatMap((g) => g.ws).filter((w) => letterCount(w.text) >= 3);
    const knownN = bodyWs.filter((w) => w.known === true).length;
    if (knownN < 3 || knownN < bodyWs.length * 0.6) return null;
    const all = usedWs;
    const toV = (x, y) => ({ x: prep.r.sx + (x - prep.PAD) / prep.scale, y: prep.r.sy + (y - prep.PAD) / prep.scale });
    const a = toV(Math.min(...all.map((w) => w.x0)), Math.min(...all.map((w) => w.y0)));
    const b = toV(Math.max(...all.map((w) => w.x1)), Math.max(...all.map((w) => w.y1)));
    return { sender, body, box: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } };
  }
  // SMS kısaltmalarını aç: "b4", "2gether", "yr" çeviriyi bozmasın
  const SMS = [
    [/\bb4\b/gi, 'before'], [/\b2gether\b/gi, 'together'], [/\b2day\b/gi, 'today'], [/\b2nite\b/gi, 'tonight'],
    [/\b2moro\b/gi, 'tomorrow'], [/\bgr8\b/gi, 'great'], [/\bl8r\b/gi, 'later'], [/\byr\b/gi, 'your'], [/\bur\b/gi, 'your'],
    [/\bu\b/g, 'you'], [/\br\b/g, 'are'], [/\bthx\b/gi, 'thanks'], [/\bpl[sz]\b/gi, 'please'], [/\bfck(in|ing)?\b/gi, 'fuck$1'],
    [/\bcuz\b/gi, 'because'], [/\bbc\b/gi, 'because'], [/\bw\/(?=\s)/gi, 'with'], [/\bmsg\b/gi, 'message'], [/\btxt\b/gi, 'text'],
    [/\bidk\b/gi, "I don't know"], [/\bimo\b/gi, 'in my opinion'], [/\bomw\b/gi, 'on my way'], [/\bbtw\b/gi, 'by the way'],
    [/\b(W)ere (in|gonna|going|not|good|done|here|there|ready|all|square|even|cool)\b/g, "$1e're $2"],
  ];
  function smsAc(t) { for (const [re, to] of SMS) t = t.replace(re, to); return t; }
  function msgHide() {
    msgShown = null; msgMask = null; msgLastSig = null;
    ui.msg.classList.remove('show');
  }
  function msgLayout(v, c) {
    if (!msgShown || !v || !v.videoWidth) return;
    c = c || contentRect(v);
    const kx = c.width / v.videoWidth, ky = c.height / v.videoHeight;
    const b = msgShown.box, vw = v.videoWidth;
    const fontPx = Math.round(Math.min(40, Math.max(12, (S.fontSize * c.height) / 720 * 0.72)));
    ui.msg.style.fontSize = fontPx + 'px';
    const right = Math.max(4, window.innerWidth - (c.left + Math.min(vw, b.x1 + vw * 0.012) * kx));
    ui.msg.style.right = right + 'px';
    ui.msg.style.left = 'auto';
    ui.msg.style.maxWidth = Math.max(220, (b.x1 - b.x0 + vw * 0.03) * kx * 1.1) + 'px';
    ui.msg.style.bottom = (window.innerHeight - (c.top + b.y0 * ky) + fontPx * 0.9) + 'px';
    ui.msg.style.top = 'auto';
  }
  function msgShow(v, parsed, tr) {
    msgShown = { src: parsed.body, sender: parsed.sender, tr, box: parsed.box };
    ui.msg.textContent = '';
    if (parsed.sender) { const b = document.createElement('b'); b.textContent = parsed.sender + ': '; ui.msg.append(b); }
    ui.msg.append(tr);
    msgLayout(v);
    ui.msg.classList.add('show');
  }
  async function msgStep(v) {
    if (msgBusy || !S.msgOn || S.from !== 'en' || !v || !v.videoWidth) return;
    if (phoneOk && phoneBox) { if (msgShown) msgHide(); return; } // telefon elde açıkken mesaj kutusu çıkmaz; ekranı telefon okuyucusu çevirir
    msgBusy = true;
    try {
      const r = msgRect(v);
      const sg = msgSignature(v, r);
      // Kutu yok (koyu yazı yok)
      // Kutu yok: koyu yazı yok ya da açık renk düz zemin yok (kutu bölgenin en az ~%10'u)
      if (sg.ratio < 0.006 || sg.bg < 0.1 || sg.run < 0.45) { if ((msgShown || msgMask) && ++msgMiss >= 2) msgHide(); msgLastSig = null; return; }
      msgMiss = 0;
      if (msgLastSig && msgSigDiff(sg, msgLastSig) < 0.2) return; // değişmedi
      // Altyazıya öncelik: mesaj OCR'ı en sık 0,5 sn'de bir (OCR havuzunda boş işçi altyazıya kalır)
      const now = performance.now();
      if (now - msgLastOcr < 500) return;
      msgLastOcr = now;
      msgLastSig = sg;
      const prep = msgPrep(v, r);
      const res = await ocrImage(prep.url);
      if (!res || !res.ok) return;
      const parsed = msgParse(res.lines, prep);
      if (!parsed) return;
      const vw = v.videoWidth, vh = v.videoHeight, b = parsed.box;
      msgMask = { x0: Math.max(0, b.x0 - vw * 0.025), y0: Math.max(0, b.y0 - vh * 0.035),
        x1: Math.min(vw, b.x1 + vw * 0.02), y1: Math.min(vh, b.y1 + vh * 0.06) };
      if (msgShown && similar(msgShown.src, parsed.body)) { msgShown.box = b; msgLayout(v); return; }
      dbg({ msg: parsed.body, sender: parsed.sender });
      const tr = await translate(smsAc(parsed.body));
      if (tr && S.enabled) msgShow(v, parsed, tr);
    } catch (e) { /* mesaj okunamadı: altyazıyı etkilemesin */ } finally { msgBusy = false; }
  }
  setInterval(() => {
    if (orphaned || !S.enabled || selecting) { if (msgShown) msgHide(); return; }
    const v = currentVideo;
    if (v && v.seeking) { if (msgShown) msgHide(); return; } // video sarıldı: eski mesaj çevirisi kalmasın
    if (!v || v.paused || document.hidden) return;
    msgStep(v);
  }, 250);

  // ---------- Sol üstteki ipucu / bildirim kutusu ----------
  // ("You can hold (◐) and press (Ⓑ) to switch characters.") Koyu yarı saydam kutuda beyaz yazı. Altyazıdan
  // tamamen ayrı: kendi bölgesi, en sık 0,6 sn'de bir OCR; çeviri kutunun hemen altına yazılır.
  // Kutudaki tuş simgeleri OCR'da kırıntı olur: harfsiz/sözlükte olmayan kısa kelimeler atılır, kalan
  // "hold and press to" kalıbını sözlük "düğmeleri" diye düzeltir.
  const HINT_REGION = { x: 0.0, y: 0.1, w: 0.34, h: 0.45 };
  const hintSigCanvas = document.createElement('canvas');
  const hintSigCtx = hintSigCanvas.getContext('2d', { willReadFrequently: true });
  const hintCanvas = document.createElement('canvas');
  const hintCtx = hintCanvas.getContext('2d', { willReadFrequently: true });
  var hintBusy = false, hintLastSig = null, hintMiss = 0, hintShown = null, hintLastOcr = 0, hintSeen = '', hintSeenN = 0;
  function hintRect(v) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const sx = Math.round(HINT_REGION.x * vw), sy = Math.round(HINT_REGION.y * vh);
    return { sx, sy, sw: Math.max(8, Math.round(HINT_REGION.w * vw)), sh: Math.max(8, Math.round(HINT_REGION.h * vh)) };
  }
  // Beyaz yazı pikseli: parlak, renksiz ve hemen yanında belirgin koyu zemin (kutunun içi)
  function hintInk(ctx, W, H, r) {
    const d = ctx.getImageData(0, 0, W, H).data, n = W * H;
    const L = new Uint8Array(n), tmp = new Uint8Array(n), mn = new Uint8Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) L[p] = lum(d, i);
    localMin(L, tmp, mn, W, H, r);
    const ink = new Uint8Array(n);
    let k = 0;
    for (let p = 0, i = 0; p < n; p++, i += 4) if (L[p] >= 175 && sat(d, i) <= 45 && mn[p] <= 90 && L[p] - mn[p] >= 90) { ink[p] = 1; k++; }
    return { ink, k, n, mn };
  }
  function hintSignature(v, r) {
    const W = 140, H = Math.max(8, Math.round((W * r.sh) / r.sw));
    if (hintSigCanvas.width !== W || hintSigCanvas.height !== H) { hintSigCanvas.width = W; hintSigCanvas.height = H; }
    hintSigCtx.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
    const { ink, k, n } = hintInk(hintSigCtx, W, H, 2);
    return { ink, k, ratio: k / n };
  }
  // Satır satır en uzun "kutu" koşusu (koyu-renksiz zemin ya da yazı; kenar yumuşatmasından gelen kısa boşluklar
  // tolere edilir). Üst üste binen uzun koşular kutuyu verir; içinde en çok yazı olan grup seçilir.
  function hintBox(d, ink, mn, W, H, gap, minW, minH) {
    const runs = new Array(H);
    for (let y = 0; y < H; y++) {
      let best = null, a = -1, last = -1;
      for (let x = 0; x <= W; x++) {
        let m = false;
        if (x < W) { const p = y * W + x, i = p * 4; m = ink[p] === 1 || (sat(d, i) <= 50 && (lum(d, i) <= 120 || mn[p] <= 90)); }
        if (m) { if (a < 0 || x - last > gap) { if (a >= 0 && last - a + 1 >= minW && (!best || last - a > best[1] - best[0])) best = [a, last]; a = x; } last = x; }
        if (x === W && a >= 0 && last - a + 1 >= minW && (!best || last - a > best[1] - best[0])) best = [a, last];
      }
      runs[y] = best;
    }
    let pick = null, bestInk = 0;
    for (let y = 0; y < H; ) {
      if (!runs[y]) { y++; continue; }
      // Kutunun yanındaki koyu yaprak/gölge koşuyu satırdan satıra uzatıp kısaltabilir: bağlılık için
      // önceki satırla en az minW kadar örtüşmek yeter
      let y1 = y, miss = 0, x0s = [runs[y][0]], x1s = [runs[y][1]], pr = runs[y];
      for (let k = y + 1; k < H && miss <= 2; k++) {
        const rr = runs[k];
        if (rr && Math.min(rr[1], pr[1]) - Math.max(rr[0], pr[0]) >= minW) { y1 = k; miss = 0; x0s.push(rr[0]); x1s.push(rr[1]); pr = rr; } else miss++;
      }
      if (y1 - y + 1 >= minH) {
        // Kenarlar cömert alınır (yazıyı kesmektense biraz zemin kalsın)
        const py = Math.round(minH * 1.5);
        const g = { x0: Math.max(0, Math.min(...x0s) - gap * 4), x1: Math.min(W - 1, Math.max(...x1s) + gap * 4), y0: Math.max(0, y - py), y1: Math.min(H - 1, y1 + py) };
        let k = 0;
        for (let yy = g.y0; yy <= g.y1; yy++) for (let x = g.x0; x <= g.x1; x++) k += ink[yy * W + x];
        if (k > bestInk) { bestInk = k; pick = g; }
      }
      y = y1 + 1;
    }
    return bestInk >= 20 ? pick : null;
  }
  function hintPrep(v, r) {
    const scale = Math.min(3, Math.max(1, 900 / r.sw)), PAD = 10;
    const W = Math.round(r.sw * scale), H = Math.round(r.sh * scale);
    hintCanvas.width = W + PAD * 2; hintCanvas.height = H + PAD * 2;
    hintCtx.fillStyle = '#fff'; hintCtx.fillRect(0, 0, hintCanvas.width, hintCanvas.height);
    hintCtx.imageSmoothingQuality = 'high';
    hintCtx.drawImage(v, r.sx, r.sy, r.sw, r.sh, PAD, PAD, W, H);
    const img = hintCtx.getImageData(PAD, PAD, W, H);
    const { ink, mn } = hintInk({ getImageData: () => img }, W, H, Math.max(2, Math.round(scale * 2)));
    const d = img.data;
    // Kutunun kendisi: koyu-renksiz zemin + beyaz yazıdan oluşan, kesintisiz uzun yatay satırlar. Güneşli sahnede
    // gökyüzü/yaprak kenarları da "yazı" sayılır; kutunun dışındaki her şey silinir. Kutu yoksa OCR'a hiç gidilmez.
    const box = hintBox(d, ink, mn, W, H, Math.round(4 * scale), Math.max(Math.round(70 * scale), Math.round(W * 0.18)), Math.round(14 * scale));
    if (!box) return null;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) ink[y * W + x] = 0;
    for (let p = 0, i = 0; p < ink.length; p++, i += 4) { const c = ink[p] ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255; }
    hintCtx.putImageData(img, PAD, PAD);
    return { url: hintCanvas.toDataURL('image/png'), scale, PAD, r };
  }
  function hintParse(lines, prep) {
    const good = [];
    for (const l of lines || []) {
      // Tuş simgesi kırıntıları: harfsiz, ya da sözlükte olmayan 1-3 harfli parça ("ED", "Gi", "@")
      // (simgeye yapışık sözlük kelimesi düşük güvenle okunsa da kalır: "hold", "to")
      const ws = (l.words || []).map((w) => ({ ...w, text: w.text.replace(/^[^\p{L}\p{N}"“'(]+|[^\p{L}\p{N}.,!?'’"”)]+$/gu, '').replace(/^([^(]*)\)$/u, '$1') }))
        // Simgeden çıkan büyük harf kırıntısı ("QO", "LB", "ED"): 1-3 büyük harf, bilinen kısaltma değil
        .filter((w) => !(/^\p{Lu}{1,3}[.,]?$/u.test(w.text) && !/^(I|A|OK|TV|FBI|CIA|USA|GPS|ATM|DJ)[.,]?$/.test(w.text)))
        .filter((w) => (w.confidence >= 50 || (w.known === true && w.confidence >= 25)) && /\p{L}/u.test(w.text)
        && !(w.known === false && letterCount(w.text) <= 3) && !/^[^\p{L}]*\p{L}[^\p{L}]*$/u.test(w.text) || /^(a|I)[.,!?]?$/.test(w.text));
      if (!ws.length) continue;
      const letters = ws.reduce((n, w) => n + letterCount(w.text), 0);
      const okL = ws.filter((w) => w.known !== false || /^\p{Lu}\p{Ll}/u.test(w.text)).reduce((n, w) => n + letterCount(w.text), 0);
      if (letters < 4 || okL < letters * 0.7) continue;
      good.push({ ws, y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)), x0: Math.min(...ws.map((w) => w.x0)) });
    }
    if (!good.length) return null;
    good.sort((a, b) => a.y0 - b.y0);
    // Kutu tek parça: ilk satırla dikey bağlantılı satırlar (aradaki boşluk satır yüksekliğinden az)
    // Kutunun üstündeki gökyüzü/yaprak gürültüsü ayrı blok olur: en çok sözlük kelimesi içeren blok seçilir
    const blocks = [[good[0]]];
    for (let i = 1; i < good.length; i++) {
      const cur = blocks[blocks.length - 1], prev = cur[cur.length - 1], h = prev.y1 - prev.y0;
      if (good[i].y0 - prev.y1 > h * 1.2 || Math.abs(good[i].x0 - cur[0].x0) > h * 3) blocks.push([good[i]]);
      else cur.push(good[i]);
    }
    const knownOf = (bl) => bl.reduce((n, g) => n + g.ws.filter((w) => letterCount(w.text) >= 3 && w.known === true).length, 0);
    const block = blocks.reduce((best, bl) => (knownOf(bl) > knownOf(best) ? bl : best), blocks[0]);
    const ws = block.flatMap((g) => g.ws);
    const body = block.map((g) => g.ws.map((w) => w.text).join(' ')).join(' ')
      .replace(/[^\p{L}\p{N}\s.,!?'’"“”:;()%$-]/gu, ' ') // simge kırıntısı ("hold®")
      .replace(/(\p{L})- (\p{L})/gu, '$1$2').replace(/\s+([,.!?;:])/g, '$1').replace(/\s+/g, ' ').trim();
    const known = ws.filter((w) => letterCount(w.text) >= 3 && w.known === true).length;
    if (known < 3 || (body.match(/\p{L}{2,}/gu) || []).length < 4) return null;
    const toV = (x, y) => ({ x: prep.r.sx + (x - prep.PAD) / prep.scale, y: prep.r.sy + (y - prep.PAD) / prep.scale });
    const a = toV(Math.min(...ws.map((w) => w.x0)), Math.min(...ws.map((w) => w.y0)));
    const b = toV(Math.max(...ws.map((w) => w.x1)), Math.max(...ws.map((w) => w.y1)));
    return { body, box: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } };
  }
  function hintHide() {
    hintShown = null; hintLastSig = null; hintSeen = ''; hintSeenN = 0;
    ui.hint.classList.remove('show');
  }
  function hintLayout(v, c) {
    if (!hintShown || !v || !v.videoWidth) return;
    c = c || contentRect(v);
    const kx = c.width / v.videoWidth, ky = c.height / v.videoHeight, b = hintShown.box, vw = v.videoWidth;
    const fontPx = Math.round(Math.min(34, Math.max(12, (S.fontSize * c.height) / 720 * 0.62)));
    ui.hint.style.fontSize = fontPx + 'px';
    ui.hint.style.left = (c.left + Math.max(0, b.x0 - vw * 0.008) * kx) + 'px';
    ui.hint.style.top = (c.top + b.y1 * ky + fontPx * 0.7) + 'px';
    ui.hint.style.maxWidth = Math.max(240, (b.x1 - b.x0 + vw * 0.04) * kx * 1.15) + 'px';
  }
  async function hintStep(v) {
    if (hintBusy || !S.hintOn || S.from !== 'en' || !v || !v.videoWidth) return;
    hintBusy = true;
    try {
      // Görev listesi açıkken sol üstte liste satırları var, ipucu değil ("Search for Tree Effigies")
      if (menuScreen(v) === 'list') { if (hintShown) hintHide(); hintLastSig = null; return; }
      const r = hintRect(v);
      const sg = hintSignature(v, r);
      if (sg.ratio < 0.002) { if (hintShown && ++hintMiss >= 2) hintHide(); hintLastSig = null; return; }
      if (hintLastSig && msgSigDiff(sg, hintLastSig) < 0.2) return; // değişmedi
      const now = performance.now();
      if (now - hintLastOcr < 600) return; // altyazıya öncelik
      hintLastOcr = now;
      hintLastSig = sg;
      const prep = hintPrep(v, r);
      if (!prep) { if (hintShown && ++hintMiss >= 2) hintHide(); return; } // kutu yok: OCR yok
      const res = await ocrImage(prep.url);
      if (!res || !res.ok) return;
      const parsed = hintParse(res.lines, prep);
      if (!parsed) { if (hintShown && ++hintMiss >= 2) hintHide(); hintLastSig = null; return; }
      hintMiss = 0;
      if (hintShown && similar(hintShown.src, parsed.body)) { hintShown.box = parsed.box; hintLayout(v); return; }
      // Kutu belirirken (kayarak/solarak) yarım okunabilir: aynı metin iki kez okununca göster
      if (!similar(hintSeen, parsed.body)) { hintSeen = parsed.body; hintSeenN = 1; hintLastSig = null; return; }
      dbg({ ipucu: parsed.body });
      const tr = await translateAll(parsed.body);
      if (tr && S.enabled && S.hintOn) {
        hintShown = { src: parsed.body, tr, box: parsed.box };
        ui.hint.textContent = tr;
        hintLayout(v);
        ui.hint.classList.add('show');
      }
    } catch (e) { /* ipucu okunamadı: altyazıyı etkilemesin */ } finally { hintBusy = false; }
  }
  setInterval(() => {
    if (orphaned || !S.enabled || selecting) { if (hintShown) hintHide(); return; }
    const v = currentVideo;
    if (v && v.seeking) { if (hintShown) hintHide(); return; }
    if (!v || v.paused || document.hidden) return;
    hintStep(v);
  }, 300);

  // ---------- Harita / menü bilgi kartı ----------
  // Duraklatma menüsünde (harita, görevler) seçilen yerin koyu kartı: "BIFF'S GUN SUPPLY" başlığı, açıklama
  // ("Ammu-Nation distributor that stocks guns…") ve "INVENTORY  STANDARD" gibi satırlar. Yalnızca menü ekranında
  // (üstte koyu sekme şeridi: "JASON & LUCIA  MAP  BRIEF…") aranır; oyun sırasında hiç çalışmaz.
  // Başlık özel isimdir, olduğu gibi kalır; açıklama ve satırlar çevrilir. Aynı kart yeniden seçilince çeviri
  // hafızadan gelir (kart tekrar tekrar çıkar — çeviri motoruna bir daha sorulmaz).
  const CARD_REGION = { x: 0.28, y: 0.12, w: 0.69, h: 0.7 };
  const cardCanvas = document.createElement('canvas');
  const cardCtx = cardCanvas.getContext('2d', { willReadFrequently: true });
  const menuCanvas = document.createElement('canvas');
  const menuCtx = menuCanvas.getContext('2d', { willReadFrequently: true });
  const menuColCanvas = document.createElement('canvas');
  const menuPanelCanvas = document.createElement('canvas');
  const menuPanelCtx = menuPanelCanvas.getContext('2d', { willReadFrequently: true });
  const menuColCtx = menuColCanvas.getContext('2d', { willReadFrequently: true });
  var cardBusy = false, cardLastSig = null, cardMiss = 0, cardShown = null, cardLastOcr = 0, cardSeen = '', cardMemo = new Map();
  // Menü ekranı mı: en üst şerit (%0,5–%8) neredeyse tamamen koyu-renksiz zemin + üstünde açık yazı (sekme adları)
  function menuScreen(v) {
    const vw = v.videoWidth, vh = v.videoHeight, W = 240, H = 16;
    if (menuCanvas.width !== W || menuCanvas.height !== H) { menuCanvas.width = W; menuCanvas.height = H; }
    menuCtx.drawImage(v, 0, Math.round(vh * 0.005), vw, Math.round(vh * 0.075), 0, 0, W, H);
    const d = menuCtx.getImageData(0, 0, W, H).data;
    let dark = 0, bright = 0;
    for (let i = 0; i < d.length; i += 4) { const l = lum(d, i), s = sat(d, i); if (l < 90 && s < 70) dark++; else if (l >= 170) bright++; }
    const n = W * H;
    const tab = dark >= n * 0.8 && bright >= n * 0.006;
    // Hikâye/görev listesi açıkken üstte şerit yok: soldaki koyu simge sütunu (harita, görev, silah… simgeleri)
    const CW = 12, CH = 80;
    if (menuColCanvas.width !== CW || menuColCanvas.height !== CH) { menuColCanvas.width = CW; menuColCanvas.height = CH; }
    menuColCtx.drawImage(v, Math.round(vw * 0.016), Math.round(vh * 0.13), Math.round(vw * 0.026), Math.round(vh * 0.42), 0, 0, CW, CH);
    const c = menuColCtx.getImageData(0, 0, CW, CH).data;
    // Simgeler beyaz (renksiz) ve sütunun ortasında; sütunun iki kenarı her satırda düz koyu zemin. Oyun sırasındaki
    // koyu direk/ağaç + pembe gökyüzü bu koşulları sağlamaz.
    const D = (i) => lum(c, i) < 90 && sat(c, i) < 70;
    let cd = 0, cb = 0, edge = 0;
    for (let i = 0; i < c.length; i += 4) { if (D(i)) cd++; else if (lum(c, i) >= 170 && sat(c, i) < 50) cb++; }
    for (let y = 0; y < CH; y++) { const r = y * CW * 4; if (D(r) && D(r + 4) && D(r + (CW - 2) * 4) && D(r + (CW - 1) * 4)) edge++; }
    const col = cd >= CW * CH * 0.6 && cb >= CW * CH * 0.03 && cd + cb >= CW * CH * 0.85 && edge >= CH * 0.7;
    if (col) {
      // Görev listesi: sütunun sağında geniş, düz, renksiz koyu-gri panel (kapkara gece sahnesi değil). Koyu yeşil
      // harita üst şeridi de "koyu" gösterebildiği için liste ayrıca bakılır.
      if (menuPanelCanvas.width !== 40) { menuPanelCanvas.width = 40; menuPanelCanvas.height = 40; }
      menuPanelCtx.drawImage(v, Math.round(vw * 0.08), Math.round(vh * 0.6), Math.round(vw * 0.18), Math.round(vh * 0.3), 0, 0, 40, 40);
      const q = menuPanelCtx.getImageData(0, 0, 40, 40).data;
      let pn = 0;
      for (let i = 0; i < q.length; i += 4) { const l = lum(q, i); if (l >= 25 && l < 60 && sat(q, i) < 30) pn++; }
      if (pn >= 1600 * 0.9) return 'list';
    }
    return tab ? 'tab' : col ? 'map' : false;
  }
  function cardRect(v) {
    const vw = v.videoWidth, vh = v.videoHeight;
    return { sx: Math.round(CARD_REGION.x * vw), sy: Math.round(CARD_REGION.y * vh), sw: Math.round(CARD_REGION.w * vw), sh: Math.round(CARD_REGION.h * vh) };
  }
  function cardSignature(v, r) {
    const W = 160, H = Math.max(8, Math.round((W * r.sh) / r.sw));
    if (hintSigCanvas.width !== W || hintSigCanvas.height !== H) { hintSigCanvas.width = W; hintSigCanvas.height = H; }
    hintSigCtx.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
    const { ink, k, n } = hintInk(hintSigCtx, W, H, 2);
    return { ink, k, ratio: k / n };
  }
  function cardPrep(v, r) {
    const scale = Math.min(2.2, Math.max(1.5, 2000 / r.sw)), PAD = 10;
    const W = Math.round(r.sw * scale), H = Math.round(r.sh * scale);
    cardCanvas.width = W + PAD * 2; cardCanvas.height = H + PAD * 2;
    cardCtx.fillStyle = '#fff'; cardCtx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);
    cardCtx.imageSmoothingQuality = 'high';
    cardCtx.drawImage(v, r.sx, r.sy, r.sw, r.sh, PAD, PAD, W, H);
    const img = cardCtx.getImageData(PAD, PAD, W, H);
    const { ink, mn } = hintInk({ getImageData: () => img }, W, H, Math.max(2, Math.round(scale * 2)));
    const d = img.data;
    const box = hintBox(d, ink, mn, W, H, Math.round(4 * scale), Math.round(W * 0.2), Math.round(30 * scale));
    if (!box) return null;
    for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
      const x = p % W, y = (p - x) / W, c = ink[p] && x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255;
    }
    cardCtx.putImageData(img, PAD, PAD);
    return { url: cardCanvas.toDataURL('image/png'), scale, PAD, r };
  }
  // Kart: dikey olarak bitişik satırlardan en çok sözlük kelimesi içeren grup. İlk satır büyük harfse başlık;
  // küçük harf içeren satırlar açıklama; sonraki büyük harfli satırlar "ETİKET  DEĞER" satırları (araları geniş boşluk).
  function cardParse(lines, prep) {
    const good = [];
    for (const l of lines || []) {
      const ws = (l.words || []).map((w) => ({ ...w, text: w.text.replace(/^[^\p{L}\p{N}$"“'(]+|[^\p{L}\p{N}.,!?'’"”)%]+$/gu, '') }))
        .filter((w) => w.text && /\p{L}|\d/u.test(w.text) && (w.confidence >= 60 || (w.known === true && w.confidence >= 35)));
      if (!ws.length) continue;
      const letters = ws.reduce((n, w) => n + letterCount(w.text), 0);
      if (letters < 3) continue;
      const h = ws.map((w) => w.y1 - w.y0).sort((a, b) => a - b)[ws.length >> 1];
      good.push({ ws, h, y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)), x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)) });
    }
    if (!good.length) return null;
    good.sort((a, b) => a.y0 - b.y0);
    const blocks = [[good[0]]];
    for (let i = 1; i < good.length; i++) {
      const cur = blocks[blocks.length - 1], prev = cur[cur.length - 1];
      // (satırlar arasında ayırıcı çizgi olabilir: "INVENTORY" / "FEATURES")
      if (good[i].y0 - prev.y1 > Math.max(prev.h, good[i].h) * 2.6 || Math.abs(good[i].x0 - cur[0].x0) > prev.h * 2) blocks.push([good[i]]);
      else cur.push(good[i]);
    }
    const knownOf = (bl) => bl.reduce((n, g) => n + g.ws.filter((w) => letterCount(w.text) >= 3 && w.known === true).length, 0);
    let block = blocks.reduce((best, bl) => (knownOf(bl) > knownOf(best) ? bl : best), blocks[0]);
    if (knownOf(block) < 4) return null;
    const caps = (g) => { const t = g.ws.map((w) => w.text).join(''); const L = letterCount(t); return L >= 3 && (t.match(/\p{Lu}/gu) || []).length >= L * 0.8; };
    // Görev kartında başlığın solunda portre var: başlık açıklamadan daha sağdan başlar, ayrı blok sayılmıştır
    const pb = blocks[blocks.indexOf(block) - 1];
    if (pb && pb.length === 1 && caps(pb[0]) && !caps(block[0]) && block[0].y0 - pb[0].y1 <= Math.max(pb[0].h, block[0].h) * 2.6 && pb[0].x0 >= block[0].x0 - pb[0].h) block = [pb[0], ...block];
    let title = '', titleTr = false, body = [], rows = [];
    block.forEach((g, i) => {
      if (i === 0 && caps(g)) {
        title = g.ws.map((w) => w.text).join(' ');
        // Görev adı ("SEARCH FOR TREE EFFIGIES") çevrilir; özel ad içeren yer adı ("BIFF'S GUN SUPPLY") olduğu gibi kalır
        titleTr = g.ws.every((w) => letterCount(w.text) < 3 || w.known === true); // ("TO", "OF" sözlükte işaretsiz)
        return;
      }
      if (caps(g)) {
        // "INVENTORY ……… STANDARD": geniş boşlukla ayrılan sütunlar
        const segs = [[g.ws[0]]];
        for (let k = 1; k < g.ws.length; k++) { if (g.ws[k].x0 - g.ws[k - 1].x1 > g.h * 2.5) segs.push([]); segs[segs.length - 1].push(g.ws[k]); }
        // Değer sütunundaki simgeler (tişört, silah) OCR'da kırıntı olur ("TES"): sözlükte olmayan değer atılır
        const keep = segs.filter((sg, k) => k === 0 || sg.every((w) => w.known === true || /^[$\d][\d.,%$km]*$/i.test(w.text)));
        rows.push(keep.map((sg) => sg.map((w) => w.text).join(' ')));
        return;
      }
      if (rows.length) return; // satırlardan sonra gelen küçük harfli parça (simge kırıntısı) alınmaz
      body.push(g.ws.map((w) => w.text).join(' '));
    });
    const bodyText = body.join(' ').replace(/(\p{L})- (\p{L})/gu, '$1$2').replace(/\s+([,.!?;:])/g, '$1').replace(/\s+/g, ' ').trim()
      .replace(/\.\s+(?=\p{Ll})/gu, ', '); // virgül nokta okunmuş ("guns. mods, ammo"): küçük harften önce nokta olmaz
    if (!bodyText && !rows.length) return null;
    const toV = (x, y) => ({ x: prep.r.sx + (x - prep.PAD) / prep.scale, y: prep.r.sy + (y - prep.PAD) / prep.scale });
    const a = toV(Math.min(...block.map((g) => g.x0)), block[0].y0), b = toV(Math.max(...block.map((g) => g.x1)), block[block.length - 1].y1);
    const key = [title, bodyText, rows.map((r) => r.join('|')).join('/')].join('\n');
    return { title, titleTr, body: bodyText, rows, key, box: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } };
  }
  function cardHide() {
    cardShown = null; cardLastSig = null; cardSeen = '';
    ui.card.classList.remove('show');
  }
  function cardLayout(v, c) {
    if (!cardShown || !v || !v.videoWidth) return;
    c = c || contentRect(v);
    const kx = c.width / v.videoWidth, ky = c.height / v.videoHeight, b = cardShown.box, vw = v.videoWidth;
    const fontPx = Math.round(Math.min(30, Math.max(12, (S.fontSize * c.height) / 720 * 0.58)));
    ui.card.style.fontSize = fontPx + 'px';
    const pad = vw * 0.012;
    ui.card.style.left = (c.left + (b.x0 - pad) * kx) + 'px';
    ui.card.style.width = Math.max(260, (b.x1 - b.x0 + pad * 2) * kx) + 'px';
    // Kartın altına; sığmazsa üstüne
    const below = c.top + (b.y1 + pad * 1.4) * ky, h = ui.card.offsetHeight || fontPx * 6;
    if (below + h <= c.top + c.height * 0.97) { ui.card.style.top = below + 'px'; }
    else ui.card.style.top = Math.max(c.top, c.top + (b.y0 - pad * 1.4) * ky - h) + 'px';
  }
  // Büyük harfli menü satırı: "INVENTORY" → "Inventory" diye çevrilir, sonuç yine büyük harfle yazılır
  const capTr = (t) => translateAll(t.charAt(0) + t.slice(1).toLowerCase()).then((x) => (x || t).toLocaleUpperCase('tr'), () => t);
  // Başlık her kelimesi büyük harfle başlatılarak çevrilir (özel adlar korunur), sonuç büyük harfle yazılır
  // (özgün başlıktaki adlar Türkçe İ ile yazılmaz: "VICE CITY'YE", "VİCE CİTY'YE" değil)
  const titleTrOf = (t) => translateAll(t.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase())).then((x) => {
    if (!x) return '';
    let u = x.toLocaleUpperCase('tr');
    for (const w of t.match(/\p{L}{2,}/gu) || []) { const tw = w.toLowerCase().toLocaleUpperCase('tr'); if (tw !== w && u.includes(tw)) u = u.split(tw).join(w.toUpperCase()); }
    return u;
  }, () => '');
  function cardRender(v, p, tr) {
    ui.card.textContent = '';
    if (p.title) ui.card.append(el('div', { class: 'c-title' }, tr.title || p.title));
    if (tr.body) ui.card.append(el('div', { class: 'c-body' }, tr.body));
    tr.rows.forEach((r) => ui.card.append(el('div', { class: 'c-row' }, r.join(': '))));
    ui.card.classList.add('show');
    cardLayout(v);
    cardLayout(v); // yüksekliği belli olunca (üste taşıma kararı) yeniden
  }
  async function cardStep(v) {
    if (cardBusy || !S.cardOn || S.from !== 'en' || !v || !v.videoWidth) return;
    cardBusy = true;
    try {
      if (!menuScreen(v)) { if (cardShown && ++cardMiss >= 2) cardHide(); cardLastSig = null; return; }
      const r = cardRect(v);
      const sg = cardSignature(v, r);
      if (sg.ratio < 0.0005) { if (cardShown && ++cardMiss >= 2) cardHide(); cardLastSig = null; return; }
      if (cardLastSig && msgSigDiff(sg, cardLastSig) < 0.2) return; // değişmedi
      const now = performance.now();
      if (now - cardLastOcr < 500) return;
      cardLastOcr = now;
      cardLastSig = sg;
      const prep = cardPrep(v, r);
      if (!prep) { if (cardShown && ++cardMiss >= 2) cardHide(); return; }
      const res = await ocrImage(prep.url);
      if (!res || !res.ok) return;
      const p = cardParse(res.lines, prep);
      if (!p) { if (cardShown && ++cardMiss >= 2) cardHide(); cardLastSig = null; return; }
      cardMiss = 0;
      if (cardShown && similar(cardShown.key, p.key)) { cardShown.box = p.box; cardLayout(v); return; }
      // Kart belirirken yarım okunabilir: aynı kart iki kez okununca göster (hafızadaki kart hemen)
      const memo = [...cardMemo.values()].find((m) => similar(m.key, p.key));
      if (!memo && !similar(cardSeen, p.key)) { cardSeen = p.key; cardLastSig = null; return; }
      let tr = memo && memo.tr;
      if (!tr) {
        dbg({ kart: p.key });
        const [title, body, ...rows] = await Promise.all([p.title && p.titleTr ? titleTrOf(p.title) : Promise.resolve(''), p.body ? translateAll(p.body) : Promise.resolve(''), ...p.rows.map((row) => Promise.all(row.map(capTr)))]);
        tr = { title, body, rows };
        cardMemo.set(p.key, { key: p.key, tr });
        if (cardMemo.size > 200) cardMemo.delete(cardMemo.keys().next().value);
      }
      if (S.enabled && S.cardOn) {
        cardShown = { key: memo ? memo.key : p.key, box: p.box };
        cardRender(v, p, tr);
      }
    } catch (e) { /* kart okunamadı: altyazıyı etkilemesin */ } finally { cardBusy = false; }
  }
  setInterval(() => {
    if (orphaned || !S.enabled || selecting) { if (cardShown) cardHide(); return; }
    const v = currentVideo;
    if (v && v.seeking) { if (cardShown) cardHide(); return; }
    if (!v || v.paused || document.hidden) return;
    cardStep(v);
  }, 300);

  // ---------- Elde tutulan telefon (mesajlar, sosyal medya) ----------
  // Telefon ekranı: koyu çerçeveli, uzun, açık renk dikdörtgen (ekranın sağ-orta kısmı). Bulunduğu anda o alan
  // (ve sağ alttaki tuş ipuçları "SCROLL / BACK") altyazı okumasında boyanır — altyazı bozulmaz. Ekrandaki yazılar
  // ayrıca okunur, baloncuk baloncuk çevrilip telefonun soluna sohbet düzeninde yazılır (gelen sarı, giden mavi).
  var phoneBox = null, phonePrevBox = null, phoneMemo = [], phoneMasks = null, phoneMiss = 0, phoneBusy = false, phoneLastSig = null, phoneLastOcr = 0, phoneShown = null, phoneSeq = 0;
  const phDetCanvas = document.createElement('canvas');
  const phDetCtx = phDetCanvas.getContext('2d', { willReadFrequently: true });
  const phCanvas = document.createElement('canvas');
  const phCtx = phCanvas.getContext('2d', { willReadFrequently: true });

  // Kaba tespit (320 px genişlikte kare). Telefon ekranının sol ve sağ kenarı DÜZ dikey çizgilerdir: kenarın bir yanı
  // koyu çerçeve, öbür yanı açık-renksiz ekran. Aynı satırda iki kenarın birlikte görüldüğü satırlar sayılır. Telefon
  // ekranın her yerinde olabilir (konum değişir); yayın kamerası/logo üstünü kapatsa da alttaki satırlar yeter.
  // Gündüz (gri çerçeve) için mutlak değil karşıtlık eşiği kullanılır. Yanlış adaylar OCR onayıyla elenir (phoneStep).
  function phoneDetect(v) {
    const vw = v.videoWidth, vh = v.videoHeight, W = 320, H = Math.max(80, Math.round((W * vh) / vw));
    if (phDetCanvas.width !== W || phDetCanvas.height !== H) { phDetCanvas.width = W; phDetCanvas.height = H; }
    phDetCtx.drawImage(v, 0, 0, vw, vh, 0, 0, W, H);
    const d = phDetCtx.getImageData(0, 0, W, H).data, N = W * H;
    const Lv = new Uint8Array(N), B = new Uint8Array(N), D = new Uint8Array(N);
    for (let p = 0, i = 0; p < N; p++, i += 4) { const l = lum(d, i); Lv[p] = l; B[p] = sat(d, i) <= 50 && l >= 115 ? 1 : 0; D[p] = l < 115 ? 1 : 0; }
    // Kenar olayları: çerçeve (2 px) ekrandan (3 px) en az 55 daha koyu (eğik kenarda da satır içinde geçerli)
    const LE = new Uint8Array(N), RE = new Uint8Array(N), evL = [], evR = [];
    for (let y = 0; y < H; y++) for (let x = 3; x < W - 3; x++) {
      const p = y * W + x;
      if (!B[p]) continue;
      if (B[p + 1] && B[p + 2] && Math.max(Lv[p - 1], Lv[p - 2]) <= Math.min(Lv[p], Lv[p + 1], Lv[p + 2]) - 55) { LE[p] = 1; evL.push(x, y); }
      if (B[p - 1] && B[p - 2] && Math.max(Lv[p + 1], Lv[p + 2]) <= Math.min(Lv[p], Lv[p - 1], Lv[p - 2]) - 55) { RE[p] = 1; evR.push(x, y); }
    }
    // Telefon elde eğik durabilir: kenar olaylarını en iyi hizalayan eğim (x kayması / y) aranır (±0,45 ≈ ±24°).
    // Her eğim için görüntü kaydırılıp (shear) dik kenar araması aynen yapılır; düz (0) her zaman denenir.
    const H2 = H / 2, peak = (ev, sl) => {
      const h = new Int32Array(W + 2);
      for (let k = 0; k < ev.length; k += 2) { const x = Math.round(ev[k] - sl * (ev[k + 1] - H2)); if (x >= 0 && x < W) h[x + 1]++; }
      let m = 0; for (let x = 1; x <= W; x++) m = Math.max(m, h[x - 1] + h[x] + h[x + 1]);
      return m;
    };
    let bestS = 0, bestP = peak(evL, 0) + peak(evR, 0);
    for (let sl = -0.45; sl <= 0.4501; sl += 0.025) {
      if (Math.abs(sl) < 1e-6) continue;
      const pk = peak(evL, sl) + peak(evR, sl);
      if (pk > bestP * 1.1) { bestP = pk; bestS = sl; }
    }
    const shear = (A, sl) => {
      if (!sl) return A;
      const O = new Uint8Array(N);
      for (let y = 0; y < H; y++) { const o = Math.round(sl * (y - H2)), row = y * W; for (let x = 0; x < W; x++) { const sx = x + o; if (sx >= 0 && sx < W) O[row + x] = A[row + sx]; } }
      return O;
    };
    const search = (sl) => {
      const LEs = shear(LE, sl), REs = shear(RE, sl), Bs = shear(B, sl), Ds = shear(D, sl);
      const le = new Int32Array(W), re = new Int32Array(W);
      for (let p = 0; p < N; p++) { if (LEs[p]) le[p % W]++; if (REs[p]) re[p % W]++; }
      // Çerçeve sürekliliği: sütundaki en uzun koyu dizi
      const run = new Int32Array(W);
      for (let x = 0; x < W; x++) {
        let best = 0, cs = -1, gap = 0;
        for (let y = 0; y < H; y++) { if (Ds[y * W + x]) { if (cs < 0) cs = y; gap = 0; if (y - cs + 1 > best) best = y - cs + 1; } else if (cs >= 0 && ++gap > 3) { cs = -1; gap = 0; } }
        run[x] = best;
      }
      const minW = Math.round(W * 0.07), maxW = Math.round(W * 0.32), mr = H * 0.05;
      const at = (A, y, x) => A[y * W + x] || A[y * W + x - 1] || A[y * W + x + 1];
      let g = null;
      for (let xl = 4; xl < W - minW; xl++) {
        if (le[xl - 1] + le[xl] + le[xl + 1] < mr || Math.max(run[xl - 2], run[xl - 3]) < H * 0.4) continue;
        for (let xr = xl + minW; xr <= Math.min(W - 5, xl + maxW); xr++) {
          if (re[xr - 1] + re[xr] + re[xr + 1] < mr || Math.max(run[xr + 2], run[xr + 3]) < H * 0.4) continue;
          let n = 0, y0 = -1, y1 = -1, nb = 0, nt = 0;
          for (let y = 0; y < H; y++) {
            if (!at(LEs, y, xl) || !at(REs, y, xr)) continue;
            n++; if (y0 < 0) y0 = y; y1 = y;
            for (let x = xl; x <= xr; x++) nb += Bs[y * W + x];
            nt += xr - xl + 1;
          }
          if (n < mr || nb < nt * 0.5) continue;
          // Mesaj kutusu (sağ alt) ve mini harita (sol alt) telefon sayılmaz
          if (xl >= W * 0.74 && y0 >= H * 0.6) continue;
          if (xr <= W * 0.35 && y0 >= H * 0.65) continue;
          const sc = n * (xr - xl);
          if (!g || sc > g.sc) g = { sc, n, xl, xr, y0, y1 };
        }
      }
      if (!g) return null;
      // Dikeyde ekranın geri kalanına uzat (fotoğraf/renkli satırlar da ekranın parçası; boşluk ≤ 6 satır)
      const gw = g.xr - g.xl + 1;
      const rowB = (y) => { let n = 0; for (let x = g.xl; x <= g.xr; x++) n += Bs[y * W + x]; return n; };
      const edge = (y) => at(LEs, y, g.xl) || at(REs, y, g.xr) || Ds[y * W + g.xl - 2] && Ds[y * W + g.xr + 2] && rowB(y) >= gw * 0.12;
      for (let y = g.y1 + 1, gap = 0; y < H && gap <= 6; y++) { if (edge(y)) { g.y1 = y; gap = 0; } else gap++; }
      for (let y = g.y0 - 1, gap = 0; y >= 0 && gap <= 6; y--) { if (edge(y)) { g.y0 = y; gap = 0; } else gap++; }
      g.sl = sl;
      return g;
    };
    let g = search(bestS);
    if (bestS) { const g0 = search(0); if (g0 && (!g || g0.sc >= g.sc)) g = g0; }
    if (!g) return null;
    // Kaydırılmış koordinattan videoya: ekranın merkezi, eksenleri (eğik), boyu ve eni + eksene hizalı çevreleyen kutu
    const kx = vw / W, ky = vh / H, sl = g.sl, nrm = Math.hypot(1, sl);
    const cyS = (g.y0 + g.y1 + 1) / 2, cxS = (g.xl + g.xr + 1) / 2;
    const cx = (cxS + sl * (cyS - H2)) * kx, cy = cyS * ky;
    const w = ((g.xr + 1 - g.xl) * kx) / nrm, h = (g.y1 + 1 - g.y0) * ky * nrm;
    const ux = 1 / nrm, uy = -sl / nrm, vx = sl / nrm, vy = 1 / nrm; // eni (sağa) ve boyu (aşağı) birim vektörler
    const hw = w / 2, hh = h / 2, ex = Math.abs(ux) * hw + Math.abs(vx) * hh, ey = Math.abs(uy) * hw + Math.abs(vy) * hh;
    return { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey, n: g.n, cx, cy, w, h, ux, uy, vx, vy, sl };
  }
  // Telefon ekranı imzası: 18×32 hücrelik ortalama parlaklık ızgarası (sallantıda az, kaydırma/yeni mesajda çok değişir)
  function phoneSig(v, b) {
    const W = 90, H = 160, GW = 18, GH = 32;
    if (msgSigCanvas.width !== W || msgSigCanvas.height !== H) { msgSigCanvas.width = W; msgSigCanvas.height = H; }
    msgSigCtx.drawImage(v, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 0, 0, W, H);
    const d = msgSigCtx.getImageData(0, 0, W, H).data, g = new Float32Array(GW * GH);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[((y / 5) | 0) * GW + ((x / 5) | 0)] += lum(d, (y * W + x) * 4) / 25;
    return g;
  }
  // Fark: ortalama parlaklık farkı (±1 hücre dikey kaymaya dayanıklı). Sallantı ~5–9, belirgin kaydırma/yeni ekran ≥ 10
  function phoneSigDiff(a, c) {
    if (!a || !c || a.length !== c.length) return 999;
    const GW = 18, GH = 32;
    let best = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      let sum = 0, n = 0;
      for (let y = Math.max(0, -dy); y < Math.min(GH, GH - dy); y++) for (let x = 0; x < GW; x++) { sum += Math.abs(a[y * GW + x] - c[(y + dy) * GW + x]); n++; }
      best = Math.min(best, sum / n);
    }
    return best;
  }
  function phonePrep(v, b) {
    // Eğik telefon düzeltilerek çizilir (yazı satırları yatay olsun): telefonun eni/boyu eksenleri çıktının x/y'si olur
    const sw = b.w || b.x1 - b.x0, sh = b.h || b.y1 - b.y0;
    const scale = Math.min(3, Math.max(1, 700 / sw)), PAD = 10;
    const W = Math.round(sw * scale), H = Math.round(sh * scale);
    phCanvas.width = W + PAD * 2; phCanvas.height = H + PAD * 2;
    phCtx.fillStyle = '#fff'; phCtx.fillRect(0, 0, phCanvas.width, phCanvas.height);
    phCtx.imageSmoothingQuality = 'high';
    if (b.sl) {
      phCtx.save();
      phCtx.beginPath(); phCtx.rect(PAD, PAD, W, H); phCtx.clip();
      const ox = PAD + W / 2, oy = PAD + H / 2;
      phCtx.setTransform(scale * b.ux, scale * b.vx, scale * b.uy, scale * b.vy,
        ox - scale * (b.ux * b.cx + b.uy * b.cy), oy - scale * (b.vx * b.cx + b.vy * b.cy));
      const bx0 = Math.max(0, Math.floor(b.x0)), by0 = Math.max(0, Math.floor(b.y0));
      const bw = Math.min(v.videoWidth, Math.ceil(b.x1)) - bx0, bh = Math.min(v.videoHeight, Math.ceil(b.y1)) - by0;
      phCtx.drawImage(v, bx0, by0, bw, bh, bx0, by0, bw, bh);
      phCtx.restore();
    } else phCtx.drawImage(v, b.x0, b.y0, sw, sh, PAD, PAD, W, H);
    const img = phCtx.getImageData(PAD, PAD, W, H);
    // Mavi zemin haritası (giden mesaj baloncuğu): ikili görüntüde renk kaybolmadan önce
    const d = img.data, blue = new Uint8Array(W * H);
    // Ekran zemininin renk tonu (güneşte sıcak/sarımsı olabilir): mavilik zemine göre ölçülür
    const hBR = new Int32Array(512), hBG = new Int32Array(512);
    let nBg = 0;
    for (let i = 0; i < d.length; i += 16) if (lum(d, i) >= 150 && sat(d, i) < 60) { hBR[d[i + 2] - d[i] + 255]++; hBG[d[i + 2] - d[i + 1] + 255]++; nBg++; }
    const med = (h) => { let c = 0; for (let t = 0; t < 512; t++) { c += h[t]; if (c >= nBg / 2) return t - 255; } return 0; };
    const bR = nBg > 50 ? Math.min(0, med(hBR)) : 0, bG = nBg > 50 ? Math.min(0, med(hBG)) : 0;
    for (let p = 0, i = 0; p < blue.length; p++, i += 4) if (d[i + 2] - d[i] - bR >= 14 && d[i + 2] - d[i + 1] - bG >= 6) blue[p] = 1; // açık mavi zemin de (198,203,216)
    const { ink } = msgInk({ getImageData: () => img }, W, H, Math.max(2, Math.round(scale * 2)));
    // Koyu mavi giden baloncuk (beyaz yazı): zemin mavi, yazı beyaz → orada mürekkep = beyaz piksel.
    // Beyaz piksel, aynı satırda iki yanında da yakın koyu mavi varsa baloncuğun içindedir (dış kenar sayılmaz).
    // Koyu mavi giden baloncuk (beyaz yazı): baloncuk alanı = iki yanında da (aynı satırda, yakın) mavi piksel olan yer
    // (mavimsi beyaz harfler de "mavi" sayılır, alan kesintisiz olsun). Alanda zemin/yazı ayrımı Otsu eşiğiyle: açık = yazı.
    const lb = new Uint8Array(W * H), zone = new Uint8Array(W * H);
    let nb2 = 0;
    for (let p = 0, i = 0; p < lb.length; p++, i += 4) if (d[i + 2] >= 150 && d[i + 2] - d[i] >= 60) { lb[p] = 1; nb2++; }
    if (nb2 > W * H * 0.01) {
      const D = Math.round(10 * scale), lastL = new Int32Array(W), hist = new Int32Array(256);
      let nz = 0;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        let l0 = -1e9;
        for (let x = 0; x < W; x++) { if (lb[row + x]) l0 = x; lastL[x] = l0; }
        let r0 = 1e9;
        for (let x = W - 1; x >= 0; x--) {
          const p = row + x;
          if (lb[p]) r0 = x;
          if (x - lastL[x] <= D && r0 - x <= D && (lb[p] || lastL[x] !== x)) { zone[p] = 1; nz++; hist[Math.round(lum(d, p * 4))]++; }
        }
      }
      // Koyu mavi baloncuk varsa (zeminin çoğu koyu): Otsu eşiği
      let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
      let wB = 0, sB = 0, best = 0, thr = 150;
      for (let t = 0; t < 256; t++) {
        wB += hist[t]; if (!wB) continue; const wF = nz - wB; if (!wF) break;
        sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, bv = wB * wF * (mB - mF) * (mB - mF);
        if (bv > best) { best = bv; thr = t; }
      }
      // Açık mavi baloncukta (198,203,216 zemin, koyu yazı) bu kural uygulanmaz: zemin ortalaması açıksa atla
      let dark = 0; for (let t = 0; t < 130; t++) dark += hist[t];
      if (dark > nz * 0.4) {
        // Baloncuğun açık kenar halkası yazı sayılmasın: alan kenarından r pikselden yakın yerler boş
        const r = Math.max(3, Math.round(4 * scale)), inner = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) { const p = y * W + x; c = zone[p] ? c + 1 : 0; inner[p] = c > r ? 1 : 0; } c = 0; for (let x = W - 1; x >= 0; x--) { const p = y * W + x; c = zone[p] ? c + 1 : 0; if (c <= r) inner[p] = 0; } }
        for (let x = 0; x < W; x++) { let c = 0; for (let y = 0; y < H; y++) { const p = y * W + x; c = zone[p] ? c + 1 : 0; if (c <= r) inner[p] = 0; } c = 0; for (let y = H - 1; y >= 0; y--) { const p = y * W + x; c = zone[p] ? c + 1 : 0; if (c <= r) inner[p] = 0; } }
        for (let p = 0; p < zone.length; p++) if (zone[p]) ink[p] = inner[p] && lum(d, p * 4) > thr + 8 ? 1 : 0;
        for (let p = 0, i = 0; p < ink.length; p++, i += 4) if (!zone[p] && ink[p] && d[i + 2] - d[i] >= 45) ink[p] = 0; // baloncuk kenarı çizgi olmasın
      }
    }
    // Kalan yazı eğikliği (telefon üç boyutlu da dönebilir: kenarlar düz ama satırlar hafif eğik): satır izdüşümünün en
    // keskin olduğu açı aranır (±0,08) ve yazı + mavi harita dikeyde kaydırılarak düzeltilir
    let bestA = 0, bestV = -1;
    for (let a = -0.08; a <= 0.0801; a += 0.01) {
      const rows = new Float64Array(H + 400), off = 200;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (ink[y * W + x]) { const yy = Math.round(y - a * (x - W / 2)) + off; if (yy >= 0 && yy < rows.length) rows[yy]++; }
      let v = 0; for (let t = 0; t < rows.length; t++) v += rows[t] * rows[t];
      if (v > bestV * 1.02 || (Math.abs(a) < 1e-6 && v >= bestV * 0.98)) { bestV = v; bestA = a; }
    }
    if (Math.abs(bestA) > 0.005) {
      const ink2 = new Uint8Array(W * H), blue2 = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sy = Math.round(y + bestA * (x - W / 2));
        if (sy >= 0 && sy < H) { ink2[y * W + x] = ink[sy * W + x]; blue2[y * W + x] = blue[sy * W + x]; }
      }
      ink.set(ink2); blue.set(blue2);
    }
    for (let p = 0, i = 0; p < ink.length; p++, i += 4) { const c = ink[p] ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255; }
    phCtx.putImageData(img, PAD, PAD);
    return { url: phCanvas.toDataURL('image/png'), scale, PAD, W, H, blue, ink, skew: bestA };
  }
  const PH_UI = /^(new messages?|messages?( encrypted)?|suggested|contacts|recent|favou?rites|calls|notifications|locating|scroll|back|send|select|exit|tab|options|view comments?|set destination|delivered|read|seen|today|yesterday|typing)$/i;
  // OCR bir harfi yanlış okusa da ("Ncw messages") arayüz yazısı sayılır
  const PH_UI_LIST = ['new message', 'new messages', 'view comments', 'view comment', 'notifications', 'set destination', 'favorites', 'favourites', 'suggested', 'contacts', 'messages', 'delivered', 'yesterday'];
  function lev1(a, b) { // a ile b arasındaki düzenleme uzaklığı ≤ 1 mi
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, e = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++e > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return e + (a.length - i) + (b.length - j) <= 1;
  }
  const uiLike = (t) => { const s = t.toLowerCase(); return PH_UI.test(s) || (s.length >= 6 && PH_UI_LIST.some((u) => lev1(u, s))); };
  const isNameLine = (ws) => ws.length <= 3 && ws.every((w) => /^[\p{Lu}@][\p{L}'’.&-]*$/u.test(w.text)) && !/[.!?]$/.test(ws[ws.length - 1].text);
  // Kutunun mavi zemin oranı (mavi baloncuk ~1; beyaz zemindeki mavi yazı/bağlantı ~0,5 — eşik 0,6)
  function blueFrac(prep, x0, y0, x1, y1) {
    const bl = prep.blue; if (!bl) return 0;
    const W = prep.W, H = prep.H;
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W - 1, Math.ceil(x1)); y1 = Math.min(H - 1, Math.ceil(y1));
    let n = 0, t = 0;
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) { t++; n += bl[y * W + x]; }
    return t ? n / t : 0;
  }
  const PH_START = /^(hey|hi|hello|yo|ok|okay|so|and|but|i|i'm|im|i'll|i've|you|u|we|they|he|she|it|it's|its|this|that|the|my|your|just|don't|dont|can|can't|could|would|where|what|when|why|how|who|yeah|yes|no|nah|sorry|thanks|thank|lol|omg|wtf|got|need|meet|come|call|listen|look|wait|did|do|are|is|well|man|dude|bro|babe|baby|good|great|please|pls|plz|let's|lets|guess|remember|tell|hope|still|also|btw|on|at|in|if|there|here|whatever|sure|cool|nice|damn|fuck|shit)\b/i;
  // Çerçeveli baloncuk (açık zemin, mavi kenar = giden): yazının solunda/sağında baloncuk boyunca uzanan dikey çizgi
  function bubbleBorder(prep, x0, y0, x1, y1) {
    const bl = prep.blue; if (!bl) return false; // kenar ince ve açık mavi: ikili görüntüde kopuk, renk haritasında net
    const W = prep.W, H = prep.H, m = Math.round(W * 0.1);
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H - 1, Math.ceil(y1));
    if (y1 - y0 < 8) return false;
    const col = (x) => { let n = 0; for (let y = y0; y <= y1; y++) { const p = y * W + x; n += bl[p] || bl[p - 1] || bl[p + 1] ? 1 : 0; } return n / (y1 - y0 + 1); };
    let L = false, R = false;
    for (let x = Math.max(Math.round(W * 0.03), Math.floor(x0) - m); x < x0 - 3 && !L; x++) if (col(x) >= 0.5) L = true;
    for (let x = Math.ceil(x1) + 3; x <= Math.min(W - 1 - Math.round(W * 0.03), Math.ceil(x1) + m) && !R; x++) if (col(x) >= 0.5) R = true;
    return L || R;
  }
  function phoneParse(lines, prep) {
    const ls = [];
    for (const l of lines || []) {
      // OCR "I" harfini çoğu zaman "|" okur
      // Satırın başında/sonunda boşlukla ayrılmış "|" ise baloncuk kenar çizgisidir: atılır
      // (çerçeveli baloncuk = giden mesaj; açık zeminli, mavi kenarlı)
      const lw0 = l.words || [], lh = lw0.length ? lw0.map((w) => w.y1 - w.y0).sort((a, b) => a - b)[lw0.length >> 1] : 0;
      let bar = 0;
      const words = lw0.filter((w, k) => {
        if (!/^[|\[\]!l1I]$/.test(w.text) || lw0.length === 1) return lw0.length > 1 || w.text !== '|';
        const keep = k === 0 ? lw0[1].x0 - w.x1 <= lh * 0.5 : k === lw0.length - 1 ? w.x0 - lw0[k - 1].x1 <= lh * 0.5 : true;
        if (!keep) bar++;
        return keep;
      }).map((w) => (w.text === '|' ? { ...w, text: 'I', confidence: Math.max(w.confidence, 60) } : w));
      // Bulanık/bozuk okunan satır (kaydırma anı, sıkıştırma): hiç sayma. İstisna: en üstte güvenle okunmuş isim
      // (başlık "Brian": yanındaki simge kırıntıları satır güvenini düşürür) — yalnızca o kelimeler alınır
      let ws;
      if (l.confidence < 55) {
        const top = words.length && Math.min(...words.map((w) => w.y0)) - prep.PAD < prep.H * 0.1;
        ws = top ? words.filter((w) => w.confidence >= 85 && /^[\p{Lu}@][\p{L}'’.&-]+$/u.test(w.text)) : [];
        if (!ws.length) continue;
      } else ws = words.filter((w) => w.confidence >= 40 && /\p{L}|\d/u.test(w.text));
      // Satır başındaki avatar/simge kırıntısı (tek harf, düşük güven) hizalamayı bozmasın
      while (ws.length > 1 && (letterCount(ws[0].text) < 2 && !/^(I|a|A)$/.test(ws[0].text) || ws[0].confidence < 55 && letterCount(ws[0].text) < 3)) ws = ws.slice(1);
      if (!ws.length) continue;
      const text = ws.map((w) => w.text).join(' ').trim();
      const bare = text.replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (letterCount(bare) < 2 || uiLike(bare)) continue;
      // Sol kenar: düşük güvenle atılan ama gerçek harf içeren kelimeler de sayılır ("come" atılınca satır sağa kaymasın)
      const lx = Math.min(ws[0].x0, ...(l.words || []).filter((w) => letterCount(w.text) >= 2 && w.x1 <= ws[0].x0).map((w) => w.x0));
      const ln = { ws, text, bar, conf: l.confidence, x0: lx, x1: Math.max(...ws.map((w) => w.x1)),
        y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)) };
      ln.blue = blueFrac(prep, ln.x0 - prep.PAD, ln.y0 - prep.PAD, ln.x1 - prep.PAD, ln.y1 - prep.PAD);
      ls.push(ln);
    }
    if (!ls.length) return null;
    ls.sort((a, b) => a.y0 - b.y0);
    const Wc = prep.W, Hc = prep.H, P = prep.PAD;
    // Başlık: üstteki kısa satır (kişi / dükkân adı)
    let title = '';
    // (cümle değil: nokta/soru ile bitmez, kelimelerin çoğu büyük harfle başlar — "Mandy's rent just came through." başlık değil)
    // (simge kırıntıları — "£2", "@" — sayılmaz)
    const tw = ls[0].ws.filter((w) => letterCount(w.text) >= 2), capN = tw.filter((w) => /^[\p{Lu}@\d]/u.test(w.text)).length;
    if (tw.length && ls[0].y0 - P < Hc * 0.1 && tw.length <= 5 && !/[.!?]$/.test(tw[tw.length - 1].text) && capN >= Math.ceil(tw.length * 0.6)) {
      title = ls.shift().ws.filter((w) => /\p{L}{2,}/u.test(w.text)).map((w) => w.text.replace(/^[^\p{L}@]+|[^\p{L}.!?']+$/gu, '')).join(' ').trim();
    }
    // Satırları baloncuklara topla (dikey boşluk + sol kenar)
    const bubbles = [];
    for (const l of ls) {
      const h = l.y1 - l.y0, last = bubbles[bubbles.length - 1];
      // Aynı baloncuk: yakın, aynı sol kenar ve aynı zemin (mavi baloncuktan beyaz zemine geçiş yeni baloncuktur)
      const pl = last && last.lines[last.lines.length - 1];
      if (last && l.y0 - last.y1 < h * 0.8 && (Math.abs(l.x0 - last.x0) < Wc * 0.07 || l.blue >= 0.6 && pl.blue >= 0.6) && Math.abs(l.blue - pl.blue) < 0.4) { last.lines.push(l); last.y1 = l.y1; }
      else bubbles.push({ lines: [l], x0: l.x0, y0: l.y0, y1: l.y1 });
      const cur = bubbles[bubbles.length - 1]; cur.x1 = Math.max(cur.x1 || 0, l.x1);
    }
    const out = [];
    bubbles.forEach((b, i) => {
      let lines = b.lines, from = '', cut = false;
      // Ekranın üstünde yarım kalmış baloncuk: yarısı kesik ilk satır(lar) atılır, kalanı "…" ile gösterilir
      if (i === 0) {
        const t0 = lines.map((l) => l.text).join(' ');
        if (/^\p{Ll}/u.test(t0) && !PH_START.test(t0)) {
          cut = true;
        }
        // Başlık çubuğunun altında yarısı kesik ilk satır (düşük güven) atılır
        while (lines.length > 1 && lines[0].conf < (cut ? 80 : 60)) { lines = lines.slice(1); cut = true; }
      }
      // Kişi listesi / grup sohbeti: ilk satır isimse ("Kenton", "Chuck's Gun Shop") gönderen olarak ayır
      if (lines.length > 1 && isNameLine(lines[0].ws)) { from = lines[0].ws.map((w) => w.text).join(' '); lines = lines.slice(1); }
      const text = lines.map((l) => l.text).join(' ').replace(/(\p{L})- (\p{L})/gu, '$1$2').replace(/(^|\s)['‘’](?=\p{L}+['’]\p{L})/gu, '$1').replace(/\s+/g, ' ').trim();
      // (oyunda mesajlar çoğu zaman küçük harfle başlar: "hey, it's me" — tipik cümle başıysa kesik sayılmaz)
      if (cut && lines.length === b.lines.length && lines.length < 2) return; // tek satırlık kesik parça: atla
      const ws = lines.flatMap((l) => l.ws);
      // Kelime denetimi: büyük harfli (isim) ve "…" ile kesilmiş son kelime sayılmaz
      const long = ws.filter((w, j) => letterCount(w.text) >= 3 && !/^\p{Lu}/u.test(w.text) && !(j === ws.length - 1 && /(\.\.\.|…)$/.test(w.text)));
      const known = long.filter((w) => w.known === true).length;
      const okShort = ws.some((w) => /^(ok|okay|yo|hi|hey|no|ya|k|lol|ty|yes|yeah|cool|thanks|sure)\W*$/i.test(w.text));
      if (long.length ? known < long.length * 0.5 : !(okShort || (ws.length >= 2 && ws.filter((w) => w.known === true).length >= 1))) return;
      // Giden: baloncuk mavi zeminli ya da belirgin sağa yaslı
      out.push({ text: cut ? '…' + text : text, from, out: !from && (lines.reduce((a, l) => a + l.bar, 0) >= 2 || bubbleBorder(prep, b.x0 - P, b.y0 - P, b.x1 - P, b.y1 - P) || b.x0 - P > Wc * 0.27 || blueFrac(prep, b.x0 - P, b.y0 - P, b.x1 - P, b.y1 - P) >= 0.6),
        q: ws.reduce((a, w) => a + w.confidence, 0) / ws.length, nw: ws.length });
    });
    if (!out.length) return null;
    const bs = out.slice(-7), nw = bs.reduce((a, x) => a + x.nw, 0);
    // Okuma kalitesi (kelime güveni ortalaması): net kare ~90, hareket bulanıklığı 50–75
    return { title, bubbles: bs, q: bs.reduce((a, x) => a + x.q * x.nw, 0) / nw };
  }
  function phoneHide() {
    phoneShown = null;
    ui.phone.classList.remove('show');
  }
  function phoneLayout(v, c) {
    if (!phoneShown || !phoneBox || !v || !v.videoWidth) return;
    c = c || contentRect(v);
    const kx = c.width / v.videoWidth, ky = c.height / v.videoHeight, b = phoneBox;
    const fontPx = Math.round(Math.min(30, Math.max(13, ((S.fontSize * c.height) / 720) * 0.6)));
    ui.phone.style.fontSize = fontPx + 'px';
    const phoneLeft = c.left + b.x0 * kx - c.width * 0.035; // telefon gövdesi + boşluk
    const width = Math.max(200, Math.min(c.width * 0.3, phoneLeft - c.left - c.width * 0.03));
    ui.phone.style.width = width + 'px';
    ui.phone.style.left = (phoneLeft - width) + 'px';
    const top = c.top + b.y0 * ky;
    ui.phone.style.top = top + 'px';
    // Altyazı alanına inmesin (çevirinin durduğu yer ~%70'in altı)
    ui.phone.style.maxHeight = Math.max(fontPx * 4, c.top + c.height * 0.68 - top) + 'px';
  }
  function phoneRender(v, parsed, trs) {
    ui.phone.textContent = '';
    if (parsed.title) { const h = document.createElement('div'); h.className = 'ph-head'; h.textContent = parsed.title; ui.phone.append(h); }
    const list = document.createElement('div'); list.className = 'ph-list';
    parsed.bubbles.forEach((b, i) => {
      const d = document.createElement('div');
      d.className = 'ph-b ' + (b.out ? 'ph-out' : 'ph-in');
      if (b.from) { const n = document.createElement('b'); n.textContent = b.from + ': '; d.append(n); }
      d.append(trs[i] || b.text);
      list.append(d);
    });
    ui.phone.append(list);
    phoneLayout(v);
    ui.phone.classList.add('show');
  }
  // Telefon takibi: aday kutu OCR ile "içinde okunur yazı var" diye onaylanınca (phoneOk) panel/maske/mesaj kutusu
  // kuralları devreye girer. Onaylanmayan aday (gökyüzü, harita, yükleme ekranı) bir süre yeniden okunmaz.
  var phoneOk = false, phoneRej = null, phoneSeen = null, phoneNull = 0, phoneLowQ = 0;
  function phoneReset() {
    phoneBox = null; phonePrevBox = null; phoneMasks = null; phoneLastSig = null; phoneOk = false; phoneSeen = null; phoneNull = 0; phoneLowQ = 0;
    phoneHide();
  }
  const boxOverlap = (a, c) => {
    const w = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0), h = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
    return w <= 0 || h <= 0 ? 0 : (w * h) / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (c.x1 - c.x0) * (c.y1 - c.y0));
  };
  async function phoneStep(v) {
    if (!S.msgOn || S.from !== 'en' || !v || !v.videoWidth) { if (phoneBox) phoneReset(); return; }
    const vw = v.videoWidth, vh = v.videoHeight, now = performance.now();
    let b = phoneDetect(v);
    // Sağ alttaki mesaj kutusu görünürken onu da içine alan aday telefon değildir (kutunun açık zemini + üstteki
    // gökyüzü uzun bir "ekran" gibi görünüp mesaj, ekranın tepesine sohbet olarak yazılıyordu)
    if (b && msgMask && boxOverlap(b, msgMask) > 0.5) b = null;
    if (!b) {
      // Tespit bir an kaçabilir (el, sallantı, yayın logosu): onaylı telefonu ~2 sn, adayı ~0,6 sn tut
      if (phoneBox && ++phoneMiss >= (phoneOk ? 10 : 3)) phoneReset();
      return;
    }
    phoneMiss = 0;
    // Aynı telefon (sol kenar aynı yerde): sağ kenarı yayın kamerası/el kapatınca daralmasın, son tam genişlik kullanılır
    if (phoneSeen && now - phoneSeen.t < 2500 && Math.abs(b.x0 - phoneSeen.x0) < vw * 0.02) {
      if (b.x1 < phoneSeen.x1 - vw * 0.01) {
        const dx = phoneSeen.x1 - b.x1, k = b.ux || 1; // sağ kenar dx kadar dışarıda: eni ve merkezi de güncelle
        b = { ...b, x1: phoneSeen.x1, w: (b.w || b.x1 - b.x0) + dx * k, cx: (b.cx || 0) + dx / 2 };
      }
      else phoneSeen = { x0: b.x0, x1: b.x1, t: now };
    } else phoneSeen = { x0: b.x0, x1: b.x1, t: now };
    // Başka yere geçtiyse (telefon değil, başka aday) onay sıfırlanır
    if (phoneOk && phoneBox && boxOverlap(b, phoneBox) < 0.3) { phoneOk = false; phoneNull = 0; phoneHide(); phoneLastSig = null; }
    phoneBox = b;
    // Altyazı okumasından çıkar (yalnızca onaylı telefon): telefon ekranı (+ çerçeve payı) ve sağ alttaki tuş ipuçları
    phoneMasks = phoneOk ? [
      { x0: b.x0 - vw * 0.012, y0: b.y0 - vh * 0.02, x1: b.x1 + vw * 0.012, y1: b.y1 + vh * 0.015 },
      { x0: vw * 0.84, y0: vh * 0.8, x1: vw, y1: vh },
    ] : null;
    if (phoneShown) phoneLayout(v);
    // Yalnızca HIZLI hareket (telefon kaldırılıp indiriliyor) beklenir; gemide/araçta sallantı okumayı durdurmaz
    const pb = phonePrevBox; phonePrevBox = b;
    const moved = pb && (Math.abs(b.x0 - pb.x0) > vw * 0.025 || Math.abs(b.x1 - pb.x1) > vw * 0.025 || Math.abs((b.y0 + b.y1) - (pb.y0 + pb.y1)) > vh * 0.3);
    // Aday en az iki ardışık karede görülmeli (tek karelik parlama/geçiş OCR'a gitmesin)
    if (moved || phoneBusy || !pb) return;
    if (!phoneOk && phoneRej && now < phoneRej.until && boxOverlap(b, phoneRej) > 0.6) return;
    if (now - phoneLastOcr < 700) return;
    // Ekran belirgin değiştiyse oku; değişmese de telefon açıkken 2,5 sn'de bir yeniden oku (kaçan/bulanık okuma telafi edilir).
    // Bulanık satırlar güven filtresine takılır, panel yalnızca içerik gerçekten değişince yeniden çizilir.
    const sg = phoneSig(v, b);
    if (phoneOk && phoneSigDiff(phoneLastSig, sg) < 10 && now - phoneLastOcr < 2500) return;
    phoneLastOcr = now;
    phoneBusy = true;
    const seq = ++phoneSeq;
    try {
      phoneLastSig = sg;
      const prep = phonePrep(v, b);
      const res = await ocrImage(prep.url);
      if (!res || !res.ok || seq !== phoneSeq || !phoneBox) return;
      const parsed = phoneParse(res.lines, prep);
      // Tanı kaydı (son okuma): popup/uzantı sayfasından okunabilir
      try {
        chrome.storage.local.set({ xctPhoneDbg: { t: Date.now(), W: prep.W, H: prep.H,
          lines: (res.lines || []).map((l) => ({ t: l.text, c: Math.round(l.confidence), w: (l.words || []).map((w) => [w.text, Math.round(w.confidence), w.x0, w.y0, w.known]) })),
          parsed } });
      } catch (e) { /* sessiz */ }
      if (!parsed) {
        // Aday telefon değilmiş: bu bölge 4 sn yeniden okunmaz. Onaylı telefonda ana ekran/fotoğraf: eski paneli kaldır.
        // Aynı yer üst üste reddedilirse daha uzun beklenir (sabit bir nesne OCR'ı meşgul etmesin)
        if (!phoneOk) { const again = phoneRej && boxOverlap(b, phoneRej) > 0.6; phoneRej = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, until: performance.now() + (again ? 10000 : 4000) }; }
        else if (++phoneNull >= 2 && phoneShown) phoneHide();
        return;
      }
      phoneNull = 0;
      // Hareket bulanıklığı: kelime güveni düşük baloncuk ("Tucia… FOT") gösterilmez; kare toptan kötüyse
      // (gösterilenden belirgin düşük) panel bozulmaz, hemen yeniden okunur. Kalıcı düşükse 4 denemeden sonra kabul.
      parsed.bubbles = parsed.bubbles.filter((x) => x.q >= 75);
      if (!parsed.bubbles.length || parsed.q < 72) { phoneLastSig = null; return; }
      if (phoneShown && parsed.q < phoneShown.q - 5 && ++phoneLowQ < 4) { phoneLastSig = null; return; }
      phoneLowQ = 0;
      if (parsed.q < 85) phoneLastSig = null; // sınırda kalite: daha net kareyle kısa sürede yeniden oku
      if (!phoneOk) { phoneOk = true; phoneRej = null; }
      // Daha önce çevrilen baloncuklar: OCR aynı yazıyı biraz farklı okusa da eski metin + çeviri kullanılır.
      // Yeni okuma belirgin daha netse eski (bulanık) okumanın yerine geçer ve yeniden çevrilir.
      const memo = (t) => phoneMemo.find((m) => m.src === t || similar(m.src, t));
      for (const x of parsed.bubbles) {
        const m = memo(x.text);
        if (!m) continue;
        if (x.text !== m.src && x.q > (m.q || 0) + 3) { m.src = x.text; m.q = x.q; m.tr = null; } else x.text = m.src;
      }
      const keyOf = (x) => (x.out ? '>' : '<') + x.from + '|' + x.text;
      const key = parsed.title + '\n' + parsed.bubbles.map(keyOf).join('\n');
      if (phoneShown && phoneShown.key === key) { phoneShown.q = Math.max(phoneShown.q, parsed.q); return; }
      // Eksik okuma (hepsi zaten gösteriliyor, sadece birkaçı kaçmış): paneli bozma
      if (phoneShown && phoneShown.title === parsed.title && parsed.bubbles.length < phoneShown.keys.length && parsed.bubbles.every((x) => phoneShown.keys.includes(keyOf(x)))) return;
      dbg({ phone: parsed.title, n: parsed.bubbles.length, last: parsed.bubbles[parsed.bubbles.length - 1].text });
      const trs = await Promise.all(parsed.bubbles.map((x) => {
        const m = memo(x.text);
        if (m && m.tr) return m.tr;
        return translate(smsAc(x.text)).then((t) => {
          if (t) { if (m) m.tr = t; else { phoneMemo.push({ src: x.text, tr: t, q: x.q }); if (phoneMemo.length > 80) phoneMemo.shift(); } }
          return t;
        }).catch(() => x.text);
      }));
      if (seq !== phoneSeq || !phoneBox || !S.enabled) return;
      phoneShown = { key, q: parsed.q, title: parsed.title, keys: parsed.bubbles.map(keyOf), srcs: parsed.bubbles.map((x) => x.text) };
      phoneRender(v, parsed, trs);
    } catch (e) { /* telefon okunamadı: altyazıyı etkilemesin */ } finally { phoneBusy = false; }
  }
  setInterval(() => {
    if (orphaned || !S.enabled || selecting) { if (phoneBox || phoneShown) phoneReset(); return; }
    const v = currentVideo;
    if (v && v.seeking) { if (phoneBox || phoneShown) phoneReset(); return; } // video sarıldı: eski panel kalmasın
    if (!v || v.paused || document.hidden) return;
    phoneStep(v);
  }, 200);

  let loop = null;
  function restartLoop() {
    clearInterval(loop);
    if (!orphaned) loop = setInterval(tick, Math.max(100, S.interval));
  }

  // ---------- Aç / kapat ----------
  async function setEnabled(on, fromGesture) {
    if (orphaned) return;
    S.enabled = on;
    renderToggle();
    try { chrome.storage.sync.set({ enabled: on }); } catch (e) { orphan(); return; }
    if (on) {
      resetDetection();
      frameFlashUntil = Date.now() + 2500;
      setTimeout(layout, 2600);
      layout();
      status('Hazırlanıyor…', true);
      if (S.engine !== 'google') ensureBuiltin(fromGesture);
      // OCR'ı ve çeviri bağlantısını önceden ısıt → ilk altyazı beklemeden gelsin
      if (S.from === 'en' && S.to === 'tr') havuzYukle();
      const [w] = await Promise.all([send({ type: 'warmup' }), S.engine === 'builtin' ? null : translate('Hello').catch(() => null)]);
      status(w.ok ? 'Hazır — altyazı bekleniyor' : 'OCR başlatılamadı: ' + w.error, !w.ok);
    } else {
      clearText();
      status('Kapalı');
    }
  }

  ui.toggle.addEventListener('click', () => setEnabled(!S.enabled, true));

  // ---------- Bölge seçimi ----------
  let selecting = false;
  function startSelect() {
    if (orphaned) return;
    const v = findVideo();
    if (!v) { status('Önce oyunu başlat — video bulunamadı'); return; }
    currentVideo = v;
    selecting = true;
    const c = contentRect(v);
    place(ui.select, c);
    ui.select.style.display = 'block';
    ui.rect.style.display = 'none';
    hideSubtitle(true);
    let start = null;

    const finish = (save, rect) => {
      selecting = false;
      ui.select.style.display = 'none';
      ui.select.onmousedown = ui.select.onmousemove = ui.select.onmouseup = null;
      document.removeEventListener('keydown', onKey, true);
      if (save && rect) {
        S.region = rect;
        try { chrome.storage.sync.set({ region: rect }); } catch (e) {}
        resetDetection();
        frameFlashUntil = Date.now() + 2500;
        setTimeout(layout, 2600);
        status('Bölge kaydedildi');
      }
      layout();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    document.addEventListener('keydown', onKey, true);

    const local = (e) => {
      const b = ui.select.getBoundingClientRect();
      return { x: Math.min(Math.max(e.clientX - b.left, 0), b.width), y: Math.min(Math.max(e.clientY - b.top, 0), b.height) };
    };
    ui.select.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();
      start = local(e);
      ui.rect.style.display = 'block';
      place(ui.rect, { left: start.x, top: start.y, width: 0, height: 0 });
    };
    ui.select.onmousemove = (e) => {
      if (!start) return;
      const p = local(e);
      place(ui.rect, { left: Math.min(start.x, p.x), top: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) });
    };
    ui.select.onmouseup = (e) => {
      if (!start) return;
      e.preventDefault(); e.stopPropagation();
      const p = local(e), b = ui.select.getBoundingClientRect();
      const rect = {
        x: Math.min(start.x, p.x) / b.width, y: Math.min(start.y, p.y) / b.height,
        w: Math.abs(p.x - start.x) / b.width, h: Math.abs(p.y - start.y) / b.height,
      };
      start = null;
      if (rect.w < 0.03 || rect.h < 0.02) { status('Alan çok küçük, tekrar çiz'); ui.rect.style.display = 'none'; return; }
      finish(true, rect);
    };
  }
  ui.regionBtn.addEventListener('click', startSelect);

  // ---------- Önizleme (popup'tan) ----------
  function preview() {
    const v = findVideo();
    if (!v) { status('Önizleme için oyun videosu gerekli'); return; }
    currentVideo = v;
    frameFlashUntil = Date.now() + 3000;
    textTopFrac = 0;
    showSubtitle('Patronum senden borcunu ödemeni istememi söyledi.');
    setTimeout(() => { if (ui.subText.textContent.startsWith('Patronum')) hideSubtitle(true); layout(); }, 3500);
  }

  // ---------- Ayarlar ve mesajlar ----------
  try {
    // v: 0 → kayıtta sürüm yoksa varsayılanın (güncel sürüm) yerine 0 gelsin, taşıma atlanmasın
    chrome.storage.sync.get({ ...DEFAULTS, v: 0 }, (stored) => {
      if (!alive()) return;
      S = migrate(stored || {});
      renderToggle();
      restartLoop();
      if (S.enabled) setEnabled(true, false);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || orphaned) return;
      const before = { ...S };
      for (const [k, { newValue }] of Object.entries(changes)) S[k] = newValue === undefined ? DEFAULTS[k] : newValue;
      if (before.from !== S.from || before.to !== S.to) {
        translator = null; translatorFailed = false; lastSource = ''; // önbellek anahtarları dile göre ayrı
      }
      if (before.interval !== S.interval) restartLoop();
      if (before.msgOn !== S.msgOn && !S.msgOn) { msgHide(); phoneReset(); }
      if (before.hintOn !== S.hintOn && !S.hintOn) hintHide();
      if (before.cardOn !== S.cardOn && !S.cardOn) cardHide();
      if (before.textMode !== S.textMode || before.threshold !== S.threshold || JSON.stringify(before.region) !== JSON.stringify(S.region)) {
        resetDetection();
      }
      if (before.enabled !== S.enabled) {
        if (S.enabled) setEnabled(true, false); else { renderToggle(); clearText(); }
      }
      layout();
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.target !== 'content' || orphaned) return;
      if (msg.type === 'command' && msg.name === 'toggle') setEnabled(!S.enabled, false);
      if (msg.type === 'command' && msg.name === 'select-region') startSelect();
      if (msg.type === 'flash-region') { frameFlashUntil = Date.now() + 2500; layout(); setTimeout(layout, 2600); }
      if (msg.type === 'preview') preview();
    });
  } catch (e) {
    orphan();
  }

  setInterval(() => {
    if (orphaned) return;
    mount();
    if (shownText || Date.now() < frameFlashUntil) layout();
  }, 1000);
})();
