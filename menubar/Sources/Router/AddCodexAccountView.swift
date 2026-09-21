import SwiftUI
import AppKit

struct AddCodexAccountView: View {
    let store: ProfileStore
    @Environment(\.dismiss) private var dismiss
    @State private var device = false
    @State private var busy = false
    @State private var succeeded = false
    @State private var message: String?
    @State private var session = UUID().uuidString
    @State private var challenge: (url: String, code: String)?
    @State private var loginTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add a Codex Account").font(.headline)
            if !succeeded {
                Picker("Sign in on", selection: $device) {
                    Text("This Mac").tag(false)
                    Text("Another computer").tag(true)
                }
                .pickerStyle(.segmented)
                .disabled(busy)
                Text(device
                     ? "The account owner can authorize this Mac from their own browser. This gives Router access to use their Codex account here. Keep this window open until they finish."
                     : "Sign in with ChatGPT in your browser. Use a private window for an account that is not your browser default.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if device {
                    Text("Device code login must be enabled in the account’s ChatGPT security settings or workspace permissions.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let challenge, busy {
                Text(challenge.url).textSelection(.enabled)
                Text(challenge.code).font(.title2.monospaced()).textSelection(.enabled)
                Button("Copy instructions") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("To authorize Router on my Mac to use your Codex account, open \(challenge.url), sign in to the account you want to add, and enter this one-time code: \(challenge.code). Approve only if you intend to grant this Mac access. The code expires 15 minutes after it is issued.", forType: .string)
                }
            }
            if busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(device && challenge == nil ? "Getting a sign-in code…" : "Waiting for sign-in to finish…")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            if let message {
                Text(message).font(.callout)
                    .foregroundStyle(succeeded ? Color.green : Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if succeeded {
                    Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
                } else {
                    if !busy {
                        Button(device ? "Get sign-in code" : "Open sign-in") { start() }
                            .keyboardShortcut(.defaultAction)
                    }
                    Button("Cancel") {
                        loginTask?.cancel()
                        Task {
                            if busy { await store.cancelCodexSignIn(session: session) }
                            await loginTask?.value
                            busy = false
                            dismiss()
                        }
                    }.keyboardShortcut(.cancelAction)
                }
            }
        }
        .padding(20).frame(width: 460)
        .task {
            while !Task.isCancelled {
                if busy && device { challenge = store.codexChallenge(session: session) }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        .onAppear {
            succeeded = false
            message = nil
        }
        .onDisappear {
            loginTask?.cancel()
            if busy {
                let closingSession = session
                Task { await store.cancelCodexSignIn(session: closingSession) }
            }
            busy = false
            challenge = nil
        }
    }

    private func start() {
        busy = true
        message = nil
        challenge = nil
        session = UUID().uuidString
        loginTask = Task {
            let result = await store.addCodex(device: device, session: session)
            guard !Task.isCancelled else { return }
            succeeded = result.ok
            message = result.message
            challenge = nil
            busy = false
        }
    }
}
