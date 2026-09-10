import { type ASLNode, constNode, makeNode } from './types';

/** Anywhere a graph expects a node, a plain number is accepted too and auto-wrapped as a `const`. */
export type ASLValueLike = ASLValue | number;

export function toNode(v: ASLValueLike): ASLNode {
  return v instanceof ASLValue ? v.node : constNode(v);
}

/**
 * The chainable wrapper every ASL builder returns:
 * `osc(...).mul(0.7)`, `lfo(...).range(...)`.
 * Each method returns a new `ASLValue` wrapping a new node; nothing here
 * mutates a graph once built.
 */
export class ASLValue {
  constructor(readonly node: ASLNode) {}

  mul(other: ASLValueLike): ASLValue {
    return new ASLValue(makeNode('mul', { a: this.node, b: toNode(other) }, {}));
  }

  add(other: ASLValueLike): ASLValue {
    return new ASLValue(makeNode('add', { a: this.node, b: toNode(other) }, {}));
  }

  /** MIDI note number to frequency in Hz (A4 = note 69 = 440Hz). */
  toFrequency(): ASLValue {
    return new ASLValue(makeNode('toFrequency', { note: this.node }, {}));
  }

  /** Maps a -1..1 signal (an oscillator or lfo) onto an arbitrary [min, max] range. */
  range(min: number, max: number): ASLValue {
    return new ASLValue(makeNode('range', { source: this.node }, { min, max }));
  }

  /**
   * Only valid on an `env.adsr()` node: binds the velocity that scales the
   * envelope's peak. The envelope's own attack/release timing is driven by
   * the voice's gate (`CompiledVoice.noteOn`/`noteOff`, compile.ts), not by
   * this call, matching the spec's "a Material declares its own polyphony"
   * framing, where gating is a voice-runtime concern, not a graph-authoring one.
   */
  trigger(velocity: ASLValueLike): ASLValue {
    if (this.node.kind !== 'adsr' && this.node.kind !== 'dahdsr') {
      throw new TypeError('.trigger() is only valid on an env.adsr() or env.dahdsr() node.');
    }
    return new ASLValue(makeNode(this.node.kind, { ...this.node.inputs, trigger: toNode(velocity) }, this.node.params));
  }
}
