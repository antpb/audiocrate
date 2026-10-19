import XCTest
@testable import CrateASL

/// The preset library the iOS plugin ships, held to the native engine.
///
/// The file is generated from the web editor's patches, so this is the check
/// that what the browser offers also runs here: every patch decodes, lowers
/// to one graph, compiles, and is filed in the slot flatten reads it as.
/// `validate-factory.sh` in the plugin listens to them too; this is the part
/// that needs no plugin sources.
final class FactoryLibraryTests: XCTestCase {

    func testTheShippedLibraryDecodes() throws {
        let library = try FactoryLibrary.bundled()
        XCTAssertEqual(library.patches.count, 100)
        XCTAssertEqual(Set(library.patches.map(\.id)).count, library.patches.count, "duplicate ids")
        for entry in library.patches {
            XCTAssertTrue(library.categoryOrder.contains(entry.category), "\(entry.id): \(entry.category)")
            XCTAssertTrue(["instrument", "effect", "either"].contains(entry.slot), "\(entry.id): \(entry.slot)")
            XCTAssertFalse(entry.blurb.isEmpty, entry.id)
        }
    }

    func testEveryPatchRunsHereAndIsFiledInTheRightSlot() throws {
        let library = try FactoryLibrary.bundled()
        let catalog = try MaterialCatalog.bundled()
        var failures = [String]()
        for entry in library.patches {
            let role = CrateFlatten.detectRole(entry.patch, catalog: catalog)
            if entry.slot == "instrument" && role != .instrument { failures.append("\(entry.id): not an instrument") }
            if entry.slot != "instrument" && role == .instrument { failures.append("\(entry.id): reads as an instrument") }
            do {
                let compiled = try CrateFlatten.flatten(entry.patch, catalog: catalog, name: entry.name)
                _ = try CompiledVoice(document: compiled.graph)
            } catch {
                failures.append("\(entry.id): \(error)")
            }
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }
}
