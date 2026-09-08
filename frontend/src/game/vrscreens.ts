/**
 * The game's screens, as in-world panels.
 *
 * Content is lifted from the DOM originals in `GameCanvas.tsx`, `Scoreboard.tsx`
 * and `game.css` — same words, same order, same voice. This is a change of
 * substrate, not a redesign, and where it deviates the deviation is commented.
 *
 * ## Sizes are in metres and they are not arbitrary
 *
 * A panel's comfort in a headset is set by the angle it subtends, not its pixel
 * count, so every screen here declares a width in metres and a nominal viewing
 * distance. At 1.5m a 0.9m panel covers ~33°, which sits inside the ~40° cone a
 * person can read without moving their head. The scoreboard is wider because a
 * four-column table cannot be narrowed without either shrinking the type below
 * legibility or truncating names; it is placed further away to compensate.
 *
 * **These distances are the one thing in this file that cannot be judged without
 * a headset.** Everything else — wording, hierarchy, contrast, hover feedback —
 * is fully reviewable flat. Do not treat a flat sign-off as an ergonomic one.
 */
import type { PanelItem } from './vrui';
import { Panel } from './vrui';

/** Nominal eye-to-panel distance, metres. Used to place, and to sanity-check angle. */
export const SCREEN_DISTANCE = 1.5;
export const BOARD_DISTANCE = 1.9;

export type ScreenName = 'menu' | 'pause' | 'board' | 'death' | 'loop' | 'hud' | 'signin';

/** Screens that sit OVER the menu and must not be replaced by a phase re-sync. */
export const MODAL_SCREENS: ReadonlySet<ScreenName> = new Set(['board', 'signin']);

export type ScoreRow = { rank: number; name: string; depth: number; gems: number; you?: boolean };

export type ScreenState = {
  /** Pause sliders, 0..1. */
  lookSensitivity: number;
  volume: number;
  /** Scoreboard contents; empty is a real and common case. */
  scores: ScoreRow[];
  boardLoading: boolean;
  /** HUD. */
  gemsGot: number;
  gemsTotal: number;
  depth: number;
  /** Whether a Memphis identity is signed in, which changes the menu's footer. */
  signedIn: boolean;
  signedInName: string | null;
};

export function defaultState(): ScreenState {
  return {
    lookSensitivity: 0.5,
    volume: 0.8,
    scores: [],
    boardLoading: false,
    gemsGot: 0,
    gemsTotal: 5,
    depth: 1,
    signedIn: false,
    signedInName: null,
  };
}

/**
 * The menu's identity footer.
 *
 * The flat menu offers a name field and a Sign in button. The FIELD cannot exist
 * here — WebAuthn is a browser-mediated ceremony and on tethered PC VR its prompt
 * is a desktop OS modal with no representation inside the headset — but the first
 * version drew the wrong conclusion from that and offered nothing at all except a
 * line of text telling the player to have done it earlier. That is advice, not an
 * affordance, and it is useless to the person reading it, who is already wearing
 * the headset.
 *
 * So there IS a button. It cannot sign you in; it explains why and offers to drop
 * you out so you can. See `signinItems`.
 *
 * Anonymous play is never gated behind it. Descend stays first and primary, the
 * copy states a fact rather than nagging, and the alternative on the confirm
 * screen is phrased as a real choice rather than a dismissal — a player who does
 * not want an account should not be made to feel they are refusing something.
 */
function identityFooter(s: ScreenState): PanelItem[] {
  if (s.signedIn && s.signedInName) {
    return [
      { kind: 'rule' },
      { kind: 'text', text: `Descending as ${s.signedInName}. He is counting.` },
    ];
  }
  return [
    { kind: 'rule' },
    { kind: 'text', text: 'Not signed in — this run will not be counted.' },
    { kind: 'button', id: 'signin', label: 'Sign in' },
  ];
}

