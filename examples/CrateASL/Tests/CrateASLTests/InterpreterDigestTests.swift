import XCTest
@testable import CrateASL

/// Did an interpreter change move a single bit of audio.
///
/// `ConformanceTests` holds Swift to JavaScript within a tolerance, which is
/// the right bar between two languages and the wrong one for a speed change
/// inside one: a refactor that only reorders work must render the identical
/// samples. This renders every conformance graph, every factory patch (as a
/// chord through a `VoicePool` for an instrument, over the fixture input for
/// an effect), and a reverb-heavy instrument, and hashes the raw float bits.
///
/// Opt-in, so a normal `swift test` is unaffected:
///
///   CRATE_DIGEST_OUT=/path/before.json swift test --filter InterpreterDigestTests
///   CRATE_DIGEST_EXPECT=/path/before.json swift test --filter InterpreterDigestTests
///
/// The second run fails, naming every graph whose audio moved.
final class InterpreterDigestTests: XCTestCase {

    /// FNV-1a over the bit patterns, so -0 and 0, or two NaNs, are not
    /// silently equal the way a float comparison would make them.
    struct Digest {
        var value: UInt64 = 0xcbf29ce484222325
        mutating func add(_ samples: UnsafeBufferPointer<Float>) {
            for s in samples {
                var bits = s.bitPattern
                for _ in 0..<4 {
                    value ^= UInt64(bits & 0xff)
                    value = value &* 0x100000001b3
                    bits >>= 8
                }
            }
        }
        mutating func add(_ samples: [Float]) { samples.withUnsafeBufferPointer { add($0) } }
    }

    /// keys -> oscillator -> lowpass -> reverb -> gain -> limiter, the patch
    /// whose reverb-per-voice cost started this.
    static let reverbInstrument = """
    {"kind":"crate.patch","version":1,
     "nodes":[
      {"id":"keys","kind":"keyboard","params":{},"x":40,"y":40},
      {"id":"osc","kind":"oscillator","params":{"attack":0.002,"decay":1.115081491907315,"gain":0.34,"release":0.4,"sustain":0.15,"type":5,"width":0.3},"x":260,"y":40},
      {"id":"lp","kind":"lowpass","params":{"cutoff":1597.1036245608243,"q":4.826984083652496},"x":480,"y":40},
      {"id":"rev","kind":"reverb","params":{"damp":5000,"decay":0.55,"mix":0.22,"size":0.7},"x":700,"y":40},
      {"id":"lvl","kind":"gain","params":{"gain":0.27336862683296204},"x":920,"y":40},
      {"id":"lim","kind":"limiter","params":{"attack":0.002,"release":0.08,"threshold":0.6},"x":1140,"y":40},
      {"id":"out","kind":"master","params":{},"x":1360,"y":40}],
     "connections":[
      {"source":"keys","sourceOutput":"cv","target":"osc","targetInput":"note"},
      {"source":"keys","sourceOutput":"gate","target":"osc","targetInput":"gate"},
      {"source":"osc","sourceOutput":"audio","target":"lp","targetInput":"input"},
      {"source":"lp","sourceOutput":"audio","target":"rev","targetInput":"input"},
      {"source":"rev","sourceOutput":"audio","target":"lvl","targetInput":"input"},
      {"source":"lvl","sourceOutput":"audio","target":"lim","targetInput":"input"},
      {"source":"lim","sourceOutput":"audio","target":"out","targetInput":"input"}]}
    """

    static let sampleRate = 48000.0
    static let frames = 256

    /// A chord held for a second, released, and its tails rendered for a
    /// second more: attacks, steady state, releases and voice retirement.
    static func renderInstrument(_ compiled: CompiledMaterialDocument) throws -> UInt64 {
        let voice = try CompiledVoice(document: compiled.graph)
        let pool = VoicePool(voice: voice, polyphony: compiled.polyphony ?? 8, seed: 7)
        pool.setParams(ParameterMap(compiled.params).defaults)
        var digest = Digest()
        var left = [Float](repeating: 0, count: frames)
        var right = [Float](repeating: 0, count: frames)
        let blocksPerSecond = Int(sampleRate) / frames
        let notes = [48, 55, 60, 64]
        for n in notes { pool.noteOn(note: n, velocity: 0.8) }
        for block in 0..<(2 * blocksPerSecond) {
            if block == blocksPerSecond { for n in notes { pool.noteOff(note: n) } }
            left.withUnsafeMutableBufferPointer { l in
                right.withUnsafeMutableBufferPointer { r in
                    _ = pool.render(sampleRate: sampleRate, frames: frames, outL: l.baseAddress!, outR: r.baseAddress!)
                }
            }
            digest.add(left)
            digest.add(right)
        }
        return digest.value
    }

    static func renderEffect(_ graph: ASLGraphDocument, input: [Float], inputR: [Float], params: [String: Double]) throws -> UInt64 {
        let voice = try CompiledVoice(document: graph)
        let state = voice.makeState(seed: 7)
        state.setParams(params)
        state.gate = true
        var digest = Digest()
        var output = [Float](repeating: 0, count: input.count)
        var right: [Float]? = [Float](repeating: 0, count: input.count)
        for _ in 0..<24 {
            let wroteRight = voice.renderBlock(
                state, sampleRate: sampleRate, output: &output,
                input: input, inputR: inputR, outputR: &right
            )
            digest.add(output)
            if wroteRight, let right { digest.add(right) }
        }
        return digest.value
    }

