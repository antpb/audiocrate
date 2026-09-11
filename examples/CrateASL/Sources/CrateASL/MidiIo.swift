import Foundation

/// Live MIDI host I/O, the Swift half of `web-version/packages/crate/src/midi/midiIo.ts`.
///
/// Line is the audio capture jack; these are the MIDI ones. MIDI In is a
/// source, MIDI Out is a sink, and neither is DSP: nothing here appears in
/// `NodeKind`, and flatten treats these the way it treats Keyboard and
/// Master. They live in the interpreter package because a host that has
/// crate's graph and not crate's jacks has to invent a second MIDI language,
/// and then the two disagree about what a pulse means.
///
/// Held to `fixtures/midi-conformance.json` by `MidiConformanceTests`. The
/// rules below are stated as prose in `CRATE_HANDOFF.md` under "Do not
/// regress", and prose is exactly what let the conformance test itself drift
/// on this side once already. Change a rule here and the fixture goes stale
/// on the JavaScript side, which is the point.
///
/// Device ids are deliberately absent from everything that renders. They name
/// a port on one machine, they are host-owned, and they must not cross a
/// collab session (`host/hostLocal.ts`). Channel, message, cc and width are
/// patch settings and do travel.

public let A4_MIDI = 69

/// The outlets a MIDI In node offers, in the order the editor draws them.
public let MIDI_IN_OUTPUTS = ["cv", "gate", "trig", "velocity", "note", "cc"]

/// The inlets a MIDI Out node accepts.
public let MIDI_OUT_INPUTS = ["note", "cv", "gate", "trig", "velocity", "cc"]

public let MIDI_MESSAGE_NAMES = ["Note", "CC", "Program"]

public let MIDI_IN_KIND = "midiin"
public let MIDI_OUT_KIND = "midiout"

// MARK: - Conversions

/// A4 is 0V. One volt per octave, which is what the `cv` jack carries.
public func voltsFromMidi(_ note: Double) -> Double {
    (note - Double(A4_MIDI)) / 12
}

public func midiFromVolts(_ cv: Double) -> Int {
    clampMidi(midiRound(Double(A4_MIDI) + cv * 12))
}

/// `Math.round` in JavaScript rounds half toward positive infinity, so -0.5
/// is -0 and -1.5 is -1. Swift's `rounded()` rounds half away from zero, so
/// the same two inputs give -1 and -2.
///
/// Every conversion in this file clamps at 0, which means the disagreement is
/// invisible in all of their outputs: a probe on `clampMidi(-0.5)` returns 0
/// either way and proves nothing. That is exactly why this is not left
/// implicit. The fixture carries a `jsRound` family that records
/// `Math.round` at the boundaries directly, and `MidiConformanceTests` holds
/// this function to it, so the rule is asserted one clamp before it could
/// ever become an audible wrong note.
@inline(__always) func midiRound(_ value: Double) -> Double {
    (value - value.rounded(.down) == 0.5) ? value.rounded(.down) + 1 : value.rounded()
}

public func clampMidi(_ note: Double) -> Int {
    guard note.isFinite else { return 0 }
    return Int(max(0, min(127, midiRound(note))))
}

public func clamp01(_ value: Double) -> Double {
    guard value.isFinite else { return 0 }
    if value < 0 { return 0 }
    if value > 1 { return 1 }
    return value
}

/// A 7-bit value from either a normalised 0..1 control or an already-MIDI
/// number. The ambiguity is deliberate and it is why anything above 1 is read
/// as already being in MIDI units: a CC inlet fed by a knob and the same
/// inlet fed by another device's CC both have to land somewhere sensible.
public func midi7(_ value: Double) -> Int {
    guard value.isFinite else { return 0 }
    if value > 1 { return Int(max(0, min(127, midiRound(value)))) }
    return Int(max(0, min(127, midiRound(value * 127))))
}

/// The low nibble of a status byte. Channels are 1-based everywhere a person
/// can see them and 0-based only here.
public func midiChannelByte(_ channel: Double) -> Int {
    let n = Int(midiRound(channel))
    if n <= 0 { return 0 }
    return max(0, min(15, n - 1))
}

