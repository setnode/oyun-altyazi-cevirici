import Cocoa
import WebKit

/// Uygulamanın içindeki Xbox: xbox.com/play (bulut oyunları + evdeki konsoldan uzaktan oynatma).
/// Çeviri motoru (content.js) Chrome eklentisindeki gibi sayfanın yalıtılmış dünyasında çalışır,
/// oyun videosunu doğrudan okur: ekran yakalama yok, ek gecikme yok, görüntü kaybı yok.
final class XboxWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, NSToolbarDelegate {
    static let home = URL(string: "https://www.xbox.com/tr-TR/play")!
    let window: NSWindow
    let web: WKWebView
    private var toggleButton: NSButton?
    private let side = NSVisualEffectView()
    private var sideTrailing: NSLayoutConstraint!
    static let sideWidth: CGFloat = 370

    init(resources: URL, version: String) {
        let cfg = makeWebConfig(resources: resources, version: version, role: "page", world: Bridge.world)
        // Dedektör zamanlayıcılarını ortak saate bağla (aynı kareyi paylaşsınlar): eklenti betiklerinden önce
        for f in ["kare-hiza.js", "video-koru.js"] {
            if let src = try? String(contentsOf: resources.appendingPathComponent("mac/" + f), encoding: .utf8) {
                cfg.userContentController.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart,
                                                                     forMainFrameOnly: true, in: Bridge.world))
            }
        }
        // Eklentinin sayfa betikleri (manifest'teki sırayla, document_idle)
        for f in ["sozluk.js", "havuz.js", "content.js"] {
            if let src = try? String(contentsOf: resources.appendingPathComponent("ext/" + f), encoding: .utf8) {
                cfg.userContentController.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentEnd,
                                                                     forMainFrameOnly: true, in: Bridge.world))
            }
        }
        // Yayın kalitesi ve gecikme: sayfanın kendi dünyasında, her şeyden önce
        if let src = try? String(contentsOf: resources.appendingPathComponent("mac/xbox-kalite.js"), encoding: .utf8) {
            cfg.userContentController.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart,
                                                                 forMainFrameOnly: true, in: .page))
        }
        cfg.userContentController.add(PageStats.shared, contentWorld: .page, name: "xctPage")
        cfg.websiteDataStore = .default()            // oturum kalıcı: bir kez giriş yeter
        cfg.preferences.isElementFullscreenEnabled = true
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        cfg.allowsAirPlayForMediaPlayback = false
        cfg.suppressesIncrementalRendering = false

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = appName
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.fullScreenPrimary]
        window.minSize = NSSize(width: 800, height: 480)
        window.backgroundColor = .black
        window.setFrameAutosaveName("Xbox")

        web = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        // xbox.com Safari'yi destekler; WebKit görünümü kendini Safari olarak tanıtsın
        web.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
        web.allowsBackForwardNavigationGestures = true
        web.allowsMagnification = false
        if #available(macOS 13.3, *) { web.isInspectable = true }
        super.init()
        web.navigationDelegate = self
        web.uiDelegate = self
        window.delegate = self
        // İçerik: oyun tam alan, ayarlar sağdan kayan panel (oyunun üstünde)
        let root = NSView()
        window.contentView = root
        web.frame = root.bounds
        root.addSubview(web)
        side.material = .sidebar
        side.blendingMode = .withinWindow
        side.state = .active
        side.translatesAutoresizingMaskIntoConstraints = false
        side.isHidden = true
        side.shadow = { let s = NSShadow(); s.shadowBlurRadius = 18; s.shadowColor = NSColor.black.withAlphaComponent(0.5); return s }()
        side.wantsLayer = true
        root.addSubview(side)
        sideTrailing = side.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: XboxWindow.sideWidth)
        NSLayoutConstraint.activate([
            side.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor),
            side.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            side.widthAnchor.constraint(equalToConstant: XboxWindow.sideWidth),
            sideTrailing,
        ])
        Bridge.shared.xbox = web
        PageStats.shared.onStats = { [weak self] t in self?.window.subtitle = t }

        let tb = NSToolbar(identifier: "xbox")
        tb.delegate = self
        tb.displayMode = .iconOnly
        window.toolbar = tb
        window.toolbarStyle = .unified
        if window.frame.origin == .zero { window.center() }

        web.load(URLRequest(url: XboxWindow.home))
        startDebug()
    }

    // Hata ayıklama (yalnızca debug dosyası varsa): sayfada kod çalıştırma, anlık görüntü, eklenti günlüğü
    private var dbgTimer: Timer?
    private func startDebug() {
        guard Debug.on else { return }
        dbgTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self else { return }
            let xURL = Store.dir.appendingPathComponent("eval-xbox.js")
            if let js = try? String(contentsOf: xURL, encoding: .utf8) {
                try? FileManager.default.removeItem(at: xURL)
                self.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: Bridge.world) { r in
                    switch r {
                    case .success(let v): Debug.log("xbox eval: \(v)")
                    case .failure(let e): Debug.log("xbox eval hata: \(e)")
                    }
                }
            }
            // Eklenti günlüğü: önbellekteki öğeden oku (her seferinde tüm sayfayı tarama)
            self.web.callAsyncJavaScript("let h=window.__xctHostEl;if(!h||!h.isConnected){h=null;for(const d of document.body.children){if(d.shadowRoot&&d.shadowRoot.getElementById('subText')){h=d;break}}window.__xctHostEl=h}const l=h&&h.dataset.xctLog;if(!l||l===window.__lastL)return '';window.__lastL=l;return JSON.parse(l).slice(-4).map(e=>JSON.stringify(e)).join('\\n')", arguments: [:], in: nil, in: Bridge.world) { r in
                if case .success(let v) = r, let s = v as? String, !s.isEmpty { Debug.log("eklenti:\n" + s) }
            }
            // Anlık görüntü yalnızca istenince (foto dosyası): her seferinde alınırsa sayfa takılır
            let foto = Store.dir.appendingPathComponent("foto")
            guard FileManager.default.fileExists(atPath: foto.path) else { return }
            try? FileManager.default.removeItem(at: foto)
            self.web.takeSnapshot(with: nil) { img, _ in
                if let t = img?.tiffRepresentation, let r = NSBitmapImageRep(data: t),
                   let j = r.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) {
                    try? j.write(to: Store.dir.appendingPathComponent("xbox.jpg"))
                }
            }
        }
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    var isActive: Bool { window.isVisible && !window.isMiniaturized }

    func renderToggle(_ on: Bool) {
        toggleButton?.image = NSImage(systemSymbolName: on ? "captions.bubble.fill" : "captions.bubble",
                                      accessibilityDescription: nil)
        toggleButton?.contentTintColor = on ? .systemGreen : nil
        toggleButton?.toolTip = on ? "Çeviri açık (⌥T)" : "Çeviri kapalı (⌥T)"
    }

    // MARK: Araç çubuğu
    private let ids: [NSToolbarItem.Identifier] = [
        .init("geri"), .init("yenile"), .init("ana"), .flexibleSpace, .init("ceviri"), .init("bolge"), .init("ayarlar"), .init("tam"),
    ]
    func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { ids }
    func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { ids }

    func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar f: Bool) -> NSToolbarItem? {
        let spec: [String: (String, String, Selector)] = [
            "geri": ("chevron.left", "Geri", #selector(goBack)),
            "yenile": ("arrow.clockwise", "Yenile", #selector(reload)),
            "ana": ("house", "Xbox ana sayfa", #selector(goHome)),
            "ceviri": ("captions.bubble", "Çeviriyi aç / kapat (⌥T)", #selector(toggleTranslate)),
            "bolge": ("rectangle.dashed", "Altyazı bölgesini seç (⌥R)", #selector(selectRegion)),
            "ayarlar": ("slider.horizontal.3", "Çeviri ayarları", #selector(openSettings)),
            "tam": ("arrow.up.left.and.arrow.down.right", "Tam ekran", #selector(fullScreen)),
        ]
        guard let (sym, tip, sel) = spec[id.rawValue] else { return nil }
        let item = NSToolbarItem(itemIdentifier: id)
        let b = NSButton(image: NSImage(systemSymbolName: sym, accessibilityDescription: tip)!, target: self, action: sel)
        b.bezelStyle = .texturedRounded
        b.toolTip = tip
        item.view = b
        item.label = tip
        if id.rawValue == "ceviri" { toggleButton = b; renderToggle(Store.shared.bool("enabled")) }
        return item
    }

    /// Uyumlu modu aç/kapat: xbox.com'un kendi deposunda tutulur, sayfa yenilenince geçerli olur
    func setUyumlu(_ on: Bool) {
        let js = on ? "localStorage.setItem('xctUyumlu','1')" : "localStorage.removeItem('xctUyumlu')"
        web.evaluateJavaScript(js, in: nil, in: .page) { [weak self] _ in self?.web.reload() }
    }

    /// Tanı raporu: sürüm, sistem, bağlantı olayları ve son ölçümler (hesap/oturum bilgisi içermez)
    func taniRaporu() -> String {
        let p = ProcessInfo.processInfo
        var model = [CChar](repeating: 0, count: 64); var n = 64
        sysctlbyname("hw.model", &model, &n, nil, 0)
        var r = "\(appName) \(appVersion) tanı raporu\n"
        r += "macOS \(p.operatingSystemVersionString) · \(String(cString: model)) · \(p.processorCount) çekirdek\n"
        r += "Uyumlu mod: \(PageStats.shared.uyumlu ? "açık" : "kapalı")\n"
        r += "Ekran: " + NSScreen.screens.map { "\(Int($0.frame.width))×\(Int($0.frame.height))@\(Int($0.backingScaleFactor))x" }.joined(separator: ", ") + "\n"
        r += "Sayfa: " + (web.url.map { ($0.host ?? "") + $0.path } ?? "-") + "\n\n"
        r += "--- Olaylar ---\n" + PageStats.shared.olaylar.joined(separator: "\n") + "\n\n"
        r += "--- Son ölçümler ---\n" + PageStats.shared.olcumler.joined(separator: "\n") + "\n"
        return r
    }

    @objc func goBack() { if web.canGoBack { web.goBack() } }
    @objc func reload() { web.reload() }
    @objc func goHome() { web.load(URLRequest(url: XboxWindow.home)) }
    @objc func toggleTranslate() { Bridge.shared.command("toggle") }
    @objc func selectRegion() { Bridge.shared.command("select-region") }
    @objc func openSettings() { setSide(side.isHidden) }

    /// Ayar sayfasını sağ panele yerleştir
    func attachSettings(_ v: WKWebView) {
        v.removeFromSuperview()
        v.translatesAutoresizingMaskIntoConstraints = false
        side.addSubview(v)
        NSLayoutConstraint.activate([
            v.topAnchor.constraint(equalTo: side.topAnchor), v.bottomAnchor.constraint(equalTo: side.bottomAnchor),
            v.leadingAnchor.constraint(equalTo: side.leadingAnchor), v.trailingAnchor.constraint(equalTo: side.trailingAnchor),
        ])
    }

    /// Sağ paneli kaydırarak aç / kapat
    func setSide(_ open: Bool) {
        if open == !side.isHidden && (open ? sideTrailing.constant == 0 : true) { return }
        if open { side.isHidden = false }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.22
            ctx.timingFunction = CAMediaTimingFunction(name: open ? .easeOut : .easeIn)
            ctx.allowsImplicitAnimation = true
            sideTrailing.animator().constant = open ? 0 : XboxWindow.sideWidth
            window.contentView?.layoutSubtreeIfNeeded()
        }, completionHandler: { [weak self] in
            if !open { self?.side.isHidden = true; self?.window.makeFirstResponder(self?.web) }
        })
    }
    @objc func fullScreen() { window.toggleFullScreen(nil) }

    // Tam ekranda araç çubuğu gizlensin, oyun tüm ekranı kaplasın
    func window(_ window: NSWindow, willUseFullScreenPresentationOptions o: NSApplication.PresentationOptions = []) -> NSApplication.PresentationOptions {
        [.fullScreen, .autoHideMenuBar, .autoHideToolbar, .autoHideDock]
    }

    // MARK: Gezinme
    // Yeni pencere isteyen bağlantılar (giriş, yardım) aynı pencerede açılsın
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { webView.load(URLRequest(url: u)) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = action.request.url, let scheme = u.scheme?.lowercased() else { decisionHandler(.allow); return }
        if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(u)   // ms-xbox:// gibi bağlantılar
            decisionHandler(.cancel)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // Kamera/mikrofon (sohbet) iznini sor; oyun akışı için gerekmez
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.prompt) }
}

/// xbox.com sayfasından yalnızca yayın ölçümü ve günlük alır (sayfa ayarlara/anahtarlara erişemez)
final class PageStats: NSObject, WKScriptMessageHandler {
    static let shared = PageStats()
    var onStats: ((String) -> Void)?
    var uyumlu = false
    // Tanı raporu için son olaylar (hata ayıklama modu kapalıyken de tutulur; yalnızca istenince dosyaya yazılır)
    private(set) var olaylar: [String] = []
    private(set) var olcumler: [String] = []
    private let saat: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f }()
    private func ekle(_ t: String, olcum: Bool = false) {
        let satir = saat.string(from: Date()) + " " + t
        if olcum { olcumler.append(satir); if olcumler.count > 30 { olcumler.removeFirst() } }
        else { olaylar.append(satir); if olaylar.count > 300 { olaylar.removeFirst() } }
    }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let b = message.body as? [String: Any], let op = b["op"] as? String else { return }
        if op == "log", let t = b["text"] as? String { ekle(t); Debug.log("[yayın] " + t); return }
        if op == "durum", let t = b["text"] as? String { ekle("durum: " + t); onStats?(t); return }
        if op == "uyumlu" { uyumlu = (b["on"] as? Bool) ?? false; return }
        guard op == "stats" else { return }
        func n(_ k: String) -> Int { (b[k] as? NSNumber)?.intValue ?? 0 }
        let mbps = (b["mbps"] as? NSNumber)?.doubleValue ?? 0
        let rtt = n("rtt"), jb = n("jb")
        var parts = ["\(n("w"))×\(n("h"))", "\(n("fps")) fps", String(format: "%.1f Mbps", mbps)]
        if rtt >= 0 { parts.append("ağ \(rtt) ms") }
        parts.append("tampon \(jb) ms")
        if let c = b["codec"] as? String, !c.isEmpty { parts.append(c) }
        let text = parts.joined(separator: " · ")
        onStats?(text)
        ekle(text + " kayıp=\(n("lost")) atlanan=\(n("dropped"))", olcum: true)
        Debug.log("[ölçüm] " + text + " kayıp=\(n("lost")) atlanan=\(n("dropped")) çözme=\(b["dec"] ?? 0) ms")
    }
}
