import Foundation

public struct LaunchPlan: Equatable, Sendable {
    public var executable: URL
    public var arguments: [String]
    public var currentDirectory: URL
    public var environment: [String: String]

    public init(
        executable: URL,
        arguments: [String],
        currentDirectory: URL,
        environment: [String: String]
    ) {
        self.executable = executable
        self.arguments = arguments
        self.currentDirectory = currentDirectory
        self.environment = environment
    }
}

public enum ServerSupervisorError: LocalizedError, Equatable {
    case runtimeNotFound
    case alreadyRunning
    case launchFailed(String)

    public var errorDescription: String? {
        switch self {
        case .runtimeNotFound:
            return "Could not find the bundled llm-toolkit runtime. Reinstall LLM Toolkit or run it from the development checkout."
        case .alreadyRunning:
            return "Already running."
        case .launchFailed(let message):
            return message
        }
    }
}

public struct ServerSupervisor: Sendable {
    public var locator: ToolkitLocator
    public var bundledRuntimeURL: URL?
    public var shellURL: URL
    public var pathEnvironment: [String: String]

    public init(
        locator: ToolkitLocator = ToolkitLocator(),
        bundledRuntimeURL: URL? = ToolkitRuntime.bundledRuntimeURL(),
        shellURL: URL = URL(fileURLWithPath: "/bin/zsh"),
        pathEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.locator = locator
        self.bundledRuntimeURL = bundledRuntimeURL
        self.shellURL = shellURL
        self.pathEnvironment = pathEnvironment
    }

    public func resolveRoot(preferences: AppPreferences) -> URL? {
        locator.locate(explicitRoot: preferences.toolkitRootURL)
    }

    public func resolveRuntime(preferences: AppPreferences) -> URL? {
        if let bundledRuntimeURL, ToolkitRuntime.isRuntimeRoot(bundledRuntimeURL) {
            return bundledRuntimeURL.standardizedFileURL
        }
        return resolveRoot(preferences: preferences)
    }

    public func makeLaunchPlan(preferences: AppPreferences) throws -> LaunchPlan {
        if let runtime = bundledRuntimeURL, ToolkitRuntime.isRuntimeRoot(runtime) {
            return bundledLaunchPlan(runtime: runtime, preferences: preferences)
        }

        guard let root = resolveRoot(preferences: preferences) else {
            throw ServerSupervisorError.runtimeNotFound
        }
        return checkoutLaunchPlan(root: root, preferences: preferences)
    }

    private func bundledLaunchPlan(runtime: URL, preferences: AppPreferences) -> LaunchPlan {
        let quoted = shellQuote(runtime.path)
        let script = "cd \(quoted) && ./node_modules/.bin/tsx packages/api/src/index.ts"
        var environment = launchEnvironment(preferences: preferences)
        environment["LLM_TOOLKIT_BUNDLED_RUNTIME"] = "1"
        return LaunchPlan(
            executable: shellURL,
            arguments: ["-lc", script],
            currentDirectory: runtime,
            environment: environment
        )
    }

    private func checkoutLaunchPlan(root: URL, preferences: AppPreferences) -> LaunchPlan {
        let quoted = shellQuote(root.path)
        let script = "cd \(quoted) && if [ ! -f packages/web/dist/index.html ]; then pnpm --filter @llm-toolkit/web build; fi && pnpm dev:api"
        let environment = launchEnvironment(preferences: preferences)
        return LaunchPlan(
            executable: shellURL,
            arguments: ["-lc", script],
            currentDirectory: root,
            environment: environment
        )
    }

    private func launchEnvironment(preferences: AppPreferences) -> [String: String] {
        var environment = pathEnvironment
        if environment["PORT"] == nil {
            environment["PORT"] = "\(preferences.apiURL.port ?? 3100)"
        }
        return environment
    }

    public func start(preferences: AppPreferences) throws -> Process {
        let plan = try makeLaunchPlan(preferences: preferences)
        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        process.currentDirectoryURL = plan.currentDirectory
        process.environment = plan.environment
        process.standardOutput = logFileHandle()
        process.standardError = process.standardOutput
        do {
            try process.run()
        } catch {
            throw ServerSupervisorError.launchFailed(error.localizedDescription)
        }
        return process
    }

    public func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.interrupt()
        }
    }

    private func logFileHandle() -> FileHandle? {
        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/LLMToolkit", isDirectory: true)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let file = logs.appendingPathComponent("console.log")
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil)
        }
        return try? FileHandle(forWritingTo: file)
    }

    public func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

public enum ToolkitRuntime: Sendable {
    public static func bundledRuntimeURL(bundle: Bundle = .main) -> URL? {
        if let url = bundle.url(forResource: "Runtime", withExtension: nil) {
            return url
        }
        let fallback = bundle.bundleURL.appendingPathComponent("Contents/Resources/Runtime", isDirectory: true)
        if FileManager.default.fileExists(atPath: fallback.path) {
            return fallback
        }
        return nil
    }

    public static func isRuntimeRoot(_ url: URL, fileManager: FileManager = .default) -> Bool {
        let root = url.standardizedFileURL
        return fileManager.fileExists(atPath: root.appendingPathComponent("package.json").path)
            && fileManager.fileExists(atPath: root.appendingPathComponent("node_modules/.bin/tsx").path)
            && fileManager.fileExists(atPath: root.appendingPathComponent("packages/api/src/index.ts").path)
            && fileManager.fileExists(atPath: root.appendingPathComponent("packages/api/node_modules/@llm-toolkit/shared").path)
            && fileManager.fileExists(atPath: root.appendingPathComponent("packages/shared/src/index.ts").path)
            && fileManager.fileExists(atPath: root.appendingPathComponent("packages/web/dist/index.html").path)
    }
}
