import Foundation

/// Turning a sentence into a patch, on a model with a 4,096 token window.
///
/// The browser patcher does this by handing a frontier model a 9,500 token
/// system prompt: the whole rulebook plus all 109 modules with their jacks
/// and parameter ranges. Apple's on-device model has 4,096 tokens for the
/// instructions, the prompt, the schema *and* the reply put together. The
/// rulebook alone is over budget by half, before a single module is listed.
///
/// So the rules do not go in the prompt. They live here, in Swift, and the
/// model is given a shape it cannot fill in wrongly:
///
/// 1. **Which modules.** Slots (source, motion, filter, space, effects), each
///    constrained to a vocabulary drawn from this build's own catalog. The
///    model cannot name a module that does not exist, because the schema does
///    not contain one.
/// 2. **How they connect.** A second session, given only the chosen modules'
///    jacks, returns cables whose endpoints are constrained to those node ids.
///
/// Everything the web skill spends tokens teaching (gain staging, keeping a
/// filter before the output, not patching control into Master, keeping pitch
/// in a musical register) is applied here instead, where it is arithmetic
/// rather than persuasion. A number out of range is clamped, a cable that
/// names a jack the node does not have is dropped, and a patch that would not
/// reach Master gets the chain it was missing.
///
/// The result is that the two halves fail differently: the model can produce
/// a dull patch, and it cannot produce an invalid one.
public enum CrateGen {

    public enum Role: String, Sendable, CaseIterable {
        /// Played from the host's keyboard.
        case instrument
        /// Treats the host's input.
        case insert
        /// Plays itself. No keyboard, no line.
        case generative
    }

    /// `none` is a real choice in every optional slot and has to be in the
    /// vocabulary: a model given only real modules will pick one, and the
    /// patch grows a reverb nobody asked for.
    public static let none = "none"
}

// MARK: - Vocabulary

/// The shortlist the model picks from, filtered against this build's catalog.
///
/// Curated, because "which modules make a good generative source" is an
/// editorial question the catalog cannot answer: `tone` is a source and
/// `oscillator` is a keyboard voice that renders silence without a gate, and
/// nothing in the data says so. Filtered, because an editorial list that
/// names a module this build cannot compile would put it in front of somebody
/// as a choice that then fails.
public struct CrateGenVocabulary: Sendable {

    public let role: CrateGen.Role
    /// What makes the sound.
    public let sources: [String]
    /// A second sound layer, or `none`.
    public let layers: [String]
    /// Tone shaping. Never `none`: something has to sit between a raw source
    /// and the output, and the web skill spends a paragraph saying so.
    public let filters: [String]
    /// Reverb or delay, or `none`.
    public let spaces: [String]
    /// Anything else, in order.
    public let effects: [String]

    /// Every kind the plan can name, which is what the wiring pass and the
    /// tests check against.
    public var allKinds: [String] {
        var seen = Set<String>()
        return (sources + layers + filters + spaces + effects).filter {
            $0 != CrateGen.none && seen.insert($0).inserted
        }
    }

    private static let instrumentSources = ["oscillator", "SynthVoice", "wavetable"]
    private static let generativeSources = ["tone", "noise", "comb", "impulse"]
    /// The modules the lanes are built out of. Not offered as slots: a lane
    /// is an idiom that expands into several of these, and offering the parts
    /// is what produced a clock sitting on the canvas wired to nothing.
    static let laneModuleKinds = [
        "clock", "pulse", "euclidean", "lfo", "randomsmooth",
        "randomstepped", "syncedramp", "adsr", "envfollow",
    ]
    private static let filterKinds = [
        "lowpass", "highpass", "bandpass", "ladder", "svflowpass",
        "onepolelowpass", "comb", "notch",
    ]
    private static let spaceKinds = ["reverb", "delay", "synceddelay", "haas", "autopan"]
    private static let effectKinds = [
        "gain", "limiter", "compressor", "softclip", "bitcrush", "waveshape",
        "ringmod", "stereopan", "width", "tremolo", "pitchshift", "gate",
    ]

    public init(role: CrateGen.Role, catalog: MaterialCatalog) {
        self.role = role
        let usable: ([String]) -> [String] = { kinds in
            kinds.filter { catalog.material($0) != nil && catalog.canCompile($0) }
        }
        // An instrument's source is a voice with note and gate jacks; a
        // generative patch's source has to make sound with nobody playing it,
        // which is the difference between `tone` and `oscillator`. An insert
        // has no source at all: the host's signal is the source.
        switch role {
        case .instrument:
            sources = usable(Self.instrumentSources)
            layers = [CrateGen.none] + usable(Self.instrumentSources + ["tone", "noise"])
        case .generative:
            sources = usable(Self.generativeSources)
            layers = [CrateGen.none] + usable(Self.generativeSources)
        case .insert:
            sources = []
            layers = [CrateGen.none] + usable(Self.generativeSources)
        }
        filters = usable(Self.filterKinds)
        spaces = [CrateGen.none] + usable(Self.spaceKinds)
        effects = usable(Self.effectKinds)
    }
}

// MARK: - The plan

/// What the first session returns: which modules, and the handful of numbers
/// that decide how the patch sits in the ear.
///
/// Plain data rather than a `@Generable` type, because `@Generable` needs
/// FoundationModels and this package has to build and be tested without it.
/// The extension declares the generable mirror and fills one of these in.
public struct CrateGenPlan: Sendable, Equatable {
    public var role: CrateGen.Role
    /// A few words, used as the patch's name.
    public var summary: String
    public var source: String
    public var layer: String
    public var filter: String
    public var space: String
    public var effects: [String]
    /// Where the patch sits in pitch. Applied to whichever chosen module has
    /// a frequency worth setting.
    public var pitchHz: Double
    /// Filter cutoff: the difference between dark and bright.
    public var brightnessHz: Double
    /// How wet the space is.
    public var spaceAmount: Double
    /// Output level before the limiter.
    public var level: Double

    public init(
        role: CrateGen.Role,
        summary: String = "",
        source: String = CrateGen.none,
        layer: String = CrateGen.none,
        filter: String = "lowpass",
        space: String = CrateGen.none,
        effects: [String] = [],
        pitchHz: Double = 220,
        brightnessHz: Double = 1800,
        spaceAmount: Double = 0.25,
        level: Double = 0.2
    ) {
        self.role = role
        self.summary = summary
        self.source = source
        self.layer = layer
        self.filter = filter
        self.space = space
        self.effects = effects
        self.pitchHz = pitchHz
        self.brightnessHz = brightnessHz
        self.spaceAmount = spaceAmount
        self.level = level
    }
}

