import XCTest
@testable import CrateASL

/// What polyphony costs, on the real instrument graph.
///
/// Eight voices of a thirty-node patch is eight interpreter walks per sample,
/// and whether that fits inside an audio quantum on a phone is the question
/// the whole instrument path rests on. A laptop is an upper bound, not an
/// answer, but a laptop that cannot do it settles the matter early.
final class PolyphonyCostTests: XCTestCase {

    func testEightVoicesOfTheStarterPatch() throws {
        let url = URL(fileURLWithPath: NSHomeDirectory() + "/Downloads/starter.crate-plugin.json")
        guard let data = try? Data(contentsOf: url),
              case .plugin(let doc) = CrateDocumentKind.sniff(data) else {
            throw XCTSkip("no ~/Downloads/starter.crate-plugin.json")
        }
        let compiled = try doc.requireCompiled()
        let voice = try CompiledVoice(document: compiled.graph)
        let defaults = ParameterMap(compiled.params).defaults

        let frames = 256          // maximumFramesToRender in the extension
        let sampleRate = 48000.0
        let quantumMs = Double(frames) / sampleRate * 1000

        var lines = ["", "=== starter patch, 256 frames at 48 kHz (\(String(format: "%.2f", quantumMs)) ms quantum) ==="]
        for voices in [1, 4, 8] {
            let pool = VoicePool(voice: voice, polyphony: 8)
            pool.setParams(defaults)
            for n in 0..<voices { pool.noteOn(note: 48 + n * 4, velocity: 1) }

            var out = [Float](repeating: 0, count: frames)
            let blocks = Int(2.0 * sampleRate) / frames
            let elapsedMs: Double = out.withUnsafeMutableBufferPointer { buf in
                for _ in 0..<200 {
                    _ = pool.render(sampleRate: sampleRate, frames: frames, outL: buf.baseAddress!, outR: nil)
                }
                let started = DispatchTime.now().uptimeNanoseconds
                for _ in 0..<blocks {
                    _ = pool.render(sampleRate: sampleRate, frames: frames, outL: buf.baseAddress!, outR: nil)
                }
                return Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6
            }
            XCTAssertEqual(pool.activeVoiceCount, voices, "voices should still be held")

            let msPerBlock = elapsedMs / Double(blocks)
            let realtime = (Double(blocks * frames) / sampleRate) / (elapsedMs / 1000)
            lines.append(String(format: "  %d voice%@  %7.1fx realtime  %6.3f ms/block  %4.1f%% of the quantum",
                                voices, voices == 1 ? " " : "s", realtime, msPerBlock,
                                100 * msPerBlock / quantumMs))
        }
        print(lines.joined(separator: "\n") + "\n")
    }
}
