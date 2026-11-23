// setdeniz play: Xbox yayınının kalitesi ve gecikmesi (xbox.com sayfasının kendi dünyasında çalışır).
// 1) Oturum açılırken sunucuya 1440p ekranlı Windows/Edge cihazı olarak bildirilir (Safari'ye daha düşük kalite veriliyor).
// 2) Çözünürlük seçimi kullanıcının xbox.com ayarına bırakılır (Remote Play'de 1440p her planda açık).
// 3) Kodek sırası en yüksek kaliteli H.264 profiline göre dizilir.
// 4) Alıcı tamponu en kısaya çekilir (gecikme).
// 5) Her saniye çözünürlük, fps ve gecikme uygulamaya bildirilir (pencere başlığında görünür).
(() => {
  if (window.__xctKalite) return;
  window.__xctKalite = true;
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.xctPage;
  const post = (m) => { try { handler && handler.postMessage(m); } catch (e) {} };
  const Q = window.__xctHedef || { w: 2560, h: 1440 };
  // Kayıtta konsol/oturum kimlikleri gizlenir (tanı raporu başkasına gönderilebilir)
  const gizle = (t) => t.replace(/("(?:serverId|sessionId|consoleId|deviceId|clientSessionId|id)\\?"\s*:\s*\\?")[^"\\]+/gi, '$1***');
  const log = (t, d) => post({ op: 'log', text: gizle(t + ' ' + (d === undefined ? '' : typeof d === 'string' ? d : JSON.stringify(d))).slice(0, 1800) });
  const durum = (t) => post({ op: 'durum', text: t });
  // Uyumlu mod: kalite ayarları (cihaz bildirimi, kodek sırası, kısa tampon) kapalı, yayın Safari'nin
  // kendi ayarlarıyla açılır. Görüntü gelmezse kendiliğinden açılır; menüden de açılıp kapatılır.
  const UYUMLU = (() => { try { return localStorage.getItem('xctUyumlu') === '1'; } catch (e) { return false; } })();
  post({ op: 'uyumlu', on: UYUMLU });
  if (UYUMLU) log('uyumlu mod açık: kalite ayarları uygulanmıyor');

  // ---------- 1) Oturum isteği: cihaz bilgisi ----------
  const PLAY = /\/v\d+\/sessions\/(cloud|home)\/play\b/i;
  function cihaz(json) {
    try {
      const d = JSON.parse(json);
      d.dev = d.dev || {};
      d.dev.os = { ...(d.dev.os || {}), name: 'windows', ver: '22631.2715', platform: 'desktop' };
      d.dev.hw = { ...(d.dev.hw || {}), make: 'Microsoft', model: 'unknown', sdktype: 'web' };
      d.dev.browser = { ...(d.dev.browser || {}), browserName: 'edge', osName: 'windows' };
      d.dev.displayInfo = { ...(d.dev.displayInfo || {}), dimensions: { widthInPixels: Q.w, heightInPixels: Q.h }, pixelDensity: { dpiX: 1, dpiY: 1 } };
      return JSON.stringify(d);
    } catch (e) { return json; }
  }
  function govde(body) {
    try {
      const b = JSON.parse(body);
      if (b && b.settings) { b.settings.osName = 'windows'; }
      return JSON.stringify(b);
    } catch (e) { return body; }
  }
  // Oturum isteğinin sonucu: kalite ayarlarıyla reddedilirse uyumlu moda geçilir
  function oturumSonucu(status, metin) {
    log('oturum yanıtı ' + status);
    if (status >= 200 && status < 300) return;
    Promise.resolve().then(metin).then((t) => log('oturum hatası', String(t).slice(0, 600))).catch(() => {});
    // 409 (başka yerde açık oturum) ve 429 (yoğunluk) kalite ayarından değil
    if (!UYUMLU && status !== 409 && status !== 429 && status >= 400) {
      try { localStorage.setItem('xctUyumlu', '1'); } catch (e) {}
      durum('Oturum açılamadı: uyumlu moda geçiliyor, sayfa yenileniyor. Oyunu yeniden başlat.');
      setTimeout(() => location.reload(), 3000);
    }
  }
  const realFetch = window.fetch;
  if (!UYUMLU) window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      if (url && PLAY.test(url)) {
        const isReq = typeof Request !== 'undefined' && input instanceof Request;
        return (async () => {
          const h = new Headers((init && init.headers) || (isReq ? input.headers : undefined));
          const di = h.get('X-MS-Device-Info');
          if (di) h.set('X-MS-Device-Info', cihaz(di));
          let body = init && init.body;
          if (body === undefined && isReq && !/^(GET|HEAD)$/i.test(input.method)) body = await input.clone().text();
          if (typeof body === 'string') body = govde(body);
          const opts = { ...(isReq ? { method: input.method, credentials: input.credentials, mode: input.mode, cache: input.cache, redirect: input.redirect, referrer: input.referrer } : {}), ...(init || {}), headers: h };
          if (body !== undefined) opts.body = body;
          log('oturum (fetch)', { url: url.replace(/\?.*/, ''), cihaz: h.get('X-MS-Device-Info') ? JSON.parse(h.get('X-MS-Device-Info')).dev : null, govde: typeof body === 'string' ? body.slice(0, 500) : null });
          const resp = await realFetch.call(window, url, opts);
          oturumSonucu(resp.status, () => resp.clone().text());
          return resp;
        })();
      }
    } catch (e) { log('fetch hata', String(e)); }
    return realFetch.apply(this, arguments);
  };
  // Aynısı XHR ile giderse
  const xo = XMLHttpRequest.prototype.open, xh = XMLHttpRequest.prototype.setRequestHeader, xs = XMLHttpRequest.prototype.send;
  if (!UYUMLU) XMLHttpRequest.prototype.open = function (m, u) { this.__xctPlay = PLAY.test(String(u)); this.__xctUrl = String(u); return xo.apply(this, arguments); };
  if (!UYUMLU) XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__xctPlay && /^x-ms-device-info$/i.test(k)) v = cihaz(v);
    return xh.call(this, k, v);
  };
  if (!UYUMLU) XMLHttpRequest.prototype.send = function (body) {
    if (this.__xctPlay && typeof body === 'string') { body = govde(body); log('oturum (xhr)', { url: this.__xctUrl.replace(/\?.*/, ''), govde: body.slice(0, 500) }); }
    if (this.__xctPlay) this.addEventListener('loadend', () => oturumSonucu(this.status, () => String(this.responseText || '')));
    return xs.call(this, body);
  };
  // Sayfa cihazın ekranını da sorabilir: 1440p ekran gibi görünsün
  if (!UYUMLU) try {
    for (const [k, v] of [['width', Q.w], ['height', Q.h], ['availWidth', Q.w], ['availHeight', Q.h]]) {
      Object.defineProperty(Screen.prototype, k, { get: () => v, configurable: true });
    }
  } catch (e) {}

  // ---------- 2) Görüntü tercihi mesajları ----------
  function boyutla(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 6) return;
    for (const k of Object.keys(o)) {
      const lk = k.toLowerCase();
      if (typeof o[k] === 'number' && /^(width|horizontal|preferredwidth|maxwidth)$/.test(lk)) o[k] = Q.w;
      else if (typeof o[k] === 'number' && /^(height|vertical|preferredheight|maxheight)$/.test(lk)) o[k] = Q.h;
      else if (typeof o[k] === 'object') boyutla(o[k], depth + 1);
    }
  }
  let ilkMesaj = 0;
  const origCreateDC = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
    const ch = origCreateDC.call(this, label, opts);
    const origSend = ch.send;
    ch.send = function (data) {
      try {
        // Çözünürlük seçimi xbox.com ayarlarındaki "Remote Play / Cloud Gaming çözünürlüğü"ne bırakılır; yalnızca kaydedilir
        if (typeof data === 'string' && /dimensionschanged|videopreference|resolution/i.test(data)) log('görüntü tercihi (' + label + ')', data.slice(0, 400));
        if (ilkMesaj < 12 && typeof data === 'string') { ilkMesaj++; log('kanal ' + label, data.slice(0, 300)); }
      } catch (e) {}
      return origSend.call(this, data);
    };
    return ch;
  };

  // ---------- 3) Kodek: en yüksek H.264 profili önce ----------
  function h264Once(sdp) {
    try {
      const lines = sdp.split('\r\n');
      const mi = lines.findIndex((l) => l.startsWith('m=video'));
      if (mi < 0) return sdp;
      const pts = lines[mi].split(' ').slice(3);
      const rank = {};
      for (const pt of pts) {
        const rtp = lines.find((l) => l.startsWith('a=rtpmap:' + pt + ' ')) || '';
        const fmtp = lines.find((l) => l.startsWith('a=fmtp:' + pt + ' ')) || '';
        const pl = (fmtp.match(/profile-level-id=([0-9a-f]{2})/i) || [])[1] || '';
        // 64 = High, 4d = Main, 42 = Baseline
        rank[pt] = /H264/i.test(rtp) ? (pl.toLowerCase() === '64' ? 0 : pl.toLowerCase() === '4d' ? 1 : 2) : 3;
      }
      const sorted = [...pts].sort((a, b) => rank[a] - rank[b]);
      lines[mi] = lines[mi].split(' ').slice(0, 3).concat(sorted).join(' ');
      return lines.join('\r\n');
    } catch (e) { return sdp; }
  }
  const origSLD = RTCPeerConnection.prototype.setLocalDescription;
  RTCPeerConnection.prototype.setLocalDescription = function (desc) {
    if (!UYUMLU && desc && desc.sdp && desc.type === 'offer') desc = { type: desc.type, sdp: h264Once(desc.sdp) };
    return origSLD.apply(this, desc ? [desc] : arguments);
  };

  // ---------- 4) Düşük gecikme + 5) ölçüm ----------
  const pcs = new Set();
  const OrigPC = window.RTCPeerConnection;
  function PC(...args) {
    const pc = new OrigPC(...args);
    pcs.add(pc);
    pc.addEventListener('track', (e) => {
      if (UYUMLU) return;
      try { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0; } catch (x) {}
      try { if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0; } catch (x) {}
    });
    pc.addEventListener('iceconnectionstatechange', () => log('ice ' + pc.iceConnectionState));
    pc.addEventListener('connectionstatechange', () => {
      const st = pc.connectionState;
      log('bağlantı ' + st);
      if (st === 'connecting') durum('Bağlanıyor…');
      else if (st === 'connected') { durum('Bağlandı, görüntü bekleniyor…'); bekci(pc); }
      else if (st === 'failed') durum('Bağlantı kurulamadı: ağ (NAT/güvenlik duvarı) yayını engelliyor olabilir');
      else if (st === 'disconnected') durum('Bağlantı koptu');
      if (st === 'closed') pcs.delete(pc);
    });
    return pc;
  }
  PC.prototype = OrigPC.prototype;
  Object.setPrototypeOf(PC, OrigPC);
  window.RTCPeerConnection = PC;

  // Görüntü bekçisi: bağlandıktan sonra hiç kare çözülmezse (siyah ekran) ayrıntılar kaydedilir; kalite
  // modundaysa uyumlu moda geçilip sayfa yenilenir (oyun yeniden başlatılınca Safari'nin kendi ayarlarıyla açılır)
  async function videoDurumu(pc) {
    const st = await pc.getStats();
    let v = null, pair = null; const loc = {}, rem = {}, codecs = {};
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') v = r;
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      if (r.type === 'local-candidate') loc[r.id] = r;
      if (r.type === 'remote-candidate') rem[r.id] = r;
      if (r.type === 'codec') codecs[r.id] = r;
    });
    const c = v && codecs[v.codecId];
    return {
      video: !!v, alinan: v ? v.framesReceived || 0 : 0, cozulen: v ? v.framesDecoded || 0 : 0, bayt: v ? v.bytesReceived || 0 : 0,
      boyut: v ? (v.frameWidth || 0) + 'x' + (v.frameHeight || 0) : '', kodek: c ? c.mimeType + ' ' + (c.sdpFmtpLine || '') : '',
      cozucu: v && v.decoderImplementation, paket: v ? v.packetsReceived || 0 : 0, kayip: v ? v.packetsLost || 0 : 0,
      yol: pair ? ((loc[pair.localCandidateId] || {}).candidateType + '→' + (rem[pair.remoteCandidateId] || {}).candidateType + ' ' + ((loc[pair.localCandidateId] || {}).protocol || '')) : '',
    };
  }
  function bekci(pc) {
    setTimeout(async () => { try { log('tanı 4 sn', await videoDurumu(pc)); } catch (e) {} }, 4000);
    setTimeout(async () => {
      if (pc.connectionState !== 'connected') return;
      let d; try { d = await videoDurumu(pc); } catch (e) { return; }
      log('tanı 12 sn', d);
      if (d.cozulen > 0) return;
      if (!UYUMLU) {
        try { localStorage.setItem('xctUyumlu', '1'); } catch (e) {}
        durum('Görüntü gelmedi: uyumlu moda geçiliyor, sayfa yenileniyor. Oyunu yeniden başlat.');
        log('uyumlu moda geçildi');
        setTimeout(() => location.reload(), 3000);
      } else {
        durum(d.bayt ? 'Görüntü verisi geliyor ama çözülemiyor (Yardım › Tanı raporu)' : 'Görüntü verisi hiç gelmiyor: ağ engelliyor olabilir (Yardım › Tanı raporu)');
      }
    }, 12000);
  }

  let last = null;
  setInterval(async () => {
    for (const pc of pcs) {
      if (pc.connectionState !== 'connected') continue;
      try {
        const st = await pc.getStats();
        let v = null, pair = null, codecs = {};
        st.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') v = r;
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
          if (r.type === 'codec') codecs[r.id] = r;
        });
        if (!v) continue;
        const now = { t: performance.now(), bytes: v.bytesReceived || 0, jb: v.jitterBufferDelay || 0, jbn: v.jitterBufferEmittedCount || 0, dec: v.totalDecodeTime || 0, decn: v.framesDecoded || 0 };
        let kbps = 0, jbMs = 0, decMs = 0;
        if (last) {
          const dt = (now.t - last.t) / 1000;
          kbps = dt > 0 ? ((now.bytes - last.bytes) * 8) / dt / 1000 : 0;
          jbMs = now.jbn > last.jbn ? ((now.jb - last.jb) / (now.jbn - last.jbn)) * 1000 : 0;
          decMs = now.decn > last.decn ? ((now.dec - last.dec) / (now.decn - last.decn)) * 1000 : 0;
        }
        last = now;
        const c = codecs[v.codecId] || {};
        post({
          op: 'stats', w: v.frameWidth || 0, h: v.frameHeight || 0, fps: Math.round(v.framesPerSecond || 0),
          rtt: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : -1,
          jb: Math.round(jbMs), dec: Math.round(decMs * 10) / 10, mbps: Math.round(kbps / 100) / 10,
          codec: (c.mimeType || '').replace('video/', '') + (c.sdpFmtpLine && /profile-level-id=64/i.test(c.sdpFmtpLine) ? ' High' : ''),
          lost: v.packetsLost || 0, dropped: v.framesDropped || 0,
        });
      } catch (e) {}
      break;
    }
  }, 1000);
})();
