import Foundation

/// The audio behind a `samplePlay`, `wavetable` or `grain` node.
///
/// One channel, because those three node kinds read a mono table: `node.table`
/// is a `[Float]` and `evalSamplePlay` interpolates two neighbours of it.
/// Summing a stereo file is the decoder's job, not the graph's.
public struct CrateSampleBox: Sendable, Equatable {
    public let samples: [Float]

    /// The rate the samples were recorded at, or 0 to follow the render rate.
    ///
    /// Left at the file's own rate rather than resampled on the way in.
    /// `evalSamplePlay` already advances its playhead by `srcRate / sr`, so a
    /// 44.1 kHz file plays at the right pitch in a 48 kHz session without a
    /// conversion pass, and a patch does not bake in the sample rate of the
    /// session it was authored in.
    public let sampleRate: Double

    public init(samples: [Float], sampleRate: Double) {
        self.samples = samples
        self.sampleRate = sampleRate
    }

    public var isEmpty: Bool { samples.isEmpty }
}

/// How a patch names an audio file, and how that name becomes audio.
///
/// ## Why a reference and not the samples
///
/// A `box` param can hold its samples inline, and the Wavetable material's
/// own default sine table does exactly that. Audio a user chose cannot: one
/// second of 48 kHz mono is 48,000 JSON numbers, a compiled graph is a JSON
/// string in `fullState`, and `fullState` is written every time the host saves
/// a project and re-encoded every time the patcher adopts an edit. A four-bar
/// loop on two nodes would make the editor unusable and the project file
/// enormous.
///
/// So a box travels as `ref`, a filename in the host's own file library:
///
/// ```
///   patch node   data["sample"] = "kick.wav"
///        │  flatten stamps the ref onto every box in that material
///        ▼
///   compiled graph   samplePlay { box: { ref: "kick.wav", samples: [] } }
///        │
///        ├─ playing:   CompiledVoice(document:samples:)   ← the live path
///        └─ exporting: CrateSamples.resolving(_:_:)      ← bakes it in
/// ```
///
/// ## Two ways in, for two different jobs
///
/// **Playing** hands the audio to `CompiledVoice` as a side table keyed by
/// filename. The document is never touched, so adopting an edit costs the
/// same whether a patch has a minute of audio in it or none: `planTable`
/// takes a reference to an array the host is already holding. That matters
/// because the patcher recompiles the whole graph on every structural edit.
/// Baking the audio in instead was measured at 166 ms per edit for a
/// 30-second sample, against about a millisecond this way.
///
/// **Exporting** is the case that does need it inline. A `.crate.plugin`
/// handed to somebody else has no access to this library, so `resolving`
/// writes the samples into the document and the file travels with the patch.
/// Slow and enormous, which is correct for a thing you do once.
///
/// Nothing in this file reads a file: both paths take audio from the caller.
/// The host owns where its library lives and how audio is decoded, and this
/// module stays free of AVFoundation and of any notion of a path.
///
/// ## A reference that does not resolve
///
/// The ref is stamped *alongside* whatever samples the material shipped, and
/// `resolving` overwrites them only when the closure answers. That one rule
/// gives both kinds the right behaviour with no special case: a Sample Player
/// ships an empty box, so a missing file is silence, which is honest. A
/// Wavetable ships a sine, so a missing file is the sine it had before, which
/// is better than turning a working patch silent. Either way the reference
/// stays in the document, so restoring the file fixes the patch.
public enum CrateSamples {

    /// The node param a table lives in.
    public static let boxParam = "box"

    /// The key inside that param naming a file instead of holding samples.
    public static let refKey = "ref"

    /// The `CratePatchNode.data` key an editor records a chosen file under.
    /// In `data` rather than `params`, because `params` is `[String: Double]`
    /// and a filename is not a number, and because a sample is not
    /// automatable: there is no fader that sweeps between two files.
    public static let dataKey = "sample"

    /// Node kinds that read a table. Spelled through `NodeKind` so a rename
    /// there is a compile error here rather than a feature that quietly
    /// stops working.
    public static let boxKinds: Set<String> = [
        NodeKind.samplePlay.rawValue,
        NodeKind.wavetable.rawValue,
        NodeKind.grain.rawValue,
    ]

    // MARK: - Reading references

    /// Every file a compiled graph asks for, deduplicated.
    ///
    /// The set, not a count: a host resolving these decodes each file once
    /// however many nodes point at it, and a host reporting the missing ones
    /// wants to name them.
    public static func references(in document: ASLGraphDocument) -> Set<String> {
        var found = Set<String>()
        var seen = Set<Int>()
        walk(document.output, seen: &seen) { node in
            if let ref = reference(of: node) { found.insert(ref) }
        }
        return found
    }

    public static func references(in document: CompiledMaterialDocument) -> Set<String> {
        references(in: document.graph)
    }

    /// Which file each patch node plays, for the nodes that name one.
    public static func references(in patch: CratePatch) -> [String: String] {
        var map = [String: String]()
        for node in patch.nodes {
            if let name = node.sampleFilename { map[node.id] = name }
        }
        return map
    }

    /// The filename a single box node names, or nil for an inline table.
    public static func reference(of node: ASLNodeDocument) -> String? {
        guard boxKinds.contains(node.kind) else { return nil }
        guard let ref = node.params[boxParam]?[refKey]?.string, !ref.isEmpty else { return nil }
        return ref
    }

    // MARK: - Putting the audio in

