# Changelog

## 0.4.0

A track can play a stream, a homecrate project's crate AU plays on the web
from the compiled graph the slot saved, and a pure ASL instrument plays the
scene's MIDI on a voice pool scheduled to the sample. CrateC runs those
patches live in WASM, and a worker can render a track ahead of the playhead
the way live playback would.

### Added

- **Streaming sources.** A `StreamClip` plays network-fed audio on a track
  (`track.addStream(clip, { at })`) without decoding the whole file first.
  The plan gives it a window like a clip (`plan.streamJobs`), and
  `ScenePlayback` starts it at the same origin and routes it through the
  track's chain, so meters, analysers and AudioMaterials see it like any
  clip. Trims, fades, stretch and offline rendering stay with `Clip`.
- **`MseStreamSource`**, the browser `StreamSource`: Media Source
  Extensions (or `ManagedMediaSource` on iOS 17.1+) into an audio element,
  joined to the graph by a `MediaElementAudioSourceNode`. The host supplies
  `loadInit` and `loadSegment`; the source fetches the segment under the
  playhead first, fills `aheadSec` ahead, evicts what is `behindSec` behind,
  aborts fetches a seek made pointless, and stops on an error marked
  `fatal`. The fetch policy is the pure `planStreamWork`.
- **`holdWhileBuffering(scene, source)`**: when a stream runs out of data
  the transport pauses at the position actually heard, and plays again once
  enough is buffered. The transport stays the one scheduling origin, so a
  network stall is a pause, never drift.
- **homecrate's crate AU plays on the web.** A project slot holding the crate
  AU (`crat` by `NAMp`: an instrument as `aumu`, an effect as `aufx`) maps
  to `homecrate.crate` / `homecrate.crate-fx` in `corePlugins`. The material
  is built from the compiled graph saved in the slot (`crateCompiledGraph`),
  the same artifact CrateASL runs, with `param_N` applied by address.
  `materialFromCompiled(doc)` is the same thing for any compiled document.
- **Pure ASL instruments play a scene's MIDI.** `prepareLiveVoices` gives an
  instrument with no kernel (a crate patch, the drum) a pool of `polyphony`
  voices, plus the bus voice of a split instrument, and `scheduledPoolTarget`
  plays it: every note of a play assigned to a voice ahead of time and sent
  with its AudioContext time, so it lands on the sample with no main-thread
  timers. Before, such an instrument got one worklet voice that ignored MIDI
  (or, for the drum, no voice), and its track was silent. A host that voices
  these itself passes `{ poolInstruments: false }`; the patch editor does.
- **`audiocrate/homecrate`**: homecrate's plugins as a package entry
  (`registerHomecrateMaterials`, `loadHomecrateKernelBinaries`,
  `HOMECRATE_KERNEL_FILES`), their worklet (`audiocrate/homecrate/worklet`)
  and WASM (`audiocrate/homecrate/wasm/*`). The entry imports core rather
  than bundling it, so a host gets one registry. `npm run build:homecrate`.
- `AudioMaterialPlugin.createFromPreset(preset)`, for a plugin whose preset
  is the material (a patch host); `mapPluginSlot` decodes first and builds
  from it. `AudioMaterialPlugin.applyAsset(material, key, value)`, for a
  plugin whose graph reads a hydrated file from somewhere of its own; the
  drum uses it to fill its pads, which a loaded kit previously never reached.
- `HostPluginIdentity.componentTypes`: a claim may name the component types
  it answers to, so one native product with two roles under one subtype maps
  to two plugins. Claims without it match as before.
- A voice's own `noteOn(params, when?)` and `noteOff(when?)` take an
  AudioContext time, scheduled in the worklet like MIDI.

- **CrateC plays crate patches live, in WASM.** `examples/CrateC/web` builds
  the C interpreter (`web/build.sh`) as a homecrate kernel: an instrument is
  CrateC's voice pool, split bus included, as one voice taking MIDI; an
  effect is one state. homecrate's `crateInstrumentPlugin` /
  `crateEffectPlugin` replace core's crate AU plugins with it live, and keep
  the ASL material for everything else. The same compiled document, sample
  for sample (`crateKernel.test.ts`), at 2 to 4 times the speed of the JS
  interpreter on a rich pad.
