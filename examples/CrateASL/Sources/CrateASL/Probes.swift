//
//  Probes.swift
//  CrateASL
//
//  What each module of a running patch is doing, for something that wants to
//  show it, at no cost to the per-sample path.
//
//  How it stays free: the interpreter already writes every node's latest
//  sample into the voice's value cache (`VoiceState.values`, stamped with the
//  frame's generation). Flatten knows which flat node is each module's
//  output, the plan knows that node's slot, so once per render block the
//  render thread can read one value per module straight out of the cache.
//  No node is added to the graph, nothing is recorded per sample, and a patch
//  that nobody is watching pays one nil check per block.
//
//  What it is: the module's output at the end of the block, as a magnitude,
//  the loudest of the voices playing it. For a CV or a gate that is the
//  value. For audio it is one sample a block, so a reader should treat it as
//  an envelope to smooth, not as a meter; Master and Line carry the block's
//  true peak, which the host measures from the buffers it already has.
//
//  Crossing processes: the audio unit runs in its extension and the editor in
//  the app, so the frames go through a small file in the shared App Group
//  container that both map (`CrateProbeFile`). The render thread writes plain
//  stores into it; a reader can see one frame half-written, which for a
//  picture of levels is harmless and is the price of never taking a lock on
//  the audio thread.
//

import Foundation

// MARK: - Sites

/// Where one module's output lives in a compiled patch: the flat node that is
/// its output, and whether it runs on a split instrument's bus.
public struct ProbeSite: Hashable, Sendable {
    public let flatId: Int
    public let onBus: Bool

    public init(flatId: Int, onBus: Bool) {
        self.flatId = flatId
        self.onBus = onBus
    }
}

// MARK: - Moving sites between flattens

extension CrateFlatten {
    /// `sites`, found on one flatten of a patch, moved onto another compiled
    /// document of the same graph, or nil if `target` is not that graph.
    ///
    /// Two flattens of one patch build the same graph but rarely number it
    /// the same: ids are minted while walking dictionaries, whose order is
    /// not fixed. So a restored project's graph cannot be matched to a fresh
    /// flatten by its bytes. This walks the two side by side from the output
    /// instead, requiring every node to agree in kind, parameters, inputs and
    /// list, and records the renumbering as it goes; the sites move through
    /// it. Main thread, at adoption, never on the render path.
    public static func probeSites(
        _ sites: [String: ProbeSite],
        from source: CompiledMaterialDocument,
        onto target: CompiledMaterialDocument
    ) -> [String: ProbeSite]? {
        guard Set(source.params.keys) == Set(target.params.keys),
              let voice = renumbering(source.graph, target.graph)
        else { return nil }
        var bus: [Int: Int]?
        switch (source.graph.bus, target.graph.bus) {
        case let (a?, b?):
            guard let map = renumbering(a, b) else { return nil }
            bus = map
        case (nil, nil):
            bus = nil
        default:
            return nil
        }
        var moved = [String: ProbeSite]()
        for (id, site) in sites {
            let map = site.onBus ? bus : voice
            // A module whose output never reached the graph has no node on
            // either side; it simply has no probe.
            guard let flatId = map?[site.flatId] else { continue }
            moved[id] = ProbeSite(flatId: flatId, onBus: site.onBus)
        }
        return moved
    }

    /// Source id to target id over one graph and its sends, or nil at the
    /// first node that differs.
    private static func renumbering(_ a: ASLGraphDocument, _ b: ASLGraphDocument) -> [Int: Int]? {
        var forward = [Int: Int]()
        var backward = [Int: Int]()
        func same(_ x: ASLNodeDocument, _ y: ASLNodeDocument) -> Bool {
            if let known = forward[x.id] { return known == y.id }
            if backward[y.id] != nil { return false }
            guard x.kind == y.kind, x.params == y.params,
                  x.inputs.count == y.inputs.count,
                  (x.list?.count ?? -1) == (y.list?.count ?? -1)
            else { return false }
            forward[x.id] = y.id
            backward[y.id] = x.id
            for (key, child) in x.inputs {
                guard let other = y.inputs[key], same(child, other) else { return false }
            }
            if let xs = x.list, let ys = y.list {
                for (p, q) in zip(xs, ys) where !same(p, q) { return false }
            }
            return true
        }
        guard same(a.output, b.output) else { return nil }
        let sendsA = a.sends ?? []
        let sendsB = b.sends ?? []
        guard sendsA.count == sendsB.count else { return nil }
        for (p, q) in zip(sendsA, sendsB) where !same(p, q) { return nil }
        return forward
    }
}

// MARK: - Layout

