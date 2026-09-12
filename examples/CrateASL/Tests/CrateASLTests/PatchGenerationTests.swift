import XCTest
@testable import CrateASL

/// The half of patch generation that is arithmetic rather than a model.
///
/// The split this file exists to defend: the model picks modules and cables,
/// and Swift decides whether the result is a patch. So the model is allowed
/// to be wrong in every way a model is wrong, and none of those ways may
/// produce a patch that does not play. Each test here is one of those ways.
final class PatchGenerationTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    private func plan(
        _ role: CrateGen.Role,
        source: String = CrateGen.none,
        layer: String = CrateGen.none,
        filter: String = "lowpass",
        space: String = CrateGen.none,
        effects: [String] = []
    ) -> CrateGenPlan {
        CrateGenPlan(
            role: role, summary: "test", source: source, layer: layer,
            filter: filter, space: space, effects: effects
        )
    }

    /// Builds, then holds the result to the same bar a hand-made patch is
    /// held to: it validates, it flattens, and it makes a sound.
    private func assertPlays(
        _ patch: CratePatch,
        _ catalog: MaterialCatalog,
        role: CrateGen.Role,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let check = CratePatchCheck.validate(patch, catalog: catalog)
        XCTAssertEqual(check.errors, [], "generated patch does not validate", file: file, line: line)

        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "Generated")
        let voice = try CompiledVoice(document: compiled.graph)

        var peak = 0.0
        if role == .instrument {
            let pool = VoicePool(voice: voice, polyphony: compiled.polyphony ?? 1)
            pool.setParams(ParameterMap(compiled.params).defaults)
            pool.noteOn(note: 60, velocity: 1)
            var out = [Float](repeating: 0, count: 4096)
            out.withUnsafeMutableBufferPointer { buffer in
                _ = pool.render(sampleRate: 48_000, frames: buffer.count, outL: buffer.baseAddress!, outR: nil)
            }
            peak = out.reduce(0) { Swift.max($0, Double(abs($1))) }
        } else {
            let state = voice.makeState()
            state.setParams(ParameterMap(compiled.params).defaults)
            state.gate = true
            let frames = 4096
            var input = [Float](repeating: 0, count: frames)
            for index in 0..<frames {
                input[index] = Float(sin(2 * Double.pi * 220 * Double(index) / 48_000) * 0.4)
            }
            var out = [Float](repeating: 0, count: frames)
            var right: [Float]? = nil
            _ = voice.renderBlock(
                state, sampleRate: 48_000, output: &out,
                input: role == .insert ? input : nil, outputR: &right
            )
            peak = out.reduce(0) { Swift.max($0, Double(abs($1))) }
        }
        XCTAssertGreaterThan(peak, 0, "the generated patch renders silence", file: file, line: line)
    }

    // MARK: - Vocabulary

    func testEveryOfferedKindExistsAndRuns() throws {
        let catalog = try catalog()
        for role in CrateGen.Role.allCases {
            let vocabulary = CrateGenVocabulary(role: role, catalog: catalog)
            for kind in vocabulary.allKinds {
                XCTAssertNotNil(catalog.material(kind), "\(role) offers \(kind), which is not in the catalog")
                XCTAssertTrue(catalog.canCompile(kind), "\(role) offers \(kind), which this build cannot run")
            }
            XCTAssertFalse(vocabulary.filters.isEmpty, "\(role) has nothing to shape the tone with")
            XCTAssertTrue(vocabulary.spaces.contains(CrateGen.none), "a space must be refusable")
        }
    }

    /// The looper is the kind this build cannot compile. It must not reach a
    /// vocabulary, because a shortlist is a promise that the thing works.
    func testTheVocabularyExcludesWhatThisBuildCannotRun() throws {
        let catalog = try catalog()
        for role in CrateGen.Role.allCases {
            let vocabulary = CrateGenVocabulary(role: role, catalog: catalog)
            XCTAssertFalse(vocabulary.allKinds.contains("looper"))
            XCTAssertFalse(vocabulary.allKinds.contains("amp"), "a kernel is not offerable either")
        }
    }

    /// A generative patch offered `oscillator` would be a patch that renders
    /// silence: it is a keyboard voice and its gate never opens.
    func testGenerativeSourcesAreNotKeyboardVoices() throws {
        let catalog = try catalog()
        let vocabulary = CrateGenVocabulary(role: .generative, catalog: catalog)
        for kind in vocabulary.sources {
            let material = try XCTUnwrap(catalog.material(kind))
            XCTAssertFalse(
                material.inputs.contains("gate"),
                "\(kind) needs a gate, so a generative patch built on it is silent"
            )
        }
    }

    // MARK: - The three roles, end to end

    func testAGenerativePlanPlaysWithNobodyTouchingIt() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(.generative, source: "tone", filter: "lowpass", space: "reverb"),
            catalog: catalog
        )
        // No cables at all: this is the wiring pass failing completely, which
        // is the case the fallback exists for.
        XCTAssertFalse(built.patch.connections.isEmpty, "the fallback produced no signal path")
        try assertPlays(built.patch, catalog, role: .generative)
        XCTAssertFalse(
            built.patch.nodes.contains { $0.kind == catalog.io.keyboard },
            "a generative patch must not grow a keyboard"
        )
    }

    func testAnInstrumentPlanIsPlayable() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(.instrument, source: "oscillator", filter: "lowpass", space: "reverb"),
            catalog: catalog
        )
        let compiled = try CrateFlatten.flatten(built.patch, catalog: catalog, name: "Gen")
        XCTAssertEqual(compiled.role, "instrument", "the keyboard cables decide this, so they must exist")
        try assertPlays(built.patch, catalog, role: .instrument)
    }

    func testAnInsertPlanTreatsTheHostSignal() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(.insert, filter: "ladder", space: "delay", effects: ["compressor"]),
            catalog: catalog
        )
        let compiled = try CrateFlatten.flatten(built.patch, catalog: catalog, name: "Gen")
        XCTAssertEqual(compiled.role, "insert")
        XCTAssertEqual(compiled.ports, ["input"], "an insert has to read the host's audio")
        try assertPlays(built.patch, catalog, role: .insert)
    }

    // MARK: - The model being wrong

    func testCablesNamingJacksThatDoNotExistAreDropped() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(.generative, source: "tone", filter: "lowpass"),
            cables: [
                CrateGenCable(from: "source", fromJack: "audio", to: "filter", toJack: "input"),
                CrateGenCable(from: "filter", fromJack: "audio", to: "out", toJack: "input"),
                CrateGenCable(from: "out", fromJack: "audio", to: "master", toJack: "input"),
                // The three shapes of wrong: a jack that does not exist, a
                // node that does not exist, and a loop.
                CrateGenCable(from: "source", fromJack: "sparkle", to: "filter", toJack: "input"),
                CrateGenCable(from: "ghost", fromJack: "audio", to: "master", toJack: "input"),
                CrateGenCable(from: "filter", fromJack: "audio", to: "filter", toJack: "input"),
            ],
            catalog: catalog
        )
        XCTAssertEqual(built.notes.count, 3, "each bad cable should say why it went")
        try assertPlays(built.patch, catalog, role: .generative)
        XCTAssertFalse(
            built.patch.connections.contains { $0.sourceOutput == "sparkle" },
            "a jack the node does not have must not survive into the document"
        )
        XCTAssertFalse(built.patch.connections.contains { $0.source == $0.target })
    }

    func testAWiringThatMissesTheOutputIsRebuilt() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(.generative, source: "tone", filter: "lowpass"),
            lanes: [CrateGenLane(kind: .drift, rateHz: 0.4)],
            routes: [CrateGenRoute(lane: "lane1", target: "filter.cutoff")],
            cables: [
                // Plausible, and it never reaches Master. This is the failure
                // the fallback chain is the floor under.
                CrateGenCable(from: "source", fromJack: "audio", to: "filter", toJack: "input"),
            ],
            catalog: catalog
        )
        try assertPlays(built.patch, catalog, role: .generative)
        // The modulation is the point of the lane passes, so rebuilding the
        // signal path has to keep it.
        XCTAssertTrue(
            built.patch.connections.contains { $0.targetInput == "cutoff" && $0.source.hasPrefix("m1") },
            "rebuilding the audio path threw away the modulation, which is the half worth having"
        )
    }

    func testAPlanNamingModulesThatDoNotExistStillBuilds() throws {
        let catalog = try catalog()
        // The schema makes this impossible, so this is the belt under the
        // braces: a future vocabulary bug must not produce a broken patch.
        let built = CrateGenBuilder.assemble(
            plan: plan(.generative, source: "unobtainium", filter: "lowpass"),
            catalog: catalog
        )
        XCTAssertFalse(built.patch.nodes.contains { $0.kind == "unobtainium" })
        let check = CratePatchCheck.validate(built.patch, catalog: catalog)
        XCTAssertEqual(check.errors, [])
    }

    // MARK: - The numbers

    func testNumbersAreClampedIntoTheEar() throws {
        let catalog = try catalog()
        var wild = plan(.generative, source: "tone", filter: "lowpass", space: "reverb")
        // What a model asks for when it has not been told the ranges.
        wild.pitchHz = 9000
        wild.brightnessHz = 19500
        wild.spaceAmount = 1
        wild.level = 4
        let nodes = CrateGenBuilder.nodes(for: wild, catalog: catalog)

        let source = try XCTUnwrap(nodes.first { $0.id == "source" })
        XCTAssertLessThanOrEqual(try XCTUnwrap(source.params["freq"]), 700, "pitch stays in a musical register")
        XCTAssertLessThanOrEqual(try XCTUnwrap(source.params["gain"]), 0.6, "a stacked source sits low")

        let filter = try XCTUnwrap(nodes.first { $0.id == "filter" })
        XCTAssertLessThanOrEqual(try XCTUnwrap(filter.params["cutoff"]), 6000, "not the full 20 kHz travel")
        XCTAssertLessThanOrEqual(try XCTUnwrap(filter.params["q"]), 1.2)

        let space = try XCTUnwrap(nodes.first { $0.id == "space" })
        XCTAssertLessThanOrEqual(try XCTUnwrap(space.params["mix"]), 0.4, "a reverb at full mix is mud")
    }

    func testEveryParameterSetIsOneTheModuleDeclares() throws {
        let catalog = try catalog()
        for role in CrateGen.Role.allCases {
            let vocabulary = CrateGenVocabulary(role: role, catalog: catalog)
            for kind in vocabulary.allKinds {
                let built = CrateGenBuilder.nodes(
                    for: plan(role, source: kind, filter: "lowpass"), catalog: catalog
                )
                for node in built {
                    guard let material = catalog.material(node.kind) else { continue }
                    for (name, value) in node.params {
                        let descriptor = try XCTUnwrap(
                            material.param(name), "\(node.kind) has no parameter \(name)"
                        )
                        XCTAssertGreaterThanOrEqual(value, descriptor.min, "\(node.kind).\(name)")
                        XCTAssertLessThanOrEqual(value, descriptor.max, "\(node.kind).\(name)")
                    }
                }
            }
        }
    }

    /// The output always has a limiter in front of it, whatever the model
    /// asked for. Generated patches clip otherwise, and a person meeting the
    /// feature for the first time hears that as the feature being bad.
    func testALimiterAlwaysSitsBeforeTheOutput() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(.generative, source: "noise", filter: "bandpass"), catalog: catalog
        )
        let limiter = try XCTUnwrap(built.patch.nodes.first { $0.kind == "limiter" })
        let master = try XCTUnwrap(built.patch.nodes.first { $0.kind == catalog.io.master })
        XCTAssertTrue(
            built.patch.connections.contains { $0.source == limiter.id && $0.target == master.id },
            "the limiter has to be the last thing before Master, not just present"
        )
    }

    // MARK: - Every combination

    /// The real assurance: every source crossed with every filter and every
    /// space, built with no cables at all, has to produce a patch that
    /// validates, flattens and makes a sound. That is the floor the button
    /// stands on when the model's wiring is useless.
    func testEverySlotCombinationProducesAPatchThatPlays() throws {
        let catalog = try catalog()
        var built = 0
        for role in CrateGen.Role.allCases {
            let vocabulary = CrateGenVocabulary(role: role, catalog: catalog)
            let sources = vocabulary.sources.isEmpty ? [CrateGen.none] : vocabulary.sources
            for source in sources {
                for filter in vocabulary.filters {
                    for space in vocabulary.spaces {
                        let result = CrateGenBuilder.assemble(
                            plan: plan(role, source: source, filter: filter, space: space),
                            lanes: [CrateGenLane(kind: .drift, rateHz: 0.5)],
                            catalog: catalog
                        )
                        let check = CratePatchCheck.validate(result.patch, catalog: catalog)
                        XCTAssertEqual(
                            check.errors, [],
                            "\(role)/\(source)/\(filter)/\(space) does not validate"
                        )
                        XCTAssertNoThrow(
                            try CrateFlatten.flatten(result.patch, catalog: catalog, name: "Gen"),
                            "\(role)/\(source)/\(filter)/\(space) does not flatten"
                        )
                        built += 1
                    }
                }
            }
        }
        XCTAssertGreaterThan(built, 100, "the sweep covered almost nothing")
    }

    // MARK: - The wiring brief

    func testTheJackBriefIsSmallEnoughToAfford() throws {
        let catalog = try catalog()
        let nodes = CrateGenBuilder.nodes(
            for: plan(.generative, source: "tone", layer: "noise",
                      filter: "ladder", space: "reverb", effects: ["gain", "softclip"]),
            catalog: catalog
        )
        let brief = CrateGenBuilder.jackBrief(nodes, catalog: catalog)
        // The whole reason the wiring is a second session: this has to fit
        // beside its instructions, its schema and its reply inside 4,096
        // tokens. At three characters to a token, a 400 token brief would
        // already be a tenth of the window.
        let estimatedTokens = brief.count / 3
        XCTAssertLessThan(estimatedTokens, 250, "the jack brief is too big to send")
        for node in nodes {
            XCTAssertTrue(brief.contains(node.id), "\(node.id) is missing from the brief")
        }
    }

    func testTheWiringVocabularyCoversTheChosenNodes() throws {
        let catalog = try catalog()
        let nodes = CrateGenBuilder.nodes(
            for: plan(.generative, source: "tone", filter: "lowpass"), catalog: catalog
        )
        let outlets = CrateGenBuilder.outletVocabulary(nodes, catalog: catalog)
        let inlets = CrateGenBuilder.inletVocabulary(nodes, catalog: catalog)
        XCTAssertTrue(outlets.contains("audio"))
        XCTAssertTrue(inlets.contains("cutoff"))
        XCTAssertEqual(Set(outlets).count, outlets.count, "the vocabulary repeats itself")
    }

    // MARK: - Layout

    func testLayoutRunsLeftToRightBySignalDepth() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(.generative, source: "tone", filter: "lowpass", space: "reverb"),
            catalog: catalog
        )
        let source = try XCTUnwrap(built.patch.nodes.first { $0.id == "source" })
        let filter = try XCTUnwrap(built.patch.nodes.first { $0.id == "filter" })
        let master = try XCTUnwrap(built.patch.nodes.first { $0.id == "master" })
        XCTAssertLessThan(source.x, filter.x)
        XCTAssertLessThan(filter.x, master.x)
        XCTAssertTrue(built.patch.nodes.allSatisfy { $0.x >= 0 && $0.y >= 0 })
    }
}

