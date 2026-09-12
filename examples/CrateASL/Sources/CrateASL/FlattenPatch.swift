import Foundation

/// Turning a patch document into one ASL graph a voice can run.
///
/// The Swift half of `src/patcher/flattenPatch.ts`, held to it by
/// `fixtures/flatten-conformance.json`. A patcher that cannot do this can
/// draw a graph and not play it: the compiled graph inside a `crate.plugin`
/// is the *output* of flattening, so a host that edits patches has to own
/// the lowering itself.
///
/// A patch is modular-synth topology: N Materials sharing one signal path.
/// A hosted plugin is the other shape: one graph, one `VoicePool`, N copies
/// of the whole chain, one per voice. Flattening converts the first into the
/// second by splicing every node's ASL graph into a single graph:
///
///  - An audio cable into an inlet replaces that inlet's `port` node with the
///    upstream node's output. Stacked cables mix.
///  - A CV cable into a param replaces that `param` node with the upstream
///    signal mapped onto the param's declared range. Unipolar sources (ADSR)
///    are lifted 0..1 to -1..1 first so 0 is the minimum; bipolar ones (LFO)
///    already sit on -1..1.
///  - Every remaining declared param is republished as `{nodeId}_{name}`, so
///    two gains in one patch do not collide.
///  - Keyboard, Line, Master, Transport and the MIDI tools are host I/O, not
    ///    DSP. Master is the output tap, Line is the hosted insert's own input,
    ///    and a Keyboard cable into a note jack only marks the patch as an
    ///    instrument: the inner graph's `note` and `velocity` params already read
    ///    the voice. A cable from another module into `note`, `velocity`,
    ///    `gate` or `trig` replaces that inner param with the upstream signal
    ///    in real units: MIDI 48..72 for `note`, 0..1 for the others. That is
    ///    how a generative oscillator plays without a keyboard.
///
/// Deliberately ASL-only. A patch naming a kernel slot cannot flatten,
/// because the flattened graph would need that kernel bound per voice, which
/// is the portable kernel path and not this one.
public enum CrateFlatten {

    public enum Role: String, Sendable {
        case insert
        case instrument
    }

    /// Inlets a keyboard drives per note rather than per sample.
    private static let noteInputs: Set<String> = ["note", "gate", "velocity", "trig", "clock"]

    // MARK: - Role

    /// Any keyboard or MIDI In cable into a note jack means instrument.
    ///
    /// A cable into MIDI Out does not count: that tool is a sink, so a patch
    /// that only forwards notes to a hardware port is still an insert.
    public static func detectRole(_ patch: CratePatch, catalog: MaterialCatalog) -> Role {
        let io = catalog.io
        var kinds = [String: String]()
        for node in patch.nodes { kinds[node.id] = node.kind }
        for connection in patch.connections {
            let source = kinds[connection.source]
            if kinds[connection.target] == io.midiOut { continue }
            if (source == io.keyboard || source == io.midiIn),
               noteInputs.contains(connection.targetInput) {
                return .instrument
            }
        }
        return .insert
    }

    // MARK: - Flatten