/// Input 0 is omni. 1..16 is a MIDI channel. Anything else is omni.
public func midiInputChannel(_ channel: Double) -> Int {
    let n = Int(midiRound(channel))
    return (n >= 1 && n <= 16) ? n : 0
}

/// Output has no omni: a message has to go somewhere, so it goes to 1.
public func midiOutputChannel(_ channel: Double) -> Int {
    let n = Int(midiRound(channel))
    return (n >= 1 && n <= 16) ? n : 1
}

public func midiMessageIndex(_ value: Double) -> Int {
    let n = Int(midiRound(value))
    if n < 0 { return 0 }
    if n >= MIDI_MESSAGE_NAMES.count { return 0 }
    return n
}

// MARK: - Fields

/// The patch settings on a MIDI node. `deviceId` is host-local and is carried
/// here only so a host can round-trip it; nothing in this file reads it.
public struct MidiIoFields: Sendable, Equatable {
    public var deviceId: String?
    public var channel: Double
    public var message: Double
    public var cc: Double
    public var widthSec: Double

    public init(
        deviceId: String? = nil,
        channel: Double,
        message: Double = 0,
        cc: Double = 1,
        widthSec: Double = 0.05
    ) {
        self.deviceId = deviceId
        self.channel = channel
        self.message = message
        self.cc = cc
        self.widthSec = widthSec
    }

    public static let midiInDefaults = MidiIoFields(channel: 0)
    public static let midiOutDefaults = MidiIoFields(channel: 1)
}

// MARK: - Events

public enum MidiVoiceEvent: Sendable, Equatable {
    case noteOn(note: Int, velocity: Double)
    case noteOff(note: Int)
    case cc(cc: Int, value: Int)
    case program(program: Int)

    /// Matches the `type` string the fixture records.
    public var typeName: String {
        switch self {
        case .noteOn: return "noteOn"
        case .noteOff: return "noteOff"
        case .cc: return "cc"
        case .program: return "program"
        }
    }
}

/// Note On velocity is floored at 1: a zero-velocity Note On is a Note Off on
/// every synth ever made, so emitting one would silence the note the graph
/// just asked for.
public func encodeMidiVoiceEvent(_ event: MidiVoiceEvent, channel: Double) -> [UInt8] {
    let ch = UInt8(midiChannelByte(channel))
    switch event {
    case let .noteOn(note, velocity):
        return [0x90 | ch, UInt8(note), UInt8(max(1, midi7(velocity)))]
    case let .noteOff(note):
        return [0x80 | ch, UInt8(note), 64]
    case let .cc(cc, value):
        return [0xb0 | ch, UInt8(cc), UInt8(value)]
    case let .program(program):
        return [0xc0 | ch, UInt8(program)]
    }
}

public enum MidiInputEvent: Sendable, Equatable {
    case noteOn(note: Int, velocity: Double, channel: Int)
    case noteOff(note: Int, channel: Int)
    case cc(cc: Int, value: Int, channel: Int)
    case program(program: Int, channel: Int)
    case allNotesOff(channel: Int)

    public var typeName: String {
        switch self {
        case .noteOn: return "noteOn"
        case .noteOff: return "noteOff"
        case .cc: return "cc"
        case .program: return "program"
        case .allNotesOff: return "allNotesOff"
        }
    }
}

/// Channel 0 is omni. Missing or short packets are ignored rather than
/// guessed at, and a status byte this does not map returns nil rather than
/// being forced into the nearest thing, because a pitch bend read as a CC is
/// worse than a pitch bend dropped.
public func parseMidiBytes(_ data: [UInt8], channel: Int = 0) -> MidiInputEvent? {
    if data.count < 2 { return nil }
    let status = data[0]
    let cmd = status & 0xf0
    let src = Int(status & 0x0f) + 1
    if channel >= 1 && src != channel { return nil }
    let d1 = Double(data[1])
    let d2 = data.count > 2 ? Int(data[2]) : 0

    if cmd == 0x90 && d2 > 0 {
        return .noteOn(note: clampMidi(d1), velocity: Double(d2) / 127, channel: src)
    }
    if cmd == 0x80 || (cmd == 0x90 && d2 == 0) {
        return .noteOff(note: clampMidi(d1), channel: src)
    }
    if cmd == 0xb0 && Int(d1) == 123 { return .allNotesOff(channel: src) }
    if cmd == 0xb0 { return .cc(cc: clampMidi(d1), value: d2, channel: src) }
    if cmd == 0xc0 { return .program(program: clampMidi(d1), channel: src) }
    return nil
}

