import Foundation

/// JavaScript's `Math.round`, which rounds a half toward positive infinity.
///
/// Swift's `rounded()` rounds a half away from zero, so the two disagree on
/// every negative half. `bitcrush` quantises a signal that swings negative,
/// which means the difference is not academic: it is a different waveform.
@inline(__always) func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

/// JavaScript's `%`, which keeps the sign of the dividend.
@inline(__always) func jsMod(_ x: Double, _ m: Double) -> Double { x.truncatingRemainder(dividingBy: m) }

/// `jsMod(x, m)` without `fmod` on the paths a phase or a ring index takes
/// every sample. Bit-identical, not approximately equal: inside (-m, m) the
/// remainder is `x` itself, and on [m, 2m) `x - m` is exact (Sterbenz), as
/// `fmod` always is. Anything else, including NaN and a non-positive `m`,
/// takes `fmod` as before. `fmod` was 6% of a reverb instrument's render.
@inline(__always) func wrapMod(_ x: Double, _ m: Double) -> Double {
    if x > -m && x < m { return x }
    if x >= m && x < 2 * m { return x - m }
    return jsMod(x, m)
}

/// `jsMod(jsMod(x, m) + m, m)`, the always-positive wrap a ring buffer reads
/// through, with the same fast paths as `wrapMod`. `x + m` is computed
/// exactly as the nested form computes it, rounding included, so a sum that
/// rounds onto `m` or `2m` still wraps to the same bits.
@inline(__always) func jsWrap(_ x: Double, _ m: Double) -> Double {
    if x >= 0 && x < m {
        let t = x + m
        return t < 2 * m ? t - m : jsMod(t, m)
    }
    if x < 0 && x > -m {
        let t = x + m
        return t < m ? t : jsMod(t, m)
    }
    return jsMod(jsMod(x, m) + m, m)
}

/// The `harmonic` shape's normalised sum of `maxHarm` partials, partial h
/// (from 0) at amplitude `amp(h)`.
///
/// Partial n is sin(n * theta), walked by the Chebyshev recurrence
/// sin((n+1)t) = 2cos(t) sin(nt) - sin((n-1)t): one `sin` and one `cos` per
/// sample instead of one `sin` per partial, which was most of a harmonic
/// pad's render. `harmonicSample` in compile.ts runs the same expressions in
/// the same order, so the two engines differ only where libm and
/// `Math.sin`/`Math.cos` already did. Plain multiplies and subtracts on
/// purpose: Swift does not contract them into FMA, and V8 never does, so
/// fusing one side would be a difference the other cannot follow.
@inline(__always) func harmonicPartials(_ phase: Double, _ maxHarm: Int, _ amp: (Int) -> Double) -> Double {
    let theta = 2 * Double.pi * phase
    let k = 2 * cos(theta)
    var prev = 0.0
    var current = sin(theta)
    var norm = 0.0
    var sample = 0.0
    for h in 0..<maxHarm {
        let a = amp(h)
        norm += a
        sample += a * current
        let next = k * current - prev
        prev = current
        current = next
    }
    return norm > 0 ? sample / norm : 0
}

/// `mem`, when given, holds the `harmonic` shape's amplitude table between
/// samples (`NodeMemory.harmonicAmps`). Same values either way: the table is
/// the very `pow` results the uncached loop computes, so the sum is the same
/// to the bit.
@inline(__always) func oscillatorSample(
    _ shape: Int, _ phase: Double, _ width: Double = 0.5, _ freq: Double = 0, _ sr: Double = 1,
    _ mem: UnsafeMutablePointer<NodeMemory>? = nil
) -> Double {
    switch shape {
    case Shape.saw: return 2 * phase - 1
    case Shape.square: return phase < 0.5 ? 1 : -1
    case Shape.triangle: return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase
    case Shape.pulse:
        let duty = min(max(width, 1e-4), 1 - 1e-4)
        return phase < duty ? 1 : -1
    case Shape.varshape:
        let t = min(max(width, 0), 1)
        let tri = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase
        let saw = 2 * phase - 1
        let square = phase < 0.5 ? 1.0 : -1.0
        if t < 0.5 {
            let mix = t * 2
            return tri * (1 - mix) + saw * mix
        }
        let mix = (t - 0.5) * 2
        return saw * (1 - mix) + square * mix
    case Shape.harmonic:
        let freqNorm = freq / sr
        var maxHarm = min(16, Int(floor(0.5 / max(freqNorm, 1e-9))))
        if maxHarm < 1 { maxHarm = 1 }
        let tilt = min(max(width, 0), 1)
        let exponent = 2 * (1 - tilt)
        if let mem {
            return withUnsafeMutablePointer(to: &mem.pointee.harmonicAmps) { tuple in
                tuple.withMemoryRebound(to: Double.self, capacity: 16) { amps in
                    if mem.pointee.harmonicExponent != exponent {
                        for h in 0..<16 { amps[h] = 1 / pow(Double(h + 1), exponent) }
                        mem.pointee.harmonicExponent = exponent
                    }
                    return harmonicPartials(phase, maxHarm) { amps[$0] }
                }
            }
        }
        return harmonicPartials(phase, maxHarm) { 1 / pow(Double($0 + 1), exponent) }
    default: return sin(2 * Double.pi * phase)
    }
}

