using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;

namespace XCloudCevirici;

/// <summary>
/// Sinema tarzı altyazı katmanı: piksel başına saydam (arka plan yok), beyaz yazı + siyah çerçeve + gölge,
/// yumuşak belirme/kaybolma. Her zaman en üstte, tıklamaları oyuna geçirir.
/// "İngilizcenin yerine" modunda ekran yakalamaya görünmez; diğer modlarda Discord yayınında görünür.
/// </summary>
sealed class OverlayForm : Form
{
    string text = "";
    Rectangle region;
    SubPosition position = SubPosition.Above;
    bool boxed;
    int fontPx = 30;
    int offsetY;

    // Sabit konum: çeviri hep aynı yerde durur. İlk altyazıda, İngilizcenin iki satıra çıktığı duruma da
    // yetecek yükseklik seçilir ve ayarlara kaydedilir (yeniden açılınca da aynı yer). Satırdan satıra
    // hiç kaymaz; yalnızca İngilizce bu konumun da üstüne çıkarsa (3 satır gibi) bir kez yukarı alınır.
    int? anchorY;
    int? curTextTop;
    public event Action<int> AnchorChanged;

    public void SetAnchor(int? y) => anchorY = y;

    public void NoteTextTop(int y, int lineH)
    {
        curTextTop = y;
        lineH = Math.Clamp(lineH, 10, Math.Max(12, region.Height / 2));
        if (anchorY == null) { anchorY = y - lineH; AnchorChanged?.Invoke(anchorY.Value); }
        else if (y < anchorY.Value - Math.Max(4, region.Height / 30)) { anchorY = y; AnchorChanged?.Invoke(y); }
    }

    int AnchorTop() => anchorY ?? curTextTop ?? region.Top;

    Bitmap frame;              // çizilmiş altyazı
    Point framePos;
    byte alpha;                // şu anki görünürlük (yumuşak geçiş)
    byte targetAlpha;
    readonly System.Windows.Forms.Timer fade = new() { Interval = 15 };
    readonly System.Windows.Forms.Timer hideLater = new();
    readonly System.Windows.Forms.Timer patchTimer = new() { Interval = 40 }; // oyundaki gibi: ~25 kare/sn
    DateTime shownAt;

    /// <summary>Oyun altyazısının parlaklık eşiği (İngilizce yazıyı silerken kullanılır).</summary>
    public int Threshold { get; set; } = 175;

    /// <summary>Bu Windows sürümü pencereyi ekran yakalamadan gizleyebiliyor mu?</summary>
    public bool CanHideFromCapture { get; private set; }

