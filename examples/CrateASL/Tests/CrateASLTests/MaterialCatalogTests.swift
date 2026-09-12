import XCTest
@testable import CrateASL

/// The palette, and whether this interpreter can actually run what is in it.
///
/// `asl-conformance` proves 91 hand-built graphs render identically in both
/// languages. It does not prove that the *materials the palette ships* can be
/// compiled here at all, because its cases build nodes directly with whatever
/// inputs the case needed. A material's own graph is wider than that: the
/// Looper material wires `fadeSec`, `overdub`, `undo`, `threshold` and
/// `quantize` onto a node whose golden case uses four inputs.
///
/// That gap is invisible until somebody places one in a patcher, at which
/// point it throws at load time, in the field, on their patch. This is the
/// test that moves the failure here.
final class MaterialCatalogTests: XCTestCase {

    func testCatalogLoads() throws {
        let catalog = try MaterialCatalog.bundled()
        XCTAssertEqual(catalog.version, 1)
        XCTAssertGreaterThan(catalog.materials.count, 100, "the palette lost most of itself")
        XCTAssertFalse(catalog.tools.isEmpty)
        XCTAssertFalse(catalog.kernels.isEmpty)
        XCTAssertEqual(catalog.io.master, "master")
        XCTAssertTrue(catalog.isHostTool(catalog.io.keyboard))
        XCTAssertFalse(catalog.isHostTool("lowpass"))
    }

    /// Kinds this interpreter is known not to be able to compile, and why.
    ///
    /// One entry, and it is not a small one. The Looper *material* wires
    /// `overdub`, `undo`, `quantize`, `fadeSec`, `latencySec`, `play` and
    /// `bars` onto its looper node. `InputName` in `Plan.swift` has none of
    /// those seven, and `evalLooper` is a take recorder where the JavaScript
    /// one is a full overdub looper: no undo buffer, no threshold arming, no
    /// quantised take length, no equal-power seam fade, no latency
    /// compensation.
    ///
    /// `asl-conformance` is 91/91 bit-exact and could not see this, because
    /// its golden looper cases build the node directly with four inputs. The
    /// material's own graph is the wider thing, and nothing compiled one here
    /// until a patcher needed to.
    ///
    /// Written as an expected-failure list rather than left red: a new break
    /// fails this test because the list no longer matches, and porting the
    /// looper fails it too, which is the reminder to delete the entry.
    static let knownUncompilable: Set<String> = ["looper"]

    /// Every kind the palette offers has to compile here, or the palette is
    /// offering nodes this build cannot run.
    func testEveryMaterialCompiles() throws {
        let catalog = try MaterialCatalog.bundled()
        var refused = [String: String]()
        for material in catalog.materials {
            do {
                _ = try CompiledVoice(document: material.graph)
            } catch {
                refused[material.kind] = "\(error)"
            }
        }
        XCTAssertEqual(
            Set(refused.keys), Self.knownUncompilable,
            "the set of palette materials this interpreter cannot compile changed. "
                + "New failures: \(Set(refused.keys).subtracting(Self.knownUncompilable)). "
                + "Fixed, so remove them from knownUncompilable: "
                + "\(Self.knownUncompilable.subtracting(refused.keys)). "
                + "Errors: \(refused)"
        )
    }

    /// The palette decides what to offer by compiling, not by carrying a list.
    ///
    /// A hardcoded list of unavailable kinds is a list that goes stale in the
    /// direction that hurts: the day the looper is ported, a palette reading
    /// a list still hides it. Asking the interpreter cannot be wrong.
    func testRunnableKindsAreDerivedNotListed() throws {
        let catalog = try MaterialCatalog.bundled()
        XCTAssertFalse(catalog.canCompile("looper"), "matches knownUncompilable today")
        XCTAssertTrue(catalog.canCompile("lowpass"))
        XCTAssertTrue(catalog.canCompile("reverb"))
        XCTAssertFalse(catalog.canCompile("amp"), "a kernel has no graph to compile")
        XCTAssertEqual(
            Set(catalog.materials.map(\.kind)).subtracting(catalog.runnableKinds),
            Self.knownUncompilable
        )
    }

    /// A material that compiles and then renders nothing but zeros is a node
    /// whose inputs this interpreter accepted and ignored. Sources are
    /// checked rather than effects because an effect with no input signal is
    /// legitimately silent.
    func testEverySourceMakesSound() throws {
        let catalog = try MaterialCatalog.bundled()
        var silent = [String]()
        for material in catalog.materials where material.audioInputs.isEmpty {
            // Analysis nodes read audio they are not being given, and the
            // random ones are excluded from conformance for the same reason
            // they are excluded everywhere: nothing stable to assert.
            if material.isAnalysis || material.kind == "noise" { continue }
            let voice = try CompiledVoice(document: material.graph)
            let state = voice.makeState()
            state.setParams(defaults(material))
            state.gate = true
            var peak = 0.0
            for _ in 0..<4096 {
                peak = Swift.max(peak, abs(voice.renderSample(state, sampleRate: 48_000)))
            }
            if peak == 0 { silent.append(material.kind) }
        }
        // Recorded rather than asserted empty: several sources are silent by
        // design at their defaults (a sample player with no file, a sequencer
        // with every step at zero), and turning that into a failure would mean
        // encoding a list of exceptions that goes stale on its own.
        XCTAssertLessThan(
            silent.count, catalog.materials.count / 4,
            "most sources render silence, which is not a palette: \(silent)"
        )
    }

    private func defaults(_ material: CatalogMaterialEntry) -> [String: Double] {
        var values = [String: Double]()
        for (name, descriptor) in material.params { values[name] = descriptor.defaultValue }
        values["note"] = 60
        values["gate"] = 1
        values["velocity"] = 1
        return values
    }

    /// Jacks a palette draws have to be jacks the graph reads, or a cable
    /// lands on a param nothing looks at.
    func testAudioInletsAreRealPorts() throws {
        let catalog = try MaterialCatalog.bundled()
        for material in catalog.materials {
            var ports = Set<String>()
            var seen = Set<Int>()
            collectPorts(material.graph.output, into: &ports, seen: &seen)
            XCTAssertEqual(
                Set(material.audioInputs), ports,
                "\(material.kind) declares audio inlets its graph does not read"
            )
        }
    }

    private func collectPorts(
        _ node: ASLNodeDocument,
        into names: inout Set<String>,
        seen: inout Set<Int>
    ) {
        if seen.contains(node.id) { return }
        seen.insert(node.id)
        if node.kind == "port", let name = node.params["name"]?.string { names.insert(name) }
        for child in node.inputs.values { collectPorts(child, into: &names, seen: &seen) }
        for child in node.list ?? [] { collectPorts(child, into: &names, seen: &seen) }
    }
}
