using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace XCloudCevirici;

/// <summary>
/// Telefon mesajları (GTA 6'da sağ alttaki açık renk kutu: gönderen + mesaj). Altyazıdan tamamen ayrı:
/// kendi bölgesi, kendi OCR motoru (altyazı okumasını bekletmez), kendi sarı katmanı (kutunun hemen üstünde).
/// Kutu görünürken o alan altyazı görüntüsünde boyanır (Mask) — mesaj altyazı sanılmaz.
/// </summary>
sealed class MessageReader
{
    // Ekranın sağ alt köşesi (oyun tam ekranken kutu burada)
    const double RX = 0.765, RY = 0.58, RW = 0.228, RH = 0.41;
    OcrEngine ocr;
    bool[] lastInk;
    int lastK, miss;
    DateTime lastOcr = DateTime.MinValue;
    public string ShownSrc { get; private set; }
    public RectangleF Box { get; private set; }      // ekran koordinatı
    public Rectangle? Mask { get; private set; }       // altyazı okumasında boyanacak alan (ekran koordinatı)

    public sealed class Message { public string Sender = "", Body = ""; public RectangleF Box; }

    public bool Init()
    {
        try
        {
            ocr = OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US"))
               ?? OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-GB"))
               ?? OcrEngine.TryCreateFromUserProfileLanguages();
        }
        catch { ocr = null; }
        return ocr != null;
    }

    public static Rectangle RegionFor(Rectangle subRegion)
    {
        var s = Screen.FromRectangle(subRegion).Bounds;
        return new Rectangle(s.Left + (int)(s.Width * RX), s.Top + (int)(s.Height * RY), (int)(s.Width * RW), (int)(s.Height * RH));
    }

    public void Reset() { lastInk = null; ShownSrc = null; Mask = null; miss = 0; }

    internal static byte[] Pixels(Bitmap bmp, out int stride)
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

