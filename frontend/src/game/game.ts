/**
 * The game: owns the renderer, the scene, the loop, and the state machine that
 * decides whether you are playing, dead, or out.
 *
 * It also exposes `window.__READY__`, `window.__FPS__` and `window.__GAME_STATE__`.
 * Those exist for the headless capture harness — critics drive the real build and
 * read real state rather than trusting anyone's description of it.
 */

import * as THREE from 'three';
import { CFG } from './config';
import { Maze, mulberry32 } from './maze';
import { buildWorld, applyElevationFog, type WorldBuild } from './world';
import { buildPost, type PostChain } from './post';
import { Player } from './player';
import { Monster } from './monster';
import { AudioEngine } from './audio';

/**
 * `transition` is the loop: the door opening, the walk through it, the card on
 * black, and the new maze fading up with the door shutting behind you. It is a
 * distinct phase rather than a flag on `playing` because during it the player
 * controller must be OFF — the camera is being driven by a script and an input
 * handler fighting it would produce a shove rather than a move.
 *
 * It is deliberately NOT terminal, which is the entire point. `won` still exists
 * and is still reachable (nothing removes it), but the ordinary path through the
 * door now goes to `transition` and comes back out at `playing` one maze deeper.
 */
export type GamePhase = 'loading' | 'menu' | 'playing' | 'caught' | 'gameover' | 'won' | 'transition';

export type GameEvents = {
  onPhase: (phase: GamePhase) => void;
  onGems: (collected: number, total: number) => void;
  onLoadProgress: (fraction: number, label: string) => void;
  onDoorUnlocked: () => void;
  /**
   * The transition, reported to the UI layer so React can draw the fade and the
   * card. `stage` names which beat is running; `fade` is 0 (clear) to 1 (black);
   * `depth` is how many mazes deep the player now is, 1-based, so the first maze
   * is depth 1 and the first loop lands them at depth 2.
   *
   * Pushed rather than polled: the game loop already knows exactly when each beat
   * changes, and having React sample it on an interval would put the card's timing
   * at the mercy of a second clock. `fade` is pushed every frame during the
   * sequence — it is one number and the overlay is a single compositor layer, so
   * this does not re-render anything expensive.
   */
  onTransition: (t: { active: boolean; stage: LoopStage; fade: number; depth: number }) => void;
};

/**
 * The beats of the loop, in the order they run. Named rather than numbered so a
 * capture script's `__GAME_STATE__.loopStage` says what the frame is showing.
 */
export type LoopStage =
  | 'idle'      // not looping
  | 'opening'   // the leaf swings on its hinge; gate1.ogg is playing
  | 'walking'   // the camera is carried through the doorway
  | 'fadeout'   // to black
  | 'card'      // the three lines, held on black; the world is rebuilt during this
  | 'fadein'    // the NEW maze comes up
  | 'shutting'  // the door behind you closes
  | 'vanishing';// and then is not there at all

const ASSETS = 'assets/';

/**
 * Scratch vectors for the per-frame flashlight-cone handoff to the dust shader.
 * Module-level so the render loop allocates nothing: this runs every frame, and
 * two Vector3s per frame at 60Hz is 7,200 objects a minute for the GC to sweep.
 */
const BEAM_POS = new THREE.Vector3();
const BEAM_DIR = new THREE.Vector3();

/**
 * Soften the punctual-light distance falloff so the torch's near field cannot
 * run away past the tone curve's shoulder.
 *
 * WHY THIS IS A SHADERCHUNK OVERRIDE. The falloff lives inside three's own
 * `lights_pars_begin` chunk, called from `getSpotLightInfo`, and it is applied
 * before anything a material can reach: `onBeforeCompile` can patch a material's
 * shader, but every lit material would then need the identical patch, and any
 * surface that missed it would disagree with its neighbours about how bright the
 * beam is at 1 m. Overriding the chunk itself is the only edit guaranteed to be
 * consistent across walls, floor, trim, gems and the monster. Installed once,
 * before the first material compiles.
 *
 * WHAT IT CHANGES. Exactly one line of three's function — the `distanceFalloff`
 * term — replacing the raw `lightDistance` with a softened distance
 *
 *     d_eff = (d^n + R^n)^(1/n)
 *
 * The Frostbite windowing term that fades the light out at `cutoffDistance` is
 * deliberately left on the RAW distance, not the softened one: that term exists
 * to drive the light to exactly zero at `distance` so it can be culled, and
 * feeding it d_eff would move the cutoff inward and leave a visible edge where
 * the beam ends. Only the falloff is softened.
 *
 * See CFG.flashlight.nearFloor for the measurement that motivates the value.
 *
 * Idempotent: the pristine chunk is captured on first call, so changing the
 * radius always re-patches the ORIGINAL rather than compounding onto an
 * already-patched string.
 */
/**
 * The pristine chunk and the installed key live on `globalThis`, NOT in module
 * locals.
 *
 * They have to outlive this module, because `THREE.ShaderChunk` does. Under Vite
 * HMR an edit to this file re-evaluates it while the three module instance —
 * and therefore the ALREADY-PATCHED `lights_pars_begin` — survives untouched.
 * Module locals reset to null, so the next call captured the patched string as
 * "pristine", failed the needle match, and logged the loud "the torch core will
 * blow out" error. It was not a false alarm: past that point the dev server
 * really was rendering an unpatched beam, so every screenshot taken from it had
 * a blown highlight that production would not have had. Anchoring the state to
 * the realm makes a hot reload a no-op instead of a silent downgrade.
 */
const NEAR_FLOOR_STATE = '__meneseNearFieldFloor__';
type NearFloorState = { pristine: string | null; key: string | null };
const nearFloorState = (): NearFloorState => {
  const g = globalThis as unknown as Record<string, NearFloorState | undefined>;
  return (g[NEAR_FLOOR_STATE] ??= { pristine: null, key: null });
};

export function installNearFieldFloor(radius: number, power: number): void {
  const state = nearFloorState();
  if (state.pristine === null) {
    state.pristine = THREE.ShaderChunk.lights_pars_begin;
  }
  const key = `${radius}/${power}`;
  if (state.key === key) return;
  const src = state.pristine;

  // A zero/negative radius means "disabled" — restore three's own behaviour.
  if (!(radius > 0)) {
    THREE.ShaderChunk.lights_pars_begin = src;
    state.key = key;
    return;
  }

  // The exact line from three's lights_pars_begin. Matched literally so that a
  // three upgrade which rewrites this function fails LOUDLY here, rather than
  // silently shipping an unpatched beam that reviews fine and blows the core
  // again in capture.
  const NEEDLE = 'float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );';
  if (!src.includes(NEEDLE)) {
    console.error(
      '[nearFloor] three.js getDistanceAttenuation no longer matches the expected source; ' +
      'the near-field floor was NOT installed and the torch core will blow out. ' +
      'Re-derive the patch against the installed three version.',
    );
    return;
  }

  // R^n is precomputed on the CPU: it is a constant, and folding it here keeps
  // the added shader cost to one pow + one add + one pow per light per fragment.
  const RN = Math.pow(radius, power).toFixed(6);
  const N = power.toFixed(4);
  const patched =
    `float softD = pow( pow( lightDistance, ${N} ) + ${RN}, 1.0 / ${N} );\n\t` +
    `float distanceFalloff = 1.0 / max( pow( softD, decayExponent ), 0.01 );`;
  THREE.ShaderChunk.lights_pars_begin = src.replace(NEEDLE, patched);
  state.key = key;
}

/**
 * The signed shortest way round from `a` to `b`, in radians, always in [-PI, PI].
 *
 * Needed by the loop's scripted camera move. Interpolating `a + (b - a) * k` on
 * raw yaws is correct right up until the pair straddles the +/-PI seam, at which
 * point the camera takes the 300-degree route instead of the 60-degree one — a
 * full pirouette in the middle of the one shot in the game that has to read as
 * simply walking forward. The failure is invisible on most seeds, because whether
 * it happens depends on which wall the door landed in.
 */
function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Fetch and decode images before they are ever needed.
 *
 * `billyScare.png` and `son.png` are rendered by React as plain <img> tags, which
 * means the browser did not begin fetching them until the element mounted — i.e.
 * at the exact instant of the jumpscare. The user's report was "the jumpscare
 * image takes a while to load at first", and that is precisely the frame where a
 * stall is least forgivable: the scare lands on an empty box and the timing of the
 * whole sequence is thrown.
 *
 * `decode()` is the important part. A loaded image still costs a decode on first
 * paint; doing it here moves that cost into the loading screen where it belongs.
 * Failures are swallowed deliberately — a preload is an optimisation, and it must
 * never be the reason the game refuses to start.
 */
async function preloadImages(urls: string[]): Promise<void> {
  await Promise.all(urls.map((url) => new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const done = () => resolve();
      if (typeof img.decode === 'function') img.decode().then(done, done);
      else done();
    };
    img.onerror = () => resolve();
    img.src = url;
  })));
}

/**
 * The way out, built as carpentry rather than as a box.
 *
 * User: "why is it so plain?" — it was a single untextured `BoxGeometry` in a
 * world that had just been given timber plates, posts and mortar lines, so it was
 * the least detailed object in the game AND the one you are asked to walk toward.
 *
 * Everything here is a lathed primitive merged into one group: a jamb and lintel
 * framing the opening, a leaf made of separate vertical planks with gaps between
 * them, two iron straps across, clavos (stud heads) along the straps, and a ring
 * handle. Nothing is textured — at the light levels in this maze what survives is
 * SILHOUETTE and the way the beam rakes across relief, which is exactly what the
 * atmosphere lane found for the walls (midFreqStd is made by edges, not by maps).
 *
 * Returns a Group whose origin is on the FLOOR at the wall plane, with its local
 * +Z pointing out of the wall into the corridor, so the caller only has to set a
 * position and a yaw.
 *
 * ---------------------------------------------------------------------------
 * THE LEAF IS A SEPARATE PIVOT, AND THAT IS THE WHOLE REASON THIS IS A GROUP
 * ---------------------------------------------------------------------------
 * Everything used to be added flat onto one group, which is fine for a door that
 * never moves and useless for one that opens. A door opens by ROTATING ABOUT ITS
 * HINGE EDGE, not by sliding and not by spinning about its centre — and the hinge
 * edge here is the -X side (the knuckles below sit at `-W/2`, the ring handle at
 * `+W*0.30`, so the geometry already committed to that handedness).
 *
 * So the frame — the two posts and the lintel, the parts that belong to the WALL —
 * stays on `g`, and everything that belongs to the moving LEAF (backing board,
 * planks, beads, straps, studs, ring, plate, hinge leaves and knuckles, keyhole)
 * goes onto a child `leaf` group whose origin is on the hinge line. Setting
 * `leaf.rotation.y` then swings the door exactly as a real one does: the handle
 * edge sweeps a 2.3m arc into the corridor while the hinge edge stays pinned.
 *
 * The pivot is published as `group.userData.leaf` so the transition sequence can
 * find it without re-walking the child list and guessing which meshes move.
 */
