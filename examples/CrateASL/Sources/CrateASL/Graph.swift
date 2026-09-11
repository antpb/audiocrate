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

    public subscript(key: String) -> ASLValue? {
        if case .object(let fields) = self { return fields[key] }
        return nil
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
public struct ASLNodeDocument: Decodable, Sendable {
    public let id: Int
    public let kind: String
    public let params: [String: ASLValue]
    public let inputs: [String: ASLNodeDocument]
    public let list: [ASLNodeDocument]?

    private enum CodingKeys: String, CodingKey {
        case id, kind, params, inputs, list
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        kind = try container.decode(String.self, forKey: .kind)
        params = try container.decodeIfPresent([String: ASLValue].self, forKey: .params) ?? [:]
        inputs = try container.decodeIfPresent([String: ASLNodeDocument].self, forKey: .inputs) ?? [:]
        list = try container.decodeIfPresent([ASLNodeDocument].self, forKey: .list)
    }
}

/// A whole graph, matching `ASLGraphDescriptor`.
public struct ASLGraphDocument: Decodable, Sendable {
    /// Named per-voice inputs the builder referenced, in first-access order.
    public let inputs: [String]
    public let output: ASLNodeDocument
    /// 1 or 2 to force the channel count; absent means decide from the graph.
    public let channels: Int?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        inputs = try container.decodeIfPresent([String].self, forKey: .inputs) ?? []
        output = try container.decode(ASLNodeDocument.self, forKey: .output)
        channels = try container.decodeIfPresent(Int.self, forKey: .channels)
    }

    private enum CodingKeys: String, CodingKey {
        case inputs, output, channels
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