    public OverlayForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        fade.Tick += (_, _) => FadeStep();
        hideLater.Tick += (_, _) => { hideLater.Stop(); BeginFadeOut(); };
        patchTimer.Tick += (_, _) => { if (gBlocks != null && alpha > 0) { RenderGameFrame(); Push(); } };
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
        CanHideFromCapture = Native.SetWindowDisplayAffinity(Handle, Native.WDA_EXCLUDEFROMCAPTURE);
        ApplyCaptureMode();
    }

    /// <summary>"Yerine" ve "sil" modları yalnızca yakalamadan gizlenebiliyorsa mümkündür (yoksa kendi yazısını okur).</summary>
    public SubPosition EffectivePosition =>
        (position == SubPosition.Replace || position == SubPosition.Game) && !CanHideFromCapture ? SubPosition.Above : position;

    void ApplyCaptureMode()
    {
        if (!IsHandleCreated) return;
        bool hide = EffectivePosition == SubPosition.Replace || EffectivePosition == SubPosition.Game;
        Native.SetWindowDisplayAffinity(Handle, hide ? Native.WDA_EXCLUDEFROMCAPTURE : Native.WDA_NONE);
    }

    public void Configure(Rectangle region, SubPosition position, bool boxed, int fontPx, int offsetY = 0)
    {
        if (region != this.region) { curTextTop = null; if (this.region != Rectangle.Empty) anchorY = null; }
        this.offsetY = offsetY;
        this.region = region;
        this.position = position;
        this.boxed = boxed;
        this.fontPx = Math.Clamp(fontPx, 12, 80);
        ApplyCaptureMode();
        if (text.Length == 0) return;
        if (gBlocks != null && EffectivePosition == SubPosition.Game) { BuildGameLayout(); RenderGameFrame(); }
        else { StopGame(); Render(); }
        Push();
    }

    /// <summary>Boş metin: en az 0,8 sn göründükten sonra yumuşakça kaybolur.</summary>
    public void ShowText(string t)
    {
        t ??= "";
        if (t.Length == 0)
        {
            if (text.Length == 0) return;
            var shownFor = DateTime.UtcNow - shownAt;
            int wait = Math.Max(0, 800 - (int)shownFor.TotalMilliseconds);
            if (wait == 0) BeginFadeOut();
            else { hideLater.Interval = wait; hideLater.Start(); }
            return;
        }
        hideLater.Stop();
        StopGame();
        bool wasEmpty = text.Length == 0 || alpha == 0;
        text = t;
        shownAt = DateTime.UtcNow;
        if (!IsHandleCreated) CreateControl();
        Render();
        if (!Visible) Show();
        if (wasEmpty) { alpha = 0; targetAlpha = 255; fade.Start(); }
        else { targetAlpha = 255; alpha = 255; }
        Push();
    }

    public void HideNow()
    {
        hideLater.Stop(); fade.Stop(); StopGame();
        text = ""; alpha = 0;
        if (Visible) Hide();
    }

    void BeginFadeOut()
    {
        targetAlpha = 0;
        fade.Start();
    }

    void FadeStep()
    {
        const int step = 40; // ~100 ms
        if (alpha < targetAlpha) alpha = (byte)Math.Min(targetAlpha, alpha + step);
        else if (alpha > targetAlpha) alpha = (byte)Math.Max(targetAlpha, alpha - step);
        Push();
        if (alpha == targetAlpha)
        {
            fade.Stop();
            if (alpha == 0) { text = ""; StopGame(); Hide(); }
        }
    }

    /// <summary>Oyun penceresi tam ekrana geçse bile en üste geri getir.</summary>
    public void KeepOnTop()
    {
        if (Visible)
            Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER);
    }

    // ---------------- Çizim ----------------

    void Render()
    {
        if (region.Width <= 0 || text.Length == 0) return;
        var screen = Screen.FromRectangle(region).Bounds;
        var pos = EffectivePosition;
        if (pos == SubPosition.Game) pos = SubPosition.Above; // konum bilgisi yoksa üstünde göster

        // Satır genişliği: altyazı bölgesi kadar, ama okunaklı olsun diye en az ekranın %55'i, en çok %85'i
        int maxW = Math.Clamp(Math.Max(region.Width, (int)(screen.Width * 0.55)), 300, (int)(screen.Width * 0.85));
        int padX = (int)(fontPx * 0.7), padY = (int)(fontPx * 0.35);
        float outline = Math.Max(3f, fontPx * 0.13f);

        using var family = new FontFamily("Segoe UI");
        var style = FontStyle.Bold;
        using var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Near };
        using var path = new GraphicsPath();
        var layout = new RectangleF(0, 0, maxW - padX * 2, 10000);
        // Görev hedefi satırı ayrı yol olarak eklenir: aynı çerçeve, farklı dolgu rengi
        var lines = text.Split('\n');
        var obj = Objective != null && Objective.Length == lines.Length && Objective.Any(b => b) ? Objective : null;
        using var objPath = new GraphicsPath();
        if (obj == null) path.AddString(text, family, (int)style, fontPx, layout, fmt);
        else
        {
            float ly = 0, gap = fontPx * 0.12f;
            for (int i = 0; i < lines.Length; i++)
            {
                using var lp = new GraphicsPath();
                lp.AddString(lines[i], family, (int)style, fontPx, new RectangleF(0, ly, layout.Width, 10000), fmt);
                var lb = lp.GetBounds();
                ly = (lb.IsEmpty ? ly + fontPx : lb.Bottom) + gap + fontPx * 0.25f;
                path.AddPath(lp, false);
                if (obj[i]) objPath.AddPath(lp, false);
            }
        }
        var tb = path.GetBounds();

        int textW = (int)Math.Ceiling(tb.Width + outline * 2);
        int textH = (int)Math.Ceiling(tb.Height + outline * 2);
        int W = maxW;
        int H = textH + padY * 2;
        if (pos == SubPosition.Replace) H = Math.Max(H, region.Height);

        // Yazıyı pencerenin ortasına hizala
        using (var m = new Matrix())
        {
            // Yatayda: yerleşim kutusu zaten ortalı, sadece kenar boşluğu kadar kaydır
            m.Translate(padX, (H - tb.Height) / 2f - tb.Top);
            path.Transform(m);
            objPath.Transform(m);
        }
        tb = path.GetBounds();

        var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.TextRenderingHint = TextRenderingHint.AntiAlias;

            if (pos == SubPosition.Replace)
            {
                // İngilizceyi tamamen örten koyu şerit
                using var bg = new SolidBrush(Color.FromArgb(235, 8, 8, 8));
                using var rr = Rounded(new RectangleF(0, 0, W, H), Math.Min(14, H / 4f));
                g.FillPath(bg, rr);
            }
            else if (boxed)
            {
                var box = RectangleF.Inflate(tb, padX * 0.8f, padY * 0.9f);
                using var bg = new SolidBrush(Color.FromArgb(170, 0, 0, 0));
                using var rr = Rounded(box, Math.Min(12, box.Height / 4f));
                g.FillPath(bg, rr);
            }

            if (!boxed || pos == SubPosition.Replace)
            {
                // Yumuşak gölge
                using (var shadow = (GraphicsPath)path.Clone())
                using (var sm = new Matrix())
                {
                    sm.Translate(0, Math.Max(2, fontPx / 14f));
                    shadow.Transform(sm);
                    using var sp = new Pen(Color.FromArgb(110, 0, 0, 0), outline * 2.2f) { LineJoin = LineJoin.Round };
                    g.DrawPath(sp, shadow);
                }
                // Siyah çerçeve
                using var op = new Pen(Color.FromArgb(235, 0, 0, 0), outline * 2f) { LineJoin = LineJoin.Round };
                g.DrawPath(op, path);
            }
            using var fill = new SolidBrush(Color.FromArgb(255, 255, 255, 255));
            g.FillPath(fill, path);
            if (objPath.PointCount > 0) { using var of = new SolidBrush(ObjColor); g.FillPath(of, objPath); }
        }

        // Konum
        int cx = region.Left + region.Width / 2;
        int x = Math.Clamp(cx - W / 2, screen.Left, screen.Right - W);
        int y = pos switch
        {
            // İngilizcenin üstünde: aralarında yarım satır kadar boşluk (iki altyazı birbirine yapışık durmasın)
            SubPosition.Above => AnchorTop() - H + padY / 2 - (int)(fontPx * 0.45) - offsetY * screen.Height / 720,
            SubPosition.Below => region.Bottom - padY / 2,
            _ => region.Bottom - H,
        };
        if (pos == SubPosition.Replace) x = Math.Clamp(region.Left + region.Width / 2 - W / 2, screen.Left, screen.Right - W);
        if (y + H > screen.Bottom) y = region.Top - H + padY / 2;   // altta yer yoksa üste
        if (y < screen.Top) y = Math.Min(region.Bottom, screen.Bottom - H); // üstte yer yoksa alta

        frame?.Dispose();
        frame = bmp;
        framePos = new Point(x, y);
    }

    // ---------------- Oyundaki gibi ----------------
    // İngilizce yazının bulunduğu yer her karede çevresindeki renklerle doldurulur (yazı "silinir"),
    // Türkçesi de tam o noktaya, oyunun yazısıyla aynı boyda ve gölgeyle yazılır.
    // Pencere ekran yakalamaya görünmez; bu yüzden altındaki oyun görüntüsü okunabilir.

    /// <summary>Hangi satır görev hedefi ("Follow Moses"): pembe yazılır. Satır sayısı uymazsa null.</summary>
    public bool[] Objective;
    public bool ObjYellow; // iki konuşmacılı diyalogda alttaki satır sarı, görev pembe
    Color ObjColor => ObjYellow ? Color.FromArgb(255, 255, 215, 94) : Color.FromArgb(255, 255, 122, 200);

    List<Engine.TextBlock> gBlocks;
    string[] gTexts;
    bool[] gBold;
    bool gBoldDone;
    Rectangle gWin, gPatch;
    Bitmap gTextLayer;
    float[] gMinL;   // piksel başına yakın geçmişteki en koyu parlaklık (sabit duran yazıyı zeminden ayırır)

    public void ShowGame(List<Engine.TextBlock> blocks, string[] texts)
    {
        hideLater.Stop();
        bool wasEmpty = text.Length == 0 || alpha == 0;
        text = string.Join("\n", texts);
        shownAt = DateTime.UtcNow;
        gBlocks = blocks; gTexts = texts; gMinL = null;
        gBold = new bool[blocks.Count]; gBoldDone = blocks.Count < 2;
        if (!IsHandleCreated) CreateControl();
        BuildGameLayout();
        RenderGameFrame();
        if (!Visible) Show();
        if (wasEmpty) { alpha = 0; targetAlpha = 255; fade.Start(); }
        else { targetAlpha = 255; alpha = 255; }
        Push();
        patchTimer.Start();
    }

    void StopGame()
    {
        patchTimer.Stop();
        gBlocks = null;
        gTextLayer?.Dispose(); gTextLayer = null;
    }

    void BuildGameLayout()
    {
        if (gBlocks == null || gBlocks.Count == 0) return;
        var screen = Screen.FromRectangle(Rectangle.Round(gBlocks[0].Box)).Bounds;
        var paths = new List<(GraphicsPath Path, float Glyph)>();
        RectangleF patch = RectangleF.Empty, win = RectangleF.Empty;
        using var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Near };
        for (int i = 0; i < gBlocks.Count; i++)
        {
            var b = gBlocks[i];
            float glyph = Math.Max(8f, b.Glyph);
            var cover = RectangleF.FromLTRB(b.Box.Left - glyph * 1.35f, b.Box.Top - glyph * 0.9f, b.Box.Right + glyph * 1.35f, b.Box.Bottom + glyph * 0.9f);
            patch = patch.IsEmpty ? cover : RectangleF.Union(patch, cover);

            float maxW = Math.Min(screen.Width * 0.9f, Math.Max(b.Box.Width * 1.15f, screen.Width * 0.4f));
            var path = new GraphicsPath();
            FontFamily family;
            try { family = new FontFamily(gBold[i] ? "Segoe UI" : "Segoe UI Semibold"); } catch { family = new FontFamily("Segoe UI"); }
            using (family)
                path.AddString(gTexts[i], family, (int)(gBold[i] ? FontStyle.Bold : FontStyle.Regular), glyph * 1.06f, new RectangleF(0, 0, maxW, 10000), fmt);
            var tb = path.GetBounds();
            // Ortası İngilizcenin ortasına, son satırı İngilizcenin son satırına otursun (uzunsa yukarı büyür)
            float dx = b.Box.Left + b.Box.Width / 2 - (tb.Left + tb.Width / 2);
            dx += Math.Max(0, screen.Left - (tb.Left + dx)) - Math.Max(0, tb.Right + dx - screen.Right);
            float dy = b.Box.Bottom + glyph * 0.08f - tb.Bottom;
            using (var m = new Matrix()) { m.Translate(dx, dy); path.Transform(m); }
            paths.Add((path, glyph));
            var pb = RectangleF.Inflate(path.GetBounds(), glyph * 0.5f, glyph * 0.5f);
            win = win.IsEmpty ? pb : RectangleF.Union(win, pb);
        }
        win = RectangleF.Union(win, patch);
        gPatch = Rectangle.Intersect(Rectangle.Round(patch), screen);
        gWin = Rectangle.Intersect(Rectangle.Round(win), screen);

        gTextLayer?.Dispose();
        gTextLayer = new Bitmap(Math.Max(1, gWin.Width), Math.Max(1, gWin.Height), PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(gTextLayer))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.TranslateTransform(-gWin.X, -gWin.Y);
            for (int pi = 0; pi < paths.Count; pi++)
            {
                var (path, glyph) = paths[pi];
                bool isObj = Objective != null && pi < Objective.Length && Objective[pi];
                // Oyun altyazısı gibi: kalın siyah çerçeve yok, yumuşak koyu gölge
                using (var soft = new Pen(Color.FromArgb(70, 0, 0, 0), glyph * 0.32f) { LineJoin = LineJoin.Round })
                    g.DrawPath(soft, path);
                using (var shade = new Pen(Color.FromArgb(185, 0, 0, 0), glyph * 0.13f) { LineJoin = LineJoin.Round })
                    g.DrawPath(shade, path);
                using var fill = new SolidBrush(isObj ? ObjColor : Color.White);
                g.FillPath(fill, path);
                path.Dispose();
            }
        }
    }

    void RenderGameFrame()
    {
        if (gBlocks == null || gTextLayer == null || gPatch.Width < 4 || gPatch.Height < 4) return;
        float k = Math.Min(1f, 640f / gPatch.Width);
        int W = Math.Max(4, (int)Math.Round(gPatch.Width * k)), H = Math.Max(4, (int)Math.Round(gPatch.Height * k));
        Bitmap patchBmp;
        double[] ink;
        using (var cap = Engine.Capture(gPatch))
        using (var small = new Bitmap(W, H, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(small))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g.PixelOffsetMode = PixelOffsetMode.Half;
                g.DrawImage(cap, new Rectangle(0, 0, W, H));
            }
            var boxes = gBlocks.Select(b => new RectangleF(
                (b.Box.Left - b.Glyph * 0.35f - gPatch.X) * k, (b.Box.Top - b.Glyph * 0.3f - gPatch.Y) * k,
                (b.Box.Width + b.Glyph * 0.7f) * k, (b.Box.Height + b.Glyph * 0.6f) * k)).ToList();
            float glyphPx = gBlocks.Max(b => b.Glyph) * k;
            if (gMinL == null || gMinL.Length != W * H) gMinL = null;
            patchBmp = Inpaint(small, boxes, glyphPx, Threshold, gBlocks.Any(b => b.Outline), ref gMinL, out ink);
        }
        // Kalın yazılan görev hedefini ("Follow Moses") kalın yaz
        if (!gBoldDone)
        {
            gBoldDone = true;
            var dens = gBlocks.Select((b, j) => ink[j] / Math.Max(1.0, (b.Box.Width + b.Glyph * 0.7) * (b.Box.Height + b.Glyph * 0.6) * k * k)).ToArray();
            double lo = dens.Min();
            bool changed = false;
            for (int j = 0; j < gBold.Length; j++) { bool bold = dens[j] > lo * 1.35; changed |= bold != gBold[j]; gBold[j] = bold; }
            if (changed) BuildGameLayout();
        }
        using (patchBmp)
        {
            var bmp = new Bitmap(gWin.Width, gWin.Height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g.PixelOffsetMode = PixelOffsetMode.Half;
                g.DrawImage(patchBmp, new Rectangle(gPatch.X - gWin.X, gPatch.Y - gWin.Y, gPatch.Width, gPatch.Height));
                g.DrawImageUnscaled(gTextLayer, 0, 0);
            }
            frame?.Dispose();
            frame = bmp;
            framePos = gWin.Location;
        }
    }

    /// <summary>
    /// Kutuların içindeki parlak yazı piksellerini (ve gölgelerini) çevredeki renklerle doldurur.
    /// Dönen görüntüde yalnızca doldurulan yerler opaktır. ink: kutu başına yazı pikseli sayısı.
    /// </summary>
    static Bitmap Inpaint(Bitmap src, List<RectangleF> boxes, float glyphPx, int threshold, bool outline, ref float[] minL, out double[] ink)
    {
        int W = src.Width, H = src.Height, N = W * H;
        var data = src.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var p = new byte[data.Stride * H];
        Marshal.Copy(data.Scan0, p, 0, p.Length);
        int stride = data.Stride;
        src.UnlockBits(data);

        ink = new double[boxes.Count];
        var m = new float[N]; var tmp = new float[N];
        // Yazı pikselleri: kutuların içinde, yazının kendi parlaklığına yakın ve yanında koyu gölge olan
        // pikseller (açık renk zemin — çakıl, tekne — silinmesin, sadece harfler)
        var boxOf = new sbyte[N];
        var L = new byte[N];
        var hist = new int[256];
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int q = y * W + x, i = y * stride + x * 4;
                L[q] = (byte)(0.299 * p[i + 2] + 0.587 * p[i + 1] + 0.114 * p[i]);
                boxOf[q] = -1;
                for (int j = 0; j < boxes.Count; j++) if (boxes[j].Contains(x, y)) { boxOf[q] = (sbyte)j; break; }
                int sat0 = Math.Max(p[i + 2], Math.Max(p[i + 1], p[i])) - Math.Min(p[i + 2], Math.Min(p[i + 1], p[i]));
                if (boxOf[q] >= 0 && sat0 <= 45) hist[L[q]]++;
            }
        // Kutulardaki en parlak %4'lük kısım yazının kendisidir
        long total = hist.Sum(), acc = 0; int textLum = 255;
        for (int v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.04) { textLum = v; break; } }
        double lumMin = Math.Max(threshold - 35, textLum - 40);
        var lmin = LocalMinBytes(L, W, H, Math.Max(1, (int)Math.Round(glyphPx * 0.12)));
        // Zaman: altyazı sabit durur; kamera oynadıkça altındaki çakıl/taş bir an kararır.
        // Yakın geçmişte kararmış piksel yazı değildir (yoksa bütün satır bulanık bir şeritle dolar).
        if (minL == null) { minL = new float[N]; for (int q = 0; q < N; q++) minL[q] = L[q]; }
        for (int q = 0; q < N; q++) minL[q] = Math.Min(L[q], minL[q] + 4);
        // Konturlu (GTA tarzı) yazıda: yazı pikselinin hemen yanında simsiyah kontur olmalı
        int tOut = 255;
        if (outline)
        {
            var ha = new int[256]; for (int q = 0; q < N; q++) ha[L[q]]++;
            long a = 0; int dk = 255; for (int v = 0; v < 256; v++) { a += ha[v]; if (a >= N * 0.0004) { dk = v; break; } }
            tOut = Math.Min(40, dk + 18);
        }
        for (int q = 0; q < N; q++)
        {
            int j = boxOf[q];
            if (j < 0) continue;
            int i = (q / W) * stride + (q % W) * 4;
            byte bb = p[i], gg = p[i + 1], rr = p[i + 2];
            int mx = Math.Max(rr, Math.Max(gg, bb)), sat = mx - Math.Min(rr, Math.Min(gg, bb)), edge = L[q] - lmin[q];
            bool white = L[q] >= lumMin && sat <= 45 && edge >= 45 && minL[q] >= lumMin - 20 && lmin[q] <= tOut;
            bool vivid = sat >= 60 && mx >= 170 && edge >= 35;
            if (white || vivid) { m[q] = 1; ink[j]++; }
        }
        // Yazının gölgesini/çerçevesini de kapsayacak kadar genişlet
        int dil = Math.Max(1, (int)Math.Round(glyphPx * 0.16));
        BoxBlur(m, tmp, W, H, dil);
        for (int q = 0; q < N; q++) m[q] = m[q] > 0.001f ? 1 : 0;
        // Maskenin dışındaki renklerden doldur (normalize bulanıklaştırma)
        int R = Math.Max(2, (int)Math.Round(glyphPx * 0.8));
        var w = new float[N]; var cr = new float[N]; var cg = new float[N]; var cb = new float[N];
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int q = y * W + x, i = y * stride + x * 4;
                float wt = 1 - m[q];
                w[q] = wt; cb[q] = p[i] * wt; cg[q] = p[i + 1] * wt; cr[q] = p[i + 2] * wt;
            }
        foreach (var a in new[] { w, cr, cg, cb }) { BoxBlur(a, tmp, W, H, R); BoxBlur(a, tmp, W, H, R); }
        var alpha = (float[])m.Clone();
        BoxBlur(alpha, tmp, W, H, 1);

        var outBmp = new Bitmap(W, H, PixelFormat.Format32bppArgb);
        var od = outBmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        var o = new byte[od.Stride * H];
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int q = y * W + x, i = y * od.Stride + x * 4;
                float wt = w[q];
                if (alpha[q] <= 0.001f || wt < 1e-3f) continue;
                o[i] = (byte)Math.Clamp(cb[q] / wt, 0, 255);
                o[i + 1] = (byte)Math.Clamp(cg[q] / wt, 0, 255);
                o[i + 2] = (byte)Math.Clamp(cr[q] / wt, 0, 255);
                o[i + 3] = (byte)Math.Clamp(alpha[q] * 300, 0, 255);
            }
        Marshal.Copy(o, 0, od.Scan0, o.Length);
        outBmp.UnlockBits(od);
        return outBmp;
    }

    /// <summary>r yarıçaplı kare komşulukta en koyu değer.</summary>
    static byte[] LocalMinBytes(byte[] src, int w, int h, int r)
    {
        var tmp = new byte[src.Length]; var o = new byte[src.Length];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                byte m = 255;
                for (int xx = Math.Max(0, x - r), e = Math.Min(w - 1, x + r); xx <= e; xx++) m = Math.Min(m, src[y * w + xx]);
                tmp[y * w + x] = m;
            }
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                byte m = 255;
                for (int yy = Math.Max(0, y - r), e = Math.Min(h - 1, y + r); yy <= e; yy++) m = Math.Min(m, tmp[yy * w + x]);
                o[y * w + x] = m;
            }
        return o;
    }

    /// <summary>Ayrılabilir kutu bulanıklaştırma (yerinde), yarıçap r.</summary>
    static void BoxBlur(float[] a, float[] tmp, int W, int H, int r)
    {
        float n = 2 * r + 1;
        for (int y = 0; y < H; y++)
        {
            int o = y * W; float s = 0;
            for (int x = -r; x <= r; x++) s += a[o + Math.Clamp(x, 0, W - 1)];
            for (int x = 0; x < W; x++)
            {
                tmp[o + x] = s / n;
                s += a[o + Math.Min(W - 1, x + r + 1)] - a[o + Math.Max(0, x - r)];
            }
        }
        for (int x = 0; x < W; x++)
        {
            float s = 0;
            for (int y = -r; y <= r; y++) s += tmp[Math.Clamp(y, 0, H - 1) * W + x];
            for (int y = 0; y < H; y++)
            {
                a[y * W + x] = s / n;
                s += tmp[Math.Min(H - 1, y + r + 1) * W + x] - tmp[Math.Max(0, y - r) * W + x];
            }
        }
    }

    static GraphicsPath Rounded(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        float d = radius * 2;
        if (d <= 0) { p.AddRectangle(r); return p; }
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    /// <summary>Çizilmiş kareyi saydamlık bilgisiyle pencereye bas.</summary>
    void Push()
    {
        if (frame == null || !IsHandleCreated) return;
        IntPtr screenDc = Native.GetDC(IntPtr.Zero);
        IntPtr memDc = Native.CreateCompatibleDC(screenDc);
        IntPtr hBmp = frame.GetHbitmap(Color.FromArgb(0));
        IntPtr old = Native.SelectObject(memDc, hBmp);
        try
        {
            var size = new Native.SIZE(frame.Width, frame.Height);
            var src = new Native.POINT(0, 0);
            var dst = new Native.POINT(framePos.X, framePos.Y);
            var blend = new Native.BLENDFUNCTION
            {
                BlendOp = Native.AC_SRC_OVER,
                SourceConstantAlpha = alpha,
                AlphaFormat = Native.AC_SRC_ALPHA,
            };
            Native.UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, Native.ULW_ALPHA);
        }
        finally
        {
            Native.SelectObject(memDc, old);
            Native.DeleteObject(hBmp);
            Native.DeleteDC(memDc);
            Native.ReleaseDC(IntPtr.Zero, screenDc);
        }
        KeepOnTop();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { fade.Dispose(); hideLater.Dispose(); patchTimer.Dispose(); frame?.Dispose(); gTextLayer?.Dispose(); }
        base.Dispose(disposing);
    }
}
