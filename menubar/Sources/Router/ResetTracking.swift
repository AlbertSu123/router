import Foundation

struct BankedReset: Equatable {
    let expiresAt: Double?
    let expirationKnown: Bool
    let supported: Bool?

    func isExpiring(at now: Date) -> Bool {
        guard let expiresAt else { return false }
        let remaining = expiresAt - now.timeIntervalSince1970
        return remaining > 0 && remaining <= 7 * 86400
    }

    func text(at now: Date) -> String {
        guard let expiresAt else { return expirationKnown ? "No expiration" : "Expiration unavailable" }
        let date = Date(timeIntervalSince1970: expiresAt)
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, yyyy, h:mm a z"
        let remaining = expiresAt - now.timeIntervalSince1970
        let prefix = remaining <= 0 ? "Expired" : "Expires"
        let countdown: String
        if remaining <= 0 { countdown = "refresh pending" }
        else if remaining < 60 { countdown = "<1m left" }
        else if remaining < 3600 { countdown = "\(Int(remaining / 60))m left" }
        else if remaining < 86400 { countdown = "\(Int(remaining / 3600))h \(Int(remaining.truncatingRemainder(dividingBy: 3600) / 60))m left" }
        else { countdown = "\(Int(remaining / 86400))d left" }
        return "\(prefix) \(formatter.string(from: date)) · \(countdown)" + (supported == false ? " · plan ineligible" : "")
    }
}

struct BankedResets: Equatable {
    let available: Int
    let applicable: Int?
    let credits: [BankedReset]
    let detailsComplete: Bool

    init?(_ raw: Any?) {
        guard let value = raw as? [String: Any], let count = value["available"] as? Int, count >= 0 else { return nil }
        available = count
        applicable = value["applicable"] as? Int
        detailsComplete = value["detailsComplete"] as? Bool ?? false
        credits = (value["credits"] as? [[String: Any]] ?? []).map {
            BankedReset(expiresAt: $0["expiresAt"] as? Double,
                        expirationKnown: $0["expiresAt"] != nil,
                        supported: $0["supported"] as? Bool)
        }
    }

    var title: String {
        "\(available) banked reset\(available == 1 ? "" : "s")" + (applicable.map { " · \($0) usable now" } ?? "")
    }

    func expiringCount(at now: Date) -> Int { credits.filter { $0.isExpiring(at: now) }.count }
}
