# The crate.plugin format

A `crate.plugin` is a sound as a document: an instrument or an effect that
opens in the patch editor, loads as an AUv3 in homecrate, and plays in an XR
Publisher world, from the same file. This page is the specification, the
version history, and the promise about what happens to a file you export
today.

The reference reader and writer are `src/patcher/cratePlugin.ts` and
`src/patcher/compiledPlugin.ts`. The second reader is
`CratePluginDocument` in CrateASL (Swift). Both are held to
`fixtures/plugin-format-conformance.json`.

## The promise

**A file that any released audiocrate wrote will open in every later
release.** Readers never drop a format version. A change that would make an
old file mean something different is a new version, not an edit to an old
one.

**A reader refuses what it does not understand, and says so.** A file with a
newer format than the reader knows is rejected before anything in it is used,
with a message naming the version. A host never plays the half of a document
it happens to recognise, because that is a sound the author never made.

**Readers ship before writers.** A new format version is readable in a
released audiocrate and in CrateASL before any editor writes it by default.
Until then, writing it is opt-in.

## The document

JSON, UTF-8. One object:

| Field | Type | |
|---|---|---|
| `version` | integer | Format version, 1 or 2. See below. |
| `kind` | `"crate.plugin"` | Fixed. |
| `id` | string | Registry kind, e.g. `user.shimmer-chain`. Stable: a host hashes it (FNV-1a) into the AU subtype that a saved project addresses the plugin by. |
| `label` | string | Display name. |
| `role` | `"insert"` or `"instrument"` | An effect on a track, or a voice played by notes. |
| `polyphony` | integer, optional | Instrument voice count. |
| `steal` | `"oldest"` or `"quietest"`, optional | Voice stealing policy. |
| `patch` | object | The editable source. See **The patch**. |
| `compiled` | object, optional | What a host without a patcher runs. See **The compiled graph**. |

A host that has a patcher reads `patch` and flattens it itself. A host that
does not (the AUv3, an XR world) reads `compiled`. Nothing reads both. A
document with no `compiled` is not corrupt, it is from before `compiled`
existed, and a patcherless host refuses it with a message to re-export.

### The patch

```json
{ "nodes": [{ "id": "n1", "kind": "svflowpass", "params": { "cutoff": 900 } }],
  "connections": [{ "source": "n1", "sourceOutput": "output", "target": "m", "targetInput": "input" }] }
```

`nodes[].kind` names an AudioMaterial in the host's registry, or one of the
host I/O kinds (`master`, `line`, `keyboard`, `transport`, `midiin`,
`midiout`). An editor may store more on a node (a canvas position); readers
carry unknown fields through untouched. `deviceId` on a MIDI node is
host-local and is stripped before a document leaves the machine.

### The compiled graph

```json
{ "graph": { "inputs": ["cutoff"], "output": { ... }, "channels": 2 },
  "params": { "cutoff": { "kind": "range", "min": 20, "max": 20000, "default": 900, "curve": "log", "address": 0 } },
  "name": "Warm Filter", "role": "insert", "polyphony": 8, "ports": ["input"] }
```

- `graph.inputs`: the parameter names the graph reads, in first-access order.
- `graph.output`: the root node (below).
- `graph.channels`: 1 or 2 to force the channel count; absent means decide
  from the graph.
- `params`: the published parameter schema. `kind` is `range`, `stepped`,
  `enum` or `toggle`. `address` is the AU parameter address a native host
  builds its tree from, which is why it travels with the graph.
- `ports`: the live audio inputs the graph reads, sorted, `input` included.
- `graph.smooth`, optional: parameter names whose host changes glide over
  5 ms rather than jump (`isSmoothedParam`). Added without a version change,
  because a reader that ignores it still runs the graph correctly; it only
  steps where it would have glided.

- `graph.sends` and `graph.bus`, format 3: a split instrument (below).

A node:

```json
{ "id": 7, "kind": "svf", "params": { "mode": "lowpass" }, "inputs": { "input": { ... }, "cutoff": { ... } } }
```

`kind` is one of the ASL node kinds (`ALL_NODE_KINDS`). `params` holds
authoring-time constants; typed arrays are written as plain arrays. `inputs`
maps input names to child nodes. `list` (only on `mix`) is an array of
children.

**`id` is load-bearing.** A graph is a DAG: one filter can feed two places.
Two appearances with the same id are the same node, with one state, and a
reader must compile them as one. A reader that gives each appearance its own
state gives one filter two delay lines, which compiles, plays, and sounds
almost right.

