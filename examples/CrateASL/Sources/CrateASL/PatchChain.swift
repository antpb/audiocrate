import Foundation

/// Effect descriptions that name more than one effect, read as a chain.
///
/// "A flanger with bit crushing" and "slow evolving filter sweeps on top of
/// bit crushing" are two effects each, in an order, and each one with its
/// own character. The model was asked to pick one category out of seven and
/// one patch out of that, and then told a second effect was "usually none".
/// So the crushing won, the category it sits in is called Drive & Crush, and
/// every patch in that category is a distortion. What came back was heavy
/// distortion, every time, because greedy sampling made it the same patch
/// every time.
///
/// None of this is a judgment call. Splitting a sentence at "with" and "on
/// top of" and matching "crushing" to the Bitcrusher is arithmetic, and the
/// on-device model is better spent on the knobs.
extension CrateGenStart {

    /// How hard a stage is pushed. A stage the words do not qualify is at
    /// full strength when it is the first one named and at medium otherwise:
    /// the second thing in "a flanger with bit crushing" is the seasoning.
    public enum Intensity: Int, Sendable, Comparable {
        case light, medium, full
        public static func < (a: Intensity, b: Intensity) -> Bool { a.rawValue < b.rawValue }
    }

    /// One effect in the chain: the words that asked for it, the patches
    /// that answer them (more than one when the words are general, "a
    /// reverb"), and how hard it is pushed.
    public struct Stage: Sendable {
        public let clause: String
        public let candidates: [FactoryLibrary.Entry]
        public let intensity: Intensity

        public init(clause: String, candidates: [FactoryLibrary.Entry], intensity: Intensity) {
            self.clause = clause
            self.candidates = candidates
            self.intensity = intensity
        }
    }

    /// Effects an instrument does not get as a patch after it, because the
    /// motion pass builds them on the instrument itself: a filter sweep on
    /// a pad is the pad's own filter moving, and vibrato on a lead is its
    /// pitch. Bolted on as effects, the pad would be swept twice.
    public static let movesOnTheInstrument: Set<String> = ["filter-sweep", "vibrato"]

    // MARK: - Clauses

    /// Connectors where the second thing goes after the first in the signal.
    private static let forward: [[String]] = [
        ["followed", "by"], ["and", "then"], ["going", "into"], ["fed", "into"], ["run", "through"],
        ["with"], ["and"], ["plu"], ["into"], ["then"], ["through"], ["before"], ["feeding"],
    ]

    /// Connectors where the second thing comes first: "sweeps on top of
    /// crushing" is the crushing, then the sweeps over it.
    private static let reverse: [[String]] = [
        ["on", "top", "of"], ["layered", "over"], ["over"], ["after"], ["on"],
    ]

    /// The description's clauses in signal order.
    ///
    /// Commas, semicolons and full stops separate like "and". Words are the
    /// same words `requestWords` makes, so "sweeps" is "sweep".
    public static func clauses(_ prompt: String) -> [String] {
        let split = segments(prompt)
        return split.order.map { split.segments[$0] }
    }

    /// The clauses as written, and the order the signal takes through them.
    static func segments(_ prompt: String) -> (segments: [String], order: [Int]) {
        var tokens = [String]()
        for piece in prompt.lowercased().split(whereSeparator: { ",;.".contains($0) }) {
            if !tokens.isEmpty { tokens.append(",") }
            tokens.append(contentsOf: CratePatchEditor.requestWords(String(piece)))
        }

        var segments = [[String]]()
        var reversed = [Bool]()
        var current = [String]()
        var pendingReverse = false
        var index = 0
        func close(_ nextReverse: Bool) {
            if !current.isEmpty {
                segments.append(current)
                reversed.append(pendingReverse)
            }
            current = []
            pendingReverse = nextReverse
        }
        func matches(_ words: [String]) -> Bool {
            index + words.count <= tokens.count && Array(tokens[index..<index + words.count]) == words
        }
        outer: while index < tokens.count {
            if tokens[index] == "," { close(false); index += 1; continue }
            // Longest connector first, so "on top of" is not read as "on".
            let all = (reverse.map { ($0, true) } + forward.map { ($0, false) })
                .sorted { $0.0.count > $1.0.count }
            for (words, isReverse) in all where matches(words) {
                close(isReverse)
                index += words.count
                continue outer
            }
            current.append(tokens[index])
            index += 1
        }
        close(false)

        var order = [Int]()
        for i in segments.indices {
            if i > 0, reversed[i], let at = order.firstIndex(of: i - 1) {
                order.insert(i, at: at)
            } else {
                order.append(i)
            }
        }
        return (segments.map { $0.joined(separator: " ") }, order)
    }

