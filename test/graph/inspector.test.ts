import { describe, expect, it } from 'vitest';
import { describeMaterial, humanizeParamName } from '../../src/graph/inspector';
import { Material } from '../../src/graph/Material';
import { param } from '../../src/graph/param';
import { filter, uniform } from '../../src/asl/builders';
import { quantizeMaterial, euclideanMaterial } from '../../src/materials/control';
import { looperMaterial } from '../../src/materials/time';
import { createInputSelectMaterial } from '../../src/materials/sidechain';

const shaper = new Material({
  name: 'Shaper',
  kind: 'acme.shaper',
  params: {
    shape: param.enum(['sine', 'saw', 'square'], { default: 'saw' }),
    poles: param.stepped(2, 8, { step: 2, default: 4 }),
    active: param.toggle({ default: true }),
    cutoff: param.range(20, 20000, { default: 1000, unit: 'Hz', address: 12 }),
    gainDb: param.range(-18, 18, { default: 0, unit: 'dB', label: 'Output' }),
  },
  automatable: ['cutoff', 'gainDb'],
  graph: ({ input, params }) => filter.lowpass(input, { cutoff: params.cutoff }).mul(params.gainDb),
});

describe('describeMaterial', () => {
  it('names the Material and its registry kind', () => {
    const model = describeMaterial(shaper);
    expect(model.name).toBe('Shaper');
    expect(model.kind).toBe('acme.shaper');
  });

  it('emits one control per declared param, in declaration order', () => {
    const model = describeMaterial(shaper);
    expect(model.controls.map((c) => c.name)).toEqual([
      'shape',
      'poles',
      'active',
      'cutoff',
      'gainDb',
    ]);
  });

  it('picks a control kind per param kind', () => {
    const byName = new Map(describeMaterial(shaper).controls.map((c) => [c.name, c]));
    expect(byName.get('shape')!.kind).toBe('menu');
    expect(byName.get('poles')!.kind).toBe('stepper');
    expect(byName.get('active')!.kind).toBe('switch');
    expect(byName.get('cutoff')!.kind).toBe('fader');
  });

  it('carries the option labels a menu and a switch need to draw', () => {
    const byName = new Map(describeMaterial(shaper).controls.map((c) => [c.name, c]));
    expect(byName.get('shape')!.options).toEqual(['sine', 'saw', 'square']);
    expect(byName.get('active')!.options).toEqual(['Off', 'On']);
    expect(byName.get('cutoff')!.options).toBeUndefined();
  });

  it('reports the live value, its normalized form, and its display string', () => {
    const material = new Material({
      name: 'One',
      params: { drive: param.range(0, 4, { default: 1 }) },
      graph: ({ params }) => uniform(1).mul(params.drive),
    });
    material.setParam('drive', 3);
    const control = describeMaterial(material).controls[0]!;
    expect(control.value).toBe(3);
    expect(control.normalized).toBe(0.75);
    expect(control.display).toBe('3');
  });

  it('prefers a declared label and derives one otherwise', () => {
    const byName = new Map(describeMaterial(shaper).controls.map((c) => [c.name, c]));
    expect(byName.get('gainDb')!.label).toBe('Output');
    expect(byName.get('cutoff')!.label).toBe('Cutoff');
  });

  it('marks which controls an automation lane may write', () => {
    const byName = new Map(describeMaterial(shaper).controls.map((c) => [c.name, c]));
    expect(byName.get('cutoff')!.automatable).toBe(true);
    expect(byName.get('shape')!.automatable).toBe(false);
  });

  it('passes a plugin address through when there is one', () => {
    const byName = new Map(describeMaterial(shaper).controls.map((c) => [c.name, c]));
    expect(byName.get('cutoff')!.address).toBe(12);
    expect(byName.get('gainDb')!.address).toBeUndefined();
  });

  it('says whether the Material is an insert or a source', () => {
    expect(describeMaterial(shaper).readsAudio).toBe(true);
    const source = new Material({
      name: 'Tone',
      params: { level: param.range(0, 1, { default: 0.5 }) },
      graph: ({ params }) => uniform(1).mul(params.level),
    });
    expect(describeMaterial(source).readsAudio).toBe(false);
  });

  it('lists aux inputs a host still has to route', () => {
    const model = describeMaterial(createInputSelectMaterial());
    expect(model.auxInputs).toEqual(['sidechain']);
    expect(describeMaterial(shaper).auxInputs).toEqual([]);
  });

  it('reports polyphony and held assets', () => {
    const poly = new Material({
      name: 'Pad',
      polyphony: 8,
      params: {},
      graph: ({ note }) => note.toFrequency(),
    });
    poly.setAsset('acme.table', new Float32Array(4));
    const model = describeMaterial(poly);
    expect(model.polyphony).toBe(8);
    expect(model.assets).toEqual(['acme.table']);
  });

  it('produces no controls for a Material with none', () => {
    const plain = new Material({ name: 'Invert', graph: ({ input }) => input.mul(-1) });
    expect(describeMaterial(plain).controls).toEqual([]);
  });
});

describe('the core library through the inspector model', () => {
  it('shows the quantizer root and scale as menus of names', () => {
    const byName = new Map(describeMaterial(quantizeMaterial).controls.map((c) => [c.name, c]));
    expect(byName.get('root')!.kind).toBe('menu');
    expect(byName.get('root')!.options?.[0]).toBe('C');
    expect(byName.get('scale')!.options).toEqual([
      'major',
      'minor',
      'pentatonic',
      'chromatic',
      'wholeTone',
    ]);
  });

  it('keeps the scale value at the index it always was', () => {
    // The graph reads this as an index into QUANTIZE_SCALES. Naming the
    // options must not renumber them, or every saved project shifts key.
    expect(quantizeMaterial.params.scale!.default).toBe(0);
    quantizeMaterial.setOption('scale', 'chromatic');
    expect(quantizeMaterial.getParam('scale')).toBe(3);
    quantizeMaterial.setOption('scale', 'major');
  });

  it('shows a whole-number control as a stepper', () => {
    const byName = new Map(describeMaterial(euclideanMaterial).controls.map((c) => [c.name, c]));
    expect(byName.get('steps')!.kind).toBe('stepper');
    expect(byName.get('steps')!.step).toBe(1);
  });

  it('shows a gate as a switch with the labels that mean something', () => {
    const control = describeMaterial(looperMaterial).controls[0]!;
    expect(control.kind).toBe('switch');
    expect(control.options).toEqual(['Off', 'Record']);
  });
});

describe('humanizeParamName', () => {
  it('splits camel case and separators, and capitalises', () => {
    expect(humanizeParamName('cutoff')).toBe('Cutoff');
    expect(humanizeParamName('fadeInSec')).toBe('Fade In Sec');
    expect(humanizeParamName('time_sec')).toBe('Time Sec');
    expect(humanizeParamName('step0')).toBe('Step0');
  });

  it('returns something for a name it cannot improve', () => {
    expect(humanizeParamName('q')).toBe('Q');
    expect(humanizeParamName('')).toBe('');
  });
});
