// Mac uygulaması: yakalanan oyun penceresinin görüntüsünü eklentiye "video" olarak verir.
(() => {
  const post = (m) => window.webkit.messageHandlers.xct.postMessage(m);

  // ---------- Oyun görüntüsü → video ----------
  const video = document.getElementById('v');
  const cv = document.createElement('canvas');
  cv.width = 1280; cv.height = 720;
  const g = cv.getContext('2d', { alpha: false });
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  video.srcObject = cv.captureStream(30);
  video.play().catch(() => {});

  let seq = 0, idle = 0;
  async function pump() {
    let wait = 40;
    try {
      const r = await fetch('xct://app/frame?after=' + seq, { cache: 'no-store' });
      if (r.status === 200) {
        seq = Number(r.headers.get('X-Seq')) || seq + 1;
        const bmp = await createImageBitmap(await r.blob());
        if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
        g.drawImage(bmp, 0, 0);
        bmp.close();
        idle = 0;
        wait = 25;
      } else {
        // Yeni kare yok (oyun durağan ya da pencere gizli): biraz bekle
        idle++;
        wait = idle > 40 ? 150 : 40;
      }
    } catch (e) {
      wait = 300;
    }
    setTimeout(pump, wait);
  }
  pump();

  // ---------- Bölge seçimi: fare yalnızca seçim sırasında katmana gelsin ----------
  let uiShadow = null, selecting = false;
  setInterval(() => {
    if (!uiShadow) {
      const h = [...document.body.children].find((d) => d.shadowRoot && d.shadowRoot.getElementById('select'));
      if (!h) return;
      uiShadow = h.shadowRoot;
    }
    const sel = uiShadow.getElementById('select');
    const now = !!sel && sel.style.display === 'block';
    if (now !== selecting) { selecting = now; post({ op: 'selecting', on: now }); }
  }, 120);
})();
