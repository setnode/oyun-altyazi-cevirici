using System.Drawing.Imaging;
using System.Globalization;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace XCloudCevirici;

/// <summary>Ekran yakalama + değişiklik algılama + OCR + çeviri.</summary>
sealed class Engine
{
    readonly Settings S;
    OcrEngine ocr;
    public string OcrLanguage { get; private set; } = "";

    // Bağlantı oyun boyunca açık kalsın: her çeviride yeniden HTTPS el sıkışması olmasın
    static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        PooledConnectionIdleTimeout = TimeSpan.FromMinutes(15),
        PooledConnectionLifetime = TimeSpan.FromMinutes(30),
        EnableMultipleHttp2Connections = true,
    })
    { Timeout = TimeSpan.FromSeconds(6), DefaultRequestHeaders = { { "User-Agent", "Mozilla/5.0" } } };
    readonly Dictionary<string, string> cache = new();
    const int CacheMax = 20000; // uzun bir oyunun tüm diyaloglarına yeter

    public Engine(Settings s) { S = s; }

    public bool InitOcr(out string error)
    {
        error = null;
        try
        {
            ocr = OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US"))
               ?? OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-GB"))
               ?? OcrEngine.TryCreateFromUserProfileLanguages();
            if (ocr == null)
            {
                error = "Windows OCR bulunamadı. Ayarlar → Saat ve dil → Dil → İngilizce ekleyin.";
                return false;
            }
            OcrLanguage = ocr.RecognizerLanguage.DisplayName;
            return true;
        }
        catch (Exception e)
        {
            error = "Windows OCR başlatılamadı: " + e.Message;
            return false;
        }
    }

    // ---------------- Yakalama ----------------

    public static Bitmap Capture(Rectangle r)
    {
        var bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.CopyFromScreen(r.Location, Point.Empty, r.Size, CopyPixelOperation.SourceCopy);
        return bmp;
    }

    static byte[] Pixels(Bitmap bmp, out int stride)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            stride = data.Stride;
            var buf = new byte[stride * bmp.Height];
            Marshal.Copy(data.Scan0, buf, 0, buf.Length);
            return buf;
        }
        finally { bmp.UnlockBits(data); }
    }

    static double Lum(byte[] p, int i) => 0.114 * p[i] + 0.587 * p[i + 1] + 0.299 * p[i + 2]; // BGRA
    static int Sat(byte[] p, int i) => Math.Max(p[i], Math.Max(p[i + 1], p[i + 2])) - Math.Min(p[i], Math.Min(p[i + 1], p[i + 2]));
    const int NeutralSat = 15;      // bunun üstündeki doygunluk "renkli" sayılır (altyazı beyazı ≈ 0–10, tekne/tişört beyazı ≈ 15–30)
    public const double MinInk = 0.0008; // bölgede yazı var sayılması için gereken parlak piksel oranı

    // ---------------- Parmak izi (değişti mi?) ----------------

    public sealed class Signature
    {
        public byte[] Values;
        public int Bright;
        public int N;
        public bool Colored; // renksiz yazı yok, renkli parlak yazı var (ör. sarı altyazı)
        /// <summary>Dokulu açık zeminde (çakıl, beton) yalnızca simsiyah kontura değen parlak pikseller; değilse null.</summary>
        public byte[] OValues;
        public int OBright;
    }

    public Signature MakeSignature(Bitmap bmp)
    {
        var p = Pixels(bmp, out int stride);
        int w = bmp.Width, h = bmp.Height;
        var sig = new Signature { Values = new byte[w * h], N = w * h };
        var ovalues = S.BrightText ? new byte[w * h] : null;
        int k = 0, colorBright = 0;
        byte[] lmin = null;
        if (S.BrightText)
        {
            // Yazının hemen yanında koyu gölge/kontur olur: beyaz tekne, beyaz tişört gibi düz
            // parlak yüzeylerin içi yazı sayılmaz — yoksa küçük altyazının gelişi fark edilmez
            var lb = new byte[w * h];
            for (int y = 0, q = 0; y < h; y++)
                for (int x = 0; x < w; x++, q++) lb[q] = (byte)Lum(p, y * stride + x * 4);
            lmin = LocalMin(lb, w, h, 2);
        }
        for (int y = 0; y < h; y++)
        {
            int row = y * stride;
            for (int x = 0; x < w; x++, k++)
            {
                int i = row + x * 4;
                double L = Lum(p, i);
                if (S.BrightText)
                {
                    // Altyazılar neredeyse renksiz beyazdır; beyaz gömlek, ten, ışık gibi
                    // parlak ama renkli sahne nesneleri yazı sayılmaz (1 = renksiz, 2 = renkli)
                    if (L <= S.Threshold || L - lmin[k] < EdgeContrast) continue;
                    if (Sat(p, i) <= NeutralSat)
                    {
                        sig.Values[k] = 1; sig.Bright++;
                        // Simsiyah kontura değen parlak piksel (GTA tarzı yazı): zemin dokusu buna pek girmez
                        if (lmin[k] <= OutlineDark) { ovalues[k] = 1; sig.OBright++; }
                    }
                    else { sig.Values[k] = 2; colorBright++; }
                }
                else sig.Values[k] = (byte)L;
            }
        }
        if (S.BrightText)
        {
            sig.Colored = sig.Bright / (double)sig.N < MinInk && colorBright / (double)sig.N >= MinInk;
            for (int j = 0; j < sig.N; j++)
                sig.Values[j] = (byte)(sig.Colored ? (sig.Values[j] != 0 ? 1 : 0) : (sig.Values[j] == 1 ? 1 : 0));
            if (sig.Colored) sig.Bright += colorBright;
            // Açık renk, dokulu zemin: parlak kenarların çoğu zemindir ve yeni altyazı toplam içinde
            // kaybolur → konturlu pikseller ayrıca izlenir (bkz. Diff)
            // Konturlu yazılı oyunda (GTA) değişim her zaman konturlu piksellerle izlenir: kamera kaydıkça
            // zemin dokusu gevşek farkı sürekli yüksek tutuyor, okuma boşuna zorlanıyordu
            else if (sig.Bright / (double)sig.N >= Textured || OutlineGame) sig.OValues = ovalues;
        }
        return sig;
    }

    const int EdgeContrast = 60; // yazı pikseli ile yanındaki gölge arasındaki en az parlaklık farkı
    const int OutlineDark = 45;  // yazı konturu sayılacak kadar koyu komşu
    const double Textured = 0.025; // bölgenin bu kadarı parlak kenarsa zemin dokulu sayılır (yazı tek başına ≈ %1–2)

    /// <summary>r yarıçaplı kare komşulukta en koyu değer (önce yatay, sonra dikey).</summary>
    static byte[] LocalMin(byte[] src, int w, int h, int r)
    {
        var tmp = new byte[src.Length]; var outp = new byte[src.Length];
        for (int y = 0; y < h; y++)
        {
            int o = y * w;
            for (int x = 0; x < w; x++)
            {
                byte m = 255;
                for (int xx = Math.Max(0, x - r), e = Math.Min(w - 1, x + r); xx <= e; xx++) if (src[o + xx] < m) m = src[o + xx];
                tmp[o + x] = m;
            }
        }
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                byte m = 255;
                for (int yy = Math.Max(0, y - r), e = Math.Min(h - 1, y + r); yy <= e; yy++) if (tmp[yy * w + x] < m) m = tmp[yy * w + x];
                outp[y * w + x] = m;
            }
        return outp;
    }

    public double Diff(Signature a, Signature b)
    {
        if (a == null || b == null || a.N != b.N) return double.PositiveInfinity;
        long s = 0;
        if (S.BrightText)
        {
            for (int i = 0; i < a.N; i++) if (a.Values[i] != b.Values[i]) s++;
            double dl = s * 100.0 / Math.Max(Math.Max(a.Bright, b.Bright), 20);
            if (a.OValues == null || b.OValues == null) return dl;
            // Dokulu zeminde yalnızca konturlu yazı piksellerine bakılır: kamera hareket ettikçe zemin
            // dokusu sürekli "değişiyor" görünür ve okuma boşuna bekler
            long o = 0;
            for (int i = 0; i < a.N; i++) if (a.OValues[i] != b.OValues[i]) o++;
            return o * 100.0 / Math.Max(Math.Max(a.OBright, b.OBright), 20);
        }
        for (int i = 0; i < a.N; i++) s += Math.Abs(a.Values[i] - b.Values[i]);
        return (double)s / a.N;
    }

    /// <summary>a'daki yazı piksellerinin yüzde kaçı b'de hâlâ yanıyor (konturlu oyunda konturlu pikseller).</summary>
    public static double KeptInk(Signature a, Signature b)
    {
        if (a == null || b == null || a.N != b.N) return 0;
        bool useO = a.OValues != null && b.OValues != null;
        var A = useO ? a.OValues : a.Values; var B = useO ? b.OValues : b.Values;
        int ink = 0, kept = 0;
        for (int i = 0; i < a.N; i++) if (A[i] != 0) { ink++; if (B[i] != 0) kept++; }
        return ink < 20 ? 0 : kept / (double)ink;
    }

    // ---------------- OCR öncesi görüntü işleme ----------------

    /// <summary>Son OCR görüntüsü: gri piksel + canlı renkli pikseller (renkli kelime kurtarma için).</summary>
    public sealed class PrepInfo { public int W, H, Pad; public double Scale; public byte[] Gray, Vivid; public bool Outline; }
    /// <summary>Son okuma kontur modunda mı yapıldı (silme maskesi de buna göre çalışır).</summary>
    public bool LastOutline { get; private set; }
    /// <summary>Son okuma zayıf mı (sözlükte olmayan kelimeler, düşük güven).</summary>
    public bool LastWeak { get; private set; }
    public PrepInfo LastPrep { get; private set; }

    /// <summary>
    /// GTA tarzı konturlu yazı: siyah konturla çevrili parlak bölgeler harftir. Piksel piksel parlaklık eşiği
    /// açık zeminde işe yaramıyor (çakıl, harf dolgusuyla aynı parlaklıkta); parlak bölgeler bütün olarak
    /// sınıflandırılır: kenarının neredeyse tamamı simsiyah kontura değmeli (çakılın kenarı gri gölgedir),
    /// satır yüksekliğini aşmamalı, renkli olmamalı ve başka bir harfin içinde kalmamalı ("o"/"c" içindeki
    /// çakıl → yoksa "o" "e" okunur: "too"→"tee"). Dönen dizide 1 = yazı; Near: kontura uzaklık için.
    /// </summary>
    static (byte[] Mask, byte[] Near) OutlineText(byte[] p, int stride, int W, int H, int screenH, double scale)
    {
        int N = W * H;
        var L = new byte[N]; var col = new byte[N];
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++)
        {
            int i = y * stride + x * 4, k = y * W + x;
            L[k] = (byte)Lum(p, i); col[k] = (byte)(Sat(p, i) > 25 ? 1 : 0);
        }
        var near = LocalMin(L, W, H, 3);
        const int BAR = 150, TD = 45;
        int maxH = (int)Math.Round(0.048 * screenH * scale);
        var lab = new int[N]; Array.Fill(lab, -1);
        var st = new int[N];
        var C = new List<(int n, bool ok, int x0, int x1, int y0, int y1)>();
        for (int s0 = 0; s0 < N; s0++)
        {
            if (lab[s0] >= 0 || L[s0] < BAR) continue;
            int id = C.Count, sp = 0, n = 0, pe = 0, pn = 0, nc = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
            long sum = 0;
            st[sp++] = s0; lab[s0] = id;
            while (sp > 0)
            {
                int q0 = st[--sp], x = q0 % W, y = q0 / W;
                n++; sum += L[q0]; nc += col[q0];
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
                bool edge = false;
                void Visit(int q) { if (L[q] < BAR) edge = true; else if (lab[q] < 0) { lab[q] = id; st[sp++] = q; } }
                if (x > 0) Visit(q0 - 1);
                if (x < W - 1) Visit(q0 + 1);
                if (y > 0) Visit(q0 - W);
                if (y < H - 1) Visit(q0 + W);
                if (edge) { pe++; if (near[q0] <= TD) pn++; }
            }
            bool ok = n >= 4 && y1 - y0 < maxH && x1 - x0 < maxH * 4 && pe > 0 && pn >= pe * 0.85 && nc < n * 0.3 && sum >= n * 170L;
            C.Add((n, ok, x0, x1, y0, y1));
        }
        // Harfin içindeki bölge: daha büyük bir harfin kutusunun içinde, üst/alt kenarına değmeden
        var ids = Enumerable.Range(0, C.Count).Where(i => C[i].ok).OrderBy(i => C[i].x0).ToList();
        var inner = new bool[C.Count];
        foreach (int a in ids)
        {
            var A = C[a];
            foreach (int b in ids)
            {
                var B = C[b];
                if (B.x0 > A.x0) break;
                if (a != b && B.n > A.n && (A.x0 + A.x1) / 2.0 < B.x1 && B.y0 < A.y0 - 1 && B.y1 > A.y1 + 1) { inner[a] = true; break; }
            }
        }
        var mask = new byte[N];
        for (int k = 0; k < N; k++) { int id = lab[k]; if (id >= 0 && C[id].ok && !inner[id]) mask[k] = 1; }
        return (mask, near);
    }

    public Bitmap Preprocess(Bitmap src, bool colored = false, bool outline = false, int screenH = 1080, double mul = 1)
    {
        // Windows OCR ~25–40 px yazıda en iyisi; ince altyazılar için biraz büyüt (fazlası yavaşlatır).
        // mul: zayıf okumada farklı ölçekle tekrar denemek için
        double scale = Math.Clamp(2200.0 / src.Width, 1.25, 2.5) * mul;
        int W = (int)(src.Width * scale), H = (int)(src.Height * scale), PAD = 12;
        var big = new Bitmap(W, H, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(big))
        {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.DrawImage(src, new Rectangle(0, 0, W, H));
        }
        var data = big.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        var p = new byte[data.Stride * H];
        Marshal.Copy(data.Scan0, p, 0, p.Length);

        LastPrep = null;
        if (S.BrightText)
        {
            // Yumuşak eşik: ince harflerin kenarları korunur → beyaz zeminde siyah yazı
            var G = outline && !colored ? OutlineText(p, data.Stride, W, H, screenH, scale) : ((byte[] Mask, byte[] Near)?)null;
            double lo = S.Threshold - 65, span = 80;
            var gray = new byte[W * H];
            var vivid = new byte[W * H];
            int nv = 0;
            for (int y = 0; y < H; y++)
            {
                for (int x = 0; x < W; x++)
                {
                    int i = y * data.Stride + x * 4, k = y * W + x;
                    double c = 255 - (Lum(p, i) - lo) * 255 / span;
                    if (!colored)
                    {
                        // Renkli parlak pikselleri (gömlek, ten, ışık) arka plana it
                        int sat = Sat(p, i);
                        if (sat > NeutralSat) c += (255 - Math.Clamp(c, 0, 255)) * Math.Min(1.0, (sat - NeutralSat) / 15.0);
                        // Canlı renkli parlak piksel: görev hedefindeki renkli kelime olabilir ("Follow Moses")
                        // (konturlu oyunda yalnızca kontura yakın olanlar: çakıldaki kırmızı taşlar kelime sanılmasın)
                        if (sat >= 60 && Math.Max(p[i], Math.Max(p[i + 1], p[i + 2])) >= 170 && (G == null || G.Value.Near[k] <= 45)) { vivid[k] = 1; nv++; }
                    }
                    if (G != null) c = G.Value.Mask[k] != 0 ? 0 : 255;
                    byte v = (byte)Math.Clamp(c, 0, 255);
                    p[i] = p[i + 1] = p[i + 2] = gray[k] = v; p[i + 3] = 255;
                }
            }
            LastPrep = new PrepInfo { W = W, H = H, Pad = PAD, Scale = scale, Gray = gray, Vivid = nv > 0 ? vivid : null, Outline = G != null };
        }
        else
        {
            double min = 255, max = 0, sum = 0; int n = 0;
            for (int i = 0; i < p.Length; i += 4) { double L = Lum(p, i); min = Math.Min(min, L); max = Math.Max(max, L); sum += L; n++; }
            bool darkBg = sum / n < (min + max) / 2;
            double range = Math.Max(1, max - min);
            for (int i = 0; i < p.Length; i += 4)
            {
                double c = (Lum(p, i) - min) / range * 255;
                if (darkBg) c = 255 - c;
                byte v = (byte)Math.Clamp(c, 0, 255);
                p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255;
            }
        }
        Marshal.Copy(p, 0, data.Scan0, p.Length);
        big.UnlockBits(data);

        var padded = new Bitmap(W + PAD * 2, H + PAD * 2, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(padded))
        {
            g.Clear(Color.White);
            g.DrawImageUnscaled(big, PAD, PAD);
        }
        big.Dispose();
        return padded;
    }

    // ---------------- OCR ----------------

    public sealed class OcrW { public string Text; public RectangleF R; }
    public sealed class OcrLine { public string Text; public List<OcrW> Words; public double Top, Bottom, X0, X1; }

    /// <summary>Ekrandaki bir yazı bloğu (diyalog, görev hedefi…): metin + ekran konumu.</summary>
    public sealed class TextBlock { public string Text; public RectangleF Box; public float Glyph; public bool Outline; }
    public sealed class ReadResult { public string Text = ""; public List<TextBlock> Blocks = new(); }

    /// <summary>Windows OCR'ı çalıştırır; kelimeleri görüntü pikseli konumlarıyla döndürür.</summary>
    async Task<List<List<OcrW>>> RawOcrAsync(Bitmap bmp)
    {
        var result = new List<List<OcrW>>();
        if (ocr == null) return result;
        // Windows OCR'ın sınırını aşma
        Bitmap use = bmp;
        double k = 1;
        int max = (int)OcrEngine.MaxImageDimension;
        if (bmp.Width > max || bmp.Height > max)
        {
            k = Math.Min((double)max / bmp.Width, (double)max / bmp.Height);
            use = new Bitmap(bmp, new Size((int)(bmp.Width * k), (int)(bmp.Height * k)));
        }
        try
        {
            // PNG'ye çevirmeden doğrudan piksellerden SoftwareBitmap (daha hızlı)
            var px = Pixels(use, out int stride);
            if (stride != use.Width * 4) throw new InvalidOperationException("Beklenmeyen satır genişliği");
            var writer = new DataWriter();
            writer.WriteBytes(px);
            IBuffer buffer = writer.DetachBuffer();
            using var sb = SoftwareBitmap.CreateCopyFromBuffer(buffer, BitmapPixelFormat.Bgra8, use.Width, use.Height, BitmapAlphaMode.Premultiplied);
            var r = await ocr.RecognizeAsync(sb);
            foreach (var line in r.Lines)
                result.Add(line.Words.Select(w => new OcrW
                {
                    Text = w.Text,
                    R = new RectangleF((float)(w.BoundingRect.X / k), (float)(w.BoundingRect.Y / k), (float)(w.BoundingRect.Width / k), (float)(w.BoundingRect.Height / k)),
                }).ToList());
            return result;
        }
        finally
        {
            if (!ReferenceEquals(use, bmp)) use.Dispose();
        }
    }

    /// <summary>OCR + kelime düzeyinde eleme. hRef: tipik harf yüksekliği (görüntü pikseli).</summary>
    async Task<(List<OcrLine> Lines, double HRef)> RecognizeLinesAsync(Bitmap bmp) => FilterLines(await RawOcrAsync(bmp));

    /// <summary>OCR sonucunun ne kadar gerçek İngilizce olduğu: sözlükteki harfler artı, uydurma kelimeler eksi.</summary>
    static (double Score, bool Ok) Quality(List<List<OcrW>> raw)
    {
        double good = 0, bad = 0;
        foreach (var w in raw.SelectMany(l => l))
        {
            int n = w.Text.Count(char.IsLetter);
            if (n < 2) continue;
            var (known, _) = WordDict.Info(w.Text);
            if (known == false) bad += n; else good += n;
        }
        return (good - bad, good >= 6 && good >= (good + bad) * 0.85);
    }

    int outlinePref; // >0: önce kontur modu (GTA), <0: önce düz mod
    /// Kontur modu üst üste iyi okuduysa oyun konturlu yazı kullanıyor (GTA): bundan sonra yalnızca konturlu
    /// okuma yapılır. Düz okuma çakıl/beton zeminde 2–5 sn sürüyor ve bu sırada gelen satırlar kaçıyordu.
    public bool OutlineGame { get; private set; }
    int outlineHits;
    void NoteOutline(bool ok) { if (OutlineGame) return; outlineHits = ok ? outlineHits + 1 : 0; if (outlineHits >= 3) OutlineGame = true; }

    (List<OcrLine> Lines, double HRef) FilterLines(List<List<OcrW>> raw)
    {
        var lines = new List<OcrLine>();
        // Kelime düzeyinde eleme: sahnedeki parlak nesnelerden çıkan "kelimeler" gerçek
        // harflerden çok daha büyük/küçüktür ya da cümleden kopuk durur
        var words = raw.SelectMany(l => l).ToList();
        var anchors = words.Where(w => w.Text.Count(char.IsLetter) >= 3).Select(w => (double)w.R.Height).OrderBy(h => h).ToList();
        // "No.", "Ow!" gibi kısa altyazılarda 3 harfli kelime olmayabilir
        if (anchors.Count == 0) anchors = words.Where(w => w.Text.Any(char.IsLetter)).Select(w => (double)w.R.Height).OrderBy(h => h).ToList();
        if (anchors.Count == 0) return (lines, 0);
        double hRef = anchors[anchors.Count / 2];
        foreach (var line in raw)
        {
            int junk = 0; // sözlükte olmadığı için atılan harf sayısı
            var ws = line.Select(w =>
            {
                var (known, fix) = WordDict.Info(w.Text);
                return (W: w, Text: fix ?? w.Text, Known: known);
            }).Where(x =>
            {
                double h = x.W.R.Height;
                int n = x.Text.Count(char.IsLetter);
                if (h > hRef * 1.6) return false;              // dev leke
                if (n >= 2 && h < hRef * 0.45) return false;   // ufak kırıntı
                // Sözlükte olmayan uzun küçük harfli ya da içi karışık kelime: "fuekingiloeer", "thatAndiew"
                // (büyük harfle başlayan bilinmeyen kelimeler isimdir: "Bennie", "Leonida")
                if (x.Known == false && ((n >= 7 && !x.Text.Any(char.IsUpper)) || MixedJunk.IsMatch(x.Text))) { junk += n; return false; }
                return true;
            }).ToList();
            double gap = hRef * 2.2;
            static bool Strong(OcrW w) => w.Text.Count(char.IsLetter) >= 3;
            while (ws.Count > 1 && ws[1].W.R.Left - ws[0].W.R.Right > gap && !Strong(ws[0].W)) ws.RemoveAt(0);
            while (ws.Count > 1 && ws[^1].W.R.Left - ws[^2].W.R.Right > gap && !Strong(ws[^1].W)) ws.RemoveAt(ws.Count - 1);
            if (ws.Count == 0) continue;
            // Satırda en az bir gerçek boyda kelime olmalı
            var core = ws.Where(x => x.W.R.Height >= hRef * 0.6 && x.Text.Count(char.IsLetter) >= 2).ToList();
            if (core.Count == 0) continue;
            // Satırın çoğu saçma çıktıysa geri kalan kırıntı da güvenilmez
            if (junk > ws.Sum(x => x.Text.Count(char.IsLetter))) continue;
            lines.Add(new OcrLine
            {
                Text = string.Join(" ", ws.Select(x => x.Text)),
                Words = ws.Select(x => new OcrW { Text = x.Text, R = x.W.R }).ToList(),
                Top = core.Min(x => x.W.R.Top), Bottom = core.Max(x => x.W.R.Bottom),
                X0 = ws.Min(x => x.W.R.Left), X1 = ws.Max(x => x.W.R.Right),
            });
        }
        lines.Sort((a, b) => a.Top.CompareTo(b.Top));
        return (lines, hRef);
    }

    /// <summary>
    /// Renkli kelime kurtarma: OCR öncesi renkli pikseller bilerek arka plan sayılır (gömlek, ışık…).
    /// Ama oyunlar görev hedefindeki isimleri renkli yazar ("Follow Moses"). Okunan bir satırın
    /// hizasında canlı renk varsa yalnızca o şerit renkler dahil tekrar okunur; yeni kelime ancak
    /// sözlükte varsa eklenir — diğer satırlar hiç etkilenmez.
    /// </summary>
    async Task RecoverColoredAsync(List<OcrLine> lines, double h)
    {
        var P = LastPrep;
        if (P?.Vivid == null || h <= 0) return;
        foreach (var L in lines)
        {
            int y0 = Math.Max(0, (int)(L.Top - P.Pad - h * 0.35)), y1 = Math.Min(P.H, (int)(L.Bottom - P.Pad + h * 0.35));
            int x0 = Math.Max(0, (int)(L.X0 - P.Pad - h * 8)), x1 = Math.Min(P.W, (int)(L.X1 - P.Pad + h * 8));
            if (y1 - y0 < 4 || x1 - x0 < 4) continue;
            int nv = 0;
            for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) nv += P.Vivid[y * P.W + x];
            if (nv < h * h * 0.25) continue;
            const int pad = 12;
            int sw = x1 - x0, sh = y1 - y0;
            using var strip = new Bitmap(sw + pad * 2, sh + pad * 2, PixelFormat.Format32bppArgb);
            var data = strip.LockBits(new Rectangle(0, 0, strip.Width, strip.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            var buf = new byte[data.Stride * strip.Height];
            for (int y = 0; y < strip.Height; y++)
                for (int x = 0; x < strip.Width; x++)
                {
                    int i = y * data.Stride + x * 4;
                    byte v = 255;
                    int sy = y - pad + y0, sx = x - pad + x0;
                    if (sy >= y0 && sy < y1 && sx >= x0 && sx < x1) { int k = sy * P.W + sx; v = P.Vivid[k] != 0 ? (byte)0 : P.Gray[k]; }
                    buf[i] = buf[i + 1] = buf[i + 2] = v; buf[i + 3] = 255;
                }
            Marshal.Copy(buf, 0, data.Scan0, buf.Length);
            strip.UnlockBits(data);

            List<List<OcrW>> raw;
            try { raw = await RawOcrAsync(strip); } catch { continue; }
            float dx = x0 - pad + P.Pad, dy = y0 - pad + P.Pad;
            var w2 = raw.SelectMany(l => l).Select(w =>
            {
                var (_, fix) = WordDict.Info(w.Text);
                return new OcrW { Text = fix ?? w.Text, R = new RectangleF(w.R.X + dx, w.R.Y + dy, w.R.Width, w.R.Height) };
            }).ToList();
            // Eski kelimelerin hepsi yeni okumada (aynı sırayla) olmalı; yoksa ikinci okuma daha kötü
            int j = 0; bool ok = true; var used = new HashSet<int>();
            foreach (var w in L.Words)
            {
                if (w.Text.Count(char.IsLetter) < 2) continue;
                while (j < w2.Count && Norm(w2[j].Text) != Norm(w.Text)) j++;
                if (j >= w2.Count) { ok = false; break; }
                used.Add(j++);
            }
            if (!ok) continue;
            static bool Ust(OcrW o, OcrW w) => Math.Min(o.R.Right, w.R.Right) - Math.Max(o.R.Left, w.R.Left) > 0.3 * Math.Min(o.R.Width, w.R.Width);
            var cand = w2.Where((w, i) =>
            {
                if (used.Contains(i)) return false;
                int n = w.Text.Count(char.IsLetter);
                if (n < 2 || WordDict.Info(w.Text).Known != true || w.R.Height < h * 0.6 || w.R.Height > h * 1.6) return false;
                // Eski bir kelimenin üstüne binmemeli
                return !L.Words.Any(o => Ust(o, w));
            }).ToList();
            // Satırın hemen yanında olmalı. Zincirleme: renkli ikinci kelime ilkinin yanındadır
            // ("Get on the dirt bike", "Handle the security guard" — "bike"/"guard" atılıyordu)
            var added = new List<OcrW>();
            double ax0 = L.X0, ax1 = L.X1;
            for (bool more = true; more;)
            {
                more = false;
                foreach (var w in cand)
                {
                    if (added.Contains(w) || w.R.Right < ax0 - h * 3 || w.R.Left > ax1 + h * 3 || added.Any(o => Ust(o, w))) continue;
                    added.Add(w); ax0 = Math.Min(ax0, w.R.Left); ax1 = Math.Max(ax1, w.R.Right); more = true;
                }
            }
            if (added.Count == 0) continue;
            L.Words = L.Words.Concat(added).OrderBy(w => w.R.Left).ToList();
            L.Text = string.Join(" ", L.Words.Select(w => w.Text));
            L.X0 = Math.Min(L.X0, added.Min(w => w.R.Left));
            L.X1 = Math.Max(L.X1, added.Max(w => w.R.Right));
        }
    }

    static bool IsCaps(string t)
    {
        int letters = 0, upper = 0;
        foreach (char c in t) if (char.IsLetter(c)) { letters++; if (char.IsUpper(c)) upper++; }
        return letters >= 3 && upper >= letters * 0.8;
    }
    public static bool IsCapsText(string t) => IsCaps(t);

    /// <summary>
    /// Bölgeyi okur: satırları aralarındaki boşluğa göre bloklara ayırır (diyalog / görev hedefi /
    /// silah bildirimi), her bloğu ayrı temizler ve ekrandaki konumunu verir.
    /// </summary>
    public async Task<ReadResult> ReadAsync(Bitmap shot, bool colored, Rectangle region, bool textured = false, bool forced = false)
    {
        var res = new ReadResult();
        int screenH = System.Windows.Forms.Screen.FromRectangle(region).Bounds.Height;
        // Dokulu açık zemin (çakıl, beton): düz okuma çöp üretir ve yavaştır → önce konturlu okuma
        bool first = S.BrightText && !colored && (outlinePref > 0 || textured);
        var pre = Preprocess(shot, colored, first, screenH);
        var raw = await RawOcrAsync(pre);
        // Okuma zayıfsa diğer yolu dene (açık renk zeminde konturlu yazı / konturu olmayan oyun)
        if (S.BrightText && !colored)
        {
            var q = Quality(raw);
            if (first && q.Ok) NoteOutline(true);
            // Dokulu zeminde konturlu okuma bir şey bulduysa, konturlu oyunda ya da geçiş anında düz okumayı deneme
            if (!q.Ok && !OutlineGame && !forced && !(textured && first && q.Score >= 3))
            {
                var keepPrep = LastPrep;
                var pre2 = Preprocess(shot, colored, !first, screenH);
                var raw2 = await RawOcrAsync(pre2);
                var q2 = Quality(raw2);
                if (q2.Score > q.Score + 3)
                {
                    pre.Dispose(); pre = pre2; raw = raw2;
                    if (first && q2.Ok) NoteOutline(false);
                    outlinePref = Math.Clamp(outlinePref + (first ? -1 : 1), -3, 3);
                }
                else
                {
                    pre2.Dispose(); LastPrep = keepPrep;
                    if (q.Score > 3) outlinePref = Math.Clamp(outlinePref + (first ? 1 : -1), -3, 3);
                }
            }
        }
        // Hâlâ zayıfsa aynı yolu biraz daha büyük ölçekle dene: OCR hataları ölçeğe göre değişir; en iyisi seçilir
        // (geçiş anındaki zorunlu okumada ve hiç yazı yokken yapılmaz: kare yarım, durulunca yeniden okunur)
        var qf = Quality(raw);
        if (!qf.Ok && !forced && qf.Score >= 3)
        {
            var keepPrep = LastPrep;
            var pre3 = Preprocess(shot, colored, keepPrep?.Outline == true, screenH, 1.35);
            var raw3 = await RawOcrAsync(pre3);
            var q3 = Quality(raw3);
            if (q3.Score > qf.Score) { pre.Dispose(); pre = pre3; raw = raw3; qf = q3; }
            else { pre3.Dispose(); LastPrep = keepPrep; }
        }
        LastWeak = !qf.Ok && qf.Score < 15;
        LastOutline = S.BrightText && !colored && LastPrep?.Outline == true;
        using var preUse = pre;
        var (lines, hRef) = FilterLines(raw);
        if (lines.Count == 0) return res;
        await RecoverColoredAsync(lines, hRef);

        var groups = new List<List<OcrLine>>();
        foreach (var l in lines)
        {
            if (groups.Count == 0 || l.Top - groups[^1][^1].Bottom > hRef * 0.9) groups.Add(new List<OcrLine>());
            groups[^1].Add(l);
        }
        int pad = LastPrep?.Pad ?? 12;
        double scale = LastPrep?.Scale ?? (preUse.Width - 24) / (double)Math.Max(1, shot.Width);
        foreach (var g in groups)
        {
            string t = Clean(string.Join("\n", g.Select(l => l.Text)));
            if (t.Length == 0) continue;
            float X(double x) => (float)(region.X + (x - pad) / scale);
            float Y(double y) => (float)(region.Y + (y - pad) / scale);
            double x0 = g.Min(l => l.X0), x1 = g.Max(l => l.X1), top = g.Min(l => l.Top), bottom = g.Max(l => l.Bottom);
            res.Blocks.Add(new TextBlock
            {
                Text = t,
                Box = RectangleF.FromLTRB(X(x0), Y(top), X(x1), Y(bottom)),
                Glyph = (float)(hRef / scale),
                Outline = LastOutline,
            });
        }
        // TAMAMI BÜYÜK HARF blok, yanında normal yazılı altyazı varsa oyun arayüzüdür (silah, ödül, menü)
        if (res.Blocks.Any(b => !IsCaps(b.Text))) res.Blocks.RemoveAll(b => IsCaps(b.Text));
        // Altyazılar ortalıdır: ana yazıdan yatayda uzak duran küçük blok arayüzdür (harita, sayaç…)
        var main = res.Blocks.OrderByDescending(b => b.Text.Count(char.IsLetter)).FirstOrDefault();
        if (main != null)
        {
            float mc = main.Box.Left + main.Box.Width / 2, tol = Math.Max(main.Box.Width * 0.6f, main.Glyph * 6);
            res.Blocks.RemoveAll(b => b != main && Math.Abs(b.Box.Left + b.Box.Width / 2 - mc) > tol);
        }
        res.Text = string.Join("\n", res.Blocks.Select(b => b.Text));
        return res;
    }

    // Küçük harften sonra büyük harf ya da harf/rakam karışımı: OCR uydurması
    static readonly Regex MixedJunk = new(@"\p{Ll}\p{Lu}|\d\p{L}|\p{L}\d", RegexOptions.Compiled);

    // ---------------- Metin temizleme ----------------

    static readonly Regex Junk = new(@"[|_~`^{}\[\]<>\\@#*]+", RegexOptions.Compiled);
    static readonly Regex LoneI = new(@"(^|\s)[|!l1](?=\s+\p{Ll})", RegexOptions.Compiled);
    static readonly Regex Spaces = new(@"\s+", RegexOptions.Compiled);
    static readonly Regex SpaceBeforePunct = new(@"\s+([,.!?;:])", RegexOptions.Compiled);
    static readonly Regex TrailingCrumb = new(@"([.?!…""'”])\s+[^\s\p{L}]*(\p{Lu}{1,2}|\p{L})?[^\s\p{L}.?!]*$", RegexOptions.Compiled);
    static readonly Regex LeadingCrumb = new(@"^[^\s\p{L}\p{N}""'“(]{1,3}\s+", RegexOptions.Compiled);

    public static string Clean(string raw)
    {
        var lines = raw.Split('\n')
            .Select(l => Spaces.Replace(Junk.Replace(LoneI.Replace(l, "$1I"), " "), " ").Trim())
            .Where(l =>
            {
                int letters = l.Count(char.IsLetter);
                return l.Length >= 2 && letters >= 2 && letters / (double)l.Length >= 0.55;
            })
            .ToList();
        var sb = new StringBuilder();
        foreach (var line in lines)
        {
            if (sb.Length == 0) { sb.Append(line); continue; }
            if (char.IsLower(line[0]))
            {
                // "...told me..." + "to ask you" → tek cümle
                while (sb.Length > 0 && (sb[^1] == '.' || sb[^1] == '…')) sb.Length--;
            }
            sb.Append(' ').Append(line);
        }
        string result = SpaceBeforePunct.Replace(sb.ToString(), "$1").Trim();
        // Cümle bittikten sonra kalan tek harflik kırıntıyı at ("aren't you? I)" → "aren't you?")
        // — sahnedeki saat, ışık gibi parlak noktalardan gelir
        result = TrailingCrumb.Replace(result, "$1");
        // Baştaki harfsiz kırıntıyı at (") Hello" → "Hello")
        result = LeadingCrumb.Replace(result, "");
        return LooksLikeSentence(result) ? result : "";
    }

    /// <summary>Gerçek bir altyazı mı, yoksa sahnedeki doku/çizgilerden çıkan anlamsız harfler mi?</summary>
    static bool LooksLikeSentence(string t)
    {
        if (t.Length < 3) return false;
        var words = t.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        int letters = t.Count(char.IsLetter);
        int nonSpace = t.Count(c => !char.IsWhiteSpace(c));
        if (letters < 4 || letters / (double)nonSpace < 0.7) return false;
        // En az bir gerçek kelime (3+ harf) olmalı
        if (!words.Any(w => w.Count(char.IsLetter) >= 3)) return false;
        // Tek harflik parçalar çoğunluktaysa (I, a hariç) çöp okumadır
        int junk = words.Count(w => w.Count(char.IsLetter) <= 1 && w != "I" && w != "a" && w != "A");
        if (words.Length >= 3 && junk / (double)words.Length > 0.35) return false;
        // Sesli harf içermeyen uzun "kelimeler" (ör. "rnnkt") çöp işaretidir
        int vowelless = words.Count(w => w.Count(char.IsLetter) >= 4 && !w.Any(c => "aeıioöuüAEIİOÖUÜyY".IndexOf(c) >= 0));
        if (vowelless > Math.Max(1, words.Length / 3)) return false;
        return true;
    }

    static string Norm(string t) =>
        new string(t.ToLower(CultureInfo.InvariantCulture).Where(char.IsLetterOrDigit).ToArray());

    static readonly Regex WordSplit = new(@"[^\p{L}\p{N}']+", RegexOptions.Compiled);

    /// <summary>Yeni okumanın kelimelerinin çoğu önceki altyazıda varsa (sahne değişirken tekrar okuma) aynı altyazıdır.</summary>
    public static bool SameSubtitle(string a, string b)
    {
        if (string.IsNullOrEmpty(b)) return false;
        string[] Words(string t) => WordSplit.Split(t.ToLowerInvariant()).Where(w => w.Length >= 2).ToArray();
        var wa = Words(a); var wb = new HashSet<string>(Words(b));
        if (wa.Length < 3 || wa.Length > wb.Count) return false; // kısa tekrarlar gerçek altyazı olabilir
        return wa.Count(wb.Contains) / (double)wa.Length >= 0.75;
    }

    // Sözlükteki (ya da büyük harfli isim) 2+ harfli kelime sayısı: OCR kırıntısı ("x", "lI") sayılmaz, okuma gidip gelmesin
    public static int WordCount(string t) => string.IsNullOrEmpty(t) ? 0 : Regex.Matches(t, @"\p{L}[\p{L}']+").Count(m => char.IsUpper(m.Value[0]) || WordDict.Info(m.Value).Known != false);

    public static bool Similar(string a, string b)
    {
        a = Norm(a); b = Norm(b);
        if (a.Length == 0 || b.Length == 0) return false;
        if (a == b) return true;
        int m = a.Length, n = b.Length;
        if (Math.Abs(m - n) > Math.Max(m, n) * 0.2) return false;
        var prev = new int[n + 1]; var cur = new int[n + 1];
        for (int j = 0; j <= n; j++) prev[j] = j;
        for (int i = 1; i <= m; i++)
        {
            cur[0] = i;
            for (int j = 1; j <= n; j++)
                cur[j] = Math.Min(Math.Min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            (prev, cur) = (cur, prev);
        }
        return prev[n] / (double)Math.Max(m, n) < 0.15;
    }

    // ---------------- Çeviri ----------------

    /// <summary>HTTPS bağlantısını önceden kur (ilk çevirideki ~300 ms'lik el sıkışmayı oyundan önce öde).</summary>
    public async Task WarmUpAsync()
    {
        try { await TranslateAsync("Hello"); } catch { /* internet yoksa sessiz geç */ }
    }

    // TAMAMI BÜYÜK HARF altyazılar çeviride bozulur ("GET OFF MAN." → "DEFİN ADAM.")
    // → çeviriye cümle düzeninde gönder ("Get off man." → "Defol dostum.")
    static readonly Regex SentenceStart = new(@"(^|[.!?…:]\s+|[""“(]\s*)(\p{L})", RegexOptions.Compiled);
    static readonly Regex LowerI = new(@"\bi\b", RegexOptions.Compiled);

    // OCR kesme işaretini kaçırırsa ("You ve just", "Youve", "don t") Google kelimeleri çevirmeden bırakır
    // → kısaltmayı onar. Yalnız zamir/yardımcı fiil kökleriyle ("were", "its", "ill" bozulmaz)
    const string KisaltAra = @"(?:\s*[`´‘’'""]\s*|\s+)";
    static readonly (Regex Re, string To)[] Kisalt =
    {
        (new Regex(@"\b(I|you|we|they|who|would|could|should|might|must)" + KisaltAra + @"(ve)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(you|we|they|who|what)" + KisaltAra + @"(re)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(I|you|we|they|he|she|it|that|there|who)" + KisaltAra + @"(ll)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(I)" + KisaltAra + @"(m)\b"), "$1'$2"),
        (new Regex(@"\b(I|you|we|they|he|she)" + KisaltAra + @"(d)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(it|that|what|there|here|he|she|who|let)" + KisaltAra + @"(s)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(don|doesn|didn|isn|aren|wasn|weren|haven|hasn|hadn|won|wouldn|couldn|shouldn|can|ain|mustn|needn)" + KisaltAra + @"(t)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(you|they)(ve|re)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(we)(ve)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(you|they|it|that)(ll)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(I)(ve|m)\b"), "$1'$2"),
        (new Regex(@"\b(could|would|should)(ve)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(that|what|there)(s)\b", RegexOptions.IgnoreCase), "$1'$2"),
        (new Regex(@"\b(don|doesn|didn|isn|aren|wasn|haven|hasn|hadn|couldn|wouldn|shouldn|won)(t)\b", RegexOptions.IgnoreCase), "$1'$2"),
    };
    public static string KisaltmaOnar(string text)
    {
        foreach (var (re, to) in Kisalt) text = re.Replace(text, to);
        return text;
    }

    public static string PrepForTranslation(string text)
    {
        text = KisaltmaOnar(text);
        int letters = 0, upper = 0;
        foreach (char c in text)
            if (char.IsLetter(c)) { letters++; if (char.IsUpper(c)) upper++; }
        if (letters < 4 || upper < letters * 0.8) return text;
        string t = text.ToLower(CultureInfo.InvariantCulture);
        t = SentenceStart.Replace(t, m => m.Groups[1].Value + m.Groups[2].Value.ToUpper(CultureInfo.InvariantCulture));
        return LowerI.Replace(t, "I");
    }

    // ---------------- Oyun sözlüğü (sozluk.js, Chrome eklentisiyle ortak) ----------------

    static readonly Dictionary<string, string> Kisa = new();
    static readonly List<(Regex Re, string To)> Argo = new();
    // Çevrilmeyecek oyun adları ("Los Santos Customs", "Port Gellhorn") ve çeviri sonrası Türkçe düzeltmeler
    static readonly List<(string Name, Regex Re)> YerAdlari = new();
    static readonly List<(Regex Re, string To)> Duzelt = new();
    // Görev hedefi mi? Diyalogun altında boşlukla ayrı duran son blok görev hedefidir ("…worth my time." /
    // "Follow Moses"). Tek başına duran blok: emir kipiyle başlıyor, kısa ve kişi zamiri yoksa hedef sayılır.
    static readonly Regex ObjVerb = new(
        "^(go|head|drive|get|follow|tail|chase|find|locate|lose|evade|escape|collect|pick|grab|take|" +
        "deliver|steal|park|return|reach|enter|leave|buy|purchase|change|land|fly|shoot|kill|destroy|defend|protect|rescue|" +
        "meet|talk|speak|call|text|answer|use|hide|search|investigate|stay|avoid|survive|hack|climb|swim|ride|board|" +
        "place|plant|stow|bring|load|unload|tow|catch|wake|drop|select|equip|eliminate|defeat|clear|exit|inspect|sell|rob|" +
        @"cross|track|retrieve|recover|sneak|crouch|ascend|descend|swap|switch|spray|refuel|repair)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex ObjPronoun = new(@"\b(i|i'm|i'll|me|my|we|we're|us|our|you|you're|your|ya)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Görev satırının ilk harfi kesik okunduysa ("ollow Meses" → "Follow Moses") ve görevdeki ad bir harf
    // yanlışsa düzelt (content.js gorevOnar ile aynı)
    static readonly Dictionary<string, string> ObjKesik = new()
    {
        ["ollow"] = "follow", ["ocate"] = "locate", ["vade"] = "evade", ["ollect"] = "collect", ["eliver"] = "deliver",
        ["eturn"] = "return", ["nter"] = "enter", ["urchase"] = "purchase", ["hange"] = "change", ["estroy"] = "destroy",
        ["efend"] = "defend", ["rotect"] = "protect", ["escue"] = "rescue", ["nswer"] = "answer", ["nvestigate"] = "investigate",
        ["urvive"] = "survive", ["oard"] = "board", ["nload"] = "unload", ["liminate"] = "eliminate", ["efeat"] = "defeat",
        ["xit"] = "exit", ["nspect"] = "inspect", ["etrieve"] = "retrieve", ["ecover"] = "recover", ["neak"] = "sneak",
        ["rouch"] = "crouch", ["scend"] = "ascend", ["escend"] = "descend", ["efuel"] = "refuel", ["epair"] = "repair",
    };
    static readonly (Regex re, string to)[] ObjKesikOzel =
    {
        (new Regex(@"^o to\b"), "Go to"), (new Regex(@"^et (in|to|out|back|the|on|off|away)\b"), "Get $1"),
        (new Regex(@"^rive (to|the|back|home)\b"), "Drive $1"), (new Regex(@"^ead (to|back|home|over)\b"), "Head $1"),
    };
    static readonly string[] Adlar =
    {
        "Jason", "Lucia", "Brian", "Moses", "Kenton", "Tommy", "Donnie", "Vicki", "Andy", "Mattia", "Boobie", "Raul", "Wade",
        "Billy", "Frankie", "Martin", "Phillip", "Johnny", "Marcelo", "Arnold", "Peggy", "Shirley", "Mandy", "Mickey",
        "Declan", "Floyd", "Wanda", "Lori", "Dunk", "Doug", "Kyle",
    };
    static bool BirFark(string a, string b)
    {
        if (a.Length != b.Length) return false;
        int d = 0;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i] && ++d > 1) return false;
        return d == 1;
    }
    // Altyazı belirirken yarım okunduysa ("Break into the" → "Break into the Montagne") tamamı gelince yeniden çevir
    public static bool Uzadi(string text, string last)
    {
        string nt = Norm(text), nl = Norm(last);
        return nl.Length >= 4 && nt.Length >= nl.Length + 3 && nt.Contains(nl);
    }

    // Bloklardan biri (görev satırı "Follows" → "Follow Moses") belirgin değiştiyse yeni altyazıdır
    public static bool BlokDegisti(string a, string b)
    {
        if (string.IsNullOrEmpty(b)) return false;
        var pa = a.Split('\n'); var pb = b.Split('\n');
        if (pa.Length < 2 || pa.Length != pb.Length) return false; // tek blokta bütün metin karşılaştırması yeter
        for (int i = 0; i < pa.Length; i++)
        {
            string na = Norm(pa[i]), nb = Norm(pb[i]);
            // yarım okuma ("Break into the" ⊂ "…Montagne") değişiklik sayılmaz, yoksa gidip gelir
            if (Math.Min(na.Length, nb.Length) < 4 || na == nb || na.Contains(nb) || nb.Contains(na)) continue;
            var prev = new int[nb.Length + 1]; var cur = new int[nb.Length + 1];
            for (int j = 0; j <= nb.Length; j++) prev[j] = j;
            for (int x = 1; x <= na.Length; x++)
            {
                cur[0] = x;
                for (int j = 1; j <= nb.Length; j++) cur[j] = Math.Min(Math.Min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + (na[x - 1] == nb[j - 1] ? 0 : 1));
                (prev, cur) = (cur, prev);
            }
            if (prev[nb.Length] / (double)Math.Max(na.Length, nb.Length) > 0.3) return true;
        }
        return false;
    }

    public static string GorevOnar(string text)
    {
        return string.Join("\n", text.Split('\n').Select(line =>
        {
            string l = line;
            var m = Regex.Match(l, @"^(\p{Ll}+)\b");
            if (m.Success && ObjKesik.TryGetValue(m.Groups[1].Value, out var v)) l = char.ToUpperInvariant(v[0]) + v[1..] + l[m.Groups[1].Length..];
            else foreach (var (re, to) in ObjKesikOzel) if (re.IsMatch(l)) { l = re.Replace(l, to, 1); break; }
            if (ObjVerb.IsMatch(l) && !ObjPronoun.IsMatch(l))
                l = Regex.Replace(l, @"\b\p{Lu}\p{Ll}{3,}\b", w => Adlar.FirstOrDefault(a => BirFark(w.Value, a)) ?? w.Value);
            return l;
        }));
    }

    public static bool[] ObjectiveFlags(string text)
    {
        var parts = text.Split('\n');
        return parts.Select((p, i) =>
        {
            string t = p.Trim();
            int words = t.Split((char[])null, StringSplitOptions.RemoveEmptyEntries).Length;
            if (t.EndsWith('?') || t.EndsWith('!') || words > 14) return false;
            if (parts.Length > 1) return i == parts.Length - 1;
            return (KalipLine(t) != null || (words <= 8 && ObjVerb.IsMatch(t))) && !ObjPronoun.IsMatch(t);
        }).ToArray();
    }

    static readonly List<(Regex Re, string To)> Kalip = new();
    const string AdPattern = @"(\p{Lu}\p{L}+(?:[ -]\p{Lu}\p{L}+)?)";
    static readonly Regex KalipRef = new(@"\{(\d)(?::([^}]+))?\}", RegexOptions.Compiled);

    /// <summary>Görev kalıpları: "Follow Donnie" → "Donnie'yi takip et" (isim + Türkçe ek, internete gitmeden).</summary>
    public static string KalipLine(string text)
    {
        var m0 = ShortSplit.Match(text.Trim());
        foreach (var (re, to) in Kalip)
        {
            var m = re.Match(m0.Groups[1].Value);
            if (!m.Success) continue;
            var names = m.Groups.Cast<Group>().Skip(1).Select(g => g.Value).ToList();
            if (names.Any(n => n.Length == 0 || n.Split(' ', '-').Any(w => NameSkip.IsMatch(w)))) continue;
            return KalipRef.Replace(to, g =>
            {
                int i = int.Parse(g.Groups[1].Value) - 1;
                string n = i < names.Count ? names[i] : "";
                return g.Groups[2].Success ? n + "'" + Harmonize(n.Split(' ', '-').Last(), g.Groups[2].Value) : n;
            }) + m0.Groups[2].Value;
        }
        return null;
    }

    static Engine()
    {
        try
        {
            using var st = typeof(Engine).Assembly.GetManifestResourceStream("sozluk.js");
            if (st == null) return;
            string js = new StreamReader(st, Encoding.UTF8).ReadToEnd();
            int a = js.IndexOf('{', js.IndexOf("XCT_SOZLUK")), b = js.LastIndexOf('}');
            using var doc = JsonDocument.Parse(js.Substring(a, b - a + 1),
                new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            foreach (var p in doc.RootElement.GetProperty("kisa").EnumerateObject()) Kisa[p.Name] = p.Value.GetString();
            foreach (var r in doc.RootElement.GetProperty("argo").EnumerateArray())
            {
                try { Argo.Add((new Regex(r[0].GetString(), RegexOptions.IgnoreCase | RegexOptions.Compiled), r[1].GetString())); }
                catch { /* bozuk kural */ }
            }
            if (doc.RootElement.TryGetProperty("adlar", out var adl))
            {
                foreach (var ad in adl.EnumerateArray().Select(x => x.GetString()).Where(x => !string.IsNullOrWhiteSpace(x)).OrderByDescending(x => x.Length))
                {
                    string esc(string x) => Regex.Escape(x).Replace("'", "['’]");
                    try { YerAdlari.Add((ad, new Regex(@"(?<![\p{L}\p{N}])(?:" + esc(ad) + "|" + esc(ad.ToUpperInvariant()) + @")(?![\p{L}\p{N}])", RegexOptions.Compiled))); }
                    catch { /* bozuk ad */ }
                }
            }
            if (doc.RootElement.TryGetProperty("duzelt", out var duz))
                foreach (var r in duz.EnumerateArray())
                {
                    try { Duzelt.Add((new Regex(r[0].GetString(), RegexOptions.Compiled), r[1].GetString())); }
                    catch { /* bozuk kural */ }
                }
            if (doc.RootElement.TryGetProperty("kalip", out var kal))
                foreach (var r in kal.EnumerateArray())
                {
                    try { Kalip.Add((new Regex(r[0].GetString().Replace("<AD>", AdPattern), RegexOptions.Compiled), r[1].GetString())); }
                    catch { /* bozuk kalıp */ }
                }
        }
        catch { /* sözlük olmadan da çalışır */ }
    }

    static readonly Regex ShortSplit = new(@"^(.*?)([.!?…]*)$", RegexOptions.Compiled);
    static readonly Regex KeyPunct = new(@"[,.!?…]", RegexOptions.Compiled);
    static readonly Regex GroupRef = new(@"\$(\d)", RegexOptions.Compiled);

    /// <summary>"Wait!" → "Bekle!" — sık geçen kısa replikler internete gitmeden, anında.</summary>
    public static string ShortLine(string text)
    {
        var m = ShortSplit.Match(text.Trim());
        string key = Spaces.Replace(KeyPunct.Replace(m.Groups[1].Value.ToLowerInvariant(), " "), " ").Trim();
        return Kisa.TryGetValue(key, out var tr) ? tr + m.Groups[2].Value : null;
    }

    /// <summary>Google'ın yanlış anladığı argoyu düz İngilizceye çevir ("let's bounce" → "let's leave").</summary>
    public static string NormalizeSlang(string text)
    {
        foreach (var (re, to) in Argo)
        {
            text = re.Replace(text, m =>
            {
                string outText = GroupRef.Replace(to, g => m.Groups[int.Parse(g.Groups[1].Value)].Value);
                char first = m.Value.FirstOrDefault(char.IsLetter);
                if (first != default && char.IsUpper(first))
                {
                    int i = outText.TakeWhile(char.IsWhiteSpace).Count();
                    if (i < outText.Length) outText = outText[..i] + char.ToUpper(outText[i]) + outText[(i + 1)..];
                }
                return outText;
            });
        }
        return text;
    }

    // ---------------- Kalıcı önbellek: tekrar eden cümleler sonraki oturumlarda da anında gelir ----------------

    // ---------------- GTA 6 kaydı: havuzda olmayıp Google'dan gelen her çeviri ayrıca saklanır ----------------
    // %APPDATA%\XCloudCevirici\gta6-kayit.json (İngilizce → Türkçe). Denetlenip havuza eklenir (havuz/kayit-ekle.js).
    public static string KayitPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "XCloudCevirici", "gta6-kayit.json");
    Dictionary<string, string> kayit;
    int kayitDirty;
    const int KayitMax = 50000;

    void Gta6Kaydet(string en, string tr)
    {
        en = Regex.Replace(en ?? "", @"\s+", " ").Trim(); tr = (tr ?? "").Trim();
        if (en.Length == 0 || tr.Length == 0 || en.Length > 400) return;
        lock (cache)
        {
            if (kayit == null)
            {
                try { kayit = File.Exists(KayitPath) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(KayitPath)) : null; } catch { }
                kayit ??= new();
            }
            if (kayit.TryGetValue(en, out var old) && old == tr) return;
            kayit[en] = tr;
            while (kayit.Count > KayitMax) kayit.Remove(kayit.Keys.First());
        }
        Interlocked.Exchange(ref kayitDirty, 1);
    }

    void SaveKayit()
    {
        if (Interlocked.Exchange(ref kayitDirty, 0) == 0) return;
        try
        {
            string json;
            lock (cache) json = JsonSerializer.Serialize(kayit, new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
            Directory.CreateDirectory(Path.GetDirectoryName(KayitPath));
            File.WriteAllText(KayitPath, json);
        }
        catch { /* kaydedilemezse sessiz geç */ }
    }

    // 1.11.6: yeni dosya — eski önbellek "sl=auto" ile yapılmış yanlış/çevrilmemiş kısa kayıtlar içerebiliyordu
    static string CachePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "XCloudCevirici", "onbellek2.json");
    bool cacheLoaded;
    int cacheDirty;
    DateTime lastSave = DateTime.UtcNow;

    // Yaklaşık eşleşme: OCR aynı cümleyi bir iki harf farklı okusa da ("yeu"/"you") bellekteki çeviri kullanılır
    List<(string N, string V)> fuzzyIndex; int fuzzySize = -1;
    static string FuzzyNorm(string t) => new string(t.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());

    static double EditRatio(string a, string b, double limit)
    {
        int m = a.Length, n = b.Length, maxD = (int)(Math.Max(m, n) * limit);
        if (Math.Abs(m - n) > maxD) return 1;
        var prev = new int[n + 1]; var cur = new int[n + 1];
        for (int j = 0; j <= n; j++) prev[j] = j;
        for (int i = 1; i <= m; i++)
        {
            cur[0] = i; int rowMin = i;
            for (int j = 1; j <= n; j++)
            {
                cur[j] = Math.Min(Math.Min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
                if (cur[j] < rowMin) rowMin = cur[j];
            }
            if (rowMin > maxD) return 1;
            (prev, cur) = (cur, prev);
        }
        return prev[n] / (double)Math.Max(m, n);
    }

    string FuzzyCache(string prefix, string src)
    {
        string q = FuzzyNorm(src);
        if (q.Length < 14) return null; // kısa cümlelerde bir harf bile anlamı değiştirir
        List<(string N, string V)> index;
        lock (cache)
        {
            if (fuzzyIndex == null || fuzzySize != cache.Count)
            {
                fuzzyIndex = cache.Where(kv => kv.Key.StartsWith(prefix, StringComparison.Ordinal))
                    .Select(kv => (FuzzyNorm(kv.Key[prefix.Length..]), kv.Value)).ToList();
                fuzzySize = cache.Count;
            }
            index = fuzzyIndex;
        }
        // Kısa cümlede tek kelime farkı anlamı değiştirir ("cash"/"car"): eşik uzunlukla gevşer
        double limit = q.Length >= 40 ? 0.1 : 0.06, bestR = limit;
        string best = null;
        foreach (var (n, v) in index)
        {
            if (Math.Abs(n.Length - q.Length) > q.Length * limit) continue;
            double r = EditRatio(q, n, limit);
            if (r < bestR) { bestR = r; best = v; if (r == 0) break; }
        }
        return best;
    }

    void LoadCache()
    {
        if (cacheLoaded) return;
        cacheLoaded = true;
        try
        {
            if (!File.Exists(CachePath)) return;
            var saved = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(CachePath));
            // Eski sürümlerin çevirmeden sakladığı kayıtlar ("tr:Lawyer" → "Lawyer") atılır
            if (saved != null) lock (cache) foreach (var kv in saved)
                {
                    int c = kv.Key.IndexOf(':');
                    string k = c >= 0 ? kv.Key[(c + 1)..] : kv.Key;
                    if (!kv.Key.StartsWith("en:") && Norm(k) == Norm(kv.Value) && Regex.IsMatch(k, @"\p{L}{3,}")) continue;
                    cache.TryAdd(kv.Key, kv.Value);
                }
        }
        catch { /* bozuk dosya → boş önbellek */ }
    }

    public void SaveCache()
    {
        SaveKayit();
        if (Interlocked.Exchange(ref cacheDirty, 0) == 0) return;
        try
        {
            string json;
            lock (cache) json = JsonSerializer.Serialize(cache.Skip(Math.Max(0, cache.Count - CacheMax)).ToDictionary(kv => kv.Key, kv => kv.Value));
            Directory.CreateDirectory(Path.GetDirectoryName(CachePath));
            File.WriteAllText(CachePath, json);
        }
        catch { /* kaydedilemezse sessiz geç */ }
    }

    public async Task<string> TranslateAsync(string text)
    {
        LoadCache();
        string src = PrepForTranslation(text);
        if (S.TargetLang == "tr")
        {
            string hit = ShortLine(src) ?? KalipLine(src);
            if (hit != null) return hit;
        }
        src = NormalizeSlang(src);
        string key = S.TargetLang + ":" + src;
        // Hazır havuz (GTA 6 diyalogları) önbellekten önce: havuz düzeltilince eski Google çevirisi gösterilmez
        if (S.TargetLang == "tr")
        {
            string pool = Havuz.Lookup(text);
            // Havuzdaki kısa replikler (1–2 kelime) sahneye özeldir ("No" → "Siktir, hayır."): çeviri kaynaktan uzunsa kullanılmaz
            int srcW = Regex.Matches(src, @"\p{L}+").Count, poolW = pool == null ? 0 : Regex.Matches(pool, @"\p{L}+").Count;
            if (pool != null && (srcW >= 3 || poolW <= srcW)) return pool;
        }
        lock (cache) { if (cache.TryGetValue(key, out var hit)) return hit; }
        string near = FuzzyCache(S.TargetLang + ":", src);
        if (near != null)
        {
            // Bu yazımı da hatırla: bir dahaki sefere tam eşleşme
            lock (cache) cache[key] = near;
            Interlocked.Exchange(ref cacheDirty, 1);
            return near;
        }
        // Aynı cümle şu an çevriliyorsa ikinci kez Google'a sorma, aynı sonucu bekle
        Task<string> job;
        lock (inflight)
        {
            if (!inflight.TryGetValue(key, out job)) { job = TranslateNetAsync(key, src, text); inflight[key] = job; }
        }
        try { return await job; }
        finally { lock (inflight) inflight.Remove(key); }
    }

    readonly Dictionary<string, Task<string>> inflight = new();

    async Task<string> TranslateNetAsync(string key, string src, string original)
    {
        // Ağ takılırsa bir kez daha dene
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                string outText = (await GoogleKeepingNamesAsync(src)).Trim();
                if (outText.Length == 0) throw new InvalidOperationException("Çeviri boş döndü");
                // Çevrilmeden aynen dönen yazı (dil algılama hatası/ağ sorunu) önbelleğe yazılmaz: bir dahaki sefere yeniden sorulur
                if (S.TargetLang != "en" && Norm(outText) == Norm(src) && Regex.IsMatch(src, @"\p{L}{3,}"))
                {
                    _ = DeeplSonraAsync(key, src, original);
                    return outText;
                }
                lock (cache)
                {
                    if (cache.Count > CacheMax) cache.Remove(cache.Keys.First());
                    cache[key] = outText;
                }
                Interlocked.Exchange(ref cacheDirty, 1);
                if (S.TargetLang == "tr") Gta6Kaydet(original, outText);
                if (DateTime.UtcNow - lastSave > TimeSpan.FromSeconds(5)) { lastSave = DateTime.UtcNow; _ = Task.Run(SaveCache); }
                _ = DeeplSonraAsync(key, src, original);
                return outText;
            }
            catch when (attempt == 0)
            {
                await Task.Delay(250);
            }
        }
    }

    // ---------------- İsimler çevrilmesin ("Follow Moses" → "Moses'i takip et") ----------------
    // Cümle ortasında büyük harfle başlayan kelime isimdir; çeviride kaybolduysa tek başına çevirisini
    // bulup yerine asıl ismi koy, ekini de Türkçe ses uyumuna göre düzelt.
    static readonly Regex NameSkip = new(
        "^(God|Lord|Jesus|Christ|Heaven|Hell|Mom|Mum|Mommy|Mama|Dad|Daddy|Papa|Sir|Madam|Mister|Mr|Mrs|Ms|Miss|" +
        "Doctor|Doc|Officer|Sergeant|Detective|Captain|Chief|Boss|Uncle|Aunt|Auntie|Grandma|Grandpa|Granny|" +
        "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|" +
        "September|October|November|December|Christmas|Easter|Halloween|Thanksgiving|English|Spanish|French|German|" +
        "Russian|Italian|Chinese|Japanese|Korean|Dutch|Greek|Turkish|Arabic|Irish|Scottish|British|Polish|Swedish|" +
        "Danish|Finnish|Thai|Swiss|Earth|Moon|Sun|North|South|East|West|Internet|Okay|Yes|No|Hey|Oh|Uh|Um|Hmm|Yeah)$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex Nationality = new("(ian|ean|can|ese|ish)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex NameShape = new(@"^\p{Lu}\p{Ll}{2,}$", RegexOptions.Compiled);
    static readonly Regex EdgeNonLetters = new(@"^\P{L}+|\P{L}+$", RegexOptions.Compiled);
    readonly HashSet<string> seenNames = new();

    static string Harmonize(string name, string suf)
    {
        string n = name.ToLowerInvariant();
        char lastV = n.Reverse().FirstOrDefault(c => "aeiou".IndexOf(c) >= 0);
        if (lastV == default) lastV = 'e';
        bool endsVowel = "aeiou".IndexOf(n[^1]) >= 0;
        // İngilizce okunuş: sondaki "e" okunmaz (Pete'i, Steve'i, Mike'ı); -son/-ton/-er/-or belirsiz "ı" (Jason'ın, Parker'ı)
        if (n.Length >= 4 && Regex.IsMatch(n, "[^aeiouy]e$") && Regex.IsMatch(n[..^2], "[aeiouy]"))
        {
            endsVowel = false; n = n[..^1];
            lastV = Regex.IsMatch(n, "[iy][^aeiouy]$") ? 'ı' : n.Reverse().FirstOrDefault(c => "aeiou".IndexOf(c) >= 0);
            if (lastV == default) lastV = 'e';
            if (lastV == 'a') lastV = 'e';
        }
        else if (n.Length >= 4 && Regex.IsMatch(n, "([sdt]on|er|or)$")) lastV = 'ı';
        else if (Regex.IsMatch(n, "[^aeiou]y$")) { endsVowel = true; lastV = 'i'; }   // Billy'yi, Kenny'ye
        else if (Regex.IsMatch(n, "[ae]y$")) lastV = 'e';                               // Jay'i, Ray'e
        bool back = "aouı".IndexOf(lastV) >= 0, round = "ou".IndexOf(lastV) >= 0;
        var tr = new CultureInfo("tr-TR");
        string s = suf.ToLower(tr);
        const string V = "aeıioöuü";
        if (!endsVowel && s.Length > 1 && (s[0] == 'y' || s[0] == 'n') && V.IndexOf(s[1]) >= 0) s = s[1..];   // Musa'yı → Moses'i
        else if (!endsVowel && s.StartsWith("yl")) s = s[1..];                                              // Musa'yla → Moses'le
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == 'a' || c == 'e') sb.Append(back ? 'a' : 'e');
            else if (V.IndexOf(c) >= 0) sb.Append(back ? (round ? 'u' : 'ı') : (round ? 'ü' : 'i'));
            else sb.Append(c);
        }
        s = sb.ToString();
        if ("pçtkfhsş".IndexOf(n[^1]) >= 0 && s.StartsWith('d')) s = "t" + s[1..];                        // Moses'de → Moses'te
        return s;
    }

    /// <summary>Çevir; cümle ortasındaki isimler ("Moses", "Hope") çeviride değiştiyse geri koy.</summary>
    // Google "Okay!" → "Tamam aşkım!" gibi kaynakta olmayan hitap uyduruyor: kaynakta sevgi sözcüğü yoksa at
    static readonly Regex SevgiEn = new(@"\b(love|lover|babe|baby|bae|honey|hun|darling|sweetheart|sweetie|sweety|dear|dearest|sugar|cutie|princess|angel|my girl|my boy)\b", RegexOptions.IgnoreCase);
    static readonly Regex UydurmaHitap = new(@",?\s+(aşkım|canım|bebeğim|tatlım|sevgilim)(?=[\s.!?,…]|$)", RegexOptions.IgnoreCase);
    static readonly Regex NoktaSonrasi = new(@"(^|[^.…][.!?]\s+)(\p{Ll})");
    static readonly System.Globalization.CultureInfo TrKultur = new("tr-TR");

    public async Task<string> TranslateKeepingNamesAsync(string src)
    {
        src = KisaltmaOnar(src); // isim/yer koruma ve DeepL yolu da onarılmış metni görsün
        var tr = await TranslateKeepingNamesCoreAsync(src);
        if (tr == null) return tr;
        if (!SevgiEn.IsMatch(src)) tr = UydurmaHitap.Replace(tr, "");
        foreach (var (re, to) in Duzelt) tr = re.Replace(tr, to); // oyun terimleri: "aranan seviye" → "aranma seviyesi"
        // Nokta/ünlemden sonra küçük harf kalmasın ("Hey. yani…"); üç nokta sonrası devamdır
        return NoktaSonrasi.Replace(tr, m => m.Groups[1].Value + m.Groups[2].Value.ToUpper(TrKultur));
    }
    async Task<string> TranslateKeepingNamesCoreAsync(string src)
    {
        // İsim adayları çeviriden ÖNCE bulunur, tek başına çevirileri ana çeviriyle aynı anda istenir (sıra beklemez)
        var toks = Regex.Matches(src, @"\S+").Select(m => m.Value).ToArray();
        var names = new List<string>();
        // 1–2 kelimelik replik ("Lawyer.", "Very good.") isim içerse bile korunmaz: çoğu zaman sıradan kelimedir
        if (Regex.Matches(src, @"\p{L}{2,}").Count >= 3)
        {
            for (int i = 0; i < toks.Length; i++)
            {
                string w = EdgeNonLetters.Replace(toks[i], "");
                if (!NameShape.IsMatch(w) || NameSkip.IsMatch(w) || Nationality.IsMatch(w)) continue;
                // Sözlükteki sıradan kelime ("Just", "Very", "Lawyer") isim sayılmaz (satır başı/OCR kırıntısı sonrası büyük harf)
                if (WordDict.Info(w.ToLowerInvariant()).Known == true) continue;
                bool sentenceStart = i == 0 || ".!?…:\"”-–—".IndexOf(toks[i - 1][^1]) >= 0;
                lock (seenNames)
                {
                    if (sentenceStart) { if (seenNames.Contains(w)) names.Add(w); continue; }
                    seenNames.Add(w);
                }
                names.Add(w);
            }
        }
        names = names.Distinct().ToList();
        var nameJobs = names.Select(n => TranslateAsync(n).ContinueWith(t => t.IsCompletedSuccessfully ? t.Result : null)).ToList();
        string outText = await TranslateAsync(src);
        if (string.IsNullOrEmpty(outText) || names.Count == 0) return outText;
        for (int k = 0; k < names.Count; k++)
        {
            string n = names[k];
            if (outText.Contains(n, StringComparison.OrdinalIgnoreCase)) continue;
            string t = (await nameJobs[k])?.Trim().TrimEnd('.', '!', '?');
            if (string.IsNullOrEmpty(t) || t.Any(char.IsWhiteSpace) || string.Equals(t, n, StringComparison.OrdinalIgnoreCase)) continue;
            var re = new Regex(@"(?<!\p{L})" + Regex.Escape(t) + @"(?:['’](\p{L}+))?(?!\p{L})", RegexOptions.IgnoreCase);
            outText = re.Replace(outText, m => n + (m.Groups[1].Success ? "'" + Harmonize(n, m.Groups[1].Value) : ""));
        }
        return outText;
    }

    // ---------------- İsim koruma (eklentideki ceviri-ag.js ile aynı) ----------------
    // Google bazı karakter adlarını çeviriyor ("Bill" → "fatura", "Peaches" → "Şeftaliler"). Göndermeden önce
    // uydurma bir adla değiştir, son hecesi asıl adla aynı sesli olsun ki Türkçe ek (Zorket'e → Cat'e) uysun.
    // Uydurma ad çeviride kaybolduysa korumasız çeviri kullanılır.
    static readonly (string name, string ph, bool midOnly)[] Isimler =
    {
        ("Bill", "Zorbil", false), ("Moses", "Zormozet", false), ("Peaches", "Zorpiçit", false), ("Dunk", "Zordunk", false),
        ("Cat", "Zorket", false), ("Lucky", "Zorlaki", true),   // true: yalnız cümle ortasında ("Lucky for you" değil)
    };
    static readonly Regex IsimRe = new(@"(^|[.!?…]\s+|[^.!?…\s]\s*)\b(" + string.Join("|", Isimler.Select(x => x.name)) + @")\b(?!-)",
        RegexOptions.Compiled);

    static (string outText, List<(string name, string ph, bool midOnly)> used) ProtectNames(string text)
    {
        var used = new List<(string, string, bool)>();
        string outText = IsimRe.Replace(text, m =>
        {
            string pre = m.Groups[1].Value;
            var it = Isimler.First(x => x.name == m.Groups[2].Value);
            bool start = pre.Trim().Length == 0 || pre.IndexOfAny(".!?…".ToCharArray()) >= 0;
            if (it.midOnly && start) return m.Value;
            used.Add(it);
            return pre + it.ph;
        });
        return (outText, used);
    }

    static string RestoreNames(string tr, List<(string name, string ph, bool midOnly)> used)
    {
        foreach (var (name, ph, _) in used)
        {
            var re = new Regex(Regex.Escape(ph), RegexOptions.IgnoreCase);
            if (!re.IsMatch(tr)) return null;   // Google uydurma adı değiştirdi: güvenme
            tr = re.Replace(tr, name);
        }
        return tr;
    }

    // ---------------- DeepL (isteğe bağlı) ----------------
    // Sunucusu Google'dan uzak (~100 ms fazla), bu yüzden ekrandaki çeviriyi beklemez: Google'ınki
    // gösterildikten 0,7 sn sonra altyazı hâlâ ekrandaysa (OCR'ın yarım okumaları kota harcamasın) bir kez
    // sorulur, gelen çeviri önbelleğe ve GTA 6 kaydına yazılır; cümle bir dahaki sefere DeepL kalitesinde gelir.
    public Func<string, bool> StillShown;
    /// <summary>DeepL çevirisi geldi (özgün metin): ekrandaki Google çevirisi yerinde yükseltilir.</summary>
    public event Action<string> DeeplUpgraded;
    readonly HashSet<string> deeplSorulan = new();
    public string LastDeeplError { get; private set; }

    async Task DeeplSonraAsync(string key, string src, string original)
    {
        string apiKey = (S.DeeplKey ?? "").Trim();
        if (apiKey.Length == 0) return;
        if (Regex.Matches(src, @"\p{L}{2,}").Count < 3) return; // OCR kırıntısı kota harcamasın
        lock (deeplSorulan) { if (!deeplSorulan.Add(key)) return; }
        await Task.Delay(300); // OCR'ın yarım okumaları kota harcamasın: altyazı 0,3 sn ekranda kalırsa sor
        if (StillShown != null && !StillShown(original)) { lock (deeplSorulan) deeplSorulan.Remove(key); return; }
        try
        {
            string tr = (await DeeplKeepingNamesAsync(src, apiKey)).Trim();
            if (tr.Length == 0) return;
            lock (cache) cache[key] = tr;
            Interlocked.Exchange(ref cacheDirty, 1);
            if (S.TargetLang == "tr") Gta6Kaydet(original, tr);
            LastDeeplError = null;
            // Ekrandaki çeviri değiştirilmez (okurken yazının değişmesi rahatsız edici); DeepL önbelleğe yazılır.
        }
        catch (Exception e) { LastDeeplError = e.Message; }
    }

    async Task<string> DeeplKeepingNamesAsync(string src, string apiKey)
    {
        if (S.TargetLang != "tr") return await DeeplAsync(src, apiKey);
        var (prot0, used) = ProtectNames(src);
        var (prot, yer) = ProtectPlaces(prot0);
        if (used.Count == 0 && yer.Count == 0) return await DeeplAsync(src, apiKey);
        string tr = null;
        try { tr = RestorePlaces(RestoreNames(await DeeplAsync(prot, apiKey), used), yer); } catch { }
        return tr ?? await DeeplAsync(src, apiKey);
    }

    static string DeeplHost(string apiKey) => apiKey.EndsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";

    async Task<string> DeeplAsync(string text, string apiKey)
    {
        string target = S.TargetLang.ToUpperInvariant() switch { "EN" => "EN-US", "PT" => "PT-BR", var t => t };
        using var req = new HttpRequestMessage(HttpMethod.Post, DeeplHost(apiKey) + "/v2/translate");
        req.Headers.TryAddWithoutValidation("Authorization", "DeepL-Auth-Key " + apiKey);
        req.Content = new StringContent(JsonSerializer.Serialize(new { text = new[] { text }, source_lang = "EN", target_lang = target }), Encoding.UTF8, "application/json");
        using var cts = new CancellationTokenSource(5000);
        using var res = await Http.SendAsync(req, cts.Token);
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException("DeepL HTTP " + (int)res.StatusCode + ((int)res.StatusCode == 456 ? " (aylık kota doldu)" : (int)res.StatusCode == 403 ? " (anahtar geçersiz)" : ""));
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(cts.Token));
        return doc.RootElement.GetProperty("translations")[0].GetProperty("text").GetString() ?? "";
    }

    // Anahtarı dener: (kullanılan, sınır) karakter
    public static async Task<(long used, long limit)> DeeplUsageAsync(string apiKey)
    {
        apiKey = apiKey.Trim();
        using var req = new HttpRequestMessage(HttpMethod.Get, DeeplHost(apiKey) + "/v2/usage");
        req.Headers.TryAddWithoutValidation("Authorization", "DeepL-Auth-Key " + apiKey);
        using var cts = new CancellationTokenSource(5000);
        using var res = await Http.SendAsync(req, cts.Token);
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException("DeepL HTTP " + (int)res.StatusCode + ((int)res.StatusCode == 403 ? " (anahtar geçersiz)" : ""));
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(cts.Token));
        return (doc.RootElement.GetProperty("character_count").GetInt64(), doc.RootElement.GetProperty("character_limit").GetInt64());
    }

    async Task<string> GoogleKeepingNamesAsync(string src)
    {
        if (S.TargetLang != "tr") return await GoogleAsync(src);
        var (prot0, used) = ProtectNames(src);
        var (prot, yer) = ProtectPlaces(prot0);
        if (used.Count == 0 && yer.Count == 0) return await GoogleAsync(src);
        string tr = null;
        try { tr = RestorePlaces(RestoreNames(await GoogleAsync(prot), used), yer); } catch { }
        return tr ?? await GoogleAsync(src);
    }

    // ---------------- Oyun adları (yer, marka) çevrilmesin — eklentideki content.js ile aynı ----------------
    // "Los Santos Customs" → "Los Santos Gümrüğü" olmasın: ad, Google'ın dokunmadığı uydurma bir adla değiştirilir
    // ("Zorvax'a götür"), sonra geri yazılır, eki Türkçe ses uyumuna göre düzeltilir ("Vice City'ye", "Leonida'nın").
    static readonly string[] AdTut = { "Zorvax", "Kelbrin", "Drunvel", "Quorix", "Talvex", "Morbek" };

    static (string outText, List<string> map) ProtectPlaces(string text)
    {
        var map = new List<string>();
        foreach (var (name, re) in YerAdlari)
        {
            if (!re.IsMatch(text)) continue;
            text = re.Replace(text, m =>
            {
                int i = map.IndexOf(name);
                if (i < 0) { if (map.Count >= AdTut.Length) return m.Value; i = map.Count; map.Add(name); }
                return AdTut[i];
            });
        }
        // Sosyal medya adları ve etiketler çevrilmez ("@Swampinator" → "@Bataklıkçı" olmasın)
        text = SosyalAd.Replace(text, m =>
        {
            int i = map.IndexOf(m.Value);
            if (i < 0) { if (map.Count >= AdTut.Length) return m.Value; i = map.Count; map.Add(m.Value); }
            return AdTut[i];
        });
        return (text, map);
    }
    static readonly Regex SosyalAd = new(@"(?<![\p{L}\p{N}])[@#][\p{L}\p{N}_.]*\p{L}[\p{L}\p{N}_]*", RegexOptions.Compiled);

    // Uydurma ad ünsüzle bitiyor ("Zorvax'a"); asıl ad ünlüyle bitiyorsa kaynaştırma harfi gerekir ("City'ye")
    static string AdEki(string name, string suf)
    {
        string s = suf.ToLower(TrKultur);
        if (s.Length > 0 && "aeıioöuü".IndexOf(s[0]) >= 0)
            s = (Regex.IsMatch(s, "^[ıiuü]n(?![aeıioöuü])") ? "n" : "y") + s;
        return Harmonize(name, s);
    }

    static string RestorePlaces(string tr, List<string> map)
    {
        if (tr == null) return null;
        for (int i = 0; i < map.Count; i++)
        {
            var re = new Regex(AdTut[i] + @"(?:['’](\p{L}+))?", RegexOptions.IgnoreCase);
            if (!re.IsMatch(tr)) return null;   // ad çeviride kayboldu: korumasız çevir
            string name = map[i];
            tr = re.Replace(tr, m => name + (m.Groups[1].Success ? "'" + AdEki(name, m.Groups[1].Value) : ""));
        }
        return tr;
    }

    // İki Google uç noktası aynı anda sorulur, ilk gelen alınır: yeni cümlede her biri 250–900 ms oynuyor,
    // yarışınca ortanca ~400 ms. gtx ayrıca sık sık 429 ("çok fazla istek") veriyor; 429/403 veren uç nokta
    // 1 dakika dinlendirilir, o sürede yalnızca diğeri kullanılır.
    static readonly long[] restUntil = new long[2]; // 0: clients5, 1: gtx (Environment.TickCount64)
    static long lastNetUse;

    async Task<string> GoogleAsync(string text)
    {
        Interlocked.Exchange(ref lastNetUse, Environment.TickCount64);
        long now = Environment.TickCount64;
        var use = new List<int>();
        for (int i = 0; i < 2; i++) if (Interlocked.Read(ref restUntil[i]) <= now) use.Add(i);
        if (use.Count == 0) use.AddRange(new[] { 0, 1 });
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var tasks = use.Select(i => i == 0 ? Clients5Async(text, cts.Token) : GtxAsync(text, cts.Token)).ToList();
        Exception last = null;
        while (tasks.Count > 0)
        {
            var t = await Task.WhenAny(tasks);
            tasks.Remove(t);
            try { string r = await t; cts.Cancel(); return r; }
            catch (Exception e) { last = e; }
        }
        throw last ?? new InvalidOperationException("Çeviri yapılamadı");
    }

    static async Task<string> GetJsonAsync(string url, int slot, CancellationToken ct)
    {
        using var res = await Http.GetAsync(url, ct);
        if ((int)res.StatusCode is 429 or 403) Interlocked.Exchange(ref restUntil[slot], Environment.TickCount64 + 60000);
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadAsStringAsync(ct);
    }

    // Kaynak her zaman İngilizce (OCR İngilizce): "auto" kısa kelimeleri ("Just", "Very", "Lawyer") başka dil sanıp
    // çevirmeden geri döndürüyordu
    string SrcLang => S.TargetLang == "en" ? "auto" : "en";

    async Task<string> Clients5Async(string text, CancellationToken ct)
    {
        string url = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=" + SrcLang + "&tl="
                     + Uri.EscapeDataString(S.TargetLang) + "&q=" + Uri.EscapeDataString(text);
        using var doc = JsonDocument.Parse(await GetJsonAsync(url, 0, ct));
        // Biçimler: ["çeviri"] · [["çeviri","en"]] · {sentences:[{trans}]}
        var e = doc.RootElement;
        if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty("sentences", out var sen))
            return string.Concat(sen.EnumerateArray().Select(x => x.TryGetProperty("trans", out var tr) ? tr.GetString() : ""));
        if (e.ValueKind == JsonValueKind.Array && e.GetArrayLength() > 0) e = e[0];
        if (e.ValueKind == JsonValueKind.Array && e.GetArrayLength() > 0) e = e[0];
        string r = e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        if (string.IsNullOrWhiteSpace(r)) throw new InvalidOperationException("Çeviri boş döndü");
        return r;
    }

    async Task<string> GtxAsync(string text, CancellationToken ct)
    {
        string url = "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=" + SrcLang + "&tl="
                     + Uri.EscapeDataString(S.TargetLang) + "&q=" + Uri.EscapeDataString(text);
        using var doc = JsonDocument.Parse(await GetJsonAsync(url, 1, ct));
        var sb = new StringBuilder();
        foreach (var part in doc.RootElement[0].EnumerateArray())
            if (part.ValueKind == JsonValueKind.Array && part[0].ValueKind == JsonValueKind.String)
                sb.Append(part[0].GetString());
        if (sb.Length == 0) throw new InvalidOperationException("Çeviri boş döndü");
        return sb.ToString();
    }

    /// <summary>Çeviri bağlantılarını sıcak tut: yeni cümlede TLS el sıkışması (~100–200 ms) beklenmesin.</summary>
    public void WarmNetwork()
    {
        long now = Environment.TickCount64;
        if (now - Interlocked.Read(ref lastNetUse) < 20000) return;
        Interlocked.Exchange(ref lastNetUse, now);
        _ = Task.Run(async () =>
        {
            using var c = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try { await Clients5Async("ok", c.Token); } catch { }
            try { await GtxAsync("ok", c.Token); } catch { }
        });
    }
}

