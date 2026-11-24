import Foundation

/// Starting a generated patch from a factory patch rather than from slots.
///
/// The slot generator builds every instrument out of the same five slots and
/// sets every parameter from one table: a `q` of 0.9, a resonance of 0.35, a
/// reverb decay of 0.7, whatever was asked for. The model contributes four
/// numbers. So every instrument came out as a Synth Voice at its defaults,
/// every effect came out as a lowpass in front of something, and the lanes
/// that were meant to give it life were parked on a compressor's attack.
///
/// The factory library is a hundred patches somebody voiced by ear, each with
/// a sentence saying what it is. Picking the nearest one and then tuning its
/// own parameters toward the prompt asks the model the two questions it can
/// answer: which of these is closest, and which way should its knobs turn.
/// Neither question is how crate spells a bell.
public enum CrateGenStart {

    /// The factory patches a role can start from.
    public static func candidates(
        for role: CrateGen.Role,
        in library: FactoryLibrary
    ) -> [FactoryLibrary.Entry] {
        library.patches.filter { entry in
            switch role {
            case .instrument: return entry.slot == "instrument"
            case .insert: return entry.slot == "effect"
            case .generative: return entry.slot == "either"
            }
        }
    }

    /// The effects an instrument may be finished with.
    public static func effects(in library: FactoryLibrary) -> [FactoryLibrary.Entry] {
        library.patches.filter { $0.slot == "effect" }
    }

    /// One menu line: the id, the name and the first sentence of the blurb.
    /// The first sentence is the one that says what it is; the rest says how.
    public static func menuLine(_ entry: FactoryLibrary.Entry) -> String {
        var first = entry.blurb
        if let stop = first.firstIndex(of: ".") { first = String(first[..<stop]) }
        if first.count > 90 { first = String(first.prefix(90)) }
        return "\(entry.id): \(entry.name). \(first)"
    }

    /// The menu, grouped under its categories so a small model reads it as
    /// a shop rather than a list.
    public static func menu(_ entries: [FactoryLibrary.Entry]) -> String {
        var lines = [String]()
        var category = ""
        for entry in entries {
            if entry.category != category {
                category = entry.category
                lines.append(category.uppercased())
            }
            lines.append(menuLine(entry))
        }
        return lines.joined(separator: "\n")
    }

    /// How many of the prompt's words an entry shares, its name and category
    /// counting three times what its blurb does.
    ///
    /// The head noun counts again on top. "A slow phaser" is a phaser that
    /// is slow, and scoring the two words alike sent it to Slow Panner.
    public static func score(_ prompt: String, _ entry: FactoryLibrary.Entry) -> Int {
        let words = CratePatchEditor.requestWords(prompt).filter { $0.count > 2 }
        let name = CratePatchEditor.requestWords(entry.name + " " + entry.category)
        let blurb = CratePatchEditor.requestWords(entry.blurb)
        var total = 0
        for word in Set(words) {
            if name.contains(where: { same(word, $0) }) { total += 3 }
            else if blurb.contains(where: { same(word, $0) }) { total += 1 }
        }
        if let head = headWord(prompt), name.contains(where: { same(head, $0) }) { total += 2 }
        return total
    }

    /// Whether an entry's name or category is the description's head noun.
    public static func namesHead(_ prompt: String, _ entry: FactoryLibrary.Entry) -> Bool {
        guard let head = headWord(prompt) else { return false }
        return CratePatchEditor.requestWords(entry.name + " " + entry.category).contains { same(head, $0) }
    }

    /// The noun a description is about: the last word before it starts
    /// qualifying itself. "A fat detuned saw bass for techno" is a bass,
    /// "a lush shimmering reverb" is a reverb.
    public static func headWord(_ prompt: String) -> String? {
        let breaks: Set<String> = ["with", "for", "that", "which", "into", "on", "in", "to", "and", "like", "where", "who"]
        var last: String?
        for word in CratePatchEditor.requestWords(prompt) {
            if breaks.contains(word) { break }
            if word.count > 2 { last = word }
        }
        return last
    }

