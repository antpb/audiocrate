import Foundation

/// The order a frame evaluates its nodes in, worked out once per plan.
///
/// `CompiledVoice.eval` is a recursive walk: the output asks its inputs, they
/// ask theirs, and every answer lands in the per-sample value cache. The
/// schedule is that same walk flattened: every node the walk is certain to
/// reach, children before parents, in the order the evaluators ask for them.
/// Running it front to back fills the cache bottom up, so when a node's
/// evaluator reads an input the value is already there and the read is a
/// load from `values`, not a call.
///
/// The bar is identical audio, not similar audio, and that decides what goes
/// in. A node is scheduled only through an input its evaluator reads **every
/// time it runs**. Anything read conditionally (a sequencer's steps, a
/// breakpoint list past the gate, a transport field one mode reads and
/// another does not) is left to the recursive walk exactly as before: a
/// stateful node evaluated on a sample where it used to be skipped would
/// advance its phase, its ring, its random stream, and the sound would move.
/// Leaving an input out of `eagerInputs` only costs speed, because a read
/// whose value is not cached yet still falls through to `eval`. Putting one
/// in that is not read every time changes the audio, which
/// `InterpreterDigestTests` exists to catch.
///
/// Node state is per node (`NodeMemory`, including each random stream), so
/// evaluating independent subtrees in schedule order rather than call order
/// cannot change any value. The order here still follows each evaluator's
/// read order, so taps record in the order they always did.
extension PlanNode {
    /// The inputs this node's evaluator reads on every evaluation, in the
    /// order it reads them. Mirrors `eval`, `evalOther` and the `eval*`
    /// helpers; change one and change this. `has` inputs are wiring, fixed
    /// for the plan's life, so "read when wired" is still unconditional.
    var eagerInputs: [InputName] {
        switch kind {
        case .const, .param, .port, .lane: return []
        case .mul, .add: return [.a, .b]
        case .range: return [.source]
        case .mix: return []  // the list, see `eagerList`
        case .meter, .capture: return [.input]
        case .toFrequency: return [.note]
        case .osc: return [.freq, .width, .type]
        case .lfo: return [.rate, .width, .type, .phase, .reset]
        case .adsr: return [.trigger]
        case .dahdsr: return [.trigger, .delay, .attack, .hold, .decay, .sustain, .release, .gate]
        case .breakpoints: return [.gate]
        case .impulse: return [.gate]
        case .filterLowpass, .filterHighpass, .filterBandpass, .filterNotch, .filterAllpass, .svf:
            return [.input, .cutoff, .q]
        case .filterPeaking, .filterLowShelf, .filterHighShelf: return [.input, .freq, .gainDb, .q]
        case .onePoleLowpass, .onePoleHighpass, .filterSlope: return [.input, .cutoff]
        case .ladder: return [.input, .cutoff, .resonance, .drive]
        case .comb: return [.input, .freq, .feedback, .mix]
        case .delay: return [.input, .timeSec, .feedback, .mix]
        case .reverse: return [.input, .timeSec]
        case .looper: return [.input, .record, .trigger, .duration]
        case .envFollow: return [.input, .attack, .release]
        case .compressor: return [.input, .sidechain, .threshold, .ratio, .attack, .release]
        case .expander: return [.input, .threshold, .ratio, .attack, .release]
        case .transient: return [.input, .attack, .sustain]
        case .rms: return [.input, .windowSec]
        case .peak: return [.input, .release]
        case .onset: return [.input, .threshold]
        case .pitch: return [.input]
        case .clip: return [.input, .drive]
        case .waveshape, .rectify, .dcBlock, .flipFlop: return [.input]
        case .bitcrush: return [.input, .bits]
        case .downsample: return [.input, .factor]
        case .slew: return [.input, .rise, .fall]
        case .sampleHold: return [.input, .freq, .clock]
        case .compare, .trigger: return [.input, .threshold]
        case .clock: return [.freq, .reset]
        case .clockDivide, .clockMultiply: return [.input, .factor, .reset]
        // NOT (mode 3) answers from `a` alone and never reads `b`.
        case .logic: return m == 3 ? [.a] : [.a, .b]
        case .quantize: return [.input, .root, .scale]
        case .euclidean: return [.input, .steps, .hits, .rotation, .reset]
        case .random: return [.freq]
        case .pulse: return [.input, .widthSec]
        // Only the step that is current is read; the clock and reset always.
        case .sequencer: return [.clock, .reset]
        case .select: return [.a, .b, .which]
        // `position` only for a multi-frame table, decided per table.
        case .wavetable: return [.freq]
        case .samplePlay: return [.rate, .gate, .trig, .reset, .position, .length, .pitch]
        case .grain: return [.duration, .position, .rate, .trigger]
        case .pitchShift: return [.input, .pitch]
        case .panLaw: return [.input, .pan]
        case .noise: return [.color]
        // Which input a transport field reads depends on its mode, and a
        // kernel's on the seam phase. Both stay on the recursive path.
        case .transport, .kernel: return []
        }
    }

    /// Whether every entry of `list` is read on every evaluation. A mix sums
    /// all of them; a sequencer reads one step and breakpoints stop at the
    /// segment they are in, so those two stay recursive.
    var eagerList: Bool { kind == .mix }
}

/// Every node a frame is certain to evaluate, children first, root last.
func buildSchedule(_ root: PlanNode) -> [PlanNode] {
    var order = [PlanNode]()
    var seen = Set<Int>()
    func visit(_ node: PlanNode) {
        guard seen.insert(node.slot).inserted else { return }
        for name in node.eagerInputs {
            if let child = node.input(name) { visit(child) }
        }
        if node.eagerList, let list = node.list {
            for child in list { visit(child) }
        }
        order.append(node)
    }
    visit(root)
    return order
}