function buildDoorMesh(cellSize: number, maps?: WorldBuild['wallMaps'] | null): THREE.Group {
  const g = new THREE.Group();
  const d = CFG.door;

  // Hoisted above the materials, which need the door's real dimensions to solve
  // each face's texture repeat.
  const W = Math.min(d.width, cellSize - 0.6);   // never wider than the corridor
  const H = d.height;
  const T = d.leafThickness;

  /**
   * The swinging half. Positioned on the hinge line so a yaw about its own origin
   * is a hinge motion; every child below is authored in the ORIGINAL door-local
   * frame and then offset by `+W/2` on X to compensate, so none of the carefully
   * measured positions in this function had to be re-derived.
   */
  const leaf = new THREE.Group();
  leaf.name = 'doorLeaf';

  /**
   * TEXTURED timber, not a flat colour — and on the WALLS' OWN derived maps.
   *
   * User: "the door is too smooth looking". It was. Every wall in the maze
   * carries woodWall.png plus a `normalFromAlbedo` normal map and a
   * `roughnessFromAlbedo` roughness map; the door was the one large object in the
   * game rendering as flat `MeshStandardMaterial` colour. Against relief-mapped
   * masonry that reads exactly like a placeholder.
   *
   * The first fix here used the raw albedo as a BUMP map, which measured
   * midFreqStd 7.15 against the walls' 10-15 — better than a slab (< 3) and still
   * visibly the odd one out. A bump map derived on the fly from a colour texture
   * is a guess at relief; the walls already have the real thing computed, so this
   * borrows it via `WorldBuild.wallMaps` rather than approximating it. Same
   * grain, same grade, same lighting response — the door now belongs to the same
   * surface language as the stone it is set into.
   *
   * REPEAT. `BoxGeometry` UVs run 0..1 per FACE regardless of the face's size, so
   * a repeat that suits the 2.4m backing board tiles a 0.3m plank eight times
   * over. Every piece therefore gets its own material clone with the repeat
   * solved from its own dimensions against one world-space density
   * (`CFG.door.texMetresPerTile`), which is what keeps the grain the same
   * physical size across the whole door — and close to the walls' own 1.18 m
   * tile, so the eye reads one material rather than two.
   */
  const baseAlbedo = maps?.albedo ?? null;
  const timberCache = new Map<string, THREE.MeshStandardMaterial>();
  const tile = d.texMetresPerTile;

  /** A timber material whose grain is `tile` metres per repeat on a `w` x `h` face. */
  const timberFor = (w: number, h: number): THREE.MeshStandardMaterial => {
    // Quantised, so the near-identical planks share one material and one program
    // instead of minting twenty.
    const key = `${Math.round((w / tile) * 8)}x${Math.round((h / tile) * 8)}`;
    const hit = timberCache.get(key);
    if (hit) return hit;

    const ru = Math.max(0.25, w / tile);
    const rv = Math.max(0.25, h / tile);
    const clone = (t: THREE.Texture | null | undefined, srgb: boolean) => {
      if (!t) return null;
      const c = t.clone();
      c.needsUpdate = true;
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(ru, rv);
      // Only the colour map is sRGB; normal and roughness are data, and tagging
      // them sRGB would gamma-decode values that were never gamma-encoded.
      if (srgb) c.colorSpace = THREE.SRGBColorSpace;
      return c;
    };
    const mat = new THREE.MeshStandardMaterial({
      color: d.timberColor,
      map: clone(baseAlbedo, true),
      normalMap: clone(maps?.normal, false),
      normalScale: new THREE.Vector2(d.normalScale, d.normalScale),
      roughnessMap: clone(maps?.roughness, false),
      roughness: d.roughness,
      metalness: 0.0,
    });
    timberCache.set(key, mat);
    return mat;
  };

  const iron = new THREE.MeshStandardMaterial({
    color: d.ironColor, roughness: 0.62, metalness: 0.55,
  });
  // Sits behind the planks and inside every gap. Relief only reads if the space
  // between the raised parts is genuinely darker than they are.
  const recess = new THREE.MeshStandardMaterial({
    color: d.recessColor, roughness: 1.0, metalness: 0.0,
  });

  // Put the pivot ON the hinge line, then shift the leaf's contents back by the
  // same amount so every child keeps the coordinates it was authored with.
  leaf.position.x = -W / 2;
  const LX = W / 2;   // add to every child's X to undo the pivot offset
  g.add(leaf);

  // --- frame: two posts and a lintel, standing proud of the wall ---------
  const postGeo = new THREE.BoxGeometry(d.frameWidth, H + d.frameWidth, d.frameDepth);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, timberFor(d.frameWidth, H + d.frameWidth));
    post.name = 'doorPost';
    post.position.set(sx * (W / 2 + d.frameWidth / 2), (H + d.frameWidth) / 2, d.frameDepth / 2);
    g.add(post);
  }
  const lintel = new THREE.Mesh(
    new THREE.BoxGeometry(W + d.frameWidth * 2, d.frameWidth, d.frameDepth),
    timberFor(W + d.frameWidth * 2, d.frameWidth),
  );
  lintel.name = 'doorLintel';
  lintel.position.set(0, H + d.frameWidth / 2, d.frameDepth / 2);
  g.add(lintel);

  // --- backing board: the dark plane the planks stand off from -----------
  // Without it you see straight through the plank gaps to the corridor beyond,
  // and the gaps read as slots rather than as shadow.
  const backing = new THREE.Mesh(new THREE.BoxGeometry(W, H, T * 0.5), recess);
  backing.name = 'doorBacking';
  backing.position.set(LX + 0, H / 2, T * 0.25);
  leaf.add(backing);

  /**
   * The leaf: separate planks with real relief.
   *
   * The first version was flat rectangles of one colour and read as cardboard.
   * Three changes, all about giving the moving beam an edge to find:
   *
   *  - plank WIDTHS vary. Equal boards are a factory product; uneven ones are a
   *    made object, and the irregular rhythm is what stops seven rectangles
   *    scanning as a grid.
   *  - each plank gets a thin CHAMFER strip along its face, slightly proud and
   *    slightly darker at the edges, so the silhouette of every board is picked
   *    out individually when the torch crosses it.
   *  - depth alternates more than before (8mm -> 18mm), because at this light
   *    level a 8mm step produced no measurable shading difference at all.
   */
  const planks = d.plankCount;
  const gap = 0.018;
  // Deterministic jitter, so a given maze always builds the same door.
  const jitter = mulberry32(0x5eed);
  const widths: number[] = [];
  let wsum = 0;
  for (let i = 0; i < planks; i++) { const w = 0.75 + jitter() * 0.5; widths.push(w); wsum += w; }
  const usable = W - gap * (planks - 1);
  let cursor = -W / 2;
  for (let i = 0; i < planks; i++) {
    const pw = (widths[i] / wsum) * usable;
    const jut = (i % 2 === 0 ? 1 : -1) * 0.018 + (jitter() - 0.5) * 0.006;
    const depth = T + jut;
    const plank = new THREE.Mesh(new THREE.BoxGeometry(pw, H - 0.05, depth), timberFor(pw, H - 0.05));
    plank.position.set(LX + cursor + pw / 2, H / 2, T * 0.5 + depth / 2);
    plank.name = 'doorPlank';
    plank.castShadow = true;
    leaf.add(plank);

    // A raised bead down the centre of each board. One more edge per plank, and
    // it is what makes the beam sweep read as travelling ACROSS boards.
    const bead = new THREE.Mesh(
      new THREE.BoxGeometry(pw * 0.18, H - 0.5, 0.012), timberFor(pw * 0.18, H - 0.5),
    );
    bead.position.set(LX + cursor + pw / 2, H / 2, T * 0.5 + depth + 0.006);
    leaf.add(bead);

    cursor += pw + gap;
  }

  // --- two iron straps, with stud heads ---------------------------------
  for (const hy of [H * 0.24, H * 0.76]) {
    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.98, d.strapHeight, T * 0.55), iron,
    );
    strap.position.set(LX + 0, hy, T + T * 0.24);
    leaf.add(strap);
    const studs = 5;
    for (let i = 0; i < studs; i++) {
      const stud = new THREE.Mesh(new THREE.SphereGeometry(d.studRadius, 6, 5), iron);
      stud.position.set(
        LX + -W / 2 + W * 0.09 + i * ((W * 0.82) / (studs - 1)),
        hy,
        T + T * 0.24 + d.studRadius * 0.7,
      );
      leaf.add(stud);
    }
  }

  // --- ring handle, off-centre like a real latch side -------------------
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(d.handleRadius, d.handleRadius * 0.22, 6, 14), iron,
  );
  ring.position.set(LX + W * 0.30, H * 0.48, T + d.handleRadius * 0.35);
  ring.rotation.x = Math.PI / 2.1;
  leaf.add(ring);

  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(d.handleRadius * 1.5, d.handleRadius * 2.2, T * 0.4), iron,
  );
  plate.position.set(LX + W * 0.30, H * 0.48 + d.handleRadius * 0.9, T + T * 0.2);
  leaf.add(plate);

  /**
   * Hinges on the far side, and a lock plate under the ring.
   *
   * A door with no hinges is a panel. These are the details the eye uses to
   * classify the object before it has consciously read anything else, and they
   * cost three boxes each. They go on the opposite edge from the handle, which is
   * where a hinge actually lives — getting that backwards is the kind of thing
   * that reads as wrong without the player being able to say why.
   */
  for (const hy of [H * 0.18, H * 0.82]) {
    // Renamed from `leaf` — that identifier is now the swinging pivot group, and
    // shadowing it here would silently add the hinge plates to the wrong parent.
    const hingePlate = new THREE.Mesh(new THREE.BoxGeometry(W * 0.26, d.strapHeight * 0.85, T * 0.5), iron);
    hingePlate.position.set(LX + -W / 2 + W * 0.13, hy, T + T * 0.22);
    leaf.add(hingePlate);
    // The knuckle: a short vertical barrel at the frame edge. This one belongs to
    // the FRAME, not the leaf — a real knuckle stays with the jamb while the plate
    // swings away from it, and keeping it on `g` is what makes the open door read
    // as hinged rather than as a panel that detached itself.
    const knuckle = new THREE.Mesh(
      new THREE.CylinderGeometry(d.strapHeight * 0.36, d.strapHeight * 0.36, d.strapHeight * 1.5, 8), iron,
    );
    knuckle.position.set(-W / 2 + 0.02, hy, T + T * 0.22);
    g.add(knuckle);
  }

  // Keyhole escutcheon, and the dark slot in it — a small black hole at eye-line
  // height is a surprisingly strong "this is a door" signal.
  const esc = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.19, T * 0.4), iron);
  esc.position.set(LX + W * 0.30, H * 0.40, T + T * 0.2);
  leaf.add(esc);
  const keyhole = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.07, T * 0.5), recess);
  keyhole.position.set(LX + W * 0.30, H * 0.40, T + T * 0.3);
  leaf.add(keyhole);

  /**
   * THE VOID BEHIND THE DOOR.
   *
   * User: "when it opened there should've been some sort of void behind it, not
   * another wall." Correct — the door sits flush IN a wall, so swinging the leaf
   * revealed the masonry directly behind it and the exit read as a cupboard.
   *
   * An unlit black panel filling the opening, just behind the leaf. Hidden by the
   * leaf while shut; it is what you see through the doorway once it swings.
   * `MeshBasicMaterial` with `fog: false` deliberately — it must not take the
   * torch, must not take the red fill, and must not drift toward the fog colour
   * with distance. Nothing about it responds to anything, which is what makes it
   * read as absence rather than as a dark surface.
   */
  const voidPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.06, H * 1.02),
    new THREE.MeshBasicMaterial({ color: 0x000000, fog: false, side: THREE.DoubleSide }),
  );
  /**
   * Parented to the GROUP, not the leaf — attached to the leaf it would swing away
   * with the door and take the void with it, which is precisely backwards: the
   * hole must stay in the doorway while the door moves out of the way of it.
   *
   * And it sits in FRONT of the door's origin plane (+Z, the side the player is
   * on), which looks wrong for a "void behind the door" and is not. `findDoorWall`
   * insets the door into the cell by exactly `wallThickness / 2`, which puts the
   * masonry's near face at door-local z = 0. The first version of this panel was
   * at z = -0.06 — six centimetres INSIDE the wall — so the wall face occluded it
   * and the opening still showed lit brick. Measured, not guessed: the doorway
   * region went 73 -> 143 mean luminance when the leaf swung, i.e. opening the
   * door made the view BRIGHTER.
   *
   * At +voidDepth it is in front of the masonry and still behind the leaf's
   * backing board, which spans local z 0 .. T/2 = 0.07 and hides it completely
   * while the door is shut. Two centimetres of clearance on either side: far more
   * than depth precision needs, and far less than the backing board's thickness.
   */
  voidPanel.position.set(0, H / 2, CFG.door.voidDepth);
  voidPanel.name = 'doorVoid';
  g.add(voidPanel);

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  // The void casts and receives nothing; it is a hole, not a surface.
  voidPanel.castShadow = false;
  voidPanel.receiveShadow = false;
  // Published so the transition can swing the leaf without walking the child list
  // and guessing. `doorway` is the clear opening width, used to decide how far the
  // scripted walk-through has to travel to be genuinely past the plane of the door.
  g.userData.leaf = leaf;
  g.userData.doorway = W;
  return g;
}

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  private maze!: Maze;
  private world!: WorldBuild;
  private post: PostChain | null = null;
  private player!: Player;
  private monster!: Monster;
  private audio = new AudioEngine();

  private flashlight!: THREE.SpotLight;
  private flashTarget = new THREE.Object3D();
  private flickerValue = 1;
  private flickerPhase = 0;
  /**
   * Whether anything solid stands between the player and the monster, as of the
   * last simulation step. Written by `updatePlay`, read by `updateFlashlight`.
   */
  private lastLineOfSight = false;
  /**
   * The sightline-damped proximity pressure, as used by the flashlight flicker.
   * Written by `updateFlashlight`, read by the post chain in the same frame so the
   * light and the picture always react to one number rather than two.
   */
  private dreadPressure = 0;

  private gems: THREE.Mesh[] = [];
  /** Per-gem shader uniform blocks, ticked once per frame from updateGems. */
  private gemUniforms: { uTime: { value: number } }[] = [];
  /**
   * Gem point lights, parented to the SCENE and never removed — dimmed to zero on
   * collection. Changing the scene's light count forces three.js to recompile every
   * material, which is what made the first gem pickup hitch.
   */
  private gemLights: THREE.PointLight[] = [];
  /** Parallel to `gems`: the scene-level distance halo for each one. */
  private gemHalos: THREE.Sprite[] = [];
  /** The door's beacon. Faint while locked, blooms when the last gem lands. */
  private doorHalo: THREE.Sprite | null = null;
  /** The column of light over the exit. See the sky-beacon note in `placeGemsAndDoor`. */
  private doorBeacon: THREE.Group | null = null;
  private doorLight: THREE.PointLight | null = null;
  private gemsCollected = 0;
  /** The exit. A Group now — it is built as carpentry, not a single box. */
  private door: THREE.Object3D | null = null;
  private doorUnlocked = false;
  private gateePlayed = false;

  private keys = new Set<string>();
  private phase: GamePhase = 'loading';
  private events: GameEvents;
  private frames = 0;
  private fpsT0 = 0;
  private running = false;
  private seed: number;

  // ---- the loop ------------------------------------------------------------
  /**
   * How many mazes deep the player is, 1-based. The first maze is depth 1; the
   * first time they walk through the door they arrive at depth 2.
   *
   * This is the number that makes the loop land. The second maze is a joke — "oh,
   * very funny" — and the fifth is dread, because by then the counter is the only
   * thing in the game that has been keeping score of how long this has been going
   * on. It is shown on the HUD (small, next to the gem tally) and large on the
   * transition card.
   */
  private depth = 1;
  private loopStage: LoopStage = 'idle';
  /** Seconds elapsed inside the current beat. Real frame time, not sim time. */
  private loopT = 0;
  /** 0 clear .. 1 black. Owned here, drawn by React. */
  private loopFade = 0;
  /**
   * The scripted walk-through, captured at the instant it starts so the move is a
   * pure interpolation and cannot be perturbed by anything else writing the
   * player transform mid-sequence.
   */
  private loopWalk: {
    fromX: number; fromZ: number; toX: number; toZ: number;
    fromYaw: number; toYaw: number; fromPitch: number;
  } | null = null;
  /** The wall texture, held from load() so a rebuilt world can reuse it. */
  private wallTex: THREE.Texture | null = null;
  /**
   * The door on the FAR side of a transition: built at the new maze's spawn, shut
   * behind the player, then disposed. Distinct from `this.door`, which is always
   * the *exit* the player is looking for.
   */
  private arrivalDoor: THREE.Group | null = null;
  /** The wall the player spawns with their back to; the arrival door sits in it. */
  private spawnWall: { pos: [number, number]; yaw: number } | null = null;
  /**
   * Exit door placement, solved from the maze alone at world-build time so the
   * carpentry can be told to keep clear of it. `placeGemsAndDoor` consumes this
   * rather than recomputing, so the hole in the trim and the door cannot drift
   * apart — which they would silently do if two call sites each did the maths.
   */
  private doorSpot: { pos: [number, number]; yaw: number; cell: [number, number] } | null = null;
  /** Spawn placement, cached for the same reason. */
  private spawnAnchor: { pos: [number, number]; yaw: number; wall: { pos: [number, number]; yaw: number } | null } | null = null;

  constructor(private canvas: HTMLCanvasElement, events: GameEvents, seed = Date.now() & 0xffff) {
    this.events = events;
    this.seed = seed;

    // Before the renderer, and so before any material can compile: this rewrites
    // a three ShaderChunk, and a material that compiled first would keep the
    // unpatched falloff and blow its highlights while its neighbours did not.
    installNearFieldFloor(CFG.flashlight.nearFloor, CFG.flashlight.nearFloorPower);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CFG.render.exposure;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(74, 1, 0.05, 500);
    this.onResize();
  }

  // ---- lifecycle -----------------------------------------------------------

  async load() {
    this.setPhase('loading');
    const texLoader = new THREE.TextureLoader();

    this.events.onLoadProgress(0.05, 'Opening the maze');
    // HELD, because every loop rebuilds the world from it. This is the one asset
    // in the build that would otherwise be re-fetched and re-decoded per maze —
    // and re-decoding it would also re-run `gradeAlbedo`, which is a full-image
    // CPU pass, in the middle of a transition the player is watching.
    this.wallTex = await texLoader.loadAsync(`${ASSETS}textures/woodWall.png`);

    this.buildMazeAndWorld(this.seed, CFG.maze.cols, CFG.maze.rows);
    this.scene.fog = new THREE.FogExp2(CFG.render.fogColor, CFG.render.fogDensity);

    this.events.onLoadProgress(0.3, 'Lighting the dark');
    this.setupLighting();

    this.player = new Player(this.camera);
    this.scene.add(this.player.yawObject);
    this.player.onFootstep = (left) => this.audio.footstep(left);

    // The loading labels are the first authored prose the player reads, and they
    // are the cheapest place in the whole game to establish who they are. "Waking
    // the child" said what was being loaded; this says what the child is wearing.
    this.events.onLoadProgress(0.45, 'Winding your flesh onto the boy');
    this.monster = new Monster(this.maze);
    try {
      await this.monster.load(`${ASSETS}models/billy.glb`);
    } catch (err) {
      // The model is a hard requirement; if it is missing the build is broken and
      // must say so loudly rather than quietly running an empty maze.
      console.error('[game] FAILED to load billy.glb — the monster will be absent:', err);
      (window as any).__ASSET_ERROR__ = String(err);
    }
    this.scene.add(this.monster.group);
    // Perf bisection switch for the capture harness. `?nomonster=1` drops him from
    // the scene graph entirely, which is how the renderer's triangle count gets
    // attributed between the maze and the 150k-triangle character.
    if (new URLSearchParams(location.search).has('nomonster')) this.monster.group.visible = false;

    this.events.onLoadProgress(0.75, 'Scattering what he took');
    this.placeGemsAndDoor();

    this.events.onLoadProgress(0.82, 'Dirtying the lens');
    // Built last, once every mesh exists: the elevation-fog patch walks the scene
    // and rewrites each fogged material's shader, so anything added after this
    // call keeps three's flat fog. Nothing is added after this call.
    applyElevationFog(this.scene);
    this.post = buildPost(this.renderer, this.scene, this.camera, CFG.render.post);
    this.onResize();

    this.events.onLoadProgress(0.85, 'Tuning the silence');
    await this.audio.load(`${ASSETS}audio/`, (done, total) => {
      this.events.onLoadProgress(0.85 + 0.15 * (done / total), 'Tuning the silence');
    });

    this.events.onLoadProgress(0.97, 'Developing the photographs');
    await preloadImages([
      `${ASSETS}images/billyScare.png`,
      `${ASSETS}images/son.png`,
      // The menu's eye. Not strictly a mid-game stall like the scare, but it is
      // the first thing the player sees and a blank menu reads as a broken build.
      `${ASSETS}images/sonEye.png`,
    ]);

    this.events.onLoadProgress(1, 'Ready');
    this.setPhase('menu');
    (window as any).__READY__ = true;
  }

  /**
   * Build a maze and its geometry, and put both in the scene.
   *
   * Factored out of `load()` because the loop calls it again for every new maze.
   * It deliberately does NOT place gems, the door or the monster — those depend
   * on the player's spawn and are done by `placeGemsAndDoor()`, which the caller
   * runs next. Splitting them is what lets the transition rebuild the world while
   * the screen is black and then place everything with the fresh maze in hand.
   *
   * The caller owns disposal of whatever was there before; see `disposeWorld()`.
   */
  private buildMazeAndWorld(seed: number, cols: number, rows: number) {
    this.maze = new Maze(cols, rows, CFG.maze.cell, seed, CFG.maze.braid);
    // `braid: 1.0` is carried straight through from CFG — the maze must stay
    // fully braided with ZERO dead ends on every loop, not just the first. A
    // regenerated maze that quietly used a different braid would reintroduce the
    // dead ends the user already reported once, and only from loop 2 onward,
    // which is exactly the kind of bug nobody reproduces.
    /**
     * The doorways have to be known BEFORE the carpentry is built, because the
     * carpentry has to leave them alone. See the `push()` exclusion note in
     * `buildTrim`: trim plates stand proud of the wall face into the corridor, so
     * without this a plate runs straight across the exit and opening the door
     * shows a lit beam where the void should be.
     *
     * Both doorways qualify — the exit, and the arrival door that shuts behind
     * you on the next maze. Both are pure functions of the maze, so both can be
     * solved here, before a single triangle of world exists.
     */
    this.doorSpot = this.computeDoorSpot();
    this.spawnAnchor = this.findSpawnAnchor();
    const clearance = CFG.door.trimClearance;
    const keepClear = [this.doorSpot?.pos, this.spawnAnchor?.wall?.pos]
      .filter((p): p is [number, number] => !!p)
      .map(([x, z]) => ({
        x, z,
        halfX: clearance.halfWidth, halfZ: clearance.halfWidth,
        maxY: CFG.door.height + clearance.headroom,
      }));
    this.world = buildWorld(this.maze, this.wallTex!, keepClear);
    this.scene.add(this.world.group, this.world.sky);
    // Any cache derived from the OLD maze is now a lie. Both of these are keyed
    // by cell index, and cell indices mean something different in a maze of a
    // different size — `corridorField` would be read at an out-of-range index and
    // `menuAnchor` would place the menu camera inside a wall.
    this.corridorField = null;
    this.corridorFieldCell = -1;
    this.menuAnchor = null;
  }

  /**
   * Release the current world's GPU resources.
   *
   * three.js does not garbage-collect geometries, materials or textures — they
   * live until something calls `.dispose()` on them, and a WebGLRenderer holds
   * them alive through its internal property caches regardless of whether any
   * JS reference remains. Ten loops leaking a merged ~900-quad wall mesh, a
   * floor, the trim, the sky and the dust each time is real memory and real
   * driver pressure, and it is invisible until it is not.
   *
   * The wall TEXTURE is deliberately exempt: it is owned by `this.wallTex` and
   * shared by every world we will ever build. Its derived maps (the graded
   * albedo, the normal and roughness derivations) are per-build and are disposed
   * here along with the materials that hold them.
   *
   * Verify with `renderer.info.memory` across several loops — if geometries or
   * textures climb per loop, something in here is not reaching a resource.
   */
  private disposeWorld(w: WorldBuild) {
    this.scene.remove(w.group, w.sky);

    const seenMat = new Set<THREE.Material>();
    const killMaterial = (m: THREE.Material) => {
      if (seenMat.has(m)) return;
      seenMat.add(m);
      // Every map slot a MeshStandardMaterial or a ShaderMaterial can hold. Each
      // is a GPU texture with its own allocation, and disposing the material does
      // NOT dispose them — three leaves that to the owner precisely because maps
      // are usually shared. Here they are not: `buildWorld` derives fresh graded
      // /normal/roughness maps per build, so every one of these is per-world.
      const mm = m as unknown as Record<string, unknown>;
      for (const slot of [
        'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap',
        'displacementMap', 'emissiveMap', 'alphaMap', 'envMap', 'lightMap',
        'specularMap', 'gradientMap',
      ]) {
        const t = mm[slot] as THREE.Texture | undefined;
        // Never dispose the shared source texture — it outlives every world.
        if (t && (t as THREE.Texture).isTexture && t !== this.wallTex) t.dispose();
      }
      // ShaderMaterials (the sky, the dust) can hold textures in uniforms too.
      const uniforms = (m as unknown as { uniforms?: Record<string, { value: unknown }> }).uniforms;
      if (uniforms) {
        for (const u of Object.values(uniforms)) {
          const v = u?.value as THREE.Texture | undefined;
          if (v && (v as THREE.Texture).isTexture && v !== this.wallTex) v.dispose();
        }
      }
      m.dispose();
    };

    for (const root of [w.group, w.sky as THREE.Object3D]) {
      root.traverse((o) => {
        const any = o as THREE.Mesh & THREE.Points;
        any.geometry?.dispose();
        const mat = any.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(killMaterial);
        else if (mat) killMaterial(mat);
      });
    }
  }

  /**
   * Release a door group. Same contract as `disposeWorld` and the same reason:
   * `buildDoorMesh` allocates fresh BoxGeometries, a torus, spheres and several
   * materials on every call, and the loop calls it twice per maze (the exit, and
   * the arrival door that shuts behind you).
   *
   * IT MUST DISPOSE THE MAPS TOO. This used to be safe to skip because the door
   * carried no textures at all — that was the "too smooth" bug. Now every timber
   * material owns three CLONES of the wall maps (its own repeat lives on the
   * texture, so they cannot be shared), and disposing a material does not touch
   * its maps: three leaves that to the owner, because maps are usually shared.
   * Caught by `tools/loop-test.mjs`, which watches renderer texture count across
   * loops and read 13 -> 16 -> 19 -> 22, exactly +3 per loop. Flat at 13 across
   * 4 loops after this.
   *
   * The wall maps THEMSELVES are guarded — they belong to the live `WorldBuild`
   * and `disposeWorld` releases them. Disposing a door must never take them with
   * it, or the next door built against the same world renders untextured.
   *
   * Worth knowing before anyone decides the per-face clones are extravagant:
   * `Texture.clone()` shares the `source`, and three refcounts GPU allocations
   * per source (`WebGLTextures.usedTimes`, freed only at zero). So N clones of
   * the wall albedo cost ONE upload, not N, and disposing a clone cannot pull the
   * texture out from under the walls. Verified by play, not just by reading: the
   * walls are still fully relief-mapped in `/tmp/loop_4.png` after four loops and
   * four door disposals. The `keep` set above is belt-and-braces on top of that.
   */
  private disposeDoor(door: THREE.Object3D | null) {
    if (!door) return;
    this.scene.remove(door);
    const keep = new Set<THREE.Texture>();
    const wm = this.world?.wallMaps;
    if (wm) {
      for (const t of [wm.albedo, wm.normal, wm.roughness]) if (t) keep.add(t);
    }
    if (this.wallTex) keep.add(this.wallTex);

    const seen = new Set<THREE.Material>();
    door.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      const kill = (m: THREE.Material) => {
        if (seen.has(m)) return;
        seen.add(m);
        const mm = m as unknown as Record<string, unknown>;
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'bumpMap', 'aoMap',
                            'metalnessMap', 'emissiveMap', 'alphaMap']) {
          const t = mm[slot] as THREE.Texture | undefined;
          if (t && t.isTexture && !keep.has(t)) t.dispose();
        }
        m.dispose();
      };
      if (Array.isArray(mat)) mat.forEach(kill);
      else if (mat) kill(mat);
    });
  }

  private setupLighting() {
    const ambient = new THREE.AmbientLight(CFG.render.ambientColor, CFG.render.ambientIntensity);
    this.scene.add(ambient);

    // Red light falling into the open corridors from the sky above. This is what
    // separates "dark" from "pitch black void with a torch in it": walls keep a
    // faint bloody rim, so the maze has shape even where the beam is not pointed.
    const sky = new THREE.HemisphereLight(
      CFG.render.hemiSky, CFG.render.hemiGround, CFG.render.hemiIntensity,
    );
    this.scene.add(sky);

    /**
     * Live fill-light knobs for the capture harness, matching __POST_TUNE__ in
     * post.ts.
     *
     * The fill is the hardest thing in the scene to set by reasoning, because it
     * is judged entirely by what it does to the parts of the frame the torch is
     * NOT pointing at — and those are precisely the parts you cannot see well
     * enough to judge on a monitor at a glance. A number is the only honest
     * instrument, and a number needs a sweep. These write to the real lights, so
     * whatever a sweep settles on is exactly what the committed default does.
     */
    (window as unknown as Record<string, unknown>).__LIGHT_TUNE__ = (o: {
      ambient?: number; hemi?: number;
      /** Hex colours, so an ablation can null a contributor's CHROMA without
       *  changing how much light it delivers. Intensity sweeps cannot answer
       *  "which light is painting the shadows red" — only a chroma swap can. */
      ambientColor?: number; hemiSky?: number; hemiGround?: number; fogColor?: number;
      /** FogExp2 density, for isolating how much of the dim band is fog at all. */
      fogDensity?: number;
      /** Beam cone geometry — see the note where these are applied. */
      beamAngle?: number; beamPenumbra?: number; beamIntensity?: number; beamDecay?: number;
    }) => {
      if (o.ambient !== undefined) ambient.intensity = o.ambient;
      if (o.hemi !== undefined) sky.intensity = o.hemi;
      if (o.ambientColor !== undefined) ambient.color.setHex(o.ambientColor);
      if (o.hemiSky !== undefined) sky.color.setHex(o.hemiSky);
      if (o.hemiGround !== undefined) sky.groundColor.setHex(o.hemiGround);
      const fog = this.scene.fog as THREE.FogExp2 | null;
      if (fog) {
        if (o.fogColor !== undefined) fog.color.setHex(o.fogColor);
        if (o.fogDensity !== undefined) fog.density = o.fogDensity;
      }
      // The beam CONE, which is the only lever that moves meanLum and
      // nearBlackFrac in the same direction. Every global curve knob trades one
      // against the other; a tighter, brighter pool raises the mean while leaving
      // MORE of the frame black, which is the actual shape of the reference.
      const fl = this.flashlight;
      if (fl) {
        if (o.beamAngle !== undefined) fl.angle = o.beamAngle;
        if (o.beamPenumbra !== undefined) fl.penumbra = o.beamPenumbra;
        if (o.beamIntensity !== undefined) fl.intensity = o.beamIntensity;
        if (o.beamDecay !== undefined) fl.decay = o.beamDecay;
      }
      return {
        ambient: ambient.intensity, hemi: sky.intensity,
        ambientColor: ambient.color.getHex(), hemiSky: sky.color.getHex(),
        hemiGround: sky.groundColor.getHex(),
        fogColor: fog ? fog.color.getHex() : null,
        fogDensity: fog ? fog.density : null,
        beamAngle: fl ? fl.angle : null, beamPenumbra: fl ? fl.penumbra : null,
        beamIntensity: fl ? fl.intensity : null, beamDecay: fl ? fl.decay : null,
      };
    };

    const f = CFG.flashlight;
    this.flashlight = new THREE.SpotLight(f.color, f.intensity, f.distance, f.angle, f.penumbra, f.decay);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(CFG.render.shadowMapSize, CFG.render.shadowMapSize);
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.camera.far = f.distance;
    this.flashlight.shadow.bias = -0.0012;
    this.flashlight.shadow.normalBias = 0.03;
    this.scene.add(this.flashlight, this.flashlight.target, this.flashTarget);
  }

  /**
   * Tear the collectibles down between mazes.
   *
   * ---------------------------------------------------------------------------
   * THE LIGHT COUNT MUST NOT CHANGE, AND THIS IS THE ONLY DELICATE PART
   * ---------------------------------------------------------------------------
   * three.js rebuilds every material's shader program whenever the number of
   * lights in the scene changes. That is the bug behind the user's original
   * report — "the game lags for a moment when you collect a gem for the first
   * time" — and it was fixed by parenting the gem lights to the scene and DIMMING
   * them rather than removing them.
   *
   * A naive regeneration would violate that spectacularly: it would remove seven
   * point lights and a door light, then add eight fresh ones, forcing a full
   * recompile of every material in a brand-new maze — i.e. the single worst
   * moment in the run to do it, because the player is about to be shown that maze
   * and every shader permutation would compile on the first frame they see.
   *
   * So the lights are RECYCLED, not recreated. `CFG.loop.gemCount` is fixed at 7
   * for exactly this reason, so the pool always matches demand: this function
   * keeps the existing PointLight objects in `gemLights` and merely repositions
   * and re-levels them in `placeGemsAndDoor`. Same for `doorLight`. Only the
   * meshes, sprites and their geometry/materials are disposed.
   *
   * Measured consequence: `renderer.info.programs.length` is flat across loops
   * and there is no compile stall on the first frame of a new maze.
   */
  private disposeCollectibles() {
    /**
     * All seven gems SHARE one `IcosahedronGeometry` (see `placeGemsAndDoor`),
     * so it is disposed once via this set rather than seven times. three.js
     * tolerates the repeat — `dispose()` only dispatches an event — but relying
     * on that is relying on an implementation detail, and a set states the
     * intent. The MATERIALS are genuinely per-gem: each carries its own
     * `onBeforeCompile` patch and its own `uSeed`, which is why seven gems do not
     * writhe in unison.
     */
    const geos = new Set<THREE.BufferGeometry>();
    for (const gem of this.gems) {
      this.scene.remove(gem);
      geos.add(gem.geometry);
      (gem.material as THREE.Material).dispose();
    }
    geos.forEach((g) => g.dispose());
    for (const halo of this.gemHalos) {
      this.scene.remove(halo);
      // The halo TEXTURE is `this.haloTex`, built once and shared by every halo
      // and by the door beacon. Disposing it here would blank the beacons of the
      // maze we are about to build; it is released in `dispose()` and nowhere else.
      (halo.material as THREE.SpriteMaterial).dispose();
    }
    if (this.doorBeacon) {
      this.scene.remove(this.doorBeacon);
      for (const c of this.doorBeacon.children) {
        const m = c as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material)?.dispose();
      }
      this.doorBeacon = null;
    }
    if (this.doorHalo) {
      this.scene.remove(this.doorHalo);
      (this.doorHalo.material as THREE.SpriteMaterial).dispose();
      this.doorHalo = null;
    }
    this.disposeDoor(this.door);
    this.door = null;

    this.gems = [];
    this.gemHalos = [];
    this.gemUniforms = [];
    this.gemsCollected = 0;
    this.doorUnlocked = false;
    this.gateePlayed = false;
    // `gemLights` and `doorLight` are NOT cleared and NOT removed. See above.
  }

  /**
   * Gems go far from spawn and far from each other, using a BFS distance field so
   * "far" means corridor distance, not straight-line distance through six walls.
   * The door goes at the deepest point in the maze.
   */
  private placeGemsAndDoor() {
    const spawnField = this.maze.distanceField(1, 1);
    const [sx, sz] = this.maze.cellToWorld(1, 1);
    this.player.position.set(sx, 0, sz);

    // Monster starts as far from you as the maze allows.
    let deepest = 0, deepestIdx = 0;
    spawnField.forEach((d, i) => { if (d > deepest) { deepest = d; deepestIdx = i; } });
    let doorX = deepestIdx % this.maze.cols, doorY = (deepestIdx / this.maze.cols) | 0;

    // A flat floor of 5 cells let some seeds drop a gem 7 cells from spawn — you
    // pick it up in the first fifteen seconds and it does no routing work. Scaling
    // the floor with the maze's own depth lifts the shallowest gem from an average
    // of 17 cells (worst case 7) to an average of 37 (worst case 21), and still
    // places all 7 gems on every one of 40 measured seeds, so it cannot soft-lock
    // the door. Measured with tools/mazelab/gems.mjs.
    const floor = Math.max(5, Math.round(deepest * CFG.gems.minSpawnDepthFraction));
    const candidates: number[] = [];
    spawnField.forEach((d, i) => { if (d > floor) candidates.push(i); });

    const chosen: number[] = [];
    const minSep = CFG.gems.minSeparationCells;
    /**
     * Fisher-Yates over a seeded stream. The previous line was
     * `candidates.sort(() => Math.random() - 0.5)`, which is not a shuffle: a
     * comparator returning a random sign is inconsistent, so the result depends on
     * the sort algorithm and is measurably biased toward leaving elements where
     * they started. It also read Math.random(), so gem layout ignored the seed
     * entirely and the same seed did not reproduce a level.
     */
    const gemRng = mulberry32(this.seed ^ 0x9e3779b9);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = (gemRng() * (i + 1)) | 0;
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    /**
     * How many gems this run needs, overridable from the URL: `?gems=1`.
     *
     * Requested so the door mechanics can be exercised without a full seven-gem
     * playthrough first. It is a DEV AFFORDANCE, not a difficulty setting: the
     * shipped default is untouched, and it changes only how many are placed —
     * placement policy, separation, unlock and the win path all run exactly as
     * they do normally, so what you test is the real mechanism.
     *
     * Clamped to 1..CFG.gems.count. Zero would unlock the door before the player
     * had taken a step, which is not a state the rest of the game expects.
     */
    const gemParam = Number(new URLSearchParams(location.search).get('gems'));
    const wantGems = Number.isFinite(gemParam) && gemParam > 0
      ? Math.min(Math.max(1, Math.round(gemParam)), CFG.gems.count)
      : CFG.gems.count;
    if (wantGems !== CFG.gems.count) {
      console.info(`[game] gem count overridden from URL: ${wantGems} (default ${CFG.gems.count})`);
    }

    /**
     * `?gems=1` IS THE DOOR RIG: gem beside you, exit beside the gem.
     *
     * User: "for testing I want the 1 gem level to have the gem next to me and
     * the door next to it." Placing one gem at the normal depth still buried it
     * ~37 cells away, so exercising a door change cost a full search of the maze
     * every time — which is how the "I couldn't find it anywhere" round happened.
     *
     * Scoped to EXACTLY `?gems=1`, not to any override: `?gems=3` still places
     * three gems by the real policy, so the only URL that changes layout is the
     * one asked for. The normal build is untouched — this branch cannot run
     * without the parameter.
     *
     * Everything downstream still runs for real. The gem is a real gem on a real
     * carved cell, the door still goes through `findDoorWall` and lands flush in
     * a wall face, the unlock still needs the pickup. Only the WHERE is shortened.
     */
    const devDoorRig = gemParam === 1;
    if (devDoorRig) {
      const rig = this.devRigCells();
      if (rig) {
        chosen.push(rig.gem[1] * this.maze.cols + rig.gem[0]);
        [doorX, doorY] = rig.door;
        console.info(`[game] ?gems=1 door rig: gem at ${rig.gem}, door at ${rig.door}`);
      }
    }

    for (const i of candidates) {
      if (devDoorRig && chosen.length) break;
      if (chosen.length >= wantGems) break;
      const cx = i % this.maze.cols, cy = (i / this.maze.cols) | 0;
      if (i === deepestIdx) continue;
      const ok = chosen.every((j) => {
        const jx = j % this.maze.cols, jy = (j / this.maze.cols) | 0;
        return Math.abs(jx - cx) + Math.abs(jy - cy) >= minSep;
      });
      if (ok) chosen.push(i);
    }

    const g = CFG.gems;
    /**
     * Not a crystal — a writhing orb.
     *
     * User note: "the gems look too regular, make them closer to orbs that keep
     * twitching and changing forms in their place in a menacing way like
     * Terminator's metal liquid enemy."
     *
     * An octahedron is the most regular thing in the scene: eight identical faces
     * that read as *manufactured*, which is exactly wrong for a purgatory made of
     * a spell. A sphere subdivided enough to deform smoothly, displaced along its
     * normals by layered noise, gives a mass that is never the same shape twice.
     *
     * 3 subdivisions = 1280 triangles per gem, 7 gems = ~9k. Against Billy's 150k
     * that is nothing, and the deformation happens on the GPU in the vertex shader
     * so the CPU cost per frame is one uniform write.
     */
    const gemGeo = new THREE.IcosahedronGeometry(g.size, 3);
    /**
     * Which slot in the recycled light pool this gem takes. See
     * `disposeCollectibles`: the PointLights survive between mazes so the scene's
     * light count never changes, which is what keeps a regeneration from
     * recompiling every shader in the game.
     */
    let slot = 0;
    for (const i of chosen) {
      const cx = i % this.maze.cols, cy = (i / this.maze.cols) | 0;
      const [wx, wz] = this.maze.cellToWorld(cx, cy);
      /**
       * A lit pale-blue body plus a bright emissive used to clip to a flat white
       * card the moment the flashlight touched it — no facets, no read as a solid.
       * A crystal reads as a crystal when the BODY is dark and only the emissive
       * carries the colour: the octahedron's facets then differ from one another
       * (each catches the beam at its own angle) and the glow is left to bloom
       * rather than being painted on. Metalness 0 keeps the facets from mirroring
       * the near-black surroundings into invisibility.
       */
      const mat = new THREE.MeshStandardMaterial({
        color: g.bodyColor,
        emissive: g.emissiveColor,
        emissiveIntensity: g.emissiveIntensity,
        // Wet and liquid rather than faceted. Low roughness with some metalness
        // gives the rolling specular that reads as mercury sliding over itself;
        // it needs a light to catch, which its own point light provides.
        roughness: 0.14,
        metalness: 0.55,
      });
      this.makeGemLiquid(mat, i);
      const gem = new THREE.Mesh(gemGeo, mat);
      gem.position.set(wx, g.height, wz);
      gem.castShadow = false;
      // A tiny light so a gem is findable from down the corridor — the only friendly
      // light in the game, and the reason you keep moving.
      // Candela, like the flashlight — see the note in config.
      /**
       * The light is parented to the SCENE, not to the gem, and it is never
       * removed — only dimmed to zero when the gem is taken.
       *
       * Hiding a gem used to hide its child light with it, and three.js rebuilds
       * every material's shader program whenever the number of lights in the scene
       * changes. So the first gem you collected triggered a full recompile of every
       * material in the maze, mid-play. That was the user's report: "the game lags
       * for a moment when you collect a gem for the first time."
       *
       * Keeping the light present with `intensity = 0` holds the light count
       * constant for the whole session, so no collection can ever cost a recompile.
       */
      /**
       * RECYCLED across mazes, not recreated. On the first build the pool is
       * empty and a light is made; on every subsequent maze the existing light is
       * repositioned and re-levelled, so the scene's light count is identical
       * before and after a regeneration and no material is recompiled.
       *
       * The re-level is not optional: by the time a loop runs, all seven of these
       * have been dimmed to `intensity = 0` by the collections that unlocked the
       * door. Reusing one without restoring `glowIntensity` would place a gem in
       * the new maze with a dead light — visible as a gem that has a halo and a
       * body but casts no pool on the floor, which is precisely the "I couldn't
       * find a gem" failure mode.
       */
      let glow = this.gemLights[slot];
      if (!glow) {
        glow = new THREE.PointLight(g.glowColor, g.glowIntensity, g.glowDistance, 2);
        this.scene.add(glow);
        this.gemLights.push(glow);
      }
      glow.color.setHex(g.glowColor);
      glow.intensity = g.glowIntensity;
      glow.distance = g.glowDistance;
      glow.position.set(wx, g.height, wz);
      slot++;

      /**
       * A camera-facing halo, and the reason a gem is findable at 20 m at all.
       *
       * MEASURED PROBLEM. At 20 m the gem subtends only a few pixels, and the
       * point light's contribution has fallen off with the square of distance, so
       * the crystal and its pool of light both vanish into the wall: peak
       * luminance contrast against the timber behind it was 1.7-1.9x across
       * three seeds, which in the frame is nothing — the gem was invisible while
       * the maths said it was lit. Neither a brighter emissive nor a longer light
       * range fixes that, because both are fighting an object whose SCREEN AREA
       * has gone to almost zero.
       *
       * So the halo is a sprite whose world size is grown with distance (in
       * `updateGems`) to hold a floor on its apparent size. That is the same
       * trick a lens flare or a distant streetlight uses, and it is honest here:
       * a real small bright source in a dark corridor does scatter into a disc
       * larger than the source, because the air between you and it is full of the
       * dust and fog this scene already renders.
       *
       * AdditiveBlending with depthWrite off so it lifts whatever is behind it
       * instead of punching a hole in the wall, and `depthTest` left ON so a gem
       * around the corner does not glow through masonry — which would be a
       * cheat that broke the maze.
       */
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.gemHaloTexture(),
        color: g.glowColor,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        fog: false,
      }));
      halo.scale.setScalar(g.haloSize);
      /**
       * The halo is parented to the SCENE, not to the gem, and tracked to it in
       * `updateGems` instead.
       *
       * As a child it inherited the gem's own animation — the crystal spins on
       * two axes every frame — so the sprite's world scale and orientation were
       * being driven by that spin, and its measured scale wandered (0.75 at 11 m,
       * 1.41 at 20 m, 2.92 at 4 m) instead of following the distance law it is
       * supposed to obey. A halo is a property of where the gem IS, not of how it
       * is turning.
       */
      halo.position.set(wx, g.height, wz);
      this.scene.add(halo);
      this.gemHalos.push(halo);
      this.gems.push(gem);
      this.scene.add(gem);
    }

    /**
     * Dim any light in the pool this maze did not claim.
     *
     * The pool is kept at whatever size the FIRST maze needed, because removing a
     * light would change the scene's light count and recompile every material. If
     * a later maze places fewer gems, the surplus lights would otherwise still be
     * burning at their previous maze's coordinates — a pool of coloured light on
     * the floor of a corridor with no gem in it, which sends the player to a cell
     * that has nothing in it and is indistinguishable from a gem they cannot
     * reach. That is the exact complaint the gem audit exists for.
     *
     * In the shipped configuration this loop never has anything to do
     * (`CFG.loop.gemCount` is fixed at 7 for precisely this reason), but `?gems=N`
     * can produce it, and so could any future change to the count.
     */
    for (let i = slot; i < this.gemLights.length; i++) {
      this.gemLights[i].intensity = 0;
    }

    this.events.onGems(0, this.gems.length);

    /**
     * Put the door IN A WALL, not in the middle of the corridor.
     *
     * User: "why is it in the middle of the road?" — and they were right. It was
     * placed at `cellToWorld(doorX, doorY)`, the CENTRE of its cell, so it stood
     * as a free-floating slab you could walk around. A door in the middle of a
     * corridor is not a door; it is an obstacle, and it read as a bug because it
     * is one.
     *
     * So: find a face of the door's cell that is actually walled, and set the door
     * flush into that wall plane, facing into the cell. Perimeter walls are
     * preferred, because the exit leading OUT of the maze rather than into another
     * corridor is what the fiction wants — you are trying to leave.
     *
     * `maze.at()` reports walls as booleans per side, so a face is available
     * exactly when its flag is true. Fully braiding the maze (braid = 1.0) gave
     * every cell at least two openings, but a 4m cell still has four sides, so
     * there is normally at least one wall to hang a door on. If the deepest cell
     * somehow has none, walk back down the distance field until a cell does.
     */
    // Solved already, at world-build time, so the trim could be told to keep clear
    // of it. Recomputing here would risk the two disagreeing.
    const doorSpot = this.doorSpot ?? this.findDoorWall(doorX, doorY, spawnField);
    const [dx, dz] = doorSpot.pos;
    this.door = buildDoorMesh(CFG.maze.cell, this.world?.wallMaps ?? null);
    this.door.position.set(dx, 0, dz);
    this.door.rotation.y = doorSpot.yaw;
    this.scene.add(this.door);

    /**
     * The door gets the gems' aura, because without one it cannot be found.
     *
     * User: "give a similar one to the door cuz I couldn't find it anywhere."
     * They were right, and it was worse than an oversight — the door shipped with
     * `emissive: 0x000000`, so it was a near-black box against near-black walls in
     * a maze whose whole point is that you cannot see. The one object the game
     * asks you to walk to was the least visible thing in it.
     *
     * Same halo sprite and the same distance law as the gems, so it reads as part
     * of the same language, but in the door's own colour: gems are the wet red of
     * Billy's cords, and the way out is a colder, cleaner light that belongs to
     * nothing else here. `depthTest` stays ON, so it does not glow through
     * masonry — a beacon visible through walls would delete the maze.
     *
     * Two states, and the difference is the point:
     *  - LOCKED: a faint ember. Enough to notice from down a corridor and think
     *    "that is something", not enough to walk to before you have earned it.
     *  - UNLOCKED: it blooms. `unlockDoor()` raises both the halo and the light,
     *    so the moment the last gem lands the exit announces itself from range.
     */
    const dcfg = CFG.door;
    const doorHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.gemHaloTexture(),
      color: dcfg.glowColor,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    }));
    doorHalo.scale.setScalar(dcfg.haloSize);
    /**
     * PUSHED OFF THE WALL, and kept small.
     *
     * A Sprite is a camera-facing QUAD. The door is set flush into a wall face,
     * so a quad centred on the door lives half inside the masonry — and a plane
     * meeting a plane is a straight line, which is exactly the razor-edged
     * diagonal the user reported as "the light is still blocky over the door".
     * Depth-testing cuts the billboard along that line, so no amount of softness
     * in the halo's own texture can help: the hard edge is the intersection, not
     * the gradient.
     *
     * Attributed by measurement rather than by eye, toggling each candidate
     * against a NOISE FLOOR taken from two identical frames (film grain, torch
     * flicker and dust otherwise get blamed on whatever you switched):
     *
     *     noise floor          mean 0.33 on geometry
     *     beacon contributes   mean 0.50   <- at the floor; not it
     *     halo contributes     mean 2.17   <- 6.6x the floor
     *
     * So the halo comes forward into the corridor, off the wall plane, and goes
     * back to a size that reads as a lamp above a door rather than a sheet of
     * light across it. Finding the exit from RANGE is now the sky beacon's job —
     * it is a volume, it cannot be plane-cut, and it clears the roofline — while
     * up close the PointLight below does the work, because a light's falloff on
     * brick has no silhouette to slice.
     */
    const hy = this.door.rotation.y;
    doorHalo.position.set(
      dx + Math.sin(hy) * dcfg.haloStandoff,
      dcfg.haloHeight,
      dz + Math.cos(hy) * dcfg.haloStandoff,
    );
    (doorHalo.material as THREE.SpriteMaterial).opacity = dcfg.haloOpacityLocked;
    this.scene.add(doorHalo);
    this.doorHalo = doorHalo;

    /**
     * THE SKY BEACON.
     *
     * User: "The door needs a bigger aura as well cuz it's too difficult to find.
     * Maybe a beacon in the sky like the minecraft one."
     *
     * The halo above the lintel only helps once you are already in the right
     * corridor — walls block it, which is correct for a hint and useless for
     * orientation. This is the opposite: a column that rises clear of the maze,
     * so from anywhere with sky above you the exit has a bearing. It is the one
     * piece of information the maze deliberately gives you, and the fiction covers
     * it — the way out of a purgatory should be the thing you can see and not
     * reach.
     *
     * Built as a tall cylinder with an additive, depth-tested-but-not-written
     * shell. Two nested shells rather than one: a tight bright core and a wider
     * soft one, which is what gives it a bloom edge instead of a hard tube. It
     * starts ABOVE head height so it never washes out the corridor you are
     * standing in, and it is `fog: false` so distance does not eat it — the whole
     * point is that it survives the fog the rest of the maze hides behind.
     */
    const beamGroup = new THREE.Group();
    beamGroup.name = 'doorBeacon';
    for (const shell of dcfg.beacon.shells) {
      const geo = new THREE.CylinderGeometry(
        shell.radius, shell.radius * dcfg.beacon.taper, dcfg.beacon.height,
        dcfg.beacon.segments, 1, true,
      );
      /**
       * WHY THIS IS A SHADER AND NOT A `MeshBasicMaterial`.
       *
       * User: "the light looks too blocky over the door". It was, and a plain
       * additive shell is guaranteed to be: an additive cylinder is BRIGHTEST AT
       * ITS SILHOUETTE, because at grazing incidence the ray crosses a long slice
       * of the surface and face-on it crosses almost none. So the rim blazes, the
       * middle reads hollow, and you get a hard bright outline around a papery
       * wedge — the exact opposite of a shaft of light, which is brightest where
       * you look through the MOST volume, i.e. down its middle.
       *
       * `abs(dot(N, V))` inverts that. It is ~1 looking straight into the tube's
       * near surface and ~0 at the rim, so the column now has a solid core that
       * dissolves at its edges. That also makes the segment count irrelevant to
       * the silhouette — the polygon boundary fades to zero alpha before it can
       * be seen — which was the other half of "blocky".
       *
       * `vFade` dissolves it into the sky instead of ending in a flat cut.
       *
       * Deliberately NOT using reserved GLSL ES 3.00 identifiers here (`sample`,
       * `filter`, `input`, `output`, `buffer`, `patch`): three logs a compile
       * failure for those and then carries on rendering nothing, which cost this
       * project three waves once already. See PROGRESS.md trap 11.
       */
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(dcfg.glowColor) },
          uStrength: { value: shell.opacity },
          uEdge: { value: shell.edge },
          uBaseFade: { value: dcfg.beacon.baseFade },
        },
        vertexShader: `
          varying vec3 vNrm;
          varying vec3 vDir;
          varying float vY;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vNrm = normalize(mat3(modelMatrix) * normal);
            vDir = normalize(cameraPosition - wp.xyz);
            vY = uv.y;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          uniform vec3 uColor;
          uniform float uStrength;
          uniform float uEdge;
          uniform float uBaseFade;
          varying vec3 vNrm;
          varying vec3 vDir;
          varying float vY;
          void main() {
            // Solid down the middle, transparent at the rim. See the note above.
            float core = pow(abs(dot(normalize(vNrm), normalize(vDir))), uEdge);
            // Dissolve into the sky rather than stopping...
            float vTop = 1.0 - smoothstep(0.05, 1.0, vY);
            // ...and ramp UP from nothing at the base. The base is the end most
            // likely to have masonry behind it, and additive light over near-black
            // stone is a far bigger relative jump than over the red sky — so a
            // column at full strength down there paints a hard bright wedge on the
            // wall even when its own edges are soft. See CFG.door.beacon.
            float vBase = smoothstep(0.0, uBaseFade, vY);
            float a = core * vTop * vBase * uStrength;
            gl_FragColor = vec4(uColor, a);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const cyl = new THREE.Mesh(geo, mat);
      cyl.position.y = dcfg.beacon.height / 2;
      cyl.userData.baseOpacity = shell.opacity;
      cyl.renderOrder = 3;
      beamGroup.add(cyl);
    }
    beamGroup.position.set(dx, dcfg.beacon.baseHeight, dz);
    this.scene.add(beamGroup);
    this.doorBeacon = beamGroup;
    this.setBeaconLevel(dcfg.beacon.opacityLocked);

    // Parented to the scene and merely dimmed on state change, never added or
    // removed — changing the scene's light count recompiles every material, which
    // is the hitch the gem lights already had to be restructured to avoid. The
    // same reasoning extends across the loop: on a regenerated maze this light is
    // MOVED and re-levelled rather than replaced, so a new maze costs zero
    // recompiles. Re-levelling matters because by the time a loop runs this light
    // is at `lightIntensityOpen` from the unlock that ended the previous maze.
    if (!this.doorLight) {
      this.doorLight = new THREE.PointLight(
        dcfg.glowColor, dcfg.lightIntensityLocked, dcfg.lightDistance, 2,
      );
      this.scene.add(this.doorLight);
    }
    this.doorLight.color.setHex(dcfg.glowColor);
    this.doorLight.intensity = dcfg.lightIntensityLocked;
    this.doorLight.distance = dcfg.lightDistance;
    this.doorLight.position.set(dx, dcfg.haloHeight, dz);

    // Spawn him inside his own quiet band rather than at the door. The door is by
    // construction the deepest cell in the maze (measured 87.1 cells from the
    // player over 10 seeds), which is 4x outside the 10-22 cell band his director
    // is written to patrol — the commute alone is ~200s of walking, so nothing the
    // director does is observable by a player. Runs after player.position.set()
    // above, which it depends on.
    this.monster.spawnNearPlayer(this.player.position);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.fpsT0 = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  async beginPlay() {
    await this.audio.resume();
    this.audio.startBeds();
    this.placePlayerAtSpawn();
    this.setPhase('playing');
  }

  /**
   * Hand the camera back from the menu.
   *
   * `updateMenuCamera` drives position, yaw, pitch and a vertical bob every frame
   * while the menu is up, and nothing returned them. `restart()` reset all four,
   * which is why **Retry produced a correct view and the very first descent did
   * not** — a tell that took a while to spot. Anything that enters 'playing' must
   * go through here.
   */
  private placePlayerAtSpawn() {
    if (!this.player || !this.maze) return;

    /**
     * Spawn with your BACK TO A WALL, and remember which wall it is.
     *
     * User, on arriving in a looped maze: "there should be a wall right behind
     * you, there wasn't cuz I was inside a relatively large room." They were
     * right, and the cause was that the arrival door was a free-standing slab
     * dropped 1.84m behind the player rather than set into anything. When it shut
     * and vanished it left open corridor — so instead of "the way back is gone"
     * the read was "there was never a door there".
     *
     * A wall behind you is what makes the door that disappears MEAN something.
     * `spawnWall` is handed to `buildArrivalDoor()` so the door lands IN that
     * wall, flush, the way the exit door does.
     */
    // Cached at world-build time so the trim exclusion and the arrival door agree.
    const anchor = this.spawnAnchor ?? this.findSpawnAnchor();
    this.spawnWall = anchor.wall;
    this.player.position.set(anchor.pos[0], 0, anchor.pos[1]);
    this.player.velocity.set(0, 0, 0);
    this.player.yawObject.position.y = 0;   // the menu camera's breathing bob
    this.player.pitchObject.rotation.x = 0;
    this.player.yawObject.rotation.y = anchor.yaw;
  }

  /**
   * A spawn cell with a wall to put your back against.
   *
   * Prefers the historical spawn (1,1) so nothing else that reasons about depth
   * from spawn shifts under it; falls back outward only if that cell somehow has
   * no walled face. Returns where to stand, which way to look (away from the
   * wall, down the longest open run), and the wall plane itself.
   */
  private findSpawnAnchor(): { pos: [number, number]; yaw: number; wall: { pos: [number, number]; yaw: number } | null } {
    const half = CFG.maze.cell / 2;
    const inset = CFG.maze.wallThickness / 2;
    const d = CFG.door;

    const tryCell = (x: number, y: number) => {
      if (!this.maze.inBounds(x, y)) return null;
      const c = this.maze.at(x, y);
      const [wx, wz] = this.maze.cellToWorld(x, y);
      // Each entry: the wall plane, and the yaw that looks AWAY from it.
      const faces: { pos: [number, number]; wallYaw: number; lookYaw: number; run: number }[] = [];
      if (c.n) faces.push({ pos: [wx, wz - half + inset], wallYaw: 0, lookYaw: Math.PI, run: this.openRun(x, y, 0, 1) });
      if (c.s) faces.push({ pos: [wx, wz + half - inset], wallYaw: Math.PI, lookYaw: 0, run: this.openRun(x, y, 0, -1) });
      if (c.w) faces.push({ pos: [wx - half + inset, wz], wallYaw: Math.PI / 2, lookYaw: -Math.PI / 2, run: this.openRun(x, y, 1, 0) });
      if (c.e) faces.push({ pos: [wx + half - inset, wz], wallYaw: -Math.PI / 2, lookYaw: Math.PI / 2, run: this.openRun(x, y, -1, 0) });
      if (!faces.length) return null;
      // Of the walls available, back onto the one that leaves the longest corridor
      // ahead — so the opening shot is depth, not another wall two metres away.
      faces.sort((a, b) => b.run - a.run);
      const f = faces[0];
      /**
       * Stand AGAINST the wall, not in the middle of the cell.
       *
       * User, on the loop's arrival: "when you spawn into a new maze there should
       * be a wall right behind you, there wasn't cuz I was inside a relatively
       * large room". Backing onto a walled face was necessary but not sufficient —
       * the spawn was still the cell CENTRE, which on a 4m grid is 2m clear of the
       * wall, so the door you just came through shut somewhere off behind you
       * instead of at your shoulders. Measured at 2.00m before this.
       *
       * Offset along the wall's inward normal to leave exactly `spawnStandoff`
       * between the player and the wall face. That has to clear the player's own
       * 0.34m collision radius plus the door frame's `frameDepth`, or the
       * controller's collision resolution simply pushes them back to where they
       * started and the whole thing silently reverts.
       */
      const inX = Math.sign(wx - f.pos[0]);
      const inZ = Math.sign(wz - f.pos[1]);
      const back = Math.max(0, half - inset - d.spawnStandoff);
      const px = wx - inX * back;
      const pz = wz - inZ * back;
      return {
        pos: [px, pz] as [number, number],
        yaw: f.lookYaw,
        wall: { pos: f.pos, yaw: f.wallYaw },
      };
    };

    const first = tryCell(1, 1);
    if (first) return first;
    for (let r = 1; r < Math.max(this.maze.cols, this.maze.rows); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const got = tryCell(1 + dx, 1 + dy);
          if (got) return got;
        }
      }
    }
    const [wx, wz] = this.maze.cellToWorld(1, 1);
    return { pos: [wx, wz], yaw: 0, wall: null };
  }

  /**
   * Cells for the `?gems=1` door rig: one step from spawn, then one more.
   *
   * Walks the maze's own `isOpen` rather than assuming the grid around spawn is
   * carved — with braiding at 1.0 most cells have several exits, but the rig must
   * not silently degrade to "gem on top of the player" on a seed where it does
   * not. Returns null if the shape is not available, and the caller falls back to
   * the ordinary placement, which is correct-but-slow rather than wrong.
   */
  private devRigCells(): { gem: [number, number]; door: [number, number] } | null {
    const DIRS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const [sx, sy] = [1, 1];
    for (const [dx, dy] of DIRS) {
      if (!this.maze.isOpen(sx, sy, dx, dy)) continue;
      const gem: [number, number] = [sx + dx, sy + dy];
      if (!this.maze.inBounds(gem[0], gem[1])) continue;
      // Prefer carrying straight on, so gem and door are not stacked back at spawn.
      const onward = [[dx, dy], ...DIRS.filter((d) => !(d[0] === -dx && d[1] === -dy))];
      for (const [ex, ey] of onward) {
        if (!this.maze.isOpen(gem[0], gem[1], ex, ey)) continue;
        const door: [number, number] = [gem[0] + ex, gem[1] + ey];
        if (!this.maze.inBounds(door[0], door[1])) continue;
        if (door[0] === sx && door[1] === sy) continue;   // not back on the player
        return { gem, door };
      }
      // A gem neighbour with nowhere onward: still better than the deep default.
      return { gem, door: gem };
    }
    return null;
  }

  /** How many cells of unobstructed corridor lie in a direction from a cell. */
  private openRun(x: number, y: number, dx: number, dy: number): number {
    let run = 0;
    let cx = x, cy = y;
    while (run < 8 && this.maze.isOpen(cx, cy, dx, dy)) { cx += dx; cy += dy; run++; }
    return run;
  }

  /*
   * `spawnYaw()` was removed. Choosing a heading is no longer separable from
   * choosing a spawn: the player must stand with their back to a WALL so the
   * arrival door has something to be set into, and the heading is then simply
   * "away from that wall, down the longest run". Both now come out of
   * `findSpawnAnchor()` together.
   */


  restart() {
    // A pending scare beat from the death we are restarting out of would otherwise
    // fire mid-run and throw the fresh game straight to the game-over screen.
    if (this.scareBeatTimer !== undefined) {
      clearTimeout(this.scareBeatTimer);
      this.scareBeatTimer = undefined;
    }

    /**
     * Cancel any in-flight loop.
     *
     * Retry keeps the CURRENT maze and the current depth — you died at depth 4,
     * you retry depth 4 — which is the honest reading of both the fiction and the
     * button. What must not survive is a half-played transition: a `loopFade` of
     * 0.6 left set would restart the run behind a grey scrim with no way to clear
     * it, and a leftover `arrivalDoor` would leave a door standing in the middle
     * of a corridor with nothing to shut it.
     *
     * Retry is reachable from `transition` in principle (the pause menu is not,
     * but the harness and any future in-transition UI are), so this is a real
     * path and not a defensive flourish.
     */
    if (this.loopStage !== 'idle') {
      this.loopStage = 'idle';
      this.loopT = 0;
      this.loopFade = 0;
      this.loopWalk = null;
      this.emitTransition();
    }
    if (this.arrivalDoor) {
      this.disposeDoor(this.arrivalDoor);
      this.arrivalDoor = null;
    }
    // Reopening a door the player already walked through, in case they died
    // between the exit swinging open and the transition completing.
    const restartLeaf = this.door?.userData?.leaf as THREE.Group | undefined;
    if (restartLeaf) restartLeaf.rotation.y = 0;

    // Full reset without a page reload: clear collectibles, put everyone back.
    this.gems.forEach((g) => { g.visible = true; (g as any).__taken = false; });
    // Relight, rather than re-adding: the light count must never change.
    this.gemLights.forEach((l) => { l.intensity = CFG.gems.glowIntensity; });
    // Re-lock the exit's beacon, or a Retry would start with the door already
    // blazing and the objective given away.
    this.setBeaconLevel(CFG.door.beacon.opacityLocked);
    if (this.doorHalo) {
      (this.doorHalo.material as THREE.SpriteMaterial).opacity = CFG.door.haloOpacityLocked;
    }
    if (this.doorLight) this.doorLight.intensity = CFG.door.lightIntensityLocked;
    this.gemsCollected = 0;
    this.doorUnlocked = false;
    this.gateePlayed = false;
    this.events.onGems(0, this.gems.length);
    // Same guard as unlockDoor(): Retry can be clicked before the door exists.
    if (this.door) {
      // Nothing to reset on the mesh itself: the door's lock state is carried by
      // its halo and point light, both handled just above.
    }

    // Shared with beginPlay() so the first descent and a Retry cannot drift apart
    // again — they did, and the difference was a 58 degree view snap on descent.
    this.placePlayerAtSpawn();

    // spawnNearPlayer also calls resetHunt(), which clears lostTimer, chaseElapsed,
    // chaseCooldown, the spent path, the search probe list and the director's beat
    // clock. Setting `state = 'patrol'` alone left all of those behind, so a Retry
    // inherited a partly-elapsed beat aimed at where you died plus a chaseCooldown
    // that could suppress the first chase of the new run for up to 8s.
    this.monster.spawnNearPlayer(this.player.position);

    this.audio.duck(1, 0.4);
    this.audio.setChase(false, 0.1);
    this.setPhase('playing');
  }

  // ---- input ---------------------------------------------------------------

  handleKey(code: string, down: boolean) {
    if (down) this.keys.add(code); else this.keys.delete(code);
  }

  handleMouse(dx: number, dy: number) {
    if (this.phase !== 'playing') return;
    this.player.look(dx, dy);
    /**
     * A deliberate look SUSPENDS the auto-follow. Without this the camera fights
     * you: you swipe to watch something off to the side, and the follow
     * immediately drags the view back to your direction of travel. Sidestepping
     * along a corridor while keeping your eyes on a doorway is exactly the thing
     * a horror game needs to stay possible.
     */
    this.lookHoldT = CFG.touch.lookHoldSeconds;
  }

  /** Movement from the on-screen stick, summed with the keys in `updatePlay`. */
  private touchMove = { forward: 0, strafe: 0, sprint: false };
  /** Seconds of auto-follow suppression left after a manual look. */
  private lookHoldT = 0;
  /** The WORLD heading the stick asked for; null when the stick is at rest. */
  private followHeading: number | null = null;
  /** The stick angle that produced it, so a genuine re-aim can be detected. */
  private followStickAngle = 0;

  setTouchInput(forward: number, strafe: number, sprint: boolean) {
    this.touchMove.forward = forward;
    this.touchMove.strafe = strafe;
    this.touchMove.sprint = sprint;
  }

  /**
   * THE CAMERA FOLLOWS WHERE YOU ARE GOING.
   *
   * User: "The camera should of course follow the player and not hang back
   * somewhere, they shouldn't have to swipe themselves to keep the camera where
   * it needs to be." With a strafing stick that does not happen for free — push
   * left and you sidestep down the corridor while the view stares straight
   * ahead, so you swipe constantly just to look where you walk.
   *
   * THE OBVIOUS IMPLEMENTATION SPINS FOREVER, and the first one here did:
   * measured at **173.7 degrees of yaw from 1.6s of holding the stick right**,
   * i.e. a continuous pirouette. The stick is CAMERA-RELATIVE, so "turn toward
   * the stick direction" has no feedback — rotating the camera rotates the
   * target with it, the error never shrinks, and the rate limiter merely sets
   * the spin speed. Any version that reads the raw stick every frame is wrong
   * in exactly this way.
   *
   * The fix anchors the goal in WORLD space. When the stick is first pushed (or
   * genuinely re-aimed) the direction it asks for is converted ONCE into a world
   * heading `followHeading`, and thereafter:
   *
   *   - the camera eases toward that fixed heading, so the error really shrinks
   *     and the motion settles instead of running away;
   *   - the stick's meaning is re-derived from it each frame, so as the camera
   *     comes round, pure strafe turns smoothly into pure forward and the player
   *     travels in a STRAIGHT LINE in world space throughout.
   *
   * Pushing right therefore means: you sidestep right, the view swings to face
   * right, and by the time it has you are walking forward along the same path
   * you were already on. That is what "the camera follows the player" has to
   * mean when the stick strafes.
   *
   * Geometry note, because the sign is easy to get backwards: camera forward is
   * `(-sin Y, -cos Y)` and local +X (right) is `(cos Y, -sin Y)`, so a
   * camera-relative angle `a = atan2(strafe, forward)` corresponds to world
   * heading `H = Y - a`. Driving `a` to zero is therefore `Y -= a`.
   */
  private updateLookFollow(dt: number): { forward: number; strafe: number } {
    const t = CFG.touch;
    const f0 = this.touchMove.forward;
    const s0 = this.touchMove.strafe;
    const mag = Math.hypot(f0, s0);

    // Stick released: forget the heading so the next push starts fresh.
    if (mag < t.followDeadzone) { this.followHeading = null; return { forward: f0, strafe: s0 }; }

    const yaw = this.player.yawObject.rotation.y;
    const a0 = Math.atan2(s0, f0);

    /**
     * (Re)anchor only when the player actively aims somewhere new — a fresh
     * push, or a real change of stick direction. Without the change test the
     * heading would be re-derived from the current yaw every frame, which is the
     * runaway above wearing a different hat.
     */
    if (this.followHeading === null ||
        Math.abs(shortestAngle(this.followStickAngle, a0)) > t.reaimThreshold) {
      this.followHeading = yaw - a0;
      this.followStickAngle = a0;
    }

    // Where the fixed world heading sits relative to where we are looking now.
    const a = shortestAngle(this.followHeading, yaw);

    // Movement re-derived from the world heading, NOT from the raw stick, so the
    // path stays straight while the view rotates under it.
    const eff = { forward: Math.cos(a) * mag, strafe: Math.sin(a) * mag };

    // A manual swipe suspends the TURN — but not the re-derivation above, or the
    // player would veer off their line the instant they looked around.
    if (this.lookHoldT > 0) { this.lookHoldT = Math.max(0, this.lookHoldT - dt); return eff; }

    const step = a * t.followGain * dt;
    const cap = t.followMaxRate * dt;
    this.player.yawObject.rotation.y -= Math.max(-cap, Math.min(cap, step));
    return eff;
  }

  onResize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h, this.renderer.getPixelRatio());
  }

  // ---- frame ---------------------------------------------------------------

  private frame() {
    const rawDt = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime;

    /**
     * SUBSTEP THE SIMULATION SO THE AI'S CLOCK TRACKS REAL TIME.
     *
     * This used to be `dt = Math.min(getDelta(), 0.05)` — a hard truncation. The
     * clamp exists for a good reason (a single 300ms integration step is a long
     * way to move between collision tests), but truncating rather than
     * *accumulating* means every second of wall time under a slow frame advances
     * the simulation by less than a second, and the deficit is simply lost.
     *
     * MEASURED, not argued (`tools/_simprobe2.mjs` against the static build):
     * at the harness's 6.3 fps the real frame is ~160ms, the clamp passes 50ms,
     * and the director's own clock therefore advances at **0.322x wall time**.
     * The director's beat cycle is quiet(40-70s) + transit(~34s) + stalk(16-30s),
     * so at that rate the first stalk lands 124-323 s into a run instead of
     * 40-104 s. A full 41-beat scripted playthrough reported `beat: "quiet"` for
     * 33 beats and `monster: "patrol"` for all 41 — the monster never once
     * escalated, across the entire game, from menu to win screen.
     *
     * That is almost certainly the true cause of the note in PROGRESS.md that
     * "two independent critic runs reported 100% quiet and concluded the whole
     * director was dead code". The director is not dead code. It was being run in
     * slow motion by this line, and only on the machines the critics measure on —
     * which is the worst possible failure, because it is invisible on the
     * developer's GPU and total under the harness.
     *
     * Accumulating instead of truncating is safe here, and that is a property of
     * the two things being stepped rather than a hope:
     *   - `Player.update` substeps internally against `p.maxSubsteps`/`maxStep`
     *     and documents that it "cannot tunnel regardless of what dt it is
     *     handed" — the clamp in this file was explicitly called a coincidence in
     *     another file's constant there.
     *   - `Monster.stepToward` clamps each move with `Math.min(speed * dt, dist)`
     *     so it cannot overshoot a path waypoint, and it follows the maze graph
     *     rather than colliders.
     * Each substep is still <= MAX_STEP, so nothing sees a larger dt than before;
     * there are simply now as many of them as real time actually demands.
     *
     * The catch-up is BOUNDED. A backgrounded tab hands back multi-second deltas,
     * and replaying all of that would teleport the monster across the maze the
     * instant the tab is focused. Beyond the budget the remainder is dropped, so
     * the worst case degrades to exactly the old truncating behaviour.
     */
    const MAX_STEP = 0.05;
    const MAX_CATCHUP_STEPS = 6; // 6 * 50ms = 300ms of catch-up per frame, max.
    const budget = Math.min(rawDt, MAX_STEP * MAX_CATCHUP_STEPS);
    const steps = Math.max(1, Math.ceil(budget / MAX_STEP));
    const dt = budget / steps;
    /**
     * What one *rendered frame* is worth, for everything that runs once per frame
     * rather than once per simulation step: the flashlight's follow-lag and
     * flicker smoothing, the dust/world animation, the fade timers on menus.
     *
     * These are all exponential smoothers of the form `x += (target - x) * k*dt`.
     * Feeding them a single substep instead of the whole frame would silently
     * slow every one of them by the substep count — the beam would lag further
     * behind the camera at low frame rates, which is precisely the situation
     * where it is already hardest to see. They want wall time, not sim time.
     */
    const frameDt = budget;

    if (this.phase === 'playing' && !this.paused) {
      // The simulation is what needs real time; the presentation below does not.
      // Rendering, post and the flashlight run once per frame off the total, so
      // this costs AI/physics accuracy only, not draw calls.
      for (let i = 0; i < steps; i++) this.updatePlay(dt);
    } else if (this.phase === 'transition') {
      /**
       * The loop drives the camera itself and runs NO simulation — no player
       * controller, no monster, no collision, no catch check. Two reasons, and
       * both are load-bearing:
       *
       *  - the scripted move writes `player.position` directly, and a controller
       *    integrating velocity in the same frame would resolve a collision
       *    against the doorway and shove the player back out of the shot;
       *  - `updatePlay` ends with the catch test, so a monster who happened to be
       *    on top of you when you touched the door would kill you mid-cutscene.
       *    Reaching the exit has to be safe once it has been reached.
       *
       * It is handed `frameDt` — wall time — not the substep. See `updateLoop`.
       */
      this.updateLoop(frameDt);
      this.audio.updateMonsterAudio(frameDt, null);
    } else if (this.phase === 'playing' && this.paused) {
      // Paused: keep rendering the maze behind the menu, but run no simulation.
      this.audio.updateMonsterAudio(frameDt, null);
    } else {
      // Fade his positional bed out rather than leaving it hanging at his last
      // position while a menu or an end screen is up.
      this.audio.updateMonsterAudio(frameDt, null);
      // The caught -> gameover promotion is a wall-clock timer set in
      // catchPlayer(), NOT a per-frame check. See the comment there: sampling
      // performance.now() once per rendered frame collapsed the one-second beat
      // to nothing whenever the catch frame was expensive.
      if (this.phase === 'menu') this.updateMenuCamera(frameDt, elapsed);
    }

    this.world.update(frameDt, elapsed);
    this.updateFlashlight(frameDt);

    // Keep the mote volume centred on the player, snapped to whole metres. Snapping
    // matters: following the camera continuously would drag every mote along with
    // you, so they would look painted onto the lens instead of hanging in the air.
    if (this.player) {
      this.world.dust.position.set(
        Math.round(this.player.position.x),
        0,
        Math.round(this.player.position.z),
      );
    }

    // Hand the live beam to the dust shader so motes only glow inside the cone.
    // Read off the real SpotLight rather than recomputed from the camera, so the
    // shaft inherits the flicker and the 2.4x chase follow-lag for free instead
    // of drifting out of step with the light it is supposed to be scattering.
    //
    // updateFlashlight() ran above, but it writes .position/.target.position and
    // three only folds those into world matrices at render time — so the world
    // matrices are read explicitly here. Using the stale matrix lags the shaft a
    // frame behind the torch, which is small but reads as the dust sliding.
    this.flashlight.updateWorldMatrix(true, false);
    this.flashlight.target.updateWorldMatrix(true, false);
    BEAM_POS.setFromMatrixPosition(this.flashlight.matrixWorld);
    BEAM_DIR.setFromMatrixPosition(this.flashlight.target.matrixWorld)
      .sub(BEAM_POS)
      .normalize();
    this.world.setBeam(BEAM_POS, BEAM_DIR);

    // The frame itself reacts to how close he is — vignette tightens, grain rises,
    // aberration smears the corners. Driven by the SAME pressure value as the
    // flashlight flicker, so the picture and the light panic together — which now
    // means the sightline-damped one `updateFlashlight` just computed, not the raw
    // proximity. If these two diverged the frame would clench at a monster three
    // walls away while the beam, correctly, stayed calm.
    const dread = this.phase === 'playing' ? this.dreadPressure : 0;

    if (this.post?.enabled) {
      this.post.update(elapsed, dread);
      this.post.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    this.frames++;
    const secs = (performance.now() - this.fpsT0) / 1000;
    if (secs > 0.5) {
      (window as any).__FPS__ = this.frames / secs;
      this.frames = 0;
      this.fpsT0 = performance.now();
    }
    (window as any).__GAME_STATE__ = {
      phase: this.phase,
      gems: this.gemsCollected,
      total: this.gems.length,
      monster: this.monster?.state,
      monsterDistance: Math.round((this.monster?.distanceToPlayer ?? 0) * 10) / 10,
      /**
       * Corridor distance in cells — the unit the director is actually budgeted
       * in. `monsterDistance` above is straight-line and can read 9m through six
       * walls, which is what made the original stalk bug so hard to see. -1 means
       * unreachable or not yet simulated.
       */
      monsterCorridorCells: this.corridorCellsToMonster(),
      /**
       * `lineOfSight` (used by the audio frame) is raw geometry: is anything solid
       * between the two of you. `monsterSeesPlayer` is whether you are actually
       * inside his vision cone. The difference between those two is exactly what
       * separates a near-miss from a blown one.
       */
      monsterSeesPlayer: this.monster?.seesPlayer ?? false,
      /**
       * His real instantaneous speed. He now ramps rather than switches
       * (walk 1.75 -> lunge 6.4 -> settle 4.65), so no single config constant
       * describes what he is doing on a given frame; this makes the burst-and-settle
       * visible in report.json instead of something a critic has to infer.
       */
      monsterSpeed: Math.round((this.monster?.speed ?? 0) * 100) / 100,
      doorUnlocked: this.doorUnlocked,
      /**
       * The loop, in the telemetry, so a beat script can assert which frame it is
       * looking at instead of inferring it from pixels. `loopStage` names the
       * beat; `loopFade` says how black the screen is, which is the difference
       * between "the card frame is correctly black" and "the render died".
       */
      depth: this.depth,
      loopStage: this.loopStage,
      loopFade: Math.round(this.loopFade * 1000) / 1000,
      /**
       * Live GPU resource counts. This is the leak gate for the loop: three.js
       * frees nothing on its own, so if `geometries` or `textures` climbs with
       * every maze then `disposeWorld`/`disposeCollectibles` is missing a
       * resource. `programs` must stay FLAT — a change there means the scene's
       * light count moved and every material recompiled.
       */
      memory: {
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        programs: this.renderer.info.programs?.length ?? 0,
      },
      mazeCells: this.maze ? `${this.maze.cols}x${this.maze.rows}` : null,
      clips: this.monster?.clipNames ?? [],
      /**
       * The clip actually crossfaded to right now. `clips` above only lists what
       * the GLB shipped, which is not the same question and cannot catch a
       * state->clip mapping fault. A whole wave was spent arguing about whether
       * the chase played `run` or `walk` because nothing reported this.
       */
      monsterClip: this.monster?.currentClip ?? null,
      /**
       * Proof the predator-posture layer found real bones and is engaged. `bones`
       * is the assertion-has-subjects check from PROGRESS.md trap 12: a posture
       * layer that silently resolved zero bones would look identical in a
       * screenshot to one that is working.
       */
      monsterPosture: this.monster?.postureProbe ?? null,
      // The pacing layer on top of the perception state: it tells a critic *why*
      // he is where he is. 'stalk' is him deliberately passing close without
      // having seen you.
      beat: this.monster?.directorBeat,
      paused: this.paused,
      /**
       * Renderer counters, for the capture harness. "The frame rate dropped" is
       * not actionable on its own — under a software rasterizer it could be fill,
       * geometry, the shadow pass or a shader recompile, and those have opposite
       * fixes. These are the numbers that tell them apart.
       */
      render: {
        calls: this.post?.sceneStats.calls ?? this.renderer.info.render.calls,
        triangles: this.post?.sceneStats.triangles ?? this.renderer.info.render.triangles,
        programs: this.renderer.info.programs?.length ?? 0,
      },
    };
  }

  /**
   * Corridor distance from player to monster, in cells, for the telemetry block.
   *
   * `distanceField` is a full BFS over the whole grid, so calling it every frame
   * purely to fill a diagnostic field would be real work done for nothing — the
   * exact kind of waste the perf budget cannot afford under a software
   * rasterizer. It is recomputed only when the player actually changes cell,
   * which in a 4m grid is a few times a second at most; between those moves the
   * cached field stays valid and reading the monster's cell out of it is O(1).
   *
   * Returns -1 when either party is off-grid or no path exists.
   */
  private corridorField: Int32Array | null = null;
  private corridorFieldCell = -1;

  private corridorCellsToMonster(): number {
    if (!this.maze || !this.player || !this.monster) return -1;
    const [px, py] = this.maze.worldToCell(this.player.position.x, this.player.position.z);
    if (!this.maze.inBounds(px, py)) return -1;

    const key = this.maze.idx(px, py);
    if (key !== this.corridorFieldCell || !this.corridorField) {
      this.corridorField = this.maze.distanceField(px, py);
      this.corridorFieldCell = key;
    }

    const [mx, my] = this.maze.worldToCell(
      this.monster.group.position.x, this.monster.group.position.z,
    );
    if (!this.maze.inBounds(mx, my)) return -1;
    const d = this.corridorField[this.maze.idx(mx, my)];
    return d < 0 ? -1 : d;
  }

  /**
   * The menu is composited over the live maze, not over a void.
   *
   * The UI lane made `.overlay--menu` translucent with a `backdrop-filter` blur so
   * the world shows through, then measured the result at `phase === 'menu'` with
   * every overlay removed from the DOM: mean RGB `[0,0,0]` — literally every pixel
   * black. So the blur had nothing to blur and the menu still read as a panel on
   * a void, which was the critic's single biggest note against Amnesia (whose menu
   * sits over a torch-lit room).
   *
   * The frame was black because the camera sat frozen at the spawn transform
   * facing a wall a metre away, with the only light in the game aimed into it.
   * This does three things, all of them cheap:
   *
   *  1. Places the camera in a corridor cell a few steps in from spawn, chosen for
   *     depth rather than hardcoded, so the shot has somewhere to recede to.
   *  2. Drifts it — a slow sinusoidal yaw sweep plus a centimetres-scale bob. Slow
   *     enough (a ~24s period) that a still screenshot still reads as a still and
   *     only motion over seconds gives it away.
   *  3. Lights it, by aiming the existing flashlight down the corridor rather than
   *     adding a light. No new light source means nothing new to tune against
   *     r155's physical units, and the beam is already the game's visual signature.
   *
   * It consumes no input and touches no gameplay state: it writes the yaw/pitch
   * objects the player already owns, which `beginPlay()` and `restart()` both
   * overwrite from the spawn cell anyway, so nothing leaks into a run.
   */
  private menuAnchor: { x: number; z: number; yaw: number } | null = null;

  private pickMenuAnchor() {
    // A cell far enough from spawn to see down a corridor, near enough that the
    // maze reads as the place you are about to walk into. The distance field is
    // the same instrument used to place the gems and the door.
    const field = this.maze.distanceField(1, 1);
    const want = 4;
    let best = -1, bestErr = Infinity;
    for (let i = 0; i < field.length; i++) {
      if (field[i] < 0) continue;
      const err = Math.abs(field[i] - want);
      if (err < bestErr) { bestErr = err; best = i; }
    }
    if (best < 0) { this.menuAnchor = { x: 0, z: 0, yaw: 0 }; return; }

    const cx = best % this.maze.cols, cy = (best / this.maze.cols) | 0;
    const [wx, wz] = this.maze.cellToWorld(cx, cy);

    // Face whichever open direction has the most corridor behind it, so the beam
    // travels instead of splashing on a wall 2m away. Falls back to the cell's
    // first opening; a carved maze cell always has at least one.
    const cell = this.maze.at(cx, cy);
    const dirs: [boolean, number][] = [
      [!cell.n, Math.PI], [!cell.s, 0], [!cell.e, -Math.PI / 2], [!cell.w, Math.PI / 2],
    ];
    let yaw = 0, bestRun = -1;
    for (const [open, y] of dirs) {
      if (!open) continue;
      const sx = Math.round(-Math.sin(y)), sz = Math.round(-Math.cos(y));
      let run = 0, tx = cx, ty = cy;
      while (run < 12) {
        const nx = tx + sx, ny = ty + sz;
        if (!this.maze.inBounds(nx, ny)) break;
        if (!this.maze.hasLineOfSight(...this.maze.cellToWorld(tx, ty), ...this.maze.cellToWorld(nx, ny))) break;
        tx = nx; ty = ny; run++;
      }
      if (run > bestRun) { bestRun = run; yaw = y; }
    }
    this.menuAnchor = { x: wx, z: wz, yaw };
  }

  private updateMenuCamera(_dt: number, elapsed: number) {
    if (!this.player || !this.maze) return;
    if (!this.menuAnchor) this.pickMenuAnchor();
    const a = this.menuAnchor!;

    const m = CFG.render.menuCamera;
    // Sinusoidal sweep. Two incommensurate periods on the bob so the vertical
    // motion never visibly repeats against the yaw.
    const sweep = Math.sin((elapsed / m.yawPeriod) * Math.PI * 2) * m.yawAmplitude;
    const bob = Math.sin((elapsed / m.bobPeriod) * Math.PI * 2) * m.bobAmplitude;

    this.player.position.set(a.x, 0, a.z);
    this.player.yawObject.rotation.y = a.yaw + sweep;
    this.player.pitchObject.rotation.x = m.pitch + bob * 0.35;
    this.player.yawObject.position.y = bob;
  }

  private updatePlay(dt: number) {
    /**
     * Keys and the touch stick are SUMMED, not switched between.
     *
     * There is no "mobile mode" flag anywhere in this file, and deliberately so:
     * a device flag has to be right, and it is wrong for every tablet with a
     * keyboard, every phone in a controller cradle, and every desktop with a
     * touchscreen. Both channels always contribute and the clamp below keeps a
     * player who somehow drives both from moving at double speed.
     */
    // Run the follow FIRST: it returns the stick's contribution re-expressed in
    // the camera frame it has just rotated, so movement and view stay consistent
    // within one frame rather than lagging each other by one.
    const touch = this.updateLookFollow(dt);
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    const input = {
      forward: clamp1(
        (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
        (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0) + touch.forward,
      ),
      strafe: clamp1(
        (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
        (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0) + touch.strafe,
      ),
      sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchMove.sprint,
    };

    this.player.update(dt, input, this.world.colliders);
    this.monster.update(dt, this.player.position, this.player.isSprinting);

    // Positional monster audio: gait footfalls at his real pace, a breath bed that
    // swells as he closes, stereo pan off his true bearing, and a lowpass that is
    // clamped shut when a wall is between you. Without this call he is silent.
    /**
     * Computed once and reused. The audio bed needs it for its occlusion lowpass,
     * and `updateFlashlight` needs it for the flicker rule below — running the
     * same DDA twice per frame for two consumers of one fact would be waste, and
     * worse, the two could disagree if either drifted.
     */
    this.lastLineOfSight = this.maze.hasLineOfSight(
      this.monster.group.position.x, this.monster.group.position.z,
      this.player.position.x, this.player.position.z,
    );

    this.audio.updateMonsterAudio(dt, {
      x: this.monster.group.position.x,
      z: this.monster.group.position.z,
      px: this.player.position.x,
      pz: this.player.position.z,
      yaw: this.player.yawObject.rotation.y,
      lineOfSight: this.lastLineOfSight,
      chasing: this.monster.state === 'chase',
      moving: this.monster.isMoving,
      /**
       * Hand the audio engine the AI's own perception state rather than making it
       * infer one. The engine can infer, and its inference is faithful, but it is
       * coarser in exactly one place that matters: 'suspicious' and 'search' both
       * mean "he is hunting and has not found you" and both should produce the
       * interrogative growl, yet inference can only reach that state when he also
       * happens to have line of sight. A monster searching a corridor two turns
       * away otherwise reads as ordinary patrol.
       *
       * `justSpotted` gives the notice vocal its exact instant. The engine also
       * self-detects the silent->hunt edge, so passing it is a precision
       * improvement, not a correctness fix — and we must therefore NOT also call
       * `noticeSting()` explicitly below, or the sting doubles.
       */
      state: this.monster.state,
      justSpotted: this.monster.justSpotted,
    });

    /**
     * THE MUSIC IS A FUNCTION OF THE AI STATE, TOTALLY.
     *
     * This used to enumerate the states that turn the chase bed OFF — patrol and
     * search — and say nothing about `suspicious`, so that state fell through both
     * branches and simply held whatever the bed was already doing. Today that is
     * survivable by luck rather than by design: `suspicious` is only ever entered
     * from `patrol` (monster.ts guards the transition on it), where the bed is
     * already down, so the gap cannot currently be observed. It is still a latent
     * desync of exactly the kind this pass exists to find — the day anything lets
     * `chase` or `search` fall back to `suspicious`, the chase music keeps playing
     * over a monster who is ambling around listening, with no error anywhere.
     *
     * Stating it as a total function of the state removes the class of bug rather
     * than the instance: chase means the bed is up, every other state means it is
     * down. `setChase` is idempotent and has a re-entrancy guard specifically so
     * it can be called every frame like this.
     */
    if (this.monster.justSpotted) this.audio.setChase(true);
    else this.audio.setChase(this.monster.state === 'chase');

    // Knocks are for the quiet. During a chase the music is already doing the work.
    this.audio.updateKnocks(dt, this.monster.state === 'chase');

    this.updateGems(dt);
    this.updateDoor();

    if (this.monster.distanceToPlayer < CFG.monster.catchDistance) this.catchPlayer();
  }

  /**
   * A soft radial falloff, built once and shared by every gem's halo.
   *
   * Generated rather than shipped as a PNG: it is 12 lines of maths against
   * another file in the asset bundle, and a gradient authored in code cannot
   * drift out of sync with the colour it is tinted by. The curve is quartic
   * rather than linear so the halo has a tight bright core with a long faint
   * skirt — a linear ramp reads as a flat disc, which looks like a UI marker
   * stuck to the wall instead of light in the air.
   */
  private haloTex: THREE.Texture | null = null;
  private gemHaloTexture(): THREE.Texture {
    if (this.haloTex) return this.haloTex;
    const N = 64;
    const data = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = (x + 0.5) / N - 0.5, dy = (y + 0.5) / N - 0.5;
        const r = Math.min(1, Math.hypot(dx, dy) * 2);
        const a = Math.pow(1 - r, 4);
        const i = (y * N + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = Math.round(a * 255);
      }
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.needsUpdate = true;
    this.haloTex = tex;
    return tex;
  }

  private updateGems(dt: number) {
    // One uniform write per gem drives all the deformation; the displacement
    // itself happens per-vertex on the GPU.
    const t = this.clock.elapsedTime;
    for (const u of this.gemUniforms) u.uTime.value = t;

    for (const gem of this.gems) {
      if (!gem.visible) continue;
      gem.rotation.y += dt * 1.3;
      gem.rotation.x += dt * 0.5;
      gem.position.y = CFG.gems.height +
        Math.sin(this.clock.elapsedTime * 1.8 + gem.id) * CFG.gems.floatAmplitude;

      /**
       * The pulse — what makes a gem findable at 20 m rather than merely present.
       *
       * The brief for these is "dark, glowing red", and red is the hardest colour
       * to make legible in this game because the sky, the fog and the walls are
       * all already red: hue carries no information here. So the gem has to
       * separate on the two channels that are still free, BRIGHTNESS and MOTION.
       * The body stays near-black and the emissive is driven up and down on a slow
       * beat, which the eye picks out of a static red field at ranges where the
       * gem itself is only a few pixels across and its shape has stopped being
       * readable at all.
       *
       * The trough is deliberately well above zero — it must never blink out, or
       * a player scanning a corridor at the wrong moment sees nothing and learns
       * the corridor is empty. It breathes; it does not flash.
       *
       * `gem.id` phase-offsets each one so a room with two gems does not pulse in
       * unison, which would read as a scripted light rather than an object.
       */
      const g = CFG.gems;
      const dxCam = gem.position.x - this.player.position.x;
      const dzCam = gem.position.z - this.player.position.z;
      const pulse = 0.5 + 0.5 * Math.sin(this.clock.elapsedTime * g.pulseRate + gem.id);
      const mat = gem.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = g.emissiveIntensity * (1 - g.pulseDepth + g.pulseDepth * pulse);
      const glow = gem.children[0] as THREE.PointLight | undefined;
      if (glow?.isPointLight) {
        glow.intensity = g.glowIntensity * (1 - g.pulseDepth + g.pulseDepth * pulse);
      }

      /**
       * Grow the halo with distance so its APPARENT size stops shrinking past
       * `haloHoldDistance`.
       *
       * A sprite of fixed world size shrinks like 1/d, so the thing that is
       * supposed to rescue legibility at 20 m disappears fastest exactly where it
       * is needed. Scaling linearly in distance beyond the hold point keeps the
       * halo at a constant number of pixels instead, which is what makes a gem a
       * findable point of light down a long corridor rather than a sub-pixel dot.
       *
       * Below the hold distance it is left alone, so a gem you are standing next
       * to does not wear an enormous disc — up close the crystal's own facets and
       * the point light are doing the work, and the halo should get out of the way.
       */
      const halo = this.gemHalos[this.gems.indexOf(gem)];
      if (halo) {
        halo.position.copy(gem.position);
        const dist = Math.hypot(dxCam, dzCam);
        const grow = Math.max(1, dist / g.haloHoldDistance);
        halo.scale.setScalar(g.haloSize * grow);
        (halo.material as THREE.SpriteMaterial).opacity =
          g.haloOpacity * (1 - g.pulseDepth + g.pulseDepth * pulse);
      }

      if (Math.hypot(dxCam, dzCam) < 1.1) {
        gem.visible = false;
        // Dim, never remove — see the note where these are created. Removing a
        // light changes the scene's light count and recompiles every shader.
        const lit = this.gemLights[this.gems.indexOf(gem)];
        if (lit) lit.intensity = 0;
        // The halo is a scene-level sibling now, so hiding the gem no longer
        // hides it. A glow left burning over a collected gem would send the
        // player back to a cell they have already cleared.
        const taken = this.gemHalos[this.gems.indexOf(gem)];
        if (taken) taken.visible = false;
        this.gemsCollected++;
        this.audio.play('gem', { volume: 0.9 });
        this.events.onGems(this.gemsCollected, this.gems.length);
        if (this.gemsCollected >= this.gems.length) this.unlockDoor();
      }
    }
  }

  /**
   * Turn a gem's standard material into a writhing liquid-metal blob.
   *
   * Patched via `onBeforeCompile` rather than written as a ShaderMaterial, so the
   * gem keeps three's full PBR lighting — it still takes the flashlight, still
   * responds to its own point light, still fogs correctly. Only the vertex
   * positions and normals are rewritten.
   *
   * The motion has two layers, because a single smooth noise reads as a lava lamp
   * rather than as something alive:
   *
   *  - a slow roil (two noise octaves at different rates) that keeps the silhouette
   *    permanently changing but never still;
   *  - a TWITCH: a sharp, short spike driven by a per-gem pseudo-random clock,
   *    which snaps a spike out of the surface and lets it collapse. That is the
   *    part that reads as menacing rather than decorative — the T-1000 is
   *    frightening in the moments it moves WRONG, not while it flows.
   *
   * Each gem gets its own `uSeed` so seven of them never pulse in unison, which
   * would instantly read as a screensaver.
   */
  private makeGemLiquid(mat: THREE.MeshStandardMaterial, seed: number) {
    const uniforms = {
      uTime: { value: 0 },
      uSeed: { value: (seed % 97) * 0.618 },
      uRoil: { value: CFG.gems.roilAmount },
      uTwitch: { value: CFG.gems.twitchAmount },
    };
    this.gemUniforms.push(uniforms);

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = `
        uniform float uTime;
        uniform float uSeed;
        uniform float uRoil;
        uniform float uTwitch;
        varying float vGemRoil;
        varying float vGemSpike;

        // Classic 3D value noise. Cheap, and smooth enough that displacing along
        // a normal by it does not tear the surface.
        vec3 hash3(vec3 p){
          p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
                   dot(p, vec3(269.5, 183.3, 246.1)),
                   dot(p, vec3(113.5, 271.9, 124.6)));
          return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
        }
        float noise3(vec3 p){
          vec3 i = floor(p), f = fract(p);
          vec3 u = f * f * (3.0 - 2.0 * f);
          float n = 0.0;
          for (int cx = 0; cx < 2; cx++)
          for (int cy = 0; cy < 2; cy++)
          for (int cz = 0; cz < 2; cz++) {
            vec3 o = vec3(float(cx), float(cy), float(cz));
            float w = mix(1.0 - u.x, u.x, o.x) * mix(1.0 - u.y, u.y, o.y) * mix(1.0 - u.z, u.z, o.z);
            n += w * dot(hash3(i + o), f - o);
          }
          return n;
        }

        // How much of a twitch is happening right now, 0..1. Sawtooth clock per
        // gem; the pulse is short and sharp, then nothing for a beat.
        float twitchEnvelope(float t) {
          float phase = fract(t * 0.31 + uSeed);
          // A spike occupying the first ~14% of each period.
          float e = max(0.0, 1.0 - phase / 0.14);
          return e * e * e;
        }
        ${mat.userData.__vsHead ?? ''}
      ` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        {
          float t = uTime + uSeed * 13.7;
          vec3 n = normalize(objectNormal);

          // Slow roil: two octaves drifting at different speeds so the surface
          // never repeats a shape.
          float roil = noise3(position * 5.5 + vec3(0.0, t * 0.55, 0.0)) * 0.65
                     + noise3(position * 11.0 - vec3(t * 0.37, 0.0, t * 0.21)) * 0.35;

          // Twitch: higher frequency, and it SPIKES rather than swells.
          float tw = twitchEnvelope(t);
          float spike = noise3(position * 17.0 + vec3(uSeed * 7.0, t * 2.3, 0.0));

          float d = roil * uRoil + spike * tw * uTwitch;
          transformed += n * d;

          // Nudge the normal along the displacement gradient so the lighting
          // actually follows the deformation. Approximate, but without it the
          // shape moves while the shading stays put and it reads as a texture.
          objectNormal = normalize(objectNormal + n * d * 2.0);
          vNormal = normalize(normalMatrix * objectNormal);

          // Hand the surface noise to the fragment stage so the glow can be
          // veined rather than uniform. See the emissive patch below.
          vGemRoil = roil;
          vGemSpike = spike * tw;
        }
        `,
      );

      // --- fragment: veins, a hot core and a rim -----------------------------
      //
      // The displacement alone made a moving blob with FLAT colour, and the user's
      // verdict was "the gem looks kinda plain". A liquid-metal mass does not read
      // by silhouette alone: it reads by what the light does ACROSS it. Three
      // cheap additions, none of which cost a triangle:
      //
      //   veins  - modulate the emissive by the same noise that moves the surface,
      //            so the glow pools in the troughs like something molten under a
      //            skin instead of the whole ball being lit to one value;
      //   twitch - the spike term flashes brighter as it fires, so a twitch is
      //            visible even in silhouette against a dark corridor;
      //   rim    - a Fresnel term, which is what actually sells "wet". Grazing
      //            angles on a liquid surface throw the light back at you, and
      //            without it a sphere in a dark room reads as matte clay.
      shader.fragmentShader = `
        varying float vGemRoil;
        varying float vGemSpike;
      ` + shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `
        #include <emissivemap_fragment>
        {
          // Remap the roil to 0..1 and bias it so troughs go dark and crests glow.
          float vein = clamp(vGemRoil * 1.9 + 0.5, 0.0, 1.0);
          vein = pow(vein, 1.7);
          // A twitch briefly floods the whole body.
          float flash = clamp(vGemSpike * 3.2, 0.0, 1.2);
          totalEmissiveRadiance *= (0.35 + 1.5 * vein + flash);

          // Fresnel rim. vViewPosition points from the fragment toward the camera.
          vec3 V = normalize(vViewPosition);
          float fres = pow(1.0 - clamp(dot(normalize(vNormal), V), 0.0, 1.0), 3.0);
          totalEmissiveRadiance += vec3(1.0, 0.22, 0.12) * fres * 1.15;
        }
        `,
      );
    };
    // Bumped so the previous, flatter program cannot be served from cache.
    mat.customProgramCacheKey = () => 'gem-liquid-v2-veined';
    mat.needsUpdate = true;
  }

  /**
   * Choose a walled face of the door's cell and return where to stand the door.
   *
   * Returns the world position ON the wall plane (pulled in by half the wall
   * thickness so the leaf sits flush rather than intersecting), and the yaw that
   * faces the door into the cell.
   *
   * Preference order:
   *   1. a PERIMETER wall — the exit should lead out of the maze, not into more of it;
   *   2. any other walled face;
   *   3. failing both, the next-deepest cell that has one.
   */
  /**
   * WHERE THE EXIT GOES, solved from the maze alone.
   *
   * Split out of `placeGemsAndDoor` so it can run at world-build time, before the
   * trim exists — the carpentry needs a hole left for the doorway, and it cannot
   * leave one for a position that has not been decided yet.
   *
   * It must agree EXACTLY with what `placeGemsAndDoor` then uses, which is why
   * that method now reads `this.doorSpot` instead of repeating this. Two copies of
   * "which cell is deepest" would drift the moment either changed, and the failure
   * would be a hole in the trim a few metres from the actual door — visible, and
   * very hard to attribute.
   */
  private computeDoorSpot(): { pos: [number, number]; yaw: number; cell: [number, number] } | null {
    if (!this.maze) return null;
    const spawnField = this.maze.distanceField(1, 1);
    let deepest = 0, deepestIdx = 0;
    spawnField.forEach((d, i) => { if (d > deepest) { deepest = d; deepestIdx = i; } });
    let doorX = deepestIdx % this.maze.cols;
    let doorY = (deepestIdx / this.maze.cols) | 0;

    // `?gems=1` moves the exit next to the player; the trim has to know that too.
    const gemParam = Number(new URLSearchParams(location.search).get('gems'));
    if (gemParam === 1) {
      const rig = this.devRigCells();
      if (rig) [doorX, doorY] = rig.door;
    }
    return this.findDoorWall(doorX, doorY, spawnField);
  }

  private findDoorWall(cellX: number, cellY: number, field: Int32Array):
      { pos: [number, number]; yaw: number; cell: [number, number] } {
    const half = CFG.maze.cell / 2;
    const inset = CFG.maze.wallThickness / 2;

    // Yaw such that the door's local +Z (its face) points INTO the cell.
    const faces = (x: number, y: number) => {
      const c = this.maze.at(x, y);
      const [wx, wz] = this.maze.cellToWorld(x, y);
      const out: { pos: [number, number]; yaw: number; perimeter: boolean }[] = [];
      if (c.n) out.push({ pos: [wx, wz - half + inset], yaw: 0, perimeter: y === 0 });
      if (c.s) out.push({ pos: [wx, wz + half - inset], yaw: Math.PI, perimeter: y === this.maze.rows - 1 });
      if (c.w) out.push({ pos: [wx - half + inset, wz], yaw: Math.PI / 2, perimeter: x === 0 });
      if (c.e) out.push({ pos: [wx + half - inset, wz], yaw: -Math.PI / 2, perimeter: x === this.maze.cols - 1 });
      return out;
    };

    const pick = (x: number, y: number) => {
      const f = faces(x, y);
      if (!f.length) return null;
      return f.find((o) => o.perimeter) ?? f[0];
    };

    const first = pick(cellX, cellY);
    if (first) return { pos: first.pos, yaw: first.yaw, cell: [cellX, cellY] };

    // Deepest-first fallback: every candidate is still a long walk from spawn.
    const order = [...field.keys()]
      .filter((i) => field[i] > 0)
      .sort((a, b) => field[b] - field[a]);
    for (const i of order) {
      const x = i % this.maze.cols, y = (i / this.maze.cols) | 0;
      const f = pick(x, y);
      if (f) return { pos: f.pos, yaw: f.yaw, cell: [x, y] };
    }
    // Unreachable in practice: a maze with no walls at all.
    const [wx, wz] = this.maze.cellToWorld(cellX, cellY);
    return { pos: [wx, wz], yaw: 0, cell: [cellX, cellY] };
  }

  private unlockDoor() {
    // The exit announces itself. Both are already in the scene; only their
    // levels change, so this can never cost a shader recompile.
    this.setBeaconLevel(CFG.door.beacon.opacityOpen);
    if (this.doorHalo) {
      (this.doorHalo.material as THREE.SpriteMaterial).opacity = CFG.door.haloOpacityOpen;
    }
    if (this.doorLight) this.doorLight.intensity = CFG.door.lightIntensityOpen;
    this.doorUnlocked = true;
    /**
     * Guarded, not `this.door!`. The UI lane hit
     * `TypeError: Cannot read properties of null (reading 'material')` here via
     * `debugCollectAllGems()`, because the non-null assertion is a compile-time
     * claim the runtime does not honour: `door` is genuinely null until
     * `placeGemsAndDoor()` runs, and a hook fired during load reaches this first.
     * `updateDoor()` directly below already checks `if (!this.door)`, so the
     * assertion here was also the only inconsistent dereference of the pair.
     * Unlocking is still recorded either way — the emissive is cosmetic.
     */
    if (this.door) {
      // The leaf has no emissive of its own; the beacon above it does the work.
    }
    this.events.onDoorUnlocked();
  }

  private updateDoor() {
    if (!this.door) return;
    const dx = this.door.position.x - this.player.position.x;
    const dz = this.door.position.z - this.player.position.z;
    const dist = Math.hypot(dx, dz);
    if (!this.doorUnlocked || dist > CFG.door.triggerRadius) return;

    /**
     * YOU HAVE TO BE ON THE DOOR'S SIDE OF THE WALL.
     *
     * User: "I went through the door even though I was at the wall on the
     * opposite side behind the door. Major bug." It was, and this test was a bare
     * 2D distance: the door is set flush into a wall face, inset only
     * `wallThickness / 2` = 0.175m into its own cell, so the centre of the cell on
     * the FAR side of that wall is roughly 2m from the door's world position —
     * comfortably inside a 2.4m radius. Walking down the corridor behind the exit
     * teleported you through it, through solid stone.
     *
     * Two conditions, because either alone leaves a hole:
     *
     *  - FRONT SIDE. The door's local +Z faces into its own cell (`findDoorWall`
     *    picks the yaw for exactly that), so the player must be on the positive
     *    side of the door's plane. This is what the reported bug needed: from
     *    behind the wall the dot product is negative.
     *  - LINE OF SIGHT. The dot test alone still admits a player who is on the
     *    right side of the plane but around a corner — diagonally adjacent through
     *    a different wall, which a 2.4m radius reaches on a 4m grid. The maze
     *    already knows how to answer this.
     *
     * The margin keeps the plane itself out of the trigger, so standing exactly in
     * the doorway cannot flicker between states on floating-point noise.
     */
    const yaw = this.door.rotation.y;
    const frontX = Math.sin(yaw), frontZ = Math.cos(yaw);
    const onFront = (-dx) * frontX + (-dz) * frontZ;
    if (onFront < CFG.door.triggerFrontMargin) return;
    if (!this.maze.hasLineOfSight(
      this.player.position.x, this.player.position.z,
      this.door.position.x, this.door.position.z,
    )) return;
    if (!this.gateePlayed) {
      this.gateePlayed = true;
      // Hard requirement from the brief: "Reaching the unlocked door -> gate1.ogg".
      // It now scores the door OPENING rather than a win screen, which is what the
      // sample always sounded like it was for.
      this.audio.play('gate', { volume: 0.95 });
    }
    /**
     * THE DOOR IS NO LONGER AN ENDING.
     *
     * This used to call `win()`, which set phase 'won' and put the three-line card
     * up as a terminal screen. The card said "Or so he lets you think. There is no
     * escape… Not even death…" over a game that had just let you escape, which
     * made the best line in the build into a boast.
     *
     * Now it starts the loop. The card still shows — see `beginLoop` — but it
     * shows as the middle of a sequence that ends with the player standing in a
     * new maze watching the door shut behind them.
     */
    this.beginLoop();
  }

  // ---- the loop ------------------------------------------------------------

  /**
   * Enter the transition. Called from `updateDoor()` when the player reaches the
   * unlocked exit, and from the `__TESTHOOK_LOOP_NOW` hook.
   *
   * The player controller is handed over here rather than merely ignored: keys
   * are cleared and the phase leaves 'playing', so `updatePlay` (and with it the
   * monster, the collision solver and the catch check) stops running entirely.
   * Trying to script the camera while the controller still integrates velocity
   * produces a fight, not a move — the controller would resolve collisions
   * against the doorway and shove the player back out of it.
   */
  private beginLoop() {
    if (this.phase !== 'playing') return;
    this.setPhase('transition');
    this.setLoopStage('opening');
    this.loopFade = 0;
    // Drop anything held down. Without this, a player sprinting into the door
    // resumes sprinting the instant the new maze starts, having "held" the key
    // through eight seconds of cutscene they could not act during.
    this.keys.clear();
    this.player.velocity.set(0, 0, 0);
    // Whatever he was doing, he is not doing it during the transition. The chase
    // bed would otherwise keep playing over a cutscene.
    this.audio.setChase(false, 0.6);
    /**
     * `win.ogg`, still played, still at the moment the brief names.
     *
     * GAME-SPEC section 2: "All gems collected + door found -> win.ogg". That is
     * this instant, and it stays this instant — the sample now scores a victory
     * that turns out not to be one, which is a better use of it than a screen
     * that ends the game. It plays under the swing and carries through the card.
     */
    this.audio.play('win', { volume: 1 });
    document.exitPointerLock?.();
    this.beginLoopApproach();
    this.emitTransition();
  }

  /**
   * Close the distance to the door WHILE it swings, instead of cutting to it.
   *
   * User: "the animation is kinda erratic." It was, and this was why. The old
   * sequence held the camera wherever the player happened to trip the 2.4m
   * trigger for the whole 1.5s swing, then `beginLoopWalk` did:
   *
   *     this.player.position.x = fromX;   // <- a hard cut, mid-shot
   *     this.player.position.z = fromZ;
   *
   * snapping up to 2.4m and any amount of yaw in a single frame before the walk
   * began. The comment there defended it as avoiding a "sidle" from an oblique
   * approach, which is a real problem — but a teleport is a worse answer to it
   * than the sidle was, and it lands in the middle of the one continuous shot in
   * the game.
   *
   * The swing was dead time. Now the approach uses it: over `openSeconds` the
   * camera eases from wherever you actually stopped to the standoff point square
   * in front of the opening, turning to face through it and levelling its pitch
   * as it goes. By the time the leaf is open you are lined up, so `walking` is a
   * pure forward move and there is no cut anywhere in the sequence.
   */
  private beginLoopApproach() {
    if (!this.door) { this.loopApproach = null; return; }
    const yaw = this.door.rotation.y;
    const thruX = -Math.sin(yaw), thruZ = -Math.cos(yaw);
    const standoff = CFG.loop.standoff;
    this.loopApproach = {
      fromX: this.player.position.x,
      fromZ: this.player.position.z,
      fromYaw: this.player.yawObject.rotation.y,
      fromPitch: this.player.pitchObject.rotation.x,
      toX: this.door.position.x - thruX * standoff,
      toZ: this.door.position.z - thruZ * standoff,
      // Camera looks down -Z; see trap 17. `atan2(dx, dz)` alone aims away.
      toYaw: Math.atan2(-thruX, -thruZ),
    };
  }

  private setLoopStage(s: LoopStage) {
    this.loopStage = s;
    this.loopT = 0;
  }

  private emitTransition() {
    this.events.onTransition({
      active: this.loopStage !== 'idle',
      stage: this.loopStage,
      fade: this.loopFade,
      depth: this.depth,
    });
  }

  /**
   * Drive the transition. Called once per RENDERED frame with wall-clock time, not
   * once per simulation substep.
   *
   * That distinction is the reason this reads `frameDt`. The sim is substepped to
   * keep the AI's clock honest under a bad frame budget (see `frame()`), and a
   * scripted camera move stepped the same way would run at the substep count's
   * mercy — under the harness's 4-17fps that is between one and six times too
   * fast. A cutscene wants the same seconds a human experiences.
   */
  /**
   * Hold the transition at a named beat so it can be photographed.
   *
   * NOT a shortcut and not a fake: the sequence still runs the real code, it just
   * stops advancing its clock when it reaches the requested stage. This exists
   * because of a measured harness fact rather than a preference — under
   * SwiftShader a single screenshot takes SECONDS (the capture above measured
   * 0.18 fps on one beat, i.e. ~5.5s a frame), and the whole transition is nine.
   * A frame burst against a free-running sequence therefore photographs whatever
   * beat happens to be current when the encoder finishes, which in the first run
   * of this meant thirteen consecutive frames of the same finished maze.
   *
   * This is the `Monster.update` freeze from PROGRESS.md's harness notes applied
   * to the transition: neutralise the thing that moves, then burst.
   */
  debugHoldLoopAt(stage: LoopStage | null) {
    this.loopHoldAt = stage;
    return this.loopStage;
  }

  /**
   * Scrub a held stage to a given fraction through itself, and apply that frame.
   *
   * Holding at stage ENTRY is not enough for the two beats that are actually
   * animations: `opening` held at entry photographs a door at 0 degrees, which is
   * a shut door, and `walking` held at entry photographs the standoff point. This
   * advances the held stage's own clock to `k` of its duration and runs one step
   * of the real per-stage code, so what is photographed is a genuine frame of the
   * sequence at a chosen point rather than a pose composed for the camera.
   *
   * Returns what it actually applied, so a beat script can assert the swing
   * angle rather than trusting that the scrub took.
   */
  debugScrubLoop(k: number) {
    if (this.loopStage === 'idle') return null;
    const L = CFG.loop;
    const spans: Record<string, number> = {
      opening: L.openSeconds,
      walking: L.walkSeconds,
      fadeout: L.fadeOutSeconds,
      card: L.cardSeconds,
      fadein: L.fadeInSeconds + L.shutDelaySeconds,
      shutting: L.shutSeconds + L.vanishDelaySeconds,
      vanishing: L.vanishSeconds,
    };
    const span = spans[this.loopStage] ?? 1;
    // Just short of the boundary, so the scrub cannot tip the stage over into the
    // next one and photograph a beat the caller did not ask for.
    this.loopT = Math.min(Math.max(0, k), 0.999) * span;

    // Re-run the stage's visual write at the new time WITHOUT advancing, by
    // stepping with dt 0 through the hold. The hold is dropped for exactly one
    // call so the switch body runs.
    const held = this.loopHoldAt;
    this.loopHoldAt = null;
    const before = this.loopT;
    this.updateLoop(0);
    this.loopT = before;
    this.loopHoldAt = held;

    const leaf = (this.door?.userData?.leaf ?? null) as THREE.Group | null;
    const arrival = (this.arrivalDoor?.userData?.leaf ?? null) as THREE.Group | null;
    return {
      stage: this.loopStage,
      t: Math.round(this.loopT * 1000) / 1000,
      span,
      fade: Math.round(this.loopFade * 1000) / 1000,
      exitLeafDeg: leaf ? Math.round((leaf.rotation.y * 180) / Math.PI * 10) / 10 : null,
      arrivalLeafDeg: arrival ? Math.round((arrival.rotation.y * 180) / Math.PI * 10) / 10 : null,
      playerX: Math.round(this.player.position.x * 100) / 100,
      playerZ: Math.round(this.player.position.z * 100) / 100,
      depth: this.depth,
    };
  }

  /** Release a held stage and let the sequence run on. */
  debugReleaseLoop() {
    this.loopHoldAt = null;
    return this.loopStage;
  }

  /**
   * Step from the currently-held beat to the next one, and hold there.
   *
   * The obvious way to walk the sequence beat by beat — release, then re-hold at
   * the next stage — has a race in it: between the two calls the sequence runs
   * free at whatever the frame rate happens to be, and at 0.2-20 fps it can shoot
   * straight past the stage being aimed at. That is not a hypothetical; the first
   * version of the loop capture lost thirteen frames to exactly this class of
   * gap.
   *
   * This closes it by driving the advance synchronously: hold is dropped, the
   * stage is pushed to its end, one update is run to trigger the transition into
   * the next stage, and the hold is re-armed on whatever it landed on — all
   * inside one call, with no frames in between for the sequence to escape
   * through.
   */
  debugStepLoop() {
    if (this.loopStage === 'idle') return null;
    const L = CFG.loop;
    const spans: Record<string, number> = {
      opening: L.openSeconds,
      walking: L.walkSeconds,
      fadeout: L.fadeOutSeconds,
      card: L.cardSeconds,
      fadein: L.fadeInSeconds + L.shutDelaySeconds,
      shutting: L.shutSeconds + L.vanishDelaySeconds,
      vanishing: L.vanishSeconds,
    };
    const from = this.loopStage;
    /**
     * A PRE-ARMED hold wins.
     *
     * A caller that has already said "hold at `card`" is asking to stop there
     * however many stages away it is, and re-arming on whatever one step happened
     * to reach would silently ignore that. This mattered in practice: two capture
     * runs stepped out of `fadeout`, hit a slow frame, and sailed through `card`
     * into `shutting` — so the beat named "the card" photographed the door
     * closing, and the card frame was simply never taken.
     *
     * With the target pre-armed, the step advances at least one stage and the
     * hold in `updateLoop` stops the sequence dead when it arrives, no matter how
     * many frames the intervening stages take.
     */
    const target = this.loopHoldAt;
    /**
     * If the caller pre-armed the stage it wants and we are ALREADY there, do
     * nothing. Stepping would carry the sequence past the beat being asked for.
     */
    if (target && target === from) {
      return { from, to: from, holdAt: target, depth: this.depth, noop: true };
    }
    this.loopHoldAt = null;
    // Park the clock just under the boundary, then step it over with one small
    // dt. `fadeout` additionally gates on `loopFade` reaching 1, so it is forced.
    this.loopT = (spans[from] ?? 1);
    if (from === 'fadeout') this.loopFade = 1;
    this.updateLoop(0.001);
    /**
     * Re-arm on the requested target if there is one, otherwise on wherever the
     * step landed — but ONLY if the target has not already been passed. If it
     * has, hold here instead: an unreachable hold would let the sequence run
     * free to the end, which is the failure that lost the card frame twice.
     *
     * `fadeout` is the case that exposed this. Coming out of `walking` the fade
     * has usually already reached 1 (the walk overlaps its own fade-out by
     * `fadeHeadStart`), so a single step jumps `walking -> fadeout -> card` and a
     * hold armed on `fadeout` could never fire.
     */
    const order: LoopStage[] = [
      'opening', 'walking', 'fadeout', 'card', 'fadein', 'shutting', 'vanishing', 'idle',
    ];
    const passed = target !== null && order.indexOf(this.loopStage) > order.indexOf(target);
    this.loopHoldAt = (target && !passed) ? target : this.loopStage;
    return {
      from, to: this.loopStage, holdAt: this.loopHoldAt,
      requested: target, passed, depth: this.depth,
    };
  }

  private loopHoldAt: LoopStage | null = null;
  /** The eased approach that now runs under the door swing. See `beginLoopApproach`. */
  private loopApproach: {
    fromX: number; fromZ: number; fromYaw: number; fromPitch: number;
    toX: number; toZ: number; toYaw: number;
  } | null = null;

  private updateLoop(dt: number) {
    const L = CFG.loop;
    /**
     * Held for the harness. The stage's own visual state has already been written
     * by the frame that reached it, so holding here freezes a fully-realised beat
     * rather than a half-applied one — the door stays at whatever angle the last
     * advance left it, the fade stays at its value, the card stays up.
     */
    if (this.loopHoldAt !== null && this.loopStage === this.loopHoldAt) {
      this.emitTransition();
      return;
    }
    this.loopT += dt;
    const leaf = (this.door?.userData?.leaf ?? null) as THREE.Group | null;

    // Smoothstep. A linear swing starts and stops instantly, which reads as a
    // prop being moved rather than as mass on a hinge.
    const ease = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

    switch (this.loopStage) {
      case 'opening': {
        const k = ease(this.loopT / L.openSeconds);
        if (leaf) leaf.rotation.y = k * L.openAngle;
        // The approach rides the same eased k as the swing, so the camera settles
        // into place exactly as the leaf finishes moving — one gesture, not two.
        const ap = this.loopApproach;
        if (ap) {
          this.player.position.x = ap.fromX + (ap.toX - ap.fromX) * k;
          this.player.position.z = ap.fromZ + (ap.toZ - ap.fromZ) * k;
          this.player.yawObject.rotation.y =
            ap.fromYaw + shortestAngle(ap.fromYaw, ap.toYaw) * k;
          this.player.pitchObject.rotation.x = ap.fromPitch * (1 - k);
        }
        if (this.loopT >= L.openSeconds) {
          this.beginLoopWalk();
          this.setLoopStage('walking');
        }
        break;
      }

      case 'walking': {
        const w = this.loopWalk;
        const k = ease(this.loopT / L.walkSeconds);
        if (w) {
          this.player.position.x = w.fromX + (w.toX - w.fromX) * k;
          this.player.position.z = w.fromZ + (w.toZ - w.fromZ) * k;
          // Turn to face squarely through the opening as we go. `shortestAngle`
          // matters: interpolating raw yaws across the +/-PI seam spins the camera
          // the long way round, which is 300 degrees of unwanted pirouette in the
          // middle of the one shot that has to read as walking forward.
          this.player.yawObject.rotation.y =
            w.fromYaw + shortestAngle(w.fromYaw, w.toYaw) * k;
          // Level the head. Whatever the player was looking at when they touched
          // the trigger, the shot through the door wants the horizon.
          this.player.pitchObject.rotation.x = w.fromPitch * (1 - k);
        }
        /**
         * The fade overlaps the move: a walk that completes and THEN fades is
         * two events, and one that fades while it is still moving is one.
         *
         * Note what this is NOT doing. It is not what hides the far side of the
         * door — there is nothing behind that door (it is set into a SOLID face
         * of a generated maze), and an earlier version of this leaned on the fade
         * to cover the gap and failed: solving the eased move showed the camera
         * crossing the door plane at t=1.25s of a 2.3s walk with the fade only at
         * 0.61, and the captured frame at 62% showed an open corridor and red sky
         * through what should be a wall.
         *
         * `CFG.loop.walkDistance` is negative for that reason — the camera stops
         * IN the threshold and never crosses the plane, so the far side is
         * unreachable by the camera at any fade value on any seed. This is free
         * to be tuned for feel.
         */
        if (this.loopT > L.walkSeconds - L.fadeHeadStart) {
          this.loopFade = Math.min(
            1,
            (this.loopT - (L.walkSeconds - L.fadeHeadStart)) / L.fadeOutSeconds,
          );
        }
        if (this.loopT >= L.walkSeconds) this.setLoopStage('fadeout');
        break;
      }

      case 'fadeout': {
        // Finish whatever the overlap above did not.
        this.loopFade = Math.min(1, this.loopFade + dt / L.fadeOutSeconds);
        if (this.loopFade >= 1) {
          /**
           * THE REBUILD HAPPENS HERE, UNDER A FULLY BLACK SCREEN.
           *
           * `regenerate()` disposes a merged wall mesh, builds a new maze, merges
           * new geometry and runs several BFS passes. That is tens of
           * milliseconds on a desktop and can be a second or more under a software
           * rasterizer — a visible hitch anywhere else, and invisible here because
           * there is nothing on screen to hitch. It is the same reason a loading
           * screen exists at all.
           */
          this.regenerate();
          this.setLoopStage('card');
        }
        break;
      }

      case 'card': {
        // The world is already rebuilt and the player is already standing in it;
        // the screen is black and React is drawing the card over it.
        if (this.loopT >= L.cardSeconds) this.setLoopStage('fadein');
        break;
      }

      case 'fadein': {
        this.loopFade = Math.max(0, 1 - this.loopT / L.fadeInSeconds);
        if (this.loopT >= L.fadeInSeconds + L.shutDelaySeconds) {
          this.loopFade = 0;
          this.setLoopStage('shutting');
          // The same sample that opened it. Reusing `gate` rather than adding a
          // sound closes the loop acoustically too: the noise that meant "you got
          // out" is now also the noise that means you did not.
          this.audio.play('gate', { volume: 0.8 });
        }
        break;
      }

      case 'shutting': {
        const k = ease(this.loopT / L.shutSeconds);
        const al = (this.arrivalDoor?.userData?.leaf ?? null) as THREE.Group | null;
        if (al) al.rotation.y = L.openAngle * (1 - k);
        if (this.loopT >= L.shutSeconds + L.vanishDelaySeconds) this.setLoopStage('vanishing');
        break;
      }

      case 'vanishing': {
        /**
         * And then there is no door.
         *
         * The user asked for it to shut "and disappear behind you… no door in the
         * wall, no seam, nothing to go back through". So it is faded out rather
         * than cut: a cut would be a pop the player's eye catches as a rendering
         * fault, whereas a fade at this light level reads as the thing simply
         * ceasing to have been there — which is the more frightening claim.
         *
         * Transparency is switched on only for this beat. Leaving `transparent`
         * true permanently would put the door in the render's transparent pass
         * for its whole life, where it sorts against the dust and the halos and
         * can be drawn in the wrong order.
         */
        const k = Math.min(1, this.loopT / L.vanishSeconds);
        if (this.arrivalDoor) {
          this.arrivalDoor.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            const m = mesh.material as THREE.MeshStandardMaterial;
            m.transparent = true;
            m.opacity = 1 - k;
            m.depthWrite = k < 0.5;
          });
        }
        if (k >= 1) {
          this.disposeDoor(this.arrivalDoor);
          this.arrivalDoor = null;
          this.endLoop();
        }
        break;
      }

      default:
        break;
    }

    this.emitTransition();
  }

  /**
   * Snapshot the scripted walk-through.
   *
   * The destination is derived from the DOOR's own orientation, not from where
   * the camera happens to point. `door.rotation.y` is set by `findDoorWall` such
   * that the door's local +Z faces INTO the cell — i.e. back at the player — so
   * the direction *through* the doorway is the door's local -Z, which in world
   * terms is `(-sin(yaw), -cos(yaw))`.
   *
   * Getting that sign wrong would walk the player backwards away from the door
   * they just opened, and it would look like a bug rather than read as one, which
   * is why it is derived here once rather than eyeballed. Trap 15 in PROGRESS.md
   * is the same class of error one layer up.
   */
  private beginLoopWalk() {
    if (!this.door) { this.loopWalk = null; return; }
    const yaw = this.door.rotation.y;
    // Through the doorway, in world XZ.
    const thruX = -Math.sin(yaw);
    const thruZ = -Math.cos(yaw);
    const L = CFG.loop;

    // Start from a point squarely in front of the opening rather than from
    // wherever the player brushed the 2.4m trigger — approaching a door at an
    // oblique angle and then walking straight through it clips the jamb.
    // The approach under the swing has already put the camera here and pointed it
    // through the opening, so these are a description of where it IS, not a
    // destination to jump to.
    const standoff = CFG.loop.standoff;
    const fromX = this.door.position.x - thruX * standoff;
    const fromZ = this.door.position.z - thruZ * standoff;

    /**
     * The camera looks down -Z, so the yaw that faces the direction
     * `(thruX, thruZ)` is `atan2(-thruX, -thruZ)`. This is PROGRESS.md trap 17
     * exactly — `atan2(dx, dz)` alone points the camera precisely away from the
     * target, and it has already cost this project a cycle once, on a probe that
     * photographed a clean empty corridor and read as "the gem does not render".
     */
    const toYaw = Math.atan2(-thruX, -thruZ);

    this.loopWalk = {
      fromX,
      fromZ,
      toX: this.door.position.x + thruX * L.walkDistance,
      toZ: this.door.position.z + thruZ * L.walkDistance,
      fromYaw: this.player.yawObject.rotation.y,
      toYaw,
      fromPitch: this.player.pitchObject.rotation.x,
    };
    // NO SNAP. `beginLoopApproach` eased the camera to this point under the door
    // swing; writing the position again here would be a no-op at best, and at
    // worst — if the approach was interrupted or held by the harness — a
    // one-frame jump of exactly the kind this change exists to remove.
  }

  /**
   * Build the next maze and put the player in it. Runs with the screen black.
   *
   * Order matters and is not arbitrary:
   *   1. dispose the old collectibles FIRST, because `disposeCollectibles` reads
   *      `this.door` and the exit door belongs to the maze being torn down;
   *   2. dispose the old world;
   *   3. build the new maze and world, which rewrites `this.maze` — everything
   *      after this point must see the NEW maze;
   *   4. re-point the monster at it, before anything asks him to path;
   *   5. place gems and the exit, which also sets the player's spawn and calls
   *      `spawnNearPlayer`.
   */
  private regenerate() {
    this.depth++;
    const L = CFG.loop;

    this.disposeCollectibles();
    const old = this.world;
    this.disposeWorld(old);

    /**
     * A NEW SEED, derived rather than random, so a run is still reproducible.
     *
     * `Date.now() & 0xffff` at construction is what makes every session different
     * (PROGRESS.md trap 6b), and that is preserved — but deriving each loop's seed
     * from the first one means a given starting seed produces the same SEQUENCE of
     * mazes. Without that, nothing about the loop could be reproduced from a bug
     * report, and "the door was unreachable on my fourth maze" would be
     * uninvestigable.
     */
    const seed = (Math.imul(this.seed + this.depth, 0x9e3779b1) ^ (this.depth * 0x85ebca6b)) >>> 0;

    // Escalation: a slightly larger maze each time, capped. Kept ODD because the
    // recursive backtracker's carve and the perimeter both assume the grid the
    // rest of the build was measured on; an even count shifts every cell centre
    // by half a cell relative to the door-placement inset arithmetic.
    const grow = Math.min(
      L.maxCells - CFG.maze.cols,
      (this.depth - 1) * L.growCellsPerLoop,
    );
    const cols = CFG.maze.cols + Math.max(0, grow);
    const rows = CFG.maze.rows + Math.max(0, grow);

    this.buildMazeAndWorld(seed, cols, rows);

    /**
     * RE-POINT THE MONSTER AT THE NEW MAZE.
     *
     * `Monster` holds its own `maze` reference, taken in its constructor, and uses
     * it for `distanceField`, `path`, `isOpen`, `hasLineOfSight` and `worldToCell`
     * — several times per frame. Left pointing at the disposed maze he would path
     * against a layout that no longer exists: walking through the new maze's walls
     * and standing still in front of its corridors, with no error anywhere,
     * because a stale Maze object is a perfectly valid object.
     *
     * The field is `private` and `monster.ts` is not this lane's file, so it is
     * written through a narrow cast rather than by widening that class's surface.
     * The cast names the exact field and nothing else, so if the field is ever
     * renamed this is a compile error rather than a silent no-op.
     */
    (this.monster as unknown as { maze: Maze }).maze = this.maze;

    /**
     * MONSTER-SPEED ESCALATION IS DELIBERATELY NOT IMPLEMENTED, and this comment
     * is here so the next agent does not "finish" it.
     *
     * The obvious move is a `speedScale` on the monster. It does not exist, and
     * adding one from this file would be a stub: `Monster.update` derives its
     * target speed directly from `CFG.monster.walkSpeed / chaseSpeed /
     * chaseLungeSpeed`, and `CFG` is exported `as const`, so a field written from
     * here would be read by nothing. It would look like escalation in a diff,
     * measure as escalation in a config dump, and change the monster not at all —
     * PROGRESS.md trap 16, "assert that your assertion has subjects".
     *
     * Doing it properly means a multiplier applied at the `targetSpeed` selection
     * in `monster.ts:2058`, which is another lane's file. `CFG.loop`'s
     * `monsterSpeedPerLoop` and `maxMonsterSpeedScale` are the tuned values,
     * already capped below the player's 5.0 sprint, ready for whoever owns that
     * file. Until then the escalation that ships is the maze growth above, which
     * is real and measurable.
     */

    this.placeGemsAndDoor();
    this.placePlayerAtSpawn();
    // `placeGemsAndDoor` ends with spawnNearPlayer, which also calls resetHunt() —
    // clearing lostTimer, chaseElapsed, chaseCooldown, the spent path, the search
    // probes and the director's beat clock. Without it the new maze would inherit
    // a partly-elapsed beat aimed at a cell in a maze that no longer exists.
    this.monster.spawnNearPlayer(this.player.position);

    // The way you came in, standing behind you, ready to shut.
    this.buildArrivalDoor();

    this.events.onGems(0, this.gems.length);
  }

  /**
   * The door on the far side: the one you just walked through, which is about to
   * close and then stop existing.
   *
   * It is placed BEHIND the player's new spawn, facing them, so that when the
   * fade comes up it is in frame if they turn around — and `spawnYaw()` has
   * already pointed them down the longest corridor, i.e. away from it. That is
   * the shot: you are looking into a new maze, you hear it shut behind you, and
   * when you turn there is nothing there.
   *
   * It is NOT a collider and it is NOT `this.door`. It has no halo, no light and
   * no trigger — walking into where it was does nothing, because by the time the
   * player can move it has already been disposed.
   */
  private buildArrivalDoor() {
    const door = buildDoorMesh(CFG.maze.cell, this.world?.wallMaps ?? null);

    if (this.spawnWall) {
      /**
       * Set INTO the wall the player is backed against, exactly like the exit
       * door. It used to be dropped free-standing 1.84m behind them, which meant
       * that once it shut and vanished the player was left in open corridor and
       * the moment read as "there was never a door" rather than "the way back is
       * gone". The wall is the whole point: it is what the door was in.
       */
      door.position.set(this.spawnWall.pos[0], 0, this.spawnWall.pos[1]);
      door.rotation.y = this.spawnWall.yaw;
    } else {
      // No walled face anywhere near spawn — fall back to the old behaviour so a
      // pathological maze still gets a door rather than none.
      const yaw = this.player.yawObject.rotation.y;
      const behindX = Math.sin(yaw), behindZ = Math.cos(yaw);
      const dist = CFG.maze.cell * 0.46;
      door.position.set(
        this.player.position.x + behindX * dist, 0,
        this.player.position.z + behindZ * dist,
      );
      door.rotation.y = Math.atan2(-behindX, -behindZ);
    }
    // It arrives OPEN — the player just came through it.
    const leaf = door.userData.leaf as THREE.Group | undefined;
    if (leaf) leaf.rotation.y = CFG.loop.openAngle;
    this.scene.add(door);
    this.arrivalDoor = door;
  }

  /** Hand control back. The new maze is live and the player can move. */
  private endLoop() {
    this.setLoopStage('idle');
    this.loopFade = 0;
    this.loopWalk = null;
    this.emitTransition();
    this.setPhase('playing');
    this.audio.duck(1, 0.5);
  }

  /**
   * The flashlight. Infinite, by user decree — there is no battery and there never
   * will be. The flicker is purely a dread signal: it stutters when Billy is near
   * and you have not seen him yet, and it goes rock steady the instant he commits
   * to a chase, because strobing during a chase is irritating rather than scary.
   */
  private updateFlashlight(dt: number) {
    const f = CFG.flashlight;

    // Beam trails the camera slightly, like a torch held in a hand rather than
    // bolted to the skull.
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    this.camera.getWorldDirection(camDir);

    const chasing = this.monster?.state === 'chase';
    // The brief wants the beam rock steady during an active chase. Pinning the
    // flicker to 1 (below) is most of it, but the follow-lag is what makes the beam
    // swing: during a chase you are sprinting by definition, and the beam inherits
    // the sprint's head bob and camera roll through the camera's world position.
    // Locking the beam to the eye exactly when the brief asks for steadiness.
    const follow = chasing ? f.followLag * 2.4 : f.followLag;

    this.flashlight.position.lerp(camPos.clone().add(new THREE.Vector3(0, -0.12, 0)), Math.min(1, follow * dt));
    const desiredTarget = camPos.clone().add(camDir.multiplyScalar(12));
    this.flashlight.target.position.lerp(desiredTarget, Math.min(1, (follow * 0.75) * dt));
    this.flashlight.target.updateMatrixWorld();

    /**
     * "...the flashlight stuttering because he is close AND YOU CAN'T SEE HIM YET"
     * — GAME-SPEC section 1. The second half of that sentence was missing.
     *
     * `proximityPressure` is pure straight-line distance and knows nothing about
     * walls. In a 21x21 grid of 4 m cells the flicker band (18 m down to 6 m) is
     * 4.5 to 1.5 cells of Euclidean range, which routinely spans three or four
     * walls: the beam was stuttering hardest at the players who were safest,
     * because he happened to be standing on the other side of the masonry. That
     * makes the tell a liar in both directions — it fires when he is unreachable,
     * and it says nothing extra when he is actually in your corridor.
     *
     * The fix uses the sightline `updatePlay` already computed this step, so it
     * costs nothing. It does not switch the flicker OFF when he is visible, which
     * would be worse: it damps it. Once you can see him the dread signal has done
     * its job and the picture should hand over to your eyes, but a beam that goes
     * abruptly steady the instant he steps into view reads as a bug, and the
     * transition itself would leak information. A 0.45 multiplier keeps the light
     * alive and nervous while making the blind case unmistakably the loud one.
     */
    const rawPressure = this.monster?.proximityPressure ?? 0;
    const pressure = this.lastLineOfSight ? rawPressure * 0.45 : rawPressure;
    // Published for the post chain, so grain/vignette/aberration clench on exactly
    // the same signal the beam stutters on.
    this.dreadPressure = pressure;

    let target = 1;
    if (chasing && f.flicker.steadyDuringChase) {
      target = 1;
      this.flickerPhase = 0;
    } else if (pressure > 0.001) {
      // Stutter rate and depth both scale with how close he is.
      this.flickerPhase += dt * (7 + pressure * 34);
      const n =
        Math.sin(this.flickerPhase) * 0.5 +
        Math.sin(this.flickerPhase * 2.7 + 1.3) * 0.3 +
        Math.sin(this.flickerPhase * 6.1) * 0.2;
      const depth = 0.16 + pressure * 0.7;
      target = 1 - Math.max(0, n) * depth;
      // Occasional full dropout at close range — the beat that makes people stop.
      if (pressure > 0.55 && Math.random() < pressure * 0.035) target = 0.05;
    }

    this.flickerValue += (target - this.flickerValue) * Math.min(1, 22 * dt);
    this.flashlight.intensity = f.intensity * this.flickerValue;

    /**
     * The viewmodel torch is lit almost entirely by its own beam bouncing back off
     * the wall in front of you — there is no other light source near your hand. So
     * when the beam stutters because Billy is close, the hand has to stutter with
     * it; a rock-steady torch body in front of a flickering beam is the tell that
     * the two are unrelated objects. `Player` applies `viewmodel.spillGain`
     * internally so the torch never goes fully black during a dropout (a hand that
     * vanishes reads as a rendering bug, not a scare). The brief's rule is
     * unaffected: during a chase `target` is pinned to 1 above, so the torch goes
     * steady exactly when the beam does.
     *
     * Guarded because `frame()` treats `player` as possibly-absent everywhere else
     * (`if (this.player)`, `this.monster?.`); an unguarded write here would be the
     * single dereference that could throw if the loop is ever started earlier.
     */
    if (this.player) this.player.flashlightSpill = this.flickerValue;
  }

  private catchPlayer() {
    if (this.phase !== 'playing') return;
    this.setPhase('caught');
    this.audio.setChase(false, 0.15);
    // Ducks everything that should get out of the way in 60ms, drops the scare
    // in on its own bus (past the duck, so it cannot attenuate itself), holds
    // for 0.9s, then eases back so the silence after the scare is audible.
    this.audio.jumpscare(1);
    document.exitPointerLock?.();

    // The spec requires billyScare.png, then the game-over window ONE SECOND
    // later. The old check compared performance.now() once per RENDERED frame,
    // and the catch frame costs so much (jumpscare one-shot, audio duck, chase
    // fade, phase change) that the harness measured 0.617fps there — the next
    // frame arrived ~1600ms later, so the condition was already true on its first
    // evaluation and 'caught' and 'gameover' landed on the same tick. There was no
    // beat at all. Wall-clock timer, so the beat survives any frame budget.
    if (this.scareBeatTimer !== undefined) clearTimeout(this.scareBeatTimer);
    this.scareBeatTimer = setTimeout(() => {
      this.scareBeatTimer = undefined;
      if (this.phase === 'caught') this.setPhase('gameover');
    }, 1000) as unknown as number;
  }

  /** Wall-clock handle for the one-second scare beat; see catchPlayer(). */
  private scareBeatTimer?: number;

  /**
   * The terminal win screen. No longer on the path through the door — that is now
   * `beginLoop()` — but kept, live and reachable, for three reasons:
   *
   *  1. GAME-SPEC section 2 lists a win screen with `son.png`, Play Again and Home
   *     as a hard requirement. The screen and its wiring still exist and still
   *     work; what changed is which event triggers them.
   *  2. It is the honest place to put an ending if the user ever wants one — a
   *     depth cap, say, where the loop finally lets you out.
   *  3. Deleting it would take `win.ogg` with it. The brief's line is "all gems
   *     collected + door found -> win.ogg", which is a moment the loop still has:
   *     `beginLoop` plays it over the card, so the requirement is met on the path
   *     the game actually takes.
   *
   * Exposed as `__TESTHOOK_WIN_SCREEN` so the end-screen regression checks can
   * still reach it without a bespoke path through the game.
   */
  debugWinScreen() {
    if (this.phase !== 'playing') return false;
    this.setPhase('won');
    this.audio.setChase(false, 0.4);
    this.audio.play('win', { volume: 1 });
    document.exitPointerLock?.();
    return true;
  }

  // ---- debug affordances for the capture harness ---------------------------
  // These move the player and the monster through the ordinary code paths. They
  // never short-circuit a result: collecting via the hook still fires the gem
  // sound, still counts, and still unlocks the door the normal way.

  /**
   * Stand on a gem.
   *
   * Lands on the gem's own cell centre, NOT at a fixed `+z` offset from it. This
   * is the identical bug already documented and fixed on `debugTeleportToDoor`
   * below, and it made this hook incapable of ever collecting anything:
   * `updateGems()` picks up inside **1.1m**, and the old offset placed the player
   * **2.2m** away — exactly twice the radius, so the pickup could not fire on any
   * seed. It was not intermittent; it was arithmetically dead, and it silently
   * turned every "collect a gem" verification into a no-op that still returned
   * `true`. Measured after the fix: `gems` goes 0 -> 1 on the beat.
   *
   * The gem's cell is walkable by construction (gems are placed on carved maze
   * cells), so the centre is always a legal position and the controller's
   * collision resolution has nothing to push against.
   */
  debugTeleportToGem(i: number) {
    const gem = this.gems.filter((g) => g.visible)[i];
    if (!gem) return false;
    const [cx, cy] = this.maze.worldToCell(gem.position.x, gem.position.z);
    const [wx, wz] = this.maze.cellToWorld(cx, cy);
    this.player.position.set(wx, 0, wz);
    this.player.velocity.set(0, 0, 0);
    return true;
  }

  /**
   * WHAT IS THE CAMERA ACTUALLY LOOKING AT THROUGH THE DOORWAY?
   *
   * Added because two sources disagreed and neither could settle it: a held-and-
   * scrubbed capture measured the open doorway as black, while the user reported
   * "the door still has a wall behind it" from real play. Reasoning about local Z
   * signs had already produced one wrong answer, and an out-of-engine probe could
   * not do better — three is not on `window`, and a bounding-box march is
   * meaningless here because the merged wall mesh's box encloses the entire maze.
   *
   * So the raycast happens in here, where three is imported and the scene graph is
   * real. Samples a grid across the void panel's own extent and names the first
   * few hits along each ray, nearest first. If the void is working, every ray's
   * first hit is `doorVoid`; anything else names the culprit outright.
   */
  debugDoorwayRays(samples = 3) {
    if (!this.door) return { error: 'no door' };
    const panel = this.door.getObjectByName('doorVoid') as THREE.Mesh | undefined;
    if (!panel) return { error: 'no doorVoid panel on the door' };
    this.door.updateWorldMatrix(true, true);

    const geo = panel.geometry as THREE.PlaneGeometry;
    const { width, height } = geo.parameters as { width: number; height: number };
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const rc = new THREE.Raycaster();
    // Sprites raycast against the camera plane, so `Raycaster.camera` must be set
    // or `Sprite.raycast` dereferences null. The halos are sprites.
    rc.camera = this.camera;
    const label = (o: THREE.Object3D) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      return o.name || `${o.type}<${m ? m.type : '?'}>`;
    };

    const rows: unknown[] = [];
    const step = samples > 1 ? 0.7 / (samples - 1) : 0;
    for (let iy = 0; iy < samples; iy++) {
      for (let ix = 0; ix < samples; ix++) {
        const fx = samples > 1 ? -0.35 + ix * step : 0;
        const fy = samples > 1 ? -0.35 + iy * step : 0;
        const target = panel.localToWorld(new THREE.Vector3(fx * width, fy * height, 0));
        rc.set(origin, target.clone().sub(origin).normalize());
        rc.near = 0.01; rc.far = 60;
        const hits = rc.intersectObject(this.scene, true)
          .filter((h) => h.object.visible && (h.object as THREE.Mesh).isMesh);
        rows.push({
          at: [+fx.toFixed(2), +fy.toFixed(2)],
          hits: hits.slice(0, 3).map((h) => `${label(h.object)}@${h.distance.toFixed(2)}`),
        });
      }
    }
    return {
      leafDeg: +((this.door.userData.leaf as THREE.Group).rotation.y * 180 / Math.PI).toFixed(1),
      voidLocalZ: panel.position.z,
      voidWorld: panel.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)),
      camera: origin.toArray().map((v) => +v.toFixed(2)),
      rows,
    };
  }

  /**
   * Scale the beacon's shells to an overall strength.
   *
   * One multiplier over every shell's authored opacity, so the core/soft
   * relationship that gives the column its bloom edge is preserved at any level
   * rather than the two crossing over as it brightens.
   */
  private setBeaconLevel(level: number) {
    if (!this.doorBeacon) return;
    for (const child of this.doorBeacon.children) {
      // The strength lives in a uniform now, not `material.opacity` — the shader
      // multiplies it into the alpha after the rim falloff, so scaling it here
      // dims the whole column without flattening the soft edge that stops it
      // reading as a solid wedge.
      const m = (child as THREE.Mesh).material as THREE.ShaderMaterial;
      m.uniforms.uStrength.value = ((child as THREE.Mesh).userData.baseOpacity as number) * level;
    }
  }

  /**
   * Stand at the exit.
   *
   * This lands the player on the door cell's own centre, NOT at a fixed `+z`
   * offset from the door. The offset version was intermittently broken and the
   * failure was invisible without measuring: it assumed the cell on the door's +z
   * side is open, which for a door placed at the deepest point of a generated
   * maze is often a wall. The player then spawned inside that wall and the
   * controller's collision resolution — correctly — pushed them back out, but
   * sideways, landing them 2.9-3.2m from the door. `updateDoor()` only wins
   * inside 2.4m, so `win()` never fired and the win screen was unreachable.
   *
   * Measured across 6 seeds before the fix: 3 landed at exactly 2.0m and won, 3
   * were displaced to 2.92m / 3.21m / 3.21m and silently stayed in `playing`.
   * That is what made it read as a hard "the win condition never fires" bug to
   * one lane and as "works fine" to another — it is seed-dependent.
   *
   * The door's own cell is walkable by construction (it is a carved maze cell,
   * which is why the door was placed there), so distance 0 is always inside the
   * trigger and collision has nothing to resolve.
   */
  debugTeleportToDoor() {
    if (!this.door) return false;
    const [cx, cy] = this.maze.worldToCell(this.door.position.x, this.door.position.z);
    if (!this.maze.inBounds(cx, cy)) return false;
    const [wx, wz] = this.maze.cellToWorld(cx, cy);
    this.player.position.set(wx, 0, wz);
    this.player.velocity.set(0, 0, 0);
    /**
     * Face the door.
     *
     * Without this the hook left the camera on whatever yaw it carried in from
     * the spawn. That is harmless for firing the exit trigger (a distance test)
     * but useless for anything that wants to LOOK at the door — and it produced a
     * run of "door" screenshots that were actually pictures of a wall, which made
     * the door-surface check silently meaningless. Now the hook leaves the player
     * standing on the door cell, looking at it.
     */
    const dx = this.door.position.x - wx;
    const dz = this.door.position.z - wz;
    if (dx * dx + dz * dz > 1e-6) {
      // Camera forward is -Z, so the yaw that aims at (dx,dz) is atan2(dx,dz)+PI.
      this.player.yawObject.rotation.y = Math.atan2(dx, dz) + Math.PI;
    }
    return true;
  }

  /**
   * The camera's *local* transform — bob, sway, foot-plant nod and sprint FOV,
   * with no world motion in it. At the harness's frame rate a 300ms stride is one
   * frame apart, so a numeric read is the only way to verify player feel.
   */
  debugCameraTransform() {
    return {
      x: this.camera.position.x,
      y: this.camera.position.y,
      /**
       * Mouse pitch lives on `player.pitchObject`; the camera is a CHILD of it
       * and carries only the walk cycle's bob and foot-plant nod. This used to
       * report `camera.rotation.x`, which is therefore ~0 forever even while
       * vertical look works perfectly — a critic nearly failed the renderer on it
       * before proving with screenshots that looking up found the sky and looking
       * down found the floor. The diagnostic was lying, not the camera.
       *
       * Both are reported now, because both are real and they mean different
       * things: `pitch` is where you are aiming, `pitchBob` is the gait.
       */
      pitch: this.player.pitchObject.rotation.x,
      pitchBob: this.camera.rotation.x,
      roll: this.camera.rotation.z,
      fov: this.camera.fov,
      yaw: this.player.yawObject.rotation.y,
      speed: this.player.speed,
      sprinting: this.player.isSprinting,
    };
  }

  /** User-facing master volume, so React does not reach through `private audio`. */
  setMasterVolume(v: number) { this.audio.setMasterVolume(v); }

  /**
   * Freeze the simulation. Rendering continues, so the maze stays behind the pause
   * menu — but the monster stops walking, which means you can no longer be killed
   * while reading the volume slider.
   */
  setPaused(p: boolean) {
    this.paused = p;
    this.audio.duck(p ? 0.35 : 1, 0.25);
  }

  private paused = false;

  /**
   * Force the loop from wherever the player is standing.
   *
   * Iterating a nine-second transition otherwise costs a full playthrough per
   * attempt, and `?gems=1` plus the teleport hook still requires the run to reach
   * the door. This drives the REAL sequence — the same `beginLoop` the trigger
   * calls, the same swing, walk, fade, regeneration and shut. It fakes no outcome
   * and skips no beat; it only removes the walk to the door.
   *
   * The gems are collected and the door unlocked through their ordinary code
   * paths first, so the door is genuinely in its unlocked state when the loop
   * starts — a transition started from a locked door would be testing a state the
   * game cannot reach.
   *
   * Returns the depth the player will arrive at, so a script can assert the
   * counter advanced rather than inferring it from a screenshot.
   */
  debugForceLoop(teleport = true) {
    if (this.phase !== 'playing') return false;
    if (!this.doorUnlocked) this.debugCollectAllGems();
    /**
     * `teleport: false` starts the loop from where the player is actually
     * standing, which is what the staged capture wants: it frames the shut door
     * from down the corridor first, and a teleport onto the door's own cell would
     * throw that shot away between the setup and the first frame. Play and the
     * default hook both keep the teleport, because the point of the hook is not
     * having to walk there.
     */
    if (teleport) this.debugTeleportToDoor();
    this.beginLoop();
    return this.depth + 1;
  }

  /** How many mazes deep, for assertions. */
  get currentDepth() { return this.depth; }

  /**
   * Reset the depth counter. Called when the player goes HOME, not on Retry.
   *
   * The distinction is the whole meaning of the number. Retry is "I died, let me
   * try that maze again" — you died at depth 4, you retry depth 4, and the
   * counter is a fact about the run you are still in. Home is starting over, and
   * a fresh game that opens with "5 deep" on the HUD has given away the entire
   * effect before the player has walked a step: the counter's job is to appear
   * for the first time at the end of the first loop, and it cannot do that if it
   * is already there.
   *
   * The MAZE is deliberately not regenerated here. The menu camera is framed on
   * the current maze by `pickMenuAnchor`, and rebuilding the world underneath a
   * menu that is already composited over it would be a visible hitch for no gain
   * — the next `beginPlay()` starts wherever the player is, and the maze they are
   * about to walk is a maze they have never seen either way.
   */
  resetDepth() {
    this.depth = 1;
    this.emitTransition();
  }

  /**
   * Live GPU resource counts, for the loop's leak gate.
   *
   * three.js frees nothing on its own, so the only honest way to know whether a
   * regeneration leaks is to read the renderer's own accounting across several
   * loops. `programs` is the light-count canary: it must stay flat, because a
   * change in the scene's light count recompiles every material in the game.
   */
  debugMemory() {
    return {
      depth: this.depth,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      programs: this.renderer.info.programs?.length ?? 0,
      gems: this.gems.length,
      gemLights: this.gemLights.length,
      sceneLights: (() => {
        let n = 0;
        this.scene.traverse((o) => { if ((o as THREE.Light).isLight) n++; });
        return n;
      })(),
      maze: this.maze ? `${this.maze.cols}x${this.maze.rows}` : null,
      loopStage: this.loopStage,
    };
  }

  debugCollectAllGems() {
    for (const gem of this.gems) {
      if (!gem.visible) continue;
      gem.visible = false;
      const lit = this.gemLights[this.gems.indexOf(gem)];
      if (lit) lit.intensity = 0;
      this.gemsCollected++;
    }
    this.events.onGems(this.gemsCollected, this.gems.length);
    if (this.gemsCollected >= this.gems.length) this.unlockDoor();
    return this.gemsCollected;
  }

  /**
   * Drop Billy at a given *corridor* distance from the player and let the AI take
   * over.
   *
   * `distance` is metres of walking through open corridor, not straight-line
   * metres. That distinction is the whole point of this rewrite. The previous
   * implementation placed him at a raw world offset directly behind the player
   * with no maze validity check, and in a 21x21 grid of 4m cells a point 9-28m
   * straight back is almost always inside a wall or off the grid. Measured
   * consequence: `__TESTHOOK_SUMMON(9)` reported a straight-line distance of 9.3m
   * while the AI sat in `patrol` with no line of sight — he was buried in masonry,
   * so a critic using this hook to judge chase behaviour was judging a no-op.
   *
   * Snapping to the nearest reachable cell on the BFS distance field fixes both
   * halves: he lands somewhere he can legally stand, and the argument now means
   * the same thing the director and every AI measurement mean by "distance".
   */
  debugSummonMonster(distance: number) {
    const [px, py] = this.maze.worldToCell(this.player.position.x, this.player.position.z);
    if (!this.maze.inBounds(px, py)) return false;
    const field = this.maze.distanceField(px, py);
    const wantCells = Math.max(1, Math.round(distance / this.maze.cellSize));

    let best = -1, bestErr = Infinity;
    for (let i = 0; i < field.length; i++) {
      if (field[i] < 0) continue; // unreachable from the player
      const err = Math.abs(field[i] - wantCells);
      if (err < bestErr) { bestErr = err; best = i; }
    }
    if (best < 0) return false;

    this.monster.spawn(best % this.maze.cols, (best / this.maze.cols) | 0);
    return true;
  }

  /**
   * Everything needed to judge Billy's scale and orientation from a report file
   * instead of from an argument about a screenshot.
   *
   * Returns his real animated world bounding box (measured through the skeleton
   * on this frame, so the mixer has run), the scale `load()` chose, where the
   * mesh is pointing relative to the player, and the two world constants worth
   * asserting against: the wall height he must not exceed and the player's eye
   * line he must read as shorter than.
   */
  debugMonsterMetrics() {
    const bounds = this.monster?.measureWorldBounds() ?? null;
    const facing = this.monster?.facingProbe(this.player.position) ?? null;
    return {
      bounds,
      facing,
      clip: this.monster?.currentClip ?? null,
      state: this.monster?.state ?? null,
      distance: Math.round((this.monster?.distanceToPlayer ?? 0) * 100) / 100,
      posture: this.monster?.postureProbe ?? null,
      boneNames: this.monster?.boneNames ?? [],
      /**
       * Where Billy lands on screen, in pixels, plus how tall he is there.
       *
       * Same lesson as the gem probe: hunting a dark frame by eye for "the
       * brightest cluster" found the flashlight viewmodel's rim highlight twice,
       * and a scale verdict read off the wrong object is worse than no verdict.
       * `screenHeightPx` is the number that actually answers "does he look knee
       * height" — it is his rendered extent, not a world measurement that a
       * camera angle could still make a liar of.
       */
      screen: this.debugMonsterScreen(),
      wallHeight: CFG.maze.wallHeight,
      eyeHeight: this.player.position.y,
      targetHeight: CFG.monster.targetHeight,
      // A caster past the flashlight's shadow-camera far plane cannot darken a
      // pixel, so this is what the shadow gate should be keying off.
      shadowGateDistance: CFG.flashlight.distance + 4,
    };
  }

  /**
   * Park Billy at a fixed straight-line distance in front of the player, facing
   * as the AI would have him face, and hold the AI off him.
   *
   * Needed because the ordinary summon hook hands him to a live director: under
   * the harness's SwiftShader frame rate he closed 7 m and killed the player
   * inside three beats, so every frame meant to show "Billy mid-chase at a known
   * distance" was actually a game-over screen. This places him deterministically
   * on a line the player is already looking down, which is the only way to shoot
   * a like-for-like scale and facing comparison at 4/10/20 m.
   *
   * `freeze` suppresses AI movement only; the mixer keeps running, so what you
   * photograph is a real animating monster and not a bind pose.
   */
  debugPlaceMonster(distance: number, freeze = true) {
    if (!this.monster) return false;
    const p = this.player.position;

    /**
     * Find a cell that is BOTH the requested straight-line distance away AND has
     * clear line of sight to the player, then turn the player to look at it.
     *
     * A raw offset along the view vector does not work and must not be used: in a
     * 21x21 grid of 4m cells the point 4m ahead is usually inside a wall, which
     * is exactly the no-op that made `__TESTHOOK_SUMMON` report a plausible 9.3m
     * while Billy stood buried in masonry — and it invalidated a whole wave of AI
     * verdicts. A photograph of the monster is worthless if he is behind a wall,
     * and the failure looks identical to "the monster did not render".
     *
     * So the search is over real cells, scored on distance error, and hard-gated
     * on `hasLineOfSight`. Aiming the camera is part of the placement rather than
     * a separate LOOK beat because a correct placement the camera is not pointed
     * at produces the same empty corridor as a failed one.
     */
    let best = -1, bestErr = Infinity;
    for (let cy = 0; cy < this.maze.rows; cy++) {
      for (let cx = 0; cx < this.maze.cols; cx++) {
        const [wx, wz] = this.maze.cellToWorld(cx, cy);
        const err = Math.abs(Math.hypot(wx - p.x, wz - p.z) - distance);
        if (err >= bestErr) continue;
        if (!this.maze.hasLineOfSight(wx, wz, p.x, p.z)) continue;
        bestErr = err; best = cy * this.maze.cols + cx;
      }
    }
    if (best < 0) return false;

    const [wx, wz] = this.maze.cellToWorld(best % this.maze.cols, (best / this.maze.cols) | 0);
    this.monster.group.position.set(wx, 0, wz);
    // Face him back at the player, which is what a chase would produce, so the
    // frame answers "does he face me" rather than "where does he happen to look".
    this.monster.group.rotation.y = Math.atan2(p.x - wx, p.z - wz);
    // And point the camera at him. Yaw is measured the same way the player's own
    // controller measures it, so this drives the real transform, not a fake one.
    this.player.yawObject.rotation.y = Math.atan2(wx - p.x, wz - p.z) + Math.PI;
    this.player.pitchObject.rotation.x = 0;
    this.monster.debugFreeze = freeze;
    return true;
  }

  /**
   * Force a monster animation state so a clip can be photographed on demand.
   * Pass null to hand the choice back to the AI.
   */
  debugMonsterClip(name: string | null) {
    if (!this.monster) return false;
    this.monster.debugFrozenClip = name;
    if (name) this.monster.playClip(name, 0);
    return true;
  }

  /**
   * Stand the player a given distance from a gem, looking straight at it, down a
   * clear line — the setup the gem legibility bar is written in ("findable at
   * 4 m, 10 m and 20 m down a corridor").
   *
   * Like `debugPlaceMonster`, the candidate must have line of sight, because a
   * gem correctly hidden behind a wall and a gem that is illegible produce the
   * same black frame and would otherwise be scored the same.
   */
  debugViewGemFrom(index: number, distance: number) {
    /**
     * `index < 0` means "whichever gem can actually be seen from `distance`".
     *
     * Needed because the maze seed changes every run (PROGRESS.md trap 6b) and on
     * many seeds NO cell has line of sight to gem 0 at 20 m — the request silently
     * degrades to the longest sightline that exists, which was 8.94 m on the first
     * run and would have scored a 20 m legibility test against a 9 m frame.
     */
    const gem = index < 0 ? this.debugBestGemForRange(distance) : this.gems[index];
    if (!gem || !gem.visible) return false;
    let best: [number, number] | null = null;
    let bestErr = Infinity;
    for (let cy = 0; cy < this.maze.rows; cy++) {
      for (let cx = 0; cx < this.maze.cols; cx++) {
        const [wx, wz] = this.maze.cellToWorld(cx, cy);
        const err = Math.abs(Math.hypot(wx - gem.position.x, wz - gem.position.z) - distance);
        if (err >= bestErr) continue;
        if (!this.maze.hasLineOfSight(wx, wz, gem.position.x, gem.position.z)) continue;
        bestErr = err; best = [wx, wz];
      }
    }
    if (!best) return false;
    this.player.yawObject.position.set(best[0], this.player.yawObject.position.y, best[1]);
    this.player.yawObject.rotation.y =
      Math.atan2(gem.position.x - best[0], gem.position.z - best[1]) + Math.PI;
    this.player.pitchObject.rotation.x = 0;
    // Keep Billy out of the photograph entirely; this measures the gem.
    if (this.monster) {
      this.monster.debugFreeze = true;
      this.monster.group.position.set(best[0] + 400, 0, best[1] + 400);
    }
    /**
     * Report where the gem lands ON SCREEN, in pixels.
     *
     * Without this, "is the gem visible at 20 m" gets scored by hunting a dark
     * PNG by eye — and the first attempt did exactly that and mistook the
     * flashlight viewmodel's rim highlight for the gem, which would have passed a
     * legibility bar the build was actually failing. Handing back the projected
     * pixel makes the measurement point at a specific place in the frame rather
     * than at whatever happens to be brightest in it.
     */
    this.player.yawObject.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const proj = gem.position.clone().project(this.camera);
    const el = this.renderer.domElement;
    const haloDbg = this.gemHalos[this.gems.indexOf(gem)];
    return {
      halo: haloDbg?.isSprite
        ? {
          scale: Math.round(haloDbg.scale.x * 1000) / 1000,
          visible: haloDbg.visible,
          opacity: Math.round((haloDbg.material as THREE.SpriteMaterial).opacity * 1000) / 1000,
        }
        : 'NO_SPRITE_AT_CHILD_1',
      emissive: Math.round((gem.material as THREE.MeshStandardMaterial).emissiveIntensity * 100) / 100,
      distance: Math.round(Math.hypot(best[0] - gem.position.x, best[1] - gem.position.z) * 100) / 100,
      screenX: Math.round((proj.x * 0.5 + 0.5) * el.width),
      screenY: Math.round((-proj.y * 0.5 + 0.5) * el.height),
      onScreen: Math.abs(proj.x) <= 1 && Math.abs(proj.y) <= 1 && proj.z < 1,
    };
  }

  /**
   * The gem with the longest clear sightline at or beyond `distance` — i.e. the
   * one that can actually answer a legibility question at that range on this
   * seed.
   */
  private debugBestGemForRange(distance: number): THREE.Mesh | null {
    let best: THREE.Mesh | null = null;
    let bestReach = -1;
    for (const gem of this.gems) {
      if (!gem.visible) continue;
      let reach = 0;
      for (let cy = 0; cy < this.maze.rows; cy++) {
        for (let cx = 0; cx < this.maze.cols; cx++) {
          const [wx, wz] = this.maze.cellToWorld(cx, cy);
          const d = Math.hypot(wx - gem.position.x, wz - gem.position.z);
          if (d <= reach || d > distance * 1.35) continue;
          if (!this.maze.hasLineOfSight(wx, wz, gem.position.x, gem.position.z)) continue;
          reach = d;
        }
      }
      if (reach > bestReach) { bestReach = reach; best = gem; }
    }
    return best;
  }

  /** Billy's projected screen position and pixel height on this frame. */
  private debugMonsterScreen() {
    const b = this.monster?.measureWorldBounds();
    if (!b) return null;
    this.camera.updateMatrixWorld(true);
    const el = this.renderer.domElement;
    const toPx = (v: THREE.Vector3) => {
      const p = v.clone().project(this.camera);
      return [
        Math.round((p.x * 0.5 + 0.5) * el.width),
        Math.round((-p.y * 0.5 + 0.5) * el.height),
        p.z,
      ];
    };
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const foot = toPx(new THREE.Vector3(cx, b.min[1], cz));
    const head = toPx(new THREE.Vector3(cx, b.max[1], cz));
    return {
      x: Math.round((foot[0] + head[0]) / 2),
      y: Math.round((foot[1] + head[1]) / 2),
      footY: foot[1],
      headY: head[1],
      screenHeightPx: Math.abs(foot[1] - head[1]),
      onScreen: head[2] < 1,
    };
  }

  /** Release the harness hold and let the director drive him again. */
  debugReleaseMonster() {
    if (!this.monster) return false;
    this.monster.debugFreeze = false;
    this.monster.debugFrozenClip = null;
    return true;
  }

  private setPhase(p: GamePhase) {
    this.phase = p;
    this.events.onPhase(p);
  }

  get currentPhase() { return this.phase; }

  dispose() {
    this.stop();
    if (this.scareBeatTimer !== undefined) clearTimeout(this.scareBeatTimer);
    this.audio.stopAll();
    this.monster?.dispose();
    // The world and the collectibles were never released on teardown either — the
    // loop needed this machinery anyway, and a full unmount is exactly as entitled
    // to it as a maze change is.
    if (this.arrivalDoor) { this.disposeDoor(this.arrivalDoor); this.arrivalDoor = null; }
    this.disposeCollectibles();
    if (this.world) this.disposeWorld(this.world);
    // Released here and NOWHERE else — every halo and every door beacon shares
    // this one texture, so disposing it between mazes would blank the beacons of
    // the maze about to be built.
    this.haloTex?.dispose();
    this.haloTex = null;
    this.wallTex?.dispose();
    this.wallTex = null;
    this.post?.dispose();
    this.renderer.dispose();
  }
}