// MARK: - MIDI In

public struct MidiInputSnapshot: Sendable, Equatable {
    public var note: Int
    public var velocity: Double
    public var gate: Double
    public var cv: Double
    public var cc: Double
    public var held: [Int]
}

/// The last-note analog snapshot a Keyboard writes, driven by MIDI instead.
///
/// Last note wins while keys are held, and releasing the top key falls back to
/// the one still down rather than to silence. Pitch and velocity survive the
/// last release on purpose: an envelope in its release stage is still reading
/// `cv`, and snapping it to zero would bend every note as it decays.
public final class MidiInputMonitor {
    private var stack: [(note: Int, velocity: Double)] = []
    public private(set) var lastNote = 60
    public private(set) var lastVelocity = 0.85
    public private(set) var lastCc: Double = 0

    public init() {}

    public enum Edge: Sendable, Equatable {
        case press(note: Int, velocity: Double)
        case release(note: Int, velocity: Double)
    }

    @discardableResult
    public func apply(_ event: MidiInputEvent) -> Edge? {
        switch event {
        case let .noteOn(note, velocity, _):
            // Re-pressing a held key moves it to the top rather than adding a
            // second entry, so one physical key is one entry and its release
            // cannot leave a ghost behind.
            if let existing = stack.firstIndex(where: { $0.note == note }) { stack.remove(at: existing) }
            stack.append((note: note, velocity: velocity))
            lastNote = note
            lastVelocity = velocity
            return .press(note: note, velocity: velocity)
        case let .noteOff(note, _):
            guard let index = stack.firstIndex(where: { $0.note == note }) else { return nil }
            stack.remove(at: index)
            if let top = stack.last {
                lastNote = top.note
                lastVelocity = top.velocity
            } else {
                lastNote = note
            }
            return .release(note: note, velocity: lastVelocity)
        case let .cc(_, value, _):
            lastCc = Double(value) / 127
            return nil
        case .allNotesOff:
            stack.removeAll()
            return nil
        case .program:
            return nil
        }
    }

    public var snapshot: MidiInputSnapshot {
        let top = stack.last
        let note = top?.note ?? lastNote
        let velocity = top?.velocity ?? lastVelocity
        return MidiInputSnapshot(
            note: note,
            velocity: velocity,
            gate: stack.isEmpty ? 0 : 1,
            cv: voltsFromMidi(Double(note)),
            cc: lastCc,
            held: stack.map(\.note)
        )
    }
}

// MARK: - MIDI Out

public struct MidiOutputSample: Sendable, Equatable {
    public var note: Double
    public var cv: Double
    public var gate: Double
    public var trig: Double
    public var velocity: Double
    public var cc: Double

    public init(
        note: Double = 60, cv: Double = 0, gate: Double = 0,
        trig: Double = 0, velocity: Double = 0.8, cc: Double = 0
    ) {
        self.note = note
        self.cv = cv
        self.gate = gate
        self.trig = trig
        self.velocity = velocity
        self.cc = cc
    }
}

/// Which inlets actually have a cable. This is not the same as "the value is
/// zero": an unpatched gate means the trig owns note length, and a gate
/// patched but sitting at zero means the voice is off.
public struct MidiOutputCables: Sendable, Equatable {
    public var note = false
    public var cv = false
    public var gate = false
    public var trig = false
    public var velocity = false
    public var cc = false

    public init(
        note: Bool = false, cv: Bool = false, gate: Bool = false,
        trig: Bool = false, velocity: Bool = false, cc: Bool = false
    ) {
        self.note = note
        self.cv = cv
        self.gate = gate
        self.trig = trig
        self.velocity = velocity
        self.cc = cc
    }
}

