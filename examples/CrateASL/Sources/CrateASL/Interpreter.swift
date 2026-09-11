import Foundation

/// JavaScript's `Math.round`, which rounds a half toward positive infinity.
///
/// Swift's `rounded()` rounds a half away from zero, so the two disagree on
/// every negative half. `bitcrush` quantises a signal that swings negative,
/// which means the difference is not academic: it is a different waveform.
@inline(__always) func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

/// JavaScript's `%`, which keeps the sign of the dividend.
@inline(__always) func jsMod(_ x: Double, _ m: Double) -> Double { x.truncatingRemainder(dividingBy: m) }

@inline(__always) func oscillatorSample(_ shape: Int, _ phase: Double, _ width: Double = 0.5, _ freq: Double = 0, _ sr: Double = 1) -> Double {
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
        var norm = 0.0
        var sample = 0.0
        for h in 0..<maxHarm {
            let n = Double(h + 1)
            let amp = 1 / pow(n, exponent)
            norm += amp
            let harmPhase = phase * n
            sample += amp * sin(2 * Double.pi * (harmPhase - floor(harmPhase)))
        }
        return norm > 0 ? sample / norm : 0
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

    public init(document: ASLGraphDocument) throws {
        plan = try buildPlan(document)
        root = plan.root
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
    }

    public convenience init(json: Data) throws {
        try self.init(document: ASLGraphDocument.decode(json))
    }

    public func makeState() -> VoiceState {
        VoiceState(slotCount: plan.slotCount, portNames: plan.ports, paramNames: plan.paramNames)
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

    public func noteOff(_ state: VoiceState) {
        state.gate = false
    }

    /// One sample, for offline rendering and tests. Ports fall back to the
    /// scalar of the same name, which is what makes a per-sample caller work.
    public func renderSample(_ state: VoiceState, sampleRate: Double) -> Double {
        state.generation += 1
        return eval(root, state, sampleRate)
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
        transport: TransportSnapshot? = nil
    ) -> Bool {
        if let transport { state.transport = transport }

        if let sourceNode {
            return renderSourceKernel(
                sourceNode, state, frames: frames, outL: outL, outR: outR, inL: inL, inR: inR
            )
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
            let wantsRight = stereo && !allInputsMono && outR != nil
            for i in 0..<frames {
                state.frameIndex = i
                state.lane = 0
                if let scalarInput { state.setParam(mainPortName, Double(scalarInput[i])) }
                state.generation += 1
                outL[i] = Float(eval(root, state, sampleRate))
                if wantsRight {
                    // A second full pass, with its own node memory, is what
                    // makes a filter written once a real stereo filter rather
                    // than a mono one whose output is copied to both sides.
                    state.lane = 1
                    state.generation += 1
                    outR![i] = Float(eval(root, state, sampleRate))
                }
            }
            state.lane = 0
            state.commitRamps(framesRendered: frames)
            return wantsRight
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
            if let scalarInput { state.setParam(mainPortName, Double(scalarInput[i])) }
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
            if let scalarInput { state.setParam(mainPortName, Double(scalarInput[i])) }
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
    func eval(_ node: PlanNode, _ state: VoiceState, _ sampleRate: Double) -> Double {
        let slot = node.slot
        if state.stamps[slot] == state.generation { return state.values[slot] }

        let result: Double
        switch node.kind {
        case .const:
            result = node.c
        case .mul:
            result = eval(node.input(.a)!, state, sampleRate)
                * eval(node.input(.b)!, state, sampleRate)
        case .add:
            result = eval(node.input(.a)!, state, sampleRate)
                + eval(node.input(.b)!, state, sampleRate)
        case .param:
            // Pure in the frame, so a seam graph's collect and apply passes
            // read the same value. See `VoiceState.paramValue`.
            result = state.paramValue(node.paramIndex, frame: state.frameIndex)
        case .port:
            result = evalPort(node, state)
        case .lane:
            result = Double(state.lane)
        case .range:
            let source = eval(node.input(.source)!, state, sampleRate)
            result = node.rangeMin + ((source + 1) / 2) * (node.rangeMax - node.rangeMin)
        case .mix:
            var sum = 0.0
            if let list = node.list {
                for child in list { sum += eval(child, state, sampleRate) }
            }
            result = sum
        default:
            result = evalOther(node, state, sampleRate)
        }

        state.values[slot] = result
        state.stamps[slot] = state.generation
        return result
    }

    @inline(__always) private func evalPort(_ node: PlanNode, _ state: VoiceState) -> Double {
        let index = node.portIndex
        guard index >= 0, let left = state.portL[index] else {
            // No block wired: fall back to the scalar of the same name. That
            // is the per-sample path, and it is why a graph written against
            // the old scalar `input` still runs unchanged.
            return state.params[node.name] ?? 0
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
