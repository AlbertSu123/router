import AppKit
import SwiftUI

// MenuBarExtra's window grows with its content but never shrinks back, so
// removing an account left the panel floating mid-way down an oversized,
// empty window. Size the window to the content, keeping its top edge under
// the menu bar.
extension View {
    func fitsHostingWindow() -> some View {
        modifier(FitsHostingWindow())
    }
}

private struct FitsHostingWindow: ViewModifier {
    @State private var window: NSWindow?
    @State private var height: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { height = $0; fit() }
            .background(WindowReader { window = $0; fit() })
    }

    private func fit() {
        guard let window, height > 0 else { return }
        let frame = window.frame
        let target = window.frameRect(forContentRect: NSRect(origin: .zero, size: NSSize(width: frame.width, height: height))).height
        guard abs(frame.height - target) > 0.5 else { return }
        window.setFrame(NSRect(x: frame.minX, y: frame.maxY - target, width: frame.width, height: target), display: true)
    }
}

private struct WindowReader: NSViewRepresentable {
    let found: (NSWindow?) -> Void

    func makeNSView(context: Context) -> NSView { Probe(found: found) }
    func updateNSView(_ view: NSView, context: Context) {}

    private final class Probe: NSView {
        let found: (NSWindow?) -> Void
        init(found: @escaping (NSWindow?) -> Void) {
            self.found = found
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError("unused") }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            let window = self.window
            DispatchQueue.main.async { self.found(window) }
        }
    }
}
