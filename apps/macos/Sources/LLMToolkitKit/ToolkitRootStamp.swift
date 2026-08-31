import Foundation

/// Checkout path written into the .app at `make app` / `make install-osx` so
/// an install under `/Applications` still finds this machine's llm-toolkit tree.
public enum ToolkitRootStamp: Sendable {
    public static func parse(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return URL(fileURLWithPath: (trimmed as NSString).expandingTildeInPath)
    }

    public static func read(from file: URL) -> URL? {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        return parse(text)
    }

    public static func bundledRoot(bundle: Bundle = .main) -> URL? {
        if let url = bundle.url(forResource: "toolkit-root", withExtension: "txt") {
            return read(from: url)
        }
        let fallback = bundle.bundleURL.appendingPathComponent("Contents/Resources/toolkit-root.txt")
        if FileManager.default.fileExists(atPath: fallback.path) {
            return read(from: fallback)
        }
        return nil
    }
}
