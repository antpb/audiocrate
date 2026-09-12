import XCTest
@testable import CrateASL

/// Holds the Swift `flattenPatch` to the JavaScript one.
///
/// The fixture is `fixtures/flatten-conformance.json`, written by
/// `npm run fixtures:flatten` from the same `flattenPatch` the browser runs.
/// Both sides lower the same patches; this asserts they produce the same
/// graph, the same published parameters and the same addresses.
///
/// Node ids are not compared directly and cannot be: they come off a global
/// counter in each language. What is compared is a **canonical renumbering**,
/// first-visit order over sorted input keys, with the graph flattened into a
/// list so that a shared subgraph is one entry referenced twice. That last
/// part is the reason not to compare expanded trees: an expansion cannot tell
/// one filter used twice from two identical filters, and the difference is
/// one delay line against two fed the same signal.
final class FlattenConformanceTests: XCTestCase {

    // MARK: - Fixture shape

    private struct Fixture: Decodable {
        let version: Int
        let io: PatchIoKinds
        let cases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let proves: String
        let patch: CratePatch
        let role: String?
        let expected: Expectation
    }

    private struct Expectation: Decodable {
        let name: String
        let role: String
        let polyphony: Int?
        let ports: [String]
        let params: [String: CrateParamDescriptor]
        let graph: CanonicalGraph
    }

    private struct CanonicalGraph: Decodable, Equatable {
        let inputs: [String]
        let channels: Int?
        let output: Int
        let nodes: [CanonicalNode]
    }

    private struct CanonicalNode: Decodable, Equatable {
        let id: Int
        let kind: String
        let params: [String: ASLValue]
        let inputs: [String: Int]
        let list: [Int]?
    }

    // MARK: - Canonical form

    /// The Swift half of `canonicalGraph` in `editor/src/flattenConformance.ts`.
    /// Both sides must walk in the same order or the numbering means nothing,
    /// which is why inputs are visited by sorted key on both.
    private func canonical(_ graph: ASLGraphDocument) -> CanonicalGraph {
        var nodes = [CanonicalNode]()
        var assigned = [Int: Int]()

        func visit(_ node: ASLNodeDocument) -> Int {
            if let already = assigned[node.id] { return already }
            // The slot is reserved before the children are walked, so an id is
            // the order a node was first reached rather than the order it
            // finished being built.
            let id = nodes.count
            assigned[node.id] = id
            nodes.append(CanonicalNode(id: id, kind: node.kind, params: node.params, inputs: [:], list: nil))
            var inputs = [String: Int]()
            for key in node.inputs.keys.sorted() {
                inputs[key] = visit(node.inputs[key]!)
            }
            let list = node.list?.map { visit($0) }
            nodes[id] = CanonicalNode(
                id: id, kind: node.kind, params: node.params, inputs: inputs, list: list
            )
            return id
        }

        let output = visit(graph.output)
        return CanonicalGraph(
            inputs: graph.inputs, channels: graph.channels, output: output, nodes: nodes
        )
    }

    // MARK: - Tests

