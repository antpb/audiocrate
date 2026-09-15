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

/// The patch that came off a device when somebody asked for "an atmospheric
/// synthesizer", kept whole.
///
/// It validated. It compiled. It had sixteen modules and seventeen cables and
/// every structural rule in the audit passed it, and it rendered exactly
/// nothing. Three separate things were wrong with it and no test anywhere
/// caught any of them, so this is the patch itself rather than a
/// reconstruction of it.
final class AtmosphericSynthesizerTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    /// Rebuilt node for node from the JSON the plugin dumped.
    private func shipped(_ catalog: MaterialCatalog) -> CratePatch {
        func n(_ id: String, _ kind: String, _ p: [String: Double] = [:]) -> CratePatchNode {
            CratePatchNode(id: id, kind: kind, params: p)
        }
        func c(_ a: String, _ j: String, _ b: String, _ i: String) -> CratePatchConnection {
            CratePatchConnection(source: a, sourceOutput: j, target: b, targetInput: i)
        }
        return CratePatch(
            nodes: [
                n("song", catalog.io.transport),
                n("source", "SynthVoice", ["cutoff": 400, "decay": 0.7, "gain": 0.3, "resonance": 0.35]),
                n("filter", "lowpass", ["cutoff": 400, "q": 0.9]),
                n("fx1", "compressor", ["mix": 0.2]),
                n("fx2", "gate"),
                n("space", "reverb", ["decay": 0.7, "mix": 0.2, "size": 1]),
                n("run", "gain", ["gain": 0.3]),
                n("out", "limiter", ["threshold": 0.85]),
                n("master", catalog.io.master),
                n("m1clk", "syncedclock", ["division": 8]),
                n("m1seq", "sequencer"),
                n("m2clk", "syncedclock", ["division": 3]),
                n("m2pls", "pulse", ["widthSec": 0.15]),
                n("m2env", "dahdsr", ["attack": 0.18, "decay": 0.3, "hold": 0.05, "release": 0.5, "sustain": 0.35]),
                n("m2trim1", "gain", ["gain": 0.6]),
                n("m2bias1", "offset", ["amount": -1]),
            ],
            connections: [
                c("m2clk", "cv", "m2pls", "input"),
                c("m2pls", "cv", "m2env", "input"),
                c("source", "audio", "filter", "input"),
                c("filter", "audio", "fx1", "input"),
                c("fx1", "audio", "fx2", "input"),
                c("fx2", "audio", "space", "input"),
                c("space", "audio", "run", "input"),
                c("run", "audio", "out", "input"),
                c("out", "audio", "master", "input"),
                c("m2env", "cv", "m2trim1", "input"),
                c("m2trim1", "audio", "m2bias1", "input"),
                c("m1clk", "cv", "m1seq", "clock"),
                c("song", "playing", "run", "gain"),
                c("m1seq", "cv", "source", "velocity"),
                c("m1seq", "cv", "source", "note"),
                c("m2bias1", "audio", "source", "gain"),
                c("song", "playing", "m1seq", "reset"),
            ]
        )
    }

    private func peak(_ patch: CratePatch, _ catalog: MaterialCatalog) throws -> Double {
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "A")
        let voice = try CompiledVoice(document: compiled.graph)
        let state = voice.makeState()
        state.setParams(ParameterMap(compiled.params).defaults)
        state.gate = true
        var out = [Float](repeating: 0, count: 48_000)
        var right: [Float]? = nil
        _ = voice.renderBlock(
            state, sampleRate: 48_000, output: &out, outputR: &right,
            transport: TransportSnapshot(playing: true)
        )
        return out.reduce(0) { Swift.max($0, Double(abs($1))) }
    }

    /// The headline, and why none of the earlier layers saw it: it is legal.
    func testItValidatesAndIsSilent() throws {
        let catalog = try catalog()
        let patch = shipped(catalog)
        XCTAssertEqual(
            CratePatchCheck.validate(patch, catalog: catalog).errors, [],
            "this patch was structurally fine, which is the whole problem"
        )
        XCTAssertEqual(try peak(patch, catalog), 0, accuracy: 1e-6, "it made no sound at all")
    }

    /// One sequencer into both note and velocity: the low notes are silent and
    /// the high ones are loud, because one number is being read as a pitch and
    /// as a level.
    func testTheSequencerDrivingBothPitchAndLevelIsCaught() throws {
        let catalog = try catalog()
        let findings = CratePatchAudit.run(shipped(catalog), catalog: catalog)
        let finding = try XCTUnwrap(findings.first { $0.rule == "voice.pitchTiedToLevel" })
        XCTAssertEqual(finding.node, "source")
        XCTAssertEqual(finding.severity, .broken)
        // The pitch cable is the one kept.
        let repaired = CratePatchAudit.repair(shipped(catalog), catalog: catalog)
        XCTAssertTrue(
            repaired.patch.connections.contains {
                $0.source == "m1seq" && $0.target == "source" && $0.targetInput == "note"
            },
            "the melody was cut instead of the level"
        )
        XCTAssertFalse(
            repaired.patch.connections.contains {
                $0.source == "m1seq" && $0.target == "source" && $0.targetInput == "velocity"
            }
        )
    }

    /// The sequencer is playing the factory steps, which is what it played in
    /// every patch that ever had one.
    func testTheSequencerHasNoMelodyInIt() throws {
        let catalog = try catalog()
        let findings = CratePatchAudit.run(shipped(catalog), catalog: catalog)
        let finding = try XCTUnwrap(findings.first { $0.rule == "sequencer.noMelody" })
        XCTAssertEqual(finding.node, "m1seq")
        XCTAssertNil(finding.repair, "Swift cannot write a melody for an atmospheric synthesizer")
    }

    /// And the reason it is silent, named rather than guessed at.
    func testTheNoiseGateIsNamedAsTheThingClosingIt() throws {
        let catalog = try catalog()
        let heard = try XCTUnwrap(CratePatchAudit.listen(shipped(catalog), catalog: catalog))
        XCTAssertEqual(heard.rule, "chain.closed")
        XCTAssertEqual(heard.node, "fx2", "the gate is the module that mutes it")
        XCTAssertTrue(heard.detail.contains("0.046"), "the measured level is what makes this actionable: \(heard.detail)")
        XCTAssertNotNil(heard.repair)
    }

    /// All of it together: the audit turns the patch that shipped into one
    /// that plays, and says what is left.
    func testTheAuditMakesItPlay() throws {
        let catalog = try catalog()
        let structural = CratePatchAudit.repair(shipped(catalog), catalog: catalog)
        let heard = CratePatchAudit.soundCheck(structural.patch, catalog: catalog)

        XCTAssertGreaterThan(
            try peak(heard.patch, catalog), 0.001,
            "after the audit it still makes no sound"
        )
        XCTAssertEqual(heard.remaining, [], "something is still closing the chain")
        // What is left needs a model, and it is the melody.
        let open = structural.remaining + heard.remaining
        XCTAssertEqual(open.map(\.rule), ["sequencer.noMelody"])
    }

    /// A notes lane with a melody in it writes that melody into the sequencer,
    /// which is the half of the fix Swift cannot do on an existing patch.
    func testAMelodyReachesTheSequencer() throws {
        let catalog = try catalog()
        // D minor, an octave apart, deliberately including a note out of key
        // and one out of range to prove both are handled.
        let steps = CrateGenLane.melody([50, 53, 57, 62, 61, 40], root: 2, scale: 1)
        XCTAssertEqual(steps.count, 6)
        for step in steps {
            XCTAssertGreaterThanOrEqual(step, -1)
            XCTAssertLessThanOrEqual(step, 1)
        }
        // Read back through flatten's own mapping: wire w is MIDI 60 + 12w.
        let midi = steps.map { 60 + 12 * $0 }
        for note in midi {
            XCTAssertGreaterThanOrEqual(note, 48)
            XCTAssertLessThanOrEqual(note, 72)
            let degree = (Int(note.rounded()) - 2 + 120) % 12
            XCTAssertTrue(
                [0, 2, 3, 5, 7, 8, 10].contains(degree),
                "MIDI \(note) is not in D minor, so the snap did not take"
            )
        }

        let built = CrateGenBuilder.assemble(
            plan: CrateGenPlan(
                role: .generative, summary: "t", source: "oscillator",
                filter: "lowpass", space: "reverb", effects: ["gain"]
            ),
            lanes: [CrateGenLane(kind: .notes, rateHz: 4, depth: 0.5, steps: steps)],
            catalog: catalog
        )
        let sequencer = try XCTUnwrap(built.patch.nodes.first { $0.kind == "sequencer" })
        XCTAssertEqual(sequencer.params["step0"], steps[0])
        // Eight steps, wrapped rather than left at their defaults: a step at
        // its default is not a rest, it is a stray note from the factory.
        for index in 0..<8 {
            XCTAssertEqual(sequencer.params["step\(index)"], steps[index % steps.count])
        }
        XCTAssertTrue(
            CratePatchAudit.run(built.patch, catalog: catalog)
                .allSatisfy { $0.rule != "sequencer.noMelody" }
        )
    }

    /// And the route that made this possible is closed: a notes lane cannot be
    /// pointed at a level, whatever the wiring pass says.
    func testANotesLaneCannotBeRoutedAtALevel() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: CrateGenPlan(
                role: .generative, summary: "t", source: "oscillator",
                filter: "lowpass", space: "reverb", effects: ["gain"]
            ),
            lanes: [
                CrateGenLane(kind: .notes, rateHz: 4, depth: 0.5),
                CrateGenLane(kind: .pulse, rateHz: 2, depth: 0.6),
            ],
            // What the model actually asked for, and what the union-of-lanes
            // menu used to let through.
            routes: [CrateGenRoute(lane: "lane1", target: "source.velocity")],
            catalog: catalog
        )
        XCTAssertFalse(
            built.patch.connections.contains {
                $0.source.hasPrefix("m1") && $0.target == "source" && $0.targetInput == "velocity"
            },
            "the notes lane reached a level jack"
        )
        XCTAssertTrue(built.notes.contains { $0.contains("cannot move source.velocity") })
    }
}

