import ClaudeMemoryKit
import Foundation
import Observation

/// Daemon phase driven by the app's existing health poll — the memory client
/// NEVER touches `~/.claude` directly; the API daemon owns the disk.
public enum MemoryDaemonPhase: Equatable, Sendable {
    case ready
    case apiStarting
    case unreachable
}

/// Observable state for the Claude Memory surface. Cached reads (projects,
/// list, detail, search hits) survive daemon loss so the UI can keep showing
/// the last-known data under a stale banner; writes are refused while the
/// daemon is not ready.
@MainActor
@Observable
public final class MemoryModel {
    // MARK: - Read state

    public private(set) var projects: [ProjectSummary] = []
    public var selectedProject: String?
    /// Last-known-good list result for the selected project (nil = never loaded).
    public private(set) var listResult: ListMemoriesResult?
    public private(set) var detail: MemoryDetail?
    /// Project slug the current detail belongs to.
    public private(set) var detailProject: String?
    public private(set) var searchHits: [SearchHit]?

    public var searchText = "" {
        didSet { scheduleSearch() }
    }

    // MARK: - Lifecycle state

    public private(set) var daemonPhase: MemoryDaemonPhase = .ready
    public private(set) var isLoadingProjects = false
    public private(set) var isLoadingList = false
    public private(set) var isLoadingDetail = false
    public var isSaving = false
    /// Inline message surfaced by the UI (success notes / blocked-write reason).
    public var banner: String?
    public var lastError: String?

    /// True when showing cached data fetched before the daemon went away.
    public var isStale: Bool { daemonPhase != .ready && hasCachedData }
    public var hasCachedData: Bool { !(listResult?.entries.isEmpty ?? true) || detail != nil || !projects.isEmpty }
    /// Writes are only allowed against a live daemon.
    public var canWrite: Bool { daemonPhase == .ready }

    /// Search debounce; shrink to zero in tests for synchronous scheduling.
    @ObservationIgnored public var searchDebounce: Duration = .milliseconds(250)

    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private let serviceFactory: () -> any ClaudeMemoryServing
    @ObservationIgnored private var hasLoadedOnce = false

    public init(serviceFactory: @escaping () -> any ClaudeMemoryServing) {
        self.serviceFactory = serviceFactory
    }

    public convenience init(baseURL: URL) {
        self.init { ClaudeMemoryAPI(baseURL: baseURL) }
    }

    // MARK: - Health wiring

    /// Feed from AppModel's health poll. Recovers automatically: a transition
    /// back to ready after unreachable triggers a fresh load (cached data stays
    /// visible until it lands).
    public func updateHealth(apiReady: Bool, apiStarting: Bool) {
        let previous = daemonPhase
        if apiReady {
            daemonPhase = .ready
        } else if apiStarting {
            daemonPhase = .apiStarting
        } else {
            daemonPhase = .unreachable
        }
        if daemonPhase == .ready && previous != .ready {
            Task { await self.bootstrapIfNeeded(force: true) }
        }
    }

    // MARK: - Loads

    /// Initial entry point for the view; reloads stale data on health return.
    public func bootstrapIfNeeded(force: Bool = false) async {
        guard force || !hasLoadedOnce else { return }
        hasLoadedOnce = true
        await reloadProjects()
        await reloadMemories()
    }

    public func reloadProjects() async {
        isLoadingProjects = true
        defer { isLoadingProjects = false }
        do {
            let fetched = try await serviceFactory().listProjects()
            projects = fetched
            if selectedProject == nil || !fetched.contains(where: { $0.slug == selectedProject }) {
                selectedProject = fetched.first?.slug
                await reloadMemories()
            }
            if daemonPhase != .ready { daemonPhase = .ready }
        } catch let error as ClaudeMemoryError {
            applyLoadError(error)
        } catch {
            applyLoadError(.transport(error.localizedDescription))
        }
    }

    public func select(project slug: String) async {
        guard slug != selectedProject else { return }
        selectedProject = slug
        detail = nil
        detailProject = nil
        searchHits = nil
        await reloadMemories()
    }

    public func reloadMemories() async {
        guard let project = selectedProject else {
            listResult = nil
            return
        }
        isLoadingList = true
        defer { isLoadingList = false }
        do {
            listResult = try await serviceFactory().listMemories(project: project)
        } catch let error as ClaudeMemoryError {
            applyLoadError(error)
        } catch {
            applyLoadError(.transport(error.localizedDescription))
        }
    }

