const DEFAULTS = {
  v: 6, enabled: false, engine: 'auto', from: 'en', to: 'tr', overlay: 'above', style: 'cinema',
  fontSize: 30, offsetY: 0, textMode: 'bright', threshold: 175, interval: 100,
  region: { x: 0.12, y: 0.8, w: 0.76, h: 0.19 },
  msgOn: true, hintOn: true, cardOn: true,
};
const FIELDS = ['enabled', 'engine', 'from', 'to', 'overlay', 'style', 'fontSize', 'offsetY', 'textMode', 'threshold', 'interval', 'msgOn', 'hintOn', 'cardOn'];
const NUMERIC = new Set(['fontSize', 'offsetY', 'threshold', 'interval']);
const $ = (id) => document.getElementById(id);

$('version').textContent = 'sürüm ' + chrome.runtime.getManifest().version;

function showOutputs() {
  $('fontSizeOut').textContent = $('fontSize').value + ' px';
  const oy = Number($('offsetY').value);
  $('offsetYOut').textContent = (oy > 0 ? '+' : '') + oy + ' px';
  $('thresholdOut').textContent = $('threshold').value;
  $('intervalOut').textContent = $('interval').value + ' ms';
}

function syncStyleState() {
  // "Yerine" modunda görünüm her zaman koyu kutudur
  $('style').disabled = $('overlay').value === 'replace' || $('overlay').value === 'game';
  // Silme modunda yazı boyu ve yeri oyunun kendi yazısından alınır
  $('fontSize').disabled = $('overlay').value === 'game';
  $('offsetY').disabled = $('overlay').value === 'game' || $('overlay').value === 'replace';
}

chrome.storage.sync.get({ ...DEFAULTS, v: 0 }, (s) => {
  // Eski sürüm ayarları (sayfa betiği de taşır; burada sadece doğru gösterelim)
  if (!s.v || s.v < 2) {
    s.overlay = s.overlay === 'cover' ? 'replace' : 'above';
    s.style = 'cinema'; s.fontSize = 30; s.interval = 100;
  }
  if (s.v && s.v < 4 && s.overlay === 'game') { s.overlay = 'above'; s.style = 'cinema'; }
  if (s.v && s.v < 6 && s.interval >= 120) s.interval = 100;
  if (!['game', 'above', 'below', 'replace'].includes(s.overlay)) s.overlay = 'above';
  for (const k of FIELDS) {
    const el = $(k);
    if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
  }
  showOutputs();
  syncStyleState();
});

for (const k of FIELDS) {
  const el = $(k);
  el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
    const value = el.type === 'checkbox' ? el.checked : NUMERIC.has(k) ? Number(el.value) : el.value;
    showOutputs();
    syncStyleState();
    chrome.storage.sync.set({ [k]: value, v: DEFAULTS.v });
  });
}

let gameTab = null;
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const ok = !!(tab && tab.url && /^https:\/\/(([^/]+\.)?xbox\.com|www\.youtube\.com)\//.test(tab.url));
  gameTab = ok ? tab : null;
  $('tabNote').hidden = ok;
  $('selectRegion').disabled = $('preview').disabled = !ok;
});

async function sendToTab(message) {
  if (!gameTab) return;
  try { await chrome.tabs.sendMessage(gameTab.id, { target: 'content', ...message }); } catch (e) { /* sayfa yenilenmemiş olabilir */ }
}

$('selectRegion').addEventListener('click', async () => {
  await sendToTab({ type: 'command', name: 'select-region' });
  window.close();
});
$('preview').addEventListener('click', () => sendToTab({ type: 'preview' }));
$('resetRegion').addEventListener('click', async () => {
  await chrome.storage.sync.set({ region: DEFAULTS.region });
  await sendToTab({ type: 'flash-region' });
});

// GTA 6 kaydı: havuzda olmayan, Google'dan gelen çeviriler (denetlenip havuza eklenir: havuz/kayit-ekle.js)
chrome.storage.local.get('xctGta6Kayit', (d) => {
  const n = Object.keys((d && d.xctGta6Kayit) || {}).length;
  $('exportKayit').textContent = 'GTA 6 kaydını indir (' + n.toLocaleString('tr-TR') + ' cümle)';
  $('exportKayit').disabled = n === 0;
});
$('exportKayit').addEventListener('click', () => {
  chrome.storage.local.get('xctGta6Kayit', (d) => {
    const blob = new Blob([JSON.stringify((d && d.xctGta6Kayit) || {}, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gta6-kayit.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
});

// DeepL anahtarı: yalnızca bu cihazda (storage.local) saklanır, servis çalışanı kullanır
function deeplDurum(key) {
  if (!key) { $('deeplStatus').textContent = 'Anahtar yok: yalnızca Google kullanılıyor.'; return; }
  $('deeplStatus').textContent = 'Deneniyor…';
  chrome.runtime.sendMessage({ target: 'bg', type: 'deeplUsage', key }, (r) => {
    void chrome.runtime.lastError;
    if (!r || !r.ok) { $('deeplStatus').textContent = 'DeepL bağlanamadı: ' + ((r && r.error) || 'yanıt yok'); return; }
    const u = r.usage || {};
    const fmt = (n) => Number(n || 0).toLocaleString('tr-TR');
    $('deeplStatus').textContent = 'DeepL bağlı ✓ Bu ay: ' + fmt(u.character_count) + ' / ' + fmt(u.character_limit) + ' karakter.';
  });
}
chrome.storage.local.get('xctDeeplKey', (o) => {
  const key = (o && o.xctDeeplKey) || '';
  $('deeplKey').value = key;
  if (key) deeplDurum(key);
});
$('deeplSave').addEventListener('click', () => {
  const key = $('deeplKey').value.trim();
  if (key) chrome.storage.local.set({ xctDeeplKey: key }, () => deeplDurum(key));
  else chrome.storage.local.remove('xctDeeplKey', () => deeplDurum(''));
});
