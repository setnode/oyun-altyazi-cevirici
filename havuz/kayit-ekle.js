// GTA 6 kaydını havuza ekler.
//   node havuz/kayit-ekle.js ~/Downloads/gta6-kayit.json [%APPDATA%/XCloudCevirici/gta6-kayit.json ...]
// Kayıt: oyunda havuzda bulunamayıp Google'dan gelen çeviriler (eklentide "GTA 6 kaydını indir",
// Windows'ta %APPDATA%\XCloudCevirici\gta6-kayit.json). Hepsi havuz/kayitlar.json'da birikir ve
// olustur.js havuzu yazarken bunları da katar. Yeni gelenler havuz/kayit-denetim.tsv'ye yazılır:
// denetleyip yanlış olanları duzeltmeler.json'a ekle (aynı biçim: anahtar → [İngilizce, doğru Türkçe]).
const fs = require('fs');
const path = require('path');
const H = require('../xcloud-ceviri/havuz.js');

const DIR = __dirname;
const KAYIT = path.join(DIR, 'kayitlar.json');
const DENETIM = path.join(DIR, 'kayit-denetim.tsv');
const OUT_EXT = path.join(DIR, '..', 'xcloud-ceviri', 'gta6-havuz.json');

// Bir kayıt (blok) birden çok cümleyse ve Türkçesi de aynı sayıda cümleye bölünüyorsa cümle cümle eşle:
// oyunda havuz cümle cümle arandığı için yalnızca bütün blok saklanırsa bulunamaz.
function pairs(en, tr) {
  const out = [[en, tr]];
  const es = H.sentences(en), ts = H.sentences(tr);
  if (es.length > 1 && es.length === ts.length) es.forEach((e, i) => out.push([e, ts[i]]));
  return out;
}

// Kayıtları havuz anahtarlarına çevirir: anahtar → [İngilizce, Türkçe]
function kayitItems(kayit) {
  const items = {};
  for (const [en, tr] of Object.entries(kayit)) {
    if (/\[/.test(en) || (en.match(/\p{L}/gu) || []).length < 2) continue;
    for (const [e, t] of pairs(en, tr)) {
      const k = H.key(e);
      if (k && !items[k]) items[k] = [e, t];
    }
  }
  return items;
}

module.exports = { KAYIT, kayitItems };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('kullanım: node havuz/kayit-ekle.js gta6-kayit.json ...'); process.exit(1); }
  const all = fs.existsSync(KAYIT) ? JSON.parse(fs.readFileSync(KAYIT, 'utf8')) : {};
  let yeni = 0;
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
    for (const [en, tr] of Object.entries(d)) {
      if (typeof tr !== 'string' || !tr.trim()) continue;
      if (!(en in all)) yeni++;
      all[en] = tr.trim();
    }
  }
  fs.writeFileSync(KAYIT, JSON.stringify(all, null, 1));

  // Havuza ekle: transkriptten gelen (denetlenmiş) çeviri varsa o kalır
  const pool = JSON.parse(fs.readFileSync(OUT_EXT, 'utf8'));
  const D = require('./duzeltmeleri-uygula.js');
  const duz = fs.existsSync(D.DUZ) ? JSON.parse(fs.readFileSync(D.DUZ, 'utf8')) : {};
  const items = kayitItems(all);
  const rows = [];
  let eklendi = 0;
  for (const [k, [en, tr]] of Object.entries(items)) {
    if (pool[k]) continue;
    pool[k] = tr; eklendi++;
    rows.push([k, en, tr].join('\t'));
  }
  D.apply(pool, duz);
  fs.writeFileSync(OUT_EXT, JSON.stringify(pool));
  fs.writeFileSync(DENETIM, rows.join('\n') + (rows.length ? '\n' : ''));
  console.log(`kayıt: ${Object.keys(all).length} (yeni ${yeni}) · havuza eklenen: ${eklendi} · havuz: ${Object.keys(pool).length}`);
  console.log(`denetlenecekler: ${path.relative(process.cwd(), DENETIM)}`);
}
