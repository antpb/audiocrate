import { useEffect, useRef, useState, type DragEvent } from 'react';
import { AnalogKeyboard, COMPUTER_DEGREES, reconcileHeld } from './analogKeyboard';
import { PatchEditor } from './editor';
import { InspectorPanel } from './InspectorPanel';
import { PaletteNav } from './PaletteNav';
import { isPaletteDrag, readPaletteKind } from './paletteDrag';
import type { PaletteFilter } from './paletteFilter';
import { catalogEntry } from './catalog';
import { Keybed } from './Keybed';
import {
  isMidiIoKind,
  isTransportKind,
  parseCratePlugin,
  stringifyCratePlugin,
  setLiveIrPartitionSize,
  type CratePluginDocument,
} from '../../src/index';
import { applyImportedAssets, importProjectBytes, isZipBytes, looksLikeZip } from './importProject';
import { lineMonitorOn } from './lineInput';
import { parsePatch, stringifyPatch, starterPatch, spatialPatch, emptyPatch, type CratePatch } from './patch';
import { isLineKind } from './tools';
import { buildPluginDocument, registerPluginDocument, suggestedRole } from './pluginDoc';
import { loadLineDeviceId, loadStoredPatch, saveLineDeviceId, saveStoredPatch } from './storage';
import { PatchAudio } from './audio';
import { applyVoiceHint } from './voiceHint';
import { onNodeMenuRequest } from './nodeMenu';
import titleMark from './assets/audiocratejs.png';
import { clearStoredNodeAssets, collectPortableAssets, hydratePatchAssets, installPortableAsset, persistNodeAssets } from './assetStore';
import { PatchSession, type TransferProgress } from './patchSession';
import {
  applyIr,
  applyNam,
  applyNamR,
  applySample,
  applyWavetable,
  clearIr,
  clearNam,
  clearNamR,
  clearSample,
  clearWavetable,
  decodeIrBytes,
  irFilename,
  loadFactoryNam,
  namFilename,
  namFilenameR,
  parseNamText,
  sampleFilename,
  wavetableFilename,
} from './nodeAssets';
import {
  getSharedWebAudioContext,
  readSharedWebAudio,
  resetSharedWebAudioContext,
  setWebAudioEngineOptions,
} from './host/webAudioContext';
import { registerOptionalMaterials, setOptionalNamMaxFrames } from './host/optionalPlugins';
import { loadAudioSettings, saveAudioSettings, type AudioSettings } from './audioSettings';
import { SettingsPanel } from './SettingsPanel';
import { createRoomId, readRoomId, sessionHref, writeRoomId } from './sessionUrl';

registerOptionalMaterials();

const bootAudio = loadAudioSettings();
setOptionalNamMaxFrames(bootAudio.renderBlock);
setLiveIrPartitionSize(bootAudio.renderBlock);
setWebAudioEngineOptions({ sampleRate: bootAudio.sampleRate, bufferMs: bootAudio.bufferMs });

