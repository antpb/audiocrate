import { useEffect, useRef, useState } from 'react';
import { HeadTracker, poseFromDrag, type HeadTrackerSource } from '../../src/index';

/**
 * Turning the listener, so a spatial patch can actually be judged.
 *
 * The obvious way to test this is to put on AirPods and turn your head. That
 * is not available: head tracking on Apple platforms is a system feature a
 * native app opts into, and no browser exposes headphone motion. Probing
 * Safari 26 for it returns nothing.
 *
 * So this offers the two things a browser can do. Drag the pad to look
 * around, which is the desktop test and works with any headphones. Or hand it
 * a phone's motion sensor and turn the phone, which is as close to turning
 * your head as the platform allows.
 *
 * Both write `yaw` and `pitch` through the ordinary param path, so the
 * rotation is the same one automation and a CV cable would drive. Nothing
 * here is a special case in the audio graph.
 */
interface SpatialLookPanelProps {
  yaw: number;
  pitch: number;
  onParam: (name: string, value: number) => void;
}

export function SpatialLookPanel({ yaw, pitch, onParam }: SpatialLookPanelProps) {
  const padRef = useRef<HTMLDivElement | null>(null);
  const trackerRef = useRef<HeadTracker | null>(null);
  const [motion, setMotion] = useState<HeadTrackerSource | null>(null);
  const [motionNote, setMotionNote] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

  useEffect(() => () => trackerRef.current?.stop(), []);

  const apply = (nextYaw: number, nextPitch: number): void => {
    onParam('yaw', nextYaw);
    onParam('pitch', nextPitch);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (motion) return;
    padRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, yaw, pitch };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragRef.current;
    if (!start) return;
    // Relative to where the drag began rather than accumulated globally, so
    // letting go and grabbing again does not jump the listener.
    const delta = poseFromDrag(event.clientX - start.x, event.clientY - start.y);
    apply(wrap(start.yaw + delta.yawDeg), clamp(start.pitch + delta.pitchDeg, -90, 90));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null;
    if (padRef.current?.hasPointerCapture(event.pointerId)) {
      padRef.current.releasePointerCapture(event.pointerId);
    }
  };

  async function toggleMotion(): Promise<void> {
    if (motion) {
      trackerRef.current?.stop();
      trackerRef.current = null;
      setMotion(null);
      setMotionNote(null);
      return;
    }
    const tracker = new HeadTracker({
      onPose: (pose) => apply(pose.yawDeg, pose.pitchDeg),
    });
    // `deviceorientation` only, never the pointer fallback: falling back
    // silently here would look like the sensor working while the pad quietly
    // did the work instead.
    const started = await tracker.start('deviceorientation');
    if (started === 'deviceorientation') {
      trackerRef.current = tracker;
      setMotion(started);
      setMotionNote(null);
      return;
    }
    tracker.stop();
    setMotionNote('No motion sensor here. Open the editor on a phone, or drag the pad.');
  }

  return (
    <div className="spatial-look">
      <div
        ref={padRef}
        className={`spatial-look-pad${motion ? ' off' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title={motion ? 'Turn the device' : 'Drag to look around'}
      >
        <svg viewBox="-60 -60 120 120" aria-hidden="true">
          <circle className="ring" cx="0" cy="0" r="46" />
          <line className="cross" x1="-46" y1="0" x2="46" y2="0" />
          <line className="cross" x1="0" y1="-46" x2="0" y2="46" />
          {/* Where the listener is facing, and how far the nose is tipped. */}
          <g transform={`rotate(${yaw})`}>
            <polygon className="nose" points="0,-46 -7,-33 7,-33" />
          </g>
          <line className="pitch" x1="-16" y1={pitch * 0.36} x2="16" y2={pitch * 0.36} />
        </svg>
        <span className="spatial-look-readout">
          {Math.round(yaw)}&deg; / {Math.round(pitch)}&deg;
        </span>
      </div>
      <div className="spatial-look-actions">
        <button type="button" onClick={() => void toggleMotion()} className={motion ? 'on' : ''}>
          {motion ? 'Stop device motion' : 'Use device motion'}
        </button>
        <button
          type="button"
          onClick={() => {
            trackerRef.current?.recenter();
            apply(0, 0);
          }}
        >
          Recentre
        </button>
      </div>
      {motionNote ? <p className="hint">{motionNote}</p> : null}
      <p className="hint">
        AirPods head tracking is a system feature no browser exposes, so this is the closest a web page
        gets. If macOS or iOS has Spatialize Stereo on for your output, turn it off first: it applies a
        second, head-tracked room on top of this one and the localization goes soft.
      </p>
    </div>
  );
}

function wrap(deg: number): number {
  const wrapped = (((deg + 180) % 360) + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