    /// Lowers a patch to the document `adoptGraph` runs.
    ///
    /// - Parameters:
    ///   - role: omit to detect it from the patch's keyboard cables.
    ///   - polyphony: omit to take the largest polyphony among the patch's
    ///     own materials, which is what makes a patch containing a
    ///     eight-voice oscillator an eight-voice instrument without anybody
    ///     saying so.
    public static func flatten(
        _ patch: CratePatch,
        catalog: MaterialCatalog,
        name: String = "Patch",
        role: Role? = nil,
        polyphony: Int? = nil
    ) throws -> CompiledMaterialDocument {
        let io = catalog.io
        let role = role ?? detectRole(patch, catalog: catalog)
        let ids = NodeIdAllocator()

        var kinds = [String: String]()
        for node in patch.nodes { kinds[node.id] = node.kind }

        // Document order, not a dictionary's order: the topological sort is
        // seeded from this and the parameter addresses come out of that sort,
        // so an unstable order here is a project whose automation lanes move
        // when it is reopened.
        var materialIds = [String]()
        var entries = [String: CatalogMaterialEntry]()
        var values = [String: [String: Double]]()
        for node in patch.nodes {
            if io.contains(node.kind) { continue }
            guard let entry = catalog.material(node.kind) else {
                if let kernel = catalog.kernel(node.kind) {
                    throw ASLCompileError(
                        "\"\(kernel.label)\" \(kernel.reason). Only pure ASL materials flatten; "
                            + "kernel DSP ships as its own plugin."
                    )
                }
                throw ASLCompileError(
                    "nothing in the catalog resolves kind \"\(node.kind)\" (node \"\(node.id)\")"
                )
            }
            materialIds.append(node.id)
            entries[node.id] = entry
            values[node.id] = resolvedParams(entry, node.params)
        }

        if materialIds.isEmpty {
            throw ASLCompileError("the patch has no materials to flatten")
        }
        guard patch.nodes.contains(where: { $0.kind == io.master }) else {
            throw ASLCompileError("the patch has no \"\(io.master)\" node, so it has no output")
        }

        let order = try topoSort(patch, materialIds: materialIds, entries: entries, kinds: kinds, io: io)

        var flattened = [String: FlatNode]()
        for id in order {
            let entry = entries[id]!
            var audioSources = [String: [FlatNode]]()
            var cvSources = [String: [FlatNode]]()
            var cvOrder = [String]()
            var cvAbsolute = [String: FlatNode]()

            for connection in patch.connections where connection.target == id {
                let sourceKind = kinds[connection.source]
                // A keyboard contributes no node. The inner graph's own
                // `note` and `gate` params are what the voice writes, so the
                // cable is a statement about role and nothing else.
                if sourceKind == io.keyboard || sourceKind == io.midiIn { continue }
                let inlet = connection.targetInput

                if sourceKind == io.transport {
                    guard let field = transportOutlet(connection.sourceOutput, ids: ids) else { continue }
                    place(field, inlet: inlet, entry: entry, audio: &audioSources, absolute: &cvAbsolute)
                    continue
                }

                if let sourceKind, let source = catalog.material(sourceKind),
                   source.isAnalysis, connection.sourceOutput != "audio" {
                    guard let audio = flattened[connection.source],
                          let field = analysisOutlet(connection.sourceOutput, audio: audio, ids: ids)
                    else { continue }
                    place(field, inlet: inlet, entry: entry, audio: &audioSources, absolute: &cvAbsolute)
                    continue
                }

                if let sourceKind, let source = catalog.material(sourceKind),
                   source.isLooper, isLooperPulse(connection.sourceOutput) {
                    guard let audio = flattened[connection.source],
                          let field = looperOutlet(connection.sourceOutput, audio: audio, ids: ids)
                    else { continue }
                    if entry.isAudioInlet(inlet) {
                        push(&audioSources, inlet, field)
                    } else if entry.params[inlet] != nil {
                        // A pulse is 0 or 1, so it is lifted before the range
                        // map the way any other unipolar source is. Unlike an
                        // analysis outlet, it is not already in real units.
                        push(&cvSources, inlet, asBipolar(field, unipolar: true, ids: ids), order: &cvOrder)
                    }
                    continue
                }

                if entry.isAudioInlet(inlet) {
                    let node = sourceKind == io.line ? insertInput(ids: ids) : flattened[connection.source]
                    if let node { push(&audioSources, inlet, node) }
                    continue
                }

                if Self.noteInputs.contains(inlet), sourceKind != io.line {
                    if let node = flattened[connection.source] {
                        let unipolar = entries[connection.source]?.isUnipolar ?? false
                        cvAbsolute[inlet] = voiceJack(
                            asBipolar(node, unipolar: unipolar, ids: ids),
                            inlet: inlet,
                            ids: ids
                        )
                    }
                    continue
                }

                if entry.params[inlet] != nil, sourceKind != io.line {
                    if let node = flattened[connection.source] {
                        let unipolar = entries[connection.source]?.isUnipolar ?? false
                        push(
                            &cvSources,
                            inlet,
                            asBipolar(node, unipolar: unipolar, ids: ids),
                            order: &cvOrder
                        )
                    }
                }
            }

            var cv = cvAbsolute
            for param in cvOrder {
                guard cv[param] == nil, let sources = cvSources[param], !sources.isEmpty else { continue }
                guard let descriptor = entry.params[param] else { continue }
                cv[param] = ids.node(
                    "range",
                    inputs: ["source": mix(sources, ids: ids)],
                    params: ["min": .number(descriptor.min), "max": .number(descriptor.max)]
                )
            }

            let instance = instantiate(entry.graph.output, ids: ids)
            flattened[id] = rewrite(
                instance,
                context: RewriteContext(
                    audio: audioSources,
                    cv: cv,
                    declared: Set(entry.params.keys),
                    prefix: id,
                    ids: ids
                )
            )
        }

        var outputs = [FlatNode]()
        for connection in patch.connections where kinds[connection.target] == io.master {
            let sourceKind = kinds[connection.source]
            let node: FlatNode?
            if sourceKind == io.line {
                node = insertInput(ids: ids)
            } else if sourceKind == io.transport {
                node = transportOutlet(connection.sourceOutput, ids: ids)
            } else if let sourceKind, let source = catalog.material(sourceKind),
                      source.isLooper, isLooperPulse(connection.sourceOutput) {
                node = flattened[connection.source]
                    .flatMap { looperOutlet(connection.sourceOutput, audio: $0, ids: ids) }
            } else {
                node = flattened[connection.source]
            }
            if let node { outputs.append(node) }
        }
        if outputs.isEmpty {
            throw ASLCompileError(
                "nothing is patched into the \"\(io.master)\" node; the plugin would be silent"
            )
        }
        let output = mix(outputs, ids: ids)

        var published = [String: CrateParamDescriptor]()
        var publishedOrder = [String]()
        var address = 0
        for id in order {
            let entry = entries[id]!
            for (param, descriptor) in entry.orderedParams {
                if cvReplaced(patch, kinds: kinds, entries: entries, io: io, id: id, param: param) {
                    continue
                }
                // Fresh sequential addresses: the inner materials' own
                // addresses collide across nodes, and a hosted parameter tree
                // addresses by number.
                let key = "\(id)_\(param)"
                published[key] = descriptor.republished(
                    defaultValue: values[id]?[param] ?? descriptor.defaultValue,
                    address: address
                )
                publishedOrder.append(key)
                address += 1
            }
        }

        let voices: Int
        if role == .instrument {
            voices = polyphony ?? max(1, materialIds.compactMap { entries[$0]?.polyphony }.max() ?? 1)
        } else {
            voices = 1
        }

        return CompiledMaterialDocument(
            graph: ASLGraphDocument(inputs: publishedOrder, output: document(output)),
            params: published,
            name: name,
            role: role.rawValue,
            polyphony: voices,
            ports: portNames(output)
        )
    }

