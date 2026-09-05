/**
 * Billy — the thing in the maze.
 *
 * Two layers, and the split is the whole design.
 *
 * The lower layer is a perception state machine: patrol → suspicious → chase →
 * search. It escalates fast and de-escalates slowly. Being seen costs you half a
 * second; being forgotten costs you several, and only once you are properly far
 * away. The moment of "did he see me" is short and sharp; the aftermath is long.
 *
 * The upper layer is the DIRECTOR, and it exists because a pure state machine is
 * not frightening. Left to random patrol he is either glued to the far side of the
 * maze — so you forget he exists — or permanently underfoot, which is noise rather
 * than dread. Amnesia's monsters work through absence: long stretches where you
 * only suspect, punctuated by a deliberate approach. So the director owns his
 * patrol *intent* on a slow cycle — QUIET (routed away), APPROACH (routed toward
 * your neighbourhood, still unaware), STALK (routed to pass close by with no
 * sightline to you) — and perception interrupts it at any moment. Seeing you beats
 * any plan.
 *
 * Position is driven entirely here. Both animation clips are in-place, so the feet
 * are synced to speed rather than the other way round — no root motion to fight.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { Maze } from './maze';
import { CFG } from './config';

/**
 * A/B switch for the chase interception scoring. SHIPS AS `false`.
 *
 * `predictedCell()` used to score cutoff candidates by `margin`
 * (`playerETA - selfETA`), which is maximised by cells close to HIM rather than
 * cells that stand in the player's way — so he ran to cells behind himself
 * (39.7%) and cells further from the player than he already was (31.2%), and
 * the argmax flipped between junction neighbours faster than he could walk to
 * either. That is the "runs around erratically after spotting me" the user has
 * now reported four times.
 *
 * Setting this to `true` restores the old behaviour EXACTLY, so the fix can be
 * re-measured against it at any time by the harnesses in tools/mazelab/CH-*.mjs
 * rather than from a git stash. The two must be compared under the same harness:
 * an earlier comparison was invalidated because the sim let him run through the
 * player and orbit a coincident point, inflating the reversal count on both
 * sides (PROGRESS.md trap 16).
 */
const BASELINE = false;

/**
 * The verified base facing correction, in radians.
 *
 * Established by controlled A/B render (tools/facing-billy.html?c=<radians>) and
 * confirmed in the live game: at -PI/2 a camera on +Z sees his FACE and one on -Z
 * sees the back of his head. This regressed once to Math.PI, which put him back
 * to charging shoulder-first — see docs/handoff/FACING-SETTLED.md before changing it.
 *
 * It is the anchor for the per-clip offsets: it holds exactly for the `run` clip,
 * and every other clip is corrected relative to it.
 */
const MESH_FORWARD_CORRECTION = -Math.PI / 2;

export type MonsterState = 'patrol' | 'suspicious' | 'chase' | 'search';

/**
 * What the director currently wants, when perception is not overriding it.
 * `quiet` = be elsewhere, `approach` = close the gap, `stalk` = pass near without
 * a sightline. Exposed so audio and the critic harness can see the pacing.
 */
export type DirectorBeat = 'quiet' | 'approach' | 'stalk';

/**
 * The pelvis pitch axis, in the Hips bone's PARENT (`Armature`) frame.
 *
 * MEASURED, not guessed. The Armature node carries Blender's Z-up->Y-up
 * `rotation.x = +90 deg`; composed with the Scene's -90 deg yaw that maps
 * Armature-local +X to the character's FORWARD, +Y to his RIGHT and +Z to his
 * DOWN. So the anatomical lateral axis — the one a forward pelvic tilt turns
 * about — is the Y axis here, NOT X. Rotating about X is a pure roll, which is
 * the sideways lean the user reported. See the long note at the use site.
 *
 * The sign is -Y rather than +Y so that a POSITIVE `CFG.monster.posture.hipPitch`
 * tips the top of the pelvis FORWARD, which is what the name says and what
 * `spinePitch` already does. Verified by measurement, not by inspection:
 * `tools/lean-probe.html?only=hipPitch` reports pitch +7.9 deg with roll
 * -0.48 deg (the clip's own baseline, i.e. zero added roll) at this sign, and a
 * BACKWARD lean at the other. Run it with `node tools/lean-measure.mjs`.
 *
 * Scratch quaternion alongside it because this runs every frame of every chase
 * and Billy is already 86% of the frame's triangles (PROGRESS.md §3c); this path
 * does not need to add per-frame allocation on top.
 */
const HIP_PITCH_AXIS = new THREE.Vector3(0, -1, 0);
const HIP_PITCH_Q = new THREE.Quaternion();

export class Monster {
  readonly group = new THREE.Group();
  state: MonsterState = 'patrol';

  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: string | null = null;
  private model: THREE.Object3D | null = null;
  /** Model Y after the load-time bind-pose ground plant. Per-clip offsets ride on this. */
  private baseModelY = 0;
  /** Per clip, how far to lift so that clip's lowest frame grazes the floor. */
  private clipGroundOffset = new Map<string, number>();
  /** Where the model's Y is heading; eased so a clip change does not pop him. */
  private targetGroundY = 0;
  /**
   * Per clip, the model yaw that makes THAT clip face along the group's +Z.
   *
   * One model-level correction is not enough, because the clips do not agree with
   * each other. Measured from the authored GLB with no correction applied
   * (tools/clip-facing.html, facing taken from the SHOULDER LINE so no individual
   * bone's axes can mislead it):
   *
   *   walk       176.1 deg   <- original billyWalk clip
   *   idle       169.5 deg   <- original
   *   run        -89.7 deg   <- RETARGETED, ~94 deg from walk
   *   jumpscare  -92.1 deg   <- RETARGETED, ~92 deg from walk
   *
   * The Blender retarget rebaked the root orientation, so imported and retargeted
   * clips sit a quarter turn apart. The old constant -PI/2 was verified against
   * the RUN, which is exactly why the chase looked right while the user reported
   * the walk "is not in my direction".
   */
  private clipYawOffset = new Map<string, number>();

  private maze: Maze;
  private path: [number, number][] = [];
  private pathIndex = 0;
  private repathTimer = 0;
  /**
   * The direction he last actually MOVED, unit length, written by `stepToward`.
   *
   * Distinct from `group.rotation.y` on purpose. The yaw is damped toward travel
   * and is also driven by the patrol look-around and the search dwell, so it lags
   * real motion and can point somewhere he is not going. `repath` needs "which
   * way is he actually heading" to decide whether a fresh path's first waypoint
   * is behind him, and using the yaw for that measured WORSE than the bug it was
   * meant to fix. Zero until he has moved at all.
   */
  private travelDirX = 0;
  private travelDirZ = 0;

  private sightTimer = 0;
  private lostTimer = 0;
  /** Seconds the current chase has been running — chases have a hard ceiling. */
  private chaseElapsed = 0;
  /**
   * Seconds remaining before he may start another chase. Set when one ends, so
   * giving up buys the player real distance instead of a frame of relief. See
   * CFG.monster.chaseCooldown for the trace that made this necessary.
   */
  private chaseCooldown = 0;
  private searchTimer = 0;
  /** Last place he actually saw or heard you — where he goes when he loses you. */
  private lastKnown = new THREE.Vector3();

  // ---- chase speed profile -------------------------------------------------
  /**
   * His actual instantaneous speed, ramped rather than switched. The old code
   * branched straight from walkSpeed 1.75 to chaseSpeed on a single frame, which
   * is both physically absurd on a body that has to turn a corner and contrary to
   * the reference ("starting off slow, but building momentum").
   */
  private moveSpeed = CFG.monster.walkSpeed;
  /** Seconds left in the opening burst. Re-armed on re-acquiring sight. */
  private lungeTimer = 0;

  // ---- patrol pauses -------------------------------------------------------
  /** Seconds left standing still, looking around. 0 = walking. */
  private pauseTimer = 0;
  /**
   * Seconds of walking left before the next pause is due. Annotated `number`
   * because CFG's members infer as literal types, and initialising from one would
   * otherwise narrow this field to the literal 8 and reject every assignment.
   */
  private pauseCooldown: number = CFG.monster.patrol.pauseEveryMin;
  /** Which way he is turning during the current pause, so it is not a spin. */
  private lookDir = 1;

  // ---- predictive pursuit --------------------------------------------------
  /** Player position last frame, for the velocity estimate. */
  private prevPlayer = new THREE.Vector3();
  private havePrevPlayer = false;
  /** Smoothed player velocity in m/s. Noisy per-frame deltas would make him jitter. */
  private playerVel = new THREE.Vector3();
  /** Confidence in the lead, 1 while seen, decaying once he cannot see you. */
  private leadConfidence = 0;
  /**
   * The cutoff cell he is currently committed to, held across repaths.
   *
   * `predictedCell()` is an argmax over the maze and it is re-evaluated every
   * 0.35 s during a chase. Without a latch, two candidates either side of a
   * junction trade places on ties and he is handed the opposite direction three
   * times a second — the erratic orbiting the user filmed. Cleared whenever no
   * honest cutoff exists, so it can never pin him to a stale plan.
   */
  private interceptCell: [number, number] | null = null;

  // ---- search --------------------------------------------------------------
  /** Cells still to be checked this search, nearest-first. */
  private searchProbes: [number, number][] = [];
  private probeDwell = 0;

  // ---- director ------------------------------------------------------------
  private beat: DirectorBeat = 'quiet';
  /**
   * For `quiet` and `stalk` this is the beat's remaining design duration. For
   * `approach` it is a FAILSAFE budget sized from the corridor distance he
   * actually has to walk — an approach ends on arrival, not on this clock.
   */
  private beatTimer = 0;
  /** True once the first beat has been scheduled; forces a plan on the first update. */
  private beatPlanned = false;
  /** Countdown to the next director re-solve, so the target tracks a moving player. */
  private replanTimer = 0;
  /** Cell the director last routed him to, so a re-solve that agrees is free. */
  private beatTarget: [number, number] | null = null;
  /**
   * True only for the very first quiet beat of a run, which is routed to the outer
   * half of the quiet band so the game opens with the player genuinely alone. See
   * the note in directorTarget.
   */
  private openingBeat = true;

  /** What the director is currently doing. Read by the harness and the audio bed. */
  get directorBeat(): DirectorBeat { return this.beat; }
  /** Seconds left in the current beat — useful when debugging pacing. */
  get directorRemaining(): number { return this.beatTimer; }

  /** True on the frame the chase begins; the game uses it to swing the music. */
  justSpotted = false;
  /** Distance to the player, refreshed every update — the flashlight reads this. */
  distanceToPlayer = Infinity;
  /**
   * Every skinned mesh in the model, cached at load so the per-frame shadow gate
   * is a flag write and not a `traverse()`. Populated in `load()`.
   */
  private shadowMeshes: THREE.Mesh[] = [];
  /** Mirrors the flag actually set on those meshes, so we only write on a change. */
  private shadowsOn = true;
  /** True while he has an unbroken line of sight on the player right now. */
  seesPlayer = false;
  /**
   * How well he is seeing you this frame: 1 at full foveal acuity, falling toward
   * `1 / peripheralSpotScale` at the edge of his cone, 0 when he cannot see you.
   *
   * Published (not private) because it is the number that makes the near-miss
   * measurable: a harness can distinguish "he has a line on you but is not
   * attending to you" from "he is looking straight at you", which a bare boolean
   * cannot. `seesPlayer` remains raw geometry — see the note in `perceive`.
   */
  sightAcuity = 0;
  /**
   * Seconds left of "keep looking where you were going".
   *
   * Set when an unaware Billy's sightline opens onto the player, and it damps his
   * turn-toward-travel so his own pathing cannot swing the player from the edge
   * of his cone into the centre of it. Never set while he is chasing.
   */
  private gazeAvertTimer = 0;
  /**
   * Latch for the unaware-sighting evasion, so it is EDGE-triggered rather than
   * level-triggered. True while the current exposure episode has already been
   * reacted to; cleared when the sighting genuinely lapses.
   *
   * MEASURED — this is the fix for "he runs around in small circles". The evade
   * branch in `updateDirector` used to fire on every frame the condition held,
   * and it held continuously: 93.8% of evade frames were consecutive with the
   * previous one (785 evade frames over 80 simulated minutes, `RC-circle`).
   * Each of those frames called `planDirectorPath(force = true)`, which picks a
   * NEW RANDOM cell out of the band and re-runs A*. So for as long as the player
   * could see him he re-chose his destination sixty times a second, taking one
   * frame's step toward each — a random walk that reads exactly as shuffling on
   * the spot. Measured alongside it: 61.7% of all director targets were
   * abandoned in under 2 s (median lifetime 0.98 s), he re-entered a cell he had
   * just left within 15 s on 20.2% of cell entries, and he reversed his heading
   * by more than 120 deg 16 times a minute.
   *
   * It also broke ENGAGEMENT, which is why one latch fixes both halves of the
   * user's report. Every one of those frames also re-armed `gazeAvertTimer`,
   * pinning his turn rate at `gazeAvertTurnScale` 0.18 for as long as he was
   * exposed. He therefore could not turn to face a player standing in his
   * corridor, his acuity stayed at a median 0.329 — below the 0.5 that converts —
   * and he stood there failing to react. Acquisition with the player plainly
   * visible at 5-15 m measured 38.9%.
   *
   * Edge-triggering keeps the beat the evasion was written for: he still reacts
   * once, still re-routes, still averts his gaze for `gazeAvertSeconds`. He just
   * does it ONCE per sighting instead of every frame, so the plan he makes
   * survives long enough to be walked.
   */
  private evadeLatched = false;

  /**
   * Harness only: hold the AI off him while leaving the mixer running, so he can
   * be photographed animating at a known distance. Never set during play.
   */
  debugFreeze = false;
  /** Harness only: pin the animation clip so a specific one can be photographed. */
  debugFrozenClip: string | null = null;

  // ---- predator posture layer (see applyPredatorPosture) --------------------
  /** 0 = upright walker, 1 = full chase posture. Eased, never snapped. */
  private postureBlend = 0;
  /** Free-running clock for the asymmetry oscillators. */
  private postureClock = 0;
  private postureBonesResolved = false;
  /** How many posture bones actually resolved. 0 means the layer is a no-op. */
  private postureBoneCount = 0;
  private boneSpine: THREE.Bone | null = null;
  private boneSpine1: THREE.Bone | null = null;
  private boneSpine2: THREE.Bone | null = null;
  private boneNeck: THREE.Bone | null = null;
  private boneHead: THREE.Bone | null = null;
  private boneRArm: THREE.Bone | null = null;
  private boneRForeArm: THREE.Bone | null = null;
  private boneLArm: THREE.Bone | null = null;
  private boneLForeArm: THREE.Bone | null = null;
  private boneLShoulder: THREE.Bone | null = null;
  private boneRShoulder: THREE.Bone | null = null;
  private boneHips: THREE.Bone | null = null;
  /**
   * The legs. These are the reason the first version of this layer failed.
   *
   * MEASURED: with the layer applied only to spine/arms/hips, a full-stride probe
   * of real world-space bone positions gave a left/right FOOT antiphase
   * correlation of -0.912 — the two legs alternating in near-perfect mirror, which
   * is the single strongest cue the eye uses to classify a gait as human. All the
   * upper-body drift in the world cannot overrule a textbook-symmetric stride
   * underneath it. Breaking that symmetry is what this layer now does first.
   */
  private boneLUpLeg: THREE.Bone | null = null;
  private boneRUpLeg: THREE.Bone | null = null;
  private boneLLeg: THREE.Bone | null = null;
  private boneRLeg: THREE.Bone | null = null;

  /** Exposed so the harness can prove the layer found subjects and is engaged. */
  get postureProbe() {
    return {
      bones: this.postureBoneCount,
      blend: Math.round(this.postureBlend * 1000) / 1000,
    };
  }

  /**
   * Read-only view of what he is currently walking toward, for the debug page's
   * target gizmo (`frontend/debug.html`).
   *
   * `waypoint` is the immediate A* waypoint he is stepping to right now, in world
   * XZ; `beatCell` is the director's higher-level destination cell. Drawing BOTH
   * is the point — the user's "he runs in weird circles" is exactly the case where
   * the beat cell is stable and sensible while the waypoint thrashes, and no
   * single marker can show that. Returns nulls rather than a stale last value when
   * there is no path, so an empty route renders as "no target" instead of as a
   * marker sitting somewhere he is not going.
   *
   * A getter over a copy: the debug page must not be able to reach in and mutate
   * the live route, or the tool would be changing the thing it is measuring.
   */
  get targetProbe(): {
    waypoint: [number, number] | null;
    beatCell: [number, number] | null;
    pathRemaining: number;
  } {
    const wp = !this.pathDone() ? this.path[this.pathIndex] : null;
    return {
      waypoint: wp ? [wp[0], wp[1]] : null,
      beatCell: this.beatTarget ? [this.beatTarget[0], this.beatTarget[1]] : null,
      pathRemaining: Math.max(0, this.path.length - this.pathIndex),
    };
  }

  /**
   * The cell at the END of the live route, for chase instrumentation.
   *
   * The immediate waypoint (`targetProbe.waypoint`) cannot distinguish "he is
   * walking a stable plan" from "his plan is being replaced twice a second by a
   * different one that happens to start in the same direction". Only the goal
   * can, and the chase churn measured by `tools/mazelab/CH-path.mjs` is a goal
   * problem, not a waypoint problem. Returns a copy; null when there is no path.
   */
  debugGoalCell(): [number, number] | null {
    if (!this.path.length) return null;
    const [wx, wz] = this.path[this.path.length - 1];
    return this.maze.worldToCell(wx, wz);
  }

  /**
   * The chase's chosen pursuit cell, evaluated without mutating anything.
   *
   * Read-only so a harness can sample the DECISION on the repath cadence and
   * separate "the plan is bad" from "the plan is fine and the walking is bad".
   */
  debugPredictedCell(): [number, number] { return this.predictedCell(); }

  /** Real direction of travel (trap 18: the group yaw is not his heading). */
  get travelDir(): [number, number] { return [this.travelDirX, this.travelDirZ]; }

  /**
   * Every bone name in the loaded rig. Exists because the posture layer resolved
   * zero bones on the first run and the only way to know WHY is to see what the
   * exporter actually named them at runtime, rather than what the GLB's node list
   * says (they differ — the loader mangles characters that are illegal in a
   * three.js object name).
   */
  get boneNames(): string[] {
    const out: string[] = [];
    this.model?.traverse((o) => { if ((o as THREE.Bone).isBone) out.push(o.name); });
    return out;
  }

  constructor(maze: Maze) {
    this.maze = maze;
  }

  /** Draco decoder, held so dispose() can release its worker pool. */
  private draco?: DRACOLoader;

