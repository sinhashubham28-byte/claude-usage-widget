// Claude Usage — always-on-top frosted-glass floating panel (macOS, Swift/AppKit)
//
// Displays Claude 5-hour and 7-day usage for EVERY account the poller has seen,
// in a translucent glass panel that floats ABOVE every other app — including
// fullscreen apps and across all Spaces.
//
//   • Drag anywhere on the panel to move it.
//   • Drag the bottom-right grip to resize (scales the whole panel).
//   • Right-click for the quit menu.
//   • Position + size are remembered across restarts.
//
// Data source: ~/.cache/claude-usage/accounts/<email>.json written by
// claude-usage-poll.sh (see BUILD_NOTES.md).
//
// Build:  swiftc -O claude-usage-float.swift -o claude-usage-float

import Cocoa

// MARK: - Data model

struct UsageWindow { var pct: Double; var resetsAt: Double? }

struct Account {
    var name: String
    var org: String?
    var email: String
    var fiveHour: UsageWindow?
    var sevenDay: UsageWindow?
    var updated: Double?
}

func parseWindow(_ dict: [String: Any]?, _ key: String) -> UsageWindow? {
    guard let rl = dict,
          let w = rl[key] as? [String: Any],
          let pct = (w["used_percentage"] as? NSNumber)?.doubleValue else { return nil }
    return UsageWindow(pct: pct, resetsAt: (w["resets_at"] as? NSNumber)?.doubleValue)
}

func loadAccounts() -> [Account] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let dir = home.appendingPathComponent(".cache/claude-usage/accounts")
    guard let files = try? FileManager.default.contentsOfDirectory(at: dir,
                                                                   includingPropertiesForKeys: nil)
    else { return [] }

    var accounts: [Account] = []
    for url in files where url.pathExtension == "json" {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }

        let acct = obj["account"] as? [String: Any]
        let email = (acct?["email"] as? String) ?? url.deletingPathExtension().lastPathComponent
        let name  = (acct?["name"] as? String) ?? email
        var org   = acct?["org"] as? String
        if let o = org, o.isEmpty { org = nil }

        let rl = obj["rate_limits"] as? [String: Any]
        accounts.append(Account(name: name, org: org, email: email,
                                fiveHour: parseWindow(rl, "five_hour"),
                                sevenDay: parseWindow(rl, "seven_day"),
                                updated: (obj["updated"] as? NSNumber)?.doubleValue))
    }
    accounts.sort { $0.email < $1.email }
    return accounts
}

// MARK: - Persisted panel state (position + scale)

struct PanelState {
    var topLeft: NSPoint
    var scale: CGFloat
    var glassAlpha: CGFloat

    static var url: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache/claude-usage/panel-state.json")
    }

    static func load() -> PanelState? {
        guard let data = try? Data(contentsOf: url),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let x = (o["x"] as? NSNumber)?.doubleValue,
              let y = (o["y"] as? NSNumber)?.doubleValue,
              let s = (o["scale"] as? NSNumber)?.doubleValue else { return nil }
        let a = (o["glassAlpha"] as? NSNumber)?.doubleValue ?? 0.5
        return PanelState(topLeft: NSPoint(x: x, y: y), scale: CGFloat(s), glassAlpha: CGFloat(a))
    }

    func save() {
        let o: [String: Any] = ["x": topLeft.x, "y": topLeft.y,
                                "scale": scale, "glassAlpha": glassAlpha]
        if let data = try? JSONSerialization.data(withJSONObject: o) {
            try? data.write(to: PanelState.url)
        }
    }
}

// MARK: - Layout (unscaled base units, multiplied by `scale`)

enum L {
    static let width: CGFloat = 264
    static let padX: CGFloat = 17
    static let topPad: CGFloat = 15
    static let titleH: CGFloat = 25
    static let acctNameH: CGFloat = 21
    static let rowH: CGFloat = 43
    static let acctGap: CGFloat = 11
    static let botPad: CGFloat = 15
    static let grip: CGFloat = 18
    static let corner: CGFloat = 18