    // MARK: - Parameter values

    /// A node's parameter values: the material's defaults, with whatever the
    /// document set on top.
    ///
    /// Out of range keeps the default rather than clamping, which is what
    /// `setParam` throwing inside a `try/catch` amounts to on the other side.
    /// Off the grid snaps, because an automation lane interpolates and a
    /// fader drag lands wherever the finger did.
    static func resolvedParams(
        _ entry: CatalogMaterialEntry,
        _ set: [String: Double]
    ) -> [String: Double] {
        var values = [String: Double]()
        for (name, descriptor) in entry.params { values[name] = descriptor.defaultValue }
        for (name, value) in set {
            guard let descriptor = entry.params[name] else { continue }
            guard value >= descriptor.min, value <= descriptor.max else { continue }
            values[name] = quantize(descriptor, value)
        }
        return values
    }

    /// Legal values are `min + k * step`. Re-derived from the grid rather
    /// than trusting float accumulation, so a stepped value compares equal to
    /// the same value written by hand.
    static func quantize(_ descriptor: CrateParamDescriptor, _ value: Double) -> Double {
        guard let step = descriptor.step, step > 0 else { return value }
        let snapped = descriptor.min + ((value - descriptor.min) / step).rounded() * step
        return Swift.min(descriptor.max, Swift.max(descriptor.min, roundToGrid(snapped, step)))
    }

