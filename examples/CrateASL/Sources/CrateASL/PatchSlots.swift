import Foundation

/// How a patch's inlets are drawn when the editor drawing them allows one
/// cable per inlet.
///
/// A crate inlet takes any number of cables and sums them: `flattenPatch`
/// pushes every cable on an inlet into a list and mixes it. AudioKit Flow,
/// which the iOS patcher draws through, allows exactly one wire per input and
/// evicts the one it replaces without saying so. Those two rules cannot both
/// be true on screen, and the eviction is the one that loses information.
///
/// So an inlet is drawn as one slot per cable, plus one spare. Patch into the
/// spare and a new spare appears. Every slot writes the same `targetInput`
/// into the document, so the file is byte-identical to what the web patcher
/// would have written for the same cables, and a patch made here opens there
/// as the same graph.
///
/// This lives beside the patch document rather than in the editor because it
/// is a property of the document: which inlets mix is decided by the catalog,
/// and the mapping from a slot back to a cable is the thing that decides
/// which cable a user just deleted.
public struct CratePatchSlot: Equatable, Sendable, Identifiable {
    /// Stable within one node: an editor keys its ports on this, and the
    /// number is the cable's position on the inlet rather than its position
    /// among all the node's slots, so adding a cable to one inlet does not
    /// renumber another inlet's identities.
    public var id: String { "\(inlet)#\(occurrence)" }

    public let inlet: String
    /// Which cable on this inlet, counting from zero. The spare is the one
    /// past the last connected.
    public let occurrence: Int
    public let label: String
    public let isSpare: Bool

    public init(inlet: String, occurrence: Int, label: String, isSpare: Bool) {
        self.inlet = inlet
        self.occurrence = occurrence
        self.label = label
        self.isSpare = isSpare
    }
}

extension CratePatch {

    /// The inlets drawn for one node, spare slots included.
    ///
    /// The numbering only appears once an inlet has more than one slot.
    /// `cutoff 1` on every node of a fresh patch is noise about a capability
    /// nobody is using yet, and the document does not record the difference.
    public func slots(for node: CratePatchNode, catalog: MaterialCatalog) -> [CratePatchSlot] {
        guard let jacks = catalog.jacks(node.kind) else { return [] }
        var slots = [CratePatchSlot]()
        for (index, inlet) in jacks.inputs.enumerated() {
            let connected = sources(into: node.id, inlet: inlet).count
            let base = jacks.inputLabel(index)
            let total = connected + 1
            for occurrence in 0..<total {
                slots.append(
                    CratePatchSlot(
                        inlet: inlet,
                        occurrence: occurrence,
                        label: total > 1 ? "\(base) \(occurrence + 1)" : base,
                        isSpare: occurrence == connected
                    )
                )
            }
        }
        return slots
    }

    /// Which slot index a given cable is drawn on.
    ///
    /// Cables on one inlet are numbered in document order, which is the order
    /// they mix in. Returns nil for a connection that is not in this patch.
    public func slotIndex(
        of connection: CratePatchConnection,
        catalog: MaterialCatalog
    ) -> Int? {
        guard let node = node(connection.target) else { return nil }
        let siblings = sources(into: connection.target, inlet: connection.targetInput)
        guard let occurrence = siblings.firstIndex(where: { $0 == connection }) else { return nil }
        return slots(for: node, catalog: catalog).firstIndex {
            $0.inlet == connection.targetInput && $0.occurrence == occurrence
        }
    }

    /// The index into `connections` of the cable drawn on a slot, or nil when
    /// that slot is the spare.
    ///
    /// The nth cable on the inlet, not the first one that matches it. Two
    /// sources into one inlet are two different cables, and removing the
    /// wrong one is a change nobody can see until they listen.
    public func connectionIndex(at slot: CratePatchSlot, on nodeId: String) -> Int? {
        var seen = 0
        for (index, connection) in connections.enumerated()
        where connection.target == nodeId && connection.targetInput == slot.inlet {
            if seen == slot.occurrence { return index }
            seen += 1
        }
        return nil
    }
}
