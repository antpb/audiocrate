import XCTest
@testable import CrateASL

/// Does the Swift MIDI host I/O behave the way `midi/midiIo.ts` does.
///
/// `ConformanceTests` holds the two interpreters to the same per-sample maths.
/// This holds the two hosts to the same jacks, which the ASL fixture has never
/// been able to see: MIDI In and MIDI Out are Material kinds handled in
/// `patcher/flattenPatch.ts`, not `NodeKind` cases, so no rendered graph
/// touches them.
///
/// There is no tolerance here and there should not be. Everything compared is
/// a MIDI byte, a note number, a jack name, or a double produced by dividing
/// one small integer by another, which two IEEE754 implementations compute
/// identically. A note that is off by one is a wrong note, not a rounding
/// disagreement, and accepting one would defeat the file.
///
/// The fixture is written by `scripts/emit-midi-fixtures.ts`
/// and its expectations are recorded from the TypeScript implementation, never
/// typed by hand. Regenerate with `npm run fixtures:midi`.
///
/// Run with `/usr/bin/swift test`. A `swiftly`-managed toolchain earlier on
/// PATH links against a system `ld` that does not know
/// `-no_warn_duplicate_libraries`, and the failure looks like a broken package
/// rather than a broken toolchain selection.
final class MidiConformanceTests: XCTestCase {

    /// The fixture format this build reads. Mirrors
    /// `MIDI_CONFORMANCE_FIXTURE_VERSION` in `midi/midiConformance.ts`.
    static let expectedVersion = 2

    struct Fixture: Decodable {
        struct Event: Decodable {
            let type: String
            let note: Int?
            let velocity: Double?
            let cc: Int?
            let value: Int?
            let program: Int?
            let channel: Int?
        }
        struct ParseCase: Decodable {
            let name: String
            let bytes: [UInt8]
            let channel: Int
            let event: Event?
        }
        struct Snapshot: Decodable {
            let note: Int
            let velocity: Double
            let gate: Double
            let cv: Double
            let cc: Double
            let held: [Int]
        }
        struct MonitorStep: Decodable {
            let bytes: [UInt8]
            let snapshot: Snapshot
        }
        struct MonitorCase: Decodable {
            let name: String
            let channel: Int
            let steps: [MonitorStep]
        }
        struct Sample: Decodable {
            let note: Double
            let cv: Double
            let gate: Double
            let trig: Double
            let velocity: Double
            let cc: Double
        }
        struct Cables: Decodable {
            let note: Bool
            let cv: Bool
            let gate: Bool
            let trig: Bool
            let velocity: Bool
            let cc: Bool
        }
        struct Fields: Decodable {
            let deviceId: String?
            let channel: Double
            let message: Double
            let cc: Double
            let widthSec: Double
        }
        struct Tick: Decodable {
            let sample: Sample
            let types: [String]
            let bytes: [[UInt8]]
        }
        struct OutputCase: Decodable {
            let name: String
            let fields: Fields
            let cables: Cables
            let dtSec: Double
            let ticks: [Tick]
        }
        struct EncodeCase: Decodable {
            let name: String
            let type: String
            let a: Double
            let b: Double
            let channel: Double
            let bytes: [UInt8]
        }
        struct OutletCase: Decodable {
            let name: String
            let snapshot: Snapshot?
            let levels: [String: Double]
        }
        struct Reading: Decodable {
            let mean: Double
            let peak: Double
            let pulse: Bool?
        }
        struct InletCase: Decodable {
            let name: String
            let cables: Cables
            let readings: [String: Reading]
            let sample: Sample
        }
        struct ScalarCase: Decodable {
            let fn: String
            let input: Double
            let output: Double
        }
        let version: Int
        let stamp: String
        let inOutputs: [String]
        let outInputs: [String]
        let messageNames: [String]
        let ioKinds: [String: String]
        let defaults: [String: Fields]
        let trigSeconds: Double
        let emptySample: Sample
        let outlets: [OutletCase]
        let inlets: [InletCase]
        let parse: [ParseCase]
        let monitor: [MonitorCase]
        let output: [OutputCase]
        let encode: [EncodeCase]
        let scalars: [ScalarCase]
    }