    /// Writes every referenced box's audio into the document, for export.
    ///
    /// Not the path to use for playing a patch. Pass the audio to
    /// `CompiledVoice(document:samples:)` instead, which costs nothing per
    /// compile. This one exists so an exported `.crate.plugin` can be opened
    /// somewhere that has no copy of the file.
    ///
    /// `resolve` is called at most once per distinct filename and may answer
    /// nil for a file that is not there; see the note on unresolved
    /// references above. It runs on whatever thread the caller is on, which
    /// must not be the audio thread: it allocates one `ASLValue` per frame.
    public static func resolving(
        _ document: ASLGraphDocument,
        _ resolve: (String) -> CrateSampleBox?
    ) -> ASLGraphDocument {
        var memo = [Int: ASLNodeDocument]()
        var decoded = [String: CrateSampleBox?]()
        let output = filled(document.output, memo: &memo, decoded: &decoded, resolve: resolve)
        return ASLGraphDocument(
            inputs: document.inputs, output: output, channels: document.channels, smooth: document.smooth
        )
    }

    public static func resolving(
        _ document: CompiledMaterialDocument,
        _ resolve: (String) -> CrateSampleBox?
    ) -> CompiledMaterialDocument {
        CompiledMaterialDocument(
            graph: resolving(document.graph, resolve),
            params: document.params,
            name: document.name,
            role: document.role,
            polyphony: document.polyphony,
            ports: document.ports
        )
    }

    /// Stamps a reference onto a box param, keeping whatever else was in it.
    ///
    /// Public because a patch generator or an importer may want to build a
    /// referenced box without going through flatten.
    public static func box(_ existing: ASLValue?, referencing filename: String) -> ASLValue {
        var fields: [String: ASLValue]
        if case let .object(current)? = existing {
            fields = current
        } else {
            fields = [:]
        }
        fields[refKey] = .string(filename)
        return .object(fields)
    }

    // MARK: - Walking

    /// Rebuilt rather than mutated because `ASLNodeDocument` is immutable,
    /// and memoised by id because a graph is a DAG written out with repeats:
    /// one filter has to come back as one filter, or the interpreter gives it
    /// two sets of state. Same contract `FlattenPatch.document(_:)` keeps.
    private static func filled(
        _ node: ASLNodeDocument,
        memo: inout [Int: ASLNodeDocument],
        decoded: inout [String: CrateSampleBox?],
        resolve: (String) -> CrateSampleBox?
    ) -> ASLNodeDocument {
        if let already = memo[node.id] { return already }

        var inputs = [String: ASLNodeDocument]()
        for (key, child) in node.inputs {
            inputs[key] = filled(child, memo: &memo, decoded: &decoded, resolve: resolve)
        }
        let list = node.list?.map {
            filled($0, memo: &memo, decoded: &decoded, resolve: resolve)
        }

        var params = node.params
        if let ref = reference(of: node) {
            let box: CrateSampleBox?
            if let cached = decoded[ref] {
                box = cached
            } else {
                box = resolve(ref)
                decoded[ref] = box
            }
            if let box, !box.isEmpty {
                params[boxParam] = .object([
                    refKey: .string(ref),
                    "samples": .array(box.samples.map { .number(Double($0)) }),
                    "sampleRate": .number(box.sampleRate),
                ])
            }
        }

        let out = ASLNodeDocument(
            id: node.id, kind: node.kind, params: params, inputs: inputs, list: list
        )
        memo[node.id] = out
        return out
    }

    private static func walk(
        _ node: ASLNodeDocument,
        seen: inout Set<Int>,
        _ visit: (ASLNodeDocument) -> Void
    ) {
        guard seen.insert(node.id).inserted else { return }
        visit(node)
        for (_, child) in node.inputs { walk(child, seen: &seen, visit) }
        for child in node.list ?? [] { walk(child, seen: &seen, visit) }
    }
}

public extension CratePatchNode {

    /// The file in the host's library this node plays, or nil for none.
    var sampleFilename: String? {
        guard let value = data?[CrateSamples.dataKey], let name = value.string, !name.isEmpty else {
            return nil
        }
        return name
    }

    /// Points this node at a file, or clears it when given nil.
    ///
    /// Clearing removes the key rather than writing an empty string, so a
    /// node that never had a sample and one whose sample was removed
    /// serialise the same way and two such patches compare equal. The
    /// editor's `isShowing` check compares patches.
    mutating func setSampleFilename(_ filename: String?) {
        var fields = data ?? [:]
        if let filename, !filename.isEmpty {
            fields[CrateSamples.dataKey] = .string(filename)
        } else {
            fields.removeValue(forKey: CrateSamples.dataKey)
        }
        data = fields.isEmpty ? nil : fields
    }
}

public extension CatalogMaterialEntry {

    /// Whether this material plays a table, and so has a file to choose.
    ///
    /// Derived by walking the material's own graph rather than listed by
    /// kind. A list would be two names long today and wrong the day a
    /// material is rebuilt around a `samplePlay`, and the palette is
    /// generated from the web editor's catalog, so a new sample-playing
    /// material can arrive here with no Swift change at all.
    var readsSampleBox: Bool {
        var seen = Set<Int>()
        var found = false
        func look(_ node: ASLNodeDocument) {
            guard !found, seen.insert(node.id).inserted else { return }
            if CrateSamples.boxKinds.contains(node.kind) {
                found = true
                return
            }
            for (_, child) in node.inputs { look(child) }
            for child in node.list ?? [] { look(child) }
        }
        look(graph.output)
        return found
    }
}

public extension MaterialCatalog {

    /// Whether a palette kind has a sample slot. False for host tools and
    /// kernels, which have no material graph to read one from.
    func takesSample(_ kind: String) -> Bool {
        material(kind)?.readsSampleBox ?? false
    }
}
