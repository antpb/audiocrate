import XCTest
@testable import CrateASL

/// Whether a split instrument renders what its patch means: voices summed
/// into the effects after them, once. The Swift half of
/// `editor/test/voicing.test.ts`; `FlattenConformanceTests` already holds the
/// graphs to the JavaScript ones, so these are about the render.
final class VoicingTests: XCTestCase {

    static let sampleRate = 48000.0
    static let frames = 256

    /// keys -> oscillator -> lowpass -> reverb -> gain [-> limiter] -> master,
    /// with `instanced` naming modules flagged to run per voice.
    static func patch(limiter: Bool, instanced: Set<String> = []) -> CratePatch {
        func node(_ id: String, _ kind: String, _ params: [String: Double] = [:]) -> CratePatchNode {
            CratePatchNode(id: id, kind: kind, params: params, voicing: instanced.contains(id) ? .instanced : nil)
        }
        func wire(_ s: String, _ so: String, _ t: String, _ ti: String) -> CratePatchConnection {
            CratePatchConnection(source: s, sourceOutput: so, target: t, targetInput: ti)
        }
        var nodes = [
            node("keys", "keyboard"),
            node("osc", "oscillator", ["attack": 0.002, "decay": 1.1, "gain": 0.34, "release": 0.4, "sustain": 0.15, "type": 5, "width": 0.3]),
            node("lp", "lowpass", ["cutoff": 1597, "q": 4.8]),
            node("rev", "reverb", ["damp": 5000, "decay": 0.55, "mix": 0.22, "size": 0.7]),
            node("lvl", "gain", ["gain": 0.27]),
            node("out", "master"),
        ]
        var wires = [
            wire("keys", "cv", "osc", "note"),
            wire("keys", "gate", "osc", "gate"),
            wire("osc", "audio", "lp", "input"),
            wire("lp", "audio", "rev", "input"),
            wire("rev", "audio", "lvl", "input"),
        ]
        if limiter {
            nodes.insert(node("lim", "limiter", ["attack": 0.002, "release": 0.08, "threshold": 0.6]), at: 5)
            wires += [wire("lvl", "audio", "lim", "input"), wire("lim", "audio", "out", "input")]
        } else {
            wires.append(wire("lvl", "audio", "out", "input"))
        }
        return CratePatch(nodes: nodes, connections: wires)
    }

    static func flatten(_ patch: CratePatch) throws -> CompiledMaterialDocument {
        try CrateFlatten.flatten(patch, catalog: MaterialCatalog.bundled(), role: .instrument)
    }

    /// `notes` held for half of `blocks`, then released, through a pool.
    static func render(_ compiled: CompiledMaterialDocument, notes: [Int], blocks: Int = 60) throws -> [Float] {
        let voice = try CompiledVoice(document: compiled.graph)
        let pool = VoicePool(voice: voice, polyphony: 8, seed: 7)
        pool.setParams(ParameterMap(compiled.params).defaults)
        for note in notes { pool.noteOn(note: note, velocity: 0.8) }
        var all = [Float]()
        var left = [Float](repeating: 0, count: frames)
        for block in 0..<blocks {
            if block == blocks / 2 { for note in notes { pool.noteOff(note: note) } }
            left.withUnsafeMutableBufferPointer { l in
                _ = pool.render(sampleRate: sampleRate, frames: frames, outL: l.baseAddress!, outR: nil)
            }
            all += left
        }
        return all
    }

    static func maxDiff(_ a: [Float], _ b: [Float]) -> Float {
        zip(a, b).reduce(0) { max($0, abs($1.0 - $1.1)) }
    }
    static func peak(_ a: [Float]) -> Float { a.reduce(0) { max($0, abs($1)) } }

    static let everythingPerVoice: Set<String> = ["lp", "rev", "lvl", "lim"]

    func testTheChainAfterTheOscillatorIsSplitOffIntoABus() throws {
        let compiled = try Self.flatten(Self.patch(limiter: true))
        XCTAssertNotNil(compiled.graph.bus)
        XCTAssertEqual(compiled.graph.sends?.count, 1)
        let voice = try CompiledVoice(document: compiled.graph)
        XCTAssertEqual(voice.sendCount, 1)
        XCTAssertNotNil(voice.bus)

        let whole = try Self.flatten(Self.patch(limiter: true, instanced: Self.everythingPerVoice))
        XCTAssertNil(whole.graph.bus, "everything per voice is the old single graph")
    }

