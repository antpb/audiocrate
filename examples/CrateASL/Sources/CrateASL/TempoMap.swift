import Foundation

/// A song's tempo over time, the Swift half of
/// `web-version/packages/crate/src/TempoMap.ts`.
///
/// The first piece of crate's session layer to exist natively. Everything a
/// scene places is placed in musical time and rendered in seconds, so a host
/// that cannot answer "what second is beat 129.7" cannot place a clip, a warp
/// segment, an automation breakpoint or a loop boundary. Until this file the
/// native side had an interpreter and no way to ask that question.
///
/// Pure conversion between beats and seconds. No audio clock, no transport, no
/// scene. Held to `fixtures/tempo-conformance.json` by `TempoConformanceTests`.
///
/// **A map with no changes returns exactly what the constant-tempo formula
/// returns.** Not approximately: the same expression, so a project that never
/// sets a tempo change schedules bit-for-bit the way it did before tempo maps
/// existed. That is the property the whole design is arranged around, and it
/// is why the arithmetic below is written the way it is rather than the way
/// that reads better.

public enum TempoCurve: String, Sendable, Equatable {
    /// Holds this tempo until the next change. A plain tempo marker.
    case jump
    /// Moves linearly to the next change's tempo across the span. An
    /// accelerando or a ritardando.
    case ramp
}

public struct TempoChange: Sendable, Equatable {
    /// Musical position of the change, in beats from the timeline origin.
    public let atBeat: Double
    public let bpm: Double
    public let curve: TempoCurve

    public init(atBeat: Double, bpm: Double, curve: TempoCurve = .jump) {
        self.atBeat = atBeat
        self.bpm = bpm
        self.curve = curve
    }
}

/// One span, with its start precomputed in both units.
///
/// `slope` is the tempo's rate of change in BPM per beat, and it is **exactly
/// zero** for every constant span. That zero is load-bearing: it is what
/// selects the plain multiply-and-divide path, so a map with no ramps computes
/// through the identical expression a map without ramps ever did.
public struct TempoSegment: Sendable, Equatable {
    public let atBeat: Double
    public let atSeconds: Double
    public let bpm: Double
    public let slope: Double
}

/// Beats to seconds, written as `(beats * 60) / bpm` and not as
/// `beats * (60 / bpm)`.
///
/// Those are not the same number. Pre-dividing rounds once more and the two
/// disagree in the last bit at some tempos: 129.7 beats at 174 bpm differ by
/// one unit in the last place. Inaudible, and still not acceptable, because a
/// map with no changes has to return the existing answer rather than one that
/// is merely very close to it. The fixture probes exactly that pair.
@inline(__always) private func beatsToSeconds(_ beats: Double, _ bpm: Double) -> Double {
    (beats * 60) / bpm
}

@inline(__always) private func secondsToBeats(_ seconds: Double, _ bpm: Double) -> Double {
    (seconds * bpm) / 60
}

/// Time across a span whose tempo moves linearly with the beat.
///
/// With tempo `v(b) = v0 + k(b - b0)`, seconds accumulate as the integral of
/// `60 / v(b)`, which is `(60 / k) * ln(v(b) / v0)`. Averaging the two tempos
/// is wrong in a way that looks right: a ramp from 60 to 120 over four beats
/// takes 2.77 seconds, not the 2.67 an average gives, because the slow end
/// lasts longer than the fast end and a mean over beats does not know that.
///
/// A slope of exactly zero never reaches here, which is what keeps a constant
/// span on the plain expression.
@inline(__always) private func rampSeconds(_ fromBpm: Double, _ slope: Double, _ beats: Double) -> Double {
    let endBpm = fromBpm + slope * beats
    return (60 / slope) * log(endBpm / fromBpm)
}

/// The inverse: how many beats a ramp covers in a given time.
@inline(__always) private func rampBeats(_ fromBpm: Double, _ slope: Double, _ seconds: Double) -> Double {
    (fromBpm * (exp((slope * seconds) / 60) - 1)) / slope
}

