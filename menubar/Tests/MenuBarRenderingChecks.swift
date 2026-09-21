import AppKit

@main
struct MenuBarRenderingChecks {
    @MainActor static func main() {
        _ = NSApplication.shared
        let light = NSAppearance(named: .aqua)!
        let dark = NSAppearance(named: .darkAqua)!
        let rows = [MenuBarRender.Segment(icon: nil, fallback: "C", usage: "5h 12%"),
                    MenuBarRender.Segment(icon: nil, fallback: "G", usage: "7d 56%")]
        let first = MenuBarRender.label(rows, appearance: light)
        for _ in 0..<100 {
            assert(MenuBarRender.label(rows, appearance: light) === first)
        }
        let darkImage = MenuBarRender.label(rows, appearance: dark)
        assert(darkImage !== first)
        assert(MenuBarRender.label(rows, appearance: light) === first)
        let changed = MenuBarRender.label([.init(icon: nil, fallback: "G", usage: "7d 57%")], appearance: light)
        assert(changed !== first)
        assert(first.tiffRepresentation != nil && darkImage.tiffRepresentation != nil)
        assert(first.size.width > changed.size.width)
        print("Stable image identity, changed usage, both provider segments, and appearance checks passed.")
    }
}