    /// One word standing for another: equal, one the start of the other
    /// ("comp", "compressor"), or sharing six letters ("shimmering",
    /// "shimmer"). Six and not five, because five made "reverb" a
    /// "reverse" and gave a shimmer reverb a reverse delay after it.
    static func same(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        let (short, long) = a.count <= b.count ? (a, b) : (b, a)
        if short.count >= 4, long.hasPrefix(short) { return true }
        return a.count >= 6 && b.count >= 6 && a.prefix(6) == b.prefix(6)
    }

    /// The candidates ordered by `score`, for when the model does not answer
    /// and to put the likeliest in front of it when it does. Ties keep
    /// library order, which is the order somebody browsing would meet them in.
    public static func rank(_ prompt: String, _ entries: [FactoryLibrary.Entry]) -> [FactoryLibrary.Entry] {
        var scored = [(score: Int, index: Int, entry: FactoryLibrary.Entry)]()
        for (index, entry) in entries.enumerated() {
            scored.append((score(prompt, entry), index, entry))
        }
        scored.sort { $0.score == $1.score ? $0.index < $1.index : $0.score > $1.score }
        return scored.map(\.entry)
    }

    /// Categories in library order.
    public static func categories(_ entries: [FactoryLibrary.Entry]) -> [String] {
        var seen = Set<String>()
        return entries.map(\.category).filter { seen.insert($0).inserted }
    }

    /// One line per category with the names in it, which is most of what a
    /// category means: "PAD: Warm Pad, Glass Pad, Breathing Pad".
    public static func categoryMenu(_ entries: [FactoryLibrary.Entry]) -> String {
        categories(entries).map { category in
            let names = entries.filter { $0.category == category }.map(\.name).joined(separator: ", ")
            return "\(category): \(names)"
        }
        .joined(separator: "\n")
    }

    /// Whether a description of an instrument asks for an effect after it.
    ///
    /// Asked of the words rather than the model, because the model, offered
    /// an effect slot, fills it: six instruments in a row came back with a
    /// slapback echo nobody mentioned.
    public static func asksForEffect(_ prompt: String) -> Bool {
        let cues = [
            "reverb", "verb", "echo", "delay", "space", "room", "hall", "cave", "cavern", "ambient",
            "wash", "lush", "shimmer", "chorus", "chorused", "flanger", "flange", "phaser", "phase",
            "vibrato", "tremolo", "rotary", "wobbly", "drive", "driven", "overdrive", "distort",
            "fuzz", "crunch", "crushed", "bitcrush", "lofi", "saturat", "tape", "dub", "wide",
            "stereo", "pan", "panning", "gated", "slapback", "telephone", "radio", "wet",
        ]
        let words = CratePatchEditor.requestWords(prompt)
        return words.contains { word in cues.contains { same(word, $0) || word.hasPrefix($0) } }
    }

    // MARK: - Chaining

    /// Factory effects a change request names that no module answers to:
    /// "add a phaser" or "add a chorus", where the library has a Phaser and
    /// a Chorus and the catalog has no module of either name. Every word of
    /// the effect's name has to be in the request, so "add a delay" is the
    /// Delay module and not the Dub Delay patch. Where a module and a patch
    /// share a name (Ring Mod, Auto Pan), the module wins and this returns
    /// nothing for it.
    public static func namedEffects(
        _ request: String,
        in library: FactoryLibrary,
        catalog: MaterialCatalog
    ) -> [FactoryLibrary.Entry] {
        let words = Set(CratePatchEditor.requestWords(request))
        let labels = Set(catalog.materials.map { catalog.label($0.kind).lowercased() })
        return effects(in: library).filter { entry in
            let name = CratePatchEditor.requestWords(entry.name)
            return !name.isEmpty
                && name.allSatisfy(words.contains)
                && !labels.contains(entry.name.lowercased())
                && CratePatchCheck.validate(entry.patch, catalog: catalog).ok
        }
    }

