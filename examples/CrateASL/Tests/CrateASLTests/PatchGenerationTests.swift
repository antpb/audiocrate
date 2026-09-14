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
            // A voice waits on an in-graph pulse. 4096 frames is 85 ms and
            // misses a 4 Hz envelope. One second covers the first hit.
            let frames = 48_000
            var input = [Float](repeating: 0, count: frames)
            for index in 0..<frames {
                input[index] = Float(sin(2 * Double.pi * 220 * Double(index) / 48_000) * 0.4)
            }
            var out = [Float](repeating: 0, count: frames)
            var right: [Float]? = nil
            _ = voice.renderBlock(
                state, sampleRate: 48_000, output: &out,
                input: role == .insert ? input : nil, outputR: &right,
                transport: TransportSnapshot(playing: true)
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

    /// Generative sources are the same voices an instrument uses. Swift
    /// cables a notes lane and an envelope so they play without a keyboard.
    func testGenerativeSourcesAreVoicesThatDriveThemselves() throws {
        let catalog = try catalog()
        let vocabulary = CrateGenVocabulary(role: .generative, catalog: catalog)
        XCTAssertTrue(vocabulary.sources.contains("oscillator") || vocabulary.sources.contains("SynthVoice"))
        XCTAssertFalse(vocabulary.sources.contains("tone"), "a free-running tone is a layer, not the lead")

        let built = CrateGenBuilder.assemble(
            plan: plan(.generative, source: "oscillator", filter: "lowpass"),
            catalog: catalog
        )
        XCTAssertFalse(
            built.patch.nodes.contains { $0.kind == catalog.io.keyboard },
            "a generative patch must not grow a keyboard"
        )
        XCTAssertTrue(
            built.patch.connections.contains { $0.target == "source" && $0.targetInput == "note" },
            "a voice has to receive notes or it sits on one pitch, or is silent"
        )
        XCTAssertTrue(
            built.patch.connections.contains { $0.target == "source" && ($0.targetInput == "gain" || $0.targetInput == "velocity") },
            "an envelope has to open the voice or it is a drone"
        )
        let compiled = try CrateFlatten.flatten(built.patch, catalog: catalog, name: "Gen")
        XCTAssertEqual(compiled.role, "insert", "graph-driven notes must not turn this into an instrument AU")
        try assertPlays(built.patch, catalog, role: .generative)
    }

    /// A free-running clock ignores the song. Synced Clock and a Play gate
    /// do not: Stop has to silence the patch, and Play has to start it.
    func testAGenerativePatchFollowsTheSongTransport() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(.generative, source: "oscillator", filter: "lowpass"),
            catalog: catalog
        )
        XCTAssertNotNil(built.patch.nodes.first { $0.kind == catalog.io.transport })
        XCTAssertTrue(
            built.patch.connections.contains { $0.sourceOutput == "playing" && $0.targetInput == "gain" },
            "Play has to open the output or a tone keeps humming after Stop"
        )
        XCTAssertTrue(
            built.patch.nodes.contains { $0.kind == "syncedclock" },
            "rhythmic lanes have to lock to the song, not a free-running Hz clock"
        )

        let compiled = try CrateFlatten.flatten(built.patch, catalog: catalog, name: "Gen")
        let voice = try CompiledVoice(document: compiled.graph)
        let frames = 48_000
        func peak(playing: Bool) -> Double {
            let state = voice.makeState()
            state.setParams(ParameterMap(compiled.params).defaults)
            state.gate = true
            var out = [Float](repeating: 0, count: frames)
            var right: [Float]? = nil
            _ = voice.renderBlock(
                state, sampleRate: 48_000, output: &out, outputR: &right,
                transport: TransportSnapshot(playing: playing)
            )
            return out.reduce(0) { Swift.max($0, Double(abs($1))) }
        }
        XCTAssertEqual(peak(playing: false), 0, "the patch must sit still when the song is stopped")
        XCTAssertGreaterThan(peak(playing: true), 0, "Play has to start the patch")
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
        // The cable that *leaves* the lane. A lane's own scaling stages are
        // in the lane, wired into each other's audio inlets, and it is what
        // comes out the far end that has to land on a parameter.
        let cable = try XCTUnwrap(
            built.patch.connections.first {
                CrateGenBuilder.isLaneId($0.source) && !CrateGenBuilder.isLaneId($0.target)
            },
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
        XCTAssertEqual(built.patch.node("m1clk")?.kind, "syncedclock")
        let division = try XCTUnwrap(built.patch.node("m1clk")?.params["division"])
        XCTAssertEqual(division, CrateGenBuilder.songDivision(rateHz: 6), accuracy: 0.001)
        let slow = try XCTUnwrap(built.patch.node("m2lfo")?.params["rate"])
        XCTAssertEqual(slow, 0.12, accuracy: 0.001)
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

    /// An LFO on frequency is a car alarm: flatten maps even a shallow
    /// amount onto the whole 20..4000 Hz span. Cutoff is the jack it may
    /// sweep. Pitch changes belong to the notes lane.
    func testAContinuousLaneIsKeptOffPitch() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [CrateGenLane(kind: .drift, rateHz: 0.5, depth: 0.4)],
            routes: [CrateGenRoute(lane: "lane1", target: "source.freq")],
            catalog: catalog
        )
        XCTAssertFalse(
            built.patch.connections.contains { $0.source.hasPrefix("m1") && $0.targetInput == "freq" },
            "an LFO on a tone's freq is a siren"
        )
        XCTAssertTrue(built.notes.contains { $0.contains("sweep pitch") })
        XCTAssertTrue(built.patch.connections.contains { $0.source.hasPrefix("m1") })
    }

    /// Held steps through a scale are how pitch is allowed to move.
    func testANotesLaneMayMovePitch() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [CrateGenLane(kind: .notes, rateHz: 2, depth: 0.6)],
            routes: [CrateGenRoute(lane: "lane1", target: "source.freq")],
            catalog: catalog
        )
        XCTAssertNotNil(built.patch.nodes.first { $0.kind == "samplehold" || $0.kind == "sequencer" })
        XCTAssertTrue(
            built.patch.connections.contains { $0.source.hasPrefix("m1") && $0.targetInput == "freq" },
            "a notes lane is the one that may change pitch"
        )
        if let seq = built.patch.nodes.first(where: { $0.kind == "sequencer" }) {
            XCTAssertTrue(
                built.patch.connections.contains {
                    $0.target == seq.id && $0.targetInput == "clock"
                },
                "a sequencer advances on clock, not on an audio inlet"
            )
            XCTAssertFalse(
                built.patch.connections.contains {
                    $0.target == seq.id && $0.targetInput == "input"
                }
            )
        }
    }

    /// A notes lane on a voice lands on `note`, which flatten reads as MIDI,
    /// not as a Hz sweep.
    func testANotesLaneDrivesAVoiceNote() throws {
        let catalog = try catalog()
        let built = CrateGenBuilder.assemble(
            plan: CrateGenPlan(
                role: .generative, summary: "test", source: "oscillator",
                filter: "lowpass"
            ),
            lanes: [CrateGenLane(kind: .notes, rateHz: 4, depth: 0.6)],
            routes: [CrateGenRoute(lane: "lane1", target: "source.note")],
            catalog: catalog
        )
        XCTAssertTrue(
            built.patch.connections.contains { $0.source.hasPrefix("m1") && $0.targetInput == "note" },
            "a notes lane on a voice writes MIDI notes, not a tone frequency"
        )
    }

    /// An LFO carries its own depth, so a filter cutoff is fine for it. Without
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
            let clocks = patch.nodes.filter { $0.kind == "clock" || $0.kind == "syncedclock" }.map(\.id)
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
            _ = voice.renderBlock(
                state, sampleRate: 48_000, output: &out, outputR: &right,
                transport: TransportSnapshot(playing: true)
            )
            let peak = out.reduce(0) { Swift.max($0, Double(abs($1))) }
            XCTAssertGreaterThan(peak, 0, "\(kind.rawValue): renders silence over half a second")
        }
    }
}