    private static func roundToGrid(_ value: Double, _ step: Double) -> Double {
        let decimals = decimals(of: step)
        if decimals == 0 { return value.rounded() }
        let scale = pow(10.0, Double(decimals))
        return (value * scale).rounded() / scale
    }

    private static func decimals(of step: Double) -> Int {
        if step == step.rounded() { return 0 }
        // Swift's shortest round-trip description, the same thing `String(step)`
        // gives JavaScript for every step a parameter declares. An exponent
        // form means more precision than a grid ever needs, so it takes the
        // cap rather than being parsed.
        let text = String(step)
        if text.contains("e") || text.contains("E") { return 9 }
        guard let dot = text.firstIndex(of: ".") else { return 0 }
        return Swift.min(9, text.distance(from: text.index(after: dot), to: text.endIndex))
    }

    // MARK: - Placement

    private static func place(
        _ field: FlatNode,
        inlet: String,
        entry: CatalogMaterialEntry,
        audio: inout [String: [FlatNode]],
        absolute: inout [String: FlatNode]
    ) {
        if entry.isAudioInlet(inlet) {
            push(&audio, inlet, field)
        } else if entry.params[inlet] != nil {
            // Already in real units, so it lands on the param directly rather
            // than through a `range`. A tempo of 132 is 132, not -1..1 mapped
            // onto the param's bounds.
            absolute[inlet] = field
        }
    }

    private static func push(_ map: inout [String: [FlatNode]], _ key: String, _ node: FlatNode) {
        map[key, default: []].append(node)
    }

    private static func push(
        _ map: inout [String: [FlatNode]],
        _ key: String,
        _ node: FlatNode,
        order: inout [String]
    ) {
        if map[key] == nil { order.append(key) }
        map[key, default: []].append(node)
    }

    // MARK: - Node construction

    /// The hosted insert's own main input, whatever inlet the cable landed on.
    private static func insertInput(ids: NodeIdAllocator) -> FlatNode {
        ids.node("port", params: ["name": .string("input")])
    }

    private static func mix(_ nodes: [FlatNode], ids: NodeIdAllocator) -> FlatNode {
        nodes.count == 1 ? nodes[0] : ids.node("mix", list: nodes)
    }

    /// A graph-driven voice jack is in real units, not a param range map.
    private static func voiceJack(_ source: FlatNode, inlet: String, ids: NodeIdAllocator) -> FlatNode {
        let midi = inlet == "note"
        return ids.node(
            "range",
            inputs: ["source": source],
            params: ["min": .number(midi ? 48 : 0), "max": .number(midi ? 72 : 1)]
        )
    }

    /// `range` reads -1..1. A unipolar 0..1 source becomes that first.
    private static func asBipolar(_ node: FlatNode, unipolar: Bool, ids: NodeIdAllocator) -> FlatNode {
        guard unipolar else { return node }
        let doubled = ids.node("mul", inputs: ["a": node, "b": ids.constant(2)])
        return ids.node("add", inputs: ["a": doubled, "b": ids.constant(-1)])
    }

    /// A Transport tool outlet is the matching `transport.*` field, in real units.
    private static func transportOutlet(_ output: String, ids: NodeIdAllocator) -> FlatNode? {
        switch output {
        case "bpm", "beats", "bars", "playing", "beatsPerBar", "beatUnit":
            return ids.node("transport", params: ["field": .string(output)])
        case "phase":
            return ids.node("transport", inputs: ["length": ids.constant(1)], params: ["field": .string("phase")])
        case "pulse", "cv", "audio":
            return ids.node("transport", inputs: ["length": ids.constant(1)], params: ["field": .string("pulse")])
        default:
            return nil
        }
    }

