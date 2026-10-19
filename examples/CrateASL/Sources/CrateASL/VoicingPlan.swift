import Foundation

/// Which modules of an instrument patch run once per voice and which run
/// once on the sum of all voices.
///
/// The Swift half of `src/patcher/voicing.ts`, rule for rule; read that file
/// for the reasons. `fixtures/flatten-conformance.json` holds the two to the
/// same answer through what `CrateFlatten` builds from it.
///
/// In short: a module is per voice when it is a voice source (polyphony above
/// 1), reads its voice (`note`, `velocity`, `gate`, or a gate-following node),
/// is played by the keyboard, has a per-voice signal on a non-audio input,
/// combines per-voice signals on two or more audio inputs,
/// feeds anything per voice, or is flagged `instanced`. Anything else
/// downstream of a voice is summed. A module no voice reaches is global.
public struct VoicingPlan: Sendable {
    public enum Role: String, Sendable { case instanced, summed, global }

    public let role: [String: Role]
    /// Whether summing is possible without the patch's flags in the way.
    public let canSum: [String: Bool]
    /// Why a module runs per voice, for an inspector.
    public let reason: [String: String]

    /// Node kinds that read the voice's gate when nothing is cabled into theirs.
    static let voiceGateKinds: Set<String> = ["adsr", "dahdsr", "breakpoints", "impulse", "samplePlay"]
    /// Params a voice sets on every note.
    static let voiceParams: Set<String> = ["note", "velocity", "gate"]

    /// Whether a catalog material's own graph reads the voice it is in.
    static func readsVoice(_ entry: CatalogMaterialEntry) -> Bool {
        var seen = Set<Int>()
        func walk(_ node: ASLNodeDocument) -> Bool {
            if !seen.insert(node.id).inserted { return false }
            if voiceGateKinds.contains(node.kind) { return true }
            if node.kind == "param", let name = node.params["name"]?.string,
               voiceParams.contains(name), entry.params[name] == nil {
                return true
            }
            for child in node.inputs.values where walk(child) { return true }
            for child in node.list ?? [] where walk(child) { return true }
            return false
        }
        return walk(entry.graph.output)
    }

    /// - Parameters:
    ///   - entries: catalog entries by node id, I/O nodes absent.
    ///   - voiceSourceKinds: the keyboard and MIDI In kinds.
    ///   - noteInputs: inlets a note source drives.
    static func plan(
        _ patch: CratePatch,
        entries: [String: CatalogMaterialEntry],
        voiceSourceKinds: Set<String>,
        noteInputs: Set<String>
    ) -> VoicingPlan {
        var kinds = [String: String]()
        for node in patch.nodes { kinds[node.id] = node.kind }
        let ids = patch.nodes.map(\.id).filter { entries[$0] != nil }
        let connections = patch.connections

        func isAudioInlet(_ id: String, _ inlet: String) -> Bool { entries[id]!.audioInputs.contains(inlet) }
        func relevant(_ c: CratePatchConnection) -> Bool {
            guard let target = entries[c.target] else { return false }
            return target.audioInputs.contains(c.targetInput)
                || target.params[c.targetInput] != nil
                || noteInputs.contains(c.targetInput)
        }
        func fromVoiceSource(_ c: CratePatchConnection) -> Bool { voiceSourceKinds.contains(kinds[c.source] ?? "") }

        // Insertion-ordered: a dictionary's iteration order would make the
        // first reason recorded for a module depend on hashing.
        var inherentReason = [String: String]()
        var inherentOrder = [String]()
        func setInherent(_ id: String, _ why: String) {
            guard inherentReason[id] == nil else { return }
            inherentReason[id] = why
            inherentOrder.append(id)
        }
        for id in ids {
            let entry = entries[id]!
            if entry.polyphony > 1 { setInherent(id, "it is a voice: one per note") }
            else if readsVoice(entry) { setInherent(id, "it reads the note, velocity or gate of its voice") }
        }
        for c in connections where entries[c.target] != nil && fromVoiceSource(c) {
            setInherent(c.target, "the keyboard plays it directly")
        }

        var derives = Set(inherentOrder)
        var changed = true
        while changed {
            changed = false
            for c in connections where relevant(c) && !derives.contains(c.target) && derives.contains(c.source) {
                derives.insert(c.target)
                changed = true
            }
        }

        func instancedSet(honourFlags: Bool) -> (set: Set<String>, reason: [String: String]) {
            var set = Set(inherentOrder)
            var reason = inherentReason
            for c in connections where relevant(c) && derives.contains(c.source) && !set.contains(c.target) {
                if !isAudioInlet(c.target, c.targetInput) || noteInputs.contains(c.targetInput) {
                    set.insert(c.target)
                    reason[c.target] = "a per-voice signal drives its \(c.targetInput)"
                }
            }
            // Voice signals on two or more audio inlets do not sum: combining
            // two sums mixes voices into each other. Ids in first-seen order
            // so the recorded reason does not depend on hashing.
            var voicedInlets = [String: Set<String>]()
            var voicedOrder = [String]()
            for c in connections where relevant(c) && derives.contains(c.source) && isAudioInlet(c.target, c.targetInput) {
                if voicedInlets[c.target] == nil { voicedOrder.append(c.target) }
                voicedInlets[c.target, default: []].insert(c.targetInput)
            }
            for id in voicedOrder where voicedInlets[id]!.count >= 2 && !set.contains(id) {
                set.insert(id)
                reason[id] = "it combines per-voice signals on more than one input"
            }
            if honourFlags {
                for id in ids where derives.contains(id) && patch.node(id)?.voicing == .instanced && !set.contains(id) {
                    set.insert(id)
                    reason[id] = "set to run per voice"
                }
            }
            var changed = true
            while changed {
                changed = false
                for c in connections where relevant(c) && set.contains(c.target) {
                    if derives.contains(c.source), entries[c.source] != nil, !set.contains(c.source) {
                        set.insert(c.source)
                        reason[c.source] = "it feeds \(c.target), which runs per voice"
                        changed = true
                    }
                }
            }
            return (set, reason)
        }

        let honoured = instancedSet(honourFlags: true)
        let forced = instancedSet(honourFlags: false)

        var role = [String: Role]()
        var canSum = [String: Bool]()
        var reason = [String: String]()
        for id in ids {
            if !derives.contains(id) {
                role[id] = .global
                canSum[id] = false
                reason[id] = "no voice reaches it, so it runs once already"
                continue
            }
            role[id] = honoured.set.contains(id) ? .instanced : .summed
            canSum[id] = !forced.set.contains(id)
            if honoured.set.contains(id), let why = forced.reason[id] ?? honoured.reason[id] { reason[id] = why }
        }
        return VoicingPlan(role: role, canSum: canSum, reason: reason)
    }
}
