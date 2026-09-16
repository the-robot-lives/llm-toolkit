import ClaudeMemoryKit
import LLMToolkitKit
import XCTest

@testable import LLMToolkitKit

/// In-memory `ClaudeMemoryServing` stub with call recording.
final class StubMemoryService: ClaudeMemoryServing, @unchecked Sendable {
    struct Call: Equatable {
        var op: String
        var project: String?
        var slug: String?
        var query: String?
    }

    private let lock = NSLock()
    private var _projects: [ProjectSummary] = []
    private var _list: ListMemoriesResult
    private var _details: [String: MemoryDetail] = [:]
    private var _hits: [SearchHit] = []
    private var _error: ClaudeMemoryError?
    private var _calls: [Call] = []
    private var _writes: [String] = []

    func configure(projects: [ProjectSummary]) {
        lock.lock(); defer { lock.unlock() }
        _projects = projects
    }

    func configure(error: ClaudeMemoryError?) {
        lock.lock(); defer { lock.unlock() }
        _error = error
    }

    func configure(detail: MemoryDetail, project: String) {
        lock.lock(); defer { lock.unlock() }
        _details["\(project)/\(detail.slug)"] = detail
    }

    func configure(hits: [SearchHit]) {
        lock.lock(); defer { lock.unlock() }
        _hits = hits
    }

    var calls: [Call] {
        lock.lock(); defer { lock.unlock() }
        return _calls
    }

    var writes: [String] {
        lock.lock(); defer { lock.unlock() }
        return _writes
    }

    private func record(_ call: Call) throws {
        lock.lock(); defer { lock.unlock() }
        _calls.append(call)
        if let error = _error { throw error }
    }

    func listProjects() async throws -> [ProjectSummary] {
        try record(Call(op: "listProjects", project: nil, slug: nil, query: nil))
        lock.lock(); defer { lock.unlock() }
        return _projects
    }

    func listMemories(project: String) async throws -> ListMemoriesResult {
        try record(Call(op: "listMemories", project: project, slug: nil, query: nil))
        lock.lock(); defer { lock.unlock() }
        return _list
    }

    func readMemory(project: String, slug: String) async throws -> MemoryDetail {
        try record(Call(op: "readMemory", project: project, slug: slug, query: nil))
        lock.lock(); defer { lock.unlock() }
        return _details["\(project)/\(slug)"]!
    }

    func searchMemories(query: String, project: String?) async throws -> [SearchHit] {
        try record(Call(op: "searchMemories", project: project, slug: nil, query: query))
        lock.lock(); defer { lock.unlock() }
        return _hits
    }

    func createMemory(project: String, input: CreateMemoryInput) async throws -> WriteResult {
        try record(Call(op: "createMemory", project: project, slug: input.slug, query: nil))
        lock.lock(); defer { lock.unlock() }
        _writes.append("create:\(input.slug)")
        return WriteResult(slug: input.slug, indexUpdated: true)
    }

    func updateMemory(project: String, slug: String, input: UpdateMemoryInput) async throws -> WriteResult {
        try record(Call(op: "updateMemory", project: project, slug: slug, query: nil))
        lock.lock(); defer { lock.unlock() }
        _writes.append("update:\(slug)")
        return WriteResult(slug: slug, indexUpdated: true)
    }

    func deleteMemory(project: String, slug: String) async throws -> DeleteResult {
        try record(Call(op: "deleteMemory", project: project, slug: slug, query: nil))
        lock.lock(); defer { lock.unlock() }
        _writes.append("delete:\(slug)")
        return DeleteResult(slug: slug, fileDeleted: true, indexLinesRemoved: 1)
    }

    init(list: ListMemoriesResult = ListMemoriesResult(indexRaw: "# Memory Index\n", entries: [])) {
        self._list = list
    }
}

@MainActor
final class MemoryModelTests: XCTestCase {
    private var service: StubMemoryService!

    override func setUp() async throws {
        try await super.setUp()
        service = StubMemoryService(
            list: ListMemoriesResult(
                indexRaw: "# Memory Index\n",
                entries: [
                    MemorySummary(slug: "alpha", fileName: "alpha.md", title: "alpha", description: "first", type: "project", modified: "2026-09-01T00:00:00.000Z", sizeBytes: 100, indexed: true, indexHook: "first"),
                    MemorySummary(slug: "beta", fileName: "beta.md", title: "beta", sizeBytes: 80, indexed: false),
                ]
            )
        )
    }

