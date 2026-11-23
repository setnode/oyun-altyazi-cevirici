// Havuz oluşturucu: YouTube konuşma metnini (transkript) cümlelere böler, Google ile toplu çevirir ve
// eklentinin okuyacağı havuz dosyasını yazar.
//   node olustur.js transkript-XXXX.tsv [başka.tsv ...]
// Çeviriler ceviri-ham.json'da birikir: yarıda kesilirse kaldığı yerden devam eder, yeni transkript
// eklenince yalnızca yeni cümleler çevrilir.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('../xcloud-ceviri/havuz.js');

const DIR = __dirname;
const RAW = path.join(DIR, 'ceviri-ham.json');
const OUT_EXT = path.join(DIR, '..', 'xcloud-ceviri', 'gta6-havuz.json');

// Eklentideki argo düzeltmeleri: çeviriye oyundakiyle aynı biçimde gitsin
const ctx = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(path.join(DIR, '..', 'xcloud-ceviri', 'sozluk.js'), 'utf8'), ctx);
const SOZLUK = ctx.globalThis.XCT_SOZLUK || { argo: [] };
const ARGO = [];
for (const [p, r] of SOZLUK.argo || []) { try { ARGO.push([new RegExp(p, 'giu'), r]); } catch (e) {} }
function normalizeSlang(text) {
  return ARGO.reduce((t, [re, r]) => t.replace(re, (...a) => {
    let out = r.replace(/\$(\d)/g, (_, i) => (typeof a[+i] === 'string' ? a[+i] : ''));
    const first = (a[0].match(/\p{L}/u) || [''])[0];
    if (first && first !== first.toLowerCase()) out = out.replace(/\S/, (c) => c.toUpperCase());
    return out;
  }), text);
}

// 1) Transkript → cümleler
const files = process.argv.slice(2);
if (!files.length) { console.error('kullanım: node olustur.js transkript.tsv ...'); process.exit(1); }
const sents = new Map(); // anahtar → özgün cümle
let total = 0, dropped = 0;
for (const f of files) {
  const text = fs.readFileSync(path.resolve(f), 'utf8').split('\n')
    .map((l) => l.split('\t').slice(1).join(' ')).join(' ')
    .replace(/ /g, ' ');
  for (const s of H.sentences(text)) {
    total++;
    // Sansürlü küfür ([ __ ]) ve [Müzik] gibi notlar: ekrandaki altyazıyla eşleşmez
    if (/\[/.test(s) || (s.match(/\p{L}/gu) || []).length < 2) { dropped++; continue; }
    for (const part of [s, ...H.spans(s)]) {
      const k = H.key(part);
      if (k && !sents.has(k)) sents.set(k, part);
    }
  }
}
console.log(`cümle: ${total}, atılan: ${dropped}, benzersiz: ${sents.size}`);

// 2) Toplu çeviri (clients5: bir istekte birden çok q)
const raw = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf8')) : {};
const todo = [...sents.entries()].filter(([k]) => !raw[k]);
console.log(`çevrilecek: ${todo.length} (önceden çevrilmiş: ${sents.size - todo.length})`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function batch(list) {
  const qs = list.map(([, s]) => '&q=' + encodeURIComponent(normalizeSlang(s))).join('');
  const url = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=tr' + qs;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.status === 429 || res.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const arr = list.length === 1 ? [Array.isArray(d) ? d[0] : d] : d;
      return arr.map((x) => (Array.isArray(x) ? x[0] : x));
    } catch (e) {
      if (attempt === 5) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw new Error('çeviri alınamadı');
}

(async () => {
  const SIZE = 25;
  for (let i = 0; i < todo.length; i += SIZE) {
    const list = todo.slice(i, i + SIZE);
    const tr = await batch(list);
    list.forEach(([k], j) => { if (typeof tr[j] === 'string' && tr[j].trim()) raw[k] = tr[j].trim(); });
    if ((i / SIZE) % 10 === 0 || i + SIZE >= todo.length) {
      fs.writeFileSync(RAW, JSON.stringify(raw));
      process.stdout.write(`\r${Math.min(i + SIZE, todo.length)}/${todo.length}`);
    }
    await sleep(350); // Google'ı yormayalım
  }
  fs.writeFileSync(RAW, JSON.stringify(raw));
  // 3) Havuz dosyası: yalnızca bu transkriptlerdeki cümleler
  const items = {};
  for (const k of sents.keys()) if (raw[k]) items[k] = raw[k];
  // Oyunda kaydedilen GTA 6 çevirileri (kayit-ekle.js): transkriptte olmayan cümleler
  const K = require('./kayit-ekle.js');
  if (fs.existsSync(K.KAYIT)) {
    let n = 0;
    for (const [k, [, tr]] of Object.entries(K.kayitItems(JSON.parse(fs.readFileSync(K.KAYIT, 'utf8'))))) if (!items[k]) { items[k] = tr; n++; }
    console.log(`\nGTA 6 kaydı: ${n} cümle eklendi`);
  }
  // Elle düzeltilmiş çeviriler en son uygulanır (bkz. duzeltmeleri-uygula.js)
  const D = require('./duzeltmeleri-uygula.js');
  if (fs.existsSync(D.DUZ)) {
    const r = D.apply(items, JSON.parse(fs.readFileSync(D.DUZ, 'utf8')));
    console.log(`\ndüzeltme: ${r.changed} çeviri, ${r.removed} parça silindi`);
  }
  const json = JSON.stringify(items);
  fs.writeFileSync(OUT_EXT, json);
  console.log(`\nhavuz: ${Object.keys(items).length} cümle, ${(json.length / 1024).toFixed(0)} KB`);
})().catch((e) => { console.error('\nHATA:', e.message); process.exit(1); });
