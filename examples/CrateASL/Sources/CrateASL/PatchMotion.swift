import Foundation

/// Movement for a generated patch: the envelopes and LFOs that make a sound
/// play rather than sit.
///
/// Most factory instruments are a source and a filter at fixed settings,
/// which is the right place to start and a flat place to finish. "Acid bass"
/// tuned from Acid Line came back as a voice into a ladder at 900 Hz with
/// nothing moving the ladder, which is a bass, not an acid bass: the squelch
/// is an envelope on that cutoff.
///
/// The model chooses which moves suit the description, from a short menu of
/// the ones this patch can take. Each move is built here, by rule, because
/// each has one right construction: what the module is, where it is cabled,
/// how far it swings. Asked to draw these cables itself, the model drew
/// `keys.cv` into an oscillator's gate.
public enum CrateGenMove: String, CaseIterable, Sendable {
    case filterEnvelope
    case filterSweep
    case wobble
    case randomSteps
    case drift
    case vibrato
    case pulseWidth
    case scan
    case autopan
    case wow

    public enum Speed: String, CaseIterable, Sendable { case slow, medium, fast }
    public enum Depth: String, CaseIterable, Sendable { case subtle, medium, deep }

    /// One line for the model: what it sounds like, not how it is built.
    public var menuLine: String {
        switch self {
        case .filterEnvelope: return "filterEnvelope: each note opens the filter and it closes again. The squelch of acid, the snap of a pluck or stab, the bite of a bass. Follows velocity, so harder notes sweep further."
        case .filterSweep: return "filterSweep: the filter opens and closes slowly by itself. Pads, drones, ambient, anything that should breathe or evolve."
        case .wobble: return "wobble: the filter pulses in a fast rhythm. Dubstep and wobble bass, growls, talking or vowel sounds."
        case .randomSteps: return "randomSteps: the filter jumps to a new random place over and over. Bleeps, glitch, computer and sci-fi sounds, sample and hold."
        case .drift: return "drift: the pitch wanders a few cents, slowly and unevenly. Analog, vintage, tape, warm, detuned, lo-fi, wide unison."
        case .vibrato: return "vibrato: the pitch wavers evenly. Leads, strings, flutes, singing or expressive sounds."
        case .pulseWidth: return "pulseWidth: the tone of the wave shifts in a slow cycle. Chorus-like richness for strings, pads and classic synth leads."
        case .scan: return "scan: the wavetable sweeps through its shapes. Evolving, morphing, digital, glassy."
        case .autopan: return "autopan: the sound moves between left and right. Wide, spacious, stereo, dreamy, psychedelic."
        case .wow: return "wow: the delay time drifts, bending the repeats in pitch. Tape echo, warble, worn, lo-fi."
        }
    }

    /// The moves this patch can take: the modules each needs are present, or
    /// for a filter move, a filter can be added.
    public static func available(in patch: CratePatch, catalog: MaterialCatalog) -> [CrateGenMove] {
        let instrument = patch.nodes.contains { $0.kind == catalog.io.keyboard || $0.kind == catalog.io.midiIn }
        var moves = [CrateGenMove]()
        if instrument || filter(in: patch, catalog: catalog) != nil {
            moves += instrument ? [.filterEnvelope, .filterSweep, .wobble, .randomSteps] : [.filterSweep, .wobble, .randomSteps]
        }
        if !pitched(patch, catalog: catalog).isEmpty { moves += [.drift, .vibrato] }
        if !shaped(patch, catalog: catalog).isEmpty { moves.append(.pulseWidth) }
        if patch.nodes.contains(where: { $0.kind == "wavetable" && !driven($0.id, "position", patch) }) { moves.append(.scan) }
        if catalog.canCompile("autopan"), !patch.nodes.contains(where: { $0.kind == "autopan" }) { moves.append(.autopan) }
        if patch.nodes.contains(where: { $0.kind == "delay" && !driven($0.id, "timeSec", patch) }) { moves.append(.wow) }
        return moves.filter { $0.buildable(catalog) }
    }

