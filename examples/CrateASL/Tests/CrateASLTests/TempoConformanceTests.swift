import XCTest
@testable import CrateASL

/// Does the Swift tempo map answer what the TypeScript one answers?
///
/// The first slice of crate's session layer held across both languages. A host
/// that places a clip does it by asking what second a beat falls on, so a
/// disagreement here is not a rounding, it is a clip in the wrong bar.
///
/// Two rules, and the fixture says which applies per map:
///
///   - a map with **no ramps** is compared with **no tolerance at all**,
///     because a constant map must return the same bits as the plain
///     `(beats * 60) / bpm`. An implementation that pre-divides passes an
///     approximate check and moves every existing clip by a rounding;
///   - a map with a ramp goes through `log` and `exp`, V8 bundles fdlibm and
///     Swift calls Apple's libm, and two correct implementations may disagree
///     in the last bit. Those are held to the fixture's stated tolerance.
///
/// Round trips are held to their own stated tolerance in both cases, because
/// composing the two directions is two roundings and is not an identity. See
/// `TempoMap.beatAtSeconds`.
final class TempoConformanceTests: XCTestCase {

    static let expectedVersion = 1

    struct Fixture: Decodable {
        struct Change: Decodable {
            let atBeat: Double
            let bpm: Double
            let curve: String?
        }
        struct Query: Decodable {
            let at: Double
            let secondsAtBeat: Double
            let bpmAtBeat: Double
            let beatAtSeconds: Double
            let bpmAtSeconds: Double
        }
        struct Span: Decodable {
            let fromBeat: Double
            let beats: Double
            let seconds: Double
        }
        struct Segment: Decodable {
            let atBeat: Double
            let atSeconds: Double
            let bpm: Double
            let slope: Double
        }
        struct RoundTrip: Decodable {
            let beat: Double
            let back: Double
        }
        struct MapCase: Decodable {
            let name: String
            let baseBpm: Double
            let baseCurve: String
            let changes: [Change]
            let exact: Bool
            let isConstant: Bool
            let hasRamps: Bool
            let normalisedChanges: [Change]
            let segments: [Segment]
            let queries: [Query]
            let spans: [Span]
            let roundTrips: [RoundTrip]
        }
        let version: Int
        let stamp: String
        let rampTolerance: Double
        let roundTripTolerance: Double
        let maps: [MapCase]
    }

