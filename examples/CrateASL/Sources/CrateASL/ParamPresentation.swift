import Foundation

/// How a parameter maps onto a control and how its value reads, ported from
/// `normalizeParam`, `denormalizeParam`, `quantizeParam` and `formatParam` in
/// `src/graph/param.ts`.
///
/// Presentation, but not cosmetic. The curve decides where a fader's travel
/// goes: every envelope time in the palette is `exp`, so a linear fader over
/// 0.001..2 s puts the whole of 1 to 50 ms, where attacks live, in the first
/// two and a half percent of the throw. A native editor that ignored `exp`
/// had exactly that fader. And a value written by a fader has to land where
/// the browser's would, or a patch made on a phone opens in the browser a hair
/// off every stepped value.
///
/// `ParamPresentationTests` holds these to numbers the JavaScript produced.
extension CrateParamDescriptor {

    /// `enum` or `toggle`: a choice, drawn as a picker or a switch rather than
    /// a fader.
    public var isChoice: Bool {
        kind == "enum" || kind == "toggle" || options != nil || labels != nil
    }

    public var isToggle: Bool { kind == "toggle" || (labels != nil && options == nil) }

    /// The value snapped onto `min + k * step` and clamped, or unchanged when
    /// the parameter is continuous.
    public func quantize(_ value: Double) -> Double {
        guard let step, step > 0 else { return value }
        let snapped = min + ((value - min) / step).rounded(.toNearestOrAwayFromZero) * step
        return Swift.min(max, Swift.max(min, Self.roundToGrid(snapped, step: step)))
    }

    /// A fader's position, 0...1, for a value.
    public func normalize(_ value: Double) -> Double {
        let span = max - min
        guard span > 0 else { return 0 }
        let clamped = Swift.min(max, Swift.max(min, value))
        switch curve {
        case "log":
            guard min > 0 else { return (clamped - min) / span }
            return Foundation.log(clamped / min) / Foundation.log(max / min)
        case "exp":
            return ((clamped - min) / span).squareRoot()
        default:
            return (clamped - min) / span
        }
    }

    /// The value at a fader position, snapped onto the grid when there is one.
    public func denormalize(_ position: Double) -> Double {
        let clamped = Swift.min(1, Swift.max(0, position))
        let span = max - min
        let value: Double
        switch curve {
        case "log" where min > 0:
            value = min * pow(max / min, clamped)
        case "exp":
            value = min + span * clamped * clamped
        default:
            value = min + clamped * span
        }
        return quantize(value)
    }

    /// What a control writes beside the fader. Nothing parses this back.
    public func format(_ value: Double) -> String {
        if let options {
            let index = Int(quantize(value).rounded())
            return index >= 0 && index < options.count ? options[index] : String(index)
        }
        if let labels, labels.count >= 2 {
            return labels[value >= 0.5 ? 1 : 0]
        }
        if let step, step > 0 {
            return Self.withUnit(Self.trim(quantize(value), decimals: Self.decimals(for: step)), unit)
        }
        return Self.withUnit(Self.trim(value, decimals: precision), unit)
    }

    /// Enough digits to see a fader move and no more: a 20 Hz to 20 kHz sweep
    /// does not want decimals, a 0 to 1 mix is useless without them.
    private var precision: Int {
        let span = max - min
        if span >= 100 { return 0 }
        if span >= 10 { return 1 }
        return 2
    }

    /// `toFixed`, then trailing zeros and a bare point dropped, as
    /// `trimNumber` does. `toFixed` rounds half away from zero on the decimal
    /// it prints, and so does this, so `0.125` reads `0.13` on both sides.
    static func trim(_ value: Double, decimals: Int) -> String {
        var text = String(format: "%.\(decimals)f", Self.roundHalfAway(value, decimals: decimals))
        if text == "-0" || text.hasPrefix("-0.") && Double(text) == 0 { text.removeFirst() }
        guard decimals > 0, text.contains(".") else { return text }
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }

    /// printf rounds an exact tie to even and `toFixed` rounds it away from
    /// zero, so `0.125` is `0.12` to one and `0.13` to the other. Only a tie
    /// is moved; every other value is printed as it is, which is where the two
    /// already agree (`1.005` is really 1.00499... and is `1.00` to both).
    private static func roundHalfAway(_ value: Double, decimals: Int) -> Double {
        let scale = pow(10, Double(decimals))
        let scaled = value * scale
        let fraction = abs(scaled - scaled.rounded(.towardZero))
        guard fraction == 0.5 else { return value }
        return scaled.rounded(.toNearestOrAwayFromZero) / scale
    }

    private static func withUnit(_ text: String, _ unit: String?) -> String {
        guard let unit, !unit.isEmpty else { return text }
        return "\(text) \(unit)"
    }

    /// Digits after the point in `step` as JavaScript prints it, capped at 9.
    static func decimals(for step: Double) -> Int {
        if step == step.rounded() { return 0 }
        var text = String(step)
        if let e = text.firstIndex(of: "e") {
            // 1e-05 and friends: the exponent is the digit count.
            let exponent = Int(text[text.index(after: e)...]) ?? 0
            return Swift.min(9, Swift.max(0, -exponent))
        }
        guard let dot = text.firstIndex(of: ".") else { return 0 }
        text = String(text[text.index(after: dot)...])
        return Swift.min(9, text.count)
    }

    private static func roundToGrid(_ value: Double, step: Double) -> Double {
        let places = decimals(for: step)
        if places == 0 { return value.rounded(.toNearestOrAwayFromZero) }
        let scale = pow(10, Double(places))
        return (value * scale).rounded(.toNearestOrAwayFromZero) / scale
    }
}