/// <summary>
/// İngilizce kelime listesi (kelimeler.txt — Tesseract sözlüğü + oyun argosu, Chrome eklentisiyle ortak).
/// Saçma OCR okumalarını ayırt eder, birleşik okunan kelimeleri ayırır ("haveall" → "have all") ve
/// tek harflik karışıklıkları düzeltir ("vou're" → "you're").
/// </summary>
static class WordDict
{
    static readonly Lazy<HashSet<string>> Words = new(() =>
    {
        try
        {
            using var st = typeof(WordDict).Assembly.GetManifestResourceStream("kelimeler.txt");
            if (st == null) return null;
            var set = new HashSet<string>(StringComparer.Ordinal);
            using var rd = new StreamReader(st, Encoding.UTF8);
            string line;
            while ((line = rd.ReadLine()) != null) if (line.Length > 0) set.Add(line);
            return set;
        }
        catch { return null; }
    });

    static readonly HashSet<string> ShortOk = new("a i am an as at be by do go he if in is it me my no of oh on or so to up us we ok".Split(' '));
    static readonly (string A, string B)[] Confusions =
    {
        ("v", "y"), ("y", "v"), ("rn", "m"), ("m", "rn"), ("e", "o"), ("o", "e"), ("c", "e"), ("e", "c"),
        ("ii", "ll"), ("li", "h"), ("l", "i"), ("i", "l"), ("n", "h"), ("h", "n"), ("u", "o"), ("a", "o"),
    };
    static readonly Regex Parts = new(@"^(\P{L}*)(.*?)(\P{L}*)$", RegexOptions.Compiled);
    static readonly Regex NonWord = new(@"[^\p{L}']+", RegexOptions.Compiled);
    static readonly Regex Hyphenated = new(@"^[\p{L}'-]+$", RegexOptions.Compiled);
    static readonly Regex LettersOnly = new(@"^\p{L}{5,20}$", RegexOptions.Compiled);

