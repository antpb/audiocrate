import XCTest
@testable import CrateASL

/// Picking the wrong one of two similar crate files is the most likely first
/// mistake anyone makes with the importer, so what it says then matters more
/// than what it says on success.
final class DocumentSniffTests: XCTestCase {

    func testTheEditorsSaveFileIsNamedAndRedirected() throws {
        // The real thing: a crate.patch as the node editor writes it.
        let patch = """
        {"kind":"crate.patch","version":1,"nodes":[],"connections":[]}
        """.data(using: .utf8)!
        let refusal = try XCTUnwrap(CrateDocumentKind.sniff(patch).refusal)
        XCTAssertTrue(refusal.contains("crate.patch"), refusal)
        XCTAssertTrue(refusal.contains("Export Plugin"), refusal)
    }

    func testAPluginWithoutACompiledGraphSaysToReExport() throws {
        let old = """
        {"version":1,"kind":"crate.plugin","id":"user.old","label":"Old","role":"insert",
         "patch":{"nodes":[],"connections":[]}}
        """.data(using: .utf8)!
        let refusal = try XCTUnwrap(CrateDocumentKind.sniff(old).refusal)
        XCTAssertTrue(refusal.lowercased().contains("re-export"), refusal)
        XCTAssertTrue(refusal.contains("Old"), refusal)
    }

    func testSomethingElseEntirely() throws {
        let other = #"{"kind":"logic.project","version":3}"#.data(using: .utf8)!
        let refusal = try XCTUnwrap(CrateDocumentKind.sniff(other).refusal)
        XCTAssertTrue(refusal.contains("logic.project"), refusal)

        let garbage = "not json at all".data(using: .utf8)!
        XCTAssertNotNil(CrateDocumentKind.sniff(garbage).refusal)
    }

    func testAGoodPluginIsAccepted() throws {
        let good = """
        {"version":1,"kind":"crate.plugin","id":"user.g","label":"G","role":"insert",
         "patch":{"nodes":[],"connections":[]},
         "compiled":{"name":"G","role":"insert","ports":["input"],"params":{},
           "graph":{"inputs":[],"output":{"id":1,"kind":"port","params":{"name":"input"},"inputs":{}}}}}
        """.data(using: .utf8)!
        let kind = CrateDocumentKind.sniff(good)
        XCTAssertNil(kind.refusal)
        guard case .plugin(let doc) = kind else { return XCTFail("expected a plugin") }
        XCTAssertEqual(doc.id, "user.g")
    }

    /// The converted plugin, if it is still sitting there. Proves the file
    /// the importer will be handed actually compiles and renders.
    func testTheConvertedPluginLoadsAndRenders() throws {
        let url = URL(fileURLWithPath: NSHomeDirectory() + "/Downloads/starter.crate-plugin.json")
        guard let data = try? Data(contentsOf: url) else {
            throw XCTSkip("no ~/Downloads/starter.crate-plugin.json")
        }
        let kind = CrateDocumentKind.sniff(data)
        XCTAssertNil(kind.refusal)
        guard case .plugin(let doc) = kind else { return XCTFail("expected a plugin") }

        let compiled = try doc.requireCompiled()
        let map = ParameterMap(compiled.params)
        let voice = try CompiledVoice(document: compiled.graph)
        let state = voice.makeState()
        state.setParams(map.defaults)
        voice.noteOn(state)

        var out = [Float](repeating: 0, count: 512)
        var right: [Float]? = nil
        let input = (0..<512).map { Float(sin(Double($0) * 0.05)) * 0.5 }
        for _ in 0..<4 {
            voice.renderBlock(state, sampleRate: 48000, output: &out, input: input, outputR: &right)
        }
        XCTAssertTrue(out.allSatisfy { $0.isFinite })
        print("\n  \(doc.label): \(map.addresses.count) automatable of \(compiled.params.count), ports \(compiled.ports)\n")
    }

    /// The note path, on the real instrument graph.
    ///
    /// A flattened instrument reads `param` nodes named `note` and
    /// `velocity` and its envelope reads the voice gate. That is the whole
    /// contract the AUv3's MIDI handler implements, so if this holds, a note
    /// on and a note off are three assignments away.
    func testTheInstrumentSoundsOnANoteAndStopsOnRelease() throws {
        let url = URL(fileURLWithPath: NSHomeDirectory() + "/Downloads/starter.crate-plugin.json")
        guard let data = try? Data(contentsOf: url),
              case .plugin(let doc) = CrateDocumentKind.sniff(data) else {
            throw XCTSkip("no ~/Downloads/starter.crate-plugin.json")
        }
        let compiled = try doc.requireCompiled()
        let voice = try CompiledVoice(document: compiled.graph)
        let state = voice.makeState()
        state.setParams(ParameterMap(compiled.params).defaults)

        var out = [Float](repeating: 0, count: 512)
        var right: [Float]? = nil
        func renderEnergy(_ blocks: Int) -> Double {
            var energy = 0.0
            for _ in 0..<blocks {
                voice.renderBlock(state, sampleRate: 48000, output: &out, outputR: &right)
                for v in out { energy += Double(v) * Double(v) }
            }
            return energy
        }

        // Gate closed: an untriggered envelope is silence, not a quiet hum.
        XCTAssertEqual(renderEnergy(4), 0, accuracy: 1e-12)

        // What the AUv3's note-on does.
        state.setParam("note", 57)
        state.setParam("velocity", 100.0 / 127.0)
        state.gate = true
        let sounding = renderEnergy(16)
        XCTAssertGreaterThan(sounding, 1e-6, "a held note should make sound")

        // And note-off releases it. The delay in this patch keeps ringing, so
        // the claim is that it decays, not that it stops dead.
        state.gate = false
        let firstRelease = renderEnergy(16)
        let laterRelease = renderEnergy(64)
        XCTAssertLessThan(laterRelease / 64, firstRelease / 16, "release should decay")
    }

    /// The file that actually failed, if it is still sitting there.
    func testTheFileFromDownloads() throws {
        let url = URL(fileURLWithPath: NSHomeDirectory() + "/Downloads/crate-patch.json")
        guard let data = try? Data(contentsOf: url) else {
            throw XCTSkip("no ~/Downloads/crate-patch.json")
        }
        let refusal = try XCTUnwrap(CrateDocumentKind.sniff(data).refusal)
        print("\n  refusal for the real file:\n  \(refusal)\n")
        XCTAssertTrue(refusal.contains("Export Plugin"), refusal)
    }
}
