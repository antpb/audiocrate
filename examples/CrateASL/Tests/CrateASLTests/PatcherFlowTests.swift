import XCTest
@testable import CrateASL

/// The path a node editor actually drives: place nodes, connect them,
/// flatten, compile, hear something.
///
/// The conformance suite proves the lowering matches JavaScript and the
/// catalog tests prove every material compiles. Neither one runs the sequence
/// an editor runs, and the joins between them are where a patcher breaks:
/// a graph that flattens and compiles can still be silent, and a patch that
/// round-trips can still come back as different cables.
final class PatcherFlowTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    /// The patch this editor opens with: the host's input through a lowpass
    /// and a gain to Master.
    private func starter(_ io: PatchIoKinds) -> CratePatch {
        CratePatch(
            nodes: [
                CratePatchNode(id: "line", kind: io.line),
                CratePatchNode(id: "lowpass", kind: "lowpass", params: ["cutoff": 20000, "q": 0.707]),
                CratePatchNode(id: "gain", kind: "gain", params: ["gain": 1]),
                CratePatchNode(id: "master", kind: io.master),
            ],
            connections: [
                CratePatchConnection(source: "line", sourceOutput: "audio", target: "lowpass", targetInput: "input"),
                CratePatchConnection(source: "lowpass", sourceOutput: "audio", target: "gain", targetInput: "input"),
                CratePatchConnection(source: "gain", sourceOutput: "audio", target: "master", targetInput: "input"),
            ],
            transport: CratePatchTransport()
        )
    }

    /// Renders a compiled insert against a 220 Hz tone and returns the peak.
    private func peak(
        _ document: CompiledMaterialDocument,
        frames: Int = 2048,
        sampleRate: Double = 48_000
    ) throws -> Double {
        let voice = try CompiledVoice(document: document.graph)
        let state = voice.makeState()
        state.setParams(ParameterMap(document.params).defaults)
        state.gate = true
        var input = [Float](repeating: 0, count: frames)
        for index in 0..<frames {
            input[index] = Float(sin(2 * Double.pi * 220 * Double(index) / sampleRate) * 0.5)
        }
        var output = [Float](repeating: 0, count: frames)
        var right: [Float]? = nil
        _ = voice.renderBlock(
            state, sampleRate: sampleRate, output: &output, input: input, outputR: &right
        )
        return output.reduce(0) { Swift.max($0, Double(abs($1))) }
    }

    // MARK: - The first thing anybody does

    func testTheStarterPatchPassesAudio() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(starter(catalog.io), catalog: catalog, name: "Starter")
        XCTAssertEqual(compiled.role, "insert")
        XCTAssertEqual(compiled.ports, ["input"])
        // A lowpass at 20 kHz and a gain of 1 is a pass-through you can hear,
        // which is the whole reason this is the starter rather than a blank
        // canvas: silent-on-insert and broken-on-insert look identical.
        let level = try peak(compiled)
        XCTAssertGreaterThan(level, 0.4, "the starter patch is silent")
        XCTAssertLessThan(level, 0.6, "the starter patch is not unity")
    }

    func testPublishedParametersAreNamedByNode() throws {
        let catalog = try catalog()
        let compiled = try CrateFlatten.flatten(starter(catalog.io), catalog: catalog, name: "Starter")
        XCTAssertEqual(
            Set(compiled.params.keys), ["lowpass_cutoff", "lowpass_q", "gain_gain"],
            "the editor finds a live parameter by this name, so the prefix is not cosmetic"
        )
        XCTAssertEqual(compiled.params["lowpass_cutoff"]?.defaultValue, 20000)
        XCTAssertEqual(compiled.params["gain_gain"]?.address, 2, "addresses follow the topological order")
    }

    // MARK: - Editing

    func testPatchingAnLfoIntoAParamTakesTheKnobAway() throws {
        let catalog = try catalog()
        var patch = starter(catalog.io)
        patch.nodes.append(CratePatchNode(id: "lfo", kind: "lfo", params: ["rate": 3, "amount": 1]))
        patch.connections.append(
            CratePatchConnection(source: "lfo", sourceOutput: "cv", target: "lowpass", targetInput: "cutoff")
        )
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "Swept")
        XCTAssertFalse(
            compiled.params.keys.contains("lowpass_cutoff"),
            "a cable replaces the param node, so publishing the knob would publish a number nothing reads"
        )
        XCTAssertTrue(compiled.params.keys.contains("lfo_rate"), "the LFO's own knobs are published")
        XCTAssertGreaterThan(try peak(compiled), 0, "a swept filter still passes audio")
    }

    func testTwoSourcesIntoMasterMix() throws {
        let catalog = try catalog()
        var patch = starter(catalog.io)
        patch.nodes.append(CratePatchNode(id: "second", kind: "gain", params: ["gain": 1]))
        patch.connections.append(
            CratePatchConnection(source: "line", sourceOutput: "audio", target: "second", targetInput: "input")
        )
        patch.connections.append(
            CratePatchConnection(source: "second", sourceOutput: "audio", target: "master", targetInput: "input")
        )
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "Doubled")
        let doubled = try peak(compiled)
        let single = try peak(try CrateFlatten.flatten(starter(catalog.io), catalog: catalog, name: "Starter"))
        // The second cable is stacked on the same Master inlet, which is the
        // case Flow cannot express with one wire per input and the reason the
        // editor grows slots. If they replaced each other this is unity.
        XCTAssertEqual(doubled, single * 2, accuracy: 1e-5)
    }

    func testDeletingTheOutputCableIsRefusedRatherThanMuted() throws {
        let catalog = try catalog()
        var patch = starter(catalog.io)
        patch.connections.removeAll { $0.target == "master" }
        XCTAssertThrowsError(try CrateFlatten.flatten(patch, catalog: catalog)) { error in
            XCTAssertTrue("\(error)".contains("silent"), "\(error)")
        }
        // The editor keeps the last good graph playing and shows this
        // sentence, rather than adopting silence. A patch with a cable
        // momentarily unplugged is a normal thing to be looking at.
    }

    // MARK: - Persistence

    func testAPatchSurvivesTheRoundTripThroughFullState() throws {
        let catalog = try catalog()
        var patch = starter(catalog.io)
        patch.nodes[1].x = 123.5
        patch.nodes[1].params["cutoff"] = 880
        patch.nodes.append(CratePatchNode(id: "lfo", kind: "lfo", x: 7, y: 9))
        patch.connections.append(
            CratePatchConnection(source: "lfo", sourceOutput: "cv", target: "gain", targetInput: "gain")
        )

        let restored = try JSONDecoder().decode(CratePatch.self, from: try patch.encoded())
        XCTAssertEqual(restored, patch, "positions, values and cables all have to come back")

        // And the graph it produces has to be the same graph, because a
        // project that reopens as a different plugin is the failure this
        // whole arrangement exists to prevent.
        let before = try CrateFlatten.flatten(patch, catalog: catalog, name: "Round")
        let after = try CrateFlatten.flatten(restored, catalog: catalog, name: "Round")
        XCTAssertEqual(before.params, after.params)
        XCTAssertEqual(before.ports, after.ports)
        XCTAssertEqual(try peak(before), try peak(after))
    }

    /// A patch built here has to be readable by the web patcher, which means
    /// the document carries nodes and cables and nothing about how they were
    /// drawn.
    func testTheDocumentIsTheSharedFormat() throws {
        let catalog = try catalog()
        let json = try String(data: starter(catalog.io).encoded(), encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"kind\":\"crate.patch\""))
        XCTAssertTrue(json.contains("\"version\":1"))
        XCTAssertTrue(json.contains("\"sourceOutput\":\"audio\""))
        XCTAssertFalse(json.contains("Flow"), "no editor's drawing model in the file")
        XCTAssertFalse(json.contains("nodeIndex"), "node indices are not portable and must not be written")
    }

    // MARK: - Instruments

    func testAKeyboardCableMakesItAnInstrument() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                CratePatchNode(id: "keys", kind: catalog.io.keyboard),
                CratePatchNode(id: "osc", kind: "oscillator", params: ["gain": 0.4]),
                CratePatchNode(id: "master", kind: catalog.io.master),
            ],
            connections: [
                CratePatchConnection(source: "keys", sourceOutput: "cv", target: "osc", targetInput: "note"),
                CratePatchConnection(source: "keys", sourceOutput: "gate", target: "osc", targetInput: "gate"),
                CratePatchConnection(source: "osc", sourceOutput: "audio", target: "master", targetInput: "input"),
            ]
        )
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "Voice")
        XCTAssertEqual(compiled.role, "instrument")
        XCTAssertEqual(compiled.polyphony, 8)
        XCTAssertEqual(compiled.ports, [], "an instrument reads no live audio")

        // The voice has to actually sound when a note is held, which is the
        // one thing the role flag does not prove.
        let voice = try CompiledVoice(document: compiled.graph)
        let pool = VoicePool(voice: voice, polyphony: compiled.polyphony ?? 1)
        pool.setParams(ParameterMap(compiled.params).defaults)
        pool.noteOn(note: 60, velocity: 1)
        var output = [Float](repeating: 0, count: 2048)
        let voices = output.withUnsafeMutableBufferPointer { buffer in
            pool.render(sampleRate: 48_000, frames: buffer.count, outL: buffer.baseAddress!, outR: nil)
        }
        XCTAssertEqual(voices, 1, "one note should be one voice rendering")
        XCTAssertGreaterThan(
            output.reduce(0) { Swift.max($0, Double(abs($1))) }, 0,
            "a held note renders silence"
        )
    }

    /// A generated generative patch from the device: two tones, both gains
    /// replaced by clocked envelopes. This is insert-role, so it has to
    /// render with the gate open and no MIDI. A VoicePool with no note
    /// allocated is the silence the instrument AU used to produce.
    func testAGatedGenerativePatchSoundsWithoutANote() throws {
        let catalog = try catalog()
        let patch = try CratePatch.decode(Self.generatedGatedTones)
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "Generated")
        XCTAssertEqual(compiled.role, "insert")
        XCTAssertFalse(compiled.isInstrument)

        let alwaysOn = try peak(compiled, frames: 8192)
        XCTAssertGreaterThan(alwaysOn, 0, "insert render of the gated tones is silence")

        let voice = try CompiledVoice(document: compiled.graph)
        let pool = VoicePool(voice: voice, polyphony: 8)
        pool.setParams(ParameterMap(compiled.params).defaults)
        var output = [Float](repeating: 0, count: 8192)
        let voices = output.withUnsafeMutableBufferPointer { buffer in
            pool.render(sampleRate: 48_000, frames: buffer.count, outL: buffer.baseAddress!, outR: nil)
        }
        XCTAssertEqual(voices, 0, "an insert graph must not wait in an empty pool")
        XCTAssertEqual(
            output.reduce(0) { Swift.max($0, Double(abs($1))) }, 0,
            "the empty-pool path is how this patch went silent in the aumu"
        )
    }

    private static let generatedGatedTones = Data(#"""
    {"kind":"crate.patch","version":1,"transport":{"bpm":120,"beatsPerBar":4,"beatUnit":4},"nodes":[{"id":"source","kind":"tone","params":{"freq":80,"gain":0.5},"x":0,"y":0},{"id":"layer","kind":"tone","params":{"freq":80,"gain":0.5},"x":0,"y":0},{"id":"filter","kind":"lowpass","params":{"cutoff":200,"q":0.9},"x":0,"y":0},{"id":"fx1","kind":"pitchshift","params":{"mix":0},"x":0,"y":0},{"id":"fx2","kind":"compressor","params":{"mix":0},"x":0,"y":0},{"id":"out","kind":"limiter","params":{"threshold":0.85},"x":0,"y":0},{"id":"master","kind":"master","params":{},"x":0,"y":0},{"id":"m1clk","kind":"clock","params":{"freq":1},"x":0,"y":0},{"id":"m1pls","kind":"pulse","params":{"widthSec":0.01},"x":0,"y":0},{"id":"m1env","kind":"dahdsr","params":{"attack":0.005,"decay":0.1,"hold":0.01,"release":0.08,"sustain":0},"x":0,"y":0},{"id":"m2lfo","kind":"lfo","params":{"amount":0.2,"rate":0.1},"x":0,"y":0},{"id":"m3clk","kind":"clock","params":{"freq":0.1},"x":0,"y":0},{"id":"m3euc","kind":"euclidean","params":{"hits":4,"rotation":0,"steps":16},"x":0,"y":0},{"id":"m3pls","kind":"pulse","params":{"widthSec":0.02},"x":0,"y":0},{"id":"m3env","kind":"dahdsr","params":{"attack":0.005,"decay":0.16,"hold":0.02,"release":0.12,"sustain":0},"x":0,"y":0}],"connections":[{"source":"m1clk","sourceOutput":"cv","target":"m1pls","targetInput":"input"},{"source":"m1pls","sourceOutput":"cv","target":"m1env","targetInput":"input"},{"source":"m3clk","sourceOutput":"cv","target":"m3euc","targetInput":"input"},{"source":"m3euc","sourceOutput":"audio","target":"m3pls","targetInput":"input"},{"source":"m3pls","sourceOutput":"cv","target":"m3env","targetInput":"input"},{"source":"source","sourceOutput":"audio","target":"filter","targetInput":"input"},{"source":"filter","sourceOutput":"audio","target":"fx1","targetInput":"input"},{"source":"fx1","sourceOutput":"audio","target":"fx2","targetInput":"input"},{"source":"fx2","sourceOutput":"audio","target":"out","targetInput":"input"},{"source":"out","sourceOutput":"audio","target":"master","targetInput":"input"},{"source":"layer","sourceOutput":"audio","target":"filter","targetInput":"input"},{"source":"m2lfo","sourceOutput":"cv","target":"layer","targetInput":"freq"},{"source":"m1env","sourceOutput":"cv","target":"layer","targetInput":"gain"},{"source":"m3env","sourceOutput":"cv","target":"source","targetInput":"gain"}]}
    """#.utf8)
}
