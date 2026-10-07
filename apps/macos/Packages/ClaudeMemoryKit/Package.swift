// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ClaudeMemoryKit",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "ClaudeMemoryKit", targets: ["ClaudeMemoryKit"]),
    ],
    targets: [
        .target(
            name: "ClaudeMemoryKit",
            path: "Sources/ClaudeMemoryKit"
        ),
        .testTarget(
            name: "ClaudeMemoryKitTests",
            dependencies: ["ClaudeMemoryKit"],
            path: "Tests/ClaudeMemoryKitTests"
        ),
    ]
)
