import Foundation

/// Clip placement, the Swift half of
/// `web-version/packages/crate/src/clip/region.ts` and the pure part of
/// `clip/fades.ts`.
///
/// Slice 2 of crate's session layer. `TempoMap` answers what second a beat
/// falls on; this answers what a host does with that second.
///
/// The time contract, stated once: **offset is timeline, trim is file, and a
/// clip's timeline extent is `(trimEnd - trimStart) * stretchRatio`.** Warp
/// segments, when present, replace `stretchRatio` entirely. Never both.
///
/// Held to `fixtures/clip-conformance.json` by `ClipConformanceTests`.
/// Everything here is add, subtract, multiply, divide, min and max, so it is
/// compared to the bit, with the two fade shapes that reach `sin` and `pow`
/// the only exceptions.

/// Which part of a source file a clip plays.
public struct SampleRegion: Sendable, Equatable {
    public var trimStartSec: Double
    /// Nil means "to the end of the file".
    public var trimEndSec: Double?

    public init(trimStartSec: Double, trimEndSec: Double? = nil) {
        self.trimStartSec = trimStartSec
        self.trimEndSec = trimEndSec
    }
}

/// One stretched span of a warped clip.
///
/// `localOffsetSec` is where this span starts within the clip, in timeline
/// seconds. `ratio` is how much longer the span is on the timeline than in the
/// file, so a ratio of 2 plays two file seconds across four timeline ones.
public struct WarpSegment: Sendable, Equatable {
    public var fileStartSec: Double
    public var fileEndSec: Double
    public var ratio: Double
    public var localOffsetSec: Double

    public init(fileStartSec: Double, fileEndSec: Double, ratio: Double, localOffsetSec: Double) {
        self.fileStartSec = fileStartSec
        self.fileEndSec = fileEndSec
        self.ratio = ratio
        self.localOffsetSec = localOffsetSec
    }
}

/// One "start this file here, then, at this rate" instruction.
public struct ClipPlaybackWindow: Sendable, Equatable {
    /// Seconds after the playhead to start this window, before PDC.
    public var whenSec: Double
    public var fileOffsetSec: Double
    public var fileDurationSec: Double
    /// The reciprocal of the ratio. Confusing the two is inaudible on an
    /// unstretched clip and doubles the pitch of a stretched one.
    public var playbackRate: Double
}

/// A ratio that cannot be divided by is not an error, it is a clip somebody
/// half-edited. Falling back to 1 plays it at its recorded speed, which is
/// what a person expects to hear from a clip they have not stretched.
@inline(__always) private func saneRatio(_ ratio: Double) -> Double {
    ratio.isFinite && ratio > 0 ? ratio : 1
}

public func resolveTrimEndSec(_ region: SampleRegion, bufferDurationSec: Double) -> Double {
    if let end = region.trimEndSec, end > region.trimStartSec {
        return min(end, bufferDurationSec)
    }
    return bufferDurationSec
}

/// How long a clip occupies on the timeline.
///
/// From the last warp segment when there is one, because segments already
/// carry their own timeline offsets and the last one's end is the clip's end.
public func clipTimelineDurationSec(
    trimStartSec: Double,
    trimEndSec: Double,
    stretchRatio: Double = 1,
    warpSegments: [WarpSegment]? = nil
) -> Double {
    if let segments = warpSegments, let last = segments.last {
        return last.localOffsetSec + (last.fileEndSec - last.fileStartSec) * saneRatio(last.ratio)
    }
    return max(0, trimEndSec - trimStartSec) * saneRatio(stretchRatio)
}

/// Where a clip reads from, given where the playhead is.
///
/// An unwarped clip is treated as one segment covering its whole trim, so
/// there is one code path rather than two that can disagree.
///
/// The subtle line is `skipFile`: a playhead partway into a segment has
/// consumed timeline seconds, and the file position it corresponds to is that
/// distance **divided by** the ratio. Multiplying instead is the mistake, and
/// it is invisible on any clip whose ratio is 1.
public func clipPlaybackWindows(
    offsetSec: Double,
    trimStartSec: Double,
    trimEndSec: Double,
    stretchRatio: Double = 1,
    warpSegments: [WarpSegment]? = nil,
    playheadSec: Double
) -> [ClipPlaybackWindow] {
    let segments: [WarpSegment]
    if let warp = warpSegments, !warp.isEmpty {
        segments = warp
    } else {
        segments = [
            WarpSegment(
                fileStartSec: trimStartSec,
                fileEndSec: trimEndSec,
                ratio: saneRatio(stretchRatio),
                localOffsetSec: 0
            )
        ]
    }

    var out: [ClipPlaybackWindow] = []
    for segment in segments {
        let ratio = saneRatio(segment.ratio)
        let fileDuration = max(0, segment.fileEndSec - segment.fileStartSec)
        if fileDuration <= 0 { continue }
        let timelineStart = offsetSec + segment.localOffsetSec
        let timelineEnd = timelineStart + fileDuration * ratio
        if playheadSec >= timelineEnd { continue }
        let whenSec = max(0, timelineStart - playheadSec)
        let skipFile = max(0, playheadSec - timelineStart) / ratio
        let fileRemain = fileDuration - skipFile
        if fileRemain <= 0 { continue }
        out.append(
            ClipPlaybackWindow(
                whenSec: whenSec,
                fileOffsetSec: segment.fileStartSec + skipFile,
                fileDurationSec: fileRemain,
                playbackRate: 1 / ratio
            )
        )
    }
    return out
}

/// Warp segments as a project stores them, in milliseconds.
public func warpSegmentsFromMs(
    _ raw: [(fileStartMs: Double, fileEndMs: Double, ratio: Double, localOffsetMs: Double)]?
) -> [WarpSegment]? {
    guard let raw, !raw.isEmpty else { return nil }
    return raw.map {
        WarpSegment(
            fileStartSec: $0.fileStartMs / 1000,
            fileEndSec: $0.fileEndMs / 1000,
            ratio: saneRatio($0.ratio),
            localOffsetSec: $0.localOffsetMs / 1000
        )
    }
}

// MARK: - Fades

/// `linear` is the default. `equalPower` and `sCurve` are what a projected
/// crossfade writes, so an overlap sums to constant perceived loudness rather
/// than dipping in the middle.
public enum FadeCurve: String, Sendable, Equatable {
    case linear, equalPower, sCurve
}

/// Gain at progress `x` toward full, clamped rather than extrapolated.
///
/// An unknown curve name is `linear` rather than an error: a project written
/// by a newer version naming a curve this build has not got should play, at
/// the plainest shape there is, instead of refusing to open.
public func fadeShape(_ x: Double, curve: String = "linear") -> Double {
    let t = x <= 0 ? 0 : (x >= 1 ? 1 : x)
    if curve == "equalPower" { return sin((t * Double.pi) / 2) }
    if curve == "sCurve" { return t * t * (3 - 2 * t) }
    return t
}

/// Clip gain in dB as a linear multiplier. At or below -60 dB it is a literal
/// zero rather than a very small number, so a muted clip costs nothing and
/// cannot leak.
public func clipGainLinear(_ gainDb: Double) -> Double {
    if !(gainDb > -60) { return 0 }
    return pow(10, gainDb / 20)
}
