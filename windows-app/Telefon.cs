using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Text.RegularExpressions;

namespace XCloudCevirici;

/// <summary>
/// Elde tutulan telefon (mesajlar, sosyal medya). Telefonun iki yanındaki uzun koyu çerçeve + arasındaki açık,
/// renksize yakın ekran aranır. Bulunduğu anda ekran alanı ve sağ alttaki tuş ipuçları altyazı okumasında boyanır
/// (Masks) — altyazı bozulmaz. Ekrandaki yazılar baloncuk baloncuk okunup telefonun soluna çevrilir.
/// </summary>
sealed class PhoneReader
{
    readonly MessageReader ocrHost; // OCR motorunu paylaşır (aynı döngüde sırayla çalışır)

    int miss;
    DateTime lastOcr = DateTime.MinValue;
    public Rectangle? Box { get; private set; }          // telefon ekranı (ekran koordinatı)
    public List<Rectangle> Masks { get; private set; }   // altyazı okumasında boyanacak alanlar
    public string ShownKey { get; set; }
    public List<string> ShownSrcs { get; set; } = new();

    public sealed class Bubble { public string Text = "", From = ""; public bool Out; public double Q = 100; }
    Rectangle? prevBox;
    float[] lastGrid;
    const int GW = 18, GH = 32;
    static float[] LumGrid(Bitmap shot)
    {
        const int W = 90, H = 160;
        var g2 = new float[GW * GH];
        using var small = new Bitmap(W, H, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(shot, 0, 0, W, H); }
        var px = MessageReader.Pixels(small, out int st);
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
                g2[(y / 5) * GW + x / 5] += (float)(Lum(px, y * st + x * 4) / 25);
        return g2;
    }
    // ±1 hücre dikey kaymaya dayanıklı ortalama fark. Sallantı ~5–9, belirgin kaydırma/yeni ekran ≥ 10
    static double GridDiff(float[] a, float[] c)
    {
        if (a == null || c == null || a.Length != c.Length) return 999;
        double best = double.MaxValue;
        for (int dy = -1; dy <= 1; dy++)
        {
            double sum = 0; int n = 0;
            for (int y = Math.Max(0, -dy); y < Math.Min(GH, GH - dy); y++)
                for (int x = 0; x < GW; x++) { sum += Math.Abs(a[y * GW + x] - c[(y + dy) * GW + x]); n++; }
            best = Math.Min(best, sum / n);
        }
        return best;
    }
    // Daha önce çevrilen baloncuklar: OCR aynı yazıyı biraz farklı okusa da eski çeviri kullanılır
    public sealed class MemoItem { public string Src = "", Tr; public double Q; }
    public readonly List<MemoItem> Memo = new();
    public double ShownQ { get; set; }
    int lowQ;
    public List<string> ShownKeys { get; set; } = new();
    public string ShownTitle { get; set; }
    public MemoItem FindMemo(string t)
    {
        foreach (var m in Memo) if (m.Src == t || Engine.Similar(m.Src, t)) return m;
        return null;
    }
    public void Remember(string src, string tr, double q)
    {
        var m = FindMemo(src);
        if (m != null) { m.Src = src; m.Tr = tr; m.Q = Math.Max(m.Q, q); return; }
        Memo.Add(new MemoItem { Src = src, Tr = tr, Q = q }); if (Memo.Count > 80) Memo.RemoveAt(0);
    }
    public static string KeyOf(Bubble b) => (b.Out ? ">" : "<") + b.From + "|" + b.Text;
    public sealed class Screenful { public string Title = ""; public List<Bubble> Bubbles = new(); public string Key = ""; public double Q = 100; }

    public PhoneReader(MessageReader host) { ocrHost = host; }

    public void Reset() { Box = null; prevBox = null; lastGrid = null; Masks = null; miss = 0; Ok = false; seen = null; nulls = 0; lowQ = 0; ShownQ = 0; ShownKey = null; ShownSrcs = new(); ShownKeys = new(); ShownTitle = null; }

    // Onay: aday kutuda OCR okunur yazı bulunca telefon sayılır (panel, maske, mesaj kutusunu susturma ancak o zaman)
    public bool Ok { get; private set; }
    int nulls;
    (int X0, int X1, DateTime T)? seen;
    Rectangle? rej; DateTime rejUntil;
    static double Overlap(Rectangle a, Rectangle c)
    {
        var i = Rectangle.Intersect(a, c);
        if (i.Width <= 0 || i.Height <= 0) return 0;
        return (double)i.Width * i.Height / Math.Min((double)a.Width * a.Height, (double)c.Width * c.Height);
    }

    static double Lum(byte[] p, int i) => 0.114 * p[i] + 0.587 * p[i + 1] + 0.299 * p[i + 2];
    static int Sat(byte[] p, int i) => Math.Max(p[i], Math.Max(p[i + 1], p[i + 2])) - Math.Min(p[i], Math.Min(p[i + 1], p[i + 2]));

    /// <summary>
    /// Kaba tespit (320 px genişlik). Telefon ekranının sol ve sağ kenarı DÜZ dikey çizgilerdir: bir yanı koyu çerçeve,
    /// öbür yanı açık-renksiz ekran. İki kenarın aynı satırda görüldüğü satırlar sayılır; telefon ekranın her yerinde
    /// olabilir, yayın kamerası/logo üstünü kapatsa da alttaki satırlar yeter. Gündüz gri çerçeve için karşıtlık eşiği.
    /// Yanlış adaylar OCR onayıyla elenir (StepAsync).
    /// </summary>
    /// <summary>Tespit sonucu: eksene hizalı çevreleyen kutu + eğik ekranın merkezi, eni/boyu ve eksenleri (yakalanan görüntü koordinatı).</summary>
    public readonly record struct Geo(RectangleF R, int N, float Cx, float Cy, float Wd, float Ht, float Ux, float Uy, float Vx, float Vy, float Sl);

