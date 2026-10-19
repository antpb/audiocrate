import Foundation

enum EnvStage {
    case idle, delay, attack, hold, decay, sustain, release
}

struct Grain {
    var pos: Double
    var i: Double
    var n: Double
    var rate: Double
}

/// Persistent state for one node on one channel.
///
/// The JavaScript interpreter stores a different object shape per node kind.
/// This is one class holding the union of those fields, which trades a little
/// memory (about a kilobyte per node per channel) for never allocating, never
/// branching on a type, and never boxing on the audio thread. Each evaluator
/// below documents which fields it uses; where two kinds want the same idea
/// they share the field, and where they do not the names are generic on
/// purpose (`k0`, `c0`) rather than pretending to a meaning they do not have.
///
/// The `k` fields are cache keys and start at NaN, which compares unequal to
/// everything including itself, so the first sample always computes.
/// A struct, not a class, and held in raw memory by `VoiceState`.
///
/// Every filter writes four of these fields per sample and every envelope
/// several more. As class properties each of those writes carried a dynamic
/// exclusivity check, which a profile showed costing more than the
/// arithmetic. In raw memory they are plain stores.
struct NodeMemory {
    // Oscillators, LFOs, clocks, sample-and-hold, wavetables.
    var phase = 0.0

    // Biquad delay line, and the coefficients it is currently running.
    var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
    var n0 = 0.0, n1 = 0.0, n2 = 0.0, d1 = 0.0, d2 = 0.0

    // Generic cache keys and derived coefficients. Meaning is per kind.
    var k0 = Double.nan, k1 = Double.nan, k2 = Double.nan, k3 = Double.nan
    var c0 = 0.0, c1 = 0.0

    // Envelopes.
    var stage = EnvStage.idle
    var level = 0.0, peak = 0.0, stageElapsed = 0.0, stageStartLevel = 0.0
    var lastGate = false

    // Followers: an envelope plus a cached coefficient per direction.
    var env = 0.0
    var ka = Double.nan, ca = 0.0, kr = Double.nan, cr = 0.0

    // Edge detection and holds. `prevReset` is separate from `prev` because
    // the nodes that take a reset are already watching their clock inlet with
    // `prev`, and one variable cannot hold two edges.
    var prev = 0.0, prevReset = 0.0, held = 0.0, count = 0.0, index = -1.0, on = 0.0
    var prevGate = false, armed = false, playing = false

    // Multi-state filters: one-pole cascades, SVF, ladder.
    var s0 = 0.0, s1 = 0.0, s2 = 0.0, s3 = 0.0

    // Clock multiply.
    var since = 0.0, interval = 0.0, nextAt = 0.0, left = 0.0

    // Ring buffers: delay, comb, reverse, looper, RMS, pitch shift.
    //
    // Float, not Double, because the reference implementation's lines are
    // `Float32Array`. Keeping more precision here than the thing being
    // matched is not a better filter, it is a different one: a delay line
    // quantises what it stores, and that quantisation is part of the sound.
    var buf = [Float]()
    var writeIdx = 0, readIdx = 0, length = 0
    var sum = 0.0, filled = 0.0

    // Euclidean pattern, cached against the settings behind it.
    var pattern = [Bool]()

    // Granular playback.
    var grains = [Grain]()
    var pos = 0.0

    /// Whether the first sample has run. A few nodes seed their state from
    /// their own first input rather than from zero (slew starts where the
    /// signal is, a clock starts ready to fire), which in JavaScript is the
    /// lazily-run initialiser closure and here has to be explicit.
    var initialized = false

    /// A `noise` or `random` node's stream (Rng.swift), seeded on first use.
    var rng: UInt32 = 0
}

/// What a `tap.meter` reports for the interval since it was last read.
public struct MeterReading: Sendable {
    public var peak: Double
    public var rms: Double
}

final class MeterAccumulator {
    var peak = 0.0
    var sumSq = 0.0
    var count = 0.0
}

final class CaptureBuffer {
    var samples: [Float]
    var write = 0
    var filled = false
    init(windowSize: Int) { samples = [Float](repeating: 0, count: max(1, windowSize)) }
}

