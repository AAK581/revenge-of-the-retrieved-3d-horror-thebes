/**
 * Touch controls: a left analog stick, a sprint button, and swipe-anywhere-else
 * to look.
 *
 * WHY POINTER EVENTS AND NOT TOUCH EVENTS. `pointerdown/move/up` plus
 * `setPointerCapture` gives multi-touch for free and, critically, keeps
 * delivering moves to the element that captured the pointer even when the finger
 * wanders off it — which is exactly what a thumb on an analog stick does. With
 * raw touch events every one of those cases is hand-rolled and one of them is
 * always wrong.
 *
 * EACH FINGER IS TRACKED BY ITS OWN pointerId. Walking with the left thumb while
 * looking with the right is the normal case, not an edge case, so the stick, the
 * sprint button and the look surface each own a pointer id and ignore events
 * that are not theirs. A shared "is dragging" boolean would have the look
 * surface stealing the stick's finger the moment it crossed over.
 *
 * The look surface sits UNDER the stick and the button in z-order and covers the
 * whole screen, so "swipe anywhere else" is literal — anywhere the two controls
 * are not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CFG } from './config';

export interface TouchControlsProps {
  /** Movement, each in -1..1, plus sprint. Called only when the value changes. */
  onMove: (forward: number, strafe: number, sprint: boolean) => void;
  /** A look delta in mouse-equivalent units. */
  onLook: (dx: number, dy: number) => void;
}

export default function TouchControls({ onMove, onLook }: TouchControlsProps) {
  const t = CFG.touch;
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);
  const [sprinting, setSprinting] = useState(false);

  // Refs, not state: these are written from pointer handlers at up to 120Hz and
  // nothing renders from them. Putting them in state would re-render the whole
  // overlay on every finger movement.
  const stickId = useRef<number | null>(null);
  const stickOrigin = useRef({ x: 0, y: 0 });
  const lookId = useRef<number | null>(null);
  const lookLast = useRef({ x: 0, y: 0 });
  const sprintId = useRef<number | null>(null);
  const move = useRef({ f: 0, s: 0 });

  const push = useCallback((f: number, s: number, sp: boolean) => {
    move.current.f = f;
    move.current.s = s;
    onMove(f, s, sp);
  }, [onMove]);

  // ---- stick ---------------------------------------------------------
  const stickDown = (e: React.PointerEvent) => {
    if (stickId.current !== null) return;
    stickId.current = e.pointerId;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    // The stick centres WHERE THE THUMB LANDS, not at the middle of its well.
    // A fixed centre means a thumb that lands off-centre starts the player
    // walking before they have moved at all.
    stickOrigin.current = { x: e.clientX, y: e.clientY };
    setKnob({ x: 0, y: 0 });
  };

  const stickMove = (e: React.PointerEvent) => {
    if (stickId.current !== e.pointerId) return;
    const dx = e.clientX - stickOrigin.current.x;
    const dy = e.clientY - stickOrigin.current.y;
    const dist = Math.hypot(dx, dy);
    const r = t.stickRadius;
    // Clamp the knob to the well, but keep the FULL direction — dragging past
    // the edge should keep steering, not stop responding.
    const k = dist > r ? r / dist : 1;
    setKnob({ x: dx * k, y: dy * k });

    const nx = (dx * k) / r;
    const ny = (dy * k) / r;
    const mag = Math.hypot(nx, ny);
    if (mag < t.stickDeadzone) { push(0, 0, sprintId.current !== null); return; }
    // Rescale past the deadzone so the first responsive position is a crawl
    // rather than a jump to 16% speed.
    const scaled = (mag - t.stickDeadzone) / (1 - t.stickDeadzone) / mag;
    // Screen y is down; forward is -y.
    push(-ny * scaled, nx * scaled, sprintId.current !== null);
  };

  const stickUp = (e: React.PointerEvent) => {
    if (stickId.current !== e.pointerId) return;
    stickId.current = null;
    setKnob(null);
    push(0, 0, sprintId.current !== null);
  };

  // ---- look ----------------------------------------------------------
  const lookDown = (e: React.PointerEvent) => {
    if (lookId.current !== null) return;
    lookId.current = e.pointerId;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    lookLast.current = { x: e.clientX, y: e.clientY };
  };

  const lookMove = (e: React.PointerEvent) => {
    if (lookId.current !== e.pointerId) return;
    const dx = e.clientX - lookLast.current.x;
    const dy = e.clientY - lookLast.current.y;
    lookLast.current = { x: e.clientX, y: e.clientY };
    onLook(dx * t.lookSensitivity, dy * t.lookSensitivity);
  };

  const lookUp = (e: React.PointerEvent) => {
    if (lookId.current !== e.pointerId) return;
    lookId.current = null;
  };

  // ---- sprint --------------------------------------------------------
  const sprintDown = (e: React.PointerEvent) => {
    sprintId.current = e.pointerId;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setSprinting(true);
    push(move.current.f, move.current.s, true);
  };
  const sprintUp = (e: React.PointerEvent) => {
    if (sprintId.current !== e.pointerId) return;
    sprintId.current = null;
    setSprinting(false);
    push(move.current.f, move.current.s, false);
  };

  /**
   * Stop the browser treating the play area as a document. Without this, a
   * two-finger drag zooms the page, a swipe pulls-to-refresh, and a long press
   * pops a text-selection menu over the game. `touch-action: none` in CSS covers
   * most of it; this catches the gesture events Safari fires anyway.
   */
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', stop);
    document.addEventListener('gesturechange', stop);
    return () => {
      document.removeEventListener('gesturestart', stop);
      document.removeEventListener('gesturechange', stop);
    };
  }, []);

  return (
    <div className="touch">
      {/* Full-screen look surface, beneath the controls. */}
      <div
        className="touch-look"
        onPointerDown={lookDown}
        onPointerMove={lookMove}
        onPointerUp={lookUp}
        onPointerCancel={lookUp}
      />

      <div
        className="touch-stick"
        onPointerDown={stickDown}
        onPointerMove={stickMove}
        onPointerUp={stickUp}
        onPointerCancel={stickUp}
      >
        <div className="touch-stick-well" />
        <div
          className="touch-stick-knob"
          style={knob ? { transform: `translate(${knob.x}px, ${knob.y}px)` } : undefined}
        />
      </div>

      <button
        className={`touch-sprint${sprinting ? ' is-on' : ''}`}
        onPointerDown={sprintDown}
        onPointerUp={sprintUp}
        onPointerCancel={sprintUp}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Sprint"
      >
        RUN
      </button>
    </div>
  );
}