    static func contentHeight(for n: Int) -> CGFloat {
        let count = max(n, 1)
        return topPad + titleH + CGFloat(count) * (acctNameH + rowH * 2 + acctGap) + botPad
    }
}

// MARK: - Glass panel content

final class PanelView: NSView {
    var accounts: [Account] = []
    var scale: CGFloat = 1.0
    var onResize: ((CGFloat) -> Void)?

    private var resizing = false
    private var dragStart = NSPoint.zero
    private var startScale: CGFloat = 1.0

    override var isFlipped: Bool { true }

    // MARK: colors (semantic → adapt to light/dark automatically)

    private func barColor(for pct: Double) -> NSColor {
        if pct >= 80 { return NSColor.systemRed }
        if pct >= 50 { return NSColor.systemOrange }
        return NSColor.systemGreen
    }

    private func resetText(_ resetsAt: Double?) -> String {
        guard let r = resetsAt else { return "" }
        let diff = r - Date().timeIntervalSince1970
        if diff <= 0 { return "resetting…" }
        let h = Int(diff) / 3600, m = (Int(diff) % 3600) / 60
        return h > 0 ? "resets in \(h)h \(m)m" : "resets in \(m)m"
    }

    private func staleText(_ updated: Double?) -> String? {
        guard let u = updated else { return nil }
        let mins = Int((Date().timeIntervalSince1970 - u) / 60)
        if mins <= 3 { return nil }
        if mins < 60 { return "\(mins)m ago" }
        return "\(mins / 60)h ago"
    }

