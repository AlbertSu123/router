import Foundation

@main
struct CLIProcessChecks {
    static func main() async {
        for _ in 0..<3 {
            await withTaskGroup(of: Bool.self) { group in
                for _ in 0..<20 {
                    group.addTask {
                        let r = await CLIProcess.run(executable: URL(fileURLWithPath: "/bin/echo"), arguments: ["fresh usage"], timeout: 3)
                        return r.ok && String(data: r.stdout ?? Data(), encoding: .utf8) == "fresh usage\n"
                    }
                }
                for await ok in group { precondition(ok, "Fast/concurrent CLI exit lost its completion") }
            }
        }
        let large = await CLIProcess.run(executable: URL(fileURLWithPath: "/usr/bin/python3"), arguments: ["-c", "import sys; sys.stderr.write('e'*200000); sys.stdout.write('o'*200000)"], timeout: 5)
        precondition(large.ok && large.stdout?.count == 200000 && large.stderr.count == 200000, "Pipe backpressure deadlocked")
        let failed = await CLIProcess.run(executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "printf failure >&2; exit 7"], timeout: 3)
        precondition(!failed.ok && String(data: failed.stderr, encoding: .utf8) == "failure")
        let missing = await CLIProcess.run(executable: URL(fileURLWithPath: "/nonexistent/router-test"), arguments: [], timeout: 3)
        precondition(!missing.ok && missing.stdout == nil)
        let start = Date()
        let timed = await CLIProcess.run(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["1"], timeout: 0.05)
        precondition(!timed.ok && timed.stdout == nil && Date().timeIntervalSince(start) < 0.7, "Timeout did not release caller")
        let retry = await CLIProcess.run(executable: URL(fileURLWithPath: "/bin/echo"), arguments: ["recovered"], timeout: 3)
        precondition(retry.ok)
        // Let late termination callbacks race the already-completed timeout.
        try? await Task.sleep(for: .milliseconds(100))
        print("CLI completion: concurrent fast exits, full stdout/stderr, errors, missing executable, timeout and retry passed.")
    }
}