/// One graph, compiled once, rendered many times.
///
/// The Swift half of `asl/compile.ts`. Same plan, same dense slots, same
/// generation-stamped value cache, same coefficient caching, same decisions
/// about when a stereo pass can be mirrored. Where the two differ at all it is
/// a bug in one of them, and `Tests/CrateASLTests` is the thing that says
/// which.
public final class CompiledVoice {
    let plan: Plan
    let root: PlanNode
    /// Whether this graph is evaluated once per output channel.
    public let stereo: Bool
    /// Tap ids this graph records under.
    public var taps: [String] { plan.tapIds }
    /// The slot of a source kernel at the graph's output, or nil.
    public let sourceSlot: String?
    private let sourceNode: PlanNode?
    private let mirrorsMonoInput: Bool
    private let writesScalarInput: Bool
    /// Where the main insert input lands in the port arrays, or -1 when the
    /// graph never reads one.
    private let mainPortSlot: Int
    /// Parameters whose `setParam` glides, `graph.smooth` in the document.
    private let smoothed: Set<String>
    /// Every node a frame always evaluates, children first (`Schedule.swift`),
    /// flattened into `ScheduledOp`s so the frame loop reads one dense array
    /// rather than chasing a `PlanNode` per node per sample. Unretained, like
    /// `PlanNode.inputs`: `plan.nodes` owns them for the voice's whole life,
    /// and walking them per sample must cost no retain.
    private let schedule: UnsafeMutablePointer<ScheduledOp>
    private let scheduleCount: Int
    /// A split instrument's voice outputs (`ASLGraphDocument.sends`): how
    /// many, and each one's slot in the value cache.
    public let sendCount: Int
    private let sendSlots: UnsafeMutablePointer<Int>
    /// What runs once on the voices' summed sends, compiled from
    /// `document.bus`. A `VoicePool` drives it; nil for every other graph.
    public let bus: CompiledVoice?
    /// The bus's port index for each send, in send order.
    private let busSendPorts: [Int]

    /// `samples` supplies the audio for boxes that name a file rather than
    /// carrying their own table, keyed by the name `CrateSamples.references`
    /// reported. A ref with nothing here falls back to whatever table the
    /// material shipped, which is silence for a Sample Player and a sine for
    /// a Wavetable; see `SampleBox.swift`.
    public init(document: ASLGraphDocument, samples: [String: CrateSampleBox] = [:]) throws {
        plan = try buildPlan(document, samples: samples)
        root = plan.root
        smoothed = Set(document.smooth ?? [])
        switch document.channels {
        case 1: stereo = false
        case 2: stereo = true
        default: stereo = !plan.ports.isEmpty || plan.usesLane
        }
        // A source kernel only means anything as the graph's output: it
        // replaces the whole per-sample evaluation, so there is nothing
        // sensible for a second one, or a buried one, to do.
        sourceNode = (root.kind == .kernel && root.m != 0) ? root : nil
        sourceSlot = sourceNode?.kernelSlot
        // A stereo graph handed the same samples on both sides, from state
        // that started identical, computes the same block twice. Two things
        // break that and both are decided here rather than guessed at: a
        // graph that asks which channel it is on is allowed to differ, and a
        // graph that draws random numbers will. Everything else can be
        // mirrored, which halves what a mono track's inserts cost.
        mirrorsMonoInput = stereo && !plan.usesLane && !plan.usesRandom
        writesScalarInput = plan.readsScalarInput
        mainPortSlot = plan.ports.firstIndex(of: mainPortName) ?? -1
        let order = buildSchedule(plan.root)
        scheduleCount = order.count
        schedule = .allocate(capacity: max(order.count, 1))
        for (i, node) in order.enumerated() { (schedule + i).initialize(to: ScheduledOp(node)) }
        let sends = document.sends ?? []
        sendCount = sends.count
        sendSlots = .allocate(capacity: max(sends.count, 1))
        for (k, send) in sends.enumerated() {
            guard let slot = plan.slotBySourceId[send.id] else {
                throw ASLCompileError("a send is not reachable from the graph output")
            }
            (sendSlots + k).initialize(to: slot)
        }
        bus = try document.bus.map { try CompiledVoice(document: $0, samples: samples) }
        busSendPorts = (0..<sends.count).map { [bus] in bus?.portIndex(of: "send\($0)") ?? -1 }
    }