    private static func isLooperPulse(_ output: String) -> Bool {
        output == "start" || output == "end"
    }

    /// A looper's pulse outlet is the same looper node with its `field`
    /// swapped, sharing the looper's inputs. Not a second looper: two loopers
    /// fed one signal record two takes.
    private static func looperOutlet(
        _ output: String,
        audio: FlatNode,
        ids: NodeIdAllocator
    ) -> FlatNode? {
        guard isLooperPulse(output), let proto = findLooper(audio) else { return nil }
        var params = proto.params
        params["field"] = .string(output)
        return ids.node("looper", inputs: proto.inputs, params: params)
    }

    private static func findLooper(_ node: FlatNode, seen: inout Set<Int>) -> FlatNode? {
        if seen.contains(node.id) { return nil }
        seen.insert(node.id)
        if node.kind == "looper", (node.params["field"]?.string ?? "audio") == "audio" { return node }
        for key in node.inputs.keys.sorted() {
            if let found = findLooper(node.inputs[key]!, seen: &seen) { return found }
        }
        for child in node.list ?? [] {
            if let found = findLooper(child, seen: &seen) { return found }
        }
        return nil
    }

    private static func findLooper(_ node: FlatNode) -> FlatNode? {
        var seen = Set<Int>()
        return findLooper(node, seen: &seen)
    }

    private static func analysisOutlet(
        _ output: String,
        audio: FlatNode,
        ids: NodeIdAllocator
    ) -> FlatNode? {
        switch output {
        case "peak":
            return ids.node("peak", inputs: ["input": audio, "release": ids.constant(0.3)])
        case "rms":
            return ids.node("rms", inputs: ["input": audio, "windowSec": ids.constant(0.05)])
        case "note", "midi":
            return pitch(audio, field: "midi", ids: ids)
        case "cv":
            // A volt-per-octave reading, not the midi number: (midi - 69) / 12.
            let midi = pitch(audio, field: "midi", ids: ids)
            let offset = ids.node("add", inputs: ["a": midi, "b": ids.constant(-69)])
            return ids.node("mul", inputs: ["a": offset, "b": ids.constant(1.0 / 12.0)])
        case "hz", "cents", "gate":
            return pitch(audio, field: output, ids: ids)
        default:
            return nil
        }
    }

    private static func pitch(_ audio: FlatNode, field: String, ids: NodeIdAllocator) -> FlatNode {
        ids.node("pitch", inputs: ["input": audio], params: ["field": .string(field)])
    }

    // MARK: - Rewriting

    private struct RewriteContext {
        let audio: [String: [FlatNode]]
        let cv: [String: FlatNode]
        let declared: Set<String>
        let prefix: String
        let ids: NodeIdAllocator
        let memo = Memo()
        let renamed = Memo()

        final class Memo {
            var byId = [Int: FlatNode]()
            var byName = [String: FlatNode]()
        }
    }

    /// Rebuilds a material's graph with substitutions, preserving shared
    /// subtrees.
    ///
    /// The interpreter keys per-node state by id, so an untouched node keeps
    /// its identity and only a touched path gets fresh ids. Param nodes that
    /// are *not* declared params (`note`, `velocity`, the live voice inputs)
    /// pass through untouched: they resolve by name against the flattened
    /// voice, which is exactly what makes the instrument case work.
    private static func rewrite(_ node: FlatNode, context: RewriteContext) -> FlatNode {
        if let cached = context.memo.byId[node.id] { return cached }
        let result: FlatNode
        if node.kind == "param" {
            let name = node.params["name"]?.string ?? ""
            if let replacement = context.cv[name] {
                result = replacement
            } else if context.declared.contains(name) {
                if let already = context.renamed.byName[name] {
                    result = already
                } else {
                    let renamed = context.ids.node(
                        "param",
                        params: ["name": .string("\(context.prefix)_\(name)")]
                    )
                    context.renamed.byName[name] = renamed
                    result = renamed
                }
            } else {
                result = node
            }
        } else if node.kind == "port" {
            let name = node.params["name"]?.string ?? ""
            if let sources = context.audio[name], !sources.isEmpty {
                result = mix(sources, ids: context.ids)
            } else {
                result = node
            }
        } else {
            var changed = false
            var inputs = [String: FlatNode]()
            for (key, child) in node.inputs {
                let next = rewrite(child, context: context)
                inputs[key] = next
                if next !== child { changed = true }
            }
            var list: [FlatNode]?
            if let children = node.list {
                let next = children.map { rewrite($0, context: context) }
                if zip(next, children).contains(where: { $0.0 !== $0.1 }) { changed = true }
                list = next
            }
            result = changed
                ? context.ids.node(node.kind, inputs: inputs, params: node.params, list: list ?? node.list)
                : node
        }
        context.memo.byId[node.id] = result
        return result
    }

