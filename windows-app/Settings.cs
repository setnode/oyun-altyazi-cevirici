using System.Text.Json;

namespace XCloudCevirici;

/// <summary>Çevirinin ekrandaki yeri.</summary>
public enum SubPosition
{
    Above = 0,   // İngilizce altyazının üstünde (Discord yayınında görünür)
    Below = 1,   // İngilizce altyazının altında (Discord yayınında görünür)
    Replace = 2, // İngilizcenin yerine, koyu kutuyla (yayında görünmez)
    Game = 3,    // İngilizce silinir, Türkçesi aynı yere aynı boyda yazılır (deneysel, yayında görünmez)
}

/// <summary>Kullanıcı ayarları: %APPDATA%\XCloudCevirici\ayarlar.json</summary>
public sealed class Settings
{
    public int Version { get; set; }
    public int RegionX { get; set; }
    public int RegionY { get; set; }
    public int RegionW { get; set; }
    public int RegionH { get; set; }
    public bool BrightText { get; set; } = true;      // beyaz/açık altyazı
    public int Threshold { get; set; } = 175;
    public SubPosition Position { get; set; } = SubPosition.Above;
    public bool Boxed { get; set; }                   // false: sinema tarzı çerçeveli yazı, true: yarı saydam kutu
    public int FontSize { get; set; } = 30;
    public int OffsetY { get; set; }                   // dikey ince ayar (720p'ye göre piksel; artı = yukarı)
    public int AnchorY { get; set; }
    // Tam ekran bölgesi: monitörün oranı olarak (0 = seçilmedi → varsayılan alt bant)
    public double FullX { get; set; }
    public double FullY { get; set; }
    public double FullW { get; set; }
    public double FullH { get; set; }
    public int FullAnchorY { get; set; }                   // çevirinin sabit konumu (ekran y; 0 = henüz yok)
    public int IntervalMs { get; set; } = 80;
    public string TargetLang { get; set; } = "tr";
    public string DeeplKey { get; set; } = "";       // isteğe bağlı: DeepL arka planda önbelleği iyileştirir
    public bool MsgOn { get; set; } = true;          // sağ alttaki telefon mesajlarını da çevir (sarı)

    // Eski sürümden kalan alan (okunur, yazılmaz)
    public bool? Cover { get; set; }

    public Rectangle Region
    {
        get => new(RegionX, RegionY, RegionW, RegionH);
        set { RegionX = value.X; RegionY = value.Y; RegionW = value.Width; RegionH = value.Height; }
    }

    public bool HasRegion => RegionW > 20 && RegionH > 10;

    static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "XCloudCevirici");
    static string FilePath => Path.Combine(Dir, "ayarlar.json");

    const int CurrentVersion = 6;

    public static Settings Load()
    {
        Settings s = null;
        try
        {
            if (File.Exists(FilePath))
                s = JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath));
        }
        catch { /* bozuk dosya → varsayılanlar */ }
        s ??= new Settings { Version = CurrentVersion };
        if (s.Version < 2)
        {
            // 1.0.x → 1.1: yayında görünen konum, daha büyük yazı, daha hızlı tarama
            s.Position = SubPosition.Above;
            s.FontSize = Math.Max(s.FontSize, 28);
            s.IntervalMs = 120;
        }
        if (s.Version < 3 && s.Position == SubPosition.Above)
        {
            // 1.5: altyazı artık oyunun kendi altyazısı gibi, İngilizcenin yerine yazılıyor
            s.Position = SubPosition.Game;
        }
        if (s.Version >= 3 && s.Version < 4 && s.Position == SubPosition.Game)
        {
            // 1.5.4: İngilizce silinmez; çeviri sabit konumda, İngilizcenin üstünde durur
            s.Position = SubPosition.Above;
            s.Boxed = false;
        }
        // 1.6.0: yeni altyazı daha çabuk fark edilsin (eski varsayılan 120 ms)
        if (s.Version < 5 && s.IntervalMs == 120) s.IntervalMs = 80;
        // 1.6.1: eski yavaş tarama aralıkları (ör. 300 ms) yeni altyazıyı 0,3 sn geç fark ettiriyordu
        if (s.Version < 6 && s.IntervalMs >= 120) s.IntervalMs = 80;
        s.Version = CurrentVersion;
        s.Cover = null;
        return s;
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions
            {
                WriteIndented = true,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            }));
        }
        catch { /* kaydedilemezse sessizce geç */ }
    }
}
