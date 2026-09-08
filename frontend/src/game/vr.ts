/**
 * WebXR session, controllers, locomotion and comfort.
 *
 * Target is tethered PC VR. Nothing in here has been through a headset — it is
 * written against the spec and against three's `WebXRManager`, and every claim
 * that could only be settled by wearing one is called out at the point it is
 * made rather than buried in a doc.
 *
 * ## What owns the head
 *
 * `player.setVR(true)` hands the head over: it zeroes the 1.68m eye-height offset
 * (a `local-floor` reference space already reports real head height above the
 * physical floor, so keeping the constant stacks them and puts the view at
 * ~3.3m), zeroes mouse pitch, and stops committing bob/nod/settle/roll to the
 * view. The rig root stays `player.yawObject`, which is why the controllers are
 * parented to it: three writes controller poses in reference space and then
 * composes the parent's world matrix, exactly as it does for the camera, so
 * anything that moves the body moves the hands with it.
 *
 * ## Two decisions that are comfort, not preference
 *
 * **Snap turn rotates about the head, not the rig origin.** Room-scale means the
 * player is usually standing somewhere other than the rig's origin, and rotating
 * the rig about its origin swings them through an arc — they turn and also get
 * translated sideways by up to their offset. It reads as being shoved, and it is
 * one of the fastest ways to make someone sick. Rotating about the head keeps the
 * head still and turns the world around it.
 *
 * **Movement is head-relative, but collision stays in the body's frame.** The
 * stick direction is resolved against where the player is LOOKING, then
 * transformed back into the frame `Player.update` expects, so the existing
 * substepped collision integrator is reused untouched. Locomotion must never get
 * its own collision path — the maze's no-tunnelling guarantee lives in that one
 * function.
 */
import * as THREE from 'three';
import { CFG } from './config';
import { setVrGrade } from './vrgrade';
import type { Player } from './player';

const UP = new THREE.Vector3(0, 1, 0);

export type VrMove = { forward: number; strafe: number; sprint: boolean };

/** Tuning. Snap turn is degrees; the rest are 0..1 stick thresholds. */
export const VR = {
  snapTurnDegrees: 30,
  /** Stick deflection that commits a snap turn, and the release point below it. */
  snapEngage: 0.7,
  snapRelease: 0.35,
  deadzone: 0.18,
  /** Sprint when the stick is pushed past this, or the trigger is held. */
  sprintAt: 0.9,
  /**
   * Comfort tunnel. `idle` is the resting inner radius (1 = no tunnel at all),
   * `moving` is where it closes to at full speed. Tightening fast and opening
   * slowly is deliberate: the tunnel must already be there when motion starts,
   * and must not flicker when the stick is feathered.
   */
  tunnelIdle: 1.0,
  tunnelMoving: 0.62,
  tunnelClose: 6.5,
  tunnelOpen: 2.2,
};

export class VrRig {
  session: XRSession | null = null;
  /** Set while an immersive session owns the head. */
  active = false;
  onEnd: (() => void) | null = null;

  private controllers: THREE.XRTargetRaySpace[] = [];
  private tunnel: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private tunnelAmount = 0;
  private snapLatched = false;
  private move: VrMove = { forward: 0, strafe: 0, sprint: false };

  constructor(
    private renderer: THREE.WebGLRenderer,
    private camera: THREE.PerspectiveCamera,
    private player: Player,
  ) {
    this.renderer.xr.enabled = true;
    // local-floor puts the origin on the physical floor and reports real head
    // height. `local` would report head height relative to wherever the headset
    // happened to be at session start, which drifts between sessions.
    this.renderer.xr.setReferenceSpaceType('local-floor');

    this.tunnel = this.buildTunnel();
    this.tunnel.visible = false;
    // Head-locked by construction: a child of the camera inherits the pose three
    // writes from the headset each frame.
    this.camera.add(this.tunnel);
  }