public struct MidiOutputState: Sendable {
    var prevGate = false
    var prevTrig = false
    var sounding: Int?
    var lastPitch = 60
    var lastCc = -1
    var offIn: Double?

    public init() {}
}

/// `note` wins over `cv` when both are patched, because a note number is
/// exact and a voltage is a rounding. With neither patched the last pitch is
/// held, so a gate with no pitch source repeats the previous note instead of
/// jumping to 0.
public func resolveMidiPitch(
    _ sample: MidiOutputSample,
    _ cables: MidiOutputCables,
    lastPitch: Int
) -> Int {
    if cables.note { return clampMidi(sample.note) }
    if cables.cv { return midiFromVolts(sample.cv) }
    return lastPitch
}

/// One control tick of a MIDI Out node.
///
/// Gate is the held voice: rise sends Note On, fall sends Note Off, a pitch
/// change while held re-articulates. Trig is the event: a pulse from a looper
/// or clock fires Note On. If gate is also patched, trig retriggers only while
/// gate is high and gate still owns the length. If gate is not patched, the
/// note ends on trig fall or after `widthSec`, whichever is later, so a
/// one-sample pulse still produces a MIDI note a synth can hear.
public func stepMidiOutput(
    _ sample: MidiOutputSample,
    _ cables: MidiOutputCables,
    _ fields: MidiIoFields,
    _ state: inout MidiOutputState,
    dtSec: Double
) -> [MidiVoiceEvent] {
    var events: [MidiVoiceEvent] = []
    let message = midiMessageIndex(fields.message)
    let pitch = resolveMidiPitch(sample, cables, lastPitch: state.lastPitch)
    state.lastPitch = pitch
    let velocity = cables.velocity ? clamp01(sample.velocity) : 0.85
    let gateHigh = cables.gate && sample.gate > 0.5
    let trigHigh = cables.trig && sample.trig > 0.5
    let gateRise = gateHigh && !state.prevGate
    let gateFall = !gateHigh && state.prevGate
    let trigRise = trigHigh && !state.prevTrig
    let trigFall = !trigHigh && state.prevTrig
    let width = fields.widthSec > 0 ? fields.widthSec : 0.05

    func noteOn(_ note: Int, _ vel: Double) {
        events.append(.noteOn(note: note, velocity: vel))
        state.sounding = note
    }
    func noteOff(_ note: Int) {
        events.append(.noteOff(note: note))
        if state.sounding == note { state.sounding = nil }
        state.offIn = nil
    }

    if message == 1 {
        let source = cables.cc ? sample.cc : (cables.velocity ? sample.velocity : 0)
        let value = midi7(source)
        if trigRise || value != state.lastCc {
            events.append(.cc(cc: clampMidi(fields.cc), value: value))
            state.lastCc = value
        }
    } else if message == 2 {
        if trigRise || gateRise {
            let program = cables.cc ? midi7(sample.cc) : pitch
            events.append(.program(program: clampMidi(Double(program))))
        }
    } else if cables.gate {
        if gateRise {
            noteOn(pitch, velocity)
        } else if gateFall, let sounding = state.sounding {
            noteOff(sounding)
        } else if gateHigh, let sounding = state.sounding, pitch != sounding {
            noteOff(sounding)
            noteOn(pitch, velocity)
        }
        if trigRise && gateHigh {
            if let sounding = state.sounding { noteOff(sounding) }
            noteOn(pitch, velocity)
        }
    } else if cables.trig {
        if trigRise {
            if let sounding = state.sounding { noteOff(sounding) }
            noteOn(pitch, velocity)
            state.offIn = width
        }
        if trigFall, let sounding = state.sounding {
            if state.offIn == nil || state.offIn! <= 0 { noteOff(sounding) }
        }
        if state.offIn != nil, let sounding = state.sounding {
            state.offIn! -= max(0, dtSec)
            if state.offIn! <= 0 && !trigHigh { noteOff(sounding) }
        }
    }

    state.prevGate = gateHigh
    state.prevTrig = trigHigh
    return events
}

// MARK: - Host graph layer

