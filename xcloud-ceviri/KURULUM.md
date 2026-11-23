# xCloud Altyazı Çevirici

Xbox Cloud Gaming'de (xbox.com/play, Chrome) ekrandaki altyazıları okur (OCR) ve canlı olarak Türkçeye çevirip üstüne yazar.
OCR tamamen bilgisayarında çalışır (Tesseract). Çeviri Google Çeviri'den gelir: iki Google adresi aynı anda sorulur, ilk gelen alınır (yeni cümlede ~0,4 sn). Google 0,6 sn içinde cevap vermezse Chrome'un cihaz üzerindeki çevirmeni anında bir çeviri gösterir, Google'ınki gelince onunla değiştirilir. Bağlantı 15 sn'de bir sıcak tutulur. "Çok fazla istek" (429) hatası veren adres 1 dakika dinlendirilir.

## Kurulum
1. Chrome'da `chrome://extensions` adresini aç.
2. Sağ üstte **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle** → bu klasörü (`xcloud-ceviri`) seç.
4. xbox.com/play sekmesi açıksa sayfayı yenile.

## Kullanım
- Oyunu başlat. Sol üstte **ÇEVİRİ: KAPALI** düğmesi çıkar → tıkla (Alt+T).
- İlk açılışta yeşil kesikli çerçeve altyazının okunduğu alanı gösterir. Altyazı başka yerdeyse **Bölge seç** (Alt+R) → fareyle altyazı alanını çiz.
- Ayarlar için araç çubuğundaki eklenti simgesine tıkla:
  - **Altyazı rengi**: beyaz değilse “Diğer renkler” seç.
  - **Parlaklık eşiği**: yanlış/eksik okuyorsa 150–200 arasında oyna.
  - **Konum**: **İngilizcenin üstünde** (varsayılan): İngilizce altyazı olduğu gibi kalır, Türkçesi üstünde hep aynı yerde durur. Yer ilk altyazıda, iki satırlık İngilizceye de yetecek yükseklikte seçilir ve bölgeyle birlikte kaydedilir; satırdan satıra hiç kaymaz. Yalnızca İngilizce bunun da üstüne çıkarsa (üç satır gibi) bir kez yukarı alınır. Bölgeyi yeniden çizince yer de yeniden seçilir. **Dikey konum** kaydırıcısıyla yüksekliği ince ayarlayabilirsin (artı = daha yukarı). Diyalog ve görev hedefi ("Follow Moses") ayrı satırlar olarak çevrilir; silah/ödül bildirimleri gibi BÜYÜK HARFLİ arayüz yazıları atlanır. İstersen altında, koyu kutuyla örtülü ya da deneysel "İngilizceyi sil, yerine yaz" da seçebilirsin.
  - **Görünüm**: Sinema (çerçeveli beyaz yazı) veya yarı saydam şerit. **Önizle** ile yerini ve boyutunu kontrol et.

## Oyun sözlüğü (`sozluk.js`)

- **kısa:** "Wait." → "Bekle." gibi sık geçen kısa replikler internete gitmeden, anında çevrilir.
- **argo:** "let's bounce", "five-o", "holler at me" gibi argo, Google'a gönderilmeden önce düz İngilizceye çevrilir, böylece yanlış anlaşılmaz.
- **Görev hedefleri:** "Lose the cops" → "Polislerden kurtul", "Collect the cash" → "Parayı topla" gibi oyunun tekrar eden komutları `kisa` listesinde hazır durur.
- **kalip:** İsimli görev kalıpları: "Follow Donnie" → "Donnie'yi takip et", "Talk to Brian" → "Brian'la konuş", "Drive to Cal's house" → "Cal'ın evine git". `<AD>` bir ismin yerini tutar; Türkçede `{1:yı}`, `{1:ya}`, `{1:yla}`, `{1:nın}` ismi doğru ekle yazar (Donnie'yi, Arnold'u, Billy'yi, Jason'ın…).

## Açık renk zeminde okuma (GTA tarzı konturlu yazı)

Beyaz yazı beyaza yakın bir zeminin (çakıl, beton, gökyüzü) üstüne gelince eski yöntem yazıyı zeminden ayıramıyordu. GTA altyazılarının etrafında ince, simsiyah bir kontur var. Eklenti artık okumayı iki yolla yapabiliyor:

- **Düz:** Parlak pikseller yazı sayılır (konturu olmayan oyunlar için).
- **Konturlu:** Simsiyah konturla çevrili parlak bölgeler bütün olarak harf sayılır. Kenarının neredeyse tamamı kontura değmeyen (çakıl taşı), satırdan büyük ya da renkli bölgeler atılır. Başka bir harfin içinde kalan bölge de atılır: "o" ve "c"nin içindeki çakıl yüzünden "too" "tee", "cars" "ears" okunuyordu. Çakıl, harf dolgusuyla aynı parlaklıkta olduğu için piksel piksel eşik bunu ayıramıyordu.