/// Seconds from a span's start to a beat inside it.
@inline(__always) private func spanSecondsFrom(_ segment: TempoSegment, _ beat: Double) -> Double {
    let beats = beat - segment.atBeat
    // Outside the span, and on every constant span, the plain expression.
    return segment.slope != 0 && beats > 0
        ? rampSeconds(segment.bpm, segment.slope, beats)
        : beatsToSeconds(beats, segment.bpm)
}

public struct TempoMapError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

public struct TempoMap: Sendable, Equatable {
    /// Ascending by `atBeat`. Always at least one, starting at beat 0.
    public let segments: [TempoSegment]

    /// `changes` may arrive unsorted and may contain a change at beat 0, which
    /// replaces `baseBpm`. A later change at a beat already taken wins,
    /// because an editor that writes the same position twice means the second.
    public init(
        _ changes: [TempoChange] = [],
        baseBpm: Double = 120,
        baseCurve: TempoCurve = .jump
    ) throws {
        try TempoMap.assertTempo("baseBpm", baseBpm)

        // Insertion order preserved so a duplicate beat resolves to the last
        // one written, the way a dictionary keyed by beat does in TypeScript.
        var order: [Double] = []
        var byBeat: [Double: (bpm: Double, curve: TempoCurve)] = [:]
        for change in changes {
            guard change.atBeat.isFinite else {
                throw TempoMapError("TempoMap: atBeat must be finite, got \(change.atBeat)")
            }
            guard change.atBeat >= 0 else {
                throw TempoMapError("TempoMap: atBeat must not be negative, got \(change.atBeat)")
            }
            try TempoMap.assertTempo("bpm", change.bpm)
            if byBeat[change.atBeat] == nil { order.append(change.atBeat) }
            byBeat[change.atBeat] = (change.bpm, change.curve)
        }

        let ordered = order.sorted().map { ($0, byBeat[$0]!) }
        let start = ordered.first.flatMap { $0.0 == 0 ? $0.1 : nil } ?? (baseBpm, baseCurve)

        // Beats and tempos first, because a ramp's duration depends on where
        // it ends and the end is the next span's start.
        var spans: [(atBeat: Double, bpm: Double, curve: TempoCurve)] = [
            (0, start.0, start.1)
        ]
        for (atBeat, entry) in ordered where atBeat != 0 {
            spans.append((atBeat, entry.bpm, entry.curve))
        }

        var built: [TempoSegment] = []
        for i in 0..<spans.count {
            let span = spans[i]
            let next = i + 1 < spans.count ? spans[i + 1] : nil
            // A ramp needs somewhere to ramp to. The last span has no next
            // tempo, so it holds: an accelerando with no destination is not a
            // shape, it is a missing marker, and guessing one would invent a
            // tempo nobody wrote.
            let slope: Double
            if span.curve == .ramp, let next, next.atBeat > span.atBeat {
                slope = (next.bpm - span.bpm) / (next.atBeat - span.atBeat)
            } else {
                slope = 0
            }
            // Accumulated from the previous span's start, so rounding never
            // compounds across a run of changes the way repeated addition of a
            // per-beat increment would.
            let atSeconds = built.last.map { $0.atSeconds + spanSecondsFrom($0, span.atBeat) } ?? 0
            built.append(TempoSegment(atBeat: span.atBeat, atSeconds: atSeconds, bpm: span.bpm, slope: slope))
        }
        segments = built
    }

    /// A map that is one tempo throughout, which is the common case.
    public static func constant(_ bpm: Double) throws -> TempoMap {
        try TempoMap([], baseBpm: bpm)
    }

    /// True when nothing changes, so a caller can take the cheap path.
    public var isConstant: Bool { segments.count == 1 }

