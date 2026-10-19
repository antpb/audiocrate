import XCTest
@testable import CrateASL

/// Parameter changes from the editor's thread, applied on the render thread.
///
/// What the AUv3 does with a knob in its own editor: the tree's observer
/// posts, the render block drains at the top of a block and glides. These
/// hold the box to latest-wins, to losing nothing, and to the render side
/// being the only one that ever touches a voice.
final class ParameterInboxTests: XCTestCase {

    func testLatestValueWinsAndEachSlotIsAppliedOnce() {
        let inbox = ParameterInbox(initial: [0, 0, 0])
        inbox.post(2, 0.1)
        inbox.post(0, 0.5)
        inbox.post(2, 0.9)
        var applied = [(Int, Double)]()
        XCTAssertEqual(inbox.drain { applied.append(($0, $1)) }, 2)
        // First-posted order, second value.
        XCTAssertEqual(applied.map(\.0), [2, 0])
        XCTAssertEqual(applied.map(\.1), [0.9, 0.5])
        XCTAssertFalse(inbox.hasPending)
        XCTAssertEqual(inbox.drain { _, _ in XCTFail("drained twice") }, 0)
    }

    func testTheReadoutFollowsBothSides() {
        let inbox = ParameterInbox(initial: [0.25])
        XCTAssertEqual(inbox.value(0), 0.25)
        inbox.post(0, 0.75)
        XCTAssertEqual(inbox.value(0), 0.75, "a knob reads back what it was set to before a block has run")
        inbox.drain { _, _ in }
        inbox.applied(0, 0.4)
        XCTAssertEqual(inbox.value(0), 0.4, "a host's own automation is what the host reads back")
    }

    func testOutOfRangeAndNonFiniteArePostedNowhere() {
        let inbox = ParameterInbox(initial: [0])
        inbox.post(-1, 1)
        inbox.post(1, 1)
        inbox.post(0, .nan)
        inbox.post(0, .infinity)
        XCTAssertFalse(inbox.hasPending)
        XCTAssertEqual(inbox.value(0), 0)
    }

    /// Lots of posting against lots of draining. Nothing is lost: whatever
    /// the last post was, it is what the last drain applied.
    func testNothingIsLostWhileTheRenderThreadDrains() {
        let inbox = ParameterInbox(initial: [0, 0, 0, 0])
        var seen = [Double](repeating: 0, count: 4)
        var drains = 0
        let writer = Thread {
            for i in 1...200_000 { inbox.post(i % 4, Double(i)) }
        }
        writer.start()
        while !writer.isFinished {
            drains += inbox.drain { seen[$0] = $1 } > 0 ? 1 : 0
        }
        while inbox.hasPending { inbox.drain { seen[$0] = $1 } }
        XCTAssertGreaterThan(drains, 0, "the drain never overlapped the writer, so this proved nothing")
        XCTAssertEqual(seen, [200_000, 199_997, 199_998, 199_999])
    }

    /// The thing this is for: a knob drained into a voice glides the way a
    /// host step does, where `VoiceState.setParam` from another thread would
    /// have jumped (and raced).
    func testADrainedKnobGlides() throws {
        let json = """
        {"inputs":["level"],"smooth":["level"],"output":{"id":0,"kind":"param","params":{"name":"level"},"inputs":{}}}
        """
        let voice = try CompiledVoice(json: json.data(using: .utf8)!)
        let pool = VoicePool(voice: voice, polyphony: 1, seed: 1)
        pool.setParams(["level": 0])
        pool.noteOn(note: 60, velocity: 1)
        var out = [Float](repeating: 0, count: 64)
        func block() -> [Float] {
            out.withUnsafeMutableBufferPointer { buffer in
                _ = pool.render(sampleRate: 48000, frames: 64, outL: buffer.baseAddress!, outR: nil)
            }
            return out
        }
        _ = block()

        let inbox = ParameterInbox(initial: [0])
        inbox.post(0, 1)
        inbox.drain { _, value in pool.glideParam("level", value) }
        let moving = block()
        XCTAssertEqual(moving[0], 0)
        XCTAssertLessThan(moving[63], 0.5, "a 5 ms glide is 240 frames at 48 kHz, so 64 in it is a quarter of the way")
        XCTAssertGreaterThan(moving[63], moving[1])
    }
}
