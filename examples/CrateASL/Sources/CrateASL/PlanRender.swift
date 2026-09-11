import Foundation

/// Rendering a scene plan to samples, the Swift half of
/// `web-version/packages/crate/src/session/planRender.ts`.
///
/// `schedulePlan` proves two implementations agree about numbers. This proves
/// they agree about **audio**, which is the claim the whole session-as-data arc
/// is for: the same plan, bounced in two languages, sample for sample.
///
/// ## Why the sources are generated rather than loaded
///
/// A plan names sources by id and a host resolves them. A conformance test
/// cannot ship a wav to two languages and expect their decoders to agree,
/// because then it would be testing decoders. So a source here is a formula
/// both sides evaluate.
///
/// `ramp` is the important one and it is chosen, not arbitrary. Its sample at
/// file position `t` is `t`, so **a rendered sample is the file position it
/// came from**. A clip placed one frame late, read at the wrong rate, or
/// skipped into by the wrong amount produces a visibly wrong number rather
/// than a subtly different waveform.
///
/// ## The summation order is part of the contract
///
/// Floating-point addition is not associative, so "sum every contribution" is
/// not a specification. Tracks in plan order, clips in track order, windows in
/// clip order, into one running total, then master gain once at the end. Two
/// implementations that follow that produce identical bits; two that do not
/// are entitled to differ in the last place, and then nobody can tell a
/// rounding from a bug.
///
/// Pan and inserts are deliberately absent: a pan law is already covered by
/// the `panLaw` ASL node, and an insert's DSP is a graph, which is already
/// conformant. The render is mono.

public enum PlanSourceSpec: Sendable, Equatable {
    /// `sample(t) = t`, so a rendered sample states the file position.
    case ramp(durationSec: Double)
    /// Piecewise constant. A misplaced read lands on a different plateau.
    case steps(durationSec: Double, stepSec: Double)
    /// The one transcendental source, for a case that looks like audio.
    case sine(durationSec: Double, hz: Double)

    public var durationSec: Double {
        switch self {
        case let .ramp(duration): return duration
        case let .steps(duration, _): return duration
        case let .sine(duration, _): return duration
        }
    }
}

extension PlanSourceSpec: Decodable {
    private enum CodingKeys: String, CodingKey { case kind, durationSec, stepSec, hz }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        let duration = try container.decode(Double.self, forKey: .durationSec)
        switch kind {
        case "ramp":
            self = .ramp(durationSec: duration)
        case "steps":
            self = .steps(durationSec: duration, stepSec: try container.decode(Double.self, forKey: .stepSec))
        case "sine":
            self = .sine(durationSec: duration, hz: try container.decode(Double.self, forKey: .hz))
        default:
            throw ScenePlanError(
                "unknown plan source kind \"\(kind)\". A source this build cannot generate would "
                    + "render as silence, which looks like a correct plan with a quiet clip."
            )
        }
    }
}

/// A source as a buffer, at the render's sample rate.
public func generateSource(_ spec: PlanSourceSpec, sampleRate: Double) -> [Float] {
    let frames = max(0, Int(midiRound(spec.durationSec * sampleRate)))
    var out = [Float](repeating: 0, count: frames)
    for i in 0..<frames {
        let t = Double(i) / sampleRate
        switch spec {
        case .ramp:
            out[i] = Float(t)
        case let .steps(_, stepSec):
            out[i] = Float((t / stepSec).rounded(.down))
        case let .sine(_, hz):
            out[i] = Float(sin(2 * Double.pi * hz * t))
        }
    }
    return out
}

/// One sample from a source at an arbitrary file position.
///
/// Linear interpolation between the two neighbouring frames, zero outside the
/// source. Stated explicitly because a resampling rule that is merely whatever
/// each implementation happened to write is not a contract: nearest-neighbour
/// and linear differ audibly on a stretched clip and agree exactly at rate 1,
/// so the disagreement would hide in every unstretched case.
public func sampleSourceAt(_ source: [Float], fileSec: Double, sampleRate: Double) -> Double {
    guard fileSec >= 0 else { return 0 }
    let position = fileSec * sampleRate
    let index = Int(position.rounded(.down))
    guard index >= 0, index < source.count else { return 0 }
    let frac = position - position.rounded(.down)
    let a = Double(source[index])
    let b = index + 1 < source.count ? Double(source[index + 1]) : 0
    return a + (b - a) * frac
}

/// A plan, from its playhead, as mono samples.
///
/// The order of accumulation is the contract. See the note at the top.
public func renderPlan(
    _ plan: ScenePlan,
    sources: [String: PlanSourceSpec],
    sampleRate: Double,
    durationSec: Double,
    atSec: Double = 0
) throws -> [Float] {
    var buffers: [String: [Float]] = [:]
    for (id, spec) in sources { buffers[id] = generateSource(spec, sampleRate: sampleRate) }

    let schedule = try schedulePlan(plan, at: atSec) { sources[$0]?.durationSec }
    let frames = max(0, Int(midiRound(durationSec * sampleRate)))
    var out = [Float](repeating: 0, count: frames)

    for i in 0..<frames {
        let t = Double(i) / sampleRate
        var acc = 0.0
        for track in schedule.tracks {
            if track.gain == 0 { continue }
            for clip in track.clips {
                guard let source = buffers[clip.source] else { continue }
                for window in clip.windows {
                    // Timeline extent of a window is its file extent divided by
                    // the playback rate: a rate of 0.5 makes two file seconds
                    // last four.
                    let timelineDurationSec = window.fileDurationSec / window.playbackRate
                    if t < window.whenSec { continue }
                    if t >= window.whenSec + timelineDurationSec { continue }
                    let fileSec = window.fileOffsetSec + (t - window.whenSec) * window.playbackRate
                    acc += sampleSourceAt(source, fileSec: fileSec, sampleRate: sampleRate)
                        * clip.gain * track.gain
                }
            }
        }
        out[i] = Float(acc * schedule.masterGain)
    }
    return out
}
