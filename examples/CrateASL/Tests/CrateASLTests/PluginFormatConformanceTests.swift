import XCTest
@testable import CrateASL

/// `crate.plugin` format 2, read by the native host.
///
/// Replays `fixtures/plugin-format-conformance.json`: real materials written
/// as format 1 and format 2 text by JavaScript, and what JavaScript rendered
/// from them. Both texts have to decode here, resolve to exactly the distinct
/// nodes JavaScript wrote, and render what JavaScript rendered.
final class PluginFormatConformanceTests: XCTestCase {
    struct Fixture: Decodable {
        let version: Int
        let sampleRate: Double
        let frames: Int
        let blocks: Int
        let input: [Double]
        let cases: [Case]
    }

    struct Case: Decodable {
        let name: String
        let role: String
        let v1: String
        let v2: String
        let v1Nodes: Int
        let v2Nodes: Int
        let uniqueNodes: Int
        let params: [String: Double]
        let left: [Double]
        let right: [Double]?
    }

    /// The same bound the ASL conformance suite holds renders to.
    static let tolerance = 5e-6

    static func loadFixture() throws -> Fixture {
        let data = try Data(contentsOf: CrateFixtures.url("plugin-format-conformance.json"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    private func distinctIds(_ node: ASLNodeDocument, into seen: inout Set<Int>) {
        XCTAssertFalse(node.isReference, "an unresolved reference reached the compiler")
        guard seen.insert(node.id).inserted else { return }
        for child in node.inputs.values { distinctIds(child, into: &seen) }
        for child in node.list ?? [] { distinctIds(child, into: &seen) }
    }

    private func render(_ text: String, _ entry: Case, _ fixture: Fixture) throws -> (left: [Float], right: [Float]?) {
        let doc = try CratePluginDocument.decode(Data(text.utf8))
        let compiled = try doc.requireCompiled()
        var ids = Set<Int>()
        distinctIds(compiled.graph.output, into: &ids)
        XCTAssertEqual(ids.count, entry.uniqueNodes, "\(entry.name): resolved to a different set of nodes")

        let voice = try CompiledVoice(document: compiled.graph)
        let state = voice.makeState()
        state.setParams(entry.params)
        voice.noteOn(state)
        let input = fixture.input.map { Float($0) }
        let inputR = input.map { -$0 }
        let insert = entry.role == "insert"
        var output = [Float](repeating: 0, count: fixture.frames)
        var right: [Float]? = [Float](repeating: 0, count: fixture.frames)
        var left = [Float]()
        var rights = [Float]()
        var stereo = false
        for _ in 0..<fixture.blocks {
            stereo = voice.renderBlock(
                state,
                sampleRate: fixture.sampleRate,
                output: &output,
                input: insert ? input : nil,
                inputR: insert ? inputR : nil,
                outputR: &right
            )
            left += output
            rights += right ?? []
        }
        return (left, stereo ? rights : nil)
    }

    func testBothFormatsRenderWhatJavaScriptRendered() throws {
        let fixture = try Self.loadFixture()
        XCTAssertEqual(fixture.version, 1)
        XCTAssertGreaterThanOrEqual(fixture.cases.count, 6, "fixture looks truncated")
        XCTAssertTrue(
            fixture.cases.contains { $0.v2.contains("\"ref\"") },
            "no case writes a reference, so format 2 is not being exercised"
        )

        for entry in fixture.cases {
            let one = try render(entry.v1, entry, fixture)
            let two = try render(entry.v2, entry, fixture)

            // Format 1 and 2 are the same document, so the same interpreter
            // must render them to the bit. A tolerance here would hide a
            // reference resolved to a copy.
            XCTAssertEqual(one.left, two.left, "\(entry.name): format 2 renders differently from format 1")
            XCTAssertEqual(one.right, two.right, "\(entry.name): format 2 right channel differs")

            XCTAssertEqual(one.left.count, entry.left.count)
            var worst = 0.0
            for (index, expected) in entry.left.enumerated() {
                worst = max(worst, abs(Double(one.left[index]) - expected))
            }
            if let expectedRight = entry.right {
                guard let actualRight = one.right else {
                    XCTFail("\(entry.name): JavaScript wrote the right channel and Swift mirrored it")
                    continue
                }
                for (index, expected) in expectedRight.enumerated() {
                    worst = max(worst, abs(Double(actualRight[index]) - expected))
                }
            } else {
                XCTAssertNil(one.right, "\(entry.name): Swift wrote a right channel JavaScript mirrored")
            }
            XCTAssertLessThanOrEqual(worst, Self.tolerance, "\(entry.name): worst deviation \(worst)")
        }
    }

    private func plugin(version: Int, output: String) -> Data {
        Data(
            """
            {"version":\(version),"kind":"crate.plugin","id":"user.t","label":"t","role":"insert",
             "patch":{"nodes":[],"connections":[]},
             "compiled":{"graph":{"inputs":[],"output":\(output)},"params":{},"name":"t","role":"insert","ports":[]}}
            """.utf8
        )
    }

    func testAReferenceWithNoDefinitionIsRefused() {
        let data = plugin(version: 2, output: #"{"id":1,"kind":"add","params":{},"inputs":{"a":{"ref":9}}}"#)
        XCTAssertThrowsError(try CratePluginDocument.decode(data)) { error in
            XCTAssertTrue("\(error)".contains("never defines"), "\(error)")
        }
    }

    func testANodeThatIsItsOwnInputIsRefused() {
        let data = plugin(version: 2, output: #"{"id":1,"kind":"mul","params":{},"inputs":{"a":{"ref":1}}}"#)
        XCTAssertThrowsError(try CratePluginDocument.decode(data)) { error in
            XCTAssertTrue("\(error)".contains("its own input"), "\(error)")
        }
    }

    func testANewerFormatIsRefusedBeforeAnythingIsRead() {
        let data = plugin(version: CratePluginDocument.maxVersion + 1, output: #"{"ref":1}"#)
        XCTAssertThrowsError(try CratePluginDocument.decode(data)) { error in
            XCTAssertTrue("\(error)".contains("newer audiocrate"), "\(error)")
        }
    }

    func testAReferenceSharesTheNodeRatherThanCopyingItsState() throws {
        // One delay reached twice must be one delay line: the sum of the two
        // paths is exactly twice either one. Two delay lines fed the same
        // signal would also sum to twice, so the proof is in the plan: the
        // compiled voice has as many slots as distinct ids, not appearances.
        let data = plugin(
            version: 2,
            output: #"""
            {"id":1,"kind":"add","params":{},"inputs":{
              "a":{"id":2,"kind":"delay","params":{"maxTimeSec":0.01},"inputs":{
                "input":{"id":3,"kind":"port","params":{"name":"input"},"inputs":{}},
                "timeSec":{"id":4,"kind":"const","params":{"value":0.001},"inputs":{}},
                "feedback":{"id":5,"kind":"const","params":{"value":0},"inputs":{}},
                "mix":{"id":6,"kind":"const","params":{"value":1},"inputs":{}}}},
              "b":{"ref":2}}}
            """#
        )
        let compiled = try CratePluginDocument.decode(data).requireCompiled()
        var ids = Set<Int>()
        distinctIds(compiled.graph.output, into: &ids)
        XCTAssertEqual(ids.count, 6)
        let voice = try CompiledVoice(document: compiled.graph)
        XCTAssertEqual(voice.plan.slotCount, 6, "a reference was compiled as a second node")
    }
}
