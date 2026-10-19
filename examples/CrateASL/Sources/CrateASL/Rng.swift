// The random numbers behind `noise` and `random`, made reproducible.
//
// Line for line with `src/asl/rng.ts`. Each node draws from its own stream,
// started from the voice seed, the node's rank among the graph's random nodes
// in structural order (`randomRanks` in Plan.swift), and the channel.
// Everything is 32-bit wrapping integer arithmetic, which is what `Math.imul`
// and `>>>` are in JavaScript, and the draw is that integer over 2^32, exact
// in a Double. That is what lets the
// conformance fixture hold noise to zero tolerance.

/// How long a smoothed parameter takes to reach a new value.
/// `PARAM_RAMP_SECONDS` in compile.ts; see there for why it is short.
public let paramRampSeconds = 0.005

/// A glide's length in frames, never zero. `paramRampFrames` in compile.ts.
public func paramRampFrames(_ sampleRate: Double) -> Int {
    max(1, Int((paramRampSeconds * sampleRate).rounded()))
}

/// The seed a voice gets when nobody chooses one. `DEFAULT_VOICE_SEED`.
public let defaultVoiceSeed: UInt32 = 0

/// ECMAScript ToUint32: truncate toward zero, wrap modulo 2^32, exactly.
/// `normalizeSeed` in rng.ts. A non-finite seed is the default.
public func normalizeSeed(_ seed: Double) -> UInt32 {
    guard seed.isFinite else { return defaultVoiceSeed }
    let wrapped = seed.rounded(.towardZero).truncatingRemainder(dividingBy: 4_294_967_296)
    return UInt32(wrapped < 0 ? wrapped + 4_294_967_296 : wrapped)
}

/// A murmur3 finalizer over the three inputs. `streamSeed` in rng.ts.
@inline(__always)
func streamSeed(_ voiceSeed: UInt32, rank: Int, lane: Int) -> UInt32 {
    var h = voiceSeed
        ^ (UInt32(truncatingIfNeeded: rank + 1) &* 0x9e37_79b1)
        ^ (UInt32(truncatingIfNeeded: lane + 1) &* 0x85eb_ca6b)
    h = (h ^ (h >> 16)) &* 0x85eb_ca6b
    h = (h ^ (h >> 13)) &* 0xc2b2_ae35
    return h ^ (h >> 16)
}

/// The next draw in [0, 1), advancing `state`. mulberry32, `nextUniform` in rng.ts.
@inline(__always)
func nextUniform(_ state: inout UInt32) -> Double {
    let s = state &+ 0x6d2b_79f5
    state = s
    var t = (s ^ (s >> 15)) &* (s | 1)
    t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
    return Double(t ^ (t >> 14)) / 4_294_967_296
}
