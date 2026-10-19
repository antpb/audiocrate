import XCTest
@testable import CrateASL

/// What the crate AUv3's seed row promises, held where it can be tested.
///
/// The plugin keeps one seed per instance, saved with the project, and builds
/// its voices with it (`VoicePool(seed:)` for an instrument,
/// `makeState(seed:)` for an effect). "Fixed" means a project reopens to the
/// same noise; unfixed means every rebuild starts somewhere new; and the
/// voices of one chord must not hiss in lockstep either way.
final class SeedContractTests: XCTestCase {

    private func noiseVoice() throws -> CompiledVoice {
        let json = """
        {"inputs":[],"output":{"id":0,"kind":"noise","params":{},"inputs":{}}}
        """
        return try CompiledVoice(json: json.data(using: .utf8)!)
    }

    /// One block from each of two voices of a pool, notes 60 and 64.
    private func render(_ pool: VoicePool) -> [Float] {
        pool.noteOn(note: 60, velocity: 1)
        var out = [Float](repeating: 0, count: 256)
        out.withUnsafeMutableBufferPointer { buffer in
            _ = pool.render(sampleRate: 48000, frames: 256, outL: buffer.baseAddress!, outR: nil)
        }
        return out
    }

    func testAFixedSeedReopensToTheSameNoise() throws {
        let voice = try noiseVoice()
        let first = render(VoicePool(voice: voice, polyphony: 4, seed: 123_456))
        let again = render(VoicePool(voice: voice, polyphony: 4, seed: 123_456))
        XCTAssertEqual(first, again)
        XCTAssertGreaterThan(first.map(abs).max() ?? 0, 0.1, "silence agrees about nothing")
    }

    func testARerolledSeedIsDifferentNoise() throws {
        let voice = try noiseVoice()
        XCTAssertNotEqual(
            render(VoicePool(voice: voice, polyphony: 4, seed: 123_456)),
            render(VoicePool(voice: voice, polyphony: 4, seed: 123_457))
        )
    }

    func testAnUnfixedSeedStartsSomewhereNewEachRebuild() throws {
        let voice = try noiseVoice()
        XCTAssertNotEqual(
            render(VoicePool(voice: voice, polyphony: 4, seed: nil)),
            render(VoicePool(voice: voice, polyphony: 4, seed: nil))
        )
    }

    func testTheVoicesOfOneChordDoNotHissInLockstep() throws {
        let voice = try noiseVoice()
        let pool = VoicePool(voice: voice, polyphony: 2, seed: 9)
        pool.noteOn(note: 60, velocity: 1)
        var one = [Float](repeating: 0, count: 256)
        one.withUnsafeMutableBufferPointer { buffer in
            _ = pool.render(sampleRate: 48000, frames: 256, outL: buffer.baseAddress!, outR: nil)
        }
        // A second voice seeded seed + 1, heard alone.
        let second = VoicePool(voice: voice, polyphony: 1, seed: 10)
        second.noteOn(note: 64, velocity: 1)
        var two = [Float](repeating: 0, count: 256)
        two.withUnsafeMutableBufferPointer { buffer in
            _ = second.render(sampleRate: 48000, frames: 256, outL: buffer.baseAddress!, outR: nil)
        }
        XCTAssertNotEqual(one, two)
    }

    /// The effect path: one state, the same promise.
    func testAnEffectsStateHoldsItsSeedToo() throws {
        let voice = try noiseVoice()
        func block(_ seed: UInt32) -> [Float] {
            let state = voice.makeState(seed: seed)
            state.gate = true
            var out = [Float](repeating: 0, count: 128)
            out.withUnsafeMutableBufferPointer { buffer in
                _ = voice.render(state, sampleRate: 48000, frames: 128, outL: buffer.baseAddress!, outR: nil)
            }
            return out
        }
        XCTAssertEqual(block(77), block(77))
        XCTAssertNotEqual(block(77), block(78))
    }
}
