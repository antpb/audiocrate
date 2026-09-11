import XCTest
@testable import CrateASL

/// Can this run inside a render callback.
///
/// The number that matters is the **realtime factor**: how many seconds of
/// audio one second of CPU renders. A voice at 50x can have fifty of itself on
/// a core before the quantum is full, minus everything else the machine is
/// doing. At 48 kHz a 128-frame quantum is 2.67 ms, and an AUv3 has to finish
/// every voice inside that with room for the host, the OS, and whatever else
/// the musician has running.
///
/// This runs on whatever machine invoked it, so the absolute values move.
/// Compare two builds in one session; do not compare a laptop to a phone.
final class PerformanceTests: XCTestCase {

    func testRendersFasterThanRealtime() throws {
        let fixture = try ConformanceTests.loadFixture()
        let input = fixture.input.map { Float($0) }
        let seconds = 1.0
        let blocks = Int((seconds * fixture.sampleRate) / Double(fixture.frames))

        struct Result { let name: String; let realtime: Double; let msPerBlock: Double }
        var results = [Result]()

        for testCase in fixture.cases {
            let voice = try CompiledVoice(document: testCase.graph)
            let state = voice.makeState()
            state.setParams(fixture.params)
            voice.noteOn(state)

            var output = [Float](repeating: 0, count: fixture.frames)
            var right: [Float]? = nil
            let feed = testCase.insert ? input : nil

            // Warm the buffers and the branch predictors on the same shapes
            // the timed loop uses.
            for _ in 0..<64 {
                voice.renderBlock(state, sampleRate: fixture.sampleRate, output: &output, input: feed, outputR: &right)
            }

            let started = DispatchTime.now().uptimeNanoseconds
            for _ in 0..<blocks {
                voice.renderBlock(state, sampleRate: fixture.sampleRate, output: &output, input: feed, outputR: &right)
            }
            let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6
            let rendered = Double(blocks * fixture.frames) / fixture.sampleRate
            results.append(
                Result(name: testCase.name, realtime: rendered / (elapsedMs / 1000), msPerBlock: elapsedMs / Double(blocks))
            )
        }

        let sorted = results.sorted { $0.realtime < $1.realtime }
        let quantumMs = (Double(fixture.frames) / fixture.sampleRate) * 1000
        var lines = ["", "=== CrateASL throughput, \(fixture.frames) frames at \(Int(fixture.sampleRate)) Hz (\(String(format: "%.2f", quantumMs)) ms quantum) ==="]
        lines.append("slowest ten:")
        for result in sorted.prefix(10) {
            lines.append(String(format: "  %-22@ %8.1fx  %7.4f ms/block  %5d voices/core",
                                result.name as NSString, result.realtime, result.msPerBlock,
                                Int(quantumMs / result.msPerBlock)))
        }
        let median = sorted[sorted.count / 2]
        lines.append(String(format: "median: %@ at %.1fx", median.name, median.realtime))
        print(lines.joined(separator: "\n") + "\n")

        // A guard, not a target, and only meaningful in a release build.
        // Swift debug builds keep every bounds check and retain, and run this
        // interpreter about fifteen times slower; asserting against that
        // number would either be trivially true or permanently red.
        #if DEBUG
        print("debug build: throughput guard skipped. Run `swift test -c release` for a real number.\n")
        #else
        XCTAssertGreaterThan(sorted.first!.realtime, 10, "slowest case: \(sorted.first!.name)")
        #endif
    }
}
