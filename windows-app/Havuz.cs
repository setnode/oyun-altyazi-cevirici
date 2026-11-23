using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace XCloudCevirici;

/// <summary>
/// Hazır çeviri havuzu (GTA 6 diyalogları, eklentideki havuz.js ile aynı mantık): okunan altyazı cümle cümle
/// havuzda aranır; hepsi bulunursa Google'a gitmeden anında çevrilir. Transkript ile ekrandaki altyazı
/// birebir aynı değildir ("gonna"/"going to", "boostin'"/"boosting"): iki taraf aynı biçime getirilir ve
/// küçük farklara tolerans tanınır (kelime düzeyinde düzenleme uzaklığı).
/// </summary>
static class Havuz
{
    static readonly (Regex re, string to)[] Swap =
    {
        (new Regex("[’‘`]"), "'"),
        (new Regex(@"\bc'mon\b"), "come on"), (new Regex(@"\bgonna\b"), "going to"), (new Regex(@"\bgotta\b"), "got to"),
        (new Regex(@"\bwanna\b"), "want to"), (new Regex(@"\bgimme\b"), "give me"), (new Regex(@"\blemme\b"), "let me"),
        (new Regex(@"\bkinda\b"), "kind of"), (new Regex(@"\bsorta\b"), "sort of"), (new Regex(@"\boutta\b"), "out of"),
        (new Regex(@"\bdunno\b"), "don't know"), (new Regex(@"\by'all\b"), "you all"), (new Regex(@"\bya\b"), "you"),
        (new Regex(@"(\s)'em\b"), "$1them"), (new Regex(@"(\s)'cause\b"), "$1because"), (new Regex(@"\byour\b"), "you"),
        (new Regex(@"\bcuz\b"), "because"), (new Regex(@"\bnothin'"), "nothing"),
        (new Regex(@"\b(\w{2,})in'(?=\W|$)"), "$1ing"), (new Regex(@"\bok\b"), "okay"), (new Regex(@"\bbout\b"), "about"),
        (new Regex(@"(\s)'til\b"), "$1until"), (new Regex(@"\ball right\b"), "alright"),
        (new Regex(@"\bquess\b"), "guess"), (new Regex(@"\b(guess|think|know) lim\b"), "$1 i'm"),
        (new Regex(@"\bslim gym\b"), "slim jim"), (new Regex(@"\bhot wire\b"), "hotwire"), (new Regex(@"(\s)'t(?=\W)"), "$1it"),
    };
    static readonly Regex NonWord = new(@"[^\p{L}\p{N}' ]+", RegexOptions.Compiled);
    static readonly Regex Spaces = new(@"\s+", RegexOptions.Compiled);
    static readonly Regex SentenceRe = new("[^.!?…]+[.!?…]*[\"”']?", RegexOptions.Compiled);
    static readonly Regex Abbrev = new(@"\b(mr|mrs|ms|dr|st|jr|sr|vs)\.$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly HashSet<string> Stop = new() { "the", "and", "you", "that", "this", "with", "for", "are", "was", "have", "not", "but", "what", "your", "got", "its", "just", "all", "can", "out", "get", "one" };
    static readonly HashSet<string> Neg = new() { "not", "no", "never", "nothing", "nobody", "dont", "doesnt", "didnt", "cant", "cannot", "wont", "wouldnt",
        "shouldnt", "couldnt", "isnt", "arent", "wasnt", "werent", "aint", "havent", "hasnt", "hadnt", "nope", "nah" };

    static Dictionary<string, string> map;
    static string[] keys;
    static string[][] words;
    static Dictionary<string, List<int>> index;
    static readonly object gate = new();

    public static string Key(string s)
    {
        string t = " " + s.ToLowerInvariant() + " ";
        foreach (var (re, to) in Swap) t = re.Replace(t, to);
        t = NonWord.Replace(t, " ").Replace("'", "");
        return Spaces.Replace(t, " ").Trim();
    }

    public static List<string> Sentences(string s)
    {
        var outList = new List<string>();
        foreach (Match m in SentenceRe.Matches(Spaces.Replace(s, " ").Trim()))
        {
            string x = m.Value.Trim();
            if (x.Length == 0) continue;
            if (outList.Count > 0 && Abbrev.IsMatch(outList[^1])) outList[^1] += " " + x; else outList.Add(x);
        }
        return outList;
    }

    static void EnsureLoaded()
    {
        if (map != null) return;
        lock (gate)
        {
            if (map != null) return;
            var m = new Dictionary<string, string>();
            try
            {
                using var st = Assembly.GetExecutingAssembly().GetManifestResourceStream("gta6-havuz.json");
                if (st != null) m = JsonSerializer.Deserialize<Dictionary<string, string>>(st) ?? m;
            }
            catch { /* havuz yoksa yalnızca Google */ }
            keys = m.Keys.ToArray();
            words = keys.Select(k => k.Split(' ')).ToArray();
            index = new();
            for (int i = 0; i < keys.Length; i++)
                foreach (var w in words[i].Distinct())
                {
                    if (w.Length < 3 || Stop.Contains(w)) continue;
                    if (!index.TryGetValue(w, out var a)) index[w] = a = new List<int>();
                    a.Add(i);
                }
            map = m;
        }
    }

    static int WordDist(string[] a, string[] b)
    {
        var prev = new int[b.Length + 1]; var cur = new int[b.Length + 1];
        for (int j = 0; j <= b.Length; j++) prev[j] = j;
        for (int i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            for (int j = 1; j <= b.Length; j++)
                cur[j] = Math.Min(Math.Min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            (prev, cur) = (cur, prev);
        }
        return prev[b.Length];
    }

    static string Find(string k)
    {
        if (map.TryGetValue(k, out var exact)) return exact;
        var q = k.Split(' ');
        if (q.Length < 4) return null; // kısa cümlede tahmin yürütme ("Get in." / "Get out.")
        var count = new Dictionary<int, int>();
        foreach (var w in q.Distinct())
            if (index.TryGetValue(w, out var ids)) foreach (int i in ids) count[i] = count.GetValueOrDefault(i) + 1;
        int need = Math.Max(2, (int)Math.Ceiling(q.Where(w => w.Length >= 3 && !Stop.Contains(w)).Distinct().Count() * 0.6));
        int qn = q.Count(Neg.Contains);
        int best = -1; double bestR = 1;
        foreach (var (i, c) in count)
        {
            if (c < need) continue;
            var cand = words[i];
            if (Math.Abs(cand.Length - q.Length) > Math.Max(2, q.Length * 0.25)) continue;
            if (cand.Count(Neg.Contains) != qn) continue; // "I do want it" ≠ "I don't want it"
            double r = WordDist(q, cand) / (double)Math.Max(q.Length, cand.Length);
            // OCR kelimeyi bölüp birleştirdiyse ("I se tick that" / "stick that"): boşluksuz harf farkı %10'u
            // geçmiyorsa yakın say (havuz.js ile aynı)
            if (r > 0.2 && r <= 0.4)
            {
                string qs = string.Concat(q), cs = string.Concat(cand);
                if (Math.Min(qs.Length, cs.Length) >= 20)
                {
                    double cr = WordDist(qs.Select(c => c.ToString()).ToArray(), cs.Select(c => c.ToString()).ToArray()) / (double)Math.Max(qs.Length, cs.Length);
                    if (cr <= 0.1) r = Math.Min(r, cr * 2);
                }
            }
            if (r < bestR) { bestR = r; best = i; }
        }
        return best >= 0 && bestR <= 0.2 ? map[keys[best]] : null;
    }

    /// <summary>Bütün cümleler havuzdaysa çevirisi, değilse null.</summary>
    public static string Lookup(string text)
    {
        EnsureLoaded();
        if (map.Count == 0) return null;
        var parts = new List<string>();
        foreach (var s in Sentences(text))
        {
            string k = Key(s);
            if (k.Length == 0) continue;
            string hit = Find(k) ?? ByClauses(s);
            if (hit == null) return null;
            parts.Add(hit);
        }
        return parts.Count > 0 ? string.Join(" ", parts) : null;
    }

    // Altyazı iki konuşma cümlesini virgülle birleştirmiş olabilir: cümle bulunamazsa virgül parçaları
    // ayrı ayrı aranır, hepsi bulunursa birleştirilir (havuz.js byClauses ile aynı)
    static string ByClauses(string s)
    {
        var cl = Regex.Split(s, @",\s+").Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
        if (cl.Count < 2 || cl.Count > 4) return null;
        var outp = new List<string>();
        foreach (var c in cl)
        {
            string k = Key(c);
            if (k.Length == 0 || k.Split(' ').Length < 2) return null;
            string hit = Find(k);
            if (hit == null) return null;
            outp.Add(hit);
        }
        return string.Join(" ", outp);
    }
}
