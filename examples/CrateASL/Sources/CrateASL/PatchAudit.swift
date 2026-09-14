//
//  PatchAudit.swift
//  CrateASL
//
//  What is wrong with a drafted patch, said precisely enough to act on.
//
//  `CratePatchCheck` answers a different question: is this a legal document.
//  A patch can be entirely legal and still be the patch nobody wanted. It
//  validates with a euclidean nothing clocks, a voice nothing plays, an
//  oscillator wired to a jack flatten will drop, and a clock with no reset so
//  the pattern comes back rotated after Stop. Every one of those has happened
//  in this pipeline, and none of them is a validity error.
//
//  So this is the second layer, and it exists in this shape for two reasons.
//
//  The first is that the model cannot be told the rules. The on-device window
//  is 4,096 tokens for instructions, prompt, schema and reply together, and
//  the browser's rulebook is 9,515 on its own. Checking after the fact costs
//  nothing from that budget, and a finding is far smaller than the rule that
//  produced it: "m1euc has no clock" is six tokens where the paragraph
//  explaining why a euclidean needs one is two hundred.
//
//  The second is that most of these have an answer Swift already knows. A
//  clock with no reset wants the transport's `playing`; a voice with no notes
//  wants a notes lane. Those are `repair`s, applied without asking anybody,
//  and the model is only shown what is left. That is what makes a second pass
//  affordable: it is handed a short list of real problems instead of the
//  patch and the rulebook again.
//

import Foundation

// MARK: - Findings

/// One thing wrong with a patch, and what to do about it.
public struct CrateGenFinding: Sendable, Equatable {

    public enum Severity: String, Sendable, CaseIterable, Comparable {
        /// The patch is silent, or a cable in it does nothing at all.
        case broken
        /// It plays, and it is not what was asked for.
        case weak
        /// Worth saying and not worth changing.
        case note

        private var rank: Int {
            switch self {
            case .broken: return 0
            case .weak: return 1
            case .note: return 2
            }
        }

        public static func < (lhs: Severity, rhs: Severity) -> Bool { lhs.rank < rhs.rank }
    }

    /// A stable id, so a test can name a rule and a log can be grepped.
    public var rule: String
    public var severity: Severity
    /// The node this is about, for an editor that wants to select it.
    public var node: String
    /// One line, written for a person and short enough to send to a model.
    public var detail: String
    /// What Swift would do about it unaided. Absent means it needs judgment.
    public var repair: CrateGenRepair?

    public init(
        rule: String,
        severity: Severity,
        node: String = "",
        detail: String,
        repair: CrateGenRepair? = nil
    ) {
        self.rule = rule
        self.severity = severity
        self.node = node
        self.detail = detail
        self.repair = repair
    }
}

/// An edit the audit can make on its own.
public enum CrateGenRepair: Sendable, Equatable {
    case connect(CratePatchConnection)
    case disconnect(CratePatchConnection)
    case setParam(node: String, param: String, value: Double)
}

// MARK: - The audit

public enum CratePatchAudit {

    /// Inlets that take an event rather than a level.
    static let triggerInlets: Set<String> = ["clock", "reset", "trig", "gate"]

    /// The slots the audio chain is built from, in order, so "downstream" has
    /// a meaning without walking the graph twice.
    static let chainOrder = ["line", "source", "layer", "filter", "fx1", "fx2", "fx3", "space", "run", "out"]

    /// Everything worth saying about a patch, worst first.
    ///
    /// Ordered by severity and then by rule, so the list a model is shown is
    /// stable between runs: an unstable ordering turns one prompt into two
    /// different prompts and makes a failure impossible to reproduce.
    public static func run(_ patch: CratePatch, catalog: MaterialCatalog) -> [CrateGenFinding] {
        var findings = [CrateGenFinding]()
        findings += unreachableCables(patch, catalog)
        findings += patternsWithNothingDrivingThem(patch, catalog)
        findings += patternsThatDoNotStartWithTheSong(patch, catalog)
        findings += voicesNobodyPlays(patch, catalog)
        findings += modulesWiredToNothing(patch, catalog)
        findings += outputProblems(patch, catalog)
        return findings.sorted {
            $0.severity == $1.severity
                ? ($0.rule == $1.rule ? $0.node < $1.node : $0.rule < $1.rule)
                : $0.severity < $1.severity
        }
    }

