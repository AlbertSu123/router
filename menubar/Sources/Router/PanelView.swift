import SwiftUI

struct PanelView: View {
    let store: ProfileStore
    @Environment(\.openWindow) private var openWindow
    @State private var removing: Profile?
    @State private var removeBusy = false
    @State private var removeError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.indigo)
                    .frame(width: 34, height: 34)
                    .background(.indigo.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Router").font(.headline)
                    Text("Your shared subscriptions").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await store.fetchUsage(); await store.refreshMeter() } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh subscriptions and usage")
                .accessibilityLabel("Refresh subscriptions and usage")
            }
            .padding(16)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    section(.claude, store.profiles)
                    if store.hasCodex { section(.codex, store.codexProfiles) }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
            }
            .frame(maxHeight: 470)
            .fixedSize(horizontal: false, vertical: true)

            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    if store.meterName == nil { open("router-signin") }
                    else { Task { await store.openSharedUsage() } }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "chart.bar.xaxis").font(.title3).foregroundStyle(.indigo)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(store.meterName == nil ? "Sign in to Router" : "Shared usage")
                                .font(.callout.weight(.semibold))
                            Text(store.meterName.map { "Tracking as \($0)" } ?? "See who uses each subscription")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(.indigo.opacity(0.07), in: RoundedRectangle(cornerRadius: 11))
                    .contentShape(RoundedRectangle(cornerRadius: 11))
                }
                .buttonStyle(.plain)
                if let code = store.meterCode {
                    Text("Confirm code \(code) in your browser")
                        .font(.caption.monospaced()).textSelection(.enabled)
                }
                if let error = store.meterError {
                    Text(error).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                } else if store.meterName != nil {
                    Text(store.meterLastSync.map { "Synced \($0.formatted(date: .omitted, time: .shortened)) · \(store.meterSubscriptionCount) subscriptions" } ?? "Verifying subscriptions…")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                HStack(spacing: 14) {
                    Menu {
                        Button("Add Claude account") { open("add") }
                        Button("Add Codex account") { open("add-codex") }
                    } label: { Label("Add account", systemImage: "plus") }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    Spacer()
                    if store.meterName != nil {
                        Button("Sign out") { Task { await store.signOutMeter() } }
                    }
                    Button("Quit") { NSApplication.shared.terminate(nil) }
                }
                .buttonStyle(.borderless)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 3)
                .padding(.top, 3)
            }
            .padding(12)
        }
        .frame(width: 440)
        .fitsHostingWindow()
        .task { await store.refreshMeter(); await store.fetchUsage() }
    }

    private func section(_ tool: Tool, _ profiles: [Profile]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                BrandIcon(tool: tool, size: 14)
                Text(tool.title).font(.caption.weight(.semibold))
                Spacer()
                Text("\(profiles.count) \(profiles.count == 1 ? "account" : "accounts")")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            ForEach(profiles) { profile in
                if removing == profile {
                    RemoveAccountConfirmation(profile: profile, busy: removeBusy, error: removeError,
                                              cancel: { removing = nil }, confirm: { confirmRemove(profile) })
                } else {
                    AccountRow(profile: profile, isCurrent: store.isCurrent(profile), usage: store.usage[profile.id],
                               onRemove: profile.id == "main" ? nil : { removeError = nil; removing = profile }) {
                        Task { await store.select(profile.id) }
                    }
                }
            }
        }
    }

    private func confirmRemove(_ profile: Profile) {
        removeBusy = true
        Task {
            let error = await store.remove(profile)
            removeBusy = false
            if let error { removeError = error } else { removing = nil }
        }
    }

    private func open(_ id: String) {
        openWindow(id: id)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
