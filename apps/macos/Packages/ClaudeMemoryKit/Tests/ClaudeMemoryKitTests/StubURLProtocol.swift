import Foundation
import XCTest

@testable import ClaudeMemoryKit

/// In-memory URLProtocol stub: records every request and serves canned
/// responses (or transport-level failures).
final class StubURLProtocol: URLProtocol {
    struct Recorded {
        var method: String
        var url: URL
        var headers: [String: String]
        var body: Data
    }

    static let lock = NSLock()
    static var recorded: [Recorded] = []
    /// Set per test before creating the session. Return nil to simulate a
    /// transport failure via `didFailWithError`.
    static var handler: ((URLRequest) -> StubResponse?)?

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        recorded = []
        handler = nil
    }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    static func lastRecorded() -> Recorded? {
        lock.lock()
        defer { lock.unlock() }
        return recorded.last
    }

    // MARK: - URLProtocol

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = Self.readBody(request)
        Self.lock.lock()
        Self.recorded.append(
            Recorded(
                method: request.httpMethod ?? "GET",
                url: request.url ?? URL(fileURLWithPath: "/"),
                headers: request.allHTTPHeaderFields ?? [:],
                body: body
            )
        )
        let handler = Self.handler
        Self.lock.unlock()

        if let response = handler?(request) {
            let http = HTTPURLResponse(
                url: request.url!,
                statusCode: response.status,
                httpVersion: "HTTP/1.1",
                headerFields: response.headers
            )!
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: response.body)
            client?.urlProtocolDidFinishLoading(self)
        } else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
        }
    }

    override func stopLoading() {}

    /// URLRequest only exposes `httpBodyStream` once it goes through the
    /// loading pipeline — drain the stream when `httpBody` is gone.
    private static func readBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

struct StubResponse {
    var status: Int
    var body: Data
    var headers: [String: String] = ["Content-Type": "application/json"]

    static func json(_ value: String, status: Int = 200) -> StubResponse {
        StubResponse(status: status, body: Data(value.utf8))
    }
}

/// Shared fixture payloads shaped like real API answers.
enum Fixtures {
    static let project = ProjectSummary(
        slug: "-Users-test-Demo",
        memoryDir: "/home/test/.claude/projects/-Users-test-Demo/memory",
        indexPresent: true,
        memoryCount: 4
    )

    static let summary = MemorySummary(
        slug: "alpha-memory",
        fileName: "alpha-memory.md",
        title: "alpha-memory",
        description: "First test memory",
        type: "project",
        modified: "2026-09-01T00:00:00.000Z",
        mtimeMs: 1_727_769_600_000,
        sizeBytes: 321,
        indexed: true,
        indexHook: "first test memory"
    )

    static let detail = MemoryDetail(
        slug: "alpha-memory",
        fileName: "alpha-memory.md",
        title: "alpha-memory",
        description: "First test memory",
        type: "project",
        modified: "2026-09-01T00:00:00.000Z",
        mtimeMs: 1_727_769_600_000,
        sizeBytes: 321,
        indexed: true,
        indexHook: "first test memory",
        body: "Body.\n",
        frontmatterRaw: "name: alpha-memory",
        raw: "---\nname: alpha-memory\n---\n\nBody.\n"
    )
}

func makeClient() -> ClaudeMemoryAPI {
    ClaudeMemoryAPI(baseURL: URL(string: "http://127.0.0.1:3100")!, session: StubURLProtocol.makeSession())
}

func errorBodyJSON(_ code: String, _ detail: String) -> String {
    #"{"error":"\#(code)","detail":"\#(detail)"}"#
}
