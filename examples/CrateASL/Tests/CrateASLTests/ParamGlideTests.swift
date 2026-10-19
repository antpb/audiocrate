import XCTest
@testable import CrateASL

/// Continuous parameters glide when a host moves them, as in compile.ts.
/// The motion fixture holds the arithmetic to JavaScript across the whole
/// palette; these pin the contract a host relies on.
final class ParamGlideTests: XCTestCase {
    private func voice(smooth: [String]?) throws -> CompiledVoice {
        let graph = ASLGraphDocument(
            inputs: ["level"],
            output: ASLNodeDocument(id: 1, kind: "param", params: ["name": .string("level")]),
            smooth: smooth
        )
        return try CompiledVoice(document: graph)
    }

    private func block(_ voice: CompiledVoice, _ state: VoiceState, _ frames: Int) -> [Float] {
        var out = [Float](repeating: 0, count: frames)
        var right: [Float]? = nil
        voice.renderBlock(state, sampleRate: 48000, output: &out, outputR: &right)
        return out
    }

    func testTheGlideIsFiveMillisecondsAndLandsExactly() throws {
        XCTAssertEqual(paramRampFrames(48000), 240)
        let voice = try voice(smooth: ["level"])
        let state = voice.makeState()
        voice.noteOn(state, params: ["level": 0])
        _ = block(voice, state, 128)
        voice.setParam(state, "level", 0.6)
        let out = block(voice, state, 128) + block(voice, state, 128) + block(voice, state, 128)
        XCTAssertEqual(out[0], 0)
        XCTAssertEqual(Double(out[120]), 0.6 * 120 / 240, accuracy: 1e-6)
        for index in 240..<out.count { XCTAssertEqual(out[index], Float(0.6)) }
    }

    func testNothingGlidesBeforeTheFirstRenderOrWithoutASmoothList() throws {
        let smooth = try voice(smooth: ["level"])
        let fresh = smooth.makeState()
        smooth.setParam(fresh, "level", 0.25)
        XCTAssertEqual(block(smooth, fresh, 2), [0.25, 0.25])

        let plain = try voice(smooth: nil)
        let state = plain.makeState()
        plain.noteOn(state, params: ["level": 0])
        _ = block(plain, state, 8)
        plain.setParam(state, "level", 1)
        XCTAssertEqual(block(plain, state, 2), [1, 1])
    }
}
