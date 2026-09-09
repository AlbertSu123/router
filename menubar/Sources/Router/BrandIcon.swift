import AppKit
import SwiftUI

// Which account belongs to which tool is the one thing the menu has to say
// at a glance, so each side is marked with its own app's icon, taken from
// the copy installed on this Mac. Nobody's artwork is vendored into this
// repo, and a Mac without the app falls back to a monogram.
@MainActor
enum Brand {
    private static var cache: [Tool: NSImage?] = [:]

    private static let bundleIDs: [Tool: [String]] = [
        .claude: ["com.anthropic.claudefordesktop", "com.anthropic.claude"],
        .codex: ["com.openai.codex", "com.openai.chat"],
    ]

    static func icon(for tool: Tool) -> NSImage? {
        if let cached = cache[tool] { return cached }
        let workspace = NSWorkspace.shared
        let found = (bundleIDs[tool] ?? [])
            .lazy
            .compactMap { workspace.urlForApplication(withBundleIdentifier: $0) }
            .first
            .map { workspace.icon(forFile: $0.path) }
        cache[tool] = found
        return found
    }

    // An app icon is 512pt at rest, and inside a Text it draws at whatever
    // size it claims, so the menu bar copy is stamped down to the line.
    static func icon(for tool: Tool, size: CGFloat) -> NSImage? {
        guard let icon = icon(for: tool)?.copy() as? NSImage else { return nil }
        icon.size = NSSize(width: size, height: size)
        return icon
    }
}

struct BrandIcon: View {
    let tool: Tool
    var size: CGFloat = 14

    var body: some View {
        if let icon = Brand.icon(for: tool) {
            Image(nsImage: icon)
                .resizable()
                .interpolation(.high)
                .frame(width: size, height: size)
        } else {
            Text(tool == .claude ? "C" : "G")
                .font(.system(size: size * 0.62, weight: .semibold))
                .frame(width: size, height: size)
                .background(Color.secondary.opacity(0.25), in: Circle())
        }
    }
}