    func testOneVoiceSoundsTheSameSplitOrNot() throws {
        let split = try Self.render(Self.flatten(Self.patch(limiter: true)), notes: [57])
        let whole = try Self.render(Self.flatten(Self.patch(limiter: true, instanced: Self.everythingPerVoice)), notes: [57])
        XCTAssertGreaterThan(Self.peak(split), 0.01)
        // Float rounding at the send, where a Double becomes a Float sample.
        XCTAssertLessThan(Self.maxDiff(split, whole), 1e-5)
    }

    func testAChordThroughALinearChainEqualsPerVoiceCopies() throws {
        let chord = [48, 55, 60, 64]
        let split = try Self.render(Self.flatten(Self.patch(limiter: false)), notes: chord)
        let whole = try Self.render(Self.flatten(Self.patch(limiter: false, instanced: Self.everythingPerVoice)), notes: chord)
        XCTAssertGreaterThan(Self.peak(split), 0.01)
        XCTAssertLessThan(Self.maxDiff(split, whole), 1e-4)
    }

    func testTheReverbTailOutlivesTheVoices() throws {
        // Voices retire on their own signal; the reverb's tail is the bus's
        // and must keep sounding after they are gone.
        let compiled = try Self.flatten(Self.patch(limiter: false))
        let voice = try CompiledVoice(document: compiled.graph)
        let pool = VoicePool(voice: voice, polyphony: 8, seed: 7)
        pool.setParams(ParameterMap(compiled.params).defaults)
        pool.noteOn(note: 60, velocity: 1)
        var left = [Float](repeating: 0, count: Self.frames)
        func block() -> Float {
            left.withUnsafeMutableBufferPointer { l in
                _ = pool.render(sampleRate: Self.sampleRate, frames: Self.frames, outL: l.baseAddress!, outR: nil)
            }
            return Self.peak(left)
        }
        for _ in 0..<20 { _ = block() }
        pool.noteOff(note: 60)
        var tailAfterRetire: Float = 0
        for _ in 0..<400 {
            let p = block()
            if pool.activeVoiceCount == 0 { tailAfterRetire = max(tailAfterRetire, p) }
        }
        XCTAssertEqual(pool.activeVoiceCount, 0, "the voice should retire once its own signal is gone")
        XCTAssertGreaterThan(tailAfterRetire, 0, "the bus keeps the tail after the voice retires")
    }

    func testThePatchFlagRoundTrips() throws {
        let patch = Self.patch(limiter: true, instanced: ["rev"])
        let decoded = try CratePatch.decode(patch.encoded())
        XCTAssertEqual(decoded.node("rev")?.voicing, .instanced)
        XCTAssertNil(decoded.node("lp")?.voicing)
    }

    /// How far each factory instrument moved from its old all-per-voice
    /// sound, as a chord: the worst sample difference relative to its peak,
    /// and which modules are now summed. Opt-in (CRATE_VOICING_REPORT=1); a
    /// report for a person, not an assertion.
    func testFactoryVoicingReport() throws {
        guard ProcessInfo.processInfo.environment["CRATE_VOICING_REPORT"] != nil else {
            throw XCTSkip("set CRATE_VOICING_REPORT=1 for the per-preset report")
        }
        let catalog = try MaterialCatalog.bundled()
        var lines = ["", "preset             note-diff  chord-diff  summed modules"]
        for entry in try FactoryLibrary.bundled().patches {
            let split = try CrateFlatten.flatten(entry.patch, catalog: catalog, name: entry.name)
            guard split.isInstrument, split.graph.bus != nil else { continue }
            var whole = entry.patch
            for i in whole.nodes.indices { whole.nodes[i].voicing = .instanced }
            let old = try CrateFlatten.flatten(whole, catalog: catalog, name: entry.name)
            func rel(_ notes: [Int]) throws -> Float {
                let a = try Self.render(split, notes: notes, blocks: 120)
                let b = try Self.render(old, notes: notes, blocks: 120)
                return Self.maxDiff(a, b) / max(Self.peak(b), 1e-9)
            }
            let plan = CrateFlatten.voicingPlan(entry.patch, catalog: catalog)
            let summed = entry.patch.nodes.filter { plan?.role[$0.id] == .summed }.map { "\($0.kind)" }
            lines.append(String(
                format: "%-16@ one %7.4f  chord %7.4f   %@",
                entry.id as NSString, try rel([57]), try rel([48, 55, 60, 64]),
                summed.joined(separator: ", ") as NSString
            ))
        }
        print(lines.joined(separator: "\n") + "\n")
    }
}
