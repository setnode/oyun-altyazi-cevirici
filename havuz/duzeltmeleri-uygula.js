// Elle düzeltilmiş çeviriler: Google'ın yanlış çevirdiği havuz cümleleri (argo, isimler, "copy that" → "kopyala" gibi).
//   node duzeltmeleri-uygula.js [liste.tsv]   → duzeltmeler.json'u günceller ve gta6-havuz.json'a uygular
// liste.tsv: "sıra<TAB>İngilizce<TAB>eski Türkçe" (gözden geçirme listesi), duzeltme-girdi.tsv: "sıra<TAB>doğru Türkçe".
// olustur.js de havuzu yazarken bu dosyayı en son uygular, böylece yeniden oluşturmada düzeltmeler kaybolmaz.
const fs = require('fs');
const path = require('path');
const H = require('../xcloud-ceviri/havuz.js');

const DIR = __dirname;
const DUZ = path.join(DIR, 'duzeltmeler.json'); // { anahtar: [İngilizce, Türkçe] }
const OUT_EXT = path.join(DIR, '..', 'xcloud-ceviri', 'gta6-havuz.json');

// Düzeltilen cümlenin tamamı değiştirilir. Eski çeviri anlamca çok farklıysa (kelimelerin yarısından azı ortak)
// Google'ın aynı cümleden çevirdiği virgül parçaları (spans) da büyük ihtimalle aynı hatayı taşır: onlar silinir,
// gerekirse canlıda Google'a sorulur. Yalnızca üslup düzeltmesinde parçalar kalır (havuz hızlı kalsın).
const words = (s) => new Set(String(s).toLocaleLowerCase('tr').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((x) => x.length > 2));
function similar(a, b) {
  const x = words(a), y = words(b);
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / Math.max(1, x.size, y.size);
}
function apply(items, duz) {
  let changed = 0, removed = 0;
  for (const [k, [en, tr]] of Object.entries(duz)) {
    const old = items[k];
    if (old === tr) continue;
    items[k] = tr; changed++;
    if (old && similar(old, tr) >= 0.5) continue;
    for (const sp of H.spans(en)) {
      const sk = H.key(sp);
      if (sk && !duz[sk] && items[sk]) { delete items[sk]; removed++; }
    }
  }
  return { changed, removed };
}

if (require.main === module) {
  const list = process.argv[2];
  const duz = fs.existsSync(DUZ) ? JSON.parse(fs.readFileSync(DUZ, 'utf8')) : {};
  if (list) {
    const en = new Map();
    for (const l of fs.readFileSync(list, 'utf8').split('\n')) {
      const [i, e] = l.split('\t');
      if (e) en.set(i, e);
    }
    let n = 0;
    for (const l of fs.readFileSync(path.join(DIR, 'duzeltme-girdi.tsv'), 'utf8').split('\n')) {
      const [i, tr] = l.split('\t');
      if (!tr || !tr.trim()) continue;
      const e = en.get(i);
      if (!e) { console.error('liste dışı sıra:', i); continue; }
      const k = H.key(e);
      if (k) { duz[k] = [e, tr.trim()]; n++; }
    }
    fs.writeFileSync(DUZ, JSON.stringify(duz, null, 0));
    console.log(`düzeltme: ${n} satır okundu, toplam ${Object.keys(duz).length}`);
  }
  const items = JSON.parse(fs.readFileSync(OUT_EXT, 'utf8'));
  const r = apply(items, duz);
  fs.writeFileSync(OUT_EXT, JSON.stringify(items));
  console.log(`havuz: ${r.changed} çeviri değişti, ${r.removed} parça silindi, toplam ${Object.keys(items).length}`);
}

module.exports = { apply, DUZ };