    public func loadDetail(project: String, slug: String) async {
        isLoadingDetail = true
        defer { isLoadingDetail = false }
        do {
            let fetched = try await serviceFactory().readMemory(project: project, slug: slug)
            // Ignore stale loads that lost a race with selection changes.
            guard selectedProject == project || detailProject == project else { return }
            detail = fetched
            detailProject = project
        } catch let error as ClaudeMemoryError {
            applyLoadError(error)
        } catch {
            applyLoadError(.transport(error.localizedDescription))
        }
    }

    /// Cancels the pending debounce and runs the search immediately (tests).
    public func flushSearch() async {
        searchTask?.cancel()
        searchTask = nil
        await runSearch()
    }

    // MARK: - Writes (daemon-gated)

    @discardableResult
    public func createMemory(_ input: CreateMemoryInput) async -> Bool {
        guard demandWritable() else { return false }
        guard let project = selectedProject else {
            lastError = "No project selected."
            return false
        }
        return await performWrite("Created \(input.slug)") {
            try await self.serviceFactory().createMemory(project: project, input: input)
        } reload: {
            await self.reloadMemories()
        }
    }

    @discardableResult
    public func saveDetail(content: String) async -> Bool {
        guard demandWritable() else { return false }
        guard let project = detailProject, let slug = detail?.slug else {
            lastError = "No memory selected."
            return false
        }
        return await performWrite("Saved \(slug)") {
            try await self.serviceFactory().updateMemory(project: project, slug: slug, input: UpdateMemoryInput(content: content))
        } reload: {
            await self.loadDetail(project: project, slug: slug)
            await self.reloadMemories()
        }
    }

    @discardableResult
    public func deleteMemory(project: String, slug: String) async -> Bool {
        guard demandWritable() else { return false }
        return await performWrite("Deleted \(slug)") {
            try await self.serviceFactory().deleteMemory(project: project, slug: slug)
        } reload: {
            if self.detail?.slug == slug {
                self.detail = nil
                self.detailProject = nil
            }
            await self.reloadMemories()
            if self.selectedProject != project {
                await self.reloadProjects()
            }
        }
    }

    public func dismissBanner() {
        banner = nil
    }

    // MARK: - Privates

    private func demandWritable() -> Bool {
        guard canWrite else {
            lastError = "The toolkit API is unreachable — writes are disabled until it responds. Cached view is read-only."
            return false
        }
        return true
    }

    private func performWrite(
        _ successNote: String,
        _ write: () async throws -> Any,
        reload: () async -> Void
    ) async -> Bool {
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await write()
            banner = successNote
            lastError = nil
            await reload()
            return true
        } catch let error as ClaudeMemoryError {
            if case .transport = error {
                daemonPhase = .unreachable
                lastError = "The toolkit API is unreachable — writes are disabled until it responds. Cached view is read-only."
            } else {
                lastError = error.errorDescription
            }
            return false
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let text = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            searchTask = nil
            searchHits = nil
            return
        }
        searchTask = Task { [weak self, debounce = searchDebounce] in
            if debounce > .zero {
                try? await Task.sleep(for: debounce)
            }
            guard !Task.isCancelled else { return }
            await self?.runSearch()
        }
    }

    private func runSearch() async {
        let text = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            searchHits = nil
            return
        }
        do {
            searchHits = try await serviceFactory().searchMemories(query: text, project: selectedProject)
        } catch let error as ClaudeMemoryError {
            applyLoadError(error, quiet: true)
        } catch {
            applyLoadError(.transport(error.localizedDescription), quiet: true)
        }
    }

    /// Transport failures while data is cached degrade the view (stale banner)
    /// instead of clearing it; without cache they surface as lastError.
    private func applyLoadError(_ error: ClaudeMemoryError, quiet: Bool = false) {
        if case .transport = error {
            daemonPhase = .unreachable
            if !hasCachedData {
                lastError = error.errorDescription
            }
            return
        }
        if case .io = error {
            // Missing native addon and disk failures arrive as IO/500 — the
            // daemon answers, so treat it as reachable-but-failing.
            if !hasCachedData || !quiet {
                lastError = error.errorDescription
            }
            return
        }
        lastError = error.errorDescription
    }
}
