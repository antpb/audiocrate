import XCTest

@testable import CrateASL

/// Taps record into dense per-voice slots resolved when the plan is built.
///
/// They used to be dictionaries keyed by the tap's id, filled on first use.
/// That hashed a string once per sample per tap and allocated on the first
/// sample through a new one, both on the audio thread, and it grew a
/// structure that `drainAnalysis` walks from whichever thread wants a reading.
/// These tests are here so the dense version keeps doing the job the
/// dictionary did.
final class TapStorageTests: XCTestCase {

    /// A meter and a scope on a constant, so what they record is known.
    private func voice() throws -> CompiledVoice {
        let json = """
        {"inputs":[],"output":{"id":0,"kind":"meter","params":{"id":"out"},"inputs":{
          "input":{"id":1,"kind":"capture","params":{"id":"scope","windowSize":4},"inputs":{
            "input":{"id":2,"kind":"const","params":{"value":0.5},"inputs":{}}}}}}}
        """
        return try CompiledVoice(json: json.data(using: .utf8)!)
    }

    private func render(_ voice: CompiledVoice, _ state: VoiceState, frames: Int) {
        var out = [Float](repeating: 0, count: frames)
        out.withUnsafeMutableBufferPointer { buffer in
            _ = voice.render(state, sampleRate: 48000, frames: frames,
                             outL: buffer.baseAddress!, outR: nil)
        }
    }

    func testBothTapsRecordAndDrain() throws {
        let voice = try self.voice()
        let state = voice.makeState()
        render(voice, state, frames: 8)

        let frame = try XCTUnwrap(state.drainAnalysis())
        XCTAssertEqual(frame.meters["out"]?.peak ?? 0, 0.5, accuracy: 1e-6)
        XCTAssertEqual(frame.meters["out"]?.rms ?? 0, 0.5, accuracy: 1e-6)
        XCTAssertEqual(frame.captures["scope"]?.count, 4, "the ring is the window the node asked for")
        for sample in frame.captures["scope"] ?? [] {
            XCTAssertEqual(sample, 0.5, accuracy: 1e-6)
        }
    }

    func testDrainingResetsTheMeterButKeepsTheSlots() throws {
        let voice = try self.voice()
        let state = voice.makeState()
        render(voice, state, frames: 8)
        _ = state.drainAnalysis()

        // Each frame covers its own interval, so a second drain with nothing
        // rendered in between reads zero rather than the last peak again.
        let second = try XCTUnwrap(state.drainAnalysis())
        XCTAssertEqual(second.meters["out"]?.peak ?? -1, 0, accuracy: 1e-9)

        // And the slots are still there to record into.
        render(voice, state, frames: 8)
        let third = try XCTUnwrap(state.drainAnalysis())
        XCTAssertEqual(third.meters["out"]?.peak ?? 0, 0.5, accuracy: 1e-6)
    }

    func testAGraphWithNoTapsHasNothingToDrain() throws {
        let voice = try CompiledVoice(
            json: #"{"inputs":[],"output":{"id":0,"kind":"const","params":{"value":1},"inputs":{}}}"#
                .data(using: .utf8)!)
        let state = voice.makeState()
        render(voice, state, frames: 4)
        XCTAssertNil(state.drainAnalysis())
    }
}