/**
 * What happens when a player presses Sign in from inside a headset.
 *
 * The honest answer is "you have to take it off", and saying so plainly beats
 * either hiding the button or letting them press something that silently does
 * nothing. The primary action actually performs the exit — being told to leave VR
 * and then having to find the system menu yourself is the kind of dead end that
 * makes people take the headset off for good.
 */
export function signinItems(): PanelItem[] {
  return [
    { kind: 'title', text: 'SIGNING IN HAPPENS OUTSIDE' },
    {
      kind: 'text',
      text: 'Your passkey prompt is drawn by the browser itself, and it cannot be shown inside the headset. Leave VR, sign in on the flat screen, and come back — nothing is lost, you have not started a run yet.',
    },
    { kind: 'rule' },
    { kind: 'button', id: 'leave-vr', label: 'Leave VR and sign in', primary: true },
    { kind: 'button', id: 'stay', label: 'Stay — play unscored' },
  ];
}

export function menuItems(s: ScreenState): PanelItem[] {
  return [
    { kind: 'title', text: 'REVENGE OF THE RETRIEVED' },
    { kind: 'text', text: 'He was small when you took him. He is not small now.' },
    { kind: 'rule' },
    { kind: 'button', id: 'descend', label: 'Descend', primary: true },
    { kind: 'button', id: 'board', label: 'Highscores' },
    ...identityFooter(s),
  ];
}

export function pauseItems(s: ScreenState): PanelItem[] {
  return [
    { kind: 'title', text: 'Paused' },
    { kind: 'text', text: 'He is still walking while you read this.' },
    { kind: 'rule' },
    { kind: 'slider', id: 'look', label: 'Look sensitivity', value: s.lookSensitivity },
    { kind: 'slider', id: 'volume', label: 'Volume', value: s.volume },
    { kind: 'gap', h: 0.012 },
    { kind: 'button', id: 'resume', label: 'Resume', primary: true },
    { kind: 'button', id: 'restart', label: 'Restart' },
    { kind: 'button', id: 'home', label: 'Home' },
  ];
}

const BOARD_W = [0.14, 0.44, 0.24, 0.18];

export function boardItems(s: ScreenState): PanelItem[] {
  const head: PanelItem[] = [
    { kind: 'title', text: 'HIGHSCORES' },
    { kind: 'rule' },
    { kind: 'row', cells: ['', 'Player', 'Deepest', 'Gems'], weights: BOARD_W, head: true },
  ];
  let body: PanelItem[];
  if (s.boardLoading) {
    body = [{ kind: 'text', text: 'Counting the ones who did not come back…' }];
  } else if (s.scores.length === 0) {
    // The empty board is not an error state and must not read as one. It is also
    // the state the real board is in most of the time, so it gets real copy.
    body = [{ kind: 'text', text: 'Nobody has gone deep enough to be remembered yet.' }];
  } else {
    body = s.scores.map((r) => ({
      kind: 'row' as const,
      cells: [`${r.rank}`, r.name, `${r.depth}`, `${r.gems}`],
      weights: BOARD_W,
      you: r.you,
    }));
  }
  return [
    ...head,
    ...body,
    // Wider than it looks like it needs: the rows above are tight by design, and
    // without real air the closing line reads as a seventh table row.
    { kind: 'gap', h: 0.032 },
    { kind: 'text', text: 'There is no escape… Not even death…' },
    { kind: 'button', id: 'close', label: 'Close' },
  ];
}

export function deathItems(): PanelItem[] {
  return [
    { kind: 'title', text: 'HE FOUND YOU' },
    { kind: 'text', text: 'You really thought you could escape?' },
    { kind: 'rule' },
    { kind: 'button', id: 'retry', label: 'Retry', primary: true },
    { kind: 'button', id: 'home', label: 'Home' },
  ];
}

/**
 * The transition card. Non-interactive by design — it plays during a scripted
 * camera move, and a button on it would invite a press that has nowhere to go.
 */
