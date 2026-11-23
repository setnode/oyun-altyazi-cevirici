import Cocoa
import WebKit

/// Oyun görüntüsünün tam üstünde duran, saydam, fareyi geçiren pencere.
/// İçinde eklentinin sayfa betiği (content.js) çalışır; altyazıyı eklentideki gibi o çizer.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class Overlay: NSObject, WKNavigationDelegate {
    let panel: OverlayPanel
    let web: WKWebView
    private var timer: Timer?
    private(set) var selecting = false
    var onTargetGone: (() -> Void)?

    init(resources: URL, version: String) {
        panel = OverlayPanel(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 720),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        // Ekran paylaşımında / kayıtta katman görünmesin; kendi yakalamamıza da karışmasın
        panel.sharingType = .none

        let cfg = makeWebConfig(resources: resources, version: version, role: "host")
        web = WKWebView(frame: panel.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }
        super.init()
        web.navigationDelegate = self
        panel.contentView = web
        Bridge.shared.host = web
        if Debug.on {
            web.configuration.userContentController.addUserScript(WKUserScript(source: "try{localStorage.setItem('xctDebug','1')}catch(e){}", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        Bridge.shared.onSelecting = { [weak self] on in self?.setSelecting(on) }
        Capture.shared.onGeometry = { [weak self] in self?.reposition() }
        startDebugSnapshots()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // WebKit süreci çökerse sayfayı yeniden aç (ayarlar ve önbellek depoda durur)
        webView.reload()
    }

    // MARK: Konum takibi
    private var dbgTimer: Timer?
    func startDebugSnapshots() {
        guard Debug.on else { return }
        dbgTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self else { return }
            let srcURL = Store.dir.appendingPathComponent("kaynak.txt")
            if let b = try? String(contentsOf: srcURL, encoding: .utf8) {
                try? FileManager.default.removeItem(at: srcURL)
                (NSApp.delegate as? AppDelegate)?.debugSelect(bundle: b.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            let evalURL = Store.dir.appendingPathComponent("eval.js")
            if let js = try? String(contentsOf: evalURL, encoding: .utf8) {
                try? FileManager.default.removeItem(at: evalURL)
                self.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
                    switch r {
                    case .success(let v): Debug.log("eval: \(v)")
                    case .failure(let e): Debug.log("eval hata: \(e)")
                    }
                }
            }
            let cap = Capture.shared
            Debug.log("durum: kaynak=\(cap.source?.appName ?? "-") pencere=\(cap.windowFrame) kare=\(cap.framePx) oyun=\(cap.contentPx) katman=\(self.panel.frame) görünür=\(self.panel.isVisible) izin=\(CGPreflightScreenCaptureAccess())")
            cap.jpeg(after: -1) { d, _ in try? d?.write(to: Store.dir.appendingPathComponent("kare.jpg")) }
            self.web.evaluateJavaScript("(()=>{const v=document.getElementById('v');const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);return v.videoWidth+'x'+v.videoHeight+' rs='+v.readyState+'|'+c.toDataURL('image/jpeg',0.9)})()") { r, _ in
                guard let s = r as? String, let bar = s.firstIndex(of: "|") else { return }
                Debug.log("video: " + s[..<bar])
                let b64 = s[s.index(after: bar)...].components(separatedBy: ",").last ?? ""
                if let d = Data(base64Encoded: b64) { try? d.write(to: Store.dir.appendingPathComponent("video.jpg")) }
            }
            self.web.evaluateJavaScript("(()=>{const h=[...document.body.children].find(d=>d.shadowRoot);const l=h&&h.dataset.xctLog;if(!l||l===window.__lastL)return '';window.__lastL=l;return JSON.parse(l).slice(-4).map(e=>JSON.stringify(e)).join('\\n')})()") { r, _ in
                if let s = r as? String, !s.isEmpty { Debug.log("eklenti:\n" + s) }
            }
            self.web.takeSnapshot(with: nil) { img, _ in
                if let t = img?.tiffRepresentation, let r = NSBitmapImageRep(data: t), let png = r.representation(using: .png, properties: [:]) {
                    try? png.write(to: Store.dir.appendingPathComponent("katman.png"))
                }
            }
        }
    }

    /// Katman sayfası yalnızca bir pencere yakalanırken çalışır (boşta OCR yapmasın)
    private var loaded = false
    func startTracking() {
        if !loaded { loaded = true; web.load(URLRequest(url: URL(string: "xct://app/mac/host.html")!)) }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.track() }
        RunLoop.main.add(timer!, forMode: .common)
        track()
    }

    func stopTracking() {
        timer?.invalidate(); timer = nil
        panel.orderOut(nil)
        if loaded { loaded = false; web.loadHTMLString("", baseURL: nil) }
    }

    private var lastFrame = CGRect.zero
    private var goneTicks = 0

    private func track() {
        guard let src = Capture.shared.source else { panel.orderOut(nil); return }
        var visible = true
        switch src.kind {
        case .window(let id):
            guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first,
                  let b = info[kCGWindowBounds as String] as? NSDictionary,
                  let f = CGRect(dictionaryRepresentation: b) else {
                goneTicks += 1
                if goneTicks > 20 { onTargetGone?() }
                panel.orderOut(nil); return
            }
            goneTicks = 0
            let onScreen = (info[kCGWindowIsOnscreen as String] as? Bool) ?? false
            if f != lastFrame { lastFrame = f; Capture.shared.updateWindowFrame(f); reposition() }
            // Oyun öndeyken göster; başka uygulamaya geçilince gizle (bizim pencerelerimiz hariç)
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            let me = ProcessInfo.processInfo.processIdentifier
            visible = onScreen && (front == src.pid || front == me || selecting)
        case .display:
            if lastFrame == .zero { lastFrame = Capture.shared.windowFrame; reposition() }
        }
        Capture.shared.paused = !visible
        if visible {
            if !panel.isVisible { reposition(); panel.orderFrontRegardless() }
        } else if panel.isVisible && !selecting {
            panel.orderOut(nil)
        }
    }

    /// Katmanı oyun görüntüsünün üstüne oturt (CG → Cocoa koordinatı)
    func reposition() {
        let cap = Capture.shared
        let wf = cap.windowFrame
        guard wf.width > 0, cap.framePx.width > 0 else { return }
        let kx = wf.width / cap.framePx.width, ky = wf.height / cap.framePx.height
        let c = cap.contentPx == .zero ? CGRect(origin: .zero, size: cap.framePx) : cap.contentPx
        let cg = CGRect(x: wf.minX + c.minX * kx, y: wf.minY + c.minY * ky, width: c.width * kx, height: c.height * ky)
        let primaryH = NSScreen.screens.first?.frame.height ?? 0
        let cocoa = NSRect(x: cg.minX, y: primaryH - cg.maxY, width: cg.width, height: cg.height)
        if panel.frame.integral != cocoa.integral { panel.setFrame(cocoa, display: true) }
    }

    // MARK: Bölge seçimi (fare yalnızca bu sırada katmana gelir)
    private func setSelecting(_ on: Bool) {
        selecting = on
        panel.ignoresMouseEvents = !on
        if on {
            NSApp.activate(ignoringOtherApps: true)
            panel.orderFrontRegardless()
            panel.makeKey()
        } else {
            panel.resignKey()
            // Oyuna geri dön
            if let pid = Capture.shared.source?.pid, pid > 0 {
                NSRunningApplication(processIdentifier: pid)?.activate(options: [])
            }
        }
    }

    func beginSelect() {
        // content.js seçim katmanını açar; fare ve klavye için katman öne gelsin
        panel.ignoresMouseEvents = false
        NSApp.activate(ignoringOtherApps: true)
        panel.orderFrontRegardless()
        panel.makeKey()
        Bridge.shared.command("select-region")
        // content.js seçimi başlatamazsa (video yok) fareyi geri ver
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, !self.selecting else { return }
            self.panel.ignoresMouseEvents = true
        }
    }
}
