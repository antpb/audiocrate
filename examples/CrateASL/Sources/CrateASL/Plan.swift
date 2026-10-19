import Foundation

/// Every input name any ASL builder wires.
///
/// The JavaScript interpreter gives every node's `inputs` object all of these
/// keys so the shape is uniform and the engine can cache the property load.
/// Swift gets the same benefit more directly: a plan node holds a fixed-size
/// array and an input lookup is an integer index, with no hashing and no
/// string comparison anywhere on the audio thread.
enum InputName: Int, CaseIterable {
    case input, a, b, attack, bits, clock, cutoff, decay, delay, drive
    case duration, factor, fall, feedback, freq, gainDb, gate, hits, hold
    case index, length, mix, note, pan, phase, pitch, position, q, rate, ratio
    case record, release, reset, resonance, rise, root, rotation, scale, sidechain
    case source, steps, sustain, threshold, timeSec, trig, trigger, which, width
    case widthSec, windowSec, type, color

    static let byName: [String: InputName] = {
        var map = [String: InputName](minimumCapacity: InputName.allCases.count)
        for name in InputName.allCases { map[String(describing: name)] = name }
        return map
    }()

    static let count = InputName.allCases.count
}

/// Oscillator and LFO shapes, resolved from their strings when the graph
/// compiles rather than compared per sample.
enum Shape {
    static let sine = 0
    static let saw = 1
    static let square = 2
    static let triangle = 3
    static let pulse = 4
    static let varshape = 5
    static let supersquare = 6
    static let harmonic = 7
}

/// A child slot.
///
/// `unowned(unsafe)` rather than a plain reference: reading it emits no
/// retain or release at all, which matters because a graph walk reads one to
/// three of these per node per sample. It is safe because `Plan.nodes` owns
/// every node for the plan's whole life, and a render cannot outlive the plan
/// it is walking.
struct ChildRef {
    unowned(unsafe) var node: PlanNode?
    init(node: PlanNode? = nil) { self.node = node }
}

