import SwiftUI

struct AccountRow: View {
    let profile: Profile
    let isCurrent: Bool
    let usage: Usage?
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
                    Text(usage?.summary.isEmpty == false ? usage!.summary : "no usage data yet")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
                                if usage?.stale == true {
                                    Text("Cached data — could not refresh").foregroundStyle(.orange)
                                }
                            }
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                        }
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
    }
}
