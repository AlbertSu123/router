import AppKit
import Observation

// Which CLI an account signs in to. The two are switched independently and
// the CLI addresses a Codex profile by its prefixed id.
enum Tool: String, Equatable {
    case claude
    case codex

    var title: String { self == .claude ? "Claude" : "Codex" }
    // How the CLI addresses a profile of this tool.
    var prefix: String { self == .codex ? "codex:" : "" }
}

struct Profile: Identifiable, Equatable {
    let tool: Tool
    let name: String
    let email: String?

    var id: String { tool.prefix + name }
}

// One limit as the usage endpoint reports it: a percentage consumed, and a
// note on the rest of it — when the window resets, or for a credit pool,
// the money behind the percentage.
struct UsageLimit: Equatable {
    let label: String
    let pct: Int
    let reset: Double?
    let detail: String?

    var text: String {
        guard let note = detail ?? reset.map(Self.until) else { return "\(label) \(pct)%" }
        return "\(label) \(pct)% (\(note))"
    }

    private static func until(_ epoch: Double) -> String {
        let secs = max(0, Int(epoch - Date().timeIntervalSince1970))
        if secs >= 86400 { return "\(secs / 86400)d" }
        if secs >= 3600 {
            let h = secs / 3600
            let m = (secs % 3600) / 60
            return m > 0 ? "\(h)h\(m)m" : "\(h)h"
        }
        if secs >= 60 { return "\(secs / 60)m" }
        return "<1m"
    }
}

struct Usage: Equatable {
    let five: UsageLimit?
    let week: UsageLimit?
    let scoped: [UsageLimit]
    // Accounts metered on spend rather than on windows report this instead
    // of the two above, never alongside them.
    let credits: UsageLimit?

    var isEmpty: Bool { five == nil && week == nil && scoped.isEmpty && credits == nil }

    // Every limit the endpoint reported, for the account row.
    var summary: String {
        ([five, week].compactMap { $0 } + scoped + [credits].compactMap { $0 })
            .map(\.text).joined(separator: " · ")
    }

    // The menu bar has room for one number. The 5-hour window is the one
    // that stops the next request; the weekly only stands in when the
    // endpoint withheld the session limit, and the credit pool when the
    // account has no windows to withhold.
    var headline: UsageLimit? { five ?? week ?? credits }
}

// Reads router state from disk for display. Switching, healing, and the
// sign-in flow go through the CLI, which owns the keychain-swap logic.
@MainActor
@Observable
final class ProfileStore {
    private(set) var current = "main"
    // The Codex account auth.json holds, or nil when Codex is logged out.
    private(set) var codexCurrent: String?
    // Limits per profile id, refreshed from `router usage --json`.
    private(set) var usage: [String: Usage] = [:]
    // Observed so the menu picks up an account added while it is open.
    private(set) var profiles: [Profile] = []
    private(set) var codexProfiles: [Profile] = []

    // The menu bar carries a mark per tool and the one number that matters,
    // no account names — those are a click away, where there is room for
    // them. Codex appears once an account is signed in to it.
    var hasCodex: Bool { !codexProfiles.isEmpty }

    func headlinePct(_ tool: Tool) -> Int? {
        activeID(tool).flatMap { usage[$0]?.headline?.pct }
    }

    private func activeID(_ tool: Tool) -> String? {
        tool == .claude ? current : codexCurrent.map { Tool.codex.prefix + $0 }
    }

    private let dir = NSHomeDirectory() + "/.router"
    private var currentFile: String { dir + "/current" }
    private var profilesFile: String { dir + "/profiles.json" }
    private var codexCurrentFile: String { dir + "/codex-current" }
    private var codexProfilesFile: String { dir + "/codex-profiles.json" }
    private var claudeConfig: String { NSHomeDirectory() + "/.claude.json" }

    init() {
        refresh()
    }

    func refresh() {
        let name = readCurrent()
        if name != current { current = name }
        let rows = readProfiles()
        if rows != profiles { profiles = rows }
        let codexRows = readCodexProfiles()
        if codexRows != codexProfiles { codexProfiles = codexRows }
        let codexName = readCodexCurrent()
        if codexName != codexCurrent { codexCurrent = codexName }
    }

    func isCurrent(_ profile: Profile) -> Bool {
        profile.tool == .codex ? codexCurrent == profile.name : current == profile.name
    }

    func select(_ id: String) async {
        _ = await Self.runCLI(["use", id])
        refresh()
    }

    func heal() async {
        _ = await Self.runCLI(["heal", "--quiet"])
    }

