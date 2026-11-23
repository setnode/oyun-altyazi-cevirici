import Cocoa
import ScreenCaptureKit
import CoreImage
import ImageIO

/// Seçilebilir kaynak: bir uygulama penceresi ya da bir ekranın tamamı.
struct Source: Equatable {
    enum Kind: Equatable { case window(CGWindowID), display(CGDirectDisplayID) }
    let kind: Kind
    let title: String
    let appName: String
    let bundleID: String
    let pid: pid_t
}

/// Oyun penceresini ScreenCaptureKit ile yakalar, son kareyi tutar ve oyun görüntüsünün
/// pencere içindeki yerini (başlık çubuğu ve siyah şeritler hariç) bulur.
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = Capture()

    private(set) var source: Source?
    private var stream: SCStream?
    private let capQueue = DispatchQueue(label: "capture.frames", qos: .userInteractive)
    private let encQueue = DispatchQueue(label: "capture.jpeg", qos: .userInteractive)
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

    // capQueue'da güncellenir
    private var latest: CVPixelBuffer?
    private var latestSeq = 0
    private var detector = ContentDetector()
    private var waiters: [(after: Int, cb: (Data?, Int) -> Void)] = []   // ana iş parçacığında
    private var lastJPEG: (seq: Int, data: Data)?

    /// Oyun görüntüsünün yakalanan karedeki yeri (piksel) ve karenin boyu
    private(set) var contentPx = CGRect.zero
    private(set) var framePx = CGSize.zero
    /// Yakalanan pencerenin ekrandaki çerçevesi (CG koordinatı, sol üst köşe başlangıç, nokta)
    private(set) var windowFrame = CGRect.zero
    var paused = false
    var onStop: ((String) -> Void)?
    var onGeometry: (() -> Void)?

    static let knownApps: [String: Int] = [
        "com.playstation.RemotePlay": 0, "com.nvidia.gfnpc.mall": 1, "com.nvidia.geforcenow": 1,
        "com.microsoft.xbox": 2, "com.google.Chrome": 3, "com.apple.Safari": 4, "com.microsoft.edgemac": 5,
        "company.thebrowser.Browser": 6, "org.mozilla.firefox": 7, "com.valvesoftware.steamlink": 8,
        "com.moonlight-stream.Moonlight": 8, "com.parsec.www": 8,
    ]

    // MARK: Kaynak listesi
    func listSources(_ done: @escaping ([Source]) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, _ in
            var out: [Source] = []
            let me = ProcessInfo.processInfo.processIdentifier
            if let content {
                // Yalnızca ekranda görünen, Dock'ta yeri olan uygulamaların pencereleri (yardımcı süreçler hariç)
                let wins = content.windows.filter { w in
                    guard let app = w.owningApplication, app.processID != me, w.isOnScreen else { return false }
                    guard NSRunningApplication(processIdentifier: app.processID)?.activationPolicy == .regular else { return false }
                    return w.windowLayer == 0 && w.frame.width >= 320 && w.frame.height >= 200
                }
                for w in wins {
                    let app = w.owningApplication!
                    out.append(Source(kind: .window(w.windowID), title: w.title ?? "", appName: app.applicationName,
                                      bundleID: app.bundleIdentifier, pid: app.processID))
                }
                out.sort { a, b in
                    let ra = Capture.knownApps[a.bundleID] ?? 50, rb = Capture.knownApps[b.bundleID] ?? 50
                    if ra != rb { return ra < rb }
                    return a.appName.localizedCaseInsensitiveCompare(b.appName) == .orderedAscending
                }
                for (i, d) in content.displays.enumerated() {
                    out.append(Source(kind: .display(d.displayID), title: content.displays.count > 1 ? "Ekran \(i + 1)" : "Ekranın tamamı",
                                      appName: "", bundleID: "", pid: 0))
                }
            }
            DispatchQueue.main.async { done(out) }
        }
    }

    // MARK: Başlat / durdur
    func start(_ src: Source, completion: @escaping (String?) -> Void) {
        stop()
        source = src
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, err in
            DispatchQueue.main.async {
                guard let content else { completion(err?.localizedDescription ?? "Ekran kaydı izni yok"); return }
                let filter: SCContentFilter
                var size: CGSize
                var scale: CGFloat = NSScreen.main?.backingScaleFactor ?? 2
                switch src.kind {
                case .window(let id):
                    guard let w = content.windows.first(where: { $0.windowID == id }) else {
                        completion("Pencere bulunamadı — kapanmış olabilir"); return
                    }
                    filter = SCContentFilter(desktopIndependentWindow: w)
                    self.windowFrame = w.frame
                    scale = Capture.scale(for: w.frame)
                    size = w.frame.size
                case .display(let id):
                    guard let d = content.displays.first(where: { $0.displayID == id }) else {
                        completion("Ekran bulunamadı"); return
                    }
                    let me = ProcessInfo.processInfo.processIdentifier
                    let mine = content.applications.filter { $0.processID == me }
                    filter = SCContentFilter(display: d, excludingApplications: mine, exceptingWindows: [])
                    self.windowFrame = CGDisplayBounds(id)
                    if #available(macOS 14.0, *) { scale = CGFloat(filter.pointPixelScale) }
                    size = d.frame.size
                }
                let cfg = self.config(size: size, scale: scale)
                let s = SCStream(filter: filter, configuration: cfg, delegate: self)
                do {
                    try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.capQueue)
                } catch { completion(error.localizedDescription); return }
                self.stream = s
                self.capQueue.async { self.detector = ContentDetector(); self.latest = nil }
                s.startCapture { err in
                    DispatchQueue.main.async {
                        if let err { self.stream = nil; completion(err.localizedDescription) } else { completion(nil) }
                    }
                }
            }
        }
    }

    /// Pencerenin bulunduğu ekranın Retina katsayısı (CG koordinatı)
    static func scale(for cgFrame: CGRect) -> CGFloat {
        let primaryH = NSScreen.screens.first?.frame.height ?? 0
        let p = NSPoint(x: cgFrame.midX, y: primaryH - cgFrame.midY)
        return (NSScreen.screens.first { $0.frame.contains(p) } ?? NSScreen.main)?.backingScaleFactor ?? 2
    }

    private var cfgSize = CGSize.zero
    private func config(size: CGSize, scale: CGFloat) -> SCStreamConfiguration {
        let c = SCStreamConfiguration()
        // Çok büyük pencereyi 2560 piksel genişliğe sınırla (OCR için fazlası gereksiz)
        var w = size.width * scale, h = size.height * scale
        if w > 2560 { h = h * 2560 / w; w = 2560 }
        c.width = max(2, Int(w.rounded()) & ~1)
        c.height = max(2, Int(h.rounded()) & ~1)
        c.pixelFormat = kCVPixelFormatType_32BGRA
        c.colorSpaceName = CGColorSpace.sRGB
        c.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        c.queueDepth = 4
        c.showsCursor = false
        c.capturesAudio = false
        if #available(macOS 14.0, *) { c.ignoreShadowsSingleWindow = true }
        cfgSize = size
        return c
    }

    /// Test modu (yalnızca geliştirme): ekran yerine bir resim dosyasını kare olarak verir
    private var testTimer: Timer?
    func startTest(images: [URL], at frame: CGRect) {
        var bufs: [CVPixelBuffer] = []
        for image in images {
            guard let src = CGImageSourceCreateWithURL(image as CFURL, nil),
                  let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { continue }
            var pb: CVPixelBuffer?
            CVPixelBufferCreate(nil, cg.width, cg.height, kCVPixelFormatType_32BGRA,
                                [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &pb)
            guard let pb else { continue }
            CVPixelBufferLockBaseAddress(pb, [])
            let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: cg.width, height: cg.height, bitsPerComponent: 8,
                                bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: srgb,
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            CVPixelBufferUnlockBaseAddress(pb, [])
            bufs.append(pb)
        }
        guard !bufs.isEmpty else { Debug.log("test resmi yok"); return }
        let t0 = Date()
        source = Source(kind: .display(0), title: "Test", appName: "Test", bundleID: "", pid: 0)
        windowFrame = frame
        testTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.capQueue.async {
                let pb = bufs[Int(Date().timeIntervalSince(t0) / 4) % bufs.count]
                self.latest = pb; self.latestSeq += 1
                let size = CGSize(width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb))
                DispatchQueue.main.async {
                    if self.framePx != size { self.framePx = size; self.contentPx = CGRect(origin: .zero, size: size); self.onGeometry?() }
                    self.serveWaiters()
                }
            }
        }
    }

    func stop() {
        testTimer?.invalidate(); testTimer = nil
        if let s = stream { s.stopCapture { _ in } }
        stream = nil
        source = nil
        contentPx = .zero
        framePx = .zero
        capQueue.async { self.latest = nil }
    }

    var running: Bool { stream != nil }

    /// Pencere taşındı/boyutlandı: çerçeveyi güncelle, boy değiştiyse yakalamayı yeni boya ayarla
    func updateWindowFrame(_ f: CGRect) {
        windowFrame = f
        guard let s = stream, abs(f.width - cfgSize.width) > 1 || abs(f.height - cfgSize.height) > 1 else { return }
        let scale = Capture.scale(for: f)
        s.updateConfiguration(config(size: f.size, scale: scale)) { _ in }
        capQueue.async { self.detector = ContentDetector() }
    }

    // MARK: Kareler
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let att = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              let raw = att[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pb = sb.imageBuffer else { return }
        latest = pb
        latestSeq += 1
        let seq = latestSeq
        let size = CGSize(width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb))
        var geoChanged = false
        if seq % 3 == 0 || detector.rect == .zero {
            geoChanged = detector.feed(pb)
        }
        let rect = detector.rect == .zero ? CGRect(origin: .zero, size: size) : detector.rect
        DispatchQueue.main.async {
            let changed = geoChanged || self.framePx != size || self.contentPx != rect
            self.framePx = size
            self.contentPx = rect
            if changed { self.onGeometry?() }
            self.serveWaiters()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async {
            if self.stream === stream {
                self.stream = nil
                self.onStop?(error.localizedDescription)
            }
        }
    }

    /// Eklentinin istediği kare: `after`dan yeni kare varsa hemen, yoksa en çok 120 ms bekleyip boş döner
    func jpeg(after: Int, _ cb: @escaping (Data?, Int) -> Void) {
        waiters.append((after, cb))
        serveWaiters()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            guard let self else { return }
            let expired = self.waiters.filter { $0.after == after }
            self.waiters.removeAll { $0.after == after }
            for w in expired { w.cb(nil, after) }
        }
    }

    private var encoding = false
    private func serveWaiters() {
        guard !waiters.isEmpty, !paused, !encoding else { return }
        capQueue.async {
            guard let pb = self.latest else { return }
            let seq = self.latestSeq
            DispatchQueue.main.async {
                guard self.waiters.contains(where: { $0.after < seq }) else { return }
                if let j = self.lastJPEG, j.seq == seq { self.deliver(j.data, seq); return }
                self.encoding = true
                let rect = self.contentPx
                self.encQueue.async {
                    let data = self.encode(pb, crop: rect)
                    DispatchQueue.main.async {
                        self.encoding = false
                        if let data { self.lastJPEG = (seq, data) }
                        self.deliver(data, seq)
                    }
                }
            }
        }
    }

    private func deliver(_ data: Data?, _ seq: Int) {
        let ready = waiters.filter { $0.after < seq }
        waiters.removeAll { $0.after < seq }
        for w in ready { w.cb(data, seq) }
    }

    private func encode(_ pb: CVPixelBuffer, crop: CGRect) -> Data? {
        let W = CGFloat(CVPixelBufferGetWidth(pb)), H = CGFloat(CVPixelBufferGetHeight(pb))
        var r = crop == .zero ? CGRect(x: 0, y: 0, width: W, height: H) : crop.intersection(CGRect(x: 0, y: 0, width: W, height: H))
        if r.width < 16 || r.height < 16 { r = CGRect(x: 0, y: 0, width: W, height: H) }
        // CoreImage'da y aşağıdan yukarı
        var img = CIImage(cvPixelBuffer: pb).cropped(to: CGRect(x: r.minX, y: H - r.maxY, width: r.width, height: r.height))
        img = img.transformed(by: CGAffineTransform(translationX: -r.minX, y: -(H - r.maxY)))
        // Eklenti 720p–1080p görüntü için ayarlı: 1920'den büyük kareyi küçült
        if r.width > 1920 {
            let k = 1920 / r.width
            img = img.transformed(by: CGAffineTransform(scaleX: k, y: k))
        }
        return ciContext.jpegRepresentation(of: img, colorSpace: srgb,
                                            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.9])
    }
}

