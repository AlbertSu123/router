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
    var plan: String = "Plan unavailable"

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
    let resets: BankedResets?
    let stale: Bool
    let observedAt: Double?
    let five: UsageLimit?
    let week: UsageLimit?
    let scoped: [UsageLimit]
    // Accounts metered on spend rather than on windows report this instead
    // of the two above, never alongside them.
    let credits: UsageLimit?

    var isEmpty: Bool { five == nil && week == nil && scoped.isEmpty && credits == nil && resets == nil }

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
    var meterPreferredProvider: String?
    private(set) var meterName: String?
    private(set) var meterPending = 0
    private(set) var meterError: String?
    private(set) var meterLastSync: Date?
    private(set) var meterSubscriptionCount = 0
    private(set) var meterCode: String?
    private(set) var meterSigningIn = false

    // Limits per profile id, refreshed from `router usage --json`.
    private(set) var usage: [String: Usage] = [:]
    // Observed so the menu picks up an account added while it is open.
    private(set) var profiles: [Profile] = []
    private(set) var codexProfiles: [Profile] = []

    // The menu bar item draws its own text, so it needs the appearance the
    // menu bar is actually using. That is not the app's: a light wallpaper
    // tints the bar light while the system runs dark, which is why every
    // other item draws a template image and lets AppKit recolor it.
    private(set) var barAppearance = ProfileStore.statusBarAppearance()

    // The menu bar carries a mark per tool and the one limit that matters,
    // no account names — those are a click away, where there is room for
    // them. Codex appears once an account is signed in to it.
    var hasCodex: Bool { !codexProfiles.isEmpty }

    func expiringResetCount(at now: Date) -> Int {
        codexProfiles.reduce(0) { total, profile in
            total + (usage[profile.id]?.resets?.expiringCount(at: now) ?? 0)
        }
    }

    func headline(_ tool: Tool) -> UsageLimit? {
        activeID(tool).flatMap { usage[$0]?.headline }
    }

    // NSApp is still nil while this store is being built, so the shared
    // instance is asked instead; the status item's window only exists once
    // the scene is up, and the poll picks it up on a later tick.
    private static func statusBarAppearance() -> NSAppearance {
        let app = NSApplication.shared
        return app.windows.first { $0.className == "NSStatusBarWindow" }?.effectiveAppearance
            ?? app.effectiveAppearance
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
        refreshMeterState()
        let name = readCurrent()
        if name != current { current = name }
        let rows = readProfiles()
        if rows != profiles { profiles = rows }
        let codexRows = readCodexProfiles()
        if codexRows != codexProfiles { codexProfiles = codexRows }
        let codexName = readCodexCurrent()
        if codexName != codexCurrent { codexCurrent = codexName }
        let bar = Self.statusBarAppearance()
        if bar.name != barAppearance.name { barAppearance = bar }
    }

    private func refreshMeterState() {
        let session = readDictionary(dir + "/meter-session.json")
        let name = (session?["user"] as? [String: Any])?["name"] as? String
        if name != meterName { meterName = name }
        let status = readDictionary(dir + "/meter-sync-status.json")
        let error = (readDictionary(dir + "/meter-setup.json")?["warning"] as? String) ?? (status?["error"] as? String)
        if error != meterError { meterError = error }
        let count = status?["subscriptions"] as? Int ?? 0
        if count != meterSubscriptionCount { meterSubscriptionCount = count }
        let date = (status?["lastSync"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
        if date != meterLastSync { meterLastSync = date }
    }

    private func readDictionary(_ path: String) -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func signInMeter(provider: String, session: String) async -> (ok: Bool, message: String) {
        guard let data = await Self.runCLI(["meter", "social-login", provider, "--session=\(session)"]),
              let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return (false, "Sign-in did not finish. Please try again.")
        }
        if let error = result["error"] as? String { return (false, error) }
        guard result["ok"] as? Bool == true else { return (false, "Sign-in did not finish.") }
        refresh()
        return (true, (result["warning"] as? String) ?? "Signed in. Router is verifying your subscriptions.")
    }

    func personalSignInURL(session: String) -> URL? {
        guard let status = readDictionary(dir + "/meter-personal-status.json"),
              status["session"] as? String == session,
              let raw = status["url"] as? String, let url = URL(string: raw),
              url.scheme == "https", ["auth.openai.com", "accounts.google.com"].contains(url.host ?? "") else { return nil }
        return url
    }

    func cancelMeterSignIn(session: String) async {
        _ = await Self.runCLI(["meter", "cancel-login", "--session=\(session)"])
    }

    func openSharedUsage() async {
        guard let data = await Self.runCLI(["meter", "dashboard"]),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            meterError = "Could not reach shared usage. Try again."
            return
        }
        if let error = json["error"] as? String { meterError = error; return }
        if let raw = json["url"] as? String, let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
        }
        if let code = json["code"] as? String {
            meterCode = code
            guard !meterSigningIn else { return }
            meterSigningIn = true
            defer { meterSigningIn = false }
            for _ in 0..<300 {
                try? await Task.sleep(for: .seconds(2))
                guard let result = await Self.runCLI(["meter", "finish"]),
                      let status = try? JSONSerialization.jsonObject(with: result) as? [String: Any] else { continue }
                if status["ok"] as? Bool == true {
                    meterCode = nil
                    refresh()
                    meterError = status["warning"] as? String
                    return
                }
                if let error = status["error"] as? String {
                    meterError = error
                    meterCode = nil
                    return
                }
            }
            meterCode = nil
            meterError = "Sign-in expired. Try again."
        }
    }

    func refreshMeter() async {
        if let data = await Self.runCLI(["meter", "status"]),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            meterPending = json["pending"] as? Int ?? 0
        }
        refreshMeterState()
    }

    func signOutMeter() async {
        if let data = await Self.runCLI(["meter", "logout"]),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let error = json["error"] as? String { meterError = error; return }
        refresh()
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
                resets: BankedResets(limits["resets"]),
                stale: limits["stale"] as? Bool ?? false,
                observedAt: limits["observedAt"] as? Double,
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
    func addCodex(device: Bool = false, session: String = "local") async -> (ok: Bool, message: String) {
        let failed = (false, "The Codex sign-in did not complete. Try again.")
        guard let data = await Self.runCLI(["auth", "codex", "login", "--replace", "--session=\(session)"] + (device ? ["--device-auth"] : [])),
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
    func codexChallenge(session: String) -> (url: String, code: String)? {
        guard let data = FileManager.default.contents(atPath: dir + "/codex-login-status.json"),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              value["session"] == session,
              let url = value["url"], let code = value["code"] else { return nil }
        return (url, code)
    }

    func cancelCodexSignIn(session: String) async {
        _ = await Self.runCLI(["auth", "codex", "cancel", "--session=\(session)"])
    }

    // Fresh from disk on every poll tick; the files are tiny.
    private func readProfiles() -> [Profile] {
        [Profile(tool: .claude, name: "main", email: mainEmail(), plan: AccountPlan.claude(mainAccount()))]
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
            Profile(tool: tool, name: $0, email: stored[$0]?["email"] as? String,
                    plan: tool == .codex ? AccountPlan.codex(stored[$0]?["plan"] as? String)
                        : AccountPlan.claude(stored[$0]?["account"] as? [String: Any]))
        }
    }

    nonisolated private static func runCLI(_ args: [String]) async -> Data? {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: NSHomeDirectory() + "/.router/bin/router")
            process.arguments = args
            let out = Pipe()
            process.standardOutput = out
            process.standardError = FileHandle.nullDevice
            do { try process.run() } catch { continuation.resume(returning: nil); return }
            DispatchQueue.global(qos: .userInitiated).async {
                let data = out.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                continuation.resume(returning: data)
            }
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
    private func mainEmail() -> String? { mainAccount()?["emailAddress"] as? String }

    private func mainAccount() -> [String: Any]? {
        for path in [dir + "/stash-account.json", claudeConfig] {
            guard let data = FileManager.default.contents(atPath: path),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            let account = path == claudeConfig ? json["oauthAccount"] as? [String: Any] : json
            if let account, account["emailAddress"] is String { return account }
        }
        return nil
    }
}