/// Making the change flow fit.
///
/// It did not. A patch the generator itself produces briefs at 464 tokens and
/// drags a 574 token schema behind it, because `targetJack` and `param` are
/// unions across every module in the patch: forty-four inlets and forty-one
/// parameters, of which one edit uses about five. Add the instructions and
/// room to answer and a 4,096 token window is gone, which is what somebody
/// pressing "Change this one" was hitting.
///
/// The fix is the same one the routing pass needed and for the same reason:
/// do not send a vocabulary, send one that has already been narrowed.
final class PatchChangeBudgetTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    /// A patch of the size the generator actually makes.
    private func realistic(_ catalog: MaterialCatalog) -> CratePatch {
        CrateGenBuilder.assemble(
            plan: CrateGenPlan(
                role: .generative, summary: "t", source: "SynthVoice", layer: "noise",
                filter: "ladder", space: "reverb", effects: ["bitcrush", "gate", "gain"]
            ),
            lanes: [
                CrateGenLane(kind: .euclidean, rateHz: 4, depth: 0.6),
                CrateGenLane(kind: .drift, rateHz: 0.3, depth: 0.4),
                CrateGenLane(kind: .notes, rateHz: 2, depth: 0.5),
            ],
            catalog: catalog
        ).patch
    }

    /// The same estimate the generator's guard uses, kept here so the number
    /// in the comments above is a measurement rather than a memory.
    private func tokens(
        _ patch: CratePatch,
        focus: Set<String>?,
        _ catalog: MaterialCatalog
    ) -> Int {
        let nodes = focus.map { keep in patch.nodes.filter { keep.contains($0.id) } } ?? patch.nodes
        let brief = CratePatchEditor.brief(patch, catalog: catalog, only: focus)
        let vocabularies =
            CrateGenVocabulary(role: .generative, catalog: catalog).allKinds
            + nodes.map(\.id) + nodes.map(\.id)
            + CrateGenBuilder.outletVocabulary(nodes, catalog: catalog)
            + CrateGenBuilder.inletVocabulary(nodes, catalog: catalog)
            + Array(Set(nodes.flatMap { catalog.material($0.kind)?.paramOrder ?? [] }))
            + CrateGenEdit.Op.allCases.map(\.rawValue)
        let schema = vocabularies.reduce(0) { $0 + $1.count + 4 }
        return (brief.count + schema) / 3
    }

    /// The problem, stated as a number so it cannot quietly come back.
    func testTheWholePatchDoesNotFit() throws {
        let catalog = try catalog()
        let patch = realistic(catalog)
        XCTAssertGreaterThan(patch.nodes.count, 15, "this is meant to be a normal patch")
        XCTAssertGreaterThan(
            tokens(patch, focus: nil, catalog), 900,
            "the whole patch used to fit, so this test is measuring the wrong thing now"
        )
    }

    /// And narrowing is what makes it fit.
    func testNarrowingToWhatAChangeIsAboutMakesItFit() throws {
        let catalog = try catalog()
        let patch = realistic(catalog)
        let whole = tokens(patch, focus: nil, catalog)

        for named in [["filter"], ["space"], ["source", "filter"]] {
            let focus = CratePatchEditor.neighbourhood(patch, around: named, catalog: catalog)
            XCTAssertFalse(focus.isEmpty, "\(named) named nothing")
            let narrowed = tokens(patch, focus: focus, catalog)
            XCTAssertLessThan(
                narrowed, whole * 2 / 3,
                "narrowing to \(named) saved almost nothing: \(narrowed) against \(whole)"
            )
            XCTAssertLessThan(narrowed, 750, "\(named) still does not leave room to answer")
        }
    }

    /// One step out, not the whole patch.
    ///
    /// The first version of `neighbourhood` tested the set it was building
    /// rather than the set it was given, so it walked the patch transitively:
    /// a filter pulled in its source, the source pulled in its lane, the lane
    /// pulled in its clock, and seventeen of twenty-three modules came back as
    /// "adjacent" to the one somebody asked about. That narrowed nothing.
    func testTheNeighbourhoodIsOneStepAndNotTheWholePatch() throws {
        let catalog = try catalog()
        let patch = realistic(catalog)
        let focus = CratePatchEditor.neighbourhood(patch, around: ["filter"], catalog: catalog)

        XCTAssertTrue(focus.contains("filter"))
        XCTAssertLessThan(focus.count, patch.nodes.count / 2, "this is not a neighbourhood")
        // What feeds it and what it feeds, and nothing two steps away.
        for cable in patch.connections where cable.target == "filter" {
            XCTAssertTrue(focus.contains(cable.source), "\(cable.source) feeds the filter and is not in")
        }
        for cable in patch.connections where cable.source == "filter" {
            XCTAssertTrue(focus.contains(cable.target), "the filter feeds \(cable.target) and it is not in")
        }
        // Master is always reachable, so an edit may rewire the output.
        XCTAssertTrue(focus.contains(where: { patch.node($0)?.kind == catalog.io.master }))
    }

    /// A narrowed brief is still a true brief: every cable it shows is in the
    /// patch, and every module it shows is too.
    func testANarrowedBriefTellsNoLies() throws {
        let catalog = try catalog()
        let patch = realistic(catalog)
        let focus = CratePatchEditor.neighbourhood(patch, around: ["space"], catalog: catalog)
        let brief = CratePatchEditor.brief(patch, catalog: catalog, only: focus)

        for line in brief.split(separator: "\n").map(String.init) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, trimmed != "nodes:", trimmed != "cables:" else { continue }
            if trimmed.contains(" > ") {
                let ends = trimmed.split(separator: ">").map {
                    $0.trimmingCharacters(in: .whitespaces).split(separator: ".").first.map(String.init) ?? ""
                }
                XCTAssertTrue(
                    ends.allSatisfy { patch.node($0) != nil },
                    "the brief names a module that is not in the patch: \(trimmed)"
                )
                XCTAssertTrue(
                    ends.contains { focus.contains($0) },
                    "the brief shows a cable neither end of which is in focus: \(trimmed)"
                )
            } else {
                let id = String(trimmed.split(separator: " ").first ?? "")
                XCTAssertTrue(focus.contains(id), "the brief shows \(id), which is not in focus")
            }
        }
    }

    /// The outline is the cheap half: what is in the patch, and nothing about
    /// how it is wired or set.
    func testTheOutlineIsCheapEnoughToAskFirst() throws {
        let catalog = try catalog()
        let patch = realistic(catalog)
        let outline = CratePatchEditor.outline(patch, catalog: catalog)
        let brief = CratePatchEditor.brief(patch, catalog: catalog)

        XCTAssertLessThan(
            outline.count * 3, brief.count,
            "the outline is \(outline.count / 3) tokens against a brief of \(brief.count / 3); it is meant to be a fraction"
        )
        XCTAssertEqual(
            outline.split(separator: "\n").count, patch.nodes.count,
            "one line per module, no more"
        )
        for node in patch.nodes {
            XCTAssertTrue(outline.contains(node.id), "\(node.id) is missing, so it cannot be named")
        }
    }

    /// Narrowing changes what the model is shown and not what an edit can do:
    /// edits apply against the whole patch either way.
    func testAnEditFromANarrowedViewStillAppliesToTheWholePatch() throws {
        let catalog = try catalog()
        let patch = realistic(catalog)
        let before = try XCTUnwrap(patch.node("filter")?.params["cutoff"])

        let applied = CratePatchEditor.apply(
            [CrateGenEdit(op: .setParam, node: "filter", param: "cutoff", value: 320)],
            to: patch,
            catalog: catalog
        )
        XCTAssertEqual(applied.applied, 1)
        XCTAssertEqual(applied.patch.node("filter")?.params["cutoff"], 320)
        XCTAssertNotEqual(before, 320)
        XCTAssertEqual(
            applied.patch.nodes.count, patch.nodes.count,
            "narrowing the view must not narrow the patch"
        )
    }
}