    /// <summary>Koyu yazı pikseli: yakınında açık, renksize yakın zemin var (mesaj kutusu).</summary>
    // colorCut > 0: bu doygunluğun üstündeki renkli pikseller yazı sayılmaz (yayın logosu gibi kırmızı/pembe çıkartma
    // mesaj kutusuna binince harf gibi okunmasın). Telefonda kullanılmaz: mavi baloncuktaki beyaz yazı korunur.
    internal static bool[] Ink(byte[] px, int stride, int W, int H, int r, out int k, out double bg, out double run, int colorCut = 0)
    {
        int n = W * H;
        var L = new byte[n]; var S2 = new byte[n]; var tmp = new byte[n]; var mx = new byte[n]; var C = new bool[n];
        int bgc = 0;
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int i = y * stride + x * 4, p = y * W + x;
                int b = px[i], g = px[i + 1], rr = px[i + 2];
                L[p] = (byte)(0.114 * b + 0.587 * g + 0.299 * rr);
                int sat = Math.Max(b, Math.Max(g, rr)) - Math.Min(b, Math.Min(g, rr));
                if (sat <= 40 && L[p] >= 115) { S2[p] = L[p]; bgc++; }
                if (colorCut > 0 && sat > colorCut && L[p] >= 60) C[p] = true;
            }
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                byte m = 0;
                for (int xx = Math.Max(0, x - r), e = Math.Min(W - 1, x + r); xx <= e; xx++) if (S2[y * W + xx] > m) m = S2[y * W + xx];
                tmp[y * W + x] = m;
            }
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                byte m = 0;
                for (int yy = Math.Max(0, y - r), e = Math.Min(H - 1, y + r); yy <= e; yy++) if (tmp[yy * W + x] > m) m = tmp[yy * W + x];
                mx[y * W + x] = m;
            }
        var ink = new bool[n];
        k = 0;
        for (int p = 0; p < n; p++) if (mx[p] >= 115 && mx[p] - L[p] >= 55 && !C[p]) { ink[p] = true; k++; }
        bg = bgc / (double)n;
        // En uzun kesintisiz açık zemin şeridi (kutunun satır arası); küçük etiket/filigran bunu geçemez
        int best = 0;
        for (int y = 0; y < H; y++) { int c = 0; for (int x = 0; x < W; x++) { c = S2[y * W + x] != 0 ? c + 1 : 0; if (c > best) best = c; } }
        run = best / (double)W;
        return ink;
    }

    /// <summary>
    /// Bir adım: kutu yoksa null (ve "gizle" isteği), değişmediyse null, yeni mesaj okunduysa Message döner.
    /// hide=true → katman gizlenmeli.
    /// </summary>
    public async Task<(Message Msg, bool Hide)> StepAsync(Rectangle subRegion)
    {
        if (ocr == null) return (null, false);
        var reg = RegionFor(subRegion);
        using var shot = Engine.Capture(reg);
        // Küçük imza (120 px genişlik)
        int SW = 120, SH = Math.Max(8, 120 * reg.Height / Math.Max(1, reg.Width));
        bool[] ink; int k; double bg, run;
        using (var small = new Bitmap(SW, SH, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(shot, 0, 0, SW, SH); }
            var px = Pixels(small, out int st);
            ink = Ink(px, st, SW, SH, 2, out k, out bg, out run, 90);
        }
        double ratio = k / (double)(SW * SH);
        if (ratio < 0.006 || bg < 0.1 || run < 0.45)
        {
            lastInk = null;
            if ((ShownSrc != null || Mask != null) && ++miss >= 2) { ShownSrc = null; Mask = null; return (null, true); }
            return (null, false);
        }
        miss = 0;
        if (lastInk != null && lastInk.Length == ink.Length)
        {
            int d = 0;
            for (int p = 0; p < ink.Length; p++) if (ink[p] != lastInk[p]) d++;
            if (d / (double)Math.Max(1, Math.Max(k, lastK)) < 0.2) return (null, false);
        }
        // Altyazıya öncelik: en sık 0,5 sn'de bir
        if ((DateTime.UtcNow - lastOcr).TotalMilliseconds < 500) return (null, false);
        lastOcr = DateTime.UtcNow;
        lastInk = ink; lastK = k;

        // OCR görüntüsü: yazı siyah, kalan her şey beyaz (~1000 px genişlik)
        double scale = Math.Min(3, Math.Max(1, 1000.0 / reg.Width));
        const int PAD = 10;
        int W = (int)(reg.Width * scale), H = (int)(reg.Height * scale);
        List<List<(string Text, RectangleF R)>> lines;
        using (var big = new Bitmap(W, H, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(big)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(shot, 0, 0, W, H); }
            var px = Pixels(big, out int st);
            var bink = Ink(px, st, W, H, Math.Max(2, (int)Math.Round(scale * 2)), out _, out _, out _, 90);
            int OW = W + PAD * 2, OH = H + PAD * 2;
            var outPx = new byte[OW * OH * 4];
            for (int i = 0; i < outPx.Length; i++) outPx[i] = 255;
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++)
                    if (bink[y * W + x]) { int o = ((y + PAD) * OW + x + PAD) * 4; outPx[o] = outPx[o + 1] = outPx[o + 2] = 0; }
            lines = await RecognizeAsync(outPx, OW, OH);
        }
        var msg = Parse(lines, reg, scale, PAD);
        if (msg == null) return (null, false);
        Box = msg.Box;
        var sc = Screen.FromRectangle(subRegion).Bounds;
        Mask = Rectangle.Round(RectangleF.FromLTRB(msg.Box.Left - sc.Width * 0.025f, msg.Box.Top - sc.Height * 0.035f,
            Math.Min(sc.Right, msg.Box.Right + sc.Width * 0.02f), Math.Min(sc.Bottom, msg.Box.Bottom + sc.Height * 0.06f)));
        if (ShownSrc != null && Engine.Similar(ShownSrc, msg.Body)) return (null, false);
        ShownSrc = msg.Body;
        return (msg, false);
    }

    internal async Task<List<List<(string Text, RectangleF R)>>> RecognizeAsync(byte[] px, int W, int H)
    {
        var result = new List<List<(string, RectangleF)>>();
        var writer = new DataWriter();
        writer.WriteBytes(px);
        using var sb = SoftwareBitmap.CreateCopyFromBuffer(writer.DetachBuffer(), BitmapPixelFormat.Bgra8, W, H, BitmapAlphaMode.Premultiplied);
        var r = await ocr.RecognizeAsync(sb);
        foreach (var line in r.Lines)
            result.Add(line.Words.Select(w => (w.Text, new RectangleF((float)w.BoundingRect.X, (float)w.BoundingRect.Y, (float)w.BoundingRect.Width, (float)w.BoundingRect.Height))).ToList());
        return result;
    }

    static int Letters(string s) => s.Count(char.IsLetter);

    // SMS kısaltmalarını aç: "b4", "2gether", "yr" çeviriyi bozmasın
    static readonly (System.Text.RegularExpressions.Regex Re, string To)[] Sms = new (string P, string T, bool I)[]
    {
        (@"\bb4\b", "before", true), (@"\b2gether\b", "together", true), (@"\b2day\b", "today", true), (@"\b2nite\b", "tonight", true),
        (@"\b2moro\b", "tomorrow", true), (@"\bgr8\b", "great", true), (@"\bl8r\b", "later", true), (@"\byr\b", "your", true), (@"\bur\b", "your", true),
        (@"\bu\b", "you", false), (@"\br\b", "are", false), (@"\bthx\b", "thanks", true), (@"\bpl[sz]\b", "please", true), (@"\bfck(in|ing)?\b", "fuck$1", true),
        (@"\bcuz\b", "because", true), (@"\bbc\b", "because", true), (@"\bw/(?=\s)", "with", true), (@"\bmsg\b", "message", true), (@"\btxt\b", "text", true),
        (@"\bidk\b", "I don't know", true), (@"\bimo\b", "in my opinion", true), (@"\bomw\b", "on my way", true), (@"\bbtw\b", "by the way", true),
        (@"\b(W)ere (in|gonna|going|not|good|done|here|there|ready|all|square|even|cool)\b", "$1e're $2", false),
    }.Select(x => (new System.Text.RegularExpressions.Regex(x.P, x.I ? System.Text.RegularExpressions.RegexOptions.IgnoreCase : System.Text.RegularExpressions.RegexOptions.None), x.T)).ToArray();

    public static string SmsAc(string t) { foreach (var (re, to) in Sms) t = re.Replace(t, to); return t; }

    static Message Parse(List<List<(string Text, RectangleF R)>> lines, Rectangle reg, double scale, int pad)
    {
        var good = new List<List<(string Text, RectangleF R)>>();
        foreach (var l in lines)
        {
            var ws = l.Where(w => w.Text.Any(char.IsLetter)).ToList();
            if (ws.Count == 0) continue;
            int letters = ws.Sum(w => Letters(w.Text));
            int ok = ws.Where(w => WordDict.Info(w.Text).Known != false || char.IsUpper(w.Text[0])).Sum(w => Letters(w.Text));
            if (letters < 3 || ok < letters * 0.6) continue;
            good.Add(ws);
        }
        if (good.Count == 0) return null;
        good.Sort((a, b) => a.Min(w => w.R.Top).CompareTo(b.Min(w => w.R.Top)));
        var all = good.SelectMany(g => g).ToList(); // kutu sınırı yalnızca gerçek metin satırlarından (simgeler hariç)
        string sender = "";
        if (good.Count > 1 && good[0].Count <= 3 && char.IsUpper(good[0][0].Text[0]))
        {
            sender = string.Join(" ", good[0].Where(w => w.Text.Length >= 2 && char.IsUpper(w.Text[0]) && w.Text.All(c => char.IsLetter(c) || c == '\'' || c == '.' || c == '-')).Select(w => w.Text));
            good.RemoveAt(0);
        }
        // Gönderen adı yoksa gerçek mesaj kutusu değil (ya da kutu daha belirmekte): gösterme
        if (sender.Length == 0 || good.Count == 0) return null;
        // Mesaj satırları kutunun sol kenarından başlar; sağa kaymış tek kelimelik satır yanıt göstergesidir ("→ Lucia")
        float minX = good.Min(g => g.Min(w => w.R.Left)), tol = (float)(reg.Width * scale * 0.06);
        var bodyLines = good.Where(g => g.Min(w => w.R.Left) <= minX + tol || g.Count > 3).ToList(); // "→ Brian" (avatarla 2-3 kelime okunabilir)
        // Tek kelimelik satırlar (yanıt göstergesi "→ Lucia" gibi) mesaj değildir
        string body = string.Join(" ", bodyLines.Select(g => string.Join(" ", g.Select(w => w.Text))));
        body = System.Text.RegularExpressions.Regex.Replace(body, @"(\p{L})- (\p{L})", "$1$2");
        body = System.Text.RegularExpressions.Regex.Replace(body, @"\s+", " ").Trim();
        // Baştaki simge kırıntısı ("a Meet here." → "Meet here.")
        body = System.Text.RegularExpressions.Regex.Replace(body, @"^(?:[a-z]\s+)+(?=\p{Lu})", "");
        // Kutu sağdan kesilmiş (yayın logosu / önizleme): "Bring a" gibi yarım biten cümle → "Bring a…"
        if (System.Text.RegularExpressions.Regex.IsMatch(body, @"\b(a|an|the|to|of|for|my|your|his|her|our|their|some|and|with|in|on|at)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) body += "…";
        if (System.Text.RegularExpressions.Regex.Matches(body, @"\p{L}{2,}").Count < 3) return null;
        // Gerçek mesaj mı? 3+ harfli kelimelerin çoğu sözlükte olmalı (arama göstergesi, HUD kırıntısı elenir)
        var bodyWs = bodyLines.SelectMany(g => g).Where(w => Letters(w.Text) >= 3).ToList();
        int knownN = bodyWs.Count(w => WordDict.Info(w.Text).Known == true);
        if (knownN < 3 || knownN < bodyWs.Count * 0.6) return null;
        float X(float x) => (float)(reg.Left + (x - pad) / scale);
        float Y(float y) => (float)(reg.Top + (y - pad) / scale);
        var box = RectangleF.FromLTRB(X(all.Min(w => w.R.Left)), Y(all.Min(w => w.R.Top)), X(all.Max(w => w.R.Right)), Y(all.Max(w => w.R.Bottom)));
        return new Message { Sender = sender, Body = body, Box = box };
    }
}

/// <summary>Mesaj çevirisi: sarı yazı, koyu yarı saydam zemin, kutunun hemen üstünde, sağa hizalı.</summary>
sealed class MessageOverlay : Form
{
    Bitmap frame;
    Point pos;

    public MessageOverlay()
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
        // Kendi sarı yazımızı ekran okumasına sokma (altyazı bölgesiyle çakışsa bile karışmasın)
        // Yayında (Discord/OBS) görünsün. Kendi ekran okumamıza karışmaz: CopyFromScreen katmanlı pencereleri yakalamaz.
        Native.SetWindowDisplayAffinity(Handle, Native.WDA_NONE);
    }

    public void ShowMessage(string sender, string tr, RectangleF box, int fontSize)
    {
        var sc = Screen.FromRectangle(Rectangle.Round(box)).Bounds;
        float fontPx = Math.Clamp(fontSize * sc.Height / 720f * 0.72f, 12, 40);
        float maxW = Math.Max(220, box.Width * 1.15f + sc.Width * 0.03f);
        using var font = new Font("Segoe UI", fontPx, FontStyle.Bold, GraphicsUnit.Pixel);
        using var fmt = new StringFormat(StringFormat.GenericTypographic) { Alignment = StringAlignment.Near };
        SizeF hs = SizeF.Empty, bs;
        string head = sender.Length > 0 ? sender + ":" : "";
        using (var mg = Graphics.FromHwnd(IntPtr.Zero))
        {
            if (head.Length > 0) hs = mg.MeasureString(head, font, (int)maxW, fmt);
            bs = mg.MeasureString(tr, font, (int)maxW, fmt);
        }
        float padX = fontPx * 0.55f, padY = fontPx * 0.3f, gap = head.Length > 0 ? fontPx * 0.1f : 0;
        float tw = Math.Max(hs.Width, bs.Width), th = hs.Height + gap + bs.Height;
        int w = (int)Math.Ceiling(tw + padX * 2) + 2, h = (int)Math.Ceiling(th + padY * 2) + 2;
        frame?.Dispose();
        frame = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(frame))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            using (var bgPath = RoundRect(new RectangleF(0, 0, w - 1, h - 1), fontPx * 0.35f))
            using (var bgBrush = new SolidBrush(Color.FromArgb(184, 8, 8, 8)))
                g.FillPath(bgBrush, bgPath);
            using var white = new SolidBrush(Color.White);
            using var yellow = new SolidBrush(Color.FromArgb(255, 0xff, 0xd7, 0x5e));
            if (head.Length > 0) g.DrawString(head, font, white, new RectangleF(padX, padY, hs.Width + 1, hs.Height + 1), fmt);
            g.DrawString(tr, font, yellow, new RectangleF(padX, padY + hs.Height + gap, bs.Width + 1, bs.Height + 1), fmt);
        }
        int right = (int)Math.Min(sc.Right - 4, box.Right + sc.Width * 0.012f);
        pos = new Point(Math.Max(sc.Left + 4, right - w), (int)(box.Top - fontPx * 0.9f - h));
        // Önce görünür yap, SONRA katmanı çiz: Show() pencereyi Form'un kendi konum/boyutuna çeker ve
        // önceki UpdateLayeredWindow çizimini geçersiz kılar (katman hiç görünmüyordu)
        if (!Visible) Show();
        Push();
    }

    static GraphicsPath RoundRect(RectangleF r, float rad)
    {
        var p = new GraphicsPath();
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