    deinit {
        schedule.deallocate()
        sendSlots.deallocate()
    }

    /// One frame: the schedule front to back, then the root's cached value.
    /// The same nodes `eval(root)` would compute, computed bottom up, so each
    /// evaluator's input reads are cache loads rather than recursive calls.
    ///
    /// The wiring kinds a patch is mostly made of (`const`, `param`, `mul`,
    /// `add`, `range`) are computed right here from the op's own fields, with
    /// no call. On device, 8 crate instances spent about half their CPU in
    /// `compute`'s prologue and epilogue: saving and restoring fourteen
    /// registers to multiply two cached numbers. The arithmetic is the same
    /// expression `compute` evaluates, so the bits are the same. Whenever an
    /// input is not already cached this frame (a lazy edge), the op falls
    /// back to `compute`, which recurses exactly as before.
    ///
    /// `generation` and `frameIndex` are read once: nothing inside a frame
    /// writes them (only the block loops in `render` do), and reading them
    /// through `hot` after every call was a reload the compiler could not
    /// prove away.
    @inline(__always) private func runFrame(_ state: VoiceState, _ sampleRate: Double) -> Double {
        let stamps = state.stamps
        let values = state.values
        let generation = state.generation
        let frame = state.frameIndex
        @inline(__always) func ready(_ slot: Int) -> Bool { slot < 0 || stamps[slot] == generation }
        @inline(__always) func read(_ slot: Int) -> Double { slot < 0 ? 0 : values[slot] }
        for i in 0..<scheduleCount {
            let op = schedule + i
            let slot = op.pointee.slot
            if stamps[slot] == generation { continue }
            let result: Double
            switch op.pointee.code {
            case .const:
                result = op.pointee.c
            case .param:
                result = state.paramValue(op.pointee.a, frame: frame)
            case .mul where ready(op.pointee.a) && ready(op.pointee.b):
                result = read(op.pointee.a) * read(op.pointee.b)
            case .add where ready(op.pointee.a) && ready(op.pointee.b):
                result = read(op.pointee.a) + read(op.pointee.b)
            case .range where ready(op.pointee.a):
                let source = read(op.pointee.a)
                result = op.pointee.c + ((source + 1) / 2) * (op.pointee.d - op.pointee.c)
            case .other:
                // Not one of `compute`'s own kinds, so `compute` would only
                // have forwarded here: skip its frame and go straight in.
                result = op.pointee.node._withUnsafeGuaranteedRef { evalOther($0, state, sampleRate) }
            default:
                // `_withUnsafeGuaranteedRef` keeps the node unretained;
                // `takeUnretainedValue` retains and measured half again slower.
                result = op.pointee.node._withUnsafeGuaranteedRef { compute($0, state, sampleRate) }
            }
            values[slot] = result
            stamps[slot] = generation
        }
        return values[root.slot]
    }

    public convenience init(json: Data) throws {
        try self.init(document: ASLGraphDocument.decode(json))
    }

    /// `seed` makes `noise` and `random` reproducible, as
    /// `createState({ seed })` does in compile.ts, and the default is the same.
    ///
    /// A split instrument's state carries its own bus, so rendering it alone
    /// plays the whole patch, as `compileVoice` does in JavaScript.
    /// `withBus: false` is for a `VoicePool`, which runs one bus for all its
    /// voices.
    public func makeState(seed: UInt32 = defaultVoiceSeed, withBus: Bool = true) -> VoiceState {
        let state = VoiceState(
            slotCount: plan.slotCount,
            portNames: plan.ports,
            paramNames: plan.paramNames,
            tapIds: plan.tapIds,
            tapWindows: plan.tapWindows
        )
        state.seed = seed
        if withBus, let bus {
            let busState = bus.makeState(seed: seed)
            // An effect on the voices' sum: its gate opens once and stays open.
            busState.gate = true
            state.splitBus = SplitBusRuntime(state: busState)
        }
        return state
    }

