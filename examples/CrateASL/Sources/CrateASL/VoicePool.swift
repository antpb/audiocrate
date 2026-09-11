import Foundation

public enum VoiceStealingPolicy {
    case oldest
    case quietest
}

/// What allocation knows about one slot. Mirrors `voices/allocate.ts`.
public struct VoiceSnapshot {
    public var index: Int
    /// The note sounding or releasing here, or nil for an idle slot.
    public var note: Int?
    public var velocity: Double
    public var startedAt: Int
    /// Whether the key is still down. A released note keeps its slot until
    /// the tail is gone or something steals it.
    public var held: Bool
}

/// Pick a slot for `note`: same-pitch retrigger first, then idle, then the
/// oldest releasing tail, then steal a held voice per policy.
///
/// Ported from `allocate.ts` rule for rule, because the order is the whole
/// design. Retrigger first means a repeated note reuses its own voice instead
/// of stacking; idle before releasing means a tail is only cut when there is
/// nothing free; releasing before held means a key still down is the last
/// thing taken.
public func allocateSlot(_ slots: [VoiceSnapshot], note: Int, policy: VoiceStealingPolicy) -> Int {
    precondition(!slots.isEmpty, "allocateSlot: polyphony is 0")

    if let retrigger = slots.first(where: { $0.held && $0.note == note }) { return retrigger.index }
    if let idle = slots.first(where: { $0.note == nil }) { return idle.index }

    let releasing = slots.filter { $0.note != nil && !$0.held }
    if !releasing.isEmpty { return oldest(releasing).index }

    let held = slots.filter(\.held)
    precondition(!held.isEmpty, "allocateSlot: no stealable voice")
    switch policy {
    case .quietest:
        return held.reduce(held[0]) { a, b in
            if a.velocity != b.velocity { return a.velocity < b.velocity ? a : b }
            return a.startedAt <= b.startedAt ? a : b
        }.index
    case .oldest:
        return oldest(held).index
    }
}

private func oldest(_ slots: [VoiceSnapshot]) -> VoiceSnapshot {
    slots.reduce(slots[0]) { $0.startedAt <= $1.startedAt ? $0 : $1 }
}

/// One pool of voices over one compiled graph.
///
/// The JavaScript `VoicePool` drives backends that are separate worklets, so
/// a voice that has gone quiet costs the audio thread nothing whether the
/// pool knows about it or not. Here every voice is interpreted in the same
/// render call, so an unnoticed dead tail is eight graphs' worth of
/// arithmetic per block for silence. That is the one thing this adds:
/// `retireSilentVoices`, below.
public final class VoicePool {
    public let voice: CompiledVoice
    public let policy: VoiceStealingPolicy

    private var slots: [VoiceSnapshot]
    private var states: [VoiceState]
    private var clock = 0

    /// Per-slot count of consecutive blocks whose peak stayed under the
    /// silence floor. Reset by anything audible.
    private var quietBlocks: [Int]

    /// Below this, a released voice is finished. -100 dBFS is far under
    /// anything a converter can express and well under an envelope's own
    /// floor, so retiring here cannot cut a tail anybody could hear.
    public var silenceFloor: Float = 1e-5
    /// How many consecutive quiet blocks before a released voice is retired.
    /// A few, so a waveform's zero crossing is never mistaken for the end.
    public var quietBlocksToRetire = 4

    /// Scratch the voices are summed through. Sized on the first render and
    /// never reallocated, because this runs on the audio thread.
    private var mixL: [Float] = []
    private var mixR: [Float] = []

    public init(voice: CompiledVoice, polyphony: Int, policy: VoiceStealingPolicy = .oldest) {
        precondition(polyphony > 0, "VoicePool: polyphony must be at least 1")
        self.voice = voice
        self.policy = policy
        self.states = (0..<polyphony).map { _ in voice.makeState() }
        self.slots = (0..<polyphony).map {
            VoiceSnapshot(index: $0, note: nil, velocity: 0, startedAt: 0, held: false)
        }
        self.quietBlocks = Array(repeating: 0, count: polyphony)
    }

    public var polyphony: Int { slots.count }

