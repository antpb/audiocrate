import Foundation

enum RbJKind { case lowpass, highpass, bandpass, notch }

let quantizeScales: [[Double]] = [
    [0, 2, 4, 5, 7, 9, 11],
    [0, 2, 3, 5, 7, 8, 10],
    [0, 2, 4, 7, 9],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    [0, 2, 4, 6, 8, 10],
]

func quantizeToScale(_ note: Double, _ root: Double, _ scaleIndex: Double) -> Double {
    let degrees = quantizeScales[Int(min(max(jsRound(scaleIndex), 0), Double(quantizeScales.count - 1)))]
    let shifted = note - root
    let octave = (shifted / 12).rounded(.down)
    let pc = shifted - octave * 12
    var bestDeg = degrees.first ?? 0
    var bestDist = Double.infinity
    // The three octave candidates are unrolled rather than gathered into an
    // array. This runs per sample, and an array literal here is a heap
    // allocation per degree per sample on the audio thread.
    for degree in degrees {
        for offset in [0.0, -12.0, 12.0] {
            let candidate = degree + offset
            let dist = abs(candidate - pc)
            if dist < bestDist - 1e-12 {
                bestDist = dist
                bestDeg = candidate
            }
        }
    }
    return root + octave * 12 + bestDeg
}

func euclideanPattern(_ steps: Double, _ hits: Double, _ rotation: Double) -> [Bool] {
    let n = Int(max(1, steps.rounded(.down)))
    let k = Int(min(Double(n), max(0, hits.rounded(.down))))
    var pattern = [Bool]()
    pattern.reserveCapacity(n)
    var acc = 0
    for _ in 0..<n {
        acc += k
        if acc >= n {
            acc -= n
            pattern.append(true)
        } else {
            pattern.append(false)
        }
    }
    let rot = ((Int(rotation.rounded(.down)) % n) + n) % n
    if rot == 0 { return pattern }
    return Array(pattern[rot...]) + Array(pattern[..<rot])
}

extension CompiledVoice {

    // MARK: Envelopes

    func evalAdsr(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let a = node.a.count > 0 ? node.a[0] : 0
        let d = node.a.count > 1 ? node.a[1] : 0
        let s = node.a.count > 2 ? node.a[2] : 0
        let r = node.a.count > 3 ? node.a[3] : 0
        let velocity = ev(node, .trigger, state, sr)
        let mem = state.memory(for: node.slot)

        if state.gate && !mem.pointee.lastGate {
            mem.pointee.stage = .attack
            mem.pointee.peak = velocity
            mem.pointee.stageElapsed = 0
            mem.pointee.stageStartLevel = mem.pointee.level
        } else if !state.gate && mem.pointee.lastGate {
            mem.pointee.stage = .release
            mem.pointee.stageElapsed = 0
            mem.pointee.stageStartLevel = mem.pointee.level
        }
        mem.pointee.lastGate = state.gate

        let dt = 1 / sr
        switch mem.pointee.stage {
        case .idle:
            mem.pointee.level = 0
        case .attack:
            mem.pointee.stageElapsed += dt
            let t = min(mem.pointee.stageElapsed / max(a, 1e-6), 1)
            mem.pointee.level = mem.pointee.stageStartLevel + (mem.pointee.peak - mem.pointee.stageStartLevel) * t
            if t >= 1 {
                mem.pointee.stage = .decay
                mem.pointee.stageElapsed = 0
                mem.pointee.stageStartLevel = mem.pointee.level
            }
        case .decay:
            mem.pointee.stageElapsed += dt
            let target = s * mem.pointee.peak
            let t = min(mem.pointee.stageElapsed / max(d, 1e-6), 1)
            mem.pointee.level = mem.pointee.stageStartLevel + (target - mem.pointee.stageStartLevel) * t
            if t >= 1 { mem.pointee.stage = .sustain }
        case .sustain:
            mem.pointee.level = s * mem.pointee.peak
        case .release:
            mem.pointee.stageElapsed += dt
            let t = min(mem.pointee.stageElapsed / max(r, 1e-6), 1)
            mem.pointee.level = mem.pointee.stageStartLevel * (1 - t)
            if t >= 1 {
                mem.pointee.stage = .idle
                mem.pointee.level = 0
            }
        case .delay, .hold:
            break
        }
        return mem.pointee.level
    }

    func evalDahdsr(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let velocity = ev(node, .trigger, state, sr)
        let delay = max(ev(node, .delay, state, sr), 0)
        let attack = max(ev(node, .attack, state, sr), 0)
        let hold = max(ev(node, .hold, state, sr), 0)
        let decay = max(ev(node, .decay, state, sr), 0)
        let sustain = min(max(ev(node, .sustain, state, sr), 0), 1)
        let release = max(ev(node, .release, state, sr), 0)
        let gated = node.has(.gate)
            ? ev(node, .gate, state, sr) > 0.5
            : state.gate
        let mem = state.memory(for: node.slot)

        if gated && !mem.pointee.lastGate {
            mem.pointee.peak = velocity
            mem.pointee.stageElapsed = 0
            mem.pointee.stageStartLevel = mem.pointee.level
            mem.pointee.stage = delay > 1e-6 ? .delay : .attack
        } else if !gated && mem.pointee.lastGate {
            mem.pointee.stage = .release
            mem.pointee.stageElapsed = 0
            mem.pointee.stageStartLevel = mem.pointee.level
        }
        mem.pointee.lastGate = gated

        mem.pointee.stageElapsed += 1 / sr

        if mem.pointee.stage == .idle {
            mem.pointee.level = 0
        } else if mem.pointee.stage == .delay {
            mem.pointee.level = mem.pointee.stageStartLevel
            if mem.pointee.stageElapsed >= delay {
                mem.pointee.stage = .attack
                mem.pointee.stageElapsed = 0
                mem.pointee.stageStartLevel = mem.pointee.level
            }
        }
        if mem.pointee.stage == .attack {
            let t = min(mem.pointee.stageElapsed / max(attack, 1e-6), 1)
            mem.pointee.level = mem.pointee.stageStartLevel + (mem.pointee.peak - mem.pointee.stageStartLevel) * t
            if t >= 1 {
                mem.pointee.stage = hold > 1e-6 ? .hold : .decay
                mem.pointee.stageElapsed = 0
                mem.pointee.stageStartLevel = mem.pointee.level
            }
        }
        if mem.pointee.stage == .hold {
            mem.pointee.level = mem.pointee.peak
            if mem.pointee.stageElapsed >= hold {
                mem.pointee.stage = .decay
                mem.pointee.stageElapsed = 0
                mem.pointee.stageStartLevel = mem.pointee.level
            }
        }
        if mem.pointee.stage == .decay {
            let target = sustain * mem.pointee.peak
            let t = min(mem.pointee.stageElapsed / max(decay, 1e-6), 1)
            mem.pointee.level = mem.pointee.stageStartLevel + (target - mem.pointee.stageStartLevel) * t
            if t >= 1 { mem.pointee.stage = .sustain }
        }
        if mem.pointee.stage == .sustain {
            mem.pointee.level = sustain * mem.pointee.peak
        }
        if mem.pointee.stage == .release {
            let t = min(mem.pointee.stageElapsed / max(release, 1e-6), 1)
            mem.pointee.level = mem.pointee.stageStartLevel * (1 - t)
            if t >= 1 {
                mem.pointee.stage = .idle
                mem.pointee.level = 0
            }
        }
        return mem.pointee.level
    }

