import XCTest
@testable import CrateASL

/// Does the Swift musical position and automation agree with TypeScript?
///
/// Slice 3, and the two rules it exists to hold are ones that are invisible in
/// the common case:
///
///   - **beats are quarter-notes and the signature is two numbers.** Every
///     signature answer is 4 in 4/4, so only a compound or cut-time case can
///     tell a correct implementation from one that folded the denominator into
///     the tempo;
///   - **a lane writes nothing before it starts.** Returning a number where
///     crate returns nothing silently overwrites whatever the user set by hand,
///     and every "no write" sample here is a case that catches it.
///
/// Arithmetic is compared to the bit. Only `exp`, `log` and `swell`, which
/// reach `pow` and `sin`, carry the fixture's stated tolerance, and the
/// fixture marks each case.
final class SessionConformanceTests: XCTestCase {

    static let expectedVersion = 1

    struct Fixture: Decodable {
        struct SignatureCase: Decodable {
            let beatsPerBar: Double?
            let beatUnit: Double?
            let normalizedUnit: Double
            let signatureBeat: Double
            let bar: Double
        }
        struct Change: Decodable {
            let atBeat: Double
            let bpm: Double
            let curve: String
        }
        struct Context: Decodable {
            let bpm: Double
            let ppqn: Double
            let beatsPerBar: Double?
            let beatUnit: Double?
            let tempoChanges: [Change]?
        }
        struct PositionCase: Decodable {
            let name: String
            let kind: String
            let seconds: Double?
            let beats: Double?
            let bar: Int?
            let beat: Int?
            let tick: Double?
            let ctx: Context
            let toBeats: Double
            let toSeconds: Double
            let exact: Bool
        }
        struct EasingCase: Decodable {
            let name: String
            let u: Double
            let value: Double
            let exact: Bool
        }
        struct Point: Decodable {
            let t: Double
            let value: Double
        }
        struct Sample: Decodable {
            let timelineSec: Double
            let value: Double?
        }
        struct LaneCase: Decodable {
            let name: String
            let startBeats: Double
            let endBeats: Double
            let from: Double
            let to: Double
            let shape: String
            let points: [Point]?
            let chase: Bool
            let hold: Bool
            let invert: Bool
            let bpm: Double
            let samples: [Sample]
            let exact: Bool
        }
        struct LerpCase: Decodable {
            let name: String
            let points: [Point]
            let probes: [Point]
        }
        struct DisplayCase: Decodable {
            let raw127: Double
            let min: Double
            let max: Double
            let value: Double
        }
        let version: Int
        let stamp: String
        let tolerance: Double
        let signatures: [SignatureCase]
        let positions: [PositionCase]
        let easings: [EasingCase]
        let lanes: [LaneCase]
        let lerps: [LerpCase]
        let display127: [DisplayCase]
    }