- **Render-ahead.** `BlockGraph` runs the live voice processor without Web
  Audio (`captureVoiceProcessor` takes the class from a worklet bundle), so a
  Worker can render a track exactly as live playback would. `TrackRender`
  renders one instrument track, with its inserts and MIDI, from any song
  position, continuously. `RenderedStreamSource` plays the chunks on the
  track's `StreamClip`, asks for a new render on a seek outside what it has,
  and stalls rather than playing silence; `combineStreamSources` gives one
  `holdWhileBuffering` a view of all of them.
- `AudioMaterialPlugin.liveGraph(material)`: the graph a real-time voice
  compiles when it should differ from `material.graph` (the drum's light
  live graph, a kernel instead of the interpreter).
- `KernelProcessor.setTransport(snapshot)`: the song position at the start
  of each render, for a kernel that keeps its own musical clock.
- An effect or bus voice (gate held open) now rests once its inputs and
  output have been silent for longer than its longest delay line, instead of
  rendering silence for good. Notes queued for later no longer keep a voice
  awake.
- `homecrateKernelSlots(scene)`: the kernel WASM a scene's materials need.
- **hc_dynEQ and hc_send** (`examples/dyneq`). dynEQ's iOS kernel, ported to
  portable C++ with its math verbatim (`dsp/dyneq_kernel.cpp`) and built to
  WASM (`wasm/build_dyneq.sh`): five RBJ bells with per-band duck, a
  stereo-linked compressor keyed internally or by the follower, in/out gain
  and the AU's safety clamp. hc_send is a JS kernel: bit-exact passthrough
  that publishes its block peak x SEND to an envelope bus kept in the worklet
  realm, the web's counterpart of the AU's process-global bus (loudest live
  send wins, stale after 150 ms). `envelopeBusTracks` names the tracks that
  must share a realm for that to work.

- **The drum plays live as its own engine.** homecrate-drum-vst3's
  DrumEngine (the AUv3's Swift voice and C++ kernel, vendored in
  `examples/drum/vst3/`) compiled to WASM (`wasm/build_drum_fx.sh`): idle pads
  cost nothing, and SOLA stretch, hi-hat choke, character and humanize are
  the AU's. The ASL drum graph stays for offline renders and bakes. Its light
  live graph (no 026S chain) changed the kit's sound and balance.
- CrateC's builder takes sample tables as floats (`{ "ext": n }`,
  `crate_build_set_external_tables`); the web kernel's `tables` payload and
  `graphForKernel` use it, so a sample-heavy graph is not written out as
  JSON text.

### Fixed

