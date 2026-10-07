import Foundation

/// JSON shapes shared verbatim across the Rust core, the napi addon, the REST
/// surface and this client. Field names are contractual — see
/// `docs/claude-memory-contract.md` and the goldens in
/// `crates/claude-memory/tests/golden/expected.json`. Never rename a property
/// here without landing the same change in Rust first.

public struct ProjectSummary: Codable, Equatable, Sendable, Identifiable {
    public var slug: String
    public var memoryDir: String
    public var indexPresent: Bool
    public var memoryCount: Int

    public var id: String { slug }

    public init(slug: String, memoryDir: String, indexPresent: Bool, memoryCount: Int) {
        self.slug = slug
        self.memoryDir = memoryDir
        self.indexPresent = indexPresent
        self.memoryCount = memoryCount
    }
}

public struct MemorySummary: Codable, Equatable, Sendable, Identifiable {
    public var slug: String
    public var fileName: String
    public var title: String
    public var description: String?
    public var type: String?
    public var modified: String?
    /// Always present over the REST surface; optional so the golden vectors
    /// (which strip filesystem mtimes) decode without ceremony.
    public var mtimeMs: Double?
    public var sizeBytes: Int
    public var indexed: Bool
    public var indexHook: String?

    public var id: String { slug }

    public init(
        slug: String,
        fileName: String,
        title: String,
        description: String? = nil,
        type: String? = nil,
        modified: String? = nil,
        mtimeMs: Double? = nil,
        sizeBytes: Int,
        indexed: Bool,
        indexHook: String? = nil
    ) {
        self.slug = slug
        self.fileName = fileName
        self.title = title
        self.description = description
        self.type = type
        self.modified = modified
        self.mtimeMs = mtimeMs
        self.sizeBytes = sizeBytes
        self.indexed = indexed
        self.indexHook = indexHook
    }
}

/// Flat mirror of the REST payload: the `MemorySummary` fields plus
/// `body` / `frontmatterRaw` / `raw`.
public struct MemoryDetail: Codable, Equatable, Sendable {
    public var slug: String
    public var fileName: String
    public var title: String
    public var description: String?
    public var type: String?
    public var modified: String?
    public var mtimeMs: Double?
    public var sizeBytes: Int
    public var indexed: Bool
    public var indexHook: String?
    public var body: String
    public var frontmatterRaw: String?
    public var raw: String

    public init(
        slug: String,
        fileName: String,
        title: String,
        description: String? = nil,
        type: String? = nil,
        modified: String? = nil,
        mtimeMs: Double? = nil,
        sizeBytes: Int,
        indexed: Bool,
        indexHook: String? = nil,
        body: String,
        frontmatterRaw: String? = nil,
        raw: String
    ) {
        self.slug = slug
        self.fileName = fileName
        self.title = title
        self.description = description
        self.type = type
        self.modified = modified
        self.mtimeMs = mtimeMs
        self.sizeBytes = sizeBytes
        self.indexed = indexed
        self.indexHook = indexHook
        self.body = body
        self.frontmatterRaw = frontmatterRaw
        self.raw = raw
    }
}

public struct ListMemoriesResult: Codable, Equatable, Sendable {
    public var indexRaw: String
    public var entries: [MemorySummary]

    public init(indexRaw: String, entries: [MemorySummary]) {
        self.indexRaw = indexRaw
        self.entries = entries
    }
}

public struct SearchHit: Codable, Equatable, Sendable, Identifiable {
    public var project: String
    public var slug: String
    /// `"title" | "description" | "body"` per the contract.
    public var field: String
    public var line: Int
    public var snippet: String

    public var id: String { "\(project)/\(slug)/\(field)/\(line)" }

    public init(project: String, slug: String, field: String, line: Int, snippet: String) {
        self.project = project
        self.slug = slug
        self.field = field
        self.line = line
        self.snippet = snippet
    }
}

public struct WriteResult: Codable, Equatable, Sendable {
    public var slug: String
    public var indexUpdated: Bool

    public init(slug: String, indexUpdated: Bool) {
        self.slug = slug
        self.indexUpdated = indexUpdated
    }
}

public struct DeleteResult: Codable, Equatable, Sendable {
    public var slug: String
    public var fileDeleted: Bool
    public var indexLinesRemoved: Int

    public init(slug: String, fileDeleted: Bool, indexLinesRemoved: Int) {
        self.slug = slug
        self.fileDeleted = fileDeleted
        self.indexLinesRemoved = indexLinesRemoved
    }
}

/// Request bodies. Synthesized `Encodable` omits `nil` optionals — exactly the
/// wire shape the napi layer expects (optional fields arrive as omitted keys,
/// never null).
public struct CreateMemoryInput: Codable, Equatable, Sendable {
    public var slug: String
    public var name: String?
    public var description: String?
    public var type: String?
    public var body: String

    public init(slug: String, name: String? = nil, description: String? = nil, type: String? = nil, body: String) {
        self.slug = slug
        self.name = name
        self.description = description
        self.type = type
        self.body = body
    }
}

public struct UpdateMemoryInput: Codable, Equatable, Sendable {
    /// Full raw replacement; when present all other fields are ignored upstream.
    public var content: String?
    public var name: String?
    public var description: String?
    public var type: String?
    public var body: String?
    public var syncIndex: Bool?

    public init(
        content: String? = nil,
        name: String? = nil,
        description: String? = nil,
        type: String? = nil,
        body: String? = nil,
        syncIndex: Bool? = nil
    ) {
        self.content = content
        self.name = name
        self.description = description
        self.type = type
        self.body = body
        self.syncIndex = syncIndex
    }
}
