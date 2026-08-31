import SwiftUI

/// Shown until the local API (which also serves the console) answers /api/health.
struct StartingOverlay: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 18) {
            WatchdogHeroBanner(height: 168)
                .frame(maxWidth: 560)

            if model.isStarting {
                ProgressView()
                    .controlSize(.small)
                Text(model.banner ?? "Starting local console…")
                    .font(.callout)
                    .foregroundStyle(Nocturne.textMuted)
            } else if let error = model.lastError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title2)
                    .foregroundStyle(Nocturne.warning)
                    .accessibilityHidden(true)
                Text(error)
                    .font(.callout)
                    .foregroundStyle(Nocturne.textPrimary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
                actionRow
            } else if !model.preferences.autoStartServers {
                Text("The local console is not running.")
                    .font(.callout)
                    .foregroundStyle(Nocturne.textPrimary)
                actionRow
            } else {
                ProgressView()
                    .controlSize(.small)
                Text(model.health.detail ?? "Waiting for local console…")
                    .font(.callout)
                    .foregroundStyle(Nocturne.textMuted)
                actionRow
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Nocturne.surface)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Local console status")
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            Button("Choose Checkout…") {
                model.chooseToolkitRoot()
            }
            Button("Recheck") {
                Task { await model.refreshHealth() }
            }
            Button("Start") {
                Task { await model.startServers() }
            }
            .keyboardShortcut(.defaultAction)
        }
        .controlSize(.regular)
    }
}
