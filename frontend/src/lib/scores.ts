/**
 * On-chain game client: usernames, the scoreboard, and the run protocol.
 * A thin wrapper over the `thebes.ts` wire client.
 *
 * THE RUN PROTOCOL IS THE ANTI-TAMPER CORE, and the shape of this file is
 * what enforces it: there is no function here that sends a score. The client
 * opens a run, reports gems one at a time as they are picked up, and reports
 * each descent through a door. The canister keeps depth and gem count itself
 * behind floors it can verify against its own clock. Dying finalizes at the
 * SERVER's numbers. Nothing in this module holds a total worth editing from
 * the console — the worst a tamperer can do is drop their own calls, which
 * only lowers their score.
 *
 * GAMEPLAY UPDATES ARE BEST-EFFORT. A consensus round can be slow and the
 * game must never stall waiting for one, so failures are logged and
 * swallowed. The frame loop never awaits any of this.
 *
 * All updates go through ONE serialized promise chain, for two reasons that
 * are both load-bearing:
 *   - the sender nonce sequence must stay orderly, and
 *   - `reportGem` must run after the `startRun` that produced its run id.
 * Firing these concurrently would race on both counts.
 */
import { call, query, encodeEmpty, encodeText, encodeTexts } from '../thebes';

export interface ScoreEntry {
  name: string;
  depth: number;
  gems: number;
}

export interface GameStats {
  runs: number;
  captures: number;
  deepest: number;
  players: number;
}

export interface RunResult {
  depth: number;
  gems: number;
  bestDepth: number;
  bestGems: number;
}

let updateChain: Promise<unknown> = Promise.resolve();
let runId: string | null = null;

function enqueue(label: string, fn: () => Promise<unknown>): void {
  updateChain = updateChain
    .then(fn)
    .catch((e) => console.warn(`scores: ${label} failed:`, e));
}

/** Parse a JSON-in-text reply. The backend answers JSON because the
 *  hand-rolled Candid client decodes primitives only. */
function j<T>(reply: string | bigint): T {
  return JSON.parse(String(reply)) as T;
}

// ─── Runs ────────────────────────────────────────────────────────────

/**
 * Open a run for a signed-in player. Call sites gate on auth — an
 * anonymous player simply has no run, and every later call no-ops.
 */
export function startRun(memphisName: string): void {
  runId = null;
  enqueue('start_run', async () => {
    const r = j<{ id: string }>(await call('start_run', encodeText(memphisName)));
    runId = r.id;
  });
}

/** One gem, as it is picked up. The server keeps the count. */
export function reportGem(): void {
  enqueue('record_gem', async () => {
    if (runId) await call('record_gem', encodeText(runId));
  });
}

/** Through the door and into the next maze. This is the scoring event. */
export function reportDescent(): void {
  enqueue('descend', async () => {
    if (runId) await call('descend', encodeText(runId));
  });
}

/**
 * He caught you. BANKS the score and leaves the run open.
 *
 * Not a typo: the game's Retry keeps your depth (die at layer 4, retry at
 * layer 4), so ending the run here would score 4 and then count from 1 again
 * while the HUD carried on to 12. The run is a SESSION — Descend to Home —
 * not a life. Banking on death is what makes that safe: dying is the moment a
 * player is most likely to close the tab, so the score is committed now
 * rather than left to depend on them going Home politely.
 *
 * This one is awaited by its caller (the end screen wants the numbers), so
 * unlike the gameplay calls it rejects rather than swallowing.
 */
export function reportCapture(): Promise<RunResult | null> {
  const p = updateChain.then(async () => {
    if (!runId) return null;
    return j<RunResult>(await call('die_run', encodeText(runId)));
  });
  // Keep the chain alive even if this settles as a rejection, or one failed
  // finish would poison every later update in the session.
  updateChain = p.catch(() => undefined);
  return p;
}

/** Back to the menu. Banks once more and closes the run — the only path
 *  that ends one. */
export function abandonRun(): void {
  const id = runId;
  runId = null;
  if (!id) return;
  enqueue('abandon_run', async () => {
    await call('abandon_run', encodeText(id));
  });
}

/** Whether a run is currently open on the chain. */
export function hasRun(): boolean {
  return runId !== null;
}

// ─── Usernames ───────────────────────────────────────────────────────

export async function getUsername(memphisName: string): Promise<string> {
  return String(await query('get_username', encodeText(memphisName)));
}

/**
 * Claim a public display name. Rejects — loudly — because unlike the
 * gameplay calls this one is a deliberate user action with a visible
 * outcome, and "that username is already taken" is exactly what the player
 * needs to see.
 */
export async function setUsername(memphisName: string, username: string): Promise<string> {
  return String(await call('set_username', encodeTexts(memphisName, username)));
}

// ─── Board ───────────────────────────────────────────────────────────

export async function getHighScores(): Promise<ScoreEntry[]> {
  return j<ScoreEntry[]>(await query('get_high_scores', encodeEmpty()));
}

export async function getBest(memphisName: string): Promise<{ depth: number; gems: number }> {
  return j<{ depth: number; gems: number }>(
    await query('get_best', encodeText(memphisName)),
  );
}

export async function getStats(): Promise<GameStats> {
  return j<GameStats>(await query('get_stats', encodeEmpty()));
}