/// One graph node prepared for evaluation.
///
/// The mirror of `PlanNode` in `asl/compile.ts`, field for field, including
/// the reasons. Node ids in a document come from a counter that spans a whole
/// authoring session, so they are never dense and are useless as array
/// indices. Compiling walks the graph once and hands every distinct node a
/// slot from zero, which is what makes the value cache and the per-node
/// memory flat arrays instead of dictionaries.
///
/// Everything a node needs per sample that can be known earlier is resolved
/// here: modes become integers, tables become arrays, names become strings
/// held on the node.
final class PlanNode {
    /// Dense slot in the value cache and the per-node memory array.
    let slot: Int
    let kind: NodeKind
    /// Compiled children, indexed by `InputName`.
    ///
    /// Unretained raw pointers rather than `[PlanNode?]`. This is read once
    /// per input per node per sample, and an array of class references costs
    /// a bounds check and an ARC retain/release on every one of those. The
    /// nodes are owned for the plan's whole life by `Plan.nodes`, and a plan
    /// outlives every render that walks it, so there is nothing here for ARC
    /// to protect against.
    let inputs: UnsafeMutablePointer<ChildRef>
    /// Each input's child slot, or -1, indexed by `InputName`. Reading a
    /// child's cached value through this touches the child's slot and
    /// nothing else: no object, so no reference count.
    let childSlots: UnsafeMutablePointer<Int>
    var list: [PlanNode]? {
        didSet {
            listSlots?.deallocate()
            listSlots = nil
            listCount = list?.count ?? 0
            guard let list, !list.isEmpty else { return }
            let slots = UnsafeMutablePointer<Int>.allocate(capacity: list.count)
            for (i, child) in list.enumerated() { (slots + i).initialize(to: child.slot) }
            listSlots = slots
        }
    }
    /// `list`'s slots, so a `mix` sums cached values without iterating an
    /// array of class references, which retains and releases every element.
    private(set) var listSlots: UnsafeMutablePointer<Int>?
    private(set) var listCount = 0
    /// A mode, shape, colour or field resolved to an integer. See `planMode`.
    let m: Int
    /// A numeric constant off `params`: window size, max delay, pole count.
    let c: Double
    /// A wavetable or sample, resolved once and never rebuilt per sample.
    /// Float for the same reason the ring buffers are: the reference holds
    /// these in a `Float32Array`, so 0.7 in a document is 0.69999998 in the
    /// table, and interpolating from the wider value is a different curve.
    let table: [Float]
    /// A curve, breakpoint time list, or division table.
    let a: [Double]
    /// The second half of a pair, which is `breakpoints` levels.
    let b: [Double]
    /// A kernel slot, tap id, port or param name. Empty for kinds with none.
    let name: String
    let kernelSlot: String
    /// `range` bounds, read once instead of destructured per sample.
    let rangeMin: Double
    let rangeMax: Double
    /// The source rate of a `samplePlay` box, or 0 to follow the render rate.
    let boxRate: Double
    /// For a `param` node, its index into `Plan.paramNames`; -1 otherwise.
    /// Resolved for the same reason ports are: reading a parameter by name
    /// per sample means hashing a string on the audio thread.
    var paramIndex: Int = -1
    /// For a `meter` or `capture` node, its index into `Plan.tapIds`; -1
    /// otherwise. Resolved here for the reason `paramIndex` and `portIndex`
    /// are: a tap records once per sample, and finding its accumulator by id
    /// meant hashing a string at the sample rate on the audio thread.
    var tapIndex: Int = -1
    /// For `noise` and `random`, this node's rank among the graph's random
    /// nodes in structural order (`randomRanks`), which picks its stream
    /// (Rng.swift). -1 otherwise. Not the slot: slots follow a walk that
    /// visits inputs in dictionary order here and in insertion order in
    /// JavaScript.
    var randomRank: Int = -1
    /// For a `port` node, its index into `Plan.ports`; -1 for anything else.
    ///
    /// Resolved here so reading a live input is an array index at render
    /// time. Looking a port up by name per sample means hashing a string
    /// 48,000 times a second on the audio thread, which is the sort of thing
    /// that is invisible in a browser and a dropout in an AUv3.
    var portIndex: Int = -1

    init(
        slot: Int, kind: NodeKind, m: Int, c: Double, table: [Float], a: [Double], b: [Double],
        name: String, kernelSlot: String, rangeMin: Double, rangeMax: Double, boxRate: Double
    ) {
        self.slot = slot
        self.kind = kind
        self.inputs = .allocate(capacity: InputName.count)
        self.inputs.initialize(repeating: ChildRef(), count: InputName.count)
        self.childSlots = .allocate(capacity: InputName.count)
        self.childSlots.initialize(repeating: -1, count: InputName.count)
        self.m = m
        self.c = c
        self.table = table
        self.a = a
        self.b = b
        self.name = name
        self.kernelSlot = kernelSlot
        self.rangeMin = rangeMin
        self.rangeMax = rangeMax
        self.boxRate = boxRate
    }

    deinit {
        inputs.deallocate()
        childSlots.deallocate()
        listSlots?.deallocate()
    }

    @inline(__always) func input(_ name: InputName) -> PlanNode? {
        inputs[name.rawValue].node
    }

    /// Through the slot table: testing the unowned reference for nil turns
    /// it into a strong one first, which is a retain and a release per test.
    @inline(__always) func has(_ name: InputName) -> Bool {
        childSlots[name.rawValue] >= 0
    }

    @inline(__always) func setInput(_ name: InputName, _ node: PlanNode) {
        inputs[name.rawValue] = ChildRef(node: node)
        childSlots[name.rawValue] = node.slot
    }
}

