importScripts('ceviri-ag.js', 'havuz.js');
let havuzItems = {};
const havuzHazir = fetch(chrome.runtime.getURL('gta6-havuz.json'))
  .then((r) => (r.ok ? r.json() : {})).then((items) => { havuzItems = items; XCT_HAVUZ.load(items); }).catch(() => {});
// Servis çalışanı: OCR isteklerini offscreen belgeye iletir, Google çevirisini yapar,
// klavye kısayollarını aktif sekmeye gönderir.

const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Ekrandaki altyazıyı okumak için Tesseract OCR çalıştırır.',
      })
      .finally(() => { creating = null; });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'bg') return;
  (async () => {
    try {
      if (msg.type === 'ocr') {
        await ensureOffscreen();
        const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', image: msg.image });
        sendResponse(r || { ok: false, error: 'OCR yanıt vermedi' });
      } else if (msg.type === 'translate') {
        if (msg.raw && msg.from === 'en' && msg.to === 'tr') {
          await havuzHazir;
          const hit = XCT_HAVUZ.lookup(msg.raw);
          if (hit) { sendResponse({ ok: true, text: hit, havuz: true }); return; }
        }
        sendResponse({ ok: true, text: await XCT_NET.translate(msg.text, msg.from, msg.to) });
      } else if (msg.type === 'deepl') {
        const { xctDeeplKey: key } = await chrome.storage.local.get('xctDeeplKey');
        sendResponse({ ok: true, text: await XCT_NET.deepl(msg.text, msg.from, msg.to, key) });
      } else if (msg.type === 'deeplUsage') {
        const key = msg.key != null ? msg.key : (await chrome.storage.local.get('xctDeeplKey')).xctDeeplKey;
        sendResponse({ ok: true, usage: await XCT_NET.deeplUsage(key || '') });
      } else if (msg.type === 'havuzVeri') {
        // Sayfa betiği havuzu kendi içinde arar (önbellekten önce); dosya web sayfalarına açılmaz, buradan gelir
        await havuzHazir;
        sendResponse({ ok: true, items: havuzItems });
      } else if (msg.type === 'hello') {
        // Eklenti oyun sayfasında çalışıyor → simgede yeşil işaret
        if (_sender.tab && _sender.tab.id != null) {
          chrome.action.setBadgeBackgroundColor({ tabId: _sender.tab.id, color: '#107c10' });
          chrome.action.setBadgeText({ tabId: _sender.tab.id, text: 'ON' });
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'warmup') {
        await ensureOffscreen();
        sendResponse(await chrome.runtime.sendMessage({ target: 'offscreen', type: 'warmup' }));
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { target: 'content', ...message }).catch(() => {});
  }
}

chrome.commands.onCommand.addListener((name) => sendToActiveTab({ type: 'command', name }));