    func evalBreakpoints(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let gated = node.has(.gate)
            ? ev(node, .gate, state, sr) > 0.5
            : state.gate
        let mem = state.memory(for: node.slot)
        if gated && !mem.pointee.prevGate { mem.pointee.stageElapsed = 0 }
        mem.pointee.prevGate = gated
        if !gated { return 0 }
        mem.pointee.stageElapsed += 1 / sr
        if let list = node.list, list.count >= 2 {
            var prevT = eval(list[0], state, sr)
            var prevL = eval(list[1], state, sr)
            if mem.pointee.stageElapsed <= prevT { return prevL }
            var i = 2
            while i + 1 < list.count {
                let t = max(eval(list[i], state, sr), prevT)
                let level = eval(list[i + 1], state, sr)
                if mem.pointee.stageElapsed <= t {
                    let span = max(t - prevT, 1e-9)
                    return prevL + (level - prevL) * ((mem.pointee.stageElapsed - prevT) / span)
                }
                prevT = t
                prevL = level
                i += 2
            }
            return prevL
        }
        let times = node.a
        let levels = node.b
        if times.isEmpty || levels.isEmpty { return 0 }
        if mem.pointee.stageElapsed <= times[0] { return levels[0] }
        var i = 1
        while i < times.count && i < levels.count {
            if mem.pointee.stageElapsed <= times[i] {
                let span = max(times[i] - times[i - 1], 1e-9)
                let t = (mem.pointee.stageElapsed - times[i - 1]) / span
                return levels[i - 1] + (levels[i] - levels[i - 1]) * t
            }
            i += 1
        }
        return levels[min(levels.count, times.count) - 1]
    }

    func evalImpulse(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let hasGate = node.has(.gate)
        let gated = hasGate ? ev(node, .gate, state, sr) > 0.5 : state.gate
        let mem = state.memory(for: node.slot)
        if !mem.pointee.initialized {
            // Armed when nothing gates it, so a bare impulse fires once at
            // the top of the voice rather than waiting for an edge.
            mem.pointee.armed = !hasGate
            mem.pointee.initialized = true
        }
        let rose = gated && !mem.pointee.prevGate
        mem.pointee.prevGate = gated
        if mem.pointee.armed || rose {
            mem.pointee.armed = false
            return 1
        }
        return 0
    }

    // MARK: Biquads

    /// Stores coefficients already divided through by a0, with the inputs
    /// they came from. Cutoff and Q are graph inputs so they *can* change every
    /// sample, and in practice almost never do: a fixed EQ band, a knob nobody
    /// is touching, an envelope at sustain. Recomputing a sine, a cosine and
    /// sometimes a power for each of those samples is the most expensive thing
    /// an idle filter does.
    @inline(__always) private func setBiquad(
        _ mem: UnsafeMutablePointer<NodeMemory>, _ k0: Double, _ k1: Double, _ k2: Double, _ k3: Double,
        _ b0: Double, _ b1: Double, _ b2: Double, _ a0: Double, _ a1: Double, _ a2: Double
    ) {
        mem.pointee.n0 = b0 / a0
        mem.pointee.n1 = b1 / a0
        mem.pointee.n2 = b2 / a0
        mem.pointee.d1 = a1 / a0
        mem.pointee.d2 = a2 / a0
        mem.pointee.k0 = k0
        mem.pointee.k1 = k1
        mem.pointee.k2 = k2
        mem.pointee.k3 = k3
    }

    @inline(__always) private func tickBiquad(_ mem: UnsafeMutablePointer<NodeMemory>, _ input: Double) -> Double {
        let y = mem.pointee.n0 * input + mem.pointee.n1 * mem.pointee.x1 + mem.pointee.n2 * mem.pointee.x2 - mem.pointee.d1 * mem.pointee.y1 - mem.pointee.d2 * mem.pointee.y2
        mem.pointee.x2 = mem.pointee.x1
        mem.pointee.x1 = input
        mem.pointee.y2 = mem.pointee.y1
        mem.pointee.y1 = y
        return y
    }

