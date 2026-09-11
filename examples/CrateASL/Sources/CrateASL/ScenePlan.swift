import Foundation

/// A session as data, the Swift half of
/// `web-version/packages/crate/src/session/ScenePlan.ts`.
///
/// The argument, in one line: **an ASL graph became portable when it stopped
/// being code and became data any interpreter could replay, and nothing about
/// a session is less serializable than a graph.**
///
/// This is what a native host executes instead of copying 1,299 lines of
/// `webshims/crateScenePlayback.ts`. A plan carries track topology, clip
/// placements with their warp segments, automation lanes, the tempo map and
/// the transport origin, in beats and seconds, with no buffer, no context and
/// no file handle in it. `schedulePlan` turns one into a sample-accurate
/// schedule.
///
/// Nothing here reads a file or opens a device. `source` is an opaque id the
/// host resolves, exactly as `deviceId` is for MIDI: a plan is portable
/// between machines and a file path is not.
///
/// Held to `fixtures/plan-conformance.json` by `PlanConformanceTests`. That
/// fixture guards a composition rather than a function: `TempoMap`,
/// `clipPlaybackWindows` and `AutomationLane` are each already held on their
/// own, and a host can still wire them together wrongly.

/// A host that does not understand the version must refuse the plan rather
/// than execute the half it recognises. Playing a project with its automation
/// silently dropped is worse than refusing to play it.
public let SCENE_PLAN_VERSION = 1

public struct ScenePlanError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

public struct ScenePlanTransport: Decodable, Sendable {
    /// Where the playhead sits when the plan is executed, in timeline seconds.
    public var originSec: Double
    public var bpm: Double
    public var beatsPerBar: Double?
    public var beatUnit: Double?
    /// Nil means one constant tempo at `bpm`.
    public var tempoChanges: [PlanTempoChange]?
    /// Ticks per quarter note, for positions expressed in bars.
    public var ppqn: Double
}

public struct PlanTempoChange: Decodable, Sendable {
    public var atBeat: Double
    public var bpm: Double
    public var curve: String
}

public struct ScenePlanClip: Decodable, Sendable {
    public var id: String
    /// An id the host resolves to audio. Never a path.
    public var source: String
    public var offsetSec: Double
    public var trimStartSec: Double
    /// Nil means to the end of the source.
    public var trimEndSec: Double?
    public var stretchRatio: Double
    /// When present these replace `stretchRatio` entirely, never both.
    public var warpSegments: [WarpSegment]?
    public var gainDb: Double
    public var muted: Bool
}

extension WarpSegment: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            fileStartSec: try container.decode(Double.self, forKey: .fileStartSec),
            fileEndSec: try container.decode(Double.self, forKey: .fileEndSec),
            ratio: try container.decode(Double.self, forKey: .ratio),
            localOffsetSec: try container.decode(Double.self, forKey: .localOffsetSec)
        )
    }
    private enum CodingKeys: String, CodingKey {
        case fileStartSec, fileEndSec, ratio, localOffsetSec
    }
}

public struct ScenePlanLane: Decodable, Sendable {
    /// The parameter this lane writes, addressed by name.
    public var target: String
    public var startBeats: Double
    public var endBeats: Double
    public var from: Double
    public var to: Double
    public var shape: String
    public var points: [AutomationPoint]?
    public var chase: Bool
    public var hold: Bool
    public var invert: Bool
}

extension AutomationPoint: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            t: try container.decode(Double.self, forKey: .t),
            value: try container.decode(Double.self, forKey: .value)
        )
    }
    private enum CodingKeys: String, CodingKey { case t, value }
}

public struct ScenePlanTrack: Decodable, Sendable {
    public var index: Int
    public var volume: Double
    public var pan: Double
    public var muted: Bool
    /// Reported latency of this track's insert chain. Here because it moves
    /// when a clip has to start, which is a scheduling fact. Which plugins
    /// produce it is not, and is not here.
    public var latencySamples: Int
    public var clips: [ScenePlanClip]
    public var automation: [ScenePlanLane]
}

public struct ScenePlanMaster: Decodable, Sendable {
    public var volume: Double
    public var latencySamples: Int
}

public struct ScenePlan: Decodable, Sendable {
    public var version: Int
    public var transport: ScenePlanTransport
    public var master: ScenePlanMaster
    public var tracks: [ScenePlanTrack]

    public static func decode(_ data: Data) throws -> ScenePlan {
        let plan = try JSONDecoder().decode(ScenePlan.self, from: data)
        guard plan.version == SCENE_PLAN_VERSION else {
            throw ScenePlanError(
                "scene plan is version \(plan.version), this build executes \(SCENE_PLAN_VERSION). "
                    + "Executing the half it recognises would play the project with parts of it missing."
            )
        }
        return plan
    }
}

// MARK: - Schedule

public struct PlanClipSchedule: Sendable {
    public var clipId: String
    public var source: String
    public var windows: [ClipPlaybackWindow]
    /// Clip gain as a linear multiplier, before the track fader.
    public var gain: Double
    /// The span of the source a host has to make available, in file seconds.
    /// Derived from the windows, not the trim: a playhead partway into a clip
    /// needs less of the file than the clip names.
    public var decodeStartSec: Double?
    public var decodeEndSec: Double?
}

