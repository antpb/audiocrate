import XCTest
@testable import CrateASL

/// The movement a generated patch is given: which moves a patch can take,
/// and that each one, built by rule, is a cable that does something audible
/// without breaking the sound it moves.
final class PatchMotionTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }
    private func library() throws -> FactoryLibrary { try FactoryLibrary.bundled() }

    private func entry(_ id: String) throws -> FactoryLibrary.Entry {
        try XCTUnwrap(try library().patches.first { $0.id == id }, "no factory patch \(id)")
    }

    /// Brightness across a held note: the centroid of the first sixty
    /// harmonics of A2, in the attack and later on. A plainer measure (the
    /// first difference over the signal) follows a resonant filter's peak
    /// down and reads a sweep as no change.
    private func brightness(_ patch: CratePatch, _ catalog: MaterialCatalog) throws -> (early: Double, late: Double) {
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "T")
        let voice = try CompiledVoice(document: compiled.graph)
        let state = voice.makeState()
        state.setParams(ParameterMap(compiled.params).defaults)
        state.setParam("note", 45)
        state.setParam("velocity", 1)
        state.gate = true
        var out = [Float](repeating: 0, count: 24_000)
        var right: [Float]? = nil
        _ = voice.renderBlock(state, sampleRate: 48_000, output: &out, outputR: &right,
                              transport: TransportSnapshot(playing: true))
        func centroid(_ range: Range<Int>) -> Double {
            var weighted = 0.0
            var total = 0.0
            for harmonic in 1...60 {
                let step = 2 * Double.pi * 110 * Double(harmonic) / 48_000
                var re = 0.0
                var im = 0.0
                for index in range {
                    re += Double(out[index]) * cos(step * Double(index))
                    im += Double(out[index]) * sin(step * Double(index))
                }
                let magnitude = (re * re + im * im).squareRoot()
                weighted += Double(harmonic) * 110 * magnitude
                total += magnitude
            }
            return total > 0 ? weighted / total : 0
        }
        return (centroid(0..<4_800), centroid(14_400..<24_000))
    }

    /// The bug report: "acid bass synth" came back as a voice into a ladder
    /// at a fixed cutoff. With the move built, the ladder opens on the note
    /// and closes again, which is the squelch.
    func testAcidEnvelopeOpensThenClosesTheLadder() throws {
        let catalog = try catalog()
        let acid = try entry("acid-line").patch
        let flat = try brightness(acid, catalog)

        let moved = CrateGenMove.apply([(.filterEnvelope, .fast, .deep)], to: acid, catalog: catalog)
        XCTAssertTrue(CratePatchCheck.validate(moved.patch, catalog: catalog).ok)
        let env = try XCTUnwrap(moved.patch.nodes.first { $0.kind == "adsr" })
        XCTAssertTrue(moved.patch.connections.contains { $0.source == "keys" && $0.target == env.id && $0.targetInput == "gate" },
                      "the envelope is played by the keyboard")
        XCTAssertTrue(moved.patch.connections.contains { $0.target == "lad" && $0.targetInput == "cutoff" },
                      "the envelope reaches the ladder")

        let swept = try brightness(moved.patch, catalog)
        XCTAssertGreaterThan(swept.early, swept.late * 1.5, "the attack is brighter than the tail: \(swept)")
        XCTAssertGreaterThan(swept.early / swept.late, flat.early / flat.late * 1.2,
                             "more movement than the factory patch had: \(swept) against \(flat)")
        XCTAssertGreaterThan(swept.early, flat.early, "and it opens further")
    }

    /// The tuning pass once took Acid Line's decay to a millisecond and its
    /// ladder resonance to 0.5. The decay is held to a fraction of what it
    /// was; a deep envelope puts the resonance back where it squelches.
    func testAcidKeepsItsNoteAndItsSquelch() throws {
        let catalog = try catalog()
        let acid = try entry("acid-line").patch
        let reined = CrateGenStart.rein(
            [CrateGenEdit(op: .setParam, node: "v", param: "decay", value: 0.001),
             CrateGenEdit(op: .setParam, node: "lad", param: "resonance", value: 0.5)],
            in: acid, catalog: catalog
        )
        let decay = try XCTUnwrap(reined.edits.first { $0.param == "decay" })
        XCTAssertGreaterThanOrEqual(decay.value, 0.06)
        let tuned = CratePatchEditor.apply(reined.edits, to: acid, catalog: catalog).patch
        let moved = CrateGenMove.apply([(.filterEnvelope, .fast, .deep)], to: tuned, catalog: catalog).patch
        XCTAssertGreaterThanOrEqual(moved.node("lad")?.params["resonance"] ?? 0, 0.8)
    }

    /// Every move on every factory instrument it applies to: valid, compiles,
    /// still heard, never clipping.
    func testEveryMoveOnEveryInstrumentStillPlays() throws {
        let catalog = try catalog()
        // Percussion is never given movement (see `motion` in the generator).
        for entry in try library().patches where entry.slot == "instrument" && entry.category != "Percussion" {
            let reference = CrateGenStart.loudness(entry.patch, catalog: catalog) ?? 0
            for move in CrateGenMove.available(in: entry.patch, catalog: catalog) {
                let moved = CrateGenMove.apply([(move, .medium, .deep)], to: entry.patch, catalog: catalog)
                XCTAssertTrue(CratePatchCheck.validate(moved.patch, catalog: catalog).ok, "\(entry.name) + \(move)")
                guard let levels = CrateGenStart.levels(moved.patch, catalog: catalog) else {
                    XCTFail("\(entry.name) + \(move) does not compile")
                    continue
                }
                XCTAssertGreaterThan(levels.rms, reference * 0.1, "\(entry.name) + \(move) went quiet")
                XCTAssertLessThan(levels.peak, 1.0, "\(entry.name) + \(move) clips")
            }
        }
    }

    /// One filter move per cutoff, and no second filter added to a patch
    /// whose filter is already moving.
    func testFilterMovesDoNotStack() throws {
        let catalog = try catalog()
        let acid = try entry("acid-line").patch
        let moved = CrateGenMove.apply(
            [(.filterEnvelope, .fast, .deep), (.wobble, .medium, .medium), (.randomSteps, .medium, .medium)],
            to: acid, catalog: catalog
        )
        let filters = moved.patch.nodes.filter { ["lowpass", "ladder", "svflowpass"].contains($0.kind) }
        XCTAssertEqual(filters.count, 1, "no filter added: \(moved.notes)")
        for node in moved.patch.nodes {
            let into = moved.patch.connections.filter { $0.target == node.id && $0.targetInput == "cutoff" }
            XCTAssertLessThanOrEqual(into.count, 1, "\(node.id).cutoff has \(into.count) cables")
        }
    }

    /// A bell has no filter; a filter move gives it one, in the signal path.
    func testFilterMoveAddsAFilterWhenThereIsNone() throws {
        let catalog = try catalog()
        let bell = try entry("bell").patch
        XCTAssertNil(CrateGenMove.filter(in: bell, catalog: catalog))
        let moved = CrateGenMove.apply([(.filterEnvelope, .medium, .medium)], to: bell, catalog: catalog)
        let filter = try XCTUnwrap(moved.patch.nodes.first { $0.kind == "lowpass" })
        XCTAssertTrue(moved.patch.connections.contains { $0.target == filter.id && $0.targetInput == "input" })
        XCTAssertTrue(moved.patch.connections.contains { $0.source == filter.id })
        XCTAssertGreaterThan(CrateGenStart.loudness(moved.patch, catalog: catalog) ?? 0, 1e-4)
    }

    /// Effects move when the words ask, and otherwise not at all.
    func testEffectsMoveOnlyWhenAsked() throws {
        let catalog = try catalog()
        let comp = try entry("vocal-comp").patch
        let available = CrateGenMove.available(in: comp, catalog: catalog)
        XCTAssertTrue(CrateGenMove.idioms("a tight vocal compressor", available: available, fallback: false).isEmpty)
        XCTAssertTrue(CrateGenMove.signature("a tight vocal compressor", available: available).isEmpty)

        let echo = try entry("tape-echo").patch
        let echoMoves = CrateGenMove.available(in: echo, catalog: catalog)
        let wide = CrateGenMove.idioms("a dreamy wide echo", available: echoMoves, fallback: false).map(\.0)
        XCTAssertTrue(wide.contains(.autopan), "\(wide)")
    }

    /// The style a move is named for wins over everything else.
    func testSignatureMoves() throws {
        let all = CrateGenMove.allCases
        XCTAssertEqual(CrateGenMove.signature("acid bass synth", available: all).first?.0, .filterEnvelope)
        XCTAssertEqual(CrateGenMove.signature("a squelchy 303 line", available: all).first?.2, .deep)
        XCTAssertEqual(CrateGenMove.signature("dubstep wobble bass", available: all).first?.0, .wobble)
        XCTAssertTrue(CrateGenMove.signature("a warm pad", available: all).isEmpty)
        XCTAssertTrue(CrateGenMove.wantsStill("a plain sub bass"))
        XCTAssertFalse(CrateGenMove.wantsStill("a fat sub bass"))
    }

    /// A patch with an LFO already on its filter counts as moving; a source
    /// and a filter played by the keyboard does not.
    func testAlreadyMoves() throws {
        let catalog = try catalog()
        XCTAssertFalse(CrateGenMove.alreadyMoves(try entry("acid-line").patch, catalog: catalog))
        let wobble = try XCTUnwrap(try library().patches.first { $0.name == "Wobble Bass" })
        XCTAssertTrue(CrateGenMove.alreadyMoves(wobble.patch, catalog: catalog))
    }
}
