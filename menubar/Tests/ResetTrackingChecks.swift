import Foundation

@main
struct ResetTrackingChecks {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let soon = BankedReset(expiresAt: now.timeIntervalSince1970 + 3600, expirationKnown: true, supported: true)
        assert(soon.isExpiring(at: now))
        assert(soon.text(at: now).contains("1h 0m left"))
        assert(!soon.isExpiring(at: now.addingTimeInterval(3600)))
        assert(soon.text(at: now.addingTimeInterval(3600)).contains("Expired"))
        assert(!BankedReset(expiresAt: now.timeIntervalSince1970 + 8 * 86400, expirationKnown: true, supported: nil).isExpiring(at: now))
        let none = BankedResets(["available": 1, "credits": [["expiresAt": NSNull()]], "detailsComplete": true])!
        assert(none.credits[0].text(at: now) == "No expiration")
        let unknown = BankedResets(["available": 1, "credits": [[:]], "detailsComplete": false])!
        assert(unknown.credits[0].text(at: now) == "Expiration unavailable")
        assert(unknown.expiringCount(at: now) == 0)
        assert(BankedResets(["available": -1]) == nil)
        print("Reset display, countdown, urgency, unknown dates, and expiry boundary checks passed.")
    }
}