    /// The index a named port occupies in `VoiceState.setPort`, or -1.
    /// A host wiring a sidechain asks for it once, not per block.
    public func portIndex(of name: String) -> Int {
        plan.ports.firstIndex(of: name) ?? -1
    }

    public func noteOn(_ state: VoiceState, params: [String: Double] = [:]) {
        state.setParams(params)
        state.gate = true
    }

    /// A host's parameter change, `CompiledVoice.setParam` in compile.ts: a
    /// parameter the graph lists in `smooth` glides there over
    /// `paramRampSeconds`, anything else lands at once, and so does anything
    /// set before the voice first renders. A host ramp with its own length
    /// (`rampParam`) and `noteOn` values are untouched by this.
    public func setParam(_ state: VoiceState, _ name: String, _ value: Double) {
        guard smoothed.contains(name), state.renderedRate > 0,
              let current = state.committedParam(name), current.value != value else {
            state.setParam(name, value)
            return
        }
        state.rampParam(name, to: value, frames: paramRampFrames(state.renderedRate))
    }

    public func noteOff(_ state: VoiceState) {
        state.gate = false
    }

    /// One sample, for offline rendering and tests. Ports fall back to the
    /// scalar of the same name, which is what makes a per-sample caller work.
    public func renderSample(_ state: VoiceState, sampleRate: Double) -> Double {
        if sendCount > 0, state.splitBus != nil {
            // The whole split patch, as a block of one.
            var out: Float = 0
            _ = render(state, sampleRate: sampleRate, frames: 1, outL: &out, outR: nil)
            return Double(out)
        }
        state.generation += 1
        // One sample is a block of one: frame 0 of any ramp, then committed.
        state.renderedRate = sampleRate
        state.frameIndex = 0
        let out = eval(root, state, sampleRate)
        state.commitRamps(framesRendered: 1)
        return out
    }

