/**
 * The "New spatial" preset, checked against the rules that would stop it
 * loading.
 *
 * A starter patch is the one piece of content a user is guaranteed to open,
 * so a cable in it that the socket rule refuses, or a param name that no
 * longer exists, is a broken first impression rather than a bug someone
 * eventually files. None of that is visible by reading the literal.
 */
import { describe, expect, it } from 'vitest';
import { isCratePatch, parsePatch, spatialPatch, stringifyPatch } from '../src/patch';
import { catalogEntry } from '../src/catalog';
import { nodeInputs, nodeOutputs } from '../src/controlInputs';
import { isBformatPort } from '../src/spatialNodes';

const patch = spatialPatch();
const kindOf = (id: string) => patch.nodes.find((n) => n.id === id)?.kind ?? '';

/** Ports a node of this kind actually has, tools and Materials alike. */
function portsFor(kind: string): { inputs: readonly string[]; outputs: readonly string[] } {
  const entry = catalogEntry(kind);
  if (!entry) return { inputs: [], outputs: [] };
  if (!entry.create) return { inputs: entry.inputs ?? [], outputs: entry.outputs ?? [] };
  const material = entry.create();
  return { inputs: nodeInputs(material), outputs: nodeOutputs(material) };
}

describe('the spatial starter patch', () => {
  it('round-trips as a crate.patch', () => {
    expect(isCratePatch(patch)).toBe(true);
    expect(parsePatch(stringifyPatch(patch))).toEqual(patch);
  });

  it('uses only kinds that are in the palette', () => {
    for (const node of patch.nodes) {
      expect(catalogEntry(node.kind), node.kind).toBeDefined();
    }
  });

  it('names only ports that exist on the nodes it connects', () => {
    for (const conn of patch.connections) {
      const from = portsFor(kindOf(conn.source));
      const to = portsFor(kindOf(conn.target));
      expect(from.outputs, `${kindOf(conn.source)}.${conn.sourceOutput}`).toContain(conn.sourceOutput);
      expect(to.inputs, `${kindOf(conn.target)}.${conn.targetInput}`).toContain(conn.targetInput);
    }
  });

  it('sets only params the Material declares', () => {
    // A renamed param would silently do nothing, which on a spatial source
    // means every position quietly reads as the default.
    for (const node of patch.nodes) {
      const entry = catalogEntry(node.kind);
      if (!entry?.create) continue;
      const material = entry.create();
      for (const name of Object.keys(node.params)) {
        expect(material.params[name], `${node.kind}.${name}`).toBeDefined();
      }
    }
  });

  it('has no cable the socket rule would refuse', () => {
    // The check `PatchEditor` runs on `connectioncreate`. A patch that fails
    // it loads with cables missing and no error.
    for (const conn of patch.connections) {
      const from = isBformatPort(kindOf(conn.source), 'output', conn.sourceOutput);
      const to = isBformatPort(kindOf(conn.target), 'input', conn.targetInput);
      expect(from, `${conn.source} -> ${conn.target}`).toBe(to);
    }
  });
});