    private func buildable(_ catalog: MaterialCatalog) -> Bool {
        let kind: String
        switch self {
        case .filterEnvelope: kind = "adsr"
        case .randomSteps: kind = "randomstepped"
        case .drift: kind = "randomsmooth"
        case .autopan: kind = "autopan"
        default: kind = "lfo"
        }
        return catalog.material(kind) != nil && catalog.canCompile(kind)
    }

    /// Whether something other than the keyboard already moves a parameter.
    /// A factory patch that breathes on its own does not need a move pressed
    /// on it.
    public static func alreadyMoves(_ patch: CratePatch, catalog: MaterialCatalog) -> Bool {
        patch.connections.contains { cable in
            guard let source = patch.node(cable.source),
                  CratePatchAudit.isControlSource(source.kind),
                  !CratePatchAudit.isClockLike(source.kind),
                  cable.targetInput != "gate", cable.targetInput != "note"
            else { return false }
            return true
        }
    }

    /// The moves the words alone point at, for when the model does not
    /// answer. The same idioms the menu lines name.
    ///
    /// `fallback` is whether a description that names no style still gets a
    /// move: an instrument does, an effect does not. A compressor nobody
    /// asked to move should not pan.
    public static func idioms(_ prompt: String, available: [CrateGenMove], fallback: Bool = true) -> [(CrateGenMove, Speed, Depth)] {
        let words = Set(CratePatchEditor.requestWords(prompt))
        func has(_ cues: Set<String>) -> Bool { !words.isDisjoint(with: cues) }
        var picks = [(CrateGenMove, Speed, Depth)]()
        if has(["acid", "303", "squelch", "squelchy"]) { picks.append((.filterEnvelope, .fast, .deep)) }
        if has(["pluck", "stab", "plucky", "funky", "funk"]) { picks.append((.filterEnvelope, .fast, .medium)) }
        if has(["wobble", "dubstep", "growl", "talking", "wub"]) { picks.append((.wobble, .medium, .deep)) }
        if has(["bleep", "bleepy", "glitch", "glitchy", "random", "computer", "robot"]) { picks.append((.randomSteps, .medium, .medium)) }
        if has(["pad", "drone", "ambient", "evolving", "breathing", "atmosphere", "atmospheric"]) { picks.append((.filterSweep, .slow, .medium)) }
        if has(["evolving", "morphing", "digital"]) { picks.append((.scan, .slow, .medium)) }
        if has(["analog", "analogue", "vintage", "tape", "warm", "lofi", "detuned"]) { picks.append((.drift, .slow, .subtle)) }
        if has(["lead", "string", "strings", "flute", "expressive", "singing"]) { picks.append((.vibrato, .medium, .subtle)) }
        if has(["wide", "stereo", "spacious", "dreamy", "psychedelic"]) { picks.append((.autopan, .slow, .medium)) }
        if has(["warble", "wobbly", "worn", "tape", "echo", "lofi"]) { picks.append((.wow, .slow, .subtle)) }
        if has(["sweep", "sweeping", "moving", "filtered"]) { picks.append((.filterSweep, .slow, .medium)) }
        var seen = Set<CrateGenMove>()
        let found = picks.filter { available.contains($0.0) && seen.insert($0.0).inserted }
        if !found.isEmpty || !fallback { return found }
        // Nothing named a style: an envelope on the filter is the move almost
        // every played instrument is better for, and a slow sweep the one an
        // effect is.
        if available.contains(.filterEnvelope) { return [(.filterEnvelope, .medium, .medium)] }
        if available.contains(.filterSweep) { return [(.filterSweep, .slow, .subtle)] }
        return []
    }

    /// Whether the words ask for a sound that does not move.
    public static func wantsStill(_ prompt: String) -> Bool {
        !Set(CratePatchEditor.requestWords(prompt)).isDisjoint(with: ["static", "plain", "simple", "clean", "steady", "basic", "pure"])
    }