    func evalRbJ(_ node: PlanNode, _ state: VoiceState, _ sr: Double, _ kind: RbJKind) -> Double {
        let input = ev(node, .input, state, sr)
        let cutoff = ev(node, .cutoff, state, sr)
        let q = ev(node, .q, state, sr)
        let mem = state.memory(for: node.slot)

        if mem.pointee.k0 != cutoff || mem.pointee.k1 != q || mem.pointee.k2 != sr {
            let clamped = min(max(cutoff, 1), sr / 2 - 1)
            let omega = (2 * Double.pi * clamped) / sr
            let sinw = sin(omega)
            let cosw = cos(omega)
            let alpha = sinw / (2 * max(q, 1e-4))
            let a0 = 1 + alpha
            let a1 = -2 * cosw
            let a2 = 1 - alpha
            var b0 = 0.0, b1 = 0.0, b2 = 0.0
            switch kind {
            case .lowpass:
                b0 = (1 - cosw) / 2
                b1 = 1 - cosw
                b2 = (1 - cosw) / 2
            case .highpass:
                b0 = (1 + cosw) / 2
                b1 = -(1 + cosw)
                b2 = (1 + cosw) / 2
            case .bandpass:
                b0 = alpha
                b1 = 0
                b2 = -alpha
            case .notch:
                b0 = 1
                b1 = -2 * cosw
                b2 = 1
            }
            setBiquad(mem, cutoff, q, sr, 0, b0, b1, b2, a0, a1, a2)
        }
        return tickBiquad(mem, input)
    }

    func evalPeaking(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let freq = ev(node, .freq, state, sr)
        let gainDb = ev(node, .gainDb, state, sr)
        let q = ev(node, .q, state, sr)
        let mem = state.memory(for: node.slot)

        if mem.pointee.k0 != freq || mem.pointee.k1 != gainDb || mem.pointee.k2 != q || mem.pointee.k3 != sr {
            let clamped = min(max(freq, 1), sr / 2 - 1)
            let a = pow(10, gainDb / 40)
            let omega = (2 * Double.pi * clamped) / sr
            let alpha = sin(omega) / (2 * max(q, 1e-4))
            let cosw = cos(omega)
            setBiquad(
                mem, freq, gainDb, q, sr,
                1 + alpha * a, -2 * cosw, 1 - alpha * a,
                1 + alpha / a, -2 * cosw, 1 - alpha / a
            )
        }
        return tickBiquad(mem, input)
    }

    func evalShelf(_ node: PlanNode, _ state: VoiceState, _ sr: Double, low: Bool) -> Double {
        let input = ev(node, .input, state, sr)
        let freq = ev(node, .freq, state, sr)
        let gainDb = ev(node, .gainDb, state, sr)
        let q = ev(node, .q, state, sr)
        let mem = state.memory(for: node.slot)

        if gainDb == 0 {
            // At 0 dB the coefficients degenerate to identity, so take the
            // exact bypass rather than a near-bypass.
            mem.pointee.x2 = mem.pointee.x1
            mem.pointee.x1 = input
            mem.pointee.y2 = mem.pointee.y1
            mem.pointee.y1 = input
            // Invalidated rather than left holding whatever preceded bypass,
            // so leaving it recomputes.
            mem.pointee.k0 = Double.nan
            return input
        }

        if mem.pointee.k0 != freq || mem.pointee.k1 != gainDb || mem.pointee.k2 != q || mem.pointee.k3 != sr {
            let clamped = min(max(freq, 1), sr / 2 - 1)
            let a = pow(10, gainDb / 40)
            let omega = (2 * Double.pi * clamped) / sr
            let sinw = sin(omega)
            let cosw = cos(omega)
            let alpha = (sinw / 2) * ((a + 1 / a) * (1 / max(q, 1e-4) - 1) + 2).squareRoot()
            let sqA = a.squareRoot()
            var a0 = 0.0, a1 = 0.0, a2 = 0.0, b0 = 0.0, b1 = 0.0, b2 = 0.0
            if low {
                a0 = a + 1 + (a - 1) * cosw + 2 * sqA * alpha
                b0 = a * (a + 1 - (a - 1) * cosw + 2 * sqA * alpha)
                b1 = 2 * a * (a - 1 - (a + 1) * cosw)
                b2 = a * (a + 1 - (a - 1) * cosw - 2 * sqA * alpha)
                a1 = -2 * (a - 1 + (a + 1) * cosw)
                a2 = a + 1 + (a - 1) * cosw - 2 * sqA * alpha
            } else {
                a0 = a + 1 - (a - 1) * cosw + 2 * sqA * alpha
                b0 = a * (a + 1 + (a - 1) * cosw + 2 * sqA * alpha)
                b1 = -2 * a * (a - 1 + (a + 1) * cosw)
                b2 = a * (a + 1 + (a - 1) * cosw - 2 * sqA * alpha)
                a1 = 2 * (a - 1 - (a + 1) * cosw)
                a2 = a + 1 - (a - 1) * cosw - 2 * sqA * alpha
            }
            setBiquad(mem, freq, gainDb, q, sr, b0, b1, b2, a0, a1, a2)
        }
        return tickBiquad(mem, input)
    }

