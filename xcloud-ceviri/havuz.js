// Hazır çeviri havuzu (ör. GTA 6 diyalogları): oyunda okunan altyazı cümle cümle havuzda aranır; hepsi
// bulunursa Google'a gitmeden anında çevrilir. Havuz, oyunun konuşma metninden (YouTube transkripti)
// önceden çevrilerek oluşturulur (bkz. ../havuz/olustur.js). Offscreen belgede ve Node'da çalışır.
//
// Transkript ile ekrandaki altyazı birebir aynı değildir: "gonna"/"going to", "boostin'"/"boosting",
// "ya phone"/"your phone", cümle sınırları da kayabilir. Bu yüzden iki taraf da aynı biçime getirilir
// (anahtar) ve küçük farklara tolerans tanınır (kelime düzeyinde düzenleme uzaklığı).
const XCT_HAVUZ = (() => {
  const SWAP = [
    [/[’‘`]/g, "'"],
    [/\bc'mon\b/g, 'come on'], [/\bgonna\b/g, 'going to'], [/\bgotta\b/g, 'got to'], [/\bwanna\b/g, 'want to'],
    [/\bgimme\b/g, 'give me'], [/\blemme\b/g, 'let me'], [/\bkinda\b/g, 'kind of'], [/\bsorta\b/g, 'sort of'],
    [/\boutta\b/g, 'out of'], [/\bdunno\b/g, "don't know"], [/\by'all\b/g, 'you all'], [/\bya\b/g, 'you'],
    [/(\s)'em\b/g, '$1them'], [/(\s)'cause\b/g, '$1because'], [/\byour\b/g, 'you'], [/\bcuz\b/g, 'because'], [/\bnothin'/g, 'nothing'],
    [/\b(\w{2,})in'(?=\W|$)/g, '$1ing'], [/\bok\b/g, 'okay'], [/\bbout\b/g, 'about'], [/(\s)'til\b/g, '$1until'],
    [/\ball right\b/g, 'alright'], [/\bquess\b/g, 'guess'], [/\b(guess|think|know) lim\b/g, "$1 i'm"],
    [/\bslim gym\b/g, 'slim jim'], [/\bhot wire\b/g, 'hotwire'], [/(\s)'t(?=\W)/g, '$1it'],
  ];

  function key(s) {
    let t = ' ' + String(s).toLowerCase() + ' ';
    for (const [re, r] of SWAP) t = t.replace(re, r);
    return t.replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim();
  }

  // Cümlelere böl: . ? ! … sonrası boşluk + büyük harf / tırnak
  function sentences(s) {
    const parts = String(s).replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]*["”']?/gu) || [];
    const out = [];
    for (const x of parts.map((p) => p.trim()).filter(Boolean)) {
      // "Mr." "Dr." gibi kısaltmalarda bölme
      if (out.length && /\b(mr|mrs|ms|dr|st|jr|sr|vs)\.$/i.test(out[out.length - 1])) out[out.length - 1] += ' ' + x;
      else out.push(x);
    }
    return out;
  }

  // Oyun uzun cümleyi virgülden bölüp parça parça gösterir ("You boost somethin' with one of those and
  // bring it here," / "all you gonna do is lead the police straight to us."): havuza cümlenin virgülle
  // ayrılan ardışık parçaları da eklenir (en az 4 kelime)
  function spans(sentence) {
    const cl = sentence.split(/,\s+/).map((x) => x.trim()).filter(Boolean);
    const out = [];
    if (cl.length < 2 || cl.length > 6) return out;
    for (let i = 0; i < cl.length; i++) {
      for (let j = i; j < cl.length; j++) {
        if (i === 0 && j === cl.length - 1) continue; // cümlenin tamamı zaten var
        const t = cl.slice(i, j + 1).join(', ');
        if (t.split(/\s+/).length >= 4) out.push(t);
      }
    }
    return out;
  }

  let map = null, keys = [], words = [], index = null;
  const STOP = new Set(['the', 'and', 'you', 'that', 'this', 'with', 'for', 'are', 'was', 'have', 'not', 'but', 'what', 'your', 'got', 'its', 'just', 'all', 'can', 'out', 'get', 'one']);

  function load(items) {
    map = new Map(Object.entries(items || {}));
    keys = [...map.keys()];
    words = keys.map((k) => k.split(' '));
    index = new Map();
    keys.forEach((k, i) => {
      for (const w of new Set(words[i])) {
        if (w.length < 3 || STOP.has(w)) continue;
        let a = index.get(w); if (!a) index.set(w, a = []); a.push(i);
      }
    });
  }

  const NEG = new Set(['not', 'no', 'never', 'nothing', 'nobody', 'dont', 'doesnt', 'didnt', 'cant', 'cannot', 'wont', 'wouldnt',
    'shouldnt', 'couldnt', 'isnt', 'arent', 'wasnt', 'werent', 'aint', 'havent', 'hasnt', 'hadnt', 'nope', 'nah']);
  const negs = (ws) => ws.reduce((n, w) => n + (NEG.has(w) ? 1 : 0), 0);

  function wordDist(a, b) {
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  function find(k) {
    const exact = map.get(k);
    if (exact) return exact;
    const q = k.split(' ');
    if (q.length < 4) return null; // kısa cümlede tahmin yürütme ("Get in." / "Get out.")
    const count = new Map();
    for (const w of new Set(q)) for (const i of index.get(w) || []) count.set(i, (count.get(i) || 0) + 1);
    const need = Math.max(2, Math.ceil(new Set(q.filter((w) => w.length >= 3 && !STOP.has(w))).size * 0.6));
    let best = null, bestR = 1;
    for (const [i, c] of count) {
      if (c < need) continue;
      const cand = words[i];
      if (Math.abs(cand.length - q.length) > Math.max(2, q.length * 0.25)) continue;
      if (negs(q) !== negs(cand)) continue; // "I do want it" ≠ "I don't want it"
      let r = wordDist(q, cand) / Math.max(q.length, cand.length);
      // OCR kelimeyi bölüp birleştirdiyse ("I se tick that" / "stick that") kelime farkı büyür ama harfler
      // neredeyse aynıdır: uzun cümlede boşluksuz harf farkı %10'u geçmiyorsa yakın say
      if (r > 0.2 && r <= 0.4) {
        const qs = q.join(''), cs = cand.join('');
        if (Math.min(qs.length, cs.length) >= 20) { const cr = wordDist(qs, cs) / Math.max(qs.length, cs.length); if (cr <= 0.1) r = Math.min(r, cr * 2); }
      }
      if (r < bestR) { bestR = r; best = i; }
    }
    return best != null && bestR <= 0.2 ? map.get(keys[best]) : null;
  }

  // Altyazı iki konuşma cümlesini virgülle birleştirmiş olabilir ("Pick up that slim jim, it's a little
  // quieter."): cümle bulunamazsa virgül parçaları ayrı ayrı aranır, hepsi bulunursa birleştirilir
  function byClauses(s) {
    const cl = s.split(/,\s+/).map((x) => x.trim()).filter(Boolean);
    if (cl.length < 2 || cl.length > 4) return null;
    const out = [];
    for (const c of cl) {
      const k = key(c);
      if (!k || k.split(' ').length < 2) return null;
      const hit = find(k);
      if (!hit) return null;
      out.push(hit);
    }
    return out.join(' ');
  }

  // Bütün cümleler havuzdaysa çevirisi, değilse null
  function lookup(text) {
    if (!map || !map.size) return null;
    const ss = sentences(text);
    if (!ss.length) return null;
    const out = [];
    for (const s of ss) {
      const k = key(s);
      if (!k) continue;
      const hit = find(k) || byClauses(s);
      if (!hit) return null;
      out.push(hit);
    }
    return out.length ? out.join(' ') : null;
  }

  return { key, sentences, spans, load, lookup, get size() { return map ? map.size : 0; } };
})();
if (typeof module !== 'undefined') module.exports = XCT_HAVUZ;