    /// The moves a style is named for, which go in whatever else the model
    /// chose: acid is the envelope on the filter, dubstep the wobble.
    public static func signature(_ prompt: String, available: [CrateGenMove]) -> [(CrateGenMove, Speed, Depth)] {
        let words = Set(CratePatchEditor.requestWords(prompt))
        var picks = [(CrateGenMove, Speed, Depth)]()
        if !words.isDisjoint(with: ["acid", "303", "squelch", "squelchy"]) { picks.append((.filterEnvelope, .fast, .deep)) }
        if !words.isDisjoint(with: ["wobble", "dubstep", "wub"]) { picks.append((.wobble, .medium, .deep)) }
        if !words.isDisjoint(with: ["bleep", "bleepy", "glitch", "glitchy"]) { picks.append((.randomSteps, .medium, .medium)) }
        if !words.isDisjoint(with: ["vibrato"]) { picks.append((.vibrato, .medium, .medium)) }
        if !words.isDisjoint(with: ["autopan", "panning"]) { picks.append((.autopan, .medium, .medium)) }
        return picks.filter { available.contains($0.0) }
    }

    // MARK: - Building

    /// Builds each move into the patch. A move whose parameter something
    /// already drives is skipped: two cables into one parameter sum, and two
    /// scaled sweeps summed is a cutoff pushed to twice where it was voiced.
    public static func apply(
        _ moves: [(CrateGenMove, Speed, Depth)],
        to patch: CratePatch,
        catalog: MaterialCatalog
    ) -> (patch: CratePatch, notes: [String]) {
        var next = patch
        var notes = [String]()
        var done = Set<CrateGenMove>()
        for (move, speed, depth) in moves.prefix(3) where done.insert(move).inserted {
            let before = next
            if let note = move.build(speed: speed, depth: depth, in: &next, catalog: catalog) {
                if CratePatchCheck.validate(next, catalog: catalog).ok {
                    notes.append(note)
                } else {
                    next = before
                }
            } else {
                next = before
            }
        }
        return (next, notes)
    }