    func fetchUsage() async {
        guard let data = await Self.runCLI(["usage", "--json"]),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]]
        else { return }
        var next: [String: Usage] = [:]
        for (name, limits) in json {
            let scoped = limits["scoped"] as? [String: Any] ?? [:]
            let row = Usage(
                five: Self.limit("5h", limits["five"]),
                week: Self.limit("7d", limits["week"]),
                scoped: scoped.keys.sorted().compactMap { Self.limit($0, scoped[$0]) },
                credits: Self.credits(limits["credits"]))
            if !row.isEmpty { next[name] = row }
        }
        if next != usage { usage = next }
    }

    // A row carries its own window label when the provider's window lengths
    // decide it (Codex plans differ in how long a window runs); otherwise
    // the caller's name for the slot stands.
    private static func limit(_ label: String, _ raw: Any?) -> UsageLimit? {
        guard let limit = raw as? [String: Any], let pct = limit["pct"] as? Double else { return nil }
        return UsageLimit(
            label: limit["label"] as? String ?? label, pct: Int(pct),
            reset: limit["reset"] as? Double, detail: nil)
    }

    private static func credits(_ raw: Any?) -> UsageLimit? {
        guard let credits = raw as? [String: Any],
              let pct = credits["pct"] as? Double,
              let used = credits["used"] as? Double,
              let cap = credits["limit"] as? Double else { return nil }
        let money = NumberFormatter()
        money.numberStyle = .currency
        money.currencyCode = credits["currency"] as? String ?? "USD"
        let amount = { (value: Double) in
            money.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
        }
        return UsageLimit(
            label: "credits", pct: Int(pct), reset: nil,
            detail: "\(amount(used))/\(amount(cap))")
    }

    // Starts a sign-in: the CLI mints the PKCE URL, the browser opens it.
    // A reopen of the window reuses the pending sign-in, so a code the user
    // already copied stays valid and the browser does not open again.
    func beginSignIn() async {
        await signIn(fresh: false)
    }

    func restartSignIn() async {
        await signIn(fresh: true)
    }

    private func signIn(fresh: Bool) async {
        var args = ["auth", "start"]
        if fresh { args.append("--fresh") }
        guard let data = await Self.runCLI(args),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = json["url"] as? String,
              let url = URL(string: raw) else { return }
        if fresh || (json["fresh"] as? Bool ?? true) {
            NSWorkspace.shared.open(url)
        }
    }

    func redeem(_ code: String) async -> (ok: Bool, message: String) {
        guard let data = await Self.runCLI(["auth", "redeem", code]),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return (false, "The sign-in failed. Try again.")
        }
        if let error = json["error"] as? String {
            return (false, error)
        }
        guard let name = json["name"] as? String else {
            return (false, "The sign-in failed. Try again.")
        }
        let email = json["email"] as? String
        refresh()
        return (true, "Added \"\(name)\"" + (email.map { " (\($0))" } ?? ""))
    }

    // Codex signs in through its own CLI, which opens the browser and waits
    // for its callback, so there is no code to paste — this call runs for as
    // long as the user takes. The command answers with one JSON line per
    // event; the outcome is the last one.
    func addCodex() async -> (ok: Bool, message: String) {
        let failed = (false, "The Codex sign-in did not complete. Try again.")
        guard let data = await Self.runCLI(["auth", "codex", "login"]),
              let text = String(data: data, encoding: .utf8) else { return failed }
        let events = text.split(separator: "\n").compactMap {
            try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        }
        guard let outcome = events.last(where: { $0["name"] != nil || $0["error"] != nil }) else {
            return failed
        }
        if let error = outcome["error"] as? String { return (false, error) }
        guard let name = outcome["name"] as? String else { return failed }
        let email = outcome["email"] as? String
        refresh()
        return (true, "Added \"codex:\(name)\"" + (email.map { " (\($0))" } ?? ""))
    }

    // An abandoned sign-in holds Codex's callback port, which would make the
    // next one fail, so closing the window calls it off.
    func cancelCodexSignIn() async {
        _ = await Self.runCLI(["auth", "codex", "cancel"])
    }

    // Fresh from disk on every poll tick; the files are tiny.
    private func readProfiles() -> [Profile] {
        [Profile(tool: .claude, name: "main", email: mainEmail())]
            + storedProfiles(profilesFile, .claude)
    }

    // Codex has no "main": every account it knows is a profile, adopted
    // from ~/.codex/auth.json the first time router sees it.
    private func readCodexProfiles() -> [Profile] {
        storedProfiles(codexProfilesFile, .codex)
    }

    private func storedProfiles(_ path: String, _ tool: Tool) -> [Profile] {
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let stored = json["profiles"] as? [String: [String: Any]] else { return [] }
        return stored.keys.sorted().map {
            Profile(tool: tool, name: $0, email: stored[$0]?["email"] as? String)
        }
    }

    nonisolated private static func runCLI(_ args: [String]) async -> Data? {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: NSHomeDirectory() + "/.router/bin/router")
            process.arguments = args
            let out = Pipe()
            process.standardOutput = out
            process.standardError = Pipe()
            process.terminationHandler = { _ in
                // Errors also arrive as JSON on stdout; hand back whatever came.
                continuation.resume(returning: out.fileHandleForReading.readDataToEndOfFile())
            }
            do { try process.run() } catch { continuation.resume(returning: nil) }
        }
    }

    private func readCurrent() -> String {
        guard let raw = try? String(contentsOfFile: currentFile, encoding: .utf8) else { return "main" }
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "main" : name
    }

    private func readCodexCurrent() -> String? {
        guard let raw = try? String(contentsOfFile: codexCurrentFile, encoding: .utf8) else { return nil }
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    // While a profile is active, ~/.claude.json carries that profile's email
    // (router patches it so Claude Code's own UI shows the right account).
    // The real login's identity lives in the stash for that window.
    private func mainEmail() -> String? {
        for path in [dir + "/stash-account.json", claudeConfig] {
            guard let data = FileManager.default.contents(atPath: path),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            let account = path == claudeConfig ? json["oauthAccount"] as? [String: Any] : json
            if let email = account?["emailAddress"] as? String { return email }
        }
        return nil
    }
}
