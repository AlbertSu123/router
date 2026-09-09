import AppKit
import SwiftUI

// One segment per tool: its mark, and how much of the active account's
// window is spent. Which account that is belongs in the panel, where the
// full address fits and clicking it means something.
//
// The label is drawn as a single image on purpose. A MenuBarExtra label
// built from stacks is measured before its content settles and then clipped
// — the second tool's number goes missing — and an image interpolated into
// a Text comes out empty. Composing the whole line as one NSImage is the
// only shape that reliably sizes itself.
struct MenuBarLabel: View {
    let store: ProfileStore
    // The marks are the apps' own icons, so the label cannot be a template
    // image that macOS would recolor — the text color has to be chosen. This
    // is read only to re-render the label when the appearance changes: inside
    // a MenuBarExtra label SwiftUI reports .dark whatever the menu bar is
    // actually doing, so the color itself comes from the app's appearance.
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let _ = scheme
        return Image(nsImage: MenuBarRender.label(segments))
    }

    // Before the first usage fetch lands a segment is a mark and no number,
    // rather than a zero that would read as a real reading.
    private var segments: [MenuBarRender.Segment] {
        var rows = [segment(.claude)]
        if store.hasCodex { rows.append(segment(.codex)) }
        return rows
    }

    private func segment(_ tool: Tool) -> MenuBarRender.Segment {
        MenuBarRender.Segment(
            icon: Brand.icon(for: tool),
            fallback: tool == .claude ? "C" : "G",
            pct: store.headlinePct(tool))
    }
}

@MainActor
enum MenuBarRender {
    struct Segment {
        let icon: NSImage?
        let fallback: String
        let pct: Int?
    }

    private static let iconSize: CGFloat = 15

    static func label(_ segments: [Segment]) -> NSImage {
        let font = NSFont.menuBarFont(ofSize: 0)
        // labelColor is dynamic: it resolves when the line is drawn, under
        // the appearance set below.
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.labelColor,
        ]
        let line = NSMutableAttributedString()
        for segment in segments {
            if line.length > 0 {
                line.append(NSAttributedString(string: "  ", attributes: attributes))
            }
            if let icon = segment.icon {
                line.append(NSAttributedString(attachment: attachment(icon, font: font)))
            } else {
                line.append(NSAttributedString(string: segment.fallback, attributes: attributes))
            }
            if let pct = segment.pct {
                line.append(NSAttributedString(string: " \(pct)%", attributes: attributes))
            }
        }
        let size = NSSize(width: ceil(line.size().width), height: ceil(line.size().height))
        // The drawing handler runs again per scale factor, so the marks stay
        // sharp on a Retina display.
        let appearance = NSApp.effectiveAppearance
        return NSImage(size: size, flipped: false) { rect in
            appearance.performAsCurrentDrawingAppearance {
                line.draw(in: rect)
            }
            return true
        }
    }

    private static func attachment(_ icon: NSImage, font: NSFont) -> NSTextAttachment {
        let sized = (icon.copy() as? NSImage) ?? icon
        sized.size = NSSize(width: iconSize, height: iconSize)
        let attachment = NSTextAttachment()
        attachment.image = sized
        attachment.bounds = CGRect(
            x: 0, y: font.descender, width: iconSize, height: iconSize)
        return attachment
    }
}