/// One drained frame of everything a graph's taps recorded.
public struct AnalysisFrame: Sendable {
    public var meters: [String: MeterReading]
    public var captures: [String: [Float]]
}

/// Everything one running voice remembers.
///
/// The value cache has no clearing step. Each slot carries the generation it
/// was written in, and starting a new sample, a new channel or a new seam
/// pass is one increment of `generation`. Clearing a cache about to be
/// completely overwritten, 48,000 times a second, was the largest single cost
/// in the JavaScript interpreter before the same change was made there.
public final class VoiceState {
    // Raw buffers rather than Swift arrays.
    //
    // These are read and written once per node per sample. A Swift `Array`
    // subscript is a bounds check and a uniqueness check on every one of
    // those, and at 48 kHz across a thirty-node graph that is the largest
    // single cost in the interpreter, measured at roughly four fifths of it.
    // The indices are plan slots, produced by the compiler and bounded by
    // `slotCount` by construction, so the check is guarding an invariant that
    // is already held rather than untrusted input.
    let values: UnsafeMutablePointer<Double>
    let stamps: UnsafeMutablePointer<Double>
    let slotCount: Int

    /// The handful of scalars the evaluator touches on every node of every
    /// sample, held in raw memory rather than as stored properties.
    ///
    /// A `var` on a class gets a dynamic exclusivity check (`swift_beginAccess`)
    /// wherever the compiler cannot prove the access is unique, and a
    /// profile of a four-voice render showed those checks dominating the
    /// whole interpreter: turning them off took one voice from 28x realtime
    /// to 84x. Behind a `let` pointer they are plain loads and stores, so the
    /// checks disappear without disabling them process-wide for code that
    /// genuinely wants them.
    private let hot: UnsafeMutablePointer<HotState>

    struct HotState {
        var generation: Double = 1
        var frameIndex: Int = 0
        var lane: Int = 0
        var gate: Bool = false
    }

    @inline(__always) var generation: Double {
        get { hot.pointee.generation }
        set { hot.pointee.generation = newValue }
    }

    /// Per-node state for channel 0. Channels past the first get their own
    /// array: a biquad running on the right channel is a second filter, not
    /// the same one fed twice.
    ///
    /// Unretained pointers for the same reason `PlanNode.inputs` is: this is
    /// looked up once per stateful node per sample. `memoryOwner` holds the
    /// strong references, so nothing is freed while a render is reading it.
    var memory: UnsafeMutablePointer<UnsafeMutablePointer<NodeMemory>?>
    var laneMemory: [UnsafeMutablePointer<UnsafeMutablePointer<NodeMemory>?>] = []
    /// Everything allocated above, so `deinit` can take it all down. A node's
    /// memory is created the first time that node runs and lives as long as
    /// the voice.
    private var allocated: [UnsafeMutablePointer<NodeMemory>] = []

    /// Parameter values by name.
    ///
    /// The host-facing view, and what a `KernelProcessor` is handed. Written
    /// only through `setParam` / `rampParam`, because the render path reads
    /// the dense array below and the two must not drift.
    public private(set) var params: [String: Double] = [:]

    @inline(__always) public var gate: Bool {
        get { hot.pointee.gate }
        set { hot.pointee.gate = newValue }
    }

    // MARK: Parameters, on the render path
    //
    // A `param` node reads its value once per sample. Looking that up by name
    // means hashing a string 48,000 times a second on the audio thread, so the
    // plan resolves every name to an index and these arrays are addressed by
    // it.
    //
    // A ramp is a **pure function of the frame index**, not a value stepped
    // as the block advances. That is the same discipline transport nodes
    // follow, and it is not a stylistic choice: a graph with a seam kernel in
    // it walks the tree twice over the same block (collect, then apply), and
    // anything that advanced as it went would land on different values in the
    // two passes. Stated as `base + step * frame`, both passes agree.
    var paramIndex: [String: Int] = [:]
    let paramValues: UnsafeMutablePointer<Double>
    let rampStep: UnsafeMutablePointer<Double>
    /// Where each ramp ends, so a finished ramp lands on its target exactly
    /// rather than on `base + step * frames`, which can miss by a rounding.
    let rampTarget: UnsafeMutablePointer<Double>
    let rampFrames: UnsafeMutablePointer<Int>
    let paramCount: Int
    /// Whether any parameter is mid-ramp, so the common case costs one check.
    var hasRamps = false

