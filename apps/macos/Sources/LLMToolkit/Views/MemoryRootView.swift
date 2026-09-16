import ClaudeMemoryKit
import LLMToolkitKit
import SwiftUI

/// Native Claude Memory surface (the only non-WKWebView route): project picker
/// with counts, memory list with live debounced search, and a detail pane.
struct MemoryRootView: View {
    @Environment(AppModel.self) private var appModel
    @State private var showNewSheet = false

    private var memory: MemoryModel { appModel.memory }

    var body: some View {
        @Bindable var memory = memory
        VStack(spacing: 0) {
            if memory.daemonPhase != .ready {
                daemonBanner
            }
            HSplitView {
                memoryListPane
                    .frame(minWidth: 300, idealWidth: 360)
                detailPane
                    .frame(minWidth: 380, maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Nocturne.surface)
        .task {
            memory.updateHealth(apiReady: appModel.health.isReady, apiStarting: appModel.isStarting)
            await memory.bootstrapIfNeeded()
        }
        .onChange(of: appModel.health.isReady) {
            memory.updateHealth(apiReady: appModel.health.isReady, apiStarting: appModel.isStarting)
        }
        .onChange(of: appModel.isStarting) {
            memory.updateHealth(apiReady: appModel.health.isReady, apiStarting: appModel.isStarting)
        }
        .onChange(of: appModel.preferences.apiURL) {
            Task { await memory.bootstrapIfNeeded(force: true) }
        }
        .sheet(isPresented: $showNewSheet) {
            NewMemorySheet(memory: memory)
        }
    }

    // MARK: - Daemon banner

    private var daemonBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: memory.daemonPhase == .apiStarting ? "hourglass" : "wifi.exclamationmark")
                .foregroundStyle(Nocturne.warning)
            VStack(alignment: .leading, spacing: 1) {
                Text(memory.daemonPhase == .apiStarting ? "Toolkit API starting…" : "Toolkit API unreachable")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Nocturne.textPrimary)
                if memory.isStale {
                    Text("Showing cached memories — read-only until the API responds.")
                        .font(.caption)
                        .foregroundStyle(Nocturne.textMuted)
                }
            }
            Spacer(minLength: 0)
            Button("Retry") {
                Task {
                    await appModel.refreshHealth()
                    await memory.bootstrapIfNeeded(force: true)
                }
            }
            if !appModel.isStarting {
                Button("Start Servers") {
                    Task { await appModel.startServers() }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Nocturne.canvas)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Nocturne.border).frame(height: 1)
        }
    }

    // MARK: - List pane

    private var memoryListPane: some View {
        @Bindable var memory = memory
        return VStack(spacing: 0) {
            HStack(spacing: 8) {
                Picker("Project", selection: $memory.selectedProject) {
                    ForEach(memory.projects) { project in
                        Text("\(project.slug) (\(project.memoryCount))")
                            .tag(project.slug as String?)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    Task {
                        await appModel.refreshHealth()
                        await memory.reloadProjects()
                        await memory.reloadMemories()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh")
                Button {
                    showNewSheet = true
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)
                .disabled(!memory.canWrite)
                .help(memory.canWrite ? "New memory" : "Writes disabled while the API is unreachable")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Nocturne.textMuted)
                TextField("Search memories…", text: $memory.searchText)
                    .textFieldStyle(.plain)
                if !memory.searchText.isEmpty {
                    Button {
                        memory.searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Nocturne.textMuted)
                    }
                    .buttonStyle(.borderless)
                    .help("Clear search")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Nocturne.canvas, in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Nocturne.border, lineWidth: 1)
            )
            .padding(.horizontal, 12)
            .padding(.bottom, 8)

            if !memory.canWrite {
                Text("Writes are disabled while the toolkit API is unreachable.")
                    .font(.caption)
                    .foregroundStyle(Nocturne.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 4)
            }

            listContent
        }
        .background(Nocturne.canvas)
    }

    @ViewBuilder
    private var listContent: some View {
        if let hits = memory.searchHits {
            List(selection: Binding(
                get: { memory.detail?.slug },
                set: { slug in
                    guard let slug, let hit = hits.first(where: { $0.slug == slug }) else { return }
                    Task { await select(hit: hit) }
                }
            )) {
                ForEach(hits) { hit in
                    searchHitRow(hit)
                        .tag(hit.slug)
                        .contextMenu {
                            openInProjectButton(hit)
                        }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        } else if let entries = memory.listResult?.entries {
            List(selection: Binding(
                get: { memory.detail?.slug },
                set: { slug in
                    guard let slug else {
                        memory.clearDetail()
                        return
                    }
                    Task {
                        await memory.loadDetail(project: memory.selectedProject ?? "", slug: slug)
                    }
                }
            )) {
                ForEach(entries) { entry in
                    entryRow(entry)
                        .tag(entry.slug)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        } else if memory.isLoadingList || memory.isLoadingProjects {
            ProgressView("Loading memories…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            emptyState
        }
    }

    private func select(hit: SearchHit) async {
        if memory.selectedProject != hit.project {
            await memory.select(project: hit.project)
        }
        await memory.loadDetail(project: hit.project, slug: hit.slug)
    }

    private func openInProjectButton(_ hit: SearchHit) -> some View {
        Button("Open in \(hit.project)") {
            Task { await select(hit: hit) }
        }
    }

    private func searchHitRow(_ hit: SearchHit) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(hit.slug)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Nocturne.textBright)
                Text(hit.field)
                    .font(.caption2)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Nocturne.surfaceRaised, in: Capsule())
                    .foregroundStyle(Nocturne.textMuted)
                if hit.project != memory.selectedProject {
                    Text(hit.project)
                        .font(.caption2.monospaced())
                        .foregroundStyle(Nocturne.textDim)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("L\(hit.line)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(Nocturne.textDim)
            }
            Text(hit.snippet)
                .font(.caption)
                .foregroundStyle(Nocturne.textMuted)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
    }

    private func entryRow(_ entry: MemorySummary) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(entry.title)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(Nocturne.textBright)
                        .lineLimit(1)
                    if let type = entry.type {
                        Text(type)
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Nocturne.surfaceRaised, in: Capsule())
                            .foregroundStyle(Nocturne.textMuted)
                    }
                    if !entry.indexed {
                        Image(systemName: "slash.circle")
                            .font(.caption2)
                            .foregroundStyle(Nocturne.textDim)
                            .help("Not in MEMORY.md index")
                    }
                }
                if let hook = entry.indexHook ?? entry.description {
                    Text(hook)
                        .font(.caption)
                        .foregroundStyle(Nocturne.textMuted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if let modified = entry.modified {
                Text(Self.shortDate(modified))
                    .font(.caption2)
                    .foregroundStyle(Nocturne.textDim)
            }
        }
        .padding(.vertical, 2)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "brain")
                .font(.title)
                .foregroundStyle(Nocturne.textDim)
            Text(memory.projects.isEmpty ? "No memory projects found" : "No memories in this project")
                .font(.callout)
                .foregroundStyle(Nocturne.textMuted)
            Text("Memories live in ~/.claude/projects/<project>/memory/.")
                .font(.caption)
                .foregroundStyle(Nocturne.textDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Detail pane

    private var detailPane: some View {
        Group {
            if let detail = memory.detail {
                MemoryDetailView(memory: memory, detail: detail)
            } else if let error = memory.lastError {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(Nocturne.danger)
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(Nocturne.textMuted)
                        .multilineTextAlignment(.center)
                    Button("Retry") {
                        Task { await memory.bootstrapIfNeeded(force: true) }
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Text("Select a memory")
                    .font(.callout)
                    .foregroundStyle(Nocturne.textDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private static func shortDate(_ iso: String) -> String {
        String(iso.prefix(10))
    }
}

// MARK: - New memory sheet

private struct NewMemorySheet: View {
    @Bindable var memory: MemoryModel
    @Environment(\.dismiss) private var dismiss

    @State private var slug = ""
    @State private var name = ""
    @State private var descriptionText = ""
    @State private var type = ""
    @State private var bodyText = ""

    var body: some View {
        VStack(spacing: 0) {
            header("New memory", subtitle: memory.selectedProject ?? "")
            Form {
                TextField("Slug", text: $slug)
                    .help("Filename stem — ^[A-Za-z0-9][A-Za-z0-9._-]*$")
                TextField("Name (optional)", text: $name)
                TextField("Description (optional)", text: $descriptionText)
                TextField("Type (optional — project, feedback, reference, user…)", text: $type)
                Section("Body") {
                    TextEditor(text: $bodyText)
                        .font(.body.monospaced())
                        .frame(minHeight: 140)
                }
            }
            .formStyle(.grouped)
            footer
        }
        .frame(width: 560, height: 480)
    }

    private func header(_ title: String, subtitle: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.headline).foregroundStyle(Nocturne.textBright)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.caption.monospaced()).foregroundStyle(Nocturne.textDim)
                }
            }
            Spacer(minLength: 0)
        }
        .padding()
        .background(Nocturne.canvas)
    }

    private var footer: some View {
        HStack {
            if !memory.canWrite {
                Label("API unreachable — writes disabled", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(Nocturne.warning)
            }
            Spacer(minLength: 0)
            Button("Cancel") { dismiss() }
            Button("Create") {
                Task {
                    let ok = await memory.createMemory(
                        CreateMemoryInput(
                            slug: slug.trimmingCharacters(in: .whitespacesAndNewlines),
                            name: name.isEmpty ? nil : name,
                            description: descriptionText.isEmpty ? nil : descriptionText,
                            type: type.isEmpty ? nil : type,
                            body: bodyText
                        )
                    )
                    if ok { dismiss() }
                }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(slug.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !memory.canWrite || memory.isSaving)
        }
        .padding()
        .background(Nocturne.canvas)
    }
}