    /// `first` played into `then`: an instrument into an effect, or one
    /// effect into another.
    ///
    /// Whatever fed `first`'s Master now feeds whatever `then`'s Line fed,
    /// and `then`'s Master is the output. Ids `then` shares with `first` are
    /// renamed (`lvl` becomes `lvl2`), and its modules move to the right of
    /// `first`'s so the canvas still reads left to right. Nil when either is
    /// not shaped for it: `first` needs a Master and `then` a Line.
    public static func series(
        _ first: CratePatch,
        _ then: CratePatch,
        catalog: MaterialCatalog
    ) -> CratePatch? {
        guard let firstMaster = first.nodes.first(where: { $0.kind == catalog.io.master }),
              let thenLine = then.nodes.first(where: { $0.kind == catalog.io.line }),
              then.nodes.contains(where: { $0.kind == catalog.io.master })
        else { return nil }

        var taken = Set(first.nodes.map(\.id))
        taken.remove(firstMaster.id)
        var rename = [String: String]()
        for node in then.nodes where node.id != thenLine.id {
            var id = node.id
            if taken.contains(id) {
                var index = 2
                while taken.contains("\(node.id)\(index)") { index += 1 }
                id = "\(node.id)\(index)"
            }
            rename[node.id] = id
            taken.insert(id)
        }

        let shift = (first.nodes.map(\.x).max() ?? 0) + CratePatchLayout.column
            - (then.nodes.map(\.x).min() ?? 0)
        var nodes = first.nodes.filter { $0.id != firstMaster.id }
        for node in then.nodes where node.id != thenLine.id {
            var moved = node
            moved.id = rename[node.id] ?? node.id
            moved.x += shift
            nodes.append(moved)
        }

        let feeding = first.connections.filter { $0.target == firstMaster.id }
        var connections = first.connections.filter { $0.target != firstMaster.id }
        for cable in then.connections {
            guard let target = rename[cable.target] else { continue }
            if cable.source == thenLine.id {
                for feed in feeding {
                    connections.append(
                        CratePatchConnection(
                            source: feed.source, sourceOutput: feed.sourceOutput,
                            target: target, targetInput: cable.targetInput
                        )
                    )
                }
            } else if let source = rename[cable.source] {
                connections.append(
                    CratePatchConnection(
                        source: source, sourceOutput: cable.sourceOutput,
                        target: target, targetInput: cable.targetInput
                    )
                )
            }
        }

        var joined = first
        joined.nodes = nodes
        joined.connections = connections
        return joined
    }

    // MARK: - Tuning

    /// Every parameter of every module, with where it can go, for the pass
    /// that turns the starting patch's knobs.
    ///
    /// Unlike `CratePatchEditor.brief`, which leaves defaults out because a
    /// change only needs what is unusual, this is all of it: a model asked to
    /// make a pad slower has to be told the pad has an `attack` and that it
    /// runs to two seconds. Menus are spelled out (`type=1 Saw of Sine, Saw,
    /// Square`) because the number alone means nothing. A parameter a cable
    /// drives is marked, since its knob is not what you hear.
    public static func tuningBrief(_ patch: CratePatch, catalog: MaterialCatalog) -> String {
        var lines = [String]()
        for node in patch.nodes where !catalog.isHostTool(node.kind) {
            guard let material = catalog.material(node.kind) else { continue }
            var parts = [String]()
            for (name, descriptor) in material.orderedParams {
                let value = node.params[name] ?? descriptor.defaultValue
                let driven = patch.connections.contains { $0.target == node.id && $0.targetInput == name }
                if driven {
                    parts.append("\(name) moved by a cable")
                } else if let options = descriptor.options, !options.isEmpty {
                    let index = Int(value.rounded()) - Int(descriptor.min)
                    let current = options.indices.contains(index) ? options[index] : "\(Int(value))"
                    let list = options.enumerated()
                        .map { "\(Int(descriptor.min) + $0.offset)=\($0.element)" }
                        .joined(separator: " ")
                    parts.append("\(name)=\(Int(value)) (\(current); choices \(list))")
                } else {
                    let unit = descriptor.unit.map { " \($0)" } ?? ""
                    parts.append("\(name)=\(trimmed(value)) (\(trimmed(descriptor.min))..\(trimmed(descriptor.max))\(unit))")
                }
            }
            lines.append("\(node.id) \(catalog.label(node.kind)): \(parts.isEmpty ? "no settings" : parts.joined(separator: "; "))")
        }
        lines.append("cables:")
        for connection in patch.connections {
            lines.append("  \(connection.source).\(connection.sourceOutput) > \(connection.target).\(connection.targetInput)")
        }
        return lines.joined(separator: "\n")
    }

