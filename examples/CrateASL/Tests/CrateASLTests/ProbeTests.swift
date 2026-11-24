import XCTest
@testable import CrateASL

/// Module probes (Probes.swift): read off the value cache once per block, so
/// they must never change what a patch compiles to, must find every module
/// that is in the graph, and must show what is actually playing.
final class ProbeTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    private func compile(_ patch: CratePatch) throws -> (CompiledMaterialDocument, [String: ProbeSite]) {
        let result = try CrateFlatten.flattenWithProbes(patch, catalog: catalog(), role: .instrument)
        return (result.document, result.probes)
    }

    /// The whole contract with the rest of the engine: asking for probes
    /// compiles the same graph. Flatten numbers nodes as it walks
    /// dictionaries, so "the same" is node for node, not byte for byte;
    /// `probeSites(_:from:onto:)` is that comparison.
    func testProbesDoNotChangeTheGraph() throws {
        for limiter in [false, true] {
            let patch = VoicingTests.patch(limiter: limiter)
            let plain = try CrateFlatten.flatten(patch, catalog: catalog(), role: .instrument)
            let (probed, sites) = try compile(patch)
            XCTAssertNotNil(CrateFlatten.probeSites(sites, from: probed, onto: plain), "limiter: \(limiter)")
        }
    }

    /// A restored project's graph was flattened by another run, so its ids
    /// differ; the sites moved onto it must land on the same modules.
    func testSitesMoveOntoAnotherFlattenOfThePatch() throws {
        for limiter in [false, true] {
            let patch = VoicingTests.patch(limiter: limiter)
            let (fresh, sites) = try compile(patch)
            let restored = try CrateFlatten.flatten(patch, catalog: catalog(), role: .instrument)
            let moved = try XCTUnwrap(CrateFlatten.probeSites(sites, from: fresh, onto: restored))
            XCTAssertEqual(Set(moved.keys), Set(sites.keys))
            let voice = try CompiledVoice(document: restored.graph)
            let table = ProbeTable(patch: patch, catalog: try catalog(), sites: moved, voice: voice)
            for (index, node) in patch.nodes.enumerated() where sites[node.id] != nil {
                XCTAssertEqual(table.kind(at: index), .module, "\(node.id), limiter: \(limiter)")
            }
        }
    }

    /// A different patch is a different graph, and must not borrow sites.
    func testADifferentGraphIsRefused() throws {
        let (a, sites) = try compile(VoicingTests.patch(limiter: false))
        let b = try CrateFlatten.flatten(VoicingTests.patch(limiter: true), catalog: catalog(), role: .instrument)
        XCTAssertNil(CrateFlatten.probeSites(sites, from: a, onto: b))
    }

    func testEveryModuleResolvesToASlot() throws {
        let patch = VoicingTests.patch(limiter: false)
        let (document, sites) = try compile(patch)
        let voice = try CompiledVoice(document: document.graph)
        let table = ProbeTable(patch: patch, catalog: try catalog(), sites: sites, voice: voice)
        XCTAssertEqual(table.count, patch.nodes.count)
        for (index, node) in patch.nodes.enumerated() {
            switch node.id {
            case "keys": XCTAssertEqual(table.kind(at: index), .notes)
            case "out": XCTAssertEqual(table.kind(at: index), .master)
            default:
                XCTAssertEqual(table.kind(at: index), .module, node.id)
                XCTAssertGreaterThanOrEqual(table.slots[index], 0, node.id)
            }
        }
        XCTAssertEqual(table.layoutHash, CrateProbeLayout.hash(patch.nodes.map(\.id)))
    }

    /// A held note lights its modules and the keyboard; released and left to
    /// ring out, the voice retires and its modules read zero again.
    func testAPlayingVoiceShowsOnItsModules() throws {
        let patch = VoicingTests.patch(limiter: false)
        let (document, sites) = try compile(patch)
        let voice = try CompiledVoice(document: document.graph)
        let pool = VoicePool(voice: voice, polyphony: 8, seed: 7)
        pool.setParams(ParameterMap(document.params).defaults)
        let table = ProbeTable(patch: patch, catalog: try catalog(), sites: sites, voice: voice)
        let out = UnsafeMutablePointer<Float>.allocate(capacity: CrateProbeLayout.maxProbes)
        defer { out.deallocate() }
        var left = [Float](repeating: 0, count: VoicingTests.frames)

        func block() {
            left.withUnsafeMutableBufferPointer { buffer in
                _ = pool.render(sampleRate: VoicingTests.sampleRate, frames: VoicingTests.frames,
                                outL: buffer.baseAddress!, outR: nil)
            }
            pool.sampleProbes(table, master: 0.5, line: 0, into: out)
        }

        pool.noteOn(note: 60, velocity: 0.8)
        // The loudest a module got over a few blocks, because one sample a
        // block can land on a zero crossing.
        var loudest = [Float](repeating: 0, count: table.count)
        for _ in 0..<12 {
            block()
            for index in 0..<table.count { loudest[index] = max(loudest[index], out[index]) }
        }
        for (index, node) in patch.nodes.enumerated() {
            switch node.id {
            case "keys": XCTAssertGreaterThan(out[index], 0, "a held key")
            case "out": XCTAssertEqual(out[index], 0.5, "Master carries the host's peak")
            default: XCTAssertGreaterThan(loudest[index], 0, "\(node.id) while a note is held")
            }
        }

        pool.noteOff(note: 60)
        for _ in 0..<2000 { block() }
        for (index, node) in patch.nodes.enumerated() where node.id != "out" {
            XCTAssertEqual(out[index], 0, "\(node.id) after the voice rang out")
        }
    }

    /// A split instrument's summed modules run on the bus, and are read there.
    func testTheSplitBusIsReadOnTheBus() throws {
        let patch = VoicingTests.patch(limiter: true)
        let (document, sites) = try compile(patch)
        guard document.graph.bus != nil else {
            throw XCTSkip("this patch did not split; nothing runs on a bus")
        }
        XCTAssertTrue(sites.values.contains { $0.onBus }, "a split patch has modules on its bus")
        let voice = try CompiledVoice(document: document.graph)
        let pool = VoicePool(voice: voice, polyphony: 8, seed: 7)
        pool.setParams(ParameterMap(document.params).defaults)
        let table = ProbeTable(patch: patch, catalog: try catalog(), sites: sites, voice: voice)
        let out = UnsafeMutablePointer<Float>.allocate(capacity: CrateProbeLayout.maxProbes)
        defer { out.deallocate() }
        var left = [Float](repeating: 0, count: VoicingTests.frames)
        pool.noteOn(note: 60, velocity: 0.8)
        var loudest = [Float](repeating: 0, count: table.count)
        for _ in 0..<12 {
            left.withUnsafeMutableBufferPointer { buffer in
                _ = pool.render(sampleRate: VoicingTests.sampleRate, frames: VoicingTests.frames,
                                outL: buffer.baseAddress!, outR: nil)
            }
            pool.sampleProbes(table, master: 0, line: 0, into: out)
            for index in 0..<table.count { loudest[index] = max(loudest[index], out[index]) }
        }
        for (index, node) in patch.nodes.enumerated() where sites[node.id]?.onBus == true {
            XCTAssertGreaterThanOrEqual(table.slots[index], 0, node.id)
            XCTAssertGreaterThan(loudest[index], 0, "\(node.id) on the bus while a note is held")
        }
    }

    func testAnEffectReadsItsOneState() throws {
        let io = try catalog().io
        let patch = CratePatch(
            nodes: [
                CratePatchNode(id: "in", kind: io.line),
                CratePatchNode(id: "lp", kind: "lowpass", params: ["cutoff": 2000, "q": 0.7]),
                CratePatchNode(id: "out", kind: io.master),
            ],
            connections: [
                CratePatchConnection(source: "in", sourceOutput: "audio", target: "lp", targetInput: "input"),
                CratePatchConnection(source: "lp", sourceOutput: "audio", target: "out", targetInput: "input"),
            ]
        )
        let result = try CrateFlatten.flattenWithProbes(patch, catalog: catalog())
        let voice = try CompiledVoice(document: result.document.graph)
        let state = voice.makeState(seed: 3)
        state.setParams(ParameterMap(result.document.params).defaults)
        state.gate = true
        let table = ProbeTable(patch: patch, catalog: try catalog(), sites: result.probes, voice: voice)
        let out = UnsafeMutablePointer<Float>.allocate(capacity: CrateProbeLayout.maxProbes)
        defer { out.deallocate() }
        let frames = 256
        var input = (0..<frames).map { Float(sin(Double($0) * 2 * .pi * 220 / 48000)) * 0.5 }
        var output = [Float](repeating: 0, count: frames)
        var loudest: Float = 0
        for _ in 0..<8 {
            input.withUnsafeMutableBufferPointer { inBuf in
                output.withUnsafeMutableBufferPointer { outBuf in
                    _ = voice.render(state, sampleRate: 48000, frames: frames,
                                     outL: outBuf.baseAddress!, outR: nil,
                                     inL: UnsafePointer(inBuf.baseAddress!), inR: nil)
                }
            }
            voice.sampleProbes(table, state: state, master: 0.25, line: 0.5, into: out)
            loudest = max(loudest, out[1])
        }
        XCTAssertEqual(table.kind(at: 0), .line)
        XCTAssertEqual(out[0], 0.5)
        XCTAssertGreaterThan(loudest, 0, "the filter, fed a tone")
        XCTAssertEqual(out[2], 0.25)
    }

    /// What probing costs the audio thread, against what it already spends:
    /// one read per module per voice, after a block of 256 frames of eight
    /// voices. Held to under 1% of the render it follows.
    func testSamplingIsNegligibleNextToTheRender() throws {
        let patch = VoicingTests.patch(limiter: false)
        let (document, sites) = try compile(patch)
        let voice = try CompiledVoice(document: document.graph)
        let pool = VoicePool(voice: voice, polyphony: 8, seed: 7)
        pool.setParams(ParameterMap(document.params).defaults)
        let table = ProbeTable(patch: patch, catalog: try catalog(), sites: sites, voice: voice)
        let out = UnsafeMutablePointer<Float>.allocate(capacity: CrateProbeLayout.maxProbes)
        defer { out.deallocate() }
        for note in [48, 52, 55, 59, 62, 65, 69, 72] { pool.noteOn(note: note, velocity: 0.8) }
        var left = [Float](repeating: 0, count: VoicingTests.frames)
        let blocks = 200
        var rendering: Double = 0
        var sampling: Double = 0
        for _ in 0..<blocks {
            let a = DispatchTime.now().uptimeNanoseconds
            left.withUnsafeMutableBufferPointer { buffer in
                _ = pool.render(sampleRate: VoicingTests.sampleRate, frames: VoicingTests.frames,
                                outL: buffer.baseAddress!, outR: nil)
            }
            let b = DispatchTime.now().uptimeNanoseconds
            pool.sampleProbes(table, master: 0, line: 0, into: out)
            let c = DispatchTime.now().uptimeNanoseconds
            rendering += Double(b - a)
            sampling += Double(c - b)
        }
        let share = sampling / rendering
        print(String(format: "probe sampling: %.0f ns a block, %.3f%% of the render", sampling / Double(blocks), share * 100))
        XCTAssertLessThan(share, 0.01)
    }

    func testTheFileCarriesAFrameAcross() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("probe-\(UUID().uuidString).probe")
        defer { try? FileManager.default.removeItem(at: url) }
        let reader = try XCTUnwrap(CrateProbeFile(url: url, create: true))
        let writer = try XCTUnwrap(CrateProbeFile(url: url, create: false))
        let into = UnsafeMutablePointer<Float>.allocate(capacity: CrateProbeLayout.maxProbes)
        defer { into.deallocate() }

        XCTAssertNil(reader.read(since: 0, into: into), "nothing written yet")
        writer.values[0] = 0.25
        writer.values[1] = 0.75
        writer.commit(count: 2, layoutHash: 42)
        let frame = try XCTUnwrap(reader.read(since: 0, into: into))
        XCTAssertEqual(frame.count, 2)
        XCTAssertEqual(frame.layoutHash, 42)
        XCTAssertEqual(into[0], 0.25)
        XCTAssertEqual(into[1], 0.75)
        XCTAssertNil(reader.read(since: frame.sequence, into: into), "no new frame")
    }

    func testTheLayoutHashTellsOrdersApart() {
        XCTAssertNotEqual(CrateProbeLayout.hash(["ab", "c"]), CrateProbeLayout.hash(["a", "bc"]))
        XCTAssertNotEqual(CrateProbeLayout.hash(["a", "b"]), CrateProbeLayout.hash(["b", "a"]))
        XCTAssertEqual(CrateProbeLayout.hash(["a", "b"]), CrateProbeLayout.hash(["a", "b"]))
    }
}
