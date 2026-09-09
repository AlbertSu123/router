import SwiftUI

struct PanelView: View {
    let store: ProfileStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // The two tools are switched independently, so each gets its own
            // marked section. Codex appears once it has an account.
            section(.claude, store.profiles)
            if store.hasCodex {
                section(.codex, store.codexProfiles)
            }
            Divider()
                .padding(.vertical, 6)
            HStack(spacing: 12) {
                Button("Add Claude") { open("add") }
                Button("Add Codex") { open("add-codex") }
                Spacer()
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .font(.callout)
            .padding(.horizontal, 6)
        }
        .padding(10)
        .frame(width: 380)
        .task { await store.fetchUsage() }
    }

    @ViewBuilder
    private func section(_ tool: Tool, _ profiles: [Profile]) -> some View {
        HStack(spacing: 6) {
            BrandIcon(tool: tool, size: 14)
            Text(tool.title)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 6)
        .padding(.top, 4)
        .padding(.bottom, 2)
        ForEach(profiles) { profile in
            AccountRow(
                profile: profile,
                isCurrent: store.isCurrent(profile),
                usage: store.usage[profile.id]?.summary
            ) {
                Task { await store.select(profile.id) }
            }
        }
    }

    private func open(_ id: String) {
        openWindow(id: id)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
