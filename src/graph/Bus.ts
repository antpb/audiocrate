import { AudioNode3, type AudioNode3Options } from './AudioNode3';

export type BusOptions = AudioNode3Options;

/** A submix bus or send: the same AudioNode3 as a Track, with a different role. */
export class Bus extends AudioNode3 {}
