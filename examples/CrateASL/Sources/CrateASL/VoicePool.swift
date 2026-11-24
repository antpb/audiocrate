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

    // MARK: Split instrument (`voicing` in flattenPatch)
    //
    // A patch whose effects run once on the sum of the voices compiles to a
    // voice graph with sends and a bus graph (`CompiledVoice.bus`). Each
    // voice renders only its sends; they are summed per send here, and the
    // bus runs once on the sums. A pool of eight playing a chord through a
    // reverb costs one reverb, not eight, and a limiter limits the chord.
    private let busState: VoiceState?
    /// Per voice, per send: where one voice writes its sends this block.
    private var voiceSendL: [UnsafeMutablePointer<Float>] = []
    private var voiceSendR: [UnsafeMutablePointer<Float>] = []
    /// Per send: the sum over every voice, which the bus reads as a port.
    private var sumSendL: [UnsafeMutablePointer<Float>] = []
    private var sumSendR: [UnsafeMutablePointer<Float>] = []
    private var sendFrames = 0
    /// The bus's port index for each send, in send order.
    private let busSendPorts: [Int]
    /// Consecutive blocks the bus has rendered silence with nothing feeding
    /// it. Past `quietBlocksToRetire` it stops rendering until a voice sounds,
    /// the way an idle voice is skipped: a reverb tail under -100 dBFS is not
    /// worth a reverb's arithmetic per block.
    private var busQuietBlocks = 0

    /// `seed` makes the pool reproducible: voice `i` is seeded `seed + i`, as
    /// `AudioMaterial.bind` does, so the voices stay independent of each other
    /// and identical across runs. Omitted, each voice gets a random seed, so
    /// a chord of noisy voices is not one noise in lockstep.
    public init(
        voice: CompiledVoice,
        polyphony: Int,
        policy: VoiceStealingPolicy = .oldest,
        seed: UInt32? = nil
    ) {
        precondition(polyphony > 0, "VoicePool: polyphony must be at least 1")
        self.voice = voice
        self.policy = policy
        self.states = (0..<polyphony).map { index in
            voice.makeState(seed: seed.map { $0 &+ UInt32(index) } ?? UInt32.random(in: .min ... .max), withBus: false)
        }
        self.slots = (0..<polyphony).map {
            VoiceSnapshot(index: $0, note: nil, velocity: 0, startedAt: 0, held: false)
        }
        self.quietBlocks = Array(repeating: 0, count: polyphony)
        self.polyphony = polyphony
        if let bus = voice.bus {
            // Seeded like voice 0, as a one-voice host seeds the bus it carries.
            let state = bus.makeState(seed: seed ?? UInt32.random(in: .min ... .max))
            // An effect on the voices' sum: its gate opens once and stays open.
            state.gate = true
            self.busState = state
            self.busSendPorts = (0..<voice.sendCount).map { bus.portIndex(of: "send\($0)") }
        } else {
            self.busState = nil
            self.busSendPorts = []
        }
    }

    deinit {
        for buffer in voiceSendL + voiceSendR + sumSendL + sumSendR { buffer.deallocate() }
    }

    /// Sized on the first render and only grown, never on the steady path.
    private func ensureSendBuffers(frames: Int) {
        guard frames > sendFrames else { return }
        for buffer in voiceSendL + voiceSendR + sumSendL + sumSendR { buffer.deallocate() }
        let count = voice.sendCount
        func make() -> [UnsafeMutablePointer<Float>] {
            (0..<count).map { _ in
                let buffer = UnsafeMutablePointer<Float>.allocate(capacity: frames)
                buffer.initialize(repeating: 0, count: frames)
                return buffer
            }
        }
        voiceSendL = make()
        voiceSendR = make()
        sumSendL = make()
        sumSendR = make()
        sendFrames = frames
    }

    /// Stored rather than read off `slots`, because an editor asks for it
    /// from the main thread while the render thread is writing `slots`.
    public let polyphony: Int

    /// Slots currently sounding or releasing.
    public var activeVoiceCount: Int { slots.reduce(0) { $0 + ($1.note == nil ? 0 : 1) } }

    public var snapshots: [VoiceSnapshot] { slots }

    /// Seeds every voice with the graph's parameter defaults.
    public func setParams(_ values: [String: Double]) {
        for state in states { state.setParams(values) }
        busState?.setParams(values)
    }

    /// A parameter change applies to every voice, sounding or not, so a note
    /// struck after the knob moved starts where the knob is.
    public func setParam(_ name: String, _ value: Double) {
        for state in states { state.setParam(name, value) }
        busState?.setParam(name, value)
    }

    /// A host's change, gliding a continuous parameter there
    /// (`CompiledVoice.setParam`). **Render thread only**: a glide writes a
    /// ramp the render reads and commits, so starting one from another thread
    /// is a torn write. `setParam` stays a plain store for callers elsewhere.
    public func glideParam(_ name: String, _ value: Double) {
        for state in states { voice.setParam(state, name, value) }
        if let bus = voice.bus, let busState { bus.setParam(busState, name, value) }
    }

    public func rampParam(_ name: String, to value: Double, frames: Int) {
        for state in states { state.rampParam(name, to: value, frames: frames) }
        busState?.rampParam(name, to: value, frames: frames)
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

        if let bus = voice.bus, let busState {
            return renderSplit(bus, busState, sampleRate: sampleRate, frames: frames, outL: outL, outR: outR, transport: transport)
        }

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

    /// `render` for a split instrument: voices into summed sends, then the
    /// bus once on the sums.
    private func renderSplit(
        _ bus: CompiledVoice,
        _ busState: VoiceState,
        sampleRate: Double,
        frames: Int,
        outL: UnsafeMutablePointer<Float>,
        outR: UnsafeMutablePointer<Float>?,
        transport: TransportSnapshot?
    ) -> Int {
        ensureSendBuffers(frames: frames)
        let count = voice.sendCount
        for k in 0..<count {
            sumSendL[k].update(repeating: 0, count: frames)
            sumSendR[k].update(repeating: 0, count: frames)
        }

        var rendered = 0
        var anyRight = false
        voiceSendL.withUnsafeBufferPointer { sendsL in
            voiceSendR.withUnsafeBufferPointer { sendsR in
                mixL.withUnsafeMutableBufferPointer { mix in
                    for index in slots.indices where slots[index].note != nil {
                        rendered += 1
                        let wroteRight = voice.render(
                            states[index], sampleRate: sampleRate, frames: frames,
                            outL: mix.baseAddress!, outR: nil,
                            transport: transport,
                            sendsL: sendsL.baseAddress!, sendsR: sendsR.baseAddress!
                        )
                        if wroteRight { anyRight = true }
                        for k in 0..<count {
                            let l = sendsL[k], r = sendsR[k], sumL = sumSendL[k], sumR = sumSendR[k]
                            for i in 0..<frames {
                                sumL[i] += l[i]
                                sumR[i] += wroteRight ? r[i] : l[i]
                            }
                        }
                        // A voice is retired on its own signal, before the
                        // bus: its share of a reverb tail is the bus's now.
                        var peak: Float = 0
                        for i in 0..<frames {
                            let value = mix[i]
                            let magnitude = value < 0 ? -value : value
                            if magnitude > peak { peak = magnitude }
                        }
                        retire(index, peak: peak)
                    }
                }
            }
        }

        if rendered == 0 && busQuietBlocks >= quietBlocksToRetire { return 0 }

        for k in 0..<count where busSendPorts[k] >= 0 {
            busState.portL[busSendPorts[k]] = UnsafePointer(sumSendL[k])
            // Left only when no voice wrote a right channel, so a mono pool
            // lets a mirrorable bus run once and copy.
            busState.portR[busSendPorts[k]] = anyRight ? UnsafePointer(sumSendR[k]) : nil
        }
        let busRight = bus.render(busState, sampleRate: sampleRate, frames: frames, outL: outL, outR: outR, transport: transport)
        if let outR, !busRight { outR.update(from: outL, count: frames) }

        var busPeak: Float = 0
        for i in 0..<frames {
            let magnitude = outL[i] < 0 ? -outL[i] : outL[i]
            if magnitude > busPeak { busPeak = magnitude }
        }
        busQuietBlocks = rendered == 0 && busPeak <= silenceFloor ? busQuietBlocks + 1 : 0
        return rendered
    }
}

