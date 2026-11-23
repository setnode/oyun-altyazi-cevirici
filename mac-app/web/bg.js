// Mac uygulaması: eklentinin servis çalışanı + offscreen belgesinin işi (OCR, çeviri, havuz).
// Xbox sayfası da yakalanan pencerenin katmanı da OCR/çeviri isteklerini buraya gönderir.
(() => {
  const BASE = 'xct://app/ext/';
  const post = (m) => window.webkit.messageHandlers.xct.postMessage(m);

  // ---------- Servis çalışanı (background.js + offscreen.js ile aynı davranış) ----------
  // ---------- Havuz + otomatik hafıza ----------
  // Hazır havuz (denetlenmiş GTA 6 çevirileri) önce gelir; ardından oyunda öğrenilenler:
  // uygulamanın kendi kaydı (xctGta6Kayit, DeepL'in iyileştirdikleri dahil) ve eklentiden aktarılan
  // kayıt (xctEklentiKayit). Böylece bir kez görülen cümle bir dahaki sefere OCR'dan hemen sonra,
  // ağa gitmeden çıkar. Aynı cümlede hazır havuz hep kazanır.
  let hazirHavuz = {}, havuzItems = {};
  const H = XCT_HAVUZ;
  function kayitEkle(items, kayit) {
    let n = 0;
    for (const [en0, tr0] of Object.entries(kayit || {})) {
      const en = String(en0 || '').trim(), tr = typeof tr0 === 'string' ? tr0.trim() : '';
      if (!en || !tr || en === tr || /\[/.test(en) || (en.match(/\p{L}{2,}/gu) || []).length < 2) continue;
      const pairs = [[en, tr]];
      const es = H.sentences(en), ts = H.sentences(tr);
      if (es.length > 1 && es.length === ts.length) es.forEach((e, i) => pairs.push([e, ts[i]]));
      for (const [e, t] of pairs) {
        const k = H.key(e);
        if (!k || k.length < 6 || k.indexOf(' ') < 0 || k in items) continue;
        items[k] = t; n++;
      }
    }
    return n;
  }
  async function havuzKur() {
    const d = await chrome.storage.local.get(['xctGta6Kayit', 'xctEklentiKayit']).catch(() => ({}));
    const items = { ...hazirHavuz };
    const a = kayitEkle(items, d.xctGta6Kayit), b = kayitEkle(items, d.xctEklentiKayit);
    sonKayitSayisi = Object.keys(d.xctGta6Kayit || {}).length;
    havuzItems = items;
    H.load(items);
    console.log('havuz: hazır ' + Object.keys(hazirHavuz).length + ' + uygulama kaydı ' + a + ' + eklenti kaydı ' + b);
  }
  const havuzHazir = fetch(BASE + 'gta6-havuz.json')
    .then((r) => (r.ok ? r.json() : {})).then((items) => { hazirHavuz = items || {}; return havuzKur(); }).catch(() => {});
  // Oyunda yeni öğrenilen cümleler hafızaya dakikada bir katılır (kayıt büyüyünce değişiklik
  // bildirimi gelmediği için sayıya bakılır; havuz bu arka plan belgesinde kurulur, oyunu yormaz)
  let sonKayitSayisi = 0;
  setInterval(async () => {
    await havuzHazir;
    const d = await chrome.storage.local.get('xctGta6Kayit').catch(() => ({}));
    if (Object.keys(d.xctGta6Kayit || {}).length !== sonKayitSayisi) havuzKur();
  }, 60000);

  // ---------- OCR: iki motor ----------
  // Ana belgedeki 2 işçi altyazıya, iframe'deki 2 işçi büyük okumalara (kart, ipucu, telefon, tabela).
  // Büyük okumalar 0,5–1,5 sn sürebiliyor; altyazı onların arkasında beklerse geç çıkıyordu.
  // İframe ile yalnızca postMessage konuşulur; hazır değilse ya da hata/zaman aşımı olursa
  // okuma ana işçilerde yapılır (altyazı hiçbir durumda kesilmez).
  const BUYUK = 48 * 1024;
  const sirada = [0, 0];
  let ikinciHazir = false, sonId = 0;
  const bekleyen = new Map();
  const cerceve = () => { const f = document.getElementById('ocr2'); return f && f.contentWindow; };
  addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.xct === 'ocr2Hazir') { ikinciHazir = true; try { cerceve().postMessage({ xct: 'warmup' }, '*'); } catch (x) {} return; }
    if (m.xct !== 'ocrSonuc') return;
    const b = bekleyen.get(m.id); if (!b) return;
    bekleyen.delete(m.id);
    m.ok ? b.resolve(m.r) : b.reject(new Error(m.error));
  });
  function ikinciyle(image) {
    return new Promise((resolve, reject) => {
      const id = ++sonId;
      const t = setTimeout(() => { if (bekleyen.delete(id)) reject(new Error('ikinci motor yanıt vermedi')); }, 8000);
      bekleyen.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (x) => { clearTimeout(t); reject(x); } });
      try { cerceve().postMessage({ xct: 'ocr', id, image }, '*'); } catch (x) { bekleyen.delete(id); clearTimeout(t); reject(x); }
    });
  }
  async function ocr(image) {
    let m = 0;
    if (ikinciHazir) {
      if (String(image).length > BUYUK) m = 1;                   // büyük okuma: ana işçileri meşgul etmesin
      else if (sirada[0] >= 2 && sirada[1] < sirada[0]) m = 1;   // altyazı: ana işçiler doluysa boştakine taş
    }
    sirada[m]++;
    try {
      if (m) { try { return await ikinciyle(image); } catch (x) { console.log('ikinci OCR motoru: ' + x.message); } }
      return await xctRecognize(BASE, image);
    } finally { sirada[m]--; }
  }

  window.__xctBg = async (msg) => {
    try {
      if (msg.type === 'warmup') { await xctWarmup(BASE); return { ok: true }; }
      if (msg.type === 'ocr') { if (window.__xctDebugOcr) { window.__lastOcr = window.__lastOcr || []; window.__lastOcr.push(msg.image); if (window.__lastOcr.length > 6) window.__lastOcr.shift(); } return await ocr(msg.image); }
      if (msg.type === 'translate') {
        if (msg.raw && msg.from === 'en' && msg.to === 'tr') {
          await havuzHazir;
          const hit = XCT_HAVUZ.lookup(msg.raw);
          if (hit) return { ok: true, text: hit, havuz: true };
        }
        return { ok: true, text: await XCT_NET.translate(msg.text, msg.from, msg.to) };
      }
      if (msg.type === 'deepl') {
        const { xctDeeplKey: key } = await chrome.storage.local.get('xctDeeplKey');
        return { ok: true, text: await XCT_NET.deepl(msg.text, msg.from, msg.to, key) };
      }
      if (msg.type === 'deeplUsage') {
        const key = msg.key != null ? msg.key : (await chrome.storage.local.get('xctDeeplKey')).xctDeeplKey;
        return { ok: true, usage: await XCT_NET.deeplUsage(key || '') };
      }
      if (msg.type === 'havuzVeri') { await havuzHazir; return { ok: true, items: havuzItems }; }
      if (msg.type === 'netwarm') { XCT_NET.warm(); return { ok: true }; }
      if (msg.type === 'hello') { post({ op: 'hello' }); return { ok: true }; }
      return { ok: false, error: 'bilinmeyen istek: ' + msg.type };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  // OCR işçilerini ve çeviri bağlantısını önceden ısıt
  xctWarmup(BASE).catch(() => {});
})();
