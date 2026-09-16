import Foundation
import XCTest

@testable import ClaudeMemoryKit

/// Decodes the shared Rust golden vectors (`crates/claude-memory/tests/golden/
/// expected.json`) with the Swift models to prove field-name parity.
///
/// Normalizations, per the task notes baked into the golden generator:
/// - `mtimeMs` is absent from golden entries (filesystem-dependent) — asserted
///   nil after decode; REST-shape `mtimeMs` decoding is covered by the API tests.
/// - `memoryDir` is relativized in goldens — asserted against the literal
///   relativized value.
final class GoldenParityTests: XCTestCase {
    private struct GoldenFile: Decodable {
        var listProjectsResult: [ProjectSummary]
        var listMemoriesResult: ListMemoriesResult
        var readMemoryAlphaResult: MemoryDetail
        var readMemoryUnindexedResult: MemoryDetail
        var searchMemoriesResult: [SearchHit]
        var searchMemoriesProjectScopedResult: [SearchHit]
    }

    private lazy var golden: GoldenFile = {
        do {
            return try JSONDecoder().decode(GoldenFile.self, from: Data(contentsOf: Self.goldenURL()))
        } catch {
            fatalError("could not load golden fixtures: \(error)")
        }
    }()

    func testListProjects() {
        XCTAssertEqual(
            golden.listProjectsResult,
            [
                ProjectSummary(
                    slug: "-Users-test-Demo",
                    memoryDir: "tests/golden/projects/-Users-test-Demo/memory",
                    indexPresent: true,
                    memoryCount: 4
                ),
            ]
        )
    }

    func testListMemoriesEntries() {
        XCTAssertEqual(golden.listMemoriesResult.entries.map(\.slug), ["alpha-memory", "beta-feedback", "gamma-reference", "unindexed-note"])
        for entry in golden.listMemoriesResult.entries {
            XCTAssertNil(entry.mtimeMs, "golden strips mtimeMs; a value here means the fixture format changed")
        }
        XCTAssertEqual(
            golden.listMemoriesResult.entries,
            [
                MemorySummary(
                    slug: "alpha-memory",
                    fileName: "alpha-memory.md",
                    title: "alpha-memory",
                    description: "First test memory for golden fixtures",
                    type: "project",
                    modified: "2026-09-01T00:00:00.000Z",
                    sizeBytes: 321,
                    indexed: true,
                    indexHook: "first test memory for golden fixtures"
                ),
                MemorySummary(
                    slug: "beta-feedback",
                    fileName: "beta-feedback.md",
                    title: "beta-feedback",
                    description: "Feedback-style memory with Why and How to apply",
                    type: "feedback",
                    modified: "2026-09-10T12:00:00.000Z",
                    sizeBytes: 254,
                    indexed: true,
                    indexHook: "user said keep the index tidy"
                ),
                MemorySummary(
                    slug: "gamma-reference",
                    fileName: "gamma-reference.md",
                    title: "gamma-reference",
                    description: "Pointer to external docs",
                    type: "reference",
                    sizeBytes: 186,
                    indexed: true,
                    indexHook: "external pointers live here"
                ),
                MemorySummary(
                    slug: "unindexed-note",
                    fileName: "unindexed-note.md",
                    title: "unindexed-note",
                    description: "Present on disk, absent from MEMORY.md",
                    type: "user",
                    sizeBytes: 131,
                    indexed: false
                ),
            ]
        )
        XCTAssertEqual(
            golden.listMemoriesResult.indexRaw,
            "# Memory Index\nOne line per topic; detail lives in the files, not here.\n\n"
                + "## Active / recent\n- [Alpha memory](alpha-memory.md) — first test memory for golden fixtures\n"
                + "- [Beta feedback](beta-feedback.md) — user said keep the index tidy\n\n"
                + "## Reference\n- [Gamma reference](gamma-reference.md) — external pointers live here\n"
        )
    }

