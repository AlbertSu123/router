import SwiftUI

@main
struct RouterApp: App {
    @NSApplicationDelegateAdaptor(RouterAppDelegate.self) private var delegate
    @State private var store = ProfileStore()
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        MenuBarExtra {
            PanelView(store: store)
        } label: {
            MenuBarLabel(store: store)
                .onReceive(NotificationCenter.default.publisher(for: .init("RouterSignInRequested"))) { notification in
                    store.meterPreferredProvider = notification.userInfo?["provider"] as? String
                    openWindow(id: "router-signin")
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
                .task {
                    // The CLI overwrites ~/.router/current in place, so a
                    // file watch on the directory misses it. A slow poll is
                    // enough for a menu bar label. Every fifth tick also
                    // heals refresh races (a running "main" session can
                    // rewrite the keychain over an active profile).
                    var tick = 0
                    while !Task.isCancelled {
                        store.refresh()
                        if tick % 5 == 0 { await store.heal() }
                        if tick % 30 == 0 { await store.fetchUsage() }
                        tick += 1
                        try? await Task.sleep(for: .seconds(2))
                    }
                }
        }
        .menuBarExtraStyle(.window)

        Window("Sign in to Router", id: "router-signin") {
            MeterSignInView(store: store)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
        .windowLevel(.floating)

        Window("Add Claude Account", id: "add") {
            AddAccountView(store: store)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
        // The app has no Dock icon, so a buried window is unfindable. Keep
        // it above the browser during the sign-in.
        .windowLevel(.floating)

        Window("Add Codex Account", id: "add-codex") {
            AddCodexAccountView(store: store)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
        .windowLevel(.floating)
    }
}

// Reopening Router (Finder, Spotlight, or accessibility tools) opens the same
// account panel as its status item, instead of activating an app with no window.
@MainActor
final class RouterAppDelegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "router" && url.host == "signin" {
            let provider = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard ["chatgpt", "google"].contains(provider) else { continue }
            NotificationCenter.default.post(name: .init("RouterSignInRequested"), object: nil, userInfo: ["provider": provider])
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        for window in sender.windows {
            if let button = statusButton(in: window.contentView) {
                button.performClick(nil)
                return false
            }
        }
        return true
    }

    private func statusButton(in view: NSView?) -> NSStatusBarButton? {
        if let button = view as? NSStatusBarButton { return button }
        for child in view?.subviews ?? [] {
            if let button = statusButton(in: child) { return button }
        }
        return nil
    }
}
