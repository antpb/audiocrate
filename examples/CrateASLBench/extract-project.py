#!/usr/bin/env python3
"""Turn an exported homecrate project into a `CrateASLBench --song` directory.

    python3 -I extract-project.py <project.json> <outdir>
    xcrun swift run -c release CrateASLBench --song <outdir>

For every track whose plugin slot holds the crate AUv3, writes the instance's
saved `crateCompiledGraph` (the document the appex renders) as
`<trackIndex>_<label>.json`, and the notes of the MIDI track that drives it as
`<trackIndex>_<label>.events.json`: `[[sampleFrame, note, velocity 0..1], ...]`
with velocity 0 for a note off. `song_seconds` is the last note's end plus
three seconds of tails. Knob positions are not carried over; the bench uses
each patch's defaults.
"""
import base64
import json
import os
import plistlib
import sys

SR = 48000

project_path, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
project = json.load(open(project_path))
bpm = project["bpm"]

files = {}
for track in project["tracks"]:
    for slot in track.get("pluginSlots") or []:
        if not slot or not slot.get("plugin") or "crate" not in slot["plugin"]["componentName"]:
            continue
        if not slot.get("savedPresetData"):
            continue
        objects = plistlib.loads(base64.b64decode(slot["savedPresetData"]))["$objects"]
        graph = None
        for o in objects:
            text = o.decode("utf8", "ignore") if isinstance(o, bytes) else o if isinstance(o, str) else None
            if text and text.lstrip().startswith("{") and '"graph"' in text:
                graph = text
        if graph is None:
            print("track", track["trackIndex"], "crate slot has no compiled graph, skipped")
            continue
        label = (track.get("label") or "track").replace(" ", "_").replace("/", "_")
        base = os.path.join(out, f"{track['trackIndex']}_{label}")
        open(base + ".json", "w").write(graph)
        files[track["trackIndex"]] = base
        break  # one instrument per track

index_for_id = {t["id"]: t["trackIndex"] for t in project["tracks"]}
end = 0.0
for midi in project.get("midiTracks") or []:
    target = index_for_id.get(midi.get("instrumentTrackId"), midi["trackIndex"])
    if target not in files:
        continue
    events = []
    for clip in midi.get("clips") or []:
        payload = clip["payload"]
        clip_bpm = payload.get("bpm", bpm)
        offset = clip["offsetMs"] / 1000
        for n in payload["notes"]:
            start = offset + n["startBeat"] * 60 / clip_bpm
            stop = start + n["durationBeats"] * 60 / clip_bpm
            events.append([int(start * SR), n["pitch"], n.get("velocity", 100) / 127])
            events.append([int(stop * SR), n["pitch"], 0])
            end = max(end, stop)
    events.sort(key=lambda e: (e[0], e[2] != 0))
    json.dump(events, open(files[target] + ".events.json", "w"))
    print(f"track {target}: {len(events) // 2} notes -> {os.path.basename(files[target])}")

for base in files.values():
    if not os.path.exists(base + ".events.json"):
        json.dump([], open(base + ".events.json", "w"))
open(os.path.join(out, "song_seconds"), "w").write(str(end + 3))
print(f"song {end:.1f} s")
