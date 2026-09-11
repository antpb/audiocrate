import XCTest
@testable import CrateASL

/// Sample-accurate parameter automation.
///
/// An AU host does not send "the gain is now 0.5". It sends "the gain reaches
/// 0.5, ramping over 64 frames, starting at frame 37 of this block". A plugin
/// that applies that at the next block boundary is audibly wrong twice: the
/// change lands late, and a fast sweep becomes a staircase whose steps are
/// the block size. That is the zipper noise every DAW user has heard.
///
/// The design here is that a ramp is a **pure function of the frame index**
/// rather than a value stepped as the block advances. That is not stylistic.
/// A graph with a seam kernel in it walks the tree twice over the same block,
/// collect then apply, and anything that advanced as it went would land on
/// different values in the two passes. Stated as `base + step * frame`, both
/// passes agree by construction.
final class RampTests: XCTestCase {

    /// `input * gain`, the smallest graph with an automatable parameter.
    private func gainVoice() throws -> CompiledVoice {
        let json = """
        {"inputs":["gain"],"output":{"id":3,"kind":"mul","params":{},"inputs":{
          "a":{"id":1,"kind":"port","params":{"name":"input"},"inputs":{}},
          "b":{"id":2,"kind":"param","params":{"name":"gain"},"inputs":{}}}}}
        """.data(using: .utf8)!
        return try CompiledVoice(json: json)
    }

    private func ones(_ n: Int) -> [Float] { [Float](repeating: 1, count: n) }

    func testARampIsLinearAcrossTheBlock() throws {
        let voice = try gainVoice()
        let state = voice.makeState()
        state.setParam("gain", 0)
        state.rampParam("gain", to: 1, frames: 64)

        var output = [Float](repeating: 0, count: 64)
        var right: [Float]? = nil
        voice.renderBlock(state, sampleRate: 48000, output: &output, input: ones(64), outputR: &right)

        // Frame k is k/64 of the way there, so the first sample is still the
        // old value and the ramp is genuinely per sample rather than per block.
        XCTAssertEqual(output[0], 0, accuracy: 1e-6)
        XCTAssertEqual(Double(output[32]), 32.0 / 64.0, accuracy: 1e-6)
        XCTAssertEqual(Double(output[63]), 63.0 / 64.0, accuracy: 1e-6)
    }

    func testARampSpanningBlocksContinuesWhereItLeftOff() throws {
        let voice = try gainVoice()
        let state = voice.makeState()
        state.setParam("gain", 0)
        // Twice the block, so the first render only gets halfway.
        state.rampParam("gain", to: 1, frames: 128)

        var output = [Float](repeating: 0, count: 64)
        var right: [Float]? = nil
        voice.renderBlock(state, sampleRate: 48000, output: &output, input: ones(64), outputR: &right)
        XCTAssertEqual(Double(output[63]), 63.0 / 128.0, accuracy: 1e-6)

        voice.renderBlock(state, sampleRate: 48000, output: &output, input: ones(64), outputR: &right)
        // Picks up at 64/128 and finishes at 127/128.
        XCTAssertEqual(Double(output[0]), 64.0 / 128.0, accuracy: 1e-6)
        XCTAssertEqual(Double(output[63]), 127.0 / 128.0, accuracy: 1e-6)

        // And lands exactly on the target rather than on an accumulation of
        // steps, which is why `commitRamps` adds `step * remaining` once
        // instead of adding `step` a hundred and twenty-eight times.
        voice.renderBlock(state, sampleRate: 48000, output: &output, input: ones(64), outputR: &right)
        XCTAssertEqual(output[0], 1.0)
        XCTAssertEqual(output[63], 1.0)
    }

    /// The sub-block split is what makes an event land on its own sample. A
    /// host renders up to the event, applies it, and renders the rest.
    func testSplittingTheBlockPutsAChangeOnItsExactSample() throws {
        let voice = try gainVoice()
        let state = voice.makeState()
        state.setParam("gain", 1)

        var output = [Float](repeating: 0, count: 64)
        let input = ones(64)
        var right: [Float]? = nil

        // Frames 0..<37 at the old value.
        output.withUnsafeMutableBufferPointer { out in
            input.withUnsafeBufferPointer { inBuf in
                voice.render(
                    state, sampleRate: 48000, frames: 37,
                    outL: out.baseAddress!, outR: nil, inL: inBuf.baseAddress!, inR: nil
                )
            }
        }
        // The event, then frames 37..<64 at the new one.
        state.setParam("gain", 0.25)
        output.withUnsafeMutableBufferPointer { out in
            input.withUnsafeBufferPointer { inBuf in
                voice.render(
                    state, sampleRate: 48000, frames: 27,
                    outL: out.baseAddress! + 37, outR: nil,
                    inL: inBuf.baseAddress! + 37, inR: nil
                )
            }
        }

        XCTAssertEqual(output[36], 1.0)
        XCTAssertEqual(output[37], 0.25)
        XCTAssertEqual(output[63], 0.25)
    }

    func testSettingAParameterCancelsARampOnIt() throws {
        let voice = try gainVoice()
        let state = voice.makeState()
        state.setParam("gain", 0)
        state.rampParam("gain", to: 1, frames: 1024)
        state.setParam("gain", 0.5)

        var output = [Float](repeating: 0, count: 8)
        var right: [Float]? = nil
        voice.renderBlock(state, sampleRate: 48000, output: &output, input: ones(8), outputR: &right)
        XCTAssertTrue(output.allSatisfy { $0 == 0.5 })
    }

    /// The property the whole design rests on. A seam graph evaluates the
    /// tree twice per block; a ramp read during collect and again during
    /// apply has to give the same answer at the same frame, or the value the
    /// kernel was fed is not the value the output was built from.
    func testARampReadsTheSameInBothSeamPasses() throws {
        let json = """
        {"inputs":["gain"],"output":{"id":4,"kind":"mul","params":{},"inputs":{
          "a":{"id":3,"kind":"kernel","params":{"slot":"test.seam","mode":"seam"},"inputs":{
            "input":{"id":1,"kind":"port","params":{"name":"input"},"inputs":{}}}},
          "b":{"id":2,"kind":"param","params":{"name":"gain"},"inputs":{}}}}}
        """.data(using: .utf8)!
        let voice = try CompiledVoice(json: json)
        let state = voice.makeState()

        // A kernel that records what it was handed and passes it through.
        final class Recorder: KernelProcessor {
            var collected = [Float]()
            func processSeam(input: UnsafeBufferPointer<Float>, output: UnsafeMutableBufferPointer<Float>) {
                collected = Array(input)
                for i in 0..<min(input.count, output.count) { output[i] = input[i] }
            }
        }
        let recorder = Recorder()
        state.kernels["test.seam"] = recorder

        state.setParam("gain", 0)
        state.rampParam("gain", to: 1, frames: 32)

        var output = [Float](repeating: 0, count: 32)
        var right: [Float]? = nil
        voice.renderBlock(state, sampleRate: 48000, output: &output, input: ones(32), outputR: &right)

        // The kernel sits upstream of the gain, so it sees the raw input and
        // the ramp appears only after it. What matters is that the block came
        // out ramped rather than stuck, which it cannot be if the two passes
        // disagreed about the frame.
        XCTAssertEqual(recorder.collected.count, 32)
        XCTAssertEqual(Double(output[16]), 16.0 / 32.0, accuracy: 1e-6)
        XCTAssertEqual(Double(output[31]), 31.0 / 32.0, accuracy: 1e-6)
    }
}