  async load(url: string) {
    // billy.glb ships Draco-compressed (2.1MB instead of ~12MB), so it declares
    // extensionsRequired: ["KHR_draco_mesh_compression"] and a bare GLTFLoader
    // throws "No DRACOLoader instance provided" — which left the game with a
    // working AI and no monster mesh at all.
    //
    // The decoder path MUST stay relative. The asset canister serves this bundle
    // from /_/raw/<cid>/, where a leading slash resolves to the gateway root and
    // 404s — it would work in dev and silently fail in production. This is the
    // same reason vite.config.ts pins base: "./".
    const draco = new DRACOLoader();
    draco.setDecoderPath('draco/');
    this.draco = draco;
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(url);
    this.model = gltf.scene;

    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      // Kept so the shadow pass can be gated on distance per frame rather than
      // re-traversing the hierarchy. See `updateShadowCulling`.
      this.shadowMeshes.push(mesh);
      // Frustum culling on a skinned mesh whose bounds were computed at rest
      // makes him vanish mid-stride at the worst possible moment.
      mesh.frustumCulled = false;

      /**
       * Make him respond to the flashlight at all.
       *
       * billy.glb's material omits `metallicFactor` and `roughnessFactor`, and
       * glTF defaults BOTH to 1.0 — so he loaded as a perfectly metallic,
       * perfectly rough surface. A pure metal in three's PBR has no diffuse
       * response: it shows only reflected environment, and this scene has no
       * environment map by design (it is a pitch-black maze). The result was a
       * monster who was correctly positioned, correctly scaled, animating, in the
       * beam at 3m — and rendered essentially black, every frame. Verified against
       * the live material: metalness 1, roughness 1, baseColor white.
       *
       * He is dead flesh and wet cord (GAME-SPEC §6a), not chrome. Dielectric,
       * with a little gloss so the cords catch a highlight on their top surfaces
       * and go dark in the gaps, which is what makes the body read as woven.
       * The baseColor/normal/roughness textures the export DOES ship are kept.
       */
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (!std || !('metalness' in std)) continue;
        std.metalness = CFG.monster.metalness;
        std.roughness = CFG.monster.roughness;
        std.needsUpdate = true;
      }
    });

    /**
     * Stand him on the floor at a believable height, and give him bounds that are
     * actually true, because both were wrong and each hid the other.
     *
     * billy.glb's armature carries a cm->m scale of 0.01 while its inverse-bind
     * matrices carry a matching x100. The two cancel *for skinned vertices*, so he
     * renders at his authored size — but they do NOT cancel for any of three's
     * convenience bounds, which read raw geometry through the node transform:
     *
     *   - `Box3.setFromObject()` reports the un-skinned geometry (0.97 units) and
     *     so LOOKS like a sane height while being unrelated to the drawn mesh.
     *   - `geometry.boundingSphere` (r = 0.57) is scaled by the armature's 0.01,
     *     giving an effective cull radius of 0.0057 m.
     *
     * That last one is what actually broke him. Even sitting 1.4 m in front of the
     * camera, dead centre, a 5.7 mm sphere fell outside the frustum test and three
     * culled the draw — `renderer.info` showed his ~150k triangles never submitted.
     * He chased, caught and killed while being invisible, and nothing errored.
     *
     * So: measure the REAL rendered extent by pushing actual vertices through the
     * skeleton (`applyBoneTransform` is the same maths the vertex shader runs),
     * scale off that, then overwrite the bounding sphere with one that encloses
     * the skinned mesh so the culler stops lying. Sampled rather than exhaustive —
     * 141k vertices every load is not worth it for a bound that only needs to be
     * conservative, and the radius is padded to cover what the stride skips.
     */
    const skinned = this.model.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh | undefined;
    if (skinned) {
      skinned.updateMatrixWorld(true);
      const posAttr = skinned.geometry.attributes.position;
      const v = new THREE.Vector3();
      const bounds = new THREE.Box3().makeEmpty();
      // ~600 samples is plenty to fix an extent to the millimetre here.
      const stride = Math.max(1, Math.floor(posAttr.count / 600));
      for (let i = 0; i < posAttr.count; i += stride) {
        v.fromBufferAttribute(posAttr, i);
        skinned.applyBoneTransform(i, v);
        skinned.localToWorld(v);
        bounds.expandByPoint(v);
      }

      const height = bounds.max.y - bounds.min.y;
      if (height > 1e-4) {
        /**
         * Scale off the BIND POSE, then correct for the fact that a bind pose is
         * not what anybody ever sees.
         *
         * This runs before the mixer has ever ticked, so `height` is the rest
         * pose: legs straight, spine straight, standing at full stretch. Every
         * pose the player actually sees is shorter than that — a run cycle keeps
         * the knees bent and the body compressed for the whole stride. Scaling
         * the rest pose to `targetHeight` therefore ships a monster who never
         * reaches it.
         *
         * MEASURED, by pushing real vertices through the skeleton with the mixer
         * running (tools/_probe/gait.mjs, 140 samples over full stride cycles):
         * with the rest pose scaled to 1.45 m, the animated crown sat at 1.243 m
         * mean while walking — 86% of target — and 1.193 m in the chase, where the
         * predator lean legitimately takes another 5 cm off. That is the gap
         * between "1.45 m" in config and what is on screen.
         *
         * `poseCompensation` closes it, and it is applied here rather than by
         * inflating `targetHeight` so that the config number keeps meaning the
         * thing it says: how tall he STANDS in the world, in metres.
         */
        const scale = (CFG.monster.targetHeight * CFG.monster.poseCompensation) / height;
        this.model.scale.multiplyScalar(scale);
        // He is modelled centred on the origin, so half of him starts below the
        // floor. Lift by his scaled lowest point to plant his feet on y = 0.
        this.model.position.y -= bounds.min.y * scale;
        this.baseModelY = this.model.position.y;
        this.measureClipGroundOffsets(skinned, gltf.animations);
        this.measureClipFacingOffsets(gltf.animations);
      }

      /**
       * Replace the geometry bounds with the skinned extent, expressed in the
       * geometry's own local space (undoing the armature scale that three will
       * re-apply). Without this the frustum culler keeps using the 5.7mm sphere.
       * `frustumCulled = false` above is belt-and-braces for the mesh itself, but
       * the shadow pass and any future code that reads these bounds need them to
       * be honest.
       */
      const meshScale = new THREE.Vector3();
      skinned.getWorldScale(meshScale);
      const localRadius = Math.max(
        bounds.getSize(new THREE.Vector3()).length() * 0.5,
        1e-3,
      ) / Math.max(meshScale.x, 1e-6);
      const center = bounds.getCenter(new THREE.Vector3());
      skinned.worldToLocal(center);
      skinned.geometry.boundingSphere = new THREE.Sphere(center, localRadius * 1.35);
      skinned.geometry.boundingBox = null;
    }

    /**
     * billy.glb is authored facing -Z. Turn him to face the group's +Z.
     *
     * The AI aligns the GROUP's +Z with the direction of travel
     * (`group.rotation.y = atan2(dx, dz)`) and reads the vision cone off that same
     * +Z, so the two agree with each other. The mesh has to be brought onto that
     * axis too, or he charges the player shoulder-first — which is what "he wasn't
     * looking in my direction" was.
     *
     * MEASURED, three independent ways, in the LIVE game rather than an offline
     * re-load (tools/kx-axis3.mjs, tools/kx-orbit2.mjs):
     *
     *   1. SHOULDER LINE. world(LeftArm) - world(RightArm), expressed in the model
     *      child's local frame, is (1.000, 0, 0.000) over 40 samples. The lateral
     *      axis is therefore local X exactly, so forward is local Z. Only the sign
     *      was ever in question.
     *   2. TOES. (ToeBase - Foot) averaged over full stride cycles, so no single
     *      frame's swing can decide it: left +0.085 Z, right +0.070 Z, against
     *      X of +0.050. Toes lead along +Z of the ROTATED model, i.e. -Z of the
     *      authored mesh once the -PI/2 that was in place is removed.
     *   3. DIRECT RENDER, which is what actually settled it. tools/kx-orbit2.mjs
     *      parks the live, loaded, animating model at the origin under a bright
     *      key and reads the drawing buffer in the same tick (a page screenshot
     *      is useless here — the game's own rAF paints the maze over it before
     *      playwright captures). Orbiting the camera in 45 deg steps: at yaw 180,
     *      i.e. a camera on -Z, you get the FACE — hair fringe over an open mouth
     *      with teeth. At yaw 0 it is the smooth back of the skull, and 90/270 are
     *      clean profiles. Authored forward is -Z.
     *
     * ^ THE ABOVE ANALYSIS IS WRONG, AND THE VALUE IT PRODUCED (PI) REGRESSED THE
     * USER'S NUMBER ONE REPORTED BUG. Kept only so nobody re-derives it a third
     * time. What actually settles this is a controlled A/B render:
     *
     *   tools/facing-billy.html?c=<radians>
     *
     * draws the loaded, animating model at a given rotation.y from a camera on +Z
     * and one on -Z, side by side, under identical framing. Run both:
     *
     *   ?c=3.1415927  (PI)      -> BOTH cameras see a PROFILE. He is side-on to
     *                              +Z and -Z alike, which is exactly what an
     *                              uncorrected +X-facing mesh does: a half turn
     *                              maps +X to -X, still perpendicular to travel.
     *   ?c=-1.5707963 (-PI/2)   -> +Z camera sees his FACE (grey skin, brown
     *                              fringe, square shoulders, hands forward);
     *                              -Z camera sees the BACK OF HIS HEAD (solid
     *                              brown hair, no face). Unambiguous.
     *
     * Confirmed a second time in the running game: summoned at ~2m with the camera
     * aimed straight at him, PI renders a profile and -PI/2 renders him square-on.
     *
     * Two things to note about the superseded reasoning above. Its render claims
     * the face shows "an open mouth with teeth" — billy.glb has NO facial bones
     * (65-joint mixamo rig, Head and HeadTop_End only, see PROGRESS.md trap 9), so
     * his mouth cannot open. That description belongs to billyScare.png, not the
     * model. And it changed the measuring instrument (meshFwd, from local +X to
     * local +Z) in the same edit as the correction, so the instrument and the new
     * value agreed with each other while the rendered character did not — the very
     * failure mode it accuses the earlier probe of.
     *
     * The mesh is authored facing +X. Rotating by theta about Y maps +X to
     * (cos t, 0, -sin t); landing that on +Z needs cos t = 0 and -sin t = 1, so
     * theta = -PI/2.
     *
     * This MUST stay on the model child. The group's yaw is the AI's output and
     * has to keep meaning "direction of travel".
     *
     * Before changing this line again: run the A/B above and LOOK at both images.
     */
    this.model.rotation.y = MESH_FORWARD_CORRECTION;

    this.group.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      this.actions.set(clip.name, action);
    }
    this.playClip('walk', 0);
  }

  get clipNames() { return [...this.actions.keys()]; }

  /** The clip currently crossfaded to. Null before load() has run. */
  get currentClip() { return this.current; }

  /**
   * The model child's yaw — the +X-authored mesh's correction onto the group's
   * travel axis. Should read exactly -1.5708 (-PI/2).
   *
   * Exposed read-only so the debug page can display it beside the group's yaw.
   * This is the user's number one past bug and it has already regressed once by
   * being re-derived as PI (see `docs/handoff/FACING-SETTLED.md` and PROGRESS.md
   * trap 10), so having it on screen next to the body he is looking at makes the
   * regression visible the moment it happens instead of a wave later. 0 before
   * `load()`.
   */
  get modelYaw(): number { return this.model?.rotation.y ?? 0; }

  /**
   * Clip transport for the debug page's scrubber (`frontend/debug.html`).
   *
   * Reports the live `AnimationAction`'s own time and its clip's duration, and
   * lets the page seek within it. This reads and writes the REAL action the game
   * plays rather than a second mixer built for the tool, which is the whole
   * reason the debug page is trustworthy: a re-implementation would drift from
   * what ships the moment either side changed.
   *
   * `seek` is deliberately not a general "set any clip's time" — it moves the
   * action that is actually current, because that is the only one whose pose is
   * on screen. Returns null before `load()`, so the page can render "no clip"
   * instead of a plausible zero.
   */
  get clipTransport(): { name: string; time: number; duration: number } | null {
    if (!this.current) return null;
    const a = this.actions.get(this.current);
    const clip = a?.getClip();
    if (!a || !clip) return null;
    return { name: this.current, time: a.time, duration: clip.duration };
  }

  /**
   * Force the real chase escalation, for the debug page's chase trigger.
   *
   * Calls `enterChase`, which is the same function `perceive()` reaches when a
   * sighting matures past `spotTime`. That matters: the button has to reproduce
   * the transition the player actually sees — the walk->run crossfade, the
   * posture layer easing in over `easeIn`, the opening lunge burst and the
   * repath to the player's cell. Assigning `state = 'chase'` from outside would
   * skip every one of those and the tool would be demonstrating a transition the
   * game never performs.
   *
   * A thin public wrapper rather than the debug page reaching into a private:
   * a cast through `unknown` would also survive tsc but breaks silently under
   * minification, which is exactly what happened when this page first tried it.
   */
  debugForceChase(player: THREE.Vector3) { this.enterChase(player); }

  /** Seek the current clip, in seconds, clamped to its duration. */
  seekClip(seconds: number) {
    if (!this.current) return;
    const a = this.actions.get(this.current);
    const clip = a?.getClip();
    if (!a || !clip) return;
    a.time = Math.min(Math.max(0, seconds), clip.duration);
  }

  /**
   * Advance ONLY the animation, by `dt` seconds, with no AI and no movement.
   *
   * The debug page uses this for its play/pause and scrubbing so a clip can be
   * watched in isolation while he stands still. `update()` cannot serve that
   * purpose because it also perceives, plans, walks and re-poses him.
   */
  tickAnimationOnly(dt: number) { this.mixer?.update(dt); }

  /**
   * The TRUE rendered extent of the monster, measured through the skeleton on the
   * frame you ask for — i.e. with the mixer having actually run.
   *
   * `load()` scales him off a bind-pose measurement, and the handoff was right to
   * be suspicious of that: a bind-pose number can be an honest measurement of a
   * pose nobody ever sees. This is the check that closes it. It pushes real
   * vertices through `applyBoneTransform` (the same maths the vertex shader runs)
   * and then through the full world matrix, so the box it returns includes the
   * armature's cm->m 0.01, the auto-scale, the model child's yaw correction and
   * the group transform — everything that could shrink him after load().
   *
   * Deliberately NOT called per frame. It is ~600 skinned-vertex evaluations and
   * exists for the capture harness and for asserting against `CFG.maze.wallHeight`
   * and the 1.68 m eye line.
   */
  measureWorldBounds(): { height: number; min: number[]; max: number[]; scale: number } | null {
    const skinned = this.model?.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh | undefined;
    if (!skinned || !this.model) return null;
    skinned.updateMatrixWorld(true);
    const posAttr = skinned.geometry.attributes.position;
    const v = new THREE.Vector3();
    const bounds = new THREE.Box3().makeEmpty();
    const stride = Math.max(1, Math.floor(posAttr.count / 600));
    for (let i = 0; i < posAttr.count; i += stride) {
      v.fromBufferAttribute(posAttr, i);
      skinned.applyBoneTransform(i, v);
      skinned.localToWorld(v);
      bounds.expandByPoint(v);
    }
    return {
      height: bounds.max.y - bounds.min.y,
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
      scale: this.model.scale.x,
    };
  }

  /**
   * Where the mesh is actually pointing, in world space, as a unit vector.
   *
   * The facing bug was invisible for a wave because the AI's own numbers all
   * agreed with each other — `followPath` writes the group's yaw and `perceive`
   * reads the cone off the same +Z, so both were self-consistent while the MESH
   * sat a quarter turn away from both. Reporting the model child's world +Z
   * separately from the group's is what makes that disagreement measurable
   * instead of something you have to see in a screenshot and argue about.
   */
  facingProbe(player: THREE.Vector3) {
    if (!this.model) return null;
    /**
     * Read the mesh's ANATOMICAL forward as the model child's WORLD +Z.
     *
     * `load()` turns the model by PI so that its authored -Z forward lands on the
     * group's +Z, so after that correction the child's own world +Z IS the face
     * direction, and this probe needs no anatomical fudge factor at all.
     *
     * This line previously read local +X and carried a comment asserting the mesh
     * was authored facing +X. Both were wrong together, and being wrong together
     * is what hid the bug for a wave: the instrument agreed with the broken
     * correction, so a monster charging shoulder-first measured as 0 deg error.
     * The axis is now established by measurement rather than assertion — see the
     * three-way determination in `load()`.
     */
    const meshFwd = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.model.getWorldQuaternion(new THREE.Quaternion()))
      .setY(0).normalize();
    const groupFwd = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.group.quaternion).setY(0).normalize();
    const toPlayer = new THREE.Vector3(
      player.x - this.group.position.x, 0, player.z - this.group.position.z,
    );
    if (toPlayer.lengthSq() < 1e-8) return null;
    toPlayer.normalize();
    const deg = (r: number) => Math.round((r * 180) / Math.PI * 10) / 10;
    return {
      // 0 deg = the mesh's face is pointed straight at the player.
      meshToPlayerDeg: deg(Math.acos(THREE.MathUtils.clamp(meshFwd.dot(toPlayer), -1, 1))),
      groupToPlayerDeg: deg(Math.acos(THREE.MathUtils.clamp(groupFwd.dot(toPlayer), -1, 1))),
      // How far the mesh sits from the AI's travel axis. This is the number that
      // was 90 when he charged shoulder-first.
      meshVsGroupDeg: deg(Math.acos(THREE.MathUtils.clamp(meshFwd.dot(groupFwd), -1, 1))),
    };
  }

  /** Crossfade to a clip. Silently no-ops for clips the GLB didn't ship. */
  playClip(name: string, fade = 0.25) {
    const next = this.actions.get(name);
    if (!next || this.current === name) return;
    const prev = this.current ? this.actions.get(this.current) : null;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (prev && fade > 0) prev.crossFadeTo(next, fade, false);
    else if (prev) prev.stop();
    this.current = name;
    // Each clip sits at its own height above the floor; re-plant for this one.
    this.targetGroundY = this.baseModelY + (this.clipGroundOffset.get(name) ?? 0);
    // ...and at its own authored heading; re-aim for this one. Snapped rather than
    // eased: a crossfade between two clips a quarter turn apart would visibly
    // swing him through 90 degrees, which is worse than the cut.
    const yaw = this.clipYawOffset.get(name);
    if (yaw !== undefined && this.model) this.model.rotation.y = yaw;
  }

  /**
   * Work out, per clip, the model yaw that points THAT clip along the group's +Z.
   *
   * Facing is measured from the SHOULDER LINE — `up x (left - right)` — and not
   * from any single bone's local axes. That choice is deliberate: bone axes on
   * this rig have misled every previous attempt at an orientation question. The
   * facing correction was derived wrongly once (PROGRESS.md trap 10) and the
   * `hipPitch` lean was caused by assuming a bone's local X was lateral when the
   * Armature's Blender Z-up conversion had made it FORWARD (trap 16). A vector
   * between two bones cannot lie about which way the chest points.
   *
   * The correction is expressed RELATIVE TO THE RUN, whose -PI/2 was verified by
   * controlled A/B render and by capture in the live game. So the run keeps
   * exactly the value already proven correct, and every other clip is brought into
   * agreement with it — rather than re-deriving an absolute that might disagree
   * with the one thing here that is known to be right.
   */
  private measureClipFacingOffsets(clips: THREE.AnimationClip[]) {
    if (!this.model) return;

    // The exporter strips the colon from `mixamorig:LeftShoulder`; an earlier
    // check in this project silently resolved ZERO bones because of it and then
    // reported 0.00 for everything (trap 14). Match on alphanumerics only.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const bones = new Map<string, THREE.Object3D>();
    this.model.traverse((o) => { if ((o as THREE.Bone).isBone) bones.set(norm(o.name), o); });
    const pick = (...names: string[]) => {
      for (const n of names) { const b = bones.get(norm(n)); if (b) return b; }
      return undefined;
    };
    const L = pick('mixamorig:LeftShoulder', 'LeftShoulder', 'mixamorig:LeftArm', 'LeftArm');
    const R = pick('mixamorig:RightShoulder', 'RightShoulder', 'mixamorig:RightArm', 'RightArm');
    if (!L || !R) {
      console.warn('[monster] shoulder bones not found; per-clip facing left at the constant');
      return;
    }

    const savedYaw = this.model.rotation.y;
    this.model.rotation.y = 0;                 // measure the AUTHORED facing

    const probe = new THREE.AnimationMixer(this.model);
    const up = new THREE.Vector3(0, 1, 0);
    const lp = new THREE.Vector3(), rp = new THREE.Vector3();
    const across = new THREE.Vector3(), fwd = new THREE.Vector3();

    const authored = new Map<string, number>();
    for (const clip of clips) {
      const action = probe.clipAction(clip);
      probe.stopAllAction();
      action.reset().play();

      // Circular mean over the cycle, so a clip that turns slightly (walk spreads
      // 11 deg) still yields a stable heading and +179/-179 cannot average to 0.
      let sx = 0, sy = 0;
      const N = 16;
      for (let i = 0; i < N; i++) {
        probe.setTime(clip.duration * (i / N));
        this.model.updateMatrixWorld(true);
        L.getWorldPosition(lp);
        R.getWorldPosition(rp);
        across.copy(lp).sub(rp).setY(0).normalize();
        fwd.crossVectors(up, across).normalize();
        const y = Math.atan2(fwd.x, fwd.z);
        sx += Math.cos(y); sy += Math.sin(y);
      }
      authored.set(clip.name, Math.atan2(sy, sx));
    }
    probe.stopAllAction();

    // Anchor on the run: keep its proven -PI/2, and shift every other clip by how
    // far its authored heading differs from the run's.
    const runYaw = authored.get('run');
    if (runYaw === undefined) { this.model.rotation.y = savedYaw; return; }
    for (const [name, yaw] of authored) {
      let delta = yaw - runYaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.clipYawOffset.set(name, MESH_FORWARD_CORRECTION - delta);
    }

    this.model.rotation.y = this.clipYawOffset.get(this.current ?? 'run') ?? savedYaw;
    this.model.updateMatrixWorld(true);
  }

  /**
   * Work out, per clip, how far off the floor that clip actually leaves him.
   *
   * The load-time ground plant uses the BIND POSE, which is the one pose the game
   * never displays. Every clip sits at a different height, and measuring the full
   * cycle rather than one instant is what separates a real flight phase from a
   * character who simply hovers:
   *
   *   clip        lowest foot over the cycle
   *   run          -0.015   <- touches down; airborne frames are a real flight phase
   *   walk          0.049
   *   idle          0.051
   *   jumpscare     0.256   <- never touches down. He hangs in the air for the kill.
   *
   * A single mid-clip sample had reported the feet planted at 0.019 and missed all
   * of this. The user saw it before the instrument did.
   *
   * The offset is the clip's own lowest point, so every clip's *lowest* moment
   * grazes the floor and its flight phases still leave the ground.
   */
  private measureClipGroundOffsets(skinned: THREE.SkinnedMesh, clips: THREE.AnimationClip[]) {
    const probe = new THREE.AnimationMixer(this.model!);
    const v = new THREE.Vector3();
    const posAttr = skinned.geometry.attributes.position;
    // Coarser than the load-time bounds pass: this runs once per clip per sample,
    // and we only need the floor contact to the centimetre.
    const stride = Math.max(1, Math.floor(posAttr.count / 220));
    const SAMPLES = 20;

    for (const clip of clips) {
      const action = probe.clipAction(clip);
      probe.stopAllAction();
      action.reset().play();

      let lowest = Infinity;
      for (let s = 0; s < SAMPLES; s++) {
        probe.setTime(clip.duration * (s / SAMPLES));
        this.model!.updateMatrixWorld(true);
        skinned.updateMatrixWorld(true);
        for (let i = 0; i < posAttr.count; i += stride) {
          v.fromBufferAttribute(posAttr, i);
          skinned.applyBoneTransform(i, v);
          skinned.localToWorld(v);
          if (v.y < lowest) lowest = v.y;
        }
      }
      if (Number.isFinite(lowest)) this.clipGroundOffset.set(clip.name, -lowest);
    }

    probe.stopAllAction();
    this.model!.updateMatrixWorld(true);
  }

  spawn(cellX: number, cellY: number) {
    const [wx, wz] = this.maze.cellToWorld(cellX, cellY);
    this.group.position.set(wx, 0, wz);
  }

  /**
   * Put him somewhere the director can actually work from, and hand back the cell.
   *
   * THIS IS THE OPENING-THREE-MINUTES FIX, and it is the single most expensive bug
   * this lane has had. game.ts spawned him at the door — by construction the
   * deepest cell in the maze, measured at 87.1 cells from the player averaged over
   * 10 seeds (worst 120). His own quiet band is 10-22 cells. He therefore began
   * every run 4x outside the far edge of the band he is supposed to be quietly
   * patrolling, and at walkSpeed 1.75 m/s across 4 m cells simply commuting into
   * his own band is ~200 s of walking.
   *
   * Measured consequence, `lane-ai-hunt.mjs --mode opening --spawn deepest`:
   *
   *     spawn 87.1 cells -> quiet band at 133 s -> first stalk 172 s
   *     -> first unaware near-miss 175 s -> first chase 191 s   (medians, 10 seeds)
   *
   * Three minutes of an empty maze, and that is in a *simulation running at real
   * time*. In the capture harness under SwiftShader the game clamps dt and sim time
   * advances at roughly an eighth of wall time, so a critic playing for ten wall
   * minutes never saw him at all and correctly reported the hunt as dead code.
   *
   * The fix is not to make him faster or the band wider — both were considered and
   * both damage the thing the director exists to protect. It is to start him inside
   * the band, which is exactly where a completed `quiet` beat would have put him
   * anyway. So the opening is now the same world-state as the middle of a run, and
   * the first approach is a normal beat rather than a 200 s commute.
   *
   * `openingMinCells` is deliberately a *higher* floor than `quietMinCells`: the
   * band's floor is fine once the player is moving and has heard him, but landing
   * 10 cells away at t=0 while the player is still reading the HUD is a chase in
   * the first fifteen seconds, which spends the whole dread budget immediately.
   *
   * He is also placed with NO line of sight to the player, so the game cannot open
   * with him already staring down your corridor.
   *
   * Returns the chosen cell so callers can log or test it; falls back to the
   * farthest reachable cell only if the band is somehow empty (a maze small enough
   * for that would already have failed the layout gate).
   */
  spawnNearPlayer(player: THREE.Vector3, rand: () => number = Math.random): [number, number] {
    const d = CFG.monster.director;
    const [px, py] = this.maze.worldToCell(player.x, player.z);
    let chosen: number = -1;

    if (this.maze.inBounds(px, py)) {
      const field = this.maze.distanceField(px, py);
      const blind: number[] = [];
      const any: number[] = [];
      for (let i = 0; i < field.length; i++) {
        const dist = field[i];
        if (dist < d.openingMinCells || dist > d.quietMaxCells) continue;
        any.push(i);
        const cx = i % this.maze.cols, cy = (i / this.maze.cols) | 0;
        const [wx, wz] = this.maze.cellToWorld(cx, cy);
        if (!this.maze.hasLineOfSight(wx, wz, player.x, player.z)) blind.push(i);
      }
      const pool = blind.length ? blind : any;
      if (pool.length) chosen = pool[(rand() * pool.length) | 0];

      if (chosen < 0) {
        // Band empty — take the cell whose distance is closest to it rather than
        // the farthest cell in the maze, which is the failure this method exists
        // to remove.
        let bestErr = Infinity;
        for (let i = 0; i < field.length; i++) {
          const dist = field[i];
          if (dist < 0) continue;
          const err = dist < d.openingMinCells
            ? d.openingMinCells - dist
            : dist > d.quietMaxCells ? dist - d.quietMaxCells : 0;
          if (err < bestErr) { bestErr = err; chosen = i; }
        }
      }
    }

    if (chosen < 0) chosen = 0;
    const cell: [number, number] = [chosen % this.maze.cols, (chosen / this.maze.cols) | 0];
    this.spawn(cell[0], cell[1]);
    this.resetHunt();
    return cell;
  }

  /**
   * Wipe every scrap of hunt state, so a Retry cannot inherit the chase that just
   * killed you.
   *
   * game.ts's restart() sets `state = 'patrol'` and nothing else, which leaves
   * `lostTimer`, `chaseElapsed`, `chaseCooldown`, the spent path, the search probe
   * list and — worst — `beatPlanned` and `beatTimer` exactly as the previous life
   * left them. The visible symptom is a retry that opens with a partly-elapsed
   * beat pointed at where you died, plus a `chaseCooldown` that can suppress the
   * first chase of the new run for up to 8 s for no reason the player can see.
   */
  resetHunt() {
    this.state = 'patrol';
    this.path = [];
    this.pathIndex = 0;
    this.repathTimer = 0;
    // Stale travel direction across a teleport/respawn would let the first
    // repath skip a waypoint on the strength of where he was walking in a
    // different part of the maze.
    this.travelDirX = 0;
    this.travelDirZ = 0;
    this.sightTimer = 0;
    this.lostTimer = 0;
    this.chaseElapsed = 0;
    this.chaseCooldown = 0;
    this.searchTimer = 0;
    this.searchProbes = [];
    this.probeDwell = 0;
    this.searchStillFor = 0;
    this.leadConfidence = 0;
    this.interceptCell = null;
    this.havePrevPlayer = false;
    this.playerVel.set(0, 0, 0);
    this.justSpotted = false;
    this.seesPlayer = false;
    this.distanceToPlayer = Infinity;
    this.lastKnown.copy(this.group.position);
    // Force a cold-start director decision on the next update: he opens quiet,
    // from inside the band, which is the whole point of spawnNearPlayer.
    this.beatPlanned = false;
    this.beat = 'quiet';
    this.beatTimer = 0;
    this.beatTarget = null;
    this.replanTimer = 0;
    // A Retry is a fresh run and gets a fresh opening grace.
    this.openingBeat = true;
    this.moveSpeed = CFG.monster.walkSpeed;
    this.lungeTimer = 0;
    this.gazeAvertTimer = 0;
    this.evadeLatched = false;
    this.sightAcuity = 0;
    this.pauseTimer = 0;
    this.pauseCooldown = CFG.monster.patrol.pauseEveryMin;
  }

  private get cell(): [number, number] {
    return this.maze.worldToCell(this.group.position.x, this.group.position.z);
  }

  /**
   * Re-solve the route to a cell — and DO NOT send him backwards to do it.
   *
   * THE BUG THIS FIXES, measured with `tools/mazelab/RC-backstep.mjs` over 96
   * simulated minutes of the real class:
   *
   *   repaths while moving ................ 44.02/min
   *   first waypoint BEHIND his heading ... 39.3%, median 3.66 m backwards
   *   heading reversals >120 deg .......... 16.01/min
   *     ...of which within 0.25 s of a repath .. 95.4%
   *
   * A* waypoints are CELL CENTRES and `maze.path` starts from the cell he is
   * standing in, so the first waypoint is always his OWN cell's centre. He is a
   * median 1.00 m past that centre by the time a repath lands (cells are 4 m), so
   * two repaths in five handed him a first waypoint behind him: he turned round,
   * walked back to a centre he had already left, consumed it, turned round again
   * and carried on. Every subsystem measured healthy in isolation — director
   * target lifetime a fine 4.98 s, churn down to 5.41/min after the `evadeLatched`
   * fix — while the thing the player actually sees, a body pivoting on the spot
   * four times per cell, came from none of them. This is the residual of the
   * user's "he still runs in weird circles and such".
   *
   * THE FIX. Drop that leading waypoint when it is behind him, but ONLY when the
   * one after it is somewhere he could legally walk to in a straight line from
   * here. That proviso is load-bearing: skipping blindly would let him cut across
   * a corner the geometry forbids, which is exactly how `canLungeAt` earned its
   * comment about 5 diagonal wall crossings in a 300-minute soak. Same rule here —
   * same cell, or one orthogonal step through an open edge.
   *
   * Deliberately NOT touched: `evadeLatched`, `commitDistance`/`commitAcuity` and
   * the proximity override on `chaseCooldown`. This is a separate defect from the
   * level-triggered evade branch a previous agent fixed, and it sits underneath
   * it — which is why that fix measured a real improvement and the user still saw
   * circling afterwards.
   */
  private repath(tx: number, ty: number) {
    const [cx, cy] = this.cell;
    const p = this.maze.path(cx, cy, tx, ty);
    if (!p || !p.length) return;
    this.path = p;
    this.pathIndex = 0;

    /**
     * ARRIVED-CELL REPATH — the single biggest source of the residual circling.
     *
     * `maze.path` INCLUDES the start cell, so asking it to route from a cell to
     * itself returns exactly one waypoint: that cell's own centre. Measured over
     * 32 simulated minutes of the real class:
     *
     *   72.4% of all repath calls returned a single waypoint
     *   100%  of those had goal == the cell he is already standing in
     *   42%   of those handed him a waypoint a median 1.04 m BEHIND him
     *
     * So he walks back to the middle of the cell he is already in, arrives, and
     * the next repath 0.35-1.1 s later does it again. That is the "small circles"
     * the player sees, and it is invisible to every other metric: the director is
     * not churning (target lifetime 4.98 s), no path is invalid, and he is
     * technically always making progress toward a legitimate goal.
     *
     * If he is already in the goal cell there is nothing to walk to. Clear the
     * path and let the caller decide what to do with a finished route rather than
     * manufacturing a backwards step to a point he has already passed. The chase
     * endgame in `update()` already handles `pathDone()` explicitly — that is what
     * `canLungeAt` and the neighbour-cell fallback are for — so this hands control
     * back to code that is expecting it.
     */
    if (cx === tx && cy === ty) { this.path = []; this.pathIndex = 0; return; }

    if (p.length < 2) return;

    const px = this.group.position.x;
    const pz = this.group.position.z;
    const [w0x, w0z] = p[0];
    const d0 = Math.hypot(w0x - px, w0z - pz);
    // Nothing to skip if he is essentially standing on it; `followPath` already
    // drains waypoints inside 0.28 m.
    if (d0 <= 0.28) return;

    /**
     * Is that first waypoint behind him?
     *
     * Tested against `travelDir` — the actual direction he MOVED, accumulated in
     * `stepToward` — and NOT against `group.rotation.y`. That distinction is the
     * whole correctness of this branch and it cost a measured regression to
     * learn: the group yaw is damped toward travel (`turnRate` in `stepToward`)
     * and is additionally driven by the patrol look-around and the search dwell,
     * so it lags and sometimes points somewhere he is not going at all. Using it
     * here fired the skip on stale yaw and pushed reversals from 16.01/min to
     * 20.16/min — worse than the bug.
     *
     * Skipping is only safe when the waypoint AFTER it is somewhere he could walk
     * to in a straight line from where he actually stands. Without that proviso
     * he would cut corners the geometry forbids, which is how `canLungeAt` earned
     * its note about 5 diagonal wall crossings in a 300-minute soak. Same rule
     * applied here: same cell, or one orthogonal step through an open edge.
     */
    if (this.travelDirX === 0 && this.travelDirZ === 0) return;
    const dot = ((w0x - px) / d0) * this.travelDirX + ((w0z - pz) / d0) * this.travelDirZ;
    // -0.35 rather than 0: only a waypoint genuinely behind him, not one merely
    // off to the side, which he can walk to without any visible pivot.
    if (dot >= -0.35) return;

    const [w1x, w1z] = p[1];
    const [n1x, n1y] = this.maze.worldToCell(w1x, w1z);
    if (!this.maze.inBounds(cx, cy) || !this.maze.inBounds(n1x, n1y)) return;
    const dx = n1x - cx, dy = n1y - cy;
    const straight = (dx === 0 && dy === 0)
      || (dx === 0 && Math.abs(dy) === 1 && this.maze.isOpen(cx, cy, dx, dy))
      || (dy === 0 && Math.abs(dx) === 1 && this.maze.isOpen(cx, cy, dx, dy));
    if (straight) this.pathIndex = 1;
  }

  private wanderTarget() {
    const x = (Math.random() * this.maze.cols) | 0;
    const y = (Math.random() * this.maze.rows) | 0;
    this.repath(x, y);
  }

  // ---- the director --------------------------------------------------------

  /**
   * Corridor distance from him to the player, in cells, or -1 if either of them is
   * off the grid. This is the quantity the whole director is budgeted in: "8 metres
   * away" through three walls is not near, and pacing a hunt in straight-line
   * metres is what let the old stalk think a 73-cell trek was a short walk.
   */
  private corridorCellsToPlayer(player: THREE.Vector3): number {
    const [px, py] = this.maze.worldToCell(player.x, player.z);
    const [mx, my] = this.cell;
    if (!this.maze.inBounds(px, py) || !this.maze.inBounds(mx, my)) return -1;
    const field = this.maze.distanceField(px, py);
    return field[this.maze.idx(mx, my)];
  }

  /**
   * Enter a beat and size its clock.
   *
   * The asymmetry here is the entire fix. `quiet` and `stalk` are DWELL beats and
   * get a duration in seconds, because what they are is a length of time — time
   * spent away, and time spent loitering near you. `approach` is a TRANSIT beat and
   * gets no design duration at all: it ends when `corridorCellsToPlayer` says he has
   * actually arrived. Its timer is only a failsafe, and it is budgeted from the
   * distance he has been asked to cover, so a 70-cell trek gets a 70-cell budget.
   *
   * The old code gave transit a flat 14-24 s. At 0.44 cells/s that bought 7.9 cells
   * against measured gaps of 41-73, so every approach and every stalk expired
   * mid-corridor and handed back to quiet, which routed him away again.
   */
  private enterBeat(beat: DirectorBeat, player: THREE.Vector3, rand: () => number) {
    const d = CFG.monster.director;
    const span = (min: number, max: number) => min + rand() * (max - min);
    this.beat = beat;
    this.beatPlanned = true;
    this.beatTarget = null;
    this.replanTimer = 0;

    if (beat === 'quiet') {
      this.beatTimer = span(d.quietMin, d.quietMax);
    } else if (beat === 'stalk') {
      this.beatTimer = span(d.stalkMin, d.stalkMax);
    } else {
      const cells = this.corridorCellsToPlayer(player);
      const gap = Math.max(0, cells < 0 ? d.quietMaxCells : cells - d.stalkArriveCells);
      const walkSeconds = (gap * this.maze.cellSize) / Math.max(0.1, CFG.monster.walkSpeed);
      this.beatTimer = Math.max(d.transitMinSeconds, walkSeconds * d.transitSlack);
    }
  }

  /**
   * Pick the next pacing beat. The cycle is deliberately not a rotation: after a
   * stalk he always goes quiet again, so a near-miss is followed by silence rather
   * than by another near-miss. That silence is what makes the next approach land.
   *
   * Note there is no longer a quiet -> stalk shortcut. A stalk can only be reached
   * by completing an approach, because a stalk is now defined as "loitering near
   * you", and he cannot loiter near you from the far side of the maze. The old
   * shortcut is precisely how stalks came to begin at 73 cells.
   */
  private planBeat(player: THREE.Vector3, rand: () => number) {
    // The opening is over the moment the first beat hands over — from here on he
    // uses the full quiet band like any other beat.
    this.openingBeat = false;
    if (this.beat === 'quiet') {
      this.enterBeat('approach', player, rand);
    } else if (this.beat === 'approach') {
      // An approach that RAN OUT OF TIME broke off — he was coming, and then he was
      // not, and you never learn why. Arrival is handled in updateDirector and
      // promotes to stalk there; reaching this branch means the failsafe fired.
      this.enterBeat('quiet', player, rand);
    } else {
      this.enterBeat('quiet', player, rand);
    }
  }

  /**
   * Choose a patrol destination that satisfies the current beat.
   *
   * All three beats work off a BFS distance field from the player, so "near" and
   * "far" mean corridor distance rather than straight-line distance through six
   * walls — being 3m from the player with a wall between you is not near.
   *
   * The stalk additionally requires NO line of sight from the target cell to the
   * player. That is what produces the near-miss: he walks the corridor next to
   * yours, audible the whole way, and never turns his head.
   */
  private directorTarget(player: THREE.Vector3, rand: () => number): [number, number] | null {
    const d = CFG.monster.director;
    const [px, py] = this.maze.worldToCell(player.x, player.z);
    if (!this.maze.inBounds(px, py)) return null;
    const field = this.maze.distanceField(px, py);

    let lo: number, hi: number, requireBlind: boolean;
    if (this.beat === 'quiet') {
      // A ceiling as well as a floor. With `hi = Infinity` the sampler happily sent
      // him to the far corner of a maze whose corridor diameter is 93 cells, and no
      // approach can recover from that inside any tolerable beat — measured stalk
      // starts of 73 and 69 cells are exactly this failure.
      lo = d.quietMinCells; hi = d.quietMaxCells; requireBlind = false;
      /**
       * THE OPENING QUIET IS DIFFERENT, and it has to be.
       *
       * Once he spawns inside the band (see spawnNearPlayer), an ordinary quiet
       * beat is free to route him to a cell 10 cells away — which is 40 m, well
       * inside `sightRange` 22 m once a corridor lines up. Traced over 4 seeds the
       * result was chases beginning at 17.1 s and 15 s, one of them from 20 m down
       * a straight corridor, and a game whose first thirty seconds are a sprint is
       * not the game in the brief. The old far-corner spawn had exactly one virtue
       * and this is it: the player got to be alone for a while first.
       *
       * So the FIRST quiet beat only — the one that runs from spawn, marked by
       * `openingBeat` — is restricted to the outer half of the band.
       * That buys the player the opening minute honestly, through where he chooses
       * to walk, rather than by switching his eyes off. Every subsequent quiet uses
       * the full band, so the maze does not stay artificially large.
       *
       * THE OPENING ALSO TAKES THE ROUTE VETO, and that is an integration fix.
       *
       * The distance floor above constrains where he ENDS. It says nothing about
       * the corridor he WALKS to get there — which is the identical mistake this
       * file already documents for the stalk band ("the near-miss is a property of
       * the route, not the destination"), made a second time one branch higher up.
       * An opening target 16 cells away can perfectly well be reached by a path
       * that crosses the player's corridor at 8 m with a clean sightline, and
       * `spotTime` is 0.45 s.
       *
       * MEASURED in a full 41-beat scripted playthrough on the static build: he
       * left spawn at 16 corridor cells and was at 3 cells and CHASING by the
       * `explore_walk_3` beat — roughly nine seconds into the run, before the
       * player had collected anything or seen a gem. That is the same failure the
       * comment above says was fixed at 17.1 s and 15 s, still live, because the
       * fix was applied to the destination only.
       *
       * `requireBlind` on the opening costs one extra A*-per-candidate pass over a
       * band that has already been cut to a couple of dozen cells, once, at spawn.
       * If no blind route exists the existing fallthrough takes the generic pick,
       * so this can only ever improve the opening, never stall it.
       */
      if (this.openingBeat) {
        lo = Math.max(lo, d.openingMinCells);
        requireBlind = true;
      }
    } else if (this.beat === 'approach') {
      // Transit aims THROUGH the arrival ring rather than at its outer edge: a
      // target one cell inside the ring means arriving is unambiguous, and the
      // re-solve every second keeps it pinned to where the player is now.
      lo = 0; hi = Math.max(1, d.stalkArriveCells - 1); requireBlind = false;
    } else {
      lo = d.stalkNearCells; hi = d.stalkFarCells; requireBlind = true;
    }

    const candidates: number[] = [];
    for (let i = 0; i < field.length; i++) {
      const dist = field[i];
      if (dist < 0 || dist < lo || dist > hi) continue;
      if (requireBlind) {
        const cx = i % this.maze.cols, cy = (i / this.maze.cols) | 0;
        const [wx, wz] = this.maze.cellToWorld(cx, cy);
        /**
         * A stalk target he would NOTICE the player from is just a slow approach;
         * reject it. A target the player can merely SEE is kept — see the long
         * note on `routeIsBlind`. This filter used to reject all mutual line of
         * sight, and because sight is symmetric that rejected every cell from
         * which the player could ever have laid eyes on him.
         *
         * The cheap range and line-of-sight tests come first so the trigonometry
         * only runs on the handful of band cells that can see the player at all.
         */
        if (Math.hypot(player.x - wx, player.z - wz) < CFG.monster.sightRange
            && this.maze.hasLineOfSight(wx, wz, player.x, player.z)
            && this.wouldNoticeArrivingAt(i, player)) continue;
      }
      candidates.push(i);
    }

    /**
     * For a stalk, the destination being blind is not enough — the WALK has to be
     * blind, and that is where the near-miss actually lives. He can end at a cell
     * with no sightline having crossed three junctions that all looked straight at
     * the player, and that walk is not a near-miss, it is a chase with extra steps.
     *
     * So filter the surviving candidates by their route. This is done after the
     * band filter rather than inside it because it costs an A* per candidate, and
     * the band has already cut the field from 441 cells to a couple of dozen.
     * Candidates are shuffled first so taking the first `maxRouteChecks` that pass
     * is still an unbiased sample of the band rather than a scan order.
     */
    if (requireBlind && candidates.length) {
      const shuffled = candidates.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = (rand() * (i + 1)) | 0;
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const maxRouteChecks = 12;
      const blindRoutes: number[] = [];
      for (let k = 0; k < shuffled.length && k < maxRouteChecks; k++) {
        if (this.routeIsBlind(shuffled[k], player)) blindRoutes.push(shuffled[k]);
      }
      if (blindRoutes.length) {
        /**
         * Pick uniformly among the blind-route candidates.
         *
         * MEASURED ALTERNATIVE, REJECTED: preferring the candidate furthest from
         * where he currently stands, to make him cross to the other side of the
         * player and so produce several distinct passes per beat. It reads well on
         * paper and it is worse in every number that matters — over 25 minutes it
         * took chase share from 16.8% to 22.7% and the near-miss rate from 0.25/min
         * DOWN to 0.16/min. The reason is geometric: the blind cell furthest from
         * him is usually on the far side of the player, and the route there has to
         * squeeze past the player through the junctions that connect the two sides,
         * which is exactly where the sightlines are. Maximising separation fights
         * the blindness constraint instead of composing with it.
         */
        const pick = blindRoutes[(rand() * blindRoutes.length) | 0];
        return [pick % this.maze.cols, (pick / this.maze.cols) | 0];
      }
      // No blind route exists from where he stands. Rather than take a route that
      // walks him through the player's sightline, fall through to the generic
      // pick below — the caller's continuous check will re-route him next tick.
    }

    /**
     * Every band can now come up empty — quiet has a ceiling, and a stalk in an
     * open junction may find no cell within 4 that the player cannot see.
     *
     * The old fallback sent him to the FARTHEST cell in the maze, which for a
     * failed stalk is the exact opposite of the intent and is one of the ways
     * stalks came to start 70 cells out. Instead, fall back to the nearest cell to
     * the band that still satisfies the beat's *direction*: for a stalk, drop the
     * blindness requirement before dropping the proximity, because being near him
     * and briefly visible is still a near-miss, whereas being blind and 70 cells
     * away is nothing at all.
     */
    if (!candidates.length) {
      if (requireBlind) {
        // Retry the same band without the line-of-sight veto.
        let best = -1, bestD = Infinity;
        for (let i = 0; i < field.length; i++) {
          const dist = field[i];
          if (dist < 0 || dist < lo || dist > hi) continue;
          if (dist < bestD) { bestD = dist; best = i; }
        }
        if (best >= 0) return [best % this.maze.cols, (best / this.maze.cols) | 0];
      }
      // Otherwise take the reachable cell whose distance is closest to the band —
      // he still moves in the right direction rather than freezing on a failed plan.
      let best = -1, bestErr = Infinity;
      for (let i = 0; i < field.length; i++) {
        const dist = field[i];
        if (dist < 0) continue;
        const err = dist < lo ? lo - dist : dist > hi ? dist - hi : 0;
        if (err < bestErr) { bestErr = err; best = i; }
      }
      if (best < 0) return null;
      return [best % this.maze.cols, (best / this.maze.cols) | 0];
    }

    const pick = candidates[(rand() * candidates.length) | 0];
    return [pick % this.maze.cols, (pick / this.maze.cols) | 0];
  }

  /**
   * Would walking to cell index `goal` keep him from NOTICING the player the whole
   * way — while still allowing the player to catch sight of HIM?
   *
   * ---- THE SYMMETRY BUG THIS EXISTS TO FIX --------------------------------
   *
   * This predicate used to reject any route where a sampled waypoint had raw line
   * of sight to the player, and justified it in a comment that said his facing
   * "cannot be known in advance, so assuming the worst is the only honest test".
   *
   * That reasoning is wrong in a way that deleted the game's best beat, because
   * **line of sight is symmetric**. A route he cannot be seen FROM is precisely a
   * route he cannot be seen ON. Vetoing all mutual line of sight does not merely
   * stop him spotting the player — it guarantees the player never spots him
   * either, so the entire unaware near-miss existed only as a telemetry counter.
   * Measured on the shipped build before this change: over 80 simulated minutes,
   * 178.5 s of unaware-with-geometric-line-of-sight, of which 1.5 s was inside the
   * camera frustum and **0.0 s inside the flashlight beam**. Zero, not rare.
   *
   * Amnesia's whole dread economy is the opposite: the Grunt walks past the closet
   * slats in full view, and the sanity penalty for looking at him only makes sense
   * BECAUSE you can see him. Watching him fail to find you is the beat.
   *
   * ---- WHY THE ASYMMETRIC TEST IS HONEST, NOT A CHEAT ---------------------
   *
   * The premise that his facing is unknowable is simply false. `stepToward` turns
   * him to face his direction of travel, so his heading at waypoint `i` is the
   * route's own tangent there — this function is computing that route, so it knows
   * the heading exactly. What it could not know before is only whether the tangent
   * happens to point at the player, and that is a two-line calculation.
   *
   * So the veto is now ASYMMETRIC: a waypoint is rejected only when the player
   * would fall inside his facing-dependent vision cone, i.e. when he would
   * actually perceive them. A waypoint where he has geometric line of sight but is
   * walking with his head turned away is ACCEPTED, and that is the shot the piece
   * was missing — he crosses a lit junction six metres ahead, in the beam, looking
   * the other way, and never breaks stride.
   *
   * This does not make him blind and it does not suppress perception. `perceive`
   * is untouched: if he does turn and the player is in his cone, `sightTimer`
   * accrues and he chases exactly as before. All that changes is which routes he
   * is willing to CHOOSE, and he now chooses ones on which he is visible but
   * inattentive rather than ones on which he is absent.
   *
   * `visionMargin` widens the rejected cone slightly beyond `sightAngle`, because
   * the tangent is a prediction: a corner taken slightly wide, or the damped turn
   * lagging the path, can swing the real heading a few degrees off the sampled
   * one. The margin buys that error back so a route accepted here does not become
   * a chase on the walk.
   */
  private routeIsBlind(goal: number, player: THREE.Vector3): boolean {
    const [cx, cy] = this.cell;
    const gx = goal % this.maze.cols, gy = (goal / this.maze.cols) | 0;
    const route = this.maze.path(cx, cy, gx, gy);
    if (!route || !route.length) return false;

    const samples = Math.max(2, CFG.monster.director.stalkRouteSamples);
    const n = route.length;
    const step = Math.max(1, Math.floor(n / samples));
    for (let i = 0; i < n; i += step) {
      if (this.wouldNoticeAt(route, i, player)) return false;
    }
    // Always test the final waypoint, whatever the stride landed on.
    if (this.wouldNoticeAt(route, n - 1, player)) return false;
    return true;
  }

  /**
   * Would he notice the player once he has ARRIVED at cell index `goal`?
   *
   * The destination is the one waypoint whose facing is decided entirely by the
   * approach, because he stops there. So this asks the route for its final inbound
   * tangent rather than assuming the worst — the same asymmetry as `routeIsBlind`,
   * applied to the cell he will dwell in.
   *
   * Returns true (reject) when the route cannot be computed, because a destination
   * he has no path to is not a stalk target worth keeping.
   */
  private wouldNoticeArrivingAt(goal: number, player: THREE.Vector3): boolean {
    const [cx, cy] = this.cell;
    const gx = goal % this.maze.cols, gy = (goal / this.maze.cols) | 0;
    const route = this.maze.path(cx, cy, gx, gy);
    if (!route || !route.length) return true;
    return this.wouldNoticeAt(route, route.length - 1, player);
  }

  /**
   * Would he perceive the player from waypoint `i` of `route`, given the heading
   * that walking this route actually gives him there?
   *
   * The three conditions are `perceive`'s own, in the same order and with the same
   * constants, so the planner rejects exactly what the perception system would
   * punish and nothing more:
   *   1. inside `sightRange`,
   *   2. unbroken line of sight through the maze,
   *   3. inside the vision cone about his direction of travel.
   *
   * Heading is the route tangent — the direction `stepToward` will be turning him
   * toward at that waypoint. The LAST waypoint is the exception and takes the
   * INBOUND tangent, because he arrives there and stops: `followPath` runs out of
   * path, `stepToward` is never called again, and he keeps whatever heading the
   * final approach left him with. Using an outbound tangent that does not exist
   * would have made the dwell cell — where he spends the most time, and so the
   * cell most likely to convert into a chase — the one waypoint tested against a
   * fictional facing.
   */
  private wouldNoticeAt(route: [number, number][], i: number, player: THREE.Vector3): boolean {
    const m = CFG.monster;
    const [wx, wz] = route[i];
    const dx = player.x - wx, dz = player.z - wz;
    const dist = Math.hypot(dx, dz);
    // Out of range: he cannot notice, and the player almost certainly cannot see
    // him either at that distance, so there is nothing to protect here.
    if (dist >= m.sightRange) return false;
    if (dist < 1e-4) return true;
    if (!this.maze.hasLineOfSight(wx, wz, player.x, player.z)) return false;

    // Heading he will actually carry through this waypoint.
    const j = i > 0 && i >= route.length - 1 ? i - 1 : i;
    const next = route[j + 1] ?? route[j];
    const hx = next[0] - route[j][0], hz = next[1] - route[j][1];
    const hlen = Math.hypot(hx, hz);
    // A degenerate tangent (a one-cell route, or duplicated waypoints) carries no
    // facing information. Fall back to his CURRENT heading rather than guessing,
    // so the test still answers the question it was asked instead of accepting
    // blindly — this is the one place a wrong answer would let him walk up on the
    // player and spot them from a standstill.
    let fx: number, fz: number;
    if (hlen < 1e-4) {
      fx = Math.sin(this.group.rotation.y);
      fz = Math.cos(this.group.rotation.y);
    } else {
      fx = hx / hlen; fz = hz / hlen;
    }

    const cosAngle = (fx * dx + fz * dz) / dist;
    const rawAngle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
    // Outside the cone entirely he cannot perceive at all, whatever the margin.
    if (rawAngle >= m.sightAngle) return false;
    /**
     * Assume he is `visionMargin` MORE face-on than the tangent predicts. The
     * damped turn means his real heading lags the path around a corner, and the
     * error that matters is the one that puts the player closer to his axis than
     * planned — so the margin is spent on caution, not on permissiveness.
     */
    const angle = Math.max(0, rawAngle - m.director.visionMargin);

    /**
     * INSIDE the cone is not the same as NOTICING, and collapsing the two is what
     * kept the beat at 6.7 s per 10 min after the first fix.
     *
     * His cone is 151 deg wide. Rejecting every waypoint anywhere inside it leaves
     * only a ~187 deg rear arc, i.e. he is allowed to be visible essentially only
     * while walking directly AWAY — which is the back of his head at 0-2 m, not the
     * crossing at 6-10 m that the shot needs. Measured: median beam distance 0.7-0.8
     * on three of six seeds, because the only permitted geometry was him leaving.
     *
     * But the cone edge is not where perception actually bites. `acuityFor` already
     * models that: inside `focusAngle` he is unimpaired, and out toward the edge
     * `spotTime` stretches by up to `peripheralSpotScale`. So the honest question is
     * not "is the player in the cone" but "would this sighting CONVERT before he has
     * walked past" — exactly the quantity `perceive` accrues.
     *
     * So estimate the conversion directly. Acuity here is computed against a
     * STATIONARY player (`peripheralMotionFull` is defeated by player motion, and a
     * planner must not assume the player will helpfully move), giving the full
     * peripheral discount the perception model grants. Exposure is how long this
     * waypoint stays in view at walking speed. If the accrued sight time would
     * reach `spotTime`, he would be caught out and the route is rejected; if his own
     * momentum carries him past first, it is a near-miss and is ALLOWED.
     */
    const acuity = this.plannedAcuity(angle);
    const exposure = m.director.waypointExposureSeconds;
    return acuity * exposure >= m.spotTime;
  }

  /**
   * `acuityFor` for a planner: the peripheral discount at `angle` assuming the
   * player is standing still.
   *
   * It deliberately does NOT read `playerVel`. `acuityFor` cancels the peripheral
   * penalty as the player moves, which is correct for perception — motion is what
   * peripheral vision is good at — but a route planner cannot know how the player
   * will move over the next several seconds, and assuming they will move is
   * assuming the case that gets him spotted. Taking the stationary (most
   * forgiving-to-the-monster) figure keeps the plan stable; if the player then
   * walks into his eyeline, `perceive` still catches them at full rate and he still
   * chases. The planner picks the route; it never overrides perception.
   */
  private plannedAcuity(angle: number): number {
    const m = CFG.monster;
    if (angle <= m.focusAngle) return 1;
    const span = Math.max(1e-3, m.sightAngle - m.focusAngle);
    const t = Math.max(0, Math.min(1, (angle - m.focusAngle) / span));
    return 1 / (1 + (m.peripheralSpotScale - 1) * t);
  }

  /**
   * Drop Billy out of the shadow pass when he is too far away to cast into it.
   *
   * He is ~150k triangles — 86% of every triangle in the frame — and `castShadow`
   * was set unconditionally at load, so the flashlight's shadow map re-rasterised
   * all of him every frame even at 56m through six walls with no line of sight.
   *
   * The gate is exact rather than a heuristic: the only shadow-casting light in
   * the scene is the flashlight, whose `distance` is 30m, so its shadow camera's
   * far plane is 30m. A caster beyond that plane is clipped out of the depth pass
   * and cannot darken any pixel — turning it off there is free by construction,
   * not a quality trade. The margin covers his own body radius, so the flag flips
   * well before any part of him could enter the frustum.
   *
   * Written only on a transition, and off a distance the AI already computed.
   */
  private updateShadowCulling(dist: number) {
    const want = dist <= CFG.flashlight.distance + 4;
    if (want === this.shadowsOn) return;
    this.shadowsOn = want;
    for (const mesh of this.shadowMeshes) mesh.castShadow = want;
  }

  /**
   * Can he see the player? Requires all three: inside range, inside the vision
   * cone, and an unbroken line through the maze. Sprinting also makes noise, which
   * counts as a soft detection that gets him moving toward you without a full chase.
   */
  private perceive(player: THREE.Vector3, sprinting: boolean) {
    const dx = player.x - this.group.position.x;
    const dz = player.z - this.group.position.z;
    const dist = Math.hypot(dx, dz);
    this.distanceToPlayer = dist;

    const m = CFG.monster;
    let sees = false;
    /**
     * How fast this sighting accrues toward `spotTime`. 1 = full acuity.
     * Below 1 he is seeing you in the corner of his eye — see `acuityFor`.
     */
    let acuity = 1;
    if (dist < m.sightRange) {
      const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
      const toPlayer = new THREE.Vector3(dx, 0, dz).normalize();
      const angle = facing.angleTo(toPlayer);
      if (angle < m.sightAngle) {
        sees = this.maze.hasLineOfSight(
          this.group.position.x, this.group.position.z, player.x, player.z,
        );
        if (sees) acuity = this.acuityFor(angle);
      }
    }
    /**
     * `seesPlayer` stays RAW line-of-sight, deliberately.
     *
     * It is the published perception flag: the director reads it to break a
     * stalk's sightline, the audio bed and the flashlight flicker read it, and the
     * capture harness measures it. All of those want "is there an unbroken line
     * between his eyes and the player", which is a geometric fact and must not be
     * silently redefined by an attention model. The attention model changes how
     * fast a sighting CONVERTS into a chase, and that is carried by `acuity`.
     */
    this.seesPlayer = sees;
    this.sightAcuity = sees ? acuity : 0;

    /**
     * Hearing is about NOISE, not proximity.
     *
     * The old line was `dist < (sprinting ? sprintRadius : walkRadius)`, which has
     * no term for whether the player is moving — so a player standing dead still
     * was audible at 6 m through a wall, and every near-miss died as a result (see
     * the trace quoted in CFG.monster.hearRadiusWalk). Keeping still is the oldest
     * defence in the genre and it did not work here because it was not implemented.
     *
     * `playerVel` is already maintained for the interception logic, so the player's
     * real speed is available without changing the signature game.ts calls.
     */
    const playerSpeed = Math.hypot(this.playerVel.x, this.playerVel.z);
    const hearRadius = playerSpeed < m.quietSpeed
      ? 0
      : sprinting
        ? m.hearRadiusSprint
        : m.hearRadiusWalk;
    const hears = hearRadius > 0 && dist < hearRadius;

    return { sees, hears, dist, acuity };
  }

  /**
   * How quickly a sighting at `angle` off his facing accrues toward `spotTime`.
   *
   * Returns 1 for full acuity (spotted in the configured `spotTime`) down to
   * `1 / peripheralSpotScale` at the very edge of the cone. See the long note at
   * `CFG.monster.focusAngle` for the measurements that motivated this; the short
   * version is that 100% of the stalk sightline breaks were the player stepping
   * into a 151 deg arc that was being applied at full acuity out to its edge, so
   * he could not physically pass anyone in a 4 m-cell maze.
   *
   * ONLY APPLIES WHILE UNAWARE. A monster who is already suspicious, chasing or
   * searching is actively hunting, and gets his full cone back — the caller gates
   * this by only using the returned acuity in the patrol/search escalation path.
   *
   * MOTION DEFEATS IT. Peripheral vision resolves movement far better than
   * detail, so a player crossing his view at walking speed is caught nearly as
   * fast as before; the penalty is only fully available to someone moving slowly
   * or standing still. That keeps this from being a blanket nerf: it rewards the
   * specific, deliberate behaviour the genre is built on.
   */
  private acuityFor(angle: number): number {
    const m = CFG.monster;
    if (angle <= m.focusAngle) return 1;
    const span = Math.max(1e-3, m.sightAngle - m.focusAngle);
    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    // 0 at the edge of the focus cone, 1 at the edge of the whole cone.
    const t = clamp01((angle - m.focusAngle) / span);
    // How much of the peripheral penalty survives the player's own movement.
    const speed = Math.hypot(this.playerVel.x, this.playerVel.z);
    const stealth = 1 - clamp01(speed / Math.max(0.01, m.peripheralMotionFull));
    const scale = 1 + (m.peripheralSpotScale - 1) * t * stealth;
    return 1 / scale;
  }

  update(dt: number, player: THREE.Vector3, sprinting: boolean) {
    this.justSpotted = false;
    this.mixer?.update(dt);

    // Ease toward this clip's ground offset. Clips sit at different heights (the
    // jumpscare hangs 0.26m up), so switching plants him without a visible pop.
    if (this.model) {
      const y = this.model.position.y;
      this.model.position.y = y + (this.targetGroundY - y) * Math.min(1, 8 * dt);
    }

    /**
     * Harness hold. The mixer above has already advanced, so a frozen Billy is a
     * fully animating one that simply is not being driven anywhere by the AI —
     * which is what makes a fixed-distance scale or facing photograph honest.
     * Perception still runs so `distanceToPlayer` and the shadow gate stay live.
     */
    if (this.debugFreeze) {
      const held = this.perceive(player, sprinting);
      this.updateShadowCulling(held.dist);
      // The gait layer keys off the CHASE state, not off the clip name, because
      // that is what it keys off during play. Honouring the pinned clip here lets
      // a capture photograph the chase posture without the AI first having to
      // walk him into a chase it would then immediately win.
      this.updateGait(dt, (this.debugFrozenClip ?? this.current) === 'run');
      return;
    }

    const m = CFG.monster;
    if (this.chaseCooldown > 0) this.chaseCooldown = Math.max(0, this.chaseCooldown - dt);
    if (this.gazeAvertTimer > 0) this.gazeAvertTimer = Math.max(0, this.gazeAvertTimer - dt);
    this.trackPlayerVelocity(dt, player);
    const { sees, hears, dist, acuity } = this.perceive(player, sprinting);
    this.updateShadowCulling(dist);

    // Confidence in the velocity lead: full while he watches you, decaying after.
    if (sees) this.leadConfidence = 1;
    else this.leadConfidence = Math.max(0, this.leadConfidence - dt / m.leadDecayTime);

    // ---- state transitions -------------------------------------------------
    switch (this.state) {
      case 'patrol':
      case 'search': {
        if (sees) {
          /**
           * THE PASS-BY LIVES ON THIS LINE.
           *
           * `acuity` is 1 when the player is inside his focus cone and falls to
           * 1/`peripheralSpotScale` at the edge of his peripheral vision, scaled
           * by how fast the player is moving. Accruing the sight timer at that
           * rate — rather than at a flat 1 — is what lets him walk past someone
           * standing quietly off to one side without registering them.
           *
           * `search` is deliberately included alongside `patrol` even though he
           * is nominally alert during a sweep: a search is him checking cells he
           * *guesses* you might be in, and his head is pointed at each probe in
           * turn. Excluding it made no measurable difference to escape difficulty
           * (searches are 17.9% of playtime and mostly out of sight) but did cost
           * the beat where he sweeps a corridor and misses you in an alcove.
           *
           * `suspicious` is NOT included: there he has heard you and is walking
           * to the noise with his attention already on it, so he gets his full
           * cone and the unchanged 0.6x spotTime. Being hunted is not made easier.
           */
          this.sightTimer += dt * acuity;
          if (this.sightTimer >= m.spotTime) this.enterChase(player);
        } else {
          this.sightTimer = Math.max(0, this.sightTimer - dt * 0.7);
        }
        if (!sees && hears && this.state === 'patrol') {
          this.state = 'suspicious';
          this.lastKnown.copy(player);
          this.repathToLastKnown();
        }
        if (this.state === 'search') {
          this.searchTimer -= dt;
          // The sweep ends either when the probes run out or when he loses interest,
          // whichever comes first.
          const sweeping = this.updateSearch(dt);
          if (!sweeping || this.searchTimer <= 0) {
            this.state = 'patrol';
            this.searchProbes = [];
            /**
             * CLEAR THE DWELL TOO. `searchProbes` was emptied here and
             * `probeDwell` was not, so a sweep that ended mid-dwell left the flag
             * set indefinitely — measured leaking on 13.5% of search exits and
             * persisting for as long as 256 s of a run (`RC-dwell`). It is read by
             * the movement block as "hold him still" and by `searchWatchdog` as
             * "this stillness is deliberate, do not intervene", so a stale value
             * is a live tripwire under two systems that are supposed to guarantee
             * he keeps moving.
             */
            this.probeDwell = 0;
            /**
             * A HUNT DECAYS; IT DOES NOT TERMINATE.
             *
             * HPL2's documented enemy states include HuntPause and HuntWander —
             * two dedicated states whose only job is that a hunt winds down
             * instead of switching off. We had no equivalent: the sweep ended and
             * `forceNewBeat()` handed straight back to the ordinary beat cycle,
             * which from a stalk means `quiet`, which routes him 10-22 cells away.
             * So the beat immediately after "he was hunting you and lost you" was
             * the beat in which he walks off — the exact moment the player learns
             * that surviving a chase means the threat is gone for a minute.
             *
             * Instead he enters an `approach` aimed at where you were. He is not
             * chasing, he cannot sprint (`chaseCooldown` is still running from
             * beginSearch), and he does not know where you are — he is simply
             * still in your part of the maze, walking, audible. That is the
             * decaying hunt, and it is why the minute after a chase in Amnesia is
             * worse than the chase.
             *
             * The `approach` failsafe clock is budgeted from real corridor
             * distance, so this cannot become an unbounded hunt: when it expires,
             * or when arrival promotes it to a stalk and that stalk ends, the
             * ordinary cycle resumes and he finally goes quiet.
             */
            this.enterBeat('approach', player, Math.random);
            this.planDirectorPath(player, true);
          }
        }
        break;
      }
      case 'suspicious': {
        if (sees) {
          this.sightTimer += dt;
          if (this.sightTimer >= m.spotTime * 0.6) this.enterChase(player);
        } else if (dist < m.investigateCatchOn) {
          // He has walked to where he heard you and you are RIGHT THERE. Requiring
          // the vision cone here was measured in the live build as 17 seconds of
          // him milling about 5m away without reacting, because he arrives facing
          // wherever his path happened to leave him and only notices when the cone
          // sweeps across by luck. At this range he does not need to see you: he is
          // close enough to hear you breathe.
          this.sightTimer += dt;
          if (this.sightTimer >= m.spotTime) this.enterChase(player);
        } else if (this.pathDone()) {
          this.state = 'patrol';
          this.forceNewBeat();
        }
        break;
      }
      case 'chase': {
        this.chaseElapsed += dt;
        if (sees) {
          /**
           * Re-acquiring sight after a REAL loss re-arms the burst.
           *
           * The threshold is `loseSightTime * 0.5` and not something small, and
           * that was measured rather than chosen. At 0.2 s this re-armed almost
           * every frame: a chase down a braided corridor flickers in and out of
           * line of sight constantly (measured: he has sight in only 30.7% of
           * chase-range geometries), so any short threshold means the burst is
           * permanently re-armed and the whole profile collapses back into a flat
           * 6.4 m/s — strictly worse than the 5.8 it replaced. A speed trace of a
           * real 12 s chase showed exactly that: `isLunging` true at t=12 s, real
           * speed pinned at 6.40 m/s from t=4 s onward.
           *
           * At half of `loseSightTime` he must have been genuinely out of contact
           * — long enough that the chase was already decaying — before rounding a
           * corner back into him counts as a fresh sighting worth a fresh burst.
           * Ducking behind one pillar does not re-trigger it; losing him properly
           * and then blundering into him does.
           */
          if (this.lostTimer > m.loseSightTime * 0.5) this.lungeTimer = m.chaseLungeSeconds;
          this.lostTimer = 0;
          this.lastKnown.copy(player);
        } else if (hears) {
          // Sight is the exception in a maze, not the rule: measured over 20k
          // chase-range geometries, he has line of sight in only 30.7% of them. If
          // breaking the sightline alone ended a chase, then simply rounding the
          // next bend would end it — which is exactly why the old chase resolved in
          // 6 seconds flat regardless of any tuning.
          //
          // So while he can still HEAR you he keeps updating where you are: you are
          // sprinting down a stone corridor a few metres away and he does not need
          // to see you to follow that.
          //
          // But sound only SLOWS the loss, it does not reset it the way sight does,
          // and crucially it is not a position fix. Copying the player's exact
          // position on every frame he could hear them made the chase unshakeable —
          // measured at 50.7% of all playtime, pursuit as a permanent condition
          // rather than as an event.
          //
          // Ears give you a bearing, not a coordinate. He gets the player's cell
          // centre, degraded further the further away they are, so following sound
          // through a braided maze accumulates error and he drifts into the wrong
          // branch — which is precisely the "hear him take the wrong turn" beat the
          // loops exist to create.
          this.lostTimer += dt * m.hearingLostDecay;
          const [hx, hy] = this.maze.worldToCell(player.x, player.z);
          if (this.maze.inBounds(hx, hy)) {
            const [wx, wz] = this.maze.cellToWorld(hx, hy);
            this.lastKnown.set(wx, 0, wz);
          }
          this.checkChaseOver(dist);
        } else {
          this.lostTimer += dt;
          this.checkChaseOver(dist);
        }
        break;
      }
    }

    // ---- the director ------------------------------------------------------
    // The director only STEERS while he is unaware — perception states own his feet
    // outright — but its clock runs on wall time regardless.
    //
    // That split is not cosmetic. Ticking `beatTimer` only inside updateDirector
    // meant the clock froze for the entire duration of every chase and every
    // search, so a beat designed as "40-70 seconds of quiet" was measured lasting
    // 403 seconds of real time, and a stalk lasting 159. The beat that comes out of
    // a chase is supposed to be a fresh decision made against a changed world, not
    // the resumption of a plan that was made four minutes ago.
    const unaware = this.state === 'patrol';
    if (unaware) this.updateDirector(dt, player);
    else this.beatTimer -= dt;

    // ---- movement ----------------------------------------------------------
    const chasing = this.state === 'chase';
    const searching = this.state === 'search';

    /**
     * Speed is RAMPED, never switched.
     *
     * `targetSpeed` is where the current state wants him; `moveSpeed` chases it at
     * a bounded acceleration. The old code assigned the state's speed directly, so
     * being spotted teleported him from 1.75 to 5.8 m/s between two frames — a
     * 4 m/s step change on a body that is at that moment mid-stride and possibly
     * mid-corner. The reference describes the opposite ("starting off slow, but
     * building momentum"), and the ramp is also what makes the opening moment of a
     * chase readable: you get the animation change and the sound before you get
     * the full closing rate, which is the half-second in which a player decides
     * which way to run.
     *
     * During a chase the target is the lunge speed while `lungeTimer` is up and
     * the settle speed afterwards, so a single `dt`-independent exponential
     * handles both the acceleration into the burst and the decay out of it.
     */
    const targetSpeed = chasing
      ? (this.lungeTimer > 0 ? m.chaseLungeSpeed : m.chaseSpeed)
      : searching
        ? m.walkSpeed * m.search.speedScale
        : m.walkSpeed;
    if (chasing) this.lungeTimer = Math.max(0, this.lungeTimer - dt);
    else this.lungeTimer = 0;
    // Frame-rate independent approach; at 4 fps under SwiftShader and at 144 on a
    // real machine this converges over the same number of SECONDS, not frames.
    const k = 1 - Math.exp(-dt / Math.max(0.05, m.chaseRampSeconds / 3));
    this.moveSpeed += (targetSpeed - this.moveSpeed) * k;
    const speed = this.moveSpeed;

    this.repathTimer -= dt;
    if (this.repathTimer <= 0) {
      this.repathTimer = chasing ? 0.35 : 1.1;
      if (chasing) {
        // Predictive pursuit. Aiming at where you were is why the old chase never
        // landed — he arrived at an empty corridor every time. Leading your
        // velocity lets him cut the corner, and the lead is scaled by how sure he
        // is: full while he can see you, fading to zero once he cannot, so he
        // never conjures knowledge he has not earned.
        const [px, py] = this.predictedCell();
        this.repath(px, py);
      } else if (!searching && this.pathDone()) {
        // Only a fallback: if the director somehow has no plan, keep him moving.
        this.wanderTarget();
      }
    }

    // While searching he walks his probe list; updateSearch owns the repathing and
    // holds him still (turning on the spot) during a dwell.
    if (searching && this.probeDwell > 0) {
      this.currentSpeed = 0;
    } else if (this.updatePatrolPause(dt, unaware)) {
      // Standing still somewhere in the maze, turning his head. See the config
      // note: this is the Grunt's "pausing every few steps to look around", and it
      // is what lets his footsteps STOP behind you.
      this.currentSpeed = 0;
    } else if (chasing && this.canLungeAt(player)) {
      // The last metres of a chase, run straight rather than via a cell centre.
      //
      // This exists to fix a measured deadlock. A* waypoints are CELL CENTRES, and
      // a path whose start and goal share a cell is a single waypoint: that cell's
      // centre. He would walk to the centre, arrive, repath 0.35s later to the same
      // centre, and orbit it forever — the live build had him circling a stationary
      // player at 4.1m for forty seconds, unable to spend the last two metres
      // because no waypoint existed inside the final cell.
      //
      // `canLungeAt` is deliberately stricter than line of sight. Two points can
      // see each other diagonally across a corner that a *body* cannot pass, and
      // gating on sight alone put 5 corner-cutting wall crossings into a 300-minute
      // soak. Straight-line movement is only ever allowed within his own cell or
      // into an orthogonally adjacent one through an open edge.
      this.stepToward(dt, speed, player.x, player.z);
    } else {
      this.followPath(dt, speed);
      // A chase must never be able to stand still. If the path is spent and he is
      // not close enough to lunge, he has nothing to walk toward until the next
      // repath tick — soaks caught rare multi-second freezes mid-chase this way.
      //
      // Re-targeting the predicted cell is not enough on its own: when that cell is
      // the one he is already standing in, A* returns a single waypoint (his own
      // centre) and he stays put regardless. So fall through to a neighbouring
      // cell, which is always a real move.
      if (chasing && this.pathDone()) {
        /**
         * DO NOT RESET `repathTimer` HERE.
         *
         * This used to do `this.repathTimer = 0`, which meant that whenever the
         * route was short — the common case once he is within a few cells — the
         * chase repathed EVERY FRAME instead of every 0.35 s. The scheduled tick
         * fired next frame too, so the interception argmax was re-run at 60 Hz.
         * With the heading bias worth +/-2.0 against a 1-per-cell distance term,
         * two candidate cutoffs either side of a junction swap places as the
         * player's velocity vector rotates, and he was handed the opposite
         * direction on alternate frames.
         *
         * Traced directly (`tools/mazelab/CH-revtrace.mjs`): goal alternating
         * (9,1) <-> (10,0) on consecutive frames, waypoint flipping between two
         * adjacent cell centres, `repath=Y` on nearly every line, while he stayed
         * in cell (9,0) and his distance to the player GREW from 10.9 m to
         * 12.9 m. That is the user's "runs around erratically after spotting me",
         * and it is the same class of defect as the level-triggered evade branch
         * a previous agent fixed for the unaware state: a decision re-taken far
         * faster than it can be acted upon.
         *
         * Letting the timer run means this branch still guarantees he is never
         * stalled — he gets a route THIS frame — but the expensive re-decision
         * stays on its cadence, so the plan survives long enough to be walked.
         */
        const [gx, gy] = this.predictedCell();
        const [cx, cy] = this.cell;
        if (gx !== cx || gy !== cy) this.repath(gx, gy);
        if (this.pathDone()) {
          const ns = this.maze.neighbours(cx, cy);
          if (ns.length) {
            const [nx, ny] = ns[(Math.random() * ns.length) | 0];
            this.repath(nx, ny);
          }
        }
        this.followPath(dt, speed);
      }
    }

    // Runs after movement, so it sees this frame's real `currentSpeed`.
    this.searchWatchdog(dt);

    // ---- animation ---------------------------------------------------------
    this.updateGait(dt, chasing);
  }

  /**
   * Pick the clip, set its rate, and then bend the result so a chase does not
   * read as a man jogging.
   *
   * WHY A POST-LAYER AND NOT A DIFFERENT CLIP. This was measured, not guessed.
   * During a real chase the build gate sampled
   * `{"state":"chase","current":"run","running":[{"clip":"run","w":1}]}` with
   * `walk` at weight 0 — so the state->clip mapping is correct and the crossfade
   * completes. The retarget itself is faithful too (0.833 s = exactly 2x, mean
   * joint deviation 40.5 deg, loop closure 0.00 deg). It reads human for the
   * simplest possible reason: it IS a faithful retarget of a human run. There is
   * therefore nothing to fix in the animation data, and the fix has to be applied
   * on top of it.
   *
   * Note what is deliberately NOT done here: `runTimeScale` stays at 1. The clip
   * is already baked at 2x by the asset pipeline, so doubling it again is the
   * "fix" that has nearly shipped twice; speed is not what makes something read
   * as inhuman anyway, and a 4x run just reads as a bug.
   */
  private updateGait(dt: number, chasing: boolean) {
    const m = CFG.monster;
    // The run clip is already baked at 2x by the asset pipeline; runTimeScale is
    // the remaining trim, and walk is scaled by actual speed so he never skates.
    const clip = this.debugFrozenClip ?? (chasing ? 'run' : 'walk');
    this.playClip(clip, 0.28);
    const action = this.actions.get(clip);
    if (action) {
      /**
       * The walk clip is scaled by his REAL speed so his feet never skate, and the
       * floor is now 0 rather than 0.35.
       *
       * A 0.35 floor meant that whenever he was stationary — a search dwell, and
       * now a patrol pause — the walk cycle kept playing at a third speed, so he
       * stood on one spot walking. That was invisible while the only stillness in
       * the game was a 1.6 s search dwell; with pauses of up to 2.6 s happening
       * throughout every patrol it would be the most obvious thing on screen.
       *
       * A small residual is kept rather than a hard zero so that a paused body
       * still has some weight shift in it instead of freezing solid, which reads
       * as a dropped frame. `idle` is not used here: the synthesized idle clip is
       * itself a slowed walk (see PROGRESS.md §2), so crossfading to it every time
       * he stops for a second would buy nothing and cost a fade.
       */
      action.timeScale = chasing
        ? m.runTimeScale
        : this.pauseTimer > 0
          ? 0.10
          : Math.max(0.2, this.currentSpeed / m.walkSpeed);
    }

    this.applyPredatorPosture(dt, chasing);
  }

  /**
   * The chase posture. Three additive bends on top of whatever the clip is doing.
   *
   * All three are applied AFTER `mixer.update()` has written this frame's pose,
   * so they compose with the animation instead of being overwritten by it. They
   * are added to the clip's own rotation, never assigned over it — assigning
   * would delete the run and leave a stiff mannequin sliding down the corridor,
   * which is the exact failure mode described in GAME-SPEC §6a.
   *
   * 1. FORWARD TORSO PITCH. A person jogging holds the torso near vertical over
   *    the hips. Pitching the spine forward and dropping the head below the
   *    shoulder line reads as something falling at you and catching itself each
   *    stride, rather than travelling upright. This is the single largest part of
   *    the effect and the cheapest.
   *
   * 2. LIMB-TIMING ASYMMETRY. A human run is bilaterally symmetric with a half
   *    period offset; that symmetry is most of what the eye uses to read a gait
   *    as human. Adding a slow drift to one arm and shoulder that is NOT locked
   *    to the stride period means the two sides never quite agree, so something
   *    is always moving wrong. It is deliberately slow and small: the goal is
   *    that you cannot say what is wrong with him, not that a limb visibly flails.
   *
   * 3. A LATERAL HITCH at the hips on a period that does not divide the stride,
   *    so his weight lands slightly off from where the footfall says it should.
   *
   * The whole layer eases in and out on `postureBlend` so leaving a chase does
   * not snap him upright on one frame, and it is scaled to zero while walking —
   * a patrolling Billy must still read as an ordinary silhouette at distance,
   * because the contrast between the two is what makes the chase land.
   */
  private applyPredatorPosture(dt: number, chasing: boolean) {
    const p = CFG.monster.posture;
    if (!p.enabled || !this.model) return;

    // Resolve the bones once. The exporter has been observed to strip the
    // `mixamorig:` prefix (PROGRESS.md trap 12 — an earlier check silently
    // resolved zero bones and reported 0.00 deg serenely), so try both spellings
    // and record whether we actually found subjects.
    if (!this.postureBonesResolved) {
      this.postureBonesResolved = true;
      /**
       * Try every spelling the pipeline has actually produced, in order.
       *
       * The GLB's node list says `mixamorig:Spine`, but three's GLTFLoader
       * sanitises characters that are illegal in an object name, so at RUNTIME
       * the bone is `mixamorigSpine`. Resolving only the colon form found zero
       * bones and the posture layer became a silent no-op — which is precisely
       * PROGRESS.md trap 12, where an anti-rest-pose check looked up
       * `mixamorig:LeftUpLeg`, resolved nothing, and reported 0.00 deg serenely.
       * Verified against a runtime dump of all 65 bone names, not against the file.
       */
      const find = (base: string) =>
        (this.model!.getObjectByName(`mixamorig${base}`)
          ?? this.model!.getObjectByName(`mixamorig:${base}`)
          ?? this.model!.getObjectByName(base)) as THREE.Bone | undefined;
      this.boneSpine = find('Spine') ?? null;
      this.boneSpine1 = find('Spine1') ?? null;
      this.boneSpine2 = find('Spine2') ?? null;
      this.boneNeck = find('Neck') ?? null;
      this.boneHead = find('Head') ?? null;
      this.boneRArm = find('RightArm') ?? null;
      this.boneRForeArm = find('RightForeArm') ?? null;
      this.boneLArm = find('LeftArm') ?? null;
      this.boneLForeArm = find('LeftForeArm') ?? null;
      this.boneLShoulder = find('LeftShoulder') ?? null;
      this.boneRShoulder = find('RightShoulder') ?? null;
      this.boneHips = find('Hips') ?? null;
      this.boneLUpLeg = find('LeftUpLeg') ?? null;
      this.boneRUpLeg = find('RightUpLeg') ?? null;
      this.boneLLeg = find('LeftLeg') ?? null;
      this.boneRLeg = find('RightLeg') ?? null;
      // ASSERT THAT THE ASSERTION HAS SUBJECTS (trap 12). If the rig ever changes
      // and these stop resolving, the posture layer must fail loudly rather than
      // become a silent no-op that still reports "applied".
      this.postureBoneCount = [
        this.boneSpine, this.boneSpine1, this.boneSpine2, this.boneNeck,
        this.boneHead, this.boneRArm, this.boneRForeArm, this.boneLArm,
        this.boneLForeArm, this.boneLShoulder, this.boneRShoulder, this.boneHips,
        this.boneLUpLeg, this.boneRUpLeg, this.boneLLeg, this.boneRLeg,
      ].filter(Boolean).length;
      /**
       * The LEGS specifically must resolve, not merely "some bones". The whole
       * reason the previous version of this layer measured as applied and still
       * read as a man jogging is that it only ever drove spine, arms and hips
       * while the stride underneath stayed textbook-symmetric. If the rig is ever
       * re-exported with different leg names this has to be loud, because the
       * failure is silent: everything still animates, it just looks human again.
       */
      if (!this.boneLUpLeg || !this.boneRUpLeg) {
        console.error(
          '[monster] predator posture could not resolve the leg bones — the stride '
          + 'asymmetry is a no-op and the chase will read as an ordinary human run.',
        );
      }
      if (this.postureBoneCount === 0) {
        console.error(
          '[monster] predator posture resolved 0 bones — the rig naming changed. '
          + 'The chase will read as an ordinary human run until this is fixed.',
        );
      }
    }
    if (this.postureBoneCount === 0) return;

    // Ease the whole layer in and out rather than snapping between postures.
    const want = chasing ? 1 : 0;
    const rate = dt / Math.max(1e-3, want > this.postureBlend ? p.easeIn : p.easeOut);
    this.postureBlend += THREE.MathUtils.clamp(want - this.postureBlend, -rate, rate);
    this.postureBlend = THREE.MathUtils.clamp(this.postureBlend, 0, 1);
    if (this.postureBlend <= 1e-4) return;

    this.postureClock += dt;
    const k = this.postureBlend;
    const t = this.postureClock;

    /**
     * STRIDE PHASE. Everything limb-related below is a function of this, not of
     * wall-clock time.
     *
     * The previous version drove every term off a free-running clock at rates
     * chosen to avoid the stride period. That is exactly backwards. A drift that
     * is unrelated to the gait averages out across the cycle and the eye discards
     * it as noise; what makes a walk look WRONG is the stride itself being
     * mis-timed. So the asymmetry is now phase-locked to the clip and applied
     * differently to each side, which is a thing a body cannot do and a clean
     * retarget can never produce.
     */
    // `current` is null before the first clip is played. Falling back to the free
    // clock keeps the layer running rather than dividing by an undefined duration
    // — the terms below are all bounded sines either way.
    const act = this.current ? this.actions.get(this.current) : undefined;
    const dur = act?.getClip()?.duration ?? 0.833;
    const phase = act ? (act.time % dur) / dur : ((t / dur) % 1);
    const TAU = Math.PI * 2;

    /**
     * 1. FORWARD PITCH — deeper than before, and NO LONGER CANCELLED.
     *
     * MEASURED, and this is why the first attempt read as a jog. Sampling real
     * world-space bone positions over a full stride, the whole Hips->Neck chain
     * leaned 15.7 deg mean. That is inside the normal range for a human sprinter
     * (10-20 deg), so it read as a runner and not as a thing falling at you. The
     * old `headCounter` then pulled the head back up over the hips, which erased
     * even that: the silhouette's top half measured vertical.
     *
     * Now the chest carries the full pitch and the head only partially recovers,
     * so he leads with the crown of his head and his face comes up at you from
     * UNDER his own brow — the posture of something running at you on the point
     * of falling over, rather than a jogger holding his chest above his hips.
     */
    if (this.boneSpine) this.boneSpine.rotation.x += p.spinePitch * 0.42 * k;
    if (this.boneSpine1) this.boneSpine1.rotation.x += p.spinePitch * 0.34 * k;
    if (this.boneSpine2) this.boneSpine2.rotation.x += p.spinePitch * 0.24 * k;
    // The head recovers only PART of the pitch, so the face still reads (item 2's
    // facing fix is not wasted) but the body is unmistakably diving. A full
    // counter-rotation is what made the torso measure vertical before.
    if (this.boneNeck) this.boneNeck.rotation.x -= p.spinePitch * p.headRecover * 0.55 * k;
    if (this.boneHead) this.boneHead.rotation.x -= p.spinePitch * p.headRecover * 0.45 * k;
    // A constant tilt off the sagittal plane. The head is never quite square to
    // the direction he is travelling, which is subtle in a still and deeply wrong
    // in motion — it is the "head that does not track with the body" cue.
    /*
     * The head cant is kept, but the head's YAW drift is gone.
     *
     * The cant (rotation.z) is the good half of this cue: a head held permanently
     * off-square reads as wrong without misleading anyone.
     *
     * The yaw drift was different in kind. The vision cone is measured from the
     * BODY axis, so swinging the head left and right made the only cue the player
     * has for where he is looking actively lie about it — and the user reported
     * precisely that: "he spotted me even though I wasn't in his eyes' direction."
     * A monster may be unfair; it may not be unreadable. Where he is facing has to
     * be information the player can act on.
     */
    if (this.boneHead) this.boneHead.rotation.z += p.headTilt * k;

    /**
     * 2. STRIDE ASYMMETRY — the actual fix.
     *
     * A human run is bilaterally symmetric: the two legs are the same signal half
     * a cycle apart. Measured on the shipping build, the left/right foot antiphase
     * correlation was -0.912, i.e. almost perfectly mirrored, and no amount of
     * upper-body drift can overrule that.
     *
     * Two things break it here, and both are per-side rather than global:
     *
     *   LIMP — one leg is driven harder through its swing than the other, on the
     *   stride phase. He favours a side, so his gait has a hitch in it that
     *   repeats every stride instead of averaging away.
     *
     *   PHASE SKEW — the two legs are offset by something that is NOT half a
     *   cycle. `strideSkew` is added to one leg's phase only, so the second foot
     *   lands early. The result is a limp with the wrong rhythm: the eye reads
     *   the period, predicts the other foot, and is wrong every stride.
     */
    const lPhase = phase * TAU;
    const rPhase = (phase + 0.5 + p.strideSkew) * TAU;
    if (this.boneLUpLeg) this.boneLUpLeg.rotation.x += p.legDrive * Math.sin(lPhase) * k;
    if (this.boneRUpLeg) {
      // The favoured side swings less and drags — `limpBias` scales one leg only.
      this.boneRUpLeg.rotation.x += p.legDrive * p.limpBias * Math.sin(rPhase) * k;
    }
    // The knees follow, rectified: a knee only ever flexes one way, so a raw sine
    // here would hyperextend it backwards on the negative half and read as a
    // broken rig rather than a wrong gait.
    if (this.boneLLeg) this.boneLLeg.rotation.x += p.kneeSnap * Math.max(0, Math.sin(lPhase + 0.6)) * k;
    if (this.boneRLeg) {
      this.boneRLeg.rotation.x += p.kneeSnap * p.limpBias * Math.max(0, Math.sin(rPhase + 0.6)) * k;
    }
    // Splay the favoured leg outward so the foot does not track under the hip —
    // he runs slightly crabwise, which is the silhouette cue that survives at
    // distance and in a flashlight beam where fine limb timing does not.
    if (this.boneRUpLeg) this.boneRUpLeg.rotation.z += p.legSplay * k;
    if (this.boneLUpLeg) this.boneLUpLeg.rotation.z -= p.legSplay * 0.35 * k;

    /**
     * 3. ARM ASYMMETRY, also phase-locked.
     *
     * Measured on the old build the two hands had an antiphase correlation of
     * 0.011 — i.e. no readable swing at all in the travel axis, because the drift
     * was free-running and averaged out. Locking the arms to the stride and then
     * driving the two sides with DIFFERENT amplitudes and a skewed phase gives a
     * swing you can actually see, which is wrong in a way you can point at
     * without it looking like a detached limb.
     */
    const aL = Math.sin(lPhase + Math.PI);
    const aR = Math.sin(rPhase + Math.PI + p.armSkew);
    if (this.boneLArm) {
      this.boneLArm.rotation.x += p.armDrive * aL * k;
      this.boneLArm.rotation.z += p.armDrift * 0.5 * k;
    }
    if (this.boneRArm) {
      // The trailing arm barely swings and hangs further back — a dead limb being
      // carried rather than driven.
      this.boneRArm.rotation.x += p.armDrive * p.armBias * aR * k;
      this.boneRArm.rotation.z -= p.armDrift * k;
      this.boneRArm.rotation.x += p.armHang * k;
    }
    if (this.boneLForeArm) this.boneLForeArm.rotation.x += p.foreArmDrift * aL * k;
    if (this.boneRForeArm) this.boneRForeArm.rotation.x += p.foreArmDrift * 0.4 * aR * k;
    // Shoulders roll on the stride, opposite sides by different amounts, so the
    // shoulder LINE is never level — measured 5.8 deg mean before, effectively a
    // level pair.
    if (this.boneLShoulder) this.boneLShoulder.rotation.z += p.shoulderDrift * Math.sin(lPhase) * k;
    if (this.boneRShoulder) {
      this.boneRShoulder.rotation.z += p.shoulderDrift * p.armBias * Math.sin(rPhase) * k;
    }

    /**
     * 4. HIPS. The lateral hitch stays, but now rides the stride so the weight
     * drop happens ON a footfall that is itself mistimed, rather than wandering
     * independently of it.
     *
     * These two are OSCILLATING and measure harmless: over a full cycle their
     * mean contribution to the body axis is ~0 (`tools/lean-probe.html?only=hipHitch`
     * gives roll -0.46 deg against the clip's own -0.48 deg). A constant lean
     * cannot come from a term whose cycle mean is zero, which is why the
     * sideways-lean hunt below is aimed at `hipPitch` and not at these.
     */
    if (this.boneHips) {
      this.boneHips.rotation.z += p.hipHitch * Math.sin(rPhase) * k;
      this.boneHips.rotation.y += p.hipHitch * 0.6 * Math.sin(lPhase * 0.5) * k;
      /**
       * PELVIS PITCH — this is where the user's "he's tilting to his left" came
       * from, and the culprit is NOT the one the symptom points at.
       *
       * MEASURED with `tools/lean-probe.html`, which reproduces this entire layer
       * offline and measures the Hips->Neck axis against a character frame taken
       * from the GROUP (never from a bone — a frame taken from the Hips rotates
       * with the very term under test and silently cancels the reading). Averaged
       * over 24 samples of the cycle, so a CONSTANT lean is separated from an
       * oscillation. `roll` is out-of-sagittal tilt, `pitch` is the forward dive:
       *
       *   clip alone .............. roll -0.48 deg   pitch  +3.3 deg
       *   full layer, OLD code .... roll -6.43 deg   pitch +27.1 deg  <- the lean
       *   hipPitch alone, OLD ..... roll -8.50 deg   pitch  +3.4 deg  <- all roll
       *   full layer minus hipPitch roll +1.59 deg   pitch +27.0 deg  <- dive kept
       *
       * `hipPitch` contributed essentially ALL of the roll and NONE of the pitch
       * it is named for. `spinePitch` — the obvious suspect, and the one I was
       * asked to test — is INNOCENT: the spine bones' local +X measures +LEFT
       * 0.96-0.99 across the whole cycle (`tools/bone-axes.html`), so on those
       * bones `rotation.x` genuinely is a forward pitch, and `only=spinePitch`
       * measures roll +1.88 deg with pitch +27.8 deg. It is doing exactly its job.
       *
       * WHY THE HIPS AND NOT THE SPINE. Two separate rig facts compound:
       *
       *  a) three's euler order is XYZ, so the composite is Rz*Ry*Rx and the X
       *     rotation is applied FIRST, then swung by whatever Y and Z hold. The
       *     spine bones carry near-zero Y/Z (-16..+13 deg) so their X stays
       *     lateral. The retargeted clip parks the HIPS at rotation.y +63..+79 deg
       *     and rotation.z -37..-150 deg for the whole cycle, which swings the
       *     added X onto an axis with only 0.04-0.39 of lateral component and
       *     0.89-0.98 of roll/twist.
       *  b) The Hips' parent is the `Armature` node, which carries the standard
       *     Blender Z-up->Y-up `rotation.x = +90 deg`. Composed with the Scene's
       *     -90 deg yaw, Armature-local +X maps to the character's FORWARD, +Y to
       *     his RIGHT and +Z to his DOWN — verified by direct measurement, not
       *     assumed. So a naive `premultiply` about +X is ALSO a pure roll; the
       *     first version of this fix did exactly that and measured byte-identical
       *     to the bug it was meant to remove.
       *
       * THE FIX. Rotate about the pelvis's real anatomical lateral axis, which in
       * the Hips' PARENT frame is the Y axis (see `HIP_PITCH_AXIS`).
       * `premultiply` applies it in that parent frame, so it is immune to whatever
       * the clip is doing to the pelvis euler. The cue survives — the pelvis
       * genuinely tucks under him — and only the unintended roll goes away:
       *
       *   hipPitch alone, OLD ..... roll -8.50 deg   pitch  +3.4 deg
       *   hipPitch alone, NEW ..... roll -0.48 deg   pitch  +7.9 deg
       *                                   ^ the clip's own baseline: zero added roll
       *   full layer, NEW ......... roll +1.67 deg   pitch +31.6 deg
       *   shoulder line tilt ...... +5.73 deg -> -2.22 deg (levelled)
       *
       * so the whole-body dive is now LARGER than before (the pelvis is finally
       * contributing to it instead of to a twist) while the lean is gone. Roll
       * measures +1.65..+1.74 deg for EVERY value of `hipPitch` from 0 to 0.14,
       * which is the evidence that the coupling is genuinely broken rather than
       * cancelled at one magnitude. `CFG.monster.posture.hipPitch` was retuned
       * 0.14 -> 0.08 to keep the dive near its old depth now the term works.
       */
      HIP_PITCH_Q.setFromAxisAngle(HIP_PITCH_AXIS, p.hipPitch * k);
      this.boneHips.quaternion.premultiply(HIP_PITCH_Q);
    }
  }

  /**
   * Patrol pauses — he stops every few cells and looks around.
   *
   * Returns true if he is paused this frame, in which case the caller must not
   * move him. Only ever fires while unaware: a chasing monster that stopped to
   * look around would be a bug, and a searching one already has `probeDwell`,
   * which is a richer version of the same idea aimed at a specific cell.
   *
   * The turn is one-directional per pause rather than oscillating, because a head
   * that sweeps back and forth reads as a machine scanning; a body that turns to
   * look at one thing, then walks on, reads as a person. The direction alternates
   * between pauses so he does not slowly rotate in one direction over a long
   * patrol and end up facing his own back.
   *
   * This genuinely changes what he can see — `perceive()` builds the vision cone
   * from `group.quaternion`, and turning here rotates that cone across corridors
   * his path would never have pointed him down. It is not an animation flourish.
   */
  private updatePatrolPause(dt: number, unaware: boolean): boolean {
    const p = CFG.monster.patrol;
    if (!unaware) {
      // Being spotted or losing you cancels a pause outright — he does not finish
      // looking at a wall while sprinting after you.
      this.pauseTimer = 0;
      return false;
    }

    if (this.pauseTimer > 0) {
      this.pauseTimer -= dt;
      this.group.rotation.y += this.lookDir * p.lookSpeed * dt;
      if (this.pauseTimer <= 0) {
        this.pauseTimer = 0;
        this.pauseCooldown = p.pauseEveryMin + Math.random() * (p.pauseEveryMax - p.pauseEveryMin);
      }
      return true;
    }

    // Only count down the walking budget while he is actually walking, or a
    // monster wedged against a wall would rack up pauses he never earned.
    if (this.currentSpeed > 0.05) this.pauseCooldown -= dt;
    if (this.pauseCooldown > 0) return false;

    this.pauseTimer = p.pauseMin + Math.random() * (p.pauseMax - p.pauseMin);
    /**
     * TURN THE SHORT WAY TOWARD A CORRIDOR HE HAS NOT LOOKED DOWN.
     *
     * This used to be `this.lookDir = -this.lookDir` — a blind alternation, which
     * means the direction he looks carries no information about where anything
     * could be. Measured consequence, over 80 simulated minutes of ordinary play
     * (`RC-circle` / the cone-coverage probe): he held line of sight to an unaware
     * player for 5894 frames and the player was inside his vision cone on only
     * **14.9%** of them, with sightlines opening at a median **78.4 deg** — i.e.
     * just outside the 75.6 deg cone edge, at the exact angle where `acuityFor`
     * gives its largest penalty. He was reliably looking the wrong way.
     *
     * That is the whole of the user's "before SOMETIMES deciding to pursue me":
     * standing in his corridor did not make him react, because a pause spent
     * turning toward a wall sweeps his cone across nothing.
     *
     * So pick the side that has somewhere to look. He scores the two turn
     * directions by how much OPEN CORRIDOR each would sweep his cone across,
     * using only the maze — never the player's position, so this cannot become
     * aimbot behaviour. He is checking the exits of the junction he stopped in,
     * which is what the Grunt's "pausing every few steps to look around" is FOR,
     * and if the player happens to be standing down one of those exits he now
     * gets seen.
     */
    this.lookDir = this.pickLookDirection();
    return true;
  }

  /**
   * Which way to turn during a pause: toward the neighbouring corridor his cone
   * is not already covering.
   *
   * Deliberately maze-only. It ranks the open edges of his current cell by how
   * far his cone would have to swing to cover them, and turns the SHORT way
   * toward the nearest one he cannot currently see down. Falls back to
   * alternating when the cell has nothing to look at (a straight corridor he has
   * already swept), so the old behaviour survives where it was already fine.
   */
  private pickLookDirection(): number {
    const [cx, cy] = this.cell;
    const ns = this.maze.neighbours(cx, cy);
    if (ns.length < 2) return -this.lookDir;

    const yaw = this.group.rotation.y;
    const half = CFG.monster.sightAngle;
    let bestSigned = 0;
    let bestCost = Infinity;

    for (const [nx, ny] of ns) {
      // Bearing of this exit, in `stepToward`'s convention: atan2(dx, dz), where
      // cell +y maps to world +Z.
      const dirYaw = Math.atan2(nx - cx, ny - cy);
      let delta = dirYaw - yaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      // Already comfortably inside the cone — nothing new to learn that way.
      if (Math.abs(delta) < half * 0.6) continue;
      const cost = Math.abs(delta);
      if (cost < bestCost) { bestCost = cost; bestSigned = delta; }
    }

    if (!Number.isFinite(bestCost) || bestSigned === 0) return -this.lookDir;
    return bestSigned > 0 ? 1 : -1;
  }

  private currentSpeed = 0;

  /**
   * Is he actually travelling this frame? The audio lane drives his footfalls off
   * this, so they stop dead the moment he stops — which is a better scare than a
   * perpetually walking sound. Requested in docs/handoff/audio.md.
   */
  get isMoving() { return this.currentSpeed > 0.05; }

  /**
   * His real instantaneous speed in m/s. Since the chase ramps (walk 1.75 -> lunge
   * 6.4 -> settle 4.65) rather than switching, `CFG.monster.chaseSpeed` no longer
   * describes what he is doing on any given frame, so anything that wants to know
   * how fast he is actually moving — telemetry, a critic's report.json — has to
   * read it rather than infer it.
   */
  get speed() { return this.currentSpeed; }

  /** True while the opening burst of a chase is still running. */
  get isLunging() { return this.lungeTimer > 0; }

  private pathDone() { return this.pathIndex >= this.path.length; }

  /**
   * Smoothed estimate of how fast and which way you are moving.
   *
   * Raw per-frame deltas are far too noisy to steer with — head bob and a variable
   * dt would have him twitching between two cells. The exponential smoothing is
   * frame-rate independent, which matters because this runs at 4fps under the
   * software rasterizer and at 144 on a real machine.
   */
  private trackPlayerVelocity(dt: number, player: THREE.Vector3) {
    if (!this.havePrevPlayer) {
      this.prevPlayer.copy(player);
      this.havePrevPlayer = true;
      return;
    }
    if (dt > 1e-4) {
      const vx = (player.x - this.prevPlayer.x) / dt;
      const vz = (player.z - this.prevPlayer.z) / dt;
      const k = 1 - Math.exp(-dt / 0.25);
      this.playerVel.x += (vx - this.playerVel.x) * k;
      this.playerVel.z += (vz - this.playerVel.z) * k;
    }
    this.prevPlayer.copy(player);
  }

  /**
   * The cell he paths to during a chase — an interception, not a tail.
   *
   * Straight-line extrapolation was measured to be worthless here: at a 4m cell and
   * 5 m/s sprint, even a generous 0.9s lead is 1.1 cells, which only ever nominates
   * a cell further down the corridor you are already in. Pathing there produces the
   * identical route to pathing at you, so the catch rate did not move at all
   * (11.7% with and without, to three decimals).
   *
   * What actually catches someone in a braided maze is arriving somewhere they are
   * going, through a *different* corridor. So: flood out from your last known cell
   * to find where you might plausibly be in the next couple of seconds, and among
   * those pick the cell he can reach strictly sooner than you can. If no such cell
   * exists he is genuinely behind and simply runs you down.
   *
   * He only gets this while `leadConfidence` is up — i.e. while he can see you or
   * has just lost you. Once it decays he is back to chasing a memory, which is what
   * keeps breaking line of sight meaningful.
   *
   * ---------------------------------------------------------------------------
   * WHY THE SCORING CHANGED — the user's "he runs around erratically AFTER
   * spotting me", fourth report, measured in the CHASE state for the first time.
   *
   * The intent above is right and is kept. The old implementation scored
   * candidates by `score = margin`, i.e. it took the cell he beats the player to
   * by the WIDEST margin. That is not an interception. `margin` is
   * `playerETA - selfETA`, so it is maximised by making `selfETA` SMALL — which
   * rewards cells close to HIM, including cells behind him and cells further from
   * the player than he already is. Measured over 20 simulated minutes of real
   * chases (`tools/mazelab/CH-intercept.mjs`):
   *
   *   intercept lies BEHIND his direction of travel ........ 39.7%
   *   intercept is FURTHER from the player than he is ...... 31.2%
   *   intercept cell changed between repaths ............... 19.4%
   *
   * and downstream of it (`tools/mazelab/CH-path.mjs`), over the same chases:
   *
   *   repaths handing him a waypoint >120 deg from the last  87.3%
   *   goal cell changed on a repath ........................ 64.6%
   *   median goal distance from the player .................. 4 cells (16 m)
   *
   * He repaths every 0.35 s, so an unstable argmax means a brand-new plan roughly
   * three times a second, each one often pointing the other way. That is the
   * erratic orbiting the user filmed: `CH-chase` measured 699 heading reversals
   * per chase-MINUTE and a median distance-vs-time slope of +0.04 m/s — he was
   * not closing at all.
   *
   * THE FIX, and what it deliberately preserves:
   *
   *   1. Score by ARRIVAL, not by margin. Among cells he genuinely beats the
   *      player to, prefer the one that is CLOSEST TO THE PLAYER — that is what
   *      "cut them off" means. `margin` stays as the eligibility test (he must
   *      still beat the player there by `interceptMarginSeconds`), which is the
   *      part that was always correct.
   *   2. Never nominate a cell that is further from the player than he already
   *      is. Such a cell cannot be a cutoff by construction; taking it is how he
   *      ended up running away from the person he was chasing.
   *   3. HYSTERESIS. Keep last frame's intercept unless the new candidate is
   *      meaningfully better (`interceptSwitchCells`). Two candidates either side
   *      of a junction otherwise trade places on ties and he alternates between
   *      them forever. This is the same class of defect as the level-triggered
   *      evade branch a previous agent fixed for the unaware state — a decision
   *      re-taken faster than it can be acted on — which is why the unaware
   *      metrics improved while the chase stayed broken.
   *
   * The heading bias is kept and still only breaks ties among real cutoffs.
   */
  private predictedCell(): [number, number] {
    const m = CFG.monster;
    const [lx, ly] = this.maze.worldToCell(this.lastKnown.x, this.lastKnown.z);
    if (!this.maze.inBounds(lx, ly)) return [lx, ly];

    const horizon = m.interceptHorizonCells * this.leadConfidence;
    if (horizon < 1) return [lx, ly];

    // Where could the player get to, and how fast? BFS from their last known cell.
    const playerField = this.maze.distanceField(lx, ly);
    // How fast can he get anywhere? BFS from his own cell.
    const [mx, my] = this.cell;
    if (!this.maze.inBounds(mx, my)) return [lx, ly];
    const selfField = this.maze.distanceField(mx, my);

    // Prefer the cell the player is heading toward, so he commits to the right side
    // of a junction rather than picking an arbitrary equidistant one.
    const heading = Math.hypot(this.playerVel.x, this.playerVel.z) > 0.4
      ? { x: this.playerVel.x, z: this.playerVel.z }
      : null;

    const cellSize = this.maze.cellSize;
    let best: number = -1;
    let bestScore = -Infinity;

    // How far HE is from the player right now, in cells. A cutoff must be closer
    // to the player than this — otherwise it is not a cutoff, it is a detour.
    const selfToPlayer = playerField[this.maze.idx(mx, my)];

    for (let i = 0; i < playerField.length; i++) {
      const pd = playerField[i];
      if (pd < 1 || pd > horizon) continue;
      const md = selfField[i];
      if (md < 0) continue;

      // Never nominate a cell FURTHER from the player than he already is. The old
      // scoring did this on 31.2% of chase repaths, because maximising
      // `playerETA - selfETA` rewards cells close to HIM rather than cells that
      // cut the player off — and running to one is running away from the chase.
      if (!BASELINE && selfToPlayer >= 0 && pd >= selfToPlayer) continue;

      // Times to arrive, in seconds, using each party's real speed.
      const playerETA = (pd * cellSize) / CFG.player.sprintSpeed;
      const selfETA = (md * cellSize) / m.chaseSpeed;
      // He must genuinely beat the player there, with a margin so he is waiting
      // rather than colliding. Anything else is just a longer tail. This stays
      // exactly as it was: it is the ELIGIBILITY test and it was always correct.
      const margin = playerETA - selfETA;
      if (margin < m.interceptMarginSeconds) continue;

      /**
       * Score by ARRIVAL, not by margin.
       *
       * Among the cells he genuinely beats the player to, the best cutoff is the
       * one CLOSEST TO THE PLAYER — that is the one that actually stands in their
       * way. Negating `pd` makes "nearest the player" the maximum, so the units
       * below (the heading bias) stay in cells and keep their old relative weight.
       */
      let score = BASELINE ? margin : -pd;
      if (heading) {
        // Bias toward the direction of travel: a cutoff behind the player is
        // pointless even if he can reach it first.
        const cx = i % this.maze.cols, cy = (i / this.maze.cols) | 0;
        const [wx, wz] = this.maze.cellToWorld(cx, cy);
        const ax = wx - this.lastKnown.x, az = wz - this.lastKnown.z;
        const len = Math.hypot(ax, az) || 1;
        const dot = (ax / len) * (heading.x) + (az / len) * (heading.z);
        const hlen = Math.hypot(heading.x, heading.z) || 1;
        /**
         * The bias must only ever BREAK TIES, never outvote the cutoff distance.
         *
         * At its old weight of 2.0 against a `-pd` term that steps by 1 per cell,
         * a swing in the player's velocity direction could move a candidate two
         * whole cells' worth of score — so the argmax jumped between cutoffs that
         * were not equally good, and jumped back when the player turned again.
         * Below 0.5 it can only separate candidates that are otherwise equal on
         * distance, which is exactly the job the comment above describes.
         */
        score += (dot / hlen) * (BASELINE ? 2.0 : 0.45);
      }
      if (score > bestScore) { bestScore = score; best = i; }
    }

    if (best < 0) {
      // No honest cutoff exists: he is behind and simply runs the player down.
      // Clearing the latch matters — otherwise a stale intercept from before he
      // fell behind would be held by the hysteresis below and he would keep
      // running to a cell the chase has moved past.
      this.interceptCell = null;
      return [lx, ly];
    }

    const bx = best % this.maze.cols, by = (best / this.maze.cols) | 0;

    /**
     * HYSTERESIS — hold the plan unless the new one is meaningfully better.
     *
     * Without this the argmax flips on ties: two cells either side of a junction
     * trade places as the player moves a few centimetres, and since the chase
     * repaths every 0.35 s he is handed the opposite direction roughly three
     * times a second. Measured before this guard, 19.4% of intercept samples
     * changed cell and 87.3% of repaths produced a waypoint more than 120 deg
     * from the previous one.
     *
     * The previous choice is only kept while it is STILL ELIGIBLE — still inside
     * the horizon, still closer to the player than he is, still beaten to. So
     * this damps churn without ever letting him commit to a stale plan.
     */
    const prev = this.interceptCell;
    if (prev && this.maze.inBounds(prev[0], prev[1])) {
      const pi = this.maze.idx(prev[0], prev[1]);
      const ppd = playerField[pi];
      const pmd = selfField[pi];
      const stillEligible = ppd >= 1 && ppd <= horizon && pmd >= 0
        && (selfToPlayer < 0 || ppd < selfToPlayer)
        && ((ppd * cellSize) / CFG.player.sprintSpeed) - ((pmd * cellSize) / m.chaseSpeed)
             >= m.interceptMarginSeconds;
      // Switch only for a genuinely better cutoff, measured in cells closer to
      // the player. Ties and near-ties keep the plan he is already walking.
      if (!BASELINE && stillEligible && ppd - playerField[best] < m.interceptSwitchCells) return [prev[0], prev[1]];
    }

    this.interceptCell = [bx, by];
    return [bx, by];
  }

  /**
   * Chase exit. Both conditions must hold: out of contact long enough AND properly
   * far. Losing him by ducking round one corner while he is two metres behind
   * would be a joke, and players would learn to abuse it inside a minute.
   *
   * Dropping out of a chase always starts a real search sweep rather than sending
   * him to one cell to stand there.
   */
  private checkChaseOver(dist: number) {
    const m = CFG.monster;
    // A chase also simply expires. Without a ceiling, a player who keeps sprinting
    // keeps feeding him contact, and the pursuit becomes the steady state — 50.7%
    // of playtime when measured. Amnesia's terror is mostly anticipation, so the
    // chase has to be able to end even when the player never plays it well.
    // Giving up here still drops him into a full search sweep, so the pressure
    // decays rather than switching off.
    if (this.chaseElapsed > m.maxChaseSeconds) { this.beginSearch(); return; }
    if (this.lostTimer <= m.loseSightTime || dist <= m.loseDistance) return;
    this.beginSearch();
  }

  /**
   * Drop out of a chase into a real search sweep of where you were last seen.
   *
   * Only ever reached from `checkChaseOver`, so this is precisely the moment a
   * chase ends, and therefore the moment to start the re-escalation cooldown. He
   * keeps hunting — the sweep runs, he still kills on contact — but he cannot break
   * back into a sprint until the player has had a real chance to get away.
   */
  private beginSearch() {
    const m = CFG.monster;
    this.state = 'search';
    this.searchTimer = m.searchTime;
    this.sightTimer = 0;
    this.chaseCooldown = m.chaseCooldown;
    this.buildSearchProbes();
    // Same unreachable-probe drain as updateSearch: an opening probe he cannot
    // path to would otherwise start the sweep already stalled.
    while (this.searchProbes.length) {
      const [nx, ny] = this.searchProbes[0];
      this.repath(nx, ny);
      if (!this.pathDone()) break;
      this.searchProbes.shift();
    }
    if (!this.searchProbes.length) this.repathToLastKnown();
  }

  /**
   * Cut the current beat short so the next director tick picks a new one.
   *
   * Called when a search or an investigation ends — he has stopped looking for you
   * and needs a fresh plan. It expires the CLOCK but deliberately leaves
   * `beatPlanned` alone, so `planBeat` runs the ordinary cycle from whatever beat
   * he was in.
   *
   * Clearing `beatPlanned` here instead was measured as a real bug: that flag
   * routes into updateDirector's cold-start branch, which unconditionally enters
   * `quiet`. Every search that ended therefore restarted a full 40-70 s quiet, and
   * because searches are frequent those restarts chained — quiet episodes measured
   * 164 s median and 397 s maximum against a 70 s design ceiling. He would vanish
   * for six minutes at a time, which is not tension, it is the player concluding
   * the monster is gone.
   */
  private forceNewBeat() {
    this.beatTimer = 0;
  }

  /**
   * The director tick — a closed loop, not a sequence of fixed timers.
   *
   * Three things happen here every frame, in this order, and the order matters:
   *
   *   1. ARRIVAL. If he is transiting and the *measured* corridor distance has
   *      dropped inside `stalkArriveCells`, the approach is over and the stalk
   *      clock starts NOW. This is the closed loop: the beat ends on the world
   *      reaching a state, not on a stopwatch that was set before he took a step.
   *   2. EXPIRY. Only then does the clock get a say, and for an approach that
   *      clock is a failsafe sized from the distance he was asked to walk.
   *   3. RE-SOLVE. Every `replanInterval` the destination is recomputed against
   *      the player's CURRENT cell. The old director solved once per beat, so an
   *      18-second stalk was aimed at where you stood 18 seconds ago; against a
   *      walking player that is up to 11 cells of error, which is more than twice
   *      the width of the entire stalk band.
   *
   * Re-solving is throttled rather than per-frame because it costs a BFS plus an
   * A*, and because a target that jitters every frame produces a monster who
   * dithers at junctions instead of committing to a corridor.
   */
  private updateDirector(dt: number, player: THREE.Vector3) {
    const d = CFG.monster.director;
    this.beatTimer -= dt;
    this.replanTimer -= dt;

    if (!this.beatPlanned) {
      // First tick of a fresh monster (or straight out of a search): decide from
      // scratch. Starting quiet rather than approaching means the game opens with
      // absence, which is the whole thesis.
      this.enterBeat('quiet', player, Math.random);
      this.planDirectorPath(player, true);
      return;
    }

    // ---- 1. arrival closes the transit -------------------------------------
    if (this.beat === 'approach') {
      const cells = this.corridorCellsToPlayer(player);
      if (cells >= 0 && cells <= d.stalkArriveCells) {
        this.enterBeat('stalk', player, Math.random);
        this.planDirectorPath(player, true);
        return;
      }
    }

    /**
     * ---- 1b. break the sightline mid-stalk ---------------------------------
     *
     * The near-miss only exists while he does not know you are there, and he is
     * one `spotTime` (0.45 s) away from that ending. If a stalk has drifted into a
     * position where he can actually see the player — the player walked into his
     * corridor, or the only route left ran through an open junction — re-solve NOW
     * for a blind cell rather than waiting out `replanInterval` in the open.
     *
     * This is the difference between the two outcomes this lane is graded on. With
     * the destination-only blindness check, 6 of 7 close passes escalated into a
     * chase and chase share hit 43% of playtime; the near-miss rate stayed at
     * 0.05/min because he kept *catching* the player instead of passing them.
     *
     * It deliberately does NOT suppress perception. If he sees you he still spots
     * you and still gives chase — the director does not get to veto that. All this
     * does is stop him CHOOSING to stand where he will be seen.
     */
    /**
     * MEASURED CORRECTION: this fires for ANY unaware beat, not just a stalk.
     *
     * `tools/mazelab/KX-face.mjs` over 60 simulated minutes logged where the
     * FIRST frame of each unaware sighting happened: 109 during a stalk but 15
     * during a quiet, and a quiet sighting escalates exactly as fast as a stalk
     * one because `spotTime` does not care what the director intended. Gating the
     * evasion on `beat === 'stalk'` left 12% of sightings with no reaction at all
     * — he would stand in the open finishing a quiet beat while the sight timer
     * ran out. `approach` is included for the same reason: an approach that walks
     * into a sightline 9 cells out has 0.45 s before it stops being an approach.
     */
    /**
     * ---- AND THE SAME SYMMETRY BUG, A THIRD TIME ---------------------------
     *
     * This fired on `seesPlayer`, which is RAW line of sight by deliberate design
     * (see `perceive`). So the moment geometry opened between them — regardless of
     * where his head was pointed — he re-planned away AND averted his gaze. Between
     * them, the two route vetoes and this reflex meant that every path by which the
     * player could have laid eyes on him was abandoned within one frame of opening.
     * That is why the beat measured 0.0 s on screen: not because he was rarely
     * visible, but because visibility was the trigger for him to stop being.
     *
     * The gate is now `sightAcuity`, the facing-dependent term. He evades when he
     * is actually LOOKING at the player — which is the case the evasion was written
     * for, since that is the one that converts into a chase inside `spotTime`. When
     * he merely happens to be geometrically exposed while walking with his head
     * turned away, he now keeps walking, and the player gets to watch him cross the
     * corridor and not find them.
     *
     * `noticeAcuity` is the threshold, not zero: `acuityFor` returns a small
     * positive value right at the edge of his cone, and treating the extreme
     * periphery as "looking at you" would re-create the old behaviour with extra
     * steps. Above it he is attentive enough that the sighting will convert, so he
     * evades exactly as before — this cannot make him easier to escape.
     */
    /**
     * EDGE-TRIGGERED, not level-triggered. See the note on `evadeLatched`.
     *
     * The condition below is TRUE continuously for as long as the player has a
     * sightline on him at a converting acuity, and acting on it every frame made
     * him re-randomise his destination sixty times a second — which is the
     * measured cause of both "he runs around in small circles" and "he sometimes
     * fails to pursue". He reacts once per exposure episode instead.
     *
     * The latch clears below the moment the sighting genuinely lapses, so a
     * player who breaks line of sight and steps back out gets a fresh reaction.
     */
    /**
     * ...AND HE COMMITS WHEN YOU ARE CLOSE AND HE IS LOOKING RIGHT AT YOU.
     *
     * See `CFG.monster.director.commitDistance`. Measured, 80 simulated minutes:
     * 95% of evasion episodes fired at acuity 1.00 and 64% within 10 m, so the
     * "he passes by without noticing" beat was in practice "he stares at you from
     * 8 m and walks away" — the user's "before SOMETIMES deciding to pursue me".
     *
     * Inside the commit range he simply does not evade, which means `perceive`'s
     * `sightTimer` runs uninterrupted and he escalates through the ordinary
     * `spotTime` path like anything else. Nothing here forces a chase; it only
     * stops the director from actively steering him out of one he has earned.
     */
    const committing = this.distanceToPlayer <= d.commitDistance
      && this.sightAcuity >= d.commitAcuity;
    /**
     * Drop any gaze aversion still running from an EARLIER, more distant glimpse.
     * `gazeAvertSeconds` is 2.2 s, so without this a player who closes from the
     * periphery into the commit range spends up to two seconds with his turn rate
     * pinned at 0.18 — unable to track them — which is the same "stands there and
     * does not react" symptom arriving by a different route.
     */
    if (committing) this.gazeAvertTimer = 0;
    const noticing = this.seesPlayer
      && this.sightAcuity >= CFG.monster.director.noticeAcuity
      && !committing;
    if (!noticing) this.evadeLatched = false;
    if (noticing && !this.evadeLatched) {
      this.evadeLatched = true;
      this.replanTimer = d.replanInterval;
      this.planDirectorPath(player, true);
      /**
       * AND LOOK AWAY WHILE HE DOES IT.
       *
       * This is the line the whole pass-by beat was missing, and it took three
       * instruments to find. `KX-acuity` showed the peripheral-vision model was
       * running and was still not producing near-misses: 88.4% of the frames in
       * which he had sight on an unaware player were at FULL acuity, i.e. he was
       * looking straight at them. But `KX-face` showed that at the FIRST frame of
       * each sighting the median angle to the player was 72.9 deg — right at the
       * 76 deg edge of his cone, with only 10% inside the focus cone.
       *
       * Those two are not in conflict; together they name the bug. He acquires
       * the player in his extreme periphery, and then — because `followPath`
       * turns him to face his direction of travel and the router has just been
       * asked to route him somewhere near the player — he KEEPS TURNING until the
       * player is dead ahead, converting his own glimpse into a stare over the
       * following handful of frames. The peripheral penalty is real but it only
       * ever gets one or two frames before his own body cancels it.
       *
       * So evading has to include his HEAD, not just his feet. `gazeAvertTimer`
       * suppresses the facing update toward a target that lies in the player's
       * direction for a moment — long enough for the route change above to take
       * him somewhere else — which is what a thing that has not noticed you
       * actually does: it keeps looking where it was going.
       *
       * It does NOT suppress perception. If the player stays in his cone he is
       * still seen and still spots them; `sightTimer` keeps accruing throughout.
       * This only stops him actively swinging his gaze onto someone he has not
       * yet registered.
       */
      this.gazeAvertTimer = CFG.monster.gazeAvertSeconds;
      return;
    }

    // ---- 2. the clock, second ----------------------------------------------
    if (this.beatTimer <= 0) {
      this.planBeat(player, Math.random);
      this.planDirectorPath(player, true);
      return;
    }

    /**
     * ---- 3. re-solve against where the player is NOW -----------------------
     *
     * Also re-solve the moment he runs out of path, or he would stand still until
     * the next interval tick.
     *
     * Arriving during a STALK forces a brand new target rather than keeping the
     * old one, and that is what turns one beat into several separate passes. A
     * stalk that picks one blind cell and stands on it is a single event; one that
     * keeps moving between blind cells on different sides of the player is
     * footsteps crossing behind you, then silence, then footsteps somewhere else —
     * which is the sound Amnesia actually makes.
     *
     * This is the only lever available for the near-miss RATE that does not shorten
     * the quiet. The rate is otherwise bounded by the beat cycle: quiet (40-70 s) +
     * transit (~34 s) + stalk (16-30 s) is a ~112 s cycle, i.e. at most 0.53
     * near-misses per minute even if every single stalk were perfect. Getting more
     * than that out of a cycle requires more passes per stalk, not a faster cycle —
     * a faster cycle is just the monster being permanently underfoot, which is the
     * failure mode this whole director exists to prevent.
     */
    if (this.replanTimer <= 0 || this.pathDone()) {
      this.replanTimer = d.replanInterval;
      this.planDirectorPath(player, this.beat === 'stalk' && this.pathDone());
    }
  }

  /**
   * Route him to a cell satisfying the current beat.
   *
   * `force` re-picks unconditionally; otherwise a target that still satisfies the
   * beat is kept. That stability is what stops the once-per-second re-solve from
   * turning a stalk into a random walk: he only changes his mind when the player's
   * movement has actually invalidated the plan.
   */
  private planDirectorPath(player: THREE.Vector3, force: boolean) {
    const d = CFG.monster.director;
    if (!force && this.beatTarget && !this.pathDone()) {
      const [px, py] = this.maze.worldToCell(player.x, player.z);
      if (this.maze.inBounds(px, py)) {
        const field = this.maze.distanceField(px, py);
        const td = field[this.maze.idx(this.beatTarget[0], this.beatTarget[1])];
        let lo: number, hi: number;
        // Must mirror directorTarget's bands exactly, including the opening's
        // raised floor — otherwise the opening target is chosen at 16+ cells and
        // then judged "still valid" against the ordinary 10-cell floor, so the
        // moment the player closes to 12 cells he keeps a target he would no
        // longer have picked, and the grace quietly stops applying.
        if (this.beat === 'quiet') {
          lo = this.openingBeat ? Math.max(d.quietMinCells, d.openingMinCells) : d.quietMinCells;
          hi = d.quietMaxCells;
        }
        else if (this.beat === 'approach') { lo = 0; hi = Math.max(1, d.stalkArriveCells - 1); }
        else { lo = d.stalkNearCells; hi = d.stalkFarCells; }
        // Still valid against the player's new position — keep walking to it.
        // A stalk must additionally still be BLIND: the player has moved since this
        // target was chosen, so a route that was hidden a second ago may now look
        // straight down the corridor the player has just stepped into. Keeping it
        // because the distance band still matched is how a near-miss turns into a
        // chase without anything having decided to.
        if (td >= lo && td <= hi) {
          if (this.beat !== 'stalk') return;
          const goal = this.maze.idx(this.beatTarget[0], this.beatTarget[1]);
          if (this.routeIsBlind(goal, player)) return;
        }
      }
    }

    const target = this.directorTarget(player, Math.random);
    if (target) {
      this.beatTarget = target;
      this.repath(target[0], target[1]);
    } else {
      this.beatTarget = null;
      this.wanderTarget();
    }
  }

  private repathToLastKnown() {
    const [px, py] = this.maze.worldToCell(this.lastKnown.x, this.lastKnown.z);
    this.repath(px, py);
  }

  /**
   * Build the search sweep: a handful of cells spread around where he last saw
   * you, ordered nearest-first so he works outward the way a person would.
   *
   * Picking them off a BFS field from `lastKnown` means every probe is genuinely
   * reachable and genuinely "off to the side" — these are the side corridors, not
   * points on a circle that might be through a wall. Spreading them apart stops
   * all four probes landing in the same stub.
   */
  private buildSearchProbes() {
    const s = CFG.monster.search;
    const [lx, ly] = this.maze.worldToCell(this.lastKnown.x, this.lastKnown.z);
    this.searchProbes = [];
    this.probeDwell = 0;
    if (!this.maze.inBounds(lx, ly)) return;

    const field = this.maze.distanceField(lx, ly);
    const pool: number[] = [];
    for (let i = 0; i < field.length; i++) {
      const d = field[i];
      if (d >= s.minProbeCells && d <= s.maxProbeCells) pool.push(i);
    }
    // Prefer junctions: a corridor with three ways out is where you would actually
    // have gone, and where he would actually look.
    pool.sort((a, b) => {
      const na = this.maze.neighbours(a % this.maze.cols, (a / this.maze.cols) | 0).length;
      const nb = this.maze.neighbours(b % this.maze.cols, (b / this.maze.cols) | 0).length;
      return nb - na;
    });

    const chosen: number[] = [];
    for (const i of pool) {
      if (chosen.length >= s.probes) break;
      const cx = i % this.maze.cols, cy = (i / this.maze.cols) | 0;
      const spread = chosen.every((j) => {
        const jx = j % this.maze.cols, jy = (j / this.maze.cols) | 0;
        return Math.abs(jx - cx) + Math.abs(jy - cy) >= s.minProbeCells;
      });
      if (spread) chosen.push(i);
    }

    // Nearest-first, so the sweep radiates out from where you vanished.
    chosen.sort((a, b) => field[a] - field[b]);
    this.searchProbes = chosen.map((i) => [i % this.maze.cols, (i / this.maze.cols) | 0]);
  }

  /**
   * Advance the search: walk to the current probe, cast about for a beat, move on.
   * Returns false when the sweep is exhausted so the caller can drop to patrol.
   */
  private updateSearch(dt: number): boolean {
    if (!this.searchProbes.length) return false;

    if (this.probeDwell > 0) {
      // Standing at a probe, turning on the spot — visibly looking, not idling.
      //
      // Uses the same `lookSpeed` as a patrol pause instead of the 1.5 rad/s that
      // was hard-coded here. A search sweep and a patrol scan are the same gesture
      // and should not read at two different speeds; and 1.5 rad/s is 86 deg/s,
      // which the user described from play as him "running around in small
      // circles". Turning on the spot has to read as looking, not as spinning.
      this.probeDwell -= dt;
      this.group.rotation.y += this.lookDir * CFG.monster.patrol.lookSpeed * dt;
      if (this.probeDwell <= 0) {
        this.searchProbes.shift();
        if (!this.searchProbes.length) return false;
        // Walk to the next probe he can actually reach. `repath` is a no-op when
        // A* fails, which used to leave the spent path in place and drop him
        // straight back into the dwell branch below — see the comment there.
        while (this.searchProbes.length) {
          const [nx, ny] = this.searchProbes[0];
          this.repath(nx, ny);
          if (!this.pathDone()) break;
          this.searchProbes.shift();
        }
        if (!this.searchProbes.length) return false;
      }
      return true;
    }

    if (this.pathDone()) {
      /**
       * Arrived (or the path fell through) — dwell here, then take the next probe.
       *
       * The `pathDone()` guard is load-bearing and used to be a soak-visible stall.
       * `repath` silently no-ops when A* returns nothing or when the goal is the
       * cell he is already standing in, which leaves the previous spent path in
       * place; `pathDone()` therefore stays true, this branch fires again on the
       * very next frame, and he re-arms another full `dwell`. Measured in a
       * multi-seed soak as an 8.8 s motionless stretch in `search`, against a
       * design dwell of 1.6 s. Draining unreachable probes above is what bounds it:
       * a dwell is now always followed by either real walking or the end of the
       * sweep.
       */
      this.probeDwell = CFG.monster.search.dwell;
      return true;
    }
    return true;
  }

  /**
   * Watchdog: a searching monster must never stand still for longer than a dwell.
   *
   * The probe-draining above fixes the cases I could reason about, and it took the
   * worst measured stall from 8.8 s down to 3.1 s — but a 300-minute, 12-seed soak
   * still found a 21.6 s freeze in `search`, which is essentially the whole
   * `searchTime` budget spent motionless. Rather than keep guessing at which
   * combination of a failed A*, an exhausted probe list and a same-cell goal
   * produced it, this asserts the invariant directly: if he is searching and has
   * not moved for longer than one dwell plus a margin, force him onto a
   * neighbouring cell, which is always a real move.
   *
   * A watchdog is the right shape here precisely BECAUSE the failure is one I
   * could not fully enumerate. It is not a substitute for the fixes above — those
   * remove the causes I did find — it is a floor under the behaviour so that any
   * cause I did not find degrades into "he walks somewhere" rather than "he is a
   * statue in the dark for twenty seconds".
   */
  private searchStillFor = 0;

  private searchWatchdog(dt: number) {
    if (this.state !== 'search') { this.searchStillFor = 0; return; }
    // A dwell is deliberate stillness, not a stall — only count unintended freezes.
    if (this.probeDwell > 0 || this.currentSpeed > 0.05) { this.searchStillFor = 0; return; }

    this.searchStillFor += dt;
    if (this.searchStillFor < CFG.monster.search.dwell + 0.5) return;
    this.searchStillFor = 0;

    const [cx, cy] = this.cell;
    const ns = this.maze.neighbours(cx, cy);
    if (!ns.length) return;
    const [nx, ny] = ns[(Math.random() * ns.length) | 0];
    this.repath(nx, ny);
  }

  /**
   * Escalate to a full chase — unless a chase only just ended.
   *
   * While `chaseCooldown` is running he refuses to sprint, but he emphatically does
   * NOT forget you: he takes the sighting as a fresh fix on your position and
   * re-aims the search sweep at it. So he is still coming, at a walk, to exactly
   * where you are. That is the Grunt shuffling toward the cupboard you are inside,
   * and it is more frightening than the sprint because you cannot simply outrun it
   * — you have to move while he is not looking.
   *
   * Returns nothing; callers may safely call it every frame.
   */
  private enterChase(player: THREE.Vector3) {
    const m0 = CFG.monster;
    /**
     * THE COOLDOWN HAS A PROXIMITY OVERRIDE, and this is the other half of
     * "before SOMETIMES deciding to pursue me".
     *
     * MEASURED over 96 simulated minutes: `enterChase` was reached 77 times and
     * **42.9% of those were refused by `chaseCooldown`** — even though the
     * cooldown is only running for 7.1% of unaware playtime. That
     * disproportion is not an accident. `beginSearch` starts the cooldown, and a
     * search is by construction the period he spends closest to the player, so
     * the 8 s window lands almost exactly on the sightings most likely to be at
     * point-blank range. The player stands in a corridor, watches him look
     * straight at them from a few metres, and watches him walk away — with no
     * way to know that an invisible timer is the reason.
     *
     * The cooldown's PURPOSE is to stop a chase that has just ended from
     * instantly restarting while he is still standing on top of the player (the
     * measured "chase->search @ m=0.0, search->chase @ m=0.3" loop). That purpose
     * is about a chase he has only just lost, not about a fresh, square-on
     * sighting at conversational distance minutes later.
     *
     * So it is overridden when he is inside `commitDistance` AND looking squarely
     * at the player (`commitAcuity`). At that range and that angle the fiction
     * cannot support him politely ignoring you — and the player has, by
     * definition, already failed to break line of sight, which is the thing the
     * cooldown was buying them a chance to do.
     *
     * This deliberately does NOT weaken the anti-thrash guarantee: the override
     * requires a genuine square look, so the m=0.0/m=0.3 re-trigger — which
     * happens with the player behind him at the end of a chase — still gets the
     * full cooldown.
     */
    const d0 = m0.director;
    const commitOverride = this.distanceToPlayer <= d0.commitDistance
      && this.sightAcuity >= d0.commitAcuity;
    if (this.chaseCooldown > 0 && !commitOverride) {
      this.lastKnown.copy(player);
      this.sightTimer = 0;
      if (this.state === 'search') {
        // Re-aim the sweep at the new fix rather than continuing to check stale
        // cells he has already decided are empty. Drains unreachable probes for
        // the same reason beginSearch does.
        this.buildSearchProbes();
        while (this.searchProbes.length) {
          const [nx, ny] = this.searchProbes[0];
          this.repath(nx, ny);
          if (!this.pathDone()) break;
          this.searchProbes.shift();
        }
        if (!this.searchProbes.length) this.repathToLastKnown();
      }
      return;
    }
    if (this.state !== 'chase') this.justSpotted = true;
    // He has registered you: no more looking politely away. A chase turns at the
    // full rate, so nothing here can make him easier to outrun.
    this.gazeAvertTimer = 0;
    // Whatever grace the opening bought, it is spent: he has seen you. The quiet
    // that follows the search must be an ordinary one.
    this.openingBeat = false;
    this.state = 'chase';
    this.sightTimer = 0;
    this.lostTimer = 0;
    this.chaseElapsed = 0;
    // Arm the opening burst. He still has to ACCELERATE into it from a walk — the
    // ramp in update() owns that — so this is "he breaks into a run", not "he is
    // instantly at 6.4 m/s".
    this.lungeTimer = m0.chaseLungeSeconds;
    this.lastKnown.copy(player);
    this.repathToLastKnown();
  }

  /**
   * Walk the current A* path.
   *
   * Two bugs lived in the waypoint-arrival branch, and between them they are the
   * long-tail freeze that survived three separate fixes.
   *
   *   1. Arriving at a waypoint used to `pathIndex++; return;` WITHOUT touching
   *      `currentSpeed`, so the value went stale at whatever the previous frame
   *      happened to leave. `isMoving` is derived from it — which the audio lane
   *      uses to drive his footfalls — and so was `searchWatchdog`'s "is he
   *      actually stuck" test, which is why the watchdog never fired and a
   *      300-minute soak still reported a 17.4 s motionless stretch. A stall that
   *      reports itself as movement cannot be caught by anything downstream.
   *   2. It consumed only ONE waypoint per frame while standing still. A path
   *      whose next few waypoints are all within the arrival radius therefore
   *      burned a frame each doing nothing.
   *
   * Both are fixed by draining arrived waypoints in a loop and then actually
   * stepping in the same frame, with `currentSpeed` always written on every exit.
   */
  private followPath(dt: number, speed: number) {
    // Consume every waypoint we are already standing on, not just one per frame.
    while (!this.pathDone()) {
      const [wx, wz] = this.path[this.pathIndex];
      if (Math.hypot(wx - this.group.position.x, wz - this.group.position.z) >= 0.28) break;
      this.pathIndex++;
    }
    if (this.pathDone()) { this.currentSpeed = 0; return; }
    const [tx, tz] = this.path[this.pathIndex];
    this.stepToward(dt, speed, tx, tz);
  }

  /**
   * May he run in a straight line at the player right now?
   *
   * Only within his own cell, or into an orthogonally adjacent cell through an
   * open edge. That is the exact set of straight lines a body can traverse without
   * clipping a corner, which is why this is not simply `hasLineOfSight`: sight is
   * computed between two *points* and happily passes diagonally across a corner
   * that a solid object cannot. Trusting it here produced 5 wall crossings in a
   * 300-minute soak, all of them diagonal, all during a chase.
   */
  private canLungeAt(player: THREE.Vector3): boolean {
    const [mx, my] = this.cell;
    const [px, py] = this.maze.worldToCell(player.x, player.z);
    if (!this.maze.inBounds(px, py) || !this.maze.inBounds(mx, my)) return false;
    const dx = px - mx, dy = py - my;
    if (dx === 0 && dy === 0) return true;
    if (dx !== 0 && dy !== 0) return false;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
    return this.maze.isOpen(mx, my, dx, dy);
  }

  /**
   * Move toward a world point and turn to face the direction of travel.
   *
   * Callers are responsible for the point being reachable in a straight line —
   * `followPath` only ever passes the next A* waypoint (one cell away, through an
   * open edge), and the chase endgame checks line of sight first. Nothing here
   * consults the maze, so nothing here may be handed an arbitrary target.
   */
  private stepToward(dt: number, speed: number, tx: number, tz: number) {
    const dx = tx - this.group.position.x;
    const dz = tz - this.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) { this.currentSpeed = 0; return; }

    const step = Math.min(speed * dt, dist);
    this.group.position.x += (dx / dist) * step;
    this.group.position.z += (dz / dist) * step;
    this.currentSpeed = dt > 0 ? step / dt : 0;
    // Record the real direction of travel for `repath`'s backstep test. See the
    // field declaration for why the group yaw cannot be used for that.
    this.travelDirX = dx / dist;
    this.travelDirZ = dz / dist;

    // Turn toward travel. Damped so corners are leaned into, not snapped through.
    const targetYaw = Math.atan2(dx, dz);
    const cur = this.group.rotation.y;
    let delta = targetYaw - cur;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    /**
     * Slow the turn while he is averting his gaze from someone he has not
     * registered. See the long note at the `gazeAvertTimer` assignment in
     * `updateDirector`: he acquires the player at a median 72.9 deg — the very
     * edge of his cone — and then his own turn-to-travel walks the player into
     * the centre of it over the next few frames, which is what was converting
     * every glimpse into a chase.
     *
     * A damping factor rather than a freeze, because a monster whose head locks
     * rigidly forward for a beat reads as a bug, and because he still has to get
     * round the corner he is walking into. `gazeAvertTurnScale` at 0.18 leaves
     * him turning, just far too slowly to centre a target inside `spotTime`.
     *
     * Only ever set while unaware — `enterChase` clears it — so a real chase
     * turns at full rate and this can never make him easier to escape.
     */
    const turnRate = this.gazeAvertTimer > 0
      ? 7 * CFG.monster.gazeAvertTurnScale
      : 7;
    this.group.rotation.y = cur + delta * Math.min(1, turnRate * dt);
  }

  /** How loud/urgent the flashlight flicker should be: 0 = calm, 1 = he is on top of you. */
  get proximityPressure() {
    const f = CFG.flashlight.flicker;
    if (!Number.isFinite(this.distanceToPlayer)) return 0;
    const t = (f.startDistance - this.distanceToPlayer) / (f.startDistance - f.panicDistance);
    return Math.max(0, Math.min(1, t));
  }

  dispose() {
    this.mixer?.stopAllAction();
    // Releases the Draco decoder's web workers; without this they outlive a retry.
    this.draco?.dispose();
    this.draco = undefined;
    this.model?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      }
    });
  }
}