    /// Slots currently sounding or releasing.
    public var activeVoiceCount: Int { slots.reduce(0) { $0 + ($1.note == nil ? 0 : 1) } }

    public var snapshots: [VoiceSnapshot] { slots }

    /// Seeds every voice with the graph's parameter defaults.
    public func setParams(_ values: [String: Double]) {
        for state in states { state.setParams(values) }
    }

    /// A parameter change applies to every voice, sounding or not, so a note
    /// struck after the knob moved starts where the knob is.
    public func setParam(_ name: String, _ value: Double) {
        for state in states { state.setParam(name, value) }
    }

    public func rampParam(_ name: String, to value: Double, frames: Int) {
        for state in states { state.rampParam(name, to: value, frames: frames) }
    }

    public func noteOn(note: Int, velocity: Double) {
        let index = allocateSlot(slots, note: note, policy: policy)
        let state = states[index]

        // Stealing is a note off then a note on on the same voice, which is
        // what gives the envelope a chance to restart from where it was
        // rather than clicking from wherever the last note left the level.
        if slots[index].note != nil { state.gate = false }

        clock += 1
        slots[index].note = note
        slots[index].velocity = velocity
        slots[index].held = true
        slots[index].startedAt = clock
        quietBlocks[index] = 0

        state.setParam("note", Double(note))
        state.setParam("velocity", velocity)
        state.gate = true
    }

    public func noteOff(note: Int) {
        for index in slots.indices where slots[index].held && slots[index].note == note {
            slots[index].held = false
            states[index].gate = false
            return
        }
    }

    public func allNotesOff() {
        for index in slots.indices where slots[index].note != nil {
            slots[index].held = false
            slots[index].note = nil
            slots[index].velocity = 0
            states[index].gate = false
            quietBlocks[index] = 0
        }
    }

    /// Renders every active voice and sums them.
    ///
    /// Idle slots are skipped entirely, which is the point of tracking them:
    /// a pool of eight playing one note should cost one voice, not eight.
    @discardableResult
    public func render(
        sampleRate: Double,
        frames: Int,
        outL: UnsafeMutablePointer<Float>,
        outR: UnsafeMutablePointer<Float>?,
        transport: TransportSnapshot? = nil
    ) -> Int {
        if mixL.count < frames {
            mixL = [Float](repeating: 0, count: frames)
            mixR = [Float](repeating: 0, count: frames)
        }
        outL.update(repeating: 0, count: frames)
        outR?.update(repeating: 0, count: frames)

        var rendered = 0
        for index in slots.indices where slots[index].note != nil {
            rendered += 1
            let state = states[index]
            var peak: Float = 0

            mixL.withUnsafeMutableBufferPointer { left in
                mixR.withUnsafeMutableBufferPointer { right in
                    let wroteRight = voice.render(
                        state, sampleRate: sampleRate, frames: frames,
                        outL: left.baseAddress!, outR: outR != nil ? right.baseAddress! : nil,
                        transport: transport
                    )
                    for i in 0..<frames {
                        let value = left[i]
                        outL[i] += value
                        let magnitude = value < 0 ? -value : value
                        if magnitude > peak { peak = magnitude }
                    }
                    if let outR {
                        // A mono graph reports it did not fill the right
                        // channel, and mirroring is the caller's job. Here
                        // the caller is this loop.
                        for i in 0..<frames { outR[i] += wroteRight ? right[i] : left[i] }
                    }
                }
            }

            retire(index, peak: peak)
        }
        return rendered
    }

    /// A released voice whose tail has fallen under the floor stops being
    /// rendered. Held voices are never retired however quiet they are: a
    /// finger is still down, and an envelope at zero sustain is silent and
    /// very much alive.
    private func retire(_ index: Int, peak: Float) {
        guard !slots[index].held else {
            quietBlocks[index] = 0
            return
        }
        if peak > silenceFloor {
            quietBlocks[index] = 0
            return
        }
        quietBlocks[index] += 1
        if quietBlocks[index] >= quietBlocksToRetire {
            slots[index].note = nil
            slots[index].velocity = 0
            quietBlocks[index] = 0
        }
    }
}
