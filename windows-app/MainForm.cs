namespace XCloudCevirici;

sealed class MainForm : Form
{
    const int HK_TOGGLE = 1, HK_REGION = 2, HK_HIDE = 3;

    readonly Settings S = Settings.Load();
    readonly Engine engine;
    readonly OverlayForm overlay = new();
    readonly MessageReader msgReader = new();
    readonly MessageOverlay msgOverlay = new();
    readonly PhoneOverlay phoneOverlay = new();
    PhoneReader phoneReader;
    readonly CheckBox chkMsg = new();

    readonly Button btnToggle = new();
    readonly Button btnRegion = new();
    readonly Label lblRegion = new();
    readonly ComboBox cmbPosition = new();
    readonly ComboBox cmbStyle = new();
    readonly NumericUpDown numFont = new();
    readonly NumericUpDown numOffset = new();
    readonly ComboBox cmbColor = new();
    readonly TrackBar trkThreshold = new();
    readonly Label lblThreshold = new();
    readonly ComboBox cmbLang = new();
    readonly Label lblStatus = new();
    readonly Label lblSource = new();
    readonly Label lblTranslated = new();

    bool running, busy, overlayHidden;
    CancellationTokenSource loopCts;

    // döngü durumu
    Engine.Signature prevSig;
    bool pending = true;
    DateTime pendingSince = DateTime.MinValue;
    bool freshAgain;
    bool changing; // görüntü bir önceki karede de değişiyordu
    string lastSource = "";
    int emptyCount;
    // Boş okumada altyazıyı tut: parlak zeminde OCR bir an hiçbir şey okuyamıyor ama yazı pikselleri hâlâ
    // yerinde. Bu durumda çeviri silinmez (titreme olmasın), en fazla 2,5 sn.
    const int HoldMs = 2500;
    Engine.Signature shownSig;
    DateTime holdSince = DateTime.MinValue;
    int mixedCaseSeen; // son altyazılar normal (küçük harfli) yazılıyor mu

    static readonly (string Code, string Name)[] Languages =
        { ("tr", "Türkçe"), ("en", "İngilizce"), ("de", "Almanca"), ("fr", "Fransızca"), ("es", "İspanyolca"), ("ar", "Arapça"), ("ru", "Rusça") };

    static readonly string[] PositionNames =
    {
        "İngilizcenin üstünde  (yayında görünür)", "İngilizcenin altında  (yayında görünür)",
        "Koyu kutuyla örtülü  (yayında görünmez)", "İngilizceyi sil, yerine yaz  (deneysel, yayında görünmez)",
    };