    static func allDigests() throws -> [String: String] {
        var out = [String: String]()
        func put(_ name: String, _ value: UInt64) { out[name] = String(format: "%016llx", value) }

        // Every conformance graph, the way ConformanceTests renders them.
        let fixture = try ConformanceTests.loadFixture()
        let input = fixture.input.map { Float($0) }
        let inputR = fixture.inputR.map { Float($0) }
        for testCase in fixture.cases {
            let voice = try CompiledVoice(document: testCase.graph)
            let state = voice.makeState()
            state.setParams(fixture.params)
            voice.noteOn(state)
            var digest = Digest()
            var output = [Float](repeating: 0, count: fixture.frames)
            var right: [Float]? = [Float](repeating: 0, count: fixture.frames)
            for block in 0..<fixture.blocks {
                let wroteRight = voice.renderBlock(
                    state, sampleRate: fixture.sampleRate, output: &output,
                    input: testCase.insert ? input : nil,
                    inputR: testCase.insert ? inputR : nil,
                    outputR: &right,
                    transport: ConformanceTests.transport(forBlock: block, fixture)
                )
                digest.add(output)
                if wroteRight, let right { digest.add(right) }
            }
            put("case:\(testCase.name)", digest.value)
        }

        // Every factory patch, flattened the way the plugin flattens it.
        let catalog = try MaterialCatalog.bundled()
        let library = try FactoryLibrary.bundled()
        let blockInput = Array(input.prefix(frames))
        let blockInputR = Array(inputR.prefix(frames))
        for entry in library.patches {
            let compiled = try CrateFlatten.flatten(entry.patch, catalog: catalog, name: entry.name)
            if compiled.isInstrument {
                put("factory:\(entry.id)", try renderInstrument(compiled))
            } else {
                let params = ParameterMap(compiled.params).defaults
                put("factory:\(entry.id)", try renderEffect(compiled.graph, input: blockInput, inputR: blockInputR, params: params))
            }
        }

        let patch = try CratePatch.decode(Data(reverbInstrument.utf8))
        put("patch:reverbInstrument", try renderInstrument(CrateFlatten.flatten(patch, catalog: catalog)))
        return out
    }

    func testAudioDigestsMatchTheRecordedBaseline() throws {
        let env = ProcessInfo.processInfo.environment
        let outPath = env["CRATE_DIGEST_OUT"]
        let expectPath = env["CRATE_DIGEST_EXPECT"]
        guard outPath != nil || expectPath != nil else {
            throw XCTSkip("set CRATE_DIGEST_OUT to record or CRATE_DIGEST_EXPECT to compare")
        }
        let digests = try Self.allDigests()
        if let outPath {
            let data = try JSONSerialization.data(withJSONObject: digests, options: [.sortedKeys, .prettyPrinted])
            try data.write(to: URL(fileURLWithPath: outPath))
            print("recorded \(digests.count) digests to \(outPath)")
        }
        if let expectPath {
            let data = try Data(contentsOf: URL(fileURLWithPath: expectPath))
            let expected = try JSONSerialization.jsonObject(with: data) as! [String: String]
            let moved = expected.keys.filter { digests[$0] != expected[$0] }.sorted()
            let missing = Set(digests.keys).symmetricDifference(expected.keys).sorted()
            XCTAssertTrue(missing.isEmpty, "graphs present in only one run: \(missing)")
            XCTAssertTrue(moved.isEmpty, "\(moved.count) of \(expected.count) graphs rendered different bits: \(moved)")
            print("compared \(expected.count) digests, \(moved.count) moved")
        }
    }

    /// The traced patch, 1 / 4 / 8 voices held, 256 frames at 48 kHz.
    func testReverbInstrumentCost() throws {
        guard ProcessInfo.processInfo.environment["CRATE_BENCH"] != nil else {
            throw XCTSkip("set CRATE_BENCH=1 to time the reverb instrument")
        }
        let catalog = try MaterialCatalog.bundled()
        let compiled = try CrateFlatten.flatten(CratePatch.decode(Data(Self.reverbInstrument.utf8)), catalog: catalog)
        let voice = try CompiledVoice(document: compiled.graph)
        let defaults = ParameterMap(compiled.params).defaults
        let frames = Self.frames
        let quantumMs = Double(frames) / Self.sampleRate * 1000
        var lines = ["", "=== reverb instrument, \(frames) frames at 48 kHz (\(String(format: "%.2f", quantumMs)) ms quantum) ==="]
        for voices in [1, 4, 8] {
            let pool = VoicePool(voice: voice, polyphony: 8, seed: 7)
            pool.setParams(defaults)
            for n in 0..<voices { pool.noteOn(note: 48 + n * 4, velocity: 1) }
            var out = [Float](repeating: 0, count: frames)
            let blocks = Int(4.0 * Self.sampleRate) / frames
            var best = Double.infinity
            out.withUnsafeMutableBufferPointer { buf in
                for _ in 0..<200 { _ = pool.render(sampleRate: Self.sampleRate, frames: frames, outL: buf.baseAddress!, outR: nil) }
                for _ in 0..<5 {
                    let started = DispatchTime.now().uptimeNanoseconds
                    for _ in 0..<blocks { _ = pool.render(sampleRate: Self.sampleRate, frames: frames, outL: buf.baseAddress!, outR: nil) }
                    best = min(best, Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6 / Double(blocks))
                }
            }
            lines.append(String(format: "  %d voice%@  %7.4f ms/block  %5.1f%% of the quantum",
                                voices, voices == 1 ? " " : "s", best, 100 * best / quantumMs))
        }
        print(lines.joined(separator: "\n") + "\n")
    }
}
