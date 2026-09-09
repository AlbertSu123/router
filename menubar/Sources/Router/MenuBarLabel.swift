import AppKit
import SwiftUI

// One segment per tool: its mark, and the limit that would stop the next
// request — which window it covers and how much of it is spent. Which
// account that is belongs in the panel, where the full address fits and
// clicking it means something.
//
// The label is drawn as a single image on purpose. A MenuBarExtra label
// built from stacks is measured before its content settles and then clipped
// — the second tool's number goes missing — and an image interpolated into
// a Text comes out empty. Composing the whole line as one NSImage is the
// only shape that reliably sizes itself.
struct MenuBarLabel: View {
    let store: ProfileStore

    var body: some View {
        Image(nsImage: MenuBarRender.label(segments, appearance: store.barAppearance))
    }

    // Before the first usage fetch lands a segment is a mark and no number,
    // rather than a zero that would read as a real reading.
    private var segments: [MenuBarRender.Segment] {
        var rows = [segment(.claude)]
        if store.hasCodex { rows.append(segment(.codex)) }
        return rows
    }

    private func segment(_ tool: Tool) -> MenuBarRender.Segment {
        let limit = store.headline(tool)
        return MenuBarRender.Segment(
            icon: Brand.icon(for: tool),
            fallback: tool == .claude ? "C" : "G",
            usage: limit.map { "\($0.label) \($0.pct)%" })
    }
}

@MainActor
enum MenuBarRender {
    struct Segment {
        let icon: NSImage?
        let fallback: String
        let usage: String?
    }

    private static let iconSize: CGFloat = 15

    // The marks are the apps' own icons, so this cannot be a template image
    // that AppKit would recolor; the text color is chosen here instead,
    // under whatever appearance the menu bar is itself drawing in.
    static func label(_ segments: [Segment], appearance: NSAppearance) -> NSImage {
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
            if let usage = segment.usage {
                line.append(NSAttributedString(string: " \(usage)", attributes: attributes))
            }
        }
        let size = NSSize(width: ceil(line.size().width), height: ceil(line.size().height))
        // The drawing handler runs again per scale factor, so the marks stay
        // sharp on a Retina display.
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
