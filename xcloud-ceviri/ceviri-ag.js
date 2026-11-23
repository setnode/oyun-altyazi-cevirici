// Google çevirisi (offscreen belgede ve servis çalışanında ortak).
// İki uç nokta (clients5 dict-chrome-ex ve translate.googleapis gtx) aynı anda sorulur, ilk gelen alınır:
// yeni cümlede her biri 250–900 ms arası oynuyor, yarışınca ortanca ~400 ms. 429/403 ("çok fazla istek")
// veren uç nokta 1 dakika dinlendirilir; o sürede yalnızca diğeri kullanılır.
const XCT_NET = (() => {
  const rest = { c5: 0, gtx: 0 };
  let lastUse = 0;

  function fail(name, status) {
    if (status === 429 || status === 403) rest[name] = Date.now() + 60000;
    return new Error('Google çeviri HTTP ' + status);
  }

  async function c5(text, from, to, signal) {
    const url = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex' +
      '&sl=' + encodeURIComponent(from) + '&tl=' + encodeURIComponent(to) + '&q=' + encodeURIComponent(text);
    const res = await fetch(url, { signal });
    if (!res.ok) throw fail('c5', res.status);
    const d = await res.json();
    // Biçimler: ["çeviri"] · [["çeviri","en"]] · {sentences:[{trans}]}
    let t = Array.isArray(d) ? d[0] : d;
    if (Array.isArray(t)) t = t[0];
    if (t && typeof t === 'object' && Array.isArray(t.sentences)) t = t.sentences.map((s) => s.trans || '').join('');
    if (typeof t !== 'string' || !t.trim()) throw new Error('Google çeviri boş döndü');
    return t;
  }

  async function gtx(text, from, to, signal) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
      '&sl=' + encodeURIComponent(from) + '&tl=' + encodeURIComponent(to) + '&q=' + encodeURIComponent(text);
    const res = await fetch(url, { signal });
    if (!res.ok) throw fail('gtx', res.status);
    const d = await res.json();
    const t = (d[0] || []).map((part) => part[0]).join('');
    if (!t.trim()) throw new Error('Google çeviri boş döndü');
    return t;
  }

  // İsim koruması: Google bazı karakter adlarını sözcük sanıp çeviriyor ("Bill with the pill" → "Hapı faturala",
  // "It's Moses" → "Musa", "Peaches" → "Şeftali"). Çeviriden önce ad, Google'ın tanımadığı uydurma bir adla
  // değiştirilir; uydurma adın son hecesi asıl adla aynı sesi verir, böylece Google'ın eklediği Türkçe ek
  // ("Bill'i", "Cat'e", "Lucky'ye") asıl ada da uyar. Çeviriden sonra uydurma ad yerine asıl ad konur.
  // [ad, uydurma ad, yalnız cümle ortasında] ("Lucky for you" cümle başında ad değildir)
  const ISIMLER = [
    ['Bill', 'Zorbil'], ['Moses', 'Zormozet'], ['Peaches', 'Zorpiçit'], ['Dunk', 'Zordunk'],
    ['Cat', 'Zorket'], ['Lucky', 'Zorlaki', true],
  ];
  const ISIM_RE = new RegExp('(^|[.!?…]\\s+|[^.!?…\\s]\\s*)\\b(' + ISIMLER.map((x) => x[0]).join('|') + ')\\b(?!-)', 'g');
  function protectNames(text) {
    const used = [];
    const out = text.replace(ISIM_RE, (m, pre, name) => {
      const it = ISIMLER.find((x) => x[0] === name);
      const start = !/[^\s]/.test(pre) || /[.!?…]/.test(pre);
      if (it[2] && start) return m;
      used.push(it);
      return pre + it[1];
    });
    return { out, used };
  }
  function restoreNames(tr, used) {
    for (const [name, ph] of used) {
      const re = new RegExp(ph, 'gi');
      if (!re.test(tr)) return null; // uydurma ad kaybolduysa (Google değiştirdi) güvenme
      tr = tr.replace(re, name);
    }
    return tr;
  }

  function translate(text, from, to) {
    const { out, used } = from === 'en' && to === 'tr' ? protectNames(text) : { out: text, used: [] };
    if (!used.length) return race(text, from, to);
    return race(out, from, to).then((tr) => restoreNames(tr, used) ?? race(text, from, to));
  }

  function race(text, from, to) {
    lastUse = Date.now();
    const now = Date.now();
    let list = [['c5', c5], ['gtx', gtx]].filter(([n]) => rest[n] <= now);
    if (!list.length) list = [['c5', c5], ['gtx', gtx]];
    const ctl = new AbortController();
    return new Promise((resolve, reject) => {
      let done = false, running = 0, next = 0, lastErr = null;
      const finish = (ok, v) => { if (done) return; done = true; clearTimeout(limit); ctl.abort(); ok ? resolve(v) : reject(v); };
      const start = () => {
        if (done || next >= list.length) return;
        const [, fn] = list[next++];
        running++;
        fn(text, from, to, ctl.signal).then((t) => finish(true, t), (e) => {
          running--; lastErr = e;
          if (!running && next >= list.length) finish(false, lastErr);
        });
      };
      const limit = setTimeout(() => finish(false, lastErr || new Error('Google çeviri zaman aşımı')), 3000);
      for (let i = 0; i < list.length; i++) start();
    });
  }

  // Bağlantıyı sıcak tut: yeni cümlede TLS el sıkışması (~100–200 ms) beklenmesin
  function warm() {
    if (Date.now() - lastUse < 20000) return;
    lastUse = Date.now();
    c5('ok', 'en', 'tr').catch(() => {});
    gtx('ok', 'en', 'tr').catch(() => {});
  }

  // DeepL (isteğe bağlı, anahtar gerekir). Sunucusu Google'dan uzak (~100 ms fazla), bu yüzden ekrana çıkan
  // çeviriyi beklemez: Google'ınki gösterildikten sonra arka planda sorulur ve önbelleğe yazılır,
  // aynı cümle bir dahaki sefere DeepL kalitesinde gelir. ":fx" ile biten anahtar ücretsiz plandır.
  async function deepl(text, from, to, key) {
    if (!key) throw new Error('DeepL anahtarı yok');
    const host = /:fx$/.test(key.trim()) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const target = to.toUpperCase() === 'EN' ? 'EN-US' : to.toUpperCase() === 'PT' ? 'PT-BR' : to.toUpperCase();
    const { out, used } = from === 'en' && to === 'tr' ? protectNames(text) : { out: text, used: [] };
    const ask = async (q) => {
      const res = await fetch(host + '/v2/translate', {
        method: 'POST',
        headers: { Authorization: 'DeepL-Auth-Key ' + key.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: [q], source_lang: from.toUpperCase(), target_lang: target }),
      });
      if (!res.ok) throw new Error('DeepL HTTP ' + res.status + (res.status === 456 ? ' (aylık kota doldu)' : res.status === 403 ? ' (anahtar geçersiz)' : ''));
      const d = await res.json();
      const t = d && d.translations && d.translations[0] && d.translations[0].text;
      if (!t || !t.trim()) throw new Error('DeepL boş döndü');
      return t;
    };
    if (!used.length) return ask(text);
    return restoreNames(await ask(out), used) ?? ask(text);
  }
  async function deeplUsage(key) {
    const host = /:fx$/.test(key.trim()) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const res = await fetch(host + '/v2/usage', { headers: { Authorization: 'DeepL-Auth-Key ' + key.trim() } });
    if (!res.ok) throw new Error('DeepL HTTP ' + res.status + (res.status === 403 ? ' (anahtar geçersiz)' : ''));
    return res.json();
  }

  return { translate, warm, protectNames, restoreNames, deepl, deeplUsage };
})();