    /// Applies every finding that carries a repair, and returns the patch plus
    /// the findings that are left.
    ///
    /// Re-audited afterwards rather than trusting the repairs, because one fix
    /// can expose another: cabling a clock into a euclidean gives the euclidean
    /// a reset to want.
    public static func repair(
        _ patch: CratePatch,
        catalog: MaterialCatalog,
        rounds: Int = 3
    ) -> (patch: CratePatch, fixed: [CrateGenFinding], remaining: [CrateGenFinding]) {
        var patch = patch
        var fixed = [CrateGenFinding]()
        var findings = run(patch, catalog: catalog)

        for _ in 0..<rounds {
            let actionable = findings.filter { $0.repair != nil }
            guard !actionable.isEmpty else { break }
            for finding in actionable {
                guard let repair = finding.repair, apply(repair, to: &patch) else { continue }
                fixed.append(finding)
            }
            let next = run(patch, catalog: catalog)
            // A repair that did not reduce the list is a repair that is not
            // working, and looping on it would spend the whole budget.
            if next.count >= findings.count && next.filter({ $0.repair != nil }).count
                >= actionable.count {
                findings = next
                break
            }
            findings = next
        }
        return (patch, fixed, findings)
    }

    private static func apply(_ repair: CrateGenRepair, to patch: inout CratePatch) -> Bool {
        switch repair {
        case let .connect(cable):
            guard patch.node(cable.source) != nil, patch.node(cable.target) != nil else { return false }
            guard !patch.connections.contains(cable) else { return false }
            patch.connections.append(cable)
            return true
        case let .disconnect(cable):
            let before = patch.connections.count
            patch.connections.removeAll { $0 == cable }
            return patch.connections.count != before
        case let .setParam(id, name, value):
            guard let index = patch.nodes.firstIndex(where: { $0.id == id }) else { return false }
            patch.nodes[index].params[name] = value
            return true
        }
    }

    // MARK: Rules

    /// A cable into a jack flatten will silently drop.
    ///
    /// The worst class of wrong, because everything downstream of it looks
    /// right: the cable is drawn, the document holds it, the patch validates
    /// and the graph compiles. Only the sound is missing.
    static func unreachableCables(
        _ patch: CratePatch,
        _ catalog: MaterialCatalog
    ) -> [CrateGenFinding] {
        patch.connections.compactMap { cable in
            guard let target = patch.node(cable.target) else { return nil }
            // A keyboard cable is a statement about what plays the module
            // rather than a signal, and flatten reads it that way.
            if let source = patch.node(cable.source),
               source.kind == catalog.io.keyboard || source.kind == catalog.io.midiIn {
                return nil
            }
            guard !catalog.canReceiveCable(kind: target.kind, inlet: cable.targetInput) else {
                return nil
            }
            return CrateGenFinding(
                rule: "cable.unreachable",
                severity: .broken,
                node: cable.target,
                detail:
                    "\(cable.source) is cabled to \(cable.target).\(cable.targetInput), "
                    + "and \(target.kind) does not read that jack, so the cable does nothing",
                repair: .disconnect(cable)
            )
        }
    }

    /// A pattern module with nothing on its clock.
    ///
    /// A euclidean or a sequencer with no clock is a module sitting on the
    /// canvas holding its first step forever. It is the commonest thing a
    /// first pass leaves out, because the model is choosing modules rather
    /// than thinking about what advances them.
    static func patternsWithNothingDrivingThem(
        _ patch: CratePatch,
        _ catalog: MaterialCatalog
    ) -> [CrateGenFinding] {
        var findings = [CrateGenFinding]()
        let clocks = patch.nodes.filter { node in
            guard let outputs = catalog.jacks(node.kind)?.outputs else { return false }
            return catalog.material(node.kind)?.isUnipolar == true && !outputs.isEmpty
                && isClockLike(node.kind)
        }
        for node in patch.nodes {
            guard let inputs = catalog.jacks(node.kind)?.inputs, inputs.contains("clock") else {
                continue
            }
            guard catalog.canReceiveCable(kind: node.kind, inlet: "clock") else { continue }
            guard !patch.connections.contains(where: {
                $0.target == node.id && $0.targetInput == "clock"
            }) else { continue }

            // If there is already a clock in the patch, use it rather than
            // asking anybody: a second clock at a second rate is a different
            // patch, and this is a repair rather than a rewrite.
            let repair = clocks.first(where: { $0.id != node.id }).flatMap { clock -> CrateGenRepair? in
                guard let jack = catalog.jacks(clock.kind)?.outputs.first else { return nil }
                return .connect(
                    CratePatchConnection(
                        source: clock.id, sourceOutput: jack,
                        target: node.id, targetInput: "clock"
                    )
                )
            }
            findings.append(
                CrateGenFinding(
                    rule: "pattern.noClock",
                    severity: .broken,
                    node: node.id,
                    detail: repair == nil
                        ? "\(node.id) (\(node.kind)) has nothing on its clock, and there is no clock in the patch to give it one"
                        : "\(node.id) (\(node.kind)) has nothing on its clock, so it holds its first step",
                    repair: repair
                )
            )
        }
        return findings
    }