    func evalAllpass(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let cutoff = ev(node, .cutoff, state, sr)
        let q = ev(node, .q, state, sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.k0 != cutoff || mem.pointee.k1 != q || mem.pointee.k2 != sr {
            let clamped = min(max(cutoff, 1), sr / 2 - 1)
            let omega = (2 * Double.pi * clamped) / sr
            let sinw = sin(omega)
            let cosw = cos(omega)
            let alpha = sinw / (2 * max(q, 1e-4))
            setBiquad(mem, cutoff, q, sr, 0, 1 - alpha, -2 * cosw, 1 + alpha, 1 + alpha, -2 * cosw, 1 - alpha)
        }
        return tickBiquad(mem, input)
    }

    // MARK: One-pole and state-variable filters

    func evalOnePole(_ node: PlanNode, _ state: VoiceState, _ sr: Double, low: Bool) -> Double {
        let input = ev(node, .input, state, sr)
        let cutoff = ev(node, .cutoff, state, sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.k0 != cutoff || mem.pointee.k1 != sr {
            let clamped = min(max(cutoff, 1), sr / 2 - 1)
            mem.pointee.c0 = 1 - exp((-2 * Double.pi * clamped) / sr)
            mem.pointee.k0 = cutoff
            mem.pointee.k1 = sr
        }
        mem.pointee.s0 += mem.pointee.c0 * (input - mem.pointee.s0)
        return low ? mem.pointee.s0 : input - mem.pointee.s0
    }

    func evalSvf(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let cutoff = ev(node, .cutoff, state, sr)
        let q = ev(node, .q, state, sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.k0 != cutoff || mem.pointee.k1 != sr {
            let clamped = min(max(cutoff, 1), sr * 0.25)
            mem.pointee.c0 = 2 * sin((Double.pi * clamped) / sr)
            mem.pointee.k0 = cutoff
            mem.pointee.k1 = sr
        }
        // Cheap enough to keep unconditional; there is no transcendental in it.
        let damp = min(1.98, max(0.05, 1 / max(q, 0.05)))
        let f = mem.pointee.c0
        mem.pointee.s0 += f * mem.pointee.s1
        let high = input - mem.pointee.s0 - damp * mem.pointee.s1
        mem.pointee.s1 += f * high
        if node.m == 1 { return high }
        if node.m == 2 { return mem.pointee.s1 }
        return mem.pointee.s0
    }

    func evalLadder(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let cutoff = ev(node, .cutoff, state, sr)
        let resonance = ev(node, .resonance, state, sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.k0 != cutoff || mem.pointee.k1 != sr {
            let clamped = min(max(cutoff, 1), sr / 2 - 1)
            mem.pointee.c0 = 1 - exp((-2 * Double.pi * clamped) / sr)
            mem.pointee.k0 = cutoff
            mem.pointee.k1 = sr
        }
        let g = mem.pointee.c0
        let k = min(max(resonance, 0), 0.99) * 4
        let x = input - k * tanh(mem.pointee.s3)
        mem.pointee.s0 += g * (x - mem.pointee.s0)
        mem.pointee.s1 += g * (mem.pointee.s0 - mem.pointee.s1)
        mem.pointee.s2 += g * (mem.pointee.s1 - mem.pointee.s2)
        mem.pointee.s3 += g * (mem.pointee.s2 - mem.pointee.s3)
        return mem.pointee.s3
    }

    func evalFilterSlope(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let cutoff = ev(node, .cutoff, state, sr)
        let poles = Int(node.c)
        let highpass = node.m == 1
        let mem = state.memory(for: node.slot)
        if mem.pointee.k0 != cutoff || mem.pointee.k1 != sr {
            let clamped = min(max(cutoff, 1), sr / 2 - 1)
            mem.pointee.c0 = 1 - exp((-2 * Double.pi * clamped) / sr)
            mem.pointee.k0 = cutoff
            mem.pointee.k1 = sr
        }
        let g = mem.pointee.c0
        var x = input
        for i in 0..<poles {
            switch i {
            case 0:
                mem.pointee.s0 += g * (x - mem.pointee.s0)
                x = highpass ? x - mem.pointee.s0 : mem.pointee.s0
            case 1:
                mem.pointee.s1 += g * (x - mem.pointee.s1)
                x = highpass ? x - mem.pointee.s1 : mem.pointee.s1
            case 2:
                mem.pointee.s2 += g * (x - mem.pointee.s2)
                x = highpass ? x - mem.pointee.s2 : mem.pointee.s2
            default:
                mem.pointee.s3 += g * (x - mem.pointee.s3)
                x = highpass ? x - mem.pointee.s3 : mem.pointee.s3
            }
        }
        return x
    }

    func evalComb(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let freq = ev(node, .freq, state, sr)
        let feedback = ev(node, .feedback, state, sr)
        let wet = ev(node, .mix, state, sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.buf.isEmpty {
            mem.pointee.buf = [Float](repeating: 0, count: Int(max(2, (sr / 20).rounded(.up) + 2)))
        }
        let len = Double(mem.pointee.buf.count)
        let delaySamples = min(max(sr / max(freq, 20), 1), len - 2)
        let read = Double(mem.pointee.writeIdx) - delaySamples
        let i0 = Int(jsMod(jsMod(read.rounded(.down), len) + len, len))
        let i1 = (i0 + 1) % mem.pointee.buf.count
        let frac = read - read.rounded(.down)
        let delayed = Double(mem.pointee.buf[i0]) * (1 - frac) + Double(mem.pointee.buf[i1]) * frac
        mem.pointee.buf[mem.pointee.writeIdx] = Float(input + delayed * min(max(feedback, -0.99), 0.99))
        mem.pointee.writeIdx = (mem.pointee.writeIdx + 1) % mem.pointee.buf.count
        let mix = min(max(wet, 0), 1)
        return input * (1 - mix) + delayed * mix
    }

    func evalDelay(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let timeSec = ev(node, .timeSec, state, sr)
        let feedback = ev(node, .feedback, state, sr)
        let wet = ev(node, .mix, state, sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.buf.isEmpty {
            // Sized once. The line length is a graph constant; re-deriving it
            // per sample was work for an answer only this line ever reads.
            let maxTimeSec = max(node.c, 1 / sr)
            mem.pointee.buf = [Float](repeating: 0, count: Int(max(2, (maxTimeSec * sr).rounded(.up) + 2)))
        }
        let len = Double(mem.pointee.buf.count)
        let delaySamples = min(max(timeSec, 0) * sr, len - 2)
        let read = Double(mem.pointee.writeIdx) - delaySamples
        let i0 = Int(jsMod(jsMod(read.rounded(.down), len) + len, len))
        let i1 = (i0 + 1) % mem.pointee.buf.count
        let frac = read - read.rounded(.down)
        let delayed = Double(mem.pointee.buf[i0]) * (1 - frac) + Double(mem.pointee.buf[i1]) * frac
        mem.pointee.buf[mem.pointee.writeIdx] = Float(input + delayed * min(max(feedback, -0.99), 0.99))
        mem.pointee.writeIdx = (mem.pointee.writeIdx + 1) % mem.pointee.buf.count
        let mix = min(max(wet, 0), 1)
        return input * (1 - mix) + delayed * mix
    }

    func evalReverse(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let timeSec = max(ev(node, .timeSec, state, sr), 1 / sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.buf.isEmpty {
            let maxTimeSec = max(node.c, 1 / sr)
            mem.pointee.buf = [Float](repeating: 0, count: Int(max(2, (maxTimeSec * sr).rounded(.up))))
        }
        let span = Int(min(max(jsRound(timeSec * sr), 2), Double(mem.pointee.buf.count)))
        mem.pointee.buf[mem.pointee.writeIdx % span] = Float(input)
        mem.pointee.writeIdx += 1
        mem.pointee.readIdx = (mem.pointee.readIdx - 1 + span) % span
        return mem.pointee.readIdx < mem.pointee.buf.count ? Double(mem.pointee.buf[mem.pointee.readIdx]) : 0
    }

    func evalLooper(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let rec = ev(node, .record, state, sr) > 0.5
        let mem = state.memory(for: node.slot)
        if mem.pointee.buf.isEmpty {
            let maxTimeSec = max(node.c, 1 / sr)
            mem.pointee.buf = [Float](repeating: 0, count: Int(max(2, (maxTimeSec * sr).rounded(.up))))
        }
        let clearing = node.has(.trigger) ? ev(node, .trigger, state, sr) > 0.5 : false
        if clearing && !mem.pointee.armed {
            mem.pointee.writeIdx = 0
            mem.pointee.length = 0
            mem.pointee.readIdx = 0
        }
        mem.pointee.armed = clearing
        let cap: Int
        if node.has(.duration) {
            let dur = max(ev(node, .duration, state, sr), 1 / sr)
            cap = min(mem.pointee.buf.count, max(2, Int((dur * sr).rounded(.up))))
        } else {
            cap = mem.pointee.buf.count
        }
        if rec && !mem.pointee.prevGate {
            mem.pointee.writeIdx = 0
            mem.pointee.length = 0
            mem.pointee.readIdx = 0
        }
        mem.pointee.prevGate = rec
        if rec {
            if mem.pointee.writeIdx < cap {
                mem.pointee.buf[mem.pointee.writeIdx] = Float(input)
                mem.pointee.writeIdx += 1
                mem.pointee.length = mem.pointee.writeIdx
            }
            return node.m == 0 ? input : 0
        }
        let playLen = min(mem.pointee.length, cap)
        if playLen <= 0 { return 0 }
        if mem.pointee.readIdx >= playLen { mem.pointee.readIdx = 0 }
        let start = mem.pointee.readIdx == 0 ? 1.0 : 0.0
        let end = mem.pointee.readIdx == playLen - 1 ? 1.0 : 0.0
        let out = mem.pointee.readIdx < mem.pointee.buf.count ? Double(mem.pointee.buf[mem.pointee.readIdx]) : 0
        mem.pointee.readIdx = (mem.pointee.readIdx + 1) % playLen
        if node.m == 1 { return start }
        if node.m == 2 { return end }
        return out
    }

    // MARK: Dynamics

    /// The follower coefficient for `time`, cached in whichever of the two
    /// slots belongs to this direction. `1 - exp(-1 / (time * sampleRate))` is
    /// a transcendental per sample, twice over in a compressor, for two
    /// numbers a knob changes a few times a second at most.
    @inline(__always) private func followerCoeff(_ mem: UnsafeMutablePointer<NodeMemory>, _ time: Double, _ sr: Double, rising: Bool) -> Double {
        if mem.pointee.k0 != sr {
            mem.pointee.k0 = sr
            mem.pointee.ka = Double.nan
            mem.pointee.kr = Double.nan
        }
        if rising {
            if mem.pointee.ka != time {
                mem.pointee.ca = 1 - exp(-1 / (time * sr))
                mem.pointee.ka = time
            }
            return mem.pointee.ca
        }
        if mem.pointee.kr != time {
            mem.pointee.cr = 1 - exp(-1 / (time * sr))
            mem.pointee.kr = time
        }
        return mem.pointee.cr
    }

    func evalEnvFollow(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let attack = max(ev(node, .attack, state, sr), 1e-5)
        let release = max(ev(node, .release, state, sr), 1e-5)
        let mem = state.memory(for: node.slot)
        let target = abs(input)
        let rising = target > mem.pointee.env
        mem.pointee.env += (target - mem.pointee.env) * followerCoeff(mem, rising ? attack : release, sr, rising: rising)
        return mem.pointee.env
    }

    func evalCompressor(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let detect = node.has(.sidechain)
            ? ev(node, .sidechain, state, sr)
            : input
        let threshold = max(ev(node, .threshold, state, sr), 1e-6)
        let ratio = max(ev(node, .ratio, state, sr), 1)
        let attack = max(ev(node, .attack, state, sr), 1e-5)
        let release = max(ev(node, .release, state, sr), 1e-5)
        let mem = state.memory(for: node.slot)
        let target = abs(detect)
        let rising = target > mem.pointee.env
        mem.pointee.env += (target - mem.pointee.env) * followerCoeff(mem, rising ? attack : release, sr, rising: rising)
        if mem.pointee.env <= threshold { return input }
        return input * pow(threshold / mem.pointee.env, 1 - 1 / ratio)
    }

    func evalExpander(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let threshold = max(ev(node, .threshold, state, sr), 1e-6)
        let ratio = max(ev(node, .ratio, state, sr), 1)
        let attack = max(ev(node, .attack, state, sr), 1e-5)
        let release = max(ev(node, .release, state, sr), 1e-5)
        let mem = state.memory(for: node.slot)
        let target = abs(input)
        let rising = target > mem.pointee.env
        mem.pointee.env += (target - mem.pointee.env) * followerCoeff(mem, rising ? attack : release, sr, rising: rising)
        if mem.pointee.env >= threshold { return input }
        return input * pow(max(mem.pointee.env, 1e-6) / threshold, ratio - 1)
    }

    func evalTransient(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let attackAmt = ev(node, .attack, state, sr)
        let sustainAmt = ev(node, .sustain, state, sr)
        let mem = state.memory(for: node.slot)
        // Both coefficients are functions of the sample rate alone: 3 ms and
        // 80 ms are the design, not parameters.
        if mem.pointee.k0 != sr {
            mem.pointee.c0 = 1 - exp(-1 / (0.003 * sr))
            mem.pointee.c1 = 1 - exp(-1 / (0.08 * sr))
            mem.pointee.k0 = sr
        }
        let target = abs(input)
        mem.pointee.s0 += (target - mem.pointee.s0) * mem.pointee.c0
        mem.pointee.s1 += (target - mem.pointee.s1) * mem.pointee.c1
        let delta = mem.pointee.s0 - mem.pointee.s1
        let gain = max(0, 1 + attackAmt * max(delta, 0) * 4 + sustainAmt * mem.pointee.s1)
        return input * gain
    }

    func evalRms(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let windowSec = max(ev(node, .windowSec, state, sr), 1 / sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.buf.isEmpty {
            mem.pointee.buf = [Float](repeating: 0, count: Int(max(2, jsRound(windowSec * sr))))
        }
        let sq = input * input
        mem.pointee.sum += sq - Double(mem.pointee.buf[mem.pointee.writeIdx])
        mem.pointee.buf[mem.pointee.writeIdx] = Float(sq)
        mem.pointee.writeIdx = (mem.pointee.writeIdx + 1) % mem.pointee.buf.count
        mem.pointee.filled = min(mem.pointee.filled + 1, Double(mem.pointee.buf.count))
        return (max(mem.pointee.sum, 0) / mem.pointee.filled).squareRoot()
    }

    func evalPeak(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let release = max(ev(node, .release, state, sr), 1e-5)
        let mem = state.memory(for: node.slot)
        let target = abs(input)
        if target > mem.pointee.peak {
            mem.pointee.peak = target
        } else {
            if mem.pointee.k0 != release || mem.pointee.k1 != sr {
                mem.pointee.c0 = exp(-1 / (release * sr))
                mem.pointee.k0 = release
                mem.pointee.k1 = sr
            }
            mem.pointee.peak *= mem.pointee.c0
        }
        return mem.pointee.peak
    }

    func evalOnset(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let threshold = ev(node, .threshold, state, sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.k0 != sr {
            mem.pointee.c0 = 1 - exp(-1 / (0.005 * sr))
            mem.pointee.k0 = sr
        }
        let target = abs(input)
        mem.pointee.env += (target - mem.pointee.env) * mem.pointee.c0
        let delta = mem.pointee.env - mem.pointee.prev
        mem.pointee.prev = mem.pointee.env
        return delta > threshold ? 1 : 0
    }

    func evalPitch(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let mem = state.memory(for: node.slot)
        if mem.pointee.buf.isEmpty {
            mem.pointee.buf = [Float](repeating: 0, count: 1024)
        }
        let cap = mem.pointee.buf.count
        mem.pointee.buf[mem.pointee.writeIdx] = Float(input)
        mem.pointee.writeIdx = (mem.pointee.writeIdx + 1) % cap
        mem.pointee.count += 1
        if mem.pointee.count >= Double(cap) && Int(mem.pointee.count) % 512 == 0 {
            var peak = 0.0
            var lastSign = 0
            var first = -1
            var last = -1
            var crossings = 0
            for i in 0..<cap {
                let sample = Double(mem.pointee.buf[(mem.pointee.writeIdx + i) % cap])
                let mag = sample < 0 ? -sample : sample
                if mag > peak { peak = mag }
                let sign = sample > 0 ? 1 : sample < 0 ? -1 : 0
                if lastSign < 0 && sign > 0 {
                    if first < 0 { first = i }
                    last = i
                    crossings += 1
                }
                if sign != 0 { lastSign = sign }
            }
            let span = last - first
            let minPeriod = sr / 2000
            let maxPeriod = sr / 50
            if peak >= 0.01 && crossings >= 2 && span > 0 {
                let period = Double(span) / Double(crossings - 1)
                if period >= minPeriod && period <= maxPeriod {
                    let hz = sr / period
                    let midi = 69 + 12 * log2(hz / 440)
                    mem.pointee.held = hz
                    mem.pointee.env = midi
                    let nearest = midi.rounded()
                    let cents = (midi - nearest) * 100
                    mem.pointee.prev = cents == 50 ? -50 : cents
                    mem.pointee.on = 1
                } else {
                    mem.pointee.on = 0
                }
            } else {
                mem.pointee.on = 0
            }
        }
        if node.m == 1 { return mem.pointee.env }
        if node.m == 2 { return mem.pointee.prev }
        if node.m == 3 { return mem.pointee.on }
        return mem.pointee.held
    }

    // MARK: Clocks and patterns

    func evalClockMultiply(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let factor = max(1, jsRound(ev(node, .factor, state, sr)))
        let mem = state.memory(for: node.slot)
        let rose = input > 0.5 && mem.pointee.prev <= 0.5
        mem.pointee.prev = input
        if rose {
            if mem.pointee.armed && mem.pointee.since > 0 {
                mem.pointee.interval = mem.pointee.since / factor
                mem.pointee.nextAt = 0
                mem.pointee.left = factor
            }
            mem.pointee.since = 0
            mem.pointee.armed = true
        }
        var out = 0.0
        if mem.pointee.left > 0 && mem.pointee.since >= mem.pointee.nextAt {
            out = 1
            mem.pointee.nextAt += mem.pointee.interval
            mem.pointee.left -= 1
        }
        mem.pointee.since += 1
        return out
    }

    func evalEuclidean(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let steps = ev(node, .steps, state, sr)
        let hits = ev(node, .hits, state, sr)
        let rotation = ev(node, .rotation, state, sr)
        let mem = state.memory(for: node.slot)
        let rose = input > 0.5 && mem.pointee.prev <= 0.5
        mem.pointee.prev = input
        if !rose { return 0 }
        let n = max(1, steps.rounded(.down))
        mem.pointee.index = jsMod(mem.pointee.index + 1, n)
        // The pattern only depends on the three settings, so rebuilding it on
        // every hit was allocating on the audio thread for an answer that had
        // not changed since the last bar.
        if mem.pointee.pattern.isEmpty || mem.pointee.k0 != n || mem.pointee.k1 != hits || mem.pointee.k2 != rotation {
            mem.pointee.pattern = euclideanPattern(n, hits, rotation)
            mem.pointee.k0 = n
            mem.pointee.k1 = hits
            mem.pointee.k2 = rotation
        }
        let index = Int(mem.pointee.index)
        return index >= 0 && index < mem.pointee.pattern.count && mem.pointee.pattern[index] ? 1 : 0
    }

    func evalRandom(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let freq = max(ev(node, .freq, state, sr), 0)
        let mem = state.memory(for: node.slot)
        if !mem.pointee.initialized {
            mem.pointee.phase = 1
            mem.pointee.initialized = true
        }
        mem.pointee.phase += freq / sr
        if mem.pointee.phase >= 1 {
            mem.pointee.phase -= mem.pointee.phase.rounded(.down)
            // s0 is the value being left, s1 the one being approached.
            mem.pointee.s0 = mem.pointee.s1
            mem.pointee.s1 = Double.random(in: 0..<1) * 2 - 1
        }
        if node.m == 1 { return mem.pointee.s0 + (mem.pointee.s1 - mem.pointee.s0) * mem.pointee.phase }
        return mem.pointee.s1
    }

    // MARK: Sources

    func evalNoise(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let white = Double.random(in: 0..<1) * 2 - 1
        let color = node.has(.color)
            ? min(5, max(0, Int(jsRound(ev(node, .color, state, sr)))))
            : node.m
        if color == 0 { return white }
        let mem = state.memory(for: node.slot)
        func pink() -> Double {
            mem.pointee.s0 = 0.99886 * mem.pointee.s0 + white * 0.0555179
            mem.pointee.s1 = 0.99332 * mem.pointee.s1 + white * 0.0750759
            mem.pointee.s2 = 0.969 * mem.pointee.s2 + white * 0.153852
            return min(1, max(-1, (mem.pointee.s0 + mem.pointee.s1 + mem.pointee.s2 + white * 0.3104856) * 0.55))
        }
        func brown() -> Double {
            mem.pointee.s3 = (mem.pointee.s3 + white * 0.02) * 0.996
            return min(1, max(-1, mem.pointee.s3 * 3.5))
        }
        if color == 1 { return pink() }
        if color == 2 { return brown() }
        if color == 3 {
            let p = pink()
            let blue = (p - mem.pointee.held) * 8
            mem.pointee.held = p
            return min(1, max(-1, blue))
        }
        if color == 4 {
            let violet = (white - mem.pointee.prev) * 0.85
            mem.pointee.prev = white
            return min(1, max(-1, violet))
        }
        let p = pink()
        let b = brown()
        return min(1, max(-1, p * 0.65 + (white - b * 0.35) * 0.4))
    }

    func evalWavetable(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let freq = ev(node, .freq, state, sr)
        let table = node.table
        if table.isEmpty { return 0 }
        let mem = state.memory(for: node.slot)
        let n = table.count
        let requested = node.c > 0 ? max(1, Int(node.c.rounded())) : n
        let frameSize = n >= requested * 2 ? requested : n
        let frames = max(1, n / frameSize)
        func lookup(_ frame: Int) -> Double {
            let base = frame * frameSize
            let idx = mem.pointee.phase * Double(frameSize)
            let i0 = Int(jsMod(jsMod(idx.rounded(.down), Double(frameSize)) + Double(frameSize), Double(frameSize)))
            let i1 = (i0 + 1) % frameSize
            let frac = idx - idx.rounded(.down)
            return Double(table[base + i0]) * (1 - frac) + Double(table[base + i1]) * frac
        }
        var out = lookup(0)
        if frames > 1 && node.has(.position) {
            let position = min(1, max(0, ev(node, .position, state, sr)))
            let f = position * Double(frames - 1)
            let f0 = Int(f.rounded(.down))
            let f1 = min(frames - 1, f0 + 1)
            let frac = f - Double(f0)
            out = lookup(f0) * (1 - frac) + lookup(f1) * frac
        }
        mem.pointee.phase = jsMod(mem.pointee.phase + freq / sr, 1)
        return out
    }

    func evalSamplePlay(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let rate = ev(node, .rate, state, sr)
        let gated = node.has(.gate)
            ? ev(node, .gate, state, sr) > 0.5
            : state.gate
        let table = node.table
        let srcRate = node.boxRate > 0 ? node.boxRate : sr
        let last = Double(max(table.count - 1, 0))
        let startPos = node.has(.position)
            ? min(max(ev(node, .position, state, sr), 0), 1) * last
            : 0
        let looping = node.has(.length) ? ev(node, .length, state, sr) > 0.5 : false
        let pitchSt = node.has(.pitch) ? ev(node, .pitch, state, sr) : 0
        let mem = state.memory(for: node.slot)
        if gated && !mem.pointee.prevGate {
            mem.pointee.pos = startPos
            mem.pointee.playing = !table.isEmpty
        }
        mem.pointee.prevGate = gated
        if !mem.pointee.playing || table.count < 2 { return 0 }
        if mem.pointee.pos >= last {
            if looping && last > startPos {
                let span = last - startPos
                mem.pointee.pos = startPos + jsMod(mem.pointee.pos - startPos, span)
            } else {
                mem.pointee.playing = false
                return 0
            }
        }
        let i0 = Int(mem.pointee.pos.rounded(.down))
        let frac = mem.pointee.pos - Double(i0)
        let out = Double(table[i0]) * (1 - frac) + Double(table[i0 + 1]) * frac
        mem.pointee.pos += max(rate, 0) * pow(2, pitchSt / 12) * (srcRate / sr)
        return out
    }

    func evalGrain(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let duration = max(ev(node, .duration, state, sr), 1 / sr)
        let position = ev(node, .position, state, sr)
        let rate = ev(node, .rate, state, sr)
        let trig = ev(node, .trigger, state, sr)
        let table = node.table
        let mem = state.memory(for: node.slot)
        let rose = trig > 0.5 && mem.pointee.prev <= 0.5
        mem.pointee.prev = trig
        if rose && !table.isEmpty {
            let n = max(2, jsRound(duration * sr))
            let start = min(max(position, 0), 1) * Double(max(table.count - 1, 0))
            mem.pointee.grains.append(Grain(pos: start, i: 0, n: n, rate: max(rate, 0)))
            if mem.pointee.grains.count > 8 { mem.pointee.grains.removeFirst() }
        }
        var out = 0.0
        var g = mem.pointee.grains.count - 1
        while g >= 0 {
            if mem.pointee.grains[g].i >= mem.pointee.grains[g].n || table.isEmpty {
                mem.pointee.grains.remove(at: g)
                g -= 1
                continue
            }
            let i0 = Int(mem.pointee.grains[g].pos.rounded(.down))
            if i0 < 0 || i0 >= table.count - 1 {
                mem.pointee.grains.remove(at: g)
                g -= 1
                continue
            }
            let frac = mem.pointee.grains[g].pos - Double(i0)
            let hann = 0.5 * (1 - cos((2 * Double.pi * mem.pointee.grains[g].i) / mem.pointee.grains[g].n))
            out += (Double(table[i0]) * (1 - frac) + Double(table[i0 + 1]) * frac) * hann
            mem.pointee.grains[g].pos += mem.pointee.grains[g].rate
            mem.pointee.grains[g].i += 1
            g -= 1
        }
        return out
    }

    func evalPitchShift(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let input = ev(node, .input, state, sr)
        let raw = ev(node, .pitch, state, sr)
        let pitch = node.m == 1 ? pow(2, raw / 12) : max(raw, 0.25)
        let grain = max(32, jsRound(0.04 * sr))
        let mem = state.memory(for: node.slot)
        if mem.pointee.buf.isEmpty { mem.pointee.buf = [Float](repeating: 0, count: Int(grain * 4)) }
        mem.pointee.buf[mem.pointee.writeIdx] = Float(input)
        let len = Double(mem.pointee.buf.count)
        func readAt(_ offset: Double) -> Double {
            let pos = jsMod(Double(mem.pointee.writeIdx) - offset + len * 8, len)
            let i0 = Int(pos.rounded(.down))
            let i1 = (i0 + 1) % mem.pointee.buf.count
            let frac = pos - pos.rounded(.down)
            return Double(mem.pointee.buf[i0]) * (1 - frac) + Double(mem.pointee.buf[i1]) * frac
        }
        func hann(_ t: Double) -> Double { 0.5 * (1 - cos(2 * Double.pi * t)) }
        let o1 = jsMod(mem.pointee.phase, grain)
        let o2 = jsMod(mem.pointee.phase + grain / 2, grain)
        let out = readAt(o1) * hann(o1 / grain) + readAt(o2) * hann(o2 / grain)
        mem.pointee.phase = jsMod(mem.pointee.phase + pitch, grain * 2)
        mem.pointee.writeIdx = (mem.pointee.writeIdx + 1) % mem.pointee.buf.count
        return out
    }

    // MARK: Transport and kernels

    /// Every field is derived from the block snapshot plus the frame index,
    /// with no stored state. A transport node asked for the same frame twice
    /// answers the same thing, which is what a seam graph's collect and apply
    /// passes need.
    func evalTransport(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        let snapshot = state.transport ?? TransportSnapshot()

        if node.m == 2 { return snapshot.bpm }
        if node.m == 3 { return snapshot.playing ? 1 : 0 }
        if node.m == 8 { return snapshot.beatsPerBar > 0 ? snapshot.beatsPerBar : 4 }
        if node.m == 9 { return snapshot.beatUnit > 0 ? snapshot.beatUnit : 4 }
        if node.m == 7 {
            let table = node.a
            if table.isEmpty { return 1 }
            let index = Int(jsRound(ev(node, .index, state, sr)))
            return table[min(table.count - 1, max(0, index))]
        }
        if node.m == 6 {
            let length = ev(node, .length, state, sr)
            return snapshot.bpm > 0 ? (length * 60) / snapshot.bpm : 0
        }

        // A stopped transport holds its position rather than advancing, so a
        // synced LFO sits still under a paused playhead instead of sweeping.
        let perSample = snapshot.playing ? snapshot.bpm / 60 / sr : 0
        let beats = snapshot.beats + Double(state.frameIndex) * perSample

        if node.m == 0 { return beats }
        if node.m == 1 {
            let perBar = snapshot.beatsPerBar > 0 ? snapshot.beatsPerBar : 4
            let unit = snapshot.beatUnit > 0 ? snapshot.beatUnit : 4
            let quarters = perBar * (4 / unit)
            return quarters > 0 ? beats / quarters : 0
        }

        let length = ev(node, .length, state, sr)
        if !(length > 0) { return 0 }

        if node.m == 4 {
            let turns = beats / length
            return turns - turns.rounded(.down)
        }
        if node.m == 5 {
            if perSample == 0 { return 0 }
            // A boundary was crossed between the previous sample and this one.
            // Comparing floors rather than testing a wrapped phase against a
            // small window means the pulse lands on exactly one sample at any
            // tempo.
            let previous = beats - perSample
            return (beats / length).rounded(.down) != (previous / length).rounded(.down) ? 1 : 0
        }
        return 0
    }

    func evalKernel(_ node: PlanNode, _ state: VoiceState, _ sr: Double) -> Double {
        if node.m != 0 {
            // Only meaningful as the graph output, where renderBlock handles
            // it before the tree is ever walked.
            return 0
        }
        let processor = state.kernels[node.kernelSlot]
        if processor != nil && seamPhase == .collect {
            let input = ev(node, .input, state, sr)
            if seamBuffers[node.slot] != nil, seamIndex < seamBuffers[node.slot]!.input.count {
                seamBuffers[node.slot]!.input[seamIndex] = Float(input)
            }
            return 0
        }
        if processor != nil && seamPhase == .apply {
            guard let buffers = seamBuffers[node.slot], seamIndex < buffers.output.count else { return 0 }
            return Double(buffers.output[seamIndex])
        }
        let input = ev(node, .input, state, sr)
        // No bound kernel, or a kernel with no per-sample path: pass through
        // rather than emit silence, so a Material whose asset never loaded
        // still sounds like the rest of its graph.
        return processor?.processSeamSample(input) ?? input
    }
}