/// Driving a MIDI In or MIDI Out node from a host graph, matching
/// `midi/midiHostIo.ts`.
///
/// The convertor above is bytes in and bytes out. This is the layer
/// immediately around it: what an outlet reads before anyone plays a note, and
/// how a host's per-inlet readings gather into one tick. It was written once
/// in crate's example editor, which is not part of the published package, so
/// every other host had to reinvent it and the reinventions would not agree.

/// How long a `trig` outlet stays high, in seconds.
///
/// A note press is an instant and a graph reads levels, so the pulse needs a
/// width. 8 ms survives a control tick at any realistic block size and is
/// still short enough that two fast repeats are two edges, not one gate.
public let MIDI_TRIG_SECONDS = 0.008

/// What a MIDI Out node reads from one cabled inlet.
///
/// `pulse` is the host saying a one-sample event happened since the last tick
/// and may be invisible in both statistics: a looper wrap or a clock edge can
/// be a single sample wide, and an interval mean over a block will not see it.
public struct MidiInletReading: Sendable, Equatable {
    public var mean: Double
    public var peak: Double
    public var pulse: Bool

    public init(mean: Double, peak: Double, pulse: Bool = false) {
        self.mean = mean
        self.peak = peak
        self.pulse = pulse
    }
}

/// An unpatched MIDI Out tick.
///
/// `note` is 60 rather than 0 because an unpatched pitch has to be some note
/// and middle C is the one a person expects. 0 is an inaudible sub-bass C that
/// reads as a broken patch.
public func emptyMidiSample() -> MidiOutputSample { MidiOutputSample(velocity: 0) }

public func emptyMidiCables() -> MidiOutputCables { MidiOutputCables() }

/// The six MIDI In outlets, as levels, for a monitor snapshot.
///
/// `trig` is always 0: it is an edge, not a level, and the host raises it for
/// `MIDI_TRIG_SECONDS` when the monitor reports a press. Returning a level
/// would make a held key look like a continuous retrigger.
///
/// With no snapshot (no device bound, nothing played yet) the outlets read as
/// a released keyboard rather than as zero, so an unplayed MIDI In is silent
/// and in tune instead of silent at note 0.
public func midiInOutlets(_ snapshot: MidiInputSnapshot?) -> [String: Double] {
    [
        "cv": snapshot?.cv ?? 0,
        "gate": snapshot?.gate ?? 0,
        "trig": 0,
        "velocity": snapshot?.velocity ?? 0,
        "note": Double(snapshot?.note ?? 60),
        "cc": snapshot?.cc ?? 0,
    ]
}

/// One MIDI Out tick, gathered from whatever the host has cabled into it.
///
/// The rule that must not diverge: **`gate` and `trig` are edges and
/// everything else is a value.** A gate read as a mean would open at 0.5 and a
/// note read as a gate would collapse 127 pitches into on and off.
///
/// An uncabled inlet is never read, because "no cable" and "a cable sitting at
/// zero" are different: an unpatched gate means the trig owns note length, and
/// a patched gate at zero means the voice is off. A cabled inlet whose source
/// has produced no reading yet keeps the default, so a patch cabled to a
/// source that has not started sounds like an unpatched one rather than a
/// broken one.
public func midiOutSample(
    _ cables: MidiOutputCables,
    _ read: (String) -> MidiInletReading?
) -> MidiOutputSample {
    var sample = emptyMidiSample()
    let patched: [(String, Bool)] = [
        ("note", cables.note), ("cv", cables.cv), ("gate", cables.gate),
        ("trig", cables.trig), ("velocity", cables.velocity), ("cc", cables.cc),
    ]
    for (inlet, cabled) in patched {
        guard cabled, let jack = read(inlet) else { continue }
        let gate = jack.mean > 0.5 || jack.peak > 0.5 || jack.pulse ? 1.0 : 0.0
        switch inlet {
        case "note": sample.note = jack.mean
        case "cv": sample.cv = jack.mean
        case "gate": sample.gate = gate
        case "trig": sample.trig = gate
        case "velocity": sample.velocity = jack.mean
        default: sample.cc = jack.mean
        }
    }
    return sample
}