    // MARK: - Ordering

    /// Material-to-material edges only: audio and CV both order evaluation,
    /// and cables to or from the host I/O nodes constrain nothing.
    private static func topoSort(
        _ patch: CratePatch,
        materialIds: [String],
        entries: [String: CatalogMaterialEntry],
        kinds: [String: String],
        io: PatchIoKinds
    ) throws -> [String] {
        var incoming = [String: Set<String>]()
        // Ordered, unlike `incoming`, because draining it decides the order
        // independent branches come out in, and that order is what parameter
        // addresses are assigned in. A sorted or hashed order here would
        // still be a valid topological sort and would still move every
        // automation lane in an existing project.
        var outgoing = [String: [String]]()
        for id in materialIds {
            incoming[id] = []
            outgoing[id] = []
        }
        let isMaterial = Set(materialIds)
        for connection in patch.connections {
            guard isMaterial.contains(connection.source), isMaterial.contains(connection.target) else {
                continue
            }
            if kinds[connection.source] == io.keyboard || kinds[connection.source] == io.midiIn {
                continue
            }
            guard let target = entries[connection.target] else { continue }
            let relevant = target.isAudioInlet(connection.targetInput)
                || target.params[connection.targetInput] != nil
                || noteInputs.contains(connection.targetInput)
            if !relevant { continue }
            incoming[connection.target]?.insert(connection.source)
            if !(outgoing[connection.source]?.contains(connection.target) ?? false) {
                outgoing[connection.source]?.append(connection.target)
            }
        }

        var order = [String]()
        // Seeded in document order and drained from the front, which is what
        // makes two independent branches come out in the order they were
        // written rather than in a dictionary's order.
        var ready = materialIds.filter { incoming[$0]?.isEmpty ?? true }
        var head = 0
        while head < ready.count {
            let id = ready[head]
            head += 1
            order.append(id)
            for next in outgoing[id] ?? [] {
                incoming[next]?.remove(id)
                if incoming[next]?.isEmpty ?? false {
                    incoming[next] = nil
                    ready.append(next)
                }
            }
        }
        if order.count != materialIds.count {
            throw ASLCompileError(
                "the patch has a feedback cycle, which a single flattened graph cannot express"
            )
        }
        return order
    }

    private static func cvReplaced(
        _ patch: CratePatch,
        kinds: [String: String],
        entries: [String: CatalogMaterialEntry],
        io: PatchIoKinds,
        id: String,
        param: String
    ) -> Bool {
        guard let entry = entries[id] else { return false }
        if entry.isAudioInlet(param) { return false }
        return patch.connections.contains { connection in
            guard connection.target == id, connection.targetInput == param else { return false }
            let sourceKind = kinds[connection.source]
            if sourceKind == io.keyboard || sourceKind == io.midiIn { return false }
            return entries[connection.source] != nil || sourceKind == io.transport
        }
    }

    // MARK: - Document conversion

    /// A fresh mutable copy of a catalog graph, with ids minted from this
    /// flatten's allocator.
    ///
    /// The remap is not optional. Every material in the catalog numbers its
    /// nodes from zero, so splicing two of them without new ids would make
    /// one filter share the interpreter's per-node state with another: two
    /// delay lines collapsing into one, which sounds almost right.
    private static func instantiate(_ document: ASLNodeDocument, ids: NodeIdAllocator) -> FlatNode {
        var memo = [Int: FlatNode]()
        return instantiate(document, ids: ids, memo: &memo)
    }