// MARK: - Change mode

/// Editing an existing patch, which is somebody's work rather than a fresh
/// guess. The difference from generation runs through every test here: when
/// generation produces something unusable it is repaired, and when a change
/// would produce something unusable it is refused.
final class PatchEditingTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    private func patch(_ catalog: MaterialCatalog) -> CratePatch {
        CratePatch(
            nodes: [
                CratePatchNode(id: "line", kind: catalog.io.line, x: 40, y: 40),
                CratePatchNode(id: "lp", kind: "lowpass", x: 260, y: 40, params: ["cutoff": 900, "q": 0.9]),
                CratePatchNode(id: "master", kind: catalog.io.master, x: 480, y: 40),
            ],
            connections: [
                CratePatchConnection(source: "line", sourceOutput: "audio", target: "lp", targetInput: "input"),
                CratePatchConnection(source: "lp", sourceOutput: "audio", target: "master", targetInput: "input"),
            ]
        )
    }

    func testTheBriefIsSmallEnoughToSend() throws {
        let catalog = try catalog()
        // A patch shaped the way the editor makes one, rather than a row of
        // bare gains. `CratePatchModel.add(kind:)` writes every parameter at
        // its default, so a hand-built patch carries a dozen numbers per node,
        // and that is what makes the document expensive and the brief cheap:
        // the brief omits every value still sitting at its default.
        var real = CrateGenBuilder.assemble(
            plan: CrateGenPlan(
                role: .generative, summary: "test", source: "tone", layer: "noise",
                filter: "ladder", space: "reverb",
                effects: ["gain", "softclip", "compressor"]
            ),
            catalog: catalog
        ).patch
        real.nodes = real.nodes.map { node in
            var node = node
            if let material = catalog.material(node.kind) {
                for (name, descriptor) in material.params where node.params[name] == nil {
                    node.params[name] = descriptor.defaultValue
                }
            }
            return node
        }

        let brief = CratePatchEditor.brief(real, catalog: catalog)
        let asJSON = try String(data: real.encoded(), encoding: .utf8) ?? ""
        // The reason change mode sends this and not the document. Both have to
        // fit beside the instructions, the schema and the reply in 4,096
        // tokens, and only one of them does.
        XCTAssertLessThan(brief.count / 3, 400, "the brief is too big to afford")
        // Measured at about 3x on this patch. The floor is set at 2x rather
        // than at the measurement, because the ratio moves with how many
        // parameters the chosen modules happen to declare and a threshold
        // pinned to today's number would break on a patch that is no worse.
        XCTAssertLessThan(
            brief.count * 2, asJSON.count,
            "the brief (\(brief.count) chars) is not meaningfully smaller than the document (\(asJSON.count))"
        )
        for node in real.nodes {
            XCTAssertTrue(brief.contains(node.id), "\(node.id) is missing from the brief")
        }
    }

    func testTheBriefOmitsValuesLeftAtTheirDefault() throws {
        let catalog = try catalog()
        let lowpass = try XCTUnwrap(catalog.material("lowpass"))
        let defaultQ = try XCTUnwrap(lowpass.param("q")).defaultValue
        var edited = patch(catalog)
        edited.nodes[1].params = ["cutoff": 900, "q": defaultQ]

        let brief = CratePatchEditor.brief(edited, catalog: catalog)
        XCTAssertTrue(brief.contains("cutoff=900"), "a changed value has to survive")
        XCTAssertFalse(
            brief.contains("q="),
            "a value left at its default is not worth a token: the model can look it up"
        )
    }

    func testSetParamIsClampedNotRefused() throws {
        let catalog = try catalog()
        let result = CratePatchEditor.apply(
            [CrateGenEdit(op: .setParam, node: "lp", param: "cutoff", value: 900_000)],
            to: patch(catalog), catalog: catalog
        )
        XCTAssertEqual(result.applied, 1)
        let cutoff = try XCTUnwrap(result.patch.node("lp")?.params["cutoff"])
        XCTAssertEqual(cutoff, 20000, "out of range clamps to the declared maximum")
    }

    func testAddingAModuleKeepsExistingIdsAndPositions() throws {
        let catalog = try catalog()
        let before = patch(catalog)
        let result = CratePatchEditor.apply(
            [
                CrateGenEdit(op: .addModule, kind: "reverb"),
                CrateGenEdit(op: .disconnect, node: "lp", target: "master"),
                CrateGenEdit(op: .connect, node: "lp", jack: "audio", target: "reverb", targetJack: "input"),
                CrateGenEdit(op: .connect, node: "reverb", jack: "audio", target: "master", targetJack: "input"),
            ],
            to: before, catalog: catalog
        )
        XCTAssertEqual(result.applied, 4)
        // Rule 14 of the web skill, which is the whole reason change is edits
        // and not a regeneration: what the user already arranged stays where
        // they put it.
        for id in ["line", "lp", "master"] {
            let old = try XCTUnwrap(before.node(id))
            let new = try XCTUnwrap(result.patch.node(id))
            XCTAssertEqual(old.x, new.x, "\(id) moved")
            XCTAssertEqual(old.y, new.y, "\(id) moved")
        }
        XCTAssertNotNil(result.patch.node("reverb"))
        XCTAssertNoThrow(try CrateFlatten.flatten(result.patch, catalog: catalog, name: "Changed"))
    }

    func testAnEditSetThatWouldSilenceThePatchIsRefusedWhole() throws {
        let catalog = try catalog()
        let before = patch(catalog)
        let result = CratePatchEditor.apply(
            [
                CrateGenEdit(op: .setParam, node: "lp", param: "cutoff", value: 400),
                // And then the model cuts the output, which no change request
                // ever meant.
                CrateGenEdit(op: .disconnect, node: "lp", target: "master"),
            ],
            to: before, catalog: catalog
        )
        XCTAssertEqual(result.patch, before, "a change that silences the patch must change nothing")
        XCTAssertEqual(result.applied, 0)
        XCTAssertTrue(result.notes.contains { $0.contains("left as it was") })
        XCTAssertTrue(result.notes.contains { $0.contains("silent") })
    }

    func testRemovingTheHostToolIsRefused() throws {
        let catalog = try catalog()
        let result = CratePatchEditor.apply(
            [CrateGenEdit(op: .removeNode, node: "master")], to: patch(catalog), catalog: catalog
        )
        XCTAssertEqual(result.applied, 0)
        XCTAssertNotNil(result.patch.node("master"))
        XCTAssertTrue(result.notes.contains { $0.contains("disconnect the patch") })
    }

    func testNonsenseEditsAreReportedAndTheRestApply() throws {
        let catalog = try catalog()
        let result = CratePatchEditor.apply(
            [
                CrateGenEdit(op: .setParam, node: "lp", param: "sparkle", value: 1),
                CrateGenEdit(op: .connect, node: "lp", jack: "aura", target: "master", targetJack: "input"),
                CrateGenEdit(op: .addModule, kind: "unobtainium"),
                CrateGenEdit(op: .removeNode, node: "ghost"),
                CrateGenEdit(op: .setParam, node: "lp", param: "q", value: 1.1),
            ],
            to: patch(catalog), catalog: catalog
        )
        // Half sensible applies the sensible half, which is the point of
        // editing one operation at a time.
        XCTAssertEqual(result.applied, 1)
        XCTAssertEqual(result.notes.count, 4)
        XCTAssertEqual(result.patch.node("lp")?.params["q"], 1.1)
    }

    func testAddingTheSameKindTwiceMintsReadableIds() throws {
        let catalog = try catalog()
        let result = CratePatchEditor.apply(
            [
                CrateGenEdit(op: .addModule, kind: "delay"),
                CrateGenEdit(op: .addModule, kind: "delay"),
            ],
            to: patch(catalog), catalog: catalog
        )
        XCTAssertNotNil(result.patch.node("delay"))
        XCTAssertNotNil(result.patch.node("delay2"))
        XCTAssertEqual(Set(result.patch.nodes.map(\.id)).count, result.patch.nodes.count)
    }

    func testAKindThisBuildCannotRunIsNotAddable() throws {
        let catalog = try catalog()
        let result = CratePatchEditor.apply(
            [CrateGenEdit(op: .addModule, kind: "looper")], to: patch(catalog), catalog: catalog
        )
        XCTAssertEqual(result.applied, 0)
        XCTAssertNil(result.patch.node("looper"))
    }
}