    private func loadFixture() throws -> Fixture {
        let data = try Data(contentsOf: CrateFixtures.url("flatten-conformance.json"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    func testFlattenMatchesJavaScript() throws {
        let fixture = try loadFixture()
        let catalog = try MaterialCatalog.bundled()
        XCTAssertEqual(fixture.version, 1)
        XCTAssertEqual(fixture.io.master, catalog.io.master, "the two generated files disagree about host I/O")
        XCTAssertFalse(fixture.cases.isEmpty)

        for entry in fixture.cases {
            let role = entry.role.flatMap { CrateFlatten.Role(rawValue: $0) }
            let compiled = try CrateFlatten.flatten(
                entry.patch,
                catalog: catalog,
                name: entry.name,
                role: role
            )

            XCTAssertEqual(compiled.name, entry.expected.name, entry.name)
            XCTAssertEqual(compiled.role, entry.expected.role, "\(entry.name): \(entry.proves)")
            XCTAssertEqual(compiled.polyphony, entry.expected.polyphony, "\(entry.name): \(entry.proves)")
            XCTAssertEqual(compiled.ports, entry.expected.ports, "\(entry.name): \(entry.proves)")

            XCTAssertEqual(
                Set(compiled.params.keys),
                Set(entry.expected.params.keys),
                "\(entry.name): published parameters differ. \(entry.proves)"
            )
            for (name, expected) in entry.expected.params {
                XCTAssertEqual(compiled.params[name], expected, "\(entry.name).\(name)")
            }

            let produced = canonical(compiled.graph)
            XCTAssertEqual(
                produced.nodes.count,
                entry.expected.graph.nodes.count,
                "\(entry.name): node count differs, so sharing differs. \(entry.proves)"
            )
            XCTAssertEqual(produced.inputs, entry.expected.graph.inputs, "\(entry.name): parameter order")
            XCTAssertEqual(produced.output, entry.expected.graph.output, entry.name)
            for (index, expected) in entry.expected.graph.nodes.enumerated() {
                guard index < produced.nodes.count else { break }
                let actual = produced.nodes[index]
                XCTAssertEqual(actual.kind, expected.kind, "\(entry.name): node \(index) kind")
                XCTAssertEqual(actual.params, expected.params, "\(entry.name): node \(index) params")
                XCTAssertEqual(actual.inputs, expected.inputs, "\(entry.name): node \(index) inputs")
                XCTAssertEqual(actual.list, expected.list, "\(entry.name): node \(index) list")
            }
        }
    }

    /// Every flattened case has to be a graph this interpreter can actually
    /// run. Matching the fixture proves the lowering agrees with JavaScript;
    /// it does not prove the result compiles here, and a node kind the Swift
    /// enum is missing would pass the comparison and throw in the field.
    ///
    /// Cases built from a material this build cannot compile are counted and
    /// reported rather than skipped quietly. Today that is the looper, whose
    /// material wires seven inputs `Plan.swift` does not have: see
    /// `MaterialCatalogTests.knownUncompilable`. Their *lowering* is still
    /// compared above, which is the part this file is for.
    func testEveryFlattenedCaseCompiles() throws {
        let fixture = try loadFixture()
        let catalog = try MaterialCatalog.bundled()
        var blocked = [String]()
        for entry in fixture.cases {
            let unsupported = entry.patch.nodes
                .map(\.kind)
                .filter { !catalog.canCompile($0) }
            if !unsupported.isEmpty {
                blocked.append("\(entry.name) (\(unsupported.joined(separator: ", ")))")
                continue
            }
            let compiled = try CrateFlatten.flatten(entry.patch, catalog: catalog, name: entry.name)
            XCTAssertNoThrow(
                try CompiledVoice(document: compiled.graph),
                "\(entry.name) flattened to a graph this interpreter cannot compile"
            )
        }
        XCTAssertEqual(
            blocked, ["looper pulse outlet (looper)"],
            "the set of conformance cases this build cannot run changed"
        )
    }

    /// A flattened graph goes into `fullState` as JSON, so it has to survive
    /// the round trip as the same graph. Encoding is new here; nothing else
    /// in the package needed it before a patcher existed.
    func testFlattenedDocumentRoundTripsThroughJSON() throws {
        let fixture = try loadFixture()
        let catalog = try MaterialCatalog.bundled()
        for entry in fixture.cases {
            let compiled = try CrateFlatten.flatten(entry.patch, catalog: catalog, name: entry.name)
            let data = try compiled.encoded()
            let restored = try JSONDecoder().decode(CompiledMaterialDocument.self, from: data)
            XCTAssertEqual(canonical(restored.graph), canonical(compiled.graph), entry.name)
            XCTAssertEqual(restored.params, compiled.params, entry.name)
            XCTAssertEqual(restored.ports, compiled.ports, entry.name)
            XCTAssertEqual(restored.polyphony, compiled.polyphony, entry.name)
        }
    }

    // MARK: - Refusals

    func testRefusesAPatchWithNoMaster() throws {
        let catalog = try MaterialCatalog.bundled()
        let patch = CratePatch(
            nodes: [CratePatchNode(id: "g", kind: "gain")],
            connections: []
        )
        XCTAssertThrowsError(try CrateFlatten.flatten(patch, catalog: catalog)) { error in
            XCTAssertTrue("\(error)".contains("no output"), "\(error)")
        }
    }

    func testRefusesASilentMaster() throws {
        let catalog = try MaterialCatalog.bundled()
        let patch = CratePatch(
            nodes: [
                CratePatchNode(id: "g", kind: "gain"),
                CratePatchNode(id: "out", kind: catalog.io.master),
            ],
            connections: []
        )
        XCTAssertThrowsError(try CrateFlatten.flatten(patch, catalog: catalog)) { error in
            XCTAssertTrue("\(error)".contains("silent"), "\(error)")
        }
    }

    func testRefusesAKernelAndSaysWhich() throws {
        let catalog = try MaterialCatalog.bundled()
        let patch = CratePatch(
            nodes: [
                CratePatchNode(id: "src", kind: catalog.io.line),
                CratePatchNode(id: "amp", kind: "amp"),
                CratePatchNode(id: "out", kind: catalog.io.master),
            ],
            connections: [
                CratePatchConnection(source: "src", sourceOutput: "audio", target: "amp", targetInput: "input"),
                CratePatchConnection(source: "amp", sourceOutput: "audio", target: "out", targetInput: "input"),
            ]
        )
        XCTAssertThrowsError(try CrateFlatten.flatten(patch, catalog: catalog)) { error in
            XCTAssertTrue("\(error)".contains("kernel"), "\(error)")
        }
    }

    func testRefusesAFeedbackCycle() throws {
        let catalog = try MaterialCatalog.bundled()
        let patch = CratePatch(
            nodes: [
                CratePatchNode(id: "a", kind: "gain"),
                CratePatchNode(id: "b", kind: "gain"),
                CratePatchNode(id: "out", kind: catalog.io.master),
            ],
            connections: [
                CratePatchConnection(source: "a", sourceOutput: "audio", target: "b", targetInput: "input"),
                CratePatchConnection(source: "b", sourceOutput: "audio", target: "a", targetInput: "input"),
                CratePatchConnection(source: "b", sourceOutput: "audio", target: "out", targetInput: "input"),
            ]
        )
        XCTAssertThrowsError(try CrateFlatten.flatten(patch, catalog: catalog)) { error in
            XCTAssertTrue("\(error)".contains("cycle"), "\(error)")
        }
    }

    func testRefusesAnUnknownKind() throws {
        let catalog = try MaterialCatalog.bundled()
        let patch = CratePatch(
            nodes: [
                CratePatchNode(id: "x", kind: "not.a.material"),
                CratePatchNode(id: "out", kind: catalog.io.master),
            ],
            connections: [
                CratePatchConnection(source: "x", sourceOutput: "audio", target: "out", targetInput: "input"),
            ]
        )
        XCTAssertThrowsError(try CrateFlatten.flatten(patch, catalog: catalog)) { error in
            XCTAssertTrue("\(error)".contains("not.a.material"), "\(error)")
        }
    }

    // MARK: - Parameter values

    func testOutOfRangeValueKeepsTheDefault() throws {
        let catalog = try MaterialCatalog.bundled()
        let lowpass = try XCTUnwrap(catalog.material("lowpass"))
        let cutoff = try XCTUnwrap(lowpass.param("cutoff"))
        let values = CrateFlatten.resolvedParams(lowpass, ["cutoff": cutoff.max * 10])
        XCTAssertEqual(
            values["cutoff"], cutoff.defaultValue,
            "an out-of-range value in a document is a caller bug and keeps the default; "
                + "clamping would hide it"
        )
    }

    func testSteppedValueSnapsToTheGrid() throws {
        let descriptor = CrateParamDescriptor(
            kind: "stepped", min: 0, max: 10, defaultValue: 0, step: 0.5
        )
        XCTAssertEqual(CrateFlatten.quantize(descriptor, 2.3), 2.5)
        XCTAssertEqual(CrateFlatten.quantize(descriptor, 2.2), 2.0)
        XCTAssertEqual(CrateFlatten.quantize(descriptor, 11), 10)
    }
}