    static func isClockLike(_ kind: String) -> Bool {
        kind == "clock" || kind == "syncedclock" || kind == "clockdivide" || kind == "clockmultiply"
    }

    /// A module that counts steps, with no reset from the transport.
    ///
    /// The patch plays, and it plays in the wrong place: press Stop halfway
    /// through a bar and the pattern comes back rotated by however far it had
    /// got. A synced clock is on the grid because it is read off the song
    /// position, and the step counter under it is not.
    static func patternsThatDoNotStartWithTheSong(
        _ patch: CratePatch,
        _ catalog: MaterialCatalog
    ) -> [CrateGenFinding] {
        guard let song = patch.nodes.first(where: { $0.kind == catalog.io.transport }),
              catalog.jacks(song.kind)?.outputs.contains("playing") == true
        else {
            // No Transport at all. Worth one finding rather than one per
            // module, and not repairable: adding a Transport to a patch is a
            // decision about what kind of patch it is.
            let counters = patch.nodes.filter {
                catalog.canReceiveCable(kind: $0.kind, inlet: "reset")
            }
            guard !counters.isEmpty else { return [] }
            return [
                CrateGenFinding(
                    rule: "transport.absent",
                    severity: .weak,
                    node: counters[0].id,
                    detail:
                        "\(counters.map(\.id).joined(separator: ", ")) count steps and there is no "
                        + "Transport in the patch, so nothing can start them with the song"
                )
            ]
        }
        return patch.nodes.compactMap { node in
            guard node.id != song.id,
                  catalog.canReceiveCable(kind: node.kind, inlet: "reset"),
                  !patch.connections.contains(where: {
                      $0.target == node.id && $0.targetInput == "reset"
                  })
            else { return nil }
            return CrateGenFinding(
                rule: "pattern.noReset",
                severity: .weak,
                node: node.id,
                detail:
                    "\(node.id) (\(node.kind)) has no reset, so after a Stop it carries on "
                    + "from wherever it was instead of starting with the song",
                repair: .connect(
                    CratePatchConnection(
                        source: song.id, sourceOutput: "playing",
                        target: node.id, targetInput: "reset"
                    )
                )
            )
        }
    }

    /// A voice with no keyboard, no notes and nothing opening it.
    ///
    /// The generative failure: an oscillator on the canvas with nobody playing
    /// it is silence, or one held note forever. Not repairable here, because
    /// the fix is a lane and a lane is a composition: it goes to the follow-up
    /// pass, which is exactly the kind of question worth spending a call on.
    static func voicesNobodyPlays(
        _ patch: CratePatch,
        _ catalog: MaterialCatalog
    ) -> [CrateGenFinding] {
        guard !patch.nodes.contains(where: { $0.kind == catalog.io.keyboard }) else { return [] }
        var findings = [CrateGenFinding]()
        for node in patch.nodes {
            guard let material = catalog.material(node.kind), material.polyphony > 1 else { continue }
            let driven = { (inlet: String) in
                patch.connections.contains { $0.target == node.id && $0.targetInput == inlet }
            }
            if catalog.canReceiveCable(kind: node.kind, inlet: "note"), !driven("note") {
                findings.append(
                    CrateGenFinding(
                        rule: "voice.noNotes",
                        severity: .broken,
                        node: node.id,
                        detail:
                            "\(node.id) (\(node.kind)) is a keyboard voice with nothing writing its "
                            + "note, and there is no keyboard, so it sits on one pitch"
                    )
                )
            }
            let amp = ["gain", "velocity"].filter {
                catalog.canReceiveCable(kind: node.kind, inlet: $0)
            }
            if !amp.isEmpty, !amp.contains(where: driven) {
                findings.append(
                    CrateGenFinding(
                        rule: "voice.noAmp",
                        severity: .weak,
                        node: node.id,
                        detail:
                            "nothing opens \(node.id) (\(node.kind)): its \(amp.joined(separator: " and ")) "
                            + "is not driven, so it drones rather than playing notes"
                    )
                )
            }
        }
        return findings
    }

