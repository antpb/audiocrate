import XCTest
@testable import CrateASL

/// Does a self-playing patch keep playing under a host whose beat position is
/// coarse or stuck?
///
/// The failure this guards: homecrate's recorder refreshed the beat it hands
/// an AUv3 on a 50 Hz timer, and never when no audio track was playing. With
/// the beat stuck at 0, frame 0 of every block read as a downbeat, a Synced
/// Clock fired once a block, the Pulse after it never fell, and every
/// self-playing factory patch played one note at Play and then nothing.
///
/// The reference is a host that reports its true position every block. A
/// follower fed a stuck or stale host has to render the same samples as that.
final class TransportFollowerTests: XCTestCase {

    private static let sampleRate = 48_000.0
    private static let block = 256
    private static let bpm = 120.0

    // MARK: - The follower on its own

    func testAStuckHostIsCountedForward() {
        var follower = TransportFollower()
        let host = TransportSnapshot(beats: 0, bpm: Self.bpm, playing: true)
        let perBlock = Double(Self.block) * Self.bpm / 60 / Self.sampleRate
        for index in 0..<10 {
            let out = follower.follow(host, frames: Self.block, sampleRate: Self.sampleRate)
            XCTAssertEqual(out.beats, Double(index) * perBlock, accuracy: 1e-9)
        }
    }

    func testPlayAnchorsToWhereTheHostIs() {
        var follower = TransportFollower()
        let out = follower.follow(
            TransportSnapshot(beats: 16, bpm: Self.bpm, playing: true),
            frames: Self.block, sampleRate: Self.sampleRate
        )
        XCTAssertEqual(out.beats, 16)
    }

    func testASeekOrLoopWrapIsFollowed() {
        var follower = TransportFollower()
        _ = follower.follow(TransportSnapshot(beats: 15.9, bpm: Self.bpm, playing: true), frames: Self.block, sampleRate: Self.sampleRate)
        // A loop back to the top: new, and far from the count.
        let wrapped = follower.follow(TransportSnapshot(beats: 0, bpm: Self.bpm, playing: true), frames: Self.block, sampleRate: Self.sampleRate)
        XCTAssertEqual(wrapped.beats, 0)
    }

    func testASlowRefreshIsNotTakenAsAJump() {
        var follower = TransportFollower()
        _ = follower.follow(TransportSnapshot(beats: 4, bpm: Self.bpm, playing: true), frames: Self.block, sampleRate: Self.sampleRate)
        // A refresh 20 ms behind the count is a late timer, not a seek.
        let late = 4 + Double(Self.block) * Self.bpm / 60 / Self.sampleRate - 0.04
        let out = follower.follow(TransportSnapshot(beats: late, bpm: Self.bpm, playing: true), frames: Self.block, sampleRate: Self.sampleRate)
        XCTAssertEqual(out.beats, 4 + Double(Self.block) * Self.bpm / 60 / Self.sampleRate, accuracy: 1e-9)
    }

    func testStopHoldsTheHostAndTheNextPlayReanchors() {
        var follower = TransportFollower()
        _ = follower.follow(TransportSnapshot(beats: 8, bpm: Self.bpm, playing: true), frames: Self.block, sampleRate: Self.sampleRate)
        let stopped = follower.follow(TransportSnapshot(beats: 8.3, bpm: Self.bpm, playing: false), frames: Self.block, sampleRate: Self.sampleRate)
        XCTAssertEqual(stopped.beats, 8.3)
        XCTAssertFalse(stopped.playing)
        let again = follower.follow(TransportSnapshot(beats: 2, bpm: Self.bpm, playing: true), frames: Self.block, sampleRate: Self.sampleRate)
        XCTAssertEqual(again.beats, 2)
    }

    // MARK: - Factory patches, end to end

    /// The factory patches that play with no notes: a Transport in the patch
    /// and nothing that reads a keyboard.
    private func selfPlaying() throws -> [(FactoryLibrary.Entry, CompiledMaterialDocument)] {
        let library = try FactoryLibrary.bundled()
        let catalog = try MaterialCatalog.bundled()
        var found = [(FactoryLibrary.Entry, CompiledMaterialDocument)]()
        for entry in library.patches {
            let kinds = Set(entry.patch.nodes.map(\.kind))
            guard kinds.contains(catalog.io.transport), !kinds.contains(catalog.io.keyboard) else { continue }
            let compiled = try CrateFlatten.flatten(entry.patch, catalog: catalog, name: entry.name)
            guard !compiled.isInstrument else { continue }
            found.append((entry, compiled))
        }
        return found
    }

