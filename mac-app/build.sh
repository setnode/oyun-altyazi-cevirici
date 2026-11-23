#!/bin/zsh
# İki Mac uygulamasını aynı kaynaktan derler:
#   build/setdeniz play.app       — Xbox'ı oynatır, altyazı çevirisi içinde
#   build/Altyazı Çevirici.app    — PS Remote Play gibi başka pencerelerin altyazısını çevirir
# ./build.sh zip → ikisinin de zip paketi
set -e
cd "$(dirname "$0")"
VERSION="1.0.0"
EXT="../xcloud-ceviri"
rm -rf build; mkdir -p build

# Apple Silicon + Intel tek dosyada (bir kez derlenir, iki uygulama da kullanır)
for ARCH in arm64 x86_64; do
  swiftc -O -swift-version 5 -target $ARCH-apple-macos13.0 \
    -framework Cocoa -framework WebKit -framework ScreenCaptureKit -framework CoreImage -framework Carbon \
    Sources/*.swift -o build/bin-$ARCH
done
lipo -create build/bin-arm64 build/bin-x86_64 -output build/bin; rm build/bin-arm64 build/bin-x86_64

paketle() {  # ad, çalıştırılabilir, kimlik, simge
  local APP="build/$1.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/ext" "$APP/Contents/Resources/mac"
  cp build/bin "$APP/Contents/MacOS/$2"
  sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$(date +%Y%m%d%H%M)/" -e "s/__NAME__/$1/" -e "s/__EXEC__/$2/" -e "s/__ID__/$3/" \
    Info.plist > "$APP/Contents/Info.plist"
  # Eklentinin motoru olduğu gibi (Chrome sürümüyle aynı sözlük, havuz ve OCR)
  for f in content.js sozluk.js havuz.js ceviri-ag.js ocr-engine.js popup.html popup.js kelimeler.txt gta6-havuz.json manifest.json; do
    cp "$EXT/$f" "$APP/Contents/Resources/ext/"
  done
  cp -R "$EXT/vendor" "$APP/Contents/Resources/ext/"
  cp web/* "$APP/Contents/Resources/mac/"
  local ICONSET=build/AppIcon.iconset; mkdir -p $ICONSET
  for s in 16 32 64 128 256 512; do
    sips -z $s $s "$4" --out $ICONSET/icon_${s}x${s}.png >/dev/null
    local d=$((s*2)); sips -z $d $d "$4" --out $ICONSET/icon_${s}x${s}@2x.png >/dev/null
  done
  iconutil -c icns $ICONSET -o "$APP/Contents/Resources/AppIcon.icns"; rm -rf $ICONSET
  # Kimlik tabanlı imza: ekran kaydı izni yeni sürümlerde de geçerli kalsın
  codesign --force --deep --sign - -r="designated => identifier \"$3\"" "$APP"
  echo "Hazır: $APP"
}

paketle "setdeniz play" "SetdenizPlay" "com.setnode.setdenizplay" icons/play.png
paketle "Altyazı Çevirici" "AltyaziCevirici" "com.setnode.altyazicevirici" "$EXT/icons/128.png"
rm build/bin

if [ "$1" = "zip" ]; then
  for pair in "setdeniz play:setdeniz-play-Mac:BENIOKU-play.txt" "Altyazı Çevirici:Altyazi-Cevirici-Mac:BENIOKU.txt"; do
    NAME="${pair%%:*}"; REST="${pair#*:}"; ZIP="${REST%%:*}"; DOC="${REST#*:}"
    rm -rf build/paket; mkdir -p build/paket
    ditto "build/$NAME.app" "build/paket/$NAME.app"; cp "$DOC" build/paket/BENIOKU.txt
    (cd build/paket && ditto -c -k --sequesterRsrc . "../$ZIP.zip")
    echo "Zip: build/$ZIP.zip"
  done
  rm -rf build/paket
fi
