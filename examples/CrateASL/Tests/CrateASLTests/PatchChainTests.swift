import XCTest
@testable import CrateASL

/// Effect descriptions that name more than one effect.
///
/// The prompts here are the ones that came back as heavy distortion: two
/// effects asked for, one category chosen, and the crusher at full strength
/// burying whatever else there was.
final class PatchChainTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }
    private func effects() throws -> [FactoryLibrary.Entry] {
        CrateGenStart.effects(in: try FactoryLibrary.bundled())
    }

    /// A fixed generator, so a failure here fails the same way twice.
    private struct SplitMix: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    private func ids(_ stages: [CrateGenStart.Stage]) -> [[String]] {
        stages.map { $0.candidates.map(\.id) }
    }

    // MARK: Reading the sentence

    func testWithKeepsTheOrderItIsSaidIn() throws {
        let stages = CrateGenStart.chain("a flanger with bit crushing", effects: try effects())
        XCTAssertEqual(ids(stages), [["flanger"], ["bitcrusher"]])
        XCTAssertEqual(stages.map(\.intensity), [.full, .medium], "the second-named effect is the seasoning")
    }

    func testOnTopOfPutsTheSecondThingFirst() throws {
        let stages = CrateGenStart.chain(
            "slow evolving filter sweeps on top of bit crushing", effects: try effects()
        )
        XCTAssertEqual(ids(stages), [["bitcrusher"], ["filter-sweep"]])
        // The sweep is what the sentence is about, wherever it sits.
        XCTAssertEqual(stages[1].intensity, .full)
        XCTAssertEqual(stages[0].intensity, .medium)
        XCTAssertTrue(stages[1].clause.contains("slow"))
    }

    func testOneClauseIsOneEffect() throws {
        let stages = CrateGenStart.chain("a big hall reverb", effects: try effects())
        XCTAssertEqual(ids(stages), [["big-hall"]], "not a Big Hall and a Plate")
        XCTAssertEqual(ids(CrateGenStart.chain("a dark tape echo with the highs rolled off", effects: try effects())),
                       [["tape-echo"]])
    }

    func testAGeneralWordOffersSeveral() throws {
        let stages = CrateGenStart.chain("a phaser into some delay", effects: try effects())
        XCTAssertEqual(stages.first?.candidates.map(\.id), ["phaser"])
        XCTAssertGreaterThan(stages.last?.candidates.count ?? 0, 1)
    }

    func testIntensityIsReadOffTheClause() throws {
        let effects = try effects()
        XCTAssertEqual(CrateGenStart.chain("a chorus with a touch of bitcrush", effects: effects).last?.intensity, .light)
        XCTAssertEqual(CrateGenStart.chain("a chorus with heavy bitcrush", effects: effects).last?.intensity, .full)
        // "Bit" in "bit crushing" is the name, not "a bit of".
        XCTAssertEqual(CrateGenStart.chain("a chorus with bit crushing", effects: effects).last?.intensity, .medium)
        XCTAssertEqual(CrateGenStart.chain("a chorus with a bit of crush", effects: effects).last?.intensity, .light)
    }

    func testAdjectivesAreNotEffects() throws {
        // "Slow" is not the Slow Panner, "warm" is not Warm Saturation.
        XCTAssertTrue(CrateGenStart.chain("something slow and warm", effects: try effects()).isEmpty)
        XCTAssertEqual(ids(CrateGenStart.chain("a slow phaser", effects: try effects())), [["phaser"]])
    }

    func testAnInstrumentsEffectsAreAllSeasoning() throws {
        let stages = CrateGenStart.chain("a bright pluck with a big hall reverb", effects: try effects(), leadIsNamed: false)
        XCTAssertEqual(ids(stages), [["big-hall"]])
        XCTAssertEqual(stages.first?.intensity, .medium)
    }

    // MARK: Voicing

    func testTheSecondEffectIsEasedBack() throws {
        let catalog = try catalog()
        let effects = try effects()
        let stages = CrateGenStart.chain("a flanger with bit crushing", effects: effects)
        let crusher = try XCTUnwrap(effects.first { $0.id == "bitcrusher" })
        let voiced = CrateGenStart.voice(crusher, stage: stages[1], catalog: catalog)
        let bits = try XCTUnwrap(voiced.patch.nodes.first { $0.kind == "bitcrush" }?.params["bits"])
        XCTAssertGreaterThan(bits, 6, "six bits is the whole sound")
        XCTAssertTrue(CratePatchCheck.validate(voiced.patch, catalog: catalog).ok)
    }

    func testSlowIsSlowerOnlyWhereItWasSaid() throws {
        let catalog = try catalog()
        let effects = try effects()
        let stages = CrateGenStart.chain("slow evolving filter sweeps on top of bit crushing", effects: effects)
        let sweep = try XCTUnwrap(effects.first { $0.id == "filter-sweep" })
        let shipped = try XCTUnwrap(sweep.patch.nodes.first { $0.kind == "lfo" }?.params["rate"])
        let voiced = CrateGenStart.voice(sweep, stage: stages[1], catalog: catalog)
        let rate = try XCTUnwrap(voiced.patch.nodes.first { $0.kind == "lfo" }?.params["rate"])
        XCTAssertLessThan(rate, shipped)
    }

    /// The point of all of it: in the chain, the flanger is still there.
    /// Each stage at unity and the crusher eased back, the chain plays at
    /// about the level it was fed, and is not the crusher's level times the
    /// flanger's.
    func testTheChainPlaysAtTheLevelItIsFed() throws {
        let catalog = try catalog()
        let effects = try effects()
        let stages = CrateGenStart.chain("a flanger with bit crushing", effects: effects)
        let entries = stages.map { $0.candidates[0] }
        var patch = CrateGenStart.voice(entries[0], stage: stages[0], catalog: catalog).patch
        let crush = CrateGenStart.voice(entries[1], stage: stages[1], catalog: catalog).patch
        patch = try XCTUnwrap(CrateGenStart.series(patch, crush, catalog: catalog))
        XCTAssertTrue(CratePatchCheck.validate(patch, catalog: catalog).ok)
        XCTAssertTrue(patch.nodes.contains { $0.kind == "comb" })
        XCTAssertTrue(patch.nodes.contains { $0.kind == "bitcrush" })
        let rms = try XCTUnwrap(CrateGenStart.loudness(patch, catalog: catalog))
        let fed = 0.3 / 2.0.squareRoot()
        XCTAssertGreaterThan(rms, fed * 0.4)
        XCTAssertLessThan(rms, fed * 2.5)
    }

    // MARK: Hints and variety

    func testHintsAreForTheModulesThere() throws {
        let catalog = try catalog()
        let flanger = try XCTUnwrap(try effects().first { $0.id == "flanger" })
        let hints = CrateGenStart.moduleHints(flanger.patch, catalog: catalog)
        XCTAssertTrue(hints.contains { $0.hasPrefix("comb:") })
        XCTAssertTrue(hints.contains { $0.hasPrefix("lfo:") })
        XCTAssertFalse(hints.contains { $0.hasPrefix("bitcrush:") })
    }

    func testTwoTakesDifferAndBothPlay() throws {
        let catalog = try catalog()
        let flanger = try XCTUnwrap(try effects().first { $0.id == "flanger" })
        var one = SplitMix(state: 1)
        var two = SplitMix(state: 2)
        let a = CrateGenStart.vary(flanger.patch, catalog: catalog, using: &one)
        let b = CrateGenStart.vary(flanger.patch, catalog: catalog, using: &two)
        XCTAssertNotEqual(a.nodes.map(\.params), b.nodes.map(\.params))
        for patch in [a, b] {
            XCTAssertTrue(CratePatchCheck.validate(patch, catalog: catalog).ok)
            XCTAssertGreaterThan(CrateGenStart.loudness(patch, catalog: catalog) ?? 0, 1e-3)
        }
    }

    /// Every factory effect still plays after a variation, for many seeds.
    func testVariationNeverSilencesAnEffect() throws {
        let catalog = try catalog()
        var rng = SplitMix(state: 7)
        for entry in try effects() {
            let shipped = CrateGenStart.loudness(entry.patch, catalog: catalog) ?? 0
            guard shipped > 1e-4 else { continue }
            for _ in 0..<3 {
                let varied = CrateGenStart.vary(entry.patch, catalog: catalog, using: &rng)
                XCTAssertGreaterThan(CrateGenStart.loudness(varied, catalog: catalog) ?? 0, shipped * 0.1, entry.name)
            }
        }
    }

    // MARK: Scoring

    func testACrushWordDoesNotPromoteEveryDistortion() throws {
        let effects = try effects()
        let fuzz = try XCTUnwrap(effects.first { $0.id == "fuzz" })
        let flanger = try XCTUnwrap(effects.first { $0.id == "flanger" })
        XCTAssertGreaterThan(
            CrateGenStart.score("a flanger with bit crushing", flanger),
            CrateGenStart.score("a flanger with bit crushing", fuzz) + 2
        )
    }
}