/// Yakalanan pencerede oyun görüntüsünün yerini bulur: birkaç saniye boyunca değişen (hareketli)
/// bölgenin sınırı alınır ve 16:9'a oturtulur. Başlık çubuğu, tarayıcı çubukları ve siyah
/// şeritler durağan olduğu için dışarıda kalır. Oyun durağansa (menü, duraklatma) eski yer korunur.
struct ContentDetector {
    private var prev: [UInt8] = []
    private var heat: [Float] = []
    private var gw = 0, gh = 0, step = 8
    private var srcW = 0, srcH = 0
    private var candidate = CGRect.zero
    private var candidateHits = 0
    private var feeds = 0
    private(set) var rect = CGRect.zero

    /// Yer değiştiyse true
    mutating func feed(_ pb: CVPixelBuffer) -> Bool {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb)?.assumingMemoryBound(to: UInt8.self) else { return false }
        let W = CVPixelBufferGetWidth(pb), H = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
        if W != srcW || H != srcH {
            srcW = W; srcH = H
            step = max(4, W / 240)
            gw = W / step; gh = H / step
            prev = [UInt8](repeating: 0, count: gw * gh)
            heat = [Float](repeating: 0, count: gw * gh)
            rect = CGRect(x: 0, y: 0, width: W, height: H)
            candidate = .zero; candidateHits = 0; feeds = 0
        }
        var cur = [UInt8](repeating: 0, count: gw * gh)
        for gy in 0..<gh {
            let row = base + (gy * step + step / 2) * bpr
            for gx in 0..<gw {
                let p = row + (gx * step + step / 2) * 4
                cur[gy * gw + gx] = UInt8((Int(p[0]) * 29 + Int(p[1]) * 150 + Int(p[2]) * 77) >> 8)
            }
        }
        feeds += 1
        if feeds == 1 { prev = cur; return false }
        // Isı: son ~4 saniyede değişen hücreler (yavaşça söner)
        var moving = 0
        for i in 0..<cur.count {
            let d = abs(Int(cur[i]) - Int(prev[i]))
            heat[i] = heat[i] * 0.97 + (d > 10 ? 1 : 0)
            if d > 10 { moving += 1 }
        }
        prev = cur
        // Yeterince hareket yoksa (durağan sahne) yeri değiştirme
        guard feeds > 6, moving > cur.count / 200 else { return false }