    /// Renders one block into raw output pointers.
    ///
    /// This is what an `AUAudioUnit`'s `internalRenderBlock` calls, so it is
    /// written to the rules that thread runs under: no allocation, no locks,
    /// no logging, no Objective-C messaging, nothing that can block. Wire any
    /// auxiliary ports with `state.setPort` first; `input` is passed here
    /// because every insert has one.
    ///
    /// Returns whether `outputR` was written. A caller that gets false must
    /// mirror channel 0 itself, and reporting it rather than having the
    /// caller re-derive the rule keeps the two from drifting: the wrong
    /// answer is either a silent right channel or a stereo image collapsed
    /// to mono.
    @discardableResult
    public func render(
        _ state: VoiceState,
        sampleRate: Double,
        frames: Int,
        outL: UnsafeMutablePointer<Float>,
        outR: UnsafeMutablePointer<Float>?,
        inL: UnsafePointer<Float>? = nil,
        inR: UnsafePointer<Float>? = nil,
        transport: TransportSnapshot? = nil,
        sendsL: UnsafePointer<UnsafeMutablePointer<Float>>? = nil,
        sendsR: UnsafePointer<UnsafeMutablePointer<Float>>? = nil
    ) -> Bool {
        // A split voice asked for its output rather than its sends plays its
        // own bus: the whole patch, as one voice.
        if sendsL == nil, sendCount > 0, let bus, let split = state.splitBus {
            split.ensure(frames: frames, sends: sendCount)
            let wroteRight = split.sendL.withUnsafeBufferPointer { left in
                split.sendR.withUnsafeBufferPointer { right in
                    render(
                        state, sampleRate: sampleRate, frames: frames, outL: split.mix!, outR: nil,
                        inL: inL, inR: inR, transport: transport,
                        sendsL: left.baseAddress!, sendsR: right.baseAddress!
                    )
                }
            }
            for k in 0..<sendCount where busSendPorts[k] >= 0 {
                split.state.portL[busSendPorts[k]] = UnsafePointer(split.sendL[k])
                split.state.portR[busSendPorts[k]] = wroteRight ? UnsafePointer(split.sendR[k]) : nil
            }
            return bus.render(
                split.state, sampleRate: sampleRate, frames: frames, outL: outL, outR: outR,
                transport: transport ?? state.transport
            )
        }
        if let transport { state.transport = transport }
        state.renderedRate = sampleRate

        if let sourceNode {
            let wrote = renderSourceKernel(
                sourceNode, state, frames: frames, outL: outL, outR: outR, inL: inL, inR: inR
            )
            state.commitRamps(framesRendered: frames)
            return wrote
        }

        if let inL, mainPortSlot >= 0 {
            state.portL[mainPortSlot] = inL
            state.portR[mainPortSlot] = inR
        }
        defer {
            for i in 0..<state.portL.count {
                state.portL[i] = nil
                state.portR[i] = nil
            }
        }

        var boundSeams = 0
        if !state.kernels.isEmpty {
            for seam in plan.seams where state.kernels[seam.kernelSlot] != nil { boundSeams += 1 }
        }

        // Nothing wired to a right channel anywhere means both passes would
        // see the same samples, so the second one is the first one computed
        // again and thrown at the right speaker.
        var allInputsMono = mirrorsMonoInput && inR == nil
        if allInputsMono {
            for i in 0..<state.portR.count where state.portR[i] != nil {
                allInputsMono = false
                break
            }
        }

        // Only worth writing per sample when a `param` node named `input`
        // exists to read it. `audio.input()` mints a port and takes the block.
        let scalarInput = writesScalarInput ? inL : nil

        if boundSeams == 0 {
            // A split voice can be stereo with no `outR`: its sends carry the
            // channels. Either asks for the second pass. Same rule as
            // compile.ts, return value included.
            let sendsL = sendCount > 0 ? sendsL : nil
            let stereoPass = stereo && !allInputsMono
            let sendsR = stereoPass && sendsL != nil ? sendsR : nil
            let wantsRight = stereoPass && (outR != nil || sendsR != nil)
            for i in 0..<frames {
                state.frameIndex = i
                state.lane = 0
                if let scalarInput { state.setPortScalar(mainPortSlot, Double(scalarInput[i])) }
                state.generation += 1
                outL[i] = Float(runFrame(state, sampleRate))
                if let sendsL {
                    for k in 0..<sendCount { sendsL[k][i] = Float(state.values[sendSlots[k]]) }
                }
                if wantsRight {
                    // A second full pass, with its own node memory, is what
                    // makes a filter written once a real stereo filter rather
                    // than a mono one whose output is copied to both sides.
                    state.lane = 1
                    state.generation += 1
                    let right = Float(runFrame(state, sampleRate))
                    if let outR { outR[i] = right }
                    if let sendsR {
                        for k in 0..<sendCount { sendsR[k][i] = Float(state.values[sendSlots[k]]) }
                    }
                }
            }
            state.lane = 0
            state.commitRamps(framesRendered: frames)
            return sendsL != nil ? sendsR != nil : (wantsRight && outR != nil)
        }

        renderSeamBlock(state, sampleRate: sampleRate, frames: frames, outL: outL, scalarInput: scalarInput)
        state.commitRamps(framesRendered: frames)
        return false
    }

    private func renderSourceKernel(
        _ node: PlanNode,
        _ state: VoiceState,
        frames: Int,
        outL: UnsafeMutablePointer<Float>,
        outR: UnsafeMutablePointer<Float>?,
        inL: UnsafePointer<Float>?,
        inR: UnsafePointer<Float>?
    ) -> Bool {
        guard let processor = state.kernels[node.kernelSlot] else {
            // Nothing bound. An effect engine passes its signal through so a
            // failed load does not mute the track; an instrument is silent,
            // which is its honest output with no engine.
            if node.m == 2 || inL == nil {
                outL.update(repeating: 0, count: frames)
                outR?.update(repeating: 0, count: frames)
            } else if let inL {
                outL.update(from: inL, count: frames)
                if let outR { outR.update(from: inR ?? inL, count: frames) }
            }
            return outR != nil
        }
        processor.applyParams(state.params)
        // A source kernel is handed a real block even when nothing is
        // connected, so an effect-shaped one does not have to null-check.
        let source: UnsafePointer<Float>
        if let inL {
            source = inL
        } else {
            if sourceScratch.count < frames { sourceScratch = [Float](repeating: 0, count: frames) }
            sourceScratch.withUnsafeMutableBufferPointer { $0.update(repeating: 0) }
            source = UnsafePointer(sourceScratch.withUnsafeMutableBufferPointer { $0.baseAddress! })
        }
        processor.processSource(
            inputL: UnsafeBufferPointer(start: source, count: frames),
            inputR: inR.map { UnsafeBufferPointer(start: $0, count: frames) },
            outputL: UnsafeMutableBufferPointer(start: outL, count: frames),
            outputR: outR.map { UnsafeMutableBufferPointer(start: $0, count: frames) }
        )
        return outR != nil
    }

