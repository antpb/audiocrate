import XCTest
@testable import CrateASL

/// The rules around a change request: what the model's edits may do, and
/// what the rules do for it. Each test is a failure from a real run against
/// Acid Line, the patch "add a reverb and modulate the decay" broke.
final class PatchChangeGuardTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    private func acid() throws -> CratePatch {
        try XCTUnwrap(try FactoryLibrary.bundled().patches.first { $0.id == "acid-line" }).patch
    }

    private func added(_ kinds: [String], to patch: CratePatch, _ catalog: MaterialCatalog) -> (CratePatch, [String]) {
        let next = CratePatchEditor.apply(kinds.map { CrateGenEdit(op: .addModule, kind: $0) }, to: patch, catalog: catalog).patch
        return (next, next.nodes.map(\.id).filter { patch.node($0) == nil })
    }

    // MARK: The reported request

    /// The whole thing, by rule: a reverb in the path before the limiter, an
    /// LFO on the reverb's decay, and a patch that still plays.
    func testAddAReverbAndModulateTheDecay() throws {
        let catalog = try catalog()
        let request = "add a reverb and modulate the decay"
        let kinds = CratePatchEditor.withModulator(CratePatchEditor.requestedKinds(request, catalog: catalog), request: request)
        XCTAssertEqual(kinds, ["reverb", "lfo"])
        let (patch, ids) = added(kinds, to: try acid(), catalog)
        let done = CratePatchEditor.completeAdditions(patch, added: ids, request: request, catalog: catalog).patch
        XCTAssertTrue(done.connections.contains { $0.target == "reverb" && $0.targetInput == "input" })
        XCTAssertTrue(done.connections.contains { $0.source == "reverb" && $0.target == "lim" })
        XCTAssertTrue(CratePatchEditor.reachesOutput("reverb", in: done, catalog: catalog))
        let into = done.connections.first { $0.target == "reverb" && $0.targetInput == "decay" }
        XCTAssertNotNil(into, "something moves the reverb's decay")
        XCTAssertGreaterThan(CrateGenStart.loudness(done, catalog: catalog) ?? 0, 1e-3)
    }

    /// The two half-wirings the model produced: an LFO into the decay and
    /// nothing into the input, and an input from the voice with the output
    /// going nowhere. Both are a reverb nobody hears, and both are placed.
    func testAnAddedEffectOutOfThePathIsPlaced() throws {
        let catalog = try catalog()
        let (patch, ids) = added(["reverb", "lfo"], to: try acid(), catalog)
        var decayOnly = patch
        decayOnly.connections.append(CratePatchConnection(source: "lfo", sourceOutput: "cv", target: "reverb", targetInput: "decay"))
        var dangling = patch
        dangling.connections.append(CratePatchConnection(source: "v", sourceOutput: "audio", target: "reverb", targetInput: "input"))
        for broken in [decayOnly, dangling] {
            let done = CratePatchEditor.completeAdditions(broken, added: ids, request: "add a reverb", catalog: catalog).patch
            XCTAssertTrue(CratePatchEditor.reachesOutput("reverb", in: done, catalog: catalog))
            XCTAssertEqual(done.sources(into: "reverb", inlet: "input").count, 1)
            XCTAssertFalse(done.connections.contains { $0.source == "v" && $0.target == "reverb" }, "the stray feed went")
        }
    }

    // MARK: What the model may do

    func testNothingIsRemovedOrAddedUnlessAsked() throws {
        let catalog = try catalog()
        let patch = try acid()
        let edits = [
            CrateGenEdit(op: .removeNode, node: "lad"),
            CrateGenEdit(op: .addModule, kind: "impulse"),
            CrateGenEdit(op: .disconnect, node: "v", target: "lad"),
        ]
        XCTAssertTrue(CratePatchEditor.guardEdits(edits, request: "make it darker", patch: patch, catalog: catalog).edits.isEmpty)
        let removing = CratePatchEditor.guardEdits(edits, request: "remove the ladder", patch: patch, catalog: catalog).edits
        XCTAssertEqual(removing.map(\.op), [.removeNode, .disconnect])
    }

    /// A sound into a pitch jack is dropped; the trim stages a control signal
    /// travels through are not.
    func testSoundGoesOnlyIntoAudioInlets() throws {
        let catalog = try catalog()
        let (patch, _) = added(["reverb", "lfo", "gain", "offset"], to: try acid(), catalog)
        let edits = [
            CrateGenEdit(op: .connect, node: "reverb", jack: "audio", target: "v", targetJack: "note"),
            CrateGenEdit(op: .connect, node: "v", jack: "audio", target: "lad", targetJack: "cutoff"),
            CrateGenEdit(op: .connect, node: "offset", jack: "audio", target: "lad", targetJack: "cutoff"),
            CrateGenEdit(op: .connect, node: "lfo", jack: "cv", target: "lad", targetJack: "resonance"),
        ]
        let kept = CratePatchEditor.guardEdits(edits, request: "add a reverb", patch: patch, catalog: catalog).edits
        XCTAssertEqual(kept.map(\.node), ["offset", "lfo"])
    }

    /// "Make it more spacious" came back with parallel paths into Master
    /// past the limiter. One feed per audio inlet unless asked for parallel.
    func testOneFeedPerAudioInlet() throws {
        let catalog = try catalog()
        let (patch, _) = added(["reverb"], to: try acid(), catalog)
        let edits = [
            CrateGenEdit(op: .connect, node: "v", jack: "audio", target: "reverb", targetJack: "input"),
            CrateGenEdit(op: .connect, node: "lad", jack: "audio", target: "reverb", targetJack: "input"),
            CrateGenEdit(op: .connect, node: "reverb", jack: "audio", target: "out", targetJack: "input"),
        ]
        let kept = CratePatchEditor.guardEdits(edits, request: "make it more spacious", patch: patch, catalog: catalog).edits
        XCTAssertEqual(kept.map(\.node), ["v"])
        let parallel = CratePatchEditor.guardEdits(edits, request: "blend in a parallel reverb", patch: patch, catalog: catalog).edits
        XCTAssertEqual(parallel.count, 3)
    }

    /// "Darker" took the ladder to 20 Hz and "brighter" took the voice to
    /// -320 Hz. A cutoff goes the way the words say, a step at a time.
    func testCutoffGoesTheWayAskedAStepAtATime() throws {
        let catalog = try catalog()
        let patch = try acid()
        let darker = CratePatchEditor.guardEdits(
            [CrateGenEdit(op: .setParam, node: "lad", param: "cutoff", value: 20)],
            request: "make it darker", patch: patch, catalog: catalog
        ).edits
        XCTAssertEqual(darker.first?.value ?? 0, 225, accuracy: 1)
        let brighter = CratePatchEditor.guardEdits(
            [CrateGenEdit(op: .setParam, node: "v", param: "cutoff", value: -320)],
            request: "make it brighter", patch: patch, catalog: catalog
        ).edits
        XCTAssertGreaterThan(brighter.first?.value ?? 0, 320)
    }

    func testTimesGoTheWayAsked() throws {
        let catalog = try catalog()
        let patch = try acid()
        let slower = CratePatchEditor.guardEdits(
            [CrateGenEdit(op: .setParam, node: "v", param: "attack", value: 0.001)],
            request: "make the attack slower", patch: patch, catalog: catalog
        ).edits
        XCTAssertGreaterThan(slower.first?.value ?? 0, 0.002)
        let much = CratePatchEditor.guardEdits(
            [CrateGenEdit(op: .setParam, node: "v", param: "attack", value: 1.2)],
            request: "make the attack much slower", patch: patch, catalog: catalog
        ).edits
        XCTAssertEqual(much.first?.value ?? 0, 1.2, accuracy: 1e-9, "a time is not held to a step")
    }

    // MARK: What the rules do

    func testRemovingAModuleJoinsItsNeighbours() throws {
        let catalog = try catalog()
        let next = CratePatchEditor.apply([CrateGenEdit(op: .removeNode, node: "lad")], to: try acid(), catalog: catalog).patch
        XCTAssertTrue(next.connections.contains { $0.source == "v" && $0.target == "lvl" && $0.targetInput == "input" })
        XCTAssertGreaterThan(CrateGenStart.loudness(next, catalog: catalog) ?? 0, 1e-3)
    }

    func testReplacementKeepsTheCablesAndTheSettings() throws {
        let catalog = try catalog()
        for request in ["replace the ladder with a lowpass", "swap the filter for a lowpass", "use a lowpass instead of the ladder"] {
            let swapped = try XCTUnwrap(CratePatchEditor.replacement(request, in: try acid(), catalog: catalog), request)
            XCTAssertNil(swapped.patch.node("lad"), request)
            let lowpass = try XCTUnwrap(swapped.patch.nodes.first { $0.kind == "lowpass" }, request)
            XCTAssertEqual(lowpass.params["cutoff"], 900, request)
            XCTAssertTrue(swapped.patch.connections.contains { $0.source == "v" && $0.target == lowpass.id }, request)
            XCTAssertTrue(swapped.patch.connections.contains { $0.source == lowpass.id && $0.target == "lvl" }, request)
        }
        XCTAssertNil(CratePatchEditor.replacement("make it darker", in: try acid(), catalog: catalog))
    }

    /// The library's effects that no module answers to, by every word of
    /// their name.
    func testNamedFactoryEffects() throws {
        let catalog = try catalog()
        let library = try FactoryLibrary.bundled()
        XCTAssertEqual(CrateGenStart.namedEffects("add a phaser", in: library, catalog: catalog).map(\.name), ["Phaser"])
        XCTAssertEqual(CrateGenStart.namedEffects("add a chorus and a delay", in: library, catalog: catalog).map(\.name), ["Chorus"])
        XCTAssertTrue(CrateGenStart.namedEffects("add a delay", in: library, catalog: catalog).isEmpty)
        XCTAssertTrue(CrateGenStart.namedEffects("add a ring mod", in: library, catalog: catalog).isEmpty, "the module wins")
    }

    func testImpliedAndModulatorKinds() throws {
        let patch = try acid()
        XCTAssertEqual(CratePatchEditor.impliedKinds("make it more spacious", patch: patch), ["reverb"])
        XCTAssertTrue(CratePatchEditor.impliedKinds("make it darker", patch: patch).isEmpty)
        XCTAssertEqual(CratePatchEditor.withModulator([], request: "modulate the resonance"), ["lfo"])
        XCTAssertEqual(CratePatchEditor.withModulator(["adsr"], request: "add an adsr to modulate the cutoff"), ["adsr"])
    }
}