/// One cable the second session asked for. Endpoints are node ids from the
/// plan; the jacks are checked here rather than constrained by the schema,
/// because a per-node jack list is a different schema per node.
public struct CrateGenCable: Sendable, Equatable {
    public var from: String
    public var fromJack: String
    public var to: String
    public var toJack: String

    public init(from: String, fromJack: String, to: String, toJack: String) {
        self.from = from
        self.fromJack = fromJack
        self.to = to
        self.toJack = toJack
    }
}

// MARK: - Motion

/// A lane of movement, named by what it does rather than by a module.
///
/// This is the piece the first design was missing, and missing it is why the
/// first design could only draw a straight line. A `motion` slot holding one
/// module name has nowhere to say *what that module drives*, so the module
/// was placed on the canvas and connected to nothing.
///
/// A lane is an idiom, and each one expands into the several modules that
/// idiom actually needs. A euclidean pattern is not a module, it is a clock
/// into a euclidean into a pulse; a sampled random is a clock into a sample
/// and hold. Putting that knowledge here rather than in the prompt is the
/// same trade as everywhere else in this file: the model is asked what kind
/// of movement the sound wants, which it can answer, and not how crate
/// spells it, which it cannot.
public enum CrateGenLaneKind: String, Sendable, CaseIterable {
    /// A steady tick. Clock into a pulse.
    case pulse
    /// An off-grid pattern. Clock into a euclidean.
    case euclidean
    /// Slow continuous movement. An LFO.
    case drift
    /// Continuous but unpredictable. Smooth random.
    case random
    /// Unpredictable and held. Stepped random.
    case stepped
    /// A rising ramp locked to the bar.
    case ramp
    /// The sound's own loudness, fed back as control.
    case follower
    /// A shaped swell, repeating. Clock into an envelope.
    case envelope

    /// Whether this lane's signal swings across its whole travel with no
    /// depth control of its own.
    ///
    /// This decides what it is allowed to move, and it is the one "ears" rule
    /// that could not be left to arithmetic alone. A cable into a parameter
    /// is mapped onto that parameter's **entire** declared range, so a
    /// stepped random into a comb's `freq` sweeps 20 Hz to 4 kHz and the
    /// patch is a siren. An LFO, an envelope and a ramp all carry their own
    /// depth, so they move a fraction of the range and stay musical.
    ///
    /// The web skill states this as a paragraph asking the model not to do
    /// it. Here the lane that would do it is simply not offered the jack.
    public var swingsFullScale: Bool {
        switch self {
        // No depth control anywhere in the lane. A smooth random runs 0 to 1
        // whatever you do, a follower runs as far as the sound is loud, and a
        // dahdsr's attack reaches full height however short it is.
        case .random, .stepped, .follower, .pulse, .euclidean, .envelope: return true
        // An LFO carries `amount` and a synced ramp carries `depth`.
        case .drift, .ramp: return false
        }
    }

    /// What a listener notices this lane doing, most first.
    ///
    /// A rhythmic lane wants a parameter where a repeated shape reads as a
    /// rhythm: a level, a wet amount, a filter opening. A slow continuous one
    /// wants somewhere a long movement is audible without being a tremolo.
    /// Picking by lane rather than by one global list is what stops a
    /// percussive envelope from being parked on a reverb's damping, where
    /// nobody would hear it.
    public var preferredParams: [String] {
        switch self {
        case .pulse, .euclidean, .envelope:
            // Bounded parameters only: these lanes reach full height, and a
            // full-height swing on a frequency jack is the siren of 9.3.
            return ["gain", "mix", "amount", "resonance", "feedback", "width"]
        case .drift, .ramp:
            return ["cutoff", "pan", "width", "mix", "freq", "resonance"]
        case .random, .stepped:
            return ["mix", "gain", "pan", "width", "amount"]
        case .follower:
            return ["mix", "cutoff", "gain", "feedback"]
        }
    }

    /// What the lane's own rate number means, for the instructions.
    public var hint: String {
        switch self {
        case .pulse: return "a steady tick"
        case .euclidean: return "an off-grid repeating pattern"
        case .drift: return "slow continuous movement"
        case .random: return "smooth unpredictable movement"
        case .stepped: return "unpredictable and held between jumps"
        case .ramp: return "a rise that resets on the bar"
        case .follower: return "follows how loud the sound is"
        case .envelope: return "a repeating swell"
        }
    }
}

/// One lane of movement the model asked for.
public struct CrateGenLane: Sendable, Equatable {
    public var kind: CrateGenLaneKind
    /// How fast, in hertz. A lane at 0.1 and a lane at 6 in the same patch is
    /// what stops it repeating on one bar.
    public var rateHz: Double
    /// How far it moves what it is patched into, 0 to 1.
    public var depth: Double

    public init(kind: CrateGenLaneKind, rateHz: Double = 1, depth: Double = 0.5) {
        self.kind = kind
        self.rateHz = rateHz
        self.depth = depth
    }
}

/// A lane pointed at something it moves.
///
/// `target` is a single string, `"filter.cutoff"`, rather than a node and a
/// jack chosen separately. That is deliberate and it is the second reason the
/// first design failed: choosing a node from one list and a jack from another
/// makes most combinations invalid (a `tone` has no `cutoff`), so the model
/// spent its answers on pairs that were then dropped. A flat list of the
/// pairs that exist cannot be got wrong.
public struct CrateGenRoute: Sendable, Equatable {
    public var lane: String
    public var target: String

    public init(lane: String, target: String) {
        self.lane = lane
        self.target = target
    }
}

// MARK: - Building


public enum CrateGenBuilder {

