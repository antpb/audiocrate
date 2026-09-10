import { describe, expect, it } from 'vitest';
import { HostedAutomationBridge } from '../../src/playback/hostedAutomation';
import { HOSTED_MASTER_TRACK_INDEX, type HostedAutomationTrack } from '../../src/automation/hosted';
import { createFuzzMaterial } from '../../src/testing/testPlugin';
import { Track } from '../../src/graph/Track';
import { Bus } from '../../src/graph/Bus';
import type { LiveSceneVoices } from '../../src/playback/liveVoices';
import type { VoiceHandle } from '../../src/renderers/WebAudioRenderer';
import { fakeVoiceHandle } from '../../src/testing/fakeVoice';

interface Recorded {
  setParam: Array<[string, number]>;
}

function fakeVoice(recorded: Recorded): VoiceHandle {
  return fakeVoiceHandle({ disconnect: () => {} } as unknown as VoiceHandle['node'], {
    setParam: (name, value) => recorded.setParam.push([name, value]),
  });
}

/** One lane on (trackIndex, slotIndex, paramAddress) ramping 0 -> 127 across a 1000ms clip at offset 0. */
function ramp(trackIndex: number, slotIndex: number, paramAddress: number, minValue = 0, maxValue = 4): HostedAutomationTrack {
  return {
    trackIndex,
    clips: [
      {
        offsetMs: 0,
        trimStartMs: 0,
        durationMs: 1000,
        automationLanes: [
          {
            slotIndex,
            paramAddress,
            minValue,
            maxValue,
            points: [
              { time: 0, value: 0 },
              { time: 1, value: 127 },
            ],
          },
        ],
      },
    ],
  };
}

