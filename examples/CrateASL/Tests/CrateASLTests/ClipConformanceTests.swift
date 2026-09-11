import XCTest
@testable import CrateASL

/// Does the Swift clip placement agree with the TypeScript one?
///
/// Slice 2 of the session layer. A disagreement here is not a rounding, it is
/// a clip playing the wrong part of the take, or playing at the wrong pitch
/// because a stretch ratio was used where its reciprocal belonged.
///
/// Everything in `region.ts` is add, subtract, multiply, divide, min and max,
/// so those are compared **with no tolerance at all**. Only the two fade
/// shapes that reach `sin` and `pow` carry the fixture's stated tolerance, and
/// the fixture marks each case so the strict rule is applied where it belongs.
final class ClipConformanceTests: XCTestCase {

    static let expectedVersion = 1

    struct Fixture: Decodable {
        struct Segment: Decodable {
            let fileStartSec: Double
            let fileEndSec: Double
            let ratio: Double
            let localOffsetSec: Double
        }
        struct Window: Decodable {
            let whenSec: Double
            let fileOffsetSec: Double
            let fileDurationSec: Double
            let playbackRate: Double
        }
        struct WindowCase: Decodable {
            let name: String
            let offsetSec: Double
            let trimStartSec: Double
            let trimEndSec: Double
            let stretchRatio: Double
            let warpSegments: [Segment]?
            let playheadSec: Double
            let windows: [Window]
        }
        struct DurationCase: Decodable {
            let name: String
            let trimStartSec: Double
            let trimEndSec: Double
            let stretchRatio: Double
            let warpSegments: [Segment]?
            let seconds: Double
        }
        struct TrimCase: Decodable {
            let name: String
            let trimStartSec: Double
            let trimEndSec: Double?
            let bufferDurationSec: Double
            let resolved: Double
        }
        struct RawSegment: Decodable {
            let fileStartMs: Double
            let fileEndMs: Double
            let ratio: Double
            let localOffsetMs: Double
        }
        struct WarpConversionCase: Decodable {
            let name: String
            let raw: [RawSegment]?
            let segments: [Segment]?
        }
        struct FadeCase: Decodable {
            let curve: String
            let x: Double
            let gain: Double
            let exact: Bool
        }
        struct GainCase: Decodable {
            let db: Double
            let linear: Double
            let exact: Bool
        }
        let version: Int
        let stamp: String
        let tolerance: Double
        let windows: [WindowCase]
        let durations: [DurationCase]
        let trims: [TrimCase]
        let warpConversions: [WarpConversionCase]
        let fades: [FadeCase]
        let gains: [GainCase]
    }