Okuma zayıf çıkarsa (sözlükte olmayan kelimeler, düşük güven) diğer yol da denenir ve iyi okunan seçilir. Hangi yolun kazandığı hatırlanır, böylece GTA'da ikinci okuma gereksiz yere yapılmaz. Aynı kural deneysel "İngilizceyi sil" görünümünde de kullanılır, yani zemin bulanıklaşmaz.

Yazının değişip değişmediği de aynı şekilde izlenir. Bölgenin %2,5'inden fazlası parlak kenarsa zemin dokulu sayılır; o zaman konturlu piksellerin değişimine de bakılır. Önceden çakıl dokusu toplamı doldurduğu için kamera sabitken yeni altyazılar fark edilmiyordu.

Kontur modu üst üste üç kez iyi okuyunca oyunun konturlu yazı kullandığı anlaşılır (GTA); bundan sonra yalnızca konturlu okuma yapılır ve değişim de yalnızca konturlu piksellerden izlenir. Düz okuma çakıl zeminde 2–5 sn sürüyor, bu sırada gelen satırlar kaçıyordu.

Konturlu oyunda yeni yazının ilk karesinde hemen okunur. İyi okunduysa çevirisi o an başlar ve gösterilir; görüntü durulunca bir kez daha okunur, gerekirse düzeltilir. Ekran 100 ms'de bir taranır.

Sahne geçişinde (görüntü sürekli değişirken) en geç 0,4 saniyede, konturlu oyunda (GTA) kamera hareket ederken 0,2 saniyede bir zorunlu okuma yapılır. Bu okuma zayıfsa ekrana basılmaz ve görüntü durulunca satır yeniden okunur. Zayıf okunan satır ayrıca biraz daha büyük ölçekte okunur, en iyi okunan seçilir. 1440p ve 4K videolarda OCR görüntüsü küçültülür, okuma ve görüntü taşıma hızlanır.