    @inline(__always) var frameIndex: Int {
        get { hot.pointee.frameIndex }
        set { hot.pointee.frameIndex = newValue }
    }
    @inline(__always) var lane: Int {
        get { hot.pointee.lane }
        set { hot.pointee.lane = newValue }
    }
    var transport: TransportSnapshot?

    /// The rate of the last render, 0 before the first. A glide's length is
    /// in seconds; before a voice has rendered there is nothing to glide from,
    /// so `CompiledVoice.setParam` lands at once. `renderedRate` in compile.ts.
    public internal(set) var renderedRate: Double = 0

    /// Where this voice's `noise` and `random` streams start. Two states with
    /// one seed render the same samples. Set before the first render.
    public var seed: UInt32 = defaultVoiceSeed

    /// Live audio for the block being rendered, one entry per port the graph
    /// reads, in `Plan.ports` order. Raw pointers, not arrays: an AUv3 render
    /// block is handed an `AudioBufferList` and has to do its work without
    /// allocating, retaining, or hashing anything. A port with nothing wired
    /// is nil and reads as the scalar of the same name, which is what makes
    /// the per-sample path work.
    var portL: [UnsafePointer<Float>?]
    var portR: [UnsafePointer<Float>?]
    /// Names in the same order, for `setParam` to find a port by name. Never
    /// read on the per-sample path.
    var portNames: [String] = []
    /// What each port reads when no block is wired, in the same order.
    ///
    /// Dense and pointer-addressed rather than a lookup in `params`. Both
    /// ends of this are per-sample: the insert path writes one for every
    /// frame it renders, and a VoicePool, which never wires a port at all,
    /// reads one for every frame of every voice. A dictionary there is a
    /// string hashed at the sample rate, and worse, it is a structure the
    /// host's thread reshapes underneath the render thread whenever a
    /// parameter is set from a view.
    let portScalars: UnsafeMutablePointer<Double>
    /// Port name to index, built once, so `setParam` can keep a port's scalar
    /// in step with the dictionary without hashing on the render thread.
    private var portIndexByName: [String: Int] = [:]

    /// Bound block-rate DSP, by kernel slot. Empty is a clean passthrough.
    public var kernels: [String: KernelProcessor] = [:]

    /// Live tap state, one slot per id in `Plan.tapIds`, built with the voice.
    ///
    /// Dense and pre-built rather than a dictionary filled on first use. Both
    /// halves of that were wrong on an audio thread: finding a tap by id
    /// hashed a string once per sample per tap, and the first sample through
    /// a new tap allocated. It was also a structure the render thread grew
    /// while `drainAnalysis` walked it from whatever thread wanted a meter
    /// reading, which is the same shape as the port-scalar crash.
    var tapMeters: [MeterAccumulator] = []
    var tapCaptures: [CaptureBuffer?] = []
    /// Ids in the same order, for `drainAnalysis` to name what it read.
    var tapIds: [String] = []