// MARK: - Composition

/// The tests the first design did not have, and would have failed.
///
/// Every test in `PatchGenerationTests` passed while the generator was
/// emitting a straight line with a clock sitting beside it wired to nothing:
/// they checked that the patch was *valid*, and a chain is valid. Validity was
/// never the interesting property. These check that the patch is a
/// composition: that the control path exists, that it lands on the audio
/// path, and that nothing is on the canvas doing nothing.
final class PatchCompositionTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    private func plan() -> CrateGenPlan {
        CrateGenPlan(
            role: .generative, summary: "test", source: "tone", layer: "noise",
            filter: "lowpass", space: "reverb", effects: ["gain"]
        )
    }

    /// The regression, stated directly: a lane the model asked for has to end
    /// up moving something. This is what shipped broken.
    func testNoModuleIsLeftWiredToNothing() throws {
        let catalog = try catalog()
        for kind in CrateGenLaneKind.allCases {
            let built = CrateGenBuilder.assemble(
                plan: plan(),
                lanes: [CrateGenLane(kind: kind, rateHz: 1.5, depth: 0.5)],
                // No routes at all: the model answering the module question
                // and not the routing question, which is the common failure.
                catalog: catalog
            )
            let driven = Set(built.patch.connections.map(\.target))
            let feeding = Set(built.patch.connections.map(\.source))
            for node in built.patch.nodes where node.kind != catalog.io.master {
                XCTAssertTrue(
                    feeding.contains(node.id) || driven.contains(node.id),
                    "\(kind.rawValue): \(node.id) (\(node.kind)) is on the canvas wired to nothing"
                )
            }
            XCTAssertTrue(
                built.patch.connections.contains { $0.source.hasPrefix("m1") },
                "\(kind.rawValue): the lane drives nothing at all"
            )
        }
    }

    /// A lane has to land on a *parameter*, not be spliced into the audio
    /// chain. That distinction is the difference between a patch that moves
    /// and a patch with an extra module in the signal path.
    func testALaneLandsOnAParameter() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [CrateGenLane(kind: .drift, rateHz: 0.3, depth: 0.6)],
            routes: [CrateGenRoute(lane: "lane1", target: "filter.cutoff")],
            catalog: catalog
        )
        let cable = try XCTUnwrap(
            built.patch.connections.first { $0.source.hasPrefix("m1") },
            "no modulation cable"
        )
        XCTAssertEqual(cable.target, "filter")
        XCTAssertEqual(cable.targetInput, "cutoff")
        let filter = try XCTUnwrap(catalog.material("lowpass"))
        XCTAssertFalse(filter.isAudioInlet(cable.targetInput), "a lane must not join the audio path")
        // And it survives flattening as a `range` node, which is what a CV
        // cable becomes: proof the modulation reached the graph and not just
        // the document.
        let compiled = try CrateFlatten.flatten(built.patch, catalog: catalog, name: "Moved")
        XCTAssertFalse(
            compiled.params.keys.contains("filter_cutoff"),
            "a patched parameter stops being a knob, so its absence is the proof the cable took"
        )
    }

    /// Three lanes is three independent movements, not one clock reused.
    func testLanesAreIndependentAndKeepTheirRates() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [
                CrateGenLane(kind: .euclidean, rateHz: 6, depth: 0.7),
                CrateGenLane(kind: .drift, rateHz: 0.12, depth: 0.4),
                CrateGenLane(kind: .stepped, rateHz: 0.8, depth: 0.9),
            ],
            routes: [
                CrateGenRoute(lane: "lane1", target: "space.mix"),
                CrateGenRoute(lane: "lane2", target: "filter.cutoff"),
                CrateGenRoute(lane: "lane3", target: "fx1.gain"),
            ],
            catalog: catalog
        )
        for lane in 1...3 {
            XCTAssertTrue(
                built.patch.connections.contains { $0.source.hasPrefix("m\(lane)") },
                "lane \(lane) drives nothing"
            )
        }
        // Each lane's own clock, at its own rate. One shared clock would make
        // the patch repeat on a single bar, which is the thing that makes a
        // generative patch boring.
        let fast = try XCTUnwrap(built.patch.node("m1clk")?.params["freq"])
        let slow = try XCTUnwrap(built.patch.node("m2lfo")?.params["rate"])
        XCTAssertEqual(fast, 6, accuracy: 0.001)
        XCTAssertEqual(slow, 0.12, accuracy: 0.001)
        XCTAssertNotEqual(fast, slow)
    }

    /// A lane that is really several modules has to be wired up inside
    /// itself. A euclidean with no clock is a pattern that never advances.
    func testALaneWiresItsOwnModules() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [CrateGenLane(kind: .euclidean, rateHz: 4, depth: 0.5)],
            catalog: catalog
        )
        XCTAssertNotNil(built.patch.node("m1clk"), "a euclidean lane needs its clock")
        XCTAssertNotNil(built.patch.node("m1euc"))
        XCTAssertTrue(
            built.patch.connections.contains { $0.source == "m1clk" && $0.target == "m1euc" },
            "the clock does not advance the pattern"
        )
    }

    /// The rule the web skill states in a paragraph: a signal with no depth of
    /// its own, mapped onto a frequency jack's full range, is a siren.
    func testAFullScaleLaneIsKeptOffFrequencyJacks() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [CrateGenLane(kind: .stepped, rateHz: 2, depth: 1)],
            routes: [CrateGenRoute(lane: "lane1", target: "source.freq")],
            catalog: catalog
        )
        XCTAssertFalse(
            built.patch.connections.contains { $0.source.hasPrefix("m1") && $0.targetInput == "freq" },
            "a stepped random on a 20..4000 Hz jack is a siren, not a melody"
        )
        XCTAssertTrue(built.notes.contains { $0.contains("swings too wide") })
        // Refused, then re-pointed: the lane still moves something.
        XCTAssertTrue(built.patch.connections.contains { $0.source.hasPrefix("m1") })
    }

    /// An LFO carries its own depth, so the same jack is fine for it. Without
    /// this the rule above would just be "never modulate a filter", which
    /// would take away the best thing in the palette.
    func testALaneWithItsOwnDepthMayMoveAFilter() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [CrateGenLane(kind: .drift, rateHz: 0.5, depth: 0.4)],
            routes: [CrateGenRoute(lane: "lane1", target: "filter.cutoff")],
            catalog: catalog
        )
        XCTAssertTrue(
            built.patch.connections.contains { $0.source.hasPrefix("m1") && $0.targetInput == "cutoff" },
            "an LFO on a cutoff is the whole point"
        )
    }

    /// A follower is the one lane that reads the sound, so it needs an audio
    /// cable in as well as a control cable out.
    func testAFollowerIsFedFromTheAudioPath() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [CrateGenLane(kind: .follower, rateHz: 1, depth: 0.5)],
            routes: [CrateGenRoute(lane: "lane1", target: "space.mix")],
            catalog: catalog
        )
        let follower = try XCTUnwrap(built.patch.nodes.first { $0.kind == "envfollow" })
        XCTAssertTrue(
            built.patch.connections.contains { $0.target == follower.id && $0.targetInput == "input" },
            "a follower with no audio in follows nothing"
        )
        XCTAssertTrue(built.patch.connections.contains { $0.source == follower.id })
    }

    /// Control must not arrive at the output. It is not audio, and the web
    /// skill spends a rule on it.
    func testNoLaneReachesTheOutput() throws {
        let catalog = try catalog()
        for kind in CrateGenLaneKind.allCases {
            let built = CrateGenBuilder.assemble(
                plan: plan(),
                lanes: [CrateGenLane(kind: kind, rateHz: 2, depth: 0.6)],
                routes: [CrateGenRoute(lane: "lane1", target: "master.input")],
                catalog: catalog
            )
            let master = try XCTUnwrap(built.patch.nodes.first { $0.kind == catalog.io.master })
            for cable in built.patch.connections where cable.target == master.id {
                XCTAssertFalse(
                    cable.source.hasPrefix("m1"),
                    "\(kind.rawValue): control reached the output"
                )
            }
        }
    }

    /// Every lane kind, in every role, still has to produce a patch that
    /// validates, flattens and makes a sound. The composition must not have
    /// come at the cost of the floor.
    func testEveryLaneKindStillPlays() throws {
        let catalog = try catalog()
        for role in CrateGen.Role.allCases {
            let vocabulary = CrateGenVocabulary(role: role, catalog: catalog)
            let source = vocabulary.sources.first ?? CrateGen.none
            for kind in CrateGenLaneKind.allCases {
                let built = CrateGenBuilder.assemble(
                    plan: CrateGenPlan(
                        role: role, summary: "t", source: source,
                        filter: vocabulary.filters.first ?? "lowpass", space: "reverb"
                    ),
                    lanes: [CrateGenLane(kind: kind, rateHz: 1.5, depth: 0.5)],
                    catalog: catalog
                )
                let check = CratePatchCheck.validate(built.patch, catalog: catalog)
                XCTAssertEqual(check.errors, [], "\(role)/\(kind.rawValue) does not validate")
                let compiled = try CrateFlatten.flatten(built.patch, catalog: catalog, name: "L")
                XCTAssertNoThrow(try CompiledVoice(document: compiled.graph), "\(role)/\(kind.rawValue)")
            }
        }
    }
}

