/**
 * The React host: every pixel that is not the 3D world.
 *
 * React owns the canvas element, the menus, the pause screen and the end
 * screens. It deliberately does not own a single frame of the game — the loop
 * lives in `Game` and never triggers a re-render, so nothing that happens at
 * 60fps can touch the reconciler. State crosses back only at the handful of
 * moments a human would call an event.
 *
 * ---------------------------------------------------------------------------
 * Why the game-over window is timed HERE and not in the game loop
 * ---------------------------------------------------------------------------
 * `Game.frame()` advances `caught` -> `gameover` by checking wall clock once per
 * rendered frame. Under the capture harness (SwiftShader, measured at 0.6fps on
 * the catch frame because the jumpscare, the audio ducking and the phase change
 * all land together) the very next frame arrives ~1600ms later. The check passes
 * immediately, so `caught` and `gameover` were delivered to React on the same
 * tick and the window appeared on top of the scare image with no beat between
 * them. Captured frames at 200ms showed the full window already up.
 *
 * So React anchors the reveal to a `setTimeout` taken at the instant `caught`
 * arrives. `SCARE_BEAT_MS` is the contract from the spec: image, one second,
 * then the window. The game may promote itself to `gameover` whenever its frame
 * budget allows; the window still waits out the full second.
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Game, type GamePhase, type LoopStage } from './game';
import './game.css';
import { useMemphis } from '../useMemphis';
import MemphisGate from '../MemphisGate';
import Scoreboard from '../Scoreboard';
import { startRun, reportGem, reportDescent, reportCapture, abandonRun, hasRun } from '../lib/scores';
import TouchControls from './TouchControls';

const ASSETS = 'assets/';

/** Spec: "show billyScare.png, then one second later a game-over window." */
const SCARE_BEAT_MS = 1000;

/**
 * How long the loading plate is held, at minimum, before the menu is allowed in.
 *
 * A critic measured the old loading screen and found it was effectively never
 * seen: at 250ms it was the title ghosting up out of black, and by 1200ms the
 * main menu had already replaced it. On a warm cache the game loads faster than
 * a human can register that a loading screen happened at all.
 *
 * Amnesia's loading screen is a hand-painted dead rose that you sit and look at.
 * That is an authored beat, and an authored beat needs a floor on its duration.
 * This is that floor.
 *
 * It is NOT a fake progress bar. The bar and the percentage under the plate
 * report `onLoadProgress`'s true fraction the whole time; if the real load takes
 * longer than this, the plate simply stays up longer. All this does is refuse to
 * let a beat the player is meant to feel be over before they have seen it.
 */
const LOAD_PLATE_MIN_MS = 4200;

/**
 * How long the plate spends fading out, and how long before the unmount that
 * fade is started.
 *
 * The old screen CUT to the menu, and cutting is most of why it read as "never
 * seen": there was no frame in which a player could notice it ending, so the
 * beat had no exit and therefore no shape. The plate now cross-dissolves — it
 * begins fading while the menu's own 2.4s `gr-menuin` is already running
 * underneath, so for just over half a second both are on screen and the menu
 * emerges through the plate rather than replacing it.
 *
 * Must match the `.overlay--loading.is-leaving` transition in game.css.
 */
const LOAD_FADE_MS = 600;

/*
 * There is no `PlankFittings` component any more, deliberately.
 *
 * It used to render eight spans: four L-shaped "metal corner fittings" and four
 * rivets, on every panel. A critic zoomed one at native resolution and found a
 * flat untextured grey rectangle, against Amnesia's sculpted bracket that curls
 * into a spiral, and measured the resulting high-frequency-detail deficit at
 * 2.6x-9x across every screen in the build.
 *
 * The corners are now carried by the art itself — `assets/ui/frame-cord.png`,
 * a 9-slice `border-image` on `.plank` in game.css, where the flesh-cords knot
 * and spiral at all four corners and the alpha channel makes the panel's
 * silhouette ragged instead of rectangular. That is one PNG and one CSS rule
 * serving menu, pause, game-over, win and loading. If you find yourself
 * reaching for a corner <span> again, the answer is to paint the corner.
 */

type Settings = { sensitivity: number; volume: number };

const SETTINGS_KEY = 'rotr.settings.v1';
const DEFAULT_SETTINGS: Settings = { sensitivity: 1, volume: 0.85 };

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      sensitivity: clamp(Number(p.sensitivity ?? DEFAULT_SETTINGS.sensitivity), 0.2, 3),
      volume: clamp(Number(p.volume ?? DEFAULT_SETTINGS.volume), 0, 1),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

