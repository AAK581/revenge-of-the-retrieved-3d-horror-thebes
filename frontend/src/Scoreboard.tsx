/**
 * The scoreboard: how deep anyone has ever got. A MODAL, not a menu fixture.
 *
 * It used to render inline above the menu plank, where it was small, partly
 * hidden behind the plank's ornate frame, and squeezed its columns into an
 * illegible "1 layer 0" at the right edge. A leaderboard wants room and a
 * reading order; the menu wants the eye to be the subject. Those are not
 * reconcilable in the same 25rem column, so the board moved out.
 *
 * CLOSED BY DEFAULT, and that is a requirement rather than a default: the user
 * asked explicitly that nobody starts the game with the score window in the
 * middle of the screen. It opens only from its own button.
 *
 * Ranked by LAYERS, gems as the tiebreak, because the maze loops forever and the
 * fiction is that nobody gets out — so the achievement is not escaping, it is how
 * far down he let you go first. The board reads as a tally of failures, which is
 * the intended note.
 */
import { useEffect, useState } from 'react';
import { getHighScores, getBest, type ScoreEntry } from './lib/scores';

export default function Scoreboard({
  open,
  onClose,
  memphisName,
  refreshKey = 0,
}: {
  open: boolean;
  onClose: () => void;
  memphisName?: string;
  refreshKey?: number;
}) {
  const [rows, setRows] = useState<ScoreEntry[] | null>(null);
  const [mine, setMine] = useState<{ depth: number; gems: number } | null>(null);

  // Fetch only while open. A closed modal has no business hitting the chain
  // every time the menu re-renders.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setRows(null);
    getHighScores()
      .then((r) => { if (live) setRows(r); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [open, refreshKey]);

  useEffect(() => {
    if (!open || !memphisName) { setMine(null); return; }
    let live = true;
    getBest(memphisName)
      .then((b) => { if (live) setMine(b); })
      .catch(() => { /* leave it out rather than showing a hole */ });
    return () => { live = false; };
  }, [open, memphisName, refreshKey]);

  // Escape closes it. The menu has no other Escape handler, and a modal that
  // can only be dismissed by hitting one small button is a trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="board-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Scoreboard"
      /* Clicking the darkened surround closes. The check is on the target
         itself, so a click that lands inside the panel does not bubble up and
         dismiss the thing the player is reading. */
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="board-panel plank">
        <h2 className="board-head">HIGHSCORES</h2>

        {rows === null ? (
          <p className="board-empty">Counting…</p>
        ) : rows.length === 0 ? (
          <p className="board-empty">No one has been counted yet.</p>
        ) : (
          <>
            {/* A header row, so "14" and "41" are not two unlabelled numbers.
                This is what the cramped inline version could not afford. */}
            <div className="board-row board-row--head">
              <span className="board-rank" />
              <span className="board-name">PLAYER</span>
              <span className="board-depth">DEEPEST</span>
              <span className="board-gems">GEMS</span>
            </div>
            <ol className="board-list">
              {rows.map((r, i) => (
                <li
                  key={`${r.name}-${i}`}
                  className={`board-row${r.name === memphisName ? ' is-you' : ''}`}
                >
                  <span className="board-rank">{i + 1}</span>
                  <span className="board-name">{r.name}</span>
                  <span className="board-depth"><b>{r.depth}</b></span>
                  <span className="board-gems">{r.gems}</span>
                </li>
              ))}
            </ol>
          </>
        )}

        {mine && mine.depth > 0 && (
          <p className="board-mine">
            your deepest — <b>{mine.depth}</b> {mine.depth === 1 ? 'layer' : 'layers'}
            <span className="board-gems"> · {mine.gems} gems</span>
          </p>
        )}

        <p className="board-note">There is no escape… Not even death…</p>
        <button className="btn btn--ghost board-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
