/**
 * The conformance fixture, as a value.
 *
 * The fixture that keeps the JavaScript and Swift interpreters in agreement.
 * Building the fixture is a function rather than a script.
 * rather than a script. `scripts/emit-asl-fixtures.ts` writes what this
 * returns; `conformanceFixture.test.ts` rebuilds it and compares it against
 * the file on disk, so a stale fixture is a failing test. The script stays
 * the only way to *update* it: regenerating on the fly would mean the two
 * implementations agree because the evidence was rewritten to say so.
 *
 * Why samples and not a digest: `Math.sin` in V8 is a bundled fdlibm port and
 * `sin` on Darwin is Apple's libm, and two correct implementations of the same
 * function may disagree in the last bit. A bit-exact digest would fail for a
 * reason that is not a bug, and chasing it would mean porting fdlibm before
 * porting the interpreter. So the other implementation is judged on how far it
 * deviates.
 *
 * It carries the graphs as JSON too, which makes it a test of graph decoding.
 * That matters: an AUv3 receives a `crate.plugin` document, not a JavaScript
 * object.
 */
import {
  ALL_NODE_KINDS,
  ALL_TRANSPORT_FIELDS,
  type ASLNode,
} from './types';
import {
  BLOCKS,
  COVERAGE_EXEMPT_KINDS,
  FRAMES,
  GOLDEN_BPM,
  GOLDEN_PARAMS,
  SR,
  allGoldenCases,
  goldenInput,
  renderGoldenCase,
} from './goldenCases';

/**
 * Bumped when the *shape* of the fixture changes, not when the audio does.
 *
 * A reader that does not understand the format must refuse the file rather
 * than decode the half it recognises: a Swift suite that silently ignored a
 * `firstR` it had never heard of would report full marks while checking one
 * channel out of two.
 *
 * 1: first and last block, left channel only, no transport.
 * 2: both channels, a rolling transport per block, and the kind list.
 */
export const CONFORMANCE_FIXTURE_VERSION = 2;

export interface ConformanceCase {
  name: string;
  insert: boolean;
  graph: unknown;
  /** The first block: attacks, one-shots, impulses. */
  first: number[];
  /** The last block: steady state, every ring buffer wrapped. */
  last: number[];
  /** Right channel, present only when the graph is evaluated per channel. */
  firstR?: number[];
  lastR?: number[];
}

export interface ConformanceFixture {
  note: string;
  version: number;
  /** FNV-1a over everything else, canonicalised. See `fixtureStamp`. */
  stamp: string;
  sampleRate: number;
  frames: number;
  blocks: number;
  bpm: number;
  params: Record<string, number>;
  input: number[];
  inputR: number[];
  /**
   * Every node kind this build of crate admits, and every transport field.
   *
   * Carried so the other implementation can check its own vocabulary against
   * this one directly, rather than a human diffing two enum declarations and
   * reporting the answer in a document. The symmetric difference being empty
   * is the thing that has to stay true; a fixture that states one side of it
   * lets the other side assert it.
   */
  kinds: string[];
  transportFields: string[];
  /** Kinds with no case, and the argument for each. Mirrors `COVERAGE_EXEMPT_KINDS`. */
  exemptKinds: Record<string, string>;
  cases: ConformanceCase[];
}

/**
 * The graph as data, with typed arrays turned into plain ones.
 *
 * Shared subgraphs are written out more than once, because JSON has no way to
 * say "the same node again". Every copy keeps its `id`, and a decoder is
 * expected to re-share by id the way `buildPlan` already does, so a diamond
 * stays one node with one piece of state rather than two that drift apart. A
 * decoder that gets this wrong produces a filter that is fed twice, which is
 * exactly the sort of thing this fixture exists to catch.
 */
function plainNode(node: ASLNode): unknown {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.params)) params[key] = plainParam(value);
  const inputs: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node.inputs)) inputs[key] = plainNode(child);
  const out: Record<string, unknown> = { id: node.id, kind: node.kind, params, inputs };
  if (node.list) out.list = node.list.map(plainNode);
  return out;
}

function plainParam(value: unknown): unknown {
  if (value instanceof Float32Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(plainParam);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = plainParam(inner);
    }
    return out;
  }
  return value;
}

/**
 * FNV-1a over the fixture with its own stamp blanked.
 *
 * Two jobs. It is what the rebuild test compares, so a stale file is one
 * string mismatch rather than a diff of two megabytes of floats. And it is
 * self-consistent, so a fixture edited by hand to make a failing case pass
 * fails its own stamp check on the Swift side, which is worth guarding
 * because a fixture is the one file in the project where editing the evidence
 * looks exactly like fixing the bug.
 */
export function fixtureStamp(fixture: Omit<ConformanceFixture, 'stamp'> & { stamp?: string }): string {
  // The fields are listed rather than spread, so the hash does not depend on
  // the order JSON.stringify happened to walk an object in. A stamp that
  // changes when a key moves is a stamp that reports staleness for edits that
  // changed nothing, and the first false alarm is the last time anyone
  // believes it.
  const body = JSON.stringify([
    fixture.version,
    fixture.sampleRate,
    fixture.frames,
    fixture.blocks,
    fixture.bpm,
    fixture.params,
    fixture.input,
    fixture.inputR,
    fixture.kinds,
    fixture.transportFields,
    fixture.exemptKinds,
    fixture.cases,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildConformanceFixture(): ConformanceFixture {
  const { left, right } = goldenInput();
  const cases: ConformanceCase[] = [];

  for (const { name, insert, graph } of allGoldenCases()) {
    const rendered = renderGoldenCase(graph, insert);
    const entry: ConformanceCase = {
      name,
      insert,
      graph: { inputs: graph.inputs, channels: graph.channels, output: plainNode(graph.output) },
      first: Array.from(rendered.first),
      last: Array.from(rendered.last),
    };
    if (rendered.firstR) entry.firstR = Array.from(rendered.firstR);
    if (rendered.lastR) entry.lastR = Array.from(rendered.lastR);
    cases.push(entry);
  }

  const fixture: Omit<ConformanceFixture, 'stamp'> = {
    note: 'Generated by scripts/emit-asl-fixtures.ts. Do not edit by hand: run `npm run fixtures:asl`.',
    version: CONFORMANCE_FIXTURE_VERSION,
    sampleRate: SR,
    frames: FRAMES,
    blocks: BLOCKS,
    bpm: GOLDEN_BPM,
    params: { ...GOLDEN_PARAMS },
    input: Array.from(left),
    inputR: Array.from(right),
    kinds: [...ALL_NODE_KINDS],
    transportFields: [...ALL_TRANSPORT_FIELDS],
    exemptKinds: { ...COVERAGE_EXEMPT_KINDS },
    cases,
  };

  return { ...fixture, stamp: fixtureStamp(fixture) };
}
