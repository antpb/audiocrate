import Foundation

// Edits the web patcher makes that a native editor needs to make the same
// way: removing a node with its audio carried through, copying one module to
// the clipboard, and exporting a patch as a `crate.plugin`. Each is ported
// from the file named on it, and kept here rather than in an editor's view
// model so the tests beside it can hold the two sides to one answer.

// MARK: - Delete and pass through

extension CratePatch {

    /// `isMainAudioInlet` in `editor/src/passthrough.ts`.
    public static func isMainAudioInlet(_ name: String) -> Bool { name == "input" }

    /// `isMainAudioOutlet`: `cv` counts, because a node whose main outlet is
    /// control is still the thing downstream of it is listening to.
    public static func isMainAudioOutlet(_ name: String) -> Bool { name == "audio" || name == "cv" }

    /// The cables that replace a removed insert, `passthroughLinks`.
    ///
    /// Every source on the node's main input is wired to every destination of
    /// its main output. Sidechain and CV inlets are dropped rather than
    /// carried, because a cable into a detector or onto a parameter has no
    /// meaning once the node it fed is gone. A cable that already exists is
    /// not doubled, and a source that is also a destination is not wired to
    /// itself, which would be a loop.
    ///
    /// Empty means there is nothing to carry through: the node is a sink, a
    /// source, or only ever took control.
    public func passthroughConnections(removing nodeId: String) -> [CratePatchConnection] {
        let incoming = connections.filter { $0.target == nodeId && Self.isMainAudioInlet($0.targetInput) }
        let outgoing = connections.filter { $0.source == nodeId && Self.isMainAudioOutlet($0.sourceOutput) }
        guard !incoming.isEmpty, !outgoing.isEmpty else { return [] }

        var existing = Set(connections)
        var next = [CratePatchConnection]()
        for inbound in incoming {
            for outbound in outgoing {
                if inbound.source == outbound.target { continue }
                let link = CratePatchConnection(
                    source: inbound.source,
                    sourceOutput: inbound.sourceOutput,
                    target: outbound.target,
                    targetInput: outbound.targetInput
                )
                guard existing.insert(link).inserted else { continue }
                next.append(link)
            }
        }
        return next
    }

    public func canPassThrough(_ nodeId: String) -> Bool {
        !passthroughConnections(removing: nodeId).isEmpty
    }

    /// Removes a node and every cable on it, optionally carrying its audio
    /// through (`removeNodePassthrough` in `editor.ts`). The new cables are
    /// appended after the survivors, which is where the web editor adds them,
    /// so a mix they join sums in the same order on both sides.
    public mutating func removeNode(_ nodeId: String, passThrough: Bool = false) {
        let rewires = passThrough ? passthroughConnections(removing: nodeId) : []
        nodes.removeAll { $0.id == nodeId }
        connections.removeAll { $0.source == nodeId || $0.target == nodeId }
        let present = Set(nodes.map(\.id))
        connections += rewires.filter { present.contains($0.source) && present.contains($0.target) }
    }
}

// MARK: - One module on the clipboard

/// `crate.nodeclip`, `editor/src/nodeClip.ts`: one module, its values and its
/// editor data, without an id or any cables. The same text the browser puts
/// on the clipboard, so a module copied on a phone pastes into the browser and
/// the other way round.
public enum CrateNodeClip {
    public static let kind = "crate.nodeclip"
    public static let version = 1
    /// `PASTE_NUDGE`: each paste of the same clip lands this much further
    /// down and to the right, so a stack of pastes reads as a stack.
    public static let nudge = 36.0

    private struct Document: Codable {
        var version: Int
        var kind: String
        var node: Clip
    }

    private struct Clip: Codable {
        var kind: String
        var x: Double?
        var y: Double?
        var params: [String: Double]?
        var data: [String: ASLValue]?
    }

    public static func encode(_ node: CratePatchNode) -> String {
        let document = Document(
            version: version,
            kind: kind,
            node: Clip(kind: node.kind, x: node.x, y: node.y, params: node.params, data: node.data)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(document), let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text
    }

    /// The node on the clipboard, with an empty id for the caller to mint, or
    /// nil when the text is not a node clip. Tolerant the way `parseNodeClip`
    /// is: a missing position is the origin and missing values are defaults.
    public static func parse(_ text: String) -> CratePatchNode? {
        guard let data = text.data(using: .utf8),
              let document = try? JSONDecoder().decode(Document.self, from: data),
              document.kind == kind,
              !document.node.kind.isEmpty
        else {
            return nil
        }
        let clip = document.node
        return CratePatchNode(
            id: "",
            kind: clip.kind,
            x: clip.x.flatMap { $0.isFinite ? $0 : nil } ?? 0,
            y: clip.y.flatMap { $0.isFinite ? $0 : nil } ?? 0,
            params: clip.params ?? [:],
            data: clip.data
        )
    }

    /// Where the `generation`th paste of a clip copied at `(x, y)` lands.
    public static func pasteOffset(x: Double, y: Double, generation: Int) -> (x: Double, y: Double) {
        let step = nudge * Double(max(1, generation))
        return (x + step, y + step)
    }
}

// MARK: - Export as a plugin

/// Builds a `crate.plugin` document from a patch, `buildPluginDocument` in
/// `editor/src/pluginDoc.ts`.
///
/// Format 1, which is what every reader shipped so far understands; format 2
/// is read here but not written until the readers are out (`docs/format.md`).
/// The compiled half is this side's own flatten, which the flatten fixture
/// holds to the browser's, so a plugin exported from a phone runs in a host
/// exactly as one exported from the browser would.
public enum CratePluginExport {

    /// `user.` plus the label lowercased with every run of other characters
    /// turned into one hyphen, as `cratePluginDocument` names it. The id is
    /// what a host keys a project slot on, so two exports of the same name
    /// are the same plugin.
    public static func pluginId(for label: String) -> String {
        var slug = ""
        var pendingHyphen = false
        for scalar in label.lowercased().unicodeScalars {
            let isWord = ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
            if isWord {
                if pendingHyphen && !slug.isEmpty { slug.append("-") }
                pendingHyphen = false
                slug.unicodeScalars.append(scalar)
            } else {
                pendingHyphen = true
            }
        }
        return "user.\(slug.isEmpty ? "plugin" : slug)"
    }

    /// The document, as JSON. Throws what flatten throws, so a patch with no
    /// Master or a kernel in it fails at export rather than in somebody's
    /// host later.
    public static func document(
        _ patch: CratePatch,
        label: String,
        role: CrateFlatten.Role,
        catalog: MaterialCatalog
    ) throws -> Data {
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = name.isEmpty ? "My Patch" : name
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: label, role: role)
        let document = Document(
            version: 1,
            kind: "crate.plugin",
            id: pluginId(for: label),
            label: label,
            role: role.rawValue,
            patch: patch,
            compiled: compiled
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(document)
    }

    private struct Document: Encodable {
        let version: Int
        let kind: String
        let id: String
        let label: String
        let role: String
        let patch: CratePatch
        let compiled: CompiledMaterialDocument
    }
}
