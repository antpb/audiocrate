import XCTest
@testable import CrateASL

/// The mapping between a drawn inlet slot and a cable in the document.
///
/// Worth its own tests because getting it wrong is silent. A slot resolving
/// to the wrong cable deletes a connection the user was not looking at, and
/// the patch keeps working well enough that it reads as the editor being
/// flaky rather than as a bug with a location.
final class PatchSlotsTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog {
        try MaterialCatalog.bundled()
    }

    private func threeIntoMaster(_ io: PatchIoKinds) -> CratePatch {
        CratePatch(
            nodes: [
                CratePatchNode(id: "a", kind: "gain"),
                CratePatchNode(id: "b", kind: "gain"),
                CratePatchNode(id: "c", kind: "gain"),
                CratePatchNode(id: "out", kind: io.master),
            ],
            connections: [
                CratePatchConnection(source: "a", sourceOutput: "audio", target: "out", targetInput: "input"),
                CratePatchConnection(source: "b", sourceOutput: "audio", target: "out", targetInput: "input"),
                CratePatchConnection(source: "c", sourceOutput: "audio", target: "out", targetInput: "input"),
            ]
        )
    }

    func testAnEmptyInletIsOneUnnumberedSlot() throws {
        let catalog = try catalog()
        let patch = CratePatch(nodes: [CratePatchNode(id: "g", kind: "gain")], connections: [])
        let slots = patch.slots(for: patch.node("g")!, catalog: catalog)
        // gain draws `input(audio)` and `gain(cv)`, one spare slot each.
        XCTAssertEqual(slots.count, 2)
        XCTAssertEqual(slots[0].label, "input(audio)", "a lone slot carries no number")
        XCTAssertTrue(slots[0].isSpare)
        XCTAssertEqual(slots[1].inlet, "gain")
    }

    func testAnInletGrowsASpareForEachCable() throws {
        let catalog = try catalog()
        let patch = threeIntoMaster(catalog.io)
        let slots = patch.slots(for: patch.node("out")!, catalog: catalog)
        XCTAssertEqual(slots.count, 4, "three cables and one spare")
        XCTAssertEqual(slots.map(\.label), ["input(audio) 1", "input(audio) 2", "input(audio) 3", "input(audio) 4"])
        XCTAssertEqual(slots.map(\.isSpare), [false, false, false, true])
        XCTAssertEqual(Set(slots.map(\.inlet)), ["input"], "every slot writes the same inlet")
    }

    func testASlotResolvesToItsOwnCable() throws {
        let catalog = try catalog()
        let patch = threeIntoMaster(catalog.io)
        let slots = patch.slots(for: patch.node("out")!, catalog: catalog)
        XCTAssertEqual(patch.connectionIndex(at: slots[0], on: "out"), 0)
        XCTAssertEqual(patch.connectionIndex(at: slots[1], on: "out"), 1)
        XCTAssertEqual(patch.connectionIndex(at: slots[2], on: "out"), 2)
        XCTAssertNil(patch.connectionIndex(at: slots[3], on: "out"), "the spare has no cable")
        // The middle one, specifically: an implementation that took the first
        // match would pass the other two and delete the wrong cable here.
        XCTAssertEqual(patch.connections[patch.connectionIndex(at: slots[1], on: "out")!].source, "b")
    }

    func testCablesAndSlotsAgreeInBothDirections() throws {
        let catalog = try catalog()
        let patch = threeIntoMaster(catalog.io)
        for connection in patch.connections {
            let index = try XCTUnwrap(patch.slotIndex(of: connection, catalog: catalog))
            let slots = patch.slots(for: patch.node(connection.target)!, catalog: catalog)
            let back = try XCTUnwrap(patch.connectionIndex(at: slots[index], on: connection.target))
            XCTAssertEqual(patch.connections[back], connection)
        }
    }

    func testSlotsCoverEveryJackTheCatalogDraws() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [CratePatchNode(id: "c", kind: "sidechaincomp")],
            connections: []
        )
        let slots = patch.slots(for: patch.node("c")!, catalog: catalog)
        let jacks = try XCTUnwrap(catalog.jacks("sidechaincomp"))
        XCTAssertEqual(slots.map(\.inlet), jacks.inputs, "every inlet is drawn, in the catalog's order")
        XCTAssertTrue(slots.contains { $0.inlet == "sidechain" }, "the aux input is reachable")
    }

    func testAToolWithNoInletsDrawsNone() throws {
        let catalog = try catalog()
        let patch = CratePatch(nodes: [CratePatchNode(id: "k", kind: catalog.io.keyboard)], connections: [])
        XCTAssertEqual(patch.slots(for: patch.node("k")!, catalog: catalog), [])
    }

    /// A patch built by growing slots has to be a patch the other editor
    /// reads. The document has no slots in it at all, which is the point.
    func testGrownSlotsLeaveNoTraceInTheDocument() throws {
        let catalog = try catalog()
        let patch = threeIntoMaster(catalog.io)
        let json = try String(data: patch.encoded(), encoding: .utf8) ?? ""
        XCTAssertFalse(json.contains("occurrence"))
        XCTAssertFalse(json.contains("slot"))
        XCTAssertFalse(json.contains("input 2"))
        XCTAssertEqual(json.components(separatedBy: "\"targetInput\":\"input\"").count - 1, 3)
    }
}
