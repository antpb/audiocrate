import Foundation

/// A value out of a graph document's `params`, which is untyped by design.
///
/// ASL node params hold whatever the node kind needs: a number, a mode
/// string, a wavetable, a nested sample box. The JavaScript side stores them
/// in a `Record<string, unknown>` and every reader casts. This is the same
/// contract with the casts made explicit, so a malformed document produces
/// `nil` at the point of the mistake rather than a wrong number later.
public enum ASLValue: Equatable, Sendable {
    case number(Double)
    case string(String)
    case bool(Bool)
    case array([ASLValue])
    case object([String: ASLValue])
    case null

    public var number: Double? {
        switch self {
        case .number(let value): return value
        case .bool(let value): return value ? 1 : 0
        default: return nil
        }
    }

    public var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// A numeric array, accepting the `[Double]` a wavetable or a breakpoint
    /// list arrives as. Anything non-numeric inside makes the whole thing nil
    /// rather than silently becoming zero.
    public var numbers: [Double]? {
        guard case .array(let items) = self else { return nil }
        var out = [Double]()
        out.reserveCapacity(items.count)
        for item in items {
            guard let value = item.number else { return nil }
            out.append(value)
        }
        return out
    }

    /// The same numbers as `numbers`, straight to `[Float]`.
    ///
    /// A sample box holds one `Float` per frame and the only consumer is
    /// `planTable`, which wants floats. Going through `numbers` builds a whole
    /// `[Double]` first and then maps it: two passes and two allocations over
    /// something that can be a million frames long, on a path a patcher hits
    /// every time it adopts an edit. Measured at half the time and half the
    /// peak for a long sample.
    public var floats: [Float]? {
        guard case .array(let items) = self else { return nil }
        var out = [Float]()
        out.reserveCapacity(items.count)
        for item in items {
            guard let value = item.number else { return nil }
            out.append(Float(value))
        }
        return out
    }

    public subscript(key: String) -> ASLValue? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }
}

extension ASLValue: Encodable {
    /// Writes back what was read. A native patcher builds graph documents
    /// rather than only reading them, and the result has to survive
    /// `fullState` and a project reload as the same numbers.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let items): try container.encode(items)
        case .object(let fields): try container.encode(fields)
        case .null: try container.encodeNil()
        }
    }
}

extension ASLValue: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([ASLValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: ASLValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unrecognised ASL param")
        }
    }
}

/// One node of a graph document, exactly as `asl/types.ts` writes it.
///
/// `id` is load-bearing and is not a display detail. A graph is a DAG, and
/// JSON cannot say "the same node again", so a shared subgraph appears more
/// than once in the document with the same id each time. Re-sharing by id is
/// what keeps one filter one filter; a decoder that treats each copy as its
/// own node gives it two delay lines fed the same signal, which sounds
/// almost right and is not.
///
/// Format 2 of `crate.plugin` writes a shared node in full once and as
/// `{ "ref": id }` after that. Such a stub decodes with `isReference` set and
/// no kind; `ASLGraphDocument` resolves every stub while decoding, so a graph
/// handed to the compiler never contains one. See `docs/format.md`.
public struct ASLNodeDocument: Codable, Sendable {
    public let id: Int
    public let kind: String
    public let params: [String: ASLValue]
    public let inputs: [String: ASLNodeDocument]
    public let list: [ASLNodeDocument]?
    /// A format 2 `{ "ref": id }` that has not been resolved yet.
    public let isReference: Bool

    private enum CodingKeys: String, CodingKey {
        case id, kind, params, inputs, list, ref
    }

    public init(
        id: Int,
        kind: String,
        params: [String: ASLValue] = [:],
        inputs: [String: ASLNodeDocument] = [:],
        list: [ASLNodeDocument]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.params = params
        self.inputs = inputs
        self.list = list
        self.isReference = false
    }

    fileprivate init(reference id: Int) {
        self.id = id
        kind = ""
        params = [:]
        inputs = [:]
        list = nil
        isReference = true
    }

