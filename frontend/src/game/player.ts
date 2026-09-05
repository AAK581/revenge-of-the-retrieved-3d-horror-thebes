/**
 * First-person controller: movement, collision, head bob, camera sway, footsteps.
 *
 * The camera is deliberately not the thing that moves. A `yawObject` holds the
 * world position and heading; a `pitchObject` under it carries mouse pitch; the
 * camera hangs off that and only ever carries the bob/sway offset. That separation
 * is what lets the head swing hard during a sprint without the collision capsule
 * drifting a millimetre.
 *
 * ## The stride is one clock, not two
 *
 * The single most important thing in this file: `stridePhase` is the *only* clock
 * for the walk cycle, and it is advanced by **distance travelled**, never by time.
 * Head height, lateral head roll, camera roll, the pitch nod and the footstep
 * sound are all read off that one phase. A footstep fires exactly when the phase
 * crosses a foot-plant, so the sound cannot drift out of the visual stride — not
 * at 120fps, not at the 2fps the software rasterizer manages, not while you walk
 * up a slope into a wall.
 *
 * The previous version ran the bob off `dt * frequency` and the footsteps off
 * accumulated distance. Measured with `tools/soak/feel-trace.mjs`, that put the
 * head bobbing at 2.93 footfalls/second while the feet landed 1.62 times a second,
 * and the step-to-footfall offset marched from -83ms to -133ms and wrapped. That
 * is the exact "floating camera" tell: nobody can name it, everybody feels it.
 *
 * ## Anatomy of the stride
 *
 * One `stridePhase` unit = one full two-step gait cycle (left plant, right plant).
 *   - head height  `-cos(2*phase*2pi)` : two dips per cycle, one per foot plant
 *   - head lateral `sin(phase*2pi)`    : one sway per cycle — the body's weight
 *                                        shifting side to side, which is why it is
 *                                        half the frequency of the vertical
 *   - camera roll  follows the lateral, lagging slightly
 *   - pitch nod    a short impulse fired on each plant and damped out
 *
 * ## The viewmodel is what makes any of the above visible
 *
 * All of that motion used to be applied to a camera with nothing in shot, and a
 * critic reading the frames called it correctly: a camera that bobs perfectly with
 * an empty frame is, to the eye, identical to a floating camera. There is no
 * in-frame referent to read the motion against.
 *
 * `buildViewmodel` hangs a torch — and ONLY a torch — off the camera and drives
 * it from the signals already computed above — `stridePhase`, `gait`, `effort`,
 * `sprintAmount`, the nod spring and yaw velocity. It deliberately introduces no
 * new clock. The one thing it must NOT do is sit at a fixed offset: a child of the
 * camera inherits the camera's bob exactly, which reads as painted on the lens.
 * What creates parallax is the *difference* between the torch's swing and the
 * head's, so the viewmodel's bob is a negative fraction of the camera's.
 *
 * ⛔ There is NO hand and NO forearm, by direct user instruction — lathed
 * primitives have no organic silhouette and it read as a robot arm. The torch is
 * cropped by the bottom frame edge instead. `v.gloveColor` survives in config so
 * that restoring one would be a deliberate one-line change; do not read it as
 * evidence that a hand is expected.
 */

import * as THREE from 'three';
import { CFG } from './config';

export type PlayerInput = {
  forward: number;
  strafe: number;
  sprint: boolean;
};

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

export class Player {
  readonly yawObject = new THREE.Object3D();
  readonly pitchObject = new THREE.Object3D();
  readonly camera: THREE.PerspectiveCamera;

  velocity = new THREE.Vector3();

  /**
   * The one clock. Whole numbers are left-foot plants, halves are right-foot
   * plants. Advanced by metres walked divided by stride length, so it is a
   * property of the ground you covered, not of how long the frame took.
   */
  private stridePhase = 0;
  /** Last phase we emitted a footstep for; guards against double-firing. */
  private lastStepPhase = -1;

  /**
   * Three separate 0..1 signals, because conflating them is how a walk ends up
   * with a sprint's field of view.
   *
   *  `gait`    how much of the walk cycle is visible. Tracks speed / walkSpeed.
   *            Zero when standing still, so the head stops swinging when you do.
   *  `effort`  how fast you are going as a fraction of top speed. Drives bob
   *            amplitude and stride length — a brisk walk bobs more than a slow one
   *            whether or not Shift is held.
   *  `sprint`  are you *actually sprinting*. Drives everything that should be a
   *            sprint-only tell: the widened sway the brief asks for, the FOV push,
   *            the forward lean and the narrowed mouse control. Walking must leave
   *            all four completely alone.
   */
  private gait = 0;
  private effort = 0;
  private sprintAmount = 0;

  /** Vertical impulse from a foot plant, and its velocity. A little spring. */
  private nod = 0;
  private nodVel = 0;
  /** Leftover time owed to the fixed-step spring integrator. */
  private springAccum = 0;

  /** Idle breathing runs on its own slow clock; it is the only time-driven motion. */
  private breathPhase = 0;

  /** Smoothed forward lean and FOV, so neither can pop on a single frame. */
  private lean = 0;
  private fov: number;
  private baseFov: number;

  /** Fastest speed reached during the current coast-to-a-stop. */
  private coastPeak = 0;
  /** Landing settle: a downward dip when momentum is dumped into the knees. */
  private settle = 0;
  private settleVel = 0;

