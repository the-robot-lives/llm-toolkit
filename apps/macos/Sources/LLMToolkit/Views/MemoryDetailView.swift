import ClaudeMemoryKit
import LLMToolkitKit
import SwiftUI

/// Detail pane for one memory: metadata, body, raw edit, delete.
struct MemoryDetailView: View {
    @Bindable var memory: MemoryModel
    let detail: MemoryDetail

    @State private var isEditing = false
    @State private var draft = ""
    @State private var confirmDelete = false

    private var project: String { memory.detailProject ?? memory.selectedProject ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Nocturne.border)
            if isEditing {
                editor
            } else {
                reader
            }
        }
        .background(Nocturne.surface)
        .onAppear {
            if draft.isEmpty { draft = detail.raw }
        }
        .confirmationDialog(
            "Delete “\(detail.title)”?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete memory file and index entry", role: .destructive) {
                Task { await memory.deleteMemory(project: project, slug: detail.slug) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The file \(detail.fileName) is removed from disk and its MEMORY.md line is cleaned up. This cannot be undone.")
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(detail.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Nocturne.textBright)
                    if let type = detail.type {
                        Text(type)
                            .font(.caption)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Nocturne.surfaceRaised, in: Capsule())
                            .foregroundStyle(Nocturne.glow)
                    }
                    indexedBadge
                }
                HStack(spacing: 10) {
                    Text(detail.slug)
                        .font(.caption.monospaced())
                        .foregroundStyle(Nocturne.textDim)
                    if let modified = detail.modified {
                        Label(Self.shortDate(modified), systemImage: "clock")
                            .font(.caption)
                            .foregroundStyle(Nocturne.textDim)
                    }
                    Text("\(detail.sizeBytes) bytes")
                        .font(.caption)
                        .foregroundStyle(Nocturne.textDim)
                }
                if let description = detail.description {
                    Text(description)
                        .font(.callout)
                        .foregroundStyle(Nocturne.textMuted)
                }
            }
            Spacer(minLength: 0)
            if isEditing {
                Button("Cancel") {
                    draft = detail.raw
                    isEditing = false
                }
                Button("Save") {
                    Task {
                        if await memory.saveDetail(content: draft) {
                            isEditing = false
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(memory.isSaving)
            } else {
                Button {
                    draft = detail.raw
                    isEditing = true
                } label: {
                    Label("Edit", systemImage: "square.and.pencil")
                }
                .disabled(!memory.canWrite || memory.isSaving)
                .help(memory.canWrite ? "Edit raw file" : "Writes disabled while the API is unreachable")

                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .disabled(!memory.canWrite || memory.isSaving)
                .help(memory.canWrite ? "Delete memory" : "Writes disabled while the API is unreachable")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Nocturne.canvas)
    }

    private var indexedBadge: some View {
        HStack(spacing: 3) {
            Image(systemName: detail.indexed ? "checkmark.circle" : "slash.circle")
                .font(.caption2)
            Text(detail.indexed ? "Indexed" : "Unindexed")
                .font(.caption2)
        }
        .foregroundStyle(detail.indexed ? Nocturne.success : Nocturne.textDim)
        .help(detail.indexed ? (detail.indexHook ?? "Listed in MEMORY.md") : "Not listed in MEMORY.md")
    }

    // MARK: - Reader / editor

    private var reader: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if memory.isStale {
                    Label("Cached read — the toolkit API is unreachable; edits are disabled.", systemImage: "clock.arrow.circlepath")
                        .font(.caption)
                        .foregroundStyle(Nocturne.warning)
                }
                Section {
                    Text(detail.body.isEmpty ? "No body." : detail.body)
                        .font(.body.monospaced())
                        .foregroundStyle(Nocturne.textPrimary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } header: {
                    sectionTitle("Body")
                }
                Section {
                    Text(detail.frontmatterRaw ?? "(none)")
                        .font(.callout.monospaced())
                        .foregroundStyle(Nocturne.textMuted)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } header: {
                    sectionTitle("Frontmatter")
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var editor: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Editing the full raw file — frontmatter included. metadata.modified is bumped on save.")
                    .font(.caption)
                    .foregroundStyle(Nocturne.textDim)
                Spacer(minLength: 0)
            }
            TextEditor(text: $draft)
                .font(.body.monospaced())
                .scrollContentBackground(.hidden)
                .background(Nocturne.void)
                .padding(4)
        }
        .padding(12)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Nocturne.textDim)
    }

    private static func shortDate(_ iso: String) -> String {
        String(iso.prefix(10))
    }
}
