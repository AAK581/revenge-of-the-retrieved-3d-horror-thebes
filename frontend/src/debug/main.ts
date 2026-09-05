/**
 * Billy — monster test map.
 *
 * A flat, empty, well-lit floor with the REAL `Monster` class on it. Requested
 * directly by the user: "An empty map to test animations of the monster would be
 * good. With a list containing animations, a chase trigger, with position and any
 * other useful logs and maybe a gizmo that shows us his viewpoint and another
 * that shows his target with logs for both."
 *
 * TWO RULES THIS FILE KEEPS.
 *
 * 1. It drives the shipping `Monster`, not a copy. Every clip, the posture layer,
 *    the perception test, the A* follower and the director are the ones that ship;
 *    this page only builds a floor, a camera and an overlay around them. A
 *    re-implementation would drift from the game the first time either side
 *    changed, and then the tool would be confidently wrong — which is worse than
 *    having no tool.
 * 2. No gizmo shows anything it cannot read. Where a value is genuinely absent
 *    (no path, no beat target) the readout says so and the marker is hidden,
 *    rather than a stale or invented position being drawn.
 *
 * It is a SEPARATE Vite entry (`frontend/debug.html`) so that it cannot
 * destabilise the game bundle. Nothing in the game imports this directory.
 *
 * Open it with:  npm run dev  ->  http://localhost:<port>/debug.html
 */
import * as THREE from 'three';
import { Maze } from '../game/maze';
import { Monster } from '../game/monster';
import { CFG } from '../game/config';
import { Orbit } from './orbit';
import { VisionConeGizmo, TargetGizmo } from './gizmos';

const app = document.getElementById('app')!;
const errBox = document.getElementById('err')!;

function fatal(msg: string) {
  errBox.textContent = msg;
  (errBox as HTMLElement).style.display = 'block';
}

/* ------------------------------------------------------------------ scene -- */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
const orbit = new Orbit(camera, renderer.domElement);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/**
 * Flat, empty, and lit so the SHAPE reads. The game is a dark horror maze on
 * purpose; this page is the opposite on purpose. You cannot judge a silhouette,
 * a lean or a foot plant in a 12% lit frame.
 */
scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x3a4048, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 1.9);
key.position.set(6, 12, 8);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.7);
fill.position.set(-7, 5, -6);
scene.add(fill);

/**
 * A 1 m grid, explicitly so his height is readable against something known.
 * `targetHeight` is 2.55 m, so he should stand two and a half squares tall — that
 * is a check anyone can perform by eye, which is the point of the grid.
 */
const GRID = 40;
const grid = new THREE.GridHelper(GRID, GRID, 0x4a5563, 0x2a3038);
scene.add(grid);
// A floor plane under the grid so he is not floating over a void, and so the
// vision cone has something to lie on.
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(GRID, GRID),
  new THREE.MeshStandardMaterial({ color: 0x1d2128, roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.005;
scene.add(floor);
// World axes at the origin: +X red, +Z blue. Yaw readings are meaningless
// without a visible reference for which way zero points.
scene.add(new THREE.AxesHelper(1.5));

/* --------------------------------------------------------------- subjects -- */

/**
 * The maze exists because `Monster` requires one — it holds the A* graph, the
 * line-of-sight test and the cell/world mapping the director is budgeted in.
 * It is NOT added to the scene: the brief asks for an empty map, and drawing the
 * walls would defeat the point. He can still path within it, which is what makes
 * the target gizmo show real routing rather than a straight line.
 *
 * Fixed seed, unlike the game's `Date.now() & 0xffff`, so that a behaviour seen
 * once can be looked at again. An irreproducible debug page is a story, not a
 * measurement (PROGRESS.md trap 6b).
 */
const SEED = 1337;
const maze = new Maze(CFG.maze.cols, CFG.maze.rows, CFG.maze.cell, SEED, CFG.maze.braid);
const monster = new Monster(maze);
scene.add(monster.group);

/** The stand-in player. Movable, so the perception and chase can be provoked. */
const dummy = new THREE.Group();
const dummyBody = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.3, 1.1, 6, 14),
  new THREE.MeshStandardMaterial({ color: 0x3f7fd6, roughness: 0.6 }),
);
dummyBody.position.y = 0.85;
dummy.add(dummyBody);
scene.add(dummy);
/** World position of the dummy, in the form `Monster.update` expects. */
const playerPos = new THREE.Vector3();