    init(
        slotCount: Int,
        portNames: [String],
        paramNames: [String],
        tapIds: [String] = [],
        tapWindows: [Int] = []
    ) {
        hot = .allocate(capacity: 1)
        hot.initialize(to: HotState())
        self.slotCount = slotCount
        self.paramCount = paramNames.count
        values = .allocate(capacity: max(1, slotCount))
        stamps = .allocate(capacity: max(1, slotCount))
        values.initialize(repeating: 0, count: max(1, slotCount))
        stamps.initialize(repeating: 0, count: max(1, slotCount))
        paramValues = .allocate(capacity: max(1, paramNames.count))
        rampStep = .allocate(capacity: max(1, paramNames.count))
        rampTarget = .allocate(capacity: max(1, paramNames.count))
        rampTarget.initialize(repeating: 0, count: max(1, paramNames.count))
        rampFrames = .allocate(capacity: max(1, paramNames.count))
        paramValues.initialize(repeating: 0, count: max(1, paramNames.count))
        rampStep.initialize(repeating: 0, count: max(1, paramNames.count))
        rampFrames.initialize(repeating: 0, count: max(1, paramNames.count))
        memory = .allocate(capacity: max(1, slotCount))
        memory.initialize(repeating: nil, count: max(1, slotCount))
        self.portNames = portNames
        portL = Array(repeating: nil, count: portNames.count)
        portR = Array(repeating: nil, count: portNames.count)
        portScalars = .allocate(capacity: max(1, portNames.count))
        portScalars.initialize(repeating: 0, count: max(1, portNames.count))
        for (index, name) in paramNames.enumerated() { paramIndex[name] = index }
        for (index, name) in portNames.enumerated() { portIndexByName[name] = index }
        self.tapIds = tapIds
        tapMeters = tapIds.map { _ in MeterAccumulator() }
        tapCaptures = tapIds.indices.map { index in
            let window = index < tapWindows.count ? tapWindows[index] : 0
            return window > 0 ? CaptureBuffer(windowSize: window) : nil
        }
    }

    deinit {
        hot.deallocate()
        // Deinitialised, not just freed: a NodeMemory holds Swift arrays for
        // its delay lines, and releasing those is what `deinitialize` does.
        for pointer in allocated {
            pointer.deinitialize(count: 1)
            pointer.deallocate()
        }
        memory.deallocate()
        for lane in laneMemory { lane.deallocate() }
        portScalars.deallocate()
        values.deallocate()
        stamps.deallocate()
        paramValues.deallocate()
        rampStep.deallocate()
        rampTarget.deallocate()
        rampFrames.deallocate()
    }

    /// The summed half of a split instrument, when this voice renders it
    /// itself (`CompiledVoice.render` with no sends). Every parameter written
    /// here is written there too. Nil for every other graph, and for a
    /// `VoicePool`'s voices, which share one bus between them.
    var splitBus: SplitBusRuntime?

    /// Sets a parameter immediately, cancelling any ramp on it.
    public func setParam(_ name: String, _ value: Double) {
        splitBus?.state.setParam(name, value)
        params[name] = value
        // A graph written against the old scalar `input` sets a "parameter"
        // that is really a port. That used to work because both went into the
        // same dictionary; now the port keeps its own slot and this is what
        // holds the two together.
        if let port = portIndexByName[name] { portScalars[port] = value }
        guard let index = paramIndex[name] else { return }
        paramValues[index] = value
        rampStep[index] = 0
        rampFrames[index] = 0
    }

    public func setParams(_ values: [String: Double]) {
        for (name, value) in values { setParam(name, value) }
    }

    /// Writes one port's scalar for the frame about to be rendered.
    ///
    /// The insert path calls this per sample, so it does exactly one store.
    /// It deliberately does not touch `params`: that dictionary is shared
    /// with whichever thread sets parameters, and writing it at the sample
    /// rate from the render thread is how a slider drag and a held note
    /// managed to corrupt it between them.
    @inline(__always) func setPortScalar(_ index: Int, _ value: Double) {
        guard index >= 0, index < max(1, portNames.count) else { return }
        portScalars[index] = value
    }

    /// Ramps a parameter to `value` over `frames`, starting at frame 0 of the
    /// next render.
    ///
    /// An AU host sends automation as a value plus a ramp duration, and a
    /// host that splits its block at each event (which is the point of doing
    /// this at all) starts every ramp at the top of a sub-block. So there is
    /// no start offset here: the offset is which sub-block you call it before.
    public func rampParam(_ name: String, to value: Double, frames: Int) {
        guard frames > 0, let index = paramIndex[name] else {
            setParam(name, value)
            return
        }
        splitBus?.state.rampParam(name, to: value, frames: frames)
        params[name] = value
        rampStep[index] = (value - paramValues[index]) / Double(frames)
        rampTarget[index] = value
        rampFrames[index] = frames
        hasRamps = true
    }

