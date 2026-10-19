import XCTest

@testable import CrateASL

/// The path from "this node plays kick.wav" to a voice with the audio in it.
///
/// Everything here is about the seam rather than about audio: no file is read,
/// the resolver is a closure returning numbers this test made up, which is
/// exactly the contract `CrateSamples.resolving` states.
final class SampleBoxTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog {
        try MaterialCatalog.bundled()
    }

    /// A Sample Player fed by Line, out to Master. The minimum patch that
    /// flattens and has a box in it.
    private func patch(io: PatchIoKinds, sample: String?) -> CratePatch {
        var player = CratePatchNode(id: "player", kind: "sampleplayer", x: 200, y: 0)
        player.setSampleFilename(sample)
        return CratePatch(
            nodes: [
                CratePatchNode(id: "line", kind: io.line),
                player,
                CratePatchNode(id: "master", kind: io.master, x: 400),
            ],
            connections: [
                CratePatchConnection(
                    source: "line", sourceOutput: "audio", target: "player", targetInput: "input"),
                CratePatchConnection(
                    source: "player", sourceOutput: "audio", target: "master", targetInput: "input"),
            ]
        )
    }

    // MARK: - The document

    func testAFilenameSurvivesAPatchRoundTrip() throws {
        var node = CratePatchNode(id: "a", kind: "sampleplayer")
        node.setSampleFilename("kick.wav")
        let patch = CratePatch(nodes: [node])
        let reopened = try CratePatch.decode(try patch.encoded())
        XCTAssertEqual(reopened.node("a")?.sampleFilename, "kick.wav")
    }

    /// Clearing has to remove the key, not blank it: the editor decides
    /// whether to rebuild itself by comparing patches, so a node that never
    /// had a sample and one whose sample was cleared must compare equal.
    func testClearingASampleLeavesNoTrace() throws {
        var node = CratePatchNode(id: "a", kind: "sampleplayer")
        node.setSampleFilename("kick.wav")
        node.setSampleFilename(nil)
        XCTAssertNil(node.sampleFilename)
        XCTAssertEqual(node, CratePatchNode(id: "a", kind: "sampleplayer"))
    }

    func testAnEmptyFilenameIsNoFilename() {
        var node = CratePatchNode(id: "a", kind: "sampleplayer")
        node.setSampleFilename("")
        XCTAssertNil(node.sampleFilename)
    }

    // MARK: - Which materials have a slot

    func testTheSampleSlotIsDerivedFromTheGraph() throws {
        let catalog = try catalog()
        XCTAssertTrue(catalog.takesSample("sampleplayer"))
        XCTAssertTrue(catalog.takesSample("wavetable"), "wavetable reads a table too")
        XCTAssertFalse(catalog.takesSample("lowpass"))
        XCTAssertFalse(catalog.takesSample(catalog.io.master), "a host tool has no graph")
        XCTAssertFalse(catalog.takesSample("nothing-by-this-name"))
    }

    /// The set is derived, so this is a report rather than an assertion about
    /// two names. It fails only if the count goes to zero, which would mean
    /// the derivation broke.
    func testSomeMaterialTakesASample() throws {
        let catalog = try catalog()
        let kinds = catalog.materials.filter(\.readsSampleBox).map(\.kind).sorted()
        print("materials with a sample slot: \(kinds.joined(separator: ", "))")
        XCTAssertFalse(kinds.isEmpty)
    }

    // MARK: - Flatten stamps the reference

    func testFlattenStampsTheFilenameOntoTheBox() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "kick.wav"), catalog: catalog)
        XCTAssertEqual(CrateSamples.references(in: compiled), ["kick.wav"])
    }

    func testAPatchWithNoSampleStampsNothing() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: nil), catalog: catalog)
        XCTAssertTrue(CrateSamples.references(in: compiled).isEmpty)
    }

    /// Two players on the same file are one decode, and two players on
    /// different files are two references.
    func testTwoNodesTwoReferences() throws {
        let catalog = try catalog()
        var a = CratePatchNode(id: "a", kind: "sampleplayer", x: 200)
        a.setSampleFilename("kick.wav")
        var b = CratePatchNode(id: "b", kind: "sampleplayer", x: 200, y: 200)
        b.setSampleFilename("snare.wav")
        var c = CratePatchNode(id: "c", kind: "sampleplayer", x: 200, y: 400)
        c.setSampleFilename("kick.wav")
        let io = catalog.io
        let patch = CratePatch(
            nodes: [CratePatchNode(id: "line", kind: io.line), a, b, c,
                    CratePatchNode(id: "master", kind: io.master, x: 400)],
            connections: ["a", "b", "c"].flatMap { id in
                [
                    CratePatchConnection(
                        source: "line", sourceOutput: "audio", target: id, targetInput: "input"),
                    CratePatchConnection(
                        source: id, sourceOutput: "audio", target: "master", targetInput: "input"),
                ]
            }
        )
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog)
        XCTAssertEqual(CrateSamples.references(in: compiled), ["kick.wav", "snare.wav"])

        var decodes = [String: Int]()
        _ = CrateSamples.resolving(compiled) { name in
            decodes[name, default: 0] += 1
            return CrateSampleBox(samples: [0, 1], sampleRate: 48000)
        }
        XCTAssertEqual(decodes, ["kick.wav": 1, "snare.wav": 1], "one decode per distinct file")
    }

    // MARK: - Resolving puts the audio in

    func testResolvingFillsTheBoxAndTheGraphCompiles() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "kick.wav"), catalog: catalog)

        let ramp = (0..<64).map { Float($0) / 63.0 }
        let filled = CrateSamples.resolving(compiled) { _ in
            CrateSampleBox(samples: ramp, sampleRate: 44100)
        }

        // The box now holds the audio, and still holds the reference so the
        // patch can be reopened and re-resolved.
        var boxes = [ASLValue]()
        collect(filled.graph.output, into: &boxes)
        XCTAssertEqual(boxes.count, 1)
        XCTAssertEqual(boxes.first?[CrateSamples.refKey]?.string, "kick.wav")
        XCTAssertEqual(boxes.first?["sampleRate"]?.number, 44100)
        XCTAssertEqual(boxes.first?["samples"]?.numbers?.count, 64)

        // And the interpreter reads it: `planTable` is what turns the box into
        // `node.table`, and it is the only thing that makes the node audible.
        let voice = try CompiledVoice(document: filled.graph)
        let player = try XCTUnwrap(
            firstNode(in: voice, kind: .samplePlay), "no samplePlay in the plan")
        XCTAssertEqual(player.table.count, 64)
        XCTAssertEqual(player.boxRate, 44100)
    }

    /// A reference nothing resolves leaves the material's own table alone.
    /// For a Sample Player that is silence; for a Wavetable it is the sine it
    /// shipped with, which is the behaviour worth having.
    func testAnUnresolvedReferenceLeavesTheShippedTable() throws {
        let catalog = try catalog()

        let player = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "gone.wav"), catalog: catalog)
        let playerFilled = CrateSamples.resolving(player) { _ in nil }
        let playerVoice = try CompiledVoice(document: playerFilled.graph)
        XCTAssertEqual(
            firstNode(in: playerVoice, kind: .samplePlay)?.table.count, 0,
            "a sample player with a missing file is silent, not wrong")

        var wave = CratePatchNode(id: "wave", kind: "wavetable", x: 200)
        wave.setSampleFilename("gone.wav")
        let io = catalog.io
        let wavePatch = CratePatch(
            nodes: [wave, CratePatchNode(id: "master", kind: io.master, x: 400)],
            connections: [
                CratePatchConnection(
                    source: "wave", sourceOutput: "audio", target: "master", targetInput: "input")
            ]
        )
        let compiled = try CrateFlatten.flatten(wavePatch, catalog: catalog)
        XCTAssertEqual(CrateSamples.references(in: compiled), ["gone.wav"])
        let filled = CrateSamples.resolving(compiled) { _ in nil }
        let voice = try CompiledVoice(document: filled.graph)
        XCTAssertGreaterThan(
            firstNode(in: voice, kind: .wavetable)?.table.count ?? 0, 0,
            "a wavetable with a missing file keeps its default table")
    }

    /// An empty box is not an answer. Resolving to zero samples has to leave
    /// the shipped table alone too, or a decoder that fails softly turns a
    /// wavetable silent.
    func testResolvingToNothingIsTreatedAsUnresolved() throws {
        let catalog = try catalog()
        var wave = CratePatchNode(id: "wave", kind: "wavetable", x: 200)
        wave.setSampleFilename("empty.wav")
        let io = catalog.io
        let compiled = try CrateFlatten.flatten(
            CratePatch(
                nodes: [wave, CratePatchNode(id: "master", kind: io.master, x: 400)],
                connections: [
                    CratePatchConnection(
                        source: "wave", sourceOutput: "audio", target: "master",
                        targetInput: "input")
                ]
            ),
            catalog: catalog
        )
        let filled = CrateSamples.resolving(compiled) { _ in
            CrateSampleBox(samples: [], sampleRate: 48000)
        }
        let voice = try CompiledVoice(document: filled.graph)
        XCTAssertGreaterThan(firstNode(in: voice, kind: .wavetable)?.table.count ?? 0, 0)
    }

    /// Resolving is the last step before a voice is built and its result is
    /// never what `fullState` carries, so the *stamped* document has to stay
    /// small. This is the whole reason the box travels as a reference.
    func testTheStampedGraphStaysSmall() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "kick.wav"), catalog: catalog)
        let stamped = try compiled.encoded().count

        let oneSecond = [Float](repeating: 0.5, count: 48000)
        let filled = try CrateSamples.resolving(compiled) { _ in
            CrateSampleBox(samples: oneSecond, sampleRate: 48000)
        }.encoded().count

        print("stamped \(stamped) bytes, with one second of audio inline \(filled) bytes")
        XCTAssertLessThan(stamped, 4096, "the graph fullState carries must not hold audio")
        XCTAssertGreaterThan(filled, 100_000, "sanity: inlining really is the expensive shape")
    }

    // MARK: - The live path: audio as a side table

    func testTheSideTableFeedsThePlanWithoutTouchingTheDocument() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "kick.wav"), catalog: catalog)

        let ramp = (0..<128).map { Float($0) / 127.0 }
        let voice = try CompiledVoice(
            document: compiled.graph,
            samples: ["kick.wav": CrateSampleBox(samples: ramp, sampleRate: 44100)]
        )
        let player = try XCTUnwrap(firstNode(in: voice, kind: .samplePlay))
        XCTAssertEqual(player.table, ramp)
        XCTAssertEqual(player.boxRate, 44100)
    }

    func testASideTableMissingTheFileLeavesTheShippedTable() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "gone.wav"), catalog: catalog)
        let voice = try CompiledVoice(document: compiled.graph, samples: ["other.wav": .init(samples: [1], sampleRate: 48000)])
        XCTAssertEqual(firstNode(in: voice, kind: .samplePlay)?.table.count, 0)
    }

    /// An inline table is the fallback, not the winner: a patch exported with
    /// its audio baked in and then reopened where the file also exists should
    /// play the file, so that replacing the file changes the sound.
    func testTheSideTableWinsOverAnInlineTable() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "kick.wav"), catalog: catalog)
        let baked = CrateSamples.resolving(compiled) { _ in
            CrateSampleBox(samples: [0, 0, 0, 0], sampleRate: 8000)
        }
        let voice = try CompiledVoice(
            document: baked.graph,
            samples: ["kick.wav": CrateSampleBox(samples: [1, 1], sampleRate: 96000)]
        )
        XCTAssertEqual(firstNode(in: voice, kind: .samplePlay)?.table, [1, 1])
        XCTAssertEqual(firstNode(in: voice, kind: .samplePlay)?.boxRate, 96000)
    }

    /// The claim the whole side-table design rests on: compiling a patch with
    /// a long sample on it costs what compiling an empty one costs, because
    /// the table is a reference rather than a conversion. The patcher
    /// recompiles on every structural edit, so this is the number that
    /// decides whether the editor is usable with audio loaded.
    func testCompilingWithALongSampleCostsNothingExtra() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "long.wav"), catalog: catalog)
        // A minute of 48 kHz, far past anything the UI will accept.
        let long = [Float](repeating: 0.25, count: 48000 * 60)
        let table = ["long.wav": CrateSampleBox(samples: long, sampleRate: 48000)]

        _ = try CompiledVoice(document: compiled.graph, samples: table)  // warm
        var withAudio = 0.0
        var without = 0.0
        for _ in 0..<20 {
            var t = Date()
            _ = try CompiledVoice(document: compiled.graph, samples: table)
            withAudio += Date().timeIntervalSince(t)
            t = Date()
            _ = try CompiledVoice(document: compiled.graph)
            without += Date().timeIntervalSince(t)
        }
        let loaded = withAudio / 20 * 1000
        let empty = without / 20 * 1000
        print(String(format: "compile with 60 s loaded %.3f ms, with nothing %.3f ms", loaded, empty))
        XCTAssertLessThan(
            loaded, Swift.max(empty * 4, 5.0),
            "compiling should not scale with the audio; the table is meant to be a reference"
        )
    }

    /// Restoring a project: the graph comes back out of JSON with the
    /// reference intact and is resolved again from the library.
    func testAReferenceSurvivesTheCompiledGraphRoundTrip() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "kick.wav"), catalog: catalog)
        let reopened = try JSONDecoder().decode(
            CompiledMaterialDocument.self, from: try compiled.encoded())
        XCTAssertEqual(CrateSamples.references(in: reopened), ["kick.wav"])
    }

    func testReferencesInAPatchAreKeyedByNode() throws {
        let catalog = try catalog()
        XCTAssertEqual(
            CrateSamples.references(in: patch(io: catalog.io, sample: "kick.wav")),
            ["player": "kick.wav"]
        )
    }

    // MARK: - End to end: does it make the sound

    /// The whole point, rendered.
    ///
    /// A Sample Player is gated by its `input` inlet: `evalSamplePlay` reads
    /// the port and triggers when it crosses 0.5. So this holds the insert
    /// input high and expects the table back, scaled by the gain parameter.
    /// If the reference, the stamp, the side table or `planTable` were wrong
    /// anywhere, this is silent.
    func testAPatchWithASampleRendersThatSample() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "kick.wav"), catalog: catalog)

        // A recognisable table, nothing like a sine, so the assertion cannot
        // pass on some other node's output.
        let audio: [Float] = [0.9, -0.8, 0.7, -0.6, 0.5, -0.4, 0.3, -0.2]
        let voice = try CompiledVoice(
            document: compiled.graph,
            samples: ["kick.wav": CrateSampleBox(samples: audio, sampleRate: 48000)]
        )
        let state = voice.makeState()
        let map = ParameterMap(compiled.params)
        state.setParams(map.defaults)

        let frames = audio.count
        // Input held at 1, which both gates the player and is what the graph
        // reads through its `input` port.
        let input = [Float](repeating: 1, count: frames)
        var outL = [Float](repeating: 0, count: frames)
        var outR = [Float](repeating: 0, count: frames)
        input.withUnsafeBufferPointer { inBuf in
            outL.withUnsafeMutableBufferPointer { l in
                outR.withUnsafeMutableBufferPointer { r in
                    _ = voice.render(
                        state, sampleRate: 48000, frames: frames,
                        outL: l.baseAddress!, outR: r.baseAddress,
                        inL: inBuf.baseAddress, inR: inBuf.baseAddress
                    )
                }
            }
        }

        // The material is samplePlay * gain, and gain defaults to 0.85.
        let gain = Float(
            try XCTUnwrap(compiled.params.first { $0.key.hasSuffix("_gain") }?.value.defaultValue))
        XCTAssertEqual(gain, 0.85, accuracy: 1e-6, "the material's gain default moved")

        // Rate 1 at a matching source rate walks the table one frame per
        // frame, and the last position is interpolated toward a frame that is
        // not there, so the run of samples before it is what to compare.
        for frame in 0..<(frames - 1) {
            XCTAssertEqual(
                outL[frame], audio[frame] * gain, accuracy: 1e-5,
                "frame \(frame) is not the sample")
        }
        XCTAssertEqual(outR, outL, "a mono table should land the same both sides")
    }

    /// The same patch with no sample on it renders silence rather than
    /// something else's noise. Together with the test above this is the pair
    /// that says the audio arrived because of the reference and not by
    /// accident.
    func testTheSamePatchWithNoSampleIsSilent() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: nil), catalog: catalog)
        let voice = try CompiledVoice(document: compiled.graph)
        let state = voice.makeState()
        state.setParams(ParameterMap(compiled.params).defaults)

        let frames = 16
        let input = [Float](repeating: 1, count: frames)
        var outL = [Float](repeating: 99, count: frames)
        var outR = [Float](repeating: 99, count: frames)
        input.withUnsafeBufferPointer { inBuf in
            outL.withUnsafeMutableBufferPointer { l in
                outR.withUnsafeMutableBufferPointer { r in
                    _ = voice.render(
                        state, sampleRate: 48000, frames: frames,
                        outL: l.baseAddress!, outR: r.baseAddress,
                        inL: inBuf.baseAddress, inR: inBuf.baseAddress
                    )
                }
            }
        }
        for frame in 0..<frames {
            XCTAssertEqual(outL[frame], 0, accuracy: 1e-6, "frame \(frame) should be silent")
        }
    }

    /// A file the library lost renders silence too, and does not render
    /// whatever the last patch had in that slot.
    func testAMissingFileRendersSilenceNotTheLastSample() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(
            patch(io: catalog.io, sample: "gone.wav"), catalog: catalog)
        let voice = try CompiledVoice(
            document: compiled.graph,
            samples: ["something-else.wav": CrateSampleBox(samples: [1, 1, 1, 1], sampleRate: 48000)]
        )
        let state = voice.makeState()
        state.setParams(ParameterMap(compiled.params).defaults)

        let frames = 8
        let input = [Float](repeating: 1, count: frames)
        var outL = [Float](repeating: 99, count: frames)
        input.withUnsafeBufferPointer { inBuf in
            outL.withUnsafeMutableBufferPointer { l in
                _ = voice.render(
                    state, sampleRate: 48000, frames: frames,
                    outL: l.baseAddress!, outR: nil,
                    inL: inBuf.baseAddress, inR: inBuf.baseAddress
                )
            }
        }
        for frame in 0..<frames {
            XCTAssertEqual(outL[frame], 0, accuracy: 1e-6)
        }
    }

    // MARK: - Playing it

    /// A Sample Player driven from one jack by a 40 Hz Clock, rendered at
    /// 800 Hz so a pulse lands every twenty samples. The table is a ramp, so
    /// a rendered sample says which frame of it the playhead is on.
    private func clocked(into inlet: String?, tableFrames: Int) throws -> [Float] {
        let catalog = try catalog()
        var player = CratePatchNode(id: "smp", kind: "sampleplayer", params: ["gain": 1, "loop": 0])
        player.setSampleFilename("s.wav")
        var nodes = [player, CratePatchNode(id: "master", kind: catalog.io.master)]
        var cables = [
            CratePatchConnection(
                source: "smp", sourceOutput: "audio", target: "master", targetInput: "input")
        ]
        if let inlet {
            nodes.insert(CratePatchNode(id: "clk", kind: "clock", params: ["freq": 40]), at: 0)
            cables.append(
                CratePatchConnection(
                    source: "clk", sourceOutput: "cv", target: "smp", targetInput: inlet))
        }
        let compiled = try CrateFlatten.flatten(
            CratePatch(nodes: nodes, connections: cables), catalog: catalog)
        let table = (0..<tableFrames).map { Float($0) / 100 }
        let voice = try CompiledVoice(
            document: compiled.graph,
            samples: ["s.wav": CrateSampleBox(samples: table, sampleRate: 800)])
        let state = voice.makeState()
        state.setParams(ParameterMap(compiled.params).defaults)
        // Held open, the way an insert's is. The jack under test is the only
        // thing that moves.
        state.gate = true
        var out = [Float](repeating: 0, count: 48)
        let silence = [Float](repeating: 0, count: 48)
        silence.withUnsafeBufferPointer { input in
            out.withUnsafeMutableBufferPointer { buffer in
                _ = voice.render(
                    state, sampleRate: 800, frames: 48,
                    outL: buffer.baseAddress!, outR: nil,
                    inL: input.baseAddress, inR: nil)
            }
        }
        return out
    }

    /// Which frame of the table each rendered sample came from.
    private func playhead(_ samples: [Float]) -> [Int] {
        samples.map { Int(($0 * 100).rounded()) }
    }

    /// How many times a series of playhead positions steps backwards.
    ///
    /// The property rather than the frame numbers: where exactly the clock's
    /// edge falls is the clock's business, and a test that pins it would fail
    /// the next time its phase is touched without anything being wrong here.
    private func rewinds(_ positions: [Int]) -> Int {
        zip(positions, positions.dropFirst()).reduce(0) { $1.1 < $1.0 ? $0 + 1 : $0 }
    }

    /// How many separate stretches of sound there are in a buffer.
    private func soundingRuns(_ samples: [Float]) -> Int {
        var runs = 0
        var sounding = false
        for sample in samples {
            let now = sample != 0
            if now && !sounding { runs += 1 }
            sounding = now
        }
        return runs
    }

    func testResetMovesThePlayheadWithoutStartingAnything() throws {
        // Free-running, the playhead walks the table one frame per sample and
        // never looks back.
        let free = playhead(try clocked(into: nil, tableFrames: 64))
        XCTAssertEqual(Array(free[0..<4]), [0, 1, 2, 3])
        XCTAssertEqual(rewinds(free), 0, "with nothing on reset the playhead just keeps going")
        XCTAssertEqual(free[47], 47)

        // With the clock on it, every pulse puts the playhead back at the
        // start, so it never gets far into a 64 frame table.
        let reset = playhead(try clocked(into: "reset", tableFrames: 64))
        XCTAssertEqual(Array(reset[0..<4]), [0, 1, 2, 3])
        XCTAssertEqual(rewinds(reset), 2, "48 frames at 40 Hz is two pulses")
        XCTAssertLessThan(reset.max() ?? 0, 25, "it should never reach the end of the table")
    }

    func testATrigEdgeRestartsASampleThatHasFinished() throws {
        // Four frames of table, so it is long over by the time a pulse lands.
        let once = try clocked(into: nil, tableFrames: 4)
        XCTAssertEqual(Array(playhead(once)[0..<3]), [0, 1, 2])
        XCTAssertTrue(once[8...].allSatisfy { $0 == 0 },
                      "a one-shot with nothing on trig stays finished")

        // Every pulse starts it again, which is the one thing `reset` will not
        // do: there is nothing left playing for a playhead move to affect.
        let trigged = try clocked(into: "trig", tableFrames: 4)
        XCTAssertFalse(trigged[8...].allSatisfy { $0 == 0 },
                       "the clock on trig should start it again")
        // The first play plus one per pulse. Counted as runs of sound rather
        // than as playhead rewinds, because silence reads as frame zero and
        // would count as a rewind of its own.
        XCTAssertEqual(soundingRuns(trigged), 3, "the first play, then one per pulse")

        // And reset, on the same finished sample, does nothing at all.
        let reset = try clocked(into: "reset", tableFrames: 4)
        XCTAssertTrue(reset[8...].allSatisfy { $0 == 0 },
                      "reset moves a playhead, it does not start a sample")
    }

    func testTheSamplePlayerDrawsTheJacksThatDriveIt() throws {
        // The regression this pair of tests exists for: the material used to
        // wire the node's gate to its audio port and declare no control jack
        // at all, so there was nothing in the palette to cable a clock into.
        let inputs = try catalog().material("sampleplayer")?.inputs ?? []
        for jack in ["trig", "gate", "reset"] {
            XCTAssertTrue(inputs.contains(jack), "the palette should draw a \(jack) jack")
        }
    }

    // MARK: - Helpers

    private func collect(_ node: ASLNodeDocument, into boxes: inout [ASLValue]) {
        if CrateSamples.boxKinds.contains(node.kind), let box = node.params[CrateSamples.boxParam] {
            boxes.append(box)
        }
        for (_, child) in node.inputs { collect(child, into: &boxes) }
        for child in node.list ?? [] { collect(child, into: &boxes) }
    }

    private func firstNode(in voice: CompiledVoice, kind: NodeKind) -> PlanNode? {
        voice.plan.nodes.first { $0.kind == kind }
    }
}