    /// The nodes a plan asks for, with their numbers already applied.
    ///
    /// Ids are the slot names (`source`, `filter`, `space`) rather than
    /// minted hex, because they go into the wiring session's schema as the
    /// values the model picks between: `filter` is a word it can reason
    /// about and `a3f19c` is not. They are unique by construction, which is
    /// the only thing a patch document needs of them.
    public static func nodes(for plan: CrateGenPlan, catalog: MaterialCatalog) -> [CratePatchNode] {
        var nodes = [CratePatchNode]()

        switch plan.role {
        case .instrument:
            nodes.append(CratePatchNode(id: "keys", kind: catalog.io.keyboard))
        case .insert:
            nodes.append(CratePatchNode(id: "line", kind: catalog.io.line))
        case .generative:
            // Neither. A generative patch that grows a keyboard is an
            // instrument nobody is playing, which is silence.
            break
        }

        if plan.source != CrateGen.none, catalog.material(plan.source) != nil {
            nodes.append(node("source", plan.source, plan, catalog))
        }
        if plan.layer != CrateGen.none, catalog.material(plan.layer) != nil {
            nodes.append(node("layer", plan.layer, plan, catalog))
        }
        if catalog.material(plan.filter) != nil {
            nodes.append(node("filter", plan.filter, plan, catalog))
        }
        for (index, kind) in plan.effects.enumerated() where catalog.material(kind) != nil {
            nodes.append(node("fx\(index + 1)", kind, plan, catalog))
        }
        if plan.space != CrateGen.none, catalog.material(plan.space) != nil {
            nodes.append(node("space", plan.space, plan, catalog))
        }
        // A limiter before the output, always. The web skill asks the model
        // for one and the model sometimes forgets; here it costs nothing and
        // is the difference between a patch that is loud and one that clips.
        if catalog.material("limiter") != nil, !plan.effects.contains("limiter") {
            nodes.append(node("out", "limiter", plan, catalog))
        }
        nodes.append(CratePatchNode(id: "master", kind: catalog.io.master))
        return nodes
    }

    /// One node with the plan's numbers mapped onto whichever of its
    /// parameters they belong to.
    ///
    /// This is where the "ears" half of the web skill lives. It is a table
    /// rather than a paragraph, and every value is clamped into the
    /// descriptor's own range on the way in, so an out-of-register pitch or a
    /// runaway feedback is not a thing the model can ask for.
    private static func node(
        _ id: String,
        _ kind: String,
        _ plan: CrateGenPlan,
        _ catalog: MaterialCatalog
    ) -> CratePatchNode {
        var params = [String: Double]()
        guard let material = catalog.material(kind) else {
            return CratePatchNode(id: id, kind: kind)
        }

        func set(_ name: String, _ value: Double, floor: Double? = nil, ceiling: Double? = nil) {
            guard let descriptor = material.param(name) else { return }
            var bounded = value
            if let floor { bounded = Swift.max(bounded, floor) }
            if let ceiling { bounded = Swift.min(bounded, ceiling) }
            bounded = Swift.min(descriptor.max, Swift.max(descriptor.min, bounded))
            params[name] = CrateFlatten.quantize(descriptor, bounded)
        }

        // Pitch, where the module has a pitch. A comb's resonant frequency and
        // a tone's frequency are the same musical decision.
        set("freq", plan.pitchHz, floor: 80, ceiling: 700)
        // Brightness, and never the full 20 kHz travel: the web skill's
        // "cutoff 900..2800" advice, enforced.
        set("cutoff", plan.brightnessHz, floor: 200, ceiling: 6000)
        set("q", 0.9, ceiling: 1.2)
        set("resonance", 0.35, ceiling: 0.7)
        // Space. A reverb at full mix and a delay at full feedback are the two
        // ways a generated patch turns into mud.
        set("mix", plan.spaceAmount, ceiling: kind == "delay" || kind == "synceddelay" ? 0.35 : 0.4)
        set("decay", 0.7, floor: 0.4, ceiling: 0.85)
        set("feedback", 0.35, ceiling: 0.6)
        set("size", 1.0)
        // Level. Stacked sources add, so each one sits low.
        set("gain", plan.level, ceiling: 0.6)
        set("amount", 0.4, ceiling: 0.6)
        if kind == "limiter" { set("threshold", 0.85) }
        if kind == "noise" { set("cutoff", plan.brightnessHz, floor: 400, ceiling: 3500) }

        return CratePatchNode(id: id, kind: kind, params: params)
    }

    // MARK: Lanes

    /// The modules one lane needs, and where its signal comes out.
    ///
    /// Ids are prefixed with the lane's own name so two lanes of the same
    /// kind do not collide, and so a person reading the canvas afterwards can
    /// see which clock belongs to which pattern.
    public static func laneNodes(
        _ lane: CrateGenLane,
        index: Int,
        catalog: MaterialCatalog
    ) -> (nodes: [CratePatchNode], cables: [CratePatchConnection], outlet: (node: String, jack: String))? {
        let prefix = "m\(index + 1)"
        let rate = Swift.min(Swift.max(lane.rateHz, 0.02), 16)

        func make(_ suffix: String, _ kind: String, _ params: [String: Double]) -> CratePatchNode? {
            guard let material = catalog.material(kind), catalog.canCompile(kind) else { return nil }
            var bounded = [String: Double]()
            for (name, value) in params {
                guard let descriptor = material.param(name) else { continue }
                bounded[name] = CrateFlatten.quantize(
                    descriptor, Swift.min(descriptor.max, Swift.max(descriptor.min, value))
                )
            }
            return CratePatchNode(id: "\(prefix)\(suffix)", kind: kind, params: bounded)
        }

        // Every lane ends in a **continuous** signal, and the event-driven
        // ones shape their own trigger to get there.
        //
        // This is the correction to the first version, which routed a clock's
        // output straight at whatever parameter was free. A clock is a
        // one-sample impulse, not a control voltage: mapped onto a gain it
        // leaves the gain at its minimum except for the single sample of the
        // tick, so the patch is silent between ticks. And crate has almost no
        // legitimate destination for a bare trigger outside a lane's own
        // chain, so there was nowhere correct for it to go.
        //
        // A rhythmic lane is therefore clock into pulse into an envelope,
        // which is how somebody would patch it by hand: the pulse gives the
        // trigger a width, and the envelope gives it a shape.
        switch lane.kind {
        case .pulse:
            guard let clock = make("clk", "clock", ["freq": rate]),
                  let pulse = make("pls", "pulse", ["widthSec": 0.01]),
                  let env = make("env", "dahdsr", [
                      "attack": 0.005, "hold": 0.01, "decay": 0.1,
                      "sustain": 0, "release": 0.08,
                  ])
            else { return nil }
            return (
                [clock, pulse, env],
                [
                    CratePatchConnection(source: clock.id, sourceOutput: "cv", target: pulse.id, targetInput: "input"),
                    // Into the envelope's `input`, and the module is a dahdsr
                    // rather than an adsr for a reason that is invisible until
                    // you listen: an adsr is gated by `gate`, which is a voice
                    // jack and not a parameter, so `flattenPatch` drops a cable
                    // into it and the envelope never opens. A dahdsr is
                    // triggered by a signal, which is what a patch with nobody
                    // playing it has. This is rule 11b of the web skill, and
                    // the first version of this file broke it.
                    CratePatchConnection(source: pulse.id, sourceOutput: "cv", target: env.id, targetInput: "input"),
                ],
                (env.id, "cv")
            )

        case .euclidean:
            // Sixteen steps with a hit count that is not a divisor of it, so
            // the pattern lands off the grid rather than on every fourth beat.
            let hits = Swift.max(2, Swift.min(11, Int((lane.depth * 9).rounded()) + 3))
            guard let clock = make("clk", "clock", ["freq": rate]),
                  let euclid = make("euc", "euclidean", ["steps": 16, "hits": Double(hits), "rotation": 0]),
                  let pulse = make("pls", "pulse", ["widthSec": 0.02]),
                  let env = make("env", "dahdsr", [
                      "attack": 0.005, "hold": 0.02, "decay": 0.16,
                      "sustain": 0, "release": 0.12,
                  ])
            else { return nil }
            return (
                [clock, euclid, pulse, env],
                [
                    CratePatchConnection(source: clock.id, sourceOutput: "cv", target: euclid.id, targetInput: "input"),
                    CratePatchConnection(source: euclid.id, sourceOutput: "audio", target: pulse.id, targetInput: "input"),
                    CratePatchConnection(source: pulse.id, sourceOutput: "cv", target: env.id, targetInput: "input"),
                ],
                (env.id, "cv")
            )

        case .envelope:
            // The same chain with a slower shape: a swell rather than a tick.
            guard let clock = make("clk", "clock", ["freq": rate]),
                  let pulse = make("pls", "pulse", ["widthSec": 0.15]),
                  let env = make("env", "dahdsr", [
                      "attack": 0.18, "hold": 0.05, "decay": 0.3,
                      "sustain": 0.35, "release": 0.5,
                  ])
            else { return nil }
            return (
                [clock, pulse, env],
                [
                    CratePatchConnection(source: clock.id, sourceOutput: "cv", target: pulse.id, targetInput: "input"),
                    CratePatchConnection(source: pulse.id, sourceOutput: "cv", target: env.id, targetInput: "input"),
                ],
                (env.id, "cv")
            )

        case .drift:
            guard let lfo = make("lfo", "lfo", ["rate": rate, "amount": lane.depth]) else { return nil }
            return ([lfo], [], (lfo.id, "cv"))

        case .random:
            guard let node = make("rnd", "randomsmooth", ["freq": rate]) else { return nil }
            return ([node], [], (node.id, "audio"))

        case .stepped:
            guard let node = make("stp", "randomstepped", ["freq": rate]) else { return nil }
            return ([node], [], (node.id, "audio"))

        case .ramp:
            guard let node = make("rmp", "syncedramp", ["depth": lane.depth]) else { return nil }
            return ([node], [], (node.id, "cv"))

        case .follower:
            // Wired to the audio path by the caller, which is the only lane
            // that reads the sound rather than running beside it.
            guard let node = make("fol", "envfollow", ["attack": 0.01, "release": 0.2]) else { return nil }
            return ([node], [], (node.id, "cv"))
        }
    }