// MARK: - Trim

/// What a lane is allowed to do to the value the plan chose.
///
/// The third thing that shipped wrong, and the one that was invisible from
/// the patch: every cable was correct, every lane validated and flattened and
/// rendered, and the patch was still not the patch that had been planned. A
/// cable into a parameter does not modulate it, it replaces it, mapped across
/// the parameter's whole declared range. So a lane pointed at a lowpass
/// planned at 1800 Hz re-centred it on 10 kHz and the filter stopped
/// filtering, and a lane pointed at a gain planned at 0.2 swung it to 4.
///
/// Measured rather than argued: the first version of this suite passed while
/// that was happening, because it asked whether the cables were legal and
/// never what the numbers on either end of them were.
final class PatchTrimTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    private func plan() -> CrateGenPlan {
        CrateGenPlan(
            role: .generative, summary: "t", source: "comb", layer: "tone",
            filter: "lowpass", space: "reverb", effects: ["gain"]
        )
    }

    private func patch(_ kind: CrateGenLaneKind, depth: Double = 0.6, catalog: MaterialCatalog) -> CratePatch {
        CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [CrateGenLane(kind: kind, rateHz: 3, depth: depth)],
            catalog: catalog
        ).patch
    }

    /// What a route actually delivers to the parameter at its far end.
    ///
    /// Walks the cable back through however many trim stages it passes
    /// through, applies each one to the lane's declared swing, and maps the
    /// result the way `flattenPatch` maps it.
    private func delivered(
        _ cable: CratePatchConnection,
        in patch: CratePatch,
        lane: CrateGenLane,
        catalog: MaterialCatalog
    ) -> (lo: Double, hi: Double, descriptor: CrateParamDescriptor)? {
        guard let target = patch.node(cable.target),
              let descriptor = catalog.material(target.kind)?.param(cable.targetInput)
        else { return nil }

        var stages = [CratePatchNode]()
        var id = cable.source
        while let node = patch.node(id), node.kind == "gain" || node.kind == "offset",
              CrateGenBuilder.isLaneId(node.id) {
            stages.append(node)
            guard let upstream = patch.connections.first(where: {
                $0.target == node.id && $0.targetInput == "input"
            }) else { return nil }
            id = upstream.source
        }

        var (lo, hi) = lane.kind.swing(depth: lane.depth)
        for node in stages.reversed() {
            let amount = node.kind == "gain" ? (node.params["gain"] ?? 1) : (node.params["amount"] ?? 0)
            if node.kind == "gain" {
                (lo, hi) = (lo * amount, hi * amount)
            } else {
                (lo, hi) = (lo + amount, hi + amount)
            }
        }
        // The wire reads -1..1, and anything past that is clipped by the
        // parameter's own bounds rather than wrapping.
        func value(_ wire: Double) -> Double {
            let clamped = Swift.min(1, Swift.max(-1, wire))
            return descriptor.min + (clamped + 1) / 2 * (descriptor.max - descriptor.min)
        }
        return (value(lo), value(hi), descriptor)
    }

    private func leaving(_ patch: CratePatch) -> [CratePatchConnection] {
        patch.connections.filter {
            CrateGenBuilder.isLaneId($0.source) && !CrateGenBuilder.isLaneId($0.target)
        }
    }

    /// The headline. A lane moves the parameter around where the plan put it,
    /// rather than replacing it with the middle of its own travel.
    func testALaneMovesTheValueThePlanChose() throws {
        let catalog = try catalog()
        for kind in CrateGenLaneKind.allCases {
            let lane = CrateGenLane(kind: kind, rateHz: 3, depth: 0.6)
            let patch = patch(kind, catalog: catalog)
            let routes = leaving(patch)
            XCTAssertFalse(routes.isEmpty, "\(kind.rawValue): the lane drives nothing")
            for cable in routes {
                guard let reach = delivered(cable, in: patch, lane: lane, catalog: catalog) else {
                    XCTFail("\(kind.rawValue): could not follow \(cable.source) back to its lane")
                    continue
                }
                let node = try XCTUnwrap(patch.node(cable.target))
                let planned = node.params[cable.targetInput] ?? reach.descriptor.defaultValue
                let span = reach.descriptor.max - reach.descriptor.min
                let where_ = "\(kind.rawValue) on \(cable.target).\(cable.targetInput)"

                // Inside the parameter's own bounds, and a slice of them
                // rather than all of them. Half is generous: what it is
                // ruling out is the whole travel, which is the siren.
                XCTAssertGreaterThanOrEqual(reach.lo, reach.descriptor.min - 1e-6, where_)
                XCTAssertLessThanOrEqual(reach.hi, reach.descriptor.max + 1e-6, where_)
                XCTAssertLessThan(
                    reach.hi - reach.lo, span * 0.9,
                    "\(where_) sweeps almost the whole range, which is what trimming exists to stop"
                )

                // And it goes where the plan pointed. A lane that rests at
                // zero opens up to the planned value; one that swings around
                // zero straddles it.
                XCTAssertGreaterThanOrEqual(planned, reach.lo - span * 0.02, "\(where_) never reaches down to \(planned)")
                XCTAssertLessThanOrEqual(planned, reach.hi + span * 0.02, "\(where_) never reaches up to \(planned)")
            }
        }
    }

    /// Every lane's declared swing is the swing it actually renders.
    ///
    /// `swing(depth:)` is a table of claims about modules, and the scaling is
    /// arithmetic on those claims, so a wrong entry is silent: the patch is
    /// still legal and still plays, it just moves the wrong part of its
    /// window. Two entries were wrong when this was written, and this is what
    /// found them.
    func testALaneDeclaresTheSwingItActuallyProduces() throws {
        let catalog = try catalog()
        let depth = 0.6
        for kind in CrateGenLaneKind.allCases {
            guard let lane = CrateGenBuilder.laneNodes(
                CrateGenLane(kind: kind, rateHz: 3, depth: depth), index: 0, catalog: catalog
            ) else {
                XCTFail("\(kind.rawValue) could not be built")
                continue
            }
            var patch = CratePatch(nodes: lane.nodes, connections: lane.cables)
            patch.nodes.append(CratePatchNode(id: "master", kind: catalog.io.master, params: [:]))
            // The follower reads the sound, so it needs one to read.
            if kind == .follower, let inlet = catalog.material("envfollow")?.audioInputs.first {
                patch.nodes.append(CratePatchNode(id: "src", kind: "tone", params: ["freq": 220, "gain": 1]))
                patch.connections.append(CratePatchConnection(
                    source: "src", sourceOutput: "audio", target: lane.outlet.node, targetInput: inlet
                ))
            }
            patch.connections.append(CratePatchConnection(
                source: lane.outlet.node, sourceOutput: lane.outlet.jack,
                target: "master", targetInput: "input"
            ))

            let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "L")
            let voice = try CompiledVoice(document: compiled.graph)
            let state = voice.makeState()
            state.setParams(ParameterMap(compiled.params).defaults)
            state.gate = true
            var out = [Float](repeating: 0, count: 192_000)
            var right: [Float]? = nil
            _ = voice.renderBlock(
                state, sampleRate: 48_000, output: &out, outputR: &right,
                transport: TransportSnapshot(playing: true)
            )
            let low = out.reduce(Double.infinity) { Swift.min($0, Double($1)) }
            let high = out.reduce(-Double.infinity) { Swift.max($0, Double($1)) }
            let declared = kind.swing(depth: depth)

            // Contained, with a little room: an interpolated random
            // overshoots its own corners, and an envelope at a given rate may
            // not have time to reach full height.
            XCTAssertGreaterThanOrEqual(low, declared.lo - 0.15, "\(kind.rawValue) goes lower than it says")
            XCTAssertLessThanOrEqual(high, declared.hi + 0.15, "\(kind.rawValue) goes higher than it says")
            // And not so much smaller that the declaration is wasting most of
            // the window it asks for.
            XCTAssertGreaterThan(
                high - low, (declared.hi - declared.lo) * 0.45,
                "\(kind.rawValue) swings \(high - low) but declares \(declared.hi - declared.lo)"
            )
        }
    }

    /// A trim stage is part of a lane, so it is fed by one and it is never
    /// offered as somewhere to patch.
    func testATrimStageBelongsToItsLane() throws {
        let catalog = try catalog()
        for kind in CrateGenLaneKind.allCases {
            let patch = patch(kind, catalog: catalog)
            let trims = patch.nodes.filter {
                CrateGenBuilder.isLaneId($0.id) && ($0.kind == "gain" || $0.kind == "offset")
            }
            let targets = Set(CrateGenBuilder.routingTargets(patch.nodes, catalog: catalog, limit: .max))
            for trim in trims {
                XCTAssertTrue(
                    patch.connections.contains { $0.target == trim.id && $0.targetInput == "input" },
                    "\(kind.rawValue): \(trim.id) is scaling nothing"
                )
                XCTAssertTrue(
                    patch.connections.contains { $0.source == trim.id },
                    "\(kind.rawValue): \(trim.id) feeds nothing"
                )
                for target in targets {
                    XCTAssertFalse(
                        target.hasPrefix("\(trim.id)."),
                        "\(kind.rawValue): \(target) was offered as a destination, and it is a lane's own scaling"
                    )
                }
            }
        }
    }

    /// A rhythmic lane on an amplitude is a VCA: it opens to the level the
    /// plan chose and closes to nothing. Anything else and the rhythm reads
    /// as the patch getting louder rather than as a rhythm.
    func testARhythmicLaneOnAnAmplitudeOpensToThePlannedLevel() throws {
        let catalog = try catalog()
        for kind in [CrateGenLaneKind.pulse, .euclidean, .envelope] {
            let lane = CrateGenLane(kind: kind, rateHz: 3, depth: 0.6)
            let patch = patch(kind, catalog: catalog)
            for cable in leaving(patch) where cable.targetInput == "gain" {
                let reach = try XCTUnwrap(delivered(cable, in: patch, lane: lane, catalog: catalog))
                let node = try XCTUnwrap(patch.node(cable.target))
                let planned = node.params["gain"] ?? reach.descriptor.defaultValue
                XCTAssertEqual(reach.lo, reach.descriptor.min, accuracy: 1e-6, "\(kind.rawValue) never closes")
                XCTAssertEqual(reach.hi, planned, accuracy: 1e-3, "\(kind.rawValue) opens past the planned level")
            }
        }
    }

    /// A cable the model drew itself is scaled the same way a route is.
    ///
    /// The wiring pass invites it to send control at a named inlet, so it is
    /// a second door into the same parameter and it has to be the same door.
    func testACableFromALaneIsScaledLikeARoute() throws {
        let catalog = try catalog()
        let lane = CrateGenLane(kind: .drift, rateHz: 2, depth: 0.6)
        let built = CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [lane],
            cables: [
                CrateGenCable(from: "m1lfo", fromJack: "cv", to: "filter", toJack: "cutoff")
            ],
            catalog: catalog
        )
        let cable = try XCTUnwrap(
            leaving(built.patch).first { $0.target == "filter" && $0.targetInput == "cutoff" },
            "the cable did not survive"
        )
        XCTAssertNotEqual(cable.source, "m1lfo", "the lane reached the parameter without being scaled")
        let reach = try XCTUnwrap(delivered(cable, in: built.patch, lane: lane, catalog: catalog))
        let planned = try XCTUnwrap(built.patch.node("filter")?.params["cutoff"])
        XCTAssertGreaterThanOrEqual(planned, reach.lo)
        XCTAssertLessThanOrEqual(planned, reach.hi)
        XCTAssertLessThan(
            reach.hi - reach.lo, (reach.descriptor.max - reach.descriptor.min) * 0.9,
            "a cable the model drew sweeps the whole range"
        )
    }

    /// The patch still plays with the scaling in it, and it plays at roughly
    /// the level the patch without any lanes plays at. The defect this fixes
    /// was audible as a twenty-fold jump in level, so the level is the check.
    func testALaneDoesNotChangeHowLoudThePatchIs() throws {
        let catalog = try catalog()
        func peak(_ patch: CratePatch) throws -> Double {
            let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "L")
            let voice = try CompiledVoice(document: compiled.graph)
            let state = voice.makeState()
            state.setParams(ParameterMap(compiled.params).defaults)
            state.gate = true
            var out = [Float](repeating: 0, count: 96_000)
            var right: [Float]? = nil
            _ = voice.renderBlock(
                state, sampleRate: 48_000, output: &out, outputR: &right,
                transport: TransportSnapshot(playing: true)
            )
            return out.reduce(0) { Swift.max($0, Double(abs($1))) }
        }
        let bare = try peak(CrateGenBuilder.assemble(plan: plan(), lanes: [], catalog: catalog).patch)
        XCTAssertGreaterThan(bare, 0, "the patch with no lanes is silent")
        for kind in CrateGenLaneKind.allCases {
            let moved = try peak(patch(kind, catalog: catalog))
            XCTAssertGreaterThan(moved, 0, "\(kind.rawValue): renders silence")
            XCTAssertLessThan(
                moved, bare * 3,
                "\(kind.rawValue) peaks at \(moved) against \(bare) with no lane, so it is rewriting the level"
            )
        }
    }
}