    private func makeModel() -> MemoryModel {
        MemoryModel(serviceFactory: { [service] in service })
    }

    // MARK: - Loads

    func testBootstrapLoadsProjectsAndMemoriesAndSelectsFirstProject() async {
        service.configure(projects: [
            ProjectSummary(slug: "-Users-demo", memoryDir: "/tmp/-Users-demo/memory", indexPresent: true, memoryCount: 2),
        ])
        let model = makeModel()
        await model.bootstrapIfNeeded()
        XCTAssertEqual(model.projects.map(\.slug), ["-Users-demo"])
        XCTAssertEqual(model.selectedProject, "-Users-demo")
        XCTAssertEqual(model.listResult?.entries.map(\.slug), ["alpha", "beta"])
        XCTAssertEqual(model.daemonPhase, .ready)
    }

    func testSelectingProjectReloadsListAndClearsDetail() async {
        service.configure(projects: [
            ProjectSummary(slug: "-Users-a", memoryDir: "/a/memory", indexPresent: true, memoryCount: 2),
            ProjectSummary(slug: "-Users-b", memoryDir: "/b/memory", indexPresent: true, memoryCount: 0),
        ])
        service.configure(detail: Self.detail(slug: "alpha"), project: "-Users-a")
        let model = makeModel()
        await model.bootstrapIfNeeded()
        await model.loadDetail(project: "-Users-a", slug: "alpha")
        XCTAssertNotNil(model.detail)

        await model.select(project: "-Users-b")
        XCTAssertEqual(model.selectedProject, "-Users-b")
        XCTAssertNil(model.detail)
        XCTAssertTrue(service.calls.contains(StubMemoryService.Call(op: "listMemories", project: "-Users-b", slug: nil, query: nil)))
    }

    // MARK: - Search

    func testSearchDebouncePopulatesHitsAndClearResets() async {
        let model = makeModel()
        model.searchDebounce = .zero
        service.configure(projects: [
            ProjectSummary(slug: "-Users-demo", memoryDir: "/tmp/-Users-demo/memory", indexPresent: true, memoryCount: 2),
        ])
        let hits = [
            SearchHit(project: "-Users-demo", slug: "alpha", field: "body", line: 2, snippet: "a needle here"),
        ]
        service.configure(hits: hits)
        await model.bootstrapIfNeeded()

        model.searchText = "needle"
        await model.flushSearch()
        XCTAssertEqual(model.searchHits, hits)
        XCTAssertTrue(service.calls.contains(StubMemoryService.Call(op: "searchMemories", project: "-Users-demo", slug: nil, query: "needle")))

        model.searchText = ""
        XCTAssertNil(model.searchHits)
    }

    // MARK: - Writes

    func testCreateGatedOnDaemonReadyAndRefreshes() async {
        service.configure(projects: [
            ProjectSummary(slug: "-Users-demo", memoryDir: "/tmp/-Users-demo/memory", indexPresent: true, memoryCount: 2),
        ])
        let model = makeModel()
        await model.bootstrapIfNeeded()

        let ok = await model.createMemory(CreateMemoryInput(slug: "gamma", body: "hi"))
        XCTAssertTrue(ok)
        XCTAssertEqual(service.writes, ["create:gamma"])
        // List reloaded after write: twice during bootstrap (selection set + explicit) plus once post-create.
        XCTAssertEqual(service.calls.filter { $0.op == "listMemories" }.count, 3)
    }

    func testSaveDetailSendsContentPatch() async {
        service.configure(projects: [
            ProjectSummary(slug: "-Users-demo", memoryDir: "/tmp/-Users-demo/memory", indexPresent: true, memoryCount: 2),
        ])
        service.configure(detail: Self.detail(slug: "alpha"), project: "-Users-demo")
        let model = makeModel()
        await model.bootstrapIfNeeded()
        await model.loadDetail(project: "-Users-demo", slug: "alpha")

        let ok = await model.saveDetail(content: "---\nname: alpha\n---\n\nrewritten\n")
        XCTAssertTrue(ok)
        XCTAssertEqual(service.writes, ["update:alpha"])
    }