    private func build(speed: Speed, depth: Depth, in patch: inout CratePatch, catalog: MaterialCatalog) -> String? {
        let amount: Double = [Depth.subtle: 0.35, .medium: 0.65, .deep: 1.0][depth]!
        func pick(_ slow: Double, _ medium: Double, _ fast: Double) -> Double {
            [Speed.slow: slow, .medium: medium, .fast: fast][speed]!
        }

        switch self {
        case .filterEnvelope:
            guard let filter = Self.ensureFilter(&patch, catalog: catalog, add: true) else { return nil }
            // The sweep is a ratio either side of where the cutoff sits, and
            // an envelope rests at the bottom of it. A ladder tuned down to
            // 500 Hz swept from there closes to mud and opens to nothing
            // much; the squelch wants the top of the sweep well up.
            if let index = patch.nodes.firstIndex(where: { $0.id == filter }),
               let descriptor = catalog.material(patch.nodes[index].kind)?.param("cutoff") {
                let floor: Double = [Depth.subtle: 400, .medium: 650, .deep: 900][depth]!
                let current = patch.nodes[index].params["cutoff"] ?? descriptor.defaultValue
                if current < floor {
                    patch.nodes[index].params["cutoff"] = CrateFlatten.quantize(descriptor, Swift.min(descriptor.max, floor))
                }
            }
            guard let env = Self.add("adsr", [
                "attack": speed == .slow ? 0.25 : 0.003,
                "decay": pick(0.8, 0.35, 0.16),
                "sustain": pick(0.35, 0.15, 0.05),
                "release": pick(0.6, 0.25, 0.12),
                "amount": 1,
            ], near: filter, in: &patch, catalog: catalog) else { return nil }
            guard CratePatchEditor.connect((env, "cv"), to: patch.node(filter)!, inlet: "cutoff", in: &patch, catalog: catalog, depth: amount)
            else { return nil }
            patch = CratePatchEditor.completeAdditions(patch, added: [env], request: "", catalog: catalog).patch
            let opened = Self.openVoiceFilters(feeding: filter, in: &patch, catalog: catalog)
            // Deep is the squelch, and the squelch is the resonance riding
            // the sweep. The tuning pass took Acid Line's ladder from 0.78
            // to 0.5 once, which leaves an envelope on a polite filter.
            if depth == .deep, let index = patch.nodes.firstIndex(where: { $0.id == filter }) {
                let node = patch.nodes[index]
                for (param, floor) in [("resonance", 0.8), ("q", 4.0)] {
                    guard let descriptor = catalog.material(node.kind)?.param(param), !Self.driven(filter, param, patch) else { continue }
                    let current = node.params[param] ?? descriptor.defaultValue
                    let wanted = node.kind == "SynthVoice" && param == "resonance" ? 4.0 : floor
                    if current < wanted {
                        patch.nodes[index].params[param] = CrateFlatten.quantize(descriptor, Swift.min(descriptor.max, wanted))
                    }
                }
            }
            return "\(env) sweeps \(filter).cutoff on every note"
                + (opened.isEmpty ? "" : ", with \(opened.joined(separator: ", ")) opened so the sweep is heard")

        case .filterSweep, .wobble, .randomSteps:
            let instrument = patch.nodes.contains { $0.kind == catalog.io.keyboard || $0.kind == catalog.io.midiIn }
            guard let filter = Self.ensureFilter(&patch, catalog: catalog, add: instrument) else { return nil }
            let kind = self == .randomSteps ? "randomstepped" : "lfo"
            var params = [String: Double]()
            switch self {
            case .filterSweep: params = ["rate": pick(0.06, 0.18, 0.5), "type": 0]
            case .wobble: params = ["rate": pick(1.5, 3, 6), "type": 3]
            default: params = ["freq": pick(2, 5, 10)]
            }
            guard let mod = Self.add(kind, params, near: filter, in: &patch, catalog: catalog),
                  let outlet = catalog.jacks(kind)?.outputs.first,
                  CratePatchEditor.connect((mod, outlet), to: patch.node(filter)!, inlet: "cutoff", in: &patch, catalog: catalog,
                                           depth: self == .wobble ? max(amount, 0.7) : amount)
            else { return nil }
            let what = self == .filterSweep ? "slowly sweeps" : self == .wobble ? "wobbles" : "steps"
            return "\(mod) \(what) \(filter).cutoff"

        case .drift, .vibrato:
            let targets = Self.pitched(patch, catalog: catalog)
            guard let first = targets.first else { return nil }
            // A few cents, either way: detune spans 200 cents, so a depth of
            // 0.1 is ten cents each side, which is vibrato; drift is less.
            let cents = self == .vibrato ? [Depth.subtle: 0.06, .medium: 0.1, .deep: 0.18][depth]! : [Depth.subtle: 0.04, .medium: 0.07, .deep: 0.12][depth]!
            var made = [String]()
            // Drift is one wander per oscillator, so two of them part and
            // meet; vibrato is one LFO, so they waver together.
            for (index, target) in targets.prefix(self == .drift ? 2 : 3).enumerated() {
                let source: String
                if self == .vibrato, let shared = made.first {
                    source = shared
                } else {
                    let kind = self == .drift ? "randomsmooth" : "lfo"
                    let params: [String: Double] = self == .drift
                        ? ["freq": pick(0.2, 0.5, 1.2) * (1 + 0.37 * Double(index))]
                        : ["rate": pick(4.5, 5.6, 6.8), "type": 0]
                    guard let mod = Self.add(kind, params, near: target, in: &patch, catalog: catalog) else { return nil }
                    source = mod
                    made.append(mod)
                }
                let outlet = catalog.jacks(patch.node(source)!.kind)?.outputs.first ?? "cv"
                CratePatchEditor.connect((source, outlet), to: patch.node(target)!, inlet: "detune", in: &patch, catalog: catalog, depth: cents)
            }
            return self == .drift
                ? "\(made.joined(separator: " and ")) let the pitch of \(targets.prefix(2).joined(separator: ", ")) drift"
                : "\(made[0]) adds vibrato to \(first)"

        case .pulseWidth:
            guard let target = Self.shaped(patch, catalog: catalog).first,
                  let mod = Self.add("lfo", ["rate": pick(0.2, 0.6, 1.8), "type": 3], near: target, in: &patch, catalog: catalog),
                  CratePatchEditor.connect((mod, "cv"), to: patch.node(target)!, inlet: "width", in: &patch, catalog: catalog, depth: amount * 0.7)
            else { return nil }
            return "\(mod) moves the wave shape of \(target)"

        case .scan:
            guard let table = patch.nodes.first(where: { $0.kind == "wavetable" && !Self.driven($0.id, "position", patch) })?.id,
                  let mod = Self.add("lfo", ["rate": pick(0.08, 0.25, 0.9), "type": 3], near: table, in: &patch, catalog: catalog),
                  CratePatchEditor.connect((mod, "cv"), to: patch.node(table)!, inlet: "position", in: &patch, catalog: catalog, depth: amount)
            else { return nil }
            return "\(mod) scans \(table) through its wavetable"

        case .autopan:
            let made = CratePatchEditor.apply([CrateGenEdit(op: .addModule, kind: "autopan")], to: patch, catalog: catalog).patch
            guard let id = made.nodes.map(\.id).first(where: { patch.node($0) == nil }) else { return nil }
            var placed = CratePatchEditor.completeAdditions(made, added: [id], request: "", catalog: catalog).patch
            guard placed.connections.contains(where: { $0.target == id }),
                  let index = placed.nodes.firstIndex(where: { $0.id == id })
            else { return nil }
            placed.nodes[index].params["rate"] = pick(0.12, 0.4, 1.5)
            placed.nodes[index].params["depth"] = [Depth.subtle: 0.35, .medium: 0.6, .deep: 0.9][depth]!
            patch = placed
            return "\(id) moves it across the stereo field"

        case .wow:
            guard let delay = patch.nodes.first(where: { $0.kind == "delay" && !Self.driven($0.id, "timeSec", patch) })?.id,
                  let mod = Self.add("lfo", ["rate": pick(0.3, 0.7, 1.6), "type": 0], near: delay, in: &patch, catalog: catalog),
                  CratePatchEditor.connect((mod, "cv"), to: patch.node(delay)!, inlet: "timeSec", in: &patch, catalog: catalog,
                                           depth: [Depth.subtle: 0.006, .medium: 0.012, .deep: 0.025][depth]!)
            else { return nil }
            return "\(mod) bends the repeats of \(delay)"
        }
    }