    /// Every parameter a lane could be pointed at, as `node.param`.
    ///
    /// Flat pairs rather than a node list and a jack list, because separate
    /// lists make most combinations invalid and the model spends its answer
    /// on pairs that are then dropped. Ordered by how much a listener would
    /// notice the movement, and capped, because this is the one part of the
    /// wiring prompt that grows with the patch.
    /// Parameters whose whole range is too wide for a signal with no depth
    /// control: moving one across its travel is a siren rather than a sweep.
    static let wideRangeParams: Set<String> = ["freq", "cutoff", "timeSec", "rate", "damp", "pitch"]

    public static func routingTargets(
        _ nodes: [CratePatchNode],
        catalog: MaterialCatalog,
        limit: Int = 40,
        forLane lane: CrateGenLaneKind? = nil
    ) -> [String] {
        // The parameters worth moving, most audible first. A cutoff sweep is
        // the sound of a patch breathing; a reverb's damping is not. A lane
        // that has an opinion of its own puts its own list in front.
        let priority = (lane?.preferredParams ?? []) + [
            "cutoff", "freq", "gain", "mix", "resonance", "q", "amount",
            "feedback", "pitch", "width", "pan", "decay", "rate", "size",
            "threshold", "depth", "damp",
        ]
        var scored = [(rank: Int, target: String)]()
        for node in nodes {
            // A lane pointed at another lane's clock is a patch nobody can
            // follow, and Master has no parameters at all.
            if node.id.hasPrefix("m") && node.id.dropFirst().first?.isNumber == true { continue }
            guard let material = catalog.material(node.kind) else { continue }
            for name in material.paramOrder where !material.isAudioInlet(name) {
                // note, gate and velocity are voice jacks: a cable into one
                // marks the patch as an instrument, which is a different
                // patch, not a modulation.
                if ["note", "gate", "velocity", "trig"].contains(name) { continue }
                if lane?.swingsFullScale == true, Self.wideRangeParams.contains(name) { continue }
                // A full-scale envelope on a source's gain replaces the
                // carrier. Between hits the tone is digital zero, and if
                // every source is parked that way the patch only ticks, or
                // is silent on an instrument AU that waits for a note.
                if lane?.swingsFullScale == true, name == "gain", material.audioInputs.isEmpty { continue }
                let rank = priority.firstIndex(of: name) ?? priority.count
                scored.append((rank, "\(node.id).\(name)"))
            }
        }
        return scored
            .sorted { $0.rank == $1.rank ? $0.target < $1.target : $0.rank < $1.rank }
            .prefix(limit)
            .map(\.target)
    }

    // MARK: The wiring pass


    /// The jacks of the chosen modules, for the wiring session's instructions.
    ///
    /// One line per node and nothing else: no parameter ranges, no categories,
    /// no prose. About a hundred tokens for a whole patch, which is what makes
    /// a second session affordable.
    public static func jackBrief(_ nodes: [CratePatchNode], catalog: MaterialCatalog) -> String {
        nodes.map { node in
            let jacks = catalog.jacks(node.kind)
            let ins = (jacks?.inputLabels ?? []).joined(separator: ",")
            let outs = (jacks?.outputLabels ?? []).joined(separator: ",")
            return "\(node.id) (\(node.kind)): in \(ins.isEmpty ? "-" : ins) | out \(outs.isEmpty ? "-" : outs)"
        }
        .joined(separator: "\n")
    }

    /// Every outlet name across the chosen nodes, for the wiring schema.
    public static func outletVocabulary(_ nodes: [CratePatchNode], catalog: MaterialCatalog) -> [String] {
        ordered(nodes.flatMap { catalog.jacks($0.kind)?.outputs ?? [] })
    }

    /// Every inlet name across the chosen nodes, for the wiring schema.
    public static func inletVocabulary(_ nodes: [CratePatchNode], catalog: MaterialCatalog) -> [String] {
        ordered(nodes.flatMap { catalog.jacks($0.kind)?.inputs ?? [] })
    }