    /// The parameters the tuning pass may set: every one in the patch that a
    /// cable is not already driving.
    public static func tunableParams(_ patch: CratePatch, catalog: MaterialCatalog) -> [String] {
        var names = Set<String>()
        for node in patch.nodes where !catalog.isHostTool(node.kind) {
            for name in catalog.material(node.kind)?.paramOrder ?? [] {
                names.insert(name)
            }
        }
        return names.sorted()
    }

    private static func trimmed(_ value: Double) -> String {
        if value == value.rounded() && abs(value) < 1e9 { return String(Int(value)) }
        if abs(value) >= 100 { return String(format: "%.0f", value) }
        return String(format: "%.3g", value)
    }

    // MARK: - Keeping the tuning musical

    /// The tuning pass's edits with the ones that wreck a factory patch
    /// removed or reined in.
    ///
    /// Each rule is a mistake the model made in the first run against real
    /// prompts. Detune is in cents and a single oscillator 100 cents off is a
    /// semitone out of tune, not a fat bass. An octave jump of two is a
    /// different instrument. A limiter is the patch's safety and nobody's
    /// sound. A parameter a cable drives does not hear its knob. Everything
    /// else is clamped only by the parameter's own range, in `apply`.
    ///
    /// And the one direction the model got backwards often enough to matter:
    /// "a bright pluck" took a lowpass from 700 Hz to 100 Hz. When the words
    /// say bright or dark, a lowpass cutoff may only move that way.
    public static func rein(
        _ edits: [CrateGenEdit],
        in patch: CratePatch,
        catalog: MaterialCatalog,
        prompt: String = ""
    ) -> (edits: [CrateGenEdit], notes: [String]) {
        let direction = brightness(prompt)
        let output = outputGain(patch, catalog: catalog).map { patch.nodes[$0].id }
        var kept = [String: CrateGenEdit]()
        var order = [String]()
        var notes = [String]()
        for var edit in edits {
            guard edit.op == .setParam else {
                let key = "#\(order.count)"
                order.append(key)
                kept[key] = edit
                continue
            }
            guard let node = patch.node(edit.node),
                  let descriptor = catalog.material(node.kind)?.param(edit.param)
            else { continue }
            if node.kind == "limiter" || node.kind == "offset" || catalog.isHostTool(node.kind) { continue }
            // The output level is `matchLevel`'s to set, after everything else.
            if node.id == output, edit.param == "gain" { continue }
            if patch.connections.contains(where: { $0.target == node.id && $0.targetInput == edit.param }) {
                continue
            }
            let current = node.params[edit.param] ?? descriptor.defaultValue
            var value = edit.value
            switch edit.param {
            case "detune":
                value = Swift.min(30, Swift.max(-30, value))
            case "octave":
                value = Swift.min(current + 1, Swift.max(current - 1, value.rounded()))
            case "feedback":
                value = Swift.min(value, Swift.max(current, 0.85))
            case "mix" where ["reverb", "delay", "synceddelay"].contains(node.kind):
                value = Swift.min(value, Swift.max(current, 0.7))
            case "q":
                value = Swift.min(value, Swift.max(current, 8))
            case "resonance":
                value = Swift.min(value, Swift.max(current, 0.9))
            case "cutoff" where direction != 0 && lowpassKinds.contains(node.kind):
                if (value - current) * Double(direction) < 0 {
                    notes.append("\(edit.node).cutoff left at \(trimmed(current)): the description asks for \(direction > 0 ? "brighter" : "darker")")
                    continue
                }
            case "decay" where descriptor.unit == "s":
                // "Short" taken to the floor is a click: Acid Line's 0.22 s
                // went to 0.001 and the note was gone before it sounded.
                value = Swift.max(value, Swift.min(current * 0.3, 0.06))
            case "makeup":
                value = Swift.max(value, current * 0.5)
            case "gain" where node.kind == "gain":
                // The level stage is matched afterwards; a trim on a sweep
                // is its depth, and doubling or halving it is plenty.
                value = Swift.min(current * 2, Swift.max(current * 0.5, value))
            default:
                break
            }
            if abs(value - edit.value) > 1e-9 {
                notes.append("\(edit.node).\(edit.param) kept to \(String(format: "%g", value)) rather than \(String(format: "%g", edit.value))")
            }
            edit.value = value
            let key = "\(edit.node).\(edit.param)"
            if kept[key] == nil { order.append(key) }
            kept[key] = edit
        }
        return (order.compactMap { kept[$0] }, notes)
    }