// MARK: - Starting with the song

/// Whether a generated patch plays the same pattern every time Play is
/// pressed.
///
/// The defect these exist for is not audible in one render, which is why it
/// survived everything above. A clock is a free-running phase and a euclidean
/// is a step counter, and neither has any relationship to the song: press
/// Stop halfway through a bar and press Play again, and the pattern comes
/// back rotated by however far it had got. A synced clock does not fix it,
/// because the clock was never the part that was drifting. The step counter
/// under it was.
final class PatchSongResetTests: XCTestCase {

    private func catalog() throws -> MaterialCatalog { try MaterialCatalog.bundled() }

    private func plan() -> CrateGenPlan {
        CrateGenPlan(
            role: .generative, summary: "t", source: "comb", layer: "tone",
            filter: "lowpass", space: "reverb", effects: ["gain"]
        )
    }

    private func built(_ kind: CrateGenLaneKind, catalog: MaterialCatalog) -> CratePatch {
        CrateGenBuilder.assemble(
            plan: plan(),
            lanes: [CrateGenLane(kind: kind, rateHz: 3, depth: 0.6)],
            catalog: catalog
        ).patch
    }

    /// Renders `beats` of song from wherever the voice currently is.
    private func play(
        _ voice: CompiledVoice,
        _ state: VoiceState,
        from beats: Double,
        seconds: Double,
        playing: Bool = true
    ) -> [Float] {
        var out = [Float](repeating: 0, count: Int(48_000 * seconds))
        var right: [Float]? = nil
        _ = voice.renderBlock(
            state, sampleRate: 48_000, output: &out, outputR: &right,
            transport: TransportSnapshot(beats: beats, bpm: 120, playing: playing)
        )
        return out
    }