export function loopItems(depth: number): PanelItem[] {
  if (depth === 2) {
    return [
      { kind: 'title', text: 'YOU MADE IT OUT' },
      { kind: 'text', text: 'Or so he lets you think… There is no escape… Not even death…' },
    ];
  }
  return [
    { kind: 'bignum', value: `${depth}`, caption: 'mazes deep' },
    {
      kind: 'text',
      text: depth < 5
        ? 'There is no escape… Not even death…'
        : 'He is not counting. He does not need to.',
    },
  ];
}

/**
 * Unbacked, non-interactive; see the `bare` note on Panel.
 *
 * Everything here is scaled up hard. At the HUD's panel width the default text
 * ratio yields glyphs 0.016m tall — 0.6° at 1.5m, against a ~1.5° floor for
 * comfortable reading in a headset — and the first render was an illegible smudge
 * that every assertion passed. The tally is drawn rather than typed because ◆/◇
 * are not guaranteed glyphs in Georgia and tofu in the HUD would be the most
 * visible possible failure.
 */
export function hudItems(s: ScreenState): PanelItem[] {
  const items: PanelItem[] = [
    { kind: 'ticks', got: s.gemsGot, total: s.gemsTotal },
    { kind: 'text', text: `${s.gemsGot} / ${s.gemsTotal}`, scale: 2.4, tone: 'bone' },
  ];
  if (s.depth > 1) items.push({ kind: 'text', text: `${s.depth} layers deep`, scale: 1.9 });
  return items;
}

/**
 * Where each screen sits relative to the eye, in metres (right, up, forward-ish).
 *
 * Menus sit centred; the HUD does not. A gem tally welded to the middle of your
 * view is not a HUD, it is an obstruction — the flat game puts it in a corner and
 * this keeps that. **The exact offsets are ergonomics and are explicitly on the
 * headset list**; what is settled is that the HUD is off-centre and the menus are
 * not.
 */
export function screenOffset(name: ScreenName): { x: number; y: number } {
  return name === 'hud' ? { x: -0.42, y: -0.30 } : { x: 0, y: 0 };
}

/** Build a panel for a screen, already sized and filled. */
export function buildScreen(name: ScreenName, s: ScreenState): Panel {
  switch (name) {
    case 'menu': {
      const p = new Panel(0.9, 0.5);
      p.setItems(menuItems(s));
      return p;
    }
    case 'pause': {
      const p = new Panel(0.9, 0.5);
      p.setItems(pauseItems(s));
      return p;
    }
    case 'board': {
      // Wider than the menus AND further away, which keeps the subtended angle
      // similar while giving four columns room. Narrowing it instead would have
      // pushed the row type under the angular legibility floor — the board's
      // headers measured 0.97° before this.
      const p = new Panel(1.3, 0.5);
      p.setItems(boardItems(s));
      return p;
    }
    case 'death': {
      const p = new Panel(0.9, 0.4);
      p.setItems(deathItems());
      return p;
    }
    case 'signin': {
      const p = new Panel(0.9, 0.45);
      p.setItems(signinItems());
      return p;
    }
    case 'loop': {
      /**
       * Bare, like the HUD and unlike the death screen.
       *
       * This mirrors the flat game exactly: `.end-window` carries `.plank`,
       * `.loop-card` does not. The distinction is doing real work — the death
       * screen is an object handed to you, while the transition card is the world
       * dissolving around you during a scripted camera move. Backing it in timber
       * turns a dissolve into a dialog box, and it was rendered as a wooden card
       * for one round before a frame showed it.
       */
      const p = new Panel(0.9, 0.4, 'bare');
      p.setItems(loopItems(s.depth));
      return p;
    }
    case 'hud': {
      const p = new Panel(0.62, 0.2, 'bare');
      p.setItems(hudItems(s));
      return p;
    }
  }
}
