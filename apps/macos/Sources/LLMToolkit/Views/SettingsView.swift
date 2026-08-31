import LLMToolkitKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                HStack(spacing: 12) {
                    WatchdogCompanionMark(size: 48)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("LLM Toolkit")
                            .font(.headline)
                        Text("Nocturne · plasma cyan · conversation extraction")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Section("Toolkit") {
                Toggle("Use native Mac chrome", isOn: $model.preferences.useNativeChrome)
                Toggle("Start automatically", isOn: $model.preferences.autoStartServers)
                Toggle("Stop on quit (only if this app started it)", isOn: $model.preferences.stopServersOnQuit)
                TextField("API URL", text: apiURLBinding)
                HStack {
                    TextField("Checkout", text: $model.preferences.toolkitRootPath)
                    Button("Browse…") { model.chooseToolkitRoot() }
                }
                if let root = model.resolvedToolkitRoot {
                    LabeledContent("Detected", value: root.path)
                }
                Text("Leave blank to auto-detect from the stamped install path, LLM_TOOLKIT_ROOT, the current directory, or ~/.local/bin/llm-toolkit.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Status") {
                LabeledContent("Status", value: model.health.summary)
                if let count = model.health.conversationCount {
                    LabeledContent("Conversations", value: "\(count)")
                }
                if let last = model.health.lastIndexed {
                    LabeledContent("Last indexed", value: last)
                }
                HStack {
                    Button("Recheck") {
                        Task { await model.refreshHealth() }
                    }
                    Button("Start") {
                        Task { await model.startServers() }
                    }
                    Button("Rebuild Index") {
                        Task { await model.rebuildIndex() }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private var apiURLBinding: Binding<String> {
        Binding(
            get: { model.preferences.apiURL.absoluteString },
            set: { value in
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if let url = URL(string: trimmed), url.scheme != nil {
                    model.preferences.apiURL = url
                }
            }
        )
    }
}
