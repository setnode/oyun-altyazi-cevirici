namespace XCloudCevirici;

/// <summary>Tüm ekranı karartır; kullanıcı altyazı alanını fareyle çizer. Esc: iptal.</summary>
sealed class RegionSelectForm : Form
{
    Point start;
    Rectangle current;
    bool dragging;

    public Rectangle Selected { get; private set; }

    public RegionSelectForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = SystemInformation.VirtualScreen;
        TopMost = true;
        ShowInTaskbar = false;
        BackColor = Color.Black;
        Opacity = 0.45;
        DoubleBuffered = true;
        Cursor = Cursors.Cross;
        KeyPreview = true;
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Activate();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape) { DialogResult = DialogResult.Cancel; Close(); }
        base.OnKeyDown(e);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        dragging = true;
        start = e.Location;
        current = new Rectangle(start, Size.Empty);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (!dragging) return;
        current = Rectangle.FromLTRB(Math.Min(start.X, e.X), Math.Min(start.Y, e.Y), Math.Max(start.X, e.X), Math.Max(start.Y, e.Y));
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (!dragging) return;
        dragging = false;
        if (current.Width < 40 || current.Height < 15) { current = Rectangle.Empty; Invalidate(); return; }
        // Form koordinatı → ekran koordinatı
        Selected = new Rectangle(PointToScreen(current.Location), current.Size);
        DialogResult = DialogResult.OK;
        Close();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var font = new Font("Segoe UI", 16f, FontStyle.Bold, GraphicsUnit.Pixel);
        const string hint = "Altyazının çıktığı alanı fareyle çizin  ·  Esc: iptal";
        var vs = SystemInformation.VirtualScreen;
        var primary = Screen.PrimaryScreen.Bounds;
        var size = TextRenderer.MeasureText(hint, font);
        var at = new Point(primary.Left - vs.Left + (primary.Width - size.Width) / 2, primary.Top - vs.Top + 30);
        TextRenderer.DrawText(e.Graphics, hint, font, at, Color.White);
        if (current.Width > 0)
        {
            using var pen = new Pen(Color.FromArgb(47, 191, 47), 3);
            e.Graphics.DrawRectangle(pen, current);
        }
    }
}