    // MARK: - Finding what to move

    /// Filters a cutoff move opens: lowpasses first, then bandpasses, and a
    /// Synth Voice's own filter only when it is the only one.
    static let sweepable: [Set<String>] = [
        ["ladder", "lowpass", "svflowpass", "slopelowpass12", "slopelowpass24", "onepolelowpass"],
        ["bandpass", "svfbandpass"],
        ["SynthVoice"],
    ]

    static func filter(in patch: CratePatch, catalog: MaterialCatalog) -> String? {
        for kinds in sweepable {
            if let node = patch.nodes.first(where: {
                kinds.contains($0.kind) && catalog.material($0.kind)?.param("cutoff") != nil && !driven($0.id, "cutoff", patch)
            }) {
                return node.id
            }
        }
        return nil
    }

    /// The filter to sweep, adding one when there is none. A bell has no
    /// filter; it gets one just before the output, set high enough that the
    /// sound it had is still there at the top of the sweep.
    static func ensureFilter(_ patch: inout CratePatch, catalog: MaterialCatalog, add: Bool) -> String? {
        if let id = filter(in: patch, catalog: catalog) { return id }
        // Only into a patch with no filter at all. One whose filter another
        // move already sweeps has its movement; a second lowpass in series
        // wobbling under it is clutter, and darker.
        let any = sweepable.reduce(Set<String>()) { $0.union($1) }
        guard add, !patch.nodes.contains(where: { any.contains($0.kind) }) else { return nil }
        let made = CratePatchEditor.apply(
            [CrateGenEdit(op: .addModule, kind: "lowpass")], to: patch, catalog: catalog
        )
        guard let id = made.patch.nodes.map(\.id).first(where: { patch.node($0) == nil }) else { return nil }
        var placed = CratePatchEditor.completeAdditions(made.patch, added: [id], request: "", catalog: catalog).patch
        guard placed.connections.contains(where: { $0.target == id }),
              let index = placed.nodes.firstIndex(where: { $0.id == id })
        else { return nil }
        placed.nodes[index].params["cutoff"] = 1800
        placed.nodes[index].params["q"] = 1.2
        patch = placed
        return id
    }

