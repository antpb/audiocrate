import XCTest
@testable import CrateASL

/// Voice allocation, and the one thing an in-process pool needs that an
/// outboard one does not.
///
/// The allocation order is ported from `voices/allocate.ts` rule for rule and
/// the order is the whole design, so it is asserted rule by rule rather than
/// by playing a chord and hoping.
final class VoicePoolTests: XCTestCase {

    private func slots(_ specs: [(note: Int?, held: Bool, velocity: Double, startedAt: Int)]) -> [VoiceSnapshot] {
        specs.enumerated().map { index, s in
            VoiceSnapshot(index: index, note: s.note, velocity: s.velocity, startedAt: s.startedAt, held: s.held)
        }
    }

    func testRetriggerBeatsEverything() {
        // A repeated note reuses its own voice rather than stacking a second
        // copy of itself, which is what stops a trill turning into a drone.
        let s = slots([(60, true, 1, 1), (nil, false, 0, 0), (64, true, 1, 2)])
        XCTAssertEqual(allocateSlot(s, note: 60, policy: .oldest), 0)
    }

    func testIdleBeatsAReleasingTail() {
        // A tail is only cut when there is nothing free.
        let s = slots([(60, false, 1, 1), (nil, false, 0, 0)])
        XCTAssertEqual(allocateSlot(s, note: 67, policy: .oldest), 1)
    }

    func testTheOldestTailGoesBeforeAnyHeldNote() {
        let s = slots([(60, true, 1, 5), (62, false, 1, 3), (64, false, 1, 2)])
        XCTAssertEqual(allocateSlot(s, note: 67, policy: .oldest), 2)
    }

    func testStealingOldestWhenEveryKeyIsDown() {
        let s = slots([(60, true, 1, 7), (62, true, 1, 3), (64, true, 1, 9)])
        XCTAssertEqual(allocateSlot(s, note: 67, policy: .oldest), 1)
    }

    func testStealingQuietestPrefersTheLowestVelocity() {
        let s = slots([(60, true, 0.9, 1), (62, true, 0.2, 2), (64, true, 0.5, 3)])
        XCTAssertEqual(allocateSlot(s, note: 67, policy: .quietest), 1)
        // Ties fall back to oldest, so a chord struck evenly still steals in
        // a defined order rather than whichever the array happened to hold.
        let tied = slots([(60, true, 0.5, 4), (62, true, 0.5, 2), (64, true, 0.5, 9)])
        XCTAssertEqual(allocateSlot(tied, note: 67, policy: .quietest), 1)
    }

    // MARK: - The pool itself

    /// `osc(note) * adsr`, the smallest graph that is actually polyphonic.
    private func synth() throws -> CompiledVoice {
        let json = """
        {"inputs":[],"output":{"id":9,"kind":"mul","params":{},"inputs":{
          "a":{"id":4,"kind":"osc","params":{"type":"saw"},"inputs":{
            "freq":{"id":3,"kind":"toFrequency","params":{},"inputs":{
              "note":{"id":2,"kind":"param","params":{"name":"note"},"inputs":{}}}}}},
          "b":{"id":8,"kind":"adsr","params":{"a":0.001,"d":0.01,"s":0.8,"r":0.02},"inputs":{
            "trigger":{"id":7,"kind":"param","params":{"name":"velocity"},"inputs":{}}}}}}}
        """.data(using: .utf8)!
        return try CompiledVoice(json: json)
    }

    private func renderPeak(_ pool: VoicePool, frames: Int = 256, blocks: Int = 1) -> (peak: Float, rendered: Int) {
        var out = [Float](repeating: 0, count: frames)
        var rendered = 0
        var peak: Float = 0
        out.withUnsafeMutableBufferPointer { buf in
            for _ in 0..<blocks {
                rendered = pool.render(sampleRate: 48000, frames: frames, outL: buf.baseAddress!, outR: nil)
                for v in buf { peak = max(peak, abs(v)) }
            }
        }
        return (peak, rendered)
    }