    static func loadFixture() throws -> Fixture {
        if let override = ProcessInfo.processInfo.environment["CRATE_TEMPO_FIXTURE"] {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: override)))
        }
        let url = CrateFixtures.url("tempo-conformance.json")
        do {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        } catch {
            throw TempoMapError(
                "tempo conformance fixture not usable at \(url.path): \(error). "
                    + "Expected fixtures/tempo-conformance.json, or set CRATE_TEMPO_FIXTURE."
            )
        }
    }

    private func build(_ entry: Fixture.MapCase) throws -> TempoMap {
        try TempoMap(
            entry.changes.map {
                TempoChange(atBeat: $0.atBeat, bpm: $0.bpm, curve: $0.curve == "ramp" ? .ramp : .jump)
            },
            baseBpm: entry.baseBpm,
            baseCurve: entry.baseCurve == "ramp" ? .ramp : .jump
        )
    }

    func testFixtureIsAFormatThisBuildUnderstands() throws {
        let fixture = try Self.loadFixture()
        XCTAssertEqual(
            fixture.version, Self.expectedVersion,
            "fixture is version \(fixture.version), this build reads \(Self.expectedVersion)."
        )
    }

    /// A constant map has to come back bit for bit. This is the assertion that
    /// catches a port written as `beats * (60 / bpm)`, which is the natural
    /// way to write it and the wrong one.
    func testConstantMapsAgreeToTheBit() throws {
        let fixture = try Self.loadFixture()
        let exactMaps = fixture.maps.filter(\.exact)
        XCTAssertGreaterThan(exactMaps.count, 4, "fixture looks truncated")

        var failures: [String] = []
        for entry in exactMaps {
            let map = try build(entry)
            for query in entry.queries {
                if map.secondsAtBeat(query.at) != query.secondsAtBeat {
                    failures.append(
                        "\(entry.name) secondsAtBeat(\(query.at)): this build "
                            + "\(map.secondsAtBeat(query.at)), crate \(query.secondsAtBeat)"
                    )
                }
                if map.beatAtSeconds(query.at) != query.beatAtSeconds {
                    failures.append(
                        "\(entry.name) beatAtSeconds(\(query.at)): this build "
                            + "\(map.beatAtSeconds(query.at)), crate \(query.beatAtSeconds)"
                    )
                }
                if map.bpmAtBeat(query.at) != query.bpmAtBeat {
                    failures.append("\(entry.name) bpmAtBeat(\(query.at))")
                }
                if map.bpmAtSeconds(query.at) != query.bpmAtSeconds {
                    failures.append("\(entry.name) bpmAtSeconds(\(query.at))")
                }
            }
            for span in entry.spans where map.spanSeconds(fromBeat: span.fromBeat, beats: span.beats) != span.seconds {
                failures.append(
                    "\(entry.name) spanSeconds(\(span.fromBeat), \(span.beats)): this build "
                        + "\(map.spanSeconds(fromBeat: span.fromBeat, beats: span.beats)), crate \(span.seconds)"
                )
            }
        }
        XCTAssertTrue(
            failures.isEmpty,
            "a constant tempo map must return the same bits as the plain formula:\n  "
                + failures.joined(separator: "\n  ")
        )
    }

    func testRampMapsAgreeWithinTolerance() throws {
        let fixture = try Self.loadFixture()
        let rampMaps = fixture.maps.filter(\.hasRamps)
        XCTAssertGreaterThan(rampMaps.count, 1, "no ramp maps, so log/exp is untested")

        var failures: [String] = []
        var worst = 0.0
        for entry in rampMaps {
            let map = try build(entry)
            func check(_ label: String, _ actual: Double, _ expected: Double) {
                let diff = abs(actual - expected)
                worst = max(worst, diff)
                if diff > fixture.rampTolerance {
                    failures.append("\(entry.name) \(label): this build \(actual), crate \(expected)")
                }
            }
            for query in entry.queries {
                check("secondsAtBeat(\(query.at))", map.secondsAtBeat(query.at), query.secondsAtBeat)
                check("beatAtSeconds(\(query.at))", map.beatAtSeconds(query.at), query.beatAtSeconds)
                check("bpmAtBeat(\(query.at))", map.bpmAtBeat(query.at), query.bpmAtBeat)
                check("bpmAtSeconds(\(query.at))", map.bpmAtSeconds(query.at), query.bpmAtSeconds)
            }
            for span in entry.spans {
                check(
                    "spanSeconds(\(span.fromBeat), \(span.beats))",
                    map.spanSeconds(fromBeat: span.fromBeat, beats: span.beats),
                    span.seconds
                )
            }
        }
        XCTAssertTrue(failures.isEmpty, "ramp maps disagree:\n  " + failures.joined(separator: "\n  "))

        print("""

        === Tempo map, Swift against JavaScript ===
        fixture stamp    \(fixture.stamp) (v\(fixture.version))
        maps             \(fixture.maps.count), \(fixture.maps.filter(\.exact).count) held to the bit
        queries          \(fixture.maps.reduce(0) { $0 + $1.queries.count })
        spans            \(fixture.maps.reduce(0) { $0 + $1.spans.count })
        worst ramp dev   \(worst) (tolerance \(fixture.rampTolerance))

        """)
    }

    /// The span table, which is what a host reads to follow a tempo change
    /// without being told again. A wrong `atSeconds` here is a change that
    /// lands at the right beat and the wrong moment.
    func testSegmentTablesMatch() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for entry in fixture.maps {
            let map = try build(entry)
            let actual = map.segmentsFrom(beat: -1)
            if actual.count != entry.segments.count {
                failures.append("\(entry.name): \(actual.count) segments, crate has \(entry.segments.count)")
                continue
            }
            for (i, expected) in entry.segments.enumerated() {
                let got = actual[i]
                let tolerance = entry.exact ? 0 : fixture.rampTolerance
                if got.atBeat != expected.atBeat
                    || abs(got.atSeconds - expected.atSeconds) > tolerance
                    || got.bpm != expected.bpm
                    || abs(got.slope - expected.slope) > tolerance
                {
                    failures.append(
                        "\(entry.name) segment \(i): this build beat \(got.atBeat) sec \(got.atSeconds) "
                            + "bpm \(got.bpm) slope \(got.slope); crate beat \(expected.atBeat) "
                            + "sec \(expected.atSeconds) bpm \(expected.bpm) slope \(expected.slope)"
                    )
                }
            }
            // Normalisation is part of the contract: unsorted input sorts, a
            // duplicate beat resolves to the last one written, and an
            // unreachable ramp resolves to a jump.
            let normalised = map.changes
            if normalised.count != entry.normalisedChanges.count {
                failures.append("\(entry.name): normalised to \(normalised.count) changes, crate \(entry.normalisedChanges.count)")
                continue
            }
            for (i, expected) in entry.normalisedChanges.enumerated() {
                let got = normalised[i]
                if got.atBeat != expected.atBeat || got.bpm != expected.bpm
                    || got.curve.rawValue != (expected.curve ?? "jump")
                {
                    failures.append(
                        "\(entry.name) change \(i): this build \(got.atBeat)/\(got.bpm)/\(got.curve.rawValue), "
                            + "crate \(expected.atBeat)/\(expected.bpm)/\(expected.curve ?? "jump")"
                    )
                }
            }
            if map.isConstant != entry.isConstant { failures.append("\(entry.name): isConstant") }
            if map.hasRamps != entry.hasRamps { failures.append("\(entry.name): hasRamps") }
        }
        XCTAssertTrue(failures.isEmpty, "segment tables disagree:\n  " + failures.joined(separator: "\n  "))
    }

    func testRoundTripsMatch() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for entry in fixture.maps {
            let map = try build(entry)
            for trip in entry.roundTrips {
                let back = map.beatAtSeconds(map.secondsAtBeat(trip.beat))
                if abs(back - trip.beat) > fixture.roundTripTolerance {
                    failures.append("\(entry.name) @ \(trip.beat): came back \(back)")
                }
                if abs(back - trip.back) > fixture.roundTripTolerance {
                    failures.append("\(entry.name) @ \(trip.beat): this build \(back), crate \(trip.back)")
                }
            }
        }
        XCTAssertTrue(failures.isEmpty, "round trips disagree:\n  " + failures.joined(separator: "\n  "))
    }

    /// A negative beat extrapolates backwards rather than clamping. An
    /// implementation with a `max(0, ...)` in it passes everything else.
    func testBelowTheOriginExtrapolates() throws {
        let fixture = try Self.loadFixture()
        for entry in fixture.maps {
            let map = try build(entry)
            XCTAssertLessThan(map.secondsAtBeat(-4), 0, "\(entry.name): beat -4 should be before the origin")
        }
    }

    func testRejectsAnImpossibleTempo() throws {
        XCTAssertThrowsError(try TempoMap([], baseBpm: 0))
        XCTAssertThrowsError(try TempoMap([], baseBpm: -120))
        XCTAssertThrowsError(try TempoMap([TempoChange(atBeat: -1, bpm: 120)]))
        XCTAssertThrowsError(try TempoMap([TempoChange(atBeat: 4, bpm: 0)]))
    }
}