/// The result of compiling a graph document.
struct Plan {
    let root: PlanNode
    /// Strong references to every node, which is what makes the unretained
    /// pointers in `PlanNode.inputs` safe: the plan owns the graph, and a
    /// render cannot outlive the plan it is walking.
    let nodes: [PlanNode]
    /// How many slots a voice state has to allocate.
    let slotCount: Int
    /// Seam-kernel nodes in discovery order, each appearing once.
    let seams: [PlanNode]
    /// Tap ids this graph records under, sorted.
    let tapIds: [String]
    /// Ring size for each id in `tapIds`, 0 for a meter (which has no ring).
    let tapWindows: [Int]
    /// Whether anything asks which channel it is on.
    let usesLane: Bool
    /// Whether a `param` node reads the main input as a scalar.
    let readsScalarInput: Bool
    /// Each planned node's slot by its document id, so a send (a document
    /// node inside the output) can be found in the plan.
    let slotBySourceId: [Int: Int]
    /// Whether anything draws a random number, which is what stops two
    /// channels fed the same samples from producing the same output.
    let usesRandom: Bool
    /// Every live audio input the graph reads, sorted, `input` included.
    let ports: [String]
    /// Every `param` name the graph reads, sorted. The render path addresses
    /// these by index; the host still writes them by name.
    let paramNames: [String]
}

let mainPortName = "input"

private func planMode(_ node: ASLNodeDocument, kind: NodeKind) -> Int {
    let p = node.params
    switch kind {
    case .osc, .lfo:
        let shape = (kind == .osc ? p["type"]?.string : p["shape"]?.string)
        switch shape {
        case "saw": return Shape.saw
        case "square": return Shape.square
        case "triangle": return Shape.triangle
        case "pulse": return Shape.pulse
        case "varshape": return Shape.varshape
        case "supersquare": return Shape.supersquare
        case "harmonic": return Shape.harmonic
        default: return Shape.sine
        }
    case .clip: return p["mode"]?.string == "hard" ? 1 : 0
    case .rectify: return p["mode"]?.string == "half" ? 1 : 0
    case .compare: return p["mode"]?.string == "lt" ? 1 : 0
    case .svf:
        switch p["mode"]?.string ?? "lowpass" {
        case "highpass": return 1
        case "bandpass": return 2
        default: return 0
        }
    case .logic:
        switch p["mode"]?.string ?? "and" {
        case "or": return 1
        case "xor": return 2
        case "not": return 3
        default: return 0
        }
    case .filterSlope: return (p["mode"]?.string ?? "lowpass") == "highpass" ? 1 : 0
    case .noise:
        switch p["color"]?.string ?? "white" {
        case "pink": return 1
        case "brown": return 2
        case "blue": return 3
        case "violet": return 4
        case "grey": return 5
        default: return 0
        }
    case .panLaw: return (p["channel"]?.string ?? "left") == "right" ? 1 : 0
    case .random: return p["mode"]?.string == "smooth" ? 1 : 0
    case .transport:
        switch p["field"]?.string ?? "beats" {
        case "bars": return 1
        case "bpm": return 2
        case "playing": return 3
        case "phase": return 4
        case "pulse": return 5
        case "seconds": return 6
        case "division": return 7
        case "beatsPerBar": return 8
        case "beatUnit": return 9
        default: return 0
        }
    case .kernel:
        // 1 source, 2 source that goes silent when nothing is bound, 0 seam.
        guard p["mode"]?.string == "source" else { return 0 }
        return p["fallback"]?.string == "silence" ? 2 : 1
    case .port:
        // A fixed channel, or -1 to follow the channel being rendered.
        return Int(p["channel"]?.number ?? -1)
    case .pitchShift:
        return p["unit"]?.string == "st" ? 1 : 0
    case .looper:
        switch p["field"]?.string ?? "audio" {
        case "start": return 1
        case "end": return 2
        default: return 0
        }
    case .pitch:
        switch p["field"]?.string ?? "hz" {
        case "midi": return 1
        case "cents": return 2
        case "gate": return 3
        default: return 0
        }
    case .samplePlay:
        // 1: the cabled gate is the only level. 0: OR the voice gate.
        if case .bool(false) = p["voiceGate"] { return 1 }
        return 0
    default:
        return 0
    }
}

