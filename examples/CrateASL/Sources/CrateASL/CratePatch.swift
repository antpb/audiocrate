import Foundation

/// A `crate.patch`: an AudioMaterial graph plus editor positions.
///
/// The same document the web patcher saves (`editor/src/patch.ts`), field for
/// field, so a patch authored in either editor opens in the other. It is not
/// a DAW project: those are tracks, clips and plugin slots.
///
/// A patch is the **editable** form. The runnable form is a
/// `CompiledMaterialDocument`, produced from this by `flattenPatch`. Keeping
/// both is what lets a plugin be reopened and edited rather than only played;
/// a host that stores only the compiled graph has thrown the patch away.
public struct CratePatch: Codable, Sendable, Equatable {
    public static let kind = "crate.patch"
    public static let version = 1

    public var version: Int
    public var kind: String
    public var nodes: [CratePatchNode]
    public var connections: [CratePatchConnection]
    public var transport: CratePatchTransport?

    public init(
        version: Int = CratePatch.version,
        kind: String = CratePatch.kind,
        nodes: [CratePatchNode] = [],
        connections: [CratePatchConnection] = [],
        transport: CratePatchTransport? = nil
    ) {
        self.version = version
        self.kind = kind
        self.nodes = nodes
        self.connections = connections
        self.transport = transport
    }

    private enum CodingKeys: String, CodingKey {
        case version, kind, nodes, connections, transport
    }

    /// Tolerant of a bare `{ nodes, connections }`.
    ///
    /// That is the shape crate core calls a `PatchDocument`: the structural
    /// half flatten reads, without the editor's envelope around it. A fixture
    /// and a collaboration message both carry it, and refusing one for
    /// missing a version it never had would be refusing the thing this type
    /// exists to accept. `decode(_:)` is where a *file* is held to the
    /// stricter contract.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? CratePatch.version
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? CratePatch.kind
        nodes = try container.decodeIfPresent([CratePatchNode].self, forKey: .nodes) ?? []
        connections = try container.decodeIfPresent([CratePatchConnection].self, forKey: .connections) ?? []
        transport = try container.decodeIfPresent(CratePatchTransport.self, forKey: .transport)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(kind, forKey: .kind)
        try container.encode(nodes, forKey: .nodes)
        try container.encode(connections, forKey: .connections)
        try container.encodeIfPresent(transport, forKey: .transport)
    }

    public static func decode(_ data: Data) throws -> CratePatch {
        let patch = try JSONDecoder().decode(CratePatch.self, from: data)
        guard patch.kind == CratePatch.kind else {
            throw ASLCompileError("Not a crate.patch document (kind was \"\(patch.kind)\").")
        }
        return patch
    }

    public func encoded() throws -> Data {
        try JSONEncoder().encode(self)
    }

    public func node(_ id: String) -> CratePatchNode? {
        nodes.first { $0.id == id }
    }

    /// Everything patched into one inlet, in document order.
    ///
    /// Order is load-bearing wherever it matters: stacked cables into one
    /// inlet sum through a `mix` whose operand order is this order, and two
    /// graphs that mix the same signals in a different order are not
    /// bit-identical.
    public func sources(into target: String, inlet: String) -> [CratePatchConnection] {
        connections.filter { $0.target == target && $0.targetInput == inlet }
    }
}

public struct CratePatchNode: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var kind: String
    public var x: Double
    public var y: Double
    /// Values for the node's declared params. A param absent here keeps the
    /// material's own default.
    public var params: [String: Double]
    /// Host-local, editor-owned state that is not a param: a Line node's
    /// device, a monitor toggle. Untyped because crate core has no business
    /// enumerating what an editor keeps here.
    public var data: [String: ASLValue]?

    public init(
        id: String,
        kind: String,
        x: Double = 0,
        y: Double = 0,
        params: [String: Double] = [:],
        data: [String: ASLValue]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.x = x
        self.y = y
        self.params = params
        self.data = data
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, x, y, params, data
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(String.self, forKey: .kind)
        x = try container.decodeIfPresent(Double.self, forKey: .x) ?? 0
        y = try container.decodeIfPresent(Double.self, forKey: .y) ?? 0
        params = try container.decodeIfPresent([String: Double].self, forKey: .params) ?? [:]
        data = try container.decodeIfPresent([String: ASLValue].self, forKey: .data)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encode(x, forKey: .x)
        try container.encode(y, forKey: .y)
        try container.encode(params, forKey: .params)
        try container.encodeIfPresent(data, forKey: .data)
    }
}

public struct CratePatchConnection: Codable, Sendable, Equatable, Hashable {
    public var source: String
    public var sourceOutput: String
    public var target: String
    public var targetInput: String

    public init(source: String, sourceOutput: String, target: String, targetInput: String) {
        self.source = source
        self.sourceOutput = sourceOutput
        self.target = target
        self.targetInput = targetInput
    }
}

/// Tempo and time signature for the patch's own transport.
///
/// Two numbers, not one: `beats` and `bpm` stay quarter-note and the
/// signature is `beatsPerBar` over `beatUnit`. Folding the denominator into
/// the tempo is the mistake this shape exists to prevent, and it is invisible
/// in 4/4.
public struct CratePatchTransport: Codable, Sendable, Equatable {
    public var bpm: Double
    public var beatsPerBar: Double
    public var beatUnit: Double
    /// Playhead in seconds when Play is pressed.
    public var startSec: Double?

    public init(bpm: Double = 120, beatsPerBar: Double = 4, beatUnit: Double = 4, startSec: Double? = nil) {
        self.bpm = bpm
        self.beatsPerBar = beatsPerBar
        self.beatUnit = beatUnit
        self.startSec = startSec
    }
}
