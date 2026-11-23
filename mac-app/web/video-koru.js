// setdeniz play: çeviri motoru yalnızca oyun yayınının videosunu görsün (xbox sayfasının yalıtılmış dünyası).
// xbox.com'un tanıtım videoları başka sunucudan gelir; motor bunlardan birini okumaya çalışırsa WebKit
// tuvali kalıcı olarak "güvensiz" sayar ve oyun başladıktan sonra da her okuma
// "The operation is insecure" hatasıyla düşer (altyazı hiç çıkmaz). Oyun yayını her zaman canlı akıştır
// (srcObject); onun dışındaki videolar motordan gizlenir ve onlardan tuvale çizim yapılmaz.
(() => {
  if (window.__xctVideoKoru) return;
  window.__xctVideoKoru = true;
  const yayin = (v) => !!(v && v.srcObject);

  const qsa = Document.prototype.querySelectorAll;
  Document.prototype.querySelectorAll = function (sel) {
    const r = qsa.call(this, sel);
    if (typeof sel === 'string' && sel.trim().toLowerCase() === 'video') return [...r].filter(yayin);
    return r;
  };

  const di = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (src) {
    if (src instanceof HTMLVideoElement && !yayin(src)) return;
    return di.apply(this, arguments);
  };
})();