    /// Every clock and every pattern in a generated patch is reset by Play.
    func testPlayResetsEveryPatternInThePatch() throws {
        let catalog = try catalog()
        for kind in CrateGenLaneKind.allCases {
            let patch = built(kind, catalog: catalog)
            let song = try XCTUnwrap(patch.nodes.first { $0.kind == catalog.io.transport })
            for node in patch.nodes where catalog.jacks(node.kind)?.inputs.contains("reset") == true {
                let cable = patch.connections.first {
                    $0.target == node.id && $0.targetInput == "reset"
                }
                let found = try XCTUnwrap(
                    cable, "\(kind.rawValue): \(node.id) (\(node.kind)) has no reset, so it starts wherever it likes"
                )
                XCTAssertEqual(found.source, song.id)
                XCTAssertEqual(found.sourceOutput, "playing")
            }
        }
    }

    /// And it is one edge, not a level. A reset held high is a pattern pinned
    /// at step zero, which is silence with a tick in it.
    func testHoldingPlayDoesNotPinThePatternAtStepZero() throws {
        let catalog = try catalog()
        let patch = built(.euclidean, catalog: catalog)
        let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "R")
        let voice = try CompiledVoice(document: compiled.graph)
        let state = voice.makeState()
        state.setParams(ParameterMap(compiled.params).defaults)
        state.gate = true
        let out = play(voice, state, from: 0, seconds: 4)
        let peak = out.reduce(0) { Swift.max($0, Double(abs($1))) }
        XCTAssertGreaterThan(peak, 0, "a patch with Play held high renders silence")
    }

    /// The headline, and the thing a person actually hears: two presses of
    /// Play from the top of the song play the same pattern.
    ///
    /// Only the lanes that carry a position in a pattern are asserted, which
    /// is the honest scope. A pulse lane is a synced clock into an envelope
    /// and a synced clock has no state at all, being read off the song
    /// position, so it starts with the song whether anybody resets it or not.
    /// A euclidean and a sequencer are counters, and they are what comes back
    /// rotated.
    ///
    /// Measured on the lane's own control signal rather than on the patch's
    /// audio: a reverb and a delay carry the first pass into the second, so
    /// comparing the audio would be comparing tails.
    ///
    /// Rendered on one voice, so the second pass starts with every counter
    /// exactly where the first left it, which is the state a plugin is in
    /// when somebody presses Stop and then Play.
    func testTwoPressesOfPlayGiveTheSamePattern() throws {
        let catalog = try catalog()
        for kind in [CrateGenLaneKind.euclidean, .notes] {
            let patch = try listeningToTheLane(built(kind, catalog: catalog), catalog: catalog)
            let compiled = try CrateFlatten.flatten(patch, catalog: catalog, name: "R")
            let voice = try CompiledVoice(document: compiled.graph)
            let state = voice.makeState()
            state.setParams(ParameterMap(compiled.params).defaults)
            state.gate = true

            let first = play(voice, state, from: 0, seconds: 2)
            // Deliberately not a whole number of pattern cycles, and that is
            // the whole test. Stop on a bar line and a counter is back at zero
            // by arithmetic rather than by resetting, so a run that happens to
            // divide evenly proves nothing: the first version of this stopped
            // at two beats and passed with the reset removed.
            _ = play(voice, state, from: 4, seconds: 1.37)
            // Stopped, which is what a host sends between the two presses.
            _ = play(voice, state, from: 6.7, seconds: 0.25, playing: false)
            let second = play(voice, state, from: 0, seconds: 2)

            // After a settling window, because an envelope caught mid-release
            // when Play arrives finishes that release into the new pass, and
            // that is not the pattern.
            let settled = 48_000 / 4
            let a = Array(first[settled...])
            let b = Array(second[settled...])
            let worst = zip(a, b).reduce(0.0) { Swift.max($0, Double(abs($1.0 - $1.1))) }
            XCTAssertGreaterThan(
                a.reduce(0.0) { Swift.max($0, Double(abs($1))) }, 0,
                "\(kind.rawValue): the lane produced nothing to compare"
            )
            XCTAssertLessThan(
                worst, 1e-6,
                "\(kind.rawValue): the second press of Play plays a different pattern, so something did not reset"
            )
        }
    }

    /// The same patch with Master listening to the lane instead of to the
    /// sound, so what is rendered is the movement and not the music.
    ///
    /// Listening at the lane's own outlet, upstream of its trim stages. The
    /// first version of this tapped after them, where a rhythmic lane driving
    /// a gain sits between -1 and -0.9: every hit is there, and none of them
    /// crosses a threshold picked as a fraction of the peak.
    private func listeningToTheLane(
        _ patch: CratePatch,
        catalog: MaterialCatalog
    ) throws -> CratePatch {
        var patch = patch
        let master = try XCTUnwrap(patch.nodes.first { $0.kind == catalog.io.master })
        var tap = try XCTUnwrap(
            patch.connections.last {
                CrateGenBuilder.isLaneId($0.source) && !CrateGenBuilder.isLaneId($0.target)
            },
            "the patch has no lane output to listen to"
        )
        while let node = patch.node(tap.source), node.kind == "gain" || node.kind == "offset",
              CrateGenBuilder.isLaneId(node.id),
              let upstream = patch.connections.first(where: {
                  $0.target == node.id && $0.targetInput == "input"
              }) {
            tap = upstream
        }
        patch.connections.removeAll { $0.target == master.id }
        patch.connections.append(
            CratePatchConnection(
                source: tap.source, sourceOutput: tap.sourceOutput,
                target: master.id, targetInput: "input"
            )
        )
        return patch
    }
}