    /// Two passes over the same tree, with the seam stubbed out on the way in.
    ///
    /// Stateful ASL nodes therefore advance once per frame during collect and
    /// read cached values during apply, which is why a stateful node placed
    /// downstream of a seam would be double-stepped. A seam graph stays mono:
    /// a block-rate kernel is stateful across blocks, so calling it once per
    /// channel would interleave one reverb's tail between left and right.
    private func renderSeamBlock(
        _ state: VoiceState,
        sampleRate: Double,
        frames: Int,
        outL: UnsafeMutablePointer<Float>,
        scalarInput: UnsafePointer<Float>?
    ) {
        for seam in plan.seams where state.kernels[seam.kernelSlot] != nil {
            if seamBuffers[seam.slot] == nil || seamBuffers[seam.slot]!.input.count < frames {
                seamBuffers[seam.slot] = SeamBuffers(frames: frames)
            }
        }
        seamPhase = .collect
        for i in 0..<frames {
            seamIndex = i
            state.frameIndex = i
            if let scalarInput { state.setPortScalar(mainPortSlot, Double(scalarInput[i])) }
            state.generation += 1
            _ = eval(root, state, sampleRate)
        }
        for seam in plan.seams {
            guard var buffers = seamBuffers[seam.slot], let processor = state.kernels[seam.kernelSlot] else { continue }
            processor.applyParams(state.params)
            buffers.input.withUnsafeBufferPointer { inBuf in
                buffers.output.withUnsafeMutableBufferPointer { outBuf in
                    processor.processSeam(
                        input: UnsafeBufferPointer(rebasing: inBuf[0..<frames]),
                        output: UnsafeMutableBufferPointer(rebasing: outBuf[0..<frames])
                    )
                }
            }
            seamBuffers[seam.slot] = buffers
        }
        seamPhase = .apply
        for i in 0..<frames {
            seamIndex = i
            state.frameIndex = i
            if let scalarInput { state.setPortScalar(mainPortSlot, Double(scalarInput[i])) }
            state.generation += 1
            outL[i] = Float(eval(root, state, sampleRate))
        }
        seamPhase = .sample
    }

    /// Array-shaped convenience for tests and offline rendering. The audio
    /// thread uses `render` directly.
    @discardableResult
    public func renderBlock(
        _ state: VoiceState,
        sampleRate: Double,
        output: inout [Float],
        input: [Float]? = nil,
        inputR: [Float]? = nil,
        outputR: inout [Float]?,
        transport: TransportSnapshot? = nil
    ) -> Bool {
        let frames = output.count
        var wrote = false
        output.withUnsafeMutableBufferPointer { outBuf in
            func run(_ outRPtr: UnsafeMutablePointer<Float>?) {
                func withInputs(_ body: (UnsafePointer<Float>?, UnsafePointer<Float>?) -> Void) {
                    guard let input else { return body(nil, nil) }
                    input.withUnsafeBufferPointer { inBuf in
                        guard let inputR else { return body(inBuf.baseAddress, nil) }
                        inputR.withUnsafeBufferPointer { inRBuf in
                            body(inBuf.baseAddress, inRBuf.baseAddress)
                        }
                    }
                }
                withInputs { l, r in
                    wrote = render(
                        state, sampleRate: sampleRate, frames: frames,
                        outL: outBuf.baseAddress!, outR: outRPtr,
                        inL: l, inR: r, transport: transport
                    )
                }
            }
            if outputR != nil {
                outputR!.withUnsafeMutableBufferPointer { outRBuf in run(outRBuf.baseAddress) }
            } else {
                run(nil)
            }
        }
        return wrote
    }

    // MARK: - Seam block state