    func testReadMemoryAlpha() {
        XCTAssertEqual(
            golden.readMemoryAlphaResult,
            MemoryDetail(
                slug: "alpha-memory",
                fileName: "alpha-memory.md",
                title: "alpha-memory",
                description: "First test memory for golden fixtures",
                type: "project",
                modified: "2026-09-01T00:00:00.000Z",
                sizeBytes: 321,
                indexed: true,
                indexHook: "first test memory for golden fixtures",
                body: "Body of alpha with a [[beta-feedback]] link and searchable needle XYZZY-ALPHA.\nSecond line mentions gamma-reference too.\n",
                frontmatterRaw: """
                name: alpha-memory
                description: "First test memory for golden fixtures"
                metadata:
                  type: project
                  originSessionId: 00000000-0000-0000-0000-000000000001
                  modified: 2026-09-01T00:00:00.000Z
                """,
                raw: """
                ---
                name: alpha-memory
                description: "First test memory for golden fixtures"
                metadata:
                  type: project
                  originSessionId: 00000000-0000-0000-0000-000000000001
                  modified: 2026-09-01T00:00:00.000Z
                ---

                Body of alpha with a [[beta-feedback]] link and searchable needle XYZZY-ALPHA.
                Second line mentions gamma-reference too.
                """ + "\n"
            )
        )
    }

    func testReadMemoryUnindexed() {
        XCTAssertEqual(
            golden.readMemoryUnindexedResult,
            MemoryDetail(
                slug: "unindexed-note",
                fileName: "unindexed-note.md",
                title: "unindexed-note",
                description: "Present on disk, absent from MEMORY.md",
                type: "user",
                sizeBytes: 131,
                indexed: false,
                body: "Needle XYZZY-UNINDEXED.\n",
                frontmatterRaw: """
                name: unindexed-note
                description: "Present on disk, absent from MEMORY.md"
                metadata:
                  type: user
                """,
                raw: """
                ---
                name: unindexed-note
                description: "Present on disk, absent from MEMORY.md"
                metadata:
                  type: user
                ---

                Needle XYZZY-UNINDEXED.
                """ + "\n"
            )
        )
    }

    func testSearchHits() {
        XCTAssertEqual(
            golden.searchMemoriesResult,
            [
                SearchHit(project: "-Users-test-Demo", slug: "alpha-memory", field: "body", line: 1, snippet: "Body of alpha with a [[beta-feedback]] link and searchable needle XYZZY-ALPHA."),
                SearchHit(project: "-Users-test-Demo", slug: "beta-feedback", field: "body", line: 3, snippet: "**How to apply:** reconcile on every delete. Needle XYZZY-BETA."),
                SearchHit(project: "-Users-test-Demo", slug: "gamma-reference", field: "body", line: 1, snippet: "Links: https://example.com/docs. Needle XYZZY-GAMMA. Also references [[alpha-memory]]."),
                SearchHit(project: "-Users-test-Demo", slug: "unindexed-note", field: "body", line: 1, snippet: "Needle XYZZY-UNINDEXED."),
            ]
        )
        XCTAssertEqual(
            golden.searchMemoriesProjectScopedResult,
            [
                SearchHit(project: "-Users-test-Demo", slug: "beta-feedback", field: "body", line: 1, snippet: "**Why:** indexes drift silently."),
                SearchHit(project: "-Users-test-Demo", slug: "unindexed-note", field: "title", line: 1, snippet: "unindexed-note"),
                SearchHit(project: "-Users-test-Demo", slug: "unindexed-note", field: "body", line: 1, snippet: "Needle XYZZY-UNINDEXED."),
            ]
        )
    }

    /// Walks up from this test file until the monorepo checkout root holding
    /// `crates/claude-memory/tests/golden/` is found.
    private static func goldenURL() -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("crates/claude-memory/tests/golden/expected.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir.deleteLastPathComponent()
        }
        fatalError("golden fixtures not found relative to \(#filePath)")
    }
}