    /// A module whose output reaches nothing, and one whose audio inlet is fed
    /// by nothing.
    static func modulesWiredToNothing(
        _ patch: CratePatch,
        _ catalog: MaterialCatalog
    ) -> [CrateGenFinding] {
        var findings = [CrateGenFinding]()
        for node in patch.nodes {
            guard !catalog.isHostTool(node.kind), let material = catalog.material(node.kind) else {
                continue
            }
            if !patch.connections.contains(where: { $0.source == node.id }) {
                findings.append(
                    CrateGenFinding(
                        rule: "module.drivesNothing",
                        severity: .broken,
                        node: node.id,
                        detail: "\(node.id) (\(node.kind)) is on the canvas and its output goes nowhere"
                    )
                )
            }
            // An audio inlet with nothing in it is silence passing through a
            // filter, which is the shape of a chain that was built in the
            // wrong order.
            for inlet in material.audioInputs where !patch.connections.contains(where: {
                $0.target == node.id && $0.targetInput == inlet
            }) {
                findings.append(
                    CrateGenFinding(
                        rule: "module.noInput",
                        severity: .broken,
                        node: node.id,
                        detail:
                            "\(node.id) (\(node.kind)) shapes a signal and nothing is feeding its "
                            + "\(inlet), so it passes silence on"
                    )
                )
            }
        }
        return findings
    }

    /// What the output looks like: something reaching it, and something
    /// keeping it in bounds.
    static func outputProblems(
        _ patch: CratePatch,
        _ catalog: MaterialCatalog
    ) -> [CrateGenFinding] {
        guard let master = patch.nodes.first(where: { $0.kind == catalog.io.master }) else {
            return [
                CrateGenFinding(
                    rule: "output.noMaster",
                    severity: .broken,
                    detail: "the patch has no Master, so it has no output"
                )
            ]
        }
        var findings = [CrateGenFinding]()
        let into = patch.connections.filter { $0.target == master.id }
        if into.isEmpty {
            findings.append(
                CrateGenFinding(
                    rule: "output.silent",
                    severity: .broken,
                    node: master.id,
                    detail: "nothing is patched into Master, so the patch is silent"
                )
            )
        }
        // Control into the output is the one cable that is always wrong: an
        // envelope in the mix is a click, not a shape.
        for cable in into {
            guard let source = patch.node(cable.source),
                  let material = catalog.material(source.kind),
                  material.isUnipolar || material.audioInputs.isEmpty,
                  isControlSource(source.kind)
            else { continue }
            findings.append(
                CrateGenFinding(
                    rule: "output.control",
                    severity: .broken,
                    node: cable.source,
                    detail: "\(cable.source) (\(source.kind)) is control and it is patched into Master",
                    repair: .disconnect(cable)
                )
            )
        }
        if !into.isEmpty,
           !patch.nodes.contains(where: { $0.kind == "limiter" || $0.kind == "compressor" }) {
            findings.append(
                CrateGenFinding(
                    rule: "output.noLimiter",
                    severity: .weak,
                    node: master.id,
                    detail: "nothing is holding the output down, so a resonant sweep can clip"
                )
            )
        }
        return findings
    }

    static func isControlSource(_ kind: String) -> Bool {
        isClockLike(kind)
            || ["pulse", "euclidean", "sequencer", "lfo", "adsr", "dahdsr", "syncedramp", "trigger",
                "breakpoints", "randomsmooth", "randomstepped", "envfollow", "samplehold"]
                .contains(kind)
    }
}

// MARK: - The brief a second pass is given

extension CratePatchAudit {

    /// The findings as the prompt for a follow-up pass.
    ///
    /// Deliberately not the patch and not the rulebook. The whole reason this
    /// layer exists is that neither fits: the catalog is 180 KB and the
    /// browser's rules are 9,515 tokens against a 4,096 token window. A
    /// finding is the rule already applied to this patch, which is both
    /// shorter and more useful than the rule.
    ///
    /// Capped, because a badly broken patch can produce twenty findings and a
    /// model given twenty problems fixes none of them well. Worst first, so
    /// the cap drops the least important.
    public static func prompt(_ findings: [CrateGenFinding], limit: Int = 6) -> String {
        findings
            .filter { $0.severity != .note }
            .prefix(limit)
            .map { "- \($0.detail)" }
            .joined(separator: "\n")
    }

    /// One line saying what was repaired without asking, for the sheet.
    public static func summary(fixed: [CrateGenFinding], remaining: [CrateGenFinding]) -> String? {
        var parts = [String]()
        if !fixed.isEmpty { parts.append("fixed \(fixed.count)") }
        let open = remaining.filter { $0.severity == .broken }.count
        if open > 0 { parts.append("\(open) still wrong") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}
