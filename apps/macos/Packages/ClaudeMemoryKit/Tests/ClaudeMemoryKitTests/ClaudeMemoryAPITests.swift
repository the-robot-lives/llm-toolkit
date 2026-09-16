import Foundation
import XCTest

@testable import ClaudeMemoryKit

final class ClaudeMemoryAPITests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    // MARK: - Request shapes

    func testListProjectsSendsGETToProjectsPath() async throws {
        StubURLProtocol.handler = { _ in .json(#"[{"slug":"-Users-test-Demo","memoryDir":"/home/test/.claude/projects/-Users-test-Demo/memory","indexPresent":true,"memoryCount":4}]"#) }
        let projects = try await makeClient().listProjects()
        XCTAssertEqual(projects, [Fixtures.project])
        let request = StubURLProtocol.lastRecorded()
        XCTAssertEqual(request?.method, "GET")
        XCTAssertEqual(request?.url.path, "/api/memory/projects")
        XCTAssertTrue(request?.body.isEmpty ?? false)
    }

    func testListMemoriesEncodesProjectSegment() async throws {
        StubURLProtocol.handler = { _ in .json("{\"indexRaw\":\"# idx\",\"entries\":[]}") }
        let result = try await makeClient().listMemories(project: "-Users-test-Demo")
        XCTAssertEqual(result, ListMemoriesResult(indexRaw: "# idx", entries: []))
        XCTAssertEqual(StubURLProtocol.lastRecorded()?.url.path, "/api/memory/-Users-test-Demo/memories")
    }

    func testReadMemoryEncodesProjectAndSlug() async throws {
        StubURLProtocol.handler = { _ in .json(Self.detailJSON) }
        let detail = try await makeClient().readMemory(project: "-Users-test-Demo", slug: "alpha-memory")
        XCTAssertEqual(detail, Fixtures.detail)
        XCTAssertEqual(StubURLProtocol.lastRecorded()?.url.path, "/api/memory/-Users-test-Demo/memories/alpha-memory")
    }

    func testSearchSendsQueryAndProjectParams() async throws {
        StubURLProtocol.handler = { _ in .json("[]") }
        let hits = try await makeClient().searchMemories(query: "needle point", project: "-Users-test-Demo")
        XCTAssertEqual(hits, [])
        let request = StubURLProtocol.lastRecorded()
        XCTAssertEqual(request?.url.path, "/api/memory/search")
        let components = URLComponents(url: request!.url, resolvingAgainstBaseURL: false)!
        let queryItems = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(queryItems["query"], "needle point")
        XCTAssertEqual(queryItems["project"], "-Users-test-Demo")
    }

    func testSearchOmitsProjectParamWhenNil() async throws {
        StubURLProtocol.handler = { _ in .json("[]") }
        _ = try await makeClient().searchMemories(query: "xyzzy")
        let components = URLComponents(url: StubURLProtocol.lastRecorded()!.url, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(components.queryItems?.map(\.name), ["query"])
    }

    func testCreateMemoryPostsBodyOmittingNilFields() async throws {
        StubURLProtocol.handler = { _ in .json(#"{"slug":"new-note","indexUpdated":true}"#) }
        let result = try await makeClient().createMemory(
            project: "-Users-test-Demo",
            input: CreateMemoryInput(slug: "new-note", name: "New note", body: "Hello.")
        )
        XCTAssertEqual(result, WriteResult(slug: "new-note", indexUpdated: true))
        let request = StubURLProtocol.lastRecorded()
        XCTAssertEqual(request?.method, "POST")
        XCTAssertEqual(request?.url.path, "/api/memory/-Users-test-Demo/memories")
        XCTAssertEqual(request?.headers["Content-Type"], "application/json")
        let body = try Self.decodeBody(request?.body)
        // nil fields arrive as omitted keys, never null.
        XCTAssertEqual(
            body as? [String: String],
            ["slug": "new-note", "name": "New note", "body": "Hello."]
        )
    }

    func testUpdateMemoryPatchesBodyWithSyncIndex() async throws {
        StubURLProtocol.handler = { _ in .json(#"{"slug":"alpha-memory","indexUpdated":false}"#) }
        let result = try await makeClient().updateMemory(
            project: "-Users-test-Demo",
            slug: "alpha-memory",
            input: UpdateMemoryInput(name: "Renamed", syncIndex: false)
        )
        XCTAssertEqual(result, WriteResult(slug: "alpha-memory", indexUpdated: false))
        let request = StubURLProtocol.lastRecorded()
        XCTAssertEqual(request?.method, "PATCH")
        XCTAssertEqual(request?.url.path, "/api/memory/-Users-test-Demo/memories/alpha-memory")
        let body = try Self.decodeBody(request?.body)
        XCTAssertEqual(
            try XCTUnwrap(body["syncIndex"] as? Bool),
            false
        )
        XCTAssertEqual(body["name"] as? String, "Renamed")
        XCTAssertNil(body["content"])
        XCTAssertNil(body["description"])
    }

    func testDeleteMemorySendsDELETEReturnsResult() async throws {
        StubURLProtocol.handler = { _ in .json(#"{"slug":"alpha-memory","fileDeleted":true,"indexLinesRemoved":1}"#) }
        let result = try await makeClient().deleteMemory(project: "-Users-test-Demo", slug: "alpha-memory")
        XCTAssertEqual(result, DeleteResult(slug: "alpha-memory", fileDeleted: true, indexLinesRemoved: 1))
        let request = StubURLProtocol.lastRecorded()
        XCTAssertEqual(request?.method, "DELETE")
        XCTAssertEqual(request?.url.path, "/api/memory/-Users-test-Demo/memories/alpha-memory")
    }

    // MARK: - Error mapping

    func testNotFoundErrorMapping() async {
        await assertErrorMapping(status: 404, code: "NOT_FOUND", detail: "no such memory") { error in
            XCTAssertEqual(error, .notFound("no such memory"))
        }
    }

    func testNoProjectErrorMapping() async {
        await assertErrorMapping(status: 404, code: "NO_PROJECT", detail: "project dir missing") { error in
            XCTAssertEqual(error, .noProject("project dir missing"))
        }
    }

    func testExistsErrorMapping() async {
        await assertErrorMapping(status: 409, code: "EXISTS", detail: "already there") { error in
            XCTAssertEqual(error, .exists("already there"))
        }
    }

    func testInvalidSlugErrorMapping() async {
        await assertErrorMapping(status: 400, code: "INVALID_SLUG", detail: "bad slug") { error in
            XCTAssertEqual(error, .invalidSlug("bad slug"))
        }
    }

    func testIOErrorMapping() async {
        await assertErrorMapping(status: 500, code: "IO", detail: "disk sad") { error in
            XCTAssertEqual(error, .io("disk sad"))
        }
    }

    func testUnknownErrorCodeCollapsesToIO() async {
        await assertErrorMapping(status: 500, code: "SOMETHING_ELSE", detail: "mystery") { error in
            XCTAssertEqual(error, .io("mystery"))
        }
    }

    func testNonJSONErrorBodyMapsToIOWithStatus() async {
        StubURLProtocol.handler = { _ in StubResponse(status: 502, body: Data("<html>bad gateway</html>".utf8)) }
        do {
            _ = try await makeClient().listProjects()
            XCTFail("expected error")
        } catch {
            XCTAssertEqual(error as? ClaudeMemoryError, .io("HTTP 502"))
        }
    }

    func testConnectionFailureMapsToTransport() async {
        StubURLProtocol.handler = nil // every request fails at transport level
        do {
            _ = try await makeClient().listProjects()
            XCTFail("expected error")
        } catch {
            if case .transport = error as? ClaudeMemoryError {} else {
                XCTFail("expected transport, got \(error)")
            }
        }
    }

    func testDecodeFailureMapsToTransport() async {
        StubURLProtocol.handler = { _ in .json(#"{"totally":"different"}"#) }
        do {
            _ = try await makeClient().listProjects()
            XCTFail("expected error")
        } catch {
            if case .transport = error as? ClaudeMemoryError {} else {
                XCTFail("expected transport, got \(error)")
            }
        }
    }

    private func assertErrorMapping(
        status: Int,
        code: String,
        detail: String,
        assertions: (ClaudeMemoryError) -> Void
    ) async {
        StubURLProtocol.handler = { _ in .json(errorBodyJSON(code, detail), status: status) }
        do {
            _ = try await makeClient().listProjects()
            XCTFail("expected error for \(code)")
        } catch {
            guard let memoryError = error as? ClaudeMemoryError else {
                return XCTFail("expected ClaudeMemoryError, got \(error)")
            }
            assertions(memoryError)
        }
    }

    private static func decodeBody(_ data: Data?) throws -> [String: Any] {
        let data = try XCTUnwrap(data, "expected a request body")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static let detailJSON = """
    {"slug":"alpha-memory","fileName":"alpha-memory.md","title":"alpha-memory",\
    "description":"First test memory","type":"project","modified":"2026-09-01T00:00:00.000Z",\
    "mtimeMs":1727769600000,"sizeBytes":321,"indexed":true,"indexHook":"first test memory",\
    "body":"Body.\\n","frontmatterRaw":"name: alpha-memory",\
    "raw":"---\\nname: alpha-memory\\n---\\n\\nBody.\\n"}
    """
}
