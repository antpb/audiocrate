import XCTest
@testable import CrateASL

/// Delete-and-pass-through, the module clipboard and plugin export, held to
/// what the web patcher does. The pass-through cases are
/// `editor/test/passthrough.test.ts` case for case; the clip and the ids are
/// strings the JavaScript produced (tsx, 2026-09-29).
final class PatchEditsTests: XCTestCase {

    private func link(_ source: String, _ output: String, _ target: String, _ input: String) -> CratePatchConnection {
        CratePatchConnection(source: source, sourceOutput: output, target: target, targetInput: input)
    }

    private func patch(_ connections: [CratePatchConnection]) -> CratePatch {
        var ids = [String]()
        for connection in connections {
            for id in [connection.source, connection.target] where !ids.contains(id) { ids.append(id) }
        }
        return CratePatch(nodes: ids.map { CratePatchNode(id: $0, kind: "gain") }, connections: connections)
    }

    // MARK: passthrough.test.ts

    func testStackedInputsThroughAnInsertAreRewiredIntoMaster() {
        let p = patch([
            link("pan0", "audio", "limiter", "input"),
            link("pan1", "audio", "limiter", "input"),
            link("pan2", "audio", "limiter", "input"),
            link("limiter", "audio", "master", "input"),
        ])
        XCTAssertEqual(p.passthroughConnections(removing: "limiter"), [
            link("pan0", "audio", "master", "input"),
            link("pan1", "audio", "master", "input"),
            link("pan2", "audio", "master", "input"),
        ])
    }

    func testASingleInputFansOutToEveryDestination() {
        let p = patch([
            link("gain", "audio", "eq", "input"),
            link("eq", "audio", "master", "input"),
            link("eq", "audio", "meter", "input"),
        ])
        XCTAssertEqual(p.passthroughConnections(removing: "eq"), [
            link("gain", "audio", "master", "input"),
            link("gain", "audio", "meter", "input"),
        ])
    }

    func testSidechainAndCvInletsAreDropped() {
        let p = patch([
            link("keys", "cv", "synth", "note"),
            link("keys", "gate", "synth", "gate"),
            link("line", "audio", "amp", "input"),
            link("amp", "audio", "master", "input"),
        ])
        XCTAssertEqual(p.passthroughConnections(removing: "amp"), [link("line", "audio", "master", "input")])
        XCTAssertEqual(p.passthroughConnections(removing: "synth"), [])
    }

    func testAnExistingCableIsNotDoubledAndNothingLoops() {
        let p = patch([
            link("gain", "audio", "eq", "input"),
            link("eq", "audio", "gain", "input"),
            link("eq", "audio", "master", "input"),
            link("gain", "audio", "master", "input"),
        ])
        XCTAssertEqual(p.passthroughConnections(removing: "eq"), [])
    }

    func testASinkOrASourceHasNothingToCarry() {
        XCTAssertEqual(patch([link("gain", "audio", "master", "input")]).passthroughConnections(removing: "master"), [])
        XCTAssertEqual(patch([link("line", "audio", "amp", "input")]).passthroughConnections(removing: "line"), [])
    }

    // MARK: removing

    func testRemovingWithPassThroughKeepsTheChainPlaying() {
        var p = patch([
            link("line", "audio", "lowpass", "input"),
            link("lfo", "audio", "lowpass", "cutoff"),
            link("lowpass", "audio", "master", "input"),
        ])
        p.removeNode("lowpass", passThrough: true)
        XCTAssertNil(p.node("lowpass"))
        XCTAssertEqual(p.connections, [link("line", "audio", "master", "input")])
    }

    func testRemovingWithoutPassThroughLeavesAGap() {
        var p = patch([
            link("line", "audio", "lowpass", "input"),
            link("lowpass", "audio", "master", "input"),
        ])
        p.removeNode("lowpass")
        XCTAssertEqual(p.connections, [])
        XCTAssertEqual(p.nodes.map(\.id), ["line", "master"])
    }

    // MARK: nodeClip.ts

    /// `stringifyNodeClip` on a lowpass with a sample name in its data.
    private let browserClip = """
    {
      "version": 1,
      "kind": "crate.nodeclip",
      "node": {
        "kind": "lowpass",
        "x": 10.5,
        "y": -4,
        "params": {
          "cutoff": 800,
          "q": 2
        },
        "data": {
          "sampleFilename": "kick.wav"
        }
      }
    }
    """

    func testAModuleCopiedInTheBrowserPastesHere() throws {
        let node = try XCTUnwrap(CrateNodeClip.parse(browserClip))
        XCTAssertEqual(node.id, "")
        XCTAssertEqual(node.kind, "lowpass")
        XCTAssertEqual(node.x, 10.5)
        XCTAssertEqual(node.y, -4)
        XCTAssertEqual(node.params, ["cutoff": 800, "q": 2])
        XCTAssertEqual(node.data?["sampleFilename"], .string("kick.wav"))
    }

    func testAModuleCopiedHereReadsBackTheSameAndCarriesNoId() throws {
        let original = CratePatchNode(id: "0123456789abcdef", kind: "delay", x: 3, y: 4, params: ["timeSec": 0.25])
        let text = CrateNodeClip.encode(original)
        XCTAssertFalse(text.contains("0123456789abcdef"), "a clip is a module, not a node: the paste mints the id")
        let back = try XCTUnwrap(CrateNodeClip.parse(text))
        XCTAssertEqual(back.kind, "delay")
        XCTAssertEqual(back.params, ["timeSec": 0.25])
        XCTAssertEqual(back.x, 3)
    }