    static func loadFixture() throws -> Fixture {
        if let override = ProcessInfo.processInfo.environment["CRATE_CLIP_FIXTURE"] {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: override)))
        }
        let url = CrateFixtures.url("clip-conformance.json")
        do {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        } catch {
            throw TempoMapError(
                "clip conformance fixture not usable at \(url.path): \(error). "
                    + "Expected fixtures/clip-conformance.json, or set CRATE_CLIP_FIXTURE."
            )
        }
    }

    private func segments(_ raw: [Fixture.Segment]?) -> [WarpSegment]? {
        raw.map {
            $0.map {
                WarpSegment(
                    fileStartSec: $0.fileStartSec, fileEndSec: $0.fileEndSec,
                    ratio: $0.ratio, localOffsetSec: $0.localOffsetSec
                )
            }
        }
    }

    func testFixtureIsAFormatThisBuildUnderstands() throws {
        let fixture = try Self.loadFixture()
        XCTAssertEqual(
            fixture.version, Self.expectedVersion,
            "fixture is version \(fixture.version), this build reads \(Self.expectedVersion)."
        )
    }

    /// The whole placement contract, to the bit.
    func testPlaybackWindowsAgreeToTheBit() throws {
        let fixture = try Self.loadFixture()
        XCTAssertGreaterThan(fixture.windows.count, 10, "fixture looks truncated")
        var failures: [String] = []
        var emitted = 0

        for probe in fixture.windows {
            let actual = clipPlaybackWindows(
                offsetSec: probe.offsetSec,
                trimStartSec: probe.trimStartSec,
                trimEndSec: probe.trimEndSec,
                stretchRatio: probe.stretchRatio,
                warpSegments: segments(probe.warpSegments),
                playheadSec: probe.playheadSec
            )
            emitted += actual.count
            if actual.count != probe.windows.count {
                failures.append("\(probe.name): \(actual.count) windows, crate has \(probe.windows.count)")
                continue
            }
            for (i, expected) in probe.windows.enumerated() {
                let got = actual[i]
                if got.whenSec != expected.whenSec
                    || got.fileOffsetSec != expected.fileOffsetSec
                    || got.fileDurationSec != expected.fileDurationSec
                    || got.playbackRate != expected.playbackRate
                {
                    failures.append(
                        "\(probe.name) window \(i): this build when \(got.whenSec) offset \(got.fileOffsetSec) "
                            + "dur \(got.fileDurationSec) rate \(got.playbackRate); crate when \(expected.whenSec) "
                            + "offset \(expected.fileOffsetSec) dur \(expected.fileDurationSec) rate \(expected.playbackRate)"
                    )
                }
            }
        }

        // A function that always returns an empty list agrees with every
        // "yields nothing" case, which is the most likely way for a port to be
        // wrong and still green.
        XCTAssertGreaterThan(emitted, 12, "nothing was placed, so agreement here means nothing")
        XCTAssertTrue(failures.isEmpty, "clip placement disagrees:\n  " + failures.joined(separator: "\n  "))

        print("""

        === Clip placement, Swift against JavaScript ===
        fixture stamp    \(fixture.stamp) (v\(fixture.version))
        placements       \(fixture.windows.count), \(emitted) windows out
        durations        \(fixture.durations.count)
        trims            \(fixture.trims.count)
        warp conversions \(fixture.warpConversions.count)
        fade probes      \(fixture.fades.count), \(fixture.fades.filter { !$0.exact }.count) transcendental
        gain probes      \(fixture.gains.count)

        """)
    }

    func testTimelineDurationsAgreeToTheBit() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for probe in fixture.durations {
            let actual = clipTimelineDurationSec(
                trimStartSec: probe.trimStartSec,
                trimEndSec: probe.trimEndSec,
                stretchRatio: probe.stretchRatio,
                warpSegments: segments(probe.warpSegments)
            )
            if actual != probe.seconds {
                failures.append("\(probe.name): this build \(actual), crate \(probe.seconds)")
            }
        }
        XCTAssertTrue(failures.isEmpty, "timeline durations disagree:\n  " + failures.joined(separator: "\n  "))
    }

    func testTrimResolutionAgrees() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for probe in fixture.trims {
            let actual = resolveTrimEndSec(
                SampleRegion(trimStartSec: probe.trimStartSec, trimEndSec: probe.trimEndSec),
                bufferDurationSec: probe.bufferDurationSec
            )
            if actual != probe.resolved {
                failures.append("\(probe.name): this build \(actual), crate \(probe.resolved)")
            }
        }
        XCTAssertTrue(failures.isEmpty, "trim resolution disagrees:\n  " + failures.joined(separator: "\n  "))
    }

    func testWarpConversionAgrees() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for probe in fixture.warpConversions {
            let actual = warpSegmentsFromMs(
                probe.raw?.map {
                    (fileStartMs: $0.fileStartMs, fileEndMs: $0.fileEndMs,
                     ratio: $0.ratio, localOffsetMs: $0.localOffsetMs)
                }
            )
            guard let expected = probe.segments else {
                if actual != nil { failures.append("\(probe.name): crate says nil, this build built segments") }
                continue
            }
            guard let actual else {
                failures.append("\(probe.name): crate built \(expected.count) segments, this build said nil")
                continue
            }
            if actual.count != expected.count {
                failures.append("\(probe.name): \(actual.count) segments, crate \(expected.count)")
                continue
            }
            for (i, want) in expected.enumerated() {
                let got = actual[i]
                if got.fileStartSec != want.fileStartSec || got.fileEndSec != want.fileEndSec
                    || got.ratio != want.ratio || got.localOffsetSec != want.localOffsetSec
                {
                    failures.append("\(probe.name) segment \(i): \(got) against crate \(want)")
                }
            }
        }
        XCTAssertTrue(failures.isEmpty, "warp conversion disagrees:\n  " + failures.joined(separator: "\n  "))
    }

    func testFadeShapesAndGain() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for probe in fixture.fades {
            let actual = fadeShape(probe.x, curve: probe.curve)
            let allowed = probe.exact ? 0 : fixture.tolerance
            if abs(actual - probe.gain) > allowed {
                failures.append("fadeShape(\(probe.x), \(probe.curve)): this build \(actual), crate \(probe.gain)")
            }
        }
        for probe in fixture.gains {
            let actual = clipGainLinear(probe.db)
            let allowed = probe.exact ? 0 : fixture.tolerance
            if abs(actual - probe.linear) > allowed {
                failures.append("clipGainLinear(\(probe.db)): this build \(actual), crate \(probe.linear)")
            }
        }
        XCTAssertTrue(failures.isEmpty, "fade shaping disagrees:\n  " + failures.joined(separator: "\n  "))
    }

    /// The silence floor is a literal zero at and below -60 dB, so a muted
    /// clip costs nothing and cannot leak a very small signal.
    func testSilenceFloorIsExact() throws {
        XCTAssertEqual(clipGainLinear(-60), 0)
        XCTAssertEqual(clipGainLinear(-60.1), 0)
        XCTAssertGreaterThan(clipGainLinear(-59.9), 0)
        XCTAssertEqual(clipGainLinear(0), 1, accuracy: 1e-12)
    }
}
