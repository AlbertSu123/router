import SwiftUI

struct PanelView: View {
    let store: ProfileStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // The two tools are switched independently, so they are only
            // told apart once Codex has an account; a Claude-only setup
            // keeps the plain list it had.
            if store.codexProfiles.isEmpty {
                rows(store.profiles)
            } else {
                section(Tool.claude.title, store.profiles)
                section(Tool.codex.title, store.codexProfiles)
            }
            Divider()
                .padding(.vertical, 6)
            HStack {
                if store.codexProfiles.isEmpty {
                    Menu("Add Account") {
                        Button("Claude Account…") { open("add") }
                        Button("Codex Account…") { open("add-codex") }
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                } else {
                    Button("Add Claude") { open("add") }
                    Button("Add Codex") { open("add-codex") }
                }
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
    private func section(_ title: String, _ profiles: [Profile]) -> some View {
        Text(title)
            .font(.caption)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.top, 4)
        rows(profiles)
    }

    @ViewBuilder
    private func rows(_ profiles: [Profile]) -> some View {
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
