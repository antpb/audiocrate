import XCTest
@testable import CrateASL

/// Does a graph read the same musical time whether or not the host split the
/// block?
///
/// An AUv3 splits a render block at every event so a note lands on its own
/// sample. Each piece is a separate `render` call and `frameIndex` restarts at
/// 0 in each one, so the transport a segment is handed has to be moved forward
/// to where that segment actually starts. `TransportSnapshot.advanced` does
/// that, and it exists next to `evalTransport` because it is the same formula:
/// if one changes and the other does not, a split block quietly plays at a
/// different position from an unsplit one.
///
/// These render `transport` directly as audio, which is what makes the
/// assertion exact rather than approximate. Beats are a smooth ramp, so a
/// segment reading the wrong start shows up as a step in the output.
final class TransportTests: XCTestCase {

    private static let sampleRate = 48_000.0

    /// `{ "output": { "kind": "transport", "params": { "field": "beats" } } }`
    private func beatsVoice() throws -> CompiledVoice {
        let json = """
        {"inputs":[],"output":{"id":1,"kind":"transport","params":{"field":"beats"},"inputs":{}}}
        """.data(using: .utf8)!
        return try CompiledVoice(json: json)
    }

    private func render(
        _ voice: CompiledVoice,
        _ state: VoiceState,
        frames: Int,
        transport: TransportSnapshot?
    ) -> [Float] {
        var out = [Float](repeating: 0, count: frames)
        var right: [Float]? = nil
        out.withUnsafeMutableBufferPointer { buf in
            _ = voice.render(
                state, sampleRate: Self.sampleRate, frames: frames,
                outL: buf.baseAddress!, outR: nil, transport: transport
            )
        }
        _ = right
        return out
    }

    func testASplitBlockPlaysTheSamePositionAsAWholeOne() throws {
        let transport = TransportSnapshot(beats: 8, bpm: 120, playing: true, beatsPerBar: 4, beatUnit: 4)
        let frames = 256
        let split = 91  // deliberately not a power of two, and not on a beat

        let whole = render(try beatsVoice(), try beatsVoice().makeState(), frames: frames, transport: transport)

        let voice = try beatsVoice()
        let state = voice.makeState()
        var pieced = render(voice, state, frames: split, transport: transport)
        pieced += render(
            voice, state, frames: frames - split,
            transport: transport.advanced(bySamples: split, sampleRate: Self.sampleRate)
        )

        XCTAssertEqual(pieced.count, whole.count)
        var worst = 0.0
        var worstIndex = -1
        for i in 0..<frames {
            let diff = abs(Double(pieced[i]) - Double(whole[i]))
            if diff > worst { worst = diff; worstIndex = i }
        }
        // Float32 beats near 8 carry about 5e-7 of resolution, so this is a
        // rounding allowance and not a tolerance for being in the wrong place:
        // forgetting to advance puts the second segment 91 samples behind,
        // which at 120 bpm is 0.0038 beats, four orders of magnitude larger.
        XCTAssertLessThan(worst, 1e-5, "split block diverges at frame \(worstIndex)")
    }

    func testNotAdvancingIsDetectableByThisTest() throws {
        // Proves the assertion above has teeth rather than passing because the
        // graph ignores its transport.
        let transport = TransportSnapshot(beats: 8, bpm: 120, playing: true, beatsPerBar: 4, beatUnit: 4)
        let frames = 256
        let split = 91

        let whole = render(try beatsVoice(), try beatsVoice().makeState(), frames: frames, transport: transport)

        let voice = try beatsVoice()
        let state = voice.makeState()
        var pieced = render(voice, state, frames: split, transport: transport)
        pieced += render(voice, state, frames: frames - split, transport: transport)  // not advanced

        var worst = 0.0
        for i in 0..<frames { worst = max(worst, abs(Double(pieced[i]) - Double(whole[i]))) }
        XCTAssertGreaterThan(worst, 1e-3, "the beats graph is not reading its transport at all")
    }

    func testAStoppedTransportHoldsItsPosition() throws {
        // A paused playhead does not advance, so a synced LFO sits still
        // rather than sweeping under a stopped transport.
        let stopped = TransportSnapshot(beats: 8, bpm: 120, playing: false, beatsPerBar: 4, beatUnit: 4)
        XCTAssertEqual(stopped.advanced(bySamples: 512, sampleRate: Self.sampleRate).beats, 8)

        let out = render(try beatsVoice(), try beatsVoice().makeState(), frames: 64, transport: stopped)
        for value in out { XCTAssertEqual(Double(value), 8, accuracy: 1e-5) }
    }

    func testAdvancingByNothingChangesNothing() throws {
        let transport = TransportSnapshot(beats: 3.5, bpm: 92, playing: true, beatsPerBar: 7, beatUnit: 8)
        XCTAssertEqual(transport.advanced(bySamples: 0, sampleRate: Self.sampleRate).beats, 3.5)
        XCTAssertEqual(transport.advanced(bySamples: 128, sampleRate: 0).beats, 3.5)
        // The signature travels untouched: it is not a function of position.
        let moved = transport.advanced(bySamples: 128, sampleRate: Self.sampleRate)
        XCTAssertEqual(moved.beatsPerBar, 7)
        XCTAssertEqual(moved.beatUnit, 8)
        XCTAssertEqual(moved.bpm, 92)
    }
}