    func testAPatchOrPlainTextIsNotAClip() {
        XCTAssertNil(CrateNodeClip.parse(#"{"version":1,"kind":"crate.patch","nodes":[],"connections":[]}"#))
        XCTAssertNil(CrateNodeClip.parse("lowpass"))
        XCTAssertNil(CrateNodeClip.parse(#"{"kind":"crate.nodeclip","version":1,"node":{"kind":""}}"#))
    }

    func testPastesOfOneClipStackDownwards() {
        XCTAssertTrue(CrateNodeClip.pasteOffset(x: 10, y: 20, generation: 1) == (46, 56))
        XCTAssertTrue(CrateNodeClip.pasteOffset(x: 10, y: 20, generation: 3) == (118, 128))
        XCTAssertTrue(CrateNodeClip.pasteOffset(x: 10, y: 20, generation: 0) == (46, 56))
    }

    // MARK: pluginDoc.ts

    func testAPluginIsNamedTheWayTheBrowserNamesIt() {
        XCTAssertEqual(CratePluginExport.pluginId(for: "My Patch"), "user.my-patch")
        XCTAssertEqual(CratePluginExport.pluginId(for: "  Warm -- Pad!! "), "user.warm-pad")
        XCTAssertEqual(CratePluginExport.pluginId(for: "Ünïcode Bass 2"), "user.n-code-bass-2")
        XCTAssertEqual(CratePluginExport.pluginId(for: "***"), "user.plugin")
        XCTAssertEqual(CratePluginExport.pluginId(for: "a_b.c"), "user.a-b-c")
    }

    func testAnExportedPluginLoadsAndRunsTheGraphThePatchFlattensTo() throws {
        let catalog = try MaterialCatalog.bundled()
        let starter = CratePatch(
            nodes: [
                CratePatchNode(id: "line", kind: catalog.io.line),
                CratePatchNode(id: "lp", kind: "lowpass", params: ["cutoff": 900]),
                CratePatchNode(id: "master", kind: catalog.io.master),
            ],
            connections: [
                link("line", "audio", "lp", "input"),
                link("lp", "audio", "master", "input"),
            ]
        )
        let data = try CratePluginExport.document(starter, label: "Dark Filter", role: .insert, catalog: catalog)

        // What a host does with it: sniff, decode, lift the compiled half.
        guard case .plugin(let doc) = CrateDocumentKind.sniff(data) else {
            return XCTFail("an exported plugin does not sniff as one")
        }
        XCTAssertEqual(doc.version, 1)
        XCTAssertEqual(doc.id, "user.dark-filter")
        XCTAssertEqual(doc.label, "Dark Filter")
        XCTAssertEqual(doc.role, "insert")
        let compiled = try doc.requireCompiled()
        XCTAssertEqual(compiled.name, "Dark Filter")
        XCTAssertEqual(compiled.params["lp_cutoff"]?.defaultValue, 900)

        // The same plugin a flatten here produces. Not compared as bytes:
        // flatten numbers nodes as it walks a dictionary, so two flattens of
        // one patch can number them differently (the flatten fixture compares
        // a canonical renumbering for exactly this reason). What a host sees
        // is compared instead, and then what it hears.
        let direct = try CrateFlatten.flatten(starter, catalog: catalog, name: "Dark Filter", role: .insert)
        XCTAssertEqual(compiled.params, direct.params)
        XCTAssertEqual(compiled.ports, direct.ports)
        XCTAssertEqual(compiled.role, direct.role)
        XCTAssertEqual(compiled.polyphony, direct.polyphony)
        XCTAssertEqual(compiled.graph.smooth, direct.graph.smooth)
        func render(_ document: CompiledMaterialDocument) throws -> [Float] {
            let voice = try CompiledVoice(document: document.graph)
            let state = voice.makeState(seed: 7)
            state.setParams(ParameterMap(document.params).defaults)
            var input = (0..<256).map { Float(sin(Double($0) * 0.3)) }
            var out = [Float](repeating: 0, count: 256)
            input.withUnsafeMutableBufferPointer { inBuffer in
                out.withUnsafeMutableBufferPointer { outBuffer in
                    _ = voice.render(state, sampleRate: 48000, frames: 256, outL: outBuffer.baseAddress!, outR: nil,
                                     inL: UnsafePointer(inBuffer.baseAddress!), inR: nil)
                }
            }
            return out
        }
        let heard = try render(compiled)
        XCTAssertEqual(heard, try render(direct))
        XCTAssertGreaterThan(heard.map(abs).max() ?? 0, 0.01, "silent renders agree about nothing")

        // And it carries the patch, so it reopens editable.
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let patchData = try JSONSerialization.data(withJSONObject: try XCTUnwrap(object["patch"]))
        XCTAssertEqual(try CratePatch.decode(patchData), starter)
    }

    func testAPatchThatCannotFlattenIsRefusedAtExport() throws {
        let catalog = try MaterialCatalog.bundled()
        let noMaster = CratePatch(nodes: [CratePatchNode(id: "lp", kind: "lowpass")])
        XCTAssertThrowsError(try CratePluginExport.document(noMaster, label: "x", role: .insert, catalog: catalog))
    }
}