    private static func ordered(_ names: [String]) -> [String] {
        var seen = Set<String>()
        return names.filter { seen.insert($0).inserted }
    }

    // MARK: Assembly

    /// The patch: an audio path, however many lanes of movement, and the
    /// routing between them.
    ///
    /// The two paths are built separately because they are different kinds of
    /// thing. The audio path is a chain and Swift can always build a correct
    /// one. The control path is a composition, and it is the part worth
    /// asking a model about: which lane moves what, and how fast.
    ///
    /// Repairs rather than refuses, because the alternative is a button that
    /// sometimes does nothing. A route naming a parameter that is not there is
    /// dropped with a reason; a patch whose audio does not reach the output
    /// has its chain rebuilt in slot order, keeping every lane and every route
    /// that was valid.
    public static func assemble(
        plan: CrateGenPlan,
        lanes: [CrateGenLane] = [],
        routes: [CrateGenRoute] = [],
        cables: [CrateGenCable] = [],
        catalog: MaterialCatalog
    ) -> (patch: CratePatch, notes: [String]) {
        var nodes = nodes(for: plan, catalog: catalog)
        var notes = [String]()
        var connections = [CratePatchConnection]()

        // Lanes first: the routing vocabulary is built from the node list and
        // has to be able to name them.
        var laneOutlets = [String: (node: String, jack: String)]()
        for (index, lane) in lanes.enumerated() {
            guard let built = laneNodes(lane, index: index, catalog: catalog) else {
                notes.append("could not build a \(lane.kind.rawValue) lane")
                continue
            }
            nodes.append(contentsOf: built.nodes)
            connections.append(contentsOf: built.cables)
            laneOutlets["lane\(index + 1)"] = built.outlet
        }

        let byId = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        // The audio chain. Built by Swift rather than asked for: a chain is
        // the one part of a patch that has a right answer.
        connections.append(contentsOf: fallbackChain(nodes, catalog: catalog))

        // A follower reads the sound, so it is the one lane that has to be
        // told where the sound is.
        for (index, lane) in lanes.enumerated() where lane.kind == .follower {
            guard let outlet = laneOutlets["lane\(index + 1)"],
                  let follower = byId[outlet.node],
                  let tap = nodes.first(where: { $0.id == "filter" }) ?? nodes.first(where: { $0.id == "source" }),
                  let tapOut = audioOutlet(of: tap, catalog: catalog),
                  let inlet = catalog.material(follower.kind)?.audioInputs.first
            else { continue }
            connections.append(
                CratePatchConnection(
                    source: tap.id, sourceOutput: tapOut, target: follower.id, targetInput: inlet
                )
            )
        }

        // The routing: this is the composition.
        let everything = Set(routingTargets(nodes, catalog: catalog, limit: .max))
        for route in routes {
            guard let outlet = laneOutlets[route.lane] else {
                notes.append("no lane called \(route.lane)")
                continue
            }
            guard everything.contains(route.target) else {
                notes.append("nothing called \(route.target) to move")
                continue
            }
            // A lane with no depth of its own may not drive a jack whose full
            // range is a siren. Dropped rather than scaled: the lane is
            // re-pointed at something bounded below, which is a patch that
            // moves instead of one that screams.
            let index = Int(route.lane.dropFirst("lane".count)) ?? 0
            if index >= 1, index <= lanes.count,
               lanes[index - 1].kind.swingsFullScale,
               let param = route.target.split(separator: ".", maxSplits: 1).last,
               Self.wideRangeParams.contains(String(param)) {
                notes.append("\(route.lane) swings too wide for \(route.target), so it moves something else")
                continue
            }
            let parts = route.target.split(separator: ".", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            let connection = CratePatchConnection(
                source: outlet.node, sourceOutput: outlet.jack,
                target: parts[0], targetInput: parts[1]
            )
            if !connections.contains(connection) { connections.append(connection) }
        }

        // Anything else the model asked for, checked the same way.
        for cable in cables {
            guard let source = byId[cable.from], let target = byId[cable.to], cable.from != cable.to else {
                notes.append("dropped a cable between nodes that are not in the patch")
                continue
            }
            guard catalog.jacks(source.kind)?.outputs.contains(cable.fromJack) == true else {
                notes.append("\(source.id) (\(source.kind)) has no outlet \(cable.fromJack)")
                continue
            }
            guard catalog.jacks(target.kind)?.inputs.contains(cable.toJack) == true else {
                notes.append("\(target.id) (\(target.kind)) has no inlet \(cable.toJack)")
                continue
            }
            let connection = CratePatchConnection(
                source: cable.from, sourceOutput: cable.fromJack,
                target: cable.to, targetInput: cable.toJack
            )
            if !connections.contains(connection) { connections.append(connection) }
        }

        var patch = CratePatch(nodes: nodes, connections: connections, transport: CratePatchTransport())

        // A lane nothing listens to is a module sitting on the canvas doing
        // nothing, which is exactly the defect this redesign exists to fix.
        // Rather than leave it there, point it at the most audible parameter
        // still unmoved.
        patch = attachIdleLanes(
            patch, lanes: lanes, laneOutlets: laneOutlets, catalog: catalog, notes: &notes
        )

        // A lane that reads the sound and then moves something the sound
        // passes through on the way in is a loop, and a flattened graph
        // cannot express one. The follower is the lane that can do this, but
        // the check is general because the next one might too.
        patch = breakCycles(patch, catalog: catalog, notes: &notes)

        if !reachesMaster(patch, catalog: catalog) {
            patch.connections = fallbackChain(nodes, catalog: catalog)
                + patch.connections.filter { isControlCable($0, in: patch, catalog: catalog) }
            notes.append("the wiring did not reach the output, so the signal path was rebuilt in order")
        }
        patch = CratePatchLayout.apply(patch)
        return (patch, notes)
    }

    /// Drops control cables that close a loop.
    ///
    /// Audio cables are kept whatever they do: a chain Swift built cannot
    /// contain a cycle, and if one ever did that is a bug worth seeing rather
    /// than one to paper over. Control cables are the ones that can reach
    /// backwards, because a follower reads the audio path and then moves part
    /// of it.
    private static func breakCycles(
        _ patch: CratePatch,
        catalog: MaterialCatalog,
        notes: inout [String]
    ) -> CratePatch {
        var patch = patch
        var edges = [String: Set<String>]()
        var kept = [CratePatchConnection]()

        func reaches(_ from: String, _ target: String) -> Bool {
            var seen = Set<String>()
            var stack = [from]
            while let id = stack.popLast() {
                if id == target { return true }
                guard seen.insert(id).inserted else { continue }
                stack.append(contentsOf: edges[id] ?? [])
            }
            return false
        }

        // Audio first, so a control cable is judged against the finished
        // signal path rather than against however much of it happened to be
        // added before it.
        let audio = patch.connections.filter { !isControlCable($0, in: patch, catalog: catalog) }
        let control = patch.connections.filter { isControlCable($0, in: patch, catalog: catalog) }
        for cable in audio {
            edges[cable.source, default: []].insert(cable.target)
            kept.append(cable)
        }
        for cable in control {
            if reaches(cable.target, cable.source) {
                notes.append(
                    "\(cable.source) would have fed back into itself through \(cable.target), so that cable was dropped"
                )
                continue
            }
            edges[cable.source, default: []].insert(cable.target)
            kept.append(cable)
        }
        patch.connections = kept
        return patch
    }

    /// Points a lane that drives nothing at something worth driving.
    ///
    /// The model can return fewer routes than lanes, and a lane with no route
    /// is the straight-line failure wearing a different hat: the modules are
    /// on the canvas and the patch does not move. One route each is the floor,
    /// and a lane already pointed somewhere is left alone.
    private static func attachIdleLanes(
        _ patch: CratePatch,
        lanes: [CrateGenLane],
        laneOutlets: [String: (node: String, jack: String)],
        catalog: MaterialCatalog,
        notes: inout [String]
    ) -> CratePatch {
        var patch = patch
        var taken = Set(patch.connections.map { "\($0.target).\($0.targetInput)" })

        for key in laneOutlets.keys.sorted() {
            guard let outlet = laneOutlets[key] else { continue }
            let index = Int(key.dropFirst("lane".count)) ?? 0
            let kind = (index >= 1 && index <= lanes.count) ? lanes[index - 1].kind : nil
            var targets = routingTargets(patch.nodes, catalog: catalog, limit: .max, forLane: kind)
            if kind == .follower {
                // It reads the audio path, so it may only move what comes
                // after the point it reads: anything earlier is a loop.
                let downstream = Set(["fx1", "fx2", "fx3", "space", "out"])
                targets = targets.filter { downstream.contains($0.split(separator: ".").first.map(String.init) ?? "") }
            }
            let driving = patch.connections.contains { $0.source == outlet.node && $0.sourceOutput == outlet.jack }
            if driving { continue }
            guard let target = targets.first(where: { !taken.contains($0) }) else { continue }
            let parts = target.split(separator: ".", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            patch.connections.append(
                CratePatchConnection(
                    source: outlet.node, sourceOutput: outlet.jack,
                    target: parts[0], targetInput: parts[1]
                )
            )
            taken.insert(target)
            notes.append("\(key) was not pointed at anything, so it moves \(target)")
        }
        return patch
    }

    /// A cable that lands on a parameter rather than on an audio inlet, which
    /// is the half worth keeping when the signal path is rebuilt.
    private static func isControlCable(
        _ connection: CratePatchConnection,
        in patch: CratePatch,
        catalog: MaterialCatalog
    ) -> Bool {
        guard let target = patch.node(connection.target),
              let material = catalog.material(target.kind)
        else { return false }
        return !material.isAudioInlet(connection.targetInput) && material.param(connection.targetInput) != nil
    }

    /// Whether anything audible arrives at Master.
    private static func reachesMaster(_ patch: CratePatch, catalog: MaterialCatalog) -> Bool {
        guard let master = patch.nodes.first(where: { $0.kind == catalog.io.master }) else { return false }
        guard !patch.sources(into: master.id, inlet: "input").isEmpty else { return false }
        // Reaching Master from a node that nothing feeds is a cable to
        // silence, so the walk goes back to a source: a node with no audio
        // inlets, or the host tool.
        var seen = Set<String>()
        var stack = patch.sources(into: master.id, inlet: "input").map(\.source)
        while let id = stack.popLast() {
            guard seen.insert(id).inserted, let node = patch.node(id) else { continue }
            if catalog.isHostTool(node.kind) { return true }
            guard let material = catalog.material(node.kind) else { continue }
            if material.audioInputs.isEmpty { return true }
            stack.append(contentsOf: patch.connections.filter { $0.target == id }.map(\.source))
        }
        return false
    }

    /// Source through filter, effects and space to the output, in slot order.
    public static func fallbackChain(
        _ nodes: [CratePatchNode],
        catalog: MaterialCatalog
    ) -> [CratePatchConnection] {
        // A layer is a second source, not a link in the chain: it joins the
        // path further down and leaves the main run alone, which is what
        // makes two stacked sources a chord rather than a series of filters.
        let order = ["line", "source", "filter", "fx1", "fx2", "fx3", "space", "out", "master"]
        let present = order.compactMap { id in nodes.first { $0.id == id } }
        var chain = [CratePatchConnection]()

        for (index, node) in present.enumerated() where index > 0 {
            let previous = present[index - 1]
            guard let outlet = audioOutlet(of: previous, catalog: catalog),
                  let inlet = audioInlet(of: node, catalog: catalog)
            else { continue }
            chain.append(
                CratePatchConnection(
                    source: previous.id, sourceOutput: outlet,
                    target: node.id, targetInput: inlet
                )
            )
        }

        // The layer stacks onto whatever the source feeds, so the two sum
        // into one filter rather than one passing through the other.
        if let layer = nodes.first(where: { $0.id == "layer" }),
           let outlet = audioOutlet(of: layer, catalog: catalog),
           let target = present.first(where: { $0.id != "line" && $0.id != "source" }),
           let inlet = audioInlet(of: target, catalog: catalog) {
            chain.append(
                CratePatchConnection(
                    source: layer.id, sourceOutput: outlet, target: target.id, targetInput: inlet
                )
            )
        }
        chain.append(contentsOf: voiceCables(nodes, catalog: catalog))
        return chain
    }

    /// Keyboard into every note jack in the patch. Without these an
    /// instrument is an instrument in name only: the role is detected from
    /// exactly this cable.
    private static func voiceCables(
        _ nodes: [CratePatchNode],
        catalog: MaterialCatalog
    ) -> [CratePatchConnection] {
        guard let keys = nodes.first(where: { $0.kind == catalog.io.keyboard }) else { return [] }
        var cables = [CratePatchConnection]()
        for node in nodes where node.id != keys.id {
            guard let inputs = catalog.jacks(node.kind)?.inputs else { continue }
            if inputs.contains("note") {
                cables.append(CratePatchConnection(source: keys.id, sourceOutput: "cv", target: node.id, targetInput: "note"))
            }
            if inputs.contains("gate") {
                cables.append(CratePatchConnection(source: keys.id, sourceOutput: "gate", target: node.id, targetInput: "gate"))
            }
        }
        return cables
    }

    /// The cables worth keeping when the audio path is rebuilt: the ones that
    /// land on a parameter rather than on an audio inlet. Those are the
    /// modulation the wiring pass exists to invent, and they are still valid
    /// even when the signal path was not.
    private static func modulationOnly(
        _ connections: [CratePatchConnection],
        catalog: MaterialCatalog,
        nodes: [CratePatchNode]
    ) -> [CratePatchConnection] {
        let byId = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
        return connections.filter { connection in
            guard let target = byId[connection.target] else { return false }
            if catalog.isHostTool(target.kind) { return false }
            guard let material = catalog.material(target.kind) else { return false }
            return !material.isAudioInlet(connection.targetInput)
                && material.param(connection.targetInput) != nil
        }
    }

    private static func audioInlet(of node: CratePatchNode, catalog: MaterialCatalog) -> String? {
        if catalog.isHostTool(node.kind) {
            return catalog.jacks(node.kind)?.inputs.first { $0 == "input" }
        }
        guard let material = catalog.material(node.kind) else { return nil }
        return material.audioInputs.contains("input") ? "input" : material.audioInputs.first
    }

    private static func audioOutlet(of node: CratePatchNode, catalog: MaterialCatalog) -> String? {
        guard let outputs = catalog.jacks(node.kind)?.outputs else { return nil }
        return outputs.contains("audio") ? "audio" : outputs.first
    }
}

// MARK: - Layout

/// Left to right by depth, the way the web patcher lays out a generated
/// patch (`layoutPatch.ts`). Sources at the left, the output at the right,
/// one row per node that shares a column.
public enum CratePatchLayout {
    static let column: Double = 220
    static let row: Double = 150
    static let originX: Double = 40
    static let originY: Double = 40

    public static func apply(_ patch: CratePatch) -> CratePatch {
        var patch = patch
        var depth = [String: Int]()

        func visit(_ id: String, _ seen: Set<String>) -> Int {
            if let cached = depth[id] { return cached }
            if seen.contains(id) { return 0 }
            var seen = seen
            seen.insert(id)
            let parents = patch.connections.filter { $0.target == id }.map(\.source)
            let value = parents.isEmpty ? 0 : (parents.map { visit($0, seen) }.max() ?? 0) + 1
            depth[id] = value
            return value
        }
        for node in patch.nodes { _ = visit(node.id, []) }

        var rows = [Int: Int]()
        patch.nodes = patch.nodes.map { node in
            var node = node
            let column = depth[node.id] ?? 0
            let row = rows[column] ?? 0
            rows[column] = row + 1
            node.x = originX + Double(column) * Self.column
            node.y = originY + Double(row) * Self.row
            return node
        }
        return patch
    }
}

// MARK: - Checking

/// What is wrong with a patch, in the words the editor shows.
///
/// The Swift half of `validateGeneratedPatch.ts`, against the real catalog
/// rather than a snapshot of it. Kept separate from `CrateFlatten`, which
/// answers a different question: flatten refuses a patch it cannot lower,
/// and this says what a person would have to change.
public enum CratePatchCheck {

    public struct Result: Sendable {
        public var errors: [String]
        public var warnings: [String]
        public var ok: Bool { errors.isEmpty }
    }

    public static func validate(_ patch: CratePatch, catalog: MaterialCatalog) -> Result {
        var errors = [String]()
        var warnings = [String]()

        if patch.nodes.isEmpty { errors.append("the patch has no nodes") }
        if Set(patch.nodes.map(\.id)).count != patch.nodes.count {
            errors.append("node ids must be unique")
        }
        let masters = patch.nodes.filter { $0.kind == catalog.io.master }
        if masters.count != 1 {
            errors.append(masters.isEmpty ? "the patch has no Master" : "the patch has \(masters.count) Masters")
        }

        let byId = Dictionary(patch.nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for node in patch.nodes {
            if catalog.isHostTool(node.kind) { continue }
            guard let material = catalog.material(node.kind) else {
                if let kernel = catalog.kernel(node.kind) {
                    warnings.append("\(node.id) is \(kernel.label), which \(kernel.reason)")
                } else {
                    errors.append("unknown kind \"\(node.kind)\" on node \(node.id)")
                }
                continue
            }
            if !catalog.canCompile(node.kind) {
                errors.append("\(node.id) (\(node.kind)) cannot run in this build")
            }
            for name in node.params.keys where material.param(name) == nil {
                warnings.append("\(node.id) has an unknown parameter \"\(name)\"")
            }
        }

        for connection in patch.connections {
            guard let source = byId[connection.source] else {
                errors.append("a cable comes from \"\(connection.source)\", which is not in the patch")
                continue
            }
            guard let target = byId[connection.target] else {
                errors.append("a cable goes to \"\(connection.target)\", which is not in the patch")
                continue
            }
            if let outs = catalog.jacks(source.kind)?.outputs, !outs.contains(connection.sourceOutput) {
                errors.append("\(source.id) has no outlet \"\(connection.sourceOutput)\"")
            }
            if let ins = catalog.jacks(target.kind)?.inputs, !ins.contains(connection.targetInput) {
                errors.append("\(target.id) has no inlet \"\(connection.targetInput)\"")
            }
        }

        if let master = masters.first, patch.sources(into: master.id, inlet: "input").isEmpty {
            errors.append("nothing is patched into Master, so the patch would be silent")
        }
        return Result(errors: errors, warnings: warnings)
    }
}

// MARK: - Changing a patch

/// One edit the model asked for.
///
/// Change is expressed as operations on the existing patch rather than as a
/// regenerated patch, for three reasons. It is far cheaper: a rewrite has to
/// send the whole patch *and* receive a whole patch, and two copies of a
/// twelve node graph is most of the window. It keeps node ids and positions,
/// which is rule 14 of the web skill and the difference between "make it
/// darker" and "start again". And it is checkable one operation at a time, so
/// a request that is half sensible applies the sensible half.
public struct CrateGenEdit: Sendable, Equatable {
    public enum Op: String, Sendable, CaseIterable {
        case addModule
        case removeNode
        case connect
        case disconnect
        case setParam
    }

    public var op: Op
    /// `addModule`: the kind to add. Otherwise unused.
    public var kind: String
    /// The node this operates on, or the source of a cable.
    public var node: String
    /// The outlet, for `connect` and `disconnect`.
    public var jack: String
    /// The other end of a cable.
    public var target: String
    public var targetJack: String
    /// `setParam`.
    public var param: String
    public var value: Double

    public init(
        op: Op,
        kind: String = "",
        node: String = "",
        jack: String = "",
        target: String = "",
        targetJack: String = "",
        param: String = "",
        value: Double = 0
    ) {
        self.op = op
        self.kind = kind
        self.node = node
        self.jack = jack
        self.target = target
        self.targetJack = targetJack
        self.param = param
        self.value = value
    }
}

public enum CratePatchEditor {

    /// The patch, small enough to send.
    ///
    /// Not the JSON. A twelve node patch is about 1,500 tokens as a document
    /// and about 300 like this, and the difference decides whether there is
    /// room left for the model to answer in. Parameters left at their default
    /// are omitted for the same reason: the model does not need to be told
    /// what it can look up, and a wall of defaults is where the budget goes.
    public static func brief(_ patch: CratePatch, catalog: MaterialCatalog) -> String {
        var lines = ["nodes:"]
        for node in patch.nodes {
            let material = catalog.material(node.kind)
            let changed = node.params
                .filter { name, value in
                    guard let descriptor = material?.param(name) else { return false }
                    return abs(value - descriptor.defaultValue) > 1e-9
                }
                .sorted { $0.key < $1.key }
                .map { "\($0.key)=\(trimmed($0.value))" }
                .joined(separator: " ")
            lines.append("  \(node.id) \(node.kind)\(changed.isEmpty ? "" : " " + changed)")
        }
        lines.append("cables:")
        for connection in patch.connections {
            lines.append(
                "  \(connection.source).\(connection.sourceOutput) > \(connection.target).\(connection.targetInput)"
            )
        }
        return lines.joined(separator: "\n")
    }

    private static func trimmed(_ value: Double) -> String {
        if value == value.rounded() && abs(value) < 1e15 { return String(Int(value)) }
        return String(format: "%.3f", value)
    }

    /// Applies what the model asked for, and says what it refused.
    ///
    /// Unlike generation, this never rebuilds the signal path. A patch being
    /// changed is somebody's work, and an edit set that would leave it silent
    /// is refused whole rather than repaired into something they did not
    /// write: the cost of refusing is one more turn, and the cost of
    /// repairing is a patch they have to reconstruct.
    public static func apply(
        _ edits: [CrateGenEdit],
        to patch: CratePatch,
        catalog: MaterialCatalog
    ) -> (patch: CratePatch, notes: [String], applied: Int) {
        var next = patch
        var notes = [String]()
        var applied = 0

        for edit in edits {
            switch edit.op {
            case .addModule:
                guard catalog.material(edit.kind) != nil, catalog.canCompile(edit.kind) else {
                    notes.append("cannot add \(edit.kind.isEmpty ? "an unnamed module" : edit.kind)")
                    continue
                }
                let id = mintId(edit.kind, in: next)
                // Placed to the right of everything, rather than at the
                // origin where it would land on top of a source.
                let x = (next.nodes.map(\.x).max() ?? 0) + CratePatchLayout.column
                let y = (next.nodes.map(\.y).min() ?? 0)
                next.nodes.append(CratePatchNode(id: id, kind: edit.kind, x: x, y: y, params: defaults(edit.kind, catalog)))
                applied += 1

            case .removeNode:
                guard let node = next.node(edit.node) else {
                    notes.append("there is no node called \(edit.node)")
                    continue
                }
                // Master and the host tool are the patch's connection to the
                // outside. Removing one is never what a change request meant.
                if catalog.isHostTool(node.kind) {
                    notes.append("kept \(node.id): removing \(node.kind) would disconnect the patch")
                    continue
                }
                next.nodes.removeAll { $0.id == edit.node }
                next.connections.removeAll { $0.source == edit.node || $0.target == edit.node }
                applied += 1

            case .connect:
                guard let source = next.node(edit.node), let target = next.node(edit.target) else {
                    notes.append("cannot connect \(edit.node) to \(edit.target)")
                    continue
                }
                guard catalog.jacks(source.kind)?.outputs.contains(edit.jack) == true else {
                    notes.append("\(source.id) has no outlet \(edit.jack)")
                    continue
                }
                guard catalog.jacks(target.kind)?.inputs.contains(edit.targetJack) == true else {
                    notes.append("\(target.id) has no inlet \(edit.targetJack)")
                    continue
                }
                let connection = CratePatchConnection(
                    source: edit.node, sourceOutput: edit.jack,
                    target: edit.target, targetInput: edit.targetJack
                )
                if !next.connections.contains(connection) {
                    next.connections.append(connection)
                    applied += 1
                }

            case .disconnect:
                let before = next.connections.count
                next.connections.removeAll {
                    $0.source == edit.node && $0.target == edit.target
                        && (edit.jack.isEmpty || $0.sourceOutput == edit.jack)
                        && (edit.targetJack.isEmpty || $0.targetInput == edit.targetJack)
                }
                if next.connections.count == before {
                    notes.append("there was no cable from \(edit.node) to \(edit.target)")
                } else {
                    applied += 1
                }

            case .setParam:
                guard let index = next.nodes.firstIndex(where: { $0.id == edit.node }) else {
                    notes.append("there is no node called \(edit.node)")
                    continue
                }
                guard let descriptor = catalog.material(next.nodes[index].kind)?.param(edit.param) else {
                    notes.append("\(edit.node) has no parameter \(edit.param)")
                    continue
                }
                let bounded = Swift.min(descriptor.max, Swift.max(descriptor.min, edit.value))
                next.nodes[index].params[edit.param] = CrateFlatten.quantize(descriptor, bounded)
                applied += 1
            }
        }

        let check = CratePatchCheck.validate(next, catalog: catalog)
        if !check.ok {
            return (patch, notes + check.errors + ["the patch was left as it was"], 0)
        }
        return (next, notes, applied)
    }

    private static func defaults(_ kind: String, _ catalog: MaterialCatalog) -> [String: Double] {
        guard let material = catalog.material(kind) else { return [:] }
        var values = [String: Double]()
        for (name, descriptor) in material.params { values[name] = descriptor.defaultValue }
        return values
    }

    /// `reverb`, then `reverb2`. Readable in a patch somebody is editing by
    /// hand afterwards, which a hex id is not.
    private static func mintId(_ kind: String, in patch: CratePatch) -> String {
        let taken = Set(patch.nodes.map(\.id))
        if !taken.contains(kind) { return kind }
        var index = 2
        while taken.contains("\(kind)\(index)") { index += 1 }
        return "\(kind)\(index)"
    }
}