    static Geo? Detect(Bitmap screen)
    {
        int W = 320, H = Math.Max(80, 320 * screen.Height / Math.Max(1, screen.Width));
        byte[] px; int st;
        using (var small = new Bitmap(W, H, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(screen, 0, 0, W, H); }
            px = MessageReader.Pixels(small, out st);
        }
        int N = W * H;
        var Lv = new byte[N]; var B = new bool[N]; var D = new bool[N];
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int i = y * st + x * 4, p = y * W + x;
                Lv[p] = (byte)Lum(px, i);
                B[p] = Sat(px, i) <= 50 && Lv[p] >= 115;
                D[p] = Lv[p] < 115;
            }
        // Kenar olayları: çerçeve (2 px) ekrandan (3 px) en az 55 daha koyu (eğik kenarda da satır içinde geçerli)
        var LE = new bool[N]; var RE = new bool[N];
        var evL = new List<int>(); var evR = new List<int>();
        for (int y = 0; y < H; y++)
            for (int x = 3; x < W - 3; x++)
            {
                int p = y * W + x;
                if (!B[p]) continue;
                if (B[p + 1] && B[p + 2] && Math.Max(Lv[p - 1], Lv[p - 2]) <= Math.Min(Lv[p], Math.Min(Lv[p + 1], Lv[p + 2])) - 55) { LE[p] = true; evL.Add(x); evL.Add(y); }
                if (B[p - 1] && B[p - 2] && Math.Max(Lv[p + 1], Lv[p + 2]) <= Math.Min(Lv[p], Math.Min(Lv[p - 1], Lv[p - 2])) - 55) { RE[p] = true; evR.Add(x); evR.Add(y); }
            }
        // Telefon elde eğik durabilir: kenar olaylarını en iyi hizalayan eğim (x kayması / y) aranır (±0,45 ≈ ±24°).
        // Her eğim için görüntü kaydırılıp (shear) dik kenar araması aynen yapılır; düz (0) her zaman denenir.
        double H2 = H / 2.0;
        int Peak(List<int> ev, double sl)
        {
            var h = new int[W + 2];
            for (int k = 0; k < ev.Count; k += 2) { int x = (int)Math.Round(ev[k] - sl * (ev[k + 1] - H2)); if (x >= 0 && x < W) h[x + 1]++; }
            int m = 0; for (int x = 1; x <= W; x++) m = Math.Max(m, h[x - 1] + h[x] + h[x + 1]);
            return m;
        }
        double bestS = 0; int bestP = Peak(evL, 0) + Peak(evR, 0);
        for (int k = -18; k <= 18; k++)
        {
            if (k == 0) continue;
            double sl = k * 0.025;
            int pk = Peak(evL, sl) + Peak(evR, sl);
            if (pk > bestP * 1.1) { bestP = pk; bestS = sl; }
        }
        bool[] Shear(bool[] A, double sl)
        {
            if (sl == 0) return A;
            var O = new bool[N];
            for (int y = 0; y < H; y++) { int o = (int)Math.Round(sl * (y - H2)), row = y * W; for (int x = 0; x < W; x++) { int sx = x + o; if (sx >= 0 && sx < W) O[row + x] = A[row + sx]; } }
            return O;
        }
        (int Xl, int Xr, int Y0, int Y1, int N, int Sc, double Sl)? Search(double sl)
        {
            var LEs = Shear(LE, sl); var REs = Shear(RE, sl); var Bs = Shear(B, sl); var Ds = Shear(D, sl);
            var le = new int[W]; var re = new int[W];
            for (int p = 0; p < N; p++) { if (LEs[p]) le[p % W]++; if (REs[p]) re[p % W]++; }
            // Çerçeve sürekliliği: sütundaki en uzun koyu dizi
            var run = new int[W];
            for (int x = 0; x < W; x++)
            {
                int best = 0, cs = -1, gap = 0;
                for (int y = 0; y < H; y++)
                {
                    if (Ds[y * W + x]) { if (cs < 0) cs = y; gap = 0; if (y - cs + 1 > best) best = y - cs + 1; }
                    else if (cs >= 0 && ++gap > 3) { cs = -1; gap = 0; }
                }
                run[x] = best;
            }
            int minW = (int)Math.Round(W * 0.07), maxW = (int)Math.Round(W * 0.32);
            double mr = H * 0.05;
            bool At(bool[] A, int y, int x) => A[y * W + x] || A[y * W + x - 1] || A[y * W + x + 1];
            (int Xl, int Xr, int Y0, int Y1, int N, int Sc)? gb = null;
            for (int xl = 4; xl < W - minW; xl++)
            {
                if (le[xl - 1] + le[xl] + le[xl + 1] < mr || Math.Max(run[xl - 2], run[xl - 3]) < H * 0.4) continue;
                for (int xr = xl + minW; xr <= Math.Min(W - 5, xl + maxW); xr++)
                {
                    if (re[xr - 1] + re[xr] + re[xr + 1] < mr || Math.Max(run[xr + 2], run[xr + 3]) < H * 0.4) continue;
                    int n = 0, y0 = -1, y1 = -1, nb = 0, nt = 0;
                    for (int y = 0; y < H; y++)
                    {
                        if (!At(LEs, y, xl) || !At(REs, y, xr)) continue;
                        n++; if (y0 < 0) y0 = y; y1 = y;
                        for (int x = xl; x <= xr; x++) if (Bs[y * W + x]) nb++;
                        nt += xr - xl + 1;
                    }
                    if (n < mr || nb < nt * 0.5) continue;
                    // Mesaj kutusu (sağ alt) ve mini harita (sol alt) telefon sayılmaz
                    if (xl >= W * 0.74 && y0 >= H * 0.6) continue;
                    if (xr <= W * 0.35 && y0 >= H * 0.65) continue;
                    int sc = n * (xr - xl);
                    if (gb == null || sc > gb.Value.Sc) gb = (xl, xr, y0, y1, n, sc);
                }
            }
            if (gb is not var (gxl, gxr, gy0, gy1, gn, gsc)) return null;
            // Dikeyde ekranın geri kalanına uzat (fotoğraf/renkli satırlar da ekranın parçası; boşluk ≤ 6 satır)
            int gw = gxr - gxl + 1;
            int RowB(int y) { int c = 0; for (int x = gxl; x <= gxr; x++) if (Bs[y * W + x]) c++; return c; }
            bool Edge(int y) => At(LEs, y, gxl) || At(REs, y, gxr) || (Ds[y * W + gxl - 2] && Ds[y * W + gxr + 2] && RowB(y) >= gw * 0.12);
            int fy0 = gy0, fy1 = gy1;
            for (int y = fy1 + 1, gap = 0; y < H && gap <= 6; y++) { if (Edge(y)) { fy1 = y; gap = 0; } else gap++; }
            for (int y = fy0 - 1, gap = 0; y >= 0 && gap <= 6; y--) { if (Edge(y)) { fy0 = y; gap = 0; } else gap++; }
            return (gxl, gxr, fy0, fy1, gn, gsc, sl);
        }
        var g1 = Search(bestS);
        if (bestS != 0) { var g0 = Search(0); if (g0 != null && (g1 == null || g0.Value.Sc >= g1.Value.Sc)) g1 = g0; }
        if (g1 is not var (Xl, Xr, Y0, Y1, Nn, _, Sl)) return null;
        // Kaydırılmış koordinattan görüntüye: ekranın merkezi, eksenleri (eğik), boyu ve eni + çevreleyen kutu
        float kx = screen.Width / (float)W, ky = screen.Height / (float)H;
        double nrm = Math.Sqrt(1 + Sl * Sl);
        double cyS = (Y0 + Y1 + 1) / 2.0, cxS = (Xl + Xr + 1) / 2.0;
        float cx = (float)((cxS + Sl * (cyS - H2)) * kx), cy = (float)(cyS * ky);
        float wd = (float)((Xr + 1 - Xl) * kx / nrm), ht = (float)((Y1 + 1 - Y0) * ky * nrm);
        float ux = (float)(1 / nrm), uy = (float)(-Sl / nrm), vx = (float)(Sl / nrm), vy = (float)(1 / nrm);
        float ex = Math.Abs(ux) * wd / 2 + Math.Abs(vx) * ht / 2, ey = Math.Abs(uy) * wd / 2 + Math.Abs(vy) * ht / 2;
        return new Geo(RectangleF.FromLTRB(cx - ex, cy - ey, cx + ex, cy + ey), Nn, cx, cy, wd, ht, ux, uy, vx, vy, (float)Sl);
    }

    static readonly Regex Ui = new(@"^(new messages?|messages?( encrypted)?|suggested|contacts|recent|favou?rites|calls|notifications|locating|scroll|back|send|select|exit|tab|options|view comments?|set destination|delivered|read|seen|today|yesterday|typing)$", RegexOptions.IgnoreCase);
    // OCR bir harfi yanlış okusa da ("Ncw messages") arayüz yazısı sayılır
    static readonly string[] UiList = { "new message", "new messages", "view comments", "view comment", "notifications", "set destination", "favorites", "favourites", "suggested", "contacts", "messages", "delivered", "yesterday" };
    static bool Lev1(string a, string b)
    {
        if (Math.Abs(a.Length - b.Length) > 1) return false;
        int i = 0, j = 0, e = 0;
        while (i < a.Length && j < b.Length)
        {
            if (a[i] == b[j]) { i++; j++; continue; }
            if (++e > 1) return false;
            if (a.Length > b.Length) i++; else if (b.Length > a.Length) j++; else { i++; j++; }
        }
        return e + (a.Length - i) + (b.Length - j) <= 1;
    }
    static bool UiLike(string t) { var s = t.ToLowerInvariant(); return Ui.IsMatch(s) || (s.Length >= 6 && UiList.Any(u => Lev1(u, s))); }
    // Kutunun mavi zemin oranı (mavi baloncuk ~1; beyaz zemindeki mavi yazı ~0,5 — eşik 0,6)
    static double BlueFrac(bool[] blue, int W, int H, float fx0, float fy0, float fx1, float fy1)
    {
        if (blue == null) return 0;
        int x0 = Math.Max(0, (int)fx0), y0 = Math.Max(0, (int)fy0), x1 = Math.Min(W - 1, (int)Math.Ceiling(fx1)), y1 = Math.Min(H - 1, (int)Math.Ceiling(fy1));
        int n = 0, t = 0;
        for (int y = y0; y <= y1; y += 2) for (int x = x0; x <= x1; x += 2) { t++; if (blue[y * W + x]) n++; }
        return t > 0 ? (double)n / t : 0;
    }
    static readonly Regex ShortOk = new(@"^(ok|okay|yo|hi|hey|no|ya|k|lol|ty|yes|yeah|cool|thanks|sure)\W*$", RegexOptions.IgnoreCase);
    static readonly Regex NameWord = new(@"^[\p{Lu}@][\p{L}'’.&-]*$");
    static bool IsNameLine(List<(string Text, RectangleF R)> ws) => ws.Count <= 3 && ws.All(w => NameWord.IsMatch(w.Text)) && !Regex.IsMatch(ws[^1].Text, @"[.!?]$");

    /// <summary>
    /// Bir adım. Hide=true → telefon gitti (katmanı gizle). Shot != null → yeni ekran içeriği okundu.
    /// </summary>
    public async Task<(Screenful Shot, bool Hide)> StepAsync(Rectangle subRegion)
    {
        var sc = Screen.FromRectangle(subRegion).Bounds;
        Geo? det;
        using (var full = Engine.Capture(sc)) det = Detect(full);
        var now = DateTime.UtcNow;
        if (det is not Geo geo)
        {
            // Tespit bir an kaçabilir (el, sallantı, yayın logosu): onaylı telefonu ~2,5 sn, adayı ~0,75 sn tut
            if (Box != null && ++miss >= (Ok ? 10 : 3)) { Reset(); return (null, true); }
            return (null, false);
        }
        var d = geo.R;
        var box = Rectangle.Round(new RectangleF(sc.Left + d.Left, sc.Top + d.Top, d.Width, d.Height));
        // Sağ alttaki mesaj kutusu görünürken onu da içine alan aday telefon değildir (kutunun açık zemini + üstteki
        // gökyüzü uzun bir "ekran" gibi görünüp mesaj ekranın tepesine sohbet olarak yazılıyordu)
        if (ocrHost.Mask is Rectangle mm && Overlap(box, mm) > 0.5)
        {
            if (Box != null && ++miss >= (Ok ? 10 : 3)) { Reset(); return (null, true); }
            return (null, false);
        }
        miss = 0;
        // Aynı telefon (sol kenar aynı yerde): sağ kenarı yayın kamerası/el kapatınca daralmasın, son tam genişlik kullanılır
        if (seen is var (sx0, sx1, st) && (now - st).TotalMilliseconds < 2500 && Math.Abs(box.Left - sx0) < sc.Width * 0.02)
        {
            if (box.Right < sx1 - sc.Width * 0.01)
            {
                int dx = sx1 - box.Right; // sağ kenar dx kadar dışarıda: eğik ekranın eni ve merkezi de güncellenir
                geo = geo with { Wd = geo.Wd + dx * geo.Ux, Cx = geo.Cx + dx / 2f };
                box = Rectangle.FromLTRB(box.Left, box.Top, sx1, box.Bottom);
            }
            else seen = (box.Left, box.Right, now);
        }
        else seen = (box.Left, box.Right, now);
        // Başka yere geçtiyse (başka aday) onay sıfırlanır
        bool newPlace = Ok && Box is Rectangle ob && Overlap(box, ob) < 0.3;
        if (newPlace) { Ok = false; nulls = 0; lastGrid = null; ShownKey = null; ShownKeys = new(); ShownSrcs = new(); ShownTitle = null; }
        Box = box;
        // Altyazı okumasından çıkar (yalnızca onaylı telefon): ekran (+ çerçeve payı) ve sağ alttaki tuş ipuçları
        Masks = Ok ? new List<Rectangle>
        {
            Rectangle.FromLTRB(box.Left - (int)(sc.Width * 0.012), box.Top - (int)(sc.Height * 0.02), box.Right + (int)(sc.Width * 0.012), box.Bottom + (int)(sc.Height * 0.015)),
            Rectangle.FromLTRB(sc.Left + (int)(sc.Width * 0.84), sc.Top + (int)(sc.Height * 0.8), sc.Right, sc.Bottom),
        } : null;
        if (newPlace) return (null, true);

        // Yalnızca HIZLI hareket (telefon kaldırılıp indiriliyor) beklenir; gemide/araçta sallantı okumayı durdurmaz
        bool moved = prevBox is Rectangle pb && (Math.Abs(box.Left - pb.Left) > sc.Width * 0.025 || Math.Abs(box.Right - pb.Right) > sc.Width * 0.025
            || Math.Abs((box.Top + box.Bottom) - (pb.Top + pb.Bottom)) > sc.Height * 0.3);
        bool firstSeen = prevBox == null;
        prevBox = box;
        // Aday en az iki ardışık karede görülmeli (tek karelik parlama/geçiş OCR'a gitmesin)
        if (moved || firstSeen) return (null, false);
        if (!Ok && rej is Rectangle rr && now < rejUntil && Overlap(box, rr) > 0.6) return (null, false);
        double sinceOcr = (now - lastOcr).TotalMilliseconds;
        if (sinceOcr < 700) return (null, false);
        using var shot = Engine.Capture(box);
        // Ekran imzası: 18×32 hücrelik ortalama parlaklık (sallantıda az, kaydırma/yeni mesajda çok değişir).
        // Belirgin değiştiyse oku; değişmese de telefon açıkken 2,5 sn'de bir yeniden oku (kaçan/bulanık okuma telafi edilir).
        var sig = LumGrid(shot);
        if (Ok && GridDiff(lastGrid, sig) < 10 && sinceOcr < 2500) return (null, false);
        lastOcr = DateTime.UtcNow;
        lastGrid = sig;

        // OCR görüntüsü: koyu yazı siyah, kalan her şey beyaz (~700 px genişlik). Eğik telefon düzeltilerek çizilir
        // (telefonun eni/boyu eksenleri çıktının x/y'si olur → yazı satırları yatay).
        double scale = Math.Min(3, Math.Max(1, 700.0 / geo.Wd));
        const int PAD = 10;
        int Wc = (int)(geo.Wd * scale), Hc = (int)(geo.Ht * scale);
        List<List<(string Text, RectangleF R)>> lines;
        bool[] blueMap;
        using (var big = new Bitmap(Wc, Hc, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(big))
            {
                g.Clear(Color.White);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                float lcx = geo.Cx + sc.Left - box.Left, lcy = geo.Cy + sc.Top - box.Top; // yakalanan görüntüde merkez
                float s1 = (float)scale;
                g.Transform = new Matrix(s1 * geo.Ux, s1 * geo.Vx, s1 * geo.Uy, s1 * geo.Vy,
                    Wc / 2f - s1 * (geo.Ux * lcx + geo.Uy * lcy), Hc / 2f - s1 * (geo.Vx * lcx + geo.Vy * lcy));
                g.DrawImage(shot, 0, 0, shot.Width, shot.Height);
            }
            var bpx = MessageReader.Pixels(big, out int bst);
            // Mavi zemin haritası (giden mesaj baloncuğu): ikili görüntüde renk kaybolmadan önce. Ekran zemini güneşte
            // sıcak/sarımsı olabilir: mavilik zemine göre ölçülür.
            var hBR = new int[512]; var hBG = new int[512]; int nBg = 0;
            for (int y = 0; y < Hc; y += 2)
                for (int x = 0; x < Wc; x += 2) { int i = y * bst + x * 4; if (Lum(bpx, i) >= 150 && Sat(bpx, i) < 60) { hBR[bpx[i] - bpx[i + 2] + 255]++; hBG[bpx[i] - bpx[i + 1] + 255]++; nBg++; } }
            int Med(int[] h) { int c = 0; for (int t = 0; t < 512; t++) { c += h[t]; if (c >= nBg / 2) return t - 255; } return 0; }
            int bR = nBg > 50 ? Math.Min(0, Med(hBR)) : 0, bG = nBg > 50 ? Math.Min(0, Med(hBG)) : 0;
            blueMap = new bool[Wc * Hc];
            for (int y = 0; y < Hc; y++)
                for (int x = 0; x < Wc; x++) { int i = y * bst + x * 4; if (bpx[i] - bpx[i + 2] - bR >= 14 && bpx[i] - bpx[i + 1] - bG >= 6) blueMap[y * Wc + x] = true; }
            var bink = MessageReader.Ink(bpx, bst, Wc, Hc, Math.Max(2, (int)Math.Round(scale * 2)), out _, out _, out _);
            // Koyu mavi giden baloncuk (beyaz yazı): baloncuk alanı = iki yanında da (aynı satırda, yakın) mavi piksel olan yer
            // (mavimsi beyaz harfler de "mavi" sayılır). Alanda zemin/yazı ayrımı Otsu eşiğiyle: açık = yazı.
            var lb = new bool[Wc * Hc]; var zone = new bool[Wc * Hc]; int nb2 = 0;
            for (int y = 0; y < Hc; y++)
                for (int x = 0; x < Wc; x++) { int i = y * bst + x * 4; if (bpx[i] >= 150 && bpx[i] - bpx[i + 2] >= 60) { lb[y * Wc + x] = true; nb2++; } }
            if (nb2 > Wc * Hc * 0.01)
            {
                int Dz = (int)Math.Round(10 * scale); var lastL = new int[Wc]; var hist = new int[256]; int nz = 0;
                for (int y = 0; y < Hc; y++)
                {
                    int l0 = -1000000;
                    for (int x = 0; x < Wc; x++) { if (lb[y * Wc + x]) l0 = x; lastL[x] = l0; }
                    int r0 = 1000000;
                    for (int x = Wc - 1; x >= 0; x--)
                    {
                        int p = y * Wc + x;
                        if (lb[p]) r0 = x;
                        if (x - lastL[x] <= Dz && r0 - x <= Dz) { zone[p] = true; nz++; hist[(int)Math.Round(Lum(bpx, y * bst + x * 4))]++; }
                    }
                }
                long sum = 0; for (int t = 0; t < 256; t++) sum += (long)t * hist[t];
                long wB = 0, sB = 0; double best = 0; int thr = 150;
                for (int t = 0; t < 256; t++)
                {
                    wB += hist[t]; if (wB == 0) continue; long wF = nz - wB; if (wF == 0) break;
                    sB += (long)t * hist[t]; double mB = (double)sB / wB, mF = (double)(sum - sB) / wF, bv = (double)wB * wF * (mB - mF) * (mB - mF);
                    if (bv > best) { best = bv; thr = t; }
                }
                int dark = 0; for (int t = 0; t < 130; t++) dark += hist[t];
                if (dark > nz * 0.4) // koyu mavi baloncuk var (açık mavi baloncukta bu kural uygulanmaz)
                {
                    // Baloncuğun açık kenar halkası yazı sayılmasın: alan kenarından r pikselden yakın yerler boş
                    int r = Math.Max(3, (int)Math.Round(4 * scale)); var inner = new bool[Wc * Hc];
                    for (int y = 0; y < Hc; y++)
                    {
                        int c = 0; for (int x = 0; x < Wc; x++) { int p = y * Wc + x; c = zone[p] ? c + 1 : 0; inner[p] = c > r; }
                        c = 0; for (int x = Wc - 1; x >= 0; x--) { int p = y * Wc + x; c = zone[p] ? c + 1 : 0; if (c <= r) inner[p] = false; }
                    }
                    for (int x = 0; x < Wc; x++)
                    {
                        int c = 0; for (int y = 0; y < Hc; y++) { int p = y * Wc + x; c = zone[p] ? c + 1 : 0; if (c <= r) inner[p] = false; }
                        c = 0; for (int y = Hc - 1; y >= 0; y--) { int p = y * Wc + x; c = zone[p] ? c + 1 : 0; if (c <= r) inner[p] = false; }
                    }
                    for (int y = 0; y < Hc; y++)
                        for (int x = 0; x < Wc; x++)
                        {
                            int p = y * Wc + x, i = y * bst + x * 4;
                            if (zone[p]) bink[p] = inner[p] && Lum(bpx, i) > thr + 8;
                            else if (bink[p] && bpx[i] - bpx[i + 2] >= 45) bink[p] = false; // baloncuk kenarı çizgi olmasın
                        }
                }
            }
            // Kalan yazı eğikliği (telefon üç boyutlu da dönebilir): satır izdüşümünün en keskin olduğu açı (±0,08) bulunur,
            // yazı + mavi harita dikeyde kaydırılarak düzeltilir
            double bestA = 0, bestV = -1;
            for (int k = -8; k <= 8; k++)
            {
                double a = k * 0.01;
                var rows = new double[Hc + 400];
                for (int y = 0; y < Hc; y += 2) for (int x = 0; x < Wc; x += 2) if (bink[y * Wc + x]) { int yy = (int)Math.Round(y - a * (x - Wc / 2.0)) + 200; if (yy >= 0 && yy < rows.Length) rows[yy]++; }
                double v = 0; foreach (var t in rows) v += t * t;
                if (v > bestV * 1.02 || (k == 0 && v >= bestV * 0.98)) { bestV = v; bestA = a; }
            }
            if (Math.Abs(bestA) > 0.005)
            {
                var ink2 = new bool[Wc * Hc]; var blue2 = new bool[Wc * Hc];
                for (int y = 0; y < Hc; y++)
                    for (int x = 0; x < Wc; x++)
                    {
                        int sy = (int)Math.Round(y + bestA * (x - Wc / 2.0));
                        if (sy >= 0 && sy < Hc) { ink2[y * Wc + x] = bink[sy * Wc + x]; blue2[y * Wc + x] = blueMap[sy * Wc + x]; }
                    }
                bink = ink2; blueMap = blue2;
            }
            int OW = Wc + PAD * 2, OH = Hc + PAD * 2;
            var outPx = new byte[OW * OH * 4];
            Array.Fill(outPx, (byte)255);
            for (int y = 0; y < Hc; y++)
                for (int x = 0; x < Wc; x++)
                    if (bink[y * Wc + x]) { int o = ((y + PAD) * OW + x + PAD) * 4; outPx[o] = outPx[o + 1] = outPx[o + 2] = 0; }
            lines = await ocrHost.RecognizeAsync(outPx, OW, OH);
        }
        var parsed = Parse(lines, Wc, Hc, PAD, blueMap);
        if (parsed == null)
        {
            // Aday telefon değilmiş: bu bölge 4 sn yeniden okunmaz. Onaylı telefonda ana ekran/fotoğraf: eski paneli kaldır.
            // Aynı yer üst üste reddedilirse daha uzun beklenir (sabit bir nesne OCR'ı meşgul etmesin)
            if (!Ok) { bool again = rej is Rectangle pr && Overlap(box, pr) > 0.6; rej = box; rejUntil = DateTime.UtcNow.AddSeconds(again ? 10 : 4); return (null, false); }
            if (++nulls >= 2 && ShownKey != null) { ShownKey = null; ShownKeys = new(); ShownSrcs = new(); ShownTitle = null; return (null, true); }
            return (null, false);
        }
        nulls = 0;
        // Hareket bulanıklığı: kare toptan kötü okunduysa (gösterilenden belirgin düşük) panel bozulmaz, hemen yeniden okunur.
        // Kalıcı düşükse 4 denemeden sonra kabul edilir.
        if (ShownKey != null && parsed.Q < ShownQ - 10 && ++lowQ < 4) { lastGrid = null; return (null, false); }
        lowQ = 0;
        if (parsed.Q < 85) lastGrid = null; // sınırda kalite: daha net kareyle kısa sürede yeniden oku
        if (!Ok) { Ok = true; rej = null; }
        // Daha önce çevrilen baloncuk: eski metin + çeviri. Yeni okuma belirgin daha netse eskinin yerine geçer (yeniden çevrilir)
        foreach (var b in parsed.Bubbles)
        {
            var m = FindMemo(b.Text);
            if (m == null) continue;
            if (b.Text != m.Src && b.Q > m.Q + 10) { m.Src = b.Text; m.Q = b.Q; m.Tr = null; } else b.Text = m.Src;
        }
        parsed.Key = parsed.Title + "\n" + string.Join("\n", parsed.Bubbles.Select(KeyOf));
        if (parsed.Key == ShownKey) { ShownQ = Math.Max(ShownQ, parsed.Q); return (null, false); }
        // Eksik okuma (hepsi zaten gösteriliyor, birkaçı kaçmış): paneli bozma
        if (ShownTitle == parsed.Title && ShownKeys.Count > parsed.Bubbles.Count && parsed.Bubbles.All(b => ShownKeys.Contains(KeyOf(b)))) return (null, false);
        return (parsed, false);
    }

    static int Letters(string s) => s.Count(char.IsLetter);
    static readonly Regex PhStart = new(@"^(hey|hi|hello|yo|ok|okay|so|and|but|i|i'm|im|i'll|i've|you|u|we|they|he|she|it|it's|its|this|that|the|my|your|just|don't|dont|can|can't|could|would|where|what|when|why|how|who|yeah|yes|no|nah|sorry|thanks|thank|lol|omg|wtf|got|need|meet|come|call|listen|look|wait|did|do|are|is|well|man|dude|bro|babe|baby|good|great|please|pls|plz|let's|lets|guess|remember|tell|hope|still|also|btw|on|at|in|if|there|here|whatever|sure|cool|nice|damn|fuck|shit)\b", RegexOptions.IgnoreCase);

    // Çerçeveli baloncuk (açık zemin, mavi kenar = giden): yazının solunda/sağında baloncuk boyunca uzanan mavi dikey çizgi
    static bool BubbleBorder(bool[] blue, int W, int H, float x0, float y0, float x1, float y1)
    {
        if (blue == null) return false;
        int m = (int)Math.Round(W * 0.1), iy0 = Math.Max(0, (int)y0), iy1 = Math.Min(H - 1, (int)Math.Ceiling(y1));
        if (iy1 - iy0 < 8) return false;
        double Col(int x)
        {
            int n = 0;
            for (int y = iy0; y <= iy1; y++) { int p = y * W + x; if (blue[p] || (x > 0 && blue[p - 1]) || (x < W - 1 && blue[p + 1])) n++; }
            return (double)n / (iy1 - iy0 + 1);
        }
        for (int x = Math.Max((int)Math.Round(W * 0.03), (int)x0 - m); x < x0 - 3; x++) if (Col(x) >= 0.5) return true;
        for (int x = (int)Math.Ceiling(x1) + 3; x <= Math.Min(W - 1 - (int)Math.Round(W * 0.03), (int)Math.Ceiling(x1) + m); x++) if (Col(x) >= 0.5) return true;
        return false;
    }

    static Screenful Parse(List<List<(string Text, RectangleF R)>> raw, int Wc, int Hc, int P, bool[] blue = null)
    {
        var ls = new List<(List<(string Text, RectangleF R)> Ws, string Text, float X0, float X1, float Y0, float Y1, int Bar, double Blue, double Known)>();
        foreach (var l in raw)
        {
            // Satırın başında/sonunda boşlukla ayrılmış "|" baloncuk kenar çizgisidir (çerçeveli = giden): atılır.
            // Diğer "|" → "I" (OCR "I" harfini çoğu zaman "|" okur)
            var lw0 = l.Where(w => w.Text.Length > 0).ToList();
            float lh = lw0.Count > 0 ? lw0.Select(w => w.R.Height).OrderBy(v => v).ElementAt(lw0.Count / 2) : 0;
            int bar = 0;
            var kept = new List<(string Text, RectangleF R)>();
            for (int k = 0; k < lw0.Count; k++)
            {
                var w = lw0[k];
                if (lw0.Count > 1 && Regex.IsMatch(w.Text, @"^[|\[\]!l1I]$"))
                {
                    bool keep = k == 0 ? lw0[1].R.Left - w.R.Right <= lh * 0.5 : k == lw0.Count - 1 ? w.R.Left - lw0[k - 1].R.Right <= lh * 0.5 : true;
                    if (!keep) { bar++; continue; }
                }
                kept.Add(w.Text == "|" ? ("I", w.R) : w);
            }
            var ws = kept.Where(w => w.Text.Any(c => char.IsLetterOrDigit(c))).ToList();
            // Satır başındaki avatar/simge kırıntısı (tek harf) hizalamayı bozmasın
            while (ws.Count > 1 && Letters(ws[0].Text) < 2 && ws[0].Text != "I" && ws[0].Text != "a" && ws[0].Text != "A") ws.RemoveAt(0);
            if (ws.Count == 0) continue;
            string text = string.Join(" ", ws.Select(w => w.Text)).Trim();
            string bare = Regex.Replace(Regex.Replace(text, @"[^\p{L}\s]", " "), @"\s+", " ").Trim();
            if (Letters(bare) < 2 || UiLike(bare)) continue;
            // Bulanık/bozuk okunan satır (kaydırma anı): 3+ harfli küçük harfli kelimelerin çoğu gerçek kelime olmalı
            var lw = ws.Where(w => Letters(w.Text) >= 3 && !char.IsUpper(w.Text[0])).ToList();
            int kn = lw.Count(w => WordDict.Info(w.Text).Known == true);
            if (lw.Count >= 2 && kn < lw.Count * 0.5) continue;
            float x0 = ws[0].R.Left, x1 = ws.Max(w => w.R.Right), y0 = ws.Min(w => w.R.Top), y1 = ws.Max(w => w.R.Bottom);
            ls.Add((ws, text, x0, x1, y0, y1, bar, BlueFrac(blue, Wc, Hc, x0 - P, y0 - P, x1 - P, y1 - P), lw.Count == 0 ? 1 : (double)kn / lw.Count));
        }
        if (ls.Count == 0) return null;
        ls.Sort((a, b) => a.Y0.CompareTo(b.Y0));
        var res = new Screenful();
        // Başlık: üstteki kısa satır (kişi / dükkân adı)
        // (cümle değil: nokta/soru ile bitmez, kelimelerin çoğu büyük harfle başlar; simge kırıntıları — "£2" — sayılmaz)
        var tw = ls[0].Ws.Where(w => Letters(w.Text) >= 2).ToList();
        int capN = tw.Count(w => char.IsUpper(w.Text[0]) || w.Text[0] == '@' || char.IsDigit(w.Text[0]));
        if (tw.Count > 0 && ls[0].Y0 - P < Hc * 0.1 && tw.Count <= 5 && !Regex.IsMatch(tw[^1].Text, @"[.!?]$") && capN >= (int)Math.Ceiling(tw.Count * 0.6))
        {
            res.Title = string.Join(" ", tw.Select(w => Regex.Replace(w.Text, @"^[^\p{L}@]+|[^\p{L}.!?']+$", ""))).Trim();
            ls.RemoveAt(0);
        }
        // Satırları baloncuklara topla: yakın, aynı sol kenar (ya da ikisi de mavi zeminde) ve aynı zemin
        var bubbles = new List<(List<int> Idx, float X0, float Y0, float Y1, float X1)>();
        for (int i = 0; i < ls.Count; i++)
        {
            var l = ls[i];
            float h = l.Y1 - l.Y0;
            if (bubbles.Count > 0)
            {
                var pl = ls[bubbles[^1].Idx[^1]];
                if (l.Y0 - bubbles[^1].Y1 < h * 0.8 && (Math.Abs(l.X0 - bubbles[^1].X0) < Wc * 0.07 || (l.Blue >= 0.6 && pl.Blue >= 0.6)) && Math.Abs(l.Blue - pl.Blue) < 0.4)
                {
                    var b = bubbles[^1]; b.Idx.Add(i); b.Y1 = l.Y1; b.X1 = Math.Max(b.X1, l.X1); bubbles[^1] = b;
                    continue;
                }
            }
            bubbles.Add((new List<int> { i }, l.X0, l.Y0, l.Y1, l.X1));
        }
        for (int bi = 0; bi < bubbles.Count; bi++)
        {
            var b = bubbles[bi];
            var idx = b.Idx;
            string from = "";
            bool cut = false;
            // Ekranın üstünde yarım kalmış baloncuk: yarısı kesik (bozuk okunan) ilk satır atılır, kalanı "…" ile gösterilir.
            // (oyunda mesajlar çoğu zaman küçük harfle başlar: "hey, it's me" — tipik cümle başıysa kesik sayılmaz)
            if (bi == 0)
            {
                string t0 = string.Join(" ", idx.Select(i => ls[i].Text));
                if (t0.Length > 0 && char.IsLower(t0[0]) && !PhStart.IsMatch(t0)) cut = true;
                while (idx.Count > 1 && ls[idx[0]].Known < (cut ? 0.8 : 0.6)) { idx = idx.Skip(1).ToList(); cut = true; }
                if (cut && idx.Count == b.Idx.Count && idx.Count < 2) continue; // tek satırlık kesik parça
            }
            // Kişi listesi / grup sohbeti: ilk satır isimse gönderen olarak ayır
            if (idx.Count > 1 && IsNameLine(ls[idx[0]].Ws)) { from = string.Join(" ", ls[idx[0]].Ws.Select(w => w.Text)); idx = idx.Skip(1).ToList(); }
            string text = string.Join(" ", idx.Select(i => ls[i].Text));
            text = Regex.Replace(Regex.Replace(text, @"(\p{L})- (\p{L})", "$1$2"), @"(^|\s)['‘’](?=\p{L}+['’]\p{L})", "$1");
            text = Regex.Replace(text, @"\s+", " ").Trim();
            var ws = idx.SelectMany(i => ls[i].Ws).ToList();
            // Kelime denetimi: büyük harfli (isim) ve "…" ile kesilmiş son kelime sayılmaz
            var lng = ws.Where((w, j) => Letters(w.Text) >= 3 && !char.IsUpper(w.Text[0]) && !(j == ws.Count - 1 && (w.Text.EndsWith("...") || w.Text.EndsWith("…")))).ToList();
            int known = lng.Count(w => WordDict.Info(w.Text).Known == true);
            bool shortOk = ws.Any(w => ShortOk.IsMatch(w.Text)) || (ws.Count >= 2 && ws.Any(w => WordDict.Info(w.Text).Known == true));
            if (lng.Count > 0 ? known < lng.Count * 0.5 : !shortOk) continue;
            var w3 = ws.Where(w => Letters(w.Text) >= 3).ToList();
            double q = w3.Count == 0 ? 100 : 100.0 * w3.Count(w => WordDict.Info(w.Text).Known == true || char.IsUpper(w.Text[0]) && w.Text.Skip(1).All(c => !char.IsLetter(c) || char.IsLower(c))) / w3.Count;
            // Giden: mavi zeminli, mavi kenarlı (çerçeveli) ya da belirgin sağa yaslı baloncuk
            bool outB = from.Length == 0 && (idx.Sum(i => ls[i].Bar) >= 2 || b.X0 - P > Wc * 0.27
                || BlueFrac(blue, Wc, Hc, b.X0 - P, b.Y0 - P, b.X1 - P, b.Y1 - P) >= 0.6 || BubbleBorder(blue, Wc, Hc, b.X0 - P, b.Y0 - P, b.X1 - P, b.Y1 - P));
            res.Bubbles.Add(new Bubble { Q = q, Text = cut ? "…" + text : text, From = from, Out = outB });
        }
        if (res.Bubbles.Count == 0) return null;
        if (res.Bubbles.Count > 7) res.Bubbles = res.Bubbles.Skip(res.Bubbles.Count - 7).ToList();
        // Okuma kalitesi: 3+ harfli kelimelerin sözlükte bulunma oranı (net kare ~95+, bulanık kare belirgin düşük)
        res.Q = res.Bubbles.Average(b => b.Q);
        return res;
    }
}

