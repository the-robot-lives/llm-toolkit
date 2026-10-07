import Foundation

/// Typed errors per the contract: the core raises `MEMORY_<CODE>: <detail>`;
/// REST maps codes to status (`NOT_FOUND`/`NO_PROJECT` → 404, `EXISTS` → 409,
/// `INVALID_SLUG` → 400, `IO` → 500) with an `{error, detail}` body. Transport
/// covers anything that never produced a parseable server answer
/// (connection failures, non-HTTP responses, decode failures).
public enum ClaudeMemoryError: Error, Equatable, Sendable, LocalizedError {
    case notFound(String)
    case exists(String)
    case invalidSlug(String)
    case noProject(String)
    case io(String)
    case transport(String)

    /// Wire code as sent in `{error: "<CODE>"}` bodies (`TRANSPORT` never
    /// arrives over the wire — it is client-side only).
    public var code: String {
        switch self {
        case .notFound: return "NOT_FOUND"
        case .exists: return "EXISTS"
        case .invalidSlug: return "INVALID_SLUG"
        case .noProject: return "NO_PROJECT"
        case .io: return "IO"
        case .transport: return "TRANSPORT"
        }
    }

    public var detail: String {
        switch self {
        case .notFound(let detail),
             .exists(let detail),
             .invalidSlug(let detail),
             .noProject(let detail),
             .io(let detail),
             .transport(let detail):
            return detail
        }
    }

    public var errorDescription: String? {
        "\(code): \(detail)"
    }

    /// Maps an `{error, detail}` body; unknown codes collapse into `.io`,
    /// matching the REST layer's default-500 behavior.
    public static func from(code: String, detail: String) -> ClaudeMemoryError {
        switch code {
        case "NOT_FOUND": return .notFound(detail)
        case "EXISTS": return .exists(detail)
        case "INVALID_SLUG": return .invalidSlug(detail)
        case "NO_PROJECT": return .noProject(detail)
        default: return .io(detail)
        }
    }
}