    /// Filters whose cutoff going up is the sound getting brighter.
    static let lowpassKinds: Set<String> = [
        "lowpass", "ladder", "svflowpass", "slopelowpass12", "slopelowpass24", "onepolelowpass", "SynthVoice",
    ]

    /// +1 when the words ask for brighter, -1 for darker, 0 for neither or
    /// both.
    public static func brightness(_ prompt: String) -> Int {
        let words = Set(CratePatchEditor.requestWords(prompt))
        let bright: Set<String> = ["bright", "brighter", "airy", "crisp", "sparkly", "sparkling", "shiny", "glassy", "brilliant", "sharp"]
        let dark: Set<String> = ["dark", "darker", "warm", "warmer", "muffled", "mellow", "dull", "murky", "lofi", "lo", "rolled", "muted", "soft"]
        let up = !words.isDisjoint(with: bright)
        let down = !words.isDisjoint(with: dark)
        return up == down ? 0 : (up ? 1 : -1)
    }

    /// Moves the lowpass when the words ask for bright or dark and the
    /// tuning pass did not, unless the starting patch's own description
    /// already says so: "a dark pad" from Dark Drone is dark enough.
    public static func nudgeBrightness(
        _ patch: CratePatch,
        prompt: String,
        start: FactoryLibrary.Entry,
        edits: [CrateGenEdit],
        catalog: MaterialCatalog
    ) -> (patch: CratePatch, note: String?) {
        let direction = brightness(prompt)
        guard direction != 0, brightness(start.name + " " + start.blurb) != direction else { return (patch, nil) }
        let moved = Set(edits.filter { $0.op == .setParam && $0.param == "cutoff" }.map(\.node))
        var next = patch
        var touched = [String]()
        for index in next.nodes.indices {
            let node = next.nodes[index]
            guard lowpassKinds.contains(node.kind), !moved.contains(node.id),
                  !patch.connections.contains(where: { $0.target == node.id && $0.targetInput == "cutoff" }),
                  let descriptor = catalog.material(node.kind)?.param("cutoff")
            else { continue }
            let current = node.params["cutoff"] ?? descriptor.defaultValue
            let wanted = Swift.min(descriptor.max, Swift.max(descriptor.min, current * (direction > 0 ? 1.8 : 0.55)))
            next.nodes[index].params["cutoff"] = CrateFlatten.quantize(descriptor, wanted)
            touched.append(node.id)
        }
        guard !touched.isEmpty else { return (patch, nil) }
        return (next, "\(touched.joined(separator: ", ")) \(direction > 0 ? "opened up" : "closed down") for a \(direction > 0 ? "brighter" : "darker") sound")
    }

