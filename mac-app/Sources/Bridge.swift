import Cocoa
import WebKit

/// Uygulama klasöründe kalıcı ayar/önbellek deposu (eklentinin chrome.storage'ı).
/// Değerler JSON metni olarak saklanır; JS tarafı çözer.
final class Store {
    static let shared = Store()
    private var areas: [String: [String: String]] = ["sync": [:], "local": [:]]
    private var dirty = Set<String>()
    private let ioQueue = DispatchQueue(label: "store.io")
    private var saveTimer: Timer?

    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent(Bundle.main.bundleIdentifier == "com.setnode.setdenizplay" ? "SetdenizPlay" : "AltyaziCevirici", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private func file(_ area: String) -> URL { Store.dir.appendingPathComponent(area + ".json") }

    init() {
        for a in ["sync", "local"] {
            if let data = try? Data(contentsOf: file(a)),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
                areas[a] = obj
            }
        }
    }

    func get(_ area: String, _ keys: [String]?) -> [String: String] {
        let all = areas[area] ?? [:]
        guard let keys else { return all }
        var out: [String: String] = [:]
        for k in keys { if let v = all[k] { out[k] = v } }
        return out
    }

    func set(_ area: String, _ items: [String: String]) {
        for (k, v) in items { areas[area, default: [:]][k] = v }
        markDirty(area)
    }

    func remove(_ area: String, _ keys: [String]) {
        for k in keys { areas[area]?.removeValue(forKey: k) }
        markDirty(area)
    }

    /// Kısa yol: yerel taraf da ayar okuyabilsin (ör. "enabled")
    func bool(_ key: String) -> Bool { areas["sync"]?[key] == "true" }

    private func markDirty(_ area: String) {
        dirty.insert(area)
        saveTimer?.invalidate()
        saveTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: false) { [weak self] _ in self?.flush() }
    }

    func flush() {
        let snapshot = dirty.map { ($0, areas[$0] ?? [:]) }
        dirty.removeAll()
        for (area, dict) in snapshot {
            let url = file(area)
            ioQueue.async {
                if let data = try? JSONSerialization.data(withJSONObject: dict) {
                    try? data.write(to: url, options: .atomic)
                }
            }
        }
    }

    func flushSync() {
        flush()
        ioQueue.sync {}
    }
}