    /// `list` is omitted when absent rather than written as null, because the
    /// JavaScript serializer omits it and a document that round-trips through
    /// here should come back byte-comparable to one that did not.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if isReference {
            try container.encode(id, forKey: .ref)
            return
        }
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encode(params, forKey: .params)
        try container.encode(inputs, forKey: .inputs)
        try container.encodeIfPresent(list, forKey: .list)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if !container.contains(.kind), let ref = try container.decodeIfPresent(Int.self, forKey: .ref) {
            self.init(reference: ref)
            return
        }
        self.init(
            id: try container.decode(Int.self, forKey: .id),
            kind: try container.decode(String.self, forKey: .kind),
            params: try container.decodeIfPresent([String: ASLValue].self, forKey: .params) ?? [:],
            inputs: try container.decodeIfPresent([String: ASLNodeDocument].self, forKey: .inputs) ?? [:],
            list: try container.decodeIfPresent([ASLNodeDocument].self, forKey: .list)
        )
    }
}

/// A whole graph, matching `ASLGraphDescriptor`.
public struct ASLGraphDocument: Codable, Sendable {
    /// Named per-voice inputs the builder referenced, in first-access order.
    public let inputs: [String]
    public let output: ASLNodeDocument
    /// 1 or 2 to force the channel count; absent means decide from the graph.
    public let channels: Int?
    /// Parameters whose host changes glide rather than jump
    /// (`ASLGraphDescriptor.smooth`). Absent on a graph with none.
    public let smooth: [String]?
    /// A split instrument's voice outputs (`ASLGraphDescriptor.sends`): nodes
    /// inside `output`, resolved to the ones `output` defines. Absent for any
    /// graph that is not a split voice.
    public let sends: [ASLNodeDocument]?
    /// One element or none: a struct cannot hold itself, an array of it can.
    private let busStorage: [ASLGraphDocument]?
    /// What runs once on the voices' summed sends, through ports
    /// `send0`..`sendN` (`ASLGraphDescriptor.bus`).
    public var bus: ASLGraphDocument? { busStorage?.first }

    public init(
        inputs: [String],
        output: ASLNodeDocument,
        channels: Int? = nil,
        smooth: [String]? = nil,
        sends: [ASLNodeDocument]? = nil,
        bus: ASLGraphDocument? = nil
    ) {
        self.inputs = inputs
        self.output = output
        self.channels = channels
        self.smooth = smooth
        self.sends = sends
        self.busStorage = bus.map { [$0] }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(inputs, forKey: .inputs)
        try container.encode(output, forKey: .output)
        try container.encodeIfPresent(channels, forKey: .channels)
        try container.encodeIfPresent(smooth, forKey: .smooth)
        // By reference, as `shareSerializedGraph` writes them: every send is
        // defined inside `output`.
        try container.encodeIfPresent(sends?.map { ASLNodeDocument(reference: $0.id) }, forKey: .sends)
        try container.encodeIfPresent(bus, forKey: .bus)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        inputs = try container.decodeIfPresent([String].self, forKey: .inputs) ?? []
        output = try ASLGraphDocument.resolvingReferences(
            container.decode(ASLNodeDocument.self, forKey: .output)
        )
        channels = try container.decodeIfPresent(Int.self, forKey: .channels)
        smooth = try container.decodeIfPresent([String].self, forKey: .smooth)
        if let written = try container.decodeIfPresent([ASLNodeDocument].self, forKey: .sends) {
            // Each send is the node `output` already defines with that id,
            // whether it was written as a reference or in full.
            var defined = [Int: ASLNodeDocument]()
            func collect(_ node: ASLNodeDocument) {
                if defined[node.id] != nil { return }
                defined[node.id] = node
                for child in node.inputs.values { collect(child) }
                for child in node.list ?? [] { collect(child) }
            }
            collect(output)
            sends = try written.map { send in
                guard let node = defined[send.id] else {
                    throw ASLCompileError("crate.plugin: a send names node \(send.id), which the graph output does not contain")
                }
                return node
            }
        } else {
            sends = nil
        }
        busStorage = try container.decodeIfPresent(ASLGraphDocument.self, forKey: .bus).map { [$0] }
    }

    /// The most node appearances a resolved graph may expand to. A format 2
    /// document is small however much it shares, and resolving it into value
    /// types is cheap because shared children share storage, but a walker
    /// that recurses without memoising (a catalog scan, an audit) pays per
    /// appearance. A format 1 file of this size would be hundreds of
    /// megabytes, so nothing legitimate comes near it.
    static let maxResolvedAppearances = 1_000_000