public struct PlanTrackSchedule: Sendable {
    public var index: Int
    /// Track fader as a linear multiplier. Exactly zero when muted.
    public var gain: Double
    public var pan: Double
    public var latencySamples: Int
    public var clips: [PlanClipSchedule]
    /// Every automated parameter that writes at this instant, by target.
    public var automation: [String: Double]
}

public struct PlanSchedule: Sendable {
    public var atSec: Double
    public var atBeats: Double
    public var bpm: Double
    public var masterGain: Double
    public var tracks: [PlanTrackSchedule]
}

public func planTempoMap(_ transport: ScenePlanTransport) throws -> TempoMap? {
    guard let changes = transport.tempoChanges else { return nil }
    let base = changes.first { $0.atBeat == 0 }
    return try TempoMap(
        changes.filter { $0.atBeat > 0 }.map {
            TempoChange(atBeat: $0.atBeat, bpm: $0.bpm, curve: $0.curve == "ramp" ? .ramp : .jump)
        },
        baseBpm: base?.bpm ?? transport.bpm,
        baseCurve: base?.curve == "ramp" ? .ramp : .jump
    )
}

public func planTimeContext(_ transport: ScenePlanTransport) throws -> TimeContext {
    TimeContext(
        bpm: transport.bpm,
        ppqn: transport.ppqn,
        beatsPerBar: transport.beatsPerBar,
        beatUnit: transport.beatUnit,
        tempoMap: try planTempoMap(transport)
    )
}

/// One clip's schedule at a playhead.
///
/// `sourceDurationSec` is the host's answer for how long the source is,
/// because a plan cannot know and must not guess.
public func scheduleClip(
    _ clip: ScenePlanClip,
    playheadSec: Double,
    sourceDurationSec: Double
) -> PlanClipSchedule {
    let trimEnd: Double
    if let end = clip.trimEndSec, end > clip.trimStartSec {
        trimEnd = min(end, sourceDurationSec)
    } else {
        trimEnd = sourceDurationSec
    }

    let windows = clip.muted
        ? []
        : clipPlaybackWindows(
            offsetSec: clip.offsetSec,
            trimStartSec: clip.trimStartSec,
            trimEndSec: trimEnd,
            stretchRatio: clip.stretchRatio,
            warpSegments: clip.warpSegments,
            playheadSec: playheadSec
        )

    var decodeStart: Double?
    var decodeEnd: Double?
    for window in windows {
        let end = window.fileOffsetSec + window.fileDurationSec
        decodeStart = decodeStart.map { min($0, window.fileOffsetSec) } ?? window.fileOffsetSec
        decodeEnd = decodeEnd.map { max($0, end) } ?? end
    }

    return PlanClipSchedule(
        clipId: clip.id,
        source: clip.source,
        windows: windows,
        gain: clipGainLinear(clip.gainDb),
        decodeStartSec: decodeStart,
        decodeEndSec: decodeEnd
    )
}

/// A whole plan, at one instant.
///
/// The function a host calls instead of copying `buildScene`. It composes the
/// three ported slices: the tempo map answers where the playhead is musically,
/// clip placement answers what plays, and the automation lanes answer what
/// every parameter is worth. Nothing here reads a file, opens a device, or
/// allocates a buffer.
///
/// A source the host does not know is treated as zero-length rather than as an
/// error, so one missing take costs one silent clip and not the whole session.
public func schedulePlan(
    _ plan: ScenePlan,
    at atSec: Double,
    sourceDurationSec: (String) -> Double?
) throws -> PlanSchedule {
    let ctx = try planTimeContext(plan.transport)
    let playheadSec = plan.transport.originSec + atSec
    let atBeats = MusicalTime.seconds(playheadSec).toBeats(ctx)

    let tracks: [PlanTrackSchedule] = plan.tracks.map { track in
        var automation: [String: Double] = [:]
        for laneSpec in track.automation {
            let lane = AutomationLane(
                shape: Easing(rawValue: laneSpec.shape) ?? .linear,
                from: laneSpec.from,
                to: laneSpec.to,
                start: .beats(laneSpec.startBeats),
                end: .beats(laneSpec.endBeats),
                points: laneSpec.points,
                chase: laneSpec.chase,
                hold: laneSpec.hold,
                invert: laneSpec.invert
            )
            if let value = lane.evaluate(playheadSec, ctx) { automation[laneSpec.target] = value }
        }
        return PlanTrackSchedule(
            index: track.index,
            // A muted track is exactly zero, not a very small number: it must
            // not leak and it must not cost a fade.
            gain: track.muted ? 0 : track.volume,
            pan: track.pan,
            latencySamples: track.latencySamples,
            clips: track.clips.map {
                scheduleClip($0, playheadSec: playheadSec, sourceDurationSec: sourceDurationSec($0.source) ?? 0)
            },
            automation: automation
        )
    }

    return PlanSchedule(
        atSec: atSec,
        atBeats: atBeats,
        bpm: ctx.tempoMap.map { $0.bpmAtBeat(atBeats) } ?? plan.transport.bpm,
        masterGain: plan.master.volume,
        tracks: tracks
    )
}
