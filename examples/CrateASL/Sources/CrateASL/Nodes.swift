import Foundation

/// Every node kind whose own work is worth more than the call to reach it.
///
/// One extension rather than one function per kind, so this reads next to
/// `asl/compile.ts` in the same order and a reviewer can put them side by
/// side. Where a comment here restates one from there, it is because the
/// reason is the same reason and losing it in translation is how two
/// implementations start to disagree.
extension CompiledVoice {
    func evalOther(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        switch node.kind {
        case .const, .param, .port, .lane, .mul, .add, .mix, .range:
            // Handled inline by `eval`. Stated rather than left to a default
            // so adding a kind above cannot silently lose it here.
            return 0

        case .meter, .capture:
            let value = ev(node, .input, state, sr)
            // Two guards, both load-bearing. A seam graph evaluates the whole
            // tree twice per sample, so recording on both would double every
            // meter. A stereo graph evaluates once per channel, so recording
            // on both would interleave a capture into nonsense.
            if seamPhase == .collect || state.lane != 0 { return value }
            if node.kind == .meter { state.recordMeter(node.name, value) }
            else { state.recordCapture(node.name, windowSize: Int(node.c), value: value) }
            return value

        case .toFrequency:
            return 440 * pow(2, (ev(node, .note, state, sr) - 69) / 12)

        case .osc:
            let freq = ev(node, .freq, state, sr)
            let width = node.has(.width) ? ev(node, .width, state, sr) : 0.5
            let shape = node.has(.type)
                ? min(7, max(0, Int(jsRound(ev(node, .type, state, sr)))))
                : node.m
            let mem = state.memory(for: node.slot)
            let increment = freq / sr
            if shape == Shape.supersquare {
                let ratio = 1 + min(max(width, 0), 1) * 3
                mem.pointee.phase += increment
                mem.pointee.s0 += increment * ratio
                if mem.pointee.phase >= 1 {
                    mem.pointee.phase -= 1
                    mem.pointee.s0 = mem.pointee.phase * ratio
                }
                if mem.pointee.s0 >= 1 { mem.pointee.s0 -= mem.pointee.s0.rounded(.down) }
                let master = 2 * mem.pointee.phase - 1
                let slave = mem.pointee.s0 < 0.5 ? 1.0 : -1.0
                return (master + slave) * 0.5
            }
            let out = oscillatorSample(shape, mem.pointee.phase, width, freq, sr)
            mem.pointee.phase = jsMod(mem.pointee.phase + increment, 1)
            return out

        case .lfo:
            let rate = ev(node, .rate, state, sr)
            let width = node.has(.width) ? ev(node, .width, state, sr) : 0.5
            let shape = node.has(.type)
                ? min(7, max(0, Int(jsRound(ev(node, .type, state, sr)))))
                : node.m
            let offset = node.has(.phase) ? ev(node, .phase, state, sr) : 0
            let mem = state.memory(for: node.slot)
            // Back to the start of the cycle, not to the start of the *next*
            // one: an LFO is a shape being read, so its reset lands on the
            // first sample of the shape. A clock, being an event, fires on
            // the sample it is reset instead.
            if resetRose(node, state, sr, mem) {
                mem.pointee.phase = 0
                mem.pointee.s0 = 0
            }
            // Shifts where the shape is *read* without touching where it has
            // got to, so two LFOs at one rate can sit apart and still be the
            // same clock. Zero is exact: stored phase is always in 0..1.
            func shift(_ phase: Double) -> Double {
                if offset == 0 { return phase }
                let shifted = jsMod(phase + offset, 1)
                return shifted < 0 ? shifted + 1 : shifted
            }
            let increment = rate / sr
            if shape == Shape.supersquare {
                let ratio = 1 + min(max(width, 0), 1) * 3
                mem.pointee.phase += increment
                mem.pointee.s0 += increment * ratio
                if mem.pointee.phase >= 1 {
                    mem.pointee.phase -= 1
                    mem.pointee.s0 = mem.pointee.phase * ratio
                }
                if mem.pointee.s0 >= 1 { mem.pointee.s0 -= mem.pointee.s0.rounded(.down) }
                let master = 2 * shift(mem.pointee.phase) - 1
                let slave = shift(mem.pointee.s0) < 0.5 ? 1.0 : -1.0
                return (master + slave) * 0.5
            }
            let out = oscillatorSample(shape, shift(mem.pointee.phase), width, rate, sr)
            mem.pointee.phase = jsMod(mem.pointee.phase + increment, 1)
            return out

        case .adsr: return evalAdsr(node, state, sr)
        case .dahdsr: return evalDahdsr(node, state, sr)
        case .breakpoints: return evalBreakpoints(node, state, sr)
        case .impulse: return evalImpulse(node, state, sr)

        case .filterLowpass: return evalRbJ(node, state, sr, .lowpass)
        case .filterHighpass: return evalRbJ(node, state, sr, .highpass)
        case .filterBandpass: return evalRbJ(node, state, sr, .bandpass)
        case .filterNotch: return evalRbJ(node, state, sr, .notch)
        case .filterPeaking: return evalPeaking(node, state, sr)
        case .filterLowShelf: return evalShelf(node, state, sr, low: true)
        case .filterHighShelf: return evalShelf(node, state, sr, low: false)
        case .filterAllpass: return evalAllpass(node, state, sr)
        case .onePoleLowpass: return evalOnePole(node, state, sr, low: true)
        case .onePoleHighpass: return evalOnePole(node, state, sr, low: false)
        case .svf: return evalSvf(node, state, sr)
        case .ladder: return evalLadder(node, state, sr)
        case .comb: return evalComb(node, state, sr)
        case .filterSlope: return evalFilterSlope(node, state, sr)

        case .clip:
            let value = ev(node, .input, state, sr)
            let drive = max(ev(node, .drive, state, sr), 1e-4)
            let driven = value * drive
            if node.m == 1 { return min(1, max(-1, driven)) }
            return tanh(driven)

        case .waveshape:
            let value = ev(node, .input, state, sr)
            let curve = node.a
            if curve.count < 2 { return value }
            let t = min(1, max(0, (value + 1) / 2)) * Double(curve.count - 1)
            let i0 = Int(t.rounded(.down))
            let i1 = min(curve.count - 1, i0 + 1)
            let frac = t - t.rounded(.down)
            return curve[i0] * (1 - frac) + curve[i1] * frac

        case .bitcrush:
            let value = ev(node, .input, state, sr)
            let bits = min(max(ev(node, .bits, state, sr), 1), 16)
            let mem = state.memory(for: node.slot)
            if mem.pointee.k0 != bits {
                mem.pointee.c0 = pow(2, bits - 1)
                mem.pointee.k0 = bits
            }
            return jsRound(value * mem.pointee.c0) / mem.pointee.c0

        case .downsample:
            let value = ev(node, .input, state, sr)
            let factor = max(1, ev(node, .factor, state, sr))
            let mem = state.memory(for: node.slot)
            if mem.pointee.count <= 0 {
                mem.pointee.held = value
                mem.pointee.count = factor
            }
            mem.pointee.count -= 1
            return mem.pointee.held

        case .rectify:
            let value = ev(node, .input, state, sr)
            return node.m == 1 ? max(value, 0) : abs(value)

        case .dcBlock:
            let value = ev(node, .input, state, sr)
            let mem = state.memory(for: node.slot)
            let y = value - mem.pointee.x1 + 0.995 * mem.pointee.y1
            mem.pointee.x1 = value
            mem.pointee.y1 = y
            return y

        case .slew:
            let value = ev(node, .input, state, sr)
            let rise = max(ev(node, .rise, state, sr), 0)
            let fall = max(ev(node, .fall, state, sr), 0)
            let mem = state.memory(for: node.slot)
            if !mem.pointee.initialized {
                // Slew starts where the signal is, not at zero, or every
                // voice would ramp up from silence on its first sample.
                mem.pointee.s0 = value
                mem.pointee.initialized = true
            }
            let delta = value - mem.pointee.s0
            if delta > 0 { mem.pointee.s0 += min(delta, rise / sr) } else { mem.pointee.s0 += max(delta, -fall / sr) }
            return mem.pointee.s0

        // Sample and hold, on its own rate or on somebody else's clock.
        //
        // A sample and hold whose only rate is its own is half a module: what
        // it is for is taking a reading at the moment the rest of the patch
        // does something. Both grids at once would fight, so `freq` at zero
        // turns the internal one off. Zero rather than the presence of a cable
        // because the graph cannot see whether a cable is attached: an
        // uncabled jack is still an input node holding its default.
        case .sampleHold:
            let value = ev(node, .input, state, sr)
            let freq = max(ev(node, .freq, state, sr), 0)
            let mem = state.memory(for: node.slot)
            if !mem.pointee.initialized {
                mem.pointee.held = value
                mem.pointee.phase = 1
                mem.pointee.initialized = true
            }
            if node.has(.clock) {
                let clock = ev(node, .clock, state, sr)
                let rose = clock > 0.5 && mem.pointee.prev <= 0.5
                mem.pointee.prev = clock
                if rose { mem.pointee.held = value }
            }
            if freq > 0 {
                mem.pointee.phase += freq / sr
                if mem.pointee.phase >= 1 {
                    mem.pointee.held = value
                    mem.pointee.phase -= mem.pointee.phase.rounded(.down)
                }
            }
            return mem.pointee.held

        case .compare:
            let value = ev(node, .input, state, sr)
            let threshold = ev(node, .threshold, state, sr)
            if node.m == 1 { return value < threshold ? 1 : 0 }
            return value > threshold ? 1 : 0

        case .compressor: return evalCompressor(node, state, sr)
        case .expander: return evalExpander(node, state, sr)
        case .transient: return evalTransient(node, state, sr)
        case .envFollow: return evalEnvFollow(node, state, sr)
        case .rms: return evalRms(node, state, sr)
        case .peak: return evalPeak(node, state, sr)
        case .onset: return evalOnset(node, state, sr)
        case .pitch: return evalPitch(node, state, sr)

        case .clock:
            let freq = max(ev(node, .freq, state, sr), 0)
            let mem = state.memory(for: node.slot)
            // Phase starts at 1 so the first sample fires, which is what
            // makes a clock audible from the moment it is armed, and is the
            // same reason a reset puts it back to 1 rather than to 0: Play
            // and the first tick are the same instant.
            if !mem.pointee.initialized { mem.pointee.phase = 1; mem.pointee.initialized = true }
            if resetRose(node, state, sr, mem) { mem.pointee.phase = 1 }
            mem.pointee.phase += freq / sr
            if mem.pointee.phase >= 1 {
                mem.pointee.phase -= mem.pointee.phase.rounded(.down)
                return 1
            }
            return 0

        case .clockDivide:
            let value = ev(node, .input, state, sr)
            let factor = max(1, jsRound(ev(node, .factor, state, sr)))
            let mem = state.memory(for: node.slot)
            // One short of the factor, so the next tick through is the one
            // that fires. A divider that swallowed the first `factor` ticks
            // after a reset would start the bar late.
            if resetRose(node, state, sr, mem) { mem.pointee.count = factor - 1 }
            let rose = value > 0.5 && mem.pointee.prev <= 0.5
            mem.pointee.prev = value
            if !rose { return 0 }
            mem.pointee.count += 1
            if mem.pointee.count >= factor {
                mem.pointee.count = 0
                return 1
            }
            return 0

        case .clockMultiply: return evalClockMultiply(node, state, sr)

        case .logic:
            let mode = node.m
            let a = ev(node, .a, state, sr) > 0.5
            if mode == 3 { return a ? 0 : 1 }
            let b = ev(node, .b, state, sr) > 0.5
            if mode == 1 { return a || b ? 1 : 0 }
            if mode == 2 { return a != b ? 1 : 0 }
            return a && b ? 1 : 0

        case .flipFlop:
            let value = ev(node, .input, state, sr)
            let mem = state.memory(for: node.slot)
            let rose = value > 0.5 && mem.pointee.prev <= 0.5
            mem.pointee.prev = value
            if rose { mem.pointee.on = mem.pointee.on > 0.5 ? 0 : 1 }
            return mem.pointee.on

        case .quantize:
            return quantizeToScale(
                ev(node, .input, state, sr),
                ev(node, .root, state, sr),
                ev(node, .scale, state, sr)
            )

        case .euclidean: return evalEuclidean(node, state, sr)
        case .random: return evalRandom(node, state, sr)

        case .trigger:
            let value = ev(node, .input, state, sr)
            let threshold = ev(node, .threshold, state, sr)
            let mem = state.memory(for: node.slot)
            let rose = value > threshold && mem.pointee.prev <= threshold
            mem.pointee.prev = value
            return rose ? 1 : 0

        case .pulse:
            let value = ev(node, .input, state, sr)
            let widthSec = max(ev(node, .widthSec, state, sr), 0)
            let mem = state.memory(for: node.slot)
            let rose = value > 0.5 && mem.pointee.prev <= 0.5
            mem.pointee.prev = value
            if rose { mem.pointee.left = max(1, jsRound(widthSec * sr)) }
            if mem.pointee.left <= 0 { return 0 }
            mem.pointee.left -= 1
            return 1

        case .sequencer:
            let clockIn = ev(node, .clock, state, sr)
            let steps = node.list ?? []
            let mem = state.memory(for: node.slot)
            if resetRose(node, state, sr, mem) { mem.pointee.index = -1 }
            let rose = clockIn > 0.5 && mem.pointee.prev <= 0.5
            mem.pointee.prev = clockIn
            if steps.isEmpty { return 0 }
            if rose { mem.pointee.index = jsMod(mem.pointee.index + 1, Double(steps.count)) }
            if mem.pointee.index < 0 { return 0 }
            return eval(steps[Int(mem.pointee.index)], state, sr)

        case .select:
            let a = ev(node, .a, state, sr)
            let b = ev(node, .b, state, sr)
            let which = ev(node, .which, state, sr)
            return which > 0.5 ? b : a

        case .reverse: return evalReverse(node, state, sr)
        case .looper: return evalLooper(node, state, sr)
        case .delay: return evalDelay(node, state, sr)
        case .wavetable: return evalWavetable(node, state, sr)
        case .samplePlay: return evalSamplePlay(node, state, sr)
        case .grain: return evalGrain(node, state, sr)
        case .pitchShift: return evalPitchShift(node, state, sr)

        case .panLaw:
            let value = ev(node, .input, state, sr)
            let pan = min(1, max(-1, ev(node, .pan, state, sr)))
            let angle = ((pan + 1) * Double.pi) / 4
            return value * (node.m == 1 ? sin(angle) : cos(angle))

        case .noise: return evalNoise(node, state, sr)
        case .transport: return evalTransport(node, state, sr)
        case .kernel: return evalKernel(node, state, sr)
        }
    }