describe('what the patch is meant to demonstrate', () => {
  it('routes several sources into one master', () => {
    const intoMaster = patch.connections.filter(
      (c) => kindOf(c.target) === 'spatialmaster' && kindOf(c.source) === 'spatialsource',
    );
    expect(intoMaster.length).toBeGreaterThanOrEqual(3);
  });

  it('reaches Master from the spatial master, through ordinary audio nodes', () => {
    // The routing question the patch exists to answer. Reachability rather
    // than adjacency, because the reverb deliberately sits in between: once
    // the field is decoded it is ordinary stereo and can be processed like
    // anything else, which is half the point of showing it.
    const intoOutput = patch.connections.filter((c) => kindOf(c.target) === 'master');
    expect(intoOutput).toHaveLength(1);

    const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
      if (from === to) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return patch.connections
        .filter((c) => c.source === from)
        .some((c) => reaches(c.target, to, seen));
    };
    const spatialMaster = patch.nodes.find((n) => n.kind === 'spatialmaster')!;
    const output = patch.nodes.find((n) => n.kind === 'master')!;
    expect(reaches(spatialMaster.id, output.id)).toBe(true);

    // And nothing bypasses the spatial master to get there.
    for (const node of patch.nodes.filter((n) => n.kind === 'spatialsource')) {
      expect(reaches(node.id, spatialMaster.id), node.id).toBe(true);
    }
  });

  it('never patches a source straight to the output', () => {
    for (const conn of patch.connections) {
      if (kindOf(conn.source) !== 'spatialsource') continue;
      expect(kindOf(conn.target)).toBe('spatialmaster');
    }
  });

  it('puts the reverb inside the field, not after the decode', () => {
    // The whole reason this is a send. A reverb after the Spatial Master
    // never passes through the rotation, so turning your head would swing
    // every source around a tail that stays put.
    const reverbs = patch.nodes.filter((n) => n.kind === 'reverb');
    expect(reverbs.length).toBeGreaterThanOrEqual(1);
    for (const reverb of reverbs) {
      const targets = patch.connections.filter((c) => c.source === reverb.id);
      expect(targets.length, reverb.id).toBeGreaterThan(0);
      for (const c of targets) expect(kindOf(c.target), reverb.id).toBe('spatialsource');
    }
  });

  it('decorrelates the two tails, because the reverb is mono', () => {
    // One mono tail sent to two positions is a phantom between them, not a
    // room. Different sizes are what make it read as diffuse.
    const reverbs = patch.nodes.filter((n) => n.kind === 'reverb');
    expect(reverbs).toHaveLength(2);
    expect(reverbs[0]!.params.size).not.toBe(reverbs[1]!.params.size);
  });

  it('trims the send, because this reverb is built to run at mix 0.28', () => {
    // Measured offline: fully wet it returns about 5x what went in.
    const send = patch.nodes.find((n) => n.id === 'send');
    expect(send?.kind).toBe('gain');
    expect(send!.params.gain).toBeLessThanOrEqual(0.1);
    for (const reverb of patch.nodes.filter((n) => n.kind === 'reverb')) {
      expect(reverb.params.mix, 'a send wants no dry through the reverb').toBe(1);
    }
  });

  it('keeps the global bed out of the room send', () => {
    // A global source has no position, so reverb on it would be a tail
    // arriving from somewhere the source is not.
    const bed = patch.nodes.find((n) => n.params.global === 1)!;
    const feedsBed = patch.connections.filter((c) => c.target === bed.id).map((c) => c.source);
    for (const id of feedsBed) {
      const onward = patch.connections.filter((c) => c.source === id).map((c) => kindOf(c.target));
      expect(onward, 'the bed source should not also feed the send').not.toContain('reverb');
    }
  });

  it('has an LFO on a position axis', () => {
    const modulated = patch.connections.find(
      (c) => kindOf(c.source) === 'lfo' && kindOf(c.target) === 'spatialsource',
    );
    expect(modulated).toBeDefined();
    expect(['x', 'y', 'z']).toContain(modulated!.targetInput);
  });

  it('includes a global source and places the others', () => {
    const sources = patch.nodes.filter((n) => n.kind === 'spatialsource');
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(sources.some((n) => n.params.global === 1)).toBe(true);
    // The placed ones are actually somewhere, not all left at the default.
    const placed = sources.filter((n) => n.params.global !== 1);
    expect(placed.every((n) => Object.keys(n.params).some((k) => 'xyz'.includes(k)))).toBe(true);
  });

  it('makes sound on Play without touching the keyboard', () => {
    // `oscillator` needs a note, so a patch that only had the keys branch
    // would be silent until you found the keybed and would demo nothing.
    // The clock is what makes it play by itself, so check the clock actually
    // reaches a spatial source rather than merely existing on the canvas.
    const clock = patch.nodes.find((n) => n.kind === 'clock');
    expect(clock).toBeDefined();

    const reachesSource = (from: string, seen = new Set<string>()): boolean => {
      if (kindOf(from) === 'spatialsource') return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return patch.connections.filter((c) => c.source === from).some((c) => reachesSource(c.target, seen));
    };
    expect(reachesSource(clock!.id)).toBe(true);
  });

  it('does not hit full scale, because four sources share one output', () => {
    // Rendered offline while tuning this: the two pings fire together, so
    // their peaks add, and the reverb adds its wet share on top. At a strike
    // of 0.3 the sum clipped.
    const strike = patch.nodes.find((n) => n.id === 'strike');
    expect(strike?.kind).toBe('gain');
    expect(strike!.params.gain).toBeLessThanOrEqual(0.25);
  });
});
