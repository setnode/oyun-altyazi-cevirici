// setdeniz play: çeviri dedektörlerini ortak bir saate bağlar (yalnızca xbox sayfasının yalıtılmış dünyasında).
// WebKit'te videodan her okuma, o anki kareyi baştan çözer (1440p'de ~5 ms, ana iş parçacığında).
// Aynı karedeki ikinci okuma ise bedavadır. Dedektörler ayrı zamanlayıcılarla farklı anlarda okuyunca
// her biri ayrı kare çözüyor ve süreler üst üste binip sayfayı (kol girişi dahil) takıltıyordu.
// Burada 50 ms'nin katı periyotlu zamanlayıcılar tek bir saatten, aynı görevde art arda çalıştırılır;
// aynı anda düşen dedektörler aynı kareyi paylaşır. Periyotlar değişmez, yalnızca hizalanır.
(() => {
  if (window.__xctKareHiza) return;
  window.__xctKareHiza = true;
  const nativeSet = window.setInterval.bind(window);
  const nativeClear = window.clearInterval.bind(window);
  const ADIM = 50;
  const isler = new Map();
  let sayac = 0, sonId = 1e7, saat = null;

  function calistir() {
    sayac++;
    for (const [id, is] of isler) {
      if (sayac < is.sonraki) continue;
      is.sonraki = sayac + is.periyot;
      try { is.fn.apply(window, is.args); } catch (e) { setTimeout(() => { throw e; }); }
      if (!isler.size) break;
    }
    if (!isler.size) { nativeClear(saat); saat = null; }
  }

  window.setInterval = function (fn, ms, ...args) {
    const d = Number(ms) || 0;
    if (typeof fn !== 'function' || d < ADIM || d % ADIM !== 0) return nativeSet(fn, ms, ...args);
    const periyot = d / ADIM;
    const id = ++sonId;
    // Aynı periyottakiler aynı adımlarda çalışsın: ilk çalışma periyodun bir sonraki katına denk gelir
    isler.set(id, { fn, args, periyot, sonraki: Math.ceil((sayac + 1) / periyot) * periyot });
    if (!saat) saat = nativeSet(calistir, ADIM);
    return id;
  };
  window.clearInterval = function (id) {
    if (isler.delete(id)) { if (!isler.size && saat) { nativeClear(saat); saat = null; } return; }
    return nativeClear(id);
  };
})();
