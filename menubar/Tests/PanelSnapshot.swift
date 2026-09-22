import SwiftUI
import AppKit

// Development-only render of the panel, without driving the user's desktop.
@main
struct PanelSnapshot {
    @MainActor static func main() throws {
        let dark = CommandLine.arguments.contains("--dark")
        NSApplication.shared.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let signIn = CommandLine.arguments.contains("--signin")
        let panel = (signIn ? AnyView(MeterSignInView(store: ProfileStore())) : AnyView(PanelView(store: ProfileStore())))
            .environment(\.colorScheme, dark ? .dark : .light)
            .background(Color(nsColor: .windowBackgroundColor))
        let host = NSHostingView(rootView: panel)
        host.frame = NSRect(x: 0, y: 0, width: signIn ? 420 : 440, height: signIn ? 440 : 650)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSApplication.shared.appearance
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("Missing bitmap") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Missing PNG") }
        let destination = CommandLine.arguments.dropFirst().first ?? "/tmp/router-panel.png"
        try png.write(to: URL(fileURLWithPath: destination))
        print("Rendered panel")
    }
}
