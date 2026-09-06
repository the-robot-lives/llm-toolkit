import XCTest
@testable import LLMToolkitKit

final class AppPreferencesTests: XCTestCase {
    func testInMemoryRoundTrip() {
        let store = InMemoryPreferenceStore()
        var prefs = store.load()
        XCTAssertEqual(prefs.apiURL, AppPreferences.defaultAPIURL)
        XCTAssertEqual(prefs.apiURL.host, "localhost")
        XCTAssertTrue(prefs.autoStartServers)
        XCTAssertTrue(prefs.useNativeChrome)

        prefs.toolkitRootPath = "~/Work/llm-toolkit"
        prefs.autoStartServers = false
        store.save(prefs)
        XCTAssertEqual(store.load().toolkitRootPath, "~/Work/llm-toolkit")
        XCTAssertFalse(store.load().autoStartServers)
        XCTAssertEqual(store.load().toolkitRootURL?.path.hasSuffix("llm-toolkit"), true)
    }

    func testLaunchPlanQuotesRootAndUsesLoginShell() throws {
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-toolkit-supervisor-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("packages/web"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("packages/api"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("bin"), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: temp.appendingPathComponent("packages/web/package.json"))
        try Data("{}".utf8).write(to: temp.appendingPathComponent("packages/api/package.json"))
        try Data("#!/bin/bash\n".utf8).write(to: temp.appendingPathComponent("bin/llm-toolkit"))
        defer { try? FileManager.default.removeItem(at: temp) }

        let supervisor = ServerSupervisor(
            locator: ToolkitLocator(
                environment: [:],
                homeDirectory: temp,
                currentDirectory: temp,
                considerCompilationPath: false
            ),
            pathEnvironment: ["PATH": "/usr/bin"]
        )
        var prefs = AppPreferences()
        prefs.toolkitRootPath = temp.path
        let plan = try supervisor.makeLaunchPlan(preferences: prefs)
        XCTAssertEqual(plan.executable.path, "/bin/zsh")
        XCTAssertEqual(plan.arguments.first, "-lc")
        XCTAssertTrue(plan.arguments[1].contains("pnpm dev:api"))
        XCTAssertTrue(plan.arguments[1].contains(supervisor.shellQuote(temp.path)))
        XCTAssertEqual(plan.currentDirectory.path, temp.path)
    }

    func testBundledRuntimeLaunchPlanDoesNotRequireCheckout() throws {
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("llm-toolkit-runtime-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("node_modules/.bin"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("packages/api/src"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("packages/api/node_modules/@llm-toolkit/shared"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("packages/shared/src"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: temp.appendingPathComponent("packages/web/dist"), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: temp.appendingPathComponent("package.json"))
        try Data("#!/bin/sh\n".utf8).write(to: temp.appendingPathComponent("node_modules/.bin/tsx"))
        try Data("api".utf8).write(to: temp.appendingPathComponent("packages/api/src/index.ts"))
        try Data("shared".utf8).write(to: temp.appendingPathComponent("packages/shared/src/index.ts"))
        try Data("<html></html>".utf8).write(to: temp.appendingPathComponent("packages/web/dist/index.html"))
        defer { try? FileManager.default.removeItem(at: temp) }

        let supervisor = ServerSupervisor(
            locator: ToolkitLocator(
                environment: [:],
                homeDirectory: temp,
                currentDirectory: temp,
                considerCompilationPath: false
            ),
            bundledRuntimeURL: temp,
            pathEnvironment: ["PATH": "/usr/bin"]
        )

        let plan = try supervisor.makeLaunchPlan(preferences: AppPreferences())
        XCTAssertEqual(plan.currentDirectory.path, temp.path)
        XCTAssertEqual(plan.arguments.first, "-lc")
        XCTAssertTrue(plan.arguments[1].contains("./node_modules/.bin/tsx packages/api/src/index.ts"))
        XCTAssertFalse(plan.arguments[1].contains("pnpm dev:api"))
        XCTAssertEqual(plan.environment["LLM_TOOLKIT_BUNDLED_RUNTIME"], "1")
    }
}