private func planConst(_ node: ASLNodeDocument, kind: NodeKind) -> Double {
    let p = node.params
    switch kind {
    case .capture: return p["windowSize"]?.number ?? 0
    case .delay: return p["maxTimeSec"]?.number ?? 0
    case .reverse: return p["maxTimeSec"]?.number ?? 2
    case .looper: return p["maxTimeSec"]?.number ?? 4
    case .filterSlope: return min(4, max(1, (p["poles"]?.number ?? 2).rounded()))
    case .const: return p["value"]?.number ?? 0
    case .wavetable: return p["frameSize"]?.number ?? 0
    default: return 0
    }
}

private func planTable(
    _ node: ASLNodeDocument,
    kind: NodeKind,
    samples: [String: CrateSampleBox]
) -> (table: [Float], rate: Double) {
    guard kind == .wavetable || kind == .samplePlay || kind == .grain else { return ([], 0) }
    // A box naming a file the caller has already loaded wins over anything
    // inline. This is the live path and the reason a sample never has to be
    // written into the document at all: the table is a reference to an array
    // the host is holding, so compiling a patch with a minute of audio in it
    // costs the same as compiling one with none. See `SampleBox.swift`.
    if let ref = CrateSamples.reference(of: node), let box = samples[ref], !box.isEmpty {
        return (box.samples, box.sampleRate)
    }
    // `floats` rather than `numbers`: a sample box is one value per frame and
    // this runs on every adopt, so the intermediate `[Double]` is worth not
    // building. See `ASLValue.floats`.
    if let box = node.params["box"], let samples = box["samples"]?.floats, !samples.isEmpty {
        return (samples, box["sampleRate"]?.number ?? 0)
    }
    if let table = node.params["table"]?.floats, !table.isEmpty { return (table, 0) }
    return ([], 0)
}

/// Which stream each `noise` and `random` node draws from, by node id:
/// first visit in a depth-first walk from the output, inputs in sorted name
/// order, a `mix` list in order. `randomRanks` in compile.ts, exactly. The
/// graph's shape is the one thing both languages agree on; ids are renumbered
/// by the catalog and minted afresh by each language's flatten.
func randomRanks(_ root: ASLNodeDocument) -> [Int: Int] {
    var ranks = [Int: Int]()
    var seen = Set<Int>()
    func visit(_ node: ASLNodeDocument) {
        guard seen.insert(node.id).inserted else { return }
        if node.kind == "noise" || node.kind == "random" { ranks[node.id] = ranks.count }
        for key in node.inputs.keys.sorted() { visit(node.inputs[key]!) }
        for child in node.list ?? [] { visit(child) }
    }
    visit(root)
    return ranks
}

