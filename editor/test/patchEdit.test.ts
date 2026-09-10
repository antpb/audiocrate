import { describe, expect, it } from 'vitest';
import { LoopbackHub } from '../../src/collab/CollabTransport';
import { SceneSync } from '../../src/collab/SceneSync';
import { starterPatch } from '../src/patch';
import { patchFromEdit, publishPatch, publishTransport, transportActionFromEdit } from '../src/patchEdit';

describe('patch edits', () => {
  it('round-trips a patch document over SceneSync', () => {
    const hub = new LoopbackHub({ schedule: (fn) => fn() });
    const options = { setInterval: () => 0, clearInterval: () => {}, now: () => 1 };
    const a = new SceneSync(hub.join('peer-a'), options);
    const b = new SceneSync(hub.join('peer-b'), options);
    let received = starterPatch();
    received.nodes = [];
    b.onEdit((edit) => {
      const patch = patchFromEdit(edit);
      if (patch) received = patch;
    });
    const sent = starterPatch();
    publishPatch(a, sent);
    expect(received.nodes.map((node) => node.id)).toEqual(sent.nodes.map((node) => node.id));
    expect(received.connections).toEqual(sent.connections);
    a.close();
    b.close();
  });

  it('does not send MIDI or audio device ids across the session', () => {
    const hub = new LoopbackHub({ schedule: (fn) => fn() });
    const options = { setInterval: () => 0, clearInterval: () => {}, now: () => 1 };
    const a = new SceneSync(hub.join('peer-a'), options);
    const b = new SceneSync(hub.join('peer-b'), options);
    let received = starterPatch();
    b.onEdit((edit) => {
      const patch = patchFromEdit(edit);
      if (patch) received = patch;
    });
    const sent = starterPatch();
    sent.nodes.push({
      id: 'midi',
      kind: 'midiout',
      x: 0,
      y: 0,
      params: {},
      data: { deviceId: 'KeyStep-37', channel: 3, message: 0 },
    });
    publishPatch(a, sent);
    const midi = received.nodes.find((node) => node.id === 'midi');
    expect(midi?.data).toEqual({ channel: 3, message: 0 });
    expect(midi?.data).not.toHaveProperty('deviceId');
    a.close();
    b.close();
  });

  it('round-trips play and stop', () => {
    const hub = new LoopbackHub({ schedule: (fn) => fn() });
    const options = { setInterval: () => 0, clearInterval: () => {}, now: () => 1 };
    const a = new SceneSync(hub.join('peer-a'), options);
    const b = new SceneSync(hub.join('peer-b'), options);
    const actions: string[] = [];
    b.onEdit((edit) => {
      const action = transportActionFromEdit(edit);
      if (action) actions.push(action);
    });
    publishTransport(a, 'playing');
    publishTransport(a, 'stopped');
    expect(actions).toEqual(['playing', 'stopped']);
    a.close();
    b.close();
  });

  it('round-trips play and stop even when audio clocks disagree', () => {
    const hub = new LoopbackHub({ schedule: (fn) => fn() });
    let wall = 1000;
    const timers = { setInterval: () => 0, clearInterval: () => {} };
    const a = new SceneSync(hub.join('peer-a'), { ...timers, now: () => 80, wallNow: () => wall });
    const b = new SceneSync(hub.join('peer-b'), { ...timers, now: () => 1, wallNow: () => wall });
    const actions: string[] = [];
    b.onEdit((edit) => {
      const action = transportActionFromEdit(edit);
      if (action) actions.push(action);
    });
    publishTransport(a, 'playing');
    wall += 1;
    publishTransport(a, 'stopped');
    expect(actions).toEqual(['playing', 'stopped']);
    a.close();
    b.close();
  });
});
