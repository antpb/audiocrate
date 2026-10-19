import XCTest

@testable import CrateASL

/// The render thread and the thread that sets parameters, on the same voice.
///
/// An AUv3 sets a parameter on whichever thread the host or the plugin's own
/// view is on, and `VoiceState.params` is a Swift dictionary. Reading one
/// while another thread reshapes its storage is not a stale number, it is a
/// wild pointer: holding a note on a Sample Player and dragging its rate took
/// the render thread down with `EXC_BAD_ACCESS` in `evalPort`, which used to
/// answer an unwired port out of that dictionary.
///
/// A `VoicePool` never wires its ports, so every voice of an instrument patch
/// reads one of these for every sample, which is what made the window wide
/// enough to hit by hand.
final class PortScalarRaceTests: XCTestCase {

    /// Reads the main port and multiplies it by a parameter, so the render
    /// path touches both a port and a param on every sample.
    private func voice() throws -> CompiledVoice {
        let json = """
        {"inputs":["gain"],"output":{"id":0,"kind":"mul","params":{},"inputs":{
          "a":{"id":1,"kind":"port","params":{"name":"input"},"inputs":{}},
          "b":{"id":2,"kind":"param","params":{"name":"gain"},"inputs":{}}}}}
        """
        return try CompiledVoice(json: json.data(using: .utf8)!)
    }

    func testAnUnwiredPortStillReadsTheScalarSetByName() throws {
        // The back-compat path the dictionary used to provide: a graph
        // written against the old scalar `input` sets it as if it were a
        // parameter, and the port reads it.
        let voice = try self.voice()
        let state = voice.makeState()
        state.setParam("gain", 1)
        state.setParam("input", 0.25)

        var out = [Float](repeating: 0, count: 8)
        out.withUnsafeMutableBufferPointer { buffer in
            _ = voice.render(state, sampleRate: 48000, frames: 8,
                             outL: buffer.baseAddress!, outR: nil)
        }
        for sample in out { XCTAssertEqual(sample, 0.25, accuracy: 1e-6) }
    }

    func testSettingParametersWhileRenderingDoesNotCorruptTheVoice() throws {
        let voice = try self.voice()
        let pool = VoicePool(voice: voice, polyphony: 4)
        pool.setParams(["gain": 1])
        for note in [60, 64, 67, 71] { pool.noteOn(note: note, velocity: 1) }

        // The other thread, doing what an editor slider does: set the same
        // parameter over and over for as long as the render loop runs.
        let writing = Thread {
            var i = 0
            while !Thread.current.isCancelled && i < 200_000 {
                pool.setParam("gain", Double(i % 100) / 100)
                pool.setParam("input", Double(i % 7) / 7)
                i += 1
            }
        }
        writing.start()

        var out = [Float](repeating: 0, count: 256)
        out.withUnsafeMutableBufferPointer { buffer in
            for _ in 0..<2_000 {
                _ = pool.render(sampleRate: 48000, frames: 256,
                                outL: buffer.baseAddress!, outR: nil)
            }
        }
        writing.cancel()

        // Reaching here at all is the assertion: before the port scalar moved
        // out of `params`, this pair of loops segfaulted rather than failed.
        XCTAssertEqual(pool.polyphony, 4)
    }
}
