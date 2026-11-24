// swift-tools-version: 5.9
import PackageDescription
import Foundation

/// Times the CrateASL interpreter through its public API only, in a real
/// release build. Not a test target on purpose: `-enable-testing` blocks the
/// static exclusivity proofs and puts `swift_beginAccess` in the profile,
/// which the shipped appex does not have.
///
///   cd examples/CrateASLBench && xcrun swift run -c release
///
/// `CRATE_ASL_PATH` points it at another copy of the package, so a before and
/// an after can be timed side by side.
let aslPath = ProcessInfo.processInfo.environment["CRATE_ASL_PATH"] ?? "../CrateASL"

let package = Package(
    name: "CrateASLBench",
    platforms: [.macOS(.v12)],
    dependencies: [.package(name: "CrateASL", path: aslPath)],
    targets: [
        .executableTarget(
            name: "CrateASLBench",
            dependencies: [.product(name: "CrateASL", package: "CrateASL")]
        )
    ]
)