describe('HostedAutomationBridge', () => {
  it('routes a write to the live voice whose Material carries the matching hostedSlot', () => {
    const amp = createFuzzMaterial();
    amp.hostedSlot = { trackIndex: 3, slotIndex: 1 };
    const track = new Track({ name: 'T' });
    track.hostedTrackIndex = 3;
    track.materials.add(amp);

    const recorded: Recorded = { setParam: [] };
    const voices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[track.id, { inserts: [fakeVoice(recorded)] }]]),
    };

    const bridge = new HostedAutomationBridge();
    // address 0 is the fuzz plugin's `drive` (range 0..4)
    bridge.setLanes([ramp(3, 1, 0)]);
    bridge.bind(voices, [track], new Bus({ name: 'Master' }));

    bridge.apply(500); // halfway through the ramp
    expect(recorded.setParam).toHaveLength(1);
    const [name, value] = recorded.setParam[0]!;
    expect(name).toBe('drive');
    expect(value).toBeGreaterThan(1.9);
    expect(value).toBeLessThan(2.1);
  });

  it('does not re-send an unchanged value on the next tick, but does send a changed one', () => {
    const amp = createFuzzMaterial();
    amp.hostedSlot = { trackIndex: 0, slotIndex: 0 };
    const track = new Track({ name: 'T' });
    track.materials.add(amp);
    const recorded: Recorded = { setParam: [] };
    const voices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[track.id, { inserts: [fakeVoice(recorded)] }]]),
    };

    const bridge = new HostedAutomationBridge();
    bridge.setLanes([ramp(0, 0, 0)]);
    bridge.bind(voices, [track], new Bus({ name: 'Master' }));

    bridge.apply(500);
    expect(recorded.setParam).toHaveLength(1);
    bridge.apply(500); // same position, same value
    expect(recorded.setParam).toHaveLength(1);
    bridge.apply(800); // moved
    expect(recorded.setParam).toHaveLength(2);
  });

  it('writes clip-level lanes (virtual slot -1, address 0) into the registered clip gain node, not a voice', () => {
    const track = new Track({ name: 'T' });
    track.hostedTrackIndex = 2;
    const clipGain = { gain: { value: 1 } };

    const bridge = new HostedAutomationBridge();
    bridge.setLanes([ramp(2, -1, 0)]);
    bridge.bind({ master: [], tracks: new Map() }, [track], new Bus({ name: 'Master' }));
    bridge.setClipGainTarget(2, clipGain);

    bridge.apply(1000); // end of ramp: clip gain maps 127 -> 2.0
    expect(clipGain.gain.value).toBeCloseTo(2, 3);
  });

  it('skips clip-level pitch lanes (address 1), which have no web node to write to', () => {
    const track = new Track({ name: 'T' });
    track.hostedTrackIndex = 2;
    const clipGain = { gain: { value: 1 } };
    const bridge = new HostedAutomationBridge();
    bridge.setLanes([ramp(2, -1, 1)]);
    bridge.bind({ master: [], tracks: new Map() }, [track], new Bus({ name: 'Master' }));
    bridge.setClipGainTarget(2, clipGain);

    expect(bridge.apply(1000)).toHaveLength(0);
    expect(clipGain.gain.value).toBe(1);
  });

  it('binds master bus materials by HOSTED_MASTER_TRACK_INDEX', () => {
    const amp = createFuzzMaterial();
    amp.hostedSlot = { trackIndex: HOSTED_MASTER_TRACK_INDEX, slotIndex: 0 };
    const master = new Bus({ name: 'Master' });
    master.materials.add(amp);

    const recorded: Recorded = { setParam: [] };
    const bridge = new HostedAutomationBridge();
    bridge.setLanes([ramp(HOSTED_MASTER_TRACK_INDEX, 0, 1, -12, 12)]); // address 1 = `tone`
    bridge.bind({ master: [fakeVoice(recorded)], tracks: new Map() }, [], master);

    bridge.apply(1000);
    expect(recorded.setParam).toHaveLength(1);
    expect(recorded.setParam[0]![0]).toBe('tone');
  });

  it('ignores writes for a slot with no bound live voice instead of throwing', () => {
    const bridge = new HostedAutomationBridge();
    bridge.setLanes([ramp(7, 2, 0)]);
    bridge.bind({ master: [], tracks: new Map() }, [], new Bus({ name: 'Master' }));
    expect(bridge.apply(500)).toEqual([]);
  });

  it('binds a track instrument voice by its own hostedSlot', () => {
    // Any Material with addressed params works here; the bridge addresses by
    // (trackIndex, slotIndex, paramAddress), never by plugin identity.
    const amp = createFuzzMaterial();
    amp.hostedSlot = { trackIndex: 1, slotIndex: 4 };
    const track = new Track({ name: 'T' });
    track.instrument = amp;

    const recorded: Recorded = { setParam: [] };
    const voices: LiveSceneVoices = {
      master: [],
      tracks: new Map([[track.id, { inserts: [], instrument: fakeVoice(recorded) }]]),
    };

    const bridge = new HostedAutomationBridge();
    bridge.setLanes([ramp(1, 4, 0)]);
    bridge.bind(voices, [track], new Bus({ name: 'Master' }));
    bridge.apply(1000);
    expect(recorded.setParam).toHaveLength(1);
    expect(recorded.setParam[0]![0]).toBe('drive');
  });

  it('reset() drops bindings so stale voices are never written to after teardown', () => {
    const amp = createFuzzMaterial();
    amp.hostedSlot = { trackIndex: 0, slotIndex: 0 };
    const track = new Track({ name: 'T' });
    track.materials.add(amp);
    const recorded: Recorded = { setParam: [] };
    const bridge = new HostedAutomationBridge();
    bridge.setLanes([ramp(0, 0, 0)]);
    bridge.bind({ master: [], tracks: new Map([[track.id, { inserts: [fakeVoice(recorded)] }]]) }, [track], new Bus({ name: 'Master' }));

    bridge.reset();
    expect(bridge.apply(500)).toEqual([]);
    expect(recorded.setParam).toHaveLength(0);
  });
});
