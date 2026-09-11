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

    // Edge detection and holds.
    var prev = 0.0, held = 0.0, count = 0.0, index = -1.0, on = 0.0
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

    /// Live audio for the block being rendered, one entry per port the graph
    /// reads, in `Plan.ports` order. Raw pointers, not arrays: an AUv3 render
    /// block is handed an `AudioBufferList` and has to do its work without
    /// allocating, retaining, or hashing anything. A port with nothing wired
    /// is nil and reads as the scalar of the same name, which is what makes
    /// the per-sample path work.
    var portL: [UnsafePointer<Float>?]
    var portR: [UnsafePointer<Float>?]
    /// Names in the same order, for the scalar fallback only. Never read on
    /// the per-sample path when a block is wired.
    var portNames: [String] = []

    /// Bound block-rate DSP, by kernel slot. Empty is a clean passthrough.
    public var kernels: [String: KernelProcessor] = [:]

    /// Live tap state, created on first use so a graph with no taps has none.
    var meters: [String: MeterAccumulator] = [:]
    var captures: [String: CaptureBuffer] = [:]

    init(slotCount: Int, portNames: [String], paramNames: [String]) {
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
        rampFrames = .allocate(capacity: max(1, paramNames.count))
        paramValues.initialize(repeating: 0, count: max(1, paramNames.count))
        rampStep.initialize(repeating: 0, count: max(1, paramNames.count))
        rampFrames.initialize(repeating: 0, count: max(1, paramNames.count))
        memory = .allocate(capacity: max(1, slotCount))
        memory.initialize(repeating: nil, count: max(1, slotCount))
        self.portNames = portNames
        portL = Array(repeating: nil, count: portNames.count)
        portR = Array(repeating: nil, count: portNames.count)
        for (index, name) in paramNames.enumerated() { paramIndex[name] = index }
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
        values.deallocate()
        stamps.deallocate()
        paramValues.deallocate()
        rampStep.deallocate()
        rampFrames.deallocate()
    }

    /// Sets a parameter immediately, cancelling any ramp on it.
    public func setParam(_ name: String, _ value: Double) {
        params[name] = value
        guard let index = paramIndex[name] else { return }
        paramValues[index] = value
        rampStep[index] = 0
        rampFrames[index] = 0
    }

    public func setParams(_ values: [String: Double]) {
        for (name, value) in values { setParam(name, value) }
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
        params[name] = value
        rampStep[index] = (value - paramValues[index]) / Double(frames)
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

    /// Advances every ramp by the frames just rendered, and lands exactly on
    /// the target rather than on an accumulation of steps.
    func commitRamps(framesRendered: Int) {
        guard hasRamps else { return }
        var stillRamping = false
        for index in 0..<paramCount {
            let remaining = rampFrames[index]
            if remaining == 0 { continue }
            if framesRendered >= remaining {
                paramValues[index] += rampStep[index] * Double(remaining)
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
    func recordMeter(_ id: String, _ value: Double) {
        let acc: MeterAccumulator
        if let existing = meters[id] { acc = existing } else {
            acc = MeterAccumulator()
            meters[id] = acc
        }
        let magnitude = value < 0 ? -value : value
        if magnitude > acc.peak { acc.peak = magnitude }
        acc.sumSq += value * value
        acc.count += 1
    }

    func recordCapture(_ id: String, windowSize: Int, value: Double) {
        let buffer: CaptureBuffer
        if let existing = captures[id] { buffer = existing } else {
            buffer = CaptureBuffer(windowSize: windowSize)
            captures[id] = buffer
        }
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
        if meters.isEmpty && captures.isEmpty { return nil }
        var readings = [String: MeterReading]()
        for (id, acc) in meters {
            readings[id] = MeterReading(peak: acc.peak, rms: acc.count > 0 ? (acc.sumSq / acc.count).squareRoot() : 0)
            // Reset rather than decay: each frame reports its own interval,
            // and any smoothing a UI wants is a UI decision made with timing
            // information this does not have.
            acc.peak = 0
            acc.sumSq = 0
            acc.count = 0
        }
        var windows = [String: [Float]]()
        for (id, buffer) in captures {
            if buffer.filled {
                windows[id] = Array(buffer.samples[buffer.write...]) + Array(buffer.samples[..<buffer.write])
            } else {
                windows[id] = Array(buffer.samples[..<buffer.write])
            }
        }
        return AnalysisFrame(meters: readings, captures: windows)
    }
}
