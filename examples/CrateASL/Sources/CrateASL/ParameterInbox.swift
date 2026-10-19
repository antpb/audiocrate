import Foundation
import os

/// Parameter changes from any thread, applied by the render thread.
///
/// A host's parameter tree calls its observer on whatever thread set the
/// value: the main thread for a knob in the plugin's own editor, something
/// else for a host that automates through the tree. None of those may touch a
/// `VoiceState`. Its `params` is a Swift dictionary the render thread writes
/// on every note and every host event, and two threads mutating one
/// dictionary is the crash `PortScalarRaceTests` exists for. Starting a glide
/// from there would be worse again, because a glide writes ramp state the
/// render commits.
///
/// So a change is posted here and nowhere else, and the render thread drains
/// the box at the top of a block, where it may glide (`CompiledVoice.setParam`)
/// the way a host's own step events do. A knob in the editor and a host
/// stepping a parameter then sound the same, and neither zips.
///
/// Latest value wins. A drag posts sixty values a second and a block drains
/// every few milliseconds; replaying every intermediate one would only make
/// the glide restart more often on its way to the same place. A slot posted
/// twice before a drain is applied once, with the second value.
///
/// The render thread never waits: `drain` only *tries* the lock and leaves
/// everything pending if a post holds it, which costs those changes one block.
/// The lock is held for a handful of stores on either side.
public final class ParameterInbox: @unchecked Sendable {
    public let count: Int

    private let lock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
    /// The value posted for each slot and not yet applied.
    private let pending: UnsafeMutablePointer<Double>
    private let dirty: UnsafeMutablePointer<Bool>
    /// Which slots are dirty, in the order they were first posted, so a drain
    /// visits only what changed rather than every parameter the patch has.
    private let queue: UnsafeMutablePointer<Int>
    private var queued = 0
    /// What a host should be shown for each slot: the latest value posted or
    /// applied, from whichever side. Raw storage, not a Swift collection, so a
    /// reader on another thread can at worst see a value one change stale and
    /// can never see the structure mid-rebuild.
    private let shown: UnsafeMutablePointer<Double>

    public init(initial: [Double]) {
        count = initial.count
        let capacity = max(1, initial.count)
        lock.initialize(to: os_unfair_lock())
        pending = .allocate(capacity: capacity)
        pending.initialize(repeating: 0, count: capacity)
        dirty = .allocate(capacity: capacity)
        dirty.initialize(repeating: false, count: capacity)
        queue = .allocate(capacity: capacity)
        queue.initialize(repeating: 0, count: capacity)
        shown = .allocate(capacity: capacity)
        shown.initialize(repeating: 0, count: capacity)
        for (index, value) in initial.enumerated() { shown[index] = value }
    }

    deinit {
        let capacity = max(1, count)
        lock.deinitialize(count: 1)
        lock.deallocate()
        pending.deinitialize(count: capacity)
        pending.deallocate()
        dirty.deinitialize(count: capacity)
        dirty.deallocate()
        queue.deinitialize(count: capacity)
        queue.deallocate()
        shown.deinitialize(count: capacity)
        shown.deallocate()
    }

    /// Posts a change. Any thread except the render thread, which applies its
    /// own changes directly and records them with `applied`.
    public func post(_ index: Int, _ value: Double) {
        guard index >= 0, index < count, value.isFinite else { return }
        os_unfair_lock_lock(lock)
        if !dirty[index] {
            dirty[index] = true
            queue[queued] = index
            queued += 1
        }
        pending[index] = value
        shown[index] = value
        os_unfair_lock_unlock(lock)
    }

    /// Applies everything posted since the last drain, in the order the slots
    /// were first posted. Render thread only; never blocks, never allocates.
    /// Returns how many changes it applied, 0 when the lock was busy.
    @discardableResult
    public func drain(_ apply: (Int, Double) -> Void) -> Int {
        guard os_unfair_lock_trylock(lock) else { return 0 }
        let drained = queued
        for position in 0..<queued {
            let index = queue[position]
            dirty[index] = false
            apply(index, pending[index])
        }
        queued = 0
        os_unfair_lock_unlock(lock)
        return drained
    }

    /// Records a value the render thread applied without going through the
    /// box, a host's own render event or a MIDI controller, so what the host
    /// reads back is what is playing. Unlocked on purpose: the render thread
    /// may not wait, and the only cost of a race here is a readout one change
    /// behind.
    @inline(__always) public func applied(_ index: Int, _ value: Double) {
        guard index >= 0, index < count else { return }
        shown[index] = value
    }

    /// The value to show for a slot. Any thread.
    public func value(_ index: Int) -> Double {
        guard index >= 0, index < count else { return 0 }
        return shown[index]
    }

    /// Whether anything is waiting, for tests.
    public var hasPending: Bool {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        return queued > 0
    }
}
