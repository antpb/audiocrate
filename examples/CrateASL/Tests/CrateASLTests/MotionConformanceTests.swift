import XCTest
@testable import CrateASL

/// Every palette material, rendered while its parameters move, against what
/// JavaScript rendered. Replays `fixtures/motion-conformance.json`; graphs
/// come from the bundled `material-catalog.json`, the file the native palette
/// ships, so this compares the palette a user actually patches with.
///
/// The ASL fixture holds parameters fixed. This one steps every parameter
/// through its range four times, releases the note and strikes a second one,
/// so it exercises what only runs when something changes: block-rate caches
/// going stale, delay read pointers gliding, filter coefficients recomputing,
/// envelopes releasing and retriggering.
final class MotionConformanceTests: XCTestCase {
    struct Fixture: Decodable {
        let version: Int
        let sampleRate: Double
        let frames: Int
        let blocks: Int
        let bpm: Double
        let inputL: [Double]
        let inputR: [Double]
        let cases: [Case]
        let silent: [String]
    }

    struct Event: Decodable {
        let block: Int
        let params: [String: Double]?
        let note: String?
        let noteParams: [String: Double]?
    }

    struct Case: Decodable {
        let kind: String
        let insert: Bool
        let events: [Event]
        let left: [Double]
        let right: [Double]?
    }

    /// Absolute, scaled by the case's own peak once that exceeds 1, so a
    /// material whose output is a note number or a frequency is held to the
    /// same relative precision as one whose output is audio.
    static let tolerance = 5e-6

    /// The first-note parameters, `FIRST_NOTE` in motionConformance.ts.
    static let firstNote: [String: Double] = ["note": 57, "velocity": 0.8]

    func testEveryPaletteMaterialMovesTheWayJavaScriptMoves() throws {
        let data = try Data(contentsOf: CrateFixtures.url("motion-conformance.json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        XCTAssertEqual(fixture.version, 1, "a motion fixture this build does not understand")
        XCTAssertGreaterThan(fixture.cases.count, 90, "fixture looks truncated")

        let catalog = try MaterialCatalog.bundled()
        let inputL = fixture.inputL.map { Float($0) }
        let inputR = fixture.inputR.map { Float($0) }
        var failures = [String]()
        var compared = 0
        var worstKind = ""
        var worstRatio = 0.0

        for entry in fixture.cases {
            if MaterialCatalogTests.knownUncompilable.contains(entry.kind) { continue }
            guard let material = catalog.material(entry.kind) else {
                failures.append("\(entry.kind): in the motion fixture and not in the catalog")
                continue
            }
            let voice = try CompiledVoice(document: material.graph)
            let state = voice.makeState()
            for name in material.paramOrder {
                if let descriptor = material.params[name] { state.setParam(name, descriptor.defaultValue) }
            }
            voice.noteOn(state, params: Self.firstNote)

            var output = [Float](repeating: 0, count: fixture.frames)
            var right: [Float]? = [Float](repeating: 0, count: fixture.frames)
            var left = [Float]()
            var rights = [Float]()
            var stereo = false
            for block in 0..<fixture.blocks {
                for event in entry.events where event.block == block {
                    if let params = event.params {
                        // Sorted, so the dictionary's order cannot matter; it
                        // does not, but a test should not rely on that.
                        for name in params.keys.sorted() { voice.setParam(state, name, params[name]!) }
                    }
                    if event.note == "off" { voice.noteOff(state) }
                    if event.note == "on" { voice.noteOn(state, params: event.noteParams ?? [:]) }
                }
                let from = block * fixture.frames
                let to = from + fixture.frames
                stereo = voice.renderBlock(
                    state,
                    sampleRate: fixture.sampleRate,
                    output: &output,
                    input: entry.insert ? Array(inputL[from..<to]) : nil,
                    inputR: entry.insert ? Array(inputR[from..<to]) : nil,
                    outputR: &right,
                    transport: TransportSnapshot(
                        beats: (Double(block) * Double(fixture.frames) * fixture.bpm) / (fixture.sampleRate * 60),
                        bpm: fixture.bpm,
                        playing: true,
                        beatsPerBar: 4,
                        beatUnit: 4
                    )
                )
                left += output
                rights += right ?? []
            }

            if (entry.right != nil) != stereo {
                failures.append(
                    "\(entry.kind): JavaScript \(entry.right != nil ? "wrote" : "mirrored") the right channel, "
                        + "Swift \(stereo ? "wrote" : "mirrored") it"
                )
                continue
            }
            let peak = entry.left.reduce(0) { max($0, abs($1)) }
            let bound = Self.tolerance * max(1, peak)
            var worst = 0.0
            var worstAt = 0
            for (index, expected) in entry.left.enumerated() {
                let diff = abs(Double(left[index]) - expected)
                if diff > worst { worst = diff; worstAt = index }
            }
            if let expectedRight = entry.right {
                for (index, expected) in expectedRight.enumerated() {
                    worst = max(worst, abs(Double(rights[index]) - expected))
                }
            }
            compared += 1
            if worst / bound > worstRatio { worstRatio = worst / bound; worstKind = entry.kind }
            if worst > bound {
                failures.append(
                    "\(entry.kind): worst \(worst) at sample \(worstAt) (block \(worstAt / fixture.frames)), bound \(bound)"
                )
            }
        }

        print("motion conformance: \(compared) materials, closest to the bound: \(worstKind) at \(worstRatio)")
        XCTAssertTrue(failures.isEmpty, "materials that move differently:\n  " + failures.joined(separator: "\n  "))
    }
}