export default function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);

  const [phase, setPhase] = useState<GamePhase>('loading');
  const [gems, setGems] = useState({ got: 0, total: 0 });
  /**
   * Memphis identity. Held here rather than in App because the MENU is what
   * needs it — sign-in, the username field and the board all live on the
   * plank, and the run protocol below keys off `auth.session.name`.
   */
  const auth = useMemphis();
  const memphisName = auth.session?.name;
  /** Bumped after a run finalizes so the board refetches with the new score. */
  const [boardKey, setBoardKey] = useState(0);
  /** The scoreboard modal. Starts CLOSED, by requirement. */
  const [boardOpen, setBoardOpen] = useState(false);
  /**
   * Fullscreen. Mirrored from the document rather than tracked as our own
   * intent, because the browser can leave fullscreen without asking us — Escape,
   * the F11 key, a tab switch, an OS gesture. A boolean we set ourselves would
   * drift out of step and the button would offer to "Exit" a fullscreen the
   * player had already left.
   */
  /**
   * PORTRAIT ON A PHONE IS NOT A SUPPORTED WAY TO PLAY.
   *
   * The game renders fine in portrait, which is the problem: a first-person
   * horror maze in a tall thin window has almost no peripheral vision, the
   * corridor ahead is a slot, and the analog stick and sprint button crowd the
   * bottom of a screen that has no width to spare. It "works" and it plays badly.
   *
   * `matchMedia` rather than comparing innerWidth/innerHeight: on mobile the
   * viewport also goes short-and-wide when the URL bar collapses or the keyboard
   * opens, and a dimension comparison reads those as a rotation.
   *
   * Touch only. A narrow desktop window is someone resizing a browser, not
   * someone holding a phone the wrong way, and demanding they rotate a monitor
   * would be absurd.
   */
  const [isPortrait, setIsPortrait] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(orientation: portrait)');
    const sync = () => setIsPortrait(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    // Safari, which still ships the prefixed event.
    document.addEventListener('webkitfullscreenchange', sync);
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  /**
   * Fullscreen the whole PAGE, not the canvas.
   *
   * The menus, the HUD and the touch controls are DOM siblings of the canvas, so
   * fullscreening the canvas alone would take the game fullscreen and leave every
   * control behind on a page nobody can see. `documentElement` keeps the overlay
   * stack intact.
   *
   * Must be called from a user gesture or the browser rejects it — hence a button
   * rather than, say, doing it automatically on Descend.
   */
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        const el = document.documentElement as HTMLElement & {
          webkitRequestFullscreen?: () => Promise<void>;
        };
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      }
    } catch {
      /* iOS Safari refuses fullscreen on iPhone entirely; the button simply
         does nothing there rather than throwing into the console. */
    }
  }, []);

  /**
   * Is fullscreen even available? iPhone Safari exposes no Fullscreen API at
   * all, so offering the button there is offering something that cannot work.
   */
  const canFullscreen = typeof document !== 'undefined' &&
    (document.fullscreenEnabled ||
     !!(document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled);
  /**
   * Does this device do touch at all? NOT "is this a phone" — the controls mount
   * wherever touch exists and are simply ignored by a player using a mouse,
   * which is the right behaviour on a touchscreen laptop and on a tablet with a
   * keyboard. Pointer lock is likewise only REQUIRED when there is no touch, or
   * Descend would fail on a phone that cannot grant it.
   */
  const hasTouch = typeof window !== 'undefined' &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0);

  /** Phone held upright: block play until it is turned. */
  const needsRotate = hasTouch && isPortrait;

  /**
   * PAUSE if they rotate mid-run.
   *
   * The rotate overlay covers the screen, and without this the monster would go
   * on hunting behind it — you would be caught by something you could not see,
   * which is the one death a horror game has no right to hand out.
   *
   * It stays paused after they rotate back, deliberately: the pause menu is then
   * on screen and resuming is a decision. Dropping someone straight back into a
   * chase they could not watch develop is the same unfairness one step later.
   */
  useEffect(() => {
    if (needsRotate && phase === 'playing') setPaused(true);
  }, [needsRotate, phase]);
  const [progress, setProgress] = useState({ fraction: 0, label: 'Waking' });
  const [doorHint, setDoorHint] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  /** Gates the game-over window on the one-second beat. See the header note. */
  const [scareSettled, setScareSettled] = useState(false);
  /** Holds the in-flight beat timer so a phase change cannot restart the clock. */
  const scareTimerRef = useRef<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [gemPulse, setGemPulse] = useState(false);
  const [settings, setSettings] = useState<Settings>(loadSettings);

  /**
   * The loop's state, pushed from the game loop rather than polled.
   *
   * `fade` arrives every frame while a transition runs. That is a `setState` at
   * frame rate, which is exactly the thing this file's header says React must
   * never do — and it is the right call here anyway, for a bounded reason: it
   * happens only during the ~9 seconds of a transition, when the simulation is
   * stopped and there is nothing else competing for the main thread, and the only
   * thing that re-renders is a single absolutely-positioned div whose opacity
   * changes. React is not reconciling a scene here; it is compositing one layer.
   *
   * The alternative — driving the fade from an imperative ref on the DOM node —
   * would be marginally cheaper and considerably harder to reason about, and it
   * would put the card's timing on a second clock. The game already knows exactly
   * when each beat starts; it should be the thing that says so.
   */
  const [loop, setLoop] = useState<{ active: boolean; stage: LoopStage; fade: number; depth: number }>(
    { active: false, stage: 'idle', fade: 0, depth: 1 },
  );
  /**
   * The loading plate's own three-state life, independent of `phase`.
   *
   *   'held'    — on screen at full opacity. The floor on this is
   *               `LOAD_PLATE_MIN_MS`; the ceiling is however long the real load
   *               takes, whichever is longer.
   *   'leaving' — the fade is running. The menu is already mounted and fading in
   *               underneath, so the two cross-dissolve.
   *   'gone'    — unmounted.
   *
   * This used to be one boolean flipped by a mount-time timer, which made the
   * plate's departure a hard cut and made "is the load finished?" and "has the
   * plate been seen?" the same question. They are not: on a warm cache the load
   * finishes in a few hundred milliseconds and the plate must still hold, while
   * under the capture harness's software rasterizer the load runs ~5s and the
   * plate must simply stay up until it is done.
   */
  const [plate, setPlate] = useState<'held' | 'leaving' | 'gone'>('held');

  // Mirrors for the imperative listeners, which are installed once and must not
  // close over stale state.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // ---- settings application -------------------------------------------------

  /**
   * Volume goes through `Game.setMasterVolume()`, which sets the AudioEngine's
   * real master GainNode, so the slider genuinely attenuates ambience, chase,
   * footsteps and stings together. This used to reach through `private audio` to
   * the node; the accessor requested in docs/handoff/ui-menus.md now exists, and
   * `duck()` writes `duckGain` rather than `master`, so a jumpscare can no longer
   * stomp the user's setting.
   *
   * Sensitivity is applied at the input edge instead: `CFG` is exported `as
   * const`, so `CFG.player.mouseSensitivity` cannot be assigned. Scaling the
   * deltas before they reach `game.handleMouse` is the same maths one step
   * earlier and needs nobody else's file.
   */
  const applyVolume = useCallback((v: number) => {
    const game = gameRef.current;
    if (!game) return false;
    game.setMasterVolume(v);
    return true;
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
    applyVolume(settings.volume);
  }, [settings, applyVolume]);

  // ---- mount ----------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Forceable maze seed (`?seed=1234` or `window.__FORCE_SEED__`). `Game`'s
    // default is `Date.now() & 0xffff`, so every build was a DIFFERENT maze and
    // two runs of the same 16-pose beat script photographed 16 different places.
    // Measured by the beam-catching lane: per-frame 1-3 px noise at the same pose
    // index correlates -0.24 between consecutive runs, and a bootstrap puts the sd
    // of a 16-pose median at 2.43 — larger than most deltas in the sweep tables
    // preserved in config.ts. A table of "changed X, metric moved 1.5" was mostly
    // reporting which corners the harness walked into (PROGRESS.md traps 6b/29b).
    // Anything absent or non-numeric leaves the default intact, so ordinary play
    // stays random; only a deliberate override is deterministic.
    const rawSeed = (window as unknown as { __FORCE_SEED__?: unknown }).__FORCE_SEED__
      ?? new URLSearchParams(location.search).get('seed');
    const forcedSeed =
      rawSeed === undefined || rawSeed === null || rawSeed === '' || !Number.isFinite(Number(rawSeed))
        ? undefined
        : Number(rawSeed) & 0xffff;

    const game = new Game(canvas, {
      onPhase: setPhase,
      onGems: (got, total) => {
        /**
         * One chain call per gem ACTUALLY GAINED.
         *
         * `onGems` also fires with got=0 on every maze build and restart, and
         * the loop calls it once per new maze — so a naive "call on every
         * event" would report phantom gems at the start of each layer and
         * desynchronise the server's count from the player's. Only a strict
         * increase is a pickup.
         */
        setGems((prev) => {
          if (got > prev.got && got - prev.got === 1) reportGem();
          return { got, total };
        });
      },
      onLoadProgress: (fraction, label) => setProgress({ fraction, label }),
      onDoorUnlocked: () => {
        setDoorHint(true);
        window.setTimeout(() => setDoorHint(false), 6000);
      },
      onTransition: (t) => {
        // A descent is scored once, at the moment the world is rebuilt and the
        // depth actually increments — not when the door starts opening, which
        // the player can still die during.
        setLoop((prev) => {
          if (t.depth > prev.depth && prev.depth > 0) reportDescent();
          return t;
        });
      },
    }, forcedSeed);
    gameRef.current = game;

    game.load()
      .then(() => {
        game.start();
        applyVolume(settingsRef.current.volume);
      })
      .catch((err) => {
        console.error('[game] fatal during load', err);
        setFatal(String(err));
      });

    // Test hooks for the headless capture harness. A critic has no pointer lock
    // and no patience for a ten-minute playthrough, so it needs to be able to
    // look around, jump to a gem, and provoke the monster on demand. These drive
    // the same code paths a player does — they do not fake any outcome.
    const w = window as any;
    w.__TESTHOOK_LOOK = (dx: number, dy: number) =>
      game.handleMouse(dx * settingsRef.current.sensitivity, dy * settingsRef.current.sensitivity);
    w.__TESTHOOK_TELEPORT_TO_GEM = (i = 0) => game.debugTeleportToGem(i);
    w.__TESTHOOK_SUMMON = (distance = 6) => game.debugSummonMonster(distance);
    w.__TESTHOOK_COLLECT_ALL = () => game.debugCollectAllGems();
    w.__TESTHOOK_TELEPORT_TO_DOOR = () => game.debugTeleportToDoor();
    /**
     * Force the loop from wherever the player is standing.
     *
     * The transition is ~9 seconds of authored sequence, and iterating it
     * otherwise costs a full playthrough per attempt — `?gems=1` shortens the
     * collection but the run still has to walk to the door. This runs the REAL
     * sequence: same swing, same scripted walk, same regeneration, same shut. It
     * collects the gems and unlocks the door through their ordinary paths first,
     * so the door is genuinely unlocked rather than being force-opened into a
     * state the game cannot otherwise reach.
     */
    w.__TESTHOOK_LOOP_NOW = (teleport = true) => game.debugForceLoop(teleport);
    /**
     * Hold and scrub the transition, so its nine seconds can be PHOTOGRAPHED.
     *
     * Measured reason, not a convenience: under SwiftShader a single screenshot
     * takes seconds — one beat of the first capture run measured 0.18 fps, i.e.
     * ~5.5s per frame — so a frame burst against a free-running sequence
     * photographs whichever beat happens to be current when the encoder finishes.
     * The first run of the loop capture produced thirteen consecutive frames of
     * the same already-finished maze for exactly this reason.
     *
     * Same technique as the documented `Monster.update` freeze: neutralise the
     * thing that moves, then burst. `SCRUB` runs one real step of the held
     * stage's own code at a chosen point through it, so what lands in the frame
     * is a genuine frame of the sequence rather than a pose staged for the camera.
     */
    w.__TESTHOOK_LOOP_HOLD = (stage: string | null) => game.debugHoldLoopAt(stage as never);
    w.__TESTHOOK_LOOP_SCRUB = (k: number) => game.debugScrubLoop(k);
    w.__TESTHOOK_LOOP_RELEASE = () => game.debugReleaseLoop();
    /**
     * Advance one beat and hold there, atomically. Release-then-rehold has a race
     * — between the two calls the sequence runs free and at this frame rate it
     * can shoot straight past the stage being aimed at, which is how the first
     * capture run lost thirteen frames.
     */
    w.__TESTHOOK_LOOP_STEP = () => game.debugStepLoop();
    /** Renderer resource counts — the leak gate for repeated regeneration. */
    /** What is really behind the open door — a raycast, run inside the engine. */
    w.__TESTHOOK_DOORWAY_RAYS = (n?: number) => game.debugDoorwayRays(n);
    w.__TESTHOOK_MEMORY = () => game.debugMemory();
    /** How many mazes deep. */
    w.__TESTHOOK_DEPTH = () => game.currentDepth;
    /**
     * The terminal win screen, which the door no longer leads to. Kept reachable
     * so the end-screen checks in GAME-SPEC section 2 can still be verified.
     */
    w.__TESTHOOK_WIN_SCREEN = () => game.debugWinScreen();
    // Read the camera's local transform (bob, roll, foot-plant nod, sprint FOV).
    // At the harness's frame rate a 300ms stride is one frame apart, so player
    // feel cannot be resolved from screenshots — it needs a numeric sample.
    w.__TESTHOOK_CAMERA = () => game.debugCameraTransform();
    /**
     * The game object itself, for beat scripts that need to express a setup no
     * fixed-purpose hook covers — e.g. placing Billy at a specific corridor
     * distance in a specific blind cell to verify director pacing. Shipped code
     * never reads this; it exists so a capture script under `tools/beats/` can
     * reach `game.maze` and `game.monster` without a bespoke hook being added for
     * every new question a critic wants to ask.
     */
    w.__GAME__ = game;
    // Lets the harness assert the UI layer's own state, not just the game's.
    w.__UI_STATE__ = () => ({
      phase: phaseRef.current,
      paused: pausedRef.current,
      settings: settingsRef.current,
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') return; // handled on keydown below
      if (['ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
      // While paused, swallow movement so nothing is held down across the pause
      // and the player does not walk on the far side of the menu.
      if (pausedRef.current) return;
      game.handleKey(e.code, e.type === 'keydown');
    };

    const onEscape = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' || e.type !== 'keydown') return;
      // Only meaningful mid-run. The browser also fires this when it drops
      // pointer lock, which is exactly the moment we want the menu.
      if (phaseRef.current !== 'playing') return;
      e.preventDefault();
      setPaused((p) => !p);
    };

    /**
     * Reject the pointer-lock transition spike.
     *
     * When lock engages, the browser delivers a mousemove whose movementX/Y is the
     * jump from wherever the cursor was to the lock origin. Clicking "Descend" — a
     * button below screen centre — produced ~463px of movementY, which look()
     * faithfully applied as a 58 degree flick at the sky, and it stayed there for
     * the rest of the run. Measured on the static build: pitch -0.049 at 0.3s after
     * the click, +0.9698 rad by 1.5s. From that angle the monster sits at the very
     * bottom edge of frame, which is almost certainly why he was reported as
     * "knee height" — his size was never the problem.
     *
     * A real flick is tens of pixels per event, never hundreds. Anything past this
     * is not a hand moving a mouse.
     */
    const MAX_MOUSE_DELTA = 180;
    const onMove = (e: MouseEvent) => {
      if (pausedRef.current) return;
      if (document.pointerLockElement !== canvas) return;
      if (Math.abs(e.movementX) > MAX_MOUSE_DELTA || Math.abs(e.movementY) > MAX_MOUSE_DELTA) return;
      const s = settingsRef.current.sensitivity;
      game.handleMouse(e.movementX * s, e.movementY * s);
    };
    const onLockChange = () => {
      const locked = document.pointerLockElement === canvas;
      setPointerLocked(locked);
      // Losing the lock mid-run is the browser's Escape. Surface the menu so the
      // player is never left standing in the dark with no pointer and no reason.
      if (!locked && phaseRef.current === 'playing') setPaused(true);
    };
    const onResize = () => game.onResize();

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('keydown', onEscape);
    window.addEventListener('mousemove', onMove);
    document.addEventListener('pointerlockchange', onLockChange);
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('keydown', onEscape);
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      window.removeEventListener('resize', onResize);
      game.dispose();
    };
  }, [applyVolume]);

  /**
   * Drive the plate out.
   *
   * Two conditions have to be true before it may start leaving, and they are
   * genuinely independent:
   *
   *   1. The real load is finished — `phase` has left 'loading'. Holding past
   *      this is authored time; leaving before it would be a lie, and would show
   *      a menu whose Descend button cannot work yet.
   *   2. `LOAD_PLATE_MIN_MS` has elapsed SINCE MOUNT. The clock starts at mount
   *      rather than at load-complete so it runs concurrently with `Game.load()`
   *      and overlaps it, instead of adding its duration on top. Under the
   *      capture harness the load takes ~4.3s and the floor is never reached;
   *      on a warm desktop cache the load is a few hundred ms and the floor is
   *      the entire beat.
   *
   * Then the fade runs for `LOAD_FADE_MS` before the element is unmounted, so
   * the plate dissolves into the menu instead of cutting to it.
   */
  const [floorPassed, setFloorPassed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setFloorPassed(true), LOAD_PLATE_MIN_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (plate !== 'held') return;
    if (!floorPassed) return;
    if (phase === 'loading') return;
    setPlate('leaving');
    const t = window.setTimeout(() => setPlate('gone'), LOAD_FADE_MS);
    return () => window.clearTimeout(t);
  }, [plate, floorPassed, phase]);

  // ---- the scare beat -------------------------------------------------------

  useEffect(() => {
    const dead = phase === 'caught' || phase === 'gameover';
    if (!dead) {
      scareTimerRef.current = null;
      setScareSettled(false);
      return;
    }
    // Arm exactly once, on the first dead phase we see. `caught` -> `gameover`
    // re-runs this effect, and an effect cleanup would cancel the in-flight
    // timer and restart the clock — which is precisely what pushed the measured
    // beat out to catch+2238ms on the first instrumented run. The ref makes the
    // timer survive the phase change, so the second is counted from the catch
    // and from nothing else.
    if (scareTimerRef.current !== null) return;
    scareTimerRef.current = window.setTimeout(() => setScareSettled(true), SCARE_BEAT_MS);
  }, [phase]);

  /** Leaving play for any reason clears the pause menu. */
  useEffect(() => {
    if (phase !== 'playing') setPaused(false);
  }, [phase]);

  /**
   * Actually freeze the simulation while the pause menu is up. Swallowing input
   * only froze the *player*: `updatePlay()` kept running, so Billy kept walking
   * toward you and could catch you while you were reading the volume slider.
   * The game keeps rendering, so the maze stays behind the menu.
   */
  useEffect(() => {
    gameRef.current?.setPaused(paused && phase === 'playing');
  }, [paused, phase]);

  /**
   * Release the pointer whenever the pause menu goes up.
   *
   * This is not redundant with the browser's own behaviour. Chromium exits
   * pointer lock on Escape *itself*, so on the Escape path the two agree and
   * this is a no-op — but pause is not only reachable by Escape. It is set by
   * `onLockChange` when the lock is lost for any other reason, and it will be
   * set by any future in-game trigger. Measured headlessly: after Escape opened
   * the menu, `document.pointerLockElement` was still the canvas
   * (`L_2 {"locked":true,"paused":true}`), which means a menu was on screen with
   * the mouse still captured — the cursor is invisible and Resume cannot be
   * clicked. Asserting the release here makes the invariant "menu up implies
   * pointer free" true by construction rather than by the browser agreeing
   * with us.
   *
   * The other half of the contract — clicking re-locks — is on the canvas's
   * onClick and on `resume()`, both of which call `lock()` from a real user
   * gesture, which is the only context in which requestPointerLock is allowed.
   */
  useEffect(() => {
    if (paused) document.exitPointerLock?.();
  }, [paused]);

  /**
   * Re-assert the user's volume on every phase change.
   *
   * `AudioEngine.duck()` writes the master gain *absolutely* — `duck(0.25, 0.2)`
   * on the catch and `duck(1, 0.4)` on restart both ramp the node to a literal
   * value, with no knowledge that the player ever moved a slider. Left alone
   * that silently resets volume to 100% the first time you die. Ducks happen at
   * phase boundaries, so re-applying here puts the setting back immediately
   * after. A duck *during* a phase still overrides until the next boundary;
   * the real fix is a separate user-volume scalar in the engine, requested in
   * docs/handoff/ui-menus.md.
   */
  useEffect(() => {
    const t = window.setTimeout(() => applyVolume(settingsRef.current.volume), 500);
    return () => window.clearTimeout(t);
  }, [phase, applyVolume]);

  /** Brief legibility pulse on the HUD tally when the count changes. */
  useEffect(() => {
    if (gems.got === 0) return;
    setGemPulse(true);
    const t = window.setTimeout(() => setGemPulse(false), 1400);
    return () => window.clearTimeout(t);
  }, [gems.got]);

  // ---- actions --------------------------------------------------------------

  const lock = useCallback(async () => {
    /**
     * Never ask a touch device for pointer lock. There is no pointer to lock, and
     * on mobile browsers the request either rejects or throws up a permission
     * prompt over the game for a capability that will not be used — the swipe
     * surface reads raw pointer deltas and needs no lock at all.
     */
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
    try { await canvasRef.current?.requestPointerLock(); } catch { /* headless */ }
  }, []);

  const enterPlay = useCallback(async () => {
    const game = gameRef.current;
    if (!game) return;
    /**
     * Open the run BEFORE play starts, and only for a signed-in player.
     *
     * Anonymous play is deliberately still allowed — this is a horror game,
     * not a login wall — it simply is not scored. `startRun` is fire-and-
     * forget: the run id arrives on the serialized chain a moment later and
     * every later call waits behind it, so nothing here can delay `Descend`.
     */
    if (memphisName) startRun(memphisName);
    await game.beginPlay();
    applyVolume(settingsRef.current.volume);
    // Pointer lock must come from the user gesture; a rejected request is fine
    // headlessly, where the harness drives the camera by key instead.
    await lock();
  }, [applyVolume, lock, memphisName]);

  const resume = useCallback(async () => {
    setPaused(false);
    await lock();
  }, [lock]);

  /** Disarm the beat timer so a restart never inherits a pending reveal. */
  const clearScareBeat = useCallback(() => {
    if (scareTimerRef.current !== null) window.clearTimeout(scareTimerRef.current);
    scareTimerRef.current = null;
    setScareSettled(false);
  }, []);

  const retry = useCallback(async () => {
    const game = gameRef.current;
    if (!game) return;
    clearScareBeat();
    setPaused(false);
    game.restart();
    applyVolume(settingsRef.current.volume);
    await lock();
  }, [applyVolume, lock, clearScareBeat]);

  const goHome = useCallback(() => {
    clearScareBeat();
    setPaused(false);
    gameRef.current?.restart();
    /**
     * Home resets the depth; Retry does not. That difference is the counter's
     * whole meaning — Retry is "let me try that maze again", so you died at depth
     * 4 and you retry depth 4, whereas Home is starting over, and a fresh game
     * that opens with "5 deep" already on the HUD has given the loop away before
     * the player has taken a step. The number has to appear for the first time at
     * the end of the first loop.
     */
    gameRef.current?.resetDepth();
    // Home is the one path that closes a run out. Banks one last time, so the
    // board is current the moment the menu draws behind us.
    if (hasRun()) { abandonRun(); setBoardKey((k) => k + 1); }
    // `restart()` puts the game back into 'playing'; the menu is a UI-layer
    // state, so it is asserted after and the loop simply renders behind it.
    setPhase('menu');
    document.exitPointerLock?.();
  }, [clearScareBeat]);

  /**
   * Bank the score when he catches you.
   *
   * `reportCapture` deliberately leaves the run OPEN — Retry keeps your depth,
   * so the run is a session rather than a life. Banking here means a player who
   * dies and closes the tab still keeps what they reached.
   */
  useEffect(() => {
    if (phase !== 'caught' || !hasRun()) return;
    void reportCapture()
      .then(() => setBoardKey((k) => k + 1))
      .catch(() => { /* best-effort; the run stays open either way */ });
  }, [phase]);

  const showEndWindow = scareSettled;
  const isDead = phase === 'caught' || phase === 'gameover';
  /**
   * The plate outlives the load: `phase` may already be 'menu' while it is still
   * held. It is mounted until the fade has finished.
   */
  const showLoading = phase === 'loading' || plate !== 'gone';
  /**
   * The menu mounts as soon as the plate STARTS leaving, not after it has gone,
   * so the plate's 600ms fade-out and the menu's own 2.4s fade-in overlap.
   * That overlap is the whole point — with a hard swap there is no frame in
   * which a player can see the loading screen hand over, which is exactly why
   * the old one registered as never having happened.
   */
  const showMenu = phase === 'menu' && plate !== 'held';

  /**
   * Image URLs handed to CSS as custom properties, RELATIVE to the bundle.
   *
   * `game.css` used absolute `url('/assets/images/...')`, which has two faults:
   * it resolves against the gateway root rather than the app root once this is
   * served from `/_/raw/<cid>/`, and it is a different URL from the one the
   * preloader warms — so the loading plate and the scare art were being fetched
   * twice, the second time at the moment they were needed.
   */
  /**
   * ...and RESOLVED against the document, not left bare-relative.
   *
   * MEASURED BUG, found by grepping a static-build capture's server log for 404s:
   *
   *     GET /_/raw/<cid>/assets/assets/images/son.png  404
   *     GET /_/raw/<cid>/assets/assets/images/sonEye.png  404
   *
   * A relative `url()` in a custom property is resolved against the STYLESHEET
   * that finally uses it, not against the document — and the bundled stylesheet
   * lives at `/_/raw/<cid>/assets/main-<hash>.css`. So `assets/images/son.png`
   * resolved to `assets/assets/images/son.png` and both images 404'd. The
   * loading plate and the menu eye have been rendering as empty boxes on the
   * gateway path, silently, because a missing background-image is not an error.
   *
   * This is the same trap the comment above describes, one level deeper: the
   * previous fix moved the URLs off the absolute `/assets/...` that resolved
   * against the gateway root, which was correct, but a bare relative URL in a
   * custom property has its own reference frame and it is not the one you want.
   *
   * `new URL(x, document.baseURI)` resolves against the APP root — `<base>` is
   * what Vite's `base: "./"` and the gateway prefix both act on — so it is right
   * in dev, right under `/_/raw/<cid>/`, and identical to the URL `preloadImages`
   * warms, which is what makes the preload actually apply to these.
   */
  const assetUrl = (p: string) => {
    try { return new URL(p, document.baseURI).href; } catch { return p; }
  };
  const assetVars = {
    '--gr-son': `url(${assetUrl(`${ASSETS}images/son.png`)})`,
    '--gr-soneye': `url(${assetUrl(`${ASSETS}images/sonEye.png`)})`,
  } as React.CSSProperties;

  return (
    <div className="game-root" style={assetVars}>
      <canvas ref={canvasRef} className="game-canvas" onClick={() => { if (!paused && phase === 'playing') void lock(); }} />

      {fatal && (
        <div className="overlay overlay--fatal">
          <h2>It would not open.</h2>
          <pre>{fatal}</pre>
        </div>
      )}

      {showLoading && (
        <div className={`overlay overlay--loading${plate === 'leaving' ? ' is-leaving' : ''}`}>
          {/* The authored plate: the son's pale forearm and hand hanging out of
              a torso of woven red cords, cropped from son.png and graded into
              the game's three colours. See `.loading-plate` in game.css for why
              this crop and not another. */}
          <div className="loading-plate" aria-hidden="true" />
          <div className="loading-inner">
            <div className="loading-eyebrow">A purgatory in the shape of a maze</div>
            <div className="loading-title">
              REVENGE OF THE
              <b>RETRIEVED</b>
            </div>
            <div className="loading-rule" />
            {/* The fiction, told once, in the only place in the build with the
                room and the seconds to tell it. GAME-SPEC section 1. */}
            {/* No <br/>s: hard breaks plus a wrapping measure produced orphans
                ("...left of / you" / "...with / him.") on the captured frame,
                which reads as a layout accident rather than as authored lines.
                `.loading-epigraph` carries a 46ch measure and `text-wrap:
                balance` instead, so the browser evens the three lines itself at
                whatever width the viewport gives it. */}
            <p className="loading-epigraph">
              You murdered a man's son. The father did not go to the law… He conjured
              a spell that used your flesh to bring the boy back, trapping you in that
              boy's domain. <em>He will never let you go.</em>
            </p>
            <div className="loading-meter">
              <div className="loading-bar"><div style={{ width: `${progress.fraction * 100}%` }} /></div>
              <div className="loading-meterrow">
                <span className="loading-label">{progress.label}…</span>
                <span className="loading-pct">{Math.round(progress.fraction * 100)}%</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {showMenu && (
        <div className="overlay overlay--menu">
          {/* Real image data behind the title rather than a smooth CSS ramp.
              See the `.menu-bg` note in game.css. */}
          <div className="menu-bg" aria-hidden="true" />
          {/* Title top-left, controls in a column down the LEFT edge, and the eye
              given the whole right of the frame. The centred layout put the panel
              over the iris no matter how small it got, and `space-between` had
              stranded the title's divider rule in the dead centre of the screen —
              which is the line the user asked about. The rule is gone: it was a
              flourish under a title, and there is no longer a title to sit under
              in that position. */}
          <div className="menu-inner">
            <h1 className="title">REVENGE OF THE<span>RETRIEVED</span></h1>
            {/* The board and the plank share ONE bottom-left column.
                They were siblings of an absolutely-positioned plank before,
                which put the board at the container's origin — top-left, over
                the eye. A column also means the plank can change height (it
                does: signed-in shows a username field) without a hand-tuned
                offset drifting into a collision. */}
            <div className="menu-left">
              <div className="menu-plank plank">
                <p className="tagline">
                He was small when you took him. He is not small here.
              </p>
              <button className="btn btn--primary" onClick={enterPlay}>Descend</button>
              <div className="controls">
                <span><b>WASD</b> move</span>
                <span><b>Shift</b> sprint</span>
                <span><b>Mouse</b> look</span>
                <span><b>Esc</b> pause</span>
              </div>
              {/* Identity and the board share the plank, under the controls.
                  Anonymous play still works — sign-in only decides whether the
                  descent is counted, so the gate is never in front of Descend. */}
                <MemphisGate auth={auth} />
                {/* Below Rename, as asked. The board is a modal now — inline it
                    was small, half-hidden behind the plank's frame, and its
                    columns collapsed into an unreadable "1 layer 0". */}
                <button className="btn btn--ghost menu-board-btn" onClick={() => setBoardOpen(true)}>
                  Scoreboard
                </button>
                {/* Deliberately NOT in the HUD: the user asked for it in the two
                    menus only. A fullscreen control on the play HUD is one more
                    thing to fat-finger mid-chase, and on touch it would sit in
                    the same corner as the pause button. */}
                {canFullscreen && (
                  <button className="btn btn--ghost menu-board-btn" onClick={() => void toggleFullscreen()}>
                    {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Outside the menu overlay so the darkening covers the title and the eye
          too, and so it survives the menu's own fade animation. Closed by
          default — nobody should start the game with the score window up. */}
      <Scoreboard
        open={boardOpen}
        onClose={() => setBoardOpen(false)}
        memphisName={memphisName}
        refreshKey={boardKey}
      />

      {needsRotate && (
        <div className="rotate" role="alertdialog" aria-label="Rotate your device">
          <div className="rotate-inner">
            <div className="rotate-phone" aria-hidden="true">
              <span className="rotate-phone-body" />
              <span className="rotate-arrow" />
            </div>
            <h2 className="rotate-title">TURN YOUR SCREEN</h2>
            <p className="rotate-note">He is easier to miss in a narrow room.</p>
          </div>
        </div>
      )}

      {/* PAUSE, top right. Esc is the only other way in and a phone has no Esc,
          so without this a mobile player cannot pause, quit, or reach settings
          at all. Outside the `.hud` because that block is `pointer-events: none`
          by design — a button in there would render and never take a tap. */}
      {hasTouch && phase === 'playing' && !paused && (
        <button
          className="touch-pause"
          onPointerDown={(e) => { e.stopPropagation(); setPaused(true); }}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="Pause"
        >
          <span /><span />
        </button>
      )}

      {hasTouch && phase === 'playing' && !paused && (
        <TouchControls
          onMove={(f, st, sp) => gameRef.current?.setTouchInput(f, st, sp)}
          onLook={(dx, dy) => gameRef.current?.handleMouse(dx, dy)}
        />
      )}

      {phase === 'playing' && (
        <div className={`hud${hasTouch ? ' hud--touch' : ''}`}>
          <div className={`hud-gems${gemPulse ? ' is-pulsed' : ''}`}>
            <div className="hud-tally">
              {Array.from({ length: gems.total }, (_, i) => (
                <span key={i} className={`hud-tick${i < gems.got ? ' is-got' : ''}`} />
              ))}
            </div>
            <span className="hud-count">{gems.got} / {gems.total}</span>
            {/*
              THE DEPTH COUNTER — and it is deliberately absent on the first maze.

              At depth 1 there is nothing to count and a "DEPTH 1" label would give
              the loop away before the player has any reason to suspect one exists.
              The whole effect depends on the first door being believed. So it
              appears the moment it becomes true, which is also the moment it stops
              being a number and starts being a tally of how long this has been
              going on: the second maze reads as a joke, the fifth reads as dread.

              Restrained on purpose — same scratched-tally language as the gems,
              one line, no colour of its own.
            */}
            {loop.depth > 1 && (
              <span className="hud-depth" title="mazes deep">
                <b>{loop.depth}</b> layers deep
              </span>
            )}
          </div>
          {/* The gems are what the spell took; giving the last one back is what
              opens the way out. "Something unlocked" described a game mechanic —
              this describes the same event inside the fiction. */}
          {doorHint && (
            <div className="hud-hint">You&rsquo;ve weakened him… Now get out of here</div>
          )}
          {/* Desktop only. `pointerLocked` is set by the `pointerlockchange` event,
              which NEVER fires on touch because `lock()` deliberately skips
              requestPointerLock there — so without the `!hasTouch` guard this
              condition is permanently true and the hint sits in the middle of the
              screen for the whole game. It is also meaningless on a phone: there
              is nothing to click, and looking is a swipe. */}
          {!hasTouch && !pointerLocked && !paused && (
            <div className="hud-lockhint">click to look</div>
          )}
        </div>
      )}

      {paused && phase === 'playing' && (
        <div className="overlay overlay--pause">
          <div className="pause-inner plank">
            <h2 className="pause-title">Paused</h2>

            <div className="settings">
              <label className="setting">
                <span className="setting-row">
                  <span>Look sensitivity</span>
                  <output>{settings.sensitivity.toFixed(2)}×</output>
                </span>
                <input
                  className="slider"
                  type="range"
                  min={0.2}
                  max={3}
                  step={0.05}
                  value={settings.sensitivity}
                  onChange={(e) => setSettings((s) => ({ ...s, sensitivity: Number(e.target.value) }))}
                />
              </label>

              <label className="setting">
                <span className="setting-row">
                  <span>Volume</span>
                  <output>{Math.round(settings.volume * 100)}%</output>
                </span>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.volume}
                  onChange={(e) => setSettings((s) => ({ ...s, volume: Number(e.target.value) }))}
                />
              </label>
            </div>

            <div className="pause-buttons">
              <button className="btn btn--primary" onClick={resume}>Resume</button>
              <button className="btn" onClick={retry}>Restart</button>
              {canFullscreen && (
                <button className="btn btn--ghost" onClick={() => void toggleFullscreen()}>
                  {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                </button>
              )}
              <button className="btn btn--ghost" onClick={goHome}>Home</button>
            </div>
          </div>
        </div>
      )}

      {isDead && (
        <div className={`overlay overlay--scare${showEndWindow ? ' is-settled' : ''}`}>
          {/* The field the photograph is pinned to. billyScare.png is 816x624
              letterboxed into a 16:9 viewport, so without this the left and
              right thirds of this screen are literally 0,0,0 — which is the
              "flat rectangles on near-black" a critic reads, even though the
              panel itself is a bitmap. Only shown once the window is up: during
              the one-second scare beat the image is meant to arrive alone, on
              black, with nothing else in frame competing with it. */}
          {showEndWindow && <div className="end-field" aria-hidden="true" />}
          <img src={`${ASSETS}images/billyScare.png`} alt="" className="scare-img" />
          {!showEndWindow && <div className="scare-flash" />}
          {showEndWindow && (
            <div className="end-window plank">
                <h2>HE FOUND YOU</h2>
              {/* Names the crime and the debt. The old line — "He waited a long
                  time to be found first" — was atmospheric but generic: it works
                  equally well for any monster in any maze. GAME-SPEC section 1 is
                  specific, and the death screen is where being caught by the
                  person you killed should mean something. */}
              <p className="end-sub">You really thought you could escape?</p>
              <div className="end-buttons">
                <button className="btn btn--primary" onClick={retry}>Retry</button>
                <button className="btn" onClick={goHome}>Home</button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'won' && (
        <div className="overlay overlay--win">
          <div className="end-field" aria-hidden="true" />
          <img src={`${ASSETS}images/son.png`} alt="" className="win-img" />
          <div className="end-window plank">
            <h2>YOU MADE IT OUT</h2>
            {/* The fiction, landed at the only beat that can carry it.
                GAME-SPEC section 1: the player is the killer, the father melted him
                onto what was left of the boy, and the monster is made out of the
                player's own flesh. Nothing in the shipped game ever said so — the
                previous line here, "The door closed behind you. He did not follow",
                read as a clean escape from a generic maze monster, which is the
                opposite of the brief's ending. You do not get to leave him behind,
                because he is wearing you. */}
            <p className="end-sub">
              Or so he lets you think.
              <br />
              There is no escape… Not even death…
            </p>
            <div className="end-buttons">
              <button className="btn btn--primary" onClick={retry}>Play Again</button>
              <button className="btn" onClick={goHome}>Home</button>
            </div>
          </div>
        </div>
      )}

      {/*
        ---------------------------------------------------------------------
        THE LOOP
        ---------------------------------------------------------------------
        One black layer whose opacity the game drives frame by frame, and a card
        that only exists during the 'card' beat.

        `pointerEvents: none` matters. This sits over the canvas for nine seconds
        and there is nothing on it to click; leaving it interactive would swallow
        the click that re-acquires pointer lock on the far side, and the player
        would come out of the transition unable to look around with no indication
        why.

        The fade is `opacity` on a solid fill rather than a CSS transition,
        because the timing belongs to the game: `updateLoop` already knows exactly
        how far through each beat it is, and a CSS transition would be a second
        clock racing the first — which is the specific bug the game-over beat was
        already restructured to avoid (see this file's header).
      */}
      {loop.active && (
        <div
          className="overlay overlay--loop"
          style={{ opacity: loop.fade, pointerEvents: 'none' }}
          aria-hidden={loop.stage !== 'card'}
        >
          {loop.stage === 'card' && (
            <div className="loop-card">
              {/*
                THE FIRST LOOP GETS THE FULL VICTORY CARD, AND THAT IS THE SHOCK.

                The user's three lines are the best writing in the project, and
                they only pay off if the player has genuinely believed the first
                one. So on the first transition this is exactly the win screen
                they earned — "YOU MADE IT OUT" — and then the floor goes out
                from under it: the fade comes up and they are in another maze.
                Showing a knowing wink on loop 1 would spend the joke before it
                has been set up.

                From loop 2 the game stops pretending. There is no headline and no
                claim of escape, just the depth and one short line, because the
                second time the player already knows and a repeat of the full
                card would read as the game not noticing. The lines shorten as the
                counter climbs, which is its own kind of escalation — the game has
                less and less to say about it.
              */}
              {loop.depth === 2 ? (
                <>
                  <h2 className="loop-title">YOU MADE IT OUT</h2>
                  <p className="loop-sub">
                    Or so he lets you think.
                    <br />
                    There is no escape… Not even death…
                  </p>
                </>
              ) : (
                <>
                  <div className="loop-depth">
                    <span>{loop.depth}</span> mazes deep
                  </div>
                  <p className="loop-sub loop-sub--short">
                    {loop.depth < 5
                      ? 'There is no escape… Not even death…'
                      : 'He is not counting. He does not need to.'}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
