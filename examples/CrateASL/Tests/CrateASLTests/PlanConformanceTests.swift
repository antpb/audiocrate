import XCTest
@testable import CrateASL

/// Does a scene plan schedule the same way in Swift as in TypeScript?
///
/// Slice 4, and the one that ties the other three together. This guards a
/// **composition**, not a function. `TempoMap`, `clipPlaybackWindows` and
/// `AutomationLane` are each already held to their own fixture and each can be
/// perfect while a host still wires them together wrongly: applying the
/// transport origin twice, resolving automation against the transport's bpm
/// instead of its tempo map, or deriving a decode span from the trim instead
/// of from what actually plays. Only a fixture over the whole function sees
/// those, and every one of them is a plausible mistake rather than a careless
/// one.
///
/// Also the first fixture that decodes a real document. Everything else is
/// probed by calling functions; this reads JSON of the shape a project file
/// carries, which makes it a test of the plan format as well as the maths.
final class PlanConformanceTests: XCTestCase {

    static let expectedVersion = 2

    struct Fixture: Decodable {
        struct Window: Decodable {
            let whenSec: Double
            let fileOffsetSec: Double
            let fileDurationSec: Double
            let playbackRate: Double
        }
        struct ClipSchedule: Decodable {
            let clipId: String
            let source: String
            let windows: [Window]
            let gain: Double
            let decodeStartSec: Double?
            let decodeEndSec: Double?
        }
        struct TrackSchedule: Decodable {
            let index: Int
            let gain: Double
            let pan: Double
            let latencySamples: Int
            let clips: [ClipSchedule]
            let automation: [String: Double]
        }
        struct Schedule: Decodable {
            let atSec: Double
            let atBeats: Double
            let bpm: Double
            let masterGain: Double
            let tracks: [TrackSchedule]
        }
        struct Case: Decodable {
            let name: String
            let plan: ScenePlan
            let sources: [String: Double]
            let sourceSpecs: [String: PlanSourceSpec]
            let probes: [Double]
            let schedules: [Schedule]
            let render: [Double]
            let exact: Bool
        }
        let version: Int
        let stamp: String
        let planVersion: Int
        let tolerance: Double
        let renderSampleRate: Double
        let renderSeconds: Double
        let cases: [Case]
    }

