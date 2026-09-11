import XCTest
@testable import CrateASL

/// Loading a `crate.plugin` the way an AUv3 will.
///
/// The document is the contract between a patcher nobody runs on the phone
/// and a host that has to render its graph anyway, so the interesting cases
/// are the ones where the two sides could quietly disagree: a document with
/// no compiled half, a parameter with no address, an address that has to
/// reach the interpreter by name.
final class PluginDocumentTests: XCTestCase {

    /// Shaped like what `compileCratePlugin` writes: a gain with one
    /// published parameter, addressed.
    private let pluginJSON = """
    {
      "version": 1,
      "kind": "crate.plugin",
      "id": "user.test-gain",
      "label": "Test Gain",
      "role": "insert",
      "patch": { "nodes": [], "connections": [] },
      "compiled": {
        "name": "Test Gain",
        "role": "insert",
        "ports": ["input"],
        "params": {
          "g_gain": { "min": 0, "max": 4, "default": 1, "address": 0, "unit": "x", "curve": "linear" },
          "g_hidden": { "min": 0, "max": 1, "default": 0.5 }
        },
        "graph": {
          "inputs": ["g_gain"],
          "output": {
            "id": 3, "kind": "mul", "params": {}, "inputs": {
              "a": { "id": 1, "kind": "port", "params": { "name": "input" }, "inputs": {} },
              "b": { "id": 2, "kind": "param", "params": { "name": "g_gain" }, "inputs": {} }
            }
          }
        }
      }
    }
    """.data(using: .utf8)!

    func testLoadsAndRendersFromTheDocument() throws {
        let doc = try CratePluginDocument.decode(pluginJSON)
        XCTAssertEqual(doc.id, "user.test-gain")
        XCTAssertFalse(doc.compiled!.isInstrument)

        let compiled = try doc.requireCompiled()
        let map = ParameterMap(compiled.params)
        let voice = try CompiledVoice(document: compiled.graph)
        let state = voice.makeState()
        state.setParams(map.defaults)

        // The graph is `input * g_gain`, and the default gain is 1.
        var input = [Float](repeating: 0, count: 8)
        for i in 0..<8 { input[i] = Float(i) / 8 }
        var output = [Float](repeating: 0, count: 8)
        var right: [Float]? = nil
        voice.renderBlock(state, sampleRate: 48000, output: &output, input: input, outputR: &right)
        XCTAssertEqual(output, input)

        // A host writing the parameter by address has to reach the name the
        // interpreter reads. That hop is the whole job of ParameterMap.
        let name = try XCTUnwrap(map.nameForAddress[0])
        state.setParam(name, 0.5)
        voice.renderBlock(state, sampleRate: 48000, output: &output, input: input, outputR: &right)
        for i in 0..<8 { XCTAssertEqual(output[i], input[i] * 0.5, accuracy: 1e-7) }
    }

    /// Crate distinguishes "a parameter" from "an automatable parameter".
    /// Only the second gets an address, and only the second belongs in a
    /// parameter tree; the first still needs its default seeded or the graph
    /// reads zero for it.
    func testUnaddressedParametersAreSeededButNotExposed() throws {
        let compiled = try CratePluginDocument.decode(pluginJSON).requireCompiled()
        let map = ParameterMap(compiled.params)

        XCTAssertEqual(map.addresses, [0])
        XCTAssertNil(map.nameForAddress[1])
        XCTAssertEqual(map.defaults["g_hidden"], 0.5)
        XCTAssertFalse(compiled.params["g_hidden"]!.isAutomatable)
        XCTAssertTrue(compiled.params["g_gain"]!.isAutomatable)
    }

    /// A document from before the compiled form existed is old, not corrupt.
    /// Say so, rather than rendering silence and letting someone find out on
    /// stage.
    func testDocumentWithoutACompiledGraphIsRefusedClearly() throws {
        let json = """
        {"version":1,"kind":"crate.plugin","id":"user.old","label":"Old","role":"insert",
         "patch":{"nodes":[],"connections":[]}}
        """.data(using: .utf8)!
        let doc = try CratePluginDocument.decode(json)
        XCTAssertNil(doc.compiled)
        XCTAssertThrowsError(try doc.requireCompiled()) { error in
            XCTAssertTrue("\(error)".lowercased().contains("re-export"), "\(error)")
        }
    }
}
