import XCTest
@testable import CrateASL

/// The seeded streams behind `noise` and `random`, held to the same literal
/// draws `test/asl/rng.test.ts` pins in JavaScript.
///
/// The conformance fixture renders every case at the default seed, so it
/// cannot see a port that gets the default right and mixes a non-zero seed,
/// a later rank or a second channel wrongly. These can: every row varies one
/// of the three inputs away from zero, and the last one sits at the top of
/// the 32-bit range where a signed/unsigned slip would show.
final class RngTests: XCTestCase {
    private let rows: [(seed: UInt32, rank: Int, lane: Int, draws: [Double], after: UInt32)] = [
        (12345, 0, 0, [0.63517789961770177, 0.17278801347129047, 0.99750317120924592], 2_182_334_657),
        (12345, 1, 0, [0.48469644016586244, 0.10247468296438456, 0.67741280770860612], 1_294_579_196),
        (12345, 0, 1, [0.036649140063673258, 0.072640679078176618, 0.021144072990864515], 3_313_936_347),
        (4_294_967_295, 3, 1, [0.14400545717217028, 0.14127441612072289, 0.26529787667095661], 329_059_612),
    ]

    func testStreamsMatchTheJavaScriptDrawsExactly() {
        for row in rows {
            var state = streamSeed(row.seed, rank: row.rank, lane: row.lane)
            let draws = (0..<3).map { _ in nextUniform(&state) }
            XCTAssertEqual(draws, row.draws, "seed \(row.seed) rank \(row.rank) lane \(row.lane)")
            XCTAssertEqual(state, row.after)
        }
    }

    func testSeedsNormalizeAsToUint32() {
        XCTAssertEqual(normalizeSeed(-1), 4_294_967_295)
        XCTAssertEqual(normalizeSeed(4_294_967_296 + 7.9), 7)
        XCTAssertEqual(normalizeSeed(-7.9), 4_294_967_289)
        XCTAssertEqual(normalizeSeed(.nan), defaultVoiceSeed)
    }

    func testOneSeedRendersTheSameNoiseTwiceAndAnotherDoesNot() throws {
        let graph = ASLGraphDocument(
            inputs: [],
            output: ASLNodeDocument(id: 1, kind: "noise", params: ["color": .string("pink")])
        )
        let voice = try CompiledVoice(document: graph)
        func render(_ seed: UInt32) -> [Double] {
            let state = voice.makeState(seed: seed)
            voice.noteOn(state)
            return (0..<64).map { _ in voice.renderSample(state, sampleRate: 48000) }
        }
        XCTAssertEqual(render(7), render(7))
        XCTAssertNotEqual(render(7), render(8))
    }
}
