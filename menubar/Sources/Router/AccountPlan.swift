import Foundation

// Labels describe the provider's stored metadata, never infer a tier from usage.
enum AccountPlan {
    static func claude(_ account: [String: Any]?) -> String {
        let tier = account?["organizationRateLimitTier"] as? String ?? ""
        let kind = account?["organizationType"] as? String ?? ""
        if tier == "default_claude_max_20x" { return "Claude Max · 20×" }
        if tier == "default_claude_max_5x" { return "Claude Max · 5×" }
        let names = ["claude_max": "Claude Max", "claude_pro": "Claude Pro",
                     "claude_team": "Claude Team", "claude_enterprise": "Claude Enterprise",
                     "claude_free": "Claude Free"]
        let label = names[kind] ?? (kind.isEmpty ? "Claude · plan unavailable" : "Claude · \(kind)")
        if account?["billingType"] as? String == "enterprise_usage_based" {
            return label + " · usage-based"
        }
        return label
    }

    static func codex(_ plan: String?) -> String {
        guard let plan, !plan.isEmpty else { return "ChatGPT · plan unavailable" }
        let names = ["free": "Free", "go": "Go", "plus": "Plus", "pro": "Pro",
                     "prolite": "Pro (prolite tier)", "team": "Business", "business": "Business",
                     "enterprise": "Enterprise", "edu": "Edu"]
        return "ChatGPT " + (names[plan.lowercased()] ?? plan)
    }
}