    // MARK: - Matching

    /// Words for effects, matched as word prefixes. Spelled as
    /// `requestWords` leaves them, which drops a plural "s" from any word
    /// over three letters: "chorus" arrives as "choru", "haas" as "haa".
    ///
    /// Matched as word prefixes ("crush" is crushing,
    /// crushed and crusher). A leading "=" means the word exactly: "comp"
    /// as a prefix is also "complex". Each answers with the factory patches
    /// it means, by id; a general word ("reverb") answers with several and
    /// the choice between them is where variety comes from.
    private static let aliases: [(words: [String], ids: [String])] = [
        // Crush
        (["bit", "crush"], ["bitcrusher"]), (["bitcrush"], ["bitcrusher"]), (["crush"], ["bitcrusher"]),
        (["=8bit"], ["bitcrusher"]), (["bit", "depth"], ["bitcrusher"]),
        (["rate", "crush"], ["sample-rate-crush"]), (["sample", "rate"], ["sample-rate-crush"]),
        (["decimat"], ["sample-rate-crush"]), (["downsampl"], ["sample-rate-crush"]), (["aliasing"], ["sample-rate-crush"]),
        // Drive
        (["fuzz"], ["fuzz"]), (["octave", "fuzz"], ["octave-fuzz"]), (["saturat"], ["warm-saturation"]),
        (["tape", "drive"], ["tape-drive"]), (["tape", "saturat"], ["tape-drive"]), (["fold"], ["wavefolder"]),
        (["distort"], ["warm-saturation", "tape-drive", "fuzz"]), (["overdrive"], ["tape-drive", "warm-saturation"]),
        (["=drive"], ["warm-saturation", "tape-drive"]), (["ring", "mod"], ["ring-mod-fx"]), (["ringmod"], ["ring-mod-fx"]),
        // Filter and tone
        (["sweep"], ["filter-sweep"]), (["=wah"], ["auto-wah"]), (["autowah"], ["auto-wah"]), (["auto", "wah"], ["auto-wah"]),
        (["telephone"], ["telephone"]), (["radio"], ["lofi-radio"]), (["lofi"], ["lofi-radio"]), (["=lo", "=fi"], ["lofi-radio"]),
        (["formant"], ["formant"]), (["vowel"], ["formant"]), (["tilt"], ["tilt-eq"]),
        // Modulation
        (["flang"], ["flanger"]), (["=jet"], ["flanger"]), (["phas"], ["phaser"]), (["choru"], ["chorus"]),
        (["trem"], ["tremolo"]), (["vibrato"], ["vibrato"]), (["rotary"], ["rotary"]), (["leslie"], ["rotary"]),
        (["sample", "and", "hold"], ["sample-hold-filter"]), (["autopan"], ["auto-pan"]), (["auto", "pan"], ["auto-pan"]),
        (["panning"], ["auto-pan", "slow-panner"]), (["panner"], ["slow-panner", "auto-pan"]),
        // Delay
        (["delay"], ["tape-echo", "dub-delay", "dotted-eighth", "triplet-echo"]),
        (["echo"], ["tape-echo", "dub-delay", "dotted-eighth", "triplet-echo"]),
        (["tape", "echo"], ["tape-echo"]), (["tape", "delay"], ["tape-echo"]), (["slap"], ["slapback"]),
        (["=dub"], ["dub-delay"]), (["revers"], ["reverse-delay"]), (["octave", "delay"], ["octave-delay"]),
        (["stutter"], ["stutter"]), (["dotted"], ["dotted-eighth"]), (["triplet"], ["triplet-echo"]),
        // Space
        (["reverb"], ["plate", "big-hall", "small-room"]), (["=verb"], ["plate", "big-hall", "small-room"]),
        (["shimmer"], ["shimmer"]), (["plate"], ["plate"]), (["hall"], ["big-hall"]), (["=room"], ["small-room"]),
        (["cave"], ["dark-cavern"]), (["cavern"], ["dark-cavern"]), (["gated", "reverb"], ["gated-reverb"]),
        (["ambient"], ["ambient-wash"]), (["=wash"], ["ambient-wash"]),
        // Dynamics
        (["compress"], ["vocal-comp", "drum-glue", "parallel-comp"]), (["=comp"], ["vocal-comp", "drum-glue"]),
        (["glue"], ["drum-glue"]), (["limit"], ["brickwall"]), (["brickwall"], ["brickwall"]),
        (["=gate"], ["noise-gate"]), (["pump"], ["pump"]), (["sidechain"], ["pump"]), (["duck"], ["pump"]),
        (["transient"], ["punch"]), (["=punch"], ["punch"]),
        // Width
        (["=eq"], ["tilt-eq"]), (["sub", "boost"], ["sub-boost"]), (["mid", "side"], ["mid-side-lift"]),
        (["=mono"], ["mono-below"]), (["stereo", "flip"], ["stereo-flip"]),
        (["widen"], ["widener"]), (["=wide"], ["widener", "haas-spread"]), (["width"], ["widener"]), (["haa"], ["haas-spread"]),
    ]