    /// "Opens up when you play harder": the keyboard's velocity on the
    /// filter, scaled so a soft note sits below the cutoff the patch was
    /// voiced at and a hard one above it.
    ///
    /// By rule, because it is one cable with one right answer and the model,
    /// asked to draw it, drew `keys.cv` into an oscillator's gate.
    public static func velocityOpensFilter(
        _ patch: CratePatch,
        prompt: String,
        catalog: MaterialCatalog
    ) -> (patch: CratePatch, note: String?) {
        let words = CratePatchEditor.requestWords(prompt)
        // Exact words. "Soft" is a pad, not a request for velocity.
        let cues: Set<String> = ["harder", "velocity", "touch", "dynamic", "expressive"]
        // A lowpass opening is brighter; a highpass opening is thinner, which
        // is the opposite of what playing harder should do.
        let opening: Set<String> = [
            "lowpass", "ladder", "svflowpass", "slopelowpass12", "slopelowpass24",
            "onepolelowpass", "bandpass", "svfbandpass", "SynthVoice",
        ]
        guard words.contains(where: cues.contains),
              let keys = patch.nodes.first(where: { $0.kind == catalog.io.keyboard || $0.kind == catalog.io.midiIn })
        else { return (patch, nil) }
        var next = patch
        var added = false
        func openable(_ node: CratePatchNode) -> Bool {
            opening.contains(node.kind)
                && catalog.material(node.kind)?.param("cutoff") != nil
                && !next.connections.contains { $0.target == node.id && $0.targetInput == "cutoff" }
        }
        // A bell has no filter to open. Asked to open up anyway, it gets one,
        // just before the output and set where a hard note is bright and a
        // soft one is round.
        if !next.nodes.contains(where: openable) {
            let made = CratePatchEditor.apply(
                [
                    CrateGenEdit(op: .addModule, kind: "lowpass"),
                    CrateGenEdit(op: .setParam, node: "lowpass", param: "cutoff", value: 2400),
                    CrateGenEdit(op: .setParam, node: "lowpass", param: "q", value: 0.8),
                ],
                to: next, catalog: catalog
            )
            guard let id = made.patch.nodes.map(\.id).first(where: { patch.node($0) == nil }) else { return (patch, nil) }
            let placed = CratePatchEditor.completeAdditions(made.patch, added: [id], request: "", catalog: catalog)
            guard placed.patch.connections.contains(where: { $0.target == id }) else { return (patch, nil) }
            next = placed.patch
            added = true
        }
        guard let filter = next.nodes.first(where: openable),
              CratePatchEditor.connect(
                  (keys.id, "velocity"), to: filter, inlet: "cutoff", in: &next, catalog: catalog, depth: 0.7
              )
        else { return (patch, nil) }
        return (next, added
            ? "a lowpass was added so playing harder can open it"
            : "playing harder opens \(filter.id)")
    }

    // MARK: - Level

    /// How loud the patch is, as RMS over half a second of a held note or of
    /// a 220 Hz tone fed in, whichever this patch takes. Nil when it does not
    /// compile.
    public static func loudness(_ patch: CratePatch, catalog: MaterialCatalog, seconds: Double = 0.5) -> Double? {
        levels(patch, catalog: catalog, seconds: seconds)?.rms
    }

