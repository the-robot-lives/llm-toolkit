import Foundation

/// The client surface, named 1:1 with the Rust core ops (`crates/claude-memory`
/// `ops.rs`) minus the `root` argument — the API daemon owns the disk.
/// Conform to this to stub the memory service (e.g. in model tests).
public protocol ClaudeMemoryServing: Sendable {
    func listProjects() async throws -> [ProjectSummary]
    func listMemories(project: String) async throws -> ListMemoriesResult
    func readMemory(project: String, slug: String) async throws -> MemoryDetail
    func searchMemories(query: String, project: String?) async throws -> [SearchHit]
    func createMemory(project: String, input: CreateMemoryInput) async throws -> WriteResult
    func updateMemory(project: String, slug: String, input: UpdateMemoryInput) async throws -> WriteResult
    func deleteMemory(project: String, slug: String) async throws -> DeleteResult
}

/// REST client for `/api/memory` (spec: `packages/api/src/routes/memory.ts`).
public struct ClaudeMemoryAPI: ClaudeMemoryServing, Sendable {
    public var baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func listProjects() async throws -> [ProjectSummary] {
        try await get("api/memory/projects")
    }

    public func listMemories(project: String) async throws -> ListMemoriesResult {
        try await get("api/memory/\(Self.encodePathSegment(project))/memories")
    }

    public func readMemory(project: String, slug: String) async throws -> MemoryDetail {
        try await get("api/memory/\(Self.encodePathSegment(project))/memories/\(Self.encodePathSegment(slug))")
    }

    public func searchMemories(query: String, project: String? = nil) async throws -> [SearchHit] {
        var components = URLComponents(url: endpoint("api/memory/search"), resolvingAgainstBaseURL: false)
        var items = [URLQueryItem(name: "query", value: query)]
        if let project {
            items.append(URLQueryItem(name: "project", value: project))
        }
        components?.queryItems = items
        guard let url = components?.url else {
            throw ClaudeMemoryError.transport("could not build search URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        return try await send(request)
    }

    public func createMemory(project: String, input: CreateMemoryInput) async throws -> WriteResult {
        var request = URLRequest(url: endpoint("api/memory/\(Self.encodePathSegment(project))/memories"))
        request.httpMethod = "POST"
        return try await send(request, jsonBody: input)
    }

    public func updateMemory(project: String, slug: String, input: UpdateMemoryInput) async throws -> WriteResult {
        var request = URLRequest(url: endpoint("api/memory/\(Self.encodePathSegment(project))/memories/\(Self.encodePathSegment(slug))"))
        request.httpMethod = "PATCH"
        return try await send(request, jsonBody: input)
    }

    public func deleteMemory(project: String, slug: String) async throws -> DeleteResult {
        var request = URLRequest(url: endpoint("api/memory/\(Self.encodePathSegment(project))/memories/\(Self.encodePathSegment(slug))"))
        request.httpMethod = "DELETE"
        return try await send(request)
    }

    // MARK: - Plumbing

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = "GET"
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest, jsonBody: (any Encodable)? = nil) async throws -> T {
        var request = request
        if let jsonBody {
            do {
                request.httpBody = try JSONEncoder().encode(jsonBody)
            } catch {
                throw ClaudeMemoryError.transport("request encoding failed: \(error.localizedDescription)")
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ClaudeMemoryError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw ClaudeMemoryError.transport("non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.serverError(status: http.statusCode, data: data)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ClaudeMemoryError.transport("response decode failed: \(error.localizedDescription)")
        }
    }

    private static func serverError(status: Int, data: Data) -> ClaudeMemoryError {
        if let body = try? JSONDecoder().decode(ErrorBody.self, from: data), let code = body.error {
            return .from(code: code, detail: body.detail ?? "")
        }
        return .io("HTTP \(status)")
    }

    private func endpoint(_ path: String) -> URL {
        var base = baseURL.absoluteString
        if base.hasSuffix("/") {
            base.removeLast()
        }
        let suffix = path.hasPrefix("/") ? path : "/" + path
        return URL(string: base + suffix) ?? baseURL.appendingPathComponent(path)
    }

    private static func encodePathSegment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

private struct ErrorBody: Decodable {
    var error: String?
    var detail: String?
}
