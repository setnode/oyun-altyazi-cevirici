// Offscreen belge: Tesseract OCR burada, eklentinin kendi kökeninde çalışır.
const BASE = chrome.runtime.getURL('/');

// Hazır çeviri havuzu (GTA 6 diyalogları): bulunan cümle Google'a gitmeden anında çevrilir
const havuzHazir = fetch(chrome.runtime.getURL('gta6-havuz.json'))
  .then((r) => (r.ok ? r.json() : {})).then((items) => XCT_HAVUZ.load(items)).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.type === 'warmup') {
        await xctWarmup(BASE);
        sendResponse({ ok: true });
      } else if (msg.type === 'ocr') {
        sendResponse(await xctRecognize(BASE, msg.image));
      } else if (msg.type === 'translate') {
        // Çeviri de burada: servis çalışanı uyuyorsa uyanmasını (~50–300 ms) beklemeye gerek kalmaz
        if (msg.raw && msg.from === 'en' && msg.to === 'tr') {
          await havuzHazir;
          const hit = XCT_HAVUZ.lookup(msg.raw);
          if (hit) { sendResponse({ ok: true, text: hit, havuz: true }); return; }
        }
        sendResponse({ ok: true, text: await XCT_NET.translate(msg.text, msg.from, msg.to) });
      } else if (msg.type === 'netwarm') {
        XCT_NET.warm();
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});
