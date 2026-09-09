import SwiftUI

// Codex signs in through its own CLI: it opens the browser and waits for
// its own callback, so this window has nothing to collect — it starts the
// sign-in, waits, and reports what came back.
struct AddCodexAccountView: View {
    let store: ProfileStore
    @Environment(\.dismiss) private var dismiss
    @State private var busy = true
    @State private var succeeded = false
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add a Codex Account")
                .font(.headline)
            Text("The ChatGPT sign-in is open in your browser. Use a private window for an account that is not your browser default. There is no code to paste — this window finishes when the sign-in does.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Waiting for the sign-in to finish…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(succeeded ? Color.green : Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if succeeded {
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            } else {
                Button("Cancel") {
                    Task {
                        await store.cancelCodexSignIn()
                        dismiss()
                    }
                }
                .keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 440)
        .task {
            busy = true
            succeeded = false
            message = nil
            let result = await store.addCodex()
            succeeded = result.ok
            message = result.message
            busy = false
        }
        // Closing the window mid-flight leaves `codex login` holding its
        // callback port, which would break the next attempt.
        .onDisappear {
            guard !succeeded else { return }
            Task { await store.cancelCodexSignIn() }
        }
    }
}
