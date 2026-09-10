import { describe, expect, it } from 'vitest';
import {
  omitHostLocalNodeData,
  overlayHostLocalNodeData,
  restoreHostLocalPatch,
  stripHostLocalPatch,
} from '../../src/host/hostLocal';

describe('host-local device ids', () => {
  it('drops deviceId from node data and keeps channel', () => {
    expect(omitHostLocalNodeData({ deviceId: 'KeyStep', channel: 3 })).toEqual({ channel: 3 });
    expect(omitHostLocalNodeData({ deviceId: 'KeyStep' })).toBeUndefined();
    expect(omitHostLocalNodeData({ channel: 1 })).toEqual({ channel: 1 });
  });

  it('overlays this machine\'s deviceId and ignores a remote one', () => {
    expect(overlayHostLocalNodeData({ deviceId: 'theirs', channel: 2 }, { deviceId: 'mine' })).toEqual({
      deviceId: 'mine',
      channel: 2,
    });
    expect(overlayHostLocalNodeData({ channel: 2 }, { deviceId: 'mine' })).toEqual({
      channel: 2,
      deviceId: 'mine',
    });
  });

  it('strips device ids from a patch without mutating the original', () => {
    const patch = {
      nodes: [
        { id: 'in', kind: 'midiin', data: { deviceId: 'port-a', channel: 1 } },
        { id: 'line', kind: 'line', data: undefined },
      ],
    };
    const wire = stripHostLocalPatch(patch);
    expect(wire.nodes[0]?.data).toEqual({ channel: 1 });
    expect(patch.nodes[0]?.data).toEqual({ deviceId: 'port-a', channel: 1 });
    expect(stripHostLocalPatch(wire)).toBe(wire);
  });

  it('restores local ports onto a remote patch and never keeps theirs', () => {
    const local = {
      nodes: [{ id: 'in', data: { deviceId: 'mine', channel: 1 } }],
    };
    const remote = {
      nodes: [{ id: 'in', data: { deviceId: 'theirs', channel: 4 } }],
    };
    const next = restoreHostLocalPatch(remote, local);
    expect(next.nodes[0]?.data).toEqual({ channel: 4, deviceId: 'mine' });
    expect(remote.nodes[0]?.data).toEqual({ deviceId: 'theirs', channel: 4 });
  });

  it('leaves a newly arrived MIDI node without a borrowed device', () => {
    const local = { nodes: [{ id: 'old', data: { deviceId: 'mine' } }] };
    const remote = { nodes: [{ id: 'new', data: { deviceId: 'theirs', channel: 2 } }] };
    expect(restoreHostLocalPatch(remote, local).nodes[0]?.data).toEqual({ channel: 2 });
  });
});