    public MainForm()
    {
        engine = new Engine(S);
        phoneReader = new PhoneReader(msgReader);
        engine.StillShown = src => lastSource.Contains(src.Trim()) || (msgReader.ShownSrc?.Contains(src.Trim()) ?? false) || phoneReader.ShownSrcs.Any(x => x.Contains(src.Trim()));
        // DeepL çevirisi geldi: altyazı hâlâ ekrandaysa Google çevirisinin yerine geçer (ilk gösterim beklemez)
        engine.DeeplUpgraded += orig => BeginInvoke(new Action(async () =>
        {
            string src = lastSource;
            if (!running || src.Length == 0 || !src.Split('\n').Any(b => b.Trim() == orig.Trim())) return;
            try { var tr = await TranslateAllAsync(src); if (lastSource == src) ShowTranslation(src, tr, lastBlocks); } catch { }
        }));
        // Sabit konum seçilince/yükseltilince kaydet: bir dahaki açılışta da aynı yer
        overlay.AnchorChanged += y => { if (fullMode) S.FullAnchorY = y; else S.AnchorY = y; S.Save(); };
        Text = "xCloud Altyazı Çevirici";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9.5f);
        ClientSize = new Size(470, 638);
        BuildUi();
        LoadUi();
    }

    void BuildUi()
    {
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(14), ColumnCount = 2, AutoSize = false };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(root);

        btnToggle.Text = "▶  Başlat (F8)";
        btnToggle.Dock = DockStyle.Fill;
        btnToggle.Font = new Font("Segoe UI Semibold", 11f);
        btnToggle.BackColor = Color.FromArgb(16, 124, 16);
        btnToggle.ForeColor = Color.White;
        btnToggle.FlatStyle = FlatStyle.Flat;
        btnToggle.Click += (_, _) => Toggle();
        root.Controls.Add(btnToggle, 0, 0);
        root.SetColumnSpan(btnToggle, 2);
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));

        btnRegion.Text = "Bölge seç (F9)";
        btnRegion.Click += (_, _) => SelectRegion();
        AddRow(root, btnRegion, lblRegion);

        var btnTest = new Button { Text = "Önizle" };
        btnTest.Click += async (_, _) =>
        {
            ApplyOverlay();
            overlay.Objective = null; overlay.ShowText("Patronum senden borcunu ödemeni istememi söyledi.");
            Status("Önizleme 4 sn gösteriliyor");
            await Task.Delay(4000);
            if (!running) overlay.ShowText("");
        };
        AddRow(root, btnTest, Lbl("Altyazının görünümünü ve yerini gösterir"));

        cmbPosition.DropDownStyle = ComboBoxStyle.DropDownList;
        cmbPosition.Items.AddRange(PositionNames);
        cmbPosition.SelectedIndexChanged += (_, _) => { S.Position = (SubPosition)cmbPosition.SelectedIndex; Changed(false); };
        AddRow(root, Lbl("Konum"), cmbPosition);

        cmbStyle.DropDownStyle = ComboBoxStyle.DropDownList;
        cmbStyle.Items.AddRange(new object[] { "Sinema (çerçeveli yazı)", "Yarı saydam kutu" });
        cmbStyle.SelectedIndexChanged += (_, _) => { S.Boxed = cmbStyle.SelectedIndex == 1; Changed(false); };
        AddRow(root, Lbl("Görünüm"), cmbStyle);

        numFont.Minimum = 16; numFont.Maximum = 72;
        numFont.ValueChanged += (_, _) => { S.FontSize = (int)numFont.Value; Changed(false); };
        AddRow(root, Lbl("Yazı boyutu"), numFont);

        numOffset.Minimum = -20; numOffset.Maximum = 80; numOffset.Increment = 2;
        numOffset.ValueChanged += (_, _) => { S.OffsetY = (int)numOffset.Value; Changed(false); };
        AddRow(root, Lbl("Dikey konum (artı = yukarı)"), numOffset);

        cmbColor.DropDownStyle = ComboBoxStyle.DropDownList;
        cmbColor.Items.AddRange(new object[] { "Beyaz / açık renk", "Diğer renkler" });
        cmbColor.SelectedIndexChanged += (_, _) => { S.BrightText = cmbColor.SelectedIndex == 0; Changed(true); };
        AddRow(root, Lbl("Oyun altyazı rengi"), cmbColor);

        trkThreshold.Minimum = 100; trkThreshold.Maximum = 240; trkThreshold.TickFrequency = 10; trkThreshold.SmallChange = 5; trkThreshold.LargeChange = 10;
        trkThreshold.ValueChanged += (_, _) => { S.Threshold = trkThreshold.Value; lblThreshold.Text = "Parlaklık eşiği: " + S.Threshold; Changed(true); };
        lblThreshold.AutoSize = true; lblThreshold.Anchor = AnchorStyles.Left;
        AddRow(root, lblThreshold, trkThreshold);

        cmbLang.DropDownStyle = ComboBoxStyle.DropDownList;
        foreach (var l in Languages) cmbLang.Items.Add(l.Name);
        cmbLang.SelectedIndexChanged += (_, _) => { S.TargetLang = Languages[Math.Max(0, cmbLang.SelectedIndex)].Code; Changed(true); };
        AddRow(root, Lbl("Çeviri dili"), cmbLang);

        // DeepL: gecikme eklemez, arka planda önbelleği iyileştirir
        txtDeepl.UseSystemPasswordChar = true;
        txtDeepl.PlaceholderText = "DeepL API anahtarı (isteğe bağlı)";
        txtDeepl.Leave += async (_, _) => await SaveDeeplAsync();
        txtDeepl.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await SaveDeeplAsync(); } };
        AddRow(root, lblDeepl, txtDeepl);

        chkMsg.Text = "mesaj kutusu + eldeki telefon ekranı";
        chkMsg.CheckedChanged += (_, _) =>
        {
            S.MsgOn = chkMsg.Checked;
            if (!S.MsgOn) { msgOverlay.HideNow(); msgReader.Reset(); phoneOverlay.HideNow(); phoneReader.Reset(); }
            Changed(false);
        };
        AddRow(root, Lbl("Telefon mesajları"), chkMsg);

        lblStatus.AutoSize = false; lblStatus.Dock = DockStyle.Fill; lblStatus.ForeColor = Color.DimGray;
        root.Controls.Add(lblStatus); root.SetColumnSpan(lblStatus, 2);
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));

        foreach (var (lbl, color) in new[] { (lblSource, Color.Gray), (lblTranslated, Color.Black) })
        {
            lbl.AutoSize = false; lbl.Dock = DockStyle.Fill; lbl.ForeColor = color;
            root.Controls.Add(lbl); root.SetColumnSpan(lbl, 2);
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        }
        lblTranslated.Font = new Font("Segoe UI Semibold", 10f);

        var help = new Label
        {
            Text = "F8 başlat/durdur · F9 bölge seç · F10 gizle/göster\nDiscord'da altyazının görünmesi için yayında \"Ekran\"ı paylaşın (sadece pencere değil).",
            AutoSize = false, Dock = DockStyle.Fill, ForeColor = Color.Gray,
        };
        root.Controls.Add(help); root.SetColumnSpan(help, 2);
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
    }

    static Label Lbl(string t) => new() { Text = t, AutoSize = true, Anchor = AnchorStyles.Left };

    static void AddRow(TableLayoutPanel root, Control left, Control right)
    {
        left.Dock = left is Button ? DockStyle.Fill : DockStyle.None;
        right.Dock = DockStyle.Fill;
        root.Controls.Add(left);
        root.Controls.Add(right);
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
    }

    readonly TextBox txtDeepl = new();
    readonly Label lblDeepl = Lbl("DeepL");

    async Task SaveDeeplAsync()
    {
        string key = txtDeepl.Text.Trim();
        if (key == (S.DeeplKey ?? "") && lblDeepl.Text != "DeepL") return;
        S.DeeplKey = key; S.Save();
        if (key.Length == 0) { lblDeepl.Text = "DeepL: kapalı"; return; }
        lblDeepl.Text = "DeepL: deneniyor…";
        try
        {
            var (used, limit) = await Engine.DeeplUsageAsync(key);
            lblDeepl.Text = "DeepL ✓ " + (limit > 0 ? (100 * used / limit) + "% kota" : "");
        }
        catch (Exception e) { lblDeepl.Text = "DeepL ✗"; lblStatus.Text = "DeepL bağlanamadı: " + e.Message; }
    }

    bool loading;
    void LoadUi()
    {
        loading = true;
        txtDeepl.Text = S.DeeplKey ?? "";
        chkMsg.Checked = S.MsgOn;
        if (txtDeepl.Text.Length > 0) _ = SaveDeeplAsync();
        cmbPosition.SelectedIndex = Math.Clamp((int)S.Position, 0, PositionNames.Length - 1);
        cmbStyle.SelectedIndex = S.Boxed ? 1 : 0;
        numFont.Value = Math.Clamp(S.FontSize, 16, 72);
        numOffset.Value = Math.Clamp(S.OffsetY, -20, 80);
        cmbColor.SelectedIndex = S.BrightText ? 0 : 1;
        trkThreshold.Value = Math.Clamp(S.Threshold, 100, 240);
        lblThreshold.Text = "Parlaklık eşiği: " + S.Threshold;
        cmbLang.SelectedIndex = Math.Max(0, Array.FindIndex(Languages, l => l.Code == S.TargetLang));
        UpdateRegionLabel();
        loading = false;
    }

    void ApplyOverlay()
    {
        overlay.Threshold = S.Threshold;
        var r = CurRegion();
        overlay.Configure(r, S.Position, S.Boxed, S.FontSize, S.OffsetY);
        int a = fullMode ? S.FullAnchorY : S.AnchorY;
        overlay.SetAnchor(a > 0 ? a : null);
    }

    void Changed(bool resetDetection)
    {
        if (loading) return;
        S.Save();
        if (resetDetection) ResetDetection();
        ApplyOverlay();
        if ((S.Position == SubPosition.Replace || S.Position == SubPosition.Game) && !overlay.CanHideFromCapture)
            Status("Bu Windows sürümünde \"yerine\" modları yok; üstünde gösterilecek.");
    }

    // ---- Tam ekran: pencere modunda seçilen bölge tam ekranda yanlış yere düşer ----
    bool fullMode;
    Rectangle fullMon;

    /// <summary>Öndeki (bizim olmayan) pencere monitörü tamamen kaplıyorsa tam ekran sayılır.</summary>
    void UpdateFullMode()
    {
        var fg = Native.GetForegroundWindow();
        if (fg == IntPtr.Zero) return;
        Native.GetWindowThreadProcessId(fg, out var pid);
        if (pid == (uint)Environment.ProcessId) return; // kendi penceremiz önde → önceki durum korunur
        var sb = new System.Text.StringBuilder(64);
        Native.GetClassName(fg, sb, 64);
        var cls = sb.ToString();
        if (cls is "Progman" or "WorkerW" or "Shell_TrayWnd") return; // masaüstü / görev çubuğu
        if (!Native.GetWindowRect(fg, out var wr)) return;
        var mon = Screen.FromHandle(fg).Bounds;
        bool full = wr.Left <= mon.Left && wr.Top <= mon.Top && wr.Right >= mon.Right && wr.Bottom >= mon.Bottom;
        if (full == fullMode && (!full || mon == fullMon)) return;
        fullMode = full; fullMon = mon;
        ResetDetection();
        msgOverlay.HideNow(); msgReader.Reset();
        phoneOverlay.HideNow(); phoneReader.Reset();
        overlay.HideNow();
        ApplyOverlay();
        UpdateRegionLabel();
    }

    Rectangle CurRegion()
    {
        if (!fullMode || fullMon.Width <= 0) return S.Region;
        var m = fullMon;
        bool set = S.FullW > 0.02 && S.FullH > 0.01;
        double x = set ? S.FullX : 0.15, y = set ? S.FullY : 0.80, w = set ? S.FullW : 0.70, h = set ? S.FullH : 0.17;
        return new Rectangle(m.Left + (int)(m.Width * x), m.Top + (int)(m.Height * y), (int)(m.Width * w), (int)(m.Height * h));
    }

    void ResetDetection() { prevSig = null; pending = true; lastSource = ""; }

    void UpdateRegionLabel() =>
        lblRegion.Text = fullMode
            ? (S.FullW > 0.02 ? "Tam ekran bölgesi (seçili)" : "Tam ekran · varsayılan alt bant")
            : S.HasRegion ? $"{S.RegionW}×{S.RegionH} @ {S.RegionX},{S.RegionY}" : "Henüz seçilmedi";

    void Status(string t) => lblStatus.Text = t;

    // ---------------- Yaşam döngüsü ----------------

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        overlay.CreateControl();
        GC.KeepAlive(overlay.Handle); // pencereyi şimdi oluştur
        msgOverlay.CreateControl();
        GC.KeepAlive(msgOverlay.Handle);
        phoneOverlay.CreateControl();
        GC.KeepAlive(phoneOverlay.Handle);
        msgReader.Init(); // telefon mesajları için ayrı OCR motoru (altyazıyı bekletmez)
        Native.RegisterHotKey(Handle, HK_TOGGLE, Native.MOD_NOREPEAT, (uint)Keys.F8);
        Native.RegisterHotKey(Handle, HK_REGION, Native.MOD_NOREPEAT, (uint)Keys.F9);
        Native.RegisterHotKey(Handle, HK_HIDE, Native.MOD_NOREPEAT, (uint)Keys.F10);

        if (!engine.InitOcr(out var err)) Status(err);
        else Status($"Hazır · OCR dili: {engine.OcrLanguage}");

        if (!S.HasRegion)
        {
            var b = Screen.PrimaryScreen.Bounds;
            S.Region = new Rectangle(b.Left + (int)(b.Width * 0.15), b.Top + (int)(b.Height * 0.84), (int)(b.Width * 0.70), (int)(b.Height * 0.13));
            S.Save();
            UpdateRegionLabel();
        }
        ApplyOverlay();
        _ = engine.WarmUpAsync(); // çeviri bağlantısını önceden aç → ilk çeviri hızlı gelir
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Native.WM_HOTKEY)
        {
            switch ((int)m.WParam)
            {
                case HK_TOGGLE: Toggle(); break;
                case HK_REGION: SelectRegion(); break;
                case HK_HIDE:
                    overlayHidden = !overlayHidden;
                    if (overlayHidden) { overlay.HideNow(); msgOverlay.HideNow(); phoneOverlay.HideNow(); }
                    Status(overlayHidden ? "Çeviri gizlendi (F10 ile geri aç)" : "Çeviri görünür");
                    break;
            }
        }
        base.WndProc(ref m);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        engine.SaveCache();
        loopCts?.Cancel();
        Native.UnregisterHotKey(Handle, HK_TOGGLE);
        Native.UnregisterHotKey(Handle, HK_REGION);
        Native.UnregisterHotKey(Handle, HK_HIDE);
        S.Save();
        overlay.Close();
        msgOverlay.Close();
        phoneOverlay.Close();
        base.OnFormClosing(e);
    }

    // ---------------- Komutlar ----------------

    void Toggle()
    {
        running = !running;
        btnToggle.Text = running ? "■  Durdur (F8)" : "▶  Başlat (F8)";
        btnToggle.BackColor = running ? Color.FromArgb(180, 40, 40) : Color.FromArgb(16, 124, 16);
        if (running)
        {
            ResetDetection();
            ApplyOverlay();
            loopCts = new CancellationTokenSource();
            _ = Loop(loopCts.Token);
            _ = MsgLoop(loopCts.Token);
            Status("Çalışıyor · altyazı bekleniyor…");
        }
        else
        {
            loopCts?.Cancel();
            overlay.HideNow();
            msgOverlay.HideNow(); msgReader.Reset();
            phoneOverlay.HideNow(); phoneReader.Reset();
            Status("Durduruldu");
        }
    }

    void SelectRegion()
    {
        UpdateFullMode(); // F9 oyun öndeyken basılırsa tam ekran durumu doğru bilinsin
        overlay.HideNow();
        using var f = new RegionSelectForm();
        if (f.ShowDialog() == DialogResult.OK)
        {
            if (fullMode)
            {
                var m = Screen.FromRectangle(f.Selected).Bounds;
                fullMon = m;
                S.FullX = (f.Selected.X - m.Left) / (double)m.Width;
                S.FullY = (f.Selected.Y - m.Top) / (double)m.Height;
                S.FullW = f.Selected.Width / (double)m.Width;
                S.FullH = f.Selected.Height / (double)m.Height;
                S.FullAnchorY = 0;
            }
            else
            {
                S.Region = f.Selected;
                S.AnchorY = 0; // yeni bölge → sabit konum ilk altyazıda yeniden seçilir
            }
            S.Save();
            UpdateRegionLabel();
            ResetDetection();
            ApplyOverlay();
            Status("Bölge kaydedildi");
        }
    }

    // ---------------- Ana döngü ----------------

    async Task Loop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(Math.Clamp(S.IntervalMs, 80, 1000), ct); }
            catch (TaskCanceledException) { return; }
            if (busy) continue;
            busy = true;
            try { await Tick(); }
            catch (Exception ex) { Status("Hata: " + ex.Message); pending = true; }
            finally { busy = false; }
        }
    }

    // Telefon mesajı okuyucusu: kendi döngüsü (250 ms), kendi OCR motoru; altyazı döngüsünü hiç bekletmez
    async Task MsgLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(250, ct); }
            catch (TaskCanceledException) { return; }
            if (!S.MsgOn || !S.HasRegion || S.TargetLang == "en") continue;
            try
            {
                // Önce eldeki telefon: açıksa sağ alttaki mesaj kutusu çıkmaz, ekranı telefon okuyucusu çevirir
                var (scr, phHide) = await phoneReader.StepAsync(CurRegion());
                if (phHide) phoneOverlay.HideNow();
                if (phoneReader.Ok && phoneReader.Box is Rectangle phBox)
                {
                    msgOverlay.HideNow(); msgReader.Reset();
                    phoneOverlay.Follow(phBox); // telefon yer değiştirince panel de onunla gider
                    if (scr != null)
                    {
                        var trs = await Task.WhenAll(scr.Bubbles.Select(async b =>
                        {
                            if (phoneReader.FindMemo(b.Text) is { Tr: not null } mm) return mm.Tr;
                            try
                            {
                                var t = await engine.TranslateKeepingNamesAsync(MessageReader.SmsAc(b.Text));
                                if (string.IsNullOrWhiteSpace(t)) return b.Text;
                                phoneReader.Remember(b.Text, t.Trim(), b.Q);
                                return t.Trim();
                            }
                            catch { return b.Text; }
                        }));
                        if (running && !ct.IsCancellationRequested && phoneReader.Box != null)
                        {
                            phoneReader.ShownKey = scr.Key;
                            phoneReader.ShownQ = scr.Q;
                            phoneReader.ShownKeys = scr.Bubbles.Select(PhoneReader.KeyOf).ToList();
                            phoneReader.ShownTitle = scr.Title;
                            phoneReader.ShownSrcs = scr.Bubbles.Select(b => MessageReader.SmsAc(b.Text)).ToList();
                            if (!overlayHidden) phoneOverlay.ShowScreen(scr.Title, scr.Bubbles.Select((b, i) => ((b.From.Length > 0 ? b.From + ": " : "") + trs[i], b.Out)).ToList(), phoneReader.Box.Value, S.FontSize);
                        }
                    }
                    continue;
                }
                var (msg, hide) = await msgReader.StepAsync(CurRegion());
                if (hide) { msgOverlay.HideNow(); continue; }
                if (msg == null) continue;
                var tr = await engine.TranslateKeepingNamesAsync(MessageReader.SmsAc(msg.Body));
                if (string.IsNullOrWhiteSpace(tr) || !running || ct.IsCancellationRequested) continue;
                if (msgReader.ShownSrc != msg.Body) continue; // bu arada başka mesaj geldi
                if (!overlayHidden) msgOverlay.ShowMessage(msg.Sender, tr.Trim(), msg.Box, S.FontSize);
            }
            catch { /* mesaj okunamadı: altyazıyı etkilemesin */ }
        }
    }

    // Mesaj kutusu görünürken o alanı altyazı görüntüsünde boya: mesaj metni altyazı sanılmasın
    void MaskMessage(Bitmap shot, Rectangle region)
    {
        var list = new List<Rectangle>();
        if (msgReader.Mask is Rectangle m) list.Add(m);
        if (phoneReader.Masks is { } pm) list.AddRange(pm);
        // Sağ alttaki tuş ipuçları ("SELECT Ⓐ / BACK Ⓑ / EXIT Ⓑ") hiçbir zaman altyazı değildir (altyazı ortalıdır)
        if (S.MsgOn)
        {
            var scr = Screen.FromRectangle(region).Bounds;
            list.Add(Rectangle.FromLTRB(scr.Left + (int)(scr.Width * 0.85), scr.Top + (int)(scr.Height * 0.78), scr.Right, scr.Bottom));
            // Sağ alttaki arama/mesaj bildirimi ("Brian · Call Ended"): altyazı satırına "Brian" eklenmesin
            list.Add(Rectangle.FromLTRB(scr.Left + (int)(scr.Width * 0.77), scr.Top + (int)(scr.Height * 0.86), scr.Right, scr.Bottom));
        }
        if (list.Count == 0) return;
        using var g = Graphics.FromImage(shot);
        using var b = new SolidBrush(S.BrightText ? Color.Black : Color.White);
        foreach (var mm in list)
        {
            var r = Rectangle.Intersect(mm, region);
            if (!r.IsEmpty) g.FillRectangle(b, r.X - region.X, r.Y - region.Y, r.Width, r.Height);
        }
    }

    Task<Engine.ReadResult> ReadRegionAsync(Bitmap shot, bool colored, Rectangle region, bool textured = false, bool forced = false) =>
        engine.ReadAsync(shot, colored, region, textured, forced);

    async Task Tick()
    {
        if (!S.HasRegion) { Status("Önce F9 ile altyazı bölgesini seçin"); return; }
        overlay.KeepOnTop(); msgOverlay.KeepOnTop(); phoneOverlay.KeepOnTop();
        UpdateFullMode();
        var region = CurRegion();
        using var shot = Engine.Capture(region);
        MaskMessage(shot, region);
        var sig = engine.MakeSignature(shot);

        // Bölgede yazı yok → kısa bir gecikmeyle çeviriyi kaldır
        // Konturlu yazı okunan oyunda (GTA) dokulu zeminde konturlu piksel kalmadıysa altyazı bitmiştir
        bool outlineGone = sig.OValues != null && engine.LastOutline && sig.OBright / (double)sig.N < Engine.MinInk;
        if (S.BrightText && (sig.Bright / (double)sig.N < Engine.MinInk || outlineGone))
        {
            prevSig = sig; pending = true; pendingSince = DateTime.UtcNow; changing = false;
            if (++emptyCount >= 3) ClearText();
            return;
        }
        emptyCount = 0;

        double d = engine.Diff(prevSig, sig);
        prevSig = sig;
        double limit = S.BrightText ? 30 : 8;
        var now = DateTime.UtcNow;
        engine.WarmNetwork(); // çeviri bağlantısı soğumasın (20 sn'de bir)
        bool forced = false; // görüntü hâlâ değişirken, beklemekten vazgeçip okuyoruz
        // Yeni bir değişim başladı ya da eski yazı sönerken okuma bitmişti (yeni satır hemen ardından
        // geliyor) ya da ilk karedeki okuma zayıftı: beklemeden oku
        bool fresh = d > limit && (!changing || !pending || freshAgain);
        if (d > limit) freshAgain = false;
        changing = d > limit;
        // Konturlu oyunda (GTA) yeni yazının ilk karesinde hemen oku: iyi okunduysa hemen gösterilir,
        // görüntü durulunca bir kez daha okunup gerekirse düzeltilir
        if (fresh && engine.OutlineGame)
        {
            if (!pending) { pending = true; pendingSince = now; }
            forced = true;
        }
        else if (d > limit)
        {
            // Yazı değişiyor (belirme efekti) → bir sonraki sabit karede oku (en fazla 1 sn bekle)
            if (!pending) { pending = true; pendingSince = now; }
            // en fazla 0,4 sn bekle; konturlu oyunda (GTA) okuma ~0,1 sn: kamera hareketliyken 0,2 sn'de bir oku
            if ((now - pendingSince).TotalMilliseconds < (engine.OutlineGame ? 200 : 400)) return;
            forced = true;
        }
        if (!pending) return;
        // Sahne geçişinde (yazı yeni belirirken) yapılan zorunlu okuma yarım/bozuk olabilir: bu durumda
        // okuma "bitti" sayılmaz, görüntü durulunca bir kez daha okunur — yoksa altyazı tamamen kaçar
        void Settle() { pending = forced; if (forced) pendingSince = DateTime.UtcNow; }

        var read = await ReadRegionAsync(shot, sig.Colored, region, sig.OValues != null, forced);
        // Sahne geçişinde yapılan zorunlu okuma zayıfsa gösterme: görüntü durulunca yapılacak okumayı bekle
        if (forced && engine.LastWeak) { Settle(); freshAgain = engine.OutlineGame; return; }
        string text = read.Text;
        // Oyun altyazıları normal yazılıyken tek başına çıkan BÜYÜK HARF yazı arayüzdür ("NIPPER .38 PISTOL")
        bool capsOnly = text.Length > 0 && Engine.IsCapsText(text);
        if (text.Length == 0 && lastSource.Length > 0 && S.BrightText && Engine.KeptInk(shownSig, sig) >= 0.75)
        {
            if (holdSince == DateTime.MinValue) holdSince = DateTime.UtcNow;
            if ((DateTime.UtcNow - holdSince).TotalMilliseconds < HoldMs) { pending = true; return; }   // yazı yerinde: bırakma, yeniden dene
        }
        if (text.Length == 0 || (capsOnly && mixedCaseSeen >= 2))
        {
            Settle();
            if (++emptyCount >= 3) ClearText();
            return;
        }
        holdSince = DateTime.MinValue; shownSig = sig;
        mixedCaseSeen = capsOnly ? Math.Max(0, mixedCaseSeen - 1) : Math.Min(3, mixedCaseSeen + 1);
        text = Engine.GorevOnar(text);
        // Yarım okunan altyazının tamamı geldiyse benzer sayma, yeniden çevir
        // Aynı altyazı daha çok kelimeyle okunduysa (ilk okuma kelime yutmuş: "I need a" → "I need a lawyer") yeniden çevir
        bool moreWords = Engine.WordCount(text) > Engine.WordCount(lastSource) && Engine.Similar(text, lastSource);
        if (!moreWords && !Engine.Uzadi(text, lastSource) && !Engine.BlokDegisti(text, lastSource))
        {
            if (Engine.Similar(text, lastSource)) { Settle(); return; }
            // Önceki altyazının bir parçasıysa (sönerken yarım okuma) yeni altyazı sayma
            // (diyalog bitip sadece görev hedefi kaldıysa — daha az blok — bu yeni bir durumdur)
            if (IsFragmentOf(text, lastSource)) { Settle(); return; }
            if (Engine.SameSubtitle(text, lastSource)) { Settle(); return; }
        }

        // Çeviri doğrulamayla aynı anda başlasın (önbelleği ısıtır; doğrulama tutmazsa sonuç kullanılmaz)
        _ = TranslateAllAsync(text).ContinueWith(_ => { }, TaskScheduler.Default);
        // Doğrulama: hemen ikinci bir kare oku; iki okuma uyuşmazsa geçiş anıdır → bekle
        using (var shot2 = Engine.Capture(region))
        {
            MaskMessage(shot2, region);
            var read2 = await ReadRegionAsync(shot2, sig.Colored, region, sig.OValues != null);
            if (!Engine.Similar(text, read2.Text)) { pending = true; return; }
            if (read2.Text.Length > text.Length) { read = read2; text = Engine.GorevOnar(read2.Text); } // daktilo efektinde daha uzun olanı al
        }
        pending = false;
        lastSource = text;
        lblSource.Text = text.Replace("\n", "  ·  ");
        if (read.Blocks.Count > 0)
        {
            var b0 = read.Blocks.OrderBy(b => b.Box.Top).First();
            int lineH = (int)(b0.Box.Height / Math.Max(1, b0.Text.Split('\n').Length) * 1.3);
            overlay.NoteTextTop((int)b0.Box.Top, lineH);
        }

        // Çeviri arka planda: tarama beklemez, internet yavaşken gelen yeni altyazı da kaçmaz
        lastBlocks = read.Blocks;
        _ = TranslateAndShowAsync(text, read.Blocks);
    }

    List<Engine.TextBlock> lastBlocks;

    static bool IsFragmentOf(string text, string previous)
    {
        if (text.Split('\n').Length < previous.Split('\n').Length) return false;
        static string N(string t) => new string(t.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
        string a = N(text), b = N(previous);
        return b.Length > 0 && a.Length < b.Length && b.Contains(a);
    }

    void ShowTranslation(string source, string tr, List<Engine.TextBlock> blocks, bool translated = true)
    {
        if (!running || lastSource != source || string.IsNullOrEmpty(tr)) return;
        lblTranslated.Text = tr.Replace("\n", "  ·  ");
        if (overlayHidden) return;
        var parts = tr.Split('\n');
        var obj = Engine.ObjectiveFlags(source);
        overlay.Objective = obj.Length == parts.Length ? obj : null;
        overlay.ObjYellow = source.Contains('\n');
        if (overlay.EffectivePosition == SubPosition.Game && blocks != null && blocks.Count == parts.Length)
        {
            // Çeviri gelmediyse İngilizceyi silme: oyunun kendi yazısı görünür kalsın
            if (translated) overlay.ShowGame(blocks, parts);
        }
        else overlay.ShowText(tr);
    }

    // Her blok (diyalog, görev hedefi) ayrı çevrilir; böylece ikisi tek cümleye karışmaz
    async Task<string> TranslateAllAsync(string text) =>
        string.Join("\n", await Task.WhenAll(text.Split('\n').Select(TranslateBlockAsync)));

    // Az önce ekranda gösterilen satır yeniden çizilirse (ör. üstündeki diyalog kalktı) aynı çeviri
    // kullanılır: arada önbelleğe DeepL çevirisi yazılmış olsa bile ekrandaki yazı değişmesin
    readonly Dictionary<string, (string Tr, DateTime At)> recentTr = new();
    static readonly System.Text.RegularExpressions.Regex Miriltı = new(@"^(?:[\s.,!?…""'“”-]*(?:m+h*m+|m*h+m+|mm+-?hm+|uh+-?h?uh+|uh+-?uh+|u+m+|u+h+|e+r+m+|hm+-?mm*))+[\s.,!?…""'“”-]*$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    static readonly System.Text.RegularExpressions.Regex Seslenme = new(@"^(?:\p{Lu}\p{Ll}{2,}[!?,.…]*\s*){2,4}$");

    async Task<string> TranslateBlockAsync(string block)
    {
        // "Mmhmm…", "Hmm.", "Uh-huh" gibi mırıltılar çevrilmez (Google "Mıhmm…" yapıyor)
        if (Miriltı.IsMatch(block)) return block;
        lock (recentTr)
            if (recentTr.TryGetValue(block, out var seen) && (DateTime.UtcNow - seen.At).TotalSeconds < 90)
            {
                recentTr[block] = (seen.Tr, DateTime.UtcNow);
                return seen.Tr;
            }
        // "Chester! Shanese!": yalnızca büyük harfli tek kelimelerden oluşan seslenme; her kelime tek başına
        // çevrilince aynı kalıyorsa hepsi isimdir, satır olduğu gibi gösterilir (Google "Şa nese" yapıyor)
        if (Seslenme.IsMatch(block))
        {
            var ws = System.Text.RegularExpressions.Regex.Matches(block, @"\p{Lu}\p{Ll}+").Select(m => m.Value).ToList();
            var tek = await Task.WhenAll(ws.Select(async w => { try { return (await engine.TranslateAsync(w) ?? "").Trim().TrimEnd('.', '!', '?'); } catch { return ""; } }));
            if (ws.Zip(tek, (w, t) => string.Equals(w, t, StringComparison.OrdinalIgnoreCase)).All(x => x)) return block;
        }
        var tr = await engine.TranslateKeepingNamesAsync(block);
        if (!string.IsNullOrEmpty(tr))
            lock (recentTr)
            {
                if (recentTr.Count > 200)
                    foreach (var k in recentTr.Where(kv => (DateTime.UtcNow - kv.Value.At).TotalSeconds > 90).Select(kv => kv.Key).ToList()) recentTr.Remove(k);
                recentTr[block] = (tr, DateTime.UtcNow);
            }
        return tr;
    }

    async Task TranslateAndShowAsync(string text, List<Engine.TextBlock> blocks)
    {
        try
        {
            ShowTranslation(text, await TranslateAllAsync(text), blocks);
            Status("Çalışıyor");
            return;
        }
        catch
        {
            // Çeviri gelmezse en azından orijinal yazı ekranda kalsın, sonra tekrar dene
            ShowTranslation(text, text, blocks, translated: false);
            Status("Çeviri gecikti — tekrar deneniyor");
        }
        await Task.Delay(800);
        if (lastSource != text) return;
        try
        {
            ShowTranslation(text, await TranslateAllAsync(text), blocks);
            Status("Çalışıyor");
        }
        catch (Exception ex)
        {
            if (lastSource == text) Status("Çeviri yapılamadı: " + ex.Message);
        }
    }

    void ClearText()
    {
        lastSource = ""; shownSig = null; holdSince = DateTime.MinValue;
        overlay.ShowText("");
    }
}