    static func loadFixture() throws -> Fixture {
        if let override = ProcessInfo.processInfo.environment["CRATE_PLAN_FIXTURE"] {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: override)))
        }
        let url = CrateFixtures.url("plan-conformance.json")
        do {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        } catch {
            throw ScenePlanError(
                "plan conformance fixture not usable at \(url.path): \(error). "
                    + "Expected fixtures/plan-conformance.json, or set CRATE_PLAN_FIXTURE."
            )
        }
    }

    func testFixtureAndPlanFormatsAreBothUnderstood() throws {
        let fixture = try Self.loadFixture()
        XCTAssertEqual(fixture.version, Self.expectedVersion)
        XCTAssertEqual(
            fixture.planVersion, SCENE_PLAN_VERSION,
            "crate writes plan format v\(fixture.planVersion), this build executes v\(SCENE_PLAN_VERSION)"
        )
    }

    /// A plan naming a version this build does not execute must be refused,
    /// not partially executed. A project playing with its automation silently
    /// dropped is worse than a project that will not open.
    func testAFutureplanIsRefused() throws {
        let json = """
        {"version":9999,"transport":{"originSec":0,"bpm":120,"ppqn":960,"tempoChanges":null},
         "master":{"volume":1,"latencySamples":0},"tracks":[]}
        """.data(using: .utf8)!
        XCTAssertThrowsError(try ScenePlan.decode(json))
    }

    /// The claim the whole session-as-data arc is for: the same plan, bounced
    /// in two languages, sample for sample.
    ///
    /// Compared with **no tolerance** on every case that does not reach a
    /// transcendental, and that is not optimism. The summation order is part
    /// of the contract precisely so that it can be exact: tracks in plan
    /// order, clips in track order, windows in clip order, master gain applied
    /// once at the end. If this needed a tolerance the order would be
    /// underspecified, and a real bug could hide inside the allowance.
    ///
    /// The ramp sources make a failure legible. A rendered sample states the
    /// file position it came from, so a diff prints "0.5 against 0.25" rather
    /// than two waveforms that look alike.
    func testRendersTheSameAudio() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        var compared = 0
        var nonZero = 0
        var worst = 0.0

        for probe in fixture.cases {
            let actual = try renderPlan(
                probe.plan,
                sources: probe.sourceSpecs,
                sampleRate: fixture.renderSampleRate,
                durationSec: fixture.renderSeconds,
                atSec: probe.probes.first ?? 0
            )
            if actual.count != probe.render.count {
                failures.append("\(probe.name): \(actual.count) frames, crate \(probe.render.count)")
                continue
            }
            let allowed = probe.exact ? 0 : fixture.tolerance
            var caseWorst = 0.0
            var caseWorstFrame = -1
            for i in 0..<actual.count {
                compared += 1
                if probe.render[i] != 0 { nonZero += 1 }
                let diff = abs(Double(actual[i]) - probe.render[i])
                if diff > caseWorst {
                    caseWorst = diff
                    caseWorstFrame = i
                }
            }
            worst = max(worst, caseWorst)
            if caseWorst > allowed {
                let at = Double(caseWorstFrame) / fixture.renderSampleRate
                failures.append(
                    "\(probe.name): worst \(caseWorst) at frame \(caseWorstFrame) (\(at)s), "
                        + "this build \(actual[caseWorstFrame]), crate \(probe.render[caseWorstFrame])"
                )
            }
        }

        // Silence agrees with silence. Without audible samples this test is
        // satisfied by a renderer that outputs nothing at all.
        XCTAssertGreaterThan(nonZero, 20_000, "almost nothing was audible, so agreement means nothing")
        XCTAssertTrue(failures.isEmpty, "rendered audio disagrees:\n  " + failures.joined(separator: "\n  "))

        print(
            """

            === Scene plan rendered, Swift against JavaScript ===
            fixture stamp    \(fixture.stamp) (v\(fixture.version), plan format v\(fixture.planVersion))
            plans            \(fixture.cases.count) at \(fixture.renderSampleRate) Hz for \(fixture.renderSeconds)s
            samples          \(compared) compared, \(nonZero) audible
            worst deviation  \(worst)

            """
        )
    }

    /// A source kind this build cannot generate must be refused, not treated
    /// as silence: a plan that renders quiet looks like a correct plan with a
    /// quiet clip.
    func testAnUnknownSourceKindIsRefused() {
        let json = Data(#"{"kind":"granularCloud","durationSec":4}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(PlanSourceSpec.self, from: json))
    }

    func testSchedulesAgree() throws {
        let fixture = try Self.loadFixture()
        XCTAssertGreaterThan(fixture.cases.count, 10, "fixture looks truncated")
        var failures: [String] = []
        var windowCount = 0
        var automationCount = 0

        for probe in fixture.cases {
            let allowed = probe.exact ? 0 : fixture.tolerance
            for (i, at) in probe.probes.enumerated() {
                let expected = probe.schedules[i]
                let actual = try schedulePlan(probe.plan, at: at) { probe.sources[$0] }
                let label = "\(probe.name) @ \(at)s"

                if abs(actual.atBeats - expected.atBeats) > allowed {
                    failures.append("\(label) atBeats: this build \(actual.atBeats), crate \(expected.atBeats)")
                }
                if abs(actual.bpm - expected.bpm) > allowed {
                    failures.append("\(label) bpm: this build \(actual.bpm), crate \(expected.bpm)")
                }
                if actual.masterGain != expected.masterGain {
                    failures.append("\(label) masterGain")
                }
                if actual.tracks.count != expected.tracks.count {
                    failures.append("\(label): \(actual.tracks.count) tracks, crate \(expected.tracks.count)")
                    continue
                }

                for (t, wantTrack) in expected.tracks.enumerated() {
                    let gotTrack = actual.tracks[t]
                    if gotTrack.index != wantTrack.index || gotTrack.gain != wantTrack.gain
                        || gotTrack.pan != wantTrack.pan
                        || gotTrack.latencySamples != wantTrack.latencySamples
                    {
                        failures.append(
                            "\(label) track \(t): this build index \(gotTrack.index) gain \(gotTrack.gain) "
                                + "pan \(gotTrack.pan) latency \(gotTrack.latencySamples); crate index "
                                + "\(wantTrack.index) gain \(wantTrack.gain) pan \(wantTrack.pan) "
                                + "latency \(wantTrack.latencySamples)"
                        )
                    }

                    // Automation both ways: a target crate writes and this
                    // build does not is a parameter stuck at its last value,
                    // and one this build writes and crate does not overwrites
                    // whatever the user set by hand.
                    for (target, want) in wantTrack.automation {
                        guard let got = gotTrack.automation[target] else {
                            failures.append("\(label) track \(t): crate writes \(target), this build did not")
                            continue
                        }
                        automationCount += 1
                        if abs(got - want) > allowed {
                            failures.append("\(label) track \(t) \(target): this build \(got), crate \(want)")
                        }
                    }
                    for target in gotTrack.automation.keys where wantTrack.automation[target] == nil {
                        failures.append(
                            "\(label) track \(t): this build writes \(target), crate writes nothing, "
                                + "which would overwrite what the user set"
                        )
                    }

                    if gotTrack.clips.count != wantTrack.clips.count {
                        failures.append("\(label) track \(t): clip count")
                        continue
                    }
                    for (c, wantClip) in wantTrack.clips.enumerated() {
                        let gotClip = gotTrack.clips[c]
                        if gotClip.clipId != wantClip.clipId || gotClip.source != wantClip.source {
                            failures.append("\(label) clip \(c): identity")
                        }
                        if abs(gotClip.gain - wantClip.gain) > allowed {
                            failures.append("\(label) clip \(wantClip.clipId) gain: this build \(gotClip.gain), crate \(wantClip.gain)")
                        }
                        if gotClip.decodeStartSec != wantClip.decodeStartSec
                            || gotClip.decodeEndSec != wantClip.decodeEndSec
                        {
                            failures.append(
                                "\(label) clip \(wantClip.clipId) decode span: this build "
                                    + "\(String(describing: gotClip.decodeStartSec))..\(String(describing: gotClip.decodeEndSec)), "
                                    + "crate \(String(describing: wantClip.decodeStartSec))..\(String(describing: wantClip.decodeEndSec))"
                            )
                        }
                        if gotClip.windows.count != wantClip.windows.count {
                            failures.append(
                                "\(label) clip \(wantClip.clipId): \(gotClip.windows.count) windows, "
                                    + "crate \(wantClip.windows.count)"
                            )
                            continue
                        }
                        for (w, wantWindow) in wantClip.windows.enumerated() {
                            windowCount += 1
                            let gotWindow = gotClip.windows[w]
                            if gotWindow.whenSec != wantWindow.whenSec
                                || gotWindow.fileOffsetSec != wantWindow.fileOffsetSec
                                || gotWindow.fileDurationSec != wantWindow.fileDurationSec
                                || gotWindow.playbackRate != wantWindow.playbackRate
                            {
                                failures.append(
                                    "\(label) clip \(wantClip.clipId) window \(w): this build when "
                                        + "\(gotWindow.whenSec) offset \(gotWindow.fileOffsetSec) dur "
                                        + "\(gotWindow.fileDurationSec) rate \(gotWindow.playbackRate); crate when "
                                        + "\(wantWindow.whenSec) offset \(wantWindow.fileOffsetSec) dur "
                                        + "\(wantWindow.fileDurationSec) rate \(wantWindow.playbackRate)"
                                )
                            }
                        }
                    }
                }
            }
        }

        // A scheduler that returns nothing agrees with every silent case.
        XCTAssertGreaterThan(windowCount, 30, "nothing was scheduled, so agreement means nothing")
        XCTAssertGreaterThan(automationCount, 5, "no automation was written, so that half is untested")
        XCTAssertTrue(failures.isEmpty, "plan schedules disagree:\n  " + failures.joined(separator: "\n  "))

        print("""

        === Scene plan, Swift against JavaScript ===
        fixture stamp    \(fixture.stamp) (v\(fixture.version), plan format v\(fixture.planVersion))
        plans            \(fixture.cases.count), \(fixture.cases.filter(\.exact).count) held to the bit
        schedules        \(fixture.cases.reduce(0) { $0 + $1.probes.count })
        windows          \(windowCount)
        automation       \(automationCount) writes

        """)
    }
}