    func testDeleteClearsDetailAndReloads() async {
        service.configure(projects: [
            ProjectSummary(slug: "-Users-demo", memoryDir: "/tmp/-Users-demo/memory", indexPresent: true, memoryCount: 2),
        ])
        service.configure(detail: Self.detail(slug: "alpha"), project: "-Users-demo")
        let model = makeModel()
        await model.bootstrapIfNeeded()
        await model.loadDetail(project: "-Users-demo", slug: "alpha")

        let ok = await model.deleteMemory(project: "-Users-demo", slug: "alpha")
        XCTAssertTrue(ok)
        XCTAssertEqual(service.writes, ["delete:alpha"])
        XCTAssertNil(model.detail)
    }

    // MARK: - Daemon resilience

    func testTransportFailureKeepsCachedDataAndBlocksWrites() async {
        service.configure(projects: [
            ProjectSummary(slug: "-Users-demo", memoryDir: "/tmp/-Users-demo/memory", indexPresent: true, memoryCount: 2),
        ])
        let model = makeModel()
        await model.bootstrapIfNeeded()
        XCTAssertEqual(model.daemonPhase, .ready)

        service.configure(error: .transport("connection refused"))
        await model.reloadMemories()
        XCTAssertEqual(model.daemonPhase, .unreachable)
        XCTAssertTrue(model.isStale)
        XCTAssertEqual(model.listResult?.entries.map(\.slug), ["alpha", "beta"], "cached list must survive")
        XCTAssertFalse(model.canWrite)
        XCTAssertTrue(service.writes.isEmpty)

        let ok = await model.createMemory(CreateMemoryInput(slug: "nope", body: "x"))
        XCTAssertFalse(ok)
        XCTAssertTrue(service.writes.isEmpty, "blocked write must not reach the service")
        XCTAssertTrue(model.lastError?.contains("writes are disabled") ?? false)
    }

    func testIOErrorDoesNotFlipToUnreachable() async {
        service.configure(projects: [
            ProjectSummary(slug: "-Users-demo", memoryDir: "/tmp/-Users-demo/memory", indexPresent: true, memoryCount: 2),
        ])
        let model = makeModel()
        await model.bootstrapIfNeeded()

        // Missing native addon surfaces as IO/500 while the daemon still answers.
        service.configure(error: .io("claude-memory native addon is not built"))
        await model.reloadMemories()
        XCTAssertEqual(model.daemonPhase, .ready)
        XCTAssertNotNil(model.lastError)
        XCTAssertEqual(model.listResult?.entries.map(\.slug), ["alpha", "beta"])
    }

    func testHealthRecoveryTriggersReload() async {
        service.configure(projects: [
            ProjectSummary(slug: "-Users-demo", memoryDir: "/tmp/-Users-demo/memory", indexPresent: true, memoryCount: 2),
        ])
        let model = makeModel()
        await model.bootstrapIfNeeded()

        service.configure(error: .transport("down"))
        model.updateHealth(apiReady: false, apiStarting: false)
        XCTAssertEqual(model.daemonPhase, .unreachable)

        model.updateHealth(apiReady: false, apiStarting: true)
        XCTAssertEqual(model.daemonPhase, .apiStarting)

        service.configure(error: nil)
        model.updateHealth(apiReady: true, apiStarting: false)
        XCTAssertEqual(model.daemonPhase, .ready)
        // Auto-recovery reloaded the list (bootstrap force path).
        try? await Task.sleep(for: .milliseconds(50))
        let listCalls = service.calls.filter { $0.op == "listMemories" }
        XCTAssertGreaterThanOrEqual(listCalls.count, 2)
        XCTAssertNil(model.lastError)
    }

    // MARK: - Fixtures

    private static func detail(slug: String) -> MemoryDetail {
        MemoryDetail(
            slug: slug,
            fileName: "\(slug).md",
            title: slug,
            description: "detail",
            type: "project",
            modified: "2026-09-01T00:00:00.000Z",
            sizeBytes: 100,
            indexed: true,
            indexHook: "hook",
            body: "Body text.\n",
            frontmatterRaw: "name: \(slug)",
            raw: "---\nname: \(slug)\n---\n\nBody text.\n"
        )
    }
}
