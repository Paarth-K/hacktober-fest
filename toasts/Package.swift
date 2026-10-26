// swift-tools-version: 5.9
// Tiny helper that shows Sidekick progress as macOS toasts (top-right), using MacToastKit.
// Reads one JSON object per line on stdin: {"message": "...", "icon": "sf.symbol.name", "duration": 3}
import PackageDescription

let package = Package(
    name: "SidekickToasts",
    platforms: [.macOS(.v13)],
    dependencies: [
        // Pinned: MacToastKit has no release tags.
        .package(url: "https://github.com/daniyalmaster693/MacToastKit", revision: "108f8957c1e05326f191de6dc05851fe1bbc8948"),
    ],
    targets: [
        .executableTarget(
            name: "SidekickToasts",
            dependencies: [.product(name: "MacToastKit", package: "MacToastKit")],
            path: "Sources/SidekickToasts"
        ),
    ]
)