    static func loadFixture() throws -> Fixture {
        if let override = ProcessInfo.processInfo.environment["CRATE_SESSION_FIXTURE"] {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: override)))
        }
        let url = CrateFixtures.url("session-conformance.json")
        do {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        } catch {
            throw TempoMapError(
                "session conformance fixture not usable at \(url.path): \(error). "
                    + "Expected fixtures/session-conformance.json, or set CRATE_SESSION_FIXTURE."
            )
        }
    }

    /// Rebuilt from the fixture's change list rather than carried as an
    /// object, so constructing the map is itself part of what agrees.
    private func context(_ ctx: Fixture.Context) throws -> TimeContext {
        var map: TempoMap?
        if let changes = ctx.tempoChanges {
            let base = changes.first { $0.atBeat == 0 }
            map = try TempoMap(
                changes.filter { $0.atBeat > 0 }.map {
                    TempoChange(atBeat: $0.atBeat, bpm: $0.bpm, curve: $0.curve == "ramp" ? .ramp : .jump)
                },
                baseBpm: base?.bpm ?? ctx.bpm,
                baseCurve: base?.curve == "ramp" ? .ramp : .jump
            )
        }
        return TimeContext(
            bpm: ctx.bpm, ppqn: ctx.ppqn,
            beatsPerBar: ctx.beatsPerBar, beatUnit: ctx.beatUnit, tempoMap: map
        )
    }

    func testFixtureIsAFormatThisBuildUnderstands() throws {
        let fixture = try Self.loadFixture()
        XCTAssertEqual(fixture.version, Self.expectedVersion)
    }

    /// Bar length in quarter-notes, which is 4 in 4/4 no matter what you do
    /// wrong. The compound and cut-time rows are the test.
    func testTimeSignatureRule() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for probe in fixture.signatures {
            let label = "\(probe.beatsPerBar.map { "\($0)" } ?? "nil")/\(probe.beatUnit.map { "\($0)" } ?? "nil")"
            if normalizeBeatUnit(probe.beatUnit) != probe.normalizedUnit {
                failures.append("\(label) normalizeBeatUnit")
            }
            if signatureBeatBeats(probe.beatUnit) != probe.signatureBeat {
                failures.append(
                    "\(label) signatureBeatBeats: this build \(signatureBeatBeats(probe.beatUnit)), "
                        + "crate \(probe.signatureBeat)"
                )
            }
            if barBeats(probe.beatsPerBar, probe.beatUnit) != probe.bar {
                failures.append(
                    "\(label) barBeats: this build \(barBeats(probe.beatsPerBar, probe.beatUnit)), "
                        + "crate \(probe.bar)"
                )
            }
        }
        XCTAssertTrue(failures.isEmpty, "time signature disagrees:\n  " + failures.joined(separator: "\n  "))
    }

    func testMusicalPositions() throws {
        let fixture = try Self.loadFixture()
        XCTAssertGreaterThan(fixture.positions.count, 8, "fixture looks truncated")
        var failures: [String] = []
        for probe in fixture.positions {
            let ctx = try context(probe.ctx)
            let time: MusicalTime
            switch probe.kind {
            case "seconds": time = .seconds(probe.seconds ?? 0)
            case "beats": time = .beats(probe.beats ?? 0)
            default: time = .bars(bar: probe.bar ?? 1, beat: probe.beat ?? 1, tick: probe.tick ?? 0)
            }
            let allowed = probe.exact ? 0 : fixture.tolerance
            let beats = time.toBeats(ctx)
            let seconds = time.toSeconds(ctx)
            if abs(beats - probe.toBeats) > allowed {
                failures.append("\(probe.name) toBeats: this build \(beats), crate \(probe.toBeats)")
            }
            if abs(seconds - probe.toSeconds) > allowed {
                failures.append("\(probe.name) toSeconds: this build \(seconds), crate \(probe.toSeconds)")
            }
        }
        XCTAssertTrue(failures.isEmpty, "musical positions disagree:\n  " + failures.joined(separator: "\n  "))
    }

    func testEasingShapes() throws {
        let fixture = try Self.loadFixture()
        // Every shipped easing is probed, so one added on either side without
        // a case fails here rather than silently going unchecked.
        let probed = Set(fixture.easings.map(\.name))
        XCTAssertEqual(probed.sorted(), Easing.allCases.map(\.rawValue).sorted(), "easing vocabularies differ")

        var failures: [String] = []
        for probe in fixture.easings {
            guard let easing = Easing(rawValue: probe.name) else {
                failures.append("\(probe.name): crate has this easing and this build does not")
                continue
            }
            let allowed = probe.exact ? 0 : fixture.tolerance
            let actual = easing.apply(probe.u)
            if abs(actual - probe.value) > allowed {
                failures.append("\(probe.name)(\(probe.u)): this build \(actual), crate \(probe.value)")
            }
        }
        XCTAssertTrue(failures.isEmpty, "easing shapes disagree:\n  " + failures.joined(separator: "\n  "))
    }

    /// Every sample of every lane, including the ones that write nothing.
    func testAutomationLanes() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        var writes = 0
        var silences = 0

        for probe in fixture.lanes {
            let lane = AutomationLane(
                shape: Easing(rawValue: probe.shape) ?? .linear,
                from: probe.from,
                to: probe.to,
                start: .beats(probe.startBeats),
                end: .beats(probe.endBeats),
                points: probe.points?.map { AutomationPoint(t: $0.t, value: $0.value) },
                chase: probe.chase,
                hold: probe.hold,
                invert: probe.invert
            )
            let ctx = TimeContext(bpm: probe.bpm)
            let allowed = probe.exact ? 0 : fixture.tolerance
            for sample in probe.samples {
                let actual = lane.evaluate(sample.timelineSec, ctx)
                switch (actual, sample.value) {
                case (nil, nil):
                    silences += 1
                case let (value?, expected?):
                    writes += 1
                    if abs(value - expected) > allowed {
                        failures.append(
                            "\(probe.name) @ \(sample.timelineSec)s: this build \(value), crate \(expected)"
                        )
                    }
                case (nil, _?):
                    failures.append("\(probe.name) @ \(sample.timelineSec)s: crate writes, this build did not")
                case (_?, nil):
                    failures.append(
                        "\(probe.name) @ \(sample.timelineSec)s: crate writes nothing, this build wrote "
                            + "\(actual!), which would overwrite what the user set"
                    )
                }
            }
        }

        // A lane that always returns nil agrees with every silence, and one
        // that always returns a number agrees with every write. Both halves
        // have to be present for either to mean anything.
        XCTAssertGreaterThan(writes, 30, "nothing was written, so agreement means nothing")
        XCTAssertGreaterThan(silences, 10, "nothing was silent, so chase is untested")
        XCTAssertTrue(failures.isEmpty, "automation lanes disagree:\n  " + failures.joined(separator: "\n  "))

        print("""

        === Session position and automation, Swift against JavaScript ===
        fixture stamp    \(fixture.stamp) (v\(fixture.version))
        signatures       \(fixture.signatures.count)
        positions        \(fixture.positions.count), \(fixture.positions.filter(\.exact).count) held to the bit
        easings          \(fixture.easings.count) probes, \(Easing.allCases.count) shapes
        lanes            \(fixture.lanes.count), \(writes) writes and \(silences) silences
        lerps            \(fixture.lerps.count)
        0..127 maps      \(fixture.display127.count)

        """)
    }

    func testLerpAndDisplayMap() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for probe in fixture.lerps {
            let points = probe.points.map { AutomationPoint(t: $0.t, value: $0.value) }
            for want in probe.probes {
                let actual = lerpPoints(points, want.t)
                if actual != want.value {
                    failures.append("\(probe.name) @ \(want.t): this build \(actual), crate \(want.value)")
                }
            }
        }
        for probe in fixture.display127 {
            let actual = mapDisplay127(probe.raw127, probe.min, probe.max)
            if actual != probe.value {
                failures.append(
                    "mapDisplay127(\(probe.raw127), \(probe.min), \(probe.max)): this build \(actual), "
                        + "crate \(probe.value)"
                )
            }
        }
        XCTAssertTrue(failures.isEmpty, "interpolation disagrees:\n  " + failures.joined(separator: "\n  "))
    }
}