  static async isSupported() {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr?.isSessionSupported) return false;
    try { return await xr.isSessionSupported('immersive-vr'); } catch { return false; }
  }

  async enter() {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr || this.session) return false;

    const session = await xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
    this.session = session;
    await this.renderer.xr.setSession(session);

    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      // Parented to the rig root, NOT the scene: the hands have to travel with
      // the body when the stick moves it and swing with it when it snap-turns.
      this.player.yawObject.add(c);
      this.controllers.push(c);
    }

    this.player.setVR(true);
    // Post is bypassed in VR, so the grade moves into the scene pass — see
    // vrgrade.ts. Without this the headset shows raw unmapped linear HDR, which
    // is not "ungraded", it is an 11% white disc with no texture in it.
    setVrGrade(this.renderer, true);
    this.tunnel.visible = true;
    this.active = true;

    session.addEventListener('end', () => this.cleanup(), { once: true });
    return true;
  }

  async exit() {
    await this.session?.end();
  }

  private cleanup() {
    for (const c of this.controllers) c.parent?.remove(c);
    this.controllers.length = 0;
    this.session = null;
    this.active = false;
    this.tunnel.visible = false;
    this.tunnelAmount = 0;
    setVrGrade(this.renderer, false);
    this.player.setVR(false);
    this.onEnd?.();
  }

  /** Ray for the in-world pointer: the dominant hand's target-ray space. */
  pointerRay(): { origin: THREE.Vector3; direction: THREE.Vector3 } | null {
    const c = this.controllers[1] ?? this.controllers[0];
    if (!c) return null;
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, 0, -1);
    c.updateWorldMatrix(true, false);
    origin.setFromMatrixPosition(c.matrixWorld);
    direction.transformDirection(c.matrixWorld);
    return { origin, direction };
  }

  /** True while the select trigger is held on either hand. */
  triggerHeld() {
    for (const src of this.inputSources()) {
      if (src.gamepad?.buttons?.[0]?.pressed) return true;
    }
    return false;
  }

  private inputSources(): XRInputSource[] {
    const s = this.session;
    if (!s) return [];
    return Array.from(s.inputSources);
  }

  /**
   * Read the sticks and turn them into the same `PlayerInput` the keyboard
   * produces, so collision, acceleration and the stride clock are all shared.
   */
  update(dt: number): VrMove {
    this.move = { forward: 0, strafe: 0, sprint: false };
    if (!this.active) return this.move;

    let moveX = 0, moveY = 0, turnX = 0;
    for (const src of this.inputSources()) {
      const ax = src.gamepad?.axes;
      if (!ax) continue;
      // Standard xr-standard mapping puts the thumbstick on axes 2/3; some
      // runtimes only populate 0/1. Take whichever is live rather than assuming.
      const sx = Math.abs(ax[2] ?? 0) > Math.abs(ax[0] ?? 0) ? (ax[2] ?? 0) : (ax[0] ?? 0);
      const sy = Math.abs(ax[3] ?? 0) > Math.abs(ax[1] ?? 0) ? (ax[3] ?? 0) : (ax[1] ?? 0);
      if (src.handedness === 'right') turnX = sx;
      else { moveX = sx; moveY = sy; }
    }

    this.applySnapTurn(turnX);

    const mag = Math.hypot(moveX, moveY);
    if (mag > VR.deadzone) {
      // Rescale past the deadzone so the first usable input is not a jump.
      const k = (mag - VR.deadzone) / (1 - VR.deadzone) / mag;
      const wx = moveX * k, wy = moveY * k;

      /**
       * Head-relative, then transformed back into the body's frame.
       *
       * `Player.update` rotates its input by `yawObject.rotation.y`, so handing it
       * raw stick values would move the player relative to their BODY while they
       * are looking somewhere else — push forward while glancing left and you
       * strafe. Resolving against head yaw and then undoing the body yaw makes
       * "forward" mean "where I am looking" without duplicating the collision code.
       */
      const headYaw = this.headYaw();
      const world = new THREE.Vector3(wx, 0, wy).applyAxisAngle(UP, headYaw);
      const local = world.applyAxisAngle(UP, -this.player.yawObject.rotation.y);
      this.move.forward = -local.z;
      this.move.strafe = local.x;
      this.move.sprint = mag > VR.sprintAt;
    }

    this.updateTunnel(dt);
    return this.move;
  }

  /** World heading the headset is facing, ignoring pitch and roll. */
  private headYaw() {
    const q = new THREE.Quaternion();
    this.camera.getWorldQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return Math.atan2(-fwd.x, -fwd.z);
  }

  /**
   * Discrete turn with hysteresis.
   *
   * Engage and release thresholds differ so a stick resting near the boundary
   * cannot chatter out a turn every frame — at 30° a chatter is a spin.
   */
  private applySnapTurn(turnX: number) {
    if (!this.snapLatched && Math.abs(turnX) > VR.snapEngage) {
      this.snapLatched = true;
      this.turnAboutHead(-Math.sign(turnX) * VR.snapTurnDegrees * Math.PI / 180);
    } else if (this.snapLatched && Math.abs(turnX) < VR.snapRelease) {
      this.snapLatched = false;
    }
  }

  /**
   * Rotate the rig about the HEAD's vertical axis.
   *
   * Rotating `yawObject` alone spins the rig about its origin, which in
   * room-scale is wherever the player was standing when the session began — so
   * turning also translates them along an arc as wide as their offset. It reads
   * as being shoved sideways, and it is a reliable way to make someone ill.
   */
  private turnAboutHead(angle: number) {
    const head = new THREE.Vector3();
    this.camera.getWorldPosition(head);
    const p = this.player.yawObject.position;
    const offset = new THREE.Vector3(p.x - head.x, 0, p.z - head.z).applyAxisAngle(UP, angle);
    p.x = head.x + offset.x;
    p.z = head.z + offset.z;
    this.player.yawObject.rotation.y += angle;
  }

  /**
   * Close the tunnel with speed.
   *
   * This is the VR replacement for the sprint FOV push, which is disabled in a
   * headset because a widening frustum is itself a nausea trigger. The flat
   * game's vignette lives in `post.ts` and is screen-space, so it cannot survive
   * stereo; this is real geometry head-locked in front of the eye instead.
   */
  private updateTunnel(dt: number) {
    const speed = this.player.speed;
    const target = Math.min(1, speed / CFG.player.sprintSpeed);
    const rate = target > this.tunnelAmount ? VR.tunnelClose : VR.tunnelOpen;
    this.tunnelAmount += (target - this.tunnelAmount) * Math.min(1, rate * dt);
    const inner = VR.tunnelIdle + (VR.tunnelMoving - VR.tunnelIdle) * this.tunnelAmount;
    this.tunnel.material.uniforms.uInner.value = inner;
    this.tunnel.material.uniforms.uOuter.value = inner + 0.34;
  }

  private buildTunnel() {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        uInner: { value: 1.0 },
        uOuter: { value: 1.34 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float uInner;
        uniform float uOuter;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float a = smoothstep(uInner, uOuter, r);
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }
      `,
    });
    /**
     * Sized generously and placed close. Each eye in VR gets its own off-axis
     * frustum wider than the flat camera's 74°, so a quad sized to the mono FOV
     * would leave the outer edge of each eye uncovered — the one place a comfort
     * vignette actually needs to reach.
     */
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), mat);
    mesh.position.set(0, 0, -0.5);
    mesh.renderOrder = 999;
    mesh.frustumCulled = false;
    return mesh;
  }

  dispose() {
    this.tunnel.geometry.dispose();
    this.tunnel.material.dispose();
    this.tunnel.parent?.remove(this.tunnel);
  }
}
