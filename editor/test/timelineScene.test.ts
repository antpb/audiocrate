import { describe, expect, it } from 'vitest';
import {
  AudioScene,
  clipGainLinear,
  createSamplePlayerMaterial,
  gainMaterial,
  renderPlan,
  schedulePlan,
  SCENE_PLAN_VERSION,
} from '../../src/index';
import { HAS_GRAIN } from './siblings';
import { createGrainMaterial } from '../../../crate-grain/src/index';
import { applySample } from '../src/nodeAssets';
import { silentJack, type JackActivity } from '../src/activity';
import { idsReachingMaster } from '../src/graphReach';
import {
  clipPlacementFromPlayer,
  collectTimelineLanes,
  hasScheduledClipData,
  laneKeyForNode,
  overlaySpread,
  patchUsesTimeline,
  spreadActivity,
  editorTimelinePlan,
  fillTimelineScene,
  type TimelineSource,
} from '../src/timelineScene';

function source(partial: Partial<TimelineSource> & Pick<TimelineSource, 'nodeIds' | 'kinds'>): TimelineSource {
  return {
    materials: new Map(),
    connections: [],
    transport: { bpm: 90, beatsPerBar: 4, beatUnit: 4, startSec: 21.3 },
    nodeData: () => undefined,
    ...partial,
  };
}

describe('timeline lanes', () => {
  it('treats imported clip offsets as a timeline patch', () => {
    expect(hasScheduledClipData({ clipOffsetSec: 21.3, clipDurationSec: 8 })).toBe(true);
    expect(
      patchUsesTimeline(
        source({
          nodeIds: ['t0-clip'],
          kinds: new Map([['t0-clip', 'sampleplayer']]),
          nodeData: () => ({ clipOffsetSec: 0, clipDurationSec: 4 }),
        }),
      ),
    ).toBe(true);
  });

  it('does not steal a live sample player with no clip placement', () => {
    expect(
      patchUsesTimeline(
        source({
          nodeIds: ['player'],
          kinds: new Map([['player', 'sampleplayer']]),
        }),
      ),
    ).toBe(false);
  });

  it('groups import ids onto DAW tracks', () => {
    const lanes = collectTimelineLanes(
      source({
        nodeIds: ['t0-aaa', 't0-gain', 't0-pan', 't1-inst', 'midi-1-c'],
        kinds: new Map([
          ['t0-aaa', 'sampleplayer'],
          ['t0-gain', 'gain'],
          ['t0-pan', 'stereopan'],
          ['t1-inst', 'synth'],
          ['midi-1-c', 'midiclip'],
        ]),
        connections: [{ source: 'midi-1-c', sourceOutput: 'cv', target: 't1-inst', targetInput: 'note' }],
        nodeData: (id) => (id === 't0-aaa' || id === 'midi-1-c' ? { clipOffsetSec: 0, offsetSec: 0 } : undefined),
      }),
    );
    expect(lanes.map((lane) => lane.key).sort()).toEqual(['t0', 't1']);
    const audio = lanes.find((lane) => lane.key === 't0');
    const inst = lanes.find((lane) => lane.key === 't1');
    expect(audio?.sampleIds).toEqual(['t0-aaa']);
    expect(audio?.gainId).toBe('t0-gain');
    expect(inst?.instId).toBe('t1-inst');
    expect(inst?.midiIds).toEqual(['midi-1-c']);
  });

  it.skipIf(!HAS_GRAIN)('does not treat a Grain insert as the track instrument', () => {
    const lanes = collectTimelineLanes(
      source({
        nodeIds: ['t0-clip', 't0-grain', 't0-gain', 't0-pan'],
        kinds: new Map([
          ['t0-clip', 'sampleplayer'],
          ['t0-grain', 'grain'],
          ['t0-gain', 'gain'],
          ['t0-pan', 'stereopan'],
        ]),
        materials: new Map([['t0-grain', createGrainMaterial()]]),
        nodeData: (id) => (id === 't0-clip' ? { clipOffsetSec: 0, clipDurationSec: 4 } : undefined),
      }),
    );
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.sampleIds).toEqual(['t0-clip']);
    expect(lanes[0]?.instId).toBeNull();
    expect(lanes[0]?.gainId).toBe('t0-gain');
  });

  it('reads trim and stretch from the sample player the way the DAW does', () => {
    const material = createSamplePlayerMaterial();
    applySample(material, {
      filename: 'take.wav',
      samples: new Float32Array(44100),
      sampleRate: 44100,
    });
    material.setParam('start', 0.25);
    material.setParam('rate', 0.5);
    material.setParam('gain', 1);
    const placed = clipPlacementFromPlayer(material, { clipOffsetSec: 8, clipDurationSec: 4 });
    expect(placed?.offsetSec).toBe(8);
    expect(placed?.trimStartSec).toBeCloseTo(0.25, 5);
    expect(placed?.stretchRatio).toBeCloseTo(2, 5);
    expect(placed?.trimEndSec).toBeCloseTo(0.25 + 2, 5);
  });
});