    /// A Synth Voice's own filter, closed down in front of the filter an
    /// envelope now sweeps, is a second lid on the sound: Acid Line's voice
    /// sits at 320 Hz with resonance 6, and the ladder after it swept from
    /// 400 Hz to 3.6 kHz moved the brightness half as far as it did with the
    /// voice opened. The swept filter is the squelch; the voice is opened
    /// and its own envelope turned down to leave it that job.
    static func openVoiceFilters(feeding filter: String, in patch: inout CratePatch, catalog: MaterialCatalog) -> [String] {
        var opened = [String]()
        for cable in patch.connections where cable.target == filter && cable.targetInput == "input" {
            guard let index = patch.nodes.firstIndex(where: { $0.id == cable.source }),
                  patch.nodes[index].kind == "SynthVoice",
                  !driven(cable.source, "cutoff", patch),
                  let material = catalog.material("SynthVoice"),
                  let cutoff = material.param("cutoff")
            else { continue }
            let current = patch.nodes[index].params["cutoff"] ?? cutoff.defaultValue
            guard current < 1200 else { continue }
            patch.nodes[index].params["cutoff"] = CrateFlatten.quantize(cutoff, 2000)
            if let envAmt = material.param("envAmt") {
                let amount = patch.nodes[index].params["envAmt"] ?? envAmt.defaultValue
                patch.nodes[index].params["envAmt"] = CrateFlatten.quantize(envAmt, Swift.min(amount, 0.3))
            }
            if let resonance = material.param("resonance") {
                let value = patch.nodes[index].params["resonance"] ?? resonance.defaultValue
                patch.nodes[index].params["resonance"] = CrateFlatten.quantize(resonance, Swift.min(value, 1.2))
            }
            opened.append(cable.source)
        }
        return opened
    }

    /// Oscillators whose detune nothing drives yet.
    static func pitched(_ patch: CratePatch, catalog: MaterialCatalog) -> [String] {
        patch.nodes.filter { ["oscillator", "wavetable"].contains($0.kind) && !driven($0.id, "detune", patch) }.map(\.id)
    }

    /// Sources whose shape control does something audible: a pulse or a
    /// square's width, a Synth Voice's.
    static func shaped(_ patch: CratePatch, catalog: MaterialCatalog) -> [String] {
        patch.nodes.filter { node in
            guard !driven(node.id, "width", patch) else { return false }
            if node.kind == "SynthVoice" { return true }
            guard node.kind == "oscillator" else { return false }
            let type = Int(node.params["type"] ?? catalog.material("oscillator")?.param("type")?.defaultValue ?? 1)
            return [2, 4, 5, 6].contains(type)
        }.map(\.id)
    }

    static func driven(_ id: String, _ param: String, _ patch: CratePatch) -> Bool {
        patch.connections.contains { $0.target == id && $0.targetInput == param }
    }

    /// Adds a modulator just above the module it moves, with its knobs set.
    private static func add(
        _ kind: String,
        _ params: [String: Double],
        near target: String,
        in patch: inout CratePatch,
        catalog: MaterialCatalog
    ) -> String? {
        let made = CratePatchEditor.apply([CrateGenEdit(op: .addModule, kind: kind)], to: patch, catalog: catalog).patch
        guard let id = made.nodes.map(\.id).first(where: { patch.node($0) == nil }),
              let index = made.nodes.firstIndex(where: { $0.id == id }),
              let material = catalog.material(kind)
        else { return nil }
        var next = made
        for (name, value) in params {
            guard let descriptor = material.param(name) else { continue }
            next.nodes[index].params[name] = CrateFlatten.quantize(descriptor, Swift.min(descriptor.max, Swift.max(descriptor.min, value)))
        }
        if let anchor = next.node(target) {
            let above = next.nodes.filter { abs($0.x - anchor.x) < CratePatchLayout.column * 0.5 && $0.y < anchor.y }.count
            next.nodes[index].x = anchor.x
            next.nodes[index].y = anchor.y - CratePatchLayout.row * Double(above + 1)
        }
        patch = next
        return id
    }
}
