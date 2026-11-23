// Tesseract işçisini tek seferlik başlatan ortak yardımcı.
// Hem eklentinin offscreen belgesinde hem de test sayfasında kullanılır.
(function (global) {
  // İki işçi: düz ve konturlu okuma aynı anda yapılabilsin (biri diğerini beklemesin)
  const POOL = 2;
  const workerPromises = [];
  const busy = new Array(POOL).fill(0);

  function resolve(base, path) {
    return new URL(path, base).href.replace(/\/$/, '');
  }

  global.xctGetOcrWorker = function (baseUrl, slot = 0) {
    if (!workerPromises[slot]) {
      workerPromises[slot] = (async () => {
        const worker = await Tesseract.createWorker('eng', 1, {
          workerPath: resolve(baseUrl, 'vendor/worker.min.js'),
          corePath: resolve(baseUrl, 'vendor/core'),
          langPath: resolve(baseUrl, 'vendor/lang'),
          workerBlobURL: false,
          gzip: true,
          cacheMethod: 'none',
        }, {
          // Tesseract'ın iç uyarılarını ("Image too small to scale!!", "Line cannot be
          // recognized!!") sustur; zararsızdır ama Chrome bunları hata olarak listeler.
          debug_file: '/dev/null',
        });
        await worker.setParameters({
          tessedit_pageseg_mode: '6', // tek metin bloğu
          preserve_interword_spaces: '1',
        });
        return worker;
      })().catch((e) => {
        workerPromises[slot] = null;
        throw e;
      });
    }
    return workerPromises[slot];
  };
  // Tüm işçileri önceden başlat (ilk altyazıda yükleme beklemesin)
  global.xctWarmup = (baseUrl) => Promise.all(Array.from({ length: POOL }, (_, i) => global.xctGetOcrWorker(baseUrl, i)));

  // İngilizce kelime listesi (Tesseract'ın kendi sözlüğü + oyun argosu): saçma okumaları
  // ("fuekingiloeer") ve birleşik okunan kelimeleri ("haveall" → "have all") ayırt etmek için
  let dictPromise = null;
  function loadDict(baseUrl) {
    if (!dictPromise) {
      dictPromise = fetch(resolve(baseUrl, 'kelimeler.txt'))
        .then((r) => (r.ok ? r.text() : ''))
        .then((t) => (t ? new Set(t.split('\n')) : null))
        .catch(() => null);
    }
    return dictPromise;
  }

  const SHORT_OK = new Set('a i am an as at be by do go he if in is it me my no of oh on or so to up us we ok'.split(' '));
  function known(dict, w) {
    if (w.length < 3) return SHORT_OK.has(w) || w.length < 2;
    return dict.has(w) || dict.has(w.replace(/'s$/, ''))
      || (/in$/.test(w) && dict.has(w + 'g'))           // comin' → coming
      || (/s$/.test(w) && dict.has(w.slice(0, -1)));
  }
  const CONFUSIONS = [['v', 'y'], ['y', 'v'], ['rn', 'm'], ['m', 'rn'], ['e', 'o'], ['o', 'e'], ['c', 'e'], ['e', 'c'],
    ['ii', 'll'], ['li', 'h'], ['l', 'i'], ['i', 'l'], ['n', 'h'], ['h', 'n'], ['u', 'o'], ['a', 'o']];
  function segment(dict, core) {
    const lc = core.toLowerCase();
    const ok = (p) => (p.length >= 3 ? dict.has(p) : SHORT_OK.has(p));
    let best = null, bestMin = 0;
    for (let i = 1; i < lc.length; i++) {
      const a = lc.slice(0, i), b = lc.slice(i);
      if (ok(a) && ok(b) && Math.min(a.length, b.length) > bestMin) { best = [i]; bestMin = Math.min(a.length, b.length); }
    }
    if (!best && lc.length >= 7) {
      for (let i = 2; i < lc.length - 3 && !best; i++) {
        for (let j = i + 2; j < lc.length - 1; j++) {
          if (ok(lc.slice(0, i)) && ok(lc.slice(i, j)) && ok(lc.slice(j))) { best = [i, j]; break; }
        }
      }
    }
    if (!best) return null;
    const cuts = [0, ...best, core.length];
    return cuts.slice(0, -1).map((c, k) => core.slice(c, cuts[k + 1])).join(' ');
  }
  // Bir OCR kelimesi için: { known: sözlükte mi, fix: düzeltilmiş yazım (varsa) }
  global.xctWordInfo = function (dict, raw) {
    const m = raw.replace(/[’‘]/g, "'").match(/^([^\p{L}]*)(.*?)([^\p{L}]*)$/u);
    const core = m[2];
    if ((core.match(/\p{L}/gu) || []).length < 3) return {};
    const parts = core.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
    if (parts.length > 1) {
      if (!parts.every((p) => known(dict, p))) return { known: false };
      // "can/show" → "can show"; tireli kelimeler olduğu gibi kalır
      return /^[\p{L}'-]+$/u.test(core) ? { known: true } : { known: true, fix: m[1] + core.split(/[^\p{L}']+/u).join(' ') + m[3] };
    }
    if (known(dict, parts[0] || '')) return { known: true };
    const lc0 = core.toLowerCase();
    // Boşluğu yutulmuş "a": "scana ride" → "scan a ride" (harf karışıklığından önce: yoksa "seana" olur)
    if (/^\p{L}{4,}a$/u.test(core) && known(dict, lc0.slice(0, -1))) return { known: true, fix: m[1] + core.slice(0, -1) + ' a' + m[3] };
    // Tek harflik OCR karışıklığı: "vou're" → "you're", "semething" → "something"
    const lc = core.toLowerCase();
    for (const [a, b] of CONFUSIONS) {
      for (let i = lc.indexOf(a); i >= 0; i = lc.indexOf(a, i + 1)) {
        if (known(dict, lc.slice(0, i) + b + lc.slice(i + a.length))) {
          const rep = core[i] !== lc[i] ? b.toUpperCase() : b;
          return { known: true, fix: m[1] + core.slice(0, i) + rep + core.slice(i + a.length) + m[3] };
        }
      }
    }
    const seg = /^\p{L}{5,20}$/u.test(core) ? segment(dict, core) : null;
    return seg ? { known: true, fix: m[1] + seg + m[3] } : { known: false };
  };

  // Satır satır sonuç: metin + güven + yükseklik (saçma okumaları elemek için)
  // PNG data URL'sinin boyutu (başlıktan, çözmeden): boş/dev görüntü Tesseract'a gitmesin —
  // Leptonica "pixCopyText: pixd not defined" hatası verir ve işçinin belleği bozulabilir
  function pngSize(image) {
    if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,')) return null;
    try {
      const b = atob(image.slice(22, 22 + 44));
      const u = (i) => ((b.charCodeAt(i) << 24) | (b.charCodeAt(i + 1) << 16) | (b.charCodeAt(i + 2) << 8) | b.charCodeAt(i + 3)) >>> 0;
      return { w: u(16), h: u(20) };
    } catch (e) { return { w: 0, h: 0 }; }
  }
  // Tesseract.js işçisinin belleği uzun oyunda büyür: belirli sayıda okumadan sonra, boştayken yenile
  const uses = new Array(POOL).fill(0), swapping = new Array(POOL).fill(false);
  const RECYCLE_AFTER = 3000;
  async function recycle(slot) {
    const p = workerPromises[slot];
    workerPromises[slot] = null; uses[slot] = 0;
    try { const w = await p; if (w) await w.terminate(); } catch (e) { /* zaten ölü */ }
  }

  global.xctRecognize = async function (baseUrl, image) {
    const sz = pngSize(image);
    if (image === 'data:,' || (sz && (sz.w < 8 || sz.h < 8 || sz.w * sz.h > 16e6))) {
      return { ok: true, text: '', confidence: 0, lines: [] };
    }
    // En az meşgul işçiyi seç
    let slot = 0;
    for (let i = 1; i < POOL; i++) if (busy[i] < busy[slot]) slot = i;
    busy[slot]++;
    let data;
    try {
      const [worker] = await Promise.all([global.xctGetOcrWorker(baseUrl, slot), loadDict(baseUrl)]);
      ({ data } = await worker.recognize(image, {}, { text: true, blocks: true }));
      uses[slot]++;
    } catch (e) {
      busy[slot]--;
      if (!busy[slot]) recycle(slot); // bozulan işçiyi at, sonraki okumada yenisi kurulur
      throw e;
    }
    busy[slot]--;
    if (uses[slot] >= RECYCLE_AFTER && !swapping[slot]) {
      // Yenisini arka planda kur; hazır olunca değiştir, eskisini boşalınca kapat (okuma beklemez)
      swapping[slot] = true;
      const old = workerPromises[slot];
      workerPromises[slot] = null;
      const fresh = global.xctGetOcrWorker(baseUrl, slot);
      workerPromises[slot] = old; // yenisi hazır olana kadar eskisi çalışsın
      fresh.then(() => {
        workerPromises[slot] = fresh; uses[slot] = 0;
        const close = () => (busy[slot] ? setTimeout(close, 1000) : old && old.then((w) => w.terminate()).catch(() => {}));
        setTimeout(close, 1000);
      }, () => {}).finally(() => { swapping[slot] = false; });
    }
    const dict = await loadDict(baseUrl);
    const lines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const b = line.bbox || {};
          lines.push({
            text: (line.text || '').trim(),
            confidence: line.confidence || 0,
            height: Math.max(0, (b.y1 || 0) - (b.y0 || 0)),
            top: b.y0 || 0,
            words: (line.words || []).map((w) => ({
              text: w.text || '',
              confidence: w.confidence || 0,
              x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1,
              ...(dict ? global.xctWordInfo(dict, w.text || '') : {}),
            })),
          });
        }
      }
    }
    return { ok: true, text: data.text || '', confidence: data.confidence || 0, lines };
  };
})(self);
