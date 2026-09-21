import SwiftUI

struct AccountRow: View {
    let profile: Profile
    let isCurrent: Bool
    let usage: Usage?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: isCurrent ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isCurrent ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(profile.email ?? profile.name)
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
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 6)
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .background(
            hovering ? Color.primary.opacity(0.07) : Color.clear,
            in: RoundedRectangle(cornerRadius: 6))
        .onHover { hovering = $0 }
    }
}