    /// Renders `seconds` of a patch the way the AU does: one effect state,
    /// gate open, one snapshot per block from `host`, optionally through a
    /// follower.
    private func render(
        _ document: CompiledMaterialDocument,
        seconds: Double,
        follow: Bool,
        host: (_ blockIndex: Int, _ trueBeats: Double) -> TransportSnapshot
    ) throws -> [Float] {
        let voice = try CompiledVoice(document: document.graph)
        let state = voice.makeState(seed: 1234)
        state.setParams(ParameterMap(document.params).defaults)
        state.gate = true
        var follower = TransportFollower()
        let total = Int(Self.sampleRate * seconds)
        var out = [Float](repeating: 0, count: total)
        var scratch = [Float](repeating: 0, count: Self.block)
        let perBlock = Double(Self.block) * Self.bpm / 60 / Self.sampleRate
        var index = 0
        var written = 0
        while written < total {
            let frames = min(Self.block, total - written)
            var snapshot = host(index, Double(index) * perBlock)
            if follow {
                snapshot = follower.follow(snapshot, frames: frames, sampleRate: Self.sampleRate)
            }
            scratch.withUnsafeMutableBufferPointer { buf in
                _ = voice.render(
                    state, sampleRate: Self.sampleRate, frames: frames,
                    outL: buf.baseAddress!, outR: nil, transport: snapshot
                )
            }
            for i in 0..<frames { out[written + i] = scratch[i] }
            written += frames
            index += 1
        }
        return out
    }

    private func accurate(_ index: Int, _ beats: Double) -> TransportSnapshot {
        TransportSnapshot(beats: beats, bpm: Self.bpm, playing: true)
    }

    private func stuck(_ index: Int, _ beats: Double) -> TransportSnapshot {
        TransportSnapshot(beats: 0, bpm: Self.bpm, playing: true)
    }

    /// The recorder's 50 Hz timer: a fresh value roughly every fourth block,
    /// a block late.
    private func stale(_ index: Int, _ beats: Double) -> TransportSnapshot {
        let refreshed = max(0, (index / 4) * 4 - 1)
        let perBlock = Double(Self.block) * Self.bpm / 60 / Self.sampleRate
        return TransportSnapshot(beats: Double(refreshed) * perBlock, bpm: Self.bpm, playing: true)
    }

    private func worstDifference(_ a: [Float], _ b: [Float]) -> Float {
        zip(a, b).reduce(0) { max($0, abs($1.0 - $1.1)) }
    }

    private func peak(_ samples: ArraySlice<Float>) -> Float {
        samples.reduce(0) { max($0, abs($1)) }
    }

    func testThereAreSelfPlayingPatchesToCheck() throws {
        XCTAssertGreaterThanOrEqual(try selfPlaying().count, 5)
    }

    /// A host that reports its true position every block is passed through
    /// exactly, so following it changes nothing a sample-accurate DAW plays.
    func testFollowingAnAccurateHostChangesNothing() throws {
        var failures = [String]()
        for (entry, document) in try selfPlaying() {
            let raw = try render(document, seconds: 4, follow: false, host: accurate)
            // It has to keep playing, or matching it proves nothing: sound in
            // the last second, well after the first note.
            if peak(raw[Int(Self.sampleRate * 3)...]) < 1e-3 {
                failures.append("\(entry.id): silent after the first note even under an accurate host")
                continue
            }
            let followed = try render(document, seconds: 4, follow: true, host: accurate)
            let diff = worstDifference(raw, followed)
            if diff != 0 { failures.append("\(entry.id): differs by \(diff)") }
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testAStuckHostPlaysTheSameAsAnAccurateOne() throws {
        var failures = [String]()
        for (entry, document) in try selfPlaying() {
            let reference = try render(document, seconds: 4, follow: true, host: accurate)
            let followed = try render(document, seconds: 4, follow: true, host: stuck)
            // One sample of rounding at a division boundary, from summing
            // block lengths where the accurate host multiplies, is the only
            // difference allowed. A missed or doubled clock is a whole note.
            let diff = shiftTolerantDifference(reference, followed)
            if diff > 0.05 { failures.append("\(entry.id): stuck host differs by \(diff)") }
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testAStaleHostPlaysTheSameAsAnAccurateOne() throws {
        var failures = [String]()
        for (entry, document) in try selfPlaying() {
            let reference = try render(document, seconds: 4, follow: true, host: accurate)
            let followed = try render(document, seconds: 4, follow: true, host: stale)
            let diff = shiftTolerantDifference(reference, followed)
            if diff > 0.05 { failures.append("\(entry.id): stale host differs by \(diff)") }
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    /// Proves the two tests above have teeth: without the follower, a stuck
    /// host is the one-note failure for every patch clocked from the song.
    func testWithoutTheFollowerAStuckHostIsTheOneNoteFailure() throws {
        let clocked = try selfPlaying().filter { entry, _ in
            entry.patch.nodes.contains { $0.kind == "syncedclock" }
        }
        XCTAssertFalse(clocked.isEmpty)
        for (entry, document) in clocked {
            let reference = try render(document, seconds: 4, follow: false, host: accurate)
            let raw = try render(document, seconds: 4, follow: false, host: stuck)
            XCTAssertGreaterThan(shiftTolerantDifference(reference, raw), 0.05, entry.id)
        }
    }

    /// Worst difference between 10 ms RMS windows. Blind to a one-sample
    /// shift of an envelope, and not to a note that is missing or extra.
    private func shiftTolerantDifference(_ a: [Float], _ b: [Float]) -> Float {
        let window = 480
        var worst: Float = 0
        var start = 0
        while start + window <= min(a.count, b.count) {
            var sa: Float = 0, sb: Float = 0
            for i in start..<(start + window) { sa += a[i] * a[i]; sb += b[i] * b[i] }
            worst = max(worst, abs((sa / Float(window)).squareRoot() - (sb / Float(window)).squareRoot()))
            start += window
        }
        return worst
    }
}