    static bool Known(HashSet<string> d, string w)
    {
        if (w.Length < 3) return ShortOk.Contains(w) || w.Length < 2;
        return d.Contains(w) || (w.EndsWith("'s") && d.Contains(w[..^2]))
            || (w.EndsWith("in") && d.Contains(w + "g"))           // comin' → coming
            || (w.EndsWith('s') && d.Contains(w[..^1]));
    }

    static string Segment(HashSet<string> d, string core)
    {
        string lc = core.ToLowerInvariant();
        bool Ok(string p) => p.Length >= 3 ? d.Contains(p) : ShortOk.Contains(p);
        int[] best = null; int bestMin = 0;
        for (int i = 1; i < lc.Length; i++)
        {
            string a = lc[..i], b = lc[i..];
            if (Ok(a) && Ok(b) && Math.Min(a.Length, b.Length) > bestMin) { best = new[] { i }; bestMin = Math.Min(a.Length, b.Length); }
        }
        if (best == null && lc.Length >= 7)
        {
            for (int i = 2; i < lc.Length - 3 && best == null; i++)
                for (int j = i + 2; j < lc.Length - 1; j++)
                    if (Ok(lc[..i]) && Ok(lc[i..j]) && Ok(lc[j..])) { best = new[] { i, j }; break; }
        }
        if (best == null) return null;
        var cuts = new List<int> { 0 }; cuts.AddRange(best); cuts.Add(core.Length);
        return string.Join(" ", Enumerable.Range(0, cuts.Count - 1).Select(k => core[cuts[k]..cuts[k + 1]]));
    }

