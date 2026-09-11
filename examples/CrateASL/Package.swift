// swift-tools-version: 5.9
import PackageDescription

/// The ASL interpreter, in Swift. Builds and tests from the command line
/// with no Xcode project. An AUv3 can link this without pulling in a host.
let package = Package(
    name: "CrateASL",
    platforms: [.iOS(.v15), .macOS(.v12), .visionOS(.v1)],
    products: [
        .library(name: "CrateASL", targets: ["CrateASL"])
    ],
    targets: [
        .target(name: "CrateASL"),
        .testTarget(name: "CrateASLTests", dependencies: ["CrateASL"])
    ]
)