/// <summary>Telefon çevirisi: telefonun solunda koyu panel; başlık beyaz, gelen baloncuklar sarı (sola), giden mavi (sağa).</summary>
sealed class PhoneOverlay : Form
{
    Bitmap frame;
    Point pos;

    public PhoneOverlay()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT | Native.WS_EX_TOOLWINDOW
                        | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOPMOST;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Yayında (Discord/OBS) görünsün. Kendi ekran okumamıza karışmaz: CopyFromScreen katmanlı pencereleri yakalamaz.
        Native.SetWindowDisplayAffinity(Handle, Native.WDA_NONE); // yayında görünsün (CopyFromScreen katmanlı pencereyi yakalamaz)
    }

    public void ShowScreen(string title, List<(string Text, bool Out)> items, Rectangle phone, int fontSize)
    {
        var sc = Screen.FromRectangle(phone).Bounds;
        float fontPx = Math.Clamp(fontSize * sc.Height / 720f * 0.6f, 13, 30);
        float right = phone.Left - sc.Width * 0.035f;
        float width = Math.Max(200, Math.Min(sc.Width * 0.3f, right - sc.Left - sc.Width * 0.03f));
        float maxH = Math.Max(fontPx * 4, sc.Top + sc.Height * 0.68f - phone.Top);
        float pad = fontPx * 0.7f, bpadX = fontPx * 0.6f, bpadY = fontPx * 0.35f, gap = fontPx * 0.4f;
        float bubbleMax = (width - pad * 2) * 0.88f - bpadX * 2;

        using var font = new Font("Segoe UI", fontPx, FontStyle.Bold, GraphicsUnit.Pixel);
        using var headFont = new Font("Segoe UI", fontPx * 1.05f, FontStyle.Bold, GraphicsUnit.Pixel);
        using var fmt = new StringFormat(StringFormat.GenericTypographic);
        using var mg = Graphics.FromHwnd(IntPtr.Zero);
        mg.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        SizeF headSz = title.Length > 0 ? mg.MeasureString(title, headFont, (int)(width - pad * 2), fmt) : SizeF.Empty;
        var sizes = items.Select(it => mg.MeasureString(it.Text, font, (int)bubbleMax, fmt)).ToList();

        // En yeni baloncuklar görünsün: alttan yukarı sığanlar
        float headH = title.Length > 0 ? headSz.Height + fontPx * 0.55f : 0;
        float avail = maxH - pad * 2 - headH;
        int first = items.Count;
        float used = 0;
        for (int i = items.Count - 1; i >= 0; i--)
        {
            float bh = sizes[i].Height + bpadY * 2 + (i < items.Count - 1 ? gap : 0);
            if (used + bh > avail && first < items.Count) break;
            used += bh; first = i;
        }
        int w = (int)Math.Ceiling(width), h = (int)Math.Ceiling(pad * 2 + headH + used) + 2;
        frame?.Dispose();
        frame = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(frame))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            using (var bg = RoundRect(new RectangleF(0, 0, w - 1, h - 1), fontPx * 0.9f))
            using (var br = new SolidBrush(Color.FromArgb(204, 10, 10, 12)))
                g.FillPath(br, bg);
            float y = pad;
            if (title.Length > 0)
            {
                using var white = new SolidBrush(Color.White);
                g.DrawString(title, headFont, white, new RectangleF(pad, y, w - pad * 2, headSz.Height + 1), fmt);
                y += headSz.Height + fontPx * 0.3f;
                using var line = new Pen(Color.FromArgb(36, 255, 255, 255), 1);
                g.DrawLine(line, pad, y, w - pad, y);
                y += fontPx * 0.25f;
            }
            using var yellow = new SolidBrush(Color.FromArgb(255, 0xff, 0xd7, 0x5e));
            using var blue = new SolidBrush(Color.FromArgb(255, 0xdb, 0xe7, 0xff));
            using var inBg = new SolidBrush(Color.FromArgb(20, 255, 255, 255));
            using var outBg = new SolidBrush(Color.FromArgb(72, 90, 130, 255));
            for (int i = first; i < items.Count; i++)
            {
                var sz = sizes[i];
                float bw = sz.Width + bpadX * 2, bh = sz.Height + bpadY * 2;
                float bx = items[i].Out ? w - pad - bw : pad;
                using (var bp = RoundRect(new RectangleF(bx, y, bw, bh), fontPx * 0.8f))
                    g.FillPath(items[i].Out ? outBg : inBg, bp);
                g.DrawString(items[i].Text, font, items[i].Out ? blue : yellow, new RectangleF(bx + bpadX, y + bpadY, sz.Width + 1, sz.Height + 1), fmt);
                y += bh + gap;
            }
        }
        pos = new Point((int)(right - w), phone.Top);
        // Önce görünür yap, SONRA katmanı çiz (Show() önceki çizimi geçersiz kılıyordu)
        if (!Visible) Show();
        Push();
    }

    static GraphicsPath RoundRect(RectangleF r, float rad)
    {
        var p = new GraphicsPath();
        rad = Math.Min(rad, Math.Min(r.Width, r.Height) / 2);
        float d = rad * 2;
        p.AddArc(r.Left, r.Top, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public void HideNow() { if (Visible) Hide(); }

    /// <summary>Oyun tam ekrana geçse bile en üste geri getir.</summary>
    public void KeepOnTop()
    {
        if (Visible) Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER);
    }

    /// <summary>Telefon kaydıysa paneli yeniden çizmeden yanına taşır.</summary>
    public void Follow(Rectangle phone)
    {
        if (!Visible || frame == null) return;
        var sc = Screen.FromRectangle(phone).Bounds;
        var np = new Point((int)(phone.Left - sc.Width * 0.035f - frame.Width), phone.Top);
        if (Math.Abs(np.X - pos.X) <= 4 && Math.Abs(np.Y - pos.Y) <= 4) return;
        pos = np;
        Push();
    }

    void Push()
    {
        if (frame == null) return;
        if (!IsHandleCreated) CreateControl();
        IntPtr screenDc = Native.GetDC(IntPtr.Zero);
        IntPtr memDc = Native.CreateCompatibleDC(screenDc);
        IntPtr hBmp = frame.GetHbitmap(Color.FromArgb(0));
        IntPtr old = Native.SelectObject(memDc, hBmp);
        try
        {
            var size = new Native.SIZE(frame.Width, frame.Height);
            var src = new Native.POINT(0, 0);
            var dst = new Native.POINT(pos.X, pos.Y);
            var blend = new Native.BLENDFUNCTION { BlendOp = Native.AC_SRC_OVER, SourceConstantAlpha = 255, AlphaFormat = Native.AC_SRC_ALPHA };
            Native.UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, Native.ULW_ALPHA);
        }
        finally
        {
            Native.SelectObject(memDc, old);
            Native.DeleteObject(hBmp);
            Native.DeleteDC(memDc);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
        }
        Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) frame?.Dispose();
        base.Dispose(disposing);
    }
}