    /// RMS and peak together, from one render.
    public static func levels(
        _ patch: CratePatch,
        catalog: MaterialCatalog,
        seconds: Double = 0.5
    ) -> (rms: Double, peak: Double)? {
        guard let compiled = try? CrateFlatten.flatten(patch, catalog: catalog, name: "Level"),
              let voice = try? CompiledVoice(document: compiled.graph)
        else { return nil }
        let frames = Int(48_000 * seconds)
        let state = voice.makeState()
        state.setParams(ParameterMap(compiled.params).defaults)
        // A note-on, as the AUv3 sends it; see `CratePatchAudit.listen`.
        state.setParam("note", 57)
        state.setParam("velocity", 100.0 / 127.0)
        state.gate = true
        let insert = patch.nodes.contains { $0.kind == catalog.io.line }
        var input = [Float](repeating: 0, count: frames)
        for index in 0..<frames {
            input[index] = Float(sin(2 * Double.pi * 220 * Double(index) / 48_000) * 0.3)
        }
        var out = [Float](repeating: 0, count: frames)
        var right: [Float]? = nil
        _ = voice.renderBlock(
            state, sampleRate: 48_000, output: &out,
            input: insert ? input : nil, outputR: &right,
            transport: TransportSnapshot(playing: true)
        )
        let sum = out.reduce(0.0) { $0 + Double($1) * Double($1) }
        let rms = (sum / Double(frames)).squareRoot()
        let peak = out.reduce(0.0) { Swift.max($0, Double(abs($1))) }
        return rms.isFinite && peak.isFinite ? (rms, peak) : nil
    }

    /// Puts the tuned patch back at the level the starting patch played at.
    ///
    /// Tuning moves levels as a side effect: more resonance, more drive, a
    /// wetter reverb, a waveform with more energy in it. The factory patches
    /// are voiced to sit together, and a generated one that is twice as loud
    /// is the one that clips the track. So the last gain before the output
    /// is turned until the two match. Within a decibel or so of each other is
    /// left alone; that is taste, not a mistake.
    ///
    /// RMS decides and the peak caps it. A pluck tuned shorter has less
    /// energy in half a second and the same transient, so matching RMS alone
    /// turned a marimba up until it peaked at 1.36.
    public static func matchLevel(
        _ patch: CratePatch,
        to reference: (rms: Double, peak: Double),
        catalog: MaterialCatalog
    ) -> (patch: CratePatch, note: String?) {
        guard reference.rms > 1e-5,
              let now = levels(patch, catalog: catalog), now.rms > 1e-5, now.peak > 1e-5
        else { return (patch, nil) }
        let ceiling = Swift.min(0.95, Swift.max(reference.peak, 0.3) * 1.1)
        let ratio = Swift.min(reference.rms / now.rms, ceiling / now.peak)
        guard ratio < 0.8 || ratio > 1.25 else { return (patch, nil) }
        guard let index = outputGain(patch, catalog: catalog),
              let descriptor = catalog.material("gain")?.param("gain")
        else { return (patch, nil) }
        var next = patch
        let current = next.nodes[index].params["gain"] ?? descriptor.defaultValue
        let wanted = Swift.min(descriptor.max, Swift.max(descriptor.min, current * ratio))
        next.nodes[index].params["gain"] = CrateFlatten.quantize(descriptor, wanted)
        let id = next.nodes[index].id
        return (next, "\(id) turned \(ratio > 1 ? "up" : "down") to the level the starting patch played at")
    }

    /// The last plain gain on the way out: walked back from Master through
    /// anything that has a single audio feed, stopping at the first `gain`.
    static func outputGain(_ patch: CratePatch, catalog: MaterialCatalog) -> Int? {
        guard let master = patch.nodes.first(where: { $0.kind == catalog.io.master }) else { return nil }
        var current = master.id
        var inlet = "input"
        for _ in 0..<6 {
            let feeds = patch.sources(into: current, inlet: inlet)
            guard feeds.count == 1, let feed = patch.node(feeds[0].source) else { return nil }
            if feed.kind == "gain",
               !patch.connections.contains(where: { $0.target == feed.id && $0.targetInput == "gain" }) {
                return patch.nodes.firstIndex { $0.id == feed.id }
            }
            guard let material = catalog.material(feed.kind), material.audioInputs.contains("input") else { return nil }
            current = feed.id
            inlet = "input"
        }
        return nil
    }
}