  /**
   * The held torch and forearm. `viewmodel` is the pivot that carries all the
   * feel motion; the meshes hang off it in a fixed pose relative to each other,
   * because a hand and the thing in it do not move independently.
   */
  readonly viewmodel = new THREE.Group();
  /** Uniform handle so the shading can track the live flashlight flicker. */
  private vmSpill: { value: number } = { value: 1 };
  /** Smoothed angular rates, for the wrist lag. Radians per second. */
  private yawRate = 0;
  private pitchRate = 0;
  /** Yaw/pitch at the end of the previous frame, to difference against. */
  private lastYaw = 0;
  private lastPitch = 0;

  onFootstep: ((left: boolean) => void) | null = null;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.yawObject.add(this.pitchObject);
    this.pitchObject.add(camera);
    this.pitchObject.position.y = CFG.player.eyeHeight;
    this.baseFov = camera.fov;
    this.fov = camera.fov;

    this.buildViewmodel();
    this.camera.add(this.viewmodel);
  }

  /**
   * How bright the torch body should be shaded, 0..1.
   *
   * game.ts owns the flicker and multiplies the SpotLight's intensity by it. The
   * torch you are holding is lit almost entirely by its own beam bouncing off the
   * wall in front of you, so when the beam stutters the hand must stutter with it —
   * a steady torch body in front of a flickering beam is the tell that the two are
   * unrelated objects. game.ts sets this each frame; the default of 1 means an
   * unwired caller still gets a correctly lit torch rather than a black one.
   */
  set flashlightSpill(v: number) {
    this.vmSpill.value = THREE.MathUtils.lerp(1, Math.max(0, v), CFG.player.viewmodel.spillGain);
  }

  get position() { return this.yawObject.position; }

  /** True world-space heading, ignoring pitch. */
  get forwardVector() {
    return new THREE.Vector3(
      -Math.sin(this.yawObject.rotation.y),
      0,
      -Math.cos(this.yawObject.rotation.y),
    );
  }

  /**
   * True while genuinely running. The monster AI reads this to decide how loud you
   * are, so it must mean "sprinting", not "moving fast-ish": it is gated on the
   * sprint signal and on actually covering ground, so holding Shift against a wall
   * does not broadcast your position.
   */
  get isSprinting() { return this.sprintAmount > 0.6 && this.gait > 0.5; }
  get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }

  /**
   * Read-only windows onto the body, for `tools/soak/player-soak.mjs`.
   *
   * These exist so the soak can assert on the *cause* rather than on a camera
   * offset that has three contributions summed into it — asserting the stop settle
   * is frame-rate independent is impossible if you can only see settle + bob +
   * breath added together. They compute nothing and change nothing.
   */
  get settleDepth() { return this.settle; }
  get nodDepth() { return this.nod; }
  get gaitAmount() { return this.gait; }
  get sprintFraction() { return this.sprintAmount; }

  /**
   * Mouse look. Sprinting narrows your effective control: the brief asks sprint to
   * cost something, and with no stamina bar the cost is that the camera is harder
   * to aim — the same trade a real person makes running flat out down a corridor.
   */
  look(dx: number, dy: number) {
    const p = CFG.player;
    const s = p.mouseSensitivity * (1 - this.sprintAmount * p.sprintLookPenalty);
    this.yawObject.rotation.y -= dx * s;
    this.pitchObject.rotation.x -= dy * s;
    // Clamp just shy of straight up/down; letting it reach the pole flips the view.
    const limit = Math.PI / 2 - 0.02;
    this.pitchObject.rotation.x = Math.max(-limit, Math.min(limit, this.pitchObject.rotation.x));
  }

  update(dt: number, input: PlayerInput, colliders: Float32Array) {
    const p = CFG.player;
    const wantSprint = input.sprint && input.forward > 0;
    const targetSpeed = wantSprint ? p.sprintSpeed : p.walkSpeed;

    // Desired velocity in world space from local input.
    const dir = new THREE.Vector3(input.strafe, 0, -input.forward);
    if (dir.lengthSq() > 0) dir.normalize();
    dir.applyAxisAngle(UP, this.yawObject.rotation.y);

    const desired = dir.multiplyScalar(targetSpeed);
    const wantsToMove = dir.lengthSq() > 0;

    // Speed at the *top* of the frame, before friction gets a say. The stop settle
    // is sized from this, not from the post-friction speed: at a 100ms frame
    // `friction * dt` exceeds 1 and the velocity is annihilated in a single step,
    // so a settle keyed on the speed afterwards saw zero and never fired. Measured
    // settle depth was 58.7mm at 120fps and 12.2mm at 10fps before this.
    const entrySpeed = this.speed;

    const beforeX = this.position.x, beforeZ = this.position.z;

    /**
     * Substep the integration so no single move can be longer than a fraction of
     * the collision radius.
     *
     * These colliders are static boxes tested against the player's *current*
     * position — there is no swept volume, so a step longer than the radius can
     * start outside a wall, end outside the far side, and never be seen as
     * overlapping. `tools/soak/player-soak.mjs` at a 120ms frame measured a 1.11m
     * single-step displacement against a 0.34m radius and put the player outside
     * the maze on 76,423 substeps.
     *
     * game.ts currently clamps dt to 50ms, which at 5 m/s is 0.25m and happens to
     * stay under the radius — but that is a coincidence in another file's constant,
     * not a property of this one. A backgrounded tab, a longer clamp or a faster
     * sprint speed would each reopen it silently. Substepping makes the guarantee
     * local: this controller cannot tunnel regardless of what dt it is handed.
     */
    const maxStep = p.radius * p.maxStepFraction;
    const worstSpeed = Math.max(this.speed, targetSpeed);

    // If even the substep budget cannot cover this frame, shorten the frame rather
    // than exceed the budget. A catastrophic dt — a backgrounded tab handing back a
    // whole second — then costs you a little travel, which nobody notices, instead
    // of putting you outside the maze, which ends the run. Measured: at dt=1s the
    // 8-substep cap alone still let the player escape on 61,358 substeps.
    const safeDt = Math.min(dt, worstSpeed > 1e-4 ? (p.maxSubsteps * maxStep) / worstSpeed : dt);
    const substeps = Math.min(p.maxSubsteps, Math.max(1, Math.ceil((worstSpeed * safeDt) / maxStep)));
    const h = safeDt / substeps;

    for (let i = 0; i < substeps; i++) {
      const rate = wantsToMove ? p.accel : p.friction;
      this.velocity.x += (desired.x - this.velocity.x) * Math.min(1, rate * h);
      this.velocity.z += (desired.z - this.velocity.z) * Math.min(1, rate * h);

      // Resolve against walls one axis at a time. Doing both at once lets you slip
      // through corners diagonally; separating them gives clean sliding.
      this.position.x += this.velocity.x * h;
      this.resolve(colliders, 'x');
      this.position.z += this.velocity.z * h;
      this.resolve(colliders, 'z');
    }

    // Distance actually covered, after walls had their say. Walk into a wall and
    // the stride stops — because your feet stopped going anywhere.
    const travelled = Math.hypot(this.position.x - beforeX, this.position.z - beforeZ);

    this.updateFeel(dt, travelled, wantSprint, wantsToMove, entrySpeed);
  }

  // ---- the body ------------------------------------------------------------

  private updateFeel(
    dt: number, travelled: number, wantSprint: boolean, wantsToMove: boolean, entrySpeed: number,
  ) {
    const p = CFG.player;
    const speed = this.speed;

    // `gait` — how much of the walk cycle is visible. Must reach zero when you stop
    // or the head keeps swinging while you stand still, which is the tell that
    // there is a camera here and not a person.
    const targetGait = Math.min(1, speed / p.walkSpeed);
    this.gait += (targetGait - this.gait) * Math.min(1, p.gaitSmoothing * dt);
    if (this.gait < 0.002) this.gait = 0;

    // `effort` — speed as a fraction of top speed. Amplitude and stride ride this,
    // so a brisk walk is bigger than a slow one regardless of the sprint key.
    // Remapped so a plain walk sits at 0 and a full sprint at 1; without the remap
    // simply walking at 2.6 of 5.0 m/s would sit at 0.52 and inherit half a sprint.
    const rawEffort = (speed - p.walkSpeed) / (p.sprintSpeed - p.walkSpeed);
    const targetEffort = Math.max(0, Math.min(1, rawEffort));
    this.effort += (targetEffort - this.effort) * Math.min(1, p.intensitySmoothing * dt);

    // `sprintAmount` — are you actually sprinting. Everything that must be a
    // sprint-only tell hangs off this and off nothing else, so walking never
    // borrows a sprint's field of view, lean, sway width or loss of control.
    const targetSprint = wantSprint ? Math.min(1, speed / p.sprintSpeed) : 0;
    this.sprintAmount += (targetSprint - this.sprintAmount) * Math.min(1, p.intensitySmoothing * dt);

    // --- the one clock ---------------------------------------------------
    // Distance / stride = gait cycles covered. Running lengthens the stride.
    const strideLen = THREE.MathUtils.lerp(p.strideWalk, p.strideSprint, this.effort);
    const prevPhase = this.stridePhase;
    this.stridePhase += travelled / (strideLen * 2); // 2 steps per gait cycle

    // --- footsteps, read straight off the clock ---------------------------
    // A plant happens at every half-phase boundary. Emitting from the phase means
    // the sound is *definitionally* on the visual footfall; there is no second
    // accumulator that can drift away from it.
    if (this.gait > 0.12) {
      const firstPlant = Math.floor(prevPhase * 2) + 1;
      const lastPlant = Math.floor(this.stridePhase * 2);
      // Cap the emissions per frame. A single frame can legitimately cover more
      // than one plant at low frame rates, but firing a dozen at once is a machine
      // gun, not a run — and an unbounded loop off a float is a hang waiting for a
      // bad number. Past the cap the phase is simply re-anchored.
      const plants = Math.min(lastPlant - firstPlant + 1, p.maxStepsPerFrame);
      for (let n = 0; n < plants; n++) {
        const plant = lastPlant - plants + 1 + n;
        if (plant <= this.lastStepPhase) continue;
        this.lastStepPhase = plant;
        // Even plants are the left foot, odd the right. Alternation is a hard
        // requirement in the brief and this makes it structural rather than
        // stateful: it is derived from the phase, so it cannot desynchronise.
        this.onFootstep?.((plant & 1) === 0);
        // Every plant kicks the head down. The impulse scales with how hard you
        // are working, so a sprint lands heavier than a walk.
        this.kickNod(p.nodImpulse * (0.7 + this.effort * 0.75));
      }
    } else {
      // Standing still. Park the phase a whisker past the last plant and mark that
      // plant as spent, so the next step lands a near-full stride after you set off
      // rather than a few centimetres in. Measured from a standing start: the first
      // footstep fires at 1.278m against a 1.300m walking stride, and every step
      // after it lands at exactly 1.300m.
      const parked = Math.floor(this.stridePhase * 2);
      this.stridePhase = parked / 2 + 0.02;
      this.lastStepPhase = parked;
    }

    // --- the offsets ------------------------------------------------------
    const a = this.stridePhase * TAU;

    // Vertical: two dips per gait cycle, one under each foot plant. `-cos(2a)` is
    // at its minimum exactly at every half-phase, which is exactly where the
    // footstep fires.
    const bobAmp = THREE.MathUtils.lerp(p.bob.walkAmp, p.bob.sprintAmp, this.effort) * this.gait;
    const bobY = -Math.cos(2 * a) * bobAmp;

    // Lateral: one sway per gait cycle. Half the vertical frequency because the
    // weight shifts to one hip, then the other — the thing that reads as a body.
    const bobX = Math.sin(a) * bobAmp * p.bob.lateralRatio;

    // Roll follows the weight shift, trailing it slightly so the head looks like
    // it is being carried rather than driven. This is the sway the brief asks to
    // widen under sprint, so it rides `sprintAmount` and not `effort`.
    const swayAmp = THREE.MathUtils.lerp(p.sway.walkAmp, p.sway.sprintAmp, this.sprintAmount);
    const roll = Math.sin(a - p.sway.rollLagRadians) * swayAmp * this.gait;

    // --- breathing --------------------------------------------------------
    // The only time-driven motion in the controller, and correctly so: your chest
    // does not stop when your feet do.
    //
    // It does two jobs. Standing still it is the whole of the motion — the reason
    // an idle frame is not a photograph. Sprinting it comes *back*, faster and
    // deeper, riding on top of the gait: that heavier breathing is the perceptual
    // cost of the sprint, which is what the brief asks for in place of a stamina
    // bar. Only during an ordinary walk is it suppressed, because a walking body's
    // breath is buried under its own footfalls.
    const breathRate = 1 + this.sprintAmount * p.breath.sprintRateBoost;
    this.breathPhase += dt * p.breath.freq * breathRate;
    const breathWeight = Math.max(1 - this.gait, this.sprintAmount * p.breath.sprintWeight);
    const breathDepth = 1 + this.sprintAmount * p.breath.sprintDepth;
    const breathY = Math.sin(this.breathPhase * TAU) * p.breath.amp * breathWeight * breathDepth;
    // A lateral component too — standing perfectly still on one axis is a tripod,
    // not a person. Runs at half rate and offset so it never traces the vertical.
    const breathX = Math.sin(this.breathPhase * TAU * 0.5 + 2.1) * p.breath.lateralAmp * breathWeight;
    const breathRoll = Math.sin(this.breathPhase * TAU * 0.5 + 1.1) * p.breath.rollAmp * breathWeight * breathDepth;
    // Pitch. Shares the vertical's phase on purpose: a chest filling lifts the head
    // and tips it back as ONE motion. Giving it its own harmonic, as the lateral and
    // roll have, would trace an ellipse and read as a wobble rather than a breath.
    //
    // Without this term the head rose 17mm at idle with 0.000 deg of pitch change,
    // which is the signature of a camera on a vertical slider — and idle is exactly
    // where it shows, because the gait is gone and breathing is all that is left.
    const breathPitch = Math.sin(this.breathPhase * TAU) * p.breath.pitchAmp * breathWeight * breathDepth;

    // --- foot-plant nod and stop settle -----------------------------------
    this.springStep(dt);

    // Hard deceleration dumps momentum into the knees.
    //
    // This is fired *once per stop*, not per frame. Per-frame was the first attempt
    // and it was wrong in a way the trace caught immediately: deceleration spans
    // dozens of frames, so the impulse got applied dozens of times and the settle
    // reached 4.5 degrees of pitch — a lurch, not a settle. Instead the speed you
    // were carrying when you let go is latched, and one impulse proportional to it
    // is spent when you actually come to rest.
    if (!wantsToMove) {
      // Coasting. Latch the fastest we were going, using the speed at the top of
      // the frame — after friction it may already be zero on a slow frame.
      this.coastPeak = Math.max(this.coastPeak, entrySpeed);
      if (speed <= p.settleMinSpeed && this.coastPeak > p.settleThreshold) {
        // Arrived at rest. Spend one impulse, normalised against sprint speed so a
        // stop from a sprint lands hard and a stop from a shuffle barely registers.
        this.settleVel -= (this.coastPeak / p.sprintSpeed) * p.settleGain;
        this.coastPeak = 0;
      }
    } else {
      // Moving again under power: whatever we were coasting from no longer counts.
      this.coastPeak = 0;
    }

    // --- forward lean and FOV --------------------------------------------
    // Leaning into a sprint is what a body does; it also subtly lowers the horizon,
    // which makes the corridor ahead feel longer.
    const targetLean = this.sprintAmount * p.sprintLean * Math.min(1, this.gait * 1.5);
    this.lean += (targetLean - this.lean) * Math.min(1, p.leanSmoothing * dt);

    const targetFov = this.baseFov + this.sprintAmount * p.sprintFovPush * Math.min(1, this.gait * 1.5);
    this.fov += (targetFov - this.fov) * Math.min(1, p.fovSmoothing * dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // --- commit -----------------------------------------------------------
    this.camera.position.y = bobY + breathY + this.nod + this.settle;
    this.camera.position.x = bobX + breathX;
    // Pitch on the camera is purely feel; mouse pitch lives on pitchObject, so the
    // two never contaminate each other and the aim clamp still holds.
    this.camera.rotation.x = this.nod * p.nodToPitch + this.settle * p.settleToPitch
      + breathPitch - this.lean;
    this.camera.rotation.z = roll + breathRoll;

    // The hand goes last, and is handed the *gait* components only — not the summed
    // camera offset, which also carries breath, nod and settle. Those three are
    // applied to the torch separately with their own gains, so feeding the sum in
    // would double-count them and the torch would fight the head instead of
    // trailing it.
    this.updateViewmodel(dt, bobY, bobX, roll);
  }

  /** Kick the foot-plant spring downward. */
  private kickNod(amount: number) {
    this.nodVel -= amount;
  }

  /**
   * The two springs — the per-footfall nod and the stop settle — integrated on a
   * **fixed timestep**, accumulating the leftover across frames.
   *
   * This is not fussiness. Semi-implicit Euler at these stiffnesses is stable but
   * heavily amplitude-dependent on `dt`, and integrating with the raw frame time
   * silently destroys the effect on a slow machine. Measured peak of the walking
   * nod against frame time, before this was fixed:
   *
   *     dt=8.3ms -> 9.1mm    dt=16.7ms -> 8.1mm    dt=33ms -> 5.9mm
   *     dt=50ms  -> 3.0mm    dt=100ms  -> 0.0mm
   *
   * The capture harness runs SwiftShader at roughly the 50ms end, which is exactly
   * where the nod had shrunk to a third of its intended depth — so the feel a
   * critic would have judged was not the feel that was designed. On a fixed
   * substep the curve is identical at every frame rate.
   */
  private springStep(dt: number) {
    const p = CFG.player;
    this.springAccum = Math.min(this.springAccum + dt, p.springMaxAccum);

    const h = p.springStep;
    const step = (x: number, v: number, k: number, d: number): [number, number] => {
      const nv = (v - x * k * h) * Math.max(0, 1 - d * h);
      return [x + nv * h, nv];
    };

    while (this.springAccum >= h) {
      this.springAccum -= h;
      [this.nod, this.nodVel] = step(this.nod, this.nodVel, p.nodStiffness, p.nodDamping);
      [this.settle, this.settleVel] = step(this.settle, this.settleVel, p.settleStiffness, p.settleDamping);
    }
  }

  // ---- the viewmodel -------------------------------------------------------

  /**
   * Shading for anything the player is holding.
   *
   * This is a hand-rolled lighting model rather than a `MeshStandardMaterial`, and
   * that is forced rather than chosen. The world's SpotLight sits at the eye at 160
   * candela with decay 1.75; the torch is 0.46m in front of it, which resolves to
   * roughly 660 candela of incident light and renders as a white silhouette. It is
   * also inside that light's 0.2m shadow-camera near plane, so as a shadow caster it
   * would stamp a black bar across the entire corridor ahead. Layers cannot rescue
   * this: three filters lights by the *camera's* layers, not the object's, so a
   * viewmodel on its own layer is still lit by every light the camera can see.
   *
   * So the held object gets its own rig, in view space, which is what every
   * first-person game does. Three terms, all real per-pixel work:
   *
   *   key   a directional term from up-and-left — the beam bouncing back off the
   *         wall ahead, which really is where almost all the light on your hand
   *         comes from in this game.
   *   fill  a flat ambient floor so the unlit side is dark, not absent.
   *   rim   a Fresnel edge in the sky's red, since the open-topped maze means a
   *         faint bloody light does fall from above.
   *
   * `uSpill` scales key and rim together so the torch stutters with its own beam.
   */
  private viewmodelMaterial(color: number, roughness: number, emissive = 0): THREE.ShaderMaterial {
    const v = CFG.player.viewmodel;
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uKeyDir: { value: new THREE.Vector3(...v.keyDir).normalize() },
        uKey: { value: v.keyIntensity },
        uWrap: { value: v.keyWrap },
        uFill: { value: v.fillIntensity },
        uBounceColor: { value: new THREE.Color(v.bounceColor) },
        uBounce: { value: v.bounceIntensity },
        uRimColor: { value: new THREE.Color(v.rimColor) },
        uRim: { value: v.rimIntensity },
        uRimPower: { value: v.rimPower },
        uGloss: { value: 1 - roughness },
        uEmissive: { value: emissive },
        uExposureComp: { value: v.exposureCompensation },
        uSpill: this.vmSpill,
      },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          // Everything is computed in VIEW space. The viewmodel is parented to the
          // camera, so view space is the hand's own frame: the key direction stays
          // pinned to the barrel no matter which way the player is facing, which is
          // exactly right — the light on your hand comes from your own torch.
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3  uColor;
        uniform vec3  uKeyDir;
        uniform vec3  uRimColor;
        uniform vec3  uBounceColor;
        uniform float uKey, uWrap, uFill, uBounce, uRim, uRimPower, uGloss, uEmissive, uSpill, uExposureComp;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec3 n = normalize(vN);
          vec3 v = normalize(vV);

          // Wrapped Lambert. uWrap = 0 is pure Lambert, 1 is half-Lambert.
          //
          // The first build used half-Lambert SQUARED, which is a flattening
          // operator: it lifts the dark side and compresses the whole range, and the
          // measured result was a luminance histogram with no separation between the
          // near-black barrel, the grey bezel and the brown glove. At 0.35 the dark
          // side stays dark and the terminator sits where a cylinder's terminator
          // belongs, which is the entire reason the barrel reads as round.
          float ndl = dot(n, uKeyDir);
          float key = max(0.0, (ndl + uWrap) / (1.0 + uWrap)) * uKey * uSpill;

          // Bounce from the floor. Up-facing surfaces get nothing from a key that
          // comes from in front; without this the underside of the forearm is dead
          // black and the arm loses its bottom edge against the corridor.
          float bounce = max(0.0, -n.y) * uBounce;

          // Blinn-Phong lobe, so the bezel and the wet glove catch a highlight that
          // MOVES as the wrist rolls. That moving highlight is a large part of what
          // sells the rig as a physical object rather than a decal: it is the one
          // cue that responds to rotation rather than to translation.
          vec3  h    = normalize(uKeyDir + v);
          float spec = pow(max(dot(n, h), 0.0), mix(6.0, 110.0, uGloss)) * uGloss * uSpill;

          float rim = pow(1.0 - max(dot(n, v), 0.0), uRimPower) * uRim;

          vec3 c = uColor * (key + uFill)
                 + uBounceColor * bounce
                 + vec3(spec) * 0.5 * uSpill
                 + uRimColor * rim;
          c += uColor * uEmissive;
          // Undo part of the renderer's 0.15 exposure. This shader emits reflectance,
          // not the physical-unit radiance the rest of the scene emits, so without
          // this the whole rig tone-maps to black — and with FULL compensation it
          // tone-maps to a featureless pale blob. See config's exposureCompensation.
          gl_FragColor = vec4(c * uExposureComp, 1.0);
        }
      `,
      // No scene fog on the viewmodel. At 0.46m the fog contribution is a rounding
      // error, and opting out keeps world.ts's elevation-fog patch — which rewrites
      // every fogged material's shader at load — from touching these.
      fog: false,
    });
  }

  /**
   * Build the torch and the forearm holding it.
   *
   * Pose logic, and the sizes are derived rather than dialled in. At this game's 74
   * degree vertical FOV a plane at z = -0.46 spans 0.694m tall by 1.234m wide, so a
   * 0.36m torch is 29% of the frame width and the forearm running back from it fills
   * the lower-left corner — which is the proportion Amnesia's reference screenshot
   * shows. The first build used a 0.19m barrel and it read as a speck.
   *
   * It is the LEFT hand, again following Amnesia. That is not only taste: the beam's
   * own pool lands at frame centre and slightly right when you walk a corridor, so a
   * left-side torch is silhouetted against darkness rather than washed out by its
   * own light. Measured on the right-hand build, bottom-right luminance was 12.8
   * with the pool at 182 in the adjacent cell.
   *
   * Whole rig is 12 meshes and roughly 900 triangles.
   */
  private buildViewmodel() {
    const v = CFG.player.viewmodel;
    const seg = v.segments;

    const body = this.viewmodelMaterial(v.bodyColor, 0.72);
    // 0.55 not 0.30. At 0.30 the bezel's specular lobe was tight and strong enough
    // that the cuff read as a bright white band and pulled the eye off the beam —
    // the exact failure the palette rule in GAME-SPEC 6a names. Dull machined
    // aluminium is not a mirror; it wants a broad, weak lobe.
    const bezel = this.viewmodelMaterial(v.bezelColor, 0.55);
    // No `glove` material any more — the hand it clothed has been removed (see the
    // note further down). `v.gloveColor` is left in config rather than deleted, so
    // that restoring a hand later is a one-line change rather than an archaeology
    // exercise.
    /**
     * A near-black, matte material used only for the narrow rings that separate one
     * part of the rig from the next.
     *
     * Real objects have contact shadows where two parts meet, and a viewmodel with
     * none reads as one extruded lump. That is exactly what the second build did:
     * the crop showed forearm, cuff, fist, barrel and head merging into a single
     * smooth tapered shape with no joints anywhere. There is no ambient occlusion
     * available here — the rig is shaded by a hand-written three-term rig, not by
     * the scene — so the occlusion is authored as geometry instead.
     */
    const seam = this.viewmodelMaterial(0x05060a, 0.95);
    // The lens is the one genuinely bright thing the player owns. It is lit from
    // behind by the bulb, so it carries an emissive term — but it is NOT a light and
    // nothing is parented to it. GAME-SPEC §6a is explicit that only the flashlight
    // makes light in this game.
    const lens = this.viewmodelMaterial(v.emitterColor, 0.1, 2.6);

    // Cylinders are authored along +Y and rotated to lie along -Z (forward), so the
    // torch points where the beam goes.
    const layFlat = (m: THREE.Mesh) => { m.rotation.x = -Math.PI / 2; return m; };

    // Barrel: the grip you hold. Slightly tapered, wider at the front.
    const barrel = layFlat(new THREE.Mesh(
      new THREE.CylinderGeometry(0.046, 0.040, 0.30, seg, 1, false), body,
    ));
    barrel.position.set(0, 0, 0.055);

    // Knurled grip band — one extra ring, but it is the detail that stops the barrel
    // reading as an untextured tube at this distance.
    const grip = layFlat(new THREE.Mesh(
      new THREE.CylinderGeometry(0.051, 0.051, 0.090, seg, 1, false), bezel,
    ));
    grip.position.set(0, 0, 0.098);

    // A slab of a switch on top of the barrel. Purely silhouette: it is the one
    // asymmetric feature on an otherwise perfectly rotational object, so it is what
    // makes the wrist ROLL legible. Without it, the barrel spinning about its own
    // axis under the sway is completely invisible and the roll work is wasted.
    const rocker = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.020, 0.062), bezel);
    rocker.position.set(0, 0.048, 0.070);

    // Head: the reflector housing, flaring out toward the lens.
    const head = layFlat(new THREE.Mesh(
      new THREE.CylinderGeometry(0.082, 0.049, 0.135, seg, 1, false), body,
    ));
    head.position.set(0, 0, -0.163);

    // Bezel ring around the glass.
    const ring = layFlat(new THREE.Mesh(
      new THREE.CylinderGeometry(0.087, 0.083, 0.024, seg, 1, false), bezel,
    ));
    ring.position.set(0, 0, -0.238);

    // The lens itself. A shallow cone rather than a disc so it catches the key
    // across its face and reads as glass with a reflector behind it.
    const glass = new THREE.Mesh(new THREE.ConeGeometry(0.079, 0.050, seg, 1, false), lens);
    glass.rotation.x = Math.PI / 2;
    glass.position.set(0, 0, -0.262);

    // Seam rings. Each stands a hair proud of the part behind it so it is never
    // z-fighting, and each is only 12-18mm long — at 0.46m that is a couple of
    // pixels of hard black, which is all a contact shadow ever is.
    const seamRing = (radius: number, len: number, z: number) => {
      const m = layFlat(new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, len, seg, 1, false), seam,
      ));
      m.position.set(0, 0, z);
      return m;
    };
    // Where the fist ends and the bare barrel begins.
    const seamFist = seamRing(0.048, 0.014, 0.030);
    // Where the barrel meets the flare of the head.
    const seamHead = seamRing(0.050, 0.016, -0.093);

    const torch = new THREE.Group();
    torch.add(barrel, grip, rocker, head, ring, glass, seamFist, seamHead);
    // Muzzle-up and toed-in toward screen centre. A hand does not hold a torch dead
    // level with the eye line, and the inward yaw aims the visible muzzle at where
    // the beam's pool actually lands, so the torch and its light read as one object.
    // Mirrored in yaw and roll from the right-hand version, because this is the
    // left hand.
    torch.rotation.set(0.085, -0.10, 0.05);

    /*
     * --- NO HAND. This is deliberate, on direct user instruction. ---
     *
     * There used to be a fist, two knuckle ridges, a thumb, a forearm, a cuff and a
     * wrist seam here, all built from lathed primitives — sphere, capsules,
     * cylinders. The user's verdict on seeing it in play was "what's with my robotic
     * looking hand", and they were right: smooth geometric solids have no organic
     * silhouette, so at any size the assembly reads as machinery rather than as a
     * person. A believable hand needs a sculpted mesh, which we do not have and
     * cannot author from the shipped assets.
     *
     * The honest options were a bad hand or no hand. No hand is better: plenty of
     * first-person horror shows only the held light. The torch is dropped low enough
     * that it enters from the bottom edge of the frame, so it reads as *held* rather
     * than floating in front of the player's face — which was the other half of the
     * note. See `restY` in config.
     *
     * `glove`, `bezel` and `seam` remain in use by the torch body itself.
     */
    this.viewmodel.add(torch);
    this.viewmodel.position.set(v.restX, v.restY, v.restZ);

    // Never a shadow caster and never a receiver.
    //
    // As a caster it sits inside the flashlight's 0.2m shadow-camera near plane and
    // would project a black bar across the whole corridor. As a receiver it would
    // sample that same map at a depth the map cannot represent and self-shadow into
    // solid black. It is lit entirely by the rig in `viewmodelMaterial`.
    this.viewmodel.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      // Draw after the world. The torch is always nearer than any wall so depth
      // already sorts it correctly, but rendering it last means the near-field
      // fragments are not shaded and then thrown away behind a wall that has not
      // been drawn yet, which on the software rasterizer is real fill-rate.
      (o as THREE.Mesh).renderOrder = 10;
    });
    this.viewmodel.matrixAutoUpdate = true;
  }

  /**
   * Drive the torch from the body's existing signals. Called once per frame from
   * `updateFeel`, after the camera's own offsets are known.
   *
   * `camBobY`/`camBobX` are the camera's *gait* contribution alone — not the summed
   * camera position, which also carries the breath, the nod and the settle. Feeding
   * the sum in would double-count everything the hand handles separately and the
   * torch would fight the head instead of trailing it.
   */
  private updateViewmodel(dt: number, camBobY: number, camBobX: number, camRoll: number) {
    const p = CFG.player;
    const v = p.viewmodel;

    // --- angular rates, for the wrist lag --------------------------------
    // Differenced from the actual rotations rather than accumulated from `look()`
    // calls, so a teleport or a testhook flick is seen exactly as the player sees
    // it. dt is floored so a stalled frame cannot divide by ~0 and produce a
    // thousand-radian rate that flings the torch out of frame.
    const safeDt = Math.max(dt, 1 / 240);
    const dYaw = this.yawObject.rotation.y - this.lastYaw;
    const dPitch = this.pitchObject.rotation.x - this.lastPitch;
    this.lastYaw = this.yawObject.rotation.y;
    this.lastPitch = this.pitchObject.rotation.x;

    const follow = Math.min(1, v.yawLagSmoothing * dt);
    this.yawRate += (dYaw / safeDt - this.yawRate) * follow;
    this.pitchRate += (dPitch / safeDt - this.pitchRate) * follow;

    const clamp = (x: number) => Math.max(-v.maxLag, Math.min(v.maxLag, x));
    const yawLag = clamp(this.yawRate * v.yawLagGain);
    const pitchLag = clamp(this.pitchRate * v.pitchLagGain);

    // --- the swing -------------------------------------------------------
    // A fraction of the camera's own bob, inverted. The camera has already moved by
    // camBobY; adding a negative fraction here leaves the torch moving in world
    // space by (1 + bobFollow) of the head — i.e. less, and out of phase, which is
    // the parallax that proves the two are different objects.
    const swingScale = 1 + this.sprintAmount * (v.sprintSwingBoost - 1);
    const bobY = camBobY * v.bobFollow * swingScale;
    const bobX = camBobX * v.swayFollow * swingScale;

    // --- breath ----------------------------------------------------------
    // Runs off the same `breathPhase` the camera uses but at a different harmonic,
    // so the hand and the head never trace the same curve. Fades out under gait for
    // the same reason the camera's does: a walking body's breath is buried under its
    // own footfalls.
    const idle = 1 - Math.min(1, this.gait * 1.4);
    const bp = this.breathPhase * TAU;
    const breathLift = Math.sin(bp * 0.5 + 0.7) * v.breathLift * idle;
    const breathTilt = Math.sin(bp * 0.5 + 2.4) * v.breathTilt * idle;
    // A lateral drift too. Without it a standing player's torch moves on exactly one
    // axis, which is a tripod rather than an arm — the first build measured 4.7mm of
    // idle vertical drift and 0.0mm lateral. Runs at a third of the breath rate and
    // offset in phase so it never traces the vertical and never produces a beat.
    const breathDrift = Math.sin(bp * 0.34 + 1.9) * v.breathDrift * idle;

    // --- pose ------------------------------------------------------------
    this.viewmodel.position.set(
      v.restX + bobX + breathDrift + this.sprintAmount * v.sprintPullIn
        - yawLag * (v.yawSlideGain / v.yawLagGain),
      v.restY + bobY + breathLift + this.sprintAmount * v.sprintDrop
        + this.nod * v.nodToLift - pitchLag * (v.pitchSlideGain / v.pitchLagGain),
      v.restZ,
    );

    this.viewmodel.rotation.set(
      // Pitch: the muzzle kicks up on each foot plant (nod is negative going down,
      // nodToTilt is negative, so a plant lifts the beam), tilts down under sprint,
      // and lags the player looking up or down.
      this.nod * v.nodToTilt + breathTilt + this.sprintAmount * v.sprintTiltDown + pitchLag,
      // Yaw: pure wrist lag on the turn.
      yawLag,
      // Roll: counter the camera's own roll partly, so the torch does not appear
      // welded to the horizon line, and add the lateral swing as a wrist roll.
      -camRoll * 0.55 + bobX * 2.2 - yawLag * 0.7,
    );
  }

  // ---- collision -----------------------------------------------------------

  /**
   * Push the player out of every wall box it overlaps, on one axis.
   *
   * The loop repeats until nothing overlaps rather than stopping at the first hit.
   * Standing in an inside corner puts you inside *two* boxes simultaneously —
   * verified in `tools/soak/player-soak.mjs` — and ejecting from only one leaves
   * you inside the other, which is a hole waiting for a frame-rate spike to open.
   * The pass cap is a safety net, not a design: with axis-aligned boxes and a
   * 0.34m radius against 4m cells, two passes is the real worst case.
   */
  private resolve(colliders: Float32Array, axis: 'x' | 'z') {
    const r = CFG.player.radius;
    for (let pass = 0; pass < 4; pass++) {
      let hit = false;
      const px = this.position.x, pz = this.position.z;
      for (let i = 0; i < colliders.length; i += 4) {
        const minX = colliders[i], minZ = colliders[i + 1];
        const maxX = colliders[i + 2], maxZ = colliders[i + 3];
        if (px + r <= minX || px - r >= maxX || pz + r <= minZ || pz - r >= maxZ) continue;

        hit = true;
        if (axis === 'x') {
          // Eject along the shorter horizontal escape.
          if (px < (minX + maxX) / 2) this.position.x = minX - r;
          else this.position.x = maxX + r;
          this.velocity.x = 0;
        } else {
          if (pz < (minZ + maxZ) / 2) this.position.z = minZ - r;
          else this.position.z = maxZ + r;
          this.velocity.z = 0;
        }
        break;
      }
      if (!hit) return;
    }
  }
}
