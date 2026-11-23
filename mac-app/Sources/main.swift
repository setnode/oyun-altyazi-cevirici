import Cocoa
import WebKit
import Carbon.HIToolbox
import ScreenCaptureKit

let appVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0"
/// Aynı kaynaktan iki uygulama: "setdeniz play" (Xbox oynatır, çeviri içinde) ve "Altyazı Çevirici" (başka pencereleri çevirir)
let isPlay = Bundle.main.bundleIdentifier == "com.setnode.setdenizplay"
let appName = (Bundle.main.infoDictionary?["CFBundleName"] as? String) ?? "Altyazı Çevirici"

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, WKNavigationDelegate, WKDownloadDelegate {
    var overlay: Overlay!
    var xbox: XboxWindow!
    var bgWeb: WKWebView!
    var settingsWindow: NSWindow!
    var settingsWeb: WKWebView!
    var sourcePopup: NSPopUpButton!
    var statusLabel: NSTextField!
    var permButton: NSButton!
    var statusItem: NSStatusItem!
    var toggleItem: NSMenuItem!
    var sources: [Source] = []
    var activity: NSObjectProtocol?
    var hotKeys: [EventHotKeyRef?] = []
    var resources: URL { Bundle.main.resourceURL! }

    func applicationDidFinishLaunching(_ n: Notification) {
        // Uygulama arka plandayken de (oyun öndeyken) yavaşlamasın
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical],
                                                         reason: "Canlı altyazı çevirisi")
        buildMenu()
        // OCR + çeviri arka planı (Xbox sayfası ve pencere katmanı ortak kullanır)
        let bgCfg = makeWebConfig(resources: resources, version: appVersion, role: "bg")
        // Pencerede görünmeyen bu belge macOS'ta düşük önceliğe alınıp yavaşlatılmasın (OCR işçileri burada)
        if #available(macOS 14.0, *) { bgCfg.preferences.inactiveSchedulingPolicy = .none }
        bgWeb = WKWebView(frame: NSRect(x: 0, y: 0, width: 10, height: 10), configuration: bgCfg)
        Bridge.shared.bg = bgWeb
        bgWeb.load(URLRequest(url: URL(string: "xct://app/mac/bg.html")!))
        // setdeniz play ekranı hiç yakalamaz: çeviri oyun videosunu sayfanın içinden okur
        if !isPlay {
            overlay = Overlay(resources: resources, version: appVersion)
            overlay.onTargetGone = { [weak self] in self?.targetGone() }
            Capture.shared.onStop = { [weak self] err in self?.setStatus("Yakalama durdu: \(err)", warn: true) }
        }
        Bridge.shared.onCloseSettings = { [weak self] in
            if isPlay { self?.xbox?.setSide(false) } else { self?.settingsWindow.orderOut(nil) }
        }
        Bridge.shared.onEnabledChanged = { [weak self] on in self?.renderToggle(on); self?.xbox?.renderToggle(on) }
        Bridge.shared.preferXbox = { [weak self] in
            guard let self, let x = self.xbox, x.isActive else { return false }
            guard Capture.shared.running else { return true }
            // İkisi de açıksa: öndeki pencere Xbox ise ona
            return NSApp.isActive && (x.window.isKeyWindow || x.window.isMainWindow)
        }
        if !isPlay { buildStatusItem() }
        buildSettingsWindow()
        registerHotKeys()
        renderToggle(Store.shared.bool("enabled"))
        if isPlay {
            xbox = XboxWindow(resources: resources, version: appVersion)
            xbox.attachSettings(settingsWeb)   // ayarlar pencerenin sağında açılan panelde
            xbox.show()
            return
        }
        showSettings()
        let tests = ((try? FileManager.default.contentsOfDirectory(at: Store.dir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("test") && $0.pathExtension == "jpg" }.sorted { $0.path < $1.path }
        if Debug.on, !tests.isEmpty {
            Capture.shared.startTest(images: tests, at: CGRect(x: 80, y: 120, width: 960, height: 540))
            overlay.startTracking()
            setStatus("TEST MODU", warn: true)
            return
        }
        checkPermissionAndStart()
    }

    func applicationWillTerminate(_ n: Notification) {
        Store.shared.flushSync()
        Capture.shared.stop()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { if isPlay { xbox.show() } else { showSettings() } }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: İzin ve kaynak
    /// Ekran kaydı izni yalnızca başka bir pencere çevrilecekse gerekir (Xbox için gerekmez)
    func checkPermissionAndStart() {
        refreshSources(autoStart: true)
    }

    private var permTimer: Timer?
    func askPermission() {
        CGRequestScreenCaptureAccess()
        permButton.isHidden = false
        setStatus("Ekran kaydı izni gerekli: Sistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Sesi Kaydı'nda "
                  + "“Altyazı Çevirici”yi açın; macOS isterse uygulamayı yeniden başlatın.", warn: true)
        permTimer?.invalidate()
        permTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
            if CGPreflightScreenCaptureAccess() { t.invalidate(); self?.permButton.isHidden = true; self?.refreshSources(autoStart: false) }
        }
    }

    @objc func openPrivacy() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }

    @objc func refreshClicked() { refreshSources(autoStart: false) }

    func refreshSources(autoStart: Bool) {
        guard CGPreflightScreenCaptureAccess() else { askPermission(); return }
        Capture.shared.listSources { [weak self] list in
            guard let self else { return }
            self.sources = list
            self.sourcePopup.removeAllItems()
            self.sourcePopup.addItem(withTitle: "— Oyun penceresini seçin —")
            for s in list { self.sourcePopup.addItem(withTitle: self.label(s)) }
            // Önceki seçim → bilinen oyun uygulaması → hiçbiri
            var pick: Int?
            if let cur = Capture.shared.source, let i = list.firstIndex(where: { $0.kind == cur.kind }) { pick = i }
            let lastBundle = UserDefaults.standard.string(forKey: "sourceBundle") ?? ""
            let lastTitle = UserDefaults.standard.string(forKey: "sourceTitle") ?? ""
            if pick == nil, !lastBundle.isEmpty {
                pick = list.firstIndex(where: { $0.bundleID == lastBundle && $0.title == lastTitle })
                    ?? list.firstIndex(where: { $0.bundleID == lastBundle })
            }
            if pick == nil {
                pick = list.firstIndex(where: { ["com.playstation.RemotePlay", "com.nvidia.gfnpc.mall", "com.nvidia.geforcenow"].contains($0.bundleID) })
            }
            if let p = pick {
                self.sourcePopup.selectItem(at: p + 1)
                if autoStart || Capture.shared.source?.kind != list[p].kind { self.startSource(list[p]) }
            } else if Capture.shared.source == nil {
                self.setStatus("PS Remote Play, GeForce NOW ya da oyunun açık olduğu pencereyi seçin.", warn: false)
            }
        }
    }

    func label(_ s: Source) -> String {
        switch s.kind {
        case .display: return "🖥  " + s.title
        case .window:
            let t = s.title.trimmingCharacters(in: .whitespaces)
            return t.isEmpty || t == s.appName ? s.appName : "\(s.appName) — \(t)"
        }
    }

    @objc func sourceChanged() {
        let i = sourcePopup.indexOfSelectedItem - 1
        guard i >= 0, i < sources.count else {
            Capture.shared.stop(); overlay.stopTracking()
            setStatus("Kaynak seçilmedi.", warn: false); return
        }
        startSource(sources[i])
    }

    func startSource(_ s: Source) {
        setStatus("Bağlanıyor: \(label(s))…", warn: false)
        Capture.shared.start(s) { [weak self] err in
            guard let self else { return }
            if let err { self.setStatus("Yakalanamadı: \(err)", warn: true); return }
            UserDefaults.standard.set(s.bundleID, forKey: "sourceBundle")
            UserDefaults.standard.set(s.title, forKey: "sourceTitle")
            self.overlay.startTracking()
            self.setStatus("Bağlı: \(self.label(s)). Çeviriyi açın (⌥T); altyazı bölgesini seçmek için ⌥R.", warn: false)
        }
    }

    func debugSelect(bundle: String) {
        Capture.shared.listSources { [weak self] list in
            let parts = bundle.components(separatedBy: "|")
            guard let self, let i = list.firstIndex(where: { $0.bundleID == parts[0] && (parts.count < 2 || $0.title.contains(parts[1])) }) else { Debug.log("kaynak yok: \(bundle)"); return }
            self.sources = list
            self.startSource(list[i])
            Debug.log("kaynak seçildi: \(self.label(list[i]))")
        }
    }

    func targetGone() {
        Capture.shared.stop()
        overlay.stopTracking()
        setStatus("Oyun penceresi kapandı. Yeniden açınca listeden seçin.", warn: true)
        refreshSources(autoStart: false)
    }

    func setStatus(_ t: String, warn: Bool) {
        statusLabel.stringValue = t
        statusLabel.textColor = warn ? .systemOrange : .secondaryLabelColor
    }

    // MARK: Ayar penceresi
    func buildSettingsWindow() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 760),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = isPlay ? "Çeviri Ayarları" : appName
        w.isReleasedWhenClosed = false
        w.minSize = NSSize(width: 360, height: 420)
        w.setFrameAutosaveName("Ayarlar")

        let root = NSView()
        w.contentView = root

        let title = NSTextField(labelWithString: "OYUN PENCERESİ")
        title.font = .systemFont(ofSize: 11, weight: .bold)
        title.textColor = .secondaryLabelColor
        sourcePopup = NSPopUpButton(frame: .zero, pullsDown: false)
        sourcePopup.target = self; sourcePopup.action = #selector(sourceChanged)
        sourcePopup.menu?.delegate = self
        let refresh = NSButton(title: "Yenile", target: self, action: #selector(refreshClicked))
        refresh.bezelStyle = .rounded
        statusLabel = NSTextField(wrappingLabelWithString: "")
        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = .secondaryLabelColor
        permButton = NSButton(title: "Ekran kaydı iznini aç", target: self, action: #selector(openPrivacy))
        permButton.bezelStyle = .rounded
        permButton.isHidden = true

        let sep = NSBox(); sep.boxType = .separator

        let cfg = makeWebConfig(resources: resources, version: appVersion, role: "popup")
        // Ayar sayfası pencereye yayılsın; başlık Mac uygulamasının adı olsun
        cfg.userContentController.addUserScript(WKUserScript(source: """
            document.addEventListener('DOMContentLoaded', () => {
              const st = document.createElement('style');
              st.textContent = 'body{width:auto !important}';
              document.head.appendChild(st);
              const h = document.querySelector('h1');
              if (h && h.firstChild && h.firstChild.nodeType === 3) h.firstChild.textContent = \(jsString(appName + " "));
              document.title = \(jsString(appName));
              // Mac klavyesi: Alt yerine ⌥
              document.querySelectorAll('kbd').forEach((k) => { if (k.textContent === 'Alt') k.textContent = '⌥'; });
              document.querySelectorAll('[title]').forEach((e) => { e.title = e.title.replace(/Alt\\+/g, '⌥'); });
            });
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        settingsWeb = WKWebView(frame: .zero, configuration: cfg)
        settingsWeb.navigationDelegate = self
        settingsWeb.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { settingsWeb.isInspectable = true }
        Bridge.shared.settings = settingsWeb
        settingsWeb.load(URLRequest(url: URL(string: "xct://app/ext/popup.html")!))

        for v in [title, sourcePopup!, refresh, statusLabel!, permButton!, sep, settingsWeb!] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
        }
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            sourcePopup.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 6),
            sourcePopup.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            sourcePopup.trailingAnchor.constraint(equalTo: refresh.leadingAnchor, constant: -6),
            refresh.centerYAnchor.constraint(equalTo: sourcePopup.centerYAnchor),
            refresh.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            statusLabel.topAnchor.constraint(equalTo: sourcePopup.bottomAnchor, constant: 6),
            statusLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            statusLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            permButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 6),
            permButton.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            sep.topAnchor.constraint(equalTo: permButton.bottomAnchor, constant: 10),
            sep.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            sep.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            settingsWeb.topAnchor.constraint(equalTo: isPlay ? root.topAnchor : sep.bottomAnchor),
            settingsWeb.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            settingsWeb.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            settingsWeb.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        // setdeniz play'de pencere seçimi yok: ayar sayfası pencerenin tamamı
        if isPlay { for v in [title, sourcePopup!, refresh, statusLabel!, permButton!, sep] as [NSView] { v.isHidden = true } }
        // İzin düğmesi gizliyken boşluk kalmasın
        permButton.setContentHuggingPriority(.required, for: .vertical)
        w.center()
        settingsWindow = w
    }

    // Açılır liste açılırken pencereleri tazele
    func menuWillOpen(_ menu: NSMenu) {
        if menu === sourcePopup.menu { refreshSources(autoStart: false) }
    }

    @objc func showSettings() {
        if isPlay { xbox.show(); xbox.setSide(true); return }
        settingsWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // "GTA 6 kaydını indir" → İndirilenler klasörüne
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload || action.request.url?.scheme == "blob" { decisionHandler(.download); return }
        if let u = action.request.url, u.scheme == "https" {
            NSWorkspace.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var url = dir.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: url.path) {
            let base = (suggestedFilename as NSString).deletingPathExtension, ext = (suggestedFilename as NSString).pathExtension
            url = dir.appendingPathComponent("\(base) (\(n)).\(ext)"); n += 1
        }
        completionHandler(url)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // MARK: Menü çubuğu
    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let b = statusItem.button {
            b.image = NSImage(systemSymbolName: "captions.bubble", accessibilityDescription: "Altyazı Çevirici")
            b.image?.isTemplate = true
        }
        let m = NSMenu()
        toggleItem = NSMenuItem(title: "Çeviriyi aç", action: #selector(toggleTranslate), keyEquivalent: "t")
        toggleItem.keyEquivalentModifierMask = [.option]
        m.addItem(toggleItem)
        let sel = NSMenuItem(title: "Altyazı bölgesini seç", action: #selector(selectRegion), keyEquivalent: "r")
        sel.keyEquivalentModifierMask = [.option]
        m.addItem(sel)
        m.addItem(NSMenuItem(title: "Önizle", action: #selector(previewSub), keyEquivalent: ""))
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: "Ayarlar…", action: #selector(showSettings), keyEquivalent: ","))
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: "Çıkış", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for i in m.items { i.target = i.action == #selector(NSApplication.terminate(_:)) ? NSApp : self }
        statusItem.menu = m
    }

    func renderToggle(_ on: Bool) {
        toggleItem?.title = on ? "Çeviriyi kapat" : "Çeviriyi aç"
        statusItem?.button?.appearsDisabled = !on
    }

    @objc func toggleTranslate() { Bridge.shared.command("toggle") }
    @objc func showXbox() { xbox.show() }

    @objc func selectRegion() {
        if Bridge.shared.preferXbox?() ?? false { Bridge.shared.command("select-region"); return }
        guard Capture.shared.running else { showSettings(); setStatus("Önce oyun penceresini seçin.", warn: true); return }
        settingsWindow.orderOut(nil)
        overlay.beginSelect()
    }
    @objc func previewSub() { Bridge.shared.sendToContent(["type": "preview"]) }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let am = NSMenu()
        am.addItem(NSMenuItem(title: "\(appName) Hakkında", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        am.addItem(.separator())
        am.addItem(NSMenuItem(title: "Ayarlar…", action: #selector(showSettings), keyEquivalent: ","))
        if isPlay { am.addItem(NSMenuItem(title: "Xbox", action: #selector(showXbox), keyEquivalent: "1")) }
        am.addItem(.separator())
        am.addItem(NSMenuItem(title: "Gizle", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        am.addItem(NSMenuItem(title: "Çıkış", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = am
        let editItem = NSMenuItem(); main.addItem(editItem)
        let em = NSMenu(title: "Düzen")
        em.addItem(NSMenuItem(title: "Kes", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        em.addItem(NSMenuItem(title: "Kopyala", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        em.addItem(NSMenuItem(title: "Yapıştır", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        em.addItem(NSMenuItem(title: "Tümünü Seç", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = em
        let winItem = NSMenuItem(); main.addItem(winItem)
        let wm = NSMenu(title: "Pencere")
        wm.addItem(NSMenuItem(title: "Kapat", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        wm.addItem(NSMenuItem(title: "Küçült", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        winItem.submenu = wm
        NSApp.mainMenu = main
    }

    // MARK: Genel kısayollar: ⌥T aç/kapat, ⌥R bölge seç (oyun öndeyken de çalışır)
    func registerHotKeys() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, ev, _ in
            var id = EventHotKeyID()
            GetEventParameter(ev, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &id)
            DispatchQueue.main.async {
                let d = NSApp.delegate as! AppDelegate
                if id.id == 1 { d.toggleTranslate() } else if id.id == 2 { d.selectRegion() }
            }
            return noErr
        }, 1, &spec, nil, nil)
        for (i, key) in [(UInt32(1), UInt32(kVK_ANSI_T)), (UInt32(2), UInt32(kVK_ANSI_R))] {
            var ref: EventHotKeyRef?
            RegisterEventHotKey(key, UInt32(optionKey), EventHotKeyID(signature: OSType(0x58435443), id: i),
                                GetApplicationEventTarget(), 0, &ref)
            hotKeys.append(ref)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