    /// Tempo before the first change.
    public var baseBpm: Double { segments[0].bpm }

    /// The curve of the span before the first change.
    public var baseCurve: TempoCurve { segments[0].slope != 0 ? .ramp : .jump }

    /// True when any span ramps rather than holding.
    public var hasRamps: Bool { segments.contains { $0.slope != 0 } }

    /// The changes this map was built from, normalised and sorted.
    public var changes: [TempoChange] {
        segments.dropFirst().map {
            TempoChange(atBeat: $0.atBeat, bpm: $0.bpm, curve: $0.slope != 0 ? .ramp : .jump)
        }
    }

    public func bpmAtBeat(_ beat: Double) -> Double {
        let segment = segmentAtBeat(beat)
        if segment.slope == 0 { return segment.bpm }
        return segment.bpm + segment.slope * max(0, beat - segment.atBeat)
    }

    public func bpmAtSeconds(_ seconds: Double) -> Double {
        let segment = segmentAtSeconds(seconds)
        if segment.slope == 0 { return segment.bpm }
        return bpmAtBeat(beatAtSeconds(seconds))
    }

    /// Seconds from the timeline origin to a musical position.
    ///
    /// A negative beat extrapolates backwards at the first segment's tempo
    /// rather than clamping to zero. Clamping would silently pile everything
    /// before the origin onto it, and something scheduled before the origin is
    /// a caller's business to reject, not this function's to hide.
    public func secondsAtBeat(_ beat: Double) -> Double {
        let segment = segmentAtBeat(beat)
        // The first segment starts at zero, so a map with no changes reduces
        // to `(beat * 60) / bpm` with no addition in the way.
        let offset = spanSecondsFrom(segment, beat)
        return segment.atSeconds == 0 ? offset : segment.atSeconds + offset
    }

    /// The inverse, to within a few units in the last place rather than
    /// exactly: each direction is one correctly-rounded expression and the
    /// composition is two roundings. See the same note in `TempoMap.ts`.
    public func beatAtSeconds(_ seconds: Double) -> Double {
        let segment = segmentAtSeconds(seconds)
        let elapsed = seconds - segment.atSeconds
        let offset = segment.slope != 0 && elapsed > 0
            ? rampBeats(segment.bpm, segment.slope, elapsed)
            : secondsToBeats(elapsed, segment.bpm)
        return segment.atBeat == 0 ? offset : segment.atBeat + offset
    }

    /// How long a span of beats lasts, starting from a musical position.
    public func spanSeconds(fromBeat: Double, beats: Double) -> Double {
        secondsAtBeat(fromBeat + beats) - secondsAtBeat(fromBeat)
    }

    /// Every tempo change at or after `fromBeat`, with the second it falls on.
    public func segmentsFrom(beat: Double) -> [TempoSegment] {
        segments.filter { $0.atBeat > beat }
    }

    /// The span the playhead is inside, so a caller resuming mid-ramp can hand
    /// the audio thread where it actually is rather than the last marker.
    public func segment(at beat: Double) -> TempoSegment { segmentAtBeat(beat) }

    private func segmentAtBeat(_ beat: Double) -> TempoSegment {
        // Linear from the end: a song has tens of tempo changes and the caller
        // is usually near the last one it asked about.
        var i = segments.count - 1
        while i > 0 {
            if beat >= segments[i].atBeat { return segments[i] }
            i -= 1
        }
        return segments[0]
    }

    private func segmentAtSeconds(_ seconds: Double) -> TempoSegment {
        var i = segments.count - 1
        while i > 0 {
            if seconds >= segments[i].atSeconds { return segments[i] }
            i -= 1
        }
        return segments[0]
    }

    private static func assertTempo(_ name: String, _ bpm: Double) throws {
        guard bpm.isFinite, bpm > 0 else {
            throw TempoMapError("TempoMap: \(name) must be a positive finite number, got \(bpm)")
        }
    }
}