Parlak zeminde (gökyüzü, beton) OCR bir an hiçbir şey okuyamayabilir. Altyazının pikselleri ekranda hâlâ duruyorsa (son okumadaki yazı piksellerinin en az %75'i yerinde) çeviri silinmez, en fazla 4 saniye tutulur ve okuma yeniden denenir. Yazı gerçekten kaybolduysa çeviri her zamanki gibi kalkar.

Yeni ifade eklemek için dosyayı bir metin düzenleyiciyle açıp listeye ekleyin, sonra `chrome://extensions` sayfasında eklentiyi ↻ ile yenileyin.

Çevrilen cümleler tarayıcıda saklanır, son 20.000 cümleye kadar (uzun bir oyunun tüm diyaloglarına yeter). Oyunda tekrar eden bir cümle sonraki oturumlarda internete gitmeden anında gelir. OCR cümleyi bir iki harf farklı okusa da ("yeu"/"you") bellekteki çeviri bulunur; kısa cümlelerde eşik daha sıkıdır, "cash"/"car" gibi farklar karışmaz.

## İsim koruma (`ceviri-ag.js`)

Google bazı karakter adlarını çeviriyor: "Bill" → "fatura", "Peaches" → "Şeftaliler", "Cat" → "kedi". Bu adlar Google'a uydurma bir adla gönderilir (Bill → Zorbil, Cat → Zorket), çeviri gelince asıl ad geri konur. Uydurma adın son hecesi asıl adla aynı sesli, böylece Google'ın eklediği Türkçe ek asıl ada da uyar ("Cat'e", "Moses'le"). "Lucky" yalnızca cümle ortasında korunur ("Lucky for you" → "Şanslısın ki"). Google uydurma adı değiştirirse korumasız çeviri kullanılır. Liste `ISIMLER` dizisindedir; Windows uygulamasında `Engine.cs` içindeki `Isimler` ile aynıdır.

## Hazır çeviri havuzu (`gta6-havuz.json`)

GTA 6'nın tam oynanış videosunun YouTube konuşma metninden (11 saat, ~10 bin cümle ve cümle parçası) önceden çevrilmiş Türkçeler. Oyunda okunan altyazı cümle cümle havuzda aranır; hepsi bulunursa Google'a gitmeden anında çevrilir.

- Konuşma metni ile ekrandaki altyazı birebir aynı değildir: "gonna"/"going to", "boostin'"/"boosting", "ya phone"/"your phone". Eşleştirmede iki taraf da aynı biçime getirilir. Uzun cümlelerde 5 kelimede 1 farka izin verilir; olumsuzluk farkı ("do"/"don't") asla eşleşmez.
- Oyun uzun cümleleri virgülden bölüp parça parça gösterir. Bu yüzden havuzda cümlelerin virgülle ayrılan parçaları da var.
- Altyazı iki konuşma cümlesini virgülle birleştirmişse ve cümle bulunamazsa, virgül parçaları ayrı ayrı aranır; hepsi bulunursa birleştirilir.
- Havuz sayfa betiğine yüklenir (~600 KB, çeviri başlarken servis çalışanından mesajla gelir; dosya web sayfalarına açılmaz) ve önbellekten önce aranır: ara mesaj olmadan <1 ms. Havuzda düzeltilen bir cümlenin bellekte kalmış eski Google çevirisi böylece hiç gösterilmez. Windows uygulamasında da havuza önbellekten önce bakılır.
- OCR bir kelimeyi bölüp okuduysa ("I se tick that" / "Stick that") kelime farkı büyür ama harfler neredeyse aynıdır: 20 harften uzun cümlede boşluksuz harf farkı %10'u geçmiyorsa havuzdaki cümle kullanılır.
- Sansürlü küfürlü (`[ __ ]`) cümleler havuza alınmaz.
- Elle düzeltmeler: Havuzdaki 7.237 cümle tek tek gözden geçirildi ve Google'ın yanlış çevirdiği yaklaşık 5 bin cümle düzeltildi. Örneğin argo ("copy that" artık "kopyala" değil "anlaşıldı"), isimler (Mattia, Dunk) ve polis telsizi dili. Düzeltmeler `havuz/duzeltmeler.json` dosyasında durur ve `olustur.js` havuzu yazarken en son uygulanır. 1.7.0'da havuzun tamamı (9.200 kayıt) yeniden denetlendi; ~700 yanlış çeviri daha düzeltildi ("luck has run out" artık "şansın yaver gitti" değil, "ghost" bağlama göre "ortadan kaybolmak", gündelik konuşmada "siz" yerine "sen" vb.). Anlamı tamamen değişen bir cümlenin virgül parçaları havuzdan silinir, çünkü büyük ihtimalle aynı hatayı taşırlar. Yeni düzeltme eklemek için `havuz/duzeltme-girdi.tsv` dosyasına `sıra<TAB>doğru Türkçe` satırı ekle (sıra numaraları `gozden-gecirme-listesi.tsv`'den), sonra `node havuz/duzeltmeleri-uygula.js havuz/gozden-gecirme-listesi.tsv` komutunu çalıştır.
- Yeni bir transkript eklemek için: YouTube'da "Transkripti göster" panelindeki satırları `zaman<TAB>metin` biçiminde `havuz/` klasörüne kaydet, sonra `node havuz/olustur.js havuz/*.tsv` komutunu çalıştır. Önceden çevrilmiş cümleler tekrar çevrilmez.

## Görev satırları (sarı renk)

Oyunun alt ortadaki görev yazısı ("Follow Moses", "Go to the safehouse") diyalogdan ayrı olsun diye Türkçesi sarı gösterilir. Satırın emir kipindeki bir fiille başlayıp başlamadığına bakılır ("I told you" gibi zamirle başlayanlar diyalog sayılır). Tek bir düzenli ifade, hız kaybı yok. İki blok varsa yalnızca görev olan blok sarı olur.

## Yarım ve kesik okumalar

- Altyazı ekrana harf harf geliyorsa ilk okuma yarım olabilir ("Break into the"). Yeni okuma öncekini içeriyor ve en az 3 harf uzunsa yeniden çevrilir; yarım çeviri ekranda kalmaz.
- Diyalog aynı kalıp yalnızca bir blok belirgin değiştiyse (görev satırı "Follows" → "Follow Moses") altyazı yeni sayılır ve yeniden çevrilir.
- Görev satırının ilk harfi kesik okunursa ("ollow Meses") ve kalan kelime bilinen bir görev fiilinin baş harfsiz hali ise satır onarılır ("Follow Moses"). Görev satırındaki karakter adlarında tek harf hatası da düzeltilir (`ADLAR` listesi).

## GTA 6 kaydı

Havuzda olmayan ve Google'a giden her cümle (İngilizce → Türkçe) ayrıca "GTA 6 kaydı"na yazılır (en çok 50 bin cümle). Böylece oynadıkça havuza girmemiş cümleler birikir.

- Eklenti: kayıt tarayıcıda durur. Açılır penceredeki **GTA 6 kaydını indir** düğmesi `gta6-kayit.json` dosyasını indirir.
- Windows: `%APPDATA%\XCloudCevirici\gta6-kayit.json`.
- Havuza eklemek için: `node havuz/kayit-ekle.js gta6-kayit.json` (birden çok dosya verilebilir). Kayıtlar `havuz/kayitlar.json`'a birleşir, havuza eklenir, `duzeltmeler.json` uygulanır ve gözden geçirmek için `havuz/kayit-denetim.tsv` yazılır. Yanlış olanlar düzeltmelere eklenince bir daha Google'a sorulmaz.

## Oyun sözlüğü genişletmesi (1.7.0)

`sozluk.js`'e ~170 hazır cümle (sürüş: "floor it" → "Bas gaza", soygun: "this is a stickup" → "Bu bir soygun", görevler: "crack the safe" → "Kasayı aç"), isimli görev kalıpları ("Follow <ad>'s truck", "Steal <ad>'s car", "Drive <ad> home") ve sokak argosu kuralları eklendi: heat/strap/blick (silah), plug (uyuşturucu satıcısı), narc (gizli polis), opps, trap house, smoke (öldürmek), case the joint (keşif), wheelman, snitch, say less vb.

## DeepL (isteğe bağlı)

Açılır penceredeki **DeepL (isteğe bağlı)** bölümüne API anahtarını yapıştırıp **Kaydet ve dene**'ye bas. Bağlantı başarılıysa bu ayki kota kullanımı görünür. Anahtar yalnızca bu bilgisayarda (`chrome.storage.local`) saklanır ve sadece servis çalışanı kullanır.

DeepL'in sunucusu Google'dan ~100 ms daha uzak (ölçüm: bağlantı 97 ms, Google'da 30 ms). Bu yüzden ekrandaki çeviri onu beklemez:

1. Altyazı önce havuzda aranır; bulunursa anında gösterilir ve DeepL'e hiç gitmez.
2. Havuzda yoksa Google'ın çevirisi anında gösterilir.
3. 0,7 sn sonra altyazı hâlâ ekrandaysa ve en az 3 gerçek kelime içeriyorsa (OCR'ın yarım okumaları ve kırıntıları kota harcamasın) cümle bir kez DeepL'e sorulur. Gelen çeviri önbelleğe ve GTA 6 kaydına yazılır. Ekrandaki yazı değişmez, titreme olmaz.
4. Aynı cümle bir dahaki sefere DeepL çevirisiyle anında gelir.

Ücretsiz planın kotası ayda 500 bin karakterdir (anahtar `:fx` ile biter). Windows uygulamasında anahtar ana penceredeki "DeepL" kutusuna girilir.

## Kelime listesi (`kelimeler.txt`)

Yaklaşık 184 bin İngilizce kelimelik liste (Tesseract'ın kendi sözlüğü ve oyun argosu). OCR'ın yanlış okuduğu kelimeleri ayıklamak için kullanılır:

- Sözlükte olmayan ve düşük güvenle okunan kelimeler ("fuekingiloeer" gibi) atılır. Satırın çoğu bu tür kelimelerden oluşuyorsa satır hiç gösterilmez.
- Bitişik okunan kelimeler ayrılır: "haveall" → "have all".
- Tek harflik karışıklıklar düzeltilir: "vou're" → "you're".
- Büyük harfle başlayan, net okunan bilinmeyen kelimeler isim sayılır ve korunur (örneğin "Bennie").

Oyuna özel bir isim ya da argo sürekli atılıyorsa, küçük harfle bu dosyaya yeni bir satır olarak ekleyin.

## Telefon mesajları (1.9.0)

GTA 6'da sağ altta çıkan açık renk mesaj kutusu (gönderen + mesaj) altyazıdan tamamen ayrı okunur:

- **Bölge:** videonun sağ alt köşesi (x 0,765–0,993, y 0,58–0,99). Kendi 250 ms'lik döngüsü vardır, OCR'ı en sık 0,5 sn'de bir çalışır ve havuzdaki boş işçiyi kullanır. Altyazı okuması beklemez.
- **Kutu tanıma:** açık, renksize yakın zemin üzerinde koyu yazı aranır. Kutunun satır araları bölge genişliğinin en az %45'i kadar kesintisiz açık şerit olmalıdır, bu yüzden yayıncı filigranı gibi küçük etiketler elenir. Ardından OCR satırları denetlenir: ilk kısa ve büyük harfle başlayan satır gönderen sayılır, tek kelimelik satırlar ("→ Lucia") atılır, gövdede en az 3 gerçek kelime aranır.
- **Gösterim:** çeviri kutunun hemen üstünde, sağa hizalı, sarı (`#ffd75e`) yazılır. Gönderen adı beyazdır.
- **Karışmama:** kutu okunduğu sürece o alan altyazı imzasında ve OCR görüntüsünde boyanır. Mesaj metni altyazı sanılmaz.
- Çeviri aynı yoldan geçer: havuz → önbellek → Google, ardından arka planda DeepL ve GTA 6 kaydı.
- Popup'taki "Telefon mesajlarını da çevir" seçeneğiyle kapatılabilir.
- **1.9.1:** gövdedeki 3+ harfli kelimelerin en az %60'ı (ve en az 3 tanesi) sözlükte olmalı; böylece arama göstergesi ("Chuck's Gun Shop 00:23") elenir. SMS kısaltmaları (b4, 2gether, yr, u, thx…) çeviriden önce açılır.
- **1.9.2:** gönderen adı (2+ harf, büyük harfle) zorunlu. Tek kelimelik satır, kutunun sol kenarından başlıyorsa mesajın parçasıdır; sağa kaymışsa yanıt göstergesidir. Kutu sınırı yalnızca metin satırlarından hesaplanır.
- **1.9.3:** sola hizalı olmayan, en fazla 3 kelimelik satır her zaman yanıt göstergesi sayılır ("→ Brian" avatarla "Brian VP" okunabiliyor).

## Eldeki telefon (1.10.0)

- **Tespit:** Kare 240 px genişliğe küçültülür. Ekranın sağ-orta kısmında (x 0,42–0,92) uzun koyu dikey şeritler aranır: telefonun sol çerçevesi ve sağdaki çerçeve ya da tutan el. Bu ikisinin arasında, genişliği karenin %10–32'si olan ve satırlarının en az %35'i açık-renksiz olan bölge telefon ekranıdır. Bulut ve gökyüzünün koyu çerçevesi olmadığı için elenir. Sağ alttaki mesaj kutusu da telefon sanılmaz (5 oyun görüntüsü ve 2 mesaj kutusu görüntüsüyle denendi).
- **Maske:** Telefon bulunduğu anda ekranı (+ çerçeve payı) ve sağ alttaki tuş ipuçları ("SCROLL / BACK", x ≥ 0,84, y ≥ 0,8) altyazı imzasından ve OCR'ından çıkarılır. Daha önce "SCROLL ®" altyazıya "KAYDIR ©" diye karışıyordu.
- **Okuma:** Ekran içeriği değişince, en sık 0,6 sn'de bir okunur. Koyu yazı siyah, kalan her şey beyaz olacak şekilde ~700 px genişlikte OCR'a gider. Arayüz yazıları ("New message", "Messages encrypted", "Locating…") atılır. Üstteki kısa satır başlıktır (kişi adı). Satırlar dikey boşluk ve sol kenara göre baloncuklara toplanır. Ekran genişliğinin %27'sinden sağda başlayan baloncuk "giden" sayılır. Üstte yarım kalmış, küçük harfle başlayan baloncuk atlanır. 3+ harfli kelimelerin en az yarısı sözlükte olmalıdır. En son 7 baloncuk alınır.
- **Gösterim:** Telefonun solunda koyu panel: başlık beyaz, gelen baloncuklar sarı ve solda, gidenler mavi ve sağda. Panel ekranın %68'inin altına inmez (altyazı alanı). Sığmazsa en yeniler görünür.
- Telefon açıkken sağ alttaki mesaj kutusu okuyucusu durur. İkisi aynı "Telefonu da çevir" seçeneğine bağlıdır.
- **1.10.1:**
  - Telefon kutusu bir önceki tespitten %0,6 (yatay) / %1 (dikey) fazla kaydıysa okuma yapılmaz; durunca okunur.
  - Çevrilen baloncuklar hafızada tutulur (benzer okuma → aynı metin + çeviri).
  - İçerik aynıysa ya da yeni okuma gösterilenin eksik bir alt kümesiyse panel yeniden çizilmez.
  - Tespit 4 kez üst üste (~0,8 sn) kaçmadıkça panel gizlenmez.
  - Liste ekranında isim satırı gönderen olarak ayrılır.
  - Sağ alttaki tuş ipucu alanı (x ≥ 0,85, y ≥ 0,78) altyazı okumasında her zaman maskelenir.
  - Tanı modunda (`localStorage.xctDebug = '1'`) son telefon okuması `data-xct-phone` özniteliğine yazılır.
- **1.10.2:** Ekran içeriği iki tespit arasında %8'den fazla değiştiyse (kaydırma) okuma beklenir. Oyunda tanı kaydı, kaydırma anında okunan satırların %0–25 güvenle anlamsız çıktığını gösterdi. Tesseract satır güveni %55'in altındaki satırlar atılır. Windows'ta güven değeri olmadığından, küçük harfli 3+ harfli kelimelerin yarısı sözlükte değilse satır atılır.
- **1.10.3:** Satırın sol kenarı hesaplanırken düşük güvenle atılan, gerçek harf içeren kelimeler de hesaba katılır; böylece "come" atılınca satır sağa kaymış (giden) sayılmaz. İlk baloncuk küçük harfle başlıyorsa, konumuna bakılmadan atlanır.
- **1.10.4:** Gemi/araç sallantısında okuma artık durmaz. "Sabit dursun" şartı kaldırıldı: yalnızca telefon hızlı hareket ederken atlanır, ekran parlaklık ızgarası değişince ya da 2,5 sn geçince yeniden okunur. Hafıza ve alt küme kuralı sayesinde aynı mesaj tekrar çevrilmez.
- **1.11.0:** Telefon tespiti baştan yazıldı: ekranın sol/sağ düz kenarları (koyu çerçeve ↔ açık ekran, karşıtlık eşiğiyle) aynı satırda eşleştirilir; konum serbest, yayın kamerası/logo üstünü kapatsa da çalışır. Aday ancak OCR içinde yazı bulunca telefon sayılır (maske, panel, mesaj kutusunu susturma ondan sonra); yazısız aday 4 sn yeniden okunmaz. Onaylı telefon ~2 sn kayıp tolere edilir, panel telefonla birlikte kayar. Mesaj kutusunda çok doygun renkli pikseller (yayın logosu) yazı sayılmaz.
- **1.13.0:** YENİ: haritada/menüde seçilen yerin bilgi kartı da çevrilir ("BIFF'S GUN SUPPLY — Ammu-Nation distributor that stocks guns, mods, ammo, and equipment." → "Silah, mod, cephane ve ekipman stoklayan Ammu-Nation distribütörü."). Başlık (yer adı) olduğu gibi kalır; "INVENTORY / STANDARD" gibi satırlar "ENVANTER: STANDART" diye yazılır. Çeviri kartın hemen altında (yer yoksa üstünde) gösterilir. Yalnızca menü ekranında (üstte koyu sekme şeridi) çalışır, oyun sırasında hiç okumaz. Aynı kart yeniden seçilince çeviri hafızadan anında gelir, çeviri motoruna bir daha sorulmaz. Ayarlarda "Harita/menü bilgi kartlarını da çevir" ile kapatılabilir. (Windows sürümünde kart okuyucu yok.)
- **1.13.1:** Kart çevirisi hikâye/görev listesinde de çalışır (üstte sekme şeridi yokken menü, soldaki koyu simge sütunundan tanınır; oyun sırasındaki koyu direk + gökyüzü buna takılmaz). Görev kartının başlığı da çevrilir ("SEARCH FOR TREE EFFIGIES" → "AĞAÇ HEYKELLERİNİ ARA"); özel ad içeren yer adları ("BIFF'S GUN SUPPLY") olduğu gibi kalır. Küçük kartlarda okuma eşiği düşürüldü.
- **1.13.2 / Windows 1.11.18:** Görev kartının başlığı artık bulunur (solundaki portre yüzünden atlanıyordu): "MOVE TO VICE CITY" → "VICE CITY'YE TAŞIN" (özel adlar Türkçe İ ile yazılmaz). "Move to …" yer yönergesi "Düğmeyi … taşıyın" diye çevriliyordu (sözlük kuralı) — düzeltildi; bu Windows'u da etkiler. Görev listesi açıkken sol üstteki ipucu okuyucusu liste satırlarını ipucu sanıp çeviriyordu ("Tree Heykellerini Ara") — artık o ekranda okumaz.
- **1.13.3:** Görev listesi koyu yeşil harita bölgesinde açıkken sekme şeridi sanılıyordu ve sol üstteki ipucu okuyucusu liste satırını yine çeviriyordu ("Tree Heykellerini Ara"). Artık liste, sol taraftaki düz koyu-gri panelden ayrıca tanınır; o ekranda ipucu okunmaz, kart çevirisi sürer.
- **1.14.0 / Windows 1.11.19:** GTA terim sözlüğü (`sozluk.js`, iki sürümde ortak). **adlar:** Vice City, Leonida, Port Gellhorn, Ammu-Nation, Pay 'n' Spray, Los Santos Customs, Burger Shot, Sprunk… gibi yer ve marka adları çevrilmez. Çeviriden önce yerine uydurma bir ad konur, sonra geri yazılıp eki ses uyumuna göre çekilir ("Vice City'ye", "Leonida'nın", "Los Santos Customs'a"). Bu adları içeren ama önceden çevrilmiş cümleler yeniden sorulmaz. **duzelt:** çeviri sonrası Türkçe düzeltme ("aranan seviyenizi kaybedin" → "aranma seviyenizi düşürün"). **argo:** "chop shop", "nice ride", "hit the bank". **kisa:** WASTED / BUSTED / MISSION PASSED. Listeye yeni ad eklemek için `sozluk.js` → `"adlar"`.
- **1.14.1 / Windows 1.11.20:** "fuck yeah / hell yes" → "kesinlikle" ("kahretsin evet" değil). "Let me…" cümlelerinde Google'ın koyduğu "Bırakın" atılır: "Bırakın işlerimi burada toparlayayım" → "İşlerimi burada toparlayayım" ("Bırak gideyim", "Bırak beni" korunur).
- **1.14.2 / Windows 1.11.21:** Küfürlü kısa ünlemler doğal Türkçe argoyla, dozunda ("kisa" bölümü): "What the fuck?" → "Ne oluyor amk?", "Shut the fuck up!" → "Kapa çeneni amk!", "Are you fucking kidding me?" → "Dalga mı geçiyorsun amk?", "Get the fuck out of here!" → "Defol git buradan lan!", "Fuck it" → "Siktir et", "Bro" → "Kanka", "Bullshit" → "Palavra". "amk/lan" yalnızca tek başına söylenen kısa satırlarda; uzun cümlelere eklenmez.
- **1.14.3 / Windows 1.11.22:** "Drive back to the cabin" → "Kulübeye geri dön" ("Kabine geri dönün" değil; cabin görevleri sözlükte). "Get in the truck" → "Kamyonete bin" (oyundaki truck pikap).
- **1.14.4 / Windows 1.11.23:** Ekran okuyucu kesme işaretini kaçırınca ("You ve just", "Youve", "don t") kelimeler çevrilmeden kalıyordu; kısaltma çeviriden önce onarılıyor ("You've just"). "were", "its", "ill" gibi gerçek kelimelere dokunulmuyor.
- **1.12.4 / Windows 1.11.17:** Motorla/arabayla giderken (kamera hep hareketli) altyazı bittiğinde eski çeviri 3–5 sn ekranda kalıyordu. İki sebep giderildi: (1) hareket sırasında boş okuma "geçiş anı" sayılıp yok sayılıyordu — artık yazı mürekkebi söndüyse çeviri kalkar; (2) "yazı yerinde ama okunamadı" tutması asfalt/beton zeminde yanlış tetikleniyordu — artık kabul edilen satırların kendi konturlu mürekkebi de yerinde olmalı, tutma süresi 4 sn → 2,5 sn.
- **1.12.3 / Windows 1.11.16:** Görev hedefindeki renkli iki kelimelik ad yarım okunuyordu: ikinci renkli kelime satırın sonundan uzak sayılıp atılıyordu ("Get on the dirt bike" → "Kirin üzerine çık", "Handle the security guard" → "Güvenliği idare edin"). Renkli kelimeler artık zincirleme eklenir (her biri bir öncekinin yanında olmalı).
- **1.12.2 / Windows 1.11.15:** Sağ alttaki mesaj kutusu görünürken telefon okuyucusu onu (üstündeki açık gökyüzüyle birlikte) telefon ekranı sanıp mesajı ekranın tepesine sohbet gibi yazıyordu; mesaj kutusunu içine alan aday artık telefon sayılmaz. Altyazı dokulu/parlak zeminde kalktığında çevirisi saniyelerce ekranda kalabiliyordu: gösterilen yazının mürekkebi yarıdan fazla sönünce ekran yeniden okunur, boşsa çeviri hemen kalkar.
- **1.12.1:** Güneşli/yapraklı sahnede sol üstteki ipucu kutusu ("You can get your vehicle delivered… Scooter Bros app") çevrilmiyordu: gökyüzü ve yaprak kenarları da yazı sanılıyordu. Artık önce koyu kutunun kendisi bulunur, yalnızca onun içi okunur (kutu yoksa hiç okunmaz, işlemci de rahatlar); birden çok satır grubu çıkarsa en anlamlı olanı seçilir. (Windows sürümünde ipucu okuyucu yok; değişmedi.)
- **1.12.0 / Windows 1.11.14:** YENİ: sol üstteki ipucu/bildirim kutusu ("You can hold … and press … to switch characters.", "Cardio Workout completed…") da çevrilir; çeviri kutunun hemen altında, sarı kenarlı koyu şeritte gösterilir. Altyazıdan ayrı bölge, en sık 0,6 sn'de bir okuma; tuş simgesi kırıntıları atılır, aynı metin iki kez okununca gösterilir, kutu kalkınca çeviri de kalkar. Ayarlarda "İpucu kutularını da çevir" ile kapatılabilir.
- **1.11.16 / Windows 1.11.13:** İki replik üst üste dururken üstteki kalkınca ("Nope." / "It's the one…") eski çeviri ekranda kalıyordu: satır satır mürekkep karşılaştırılır, kalkan satır fark edilip yeniden okunur. Parlak/dokulu zeminde altyazı bitince çeviri hemen kalkar. "Parça" kabulü yalnızca gösterilen yazının kendi kutusunda mürekkep azaldıysa yapılır (başka satırın kalkması eksik okumayı haklı çıkarmaz). OCR'ın tek kelime içinde bıraktığı boşluk silinir ("Sha nese" → "Shanese"). Argo: "the one, the only".
- **1.11.15 / Windows 1.11.12:** Çeviride nokta/ünlem/soru işaretinden sonra küçük harf kalmaz ("Hey. yani…" → "Hey. Yani…"); üç nokta sonrası devam sayılır, dokunulmaz.
- **1.11.14 / Windows 1.11.11:** Yalnızca büyük harfli tek kelimelerden oluşan seslenme ("Chester! Shanese!"): her kelime tek başına çevrilince aynı kalıyorsa isimdir, satır olduğu gibi gösterilir (Google "Şa nese" yapıyordu).
- **1.11.13 / Windows 1.11.10:** Mırıltılar ("Mmhmm…", "Hmm.") çevrilmez. Tuş simgeli ipucu satırı ("Use (L) and (R) to center your attention") simge boşluğunda parçalanmaz, "düğmeleri kullanın" diye çevrilir. Küçük harfle başlayan ikinci satır, noktasız biten üst satırın devamı sayılır (satır aralığı geniş okunsa bile tek cümle çevrilir). Argo: "What do I do?", tek başına "Focus.".
- **1.11.12 / Windows 1.11.9:** Google "Okay!" → "Tamam aşkım!" uyduruyor: kaynakta sevgi sözcüğü yoksa aşkım/canım/bebeğim/tatlım/sevgilim çıktıdan atılır. Bir blok kalkınca (sönen eski replik ilk okumaya karışmış ya da diyalog bitti) kalan bloklar gösterilir, çevirileri değişmez. Argo: "we (fucking) doing this?", "you fucking kidding".
- **1.11.11 / Windows 1.11.8:** Son 90 sn içinde gösterilen satır yeniden çizilirse aynı çeviri kullanılır (arada önbelleğe DeepL yazılsa da "Yerleşkeyi soy" → "Kompleksi soy" değişmez). Cihaz içi → Google yükseltmesi bu kuralı atlar.
- **1.11.10 / Windows 1.11.7:** Ekrandaki çeviri sonradan değişmez: DeepL canlı değişimi kaldırıldı (önbelleğe yazar). Doğrulama okuması yalnızca eksik altyazıyı tamamlar (uzadı), harf farkıyla yeniden çevirmez.
- **1.11.9:** İkiye bölünmüş cümle: küçük harfle başlayan devam altyazısı, noktalamasız biten önceki parçayla (8 sn içinde) birlikte çevrilir ve tüm cümlenin çevirisi gösterilir; DeepL yükseltmesi de birleşik metinle çalışır. Argo: bullet sponge.
- **1.11.8:** Dokulu zeminde (kum/çakıl) değişim ve yeni yazı oranı, gösterilen yazının kendi konturlu piksel sayısına göre de ölçülür: kısa yeni replik ("Oh, hey.") ve yazının kalkması artık fark ediliyor.
- **1.11.7 (eklenti, oyun içi test):** Aynı hizada ama arası açık yazılar ayrı parçalara bölünür (sol alt menü "Not owned" + orta görev); ekrandaki yazı gerçekten azaldıysa (parlak piksel düşüşü) 3 tutarlı okumadan sonra yeni altyazı sayılır. Yeni altyazı 350 ms sonra bir kez daha okunur (açık zeminde yutulan kelimeler). Hareketli sahnede net okunan kısa replik atılmaz. OCR hiç harf görmezse eski çeviri hemen kalkar. Diyalog altındaki görev pembe; kırıntı blok ("at OS") atılır; görev çevirisi emir kipine çevrilir ("…mek" → kök), "Billy's'ten" → "Billy'den". DeepL 300 ms sonra; gelince ekrandaki çeviri canlı değişir. OCR: geçersiz boyutlu görüntü motora gitmez, hata veren işçi yenilenir, 3000 okumada bir işçi arka planda tazelenir ("pixd not defined"). Yeni argo/deyimler (pop cherries, get in on the action, even trying, catch air, Beat → Defeat, 'em, gonna, gotta).
- **1.11.6 (Windows):** Mesaj/telefon katmanları yayında görünür (WDA_NONE). Kaynak dil "en" (sl=auto kısa kelimeleri çevirmiyordu). İsim koruması tek/iki kelimelik satırlarda ve sözlükte bilinen kelimelerde devre dışı. Kısa satırlara uzun havuz karşılığı verilmez. Aynı kalan çeviriler önbelleğe yazılmaz, önbellek dosyası yenilendi (onbellek2.json). DeepL 300 ms sonra arka planda; gelince ekrandaki çeviri canlı değişir. Daha çok kelime okunan satır yeniden çevrilir; çeviri doğrulama okumasıyla paralel başlar.
- **1.11.5:** Telefon tespiti eğime dayanıklı: kenar olaylarını hizalayan eğim (±0,45) aranır, kaydırılmış (shear) görüntüde aynı dik-kenar araması yapılır; sonuç merkez/eksen/en/boy (eğik) + çevreleyen kutu. OCR görüntüsü dönüş matrisiyle düzeltilerek çizilir, kalan yazı eğikliği satır izdüşümüyle (±0,08) giderilir. Koyu mavi baloncuk: mavi alan + Otsu + kenar halkası aşındırma. Mavilik ekran zemininin tonuna göre ölçülür (güneşte sarımsı zemin). Çerçeveli baloncuk: kenar "|" atılır (≥2 → giden), mavi kenar sütunu da giden sayılır. İlk kesik baloncuk "…" ile gösterilir. Test: test/ph (andy/lucia, ±12° döndürme).
- **1.11.4:** Telefon: koyu mavi giden baloncukta beyaz yazı mürekkep sayılır (iki yanda koyu mavi olan beyaz piksel). Okuma kalitesi q (kelime güveni; Windows'ta sözlük oranı): baloncuk q<75 atılır, kare q gösterilenden 5 (Win 10) düşükse panel bozulmaz ve hemen yeniden okunur (4 denemeden sonra kabul); belleğe alınmış baloncuk daha net okununca yeniden çevrilir. İlk baloncuk küçük harfle başlasa da tipik cümle başıysa ("hey", "and"…) atılmaz. Yerel test: test/ph/index.html (ceviri-test sunucusu).
- **1.11.3:** İki satırlı (iki konuşmacılı) diyalogda alt satır yeniden sarı (#ffd75e); pembe (#ff7ac8) yalnızca tek satırlık görev hedefinde.
- **1.11.2:** (Windows) Mesaj/telefon katmanı Show() sonra Push() sırasıyla çiziliyor (önceden görünmüyordu), KeepOnTop eklendi. Tam ekran algılama: öndeki pencere monitörü kaplıyorsa monitör oranlı ayrı bölge (FullX/Y/W/H, varsayılan 0,15/0,80/0,70/0,17) ve ayrı sabit konum kullanılır.
- **1.11.1:** Görev hedefi çevirisi pembe (#ff7ac8). Sağ alt arama bildirimi bölgesi (x≥0,77, y≥0,86) altyazı okumasında kalıcı maskelenir. Telefon: düşük güvenli başlık satırından yalnızca güvenli isim kelimesi alınır, cümle gibi satır başlık sayılmaz, "|"→"I", arayüz yazıları 1 harf hatayla da elenir, giden baloncuk mavi zemin oranıyla (≥0,6) da tanınır. Mesaj kutusu: baştaki tek harfli kırıntı silinir, yarım biten mesaja "…" eklenir. Video sarılınca (seeking) mesaj/telefon katmanı gizlenir. Telefon adayı iki ardışık karede görülmeden OCR yapılmaz; aynı yer tekrar reddedilirse 10 sn beklenir.

