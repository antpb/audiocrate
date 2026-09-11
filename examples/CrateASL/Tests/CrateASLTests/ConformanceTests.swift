import XCTest
@testable import CrateASL

/// Does the Swift interpreter render what the JavaScript one renders.
///
/// The fixture is written by `scripts/emit-asl-fixtures.ts`
/// from the same graphs the JavaScript golden-audio snapshot is taken from,
/// so the two implementations cannot be checked against different things and
/// both claim to pass. Each case carries the graph as a document, the first
/// rendered block (attacks, one-shots, impulses) and the last (steady state,
/// every ring buffer wrapped at least once), for both output channels.
///
/// Bit-exactness is not the bar, and pretending it were would be dishonest.
/// V8 computes `Math.sin` with a bundled fdlibm port; Swift calls Apple's
/// libm. Two correct implementations of the same function are allowed to
/// disagree in the last bit, so a digest comparison would fail for a reason
/// that is not a bug. What is asserted instead is a deviation small enough to
/// be inaudible by a wide margin, reported per case so the number can be
/// looked at rather than trusted.
///
/// Three things beyond the samples are asserted here, and they are what turn
/// "we validated this once" into "it cannot silently stop being true"
/// (`docs/CRATE_OVERVIEW.md` section 5.1):
///
///   - the fixture is a format this build understands, so a field added on
///     the JavaScript side cannot be silently ignored;
///   - `NodeKind.allCases` and the fixture's kind list are the same set, so a
///     kind added in TypeScript fails here instead of throwing in a DAW;
///   - every kind has a case behind it, or an exemption the fixture states.
///
/// Run with `/usr/bin/swift test`. A `swiftly`-managed toolchain earlier on
/// PATH links against a system `ld` that does not know
/// `-no_warn_duplicate_libraries`, and the failure looks like a broken
/// package rather than a broken toolchain selection.
final class ConformanceTests: XCTestCase {

    /// The fixture format this build reads. Mirrors
    /// `CONFORMANCE_FIXTURE_VERSION` in `asl/conformanceFixture.ts`.
    static let expectedVersion = 2

    struct Fixture: Decodable {
        struct Case: Decodable {
            let name: String
            let insert: Bool
            let graph: ASLGraphDocument
            let first: [Double]
            let last: [Double]
            /// Present only for a graph evaluated once per channel.
            let firstR: [Double]?
            let lastR: [Double]?
        }
        let version: Int
        let stamp: String
        let sampleRate: Double
        let frames: Int
        let blocks: Int
        let bpm: Double
        let params: [String: Double]
        let input: [Double]
        let inputR: [Double]
        let kinds: [String]
        let transportFields: [String]
        let exemptKinds: [String: String]
        let cases: [Case]
    }

    /// Deviation allowed between the two implementations, as an absolute
    /// difference on signals that live in roughly [-1, 1]. Five millionths of
    /// full scale is about 106 dB down: far below the noise floor of any
    /// converter, and far below a 24-bit LSB.
    static let tolerance = 5e-6