        // Satır/sütun başına sıcak hücre sayısı → hareketli bölgenin sınırı
        var rows = [Int](repeating: 0, count: gh), cols = [Int](repeating: 0, count: gw)
        for gy in 0..<gh { for gx in 0..<gw where heat[gy * gw + gx] > 0.6 { rows[gy] += 1; cols[gx] += 1 } }
        let rowMin = max(2, gw / 40), colMin = max(2, gh / 40)
        guard let top = rows.firstIndex(where: { $0 >= rowMin }), let bottom = rows.lastIndex(where: { $0 >= rowMin }),
              let left = cols.firstIndex(where: { $0 >= colMin }), let right = cols.lastIndex(where: { $0 >= colMin }) else { return false }
        var x0 = CGFloat(left * step), x1 = CGFloat((right + 1) * step)
        var y0 = CGFloat(top * step), y1 = CGFloat((bottom + 1) * step)
        let bw = x1 - x0, bh = y1 - y0
        guard bw > CGFloat(W) * 0.3, bh > CGFloat(H) * 0.25 else { return false }
        // 16:9'a oturt (oyun akışları hep 16:9): kısa kalan kenarı ortalayarak uzat
        let ratio: CGFloat = 16.0 / 9.0
        if bw / bh > ratio {
            let nh = bw / ratio, cy = (y0 + y1) / 2
            y0 = cy - nh / 2; y1 = cy + nh / 2
        } else {
            let nw = bh * ratio, cx = (x0 + x1) / 2
            x0 = cx - nw / 2; x1 = cx + nw / 2
        }
        // Pencereden taşarsa içeri kaydır, yine sığmazsa kırp
        if y0 < 0 { y1 -= y0; y0 = 0 }
        if y1 > CGFloat(H) { y0 -= y1 - CGFloat(H); y1 = CGFloat(H); y0 = max(0, y0) }
        if x0 < 0 { x1 -= x0; x0 = 0 }
        if x1 > CGFloat(W) { x0 -= x1 - CGFloat(W); x1 = CGFloat(W); x0 = max(0, x0) }
        let r = CGRect(x: x0.rounded(), y: y0.rounded(), width: (x1 - x0).rounded(), height: (y1 - y0).rounded())

        // Kararlı olsun: yeni yer 3 kez üst üste aynı çıkarsa kabul et
        func near(_ a: CGRect, _ b: CGRect) -> Bool {
            let t = CGFloat(W) * 0.015
            return abs(a.minX - b.minX) < t && abs(a.minY - b.minY) < t && abs(a.maxX - b.maxX) < t && abs(a.maxY - b.maxY) < t
        }
        if near(r, rect) { candidateHits = 0; return false }
        if near(r, candidate) { candidateHits += 1 } else { candidate = r; candidateHits = 1 }
        if candidateHits >= 3 { rect = candidate; candidateHits = 0; return true }
        return false
    }
}