    private static func wordMatches(_ token: String, _ pattern: String) -> Bool {
        if pattern.hasPrefix("=") { return token == pattern.dropFirst() }
        return token.hasPrefix(pattern)
    }

    /// The patches one clause asks for, best first, or none. One effect per
    /// clause: "a big hall reverb" is the Big Hall, not a Big Hall and a
    /// Plate. The most specific match wins (fewest candidates, then most
    /// words), and between equals the later one, since a clause ends on its
    /// noun: "a fuzzy flanger" is a flanger.
    static func resolve(_ clause: String, effects: [FactoryLibrary.Entry]) -> [FactoryLibrary.Entry] {
        let tokens = clause.split(separator: " ").map(String.init)
        var best: (ids: [String], words: Int, at: Int)?
        for alias in aliases {
            let n = alias.words.count
            guard tokens.count >= n else { continue }
            for start in 0...(tokens.count - n) {
                let hit = (0..<n).allSatisfy { wordMatches(tokens[start + $0], alias.words[$0]) }
                guard hit else { continue }
                if let current = best {
                    let better = alias.ids.count < current.ids.count
                        || (alias.ids.count == current.ids.count && n > current.words)
                        || (alias.ids.count == current.ids.count && n == current.words && start > current.at)
                    if !better { continue }
                }
                best = (alias.ids, n, start)
            }
        }
        // Only the table. Matching the library's own names as well made a
        // lone "slow" the Slow Panner and "warm" the Warm Saturation; those
        // are adjectives far more often than they are requests.
        return (best?.ids ?? []).compactMap { id in effects.first { $0.id == id } }
    }

    private static let heavyWords: Set<String> = [
        "heavy", "heavily", "extreme", "destroyed", "brutal", "harsh", "massive", "nasty",
        "aggressive", "intense", "lot", "huge", "maximum", "wrecked", "mangled",
    ]
    private static let lightWords: Set<String> = [
        "subtle", "touch", "hint", "light", "lightly", "gentle", "slight", "slightly", "mild", "faint",
        "little", "soft", "bit",
    ]

    /// How hard a clause asks for its effect.
    ///
    /// "Bit" is light only when it is not part of "bit crush": "a bit of
    /// crush" is light, "bit crushing" is just the name.
    static func intensity(_ clause: String, first: Bool) -> Intensity {
        let tokens = clause.split(separator: " ").map(String.init)
        var words = Set(tokens)
        if let at = tokens.firstIndex(of: "bit"), at + 1 < tokens.count, tokens[at + 1].hasPrefix("crush") {
            words.remove("bit")
        }
        if !words.isDisjoint(with: heavyWords) { return .full }
        if !words.isDisjoint(with: lightWords) { return .light }
        return first ? .full : .medium
    }