    /// The value a `param` node sees at `frame`. Pure in the frame, so the
    /// two passes of a seam graph agree.
    @inline(__always) func paramValue(_ index: Int, frame: Int) -> Double {
        let remaining = rampFrames[index]
        if remaining == 0 { return paramValues[index] }
        return paramValues[index] + rampStep[index] * Double(min(frame, remaining))
    }

    /// Whether `name` is a declared parameter this state has been given a
    /// value for, and that value. `CompiledVoice.setParam` glides only from a
    /// value that exists, as compile.ts does.
    func committedParam(_ name: String) -> (index: Int, value: Double)? {
        guard params[name] != nil, let index = paramIndex[name] else { return nil }
        return (index, paramValues[index])
    }

    /// Advances every ramp by the frames just rendered, and lands exactly on
    /// the target rather than on an accumulation of steps.
    func commitRamps(framesRendered: Int) {
        guard hasRamps else { return }
        var stillRamping = false
        for index in 0..<paramCount {
            let remaining = rampFrames[index]
            if remaining == 0 { continue }
            if framesRendered >= remaining {
                paramValues[index] = rampTarget[index]
                rampStep[index] = 0
                rampFrames[index] = 0
            } else {
                paramValues[index] += rampStep[index] * Double(framesRendered)
                rampFrames[index] = remaining - framesRendered
                stillRamping = true
            }
        }
        hasRamps = stillRamping
    }

    /// Wires an auxiliary port for the coming block. The pointer has to stay
    /// valid for the whole of `render`, and is cleared when it returns.
    public func setPort(_ index: Int, left: UnsafePointer<Float>?, right: UnsafePointer<Float>? = nil) {
        guard index >= 0 && index < portL.count else { return }
        portL[index] = left
        portR[index] = right
    }

    /// The memory for `slot` on the channel being rendered, created on first
    /// use so a graph only pays for the nodes it actually reaches.
    @inline(__always) func memory(for slot: Int) -> UnsafeMutablePointer<NodeMemory> {
        let store: UnsafeMutablePointer<UnsafeMutablePointer<NodeMemory>?>
        if lane == 0 {
            store = memory
        } else {
            while laneMemory.count < lane {
                let extra = UnsafeMutablePointer<UnsafeMutablePointer<NodeMemory>?>
                    .allocate(capacity: max(1, slotCount))
                extra.initialize(repeating: nil, count: max(1, slotCount))
                laneMemory.append(extra)
            }
            store = laneMemory[lane - 1]
        }
        if let existing = store[slot] { return existing }
        let fresh = UnsafeMutablePointer<NodeMemory>.allocate(capacity: 1)
        fresh.initialize(to: NodeMemory())
        allocated.append(fresh)
        store[slot] = fresh
        return fresh
    }
}

/// The host's musical position at the start of a block. Transport nodes derive
/// their sample-accurate position from this plus the frame index, which makes
/// them pure functions of the frame and is why they need no memory at all.
public struct TransportSnapshot: Sendable {
    public var beats: Double
    public var bpm: Double
    public var playing: Bool
    public var beatsPerBar: Double
    public var beatUnit: Double

    public init(
        beats: Double = 0,
        bpm: Double = 120,
        playing: Bool = false,
        beatsPerBar: Double = 4,
        beatUnit: Double = 4
    ) {
        self.beats = beats
        self.bpm = bpm
        self.playing = playing
        self.beatsPerBar = beatsPerBar
        self.beatUnit = beatUnit
    }

    /// This snapshot, moved forward by `offset` samples.
    ///
    /// A host that splits a block at render events calls the interpreter more
    /// than once per block, and `evalTransport` derives its position as
    /// `beats + frameIndex * perSample` with `frameIndex` restarting at 0 on
    /// every call. Without this, a segment starting partway through a block
    /// replays that much musical time, so a note landing mid-block reads a
    /// beat position slightly in the past. Inaudible over one block and a
    /// drifting sequencer over a bar.
    ///
    /// It lives here rather than in the host because it is the same formula
    /// `evalTransport` uses, and the two have to move together. A stopped
    /// transport holds its position, so it advances by nothing.
    public func advanced(bySamples offset: Int, sampleRate: Double) -> TransportSnapshot {
        guard offset > 0, playing, sampleRate > 0 else { return self }
        var moved = self
        moved.beats += Double(offset) * bpm / 60 / sampleRate
        return moved
    }
}

