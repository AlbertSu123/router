import SwiftUI

struct AccountRow: View {
    let profile: Profile
    let isCurrent: Bool
    let usage: Usage?
    // nil for the one account that cannot be removed: the main Claude login.
    var onRemove: (() -> Void)? = nil
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: isCurrent ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isCurrent ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(profile.email ?? profile.name).font(.callout.weight(isCurrent ? .semibold : .medium))
                        .lineLimit(1).truncationMode(.middle).help(profile.email ?? profile.name)
                    Text(profile.plan)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .help("Usage percentages are relative to this account’s own plan limits.")
                    if usage?.signedOut == true {
                        Text("Signed out — add this account again to reconnect")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    } else {
                        Text(usage?.summary.isEmpty == false ? usage!.summary : "no usage data yet")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let resets = usage?.resets {
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(resets.title).fontWeight(.medium)
                                ForEach(Array(resets.credits.enumerated()), id: \.offset) { _, credit in
                                    Text(credit.text(at: context.date))
                                        .foregroundStyle(credit.isExpiring(at: context.date) ? Color.orange : Color.secondary)
                                }
                                if !resets.detailsComplete {
                                    Text("Some expiration dates are unavailable").foregroundStyle(.secondary)
                                }
                            }
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let usage, usage.signedOut == false, let error = usage.error {
                        Text(error).font(.caption).foregroundStyle(.orange)
                    }
                }
                Spacer(minLength: 0)
                if let limit = usage?.headline {
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("\(limit.pct)%").font(.callout.monospacedDigit().weight(.semibold))
                            .foregroundStyle(limit.pct >= 90 ? Color.orange : Color.secondary)
                        ProgressView(value: Double(min(100, max(0, limit.pct))), total: 100)
                            .tint(limit.pct >= 90 ? .orange : .indigo).frame(width: 48)
                        Text(limit.label).font(.caption2).foregroundStyle(.tertiary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 10)
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .background(
            hovering ? Color.primary.opacity(0.07) : isCurrent ? Color.indigo.opacity(0.08) : Color.primary.opacity(0.025),
            in: RoundedRectangle(cornerRadius: 10))
        .onHover { hovering = $0 }
        .contextMenu {
            if let onRemove {
                Button("Remove Account…", role: .destructive, action: onRemove)
            }
        }
    }
}

// Shown in the row's place until the removal is confirmed or cancelled; an
// inline step, since a modal alert would dismiss the menu bar panel.
struct RemoveAccountConfirmation: View {
    let profile: Profile
    let busy: Bool
    let error: String?
    let cancel: () -> Void
    let confirm: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Remove \(profile.email ?? profile.name) from Router?")
                .font(.callout.weight(.semibold))
                .lineLimit(1).truncationMode(.middle)
            Text("Its saved sign-in is deleted from this Mac. To use it again, add the account again.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let error {
                Text(error).font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel", action: cancel)
                    .keyboardShortcut(.cancelAction)
                Button("Remove", role: .destructive, action: confirm)
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .disabled(busy || error != nil)
            }
            .controlSize(.small)
        }
        .padding(12)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}
