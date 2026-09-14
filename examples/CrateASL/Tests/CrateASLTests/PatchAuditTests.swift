import XCTest
@testable import CrateASL

/// The audit, held to the patches that actually shipped wrong.
///
/// Every rule here exists because something got through: a cable into a jack
/// flatten drops, a euclidean nothing clocks, a voice nobody plays, a pattern
/// that comes back rotated after Stop. So each test builds that patch by hand
/// and asks whether the audit sees it, rather than asking whether the audit
/// runs.
final class PatchAuditTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    private func node(_ id: String, _ kind: String, _ params: [String: Double] = [:]) -> CratePatchNode {
        CratePatchNode(id: id, kind: kind, params: params)
    }

    private func cable(_ from: String, _ out: String, _ to: String, _ inlet: String) -> CratePatchConnection {
        CratePatchConnection(source: from, sourceOutput: out, target: to, targetInput: inlet)
    }

    private func rules(_ findings: [CrateGenFinding]) -> [String] {
        findings.map(\.rule)
    }

    // MARK: A cable that does nothing

    func testACableIntoAJackFlattenDropsIsCaught() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("clk", "clock"),
                node("env", "adsr"),
                node("master", catalog.io.master),
            ],
            connections: [
                // The trap of 9.6: `gate` on an ADSR is the voice allocator's,
                // the graph never reads it, and flatten throws the cable away.
                cable("clk", "cv", "env", "gate"),
                cable("env", "cv", "master", "input"),
            ]
        )
        let findings = CratePatchAudit.run(patch, catalog: catalog)
        XCTAssertTrue(rules(findings).contains("cable.unreachable"), "\(rules(findings))")
        let finding = try XCTUnwrap(findings.first { $0.rule == "cable.unreachable" })
        XCTAssertEqual(finding.severity, .broken)
        XCTAssertEqual(finding.node, "env")
    }

    /// And the same cable from a keyboard is not a finding, because that one
    /// is a statement about what plays the module rather than a signal.
    func testAKeyboardCableIntoAGateIsNotAFinding() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("keys", catalog.io.keyboard),
                node("osc", "oscillator"),
                node("master", catalog.io.master),
            ],
            connections: [
                cable("keys", "cv", "osc", "note"),
                cable("keys", "gate", "osc", "gate"),
                cable("osc", "audio", "master", "input"),
            ]
        )
        let findings = CratePatchAudit.run(patch, catalog: catalog)
        XCTAssertFalse(rules(findings).contains("cable.unreachable"), "\(rules(findings))")
    }

    /// The derivation behind all of it: every jack the dead-jack list knows
    /// about, and nothing else, is refused.
    func testTheReachabilityRuleAgreesWithWhatWasMeasured() throws {
        let catalog = try catalog()
        for dead in DeadJackTests.known {
            let parts = dead.split(separator: ".", maxSplits: 1).map(String.init)
            XCTAssertFalse(
                catalog.canReceiveCable(kind: parts[0], inlet: parts[1]),
                "\(dead) is measured dead and the rule says a cable reaches it"
            )
        }
        // And the jacks that work, work.
        for live in ["oscillator.note", "oscillator.velocity", "lowpass.cutoff", "dahdsr.input",
                     "euclidean.clock", "clock.reset", "samplehold.clock", "ladder.drive"] {
            let parts = live.split(separator: ".", maxSplits: 1).map(String.init)
            XCTAssertTrue(
                catalog.canReceiveCable(kind: parts[0], inlet: parts[1]),
                "\(live) works and the rule says it does not"
            )
        }
    }

    // MARK: A pattern nothing advances

    func testAEuclideanWithNothingOnItsClockIsCaught() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("euc", "euclidean"),
                node("master", catalog.io.master),
            ],
            connections: [cable("euc", "cv", "master", "input")]
        )
        let findings = CratePatchAudit.run(patch, catalog: catalog)
        let finding = try XCTUnwrap(findings.first { $0.rule == "pattern.noClock" })
        XCTAssertEqual(finding.severity, .broken)
        XCTAssertNil(finding.repair, "there is no clock in the patch to wire it to")
    }

    /// With a clock already present it is repaired rather than reported,
    /// because a second clock at a second rate would be a different patch.
    func testAEuclideanIsClockedFromTheClockThatIsAlreadyThere() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("clk", "syncedclock"),
                node("euc", "euclidean"),
                node("master", catalog.io.master),
            ],
            connections: [cable("euc", "cv", "master", "input")]
        )
        let repaired = CratePatchAudit.repair(patch, catalog: catalog)
        XCTAssertTrue(
            repaired.patch.connections.contains(cable("clk", "cv", "euc", "clock")),
            "the clock in the patch was not wired to the pattern"
        )
        XCTAssertTrue(repaired.fixed.contains { $0.rule == "pattern.noClock" })
        XCTAssertFalse(
            rules(repaired.remaining).contains("pattern.noClock"),
            "\(rules(repaired.remaining))"
        )
    }

    // MARK: Starting with the song

    func testAPatternWithNoResetIsWiredToTheTransport() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("song", catalog.io.transport),
                node("clk", "syncedclock"),
                node("euc", "euclidean"),
                node("master", catalog.io.master),
            ],
            connections: [
                cable("clk", "cv", "euc", "clock"),
                cable("euc", "cv", "master", "input"),
            ]
        )
        // Only the euclidean. A Synced Clock is read off the song position and
        // holds no state, so there is nothing in it to put back, and offering
        // it a reset it does not have would be the audit inventing a jack.
        let before = CratePatchAudit.run(patch, catalog: catalog)
        XCTAssertEqual(before.filter { $0.rule == "pattern.noReset" }.map(\.node), ["euc"])

        let repaired = CratePatchAudit.repair(patch, catalog: catalog)
        XCTAssertTrue(
            repaired.patch.connections.contains(cable("song", "playing", "euc", "reset")),
            "the pattern was not started with the song"
        )
        XCTAssertFalse(rules(repaired.remaining).contains("pattern.noReset"))
    }

    /// No Transport is one finding about the patch rather than one per module,
    /// and it is not repaired: adding a Transport decides what kind of patch
    /// this is, which is not the audit's call.
    func testAPatchWithNoTransportSaysSoOnce() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("clk", "clock"),
                node("euc", "euclidean"),
                node("master", catalog.io.master),
            ],
            connections: [
                cable("clk", "cv", "euc", "clock"),
                cable("euc", "cv", "master", "input"),
            ]
        )
        let findings = CratePatchAudit.run(patch, catalog: catalog)
        XCTAssertEqual(findings.filter { $0.rule == "transport.absent" }.count, 1)
        XCTAssertTrue(findings.filter { $0.rule == "transport.absent" }.allSatisfy { $0.repair == nil })
        XCTAssertFalse(rules(findings).contains("pattern.noReset"))
    }

    // MARK: A voice nobody plays

    func testAnOscillatorWithNoNotesAndNoKeyboardIsCaught() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("source", "oscillator"),
                node("master", catalog.io.master),
            ],
            connections: [cable("source", "audio", "master", "input")]
        )
        let findings = CratePatchAudit.run(patch, catalog: catalog)
        XCTAssertTrue(rules(findings).contains("voice.noNotes"), "\(rules(findings))")
        XCTAssertTrue(rules(findings).contains("voice.noAmp"), "\(rules(findings))")
        // Not repairable: the fix is a lane, and a lane is a composition.
        XCTAssertTrue(
            findings.filter { $0.rule.hasPrefix("voice.") }.allSatisfy { $0.repair == nil }
        )
    }

    func testAVoiceWithAKeyboardIsNotAFinding() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("keys", catalog.io.keyboard),
                node("source", "oscillator"),
                node("master", catalog.io.master),
            ],
            connections: [
                cable("keys", "cv", "source", "note"),
                cable("source", "audio", "master", "input"),
            ]
        )
        XCTAssertFalse(
            rules(CratePatchAudit.run(patch, catalog: catalog)).contains { $0.hasPrefix("voice.") }
        )
    }

    // MARK: The output

    func testControlPatchedIntoMasterIsCaughtAndCut() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("song", catalog.io.transport),
                node("clk", "syncedclock"),
                node("tone", "tone"),
                node("master", catalog.io.master),
            ],
            connections: [
                cable("tone", "audio", "master", "input"),
                cable("clk", "cv", "master", "input"),
            ]
        )
        let repaired = CratePatchAudit.repair(patch, catalog: catalog)
        XCTAssertFalse(
            repaired.patch.connections.contains(cable("clk", "cv", "master", "input")),
            "a clock is still in the mix"
        )
        XCTAssertTrue(
            repaired.patch.connections.contains(cable("tone", "audio", "master", "input")),
            "the audio was cut instead"
        )
    }

    func testAFilterWithNothingFeedingItIsCaught() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("filter", "lowpass"),
                node("master", catalog.io.master),
            ],
            connections: [cable("filter", "audio", "master", "input")]
        )
        let findings = CratePatchAudit.run(patch, catalog: catalog)
        XCTAssertTrue(rules(findings).contains("module.noInput"), "\(rules(findings))")
    }

    // MARK: What the generator produces

    /// The bar that matters: what the pipeline builds on its own has nothing
    /// broken in it. A rule that fires on every generated patch is a rule that
    /// gets ignored.
    func testNothingTheGeneratorBuildsIsBroken() throws {
        let catalog = try catalog()
        for role in CrateGen.Role.allCases {
            let vocabulary = CrateGenVocabulary(role: role, catalog: catalog)
            for kind in CrateGenLaneKind.allCases {
                let built = CrateGenBuilder.assemble(
                    plan: CrateGenPlan(
                        role: role, summary: "t",
                        source: vocabulary.sources.first ?? CrateGen.none,
                        filter: vocabulary.filters.first ?? "lowpass",
                        space: "reverb", effects: ["gain"]
                    ),
                    lanes: [CrateGenLane(kind: kind, rateHz: 2, depth: 0.5)],
                    catalog: catalog
                )
                let broken = CratePatchAudit.run(built.patch, catalog: catalog)
                    .filter { $0.severity == .broken }
                XCTAssertEqual(
                    broken.map(\.detail), [],
                    "\(role)/\(kind.rawValue) came out of the generator broken"
                )
            }
        }
    }

    // MARK: The prompt

    /// What a second pass is handed has to be small, or the layer has not paid
    /// for itself. Six findings is well under a tenth of the window the whole
    /// request has to fit inside.
    func testTheFollowUpPromptIsSmallEnoughToAfford() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("source", "oscillator"),
                node("euc", "euclidean"),
                node("filter", "lowpass"),
                node("master", catalog.io.master),
            ],
            connections: [cable("source", "audio", "master", "input")]
        )
        let findings = CratePatchAudit.run(patch, catalog: catalog)
        XCTAssertGreaterThan(findings.count, 3, "this patch is wrong in more ways than that")
        let prompt = CratePatchAudit.prompt(findings)
        XCTAssertLessThanOrEqual(prompt.split(separator: "\n").count, 6, "the cap is not holding")
        XCTAssertLessThan(prompt.count / 3, 250, "the follow-up prompt is \(prompt.count / 3) tokens")
        // Worst first, so the cap drops the least important.
        XCTAssertTrue(
            prompt.contains("euc"),
            "a pattern nothing clocks did not survive the cap: \(prompt)"
        )
    }

    /// The whole mend request, measured against the window it has to fit in.
    ///
    /// This is what the layer is for. The browser sends a 9,515 token rulebook
    /// and the whole catalog; the on-device model has 4,096 tokens for
    /// instructions, prompt, schema and reply together. A fourth pass is only
    /// possible because a finding is the rule already applied to this patch,
    /// which is an order of magnitude smaller than the rule, and because the
    /// brief omits every value still at its default.
    ///
    /// Counted at three characters to a token, the same estimate
    /// `CrateGenSession.change` guards with.
    func testTheWholeMendRequestFitsWithRoomToAnswer() throws {
        let catalog = try catalog()
        // A real generated patch, broken the way a first pass breaks one: the
        // routing left a pattern unclocked and a cable landed on a dead jack.
        var patch = CrateGenBuilder.assemble(
            plan: CrateGenPlan(
                role: .generative, summary: "t", source: "oscillator", layer: "noise",
                filter: "ladder", space: "reverb", effects: ["bitcrush", "gain"]
            ),
            lanes: [
                CrateGenLane(kind: .euclidean, rateHz: 4, depth: 0.6),
                CrateGenLane(kind: .drift, rateHz: 0.3, depth: 0.4),
            ],
            catalog: catalog
        ).patch
        patch.nodes.append(node("euc2", "euclidean"))
        patch.nodes.append(node("env2", "adsr"))
        patch.connections.append(cable("euc2", "cv", "space", "mix"))
        patch.connections.append(cable("euc2", "cv", "env2", "gate"))

        let findings = CratePatchAudit.run(patch, catalog: catalog)
        XCTAssertFalse(findings.isEmpty, "this patch is wrong and the audit did not notice")

        let brief = CratePatchEditor.brief(patch, catalog: catalog)
        let problems = CratePatchAudit.prompt(findings)
        // The fixed prose in `mendEdits`, counted so the budget is the real
        // one rather than the interesting half of it.
        let boilerplate = 320
        let tokens = (brief.count + problems.count + boilerplate) / 3

        XCTAssertLessThan(
            tokens, 1200,
            "the mend request is \(tokens) tokens, leaving too little of 4,096 for the schema and the reply"
        )
        // And the findings are the small half: the point is that stating the
        // problem costs less than stating the rule behind it.
        XCTAssertLessThan(
            problems.count / 3, 200,
            "the findings alone are \(problems.count / 3) tokens"
        )
    }

    /// Findings come back in a stable order. An unstable one turns a single
    /// prompt into two different prompts and makes a failure unreproducible.
    func testTheOrderIsStable() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("source", "oscillator"),
                node("euc", "euclidean"),
                node("filter", "lowpass"),
                node("master", catalog.io.master),
            ],
            connections: [cable("source", "audio", "master", "input")]
        )
        let once = CratePatchAudit.run(patch, catalog: catalog)
        for _ in 0..<5 {
            XCTAssertEqual(CratePatchAudit.run(patch, catalog: catalog), once)
        }
        // And worst first, which is what makes the cap in `prompt` drop the
        // least important rather than an arbitrary one.
        for (earlier, later) in zip(once, once.dropFirst()) {
            XCTAssertFalse(later.severity < earlier.severity, "\(later.rule) sorted above \(earlier.rule)")
        }
    }

    /// Repair reaches a fixed point rather than looping, even on a patch it
    /// cannot finish fixing.
    func testRepairStopsEvenWhenItCannotFinish() throws {
        let catalog = try catalog()
        let patch = CratePatch(
            nodes: [
                node("source", "oscillator"),
                node("euc", "euclidean"),
                node("master", catalog.io.master),
            ],
            connections: []
        )
        let repaired = CratePatchAudit.repair(patch, catalog: catalog)
        XCTAssertFalse(repaired.remaining.isEmpty, "this patch cannot be repaired into a good one")
        XCTAssertTrue(
            repaired.remaining.allSatisfy { $0.repair == nil },
            "it stopped with repairs still on the table: \(rules(repaired.remaining))"
        )
    }
}