/// One walk of the document doing every job compiling needs: slot assignment,
/// seam discovery, tap ids, port names, and the questions that decide how a
/// block is rendered.
func buildPlan(
    _ document: ASLGraphDocument,
    samples: [String: CrateSampleBox] = [:]
) throws -> Plan {
    var bySourceId = [Int: PlanNode]()
    var seams = [PlanNode]()
    var portNodes = [PlanNode]()
    var paramNodes = [PlanNode]()
    var paramNameSet = Set<String>()
    var tapIds = Set<String>()
    var tapNodes = [PlanNode]()
    var tapWindows = [String: Int]()
    var ports = Set<String>()
    var slotCount = 0
    var usesLane = false
    var readsScalarInput = false
    var usesRandom = false

    func visit(_ node: ASLNodeDocument) throws -> PlanNode {
        if let existing = bySourceId[node.id] { return existing }
        guard let kind = NodeKind(rawValue: node.kind) else {
            throw ASLCompileError("unknown ASL node kind \"\(node.kind)\"")
        }

        let name: String
        var kernelSlot = ""
        switch kind {
        case .kernel:
            name = ""
            kernelSlot = node.params["slot"]?.string ?? ""
        case .meter, .capture:
            name = node.params["id"]?.string ?? ""
        case .param, .port:
            name = node.params["name"]?.string ?? ""
        default:
            name = ""
        }

        let (table, boxRate) = planTable(node, kind: kind, samples: samples)
        let a: [Double]
        let b: [Double]
        switch kind {
        case .waveshape:
            a = node.params["curve"]?.numbers ?? [-1, 0, 1]
            b = []
        case .breakpoints:
            a = node.params["times"]?.numbers ?? [0, 1]
            b = node.params["levels"]?.numbers ?? [0, 1]
        case .transport:
            a = node.params["divisions"]?.numbers ?? []
            b = []
        case .adsr:
            // Attack, decay, sustain, release. Unlike `dahdsr` these are
            // authored constants rather than graph inputs, so they resolve
            // here with everything else that cannot change per sample.
            a = [
                node.params["a"]?.number ?? 0,
                node.params["d"]?.number ?? 0,
                node.params["s"]?.number ?? 0,
                node.params["r"]?.number ?? 0,
            ]
            b = []
        default:
            a = []
            b = []
        }

        // A `range` bound that is not a finite number is refused, as in
        // compile.ts: the old reading defaulted it to 0 here and to NaN there,
        // and a document that disagrees across interpreters is worse than one
        // that fails to load in both.
        var rangeMin = 0.0
        var rangeMax = 0.0
        if kind == .range {
            guard let lo = node.params["min"]?.number, lo.isFinite,
                  let hi = node.params["max"]?.number, hi.isFinite else {
                throw ASLCompileError(
                    "ASL range node \(node.id): min and max must be finite numbers"
                )
            }
            rangeMin = lo
            rangeMax = hi
        }

        let plan = PlanNode(
            slot: slotCount,
            kind: kind,
            m: planMode(node, kind: kind),
            c: planConst(node, kind: kind),
            table: table,
            a: a,
            b: b,
            name: name,
            kernelSlot: kernelSlot,
            rangeMin: rangeMin,
            rangeMax: rangeMax,
            boxRate: boxRate
        )
        slotCount += 1
        // Registered before the children are visited, so a document that
        // somehow refers back to itself terminates instead of recursing.
        bySourceId[node.id] = plan

        switch kind {
        case .lane: usesLane = true
        case .port:
            ports.insert(name)
            portNodes.append(plan)
            if node.params["channel"]?.number != nil { usesLane = true }
        case .param:
            paramNodes.append(plan)
            paramNameSet.insert(name)
            if name == mainPortName { readsScalarInput = true }
        case .meter, .capture:
            tapIds.insert(name)
            tapNodes.append(plan)
            // A capture's ring is sized by the node that asks for it, so the
            // widest window any node wants is what the voice allocates.
            if kind == .capture {
                tapWindows[name] = max(tapWindows[name] ?? 0, Int(plan.c))
            }
        case .noise, .random: usesRandom = true
        case .kernel: if node.params["mode"]?.string == "seam" { seams.append(plan) }
        default: break
        }

        for (key, child) in node.inputs {
            guard let input = InputName.byName[key] else {
                throw ASLCompileError("unknown ASL input name \"\(key)\" on \(node.kind)")
            }
            plan.setInput(input, try visit(child))
        }
        if let list = node.list {
            var planned = [PlanNode]()
            planned.reserveCapacity(list.count)
            for child in list { planned.append(try visit(child)) }
            plan.list = planned
        }
        return plan
    }

    let root = try visit(document.output)
    if usesRandom {
        for (id, rank) in randomRanks(document.output) { bySourceId[id]?.randomRank = rank }
    }
    let portNames = ports.sorted()
    for node in portNodes {
        node.portIndex = portNames.firstIndex(of: node.name) ?? -1
    }
    let paramNames = paramNameSet.sorted()
    for node in paramNodes {
        node.paramIndex = paramNames.firstIndex(of: node.name) ?? -1
    }
    let sortedTaps = tapIds.sorted()
    for node in tapNodes {
        node.tapIndex = sortedTaps.firstIndex(of: node.name) ?? -1
    }
    return Plan(
        root: root,
        nodes: Array(bySourceId.values),
        slotCount: slotCount,
        seams: seams,
        tapIds: sortedTaps,
        tapWindows: sortedTaps.map { tapWindows[$0] ?? 0 },
        usesLane: usesLane,
        readsScalarInput: readsScalarInput,
        slotBySourceId: bySourceId.mapValues(\.slot),
        usesRandom: usesRandom,
        ports: portNames,
        paramNames: paramNames
    )
}