    /// The effects a description names, in signal order, at most three.
    ///
    /// A clause that names no effect is character for its neighbour: "a dark
    /// tape echo with the highs rolled off" is one stage whose clause carries
    /// "the highs rolled off", which is what the tuning pass reads.
    ///
    /// `leadIsNamed` is whether the first effect the sentence names is the
    /// thing it is about. For an effect slot it is; for an instrument the
    /// instrument is, and every effect after it is seasoning.
    public static func chain(
        _ prompt: String,
        effects: [FactoryLibrary.Entry],
        leadIsNamed: Bool = true
    ) -> [Stage] {
        let split = segments(prompt)
        let found = split.segments.map { resolve($0, effects: effects) }
        let lead = leadIsNamed ? found.firstIndex { !$0.isEmpty } : nil

        var stages = [(segment: Int, clause: String, candidates: [FactoryLibrary.Entry])]()
        var orphan = [String]()
        for segment in split.order {
            let clause = split.segments[segment]
            let candidates = found[segment]
            if candidates.isEmpty {
                if stages.isEmpty { orphan.append(clause) } else { stages[stages.count - 1].clause += " " + clause }
                continue
            }
            // The same effect named twice is one effect.
            if stages.contains(where: { Set($0.candidates.map(\.id)) == Set(candidates.map(\.id)) }) { continue }
            stages.append((segment, (orphan + [clause]).joined(separator: " "), candidates))
            orphan = []
        }
        return stages.prefix(3).map { item in
            Stage(
                clause: item.clause,
                candidates: item.candidates,
                intensity: intensity(item.clause, first: item.segment == lead)
            )
        }
    }

    // MARK: - Voicing a stage

    /// A stage softened to its intensity, paced to its words, and set to
    /// play at the level it is fed.
    ///
    /// A bitcrusher at six bits has no dry signal in it, so in series with
    /// a flanger it is the whole sound. Softened, the crush is grit on the
    /// flanger rather than the flanger buried under it. And each stage at
    /// unity means the order of the chain decides the sound, not whichever
    /// patch somebody happened to voice hottest.
    public static func voice(
        _ entry: FactoryLibrary.Entry,
        stage: Stage,
        catalog: MaterialCatalog
    ) -> (patch: CratePatch, notes: [String]) {
        var patch = entry.patch
        var notes = [String]()
        if stage.intensity < .full {
            let light = stage.intensity == .light
            var touched = false
            for index in patch.nodes.indices {
                let node = patch.nodes[index]
                guard let material = catalog.material(node.kind) else { continue }
                func set(_ param: String, _ make: (Double) -> Double) {
                    guard let descriptor = material.param(param), !driven(node.id, param, patch) else { return }
                    let current = node.params[param] ?? descriptor.defaultValue
                    let wanted = Swift.min(descriptor.max, Swift.max(descriptor.min, make(current)))
                    patch.nodes[index].params[param] = CrateFlatten.quantize(descriptor, wanted)
                    touched = true
                }
                switch node.kind {
                case "bitcrush": set("bits") { $0 + (light ? 5 : 2) }
                case "downsample": set("factor") { Swift.max(2, ($0 / (light ? 4 : 2)).rounded()) }
                case "hardclip", "softclip": set("drive") { Swift.max(1, $0 * (light ? 0.35 : 0.6)) }
                case "waveshape":
                    set("drive") { Swift.max(1, $0 * (light ? 0.35 : 0.6)) }
                    set("mix") { $0 * (light ? 0.45 : 0.7) }
                case "ringmod", "comb", "reverb", "delay", "synceddelay":
                    set("mix") { $0 * (light ? 0.5 : 0.75) }
                default: break
                }
            }
            if touched { notes.append("\(entry.name) eased back so it sits under the rest (\(light ? "light" : "medium"))") }
        }

        // Pace, from this stage's own words. "Slow evolving sweeps on top of
        // bit crushing" asks the sweep to be slow, not the crusher.
        let words = Set(stage.clause.split(separator: " ").map(String.init))
        let slow = !words.isDisjoint(with: ["slow", "slowly", "evolving", "evolve", "glacial", "gradual", "lazy", "creeping", "drifting"])
        let fast = !words.isDisjoint(with: ["fast", "quick", "rapid", "frantic", "racing", "speedy"])
        if slow != fast {
            let factor = slow ? 0.4 : 2.5
            var paced = false
            for index in patch.nodes.indices {
                let node = patch.nodes[index]
                let param: String
                switch node.kind {
                case "lfo": param = "rate"
                case "randomsmooth", "randomstepped": param = "freq"
                default: continue
                }
                guard let descriptor = catalog.material(node.kind)?.param(param), !driven(node.id, param, patch) else { continue }
                let current = node.params[param] ?? descriptor.defaultValue
                let wanted = Swift.min(descriptor.max, Swift.max(descriptor.min, current * factor))
                patch.nodes[index].params[param] = CrateFlatten.quantize(descriptor, wanted)
                paced = true
            }
            if paced { notes.append("\(entry.name) moves \(slow ? "slower" : "faster"), as asked") }
        }

        // Unity: what goes in comes out at about the same level. The level
        // probe feeds a 0.3 sine, whose RMS is 0.3 over root two.
        let leveled = matchLevel(patch, to: (rms: 0.3 / 2.0.squareRoot(), peak: 0.6), catalog: catalog)
        patch = leveled.patch
        return (patch, notes)
    }