/// Turns the position a host reports once per block into one that advances
/// sample by sample, whatever the host's own resolution.
///
/// `evalTransport` derives every frame as `beats + frameIndex * perSample`,
/// so it is only as continuous as the `beats` each block starts from. A host
/// that reports its true position every block is fine. A host that refreshes
/// it on a timer is not: several blocks in a row start from the same stale
/// beat, so the same stretch of song is replayed and the stretch between
/// refreshes is skipped. A host that never refreshes it is worse: every block
/// starts at beat 0, frame 0 of every block reads as a downbeat crossing, and
/// a `transport.pulse` fires once a block. A Pulse downstream re-arms on each
/// of those, so its output never falls, the envelope it gates never
/// releases, and a self-playing patch plays one note at Play and nothing
/// after it. homecrate's own recorder was both hosts: its beat refreshes at
/// 50 Hz, and not at all when no audio track is playing.
///
/// So the follower keeps its own count. It anchors to the host when rolling
/// starts, then advances by the samples it actually rendered at the host's
/// tempo. A host value is only believed over that count when it is new (it
/// differs from the last one the host gave) and either within a sample of the
/// count, which is a sample-accurate host and is passed through exactly, or
/// far from it, which is a seek or a loop wrap rather than a slow refresh.
///
/// Render thread only. Holds two doubles and allocates nothing.
public struct TransportFollower: Sendable {
    /// How far, in seconds of song, a fresh host position may sit from the
    /// count before it is taken as a jump. Wider than any timer-driven
    /// host's lag (one refresh plus an output buffer) and narrower than a
    /// seek or a loop anyone would make.
    public static let defaultJumpSeconds = 0.125

    public var jumpSeconds: Double
    /// Where the next block starts by the count, or nil when not rolling.
    private var expected: Double?
    /// The last beat the host reported, to tell a refresh from a repeat.
    private var lastHostBeats: Double?

    public init(jumpSeconds: Double = TransportFollower.defaultJumpSeconds) {
        self.jumpSeconds = jumpSeconds
    }

    /// Forgets the count, so the next rolling block anchors to the host.
    public mutating func reset() {
        expected = nil
        lastHostBeats = nil
    }

    /// The snapshot this block should render with. `frames` is the whole
    /// block, not a segment: segments derive their start from this with
    /// `advanced(bySamples:sampleRate:)`.
    public mutating func follow(
        _ host: TransportSnapshot,
        frames: Int,
        sampleRate: Double
    ) -> TransportSnapshot {
        guard host.playing, sampleRate > 0 else {
            // A stopped host holds its own position, and the next Play
            // anchors to wherever it is then.
            reset()
            return host
        }
        var out = host
        if let expected {
            let fresh = lastHostBeats != host.beats
            let gap = abs(host.beats - expected)
            let beatsPerSecond = max(host.bpm, 0) / 60
            // Within a sample, the host is the count, so its value is used
            // as given: rounding never accumulates, and a host integrating a
            // tempo ramp its own way is never second-guessed.
            let agrees = gap <= beatsPerSecond / sampleRate
            let jumped = gap > jumpSeconds * beatsPerSecond
            if !(fresh && (agrees || jumped)) {
                out.beats = expected
            }
        }
        lastHostBeats = host.beats
        expected = out.advanced(bySamples: frames, sampleRate: sampleRate).beats
        return out
    }
}

/// Block-rate DSP that is not ASL-shaped, bound into a slot the graph names.
///
/// The same contract as `renderers/kernel.ts`: `Float32Array` in,
/// `Float32Array` out, with no statement about where it runs. A neural amp,
/// a convolver or a granular engine implements this; the interpreter does not
/// know what any of them are. Every method is optional, and an unbound slot
/// is a clean passthrough rather than silence, so a Material whose asset
/// failed to load still sounds like the rest of its graph.
public protocol KernelProcessor: AnyObject {
    func applyParams(_ params: [String: Double])
    func processSeam(input: UnsafeBufferPointer<Float>, output: UnsafeMutableBufferPointer<Float>)
    func processSeamSample(_ input: Double) -> Double?
    func processSource(
        inputL: UnsafeBufferPointer<Float>,
        inputR: UnsafeBufferPointer<Float>?,
        outputL: UnsafeMutableBufferPointer<Float>,
        outputR: UnsafeMutableBufferPointer<Float>?
    )
}