    private func draw(_ text: String, _ x: CGFloat, _ y: CGFloat, size: CGFloat,
                      color: NSColor, weight: NSFont.Weight = .regular,
                      align: NSTextAlignment = .left, width: CGFloat? = nil) {
        let para = NSMutableParagraphStyle()
        para.alignment = align
        para.lineBreakMode = .byTruncatingTail
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: color,
            .paragraphStyle: para,
        ]
        let w = width ?? (bounds.width - x - L.padX * scale)
        (text as NSString).draw(in: NSRect(x: x, y: y, width: w, height: size + 6 * scale),
                                withAttributes: attrs)
    }

    private func drawUsageRow(_ label: String, _ win: UsageWindow?, _ y: CGFloat) -> CGFloat {
        let s = scale
        let padX = L.padX * s
        let barW = bounds.width - padX * 2

        guard let win = win else {
            draw(label, padX, y, size: 12 * s, color: .labelColor, weight: .medium)
            draw("no data", padX, y, size: 12 * s, color: .secondaryLabelColor, align: .right)
            return y + 26 * s
        }

        // A window whose reset time has already passed has rolled over, so the
        // last recorded percentage no longer describes reality. Show it as
        // unknown rather than presenting a stale number as if it were current.
        if let r = win.resetsAt, r <= Date().timeIntervalSince1970 {
            draw(label, padX, y, size: 12 * s, color: .labelColor, weight: .medium)
            draw("—", padX, y, size: 12 * s, color: .secondaryLabelColor,
                 weight: .bold, align: .right)
            draw("window has reset", padX, y + 18 * s, size: 10 * s,
                 color: .secondaryLabelColor)
            return y + L.rowH * s
        }

        let pct = win.pct.rounded()
        draw(label, padX, y, size: 12 * s, color: .labelColor, weight: .medium)
        draw("\(Int(pct))%", padX, y, size: 12 * s, color: .labelColor,
             weight: .bold, align: .right)

        // Track
        let barY = y + 18 * s
        let barH = 7 * s
        let radius = barH / 2
        let track = NSBezierPath(roundedRect: NSRect(x: padX, y: barY, width: barW, height: barH),
                                 xRadius: radius, yRadius: radius)
        NSColor.labelColor.withAlphaComponent(0.20).setFill()
        track.fill()

        // Fill
        let fillW = max(0, min(pct, 100) / 100.0 * barW)
        if fillW > radius * 2 {
            let fill = NSBezierPath(roundedRect: NSRect(x: padX, y: barY, width: fillW, height: barH),
                                    xRadius: radius, yRadius: radius)
            barColor(for: pct).setFill()
            fill.fill()
        } else if fillW > 0 {
            let fill = NSBezierPath(ovalIn: NSRect(x: padX, y: barY, width: fillW, height: barH))
            barColor(for: pct).setFill()
            fill.fill()
        }

        draw(resetText(win.resetsAt), padX, barY + barH + 4 * s,
             size: 10 * s, color: .secondaryLabelColor)
        return y + L.rowH * s
    }

    private func drawAccount(_ a: Account, _ y: CGFloat) -> CGFloat {
        let s = scale, padX = L.padX * s
        var yy = y

        let title = a.org.map { "\(a.name) · \($0)" } ?? a.name
        // Reserve room on the right for the freshness badge.
        let badge = staleText(a.updated)
        let badgeW: CGFloat = badge == nil ? 0 : 62 * s
        draw(title, padX, yy, size: 12.5 * s, color: .labelColor, weight: .bold,
             width: bounds.width - padX * 2 - badgeW)
        if let badge = badge {
            draw(badge, padX, yy + 1 * s, size: 10 * s, color: .secondaryLabelColor, align: .right)
        }
        yy += L.acctNameH * s

        yy = drawUsageRow("5-hour", a.fiveHour, yy)
        yy = drawUsageRow("7-day", a.sevenDay, yy)
        return yy + L.acctGap * s
    }

    private func drawGrip() {
        let s = scale
        let g = L.grip * s
        let x = bounds.width - g, y = bounds.height - g
        NSColor.tertiaryLabelColor.setStroke()
        // Three short diagonal strokes, classic grip.
        for i in 0..<3 {
            let off = CGFloat(i) * 4 * s
            let p = NSBezierPath()
            p.lineWidth = 1.2 * s
            p.lineCapStyle = .round
            p.move(to: NSPoint(x: x + g - 3 * s - off, y: y + g - 3 * s))
            p.line(to: NSPoint(x: x + g - 3 * s, y: y + g - 3 * s - off))
            p.stroke()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let s = scale

        // Glass edge: a hairline highlight so the panel reads as a distinct
        // surface against busy backgrounds.
        let inset = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                                 xRadius: L.corner * s, yRadius: L.corner * s)
        NSColor.labelColor.withAlphaComponent(0.10).setStroke()
        inset.lineWidth = 1
        inset.stroke()

        var y = L.topPad * s
        draw("Claude Usage", L.padX * s, y, size: 13 * s,
             color: .labelColor, weight: .bold)
        y += L.titleH * s

        if accounts.isEmpty {
            draw("Waiting for usage data…", L.padX * s, y, size: 11.5 * s, color: .labelColor)
            draw("The poller refreshes every 2 minutes.", L.padX * s, y + 17 * s,
                 size: 10.5 * s, color: .secondaryLabelColor)
            drawGrip()
            return
        }

        for a in accounts { y = drawAccount(a, y) }
        drawGrip()
    }

    // MARK: - Mouse: drag to move, grip to resize

    private func inGrip(_ p: NSPoint) -> Bool {
        let g = L.grip * scale
        return p.x >= bounds.width - g && p.y >= bounds.height - g
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if inGrip(p) {
            resizing = true
            dragStart = NSEvent.mouseLocation
            startScale = scale
        } else {
            // Built-in window drag: handles the whole loop until mouse-up.
            window?.performDrag(with: event)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard resizing else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - dragStart.x
        let newScale = max(0.75, min(2.2, startScale + dx / L.width))
        if abs(newScale - scale) > 0.001 { onResize?(newScale) }
    }

    override func mouseUp(with event: NSEvent) {
        resizing = false
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var glass: NSVisualEffectView!
    var view: PanelView!
    var timer: Timer?
    var scale: CGFloat = 1.0
    var glassAlpha: CGFloat = 0.5   // lower = more see-through
    var lastCount = -1

    func applicationDidFinishLaunching(_ note: Notification) {
        let saved = PanelState.load()
        scale = saved?.scale ?? 1.0
        glassAlpha = saved?.glassAlpha ?? 0.5

        let w = L.width * scale
        let h = L.contentHeight(for: 1) * scale
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let topLeft = saved?.topLeft ?? NSPoint(x: screen.maxX - w - 20, y: screen.maxY - 20)

        window = NSWindow(contentRect: NSRect(x: topLeft.x, y: topLeft.y - h, width: w, height: h),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary,
                                     .stationary, .ignoresCycle]

        // Transparent container so the glass layer's opacity can be tuned
        // independently of the text drawn on top of it (text stays crisp).
        let container = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        container.autoresizingMask = [.width, .height]
        window.contentView = container

        // Frosted glass: blurs whatever is *behind* the window.
        glass = NSVisualEffectView(frame: container.bounds)
        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = L.corner * scale
        glass.layer?.masksToBounds = true
        glass.autoresizingMask = [.width, .height]
        glass.alphaValue = glassAlpha
        container.addSubview(glass)

        view = PanelView(frame: container.bounds)
        view.autoresizingMask = [.width, .height]
        view.scale = scale
        view.onResize = { [weak self] s in self?.apply(scale: s) }
        container.addSubview(view)

        view.menu = buildMenu()

        NotificationCenter.default.addObserver(self, selector: #selector(windowMoved),
                                               name: NSWindow.didMoveNotification, object: window)

        window.orderFrontRegardless()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    @objc func windowMoved() { saveState() }

    func saveState() {
        let f = window.frame
        PanelState(topLeft: NSPoint(x: f.origin.x, y: f.origin.y + f.size.height),
                   scale: scale, glassAlpha: glassAlpha).save()
    }

    // MARK: - Right-click menu

    /// Transparency presets, from nearly solid to barely-there.
    static let alphaPresets: [(String, CGFloat)] = [
        ("Solid",       0.95),
        ("Frosted",     0.75),
        ("Sheer",       0.50),
        ("Ultra sheer", 0.28),
        ("Invisible",   0.10),
    ]

    func buildMenu() -> NSMenu {
        let menu = NSMenu()

        let sub = NSMenu()
        for (title, a) in AppDelegate.alphaPresets {
            let item = NSMenuItem(title: title, action: #selector(setTransparency(_:)),
                                  keyEquivalent: "")
            item.target = self
            item.representedObject = a
            item.state = abs(a - glassAlpha) < 0.01 ? .on : .off
            sub.addItem(item)
        }
        let subItem = NSMenuItem(title: "Transparency", action: nil, keyEquivalent: "")
        subItem.submenu = sub
        menu.addItem(subItem)

        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Claude Usage",
                     action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        return menu
    }

    @objc func setTransparency(_ sender: NSMenuItem) {
        guard let a = sender.representedObject as? CGFloat else { return }
        glassAlpha = a
        glass.alphaValue = a
        saveState()
        view.menu = buildMenu()   // refresh the checkmark
    }

    /// Resize the panel, keeping its top-left corner anchored.
    func apply(scale newScale: CGFloat) {
        scale = newScale
        view.scale = newScale
        glass.layer?.cornerRadius = L.corner * newScale
        resizeWindow()
        saveState()
    }

    func resizeWindow() {
        let n = max(view.accounts.count, 1)
        let w = L.width * scale
        let h = L.contentHeight(for: n) * scale
        var f = window.frame
        let topY = f.origin.y + f.size.height
        f.size = NSSize(width: w, height: h)
        f.origin.y = topY - h
        window.setFrame(f, display: true)
        view.needsDisplay = true
    }

    func refresh() {
        let accounts = loadAccounts()
        view.accounts = accounts
        if accounts.count != lastCount {
            lastCount = accounts.count
            resizeWindow()
        }
        view.needsDisplay = true
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
