namespace XCloudCevirici;

static class Program
{
    [STAThread]
    static void Main()
    {
        using var single = new Mutex(true, "XCloudCevirici.TekKopya", out bool first);
        if (!first)
        {
            MessageBox.Show("xCloud Altyazı Çevirici zaten açık.", "xCloud Altyazı Çevirici");
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
