import XCTest
@testable import CrateASL

/// Fader curves, grid snapping and display strings, against what
/// `normalizeParam`, `denormalizeParam`, `quantizeParam` and `formatParam` in
/// `src/graph/param.ts` returned for the same descriptors (run through tsx,
/// 2026-09-29). A fader in the native editor has to write the value the
/// browser's would, or a patch made on a phone opens in the browser a hair
/// off every stepped and curved value.
final class ParamPresentationTests: XCTestCase {

    private struct Reference {
        let descriptor: CrateParamDescriptor
        let denorm: [Double]
        let norm: [Double]
        let format: [String]
        let quantize: [Double]
    }

    /// Positions fed to `denormalize`.
    private let positions = [0, 0.1, 0.25, 0.5, 0.77, 1]
    /// Arbitrary values fed to `format`, after min, default and max.
    private let formatExtras = [0.125, 0.3333, 1234.5, 0.07]
    private let quantizeInputs = [0.126, 0.51, -1.4, 1.5]

    private var references: [String: Reference] {
        [
            "attack": Reference(
                descriptor: .init(kind: "range", min: 0.001, max: 2, defaultValue: 0.005, unit: "s", curve: "exp"),
                denorm: [0.001, 0.020990000000000005, 0.1259375, 0.50075, 1.1862071, 2],
                norm: [0, 0.7071067811865475, 1, 0.04473254408425844],
                format: ["0 s", "0.01 s", "2 s", "0.13 s", "0.33 s", "1234.5 s", "0.07 s"],
                quantize: [0.126, 0.51, -1.4, 1.5]
            ),
            "cutoff": Reference(
                descriptor: .init(kind: "range", min: 20, max: 20000, defaultValue: 1000, unit: "Hz", curve: "log"),
                denorm: [20, 39.905246299377595, 112.46826503806983, 632.4555320336758, 4083.475889339059, 20000],
                norm: [0, 0.8998013606051125, 1, 0.5663233347786729],
                // 1234.5 is a tie: toFixed rounds it up and printf to even.
                format: ["20 Hz", "1000 Hz", "20000 Hz", "0 Hz", "0 Hz", "1235 Hz", "0 Hz"],
                quantize: [0.126, 0.51, -1.4, 1.5]
            ),
            "octave": Reference(
                descriptor: .init(kind: "stepped", min: -2, max: 2, defaultValue: 0, step: 1),
                denorm: [-2, -2, -1, 0, 1, 2],
                norm: [0, 0.5, 1, 0.5],
                format: ["-2", "0", "2", "0", "0", "2", "0"],
                quantize: [0, 1, -1, 2]
            ),
            "fine": Reference(
                descriptor: .init(kind: "stepped", min: 0, max: 1, defaultValue: 0.5, unit: "x", step: 0.05),
                denorm: [0, 0.1, 0.25, 0.5, 0.75, 1],
                norm: [0, 0.5, 1, 0.5],
                format: ["0 x", "0.5 x", "1 x", "0.15 x", "0.35 x", "1 x", "0.05 x"],
                quantize: [0.15, 0.5, 0, 1]
            ),
            "wave": Reference(
                descriptor: .init(kind: "enum", min: 0, max: 2, defaultValue: 0, step: 1, options: ["Sine", "Saw", "Square"]),
                denorm: [0, 0, 1, 1, 2, 2],
                norm: [0, 0.5, 1, 0],
                format: ["Sine", "Sine", "Square", "Sine", "Sine", "Square", "Sine"],
                quantize: [0, 1, 0, 2]
            ),
            "on": Reference(
                descriptor: .init(kind: "toggle", min: 0, max: 1, defaultValue: 0, step: 1, labels: ["Off", "On"]),
                denorm: [0, 0, 0, 1, 1, 1],
                norm: [0, 0.5, 1, 0],
                format: ["Off", "Off", "On", "Off", "Off", "On", "Off"],
                quantize: [0, 1, 0, 1]
            ),
            "mix": Reference(
                descriptor: .init(kind: "range", min: 0, max: 1, defaultValue: 0.5),
                denorm: [0, 0.1, 0.25, 0.5, 0.77, 1],
                norm: [0, 0.5, 1, 0.5],
                format: ["0", "0.5", "1", "0.13", "0.33", "1234.5", "0.07"],
                quantize: [0.126, 0.51, -1.4, 1.5]
            ),
            "detune": Reference(
                descriptor: .init(kind: "range", min: -100, max: 100, defaultValue: 0, unit: "ct"),
                denorm: [-100, -80, -50, 0, 54, 100],
                norm: [0, 0.5, 1, 0.5],
                format: ["-100 ct", "0 ct", "100 ct", "0 ct", "0 ct", "1235 ct", "0 ct"],
                quantize: [0.126, 0.51, -1.4, 1.5]
            ),
            "time": Reference(
                descriptor: .init(kind: "range", min: 0, max: 12, defaultValue: 1, unit: "s"),
                denorm: [0, 1.2000000000000002, 3, 6, 9.24, 12],
                norm: [0, 0.5, 1, 0.08333333333333333],
                format: ["0 s", "1 s", "12 s", "0.1 s", "0.3 s", "1234.5 s", "0.1 s"],
                quantize: [0.126, 0.51, -1.4, 1.5]
            ),
        ]
    }

    /// Relative, because `pow` and `log` are libm's here and fdlibm's in V8
    /// and are entitled to differ in the last bit.
    private func assertClose(_ a: Double, _ b: Double, _ message: String) {
        XCTAssertEqual(a, b, accuracy: max(1e-12, abs(b) * 1e-12), message)
    }

    func testFaderPositionsLandWhereTheBrowsersDo() {
        for (name, reference) in references {
            for (index, position) in positions.enumerated() {
                assertClose(reference.descriptor.denormalize(position), reference.denorm[index], "\(name) at \(position)")
            }
        }
    }

    func testValuesMapBackOntoTheSameFaderPositions() {
        for (name, reference) in references {
            let d = reference.descriptor
            let values = [d.min, (d.min + d.max) / 2, d.max, d.defaultValue]
            for (index, value) in values.enumerated() {
                assertClose(d.normalize(value), reference.norm[index], "\(name) at \(value)")
            }
        }
    }

    func testDisplayStringsReadTheSame() {
        for (name, reference) in references {
            let d = reference.descriptor
            let values = [d.min, d.defaultValue, d.max] + formatExtras
            XCTAssertEqual(values.map(d.format), reference.format, name)
        }
    }

    func testTheGridSnapsTheSame() {
        for (name, reference) in references {
            XCTAssertEqual(quantizeInputs.map(reference.descriptor.quantize), reference.quantize, name)
        }
    }

    /// The reason this file exists: an exp fader gives attack times their
    /// travel. A quarter of the throw is 126 ms, not half a second.
    func testAnExpFaderSpendsItsTravelOnShortTimes() {
        let attack = references["attack"]!.descriptor
        XCTAssertLessThan(attack.denormalize(0.25), 0.13)
        XCTAssertEqual(attack.normalize(attack.denormalize(0.4)), 0.4, accuracy: 1e-12)
    }
}