// MARK: - Probes (Probes.swift)

extension VoicePool {
    /// Every voice's probes: per module, the loudest of the voices playing
    /// now. Render thread only, after `render`; allocates nothing.
    public func sampleProbes(
        _ table: ProbeTable,
        master: Float,
        line: Float,
        into out: UnsafeMutablePointer<Float>
    ) {
        table.fillHost(master: master, line: line, into: out)
        var held = 0
        for index in slots.indices where slots[index].note != nil && slots[index].held { held += 1 }
        let notes = held == 0 ? 0 : min(1, 0.5 + Float(held) / Float(max(polyphony, 1)))
        let busLive = busState != nil && busQuietBlocks < quietBlocksToRetire
        for index in 0..<table.count {
            switch table.kinds[index] {
            case CrateProbeLayout.Kind.module.rawValue:
                let slot = table.slots[index]
                if table.onBus[index] {
                    out[index] = busLive ? (busState?.probeMagnitude(slot) ?? 0) : 0
                    continue
                }
                var loudest: Float = 0
                // Only the voices this block rendered: a retired voice keeps
                // its last values and its own generation, so the stamp alone
                // would call a silent voice current.
                for voice in slots.indices where slots[voice].note != nil {
                    let value = states[voice].probeMagnitude(slot)
                    if value > loudest { loudest = value }
                }
                out[index] = loudest
            case CrateProbeLayout.Kind.notes.rawValue:
                out[index] = notes
            default:
                break
            }
        }
    }
}