    private static func driven(_ id: String, _ param: String, _ patch: CratePatch) -> Bool {
        patch.connections.contains { $0.target == id && $0.targetInput == param }
    }

    // MARK: - What makes each module sound like itself

    /// One line per kind of module in the patch, saying which knob carries
    /// the effect's character and what its range sounds like.
    ///
    /// The tuning pass was told "a slow sound wants a long attack", which is
    /// about instruments; nothing told it that a flanger is its feedback or
    /// that six bits is destroyed and twelve is grain. These are the
    /// numbers a person would say out loud, and they cost about twenty
    /// tokens a module.
    public static func moduleHints(_ patch: CratePatch, catalog: MaterialCatalog, limit: Int = 6) -> [String] {
        let hints: [(kind: String, line: String)] = [
            ("comb", "comb: feedback is how hard it rings, 0.6 to 0.9 is a flanger's jet; mix near 0.5 is the deepest notch; freq is where the sweep centres."),
            ("allpass", "allpass: cutoff is where the phaser's notch sits; q is how sharp."),
            ("lfo", "lfo: rate is the speed of the movement, under 0.1 Hz is slow and evolving, 0.2 to 1 Hz a classic sweep, over 4 Hz a wobble or trill."),
            ("randomsmooth", "randomsmooth: freq is how quickly it wanders, under 0.5 Hz is a slow drift."),
            ("randomstepped", "randomstepped: freq is how often it jumps."),
            ("bitcrush", "bitcrush: bits is how crushed, 3 to 5 destroyed, 6 to 8 gritty, 10 to 12 a faint grain."),
            ("downsample", "downsample: factor is how much top is lost, 2 to 4 subtle, 8 metallic, 16 and up broken."),
            ("hardclip", "hardclip: drive is how hard, 1 to 2 edge, 4 and up fuzz."),
            ("softclip", "softclip: drive is how hard, 1 to 2 warmth, 4 and up overdrive."),
            ("waveshape", "waveshape: drive is how hard; mix blends the clean signal back in."),
            ("ringmod", "ringmod: freq under 30 Hz is a tremolo, higher is metallic and bell-like; mix blends."),
            ("svflowpass", "svflowpass: cutoff is brightness; q 2 to 6 makes a sweep vocal and obvious."),
            ("lowpass", "lowpass: cutoff is brightness, low is dark; q is resonance at the edge."),
            ("ladder", "ladder: cutoff is brightness; resonance is the squelch."),
            ("highpass", "highpass: cutoff takes the low end away, higher is thinner."),
            ("bandpass", "bandpass: cutoff is the band you hear, q how narrow."),
            ("reverb", "reverb: size and decay are how big and long, damp under 3000 Hz is dark; mix is how far away."),
            ("delay", "delay: timeSec is the gap, feedback how many repeats, mix how loud they are."),
            ("synceddelay", "synceddelay: division is the rhythm of the repeats, feedback how many, mix how loud."),
            ("autopan", "autopan: rate is how fast it moves side to side."),
            ("syncedtremolo", "syncedtremolo: the rhythm of the volume chop."),
            ("compressor", "compressor: threshold lower and ratio higher squash harder."),
        ]
        let kinds = Set(patch.nodes.map(\.kind))
        var lines = hints.filter { kinds.contains($0.kind) && catalog.material($0.kind) != nil }.map(\.line)
        // The depth of a sweep lives on a gain between the modulator and its
        // target, which is the least obvious knob in a factory patch.
        let modulated = patch.connections.contains { cable in
            guard let source = patch.node(cable.source), let target = patch.node(cable.target) else { return false }
            return ["lfo", "randomsmooth", "randomstepped"].contains(source.kind) && target.kind == "gain"
        }
        if modulated {
            lines.append("a gain fed by an lfo or random source is the depth of that movement: higher reaches further.")
        }
        return Array(lines.prefix(limit))
    }