- **Track volume in a homecrate project is a fader position.** The app plays
  it through a cubic taper; `loadProjectScene` (and the editor's import) read
  it as a linear gain, so every track below full fader played hot, a 0.47
  fader by 13 dB, and no imported mix had the balance the artist set.
  `projectFaderGain` is the taper.
- `prepareLiveVoices` no longer leaves a drum with a kernel voiceless; the
  drum is skipped only for a host that voices instruments itself.
- `decodeKeyedArchive` no longer overflows the stack on a long ASCII string
  (a crate AU's compiled graph runs to hundreds of kB).

## 0.3

An instrument now sums its voices into the effects after
them, `noise` and `random` are seeded, and the browser patcher plays a patch
as the graph the plugin ships. Existing golden renders are unchanged; the
conformance fixture grew from 103 cases to 115, additions only. Where a sound
changed on purpose, the entry says so.

### Added

- **Instruments sum their voices into the effects after them.** A patch is
  modular topology: eight oscillator voices into one reverb is one reverb.
  Flattening used to copy the whole chain into every voice, so an instrument
  ran eight reverbs and eight limiters and limited each note instead of the
  chord. `flattenPatch` now splits an instrument into a per-voice graph with
  `sends` and a `bus` that runs once on their sum (`patcher/voicing.ts`,
  CrateASL `VoicingPlan`). A module stays per voice when it is a voice
  source, reads its voice, is played by the keyboard, has a per-voice signal
  on a control input, combines per-voice signals on two audio inputs, or
  feeds anything per voice; a patch node's optional `voicing: "instanced"`
  keeps any other module per voice, and the inspector shows a Per voice /
  Summed switch. Single notes render the same as before; chords differ only
  where a stage is nonlinear on the sum. The traced reverb instrument costs
  0.28 ms per 256-frame block at eight voices, down from 1.53 ms.
  A split instrument exports as `crate.plugin` format 3 (`docs/format.md`).
- **The Swift interpreter runs a precomputed schedule.** Every node a frame
  always evaluates runs bottom up from a flat list (`Schedule.swift`), inputs
  are read from the value cache by slot, and the render path does no
  reference counting. Bit-identical on every conformance graph and factory
  patch (`InterpreterDigestTests`), about 46% faster before the voice split.
- **The patcher plays patches the way the plugin does.** A patch of pure ASL
  materials is flattened (`flattenPatch`, the lowering Export Plugin and the
  iOS AUv3 use) and played as one voice, so a cable into a parameter is a
  per-sample signal rather than a value sampled from the main thread every
  50 ms. Drum envelopes, fast LFOs and a clock into a Euclidean now work in
  the browser, and the browser renders the graph the plugin ships. Patches
  with kernels, loaded files, a looper, analysis modules, MIDI Out, spatial
  nodes or MIDI clips still play per module (`editor/src/compiledPlayback.ts`
  says why each). Knobs reach the compiled voice as parameter changes and
  glide; a change of modules or cables rebuilds it.
- **Seeded `noise` and `random`.** Each node draws from its own stream, a pure
  function of the voice seed, the node's structural rank (first visit from
  the output, inputs in sorted name order), and the channel (`asl/rng.ts`, `Rng.swift`). A bounce is now reproducible, and a
  seeded world sounds the same on every visit and every device.
  `createState({ seed })`, `OfflineRenderer.render({ seed })`,
  `BlockRenderer({ seed })`, `WebAudioRenderer.createVoice(graph, { seed })`,
  `AudioMaterial.bind(renderer, dest, { seed })` (voice `i` gets `seed + i`),
  Swift `makeState(seed:)` and `VoicePool(seed:)`. Offline renderers default
  to seed 0. Live voices default to a fresh random seed each, as before, so
  two voices of one graph never share a noise. `DEFAULT_VOICE_SEED` and
  `normalizeSeed` are exported.
- **Both kinds are in the conformance fixture** (11 new cases, 115 in all):
  every colour, a live colour switch, both random modes, two streams in one
  graph, and a stereo insert. `COVERAGE_EXEMPT_KINDS` is empty. The twelfth
  addition is `svf bandpass ringing`, under the resonance ceiling below.

- **`crate.plugin` format 2, readable now, written on request.** A shared
  node is written in full once and as `{ "ref": id }` after that, which takes
  a rich plugin to about 40% of its format 1 size (`ambient-bloom` 38.8 kB to
  15.9 kB). `parseCratePlugin` reads both and hands back `compiled.graph` with
  shared nodes as shared objects, so hosts need no change beyond upgrading;
  CrateASL resolves references while decoding. `stringifyCratePlugin(doc,
  { shareNodes: true })` writes it; the default stays format 1 until hosts
  that read 2 have shipped. `shareSerializedGraph`, `inflateSerializedGraph`,
  `canonicalizeSerializedGraph` and `CRATE_PLUGIN_MAX_VERSION` are exported.
  Specified in `docs/format.md`, with the compatibility promise, and held to
  `fixtures/plugin-format-conformance.json` in both languages.
- **A newer format is refused, by name.** `parseCratePlugin` and
  `CratePluginDocument.decode` reject a version above what they read, before
  reading anything else. `isCratePluginDocument` used to accept any number.

- **Motion conformance.** `fixtures/motion-conformance.json` renders all 106
  sounding palette materials while every parameter steps through its range
  four times and the note is released and struck again; CrateASL replays it
  against the bundled catalog (`MotionConformanceTests`). It is the first
  render comparison of the palette itself, and all 105 Swift can compile agree.
  `editor/test/paramMotion.test.ts` sweeps every automatable parameter at knob
  rate and fails on any non-finite sample or any click not listed with a reason.

- **Continuous parameters glide when a host moves them.** A change through
  `CompiledVoice.setParam` (the worklet's `setParam` message,
  `BlockRenderer.setParam`, CrateASL's `CompiledVoice.setParam` and
  `VoicePool.glideParam`) reaches its value over `PARAM_RAMP_SECONDS`, 5 ms,
  in a straight line, and lands on it exactly. Which parameters glide is
  decided by what they are (`isSmoothedParam`): a continuous `range` glides;
  `stepped`, `enum` and `toggle` jump, because gliding a mode plays modes
  nobody chose; `smooth: false` makes a continuous one jump. Values that
  arrive with a note never glide, and nothing glides before a voice first
  renders. 5 ms is the shortest length that cleared every zipper finding in
  the palette sweep (2 ms left one), and short enough that a large change
  lands within two render quanta. The list travels as `graph.smooth`, an
  optional field (no format version change), through `crate.plugin`, the
  palette catalog and both flattens, and the motion fixture holds the two
  interpreters' glides to each other. The AUv3 glides host step events and
  MIDI CC, both on the render thread. A knob in the plugin's own editor is
  posted to `ParameterInbox` and applied on that same thread, so it glides
  the same way and never writes a `VoiceState` from the thread the host
  called on.
- **Sample Player takes `trig`, `gate`, and `reset`.** `trig` is an edge: it
  starts the file from `start`, and it restarts one that has finished.
  `gate` is a level: it starts on the rise and stops on the release, and it
  is ORed with the voice gate, so a keyboard plays a sampler with nothing
  cabled. `reset` moves the playhead to `start` and leaves a finished sample
  finished. The audio inlet still triggers, as an edge, which is how this
  material worked before it had jacks of its own: a cable into it plays the
  file out, and a patch built that way is unchanged. A `samplePlay` whose
  `gate` inlet is present used to ignore the voice gate, and releasing that
  gate used to let the file play out; the release now stops it.
  `samplePlayerMaterial` exposes the three jacks. Both interpreters.
- **A loaded file is a name until a plugin is exported.** A sample, wavetable,
  or grain box in CrateASL can name a file (`ref`) beside its samples.
  `CrateSamples.references` lists them. Playing hands the audio to
  `CompiledVoice(document:samples:)` as a side table the host already holds,
  so adopting an edit does not copy the samples into the graph: a 30-second
  file was 166 ms per edit when baked in, and about a millisecond this way.
  `CrateSamples.resolving` writes the samples into the document for export,
  because a `.crate.plugin` opened somewhere else has no library. A missing
  Sample Player file is silence. A missing wavetable stays the sine it
  shipped with. The reference stays either way, so putting the file back
  fixes the patch.
- **The factory library is one file.** `npm run fixtures:factory` writes
  `editor/src/factoryPatches.ts` into CrateASL as `factory-patches.json`, and
  `FactoryLibrary.bundled()` is what the iOS plugin offers.
  `FactoryLibraryTests` decodes, flattens, and compiles every patch. There
  used to be a second, hand-written copy of all of them in Swift.
- **On-device generation starts from a factory patch.** `CrateGenStart` picks
  the nearest factory patch for the sentence and tunes that patch's own
  knobs. `CrateGenMove` adds the movement the description asks for (a filter
  envelope, a sweep, wobble, random steps, drift, vibrato, pulse width, a
  wavetable scan, autopan, tape wow), each built by rule. Editing a patch
  that already exists (`CratePatchEditor`) wires an added module into the
  path: "add a reverb and modulate the decay" puts the reverb before the
  limiter and an LFO on its decay (`PatchChangeGuardTests`).
- **The native editor matches the browser's edits.** Removing a module can
  carry its audio through to whatever followed it (`passthroughConnections`).
  `CrateNodeClip` is `crate.nodeclip`, the same text the browser puts on the
  clipboard, so a module copied on a phone pastes into the browser.
  `CratePluginExport` writes a format 1 `crate.plugin` from this side's
  flatten. `ParamPresentation` is `normalizeParam`, `denormalizeParam`,
  `quantizeParam`, and `formatParam`, so a native fader lands on the value
  the browser's would: envelope times are `exp`, and a linear fader over
  0.001 to 2 seconds puts 1 to 50 ms in the first two and a half percent of
  the throw.

### Fixed

- **`transport.pulse` no longer drops an edge.** It compared each sample's
  position with `beats - perSample` rather than with the previous sample's
  own position. The two differ by rounding, so when a boundary landed within
  that rounding of a sample both floors agreed and the clock skipped it. At
  120 bpm a 1/16 Synced Clock lost the edge at beat 4.75, and a Euclidean or
  Sequencer on it played a step late for the rest of the song. Both
  evaluators now use the same formula for the previous sample as for the
  current one.
- **Self-playing patches in the iOS AUv3 played one note and stopped.** The
  homecrate recorder refreshes the beat it gives a plugin from a 50 Hz timer,
  and not at all when no audio track is playing. With the beat stuck at 0,
  frame 0 of every block looked like a downbeat, a Synced Clock fired once a
  block, the Pulse after it never fell, and the envelope it gated never
  released. `TransportFollower` (Swift) now keeps a sample-continuous count
  anchored at Play, passes a sample-accurate host through unchanged, and
  re-anchors only on a seek or loop wrap. The AU also reads a host with a
  musical context and no transport-state block, like the recorder's offline
  bounce, as rolling, so such a bounce no longer renders these patches silent.

- **A worklet voice could render before it had its parameters.** Values
  arrived as `setParam` messages after the node existed, and on a busy main
  thread the processor had already run a block or two with every parameter at
  zero. A ladder with drive 0 computes 0/0, and a filter keeps a NaN forever:
  the browser patcher went NaN on ladder patches after a few patch loads.
  `WebAudioRenderer.createVoice(graph, { params })` now hands the starting
  values to the processor's constructor, and `AudioMaterial.bind` and the
  scene's live voices pass them. The ladder also treats drive near 0 as the
  identity, the formula's own limit, in both interpreters.
- **Disposed worklet voices were never released.** A processor that returns
  true is kept by the browser for as long as the page lives, disconnected or
  not. `disposeVoiceHandle` now posts `{ type: 'dispose' }` and `process`
  returns false after it.
- **Idle pool voices rendered their whole graph into silence.** A released
  voice that has been silent for four blocks, with nothing at its inputs and
  no MIDI due, now skips rendering until a note or an input wakes it: the
  rule the Swift `VoicePool` retires a tail by. A held voice is never skipped,
  so inserts (gate held open) and sustained notes are unaffected. A split
  instrument's bus follows the same rule: four silent blocks with nothing
  feeding it, and the summed effects stop until a voice sounds.
- **A pulse-driven DAHDSR fired once and never again wherever the voice gate
  was held open.** The envelope read `gate cable || voice gate`, and a host
  that holds an insert's gate open (every AUv3 insert and self-playing patch)
  made that true forever: one hit at load, then silence. The cable now drives
  the envelope from the moment it first rises, and each rise retriggers it
  even under a held voice gate. An envelope whose cable never fires follows
  the voice gate exactly as before, so keyboard-played envelopes are
  unchanged. Both interpreters; the golden snapshot and the motion fixture
  are unchanged, and two Swift tests that had been failing
  (`PatchSongResetTests` and `AtmosphericSynthesizerTests`, both built on
  pulse-driven lanes) now pass, because this was their cause.
- **Waveshape's Fold and Asym curves turned silence into DC.** Fold was
  `[-1, 1, -1, 1, -1]`, which is -1 at its centre, so a folded signal sat at
  full-scale DC with nothing playing and a limiter after it clamped the rest
  of the patch; Asym put 0.05 there. Every curve now maps 0 to 0: Fold is an
  odd fold (`[1, -1, 0, 1, -1]`) and Asym keeps its lean. Patches using
  Fold or Asym sound different, on purpose.
- **SVF blew up at high cutoffs.** The topology is stable only while
  `f^2 + 2 f damp < 4`, and the `sr / 4` cutoff clamp is inside that only
  above Q 1.4. At the palette's default Q of 0.5 the SVF materials went NaN
  from 6.6 kHz, knob held still, on a cutoff that goes to 20 kHz. `f` is now
  capped at `SVF_STABILITY`; settings that were stable are bit-identical.
  Both interpreters.
- **Low and high shelves went NaN on a deep cut with a steep slope** (-17 dB
  at q 3.96, inside the materials' ranges), and stayed NaN for the rest of the
  voice. The slope-form radicand is floored at 1/Q^2 for Q 10
  (`SHELF_MIN_RADICAND`); settings that rendered before are bit-identical.
  Affects `parametricEq` too. Both interpreters.
- **Changing an envelope's attack, decay or release mid-stage jumped the
  level** (up to 0.55). A stage now keeps its fraction done when its time
  moves. Envelopes whose times hold still are bit-identical. Both interpreters.
- **Swift never had the delay and comb read-pointer glide.** The JavaScript
  click fix for sweeping a delay time or comb frequency was never ported, so
  the AUv3 still crackled while those knobs moved. Ported line for line.
- **Seeded streams are ranked by the graph's shape, not by node id.** The
  palette catalog renumbers ids and each language's flatten mints its own, so
  ranking by id could swap two noise sources between the web editor and the
  AUv3. `randomRanks`: first visit from the output, inputs in sorted name
  order.
- **`.range()` with signal bounds.** A parameter or envelope passed as a bound
  was written into params as an object and rendered NaN with no error. Signal
  bounds now lower to `add`/`mul`; constant bounds still build one `range`
  node, so existing graphs serialize unchanged. A `range` node whose bounds are
  not finite numbers is refused at compile time in both interpreters rather
  than rendering NaN (JS) or 0 (Swift).
- **SVF resonance ceiling.** The damping floor capped Q at 20, so a filter
  asked to ring for a second rang for milliseconds. It is Q 10,000 now
  (`SVF_MIN_DAMP`). The topology is stable for any positive damping at every
  cutoff the clamp allows. The palette's SVF materials still cap `q` at 20, so
  patches are unaffected.
- **Duplicate worklet registration.** `registerProcessor` is guarded by a
  registry shared across every copy of audiocrate in the worklet global, and a
  skipped registration says so on the console. `WebAudioRenderer` loads the
  module once per context per processor name, across renderer instances and
  package copies, and warns when a different build was asked for under a name
  that is already loaded. A failed load is retried.
- **`crate.plugin` size.** `stringifyCratePlugin` indented the compiled graph,
  which nests as deep as the signal chain, and the whitespace outweighed the
  data about five to one. `compiled` is written on one line now and the patch
  stays indented. Measured on XR Publisher's exports: `ambient-bloom` 266 kB to
  39 kB, `music-box` 245 kB to 35 kB. Every JSON reader parses both identically.
- **A slider and the audio thread no longer share a dictionary.** Port
  scalars and tap state are dense arrays, indexed when the plan is built.
  Looking a port up by name hashed a string on every sample, and a dictionary
  written from a slider while the render thread read it was a reproducible
  crash (`PortScalarRaceTests`). Taps are allocated with the voice
  (`TapStorageTests`), including the accumulator a tap used to create on its
  first sample.

### Changed

- **`adsrMaterial` reads a live `gate` inlet.** The graph is `env.dahdsr` with
  `audio.input('gate')`, so a cable into `gate` is the same kind of signal a
  pulse sends into `dahdsrMaterial`. `audioInputs` includes `gate`. `noteOn`
  still opens the envelope when that inlet is silent or unconnected.
- **`env.dahdsr` with a `gate` input still follows the voice gate.** A patched
  gate that sits at 0 used to ignore `noteOn`, because the compiler treated
  "gate inlet present" as "voice gate does not count." The envelope now opens
  on the signal **or** `state.gate`.
- **Factory patches were revoiced against the fixes above.** Self-playing
  patches widen the pulses that gate their envelopes, because a pulse that
  falls now really does release. Ring Lead and Bell multiply a second
  oscillator played by the keys, so the partials follow the note. The music
  box sits an octave higher. A few reverbs, decays, and levels moved with
  them. `npm run audit:presets` is the listening pass.

## 0.2.0

### Added

- **Block-rate evaluation of parameter-only subtrees.** A subtree built from
  pure operations whose leaves are parameters and constants is computed once a
  block instead of once per sample per channel. Rendered output is unchanged,
  which the golden-audio snapshot checks sample for sample.
  `CompiledVoice.blockConstantNodes` reports how much of a graph qualifies.
- `ASLValue`, `ASLValueLike` and `SampleBox` are exported as types, so a
  package writing its own ASL helpers can declare what they take and return.
- **Reset on every node that carries a position in a pattern.** `clock`,
  `clockDivide`, `clockMultiply`, `euclidean`, and `sequencer` take an optional
  `reset`. A rising edge puts the node back to its first step. It is
  edge-triggered, so a Transport `playing` held high is one restart at Play
  and not a pattern pinned at step zero for the whole song. A clock fires on
  the sample it is reset. A divider is left one short of its factor so the
  next tick through is the one that fires. A multiplier forgets the interval
  it had learned. The inlet is added to a node only when it is asked for, so
  a graph that does not use it serializes exactly as it did. The matching
  AudioMaterials expose a `reset` jack, appended so existing flatten addresses
  stay put. Flatten treats `reset` as a per-note inlet, like `clock`.
- **LFO phase and reset.** `lfo({ phase, reset })` offsets where the shape is
  read without moving stored phase, so two LFOs at one rate can sit a quarter
  cycle apart and still be the same clock. Zero is exact: an unset or zero
  `phase` is bit-identical to the LFO that had no inlet. A rising `reset`
  restarts the cycle. `lfoMaterial` exposes both; `phase` is automatable.
- **Ladder drive.** `filter.ladder` and `ladderMaterial` take `drive`. It
  saturates into the filter. The default of 1 is a branch rather than
  `tanh(x) / tanh(1)`, so a ladder that already exists is exactly itself.
- **Sample and hold on another clock.** `sampleHold` and
  `sampleHoldMaterial` take a `clock` inlet. `freq` at 0 turns the internal
  rate off, which is what keeps two grids from fighting. An uncabled jack is
  still an input holding its default, so presence of the cable cannot be the
  switch.
- **Gate hold.** `gateMaterial` and `sidechainGateMaterial` take `hold`, the
  shortest time the gate may stay open once it has opened. It is a pulse-and-or
  in ASL rather than a second envelope in the kernel. At 0 the pulse is one
  sample wide and lands on the sample that already went high, so the or is
  exactly the old open signal.
- **Live amplitude envelope on `oscillatorMaterial`.** Attack, decay, sustain,
  and release were four numbers written into the graph. They are parameters
  now, defaulted to those numbers, built from `env.dahdsr` so a live value can
  reach them. SynthVoice and Wavetable already exposed theirs.
- Drum plugin example, factory kit, and pad editing in the patcher.
- Line / Mic device picker. Android Chrome lists USB audio but often still
  captures the phone microphone; the inspector now says what actually opened.
- A module dropped while Play is running joins the live graph. Stop and Play
  are no longer required to hear it.

### Changed

- `panLaw` caches its gain per pan position rather than computing a sine and a
  cosine per sample.
- `sampleHoldMaterial.freq` now runs from 0, and its curve is exponential.
  Zero means the external clock is in charge.

## 0.1.0

First public release.

### Known issues

- The conformance gate renders only **fixed** parameters. It cannot see a
  node that is correct at every constant value and clicks when the value
  moves. A separate test covers the delay and comb cases that had that bug.
- Mobile voice budgets are estimated, not profiled.
- The kernel path has one shipped implementation.