/// xct://app/… adreslerini uygulamanın içindeki dosyalarla ve canlı oyun karesiyle yanıtlar.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    let resources: URL
    init(resources: URL) { self.resources = resources }

    static let mime: [String: String] = [
        "html": "text/html", "js": "text/javascript", "css": "text/css", "json": "application/json",
        "wasm": "application/wasm", "png": "image/png", "webp": "image/webp", "jpg": "image/jpeg",
        "txt": "text/plain", "gz": "application/octet-stream", "md": "text/plain",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path
        if path == "/frame" {
            let after = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "after" })?.value.flatMap { Int($0) } ?? 0
            Capture.shared.jpeg(after: after) { data, seq in
                if let data {
                    let r = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                        "Content-Type": "image/jpeg", "X-Seq": String(seq), "Cache-Control": "no-store",
                        "Access-Control-Expose-Headers": "X-Seq",
                    ])!
                    task.didReceive(r); task.didReceive(data); task.didFinish()
                } else {
                    let r = HTTPURLResponse(url: url, statusCode: 204, httpVersion: "HTTP/1.1", headerFields: ["Cache-Control": "no-store"])!
                    task.didReceive(r); task.didFinish()
                }
            }
            return
        }
        // /ext/… → eklentinin dosyaları, /mac/… → Mac'e özel sayfalar
        let rel = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let fileURL = resources.appendingPathComponent(rel).standardizedFileURL
        guard fileURL.path.hasPrefix(resources.standardizedFileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            let r = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!
            task.didReceive(r); task.didFinish()
            return
        }
        let type = SchemeHandler.mime[fileURL.pathExtension.lowercased()] ?? "application/octet-stream"
        let r = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type, "Content-Length": String(data.count), "Access-Control-Allow-Origin": "*",
        ])!
        task.didReceive(r); task.didReceive(data); task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// JS ↔ uygulama köprüsü: depolama, ağ, sayfalar arası mesajlar.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = Bridge()
    weak var host: WKWebView?        // yakalanan pencerenin katmanı (content.js burada çalışır)
    weak var settings: WKWebView?    // ayar penceresi (popup.html)
    weak var bg: WKWebView?          // OCR + çeviri arka planı (bg.html)
    weak var xbox: WKWebView?        // gömülü xbox.com/play (content.js yalıtılmış dünyada)
    static let world = WKContentWorld.world(name: "xct")
    /// Ayarlardaki "Bölge seç / Önizle" ve kısayollar hangi sayfaya gitsin: true → Xbox penceresi
    var preferXbox: (() -> Bool)?
    var onSelecting: ((Bool) -> Void)?
    var onCloseSettings: (() -> Void)?
    var onHello: (() -> Void)?
    var onEnabledChanged: ((Bool) -> Void)?

    let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 12
        c.httpMaximumConnectionsPerHost = 6
        c.httpAdditionalHeaders = ["User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"]
        return URLSession(configuration: c)
    }()

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(nil, "geçersiz istek"); return
        }
        let sender = message.webView
        switch op {
        case "get":
            let area = body["area"] as? String ?? "sync"
            replyHandler(Store.shared.get(area, body["keys"] as? [String]), nil)
        case "set":
            let area = body["area"] as? String ?? "sync"
            let items = body["items"] as? [String: String] ?? [:]
            Store.shared.set(area, items)
            broadcast(area: area, raw: items.mapValues { $0 as Any }, except: sender)
            if area == "sync", let e = items["enabled"] { onEnabledChanged?(e == "true") }
            replyHandler(true, nil)
        case "remove":
            let area = body["area"] as? String ?? "sync"
            let keys = body["keys"] as? [String] ?? []
            Store.shared.remove(area, keys)
            broadcast(area: area, raw: Dictionary(uniqueKeysWithValues: keys.map { ($0, NSNull() as Any) }), except: sender)
            replyHandler(true, nil)
        case "net":
            net(body, replyHandler)
        case "toContent":
            sendToContent(body["msg"] as? [String: Any] ?? [:])
            replyHandler(true, nil)
        case "toBg":
            guard let bg else { replyHandler(["ok": false, "error": "Arka plan hazır değil"], nil); return }
            bg.callAsyncJavaScript("return await window.__xctBg(msg)", arguments: ["msg": body["msg"] ?? [:]],
                                     in: nil, in: .page) { result in
                switch result {
                case .success(let v): replyHandler(v, nil)
                case .failure(let e): replyHandler(["ok": false, "error": e.localizedDescription], nil)
                }
            }
        case "selecting":
            onSelecting?((body["on"] as? Bool) ?? false)
            replyHandler(true, nil)
        case "closeSettings":
            onCloseSettings?()
            replyHandler(true, nil)
        case "log":
            Debug.log("[\(message.webView === host ? "katman" : message.webView === xbox ? "xbox" : message.webView === bg ? "arka" : "ayar")] \(body["lvl"] ?? ""): \(body["text"] ?? "")")
            replyHandler(true, nil)
        case "hello":
            onHello?()
            replyHandler(true, nil)
        default:
            replyHandler(nil, "bilinmeyen işlem: \(op)")
        }
    }

    /// Diğer sayfalara depolama değişikliğini bildir (çeviri önbelleği gibi büyük kayıtlar hariç)
    private func broadcast(area: String, raw: [String: Any], except: WKWebView?) {
        let small = raw.filter { ($0.value as? String)?.utf8.count ?? 0 < 200_000 }
        guard !small.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: small),
              let json = String(data: data, encoding: .utf8) else { return }
        for wv in [host, settings, bg, xbox].compactMap({ $0 }) where wv !== except {
            wv.evaluateJavaScript("window.__xctChanged && window.__xctChanged(\(jsString(area)), \(json))",
                                  in: nil, in: wv === xbox ? Bridge.world : .page, completionHandler: nil)
        }
    }

    func sendToContent(_ msg: [String: Any]) {
        var m = msg
        m["target"] = "content"
        let toXbox = xbox != nil && (preferXbox?() ?? false)
        guard let wv = toXbox ? xbox : host else { return }
        wv.callAsyncJavaScript("window.__xctToContent && window.__xctToContent(msg)", arguments: ["msg": m],
                               in: nil, in: toXbox ? Bridge.world : .page, completionHandler: nil)
    }

    func command(_ name: String) { sendToContent(["type": "command", "name": name]) }

    private func net(_ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let s = body["url"] as? String, let url = URL(string: s),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            reply(["error": "geçersiz adres"], nil); return
        }
        var req = URLRequest(url: url)
        req.httpMethod = body["method"] as? String ?? "GET"
        for (k, v) in body["headers"] as? [String: String] ?? [:] { req.setValue(v, forHTTPHeaderField: k) }
        if let b = body["body"] as? String { req.httpBody = b.data(using: .utf8) }
        session.dataTask(with: req) { data, resp, err in
            DispatchQueue.main.async {
                if let err { reply(["error": err.localizedDescription], nil); return }
                let http = resp as? HTTPURLResponse
                var headers: [String: String] = [:]
                if let ct = http?.value(forHTTPHeaderField: "Content-Type") { headers["Content-Type"] = ct }
                let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                reply(["status": http?.statusCode ?? 0, "body": text, "headers": headers], nil)
            }
        }.resume()
    }
}

func jsString(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s])
    let arr = String(data: data, encoding: .utf8)!
    return String(arr.dropFirst().dropLast())
}

/// İki sayfanın ortak WebKit ayarı: aynı köprü, aynı dosya sunucusu, aynı chrome taklidi.
func makeWebConfig(resources: URL, version: String, role: String, world: WKContentWorld = .page) -> WKWebViewConfiguration {
    let cfg = WKWebViewConfiguration()
    cfg.setURLSchemeHandler(SchemeHandler(resources: resources), forURLScheme: "xct")
    cfg.mediaTypesRequiringUserActionForPlayback = []
    let ucc = WKUserContentController()
    ucc.addScriptMessageHandler(Bridge.shared, contentWorld: world, name: "xct")
    let shim = (try? String(contentsOf: resources.appendingPathComponent("mac/shim.js"), encoding: .utf8)) ?? ""
    ucc.addUserScript(WKUserScript(source: "window.__xctVersion = \(jsString(version)); window.__xctRole = \(jsString(role));\n" + shim,
                                   injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
    cfg.userContentController = ucc
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
    return cfg
}

/// Hata ayıklama: Application Support/AltyaziCevirici/debug dosyası varsa günlük ve anlık görüntü yazar
enum Debug {
    static let on = FileManager.default.fileExists(atPath: Store.dir.appendingPathComponent("debug").path)
    static let logURL = Store.dir.appendingPathComponent("log.txt")
    static func log(_ s: String) {
        guard on else { return }
        let line = "\(Date().formatted(.iso8601.time(includingFractionalSeconds: true))) \(s)\n"
        if let h = try? FileHandle(forWritingTo: logURL) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
        else { try? line.write(to: logURL, atomically: true, encoding: .utf8) }
    }
}