    // MARK: - Variety

    /// The same patch, not identical: its rates, frequencies and times moved
    /// a little within its own character.
    ///
    /// Two presses of Generate for the same words used to give the same
    /// patch to the last digit, because every choice was greedy. This is
    /// the deterministic half of the fix: small enough that the factory
    /// voicing survives, large enough that the second take is a second take.
    /// The tuning pass runs after it, so anything the words asked for wins.
    public static func vary<G: RandomNumberGenerator>(
        _ patch: CratePatch,
        catalog: MaterialCatalog,
        using rng: inout G
    ) -> CratePatch {
        // Ratio ranges, log-uniform; additive spread for feedback.
        let ratios: [String: [String: ClosedRange<Double>]] = [
            "lfo": ["rate": 0.7...1.4],
            "randomsmooth": ["freq": 0.7...1.4],
            "randomstepped": ["freq": 0.8...1.25],
            "comb": ["freq": 0.75...1.33],
            "ringmod": ["freq": 0.8...1.25],
            "autopan": ["rate": 0.75...1.33],
            "svflowpass": ["cutoff": 0.85...1.18],
            "lowpass": ["cutoff": 0.88...1.14],
            "allpass": ["cutoff": 0.8...1.25],
            "bandpass": ["cutoff": 0.85...1.18],
            "delay": ["timeSec": 0.9...1.1],
            "reverb": ["size": 0.92...1.08, "damp": 0.8...1.25],
        ]
        var next = patch
        for index in next.nodes.indices {
            let node = next.nodes[index]
            guard let material = catalog.material(node.kind) else { continue }
            for (param, range) in ratios[node.kind] ?? [:] {
                guard let descriptor = material.param(param), !driven(node.id, param, next) else { continue }
                let current = node.params[param] ?? descriptor.defaultValue
                let ratio = exp(Double.random(in: log(range.lowerBound)...log(range.upperBound), using: &rng))
                let wanted = Swift.min(descriptor.max, Swift.max(descriptor.min, current * ratio))
                next.nodes[index].params[param] = CrateFlatten.quantize(descriptor, wanted)
            }
            if ["comb", "delay", "synceddelay"].contains(node.kind),
               let descriptor = material.param("feedback"), !driven(node.id, "feedback", next) {
                let current = node.params["feedback"] ?? descriptor.defaultValue
                let wanted = Swift.min(0.9, Swift.max(descriptor.min, current + Double.random(in: -0.06...0.06, using: &rng)))
                next.nodes[index].params["feedback"] = CrateFlatten.quantize(descriptor, wanted)
            }
        }
        return next
    }
}