    static func loadFixture() throws -> Fixture {
        if let override = ProcessInfo.processInfo.environment["CRATE_MIDI_FIXTURE"] {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: override)))
        }
        let url = CrateFixtures.url("midi-conformance.json")
        do {
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        } catch {
            throw ASLCompileError(
                "MIDI conformance fixture not usable at \(url.path): \(error). "
                    + "Expected fixtures/midi-conformance.json, or set CRATE_MIDI_FIXTURE."
            )
        }
    }

    func testFixtureIsAFormatThisBuildUnderstands() throws {
        let fixture = try Self.loadFixture()
        XCTAssertEqual(
            fixture.version, Self.expectedVersion,
            "fixture is version \(fixture.version), this build reads \(Self.expectedVersion). "
                + "Decoding the half it recognises would report full marks while checking "
                + "less than the fixture describes."
        )
    }

    /// The jack names, not only the behaviour behind them. A cable into an
    /// outlet this build has never heard of goes nowhere silently, which is
    /// the MIDI version of the node-kind drift `ConformanceTests` closes.
    func testJackVocabulariesAreIdentical() throws {
        let fixture = try Self.loadFixture()
        XCTAssertEqual(MIDI_IN_OUTPUTS, fixture.inOutputs, "MIDI In outlets disagree with crate")
        XCTAssertEqual(MIDI_OUT_INPUTS, fixture.outInputs, "MIDI Out inlets disagree with crate")
        XCTAssertEqual(MIDI_MESSAGE_NAMES, fixture.messageNames, "message kinds disagree with crate")
        XCTAssertEqual(fixture.ioKinds["midiIn"], MIDI_IN_KIND)
        XCTAssertEqual(fixture.ioKinds["midiOut"], MIDI_OUT_KIND)
    }

    func testDefaultFieldsMatch() throws {
        let fixture = try Self.loadFixture()
        for (name, expected) in fixture.defaults {
            let actual = name == "midiIn" ? MidiIoFields.midiInDefaults : MidiIoFields.midiOutDefaults
            XCTAssertEqual(actual.channel, expected.channel, "\(name) default channel")
            XCTAssertEqual(actual.message, expected.message, "\(name) default message")
            XCTAssertEqual(actual.cc, expected.cc, "\(name) default cc")
            XCTAssertEqual(actual.widthSec, expected.widthSec, "\(name) default widthSec")
            XCTAssertNil(expected.deviceId, "a fixture must not carry this machine's port ids")
            XCTAssertNil(actual.deviceId)
        }
    }

    /// The two constants that were editor-local. A host that guessed the trig
    /// width would emit an edge too short for its own control rate to see, and
    /// a host that guessed the unpatched note would emit pitch 0.
    func testHostConstantsMatch() throws {
        let fixture = try Self.loadFixture()
        XCTAssertEqual(MIDI_TRIG_SECONDS, fixture.trigSeconds, "trig pulse width disagrees with crate")
        let empty = emptyMidiSample()
        XCTAssertEqual(empty.note, fixture.emptySample.note, "unpatched pitch disagrees with crate")
        XCTAssertEqual(empty.cv, fixture.emptySample.cv)
        XCTAssertEqual(empty.gate, fixture.emptySample.gate)
        XCTAssertEqual(empty.trig, fixture.emptySample.trig)
        XCTAssertEqual(empty.velocity, fixture.emptySample.velocity)
        XCTAssertEqual(empty.cc, fixture.emptySample.cc)
    }

    /// What a graph patched to a MIDI In reads, including before anyone plays.
    func testMidiInOutletLevels() throws {
        let fixture = try Self.loadFixture()
        XCTAssertGreaterThan(fixture.outlets.count, 3, "fixture looks truncated")
        var failures: [String] = []
        for probe in fixture.outlets {
            let snapshot = probe.snapshot.map {
                MidiInputSnapshot(
                    note: $0.note, velocity: $0.velocity, gate: $0.gate,
                    cv: $0.cv, cc: $0.cc, held: $0.held
                )
            }
            let actual = midiInOutlets(snapshot)
            for outlet in fixture.inOutputs {
                guard let expected = probe.levels[outlet] else {
                    failures.append("\(probe.name): crate states no level for \(outlet)")
                    continue
                }
                guard let got = actual[outlet] else {
                    failures.append("\(probe.name): this build has no outlet \(outlet)")
                    continue
                }
                if got != expected {
                    failures.append("\(probe.name)/\(outlet): this build \(got), crate \(expected)")
                }
            }
        }
        XCTAssertTrue(failures.isEmpty, "MIDI In outlets disagree:\n  " + failures.joined(separator: "\n  "))
    }

    /// How a host's per-inlet readings gather into one convertor tick. Covers
    /// the pulse rule (a one-sample event invisible in mean and peak) and the
    /// difference between an inlet with no reading and one reading zero.
    func testMidiOutInletGather() throws {
        let fixture = try Self.loadFixture()
        XCTAssertGreaterThan(fixture.inlets.count, 5, "fixture looks truncated")
        var failures: [String] = []
        for probe in fixture.inlets {
            let cables = MidiOutputCables(
                note: probe.cables.note, cv: probe.cables.cv, gate: probe.cables.gate,
                trig: probe.cables.trig, velocity: probe.cables.velocity, cc: probe.cables.cc
            )
            let actual = midiOutSample(cables) { inlet in
                guard let reading = probe.readings[inlet] else { return nil }
                return MidiInletReading(mean: reading.mean, peak: reading.peak, pulse: reading.pulse ?? false)
            }
            let e = probe.sample
            if actual.note != e.note || actual.cv != e.cv || actual.gate != e.gate
                || actual.trig != e.trig || actual.velocity != e.velocity || actual.cc != e.cc
            {
                failures.append(
                    "\(probe.name): this build note \(actual.note) cv \(actual.cv) gate \(actual.gate) "
                        + "trig \(actual.trig) vel \(actual.velocity) cc \(actual.cc); crate "
                        + "note \(e.note) cv \(e.cv) gate \(e.gate) trig \(e.trig) vel \(e.velocity) cc \(e.cc)"
                )
            }
        }
        XCTAssertTrue(failures.isEmpty, "MIDI Out inlet gather disagrees:\n  " + failures.joined(separator: "\n  "))
    }

    func testScalarConversions() throws {
        let fixture = try Self.loadFixture()
        XCTAssertGreaterThan(fixture.scalars.count, 60, "fixture looks truncated")
        var failures: [String] = []
        for probe in fixture.scalars {
            let actual: Double
            switch probe.fn {
            case "jsRound": actual = midiRound(probe.input)
            case "voltsFromMidi": actual = voltsFromMidi(probe.input)
            case "midiFromVolts": actual = Double(midiFromVolts(probe.input))
            case "clampMidi": actual = Double(clampMidi(probe.input))
            case "clamp01": actual = clamp01(probe.input)
            case "midi7": actual = Double(midi7(probe.input))
            case "midiChannelByte": actual = Double(midiChannelByte(probe.input))
            case "midiInputChannel": actual = Double(midiInputChannel(probe.input))
            case "midiOutputChannel": actual = Double(midiOutputChannel(probe.input))
            case "midiMessageIndex": actual = Double(midiMessageIndex(probe.input))
            default:
                failures.append("\(probe.fn): crate has this conversion and this build does not")
                continue
            }
            if actual != probe.output {
                failures.append("\(probe.fn)(\(probe.input)) = \(actual), crate says \(probe.output)")
            }
        }
        XCTAssertTrue(failures.isEmpty, "scalar conversions disagree:\n  " + failures.joined(separator: "\n  "))
    }

    func testParsesTheSamePackets() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for probe in fixture.parse {
            let actual = parseMidiBytes(probe.bytes, channel: probe.channel)
            guard let expected = probe.event else {
                if let actual {
                    failures.append("\(probe.name): crate drops this packet, this build read \(actual.typeName)")
                }
                continue
            }
            guard let actual else {
                failures.append("\(probe.name): crate reads \(expected.type), this build dropped it")
                continue
            }
            if actual.typeName != expected.type {
                failures.append("\(probe.name): crate reads \(expected.type), this build read \(actual.typeName)")
                continue
            }
            switch actual {
            case let .noteOn(note, velocity, channel):
                if note != expected.note || velocity != expected.velocity || channel != expected.channel {
                    failures.append("\(probe.name): note \(note) vel \(velocity) ch \(channel)")
                }
            case let .noteOff(note, channel):
                if note != expected.note || channel != expected.channel {
                    failures.append("\(probe.name): note \(note) ch \(channel)")
                }
            case let .cc(cc, value, channel):
                if cc != expected.cc || value != expected.value || channel != expected.channel {
                    failures.append("\(probe.name): cc \(cc) value \(value) ch \(channel)")
                }
            case let .program(program, channel):
                if program != expected.program || channel != expected.channel {
                    failures.append("\(probe.name): program \(program) ch \(channel)")
                }
            case let .allNotesOff(channel):
                if channel != expected.channel { failures.append("\(probe.name): ch \(channel)") }
            }
        }
        XCTAssertTrue(failures.isEmpty, "packet parsing disagrees:\n  " + failures.joined(separator: "\n  "))
    }

    /// The snapshot after *every* packet, not only the last one. A monitor
    /// that ends in the right place having passed through the wrong ones is a
    /// stuck note or a bent pitch, and comparing only the end would miss both.
    func testMonitorTracksTheSameSnapshots() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for probe in fixture.monitor {
            let monitor = MidiInputMonitor()
            for (index, step) in probe.steps.enumerated() {
                if let event = parseMidiBytes(step.bytes, channel: probe.channel) { monitor.apply(event) }
                let actual = monitor.snapshot
                let expected = step.snapshot
                if actual.note != expected.note
                    || actual.velocity != expected.velocity
                    || actual.gate != expected.gate
                    || actual.cv != expected.cv
                    || actual.cc != expected.cc
                    || actual.held != expected.held
                {
                    failures.append(
                        "\(probe.name) step \(index): this build "
                            + "note \(actual.note) vel \(actual.velocity) gate \(actual.gate) "
                            + "cv \(actual.cv) cc \(actual.cc) held \(actual.held); crate "
                            + "note \(expected.note) vel \(expected.velocity) gate \(expected.gate) "
                            + "cv \(expected.cv) cc \(expected.cc) held \(expected.held)"
                    )
                }
            }
        }
        XCTAssertTrue(failures.isEmpty, "MIDI In snapshots disagree:\n  " + failures.joined(separator: "\n  "))
    }

    func testEncodesTheSameBytes() throws {
        let fixture = try Self.loadFixture()
        var failures: [String] = []
        for probe in fixture.encode {
            let event: MidiVoiceEvent
            switch probe.type {
            case "noteOn": event = .noteOn(note: Int(probe.a), velocity: probe.b)
            case "noteOff": event = .noteOff(note: Int(probe.a))
            case "cc": event = .cc(cc: Int(probe.a), value: Int(probe.b))
            default: event = .program(program: Int(probe.a))
            }
            let actual = encodeMidiVoiceEvent(event, channel: probe.channel)
            if actual != probe.bytes {
                failures.append("\(probe.name): this build \(actual), crate \(probe.bytes)")
            }
        }
        XCTAssertTrue(failures.isEmpty, "encoded packets disagree:\n  " + failures.joined(separator: "\n  "))
    }

    /// The convertor, tick by tick. This is the case family that carries the
    /// rules nothing else could hold: gate owns length, trig is the event,
    /// trig retriggers only while gate is high, a one-tick pulse still makes a
    /// note a synth can hear.
    func testConvertorEmitsTheSameEvents() throws {
        let fixture = try Self.loadFixture()
        XCTAssertGreaterThan(fixture.output.count, 5, "fixture looks truncated")
        var failures: [String] = []
        var emitted = 0

        for probe in fixture.output {
            let fields = MidiIoFields(
                deviceId: nil,
                channel: probe.fields.channel,
                message: probe.fields.message,
                cc: probe.fields.cc,
                widthSec: probe.fields.widthSec
            )
            let cables = MidiOutputCables(
                note: probe.cables.note,
                cv: probe.cables.cv,
                gate: probe.cables.gate,
                trig: probe.cables.trig,
                velocity: probe.cables.velocity,
                cc: probe.cables.cc
            )
            var state = MidiOutputState()

            for (index, tick) in probe.ticks.enumerated() {
                let sample = MidiOutputSample(
                    note: tick.sample.note,
                    cv: tick.sample.cv,
                    gate: tick.sample.gate,
                    trig: tick.sample.trig,
                    velocity: tick.sample.velocity,
                    cc: tick.sample.cc
                )
                let events = stepMidiOutput(sample, cables, fields, &state, dtSec: probe.dtSec)
                let types = events.map(\.typeName)
                let bytes = events.map { encodeMidiVoiceEvent($0, channel: fields.channel) }
                emitted += bytes.count

                if types != tick.types {
                    failures.append(
                        "\(probe.name) tick \(index): this build \(types.isEmpty ? "(none)" : types.joined(separator: ",")), "
                            + "crate \(tick.types.isEmpty ? "(none)" : tick.types.joined(separator: ","))"
                    )
                    continue
                }
                if bytes != tick.bytes {
                    failures.append("\(probe.name) tick \(index): this build \(bytes), crate \(tick.bytes)")
                }
            }
        }

        // A convertor that returns an empty array from every call agrees with
        // every "(none)" tick, which is the most likely way for a port to be
        // wrong and still green.
        XCTAssertGreaterThan(emitted, 15, "nothing was emitted, so agreement here means nothing")
        XCTAssertTrue(failures.isEmpty, "MIDI Out convertor disagrees:\n  " + failures.joined(separator: "\n  "))

        print("""

        === MIDI host jacks, Swift against JavaScript ===
        fixture stamp    \(fixture.stamp) (v\(fixture.version))
        parse            \(fixture.parse.count) packets
        monitor          \(fixture.monitor.count) streams, \(fixture.monitor.reduce(0) { $0 + $1.steps.count }) snapshots
        outlets          \(fixture.outlets.count) snapshots
        inlets           \(fixture.inlets.count) gathers, trig \(fixture.trigSeconds)s
        convertor        \(fixture.output.count) cases, \(fixture.output.reduce(0) { $0 + $1.ticks.count }) ticks, \(emitted) packets out
        encode           \(fixture.encode.count) events
        scalars          \(fixture.scalars.count) probes
        jacks            \(fixture.inOutputs.count) in, \(fixture.outInputs.count) out

        """)
    }
}
