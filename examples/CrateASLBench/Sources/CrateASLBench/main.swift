import CrateASL
import Foundation

// Every factory patch as the plugin runs it: an instrument with 8 voices held
// through a VoicePool, an effect over a noise input. 256 frames at 48 kHz.
// Reports the best of several passes per patch, so a stray scheduler hiccup
// does not land in the number.

let sampleRate = 48000.0
let frames = 256
let blocksPerPass = Int(sampleRate) / frames  // one second of audio
let passes = 5
let args = Array(CommandLine.arguments.dropFirst())

// `--song <dir>`: a real project. The directory holds, per crate track,
// `<n>_<label>.json` (the instance's saved `crateCompiledGraph`, which is the
// document the appex renders) and `<n>_<label>.events.json`
// (`[[sampleFrame, note, velocity 0...1, 0 = off], ...]`), plus
// `song_seconds`. Each track renders the whole song through a VoicePool the
// way the appex builds one, notes applied at block boundaries.
if args.first == "--song", args.count > 1 {
    let dir = URL(fileURLWithPath: args[1])
    let seconds = Double((try? String(contentsOf: dir.appendingPathComponent("song_seconds"), encoding: .utf8)) ?? "60")!
    let blocks = Int(seconds * sampleRate) / frames
    let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        .filter { $0.hasSuffix(".json") && !$0.hasSuffix(".events.json") }.sorted()
    var outL = [Float](repeating: 0, count: frames)
    var outR = [Float](repeating: 0, count: frames)
    var total = 0.0
    var sink: Float = 0
    for file in files {
        let data = try Data(contentsOf: dir.appendingPathComponent(file))
        let document = try JSONDecoder().decode(CompiledMaterialDocument.self, from: data)
        let eventsURL = dir.appendingPathComponent(String(file.dropLast(5)) + ".events.json")
        let events = (try JSONSerialization.jsonObject(with: Data(contentsOf: eventsURL))) as! [[Double]]
        let voice = try CompiledVoice(document: document.graph)
        let pool = VoicePool(voice: voice, polyphony: max(1, document.polyphony ?? 8), seed: 7)
        pool.setParams(ParameterMap(document.params).defaults)
        var next = 0
        var peakVoices = 0
        var digest: UInt64 = 0xcbf29ce484222325
        var hashTime = 0.0
        let t0 = now()
        outL.withUnsafeMutableBufferPointer { l in
            outR.withUnsafeMutableBufferPointer { r in
                for block in 0..<blocks {
                    let end = Double((block + 1) * frames)
                    while next < events.count, events[next][0] < end {
                        let e = events[next]
                        if e[2] > 0 { pool.noteOn(note: Int(e[1]), velocity: e[2]) } else { pool.noteOff(note: Int(e[1])) }
                        next += 1
                    }
                    pool.render(sampleRate: sampleRate, frames: frames, outL: l.baseAddress!, outR: r.baseAddress!)
                    sink += l[7]
                    // Bit digest of both channels, so a speed change can be
                    // checked against the real patches, not just the factory set.
                    let h0 = now()
                    for i in 0..<frames {
                        digest = (digest ^ UInt64(l[i].bitPattern)) &* 0x100000001b3
                        digest = (digest ^ UInt64(r[i].bitPattern)) &* 0x100000001b3
                    }
                    hashTime += now() - h0
                    if block & 63 == 0 { peakVoices = max(peakVoices, pool.activeVoiceCount) }
                }
            }
        }
        let t = now() - t0 - hashTime
        total += t
        print(String(format: "%8.2f ms/s  %5.2f%% of one core  peak voices %d  digest %016llx  %@", t / seconds * 1000, t / seconds * 100, peakVoices, digest, file))
    }
    print(String(format: "all tracks: %.2f ms per second of audio = %.1f%% of one core (%.0f s song, sink %g)",
                 total / seconds * 1000, total / seconds * 100, seconds, sink))
    exit(0)
}
let filter = args.first

let catalog = try MaterialCatalog.bundled()
let library = try FactoryLibrary.bundled()

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

var left = [Float](repeating: 0, count: frames)
var right = [Float](repeating: 0, count: frames)
var noiseL = [Float](repeating: 0, count: frames)
var noiseR = [Float](repeating: 0, count: frames)
var seed: UInt32 = 12345
for i in 0..<frames {
    seed = seed &* 1664525 &+ 1013904223
    noiseL[i] = Float(seed >> 8) / Float(1 << 24) * 0.5 - 0.25
    seed = seed &* 1664525 &+ 1013904223
    noiseR[i] = Float(seed >> 8) / Float(1 << 24) * 0.5 - 0.25
}

var instrumentTotal = 0.0
var effectTotal = 0.0
var sink: Float = 0
var rows: [(String, Double)] = []

for entry in library.patches {
    if let filter, !entry.id.contains(filter) { continue }
    let compiled = try CrateFlatten.flatten(entry.patch, catalog: catalog, name: entry.name)
    let voice = try CompiledVoice(document: compiled.graph)
    let defaults = ParameterMap(compiled.params).defaults
    var best = Double.infinity
    if compiled.isInstrument {
        for _ in 0..<passes {
            let pool = VoicePool(voice: voice, polyphony: 8, seed: 7)
            pool.setParams(defaults)
            for n in 0..<8 { pool.noteOn(note: 48 + n * 3, velocity: 0.8) }
            let t0 = now()
            left.withUnsafeMutableBufferPointer { l in
                right.withUnsafeMutableBufferPointer { r in
                    for _ in 0..<blocksPerPass {
                        pool.render(sampleRate: sampleRate, frames: frames, outL: l.baseAddress!, outR: r.baseAddress!)
                        sink += l[7]
                    }
                }
            }
            best = min(best, now() - t0)
        }
        instrumentTotal += best
    } else {
        for _ in 0..<passes {
            let state = voice.makeState(seed: 7)
            state.setParams(defaults)
            state.gate = true
            var outR: [Float]? = right
            let t0 = now()
            for _ in 0..<blocksPerPass {
                voice.renderBlock(state, sampleRate: sampleRate, output: &left, input: noiseL, inputR: noiseR, outputR: &outR)
                sink += left[7]
            }
            best = min(best, now() - t0)
        }
        effectTotal += best
    }
    rows.append(("\(compiled.isInstrument ? "inst" : "fx  ") \(entry.id)", best))
}

// Milliseconds of CPU per second of audio, the inverse of x-realtime.
for (name, t) in rows.sorted(by: { $0.1 > $1.1 }).prefix(15) {
    print(String(format: "%8.2f ms/s  %@", t * 1000, name))
}
print(String(format: "instruments (8 voices): %.1f ms per second of audio, summed", instrumentTotal * 1000))
print(String(format: "effects:                %.1f ms per second of audio, summed", effectTotal * 1000))
print(String(format: "total:                  %.1f ms   (sink %g)", (instrumentTotal + effectTotal) * 1000, sink))
