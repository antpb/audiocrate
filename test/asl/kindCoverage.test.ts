/**
 * The gate that stops the multi-target claim from quietly ceasing to be true.
 *
 * The check is not "the numbers still line up". It is "every kind the
 * language admits has evidence behind it", which is a question a test can
 * only ask if the kinds are enumerable at runtime. That is what
 * `ALL_NODE_KINDS` is for.
 */
import { describe, expect, it } from 'vitest';
import {
  COVERAGE_EXEMPT_KINDS,
  allGoldenCases,
  coveredKinds,
  coveredNodeFields,
  coveredTransportFields,
  renderGoldenCase,
} from '../../src/asl/goldenCases';
import { LOOPER_FIELDS, PITCH_FIELDS } from '../../src/asl/builders';
import { ALL_NODE_KINDS, ALL_TRANSPORT_FIELDS } from '../../src/asl/types';

describe('golden case coverage', () => {
  it('every node kind has a golden case, or a stated reason it cannot', () => {
    const covered = coveredKinds();
    const missing = ALL_NODE_KINDS.filter(
      (kind) => !covered.has(kind) && !(kind in COVERAGE_EXEMPT_KINDS),
    );
    expect(
      missing,
      missing.length === 0
        ? ''
        : `These node kinds render in no golden case, so no second implementation is ` +
          `held to them: ${missing.join(', ')}. Add a case to sourceCases or ` +
          `insertCases in asl/goldenCases.ts, then regenerate the conformance ` +
          `fixture with \`npm run fixtures:asl\`. If a kind genuinely cannot be ` +
          `compared sample by sample, add it to COVERAGE_EXEMPT_KINDS with the ` +
          `argument for why.`,
    ).toEqual([]);
  });

  it('every transport field has a golden case', () => {
    // A second dimension, and one a single `transport` case would hide: the
    // fields share a snapshot and nothing else, so proving `beats`
    // decodes proves nothing at all about `division`.
    const covered = coveredTransportFields();
    const missing = ALL_TRANSPORT_FIELDS.filter((field) => !covered.has(field));
    expect(missing).toEqual([]);
  });

  it('every field of a multi-field kind has a golden case', () => {
    // The hole this closes: a kind carrying a `field` param is several nodes
    // sharing a name, and counting the kind once read a single `looper` case
    // as evidence for its `start` and `end` outlets as well. It was not. Five
    // fields across two kinds were rendering in no case at all while the
    // coverage gate reported full marks.
    //
    // The field lists are the same runtime arrays the builders use, so a field
    // added to one fails here rather than going quietly uncovered.
    const families: Array<{ kind: string; fields: readonly string[]; defaultField: string }> = [
      { kind: 'looper', fields: LOOPER_FIELDS, defaultField: 'audio' },
      { kind: 'pitch', fields: PITCH_FIELDS, defaultField: 'midi' },
    ];
    const missing: string[] = [];
    for (const family of families) {
      const covered = coveredNodeFields(family.kind, family.defaultField);
      for (const field of family.fields) {
        if (!covered.has(field)) missing.push(`${family.kind}.${field}`);
      }
    }
    expect(
      missing,
      missing.length === 0
        ? ''
        : `These fields render in no golden case, so no second implementation ` +
          `is held to them: ${missing.join(', ')}. Add a case per field the way ` +
          `the transport fields have one each, then regenerate with ` +
          `\`npm run fixtures:asl\`.`,
    ).toEqual([]);
  });

  it('no two cases of one field family render the same thing', () => {
    // The hole underneath the one above, and it caught a case I had just
    // written. `start` and `end` were driven by the audio case's one-sample
    // `clock`, which opens and closes a take on consecutive samples. `playLen`
    // came out as 1, so `playRead === 0` and `playRead === playLen - 1` were
    // both true on every sample and the two outlets were constant 1 and
    // identical. Audible, so the silence check passed. Covered, so the field
    // check passed. Asserting nothing, because swapping the two fields in the
    // other implementation changed no sample.
    //
    // Two cases that differ only by `field` and render identically mean the
    // field is being read by nobody.
    const families = [
      ['looper start pulse', 'looper end pulse'],
      ['pitch', 'pitch hz', 'pitch cents', 'pitch gate'],
    ];
    const byName = new Map(allGoldenCases().map((entry) => [entry.name, entry]));
    const identical: string[] = [];
    for (const family of families) {
      const rendered = family.map((name) => {
        const entry = byName.get(name);
        expect(entry, `${name} is not a golden case`).toBeDefined();
        const { first, last } = renderGoldenCase(entry!.graph, entry!.insert);
        return { name, key: `${Array.from(first).join(',')}|${Array.from(last).join(',')}` };
      });
      for (let i = 0; i < rendered.length; i++) {
        for (let j = i + 1; j < rendered.length; j++) {
          if (rendered[i]!.key === rendered[j]!.key) {
            identical.push(`${rendered[i]!.name} === ${rendered[j]!.name}`);
          }
        }
      }
    }
    expect(
      identical,
      identical.length === 0
        ? ''
        : `These cases differ only by \`field\` and render identically, so no ` +
          `implementation is held to the difference between them: ` +
          `${identical.join(', ')}. Drive the case so the fields actually ` +
          `diverge.`,
    ).toEqual([]);
  });

  it('exemptions name a kind that exists', () => {
    // An exemption for a kind that has since been renamed reads as coverage
    // and is the opposite of it.
    const stale = Object.keys(COVERAGE_EXEMPT_KINDS).filter(
      (kind) => !(ALL_NODE_KINDS as readonly string[]).includes(kind),
    );
    expect(stale).toEqual([]);
  });

  it('exemptions are not silently covered anyway', () => {
    // If an exempt kind turns out to render in a case, the exemption is a
    // lie about what the fixture asserts, and worse, the case will flap.
    const covered = coveredKinds();
    const contradicted = Object.keys(COVERAGE_EXEMPT_KINDS).filter((kind) => covered.has(kind));
    expect(contradicted).toEqual([]);
  });

  it('no case renders silence unless silence is the point', () => {
    // A case that outputs nothing at all covers a node kind on paper and
    // asserts nothing: two implementations agree on zero however wrongly they
    // each arrived at it. This caught a real one. `onset` compares its
    // threshold against a per-sample change in a 5 ms envelope rather than
    // against a level, so a plausible-looking 0.02 could never fire, and the
    // case sat in the fixture proving that both interpreters can output
    // silence.
    const silentByDesign = new Set(['kernel source unbound silence']);
    const silent: string[] = [];
    for (const { name, insert, graph } of allGoldenCases()) {
      if (silentByDesign.has(name)) continue;
      const { first, last, firstR, lastR } = renderGoldenCase(graph, insert);
      const blocks = [first, last, firstR, lastR].filter((b): b is Float32Array => b !== null);
      const loudest = blocks.reduce(
        (peak, block) => block.reduce((acc, v) => Math.max(acc, Math.abs(v)), peak),
        0,
      );
      if (loudest === 0) silent.push(name);
    }
    expect(silent).toEqual([]);
  });

  it('case names are unique across sources and inserts', () => {
    // The fixture is a flat list keyed by name, and a duplicate would mean a
    // case that silently replaces another rather than adding to it.
    const names = allGoldenCases().map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