public enum CrateProbeLayout {
    /// What a probe reads. Raw values are written into shared memory and
    /// read by another process; never renumber.
    public enum Kind: UInt8, Sendable {
        /// Nothing to read (Transport, MIDI Out, a module the graph dropped).
        case none = 0
        /// A material's output, from the value cache.
        case module = 1
        /// The plugin's output, the block's peak.
        case master = 2
        /// The host's audio into the plugin, the block's peak.
        case line = 3
        /// Notes: Keyboard and MIDI In. How many voices are held, as 0...1.
        case notes = 4
    }

    public static let magic: UInt32 = 0x4352_4250   // "CRBP"
    public static let version: UInt32 = 1
    public static let headerBytes = 64
    public static let maxProbes = 512
    public static var fileBytes: Int { headerBytes + maxProbes * MemoryLayout<Float>.stride }

    /// FNV-1a over the node ids in order. Both sides compute it from their
    /// own copy of the patch, so a reader can tell a frame belongs to the
    /// patch it is showing and not the one before an edit landed.
    public static func hash(_ nodeIds: [String]) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for id in nodeIds {
            for byte in id.utf8 {
                hash ^= UInt64(byte)
                hash = hash &* 0x0000_0100_0000_01B3
            }
            // A separator, so ["ab", "c"] and ["a", "bc"] differ.
            hash ^= 0x1F
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return hash
    }

    /// The kind of each patch node, in patch order.
    public static func kinds(for patch: CratePatch, catalog: MaterialCatalog) -> [Kind] {
        let io = catalog.io
        return patch.nodes.map { node in
            switch node.kind {
            case io.master: return .master
            case io.line: return .line
            case io.keyboard, io.midiIn: return .notes
            case io.transport, io.midiOut: return .none
            default: return catalog.material(node.kind) != nil ? .module : .none
            }
        }
    }
}

// MARK: - Table

/// One patch's probes resolved against one compiled voice: a kind and a
/// cache slot per patch node, in patch order. Built off the audio thread when
/// a graph is adopted and never written after, so the render thread reads it
/// with the same lifetime as the voice it belongs to.
public final class ProbeTable: @unchecked Sendable {
    public let count: Int
    public let layoutHash: UInt64
    let kinds: UnsafeMutablePointer<UInt8>
    /// Value-cache slot, or -1 when the module's output is not in the graph
    /// (nothing it feeds reaches Master).
    let slots: UnsafeMutablePointer<Int>
    let onBus: UnsafeMutablePointer<Bool>

    /// - Parameter sites: from `CrateFlatten.flattenWithProbes`, for the
    ///   same patch the voice was compiled from.
    public init(patch: CratePatch, catalog: MaterialCatalog, sites: [String: ProbeSite], voice: CompiledVoice) {
        let kinds = CrateProbeLayout.kinds(for: patch, catalog: catalog)
        let count = min(patch.nodes.count, CrateProbeLayout.maxProbes)
        self.count = count
        layoutHash = CrateProbeLayout.hash(patch.nodes.map(\.id))
        self.kinds = .allocate(capacity: max(count, 1))
        slots = .allocate(capacity: max(count, 1))
        onBus = .allocate(capacity: max(count, 1))
        for index in 0..<count {
            let node = patch.nodes[index]
            var kind = kinds[index]
            var slot = -1
            var bus = false
            if kind == .module {
                if let site = sites[node.id] {
                    bus = site.onBus
                    let plan = site.onBus ? voice.bus?.plan : voice.plan
                    slot = plan?.slotBySourceId[site.flatId] ?? -1
                }
                if slot < 0 { kind = .none }
            }
            (self.kinds + index).initialize(to: kind.rawValue)
            (slots + index).initialize(to: slot)
            (onBus + index).initialize(to: bus)
        }
    }

    deinit {
        kinds.deallocate()
        slots.deallocate()
        onBus.deallocate()
    }

    public func kind(at index: Int) -> CrateProbeLayout.Kind {
        guard index >= 0, index < count else { return .none }
        return CrateProbeLayout.Kind(rawValue: kinds[index]) ?? .none
    }

    /// Writes the values every graph shape shares: Master and Line from the
    /// host's peaks, and zero for the kinds with nothing to read. Module and
    /// note entries are the caller's.
    @inline(__always) func fillHost(master: Float, line: Float, into out: UnsafeMutablePointer<Float>) {
        for index in 0..<count {
            switch kinds[index] {
            case CrateProbeLayout.Kind.master.rawValue: out[index] = master
            case CrateProbeLayout.Kind.line.rawValue: out[index] = line
            case CrateProbeLayout.Kind.none.rawValue: out[index] = 0
            default: break
            }
        }
    }
}