    @inline(__always) func ev(_ node: PlanNode, _ name: InputName, _ state: VoiceState, _ sr: Double) -> Double {
        guard let child = node.input(name) else { return 0 }
        return eval(child, state, sr)
    }

    /// Whether a rising edge arrived on `reset` this sample.
    ///
    /// Shared by the five nodes that carry a position in a pattern, because
    /// without it a patch cannot start with the song. The transport's
    /// `playing` is the signal anybody actually wires here: a clock is a
    /// free-running phase and a euclidean is a step counter, so when Play
    /// arrives they are wherever they happened to be, and the pattern lands
    /// off the bar for as long as the plugin stays loaded. `syncedclock` is
    /// exempt, being derived from the song position with no state of its own,
    /// but everything counting steps downstream of it is not.
    ///
    /// Edge-triggered rather than level-triggered, so a `playing` held high
    /// is one reset at the top and not a node pinned to step zero for the
    /// whole song.
    @inline(__always) func resetRose(
        _ node: PlanNode,
        _ state: VoiceState,
        _ sr: Double,
        _ mem: UnsafeMutablePointer<NodeMemory>
    ) -> Bool {
        guard let child = node.input(.reset) else { return false }
        let value = eval(child, state, sr)
        let rose = value > 0.5 && mem.pointee.prevReset <= 0.5
        mem.pointee.prevReset = value
        return rose
    }
}