    /// Every `{ "ref": id }` replaced by the node it names, as
    /// `inflateSerializedGraph` does in compiledPlugin.ts. Refuses a reference
    /// with no definition, a node that is its own input, and a graph that
    /// would expand past `maxResolvedAppearances`.
    static func resolvingReferences(_ root: ASLNodeDocument) throws -> ASLNodeDocument {
        var defined = [Int: ASLNodeDocument]()
        var hasReference = false
        func collect(_ node: ASLNodeDocument) {
            if node.isReference { hasReference = true; return }
            if defined[node.id] == nil { defined[node.id] = node }
            for child in node.inputs.values { collect(child) }
            for child in node.list ?? [] { collect(child) }
        }
        collect(root)
        if !hasReference { return root }

        var built = [Int: (node: ASLNodeDocument, appearances: Int)]()
        var building = Set<Int>()
        func build(_ node: ASLNodeDocument) throws -> (node: ASLNodeDocument, appearances: Int) {
            if let done = built[node.id] { return done }
            guard let source = defined[node.id] else {
                throw ASLCompileError("crate.plugin: the graph refers to node \(node.id), which it never defines")
            }
            guard building.insert(node.id).inserted else {
                throw ASLCompileError("crate.plugin: node \(node.id) is its own input")
            }
            var appearances = 1
            var inputs = [String: ASLNodeDocument]()
            for (key, child) in source.inputs {
                let resolved = try build(child)
                inputs[key] = resolved.node
                appearances += resolved.appearances
            }
            var list: [ASLNodeDocument]?
            if let children = source.list {
                list = try children.map { child in
                    let resolved = try build(child)
                    appearances += resolved.appearances
                    return resolved.node
                }
            }
            if appearances > maxResolvedAppearances {
                throw ASLCompileError(
                    "crate.plugin: the graph expands past \(maxResolvedAppearances) node appearances"
                )
            }
            building.remove(node.id)
            let out = ASLNodeDocument(
                id: source.id, kind: source.kind, params: source.params, inputs: inputs, list: list
            )
            built[node.id] = (out, appearances)
            return (out, appearances)
        }
        return try build(root).node
    }

    private enum CodingKeys: String, CodingKey {
        case inputs, output, channels, smooth, sends, bus
    }

    public static func decode(_ data: Data) throws -> ASLGraphDocument {
        try JSONDecoder().decode(ASLGraphDocument.self, from: data)
    }
}

/// Every node kind the interpreter understands.
///
/// A document naming a kind that is not here fails to compile rather than
/// rendering silence: a graph half-understood is worse than a graph refused,
/// because the failure is inaudible until someone notices the sound is wrong.
///
/// `CaseIterable` because this list and `ALL_NODE_KINDS` in
/// `asl/types.ts` have to hold exactly the same names, and until recently the
/// only thing enforcing that was a human running a script and writing the
/// answer into a document. The conformance fixture states the JavaScript side
/// of the list; `ConformanceTests` compares it against `allCases`, so the two
/// vocabularies cannot drift apart without a test going red. A kind added in
/// TypeScript and missed here used to surface as a throw at load time, in the
/// field, on somebody's exported patch.
public enum NodeKind: String, Sendable, CaseIterable {
    case const, param, port, lane, meter, capture
    case osc, lfo, adsr, mix, mul, add, toFrequency, range
    case filterLowpass, filterHighpass, filterBandpass, filterNotch
    case filterPeaking, filterLowShelf, filterHighShelf, filterAllpass
    case onePoleLowpass, onePoleHighpass, svf, ladder, comb
    case bitcrush, downsample, rectify, slew, sampleHold, compare, compressor
    case clock, clockDivide, clockMultiply, logic, flipFlop, quantize
    case euclidean, random, trigger, pulse, dahdsr, sequencer, impulse
    case expander, transient, reverse, looper, select, waveshape, breakpoints
    case rms, peak, onset, pitch, filterSlope, wavetable, samplePlay, grain
    case pitchShift, panLaw, noise, delay, clip, dcBlock, envFollow
    case transport, kernel
}

public struct ASLCompileError: Error, CustomStringConvertible {
    public let description: String
    /// Public because the type is. An internal initialiser on a public error
    /// means nothing outside this module can construct or rethrow one, which
    /// is not a boundary anybody chose.
    public init(_ description: String) { self.description = description }
}