**The numbers themselves are not.** A writer may renumber ids freely
(`canonicalizeSerializedGraph` does, to make exports diffable) as long as the
same node keeps the same id throughout the document. Each `noise` and `random`
node's stream is picked by its place in the graph's shape (`randomRanks`), not
by its id, so renumbering never changes the sound.

## Versions

### Format 1

Every appearance of a node is written in full, so a node reached from two
places is written twice, with the same id both times.

### Format 2 (readable from audiocrate 0.3 and CrateASL, September 2026)

A node is written in full the first time it is reached, depth first in the
order its keys are written, and as a reference after that:

```json
{ "ref": 7 }
```

A reference has `ref` and no `kind`. It means "the node whose id is 7",
exactly: the same node, not a copy. A reader:

- resolves every reference to the node with that id, wherever the definition
  appears in the document;
- refuses a reference to an id that is never defined;
- refuses a node that is, through references, its own input;
- may refuse a graph that would expand past a million node appearances.
  CrateASL does, because a small format 2 file can describe a very large tree
  and some walkers do not memoise.

References are allowed, not required: a format 2 document with none is valid,
and is what re-saving a format 2 file without sharing produces. Nothing
outside `compiled.graph` changed.

Measured on real exports, as format 1 text (after the 0.3 layout change that
writes `compiled` on one line) against format 2:

| Plugin | Format 1 | Format 2 |
|---|---|---|
| `ambient-bloom` | 38.8 kB | 15.9 kB |
| `music-box` | 35.0 kB | 13.4 kB |
| `parametricEq` alone | 13.0 kB | 4.9 kB |

Writing it: `stringifyCratePlugin(doc, { shareNodes: true })`. The editor
writes format 1 by default until the hosts that open its files read format 2.

### Format 3 (readable from audiocrate 0.4 and CrateASL, October 2026)

An instrument whose effects run once on the sum of its voices rather than once
per voice. A patch is modular topology: eight oscillator voices into one
reverb is one reverb. Format 1 and 2 instruments copy the whole chain into
every voice; format 3 writes the chain in two halves:

```json
{ "graph": { "inputs": [...], "output": { ... },
             "sends": [{ "ref": 12 }],
             "bus": { "inputs": [...], "output": { ... } } }, ... }
```

- `graph` is the per-voice half. `graph.sends` lists the signals a voice hands
  on, each a node inside `graph.output` (written in full or as a reference;
  either way it is the node `output` defines with that id). `graph.output` is
  their mix.
- `graph.bus` is the summed half, a graph of its own whose ports `send0`,
  `send1`, ... read the sends. A host renders every voice, sums each send
  across voices, and runs the bus once on the sums. Its gate is held open, as
  an insert's is. It shares the document's `params`.

Which modules land in which half is `voicing.ts` (CrateASL `VoicingPlan`): a
module stays per voice when it is a voice source, reads its voice, is played
by the keyboard, has a per-voice signal on a control input, combines per-voice
signals on two audio inputs, feeds anything per voice, or carries
`"voicing": "instanced"` on its patch node. A patch node's `voicing` is
optional, and a patch with nothing to sum is written exactly as before.

Written as format 3 only when `graph.bus` is present, so every other document
keeps its version. A format 2 reader would otherwise ignore the bus and play
the voices without their effects, which is the kind of misreading a version
exists to prevent.

## What changes a version, and what does not

Needs a new version:

- anything that would make an existing file mean something else;
- a new required field;
- a new encoding a current reader would misread rather than reject.

Does not:

- a new optional field that a reader which ignores it still runs correctly
  (how `compiled` itself was added to format 1);
- a new ASL node kind. A reader that does not know a kind already refuses the
  graph, by name;
- whitespace and key order. `stringifyCratePlugin` indents `patch` and writes
  `compiled` on one line; any JSON reader parses both layouts identically.

## Checking a reader

`fixtures/plugin-format-conformance.json` holds six real materials written
both ways, with what JavaScript renders from them. A reader passes when:

1. both texts decode;
2. both resolve to exactly the recorded number of distinct nodes;
3. both render the recorded samples, format 1 and 2 identically to each other
   and within 5e-6 of JavaScript.

The Swift replay is `PluginFormatConformanceTests.swift`. Regenerate the
fixture with `npm run fixtures:plugin-format` from `web-version/`; never by
hand.
