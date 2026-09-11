import Foundation

/// One published parameter, as the compiled document carries it.
///
/// This is `graph/param.ts`'s `ParamDescriptor` seen from the host side. The
/// fields an `AUParameterTree` needs are all here, which is the point: a
/// crate plugin's parameter tree is read off the document rather than
/// authored twice.
public struct CrateParamDescriptor: Decodable, Sendable {
    public let min: Double
    public let max: Double
    /// `default` in the document; `default` is a keyword here.
    public let defaultValue: Double
    /// `AUParameterAddress`. Flattening assigns these sequentially, because
    /// two copies of the same node would otherwise claim the same address.
    /// A descriptor without one is not automatable and is not exposed.
    public let address: Int?
    public let label: String?
    public let unit: String?
    /// Legal values are `min + k * step`. Absent means continuous, and
    /// present means `AUParameterOptions.flag_IsStepped`.
    public let step: Double?
    /// `linear`, `log` or `exp`. Only affects how a knob maps to the value;
    /// the value itself is always in real units on a linear scale.
    public let curve: String?
    /// Present on an enum parameter, and the `valueStrings` of an AU param.
    public let options: [String]?
    /// Present on a toggle parameter: the labels for off and on.
    public let labels: [String]?

    private enum CodingKeys: String, CodingKey {
        case min, max, address, label, unit, step, curve, options, labels
        case defaultValue = "default"
    }

    /// Whether this parameter should appear in an `AUParameterTree`.
    /// Crate distinguishes "a parameter" from "an automatable parameter", and
    /// only the second earns an address.
    public var isAutomatable: Bool { address != nil }
}

/// The compiled half of a `crate.plugin`: everything a host needs to run the
/// plugin without a patcher in it.
///
/// A `crate.plugin` is a patch, and the ASL graph is produced from it by
/// `flattenPatch` in JavaScript. A native host cannot do that without a
/// second implementation of node-to-graph lowering, so export writes the
/// compiled artifact into the document. See
/// `web-version/packages/crate/src/patcher/compiledPlugin.ts`.
public struct CompiledMaterialDocument: Decodable, Sendable {
    public let graph: ASLGraphDocument
    public let params: [String: CrateParamDescriptor]
    public let name: String
    public let role: String
    public let polyphony: Int?
    /// Live audio inputs the graph reads, sorted, `input` included.
    public let ports: [String]

    public var isInstrument: Bool { role == "instrument" }
}

/// A whole `crate.plugin` document. The patch itself is deliberately not
/// decoded: this side has no patcher and no business reading one.
public struct CratePluginDocument: Decodable, Sendable {
    public let version: Int
    public let kind: String
    public let id: String
    public let label: String
    public let role: String
    public let polyphony: Int?
    public let compiled: CompiledMaterialDocument?

    public static func decode(_ data: Data) throws -> CratePluginDocument {
        try JSONDecoder().decode(CratePluginDocument.self, from: data)
    }

    /// The compiled form, or a refusal that says which half is missing.
    ///
    /// A document exported before the compiled form existed is not corrupt,
    /// it is old, and the fix is to re-export it from the patcher rather than
    /// to guess at what its graph would have been.
    public func requireCompiled() throws -> CompiledMaterialDocument {
        guard let compiled else {
            throw ASLCompileError(
                "crate.plugin \"\(id)\" has no compiled graph. Re-export it from crate-patcher; "
                    + "a host without a patcher cannot flatten the patch itself."
            )
        }
        return compiled
    }
}

/// What a file someone picked actually turned out to be.
///
/// Two crate documents look alike from a distance and are not
/// interchangeable. A `crate.patch` is the node editor's save file: nodes and
/// connections, no graph. A `crate.plugin` is what Export Plugin produces,
/// and only that carries the compiled graph a host without a patcher can
/// run. Telling them apart before decoding is what turns "keyNotFound: id"
/// into a sentence someone can act on.
public enum CrateDocumentKind {
    case plugin(CratePluginDocument)
    /// The editor's save file. Has no graph in it and cannot be run here.
    case patch
    /// Valid JSON, but not a crate document. Carries whatever `kind` said.
    case other(String?)
    /// Not JSON at all.
    case unreadable

    public static func sniff(_ data: Data) -> CrateDocumentKind {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .unreadable
        }
        let kind = object["kind"] as? String
        if kind == "crate.patch" { return .patch }
        if let doc = try? CratePluginDocument.decode(data) { return .plugin(doc) }
        return .other(kind)
    }

    /// Why this file cannot be loaded, and what to do instead. Nil when it
    /// can be.
    public var refusal: String? {
        switch self {
        case .plugin(let doc):
            return doc.compiled == nil
                ? "\"\(doc.label)\" has no compiled graph. Re-export it from the node editor; "
                    + "documents saved before the compiled form existed cannot be run here."
                : nil
        case .patch:
            return "This is a crate.patch, which is the node editor's save file and holds no graph. "
                + "Use Export Plugin in the node editor to get a .crate.plugin, and import that."
        case .other(let kind):
            return kind.map { "Not a crate document (kind \"\($0)\")." }
                ?? "Not a crate document."
        case .unreadable:
            return "Not readable as JSON."
        }
    }
}

/// A parameter address mapped to the name the interpreter reads.
///
/// Built once when a plugin loads, because the render thread and the
/// parameter observer both need it and neither can afford to search a
/// dictionary of descriptors for a matching address.
public struct ParameterMap: Sendable {
    public let nameForAddress: [Int: String]
    public let descriptorForAddress: [Int: CrateParamDescriptor]
    /// Defaults, ready to seed a fresh `VoiceState`.
    public let defaults: [String: Double]

    public init(_ params: [String: CrateParamDescriptor]) {
        var names = [Int: String]()
        var descriptors = [Int: CrateParamDescriptor]()
        var defaults = [String: Double]()
        for (name, descriptor) in params {
            defaults[name] = descriptor.defaultValue
            guard let address = descriptor.address else { continue }
            names[address] = name
            descriptors[address] = descriptor
        }
        nameForAddress = names
        descriptorForAddress = descriptors
        self.defaults = defaults
    }

    /// Addresses in ascending order, so a parameter tree is built in a stable
    /// order rather than in whatever order a dictionary iterated.
    public var addresses: [Int] { nameForAddress.keys.sorted() }
}
