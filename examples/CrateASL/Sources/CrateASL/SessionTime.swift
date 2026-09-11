import Foundation

/// Musical position and automation, the Swift half of
/// `web-version/packages/crate/src/Time.ts`, `asl/transportNodes.ts` (the
/// signature helpers) and `automation/`.
///
/// Slice 3 of crate's session layer, and the last set of inputs a plan
/// document needs. `TempoMap` answers what second a beat falls on,
/// `ClipRegion` answers what plays then, and this answers which beat a musical
/// position *is* and what a parameter is worth at that instant.
///
/// Held to `fixtures/session-conformance.json` by `SessionConformanceTests`.

// MARK: - Time signature

/// The lower number of a time signature. Absent or non-positive means 4: a
/// beat is a quarter note, which is every existing 4/4 and 3/4 project.
public func normalizeBeatUnit(_ beatUnit: Double?) -> Double {
    if let beatUnit, beatUnit > 0 { return beatUnit }
    return 4
}

/// How many quarter-note beats one signature beat lasts. 4/4 is 1, 6/8 is
/// 1/2, 2/2 is 2.
public func signatureBeatBeats(_ beatUnit: Double? = nil) -> Double {
    4 / normalizeBeatUnit(beatUnit)
}

/// Quarter-note beats in one bar. 4/4 is 4, **6/8 is 3**, 2/2 is 4.
///
/// The 6/8 answer is the whole rule. Six eighth-notes are three quarter-notes,
/// and beats are quarter-notes everywhere in crate. Folding the denominator
/// into the tempo instead is the documented mistake, and it is invisible in
/// 4/4, which is most projects.
public func barBeats(_ beatsPerBar: Double? = nil, _ beatUnit: Double? = nil) -> Double {
    let perBar = (beatsPerBar.map { $0 > 0 ? $0 : 4 }) ?? 4
    return perBar * signatureBeatBeats(beatUnit)
}

// MARK: - Musical position

/// What a position is resolved against. Never a hidden global transport: the
/// caller says which tempo, which signature and, when there is one, which map.
public struct TimeContext: Sendable {
    public var bpm: Double
    public var ppqn: Double
    public var beatsPerBar: Double?
    public var beatUnit: Double?
    /// Absent means one constant tempo at `bpm`, which resolves through the
    /// identical expression a project without tempo changes always used.
    public var tempoMap: TempoMap?

    public init(
        bpm: Double,
        ppqn: Double = 960,
        beatsPerBar: Double? = nil,
        beatUnit: Double? = nil,
        tempoMap: TempoMap? = nil
    ) {
        self.bpm = bpm
        self.ppqn = ppqn
        self.beatsPerBar = beatsPerBar
        self.beatUnit = beatUnit
        self.tempoMap = tempoMap
    }
}

/// A position, kept structured until something asks for a number.
///
/// `bar` and `beat` are 1-indexed and `tick` is 0-indexed, matching how
/// musicians count: "bar 2, beat 1" is one bar in, not two.
public enum MusicalTime: Sendable, Equatable {
    case seconds(Double)
    case beats(Double)
    case bars(bar: Int, beat: Int, tick: Double)

    /// This position in quarter-note beats.
    ///
    /// A host placing a clip needs beats, not seconds: beats are what a tempo
    /// map is indexed by and what survives a tempo change.
    public func toBeats(_ ctx: TimeContext) -> Double {
        switch self {
        case let .seconds(value):
            if let map = ctx.tempoMap { return map.beatAtSeconds(value) }
            return (value * ctx.bpm) / 60
        case let .beats(value):
            return value
        case let .bars(bar, beat, tick):
            return Double(bar - 1) * barBeats(ctx.beatsPerBar, ctx.beatUnit)
                + Double(beat - 1) * signatureBeatBeats(ctx.beatUnit)
                + tick / ctx.ppqn
        }
    }

    /// This position in seconds.
    ///
    /// Not expressed through `toBeats`: a `seconds` position converted to
    /// beats and back is two roundings rather than an identity, and this has
    /// to keep returning exactly what it always returned.
    public func toSeconds(_ ctx: TimeContext) -> Double {
        switch self {
        case let .seconds(value):
            return value
        case let .beats(value):
            return Self.beatsToSeconds(value, ctx)
        case let .bars(bar, beat, tick):
            let total = Double(bar - 1) * barBeats(ctx.beatsPerBar, ctx.beatUnit)
                + Double(beat - 1) * signatureBeatBeats(ctx.beatUnit)
                + tick / ctx.ppqn
            return Self.beatsToSeconds(total, ctx)
        }
    }