const MOBILE_QUERY = '(max-width: 800px)';

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function App() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<PatchEditor | null>(null);
  const audioRef = useRef(new PatchAudio());
  const analogRef = useRef(new AnalogKeyboard());
  const persistTimer = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [tick, setTick] = useState(0);
  const [keys, setKeys] = useState(analogRef.current.snapshot);
  const [exportForm, setExportForm] = useState<{ label: string; role: 'insert' | 'instrument' } | null>(null);
  const [sheet, setSheet] = useState<'none' | 'palette' | 'inspector'>('none');
  const [lineDeviceId, setLineDeviceId] = useState<string | null>(() => loadLineDeviceId());
  const [masterMonitor, setMasterMonitor] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(bootAudio);
  const [audioReadout, setAudioReadout] = useState(() => readSharedWebAudio());
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [paletteFilter, setPaletteFilter] = useState<PaletteFilter>('all');
  const [paletteQuery, setPaletteQuery] = useState('');
  const [dropReady, setDropReady] = useState(false);
  const [nodeMenu, setNodeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const physicalRef = useRef(new Set<number>());
  const sessionRef = useRef<PatchSession | null>(null);
  const sessionHostRef = useRef(false);
  const publishTimer = useRef<number | null>(null);
  const queuePublishRef = useRef<(immediate: boolean) => void>(() => {});
  const playRef = useRef<(fromRemote?: boolean) => Promise<void>>(async () => {});
  const stopRef = useRef<(fromRemote?: boolean) => void>(() => {});
  const [editorReady, setEditorReady] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(() => readRoomId());
  const [peerCount, setPeerCount] = useState(0);
  const [assetProgress, setAssetProgress] = useState<TransferProgress | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const analog = analogRef.current;
    audioRef.current.lineDeviceId = loadLineDeviceId();
    audioRef.current.attachKeyboard(analog);
    const editor = new PatchEditor(host, {
      onSelect: (id) => {
        setSelectedId(id);
        setTick((n) => n + 1);
      },
      onChange: (kind = 'graph') => {
        const current = editorRef.current;
        if (current) {
          applyVoiceHint(current, analog);
          if (kind !== 'view' && audioRef.current.playing) audioRef.current.sync(current);
          if (kind !== 'view') setKeys(analog.snapshot);
        }
        if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
        persistTimer.current = window.setTimeout(() => {
          const latest = editorRef.current;
          if (latest) saveStoredPatch(latest.getPatch());
        }, 250);
        queuePublishRef.current(kind !== 'view');
      },
    });
    editorRef.current = editor;
    const onKey = (event: KeyboardEvent) => {
      if (typingInField(event.target)) return;
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        void editor.removeSelected();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const digit = event.key.toLowerCase();
      if (digit === 'z') {
        analog.octave = Math.max(1, analog.octave - 1);
        setTick((n) => n + 1);
        return;
      }
      if (digit === 'x') {
        analog.octave = Math.min(7, analog.octave + 1);
        setTick((n) => n + 1);
        return;
      }
      const degree = COMPUTER_DEGREES[digit];
      if (degree == null || event.repeat) return;
      event.preventDefault();
      void fingerDown(analog.midiForDegree(degree));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (typingInField(event.target)) return;
      const degree = COMPUTER_DEGREES[event.key.toLowerCase()];
      if (degree == null) return;
      fingerUp(analog.midiForDegree(degree));
    };
    const onBlur = () => {
      physicalRef.current.clear();
      analog.releaseAll();
      setKeys(analog.snapshot);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    void (async () => {
      try {
        await editor.loadPatch(loadStoredPatch());
        await hydratePatchAssets(editor);
        applyVoiceHint(editor, analog);
        setKeys(analog.snapshot);
        setStatus('Patch restored. Press Play, then use the keybed.');
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
      setEditorReady(true);
      if (import.meta.env.DEV) {
        (window as unknown as { __cratePatcher: unknown }).__cratePatcher = {
          getPatch: () => editor.getPatch(),
          loadPatch: (patch: unknown) => editor.loadPatch(patch as ReturnType<typeof editor.getPatch>),
          addKind: (kind: string) => editor.addKind(kind),
          pressKey: (note: number, velocity?: number) => {
            analog.press(note, velocity);
            setKeys(analog.snapshot);
          },
          releaseKey: (note: number) => {
            analog.release(note);
            setKeys(analog.snapshot);
          },
          keyboardSnapshot: () => analog.snapshot,
          exportPlugin: (label: string, role?: 'insert' | 'instrument') => {
            const doc = buildPluginDocument(editor.getPatch(), label, role ?? suggestedRole(editor.getPatch()));
            registerPluginDocument(doc);
            return doc;
          },
          importPlugin: async (doc: unknown) => {
            const plugin = parseCratePlugin(JSON.stringify(doc));
            registerPluginDocument(plugin);
            await editor.loadPatch(plugin.patch as CratePatch);
            return plugin.id;
          },
        };
      }
    })();
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      editor.destroy();
      editorRef.current = null;
      audioRef.current.stop();
      setEditorReady(false);
    };
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (moreRef.current?.contains(event.target as Node)) return;
      setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    return onNodeMenuRequest((request) => {
      editorRef.current?.select(request.nodeId);
      setSelectedId(request.nodeId);
      setTick((n) => n + 1);
      const width = 220;
      const height = 84;
      setNodeMenu({
        id: request.nodeId,
        x: Math.min(request.x, window.innerWidth - width - 8),
        y: Math.min(request.y, window.innerHeight - height - 8),
      });
    });
  }, []);

  useEffect(() => {
    if (!nodeMenu) return;
    const onPointer = () => setNodeMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNodeMenu(null);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [nodeMenu]);

  useEffect(() => {
    if (!status) return;
    const hide = window.setTimeout(() => setStatus(null), 3200);
    return () => window.clearTimeout(hide);
  }, [status]);

  useEffect(() => {
    const onPop = () => setRoomId(readRoomId());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!editorReady || !roomId) return;
    const session = new PatchSession(roomId);
    sessionRef.current = session;
    const publishOnStart = sessionHostRef.current;
    sessionHostRef.current = false;
    if (!publishOnStart) setStatus('Joining session…');
    void session
      .connect(
      {
        getPatch: () => editorRef.current?.getPatch() ?? starterPatch(),
        loadPatch: async (patch) => {
          const editor = editorRef.current;
          if (!editor) return;
          await editor.loadPatch(patch);
          applyVoiceHint(editor, analogRef.current);
          setKeys(analogRef.current.snapshot);
          saveStoredPatch(patch);
          setTick((n) => n + 1);
          if (audioRef.current.playing) audioRef.current.sync(editor);
        },
        listAssets: () => {
          const editor = editorRef.current;
          return editor ? collectPortableAssets(editor) : [];
        },
        installAsset: async (asset) => {
          const editor = editorRef.current;
          if (!editor?.materials.has(asset.nodeId)) return false;
          await installPortableAsset(editor, asset);
          if (audioRef.current.playing) await audioRef.current.refreshKernels(asset.nodeId);
          setTick((n) => n + 1);
          return true;
        },
        onTransport: (action) => {
          if (action === 'playing') void playRef.current(true);
          else stopRef.current(true);
        },
        playing: () => audioRef.current.playing,
        onPeers: setPeerCount,
        onStatus: setStatus,
        onTransfer: setAssetProgress,
      },
      publishOnStart,
    )
      .catch((err) => {
        setStatus(err instanceof Error ? err.message : String(err));
      });
    return () => {
      session.close();
      setAssetProgress(null);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [editorReady, roomId]);

  queuePublishRef.current = (immediate) => {
    const send = () => {
      const editor = editorRef.current;
      if (editor) sessionRef.current?.publish(editor.getPatch());
    };
    if (immediate) {
      if (publishTimer.current != null) window.clearTimeout(publishTimer.current);
      publishTimer.current = null;
      send();
      return;
    }
    if (publishTimer.current != null) return;
    publishTimer.current = window.setTimeout(() => {
      publishTimer.current = null;
      send();
    }, 120);
  };

  const material = editorRef.current?.selectedMaterial() ?? null;
  const selectedKind = editorRef.current?.selectedKind() ?? null;

  function applyAudioSettings(next: AudioSettings) {
    const saved = saveAudioSettings(next);
    setAudioSettings(saved);
    setOptionalNamMaxFrames(saved.renderBlock);
    setLiveIrPartitionSize(saved.renderBlock);
    setWebAudioEngineOptions({ sampleRate: saved.sampleRate, bufferMs: saved.bufferMs });
    const wasPlaying = audioRef.current.playing;
    audioRef.current.reinitialize();
    resetSharedWebAudioContext();
    setPlaying(false);
    setAudioReadout(readSharedWebAudio());
    setStatus(wasPlaying ? 'Audio rebuilt. Press Play.' : 'Audio settings applied.');
  }

  async function play(fromRemote = false) {
    const editor = editorRef.current;
    if (!editor) return;
    audioRef.current.unlock();
    try {
      await audioRef.current.play(editor);
      setKeys(analogRef.current.snapshot);
      setPlaying(true);
      setAudioReadout(readSharedWebAudio());
      if (!fromRemote) sessionRef.current?.publishTransport('playing');
      const state = audioRef.current.contextState();
      editor.syncTransportFromGraph();
      const transport = editor.transport;
      const hz = audioRef.current.sampleRate();
      const song =
        transport && transport.bpm
          ? ` ${transport.bpm} bpm ${transport.beatsPerBar}/${transport.beatUnit ?? 4}${transport.startSec && transport.startSec > 0.25 ? `, from ${transport.startSec.toFixed(1)}s` : ''}`
          : '';
      const rate = hz ? ` at ${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz` : '';
      setStatus(
        state === 'running'
          ? fromRemote
            ? `Playing (session).${song}${rate}.`
            : `Playing.${song}${rate}.`
          : `Audio is ${state}. Tap Play again (iOS drops the context after the first wait).`,
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function stop(fromRemote = false) {
    audioRef.current.stop();
    physicalRef.current.clear();
    analogRef.current.releaseAll();
    setKeys(analogRef.current.snapshot);
    setPlaying(false);
    if (!fromRemote) sessionRef.current?.publishTransport('stopped');
    setStatus(fromRemote ? 'Stopped (session).' : 'Stopped.');
  }

  playRef.current = play;
  stopRef.current = stop;

  function fingerUp(note: number) {
    physicalRef.current.delete(note);
    analogRef.current.release(note);
    setKeys(analogRef.current.snapshot);
  }

  function syncPhysical() {
    const analog = analogRef.current;
    const next = reconcileHeld(analog.snapshot.held, physicalRef.current);
    for (const note of next.drop) analog.release(note);
    for (const note of next.strike) analog.press(note);
    setKeys(analog.snapshot);
  }

  async function fingerDown(note: number) {
    physicalRef.current.add(note);
    analogRef.current.press(note);
    setKeys(analogRef.current.snapshot);
    audioRef.current.unlock();
    if (audioRef.current.playing) return;
    try {
      await play();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      physicalRef.current.delete(note);
      analogRef.current.release(note);
      setKeys(analogRef.current.snapshot);
      return;
    }
    syncPhysical();
  }

  function exportJson() {
    const editor = editorRef.current;
    if (!editor) return;
    const blob = new Blob([stringifyPatch(editor.getPatch())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'crate-patch.json';
    link.click();
    URL.revokeObjectURL(url);
    setStatus('Exported crate-patch.json.');
  }

  async function importFile(file: File) {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isZipBytes(bytes) || looksLikeZip(file)) {
        setStatus('Importing project...');
        const imported = await importProjectBytes(bytes);
        await editor.loadPatch(imported.patch);
        await applyImportedAssets(editor, imported);
        sessionRef.current?.pushAssets();
        applyVoiceHint(editor, analogRef.current);
        setKeys(analogRef.current.snapshot);
        saveStoredPatch(imported.patch);
        setTick((n) => n + 1);
        const extra = imported.warnings.length > 0 ? ` ${imported.warnings.join(' ')}` : '';
        setStatus(`Imported project "${imported.name}" (${imported.patch.nodes.length} nodes).${extra}`);
        return;
      }
      const text = new TextDecoder().decode(bytes);
      let patch: CratePatch;
      let note: string;
      try {
        patch = parsePatch(text);
        note = `Imported ${patch.nodes.length} nodes.`;
      } catch {
        const doc = parseCratePlugin(text);
        registerPluginDocument(doc);
        patch = doc.patch as CratePatch;
        note = `Imported plugin "${doc.label}" (${doc.role}). On the canvas and in the palette.`;
      }
      await editor.loadPatch(patch);
      await hydratePatchAssets(editor);
      applyVoiceHint(editor, analogRef.current);
      setKeys(analogRef.current.snapshot);
      saveStoredPatch(patch);
      setTick((n) => n + 1);
      setStatus(note);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function openExportForm() {
    const editor = editorRef.current;
    if (!editor) return;
    setExportForm({ label: 'My Patch', role: suggestedRole(editor.getPatch()) });
  }

  function exportPluginDoc(): CratePluginDocument | null {
    const editor = editorRef.current;
    if (!editor || !exportForm) return null;
    try {
      const doc = buildPluginDocument(editor.getPatch(), exportForm.label.trim() || 'My Patch', exportForm.role);
      registerPluginDocument(doc);
      const blob = new Blob([stringifyCratePlugin(doc)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${doc.id.replace(/^user\./, '')}.crate-plugin.json`;
      link.click();
      URL.revokeObjectURL(url);
      setExportForm(null);
      setTick((n) => n + 1);
      setStatus(`Exported "${doc.label}" as a ${doc.role}. Added to Plugins in the palette.`);
      return doc;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function loadPreset(patch: CratePatch, status: string) {
    const editor = editorRef.current;
    if (!editor) return;
    await editor.loadPatch(patch);
    await hydratePatchAssets(editor);
    applyVoiceHint(editor, analogRef.current);
    setKeys(analogRef.current.snapshot);
    saveStoredPatch(patch);
    setStatus(status);
  }

  async function newPatch() {
    await loadPreset(starterPatch(), 'New patch.');
  }

  async function newBlankPatch() {
    await loadPreset(emptyPatch(), 'Blank patch.');
  }

  async function newSpatialPatch() {
    await loadPreset(spatialPatch(), 'Spatial patch. Play, then turn the master yaw.');
  }

  function openImportProject() {
    if (playing) stop();
    fileRef.current?.click();
    setMoreOpen(false);
  }

  async function copySessionLink(id: string): Promise<boolean> {
    const href = sessionHref(id);
    try {
      await navigator.clipboard.writeText(href);
      return true;
    } catch {
      setStatus(`Share this link: ${href}`);
      return false;
    }
  }

  async function startSession() {
    setMoreOpen(false);
    const id = createRoomId();
    sessionHostRef.current = true;
    writeRoomId(id);
    setRoomId(id);
    const copied = await copySessionLink(id);
    setStatus(
      copied
        ? 'Session started. Link copied. Open it in another browser to join.'
        : `Session started. Share this link: ${sessionHref(id)}`,
    );
  }

  function persistShare(nodeId: string, next: NonNullable<typeof material>, kind: string) {
    return persistNodeAssets(nodeId, next, kind).then(() => {
      sessionRef.current?.pushAssets();
    });
  }

  function leaveSession() {
    setMoreOpen(false);
    writeRoomId(null);
    setRoomId(null);
    setPeerCount(0);
    setAssetProgress(null);
    setStatus('Left session.');
  }

  function toggleSheet(next: 'palette' | 'inspector') {
    setSheet((current) => (current === next ? 'none' : next));
  }

  async function addFromPalette(kind: string, position?: { x: number; y: number }) {
    try {
      await editorRef.current?.addKind(kind, position);
      if (isMobile()) setSheet('inspector');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function stageDragOver(event: DragEvent<HTMLDivElement>) {
    if (!isPaletteDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropReady(true);
  }

  function stageDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setDropReady(false);
  }

  async function deleteNode(id: string, passthrough: boolean) {
    const editor = editorRef.current;
    if (!editor) return;
    setNodeMenu(null);
    await clearStoredNodeAssets(id);
    if (passthrough) await editor.removeNodePassthrough(id);
    else await editor.removeNode(id);
    setTick((n) => n + 1);
  }

  function dropOnStage(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDropReady(false);
    const kind = readPaletteKind(event.dataTransfer);
    if (!kind || !catalogEntry(kind)) return;
    const editor = editorRef.current;
    if (!editor) return;
    const at = editor.graphPointFromClient(event.clientX, event.clientY);
    void addFromPalette(kind, { x: at.x - 24, y: at.y - 14 });
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>
            <img src={titleMark} alt="audiocrate.js" />
          </h1>
        </div>
        <div className="actions">
          <button type="button" onClick={() => void play()} disabled={playing}>
            Play
          </button>
          <button type="button" onClick={stop} disabled={!playing}>
            Stop
          </button>
          <button type="button" onClick={exportJson}>
            <span className="wide">Export Patch</span>
            <span className="narrow">JSON</span>
          </button>
          <button type="button" onClick={openExportForm}>
            <span className="wide">Export Plugin</span>
            <span className="narrow">Plugin</span>
          </button>
          <button type="button" onClick={() => fileRef.current?.click()}>
            Import
          </button>
          <div className="more" ref={moreRef}>
            <button
              type="button"
              className={moreOpen ? 'on' : ''}
              aria-label="More"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              ...
            </button>
            {moreOpen ? (
              <div className="more-menu">
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    void newPatch();
                  }}
                >
                  New
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    void newBlankPatch();
                  }}
                >
                  New blank
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    void newSpatialPatch();
                  }}
                >
                  New spatial
                </button>
                <button type="button" onClick={openImportProject}>
                  Import Project
                </button>
                {roomId ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        void copySessionLink(roomId).then((copied) => {
                          if (copied) setStatus('Session link copied.');
                        });
                      }}
                    >
                      Copy session link{peerCount > 0 ? ` (${peerCount + 1})` : ''}
                    </button>
                    <button type="button" onClick={leaveSession}>
                      Leave session
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => void startSession()}>
                    Start session
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    setAudioReadout(readSharedWebAudio());
                    setSettingsOpen(true);
                  }}
                >
                  Settings
                </button>
              </div>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/zip,.zip,application/x-zip-compressed,application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = '';
            }}
          />
        </div>
        {exportForm ? (
          <div className="export-form">
            <label>
              Name
              <input
                type="text"
                value={exportForm.label}
                onChange={(event) => setExportForm({ ...exportForm, label: event.target.value })}
              />
            </label>
            <label>
              Role
              <select
                value={exportForm.role}
                onChange={(event) =>
                  setExportForm({ ...exportForm, role: event.target.value as 'insert' | 'instrument' })
                }
              >
                <option value="insert">insert (effect on a track)</option>
                <option value="instrument">instrument (note-driven)</option>
              </select>
            </label>
            <button type="button" onClick={() => exportPluginDoc()}>
              Download
            </button>
            <button type="button" onClick={() => setExportForm(null)}>
              Cancel
            </button>
          </div>
        ) : null}
      </header>
      <div className={`body sheet-${sheet}`}>
        <PaletteNav
          filter={paletteFilter}
          query={paletteQuery}
          onFilter={setPaletteFilter}
          onQuery={setPaletteQuery}
          onAdd={(kind) => void addFromPalette(kind)}
        />
        <div
          className={`stage${dropReady ? ' drop-ready' : ''}`}
          onDragOver={stageDragOver}
          onDragLeave={stageDragLeave}
          onDrop={dropOnStage}
          onContextMenu={(event) => event.preventDefault()}
        >
          {status || assetProgress ? (
            <div className="stage-banners">
              {status ? (
                <p className="notice" role="status" onClick={() => setStatus(null)}>
                  {status}
                </p>
              ) : null}
              {assetProgress ? (
                <div className="session-progress" role="status">
                  <div className="session-progress-row">
                    <span>
                      {assetProgress.direction === 'send' ? 'Sending' : 'Receiving'} {assetProgress.label}
                    </span>
                    <span>
                      {formatBytes(assetProgress.done)} / {formatBytes(assetProgress.total)}
                    </span>
                  </div>
                  <div className="session-progress-track">
                    <div
                      className="session-progress-fill"
                      style={{
                        width: `${assetProgress.total > 0 ? Math.min(100, (100 * assetProgress.done) / assetProgress.total) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {sheet !== 'none' ? (
            <button type="button" className="sheet-dismiss" aria-label="Close panel" onClick={() => setSheet('none')} />
          ) : null}
          <div className="stage-host" ref={hostRef} />
        </div>
        <InspectorPanel
          key={selectedId ?? 'none'}
          material={material}
          kind={selectedKind}
          snapshot={keys}
          masterMonitor={masterMonitor}
          lineDeviceId={lineDeviceId}
          onLineDevice={async (id) => {
            const used = await audioRef.current.setLineDevice(id);
            saveLineDeviceId(used);
            setLineDeviceId(used);
          }}
          onMasterMonitor={(on) => {
            audioRef.current.setMasterMonitor(on);
            setMasterMonitor(on);
          }}
          onParam={(name, value) => {
            if (!material || !selectedId) return;
            material.setParam(name, value);
            const editor = editorRef.current;
            if (editor && isTransportKind(selectedKind ?? '')) editor.syncTransportFromGraph();
            audioRef.current.setParam(selectedId, name, value);
            setTick((n) => n + 1);
            if (editor) saveStoredPatch(editor.getPatch());
            queuePublishRef.current(true);
          }}
          nodeData={selectedId ? editorRef.current?.nodeData(selectedId) : undefined}
          onNodeData={(patch) => {
            if (!selectedId) return;
            const editor = editorRef.current;
            if (!editor) return;
            editor.patchNodeData(selectedId, patch);
            saveStoredPatch(editor.getPatch());
            setTick((n) => n + 1);
            queuePublishRef.current(true);
            if (isMidiIoKind(selectedKind ?? '')) void audioRef.current.syncMidiIo(selectedId);
            if (isLineKind(selectedKind ?? '') && 'monitor' in patch) {
              audioRef.current.setLineMonitor(selectedId, lineMonitorOn(patch));
            }
          }}
          nodeId={selectedId}
          namFilename={material && selectedKind === 'amp' ? namFilename(material) : null}
          namFilenameR={material && selectedKind === 'amp' ? namFilenameR(material) : null}
          irFilename={material && selectedKind ? irFilename(material, selectedKind) : null}
          sampleFilename={material && selectedKind === 'sampleplayer' ? sampleFilename(material) : null}
          wavetableFilename={material && selectedKind === 'wavetable' ? wavetableFilename(material) : null}
          onNamFile={
            material && selectedId && selectedKind === 'amp'
              ? async (file) => {
                  applyNam(material, parseNamText(await file.text(), file.name));
                  await persistShare(selectedId, material, 'amp');
                  await audioRef.current.refreshKernels(selectedId);
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onNamFactory={
            material && selectedId && selectedKind === 'amp'
              ? async () => {
                  applyNam(material, await loadFactoryNam());
                  await persistShare(selectedId, material, 'amp');
                  await audioRef.current.refreshKernels(selectedId);
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onNamClear={
            material && selectedId && selectedKind === 'amp'
              ? () => {
                  clearNam(material);
                  void persistShare(selectedId, material, 'amp');
                  void audioRef.current.refreshKernels(selectedId);
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onNamRFile={
            material && selectedId && selectedKind === 'amp'
              ? async (file) => {
                  applyNamR(material, parseNamText(await file.text(), file.name));
                  await persistShare(selectedId, material, 'amp');
                  await audioRef.current.refreshKernels(selectedId);
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onNamRClear={
            material && selectedId && selectedKind === 'amp'
              ? () => {
                  clearNamR(material);
                  void persistShare(selectedId, material, 'amp');
                  void audioRef.current.refreshKernels(selectedId);
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onIrFile={
            material && selectedId && selectedKind === 'ir'
              ? async (file) => {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  const ctx = getSharedWebAudioContext() as AudioContext | null;
                  applyIr(material, selectedKind!, await decodeIrBytes(bytes, file.name, ctx));
                  await persistShare(selectedId, material, selectedKind!);
                  await audioRef.current.refreshKernels(selectedId);
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onIrClear={
            material && selectedId && selectedKind === 'ir'
              ? () => {
                  clearIr(material, selectedKind!);
                  void persistShare(selectedId, material, selectedKind!);
                  void audioRef.current.refreshKernels(selectedId);
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onSampleFile={
            material && selectedId && selectedKind === 'sampleplayer'
              ? async (file) => {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  const ctx = getSharedWebAudioContext() as AudioContext | null;
                  applySample(material, await decodeIrBytes(bytes, file.name, ctx));
                  await persistShare(selectedId, material, 'sampleplayer');
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onSampleClear={
            material && selectedId && selectedKind === 'sampleplayer'
              ? () => {
                  clearSample(material);
                  void persistShare(selectedId, material, 'sampleplayer');
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onWavetableFile={
            material && selectedId && selectedKind === 'wavetable'
              ? async (file) => {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  const ctx = getSharedWebAudioContext() as AudioContext | null;
                  applyWavetable(material, await decodeIrBytes(bytes, file.name, ctx));
                  await persistShare(selectedId, material, 'wavetable');
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onWavetableClear={
            material && selectedId && selectedKind === 'wavetable'
              ? () => {
                  clearWavetable(material);
                  void persistShare(selectedId, material, 'wavetable');
                  setTick((n) => n + 1);
                }
              : undefined
          }
          onRemove={() => {
            if (selectedId) void clearStoredNodeAssets(selectedId);
            void editorRef.current?.removeSelected();
            if (isMobile()) setSheet('none');
          }}
        />
      </div>
      <nav className="dock">
        <button type="button" className={sheet === 'palette' ? 'on' : ''} onClick={() => toggleSheet('palette')}>
          Add
        </button>
        <button type="button" className={sheet === 'inspector' ? 'on' : ''} onClick={() => toggleSheet('inspector')}>
          Inspect
        </button>
      </nav>
      <SettingsPanel
        open={settingsOpen}
        settings={audioSettings}
        readout={audioReadout}
        onChange={applyAudioSettings}
        onReinitialize={() => applyAudioSettings(audioSettings)}
        onClose={() => setSettingsOpen(false)}
      />
      <Keybed
        analog={analogRef.current}
        snapshot={keys}
        onPress={(note) => void fingerDown(note)}
        onRelease={(note) => {
          fingerUp(note);
        }}
        onOctave={(octave) => {
          analogRef.current.octave = octave;
          setTick((n) => n + 1);
        }}
        onVelocity={(velocity) => {
          analogRef.current.velocity = velocity;
          setTick((n) => n + 1);
        }}
      />
      {nodeMenu ? (
        <div
          className="node-menu"
          style={{ left: nodeMenu.x, top: nodeMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => void deleteNode(nodeMenu.id, false)}>
            Delete
          </button>
          <button
            type="button"
            disabled={!editorRef.current?.canPassthrough(nodeMenu.id)}
            onClick={() => void deleteNode(nodeMenu.id, true)}
          >
            Delete and pass through
          </button>
        </div>
      ) : null}
    </div>
  );
}

function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}
