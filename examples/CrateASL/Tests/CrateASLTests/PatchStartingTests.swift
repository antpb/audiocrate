import XCTest
@testable import CrateASL

/// Starting a generated instrument or effect from the factory library.
///
/// The model's half of this is two choices and a list of knob turns, and it
/// is checked by running prompts against the real model. What is checked here
/// is everything around it that has one right answer: chaining two patches,
/// matching words to patches, the rails on the knob turns, and the level.
final class PatchStartingTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }
    private func library() throws -> FactoryLibrary { try FactoryLibrary.bundled() }

    private func entry(_ id: String) throws -> FactoryLibrary.Entry {
        try XCTUnwrap(try library().patches.first { $0.id == id }, "no factory patch \(id)")
    }

    /// Renders a held note at a velocity, returning RMS and a brightness
    /// proxy: the energy of the first difference over the energy of the
    /// signal, which rises as the high end opens.
    private func render(_ patch: CratePatch, _ catalog: MaterialCatalog, velocity: Double) throws -> (rms: Double, bright: Double) {
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "T")
        let voice = try CompiledVoice(document: compiled.graph)
        let state = voice.makeState()
        state.setParams(ParameterMap(compiled.params).defaults)
        state.setParam("note", 57)
        state.setParam("velocity", velocity)
        state.gate = true
        var out = [Float](repeating: 0, count: 24_000)
        var right: [Float]? = nil
        _ = voice.renderBlock(state, sampleRate: 48_000, output: &out, outputR: &right,
                              transport: TransportSnapshot(playing: true))
        var energy = 0.0
        var edge = 0.0
        for index in 1..<out.count {
            energy += Double(out[index]) * Double(out[index])
            let step = Double(out[index] - out[index - 1])
            edge += step * step
        }
        return ((energy / Double(out.count)).squareRoot(), energy > 0 ? edge / energy : 0)
    }

    // MARK: The audit hears instruments

    /// The bug under all of this: the audit opened the gate and never set a
    /// velocity, so every velocity-scaled instrument rendered silence and was
    /// reported broken. A factory instrument is the definition of one that
    /// works.
    func testEveryFactoryInstrumentIsHeard() throws {
        let catalog = try catalog()
        for entry in try library().patches where entry.slot == "instrument" {
            let finding = CratePatchAudit.listen(entry.patch, catalog: catalog)
            XCTAssertNil(finding, "\(entry.name) is reported as \(finding?.detail ?? "")")
            XCTAssertGreaterThan(CrateGenStart.loudness(entry.patch, catalog: catalog) ?? 0, 1e-4, entry.name)
        }
    }

    // MARK: Choosing

    func testTheHeadNounIsWhatTheDescriptionIsAbout() {
        XCTAssertEqual(CrateGenStart.headWord("a slow phaser"), "phaser")
        XCTAssertEqual(CrateGenStart.headWord("a fat detuned saw bass for techno"), "bass")
        XCTAssertEqual(CrateGenStart.headWord("a glassy bell that opens up when you play harder"), "bell")
        XCTAssertEqual(CrateGenStart.headWord("a bright pluck with a big hall reverb"), "pluck")
    }

    func testTheNounOutranksTheAdjective() throws {
        let library = try library()
        let effects = CrateGenStart.candidates(for: .insert, in: library)
        let instruments = CrateGenStart.candidates(for: .instrument, in: library)
        XCTAssertEqual(CrateGenStart.rank("a slow phaser", effects).first?.id, "phaser")
        XCTAssertEqual(CrateGenStart.rank("a glassy bell", instruments).first?.id, "bell")
        XCTAssertEqual(CrateGenStart.rank("a lush shimmering reverb", effects).first?.id, "shimmer")
        XCTAssertEqual(CrateGenStart.rank("a tight vocal compressor", effects).first?.id, "vocal-comp")
        XCTAssertTrue(CrateGenStart.namesHead("a slow phaser", try entry("phaser")))
        XCTAssertFalse(CrateGenStart.namesHead("a slow phaser", try entry("slow-panner")))
    }

    /// Reverb is not reverse. Five shared letters said it was.
    func testSimilarWordsAreNotTheSameWord() {
        XCTAssertFalse(CrateGenStart.same("reverb", "reverse"))
        XCTAssertTrue(CrateGenStart.same("shimmering", "shimmer"))
        XCTAssertTrue(CrateGenStart.same("comp", "compressor"))
        XCTAssertTrue(CrateGenStart.same("detuned", "detune"))
    }

    func testAnInstrumentGetsAnEffectOnlyWhenOneIsAskedFor() {
        XCTAssertFalse(CrateGenStart.asksForEffect("a plucky marimba"))
        XCTAssertFalse(CrateGenStart.asksForEffect("a fat detuned saw bass for techno"))
        XCTAssertTrue(CrateGenStart.asksForEffect("a bright pluck with a big hall reverb"))
        XCTAssertTrue(CrateGenStart.asksForEffect("an aggressive distorted bass with chorus"))
    }

    func testBrightAndDarkAreReadOffTheWords() {
        XCTAssertEqual(CrateGenStart.brightness("a bright pluck"), 1)
        XCTAssertEqual(CrateGenStart.brightness("a soft warm pad"), -1)
        XCTAssertEqual(CrateGenStart.brightness("a slow phaser"), 0)
    }

    // MARK: Chaining

    func testAnInstrumentPlaysIntoAnEffect() throws {
        let catalog = try catalog()
        let pluck = try entry("rubber-pluck").patch
        let hall = try entry("big-hall").patch
        let joined = try XCTUnwrap(CrateGenStart.series(pluck, hall, catalog: catalog))
        XCTAssertTrue(CratePatchCheck.validate(joined, catalog: catalog).ok)
        XCTAssertEqual(joined.nodes.filter { $0.kind == catalog.io.master }.count, 1)
        XCTAssertFalse(joined.nodes.contains { $0.kind == catalog.io.line }, "the effect's line is replaced by the instrument")
        XCTAssertEqual(Set(joined.nodes.map(\.id)).count, joined.nodes.count, "ids collide")
        XCTAssertNotNil(joined.nodes.first { $0.kind == "reverb" })
        XCTAssertGreaterThan(CrateGenStart.loudness(joined, catalog: catalog) ?? 0, 1e-4)
        // Nothing the instrument's author placed has moved.
        for node in pluck.nodes where node.kind != catalog.io.master {
            XCTAssertEqual(joined.node(node.id)?.x, node.x)
        }
    }

    func testTwoEffectsChainInOrder() throws {
        let catalog = try catalog()
        let joined = try XCTUnwrap(
            CrateGenStart.series(try entry("fuzz").patch, try entry("dub-delay").patch, catalog: catalog)
        )
        XCTAssertTrue(CratePatchCheck.validate(joined, catalog: catalog).ok)
        XCTAssertEqual(joined.nodes.filter { $0.kind == catalog.io.line }.count, 1)
        XCTAssertGreaterThan(CrateGenStart.loudness(joined, catalog: catalog) ?? 0, 1e-4)
    }

    // MARK: Rails on the tuning

    func testTheTuningIsKeptMusical() throws {
        let catalog = try catalog()
        let pluck = try entry("rubber-pluck").patch
        let osc = try XCTUnwrap(pluck.nodes.first { $0.kind == "oscillator" })
        let lp = try XCTUnwrap(pluck.nodes.first { $0.kind == "lowpass" })
        let lim = try XCTUnwrap(pluck.nodes.first { $0.kind == "limiter" })
        let octave = osc.params["octave"] ?? 0
        let cutoff = try XCTUnwrap(lp.params["cutoff"])
        let reined = CrateGenStart.rein(
            [
                CrateGenEdit(op: .setParam, node: osc.id, param: "detune", value: 100),
                CrateGenEdit(op: .setParam, node: osc.id, param: "octave", value: octave + 2),
                CrateGenEdit(op: .setParam, node: lim.id, param: "threshold", value: 1),
                CrateGenEdit(op: .setParam, node: lp.id, param: "cutoff", value: cutoff / 7),
            ],
            in: pluck, catalog: catalog, prompt: "a bright pluck"
        )
        let byParam = Dictionary(uniqueKeysWithValues: reined.edits.map { ($0.param, $0.value) })
        XCTAssertEqual(byParam["detune"], 30, "a single oscillator a semitone off is out of tune, not fat")
        XCTAssertEqual(byParam["octave"], octave + 1)
        XCTAssertNil(byParam["threshold"], "the limiter is the patch's safety")
        XCTAssertNil(byParam["cutoff"], "a bright pluck does not close its lowpass")
    }

    func testTheOutputGainBelongsToTheLevelMatch() throws {
        let catalog = try catalog()
        let comp = try entry("vocal-comp").patch
        let output = try XCTUnwrap(CrateGenStart.outputGain(comp, catalog: catalog))
        let reined = CrateGenStart.rein(
            [CrateGenEdit(op: .setParam, node: comp.nodes[output].id, param: "gain", value: 3)],
            in: comp, catalog: catalog
        )
        XCTAssertTrue(reined.edits.isEmpty)
    }

    /// RMS decides and the peak caps it, so a pluck tuned shorter is not
    /// turned up until it clips.
    func testMatchingTheLevelNeverClips() throws {
        let catalog = try catalog()
        let marimba = try entry("marimba").patch
        let reference = try XCTUnwrap(CrateGenStart.levels(marimba, catalog: catalog))
        var short = marimba
        for index in short.nodes.indices where short.nodes[index].kind == "oscillator" {
            short.nodes[index].params["decay"] = 0.05
            short.nodes[index].params["release"] = 0.05
        }
        let matched = CrateGenStart.matchLevel(short, to: reference, catalog: catalog)
        let after = try XCTUnwrap(CrateGenStart.levels(matched.patch, catalog: catalog))
        XCTAssertLessThanOrEqual(after.peak, 0.96)
    }

    // MARK: Opening up when you play harder

    func testPlayingHarderIsBrighter() throws {
        let catalog = try catalog()
        // Bell has no filter, so this also covers the one that is added.
        let bell = try entry("bell").patch
        let touched = CrateGenStart.velocityOpensFilter(bell, prompt: "a bell that opens up when you play harder", catalog: catalog)
        XCTAssertNotNil(touched.note)
        let soft = try render(touched.patch, catalog, velocity: 0.2)
        let hard = try render(touched.patch, catalog, velocity: 1.0)
        XCTAssertGreaterThan(soft.rms, 1e-4)
        XCTAssertGreaterThan(hard.bright, soft.bright * 1.2, "velocity does not reach the cutoff")
    }

    func testSoftIsNotAskingForVelocity() throws {
        let catalog = try catalog()
        let pad = try entry("warm-pad").patch
        XCTAssertNil(CrateGenStart.velocityOpensFilter(pad, prompt: "a soft warm pad", catalog: catalog).note)
    }
}