// MARK: - Signal types

/// What a lane is allowed to send where.
///
/// The second thing that shipped wrong, and it was one category error: every
/// lane output was treated as interchangeable modulation. An event signal and
/// a control signal are not interchangeable. A clock is a one-sample impulse,
/// so mapped onto a gain it leaves the gain at its minimum except for the
/// single sample of the tick, and the patch is silent between ticks. It was
/// also being wired straight into an envelope's gate, which barely opens
/// before it shuts.
///
/// The fix is structural rather than a rule: every lane ends in a continuous
/// signal, and the event lanes shape their own trigger to get there. These
/// tests are what makes that structural claim checkable.
final class PatchSignalTypeTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    private func patches(_ catalog: MaterialCatalog) -> [(CrateGenLaneKind, CratePatch)] {
        CrateGenLaneKind.allCases.map { kind in
            (
                kind,
                CrateGenBuilder.assemble(
                    plan: CrateGenPlan(
                        role: .generative, summary: "t", source: "comb", layer: "tone",
                        filter: "lowpass", space: "reverb", effects: ["gain"]
                    ),
                    lanes: [CrateGenLane(kind: kind, rateHz: 3, depth: 0.6)],
                    catalog: catalog
                ).patch
            )
        }
    }

    /// The headline: nothing a lane emits may arrive at an audio inlet.
    /// Control is not sound, and a control signal summed into an audio port is
    /// a click track in the mix.
    func testNoLaneOutputReachesAnAudioInlet() throws {
        let catalog = try catalog()
        for (kind, patch) in patches(catalog) {
            for cable in patch.connections where cable.source.hasPrefix("m1") {
                guard let target = patch.node(cable.target) else { continue }
                // Inside the lane, a control chain's own `input` is where the
                // trigger belongs, so only cables leaving the lane are judged.
                if target.id.hasPrefix("m1") { continue }
                guard let material = catalog.material(target.kind) else { continue }
                XCTAssertFalse(
                    material.isAudioInlet(cable.targetInput),
                    "\(kind.rawValue): \(cable.source) reaches the audio inlet \(cable.target).\(cable.targetInput)"
                )
            }
        }
    }

    /// A clock is an event, and events belong inside the lane that made them.
    func testAClockNeverLeavesItsOwnLane() throws {
        let catalog = try catalog()
        for (kind, patch) in patches(catalog) {
            let clocks = patch.nodes.filter { $0.kind == "clock" }.map(\.id)
            for cable in patch.connections where clocks.contains(cable.source) {
                XCTAssertTrue(
                    cable.target.hasPrefix("m1"),
                    "\(kind.rawValue): a clock drives \(cable.target).\(cable.targetInput) outside its lane"
                )
            }
        }
    }

    /// A gate has to stay open long enough for an envelope to leave its
    /// attack, so it is fed by a pulse with a width and never by a bare clock.
    func testAGateIsFedByAPulseAndNotAClock() throws {
        let catalog = try catalog()
        for (kind, patch) in patches(catalog) {
            for cable in patch.connections where cable.targetInput == "gate" {
                let source = try XCTUnwrap(patch.node(cable.source))
                XCTAssertEqual(
                    source.kind, "pulse",
                    "\(kind.rawValue): \(source.kind) drives a gate directly, so it opens for one sample"
                )
                let width = try XCTUnwrap(source.params["widthSec"])
                XCTAssertGreaterThan(width, 0, "a gate of zero width never opens")
            }
        }
    }

    /// Whatever the lane is made of, what leaves it is continuous.
    func testWhatLeavesALaneIsContinuous() throws {
        let catalog = try catalog()
        // The event modules: sparse, and not a control voltage.
        let eventKinds: Set<String> = ["clock", "pulse", "euclidean", "trigger", "syncedclock"]
        for (kind, patch) in patches(catalog) {
            let leaving = patch.connections.filter { $0.source.hasPrefix("m1") && !$0.target.hasPrefix("m1") }
            XCTAssertFalse(leaving.isEmpty, "\(kind.rawValue): the lane drives nothing")
            for cable in leaving {
                let source = try XCTUnwrap(patch.node(cable.source))
                XCTAssertFalse(
                    eventKinds.contains(source.kind),
                    "\(kind.rawValue): \(source.kind) leaves the lane, and it is an event rather than a level"
                )
            }
        }
    }

    /// A rhythmic lane lands where a repeated shape is audible, not on a
    /// reverb's damping. Checked as "somewhere in its own preference list"
    /// rather than against one fixed answer, so the table can be retuned
    /// without rewriting the test.
    func testALaneLandsSomewhereItWouldBeHeard() throws {
        let catalog = try catalog()
        for (kind, patch) in patches(catalog) {
            let leaving = patch.connections.filter { $0.source.hasPrefix("m1") && !$0.target.hasPrefix("m1") }
            for cable in leaving {
                XCTAssertTrue(
                    kind.preferredParams.contains(cable.targetInput),
                    "\(kind.rawValue) landed on \(cable.targetInput), which is not in what it is for"
                )
            }
        }
    }

    /// And the whole thing still plays, which is what all of it is for.
    func testEveryLaneStillMakesASound() throws {
        let catalog = try catalog()
        for (kind, patch) in patches(catalog) {
            let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "L")
            let voice = try CompiledVoice(document: compiled.graph)
            let state = voice.makeState()
            state.setParams(ParameterMap(compiled.params).defaults)
            state.gate = true
            var out = [Float](repeating: 0, count: 24_000)
            var right: [Float]? = nil
            _ = voice.renderBlock(state, sampleRate: 48_000, output: &out, outputR: &right)
            let peak = out.reduce(0) { Swift.max($0, Double(abs($1))) }
            XCTAssertGreaterThan(peak, 0, "\(kind.rawValue): renders silence over half a second")
        }
    }
}
