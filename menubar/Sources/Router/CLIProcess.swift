import Foundation

// Never call Process.waitUntilExit(): its run-loop wait can remain blocked
// after a CLI exits. Drain both pipes concurrently and observe termination.
enum CLIProcess {
    struct Result: Sendable {
        let ok: Bool
        let stdout: Data?
        let stderr: Data
    }

    static func run(executable: URL, arguments: [String], timeout: TimeInterval?) async -> Result {
        await withCheckedContinuation { continuation in
            let invocation = Invocation(continuation: continuation)
            invocation.start(executable: executable, arguments: arguments, timeout: timeout)
        }
    }

    private final class Invocation: @unchecked Sendable {
        private let lock = NSLock()
        private let process = Process()
        private let out = Pipe()
        private let err = Pipe()
        private var output: Data?
        private var errors: Data?
        private var status: Int32?
        private var continuation: CheckedContinuation<Result, Never>?
        private var deadline: DispatchWorkItem?

        init(continuation: CheckedContinuation<Result, Never>) { self.continuation = continuation }

        func start(executable: URL, arguments: [String], timeout: TimeInterval?) {
            process.executableURL = executable
            process.arguments = arguments
            process.standardOutput = out
            process.standardError = err
            process.terminationHandler = { [self] process in
                complete(status: process.terminationStatus)
            }
            do { try process.run() }
            catch { finish(Result(ok: false, stdout: nil, stderr: Data())); return }
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                complete(output: out.fileHandleForReading.readDataToEndOfFile())
            }
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                complete(errors: err.fileHandleForReading.readDataToEndOfFile())
            }
            if let timeout {
                let deadline = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    // Release the UI even if process termination/pipe completion
                    // never arrives. Cached readings must be marked stale.
                    self.finish(Result(ok: false, stdout: nil, stderr: Data("Router command timed out".utf8)))
                    if self.process.isRunning { self.process.terminate() }
                }
                lock.lock()
                if continuation != nil { self.deadline = deadline }
                else { deadline.cancel() }
                lock.unlock()
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
            }
        }

        private func complete(output: Data? = nil, errors: Data? = nil, status: Int32? = nil) {
            lock.lock()
            if let output { self.output = output }
            if let errors { self.errors = errors }
            if let status { self.status = status }
            let result = self.output.flatMap { output in self.errors.flatMap { errors in
                self.status.map { Result(ok: $0 == 0, stdout: output, stderr: errors) }
            } }
            lock.unlock()
            if let result { finish(result) }
        }

        private func finish(_ result: Result) {
            lock.lock()
            let continuation = self.continuation
            self.continuation = nil
            let deadline = self.deadline
            self.deadline = nil
            lock.unlock()
            deadline?.cancel()
            process.terminationHandler = nil
            continuation?.resume(returning: result)
        }
    }
}