describe('laneKeyForNode', () => {
  it('parses import prefixes', () => {
    expect(laneKeyForNode('t4-gain', 'gain', undefined)).toBe('t4');
    expect(laneKeyForNode('midi-2-x', 'midiclip', { offsetSec: 1 })).toBe('t2');
  });
});

describe('spreadActivity', () => {
  it('lights the cable path from a clip through inserts to master', () => {
    const jack: JackActivity = { ...silentJack(), peak: 0.6, rms: 0.2 };
    const frames = spreadActivity(
      new Map([['t0-clip', jack]]),
      [
        { source: 't0-clip', sourceOutput: 'audio', target: 't0-eq', targetInput: 'input' },
        { source: 't0-eq', sourceOutput: 'audio', target: 't0-gain', targetInput: 'input' },
        { source: 't0-gain', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
      ],
    );
    expect(frames.get('t0-clip')?.outputs.audio?.peak).toBe(0.6);
    expect(frames.get('t0-eq')?.inputs.input?.peak).toBe(0.6);
    expect(frames.get('t0-eq')?.outputs.audio?.peak).toBe(0.6);
    expect(frames.get('master')?.inputs.input?.peak).toBe(0.6);
  });

  it('paints a live source along cables so gain and pan light without their own tap', () => {
    const jack: JackActivity = { ...silentJack(), peak: 0.5, rms: 0.2 };
    const frames = new Map([
      ['t1-inst', { outputs: { audio: jack }, inputs: {} }],
    ]);
    overlaySpread(frames, [
      { source: 't1-inst', sourceOutput: 'audio', target: 't1-gain', targetInput: 'input' },
      { source: 't1-gain', sourceOutput: 'audio', target: 't1-pan', targetInput: 'input' },
      { source: 't1-pan', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
    ]);
    expect(frames.get('t1-gain')?.outputs.audio?.peak).toBe(0.5);
    expect(frames.get('t1-pan')?.outputs.audio?.peak).toBe(0.5);
    expect(frames.get('t1-pan')?.inputs.input?.peak).toBe(0.5);
  });
});

describe('synth mix path', () => {
  it('drops the instrument from Master when its audio cable is removed', () => {
    const nodes = [
      { id: 't1-inst', kind: 'synth' },
      { id: 't1-gain', kind: 'gain' },
      { id: 't1-pan', kind: 'stereopan' },
      { id: 'master', kind: 'master' },
    ];
    const plugged = [
      { source: 't1-inst', target: 't1-gain' },
      { source: 't1-gain', target: 't1-pan' },
      { source: 't1-pan', target: 'master' },
    ];
    expect([...idsReachingMaster(nodes, plugged)].sort()).toEqual(['master', 't1-gain', 't1-inst', 't1-pan']);
    const unplugged = plugged.filter((conn) => conn.source !== 't1-inst');
    expect([...idsReachingMaster(nodes, unplugged)].sort()).toEqual(['master', 't1-gain', 't1-pan']);
  });
});

function timelinePatch() {
  const one = createSamplePlayerMaterial();
  const two = createSamplePlayerMaterial();
  // 4 seconds of ramp at 8 kHz: the sample at file position t is t, so a
  // rendered value states where it was read from.
  const sr = 8000;
  const samples = new Float32Array(sr * 4);
  for (let i = 0; i < samples.length; i++) samples[i] = i / sr;
  applySample(one, { samples, sampleRate: sr, name: 'take-a' });
  applySample(two, { samples, sampleRate: sr, name: 'take-b' });
  one.setParam('gain', 1);
  // The second clip is quieter and half speed on purpose. With both at unity
  // gain and unity rate, an assertion that the scene took its stretch and gain
  // from the plan passes against a scene that hardcoded the defaults.
  two.setParam('gain', 0.5);
  two.setParam('rate', 0.5);

  // Distinct faders on purpose. With every gain left at 1 an assertion that
  // the scene took its volume from the plan passes against a scene that
  // hardcoded 1, and the conversion would be untested where it matters most.
  const gainOne = gainMaterial.duplicate();
  const gainTwo = gainMaterial.duplicate();
  const masterGain = gainMaterial.duplicate();
  gainOne.setParam('gain', 0.3);
  gainTwo.setParam('gain', 0.7);
  masterGain.setParam('gain', 0.6);

  const data: Record<string, Record<string, unknown>> = {
    't0-clip': { clipOffsetSec: 0, clipDurationSec: 2 },
    't1-clip': { clipOffsetSec: 1, clipDurationSec: 2 },
  };
  return source({
    nodeIds: ['t0-clip', 't0-gain', 't1-clip', 't1-gain', 'master-gain', 'master'],
    kinds: new Map([
      ['t0-clip', 'sampleplayer'],
      ['t0-gain', 'gain'],
      ['t1-clip', 'sampleplayer'],
      ['t1-gain', 'gain'],
      ['master-gain', 'gain'],
      ['master', 'master'],
    ]),
    materials: new Map([
      ['t0-clip', one],
      ['t1-clip', two],
      ['t0-gain', gainOne],
      ['t1-gain', gainTwo],
      ['master-gain', masterGain],
    ]),
    connections: [
      { source: 't0-clip', sourceOutput: 'audio', target: 't0-gain', targetInput: 'input' },
      { source: 't0-gain', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
      { source: 't1-clip', sourceOutput: 'audio', target: 't1-gain', targetInput: 'input' },
      { source: 't1-gain', sourceOutput: 'audio', target: 'master', targetInput: 'input' },
    ],
    nodeData: (id) => data[id],
  });
}

describe('the timeline as a scene plan', () => {
  /**
   * `fillTimelineScene` builds its `AudioScene` from a `ScenePlan` rather than
   * straight from the editor. These check the document actually carries the
   * session, which is the only way to find out whether a format designed
   * against its own conformance cases describes anything else.
   */

  it('carries every lane and clip into the document', () => {
    const { plan, buffers, lanes } = editorTimelinePlan(timelinePatch());
    expect(plan.version).toBe(SCENE_PLAN_VERSION);
    expect(plan.tracks).toHaveLength(lanes.length);
    const placed = plan.tracks.flatMap((track) => track.clips);
    expect(placed).toHaveLength(2);
    expect(placed.map((clip) => clip.offsetSec).sort()).toEqual([0, 1]);
    for (const clip of placed) expect(buffers.has(clip.source)).toBe(true);
  });

  it('names sources by node id, so no path reaches the document', () => {
    const { plan } = editorTimelinePlan(timelinePatch());
    expect(JSON.stringify(plan)).not.toContain('file://');
    for (const track of plan.tracks) {
      for (const clip of track.clips) expect(clip.source).toMatch(/^t\d-clip$/);
    }
  });

  it('schedules and renders from the document alone', () => {
    // The point of the exercise: the plan plus a source length is enough to
    // say what plays and when, with the editor nowhere in sight.
    const { plan, buffers } = editorTimelinePlan(timelinePatch());
    const lengths = new Map<string, number>();
    for (const [id, buffer] of buffers) lengths.set(id, buffer.length / buffer.sampleRate);

    const schedule = schedulePlan(plan, 0, (id) => lengths.get(id));
    const scheduled = schedule.tracks.flatMap((track) =>
      track.clips.flatMap((clip) => clip.windows.map((w) => ({ id: clip.clipId, when: w.whenSec }))),
    );
    expect(scheduled.map((entry) => entry.when).sort()).toEqual([0, 1]);

    const specs = Object.fromEntries(
      [...lengths].map(([id, seconds]) => [id, { kind: 'ramp' as const, durationSec: seconds }]),
    );
    const samples = renderPlan(plan, specs, { sampleRate: 4800, durationSec: 3 });
    // Every gain and every rate in the document is in the way now, which is
    // the point: a rendered sample is the file position it was read from,
    // scaled by the clip's gain, the lane's fader, and the master's.
    const [t0, t1] = plan.tracks;
    const m = plan.master.volume;
    const g = (clip: { gainDb: number }) => clipGainLinear(clip.gainDb);
    const c0 = t0!.clips[0]!;
    const c1 = t1!.clips[0]!;
    // At 0.5s only the first clip plays, reading file position 0.5.
    expect(samples[Math.round(0.5 * 4800)]).toBeCloseTo(0.5 * g(c0) * t0!.volume * m, 4);
    // At 1.5s both do. The second started a second ago and is stretched, so it
    // reads at 1/stretchRatio of real time from its own trim start.
    const second = c1.trimStartSec + 0.5 * (1 / c1.stretchRatio);
    expect(samples[Math.round(1.5 * 4800)]).toBeCloseTo(
      (1.5 * g(c0) * t0!.volume + second * g(c1) * t1!.volume) * m,
      4,
    );
  });

  it('marks a lane silenced by its fader as muted, rather than leaving it inferred', () => {
    const patch = timelinePatch();
    patch.materials.get('t0-clip')!.setParam('gain', 1);
    const gainless = source({
      ...patch,
      nodeData: (id) => (id === 't0-gain' ? { gain: 0 } : patch.nodeData(id)),
    });
    const { plan } = editorTimelinePlan(gainless);
    const silenced = plan.tracks.filter((track) => track.muted);
    for (const track of silenced) expect(track.volume).toBeLessThanOrEqual(0);
  });

  it('states what plan format v1 does not carry', () => {
    // Instruments and MIDI clips are attached by `fillTimelineScene` outside
    // the plan. Converting this host is what turned that from a note in a
    // handoff into two lines that visibly bypass the document, and this test
    // fails the day either becomes expressible so nobody forgets to move it.
    const { plan } = editorTimelinePlan(timelinePatch());
    expect(Object.keys(plan.tracks[0] ?? {})).not.toContain('instrument');
    expect(Object.keys(plan.tracks[0] ?? {})).not.toContain('midiClips');
  });
});

describe('fillTimelineScene builds from the document', () => {
  /**
   * The tests above cover `editorTimelinePlan`. These cover the conversion
   * itself, because a plan nothing consumes proves nothing: if the scene were
   * still built straight from the editor, dropping a clip from the plan would
   * change nothing and the exercise would be decorative.
   */
  function fakeContext() {
    const fake = {
      currentTime: 0,
      sampleRate: 48000,
      state: 'running' as const,
      async resume() {},
      async close() {},
    };
    return fake;
  }

  async function filled(patch: TimelineSource) {
    const scene = new AudioScene({ createContext: () => fakeContext() });
    await scene.start();
    const stats = fillTimelineScene(scene, patch);
    return { scene, stats };
  }

  it('places the clips the plan names, on the tracks the plan names', async () => {
    const { scene, stats } = await filled(timelinePatch());
    expect(stats.tracks).toBe(2);
    expect(stats.clips).toBe(2);
    expect(scene.tracks).toHaveLength(2);
    const { plan } = editorTimelinePlan(timelinePatch());
    // Distinct faders, so an assertion here cannot pass against a scene that
    // hardcoded unity.
    expect(new Set(plan.tracks.map((t) => t.volume)).size).toBe(2);
    scene.tracks.forEach((track, index) => {
      const planned = plan.tracks[index]!;
      expect(track.volume).toBe(planned.volume);
      expect(track.pan).toBe(planned.pan);
      expect(track.muted).toBe(planned.muted);
      // The placement and the region, from the document, on the scene's own
      // clips. Every field asserted here is one the scene could otherwise have
      // reached around the plan for, since the editor still has the Material.
      expect(track.clips.map((entry) => entry.at.toSeconds({ bpm: plan.transport.bpm, ppqn: 960 }))).toEqual(
        planned.clips.map((clip) => clip.offsetSec),
      );
      expect(track.clips.map((entry) => entry.clip.region)).toEqual(
        planned.clips.map((clip) => ({ trimStartSec: clip.trimStartSec, trimEndSec: clip.trimEndSec })),
      );
      expect(track.clips.map((entry) => entry.clip.stretchRatio)).toEqual(
        planned.clips.map((clip) => clip.stretchRatio),
      );
      expect(track.clips.map((entry) => entry.clip.gainDb)).toEqual(
        planned.clips.map((clip) => clip.gainDb),
      );
    });
  });

  it('takes the transport and master from the plan', async () => {
    const { scene } = await filled(timelinePatch());
    const { plan } = editorTimelinePlan(timelinePatch());
    expect(scene.transport.bpm).toBe(plan.transport.bpm);
    expect(scene.transport.beatsPerBar).toBe(plan.transport.beatsPerBar);
    expect(scene.transport.beatUnit).toBe(plan.transport.beatUnit);
    expect(scene.master.volume).toBe(plan.master.volume);
  });

  it('mutes the scene track the plan calls muted', async () => {
    // Without a silenced lane, an assertion that the scene took `muted` from
    // the document passes against a scene that hardcoded false.
    const patch = timelinePatch();
    const silent = gainMaterial.duplicate();
    silent.setParam('gain', 0);
    patch.materials.set('t1-gain', silent);

    const { plan } = editorTimelinePlan(patch);
    expect(plan.tracks.map((track) => track.muted)).toEqual([false, true]);

    const { scene } = await filled(patch);
    expect(scene.tracks.map((track) => track.muted)).toEqual([false, true]);
  });

  it('plays nothing the plan does not carry', async () => {
    // The assertion that makes the conversion real rather than decorative. A
    // source with no buffer is a clip the plan names and the host cannot
    // resolve, and the scene must end up without it rather than reaching
    // around the document to the editor for the sample it still has.
    const patch = timelinePatch();
    const { plan } = editorTimelinePlan(patch);
    expect(plan.tracks.flatMap((t) => t.clips)).toHaveLength(2);

    const scene = new AudioScene({ createContext: () => fakeContext() });
    await scene.start();
    const stats = fillTimelineScene(scene, {
      ...patch,
      // Same lanes, no Materials to place from: the plan comes back with the
      // tracks and no clips, and the scene has to agree.
      materials: new Map(),
    });
    expect(stats.tracks).toBe(2);
    expect(stats.clips).toBe(0);
  });
});