    private static func instantiate(
        _ document: ASLNodeDocument,
        ids: NodeIdAllocator,
        memo: inout [Int: FlatNode]
    ) -> FlatNode {
        if let already = memo[document.id] { return already }
        let node = FlatNode(id: ids.mint(), kind: document.kind, params: document.params)
        // Recorded before the children are walked, so a cycle in a malformed
        // document terminates instead of recursing forever.
        memo[document.id] = node
        for (key, child) in document.inputs {
            node.inputs[key] = instantiate(child, ids: ids, memo: &memo)
        }
        if let list = document.list {
            node.list = list.map { instantiate($0, ids: ids, memo: &memo) }
        }
        return node
    }

    /// Back to the document form. A shared node is written out once per
    /// reference with the same id each time, which is the contract
    /// `ASLNodeDocument` states and what `CompiledVoice` re-shares on.
    private static func document(_ node: FlatNode) -> ASLNodeDocument {
        var memo = [Int: ASLNodeDocument]()
        return document(node, memo: &memo)
    }

    private static func document(_ node: FlatNode, memo: inout [Int: ASLNodeDocument]) -> ASLNodeDocument {
        if let already = memo[node.id] { return already }
        var inputs = [String: ASLNodeDocument]()
        for (key, child) in node.inputs { inputs[key] = document(child, memo: &memo) }
        let list = node.list?.map { document($0, memo: &memo) }
        let out = ASLNodeDocument(id: node.id, kind: node.kind, params: node.params, inputs: inputs, list: list)
        memo[node.id] = out
        return out
    }

    /// Every port name the flattened graph still reads, sorted. Sorted rather
    /// than in discovery order so it cannot depend on how a builder happened
    /// to walk its own tree.
    private static func portNames(_ output: FlatNode) -> [String] {
        var names = Set<String>()
        var seen = Set<Int>()
        collectPorts(output, into: &names, seen: &seen)
        return names.sorted()
    }

    private static func collectPorts(_ node: FlatNode, into names: inout Set<String>, seen: inout Set<Int>) {
        if seen.contains(node.id) { return }
        seen.insert(node.id)
        if node.kind == "port", let name = node.params["name"]?.string { names.insert(name) }
        for child in node.inputs.values { collectPorts(child, into: &names, seen: &seen) }
        for child in node.list ?? [] { collectPorts(child, into: &names, seen: &seen) }
    }
}

/// A graph node while it is being spliced.
///
/// A reference type on purpose. The rewrite preserves a DAG by keeping the
/// same object where nothing changed, and value semantics would silently turn
/// every shared subgraph into copies: the graph would still sound right on a
/// filter and wrong on anything with state, which is the worst place for this
/// distinction to be invisible.
final class FlatNode {
    let id: Int
    let kind: String
    var params: [String: ASLValue]
    var inputs: [String: FlatNode]
    var list: [FlatNode]?

    init(
        id: Int,
        kind: String,
        params: [String: ASLValue] = [:],
        inputs: [String: FlatNode] = [:],
        list: [FlatNode]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.params = params
        self.inputs = inputs
        self.list = list
    }
}

/// Hands out node ids for one flatten.
///
/// Ids only have to be unique within the graph being built. The JavaScript
/// side counts globally across the process, which is why the two sides cannot
/// be compared on their raw documents and the conformance fixture compares a
/// canonical renumbering instead.
final class NodeIdAllocator {
    private var next = 0

    func mint() -> Int {
        defer { next += 1 }
        return next
    }

    func node(
        _ kind: String,
        inputs: [String: FlatNode] = [:],
        params: [String: ASLValue] = [:],
        list: [FlatNode]? = nil
    ) -> FlatNode {
        FlatNode(id: mint(), kind: kind, params: params, inputs: inputs, list: list)
    }

    func constant(_ value: Double) -> FlatNode {
        node("const", params: ["value": .number(value)])
    }
}