    /// The one place a musical position becomes seconds, so a tempo map has
    /// exactly one hook to reach and the constant path is provably unchanged.
    private static func beatsToSeconds(_ totalBeats: Double, _ ctx: TimeContext) -> Double {
        if let map = ctx.tempoMap { return map.secondsAtBeat(totalBeats) }
        return (totalBeats * 60) / ctx.bpm
    }
}

// MARK: - Easing

/// Each maps normalized progress in 0..1 to 0..1, clamped rather than
/// extrapolated: a lane asked for a value outside its range should sit at an
/// endpoint, not run off.
public enum Easing: String, Sendable, CaseIterable {
    case linear, exp, log, sCurve, swell

    public func callAsFunction(_ u: Double) -> Double { apply(u) }

    public func apply(_ u: Double) -> Double {
        let t = u <= 0 ? 0 : (u >= 1 ? 1 : u)
        switch self {
        case .linear: return t
        case .exp: return pow(t, 2.5)
        case .log: return 1 - pow(1 - t, 2.5)
        case .sCurve: return t * t * (3 - 2 * t)
        case .swell: return sin(Double.pi * t)
        }
    }
}

// MARK: - Automation

public struct AutomationPoint: Sendable, Equatable {
    public var t: Double
    public var value: Double
    public init(t: Double, value: Double) {
        self.t = t
        self.value = value
    }
}

/// A parameter's value over a span of the timeline.
///
/// Chase and hold: before the range there is **no write at all**, which is not
/// the same as writing the first value, because a lane that has not started
/// must not overwrite what the user set by hand. Inside, interpolate. After
/// the end, hold the last value when `hold` is true and stop writing when it
/// is not.
public struct AutomationLane: Sendable {
    public var shape: Easing
    public var from: Double
    public var to: Double
    public var start: MusicalTime
    public var end: MusicalTime
    /// Baked progress samples. When present these are the source of truth and
    /// `shape`, `from` and `to` are ignored: they are already-authored output,
    /// and scaling somebody's drawn curve by a range they cannot see is not a
    /// refinement.
    public var points: [AutomationPoint]?
    public var chase: Bool
    public var hold: Bool
    public var invert: Bool

    public init(
        shape: Easing = .linear,
        from: Double = 0,
        to: Double = 1,
        start: MusicalTime,
        end: MusicalTime,
        points: [AutomationPoint]? = nil,
        chase: Bool = true,
        hold: Bool = true,
        invert: Bool = false
    ) {
        self.shape = shape
        self.from = from
        self.to = to
        self.start = start
        self.end = end
        self.points = (points?.isEmpty ?? true) ? nil : points
        self.chase = chase
        self.hold = hold
        self.invert = invert
    }

    /// Value at a timeline instant, or nil where this lane does not write.
    public func evaluate(_ timelineSec: Double, _ ctx: TimeContext) -> Double? {
        let startSec = start.toSeconds(ctx)
        let endSec = end.toSeconds(ctx)
        let span = endSec - startSec
        guard span > 0 else { return nil }
        if timelineSec < startSec { return nil }
        if timelineSec > endSec && !hold { return nil }
        let u = min(1, max(0, (timelineSec - startSec) / span))
        return valueAt(u)
    }

    public func valueAt(_ u: Double) -> Double {
        if let points { return lerpPoints(points, u) }
        let shaped = shape.apply(u)
        let lo = min(from, to)
        let hi = max(from, to)
        var value = from + (to - from) * shaped
        // Mirroring within the range, not reversing time: an inverted swell is
        // still a swell, it just dips instead of rising.
        if invert { value = lo + hi - value }
        return value
    }
}

/// Linear interpolation across baked points, clamped at both ends.
///
/// Two points at the same `t` do not divide by zero: the span is zero, the
/// local progress is taken as 0, and the earlier value wins. A vertical jump
/// somebody drew is a jump, not an error.
public func lerpPoints(_ points: [AutomationPoint], _ t: Double) -> Double {
    guard let first = points.first, let last = points.last else { return 0 }
    if t <= first.t { return first.value }
    if t >= last.t { return last.value }
    for i in 0..<(points.count - 1) {
        let a = points[i]
        let b = points[i + 1]
        if t >= a.t && t <= b.t {
            let span = b.t - a.t
            let local = span > 0 ? (t - a.t) / span : 0
            return a.value + local * (b.value - a.value)
        }
    }
    return first.value
}

/// A 0..127 controller value across a parameter's range.
public func mapDisplay127(_ raw127: Double, _ minimum: Double, _ maximum: Double) -> Double {
    minimum + (raw127 / 127) * (maximum - minimum)
}