    func testAChordIsLouderThanOneNote() throws {
        let pool = VoicePool(voice: try synth(), polyphony: 8)
        pool.noteOn(note: 57, velocity: 1)
        let single = renderPeak(pool, blocks: 4).peak

        pool.noteOn(note: 61, velocity: 1)
        pool.noteOn(note: 64, velocity: 1)
        let chord = renderPeak(pool, blocks: 4)

        XCTAssertEqual(chord.rendered, 3)
        XCTAssertGreaterThan(chord.peak, single * 1.5, "three voices should sum")
    }

    func testIdleVoicesCostNothing() throws {
        let pool = VoicePool(voice: try synth(), polyphony: 8)
        XCTAssertEqual(renderPeak(pool).rendered, 0, "an untouched pool renders no voices")

        pool.noteOn(note: 60, velocity: 1)
        XCTAssertEqual(renderPeak(pool).rendered, 1, "one note should cost one voice, not eight")
    }

    /// The reason this pool differs from the JavaScript one. There, a quiet
    /// voice is a worklet nobody pulls. Here it is eight graphs' worth of
    /// arithmetic per block, produced for silence, unless the tail is retired.
    func testAFinishedTailStopsBeingRendered() throws {
        let pool = VoicePool(voice: try synth(), polyphony: 8)
        pool.noteOn(note: 60, velocity: 1)
        XCTAssertEqual(renderPeak(pool).rendered, 1)

        pool.noteOff(note: 60)
        // The release is 20 ms; a second of blocks is far past it.
        _ = renderPeak(pool, blocks: 200)
        XCTAssertEqual(renderPeak(pool).rendered, 0, "a dead tail should have been retired")
        XCTAssertEqual(pool.activeVoiceCount, 0)
    }

    /// A held note at zero sustain is silent and very much alive. Retiring on
    /// silence alone would kill it and the key would stop responding.
    func testAHeldSilentVoiceIsNeverRetired() throws {
        let json = """
        {"inputs":[],"output":{"id":3,"kind":"mul","params":{},"inputs":{
          "a":{"id":1,"kind":"const","params":{"value":0},"inputs":{}},
          "b":{"id":2,"kind":"param","params":{"name":"note"},"inputs":{}}}}}
        """.data(using: .utf8)!
        let pool = VoicePool(voice: try CompiledVoice(json: json), polyphony: 4)
        pool.noteOn(note: 60, velocity: 1)
        _ = renderPeak(pool, blocks: 50)
        XCTAssertEqual(pool.activeVoiceCount, 1, "a key still down keeps its voice")
    }

    func testAllNotesOffFreesEverything() throws {
        let pool = VoicePool(voice: try synth(), polyphony: 8)
        for note in [60, 64, 67, 71] { pool.noteOn(note: note, velocity: 1) }
        XCTAssertEqual(pool.activeVoiceCount, 4)
        pool.allNotesOff()
        XCTAssertEqual(pool.activeVoiceCount, 0)
        XCTAssertEqual(renderPeak(pool).rendered, 0)
    }

    func testEachVoiceKeepsItsOwnState() throws {
        // Two notes an octave apart must not share an oscillator phase or a
        // filter's delay line. Summed, they beat; sharing, they would not.
        let pool = VoicePool(voice: try synth(), polyphony: 2)
        pool.noteOn(note: 45, velocity: 1)
        pool.noteOn(note: 57, velocity: 1)
        var out = [Float](repeating: 0, count: 2048)
        out.withUnsafeMutableBufferPointer { buf in
            _ = pool.render(sampleRate: 48000, frames: 2048, outL: buf.baseAddress!, outR: nil)
        }
        // A saw at 110 Hz summed with one at 220 Hz is not a saw: its period
        // is the lower note's, and its shape within that period is not
        // monotonic the way a single saw's is.
        var risesWithinPeriod = 0
        let period = Int(48000.0 / 110.0)
        for i in 1..<period where out[i] < out[i - 1] { risesWithinPeriod += 1 }
        XCTAssertGreaterThan(risesWithinPeriod, 1, "two independent oscillators should not sum to one saw")
    }
}