    /// <summary>Known: sözlükte mi (sözlük yoksa ya da 3 harften kısaysa null); Fix: düzeltilmiş yazım.</summary>
    public static (bool? Known, string Fix) Info(string raw)
    {
        var d = Words.Value;
        if (d == null) return (null, null);
        var m = Parts.Match(raw.Replace('’', '\'').Replace('‘', '\''));
        string pre = m.Groups[1].Value, core = m.Groups[2].Value, post = m.Groups[3].Value;
        if (core.Count(char.IsLetter) < 3) return (null, null);
        var parts = NonWord.Split(core.ToLowerInvariant()).Where(p => p.Length > 0).ToArray();
        if (parts.Length > 1)
        {
            if (!parts.All(p => Known(d, p))) return (false, null);
            // "can/show" → "can show"; tireli kelimeler olduğu gibi kalır
            return Hyphenated.IsMatch(core) ? (true, null) : (true, pre + string.Join(" ", NonWord.Split(core).Where(p => p.Length > 0)) + post);
        }
        string lc = core.ToLowerInvariant();
        if (Known(d, lc)) return (true, null);
        // Boşluğu yutulmuş "a": "scana ride" → "scan a ride" (harf karışıklığından önce: yoksa "seana" olur)
        if (lc.Length >= 5 && lc[^1] == 'a' && LettersOnly.IsMatch(core) && Known(d, lc[..^1]))
            return (true, pre + core[..^1] + " a" + post);
        foreach (var (a, b) in Confusions)
        {
            for (int i = lc.IndexOf(a, StringComparison.Ordinal); i >= 0; i = lc.IndexOf(a, i + 1, StringComparison.Ordinal))
            {
                if (Known(d, lc[..i] + b + lc[(i + a.Length)..]))
                {
                    string rep = core[i] != lc[i] ? b.ToUpperInvariant() : b;
                    return (true, pre + core[..i] + rep + core[(i + a.Length)..] + post);
                }
            }
        }
        string seg = LettersOnly.IsMatch(core) ? Segment(d, core) : null;
        return seg != null ? (true, pre + seg + post) : (false, null);
    }
}
