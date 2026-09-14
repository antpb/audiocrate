# Editor materials

Palette modules and their parameters.

`kind` is the crate.patch key. A menu param is an index, a switch is 0 or 1.
A cable into a param jack is CV. Unipolar sources (ADSR, clocks) map 0 to min and 1 to max.
Bipolar sources (LFO) map -1..1 across that range. At most ten param jacks (`MAX_CV_JACKS`).

Generated from the catalog. After an AudioMaterial change, run:

```bash
npm run test:editor
```

Amp, Grain, Synth, Space Reverb, and IR are WASM kernels, not ASL.

## Contents

- [Tools](#tools)
- [Sources](#sources)
- [Filters](#filters)
- [Dynamics](#dynamics)
- [Shape](#shape)
- [Time](#time)
- [Control](#control)
- [Routing](#routing)
- [Analysis](#analysis)
- [Stereo](#stereo)
- [Spatial](#spatial)
- [Plugins](#plugins)

## Tools

### Keyboard (`keyboard`)

Host note source. cv is last-note 1V/oct. note/gate/velocity cables allocate poly voices.

- Jacks: in none / out cv, gate, trig, velocity

No parameters.

### Line / Mic (`line`)

Live input from this machine's audio interface or mic. Device assignment is not sent to a session.

- Jacks: in none / out audio

No parameters.

### MIDI In (`midiin`)

Live MIDI input from one device on this machine. Device assignment is not sent to a session. Last-note analog like Keyboard. Channel 0 is omni. note/gate cables allocate poly voices.

- Jacks: in none / out cv, gate, trig, velocity, note, cc

No parameters.

### MIDI Out (`midiout`)

Live MIDI output to one device on this machine. Device assignment is not sent to a session. Gate holds the voice. Trig is the event: a pulse plus a note. Channel and message do sync.

- Jacks: in note, cv(cv), gate, trig, velocity, cc(cv) / out none

No parameters.

### MIDI Clip (`midiclip`)

Piano-roll clip. Start, loop, pitch, rate, and velocity match Sample Player.

- Jacks: in none / out cv, gate, trig, velocity

No parameters.

### Master (`master`)

The only output. Patch here to hear it.

- Jacks: in input(audio) / out none

No parameters.

## Sources

### Oscillator (`oscillator`)

Keyboard voice. Eight waves, octave and detune, a short amp envelope.

- Jacks: in note, gate, velocity, gain(cv), width(cv), octave(cv), detune(cv), attack(cv), decay(cv), sustain(cv), release(cv) / out audio
- Voices: 8 (oldest steal)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `type` | menu | 0 Sine, 1 Saw, 2 Square, 3 Triangle, 4 Pulse, 5 VarShape, 6 SuperSquare, 7 Harmonic | Saw |  |
| `width` | fader | 0..1 | 0.5 | yes |
| `octave` | stepper | -2..2 step 1 | 0 | yes |
| `detune` | fader | -100..100 ct | 0 ct | yes |
| `gain` | fader | 0..1 | 0.4 | yes |
| `attack` | fader | 0.001..2 s exp | 0.01 s | yes |
| `decay` | fader | 0.001..2 s exp | 0.08 s | yes |
| `sustain` | fader | 0..1 | 0.7 | yes |
| `release` | fader | 0.001..4 s exp | 0.2 s | yes |

### Tone (`tone`)

Free-running sine. Sounds on Play without a Keyboard. freq is a CV jack.

- Jacks: in freq(cv), gain(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `freq` | fader | 20..4000 Hz log | 220 Hz | yes |
| `gain` | fader | 0..1 | 0.22 | yes |

### Noise (`noise`)

Six spectral colors through a lowpass. White is flat, brown is rumble, blue and violet get brighter.

- Jacks: in gain(cv), cutoff(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `color` | menu | 0 White, 1 Pink, 2 Brown, 3 Blue, 4 Violet, 5 Grey | White |  |
| `gain` | fader | 0..1 | 0.2 | yes |
| `cutoff` | fader | 80..16000 Hz log | 4000 Hz | yes |

### Impulse (`impulse`)

A one-sample click on a rising gate. For pinging filters and starting envelopes.

- Jacks: in input(audio) / out audio

No parameters.

### Wavetable (`wavetable`)

Polyphonic scanner over eight single-cycle frames, or a loaded table of 256-sample frames.

- Jacks: in note, gate, velocity, position(cv), octave(cv), detune(cv), gain(cv), attack(cv), release(cv) / out audio
- Voices: 8 (oldest steal)
- File: Optional table. 512+ samples become 256-sample frames. Clear restores the factory bank.

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `position` | fader | 0..1 | 0.28 | yes |
| `octave` | stepper | -2..2 step 1 | 0 | yes |
| `detune` | fader | -100..100 ct | 0 ct | yes |
| `gain` | fader | 0..1 | 0.4 | yes |
| `attack` | fader | 0.001..2 s exp | 0.01 s | yes |
| `decay` | fader | 0.001..2 s exp | 0.08 s |  |
| `sustain` | fader | 0..1 | 0.7 |  |
| `release` | fader | 0.001..4 s exp | 0.2 s | yes |

### Sample Player (`sampleplayer`)

Plays a loaded file on a gate. Silent until you choose a file. Pitch is semitones.

- Jacks: in input(audio), rate(cv), start(cv), pitch(cv), gain(cv), loop(cv) / out audio
- File: Sample. Silent until a file is loaded.

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `rate` | fader | 0.25..4 | 1 | yes |
| `start` | fader | 0..1 | 0 | yes |
| `loop` | switch | 0 One-shot, 1 Loop | One-shot | yes |
| `pitch` | fader | -12..12 st | 0 st | yes |
| `gain` | fader | 0..2 | 0.85 | yes |

### Synth Voice (`SynthVoice`)

Subtractive voice: wave plus a detuned twin, a lowpass, and an amp envelope that can open the filter.

- Jacks: in note, gate, velocity, cutoff(cv), resonance(cv), envAmt(cv), gain(cv), unison(cv), width(cv), attack(cv), release(cv) / out audio
- Voices: 8 (oldest steal)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `type` | menu | 0 Sine, 1 Saw, 2 Square, 3 Triangle, 4 Pulse, 5 VarShape, 6 SuperSquare, 7 Harmonic | Saw |  |
| `width` | fader | 0..1 | 0.5 | yes |
| `octave` | stepper | -2..2 step 1 | 0 |  |
| `detune` | fader | -100..100 ct | 0 ct |  |
| `unison` | fader | 0..1 | 0.22 | yes |
| `cutoff` | fader | 80..12000 Hz log | 2000 Hz | yes |
| `resonance` | fader | 0.3..8 | 0.8 | yes |
| `envAmt` | fader | -1..2 | 0.35 | yes |
| `attack` | fader | 0.001..2 s exp | 0.01 s | yes |
| `decay` | fader | 0.001..2 s exp | 0.12 s |  |
| `sustain` | fader | 0..1 | 0.6 |  |
| `release` | fader | 0.001..4 s exp | 0.35 s | yes |
| `gain` | fader | 0..1 | 0.7 | yes |

## Filters

### Lowpass (`lowpass`)

RBJ biquad lowpass. Cutoff and Q.

- Jacks: in input(audio), cutoff(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |
| `q` | fader | 0.1..10 | 0.71 | yes |

### Highpass (`highpass`)

RBJ biquad highpass. Cutoff and Q.

- Jacks: in input(audio), cutoff(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 200 Hz | yes |
| `q` | fader | 0.1..10 | 0.71 | yes |

### Bandpass (`bandpass`)

RBJ biquad bandpass. Cutoff and Q.

- Jacks: in input(audio), cutoff(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |
| `q` | fader | 0.1..20 | 1 | yes |

### Notch (`notch`)

RBJ biquad notch. Cutoff and Q.

- Jacks: in input(audio), cutoff(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |
| `q` | fader | 0.1..20 | 1 | yes |

### Low Shelf (`lowshelf`)

Low shelf. Gain at 0 dB is dry.

- Jacks: in input(audio), freq(cv), gainDb(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `freq` | fader | 20..20000 Hz log | 80 Hz | yes |
| `gainDb` | fader | -18..18 dB | 0 dB | yes |
| `q` | fader | 0.1..10 | 0.71 | yes |

### High Shelf (`highshelf`)

High shelf. Gain at 0 dB is dry.

- Jacks: in input(audio), freq(cv), gainDb(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `freq` | fader | 20..20000 Hz log | 8000 Hz | yes |
| `gainDb` | fader | -18..18 dB | 0 dB | yes |
| `q` | fader | 0.1..10 | 0.71 | yes |

### Allpass (`allpass`)

Phase shift without an amplitude change. Cutoff and Q.

- Jacks: in input(audio), cutoff(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |
| `q` | fader | 0.1..10 | 0.71 | yes |

### 1-Pole Lowpass (`onepolelowpass`)

Gentle one-pole lowpass. Cheap and well behaved when the cutoff moves.

- Jacks: in input(audio), cutoff(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |

### 1-Pole Highpass (`onepolehighpass`)

Gentle one-pole highpass.

- Jacks: in input(audio), cutoff(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 200 Hz | yes |

### SVF Lowpass (`svflowpass`)

State-variable lowpass. Stays stable when cutoff is modulated hard.

- Jacks: in input(audio), cutoff(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |
| `q` | fader | 0.1..20 | 0.5 | yes |

### SVF Highpass (`svfhighpass`)

State-variable highpass.

- Jacks: in input(audio), cutoff(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 200 Hz | yes |
| `q` | fader | 0.1..20 | 0.5 | yes |

### SVF Bandpass (`svfbandpass`)

State-variable bandpass.

- Jacks: in input(audio), cutoff(cv), q(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |
| `q` | fader | 0.1..20 | 0.5 | yes |

### Ladder (`ladder`)

Resonant ladder lowpass. Resonance has character.

- Jacks: in input(audio), cutoff(cv), resonance(cv), drive(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |
| `resonance` | fader | 0..0.99 | 0 | yes |
| `drive` | fader | 1..8 | 1 | yes |

### Comb (`comb`)

Tuned comb. freq is the tooth spacing.

- Jacks: in input(audio), freq(cv), feedback(cv), mix(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `freq` | fader | 20..4000 Hz log | 440 Hz | yes |
| `feedback` | fader | 0..0.95 | 0.5 | yes |
| `mix` | fader | 0..1 | 0.5 | yes |

### LP 12 dB (`slopelowpass12`)

Fixed 12 dB/oct lowpass. No resonance control.

- Jacks: in input(audio), cutoff(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |

### LP 24 dB (`slopelowpass24`)

Fixed 24 dB/oct lowpass. No resonance control.

- Jacks: in input(audio), cutoff(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 1000 Hz | yes |

### HP 12 dB (`slopehighpass12`)

Fixed 12 dB/oct highpass. No resonance control.

- Jacks: in input(audio), cutoff(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `cutoff` | fader | 20..20000 Hz log | 200 Hz | yes |

### Parametric EQ (`ParametricEQ`)

Four-band channel EQ plus highpass and lowpass. Gains at 0 dB and filters off are dry.

- Jacks: in input(audio), hpFreq(cv), lowFreq(cv), lowGain(cv), lowMidFreq(cv), lowMidGain(cv), highMidFreq(cv), highMidGain(cv), highGain(cv), lpFreq(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `hpOn` | switch | 0 Off, 1 On | Off |  |
| `hpFreq` | fader | 20..2000 Hz log | 80 Hz | yes |
| `hpQ` | fader | 0.3..2 | 0.71 |  |
| `lowType` | menu | 0 Shelf, 1 Peak | Shelf |  |
| `lowFreq` | fader | 20..500 Hz log | 100 Hz | yes |
| `lowGain` | fader | -18..18 dB | 0 dB | yes |
| `lowQ` | fader | 0.3..2 | 0.7 |  |
| `lowMidFreq` | fader | 80..2000 Hz log | 400 Hz | yes |
| `lowMidGain` | fader | -18..18 dB | 0 dB | yes |
| `lowMidQ` | fader | 0.1..10 | 1 |  |
| `highMidFreq` | fader | 400..8000 Hz log | 2500 Hz | yes |
| `highMidGain` | fader | -18..18 dB | 0 dB | yes |
| `highMidQ` | fader | 0.1..10 | 1 |  |
| `highType` | menu | 0 Shelf, 1 Peak | Shelf |  |
| `highFreq` | fader | 2000..20000 Hz log | 8000 Hz |  |
| `highGain` | fader | -18..18 dB | 0 dB | yes |
| `highQ` | fader | 0.3..2 | 0.7 |  |
| `lpOn` | switch | 0 Off, 1 On | Off |  |
| `lpFreq` | fader | 1000..20000 Hz log | 12000 Hz | yes |
| `lpQ` | fader | 0.3..2 | 0.71 |  |

## Dynamics

### Compressor (`compressor`)

Downward compressor with makeup and mix. Mix at 0 is dry.

- Jacks: in input(audio), threshold(cv), ratio(cv), attack(cv), release(cv), makeup(cv), mix(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | 0.01..1 | 0.5 | yes |
| `ratio` | fader | 1..20 | 4 | yes |
| `attack` | fader | 0.001..0.2 s exp | 0.01 s | yes |
| `release` | fader | 0.01..1 s exp | 0.05 s | yes |
| `makeup` | fader | 0..4 | 1 | yes |
| `mix` | fader | 0..1 | 1 | yes |

### Limiter (`limiter`)

Compressor locked to a high ratio.

- Jacks: in input(audio), threshold(cv), attack(cv), release(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | 0.01..1 | 0.89 | yes |
| `attack` | fader | 0.001..0.05 s exp | 0 s | yes |
| `release` | fader | 0.01..1 s exp | 0.05 s | yes |

### Gate (`gate`)

Opens when the envelope is above threshold.

- Jacks: in input(audio), threshold(cv), attack(cv), release(cv), hold(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | 0.001..1 | 0.05 | yes |
| `attack` | fader | 0.001..0.2 s exp | 0 s | yes |
| `release` | fader | 0.01..1 s exp | 0.05 s | yes |
| `hold` | fader | 0..0.5 s | 0 s | yes |

### Expander (`expander`)

Turns quiet signals down.

- Jacks: in input(audio), threshold(cv), ratio(cv), attack(cv), release(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | 0.01..1 | 0.25 | yes |
| `ratio` | fader | 1..20 | 2 | yes |
| `attack` | fader | 0.001..0.2 s exp | 0.01 s | yes |
| `release` | fader | 0.01..1 s exp | 0.05 s | yes |

### Transient (`transient`)

Boosts or cuts attack and sustain without a threshold.

- Jacks: in input(audio), attack(cv), sustain(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `attack` | fader | -1..1 | 0 | yes |
| `sustain` | fader | -1..1 | 0 | yes |

### Ducker (`ducker`)

Turns the main signal down when the sidechain is loud.

- Jacks: in input(audio), sidechain(audio), amount(cv), attack(cv), release(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `amount` | fader | 0..1 | 0.8 | yes |
| `attack` | fader | 0.001..0.5 s exp | 0.01 s | yes |
| `release` | fader | 0.005..2 s exp | 0.2 s | yes |

### SC Comp (`sidechaincomp`)

Compressor keyed by a second audio inlet named sidechain.

- Jacks: in input(audio), sidechain(audio), threshold(cv), ratio(cv), attack(cv), release(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | 0..1 | 0.5 | yes |
| `ratio` | fader | 1..20 | 4 | yes |
| `attack` | fader | 0.001..0.5 s exp | 0.01 s | yes |
| `release` | fader | 0.005..2 s exp | 0.05 s | yes |

### SC Gate (`sidechaingate`)

Gate keyed by a second audio inlet named sidechain.

- Jacks: in input(audio), sidechain(audio), threshold(cv), attack(cv), release(cv), hold(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | 0..1 | 0.1 | yes |
| `attack` | fader | 0.001..0.5 s exp | 0 s | yes |
| `release` | fader | 0.005..2 s exp | 0.1 s | yes |
| `hold` | fader | 0..0.5 s | 0 s | yes |

## Shape

### Soft Clip (`softclip`)

Smooth tanh saturation. Drive into it.

- Jacks: in input(audio), drive(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `drive` | fader | 0.1..16 | 1 | yes |

### Hard Clip (`hardclip`)

Hard ceiling. Drive into it.

- Jacks: in input(audio), drive(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `drive` | fader | 0.1..16 | 1 | yes |

### Bitcrush (`bitcrush`)

Lowers amplitude resolution. 16 bits is effectively clean.

- Jacks: in input(audio), bits(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `bits` | stepper | 1..16 step 1 | 8 | yes |

### Downsample (`downsample`)

Lowers time resolution. Factor is how many samples to hold.

- Jacks: in input(audio), factor(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `factor` | stepper | 1..64 step 1 | 4 | yes |

### Full Rectify (`fullrectify`)

Absolute value. Turns bipolar audio into unipolar.

- Jacks: in input(audio) / out audio

No parameters.

### Half Rectify (`halfrectify`)

Keeps the positive half, zeros the rest.

- Jacks: in input(audio) / out audio

No parameters.

### Waveshape (`waveshape`)

Drive into a transfer curve, then mix with dry. Mix at 0 is bypass.

- Jacks: in input(audio), drive(cv), mix(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `curve` | menu | 0 Soft, 1 Hard, 2 Fold, 3 Asym, 4 Sine | Soft |  |
| `drive` | fader | 0.25..12 exp | 1.6 | yes |
| `mix` | fader | 0..1 | 1 | yes |

### Ring Mod (`ringmod`)

Multiplies the input by a sine at freq.

- Jacks: in input(audio), freq(cv), mix(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `freq` | fader | 1..4000 Hz log | 220 Hz | yes |
| `mix` | fader | 0..1 | 1 | yes |

## Time

### Delay (`delay`)

Echo with feedback. Mix at 0 is dry.

- Jacks: in input(audio), timeSec(cv), feedback(cv), mix(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `timeSec` | fader | 0..2 s exp | 0.25 s | yes |
| `feedback` | fader | 0..0.95 | 0.3 | yes |
| `mix` | fader | 0..1 | 0.35 | yes |

### Reverb (`reverb`)

Six-comb tank plus two allpass-ish delays. Mix at 0 is dry.

- Jacks: in input(audio), size(cv), decay(cv), damp(cv), mix(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `size` | fader | 0.3..1.4 | 0.85 | yes |
| `decay` | fader | 0..0.92 | 0.72 | yes |
| `damp` | fader | 200..12000 Hz log | 4500 Hz | yes |
| `mix` | fader | 0..1 | 0.28 | yes |

### Synced Delay (`synceddelay`)

Delay time is a note length, so it follows tempo.

- Jacks: in input(audio), division(cv), feedback(cv), mix(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `division` | menu | 0 1/1, 1 1/2, 2 1/2., 3 1/4, 4 1/4., 5 1/4T, 6 1/8, 7 1/8., 8 1/8T, 9 1/16, 10 1/16T | 1/8 | yes |
| `feedback` | fader | 0..0.95 | 0.4 | yes |
| `mix` | fader | 0..1 | 0.35 | yes |

### Pitch Shift (`pitchshift`)

Granular pitch shift in semitones. Mix at 0 is dry.

- Jacks: in input(audio), pitch(cv), mix(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `pitch` | fader | -12..12 st | 0 st | yes |
| `mix` | fader | 0..1 | 1 | yes |

### Reverse (`reverse`)

Plays short windows of the input backwards.

- Jacks: in input(audio), timeSec(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `timeSec` | fader | 0.01..2 s exp | 0.25 s | yes |

### Looper (`looper`)

Record captures. Play starts or restarts the loop, and closes a take when Record is still held. Bars 0 is free-running up to the ring. N bars auto-closes on that many measures. Threshold 0 is off; above 0, Record arms until a peak. Quantize snaps a free take. Start is a one-sample pulse on the first play sample after a take closes and on every wrap. End is a one-sample pulse on the last sample of the loop. Mix at 0 is dry.

- Jacks: in input(audio), record(cv), play(cv), overdub(cv), undo(cv), length(cv), threshold(cv), quantize(cv), mix(cv), clear(cv) / out audio, start, end

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `record` | switch | 0 Off, 1 Record | Off | yes |
| `play` | switch | 0 Stop, 1 Play | Play | yes |
| `overdub` | switch | 0 Off, 1 Overdub | Off | yes |
| `undo` | switch | 0 Ready, 1 Undo | Ready | yes |
| `length` | stepper | 0..16 step 1 | 0 | yes |
| `threshold` | fader | 0..1 | 0 | yes |
| `quantize` | menu | 0 Free, 1 Beat, 2 Bar | Free | yes |
| `clear` | switch | 0 Ready, 1 Clear | Ready | yes |
| `mix` | fader | 0..1 | 1 | yes |

### Transport (`transport`)

Host tempo and time signature. Params publish bpm, beatsPerBar, and beatUnit. Outlets are those fields plus beats, bars, playing, and a quarter-note pulse. Clock is free-running Hz. Synced Clock reads this snapshot.

- Jacks: in bpm(cv), beatsPerBar(cv), beatUnit(cv) / out bpm, beats, bars, playing, beatsPerBar, beatUnit, pulse

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `bpm` | fader | 20..300 bpm | 120 bpm | yes |
| `beatsPerBar` | stepper | 1..16 step 1 | 4 | yes |
| `beatUnit` | stepper | 1..16 step 1 | 4 | yes |

### Clock (`clock`)

Free-running pulse train. Output is CV, not audio.

- Jacks: in reset, freq(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `freq` | fader | 0.1..40 Hz log | 2 Hz | yes |
| `reset` | fader | 0..1 | 0 |  |

### Synced Clock (`syncedclock`)

A pulse on each tempo division. Output is CV.

- Jacks: in division(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `division` | menu | 0 1/1, 1 1/2, 2 1/2., 3 1/4, 4 1/4., 5 1/4T, 6 1/8, 7 1/8., 8 1/8T, 9 1/16, 10 1/16T | 1/4 | yes |

### Clock Divide (`clockdivide`)

Passes one pulse every N incoming pulses.

- Jacks: in input(audio), reset, factor(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `factor` | stepper | 1..64 step 1 | 2 | yes |
| `reset` | fader | 0..1 | 0 |  |

### Clock Multiply (`clockmultiply`)

Emits extra pulses between incoming ones.

- Jacks: in input(audio), reset, factor(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `factor` | stepper | 1..16 step 1 | 2 | yes |
| `reset` | fader | 0..1 | 0 |  |

### Pulse (`pulse`)

Turns an edge into a pulse of widthSec.

- Jacks: in input(audio), widthSec(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `widthSec` | fader | 0.001..2 s exp | 0.01 s | yes |

### Trigger (`trigger`)

Fires when the input crosses threshold upward.

- Jacks: in input(audio), threshold(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | -1..1 | 0.5 | yes |

### Sequencer (`sequencer`)

Eight stepped values advanced by a clock. Output is CV.

- Jacks: in clock, reset, step0(cv), step1(cv), step2(cv), step3(cv), step4(cv), step5(cv), step6(cv), step7(cv) / out cv

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `clock` | fader | 0..1 | 0 |  |
| `step0` | fader | -1..1 | 0 | yes |
| `step1` | fader | -1..1 | 0.25 | yes |
| `step2` | fader | -1..1 | 0.5 | yes |
| `step3` | fader | -1..1 | 0.75 | yes |
| `step4` | fader | -1..1 | 1 | yes |
| `step5` | fader | -1..1 | 0.75 | yes |
| `step6` | fader | -1..1 | 0.5 | yes |
| `step7` | fader | -1..1 | 0.25 | yes |
| `reset` | fader | 0..1 | 0 |  |

### Smooth Random (`randomsmooth`)

Smooth random bipolar CV at freq.

- Jacks: in freq(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `freq` | fader | 0.1..40 Hz log | 4 Hz | yes |

### Stepped Random (`randomstepped`)

Stepped random bipolar CV at freq.

- Jacks: in freq(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `freq` | fader | 0.1..40 Hz log | 8 Hz | yes |

### Synced Ramp (`syncedramp`)

A 0..1 ramp locked to a tempo division.

- Jacks: in division(cv), depth(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `division` | menu | 0 1/1, 1 1/2, 2 1/2., 3 1/4, 4 1/4., 5 1/4T, 6 1/8, 7 1/8., 8 1/8T, 9 1/16, 10 1/16T | 1/4 | yes |
| `depth` | fader | 0..1 | 1 | yes |

### Synced Tremolo (`syncedtremolo`)

Amplitude modulation locked to a tempo division.

- Jacks: in input(audio), division(cv), depth(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `division` | menu | 0 1/1, 1 1/2, 2 1/2., 3 1/4, 4 1/4., 5 1/4T, 6 1/8, 7 1/8., 8 1/8T, 9 1/16, 10 1/16T | 1/8 | yes |
| `depth` | fader | 0..1 | 0.6 | yes |

### LFO (`lfo`)

Bipolar control oscillator. Same eight waves as Oscillator, at control rate.

- Jacks: in reset, rate(cv), amount(cv), width(cv), phase(cv) / out cv
- Outlet: bipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `type` | menu | 0 Sine, 1 Saw, 2 Square, 3 Triangle, 4 Pulse, 5 VarShape, 6 SuperSquare, 7 Harmonic | Sine |  |
| `width` | fader | 0..1 | 0.5 | yes |
| `rate` | fader | 0.05..20 Hz log | 0.4 Hz | yes |
| `amount` | fader | 0..1 | 0.35 | yes |
| `phase` | fader | 0..1 | 0 | yes |
| `reset` | fader | 0..1 | 0 |  |

### ADSR (`adsr`)

Note-driven envelope. Times are live. Output is unipolar CV.

- Jacks: in gate, velocity, attack(cv), decay(cv), sustain(cv), release(cv), amount(cv) / out cv
- Voices: 8 (oldest steal)
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `attack` | fader | 0.001..2 s exp | 0.01 s | yes |
| `decay` | fader | 0.001..2 s exp | 0.12 s | yes |
| `sustain` | fader | 0..1 | 0.7 | yes |
| `release` | fader | 0.001..4 s exp | 0.25 s | yes |
| `amount` | fader | 0..1 | 1 | yes |

### DAHDSR (`dahdsr`)

Delay, attack, hold, decay, sustain, release from a gate. Output is CV.

- Jacks: in input(audio), delay(cv), attack(cv), hold(cv), decay(cv), sustain(cv), release(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `delay` | fader | 0..2 s exp | 0 s | yes |
| `attack` | fader | 0.001..2 s exp | 0.01 s | yes |
| `hold` | fader | 0..2 s exp | 0 s | yes |
| `decay` | fader | 0.001..2 s exp | 0.1 s | yes |
| `sustain` | fader | 0..1 | 0.7 | yes |
| `release` | fader | 0.001..4 s exp | 0.2 s | yes |

### Breakpoints (`breakpoints`)

Four live time/level points from a gate. Later times clamp forward. Output is CV.

- Jacks: in input(audio), time0(cv), time1(cv), time2(cv), time3(cv), level0(cv), level1(cv), level2(cv), level3(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `time0` | fader | 0..4 s exp | 0 s | yes |
| `time1` | fader | 0..4 s exp | 0.01 s | yes |
| `time2` | fader | 0..4 s exp | 0.12 s | yes |
| `time3` | fader | 0..4 s exp | 0.4 s | yes |
| `level0` | fader | 0..1 | 0 | yes |
| `level1` | fader | 0..1 | 1 | yes |
| `level2` | fader | 0..1 | 0.6 | yes |
| `level3` | fader | 0..1 | 0 | yes |

### Env Follow (`envfollow`)

Amplitude of the input as a control signal.

- Jacks: in input(audio), attack(cv), release(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `attack` | fader | 0.001..1 s exp | 0.01 s | yes |
| `release` | fader | 0.001..2 s exp | 0.1 s | yes |

## Control

### Control (`control`)

A constant you can automate or patch. Output is CV.

- Jacks: in value(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `value` | fader | -1..1 | 0 | yes |

### Offset (`offset`)

Adds a constant to the input.

- Jacks: in input(audio), amount(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `amount` | fader | -2..2 | 0 | yes |

### Slew (`slew`)

Rate limiter with separate rise and fall speeds.

- Jacks: in input(audio), rise(cv), fall(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `rise` | fader | 0..10000 /s | 10 /s | yes |
| `fall` | fader | 0..10000 /s | 10 /s | yes |

### Sample & Hold (`samplehold`)

Samples the input at freq and holds it.

- Jacks: in input(audio), clock, freq(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `freq` | fader | 0..20000 Hz exp | 20 Hz | yes |
| `clock` | fader | 0..1 | 0 |  |

### Compare > (`comparegt`)

1 when the input is above threshold, else 0.

- Jacks: in input(audio), threshold(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | -1..1 | 0 | yes |

### Compare < (`comparelt`)

1 when the input is below threshold, else 0.

- Jacks: in input(audio), threshold(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | -1..1 | 0 | yes |

### AND (`logicand`)

AND of the input and other.

- Jacks: in input(audio), other(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `other` | fader | 0..1 | 1 | yes |

### OR (`logicor`)

OR of the input and other.

- Jacks: in input(audio), other(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `other` | fader | 0..1 | 0 | yes |

### XOR (`logicxor`)

XOR of the input and other.

- Jacks: in input(audio), other(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `other` | fader | 0..1 | 0 | yes |

### NOT (`logicnot`)

Inverts a gate.

- Jacks: in input(audio) / out audio(cv)

No parameters.

### Flip Flop (`flipflop`)

Toggles on each rising edge.

- Jacks: in input(audio) / out audio(cv)

No parameters.

### Quantize (`quantize`)

Snaps a MIDI-style pitch number to a scale. Root and scale are menus.

- Jacks: in input(audio), root(cv), scale(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `root` | menu | 0 C, 1 C#, 2 D, 3 D#, 4 E, 5 F, 6 F#, 7 G, 8 G#, 9 A, 10 A#, 11 B | C | yes |
| `scale` | menu | 0 major, 1 minor, 2 pentatonic, 3 chromatic, 4 wholeTone | major | yes |

### Euclidean (`euclidean`)

Evenly spaced hits across a step count, advanced by a clock.

- Jacks: in clock, reset, steps(cv), hits(cv), rotation(cv) / out cv
- Outlet: unipolar CV (jack name cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `clock` | fader | 0..1 | 0 |  |
| `steps` | stepper | 1..32 step 1 | 8 | yes |
| `hits` | stepper | 0..32 step 1 | 3 | yes |
| `rotation` | stepper | 0..31 step 1 | 0 | yes |
| `reset` | fader | 0..1 | 0 |  |

### RMS (`rms`)

Windowed RMS of the input, as CV.

- Jacks: in input(audio), windowSec(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `windowSec` | fader | 0.005..0.5 s exp | 0.05 s | yes |

### Peak (`peak`)

Peak follower with a release time, as CV.

- Jacks: in input(audio), release(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `release` | fader | 0.01..2 s exp | 0.3 s | yes |

### Onset (`onset`)

Fires a pulse when a transient crosses threshold.

- Jacks: in input(audio), threshold(cv) / out audio(cv)

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `threshold` | fader | 0.001..0.5 | 0.05 | yes |

## Routing

### Gain (`gain`)

Multiply. Gain at 1 is unity.

- Jacks: in input(audio), gain(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `gain` | fader | 0..4 | 1 | yes |

### Mix (`mix`)

Weighted sum of the main input plus three more constants-or-cables.

- Jacks: in input(audio), a(cv), b(cv), c(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `a` | fader | -1..1 | 0 | yes |
| `b` | fader | -1..1 | 0 | yes |
| `c` | fader | -1..1 | 0 | yes |

### Audio Mix (`audiomix`)

Sums a second live audio inlet.

- Jacks: in input(audio), sidechain(audio), level(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `level` | fader | 0..2 | 1 | yes |

### Audio Multiply (`audiomultiply`)

Ring modulation by a second live audio inlet.

- Jacks: in input(audio), sidechain(audio), mix(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `mix` | fader | 0..1 | 1 | yes |

### Crossfade (`crossfade`)

Crossfade between the main input and a second live inlet.

- Jacks: in input(audio), sidechain(audio), position(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `position` | fader | 0..1 | 0.5 | yes |

### Input Select (`inputselect`)

Hard switch between two live audio inlets.

- Jacks: in input(audio), sidechain(audio), which(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `which` | switch | 0 Input, 1 Sidechain | Input | yes |

### Select (`select`)

Chooses between the main input and other.

- Jacks: in input(audio), other(cv), which(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `other` | fader | -1..1 | 0 | yes |
| `which` | switch | 0 Input, 1 Other | Input | yes |

### Invert (`invert`)

Flips polarity.

- Jacks: in input(audio) / out audio

No parameters.

### Bypass (`bypass`)

Passes the input through. A placeholder in a chain.

- Jacks: in input(audio) / out audio

No parameters.

### DC Block (`dcblock`)

Removes DC offset.

- Jacks: in input(audio) / out audio

No parameters.

## Analysis

### Meter (`meter`)

Peak and RMS readout, also as CV. Audio still passes through.

- Jacks: in input(audio) / out audio, peak, rms

No parameters.

### Scope (`scope`)

A window of samples for the inspector. Peak and RMS are CV. Audio still passes through.

- Jacks: in input(audio) / out audio, peak, rms

No parameters.

### Analyzer (`analyzer`)

Meter plus spectrum. Note, cv, hz, cents, gate, peak, RMS, and LUFS are CV outlets so a patch can follow live playing.

- Jacks: in input(audio) / out audio, note, cv, hz, cents, gate, peak, rms, lufs

No parameters.

### Tuner (`tuner`)

Pitch readout of the incoming cable. Note, cv, hz, cents, and gate are CV outlets. Audio still passes through.

- Jacks: in input(audio) / out audio, note, cv, hz, cents, gate

No parameters.

## Stereo

### Stereo Pan (`stereopan`)

Track-pan matrix: fold both sides, then equal-power position. Identity at center.

- Jacks: in input(audio), pan(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `pan` | fader | -1..1 | 0 | yes |

### Balance (`balance`)

Independent level per side.

- Jacks: in input(audio), left(cv), right(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `left` | fader | 0..2 | 1 | yes |
| `right` | fader | 0..2 | 1 | yes |

### Auto Pan (`autopan`)

Pans back and forth at rate.

- Jacks: in input(audio), rate(cv), depth(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `rate` | fader | 0.01..20 Hz log | 1 Hz | yes |
| `depth` | fader | 0..1 | 1 | yes |

### Haas (`haas`)

Width from a short delay on one side.

- Jacks: in input(audio), delayMs(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `delayMs` | fader | 0..30 ms exp | 12 ms | yes |

### Width (`width`)

0 collapses to mono, 1 is unity, above widens. The centre stays put.

- Jacks: in input(audio), width(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `width` | fader | 0..2 | 1 | yes |

### Mono Sum (`monosum`)

Folds stereo to mono at the level a correlated pair started at.

- Jacks: in input(audio) / out audio

No parameters.

### Mono Left (`monoleft`)

Copies the left channel to both sides.

- Jacks: in input(audio) / out audio

No parameters.

### Mono Right (`monoright`)

Copies the right channel to both sides.

- Jacks: in input(audio) / out audio

No parameters.

### Swap (`swap`)

Swaps left and right.

- Jacks: in input(audio) / out audio

No parameters.

### M/S Encode (`midside`)

Stereo to mid/side.

- Jacks: in input(audio) / out audio

No parameters.

### M/S Decode (`midsidedecode`)

Mid/side back to stereo.

- Jacks: in input(audio) / out audio

No parameters.

### Stereo Merge (`stereomerge`)

Two live mono inlets into one stereo pair.

- Jacks: in input(audio), sidechain(audio) / out audio

No parameters.

### Pan Left (`panleft`)

Equal-power gain for the left side of a pan pair.

- Jacks: in input(audio), pan(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `pan` | fader | -1..1 | 0 | yes |

### Pan Right (`panright`)

Equal-power gain for the right side of a pan pair.

- Jacks: in input(audio), pan(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `pan` | fader | -1..1 | 0 | yes |

## Spatial

### Spatial Source (`spatialsource`)

A sound placed in the room. x, y and z are metres, with -z ahead of the listener, and each is a CV jack, so an LFO on x sweeps the source past you. Global makes it omnidirectional. Its outlet is not audio: patch it into a Spatial Master.

- Jacks: in input(audio), x(cv), y(cv), z(cv), gain(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `x` | fader | -32..32 m | 0 m | yes |
| `y` | fader | -32..32 m | 0 m | yes |
| `z` | fader | -32..32 m | -1 m | yes |
| `gain` | fader | 0..4 | 1 | yes |
| `global` | switch | 0 Off, 1 On | Off |  |
| `distanceModel` | menu | 0 Preview, 1 Web HRTF | Preview |  |

### Spatial Master (`spatialmaster`)

Sums any number of Spatial Sources, turns the room to face the listener, and decodes it to headphones. Yaw and pitch are the listener's head, not the room. This is the node that goes to Master.

- Jacks: in input(audio), yaw(cv), pitch(cv), level(cv) / out audio

| Param | Control | Range | Default | CV |
|---|---|---|---|---|
| `yaw` | fader | -180..180 deg | 0 deg | yes |
| `pitch` | fader | -90..90 deg | 0 deg | yes |
| `decode` | menu | 0 Binaural, 1 Stereo, 2 Ambisonic | Binaural |  |
| `level` | fader | 0..2 | 1 | yes |

## Plugins

### Amp (`amp`)

Neural amp (NAM) plus analog / EQ / reverb / delay. Cabinet lives on an IR node after Amp.

- Jacks: in input(audio) / out audio
- Kernel: WASM. Cannot flatten to a crate.plugin graph.
- File: NAM profile (.nam). No profile is the analog path.

| Param | Range | Default |
|---|---|---|
| `inputGain` | 0..4 lin | 1 |
| `outputGain` | 0..4 lin | 1 |
| `eqBand0` | -12..12 dB | 0 |
| `eqBand1` | -12..12 dB | 0 |
| `eqBand2` | -12..12 dB | 0 |
| `eqBand3` | -12..12 dB | 0 |
| `eqBand4` | -12..12 dB | 0 |
| `reverbBlend` | 0..1 | 0 |
| `reverbDecay` | 0..1 | 0.5 |
| `delayMix` | 0..1 | 0 |
| `delayTime` | 20..2000 ms | 350 |
| `inputPad` | 0..1 bool | 0 |

### Drum (`drum`)

Sixteen one-shot pads on C2 to D#3, each with its own bit crusher and low-pass, into a shared filter and character stage. A pad plays to its end and ignores the note-off. Pure ASL, so no WASM. A new one arrives with the factory kit loaded.

- Jacks: in none / out audio

No parameters.

### Grain (`grain`)

Granular instrument kernel. Needs WASM. Files are not auto-loaded.

- Jacks: in note, gate, velocity / out audio
- Kernel: WASM. Cannot flatten to a crate.plugin graph.

| Param | Range | Default |
|---|---|---|
| `grainMix` | 0..1 | 0 |
| `grainSize` | 20..500 ms | 120 |
| `grainDensity` | 2..80 Hz | 18 |
| `grainPitch` | -24..24 st | 0 |
| `inputGain` | 0..4 lin | 1 |
| `outputGain` | 0..4 lin | 1 |
| `loopLength` | 0.25..5 s | 2 |
| `dryLevel` | 0..1 | 1 |

### Synth (`synth`)

Subtractive synth kernel. Needs WASM.

- Jacks: in note, gate, velocity / out audio
- Kernel: WASM. Cannot flatten to a crate.plugin graph.

| Param | Range | Default |
|---|---|---|
| `oscAWaveform` | 0..7 index | 2 |
| `oscBWaveform` | 0..7 index | 0 |
| `oscBlend` | -1..1 | 0 |
| `ampAttack` | 0.001..5 s | 0.01 |
| `ampDecay` | 0.001..5 s | 0.3 |
| `ampSustain` | 0..1 | 0.7 |
| `ampRelease` | 0.001..10 s | 0.5 |
| `filterCutoff` | 20..20000 Hz | 2000 |
| `filterResonance` | 0..1 | 0 |
| `masterGain` | 0..2 lin | 0.8 |
| `delayMix` | 0..1 | 0 |
| `reverbBlend` | 0..1 | 0 |

### Space Reverb (`spacereverb`)

Costello room kernel. Needs WASM.

- Jacks: in input(audio) / out audio
- Kernel: WASM. Cannot flatten to a crate.plugin graph.

| Param | Range | Default |
|---|---|---|
| `reverbBlend` | 0..1 | 0.28 |
| `reverbDecay` | 0..1 | 0.5 |
| `reverbSize` | 0.5..2 | 1 |
| `reverbPreDelay` | 0..100 ms | 0 |
| `reverbTone` | 0..1 | 0.7 |
| `reverbGate` | 0..1 bool | 0 |

### IR (`ir`)

Convolution cabinet or space. Needs an impulse file.

- Jacks: in input(audio) / out audio
- Kernel: WASM. Cannot flatten to a crate.plugin graph.
- File: Impulse (.wav, .aiff, .flac, ...).

| Param | Range | Default |
|---|---|---|
| `mix` | 0..1 | 1 |
| `gain` | 0..4 | 1 |
