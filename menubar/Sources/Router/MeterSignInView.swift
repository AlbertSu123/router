import SwiftUI
import AppKit

struct MeterSignInView: View {
    let store: ProfileStore
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var succeeded = false
    @State private var message: String?
    @State private var session = UUID().uuidString
    @State private var browserURL: URL?
    @State private var loginTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "person.crop.circle.badge.checkmark")
                .font(.system(size: 32)).foregroundStyle(.indigo)
            Text("Sign in to Router").font(.title2.weight(.semibold))
            Text("Use your own account so shared usage is attributed to you. Subscription accounts stay separate.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !succeeded {
                VStack(spacing: 10) {
                    Button { start("chatgpt") } label: {
                        HStack(spacing: 9) {
                            BrandIcon(tool: .codex, size: 18)
                            Text("Sign in with ChatGPT").fontWeight(.semibold)
                            Spacer()
                            Image(systemName: "arrow.up.right").font(.caption)
                        }.padding(12).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).tint(.indigo)
                    .disabled(busy)
                    Button { start("google") } label: {
                        HStack(spacing: 9) {
                            Text("G").font(.headline).foregroundStyle(.blue).frame(width: 18)
                            Text("Continue with Google")
                            Spacer()
                            Image(systemName: "arrow.up.right").font(.caption)
                        }.padding(12).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered).disabled(busy)
                }
                Text("ChatGPT opens the Codex sign-in flow. Google is available if you prefer it or ChatGPT sign-in fails.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Finish signing in in your browser…").font(.callout).foregroundStyle(.secondary)
                }
                if let browserURL {
                    Button("Open browser again") { NSWorkspace.shared.open(browserURL) }
                        .buttonStyle(.link)
                }
            }
            if let message {
                Text(message).font(.callout)
                    .foregroundStyle(succeeded ? Color.green : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button(succeeded ? "Done" : "Cancel") {
                    loginTask?.cancel()
                    Task {
                        if busy { await store.cancelMeterSignIn(session: session) }
                        await loginTask?.value
                        busy = false
                        dismiss()
                    }
                }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24).frame(width: 420)
        .task {
            while !Task.isCancelled {
                if busy { browserURL = store.personalSignInURL(session: session) }
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
        .onAppear {
            succeeded = false
            message = nil
            if let provider = store.meterPreferredProvider {
                store.meterPreferredProvider = nil
                start(provider)
            }
        }
        .onDisappear {
            loginTask?.cancel()
            if busy {
                let closing = session
                Task { await store.cancelMeterSignIn(session: closing) }
            }
            busy = false
            browserURL = nil
        }
    }

    private func start(_ provider: String) {
        busy = true
        message = nil
        browserURL = nil
        session = UUID().uuidString
        loginTask = Task {
            let result = await store.signInMeter(provider: provider, session: session)
            guard !Task.isCancelled else { return }
            succeeded = result.ok
            message = result.message
            busy = false
            browserURL = nil
        }
    }
}