public extension KernelProcessor {
    func applyParams(_ params: [String: Double]) {}
    func processSeam(input: UnsafeBufferPointer<Float>, output: UnsafeMutableBufferPointer<Float>) {
        for i in 0..<min(input.count, output.count) { output[i] = input[i] }
    }
    func processSeamSample(_ input: Double) -> Double? { nil }
    func processSource(
        inputL: UnsafeBufferPointer<Float>,
        inputR: UnsafeBufferPointer<Float>?,
        outputL: UnsafeMutableBufferPointer<Float>,
        outputR: UnsafeMutableBufferPointer<Float>?
    ) {}
}


extension VoiceState {
    @inline(__always) func recordMeter(_ index: Int, _ value: Double) {
        guard index >= 0, index < tapMeters.count else { return }
        let acc = tapMeters[index]
        let magnitude = value < 0 ? -value : value
        if magnitude > acc.peak { acc.peak = magnitude }
        acc.sumSq += value * value
        acc.count += 1
    }

    @inline(__always) func recordCapture(_ index: Int, value: Double) {
        guard index >= 0, index < tapCaptures.count, let buffer = tapCaptures[index] else { return }
        buffer.samples[buffer.write] = Float(value)
        buffer.write += 1
        if buffer.write >= buffer.samples.count {
            buffer.write = 0
            buffer.filled = true
        }
    }

    /// Reads every tap and resets the meters, so each frame covers exactly the
    /// interval since the previous call. Captures come back oldest first, so a
    /// reader can hand one straight to a pitch detector without knowing it was
    /// a ring.
    public func drainAnalysis() -> AnalysisFrame? {
        if tapIds.isEmpty { return nil }
        var readings = [String: MeterReading]()
        for (index, id) in tapIds.enumerated() {
            let acc = tapMeters[index]
            readings[id] = MeterReading(peak: acc.peak, rms: acc.count > 0 ? (acc.sumSq / acc.count).squareRoot() : 0)
            // Reset rather than decay: each frame reports its own interval,
            // and any smoothing a UI wants is a UI decision made with timing
            // information this does not have.
            acc.peak = 0
            acc.sumSq = 0
            acc.count = 0
        }
        var windows = [String: [Float]]()
        for (index, id) in tapIds.enumerated() {
            guard let buffer = tapCaptures[index] else { continue }
            if buffer.filled {
                windows[id] = Array(buffer.samples[buffer.write...]) + Array(buffer.samples[..<buffer.write])
            } else {
                windows[id] = Array(buffer.samples[..<buffer.write])
            }
        }
        return AnalysisFrame(meters: readings, captures: windows)
    }
}

/// A split voice's own bus and the scratch its sends pass through, for a
/// host that renders one voice. Sized on the first render; a `VoicePool`,
/// the audio-thread path, never makes one.
final class SplitBusRuntime {
    let state: VoiceState
    var sendL: [UnsafeMutablePointer<Float>] = []
    var sendR: [UnsafeMutablePointer<Float>] = []
    var mix: UnsafeMutablePointer<Float>?
    private var frames = 0

    init(state: VoiceState) { self.state = state }

    func ensure(frames: Int, sends: Int) {
        guard frames > self.frames else { return }
        release()
        func make() -> UnsafeMutablePointer<Float> {
            let buffer = UnsafeMutablePointer<Float>.allocate(capacity: frames)
            buffer.initialize(repeating: 0, count: frames)
            return buffer
        }
        sendL = (0..<sends).map { _ in make() }
        sendR = (0..<sends).map { _ in make() }
        mix = make()
        self.frames = frames
    }

    private func release() {
        for buffer in sendL + sendR { buffer.deallocate() }
        mix?.deallocate()
        sendL = []
        sendR = []
        mix = nil
    }

    deinit { release() }
}