// MARK: - Sampling (render thread)

extension VoiceState {
    /// A slot's value from the frame just rendered, as a magnitude, or 0 if
    /// the slot was not evaluated in that frame or holds something no
    /// picture can use.
    @inline(__always) func probeMagnitude(_ slot: Int) -> Float {
        guard slot >= 0, slot < slotCount, stamps[slot] == generation else { return 0 }
        let value = values[slot]
        guard value.isFinite else { return 0 }
        return Float(value < 0 ? -value : value)
    }
}

extension CompiledVoice {
    /// One state's probes: an effect, or a one-voice host. Render thread
    /// only, after `render`; allocates nothing.
    public func sampleProbes(
        _ table: ProbeTable,
        state: VoiceState,
        master: Float,
        line: Float,
        into out: UnsafeMutablePointer<Float>
    ) {
        table.fillHost(master: master, line: line, into: out)
        let bus = state.splitBus?.state
        for index in 0..<table.count {
            switch table.kinds[index] {
            case CrateProbeLayout.Kind.module.rawValue:
                let source = table.onBus[index] ? bus : state
                out[index] = source?.probeMagnitude(table.slots[index]) ?? 0
            case CrateProbeLayout.Kind.notes.rawValue:
                out[index] = state.gate ? 1 : 0
            default:
                break
            }
        }
    }
}

// `VoicePool.sampleProbes` lives in VoicePool.swift, beside the voice slots
// it reads.

// MARK: - Shared file

/// The frames, in a file both processes map.
///
/// Layout, little-endian: magic UInt32, version UInt32, sequence UInt32
/// (bumped after every frame), count UInt32, layout hash UInt64, then from
/// `headerBytes` one Float per probe. The app creates and sizes the file; the
/// audio unit maps the same file and writes. Neither ever unmaps a file the
/// other might still be using mid-frame: the unit keeps every file it mapped
/// until it is deallocated.
public final class CrateProbeFile: @unchecked Sendable {
    public let url: URL
    private let base: UnsafeMutableRawPointer
    private let length: Int

    /// Where values go, `maxProbes` of them.
    public var values: UnsafeMutablePointer<Float> {
        (base + CrateProbeLayout.headerBytes).assumingMemoryBound(to: Float.self)
    }

    private var header: UnsafeMutablePointer<UInt32> { base.assumingMemoryBound(to: UInt32.self) }

    /// Maps a file, creating and sizing it first when `create` is set (the
    /// reader's side). Nil when it cannot be opened or is the wrong size.
    public init?(url: URL, create: Bool) {
        self.url = url
        let flags = create ? (O_RDWR | O_CREAT) : O_RDWR
        let fd = open(url.path, flags, 0o644)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        let length = CrateProbeLayout.fileBytes
        if create {
            guard ftruncate(fd, off_t(length)) == 0 else { return nil }
        } else {
            var info = stat()
            guard fstat(fd, &info) == 0, Int(info.st_size) >= length else { return nil }
        }
        // MAP_FAILED is a C macro Swift does not import: it is all bits set.
        guard let mapped = mmap(nil, length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0),
              mapped != UnsafeMutableRawPointer(bitPattern: -1)
        else { return nil }
        base = mapped
        self.length = length
        if create {
            memset(base, 0, length)
            header[0] = CrateProbeLayout.magic
            header[1] = CrateProbeLayout.version
        }
    }

    deinit { munmap(base, length) }

    /// Render thread: publishes the frame just written into `values`.
    @inline(__always) public func commit(count: Int, layoutHash: UInt64) {
        header[3] = UInt32(min(count, CrateProbeLayout.maxProbes))
        (base + 16).assumingMemoryBound(to: UInt64.self).pointee = layoutHash
        header[2] = header[2] &+ 1
    }

    /// Reader: the latest frame, if one landed since `sequence`. Copies into
    /// `into`, which must hold `maxProbes` values; returns the frame's
    /// sequence, count and layout hash.
    public func read(
        since sequence: UInt32,
        into destination: UnsafeMutablePointer<Float>
    ) -> (sequence: UInt32, count: Int, layoutHash: UInt64)? {
        guard header[0] == CrateProbeLayout.magic, header[1] == CrateProbeLayout.version else { return nil }
        let current = header[2]
        guard current != sequence else { return nil }
        let count = min(Int(header[3]), CrateProbeLayout.maxProbes)
        let hash = (base + 16).assumingMemoryBound(to: UInt64.self).pointee
        destination.update(from: values, count: count)
        return (current, count, hash)
    }
}