    enum SeamPhase { case sample, collect, apply }
    struct SeamBuffers {
        var input: [Float]
        var output: [Float]
        init(frames: Int) {
            input = [Float](repeating: 0, count: frames)
            output = [Float](repeating: 0, count: frames)
        }
    }
    var seamPhase = SeamPhase.sample
    var seamIndex = 0
    var seamBuffers = [Int: SeamBuffers]()
    private var sourceScratch = [Float]()

    // MARK: - Evaluation

    /// Evaluate one node, through the per-sample cache.
    ///
    /// The wiring kinds live here and everything else is one call away, for
    /// the same reason as in the JavaScript version: a graph's arithmetic
    /// spine is a deep recursion, and recursing through a function with
    /// seventy cases in it means stack frames sized for the widest of them.
    ///
    /// Split in two. This half is the cache: small enough to inline into
    /// every caller, so a value this frame already has costs a compare and a
    /// load, not a call. `compute` is the switch, kept out of line so its
    /// frame (sized for whatever the compiler inlined into seventy cases) is
    /// paid once per node per sample rather than on every read. A profile of
    /// the single-function form put about a quarter of render time in its
    /// prologue and epilogue alone.
    @inline(__always) func eval(_ node: PlanNode, _ state: VoiceState, _ sampleRate: Double) -> Double {
        let slot = node.slot
        if state.stamps[slot] == state.generation { return state.values[slot] }
        let result = compute(node, state, sampleRate)
        state.values[slot] = result
        state.stamps[slot] = state.generation
        return result
    }

    /// One node's own work, with its inputs read through `ev`. Callers go
    /// through `eval`, which caches the answer for the rest of the frame.
    @inline(never) func compute(_ node: PlanNode, _ state: VoiceState, _ sampleRate: Double) -> Double {
        let result: Double
        switch node.kind {
        case .const:
            result = node.c
        case .mul:
            result = ev(node, .a, state, sampleRate) * ev(node, .b, state, sampleRate)
        case .add:
            result = ev(node, .a, state, sampleRate) + ev(node, .b, state, sampleRate)
        case .param:
            // Pure in the frame, so a seam graph's collect and apply passes
            // read the same value. See `VoiceState.paramValue`.
            result = state.paramValue(node.paramIndex, frame: state.frameIndex)
        case .port:
            result = evalPort(node, state)
        case .lane:
            result = Double(state.lane)
        case .range:
            let source = ev(node, .source, state, sampleRate)
            result = node.rangeMin + ((source + 1) / 2) * (node.rangeMax - node.rangeMin)
        case .mix:
            // Same terms, same order, so the same sum to the bit; read from
            // the cache by slot, as `ev` reads a named input.
            var sum = 0.0
            if let slots = node.listSlots {
                for i in 0..<node.listCount {
                    let s = slots[i]
                    sum += state.stamps[s] == state.generation ? state.values[s] : eval(node.list![i], state, sampleRate)
                }
            }
            result = sum
        default:
            result = evalOther(node, state, sampleRate)
        }
        return result
    }

    @inline(__always) private func evalPort(_ node: PlanNode, _ state: VoiceState) -> Double {
        let index = node.portIndex
        guard index >= 0, let left = state.portL[index] else {
            // No block wired: fall back to the scalar of the same name. That
            // is the per-sample path, and it is why a graph written against
            // the old scalar `input` still runs unchanged.
            //
            // Out of the dense array, never out of `state.params`. That
            // dictionary is written by whichever thread sets a parameter,
            // which for an AUv3 is the host's thread the moment somebody
            // drags a slider, and reading a Swift dictionary while another
            // thread reshapes its storage is a wild pointer rather than a
            // stale number. A VoicePool never wires its ports, so an
            // instrument patch took this branch for every sample of every
            // voice, which is where that race was found: holding a note on a
            // Sample Player and moving its rate killed the render thread.
            return index >= 0 ? state.portScalars[index] : 0
        }
        // A fixed channel the source does not have reads the one it does
        // have: `audio.right()` on a mono send is that send, not silence.
        let channel = node.m < 0 ? state.lane : node.m
        if channel > 0, let right = state.portR[index] { return Double(right[state.frameIndex]) }
        return Double(left[state.frameIndex])
    }

    @inline(__always) private func input(_ node: PlanNode, _ name: InputName, _ state: VoiceState, _ sr: Double) -> Double {
        guard let child = node.input(name) else { return 0 }
        return eval(child, state, sr)
    }
}