    static func loadFixture() throws -> Fixture {
        if let override = ProcessInfo.processInfo.environment["CRATE_ASL_FIXTURE"] {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: override)))
        }
        let url = CrateFixtures.url("asl-conformance.json")
        return try JSONDecoder().decode(Fixture.self, from: url.dataOrThrow())
    }

    /// What the host says the song is doing at the start of block `index`.
    /// The same rule as `transportForBlock` in `asl/goldenCases.ts`; both
    /// derive it from the fixture's own tempo rather than hardcoding one, so
    /// changing the tempo there does not silently desync this.
    static func transport(forBlock index: Int, _ fixture: Fixture) -> TransportSnapshot {
        TransportSnapshot(
            beats: (Double(index) * Double(fixture.frames) * fixture.bpm) / (fixture.sampleRate * 60),
            bpm: fixture.bpm,
            playing: true,
            beatsPerBar: 4,
            beatUnit: 4
        )
    }

    func testFixtureIsAFormatThisBuildUnderstands() throws {
        let fixture = try Self.loadFixture()
        XCTAssertEqual(
            fixture.version, Self.expectedVersion,
            "fixture is version \(fixture.version), this build reads \(Self.expectedVersion). "
                + "Decoding the half it recognises would report full marks while checking "
                + "less than the fixture describes."
        )
    }

    /// The check that used to be a human diffing two enum declarations and
    /// writing "symmetric difference: 0" into a document.
    func testNodeVocabulariesAreIdentical() throws {
        let fixture = try Self.loadFixture()
        let swiftKinds = Set(NodeKind.allCases.map(\.rawValue))
        let jsKinds = Set(fixture.kinds)

        let missingInSwift = jsKinds.subtracting(swiftKinds).sorted()
        let extraInSwift = swiftKinds.subtracting(jsKinds).sorted()

        XCTAssertTrue(
            missingInSwift.isEmpty,
            "kinds crate can emit that this interpreter cannot decode: \(missingInSwift.joined(separator: ", ")). "
                + "A graph using one of these throws at load time, in the field, on somebody's exported patch."
        )
        XCTAssertTrue(
            extraInSwift.isEmpty,
            "kinds this interpreter has that crate no longer emits: \(extraInSwift.joined(separator: ", ")). "
                + "Dead code at best, a renamed node whose old spelling still half-works at worst."
        )
    }

    /// Every kind has audio behind it, or a stated reason it cannot.
    ///
    /// The JavaScript suite asserts this too. It is asserted again here
    /// because the two suites can be run separately and this is the one that
    /// runs against the file as checked in.
    func testEveryKindHasACase() throws {
        let fixture = try Self.loadFixture()
        var covered = Set<String>()
        func walk(_ node: ASLNodeDocument) {
            covered.insert(node.kind)
            for child in node.inputs.values { walk(child) }
            for child in node.list ?? [] { walk(child) }
        }
        for testCase in fixture.cases { walk(testCase.graph.output) }

        let uncovered = NodeKind.allCases
            .map(\.rawValue)
            .filter { !covered.contains($0) && fixture.exemptKinds[$0] == nil }
            .sorted()
        XCTAssertTrue(
            uncovered.isEmpty,
            "node kinds no case renders, so nothing here is held to them: \(uncovered.joined(separator: ", "))"
        )
    }

    func testMatchesTheJavaScriptInterpreter() throws {
        let fixture = try Self.loadFixture()
        XCTAssertGreaterThan(fixture.cases.count, 50, "fixture looks truncated")

        let input = fixture.input.map { Float($0) }
        let inputR = fixture.inputR.map { Float($0) }
        var worstName = ""
        var worstDiff = 0.0
        var exactCount = 0
        var stereoCount = 0
        var inexact = [String]()
        var failures = [String]()

        for testCase in fixture.cases {
            let voice = try CompiledVoice(document: testCase.graph)
            let state = voice.makeState()
            state.setParams(fixture.params)
            voice.noteOn(state)

            var output = [Float](repeating: 0, count: fixture.frames)
            var right: [Float]? = [Float](repeating: 0, count: fixture.frames)
            var first = [Float]()
            var firstR = [Float]()
            var wroteRight = false
            for block in 0..<fixture.blocks {
                wroteRight = voice.renderBlock(
                    state,
                    sampleRate: fixture.sampleRate,
                    output: &output,
                    input: testCase.insert ? input : nil,
                    inputR: testCase.insert ? inputR : nil,
                    outputR: &right,
                    transport: Self.transport(forBlock: block, fixture)
                )
                if block == 0 {
                    first = output
                    firstR = right ?? []
                }
            }

            // A fixture case that carries a right channel and an
            // implementation that declines to fill one are not a rounding
            // disagreement, they are a stereo insert collapsing to mono. That
            // is a real bug this project has already shipped once, and
            // comparing only the samples it did write would hide it.
            let expectsStereo = testCase.firstR != nil
            if expectsStereo != wroteRight {
                failures.append(
                    "\(testCase.name): JavaScript \(expectsStereo ? "wrote" : "mirrored") the right channel, Swift "
                        + "\(wroteRight ? "wrote" : "mirrored") it"
                )
                continue
            }
            if expectsStereo { stereoCount += 1 }

            var caseWorst = 0.0
            for (index, expected) in testCase.first.enumerated() {
                caseWorst = max(caseWorst, abs(Double(first[index]) - expected))
            }
            for (index, expected) in testCase.last.enumerated() {
                caseWorst = max(caseWorst, abs(Double(output[index]) - expected))
            }
            if let expectedFirstR = testCase.firstR, let expectedLastR = testCase.lastR {
                let lastR = right ?? []
                for (index, expected) in expectedFirstR.enumerated() {
                    caseWorst = max(caseWorst, abs(Double(firstR[index]) - expected))
                }
                for (index, expected) in expectedLastR.enumerated() {
                    caseWorst = max(caseWorst, abs(Double(lastR[index]) - expected))
                }
            }

            if caseWorst == 0 {
                exactCount += 1
            } else {
                inexact.append("\(testCase.name) \(caseWorst)")
            }
            if caseWorst > worstDiff {
                worstDiff = caseWorst
                worstName = testCase.name
            }
            if caseWorst > Self.tolerance {
                failures.append("\(testCase.name): \(caseWorst)")
            }
        }

        print("""

        === ASL conformance, Swift against JavaScript ===
        fixture stamp    \(fixture.stamp) (v\(fixture.version))
        cases            \(fixture.cases.count), \(stereoCount) of them stereo
        node kinds       \(fixture.kinds.count), \(fixture.exemptKinds.count) exempt
        bit-exact        \(exactCount)
        worst deviation  \(worstDiff) (\(worstName))
        tolerance        \(Self.tolerance)
        not bit-exact    \(inexact.isEmpty ? "none" : inexact.joined(separator: ", "))

        """)

        XCTAssertTrue(
            failures.isEmpty,
            "cases outside tolerance:\n  " + failures.joined(separator: "\n  ")
        )
    }

    /// A graph is a DAG and JSON cannot say "the same node again", so a shared
    /// subgraph is written out more than once with the same id. Re-sharing by
    /// id is what keeps one filter one filter. A decoder that misses this
    /// gives a shared node two pieces of state, which sounds almost right,
    /// which is the worst way for it to be wrong.
    func testSharedSubgraphsCompileToOneNode() throws {
        let json = """
        {"inputs":[],"output":{"id":3,"kind":"add","params":{},"inputs":{
          "a":{"id":2,"kind":"mul","params":{},"inputs":{
            "a":{"id":1,"kind":"const","params":{"value":2},"inputs":{}},
            "b":{"id":1,"kind":"const","params":{"value":2},"inputs":{}}}},
          "b":{"id":1,"kind":"const","params":{"value":2},"inputs":{}}}}}
        """.data(using: .utf8)!
        let voice = try CompiledVoice(json: json)
        // Three distinct nodes, not five: the constant appears three times in
        // the document and is one node in the plan.
        XCTAssertEqual(voice.plan.slotCount, 3)
        XCTAssertEqual(voice.renderSample(voice.makeState(), sampleRate: 48000), 6)
    }

    /// A document naming a kind this build does not have must fail loudly.
    /// A graph half-understood is worse than a graph refused, because the
    /// failure is inaudible until someone notices the sound is wrong.
    func testUnknownKindIsRefused() {
        let json = """
        {"inputs":[],"output":{"id":1,"kind":"quantumReverb","params":{},"inputs":{}}}
        """.data(using: .utf8)!
        XCTAssertThrowsError(try CompiledVoice(json: json))
    }
}

private extension URL {
    /// `Data(contentsOf:)` with a message that says which file, because the
    /// fixture not being where it should be is the most likely first failure
    /// for anyone running this suite for the first time.
    func dataOrThrow() throws -> Data {
        do {
            return try Data(contentsOf: self)
        } catch {
            throw ASLCompileError(
                "conformance fixture not found at \(path). Expected fixtures/asl-conformance.json, "
                    + "or set CRATE_ASL_FIXTURE."
            )
        }
    }
}