const cone = new VisionConeGizmo();
scene.add(cone.object);
const targetGizmo = new TargetGizmo();
scene.add(targetGizmo.object);

/* ------------------------------------------------------------------- state -- */

type Mode = 'ai' | 'anim';
const ui = {
  /** `ai` runs the real update loop; `anim` freezes AI and only plays a clip. */
  mode: 'anim' as Mode,
  playing: true,
  animSpeed: 1,
  showCone: true,
  showTarget: true,
  /** Metres per second the dummy moves under the arrow keys. */
  dummySpeed: 3.2,
};

const held = new Set<string>();
window.addEventListener('keydown', (e) => {
  held.add(e.key.toLowerCase());
  if (e.key === ' ') { ui.playing = !ui.playing; syncButtons(); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));

/* ---------------------------------------------------------------- controls -- */

const controls = document.createElement('div');
controls.className = 'panel';
controls.id = 'controls';
document.body.appendChild(controls);

const readout = document.createElement('div');
readout.className = 'panel';
readout.id = 'readout';
document.body.appendChild(readout);

function group(title: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'grp';
  const h = document.createElement('h2');
  h.textContent = title;
  d.appendChild(h);
  controls.appendChild(d);
  return d;
}

function button(parent: HTMLElement, label: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = on;
  parent.appendChild(b);
  return b;
}

const gClips = group('animations');
const gPlayback = group('playback');
const gAI = group('ai');
const gView = group('view');

/** One button per clip, filled in after `load()` reports what actually exists. */
const clipButtons = new Map<string, HTMLButtonElement>();

const scrub = document.createElement('input');
scrub.type = 'range';
scrub.min = '0'; scrub.max = '1000'; scrub.value = '0';
const scrubLabel = document.createElement('label');
scrubLabel.className = 'row';
scrubLabel.innerHTML = '<span>clip time</span><span id="scrubv">—</span>';
gPlayback.appendChild(scrubLabel);
gPlayback.appendChild(scrub);
/**
 * Scrubbing is only meaningful while the animation is not also being advanced by
 * the clock, so dragging pauses. Otherwise the next frame overwrites the seek and
 * the slider fights the mixer.
 */
scrub.addEventListener('input', () => {
  ui.playing = false;
  const t = monster.clipTransport;
  if (t) monster.seekClip((Number(scrub.value) / 1000) * t.duration);
  syncButtons();
});

const btnPlay = button(gPlayback, 'play / pause', () => { ui.playing = !ui.playing; syncButtons(); });
const speedLabel = document.createElement('label');
speedLabel.className = 'row';
speedLabel.innerHTML = '<span>speed</span><span id="spdv">1.00x</span>';
const speed = document.createElement('input');
speed.type = 'range'; speed.min = '0'; speed.max = '200'; speed.value = '100';
speed.addEventListener('input', () => { ui.animSpeed = Number(speed.value) / 100; });
gPlayback.appendChild(speedLabel);
gPlayback.appendChild(speed);

const btnChase = button(gAI, 'trigger chase', () => {
  /**
   * The real escalation path, not a state assignment. `debugForceChase` calls
   * the same `enterChase` that `perceive()` reaches when a sighting matures, so
   * this reproduces the transition the player actually sees — the walk->run
   * crossfade, the posture layer easing in, and the opening lunge burst.
   *
   * Running the AI is part of triggering a chase: a chase that cannot move is
   * not the thing under test.
   */
  ui.mode = 'ai';
  monster.debugFrozenClip = null;
  playerPos.copy(dummy.position);
  monster.debugForceChase(playerPos);
  syncButtons();
});
const btnAI = button(gAI, 'run ai', () => {
  ui.mode = ui.mode === 'ai' ? 'anim' : 'ai';
  if (ui.mode === 'ai') monster.debugFrozenClip = null;
  syncButtons();
});
button(gAI, 'reset hunt', () => { monster.resetHunt(); });
button(gAI, 'teleport to dummy', () => {
  const [cx, cy] = maze.worldToCell(dummy.position.x, dummy.position.z);
  if (maze.inBounds(cx, cy)) monster.spawn(cx, cy);
});

const btnCone = button(gView, 'vision cone', () => { ui.showCone = !ui.showCone; syncButtons(); });
const btnTgt = button(gView, 'target gizmo', () => { ui.showTarget = !ui.showTarget; syncButtons(); });
button(gView, 'focus billy', () => {
  orbit.focus(new THREE.Vector3(monster.group.position.x, 1.2, monster.group.position.z), 6);
});
button(gView, 'top-down', () => {
  orbit.focus(new THREE.Vector3(monster.group.position.x, 0, monster.group.position.z), 26);
});

const hint = document.createElement('div');
hint.className = 'hint';
hint.innerHTML = 'left-drag orbit · right-drag pan · wheel zoom<br>'
  + 'arrows / WASD move the dummy · space play-pause';
controls.appendChild(hint);

function syncButtons() {
  btnPlay.classList.toggle('on', ui.playing);
  btnPlay.textContent = ui.playing ? 'pause' : 'play';
  btnAI.classList.toggle('on', ui.mode === 'ai');
  btnAI.textContent = ui.mode === 'ai' ? 'ai: running' : 'ai: frozen';
  btnCone.classList.toggle('on', ui.showCone);
  btnTgt.classList.toggle('on', ui.showTarget);
  btnChase.classList.toggle('warn', monster.state === 'chase');
  for (const [name, b] of clipButtons) {
    b.classList.toggle('on', monster.currentClip === name);
  }
  cone.setVisible(ui.showCone);
  targetGizmo.setVisible(ui.showTarget);
}

/* -------------------------------------------------------------------- load -- */

/**
 * Same path and same loader the game uses. `base: "./"` and the relative Draco
 * decoder path mean this resolves under the Thebes gateway too, so the debug page
 * is deployable rather than dev-only.
 */
monster.load('assets/models/billy.glb').then(() => {
  const names = monster.clipNames;
  if (!names.length) {
    fatal('billy.glb loaded but exposes no animation clips.\n'
      + 'The animation list would be empty, so there is nothing to test.');
    return;
  }
  for (const name of names) {
    const b = button(gClips, name, () => {
      // Freezing the AI is part of choosing a clip: the gait controller would
      // otherwise overwrite the choice on the very next frame, since it maps
      // state -> clip itself. `debugFrozenClip` is the hook that already exists
      // in `updateGait` for exactly this.
      ui.mode = 'anim';
      monster.debugFrozenClip = name;
      monster.playClip(name, 0.15);
      ui.playing = true;
      syncButtons();
    });
    clipButtons.set(name, b);
  }
  // Start somewhere sensible: middle of the grid, facing +Z, playing idle.
  monster.group.position.set(0, 0, 0);
  monster.debugFrozenClip = names.includes('idle') ? 'idle' : names[0];
  monster.playClip(monster.debugFrozenClip, 0);
  dummy.position.set(0, 0, 6);
  orbit.focus(new THREE.Vector3(0, 1.2, 0), 7);
  syncButtons();
}).catch((e) => {
  fatal('Failed to load billy.glb\n\n' + String(e && e.message ? e.message : e)
    + '\n\nServe the frontend (npm run dev) and open /debug.html from the same '
    + 'origin, so that assets/ and draco/ resolve.');
});

/* ------------------------------------------------------------------ readout -- */

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const deg = (r: number) => `${((r * 180) / Math.PI).toFixed(1)}°`;

function renderReadout(dt: number) {
  const t = monster.clipTransport;
  const tp = monster.targetProbe;
  const p = monster.group.position;
  const toPlayer = Math.hypot(dummy.position.x - p.x, dummy.position.z - p.z);

  /**
   * The angle the perception test actually computes, recomputed here the same
   * way, so "why did he see me" is answerable by comparing two numbers on screen
   * rather than by argument: `off-axis` against `sightAngle`.
   */
  const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(monster.group.quaternion);
  const toP = new THREE.Vector3(dummy.position.x - p.x, 0, dummy.position.z - p.z);
  const offAxis = toP.lengthSq() > 1e-8 ? facing.angleTo(toP.normalize()) : 0;

  const inCone = offAxis < CFG.monster.sightAngle && toPlayer < CFG.monster.sightRange;
  const los = maze.hasLineOfSight(p.x, p.z, dummy.position.x, dummy.position.z);

  const beat = tp.beatCell ? maze.cellToWorld(tp.beatCell[0], tp.beatCell[1]) : null;
  const yn = (v: boolean) => `<span class="${v ? 'good' : 'bad'}">${v ? 'yes' : 'no'}</span>`;

  readout.innerHTML = `
    <div class="grp"><h2>animation</h2><table>
      <tr><td class="k">clip</td><td class="v">${t ? t.name : '—'}</td></tr>
      <tr><td class="k">time</td><td class="v">${t ? `${fmt(t.time % t.duration, 3)} / ${fmt(t.duration, 3)} s` : '—'}</td></tr>
      <tr><td class="k">posture blend</td><td class="v">${fmt(monster.postureProbe.blend, 3)}</td></tr>
      <tr><td class="k">posture bones</td><td class="v">${monster.postureProbe.bones}</td></tr>
    </table></div>

    <div class="grp"><h2>transform</h2><table>
      <tr><td class="k">position</td><td class="v">${fmt(p.x)}, ${fmt(p.z)}</td></tr>
      <tr><td class="k">cell</td><td class="v">${maze.worldToCell(p.x, p.z).join(', ')}</td></tr>
      <tr><td class="k">world yaw</td><td class="v">${deg(monster.group.rotation.y)}</td></tr>
      <tr><td class="k">model yaw</td><td class="v">${deg(monster.modelYaw)}</td></tr>
      <tr><td class="k">speed</td><td class="v">${fmt(monster.speed)} m/s</td></tr>
    </table></div>

    <div class="grp"><h2>ai</h2><table>
      <tr><td class="k">state</td><td class="v">${monster.state}</td></tr>
      <tr><td class="k">director beat</td><td class="v">${monster.directorBeat}</td></tr>
      <tr><td class="k">beat remaining</td><td class="v">${fmt(monster.directorRemaining, 1)} s</td></tr>
      <tr><td class="k">lunging</td><td class="v">${yn(monster.isLunging)}</td></tr>
    </table></div>

    <div class="grp"><h2>perception</h2><table>
      <tr><td class="k">distance</td><td class="v">${fmt(toPlayer)} m</td></tr>
      <tr><td class="k">off-axis</td><td class="v">${deg(offAxis)}</td></tr>
      <tr><td class="k">half-cone</td><td class="v">${deg(CFG.monster.sightAngle)}</td></tr>
      <tr><td class="k">within cone</td><td class="v">${yn(inCone)}</td></tr>
      <tr><td class="k">line of sight</td><td class="v">${yn(los)}</td></tr>
      <tr><td class="k">sees player</td><td class="v">${yn(monster.seesPlayer)}</td></tr>
      <tr><td class="k">acuity</td><td class="v">${fmt(monster.sightAcuity, 2)}</td></tr>
    </table></div>

    <div class="grp"><h2>target</h2><table>
      <tr><td class="k"><span class="swatch" style="background:#ffb03a"></span>waypoint</td>
          <td class="v">${tp.waypoint ? `${fmt(tp.waypoint[0])}, ${fmt(tp.waypoint[1])}` : 'none'}</td></tr>
      <tr><td class="k"><span class="swatch" style="background:#54d98c"></span>beat cell</td>
          <td class="v">${tp.beatCell ? tp.beatCell.join(', ') : 'none'}</td></tr>
      <tr><td class="k">beat world</td><td class="v">${beat ? `${fmt(beat[0])}, ${fmt(beat[1])}` : '—'}</td></tr>
      <tr><td class="k">path remaining</td><td class="v">${tp.pathRemaining}</td></tr>
    </table></div>

    <div class="grp"><h2>frame</h2><table>
      <tr><td class="k">dt</td><td class="v">${fmt(dt * 1000, 1)} ms</td></tr>
      <tr><td class="k">seed</td><td class="v">${SEED}</td></tr>
    </table></div>`;

  const sv = document.getElementById('scrubv');
  if (sv) sv.textContent = t ? `${fmt(t.time % t.duration, 3)} s` : '—';
  const spd = document.getElementById('spdv');
  if (spd) spd.textContent = `${ui.animSpeed.toFixed(2)}x`;
  if (t && document.activeElement !== scrub) {
    scrub.value = String(Math.round(((t.time % t.duration) / t.duration) * 1000));
  }
}

/* --------------------------------------------------------------------- loop -- */

const clock = new THREE.Clock();

function moveDummy(dt: number) {
  let mx = 0, mz = 0;
  if (held.has('arrowup') || held.has('w')) mz -= 1;
  if (held.has('arrowdown') || held.has('s')) mz += 1;
  if (held.has('arrowleft') || held.has('a')) mx -= 1;
  if (held.has('arrowright') || held.has('d')) mx += 1;
  if (!mx && !mz) return;
  // Move relative to the CAMERA, so "up" is always away from the viewer whatever
  // angle the orbit is at. Moving in world axes on an orbiting camera is the
  // fastest way to make a debug tool infuriating.
  const f = new THREE.Vector3();
  camera.getWorldDirection(f);
  f.y = 0; f.normalize();
  const r = new THREE.Vector3(f.z, 0, -f.x);
  const d = new THREE.Vector3()
    .addScaledVector(f, -mz)
    .addScaledVector(r, mx);
  if (d.lengthSq() < 1e-8) return;
  d.normalize().multiplyScalar(ui.dummySpeed * dt);
  dummy.position.add(d);
}

function frame() {
  requestAnimationFrame(frame);
  // Clamp: a background tab returns a huge delta and would teleport the sim.
  const dt = Math.min(0.05, clock.getDelta());

  moveDummy(dt);
  playerPos.copy(dummy.position);

  if (ui.mode === 'ai') {
    /**
     * The genuine per-frame entry point the game calls. Perception, the director,
     * pathing, movement and the posture layer all run here — which is why what
     * this page shows is what ships.
     */
    if (ui.playing) monster.update(dt * ui.animSpeed, playerPos, false);
  } else if (ui.playing) {
    // Animation only: no AI, no movement, so a clip can be watched in isolation.
    monster.tickAnimationOnly(dt * ui.animSpeed);
  }

  cone.syncTo(monster.group);
  const tp = monster.targetProbe;
  const beatWorld = tp.beatCell
    ? (maze.cellToWorld(tp.beatCell[0], tp.beatCell[1]) as [number, number])
    : null;
  targetGizmo.update(monster.group.position, tp.waypoint, beatWorld);

  orbit.apply();
  renderer.render(scene, camera);
  renderReadout(dt);
  // Keeps the chase button's warning tint and the clip highlight honest as the
  // AI changes state on its own.
  syncButtons();
}
frame();

// Handy for ad-hoc poking from the console and for any capture script.
(window as unknown as Record<string, unknown>).__DEBUG__ = { monster, maze, dummy, ui, scene, camera };
