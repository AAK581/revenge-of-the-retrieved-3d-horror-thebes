/**
 * The two gizmos that make the monster debug page worth having.
 *
 * Both draw REAL data or nothing. There is no decorative geometry in this file:
 * if a value cannot be read from the live `Monster`, the corresponding gizmo is
 * hidden rather than drawn from a plausible guess. A debug overlay that lies is
 * worse than no overlay, because it is believed.
 */
import * as THREE from 'three';
import { CFG } from '../game/config';

/**
 * The vision cone, drawn from exactly the quantities `Monster.perceive()` uses.
 *
 * `perceive()` computes the facing as `(0,0,1)` rotated by `group.quaternion`,
 * takes `angleTo` the flattened vector to the player, and accepts when that
 * angle is `< CFG.monster.sightAngle`. So:
 *
 *   - the cone is drawn around the GROUP's +Z, not around the model's forward
 *     and not around the head bone. The head is deliberately canted by the
 *     wrongness layer and its yaw drift was removed precisely because a head
 *     that moves independently of the cone misleads the player about where he
 *     is looking. Drawing the cone anywhere but the body axis would reintroduce
 *     that lie inside the tool meant to expose it.
 *   - `sightAngle` is a HALF-angle, so the wedge spans 2x it. This has been
 *     misread before (the value was Math.PI*0.42, i.e. a 151 deg field of view,
 *     because it was being read as a full angle).
 *   - the radius is `sightRange`, the same cutoff `perceive()` tests `dist`
 *     against.
 *
 * The inner, brighter wedge is `focusAngle`: inside it a sighting accrues at
 * full acuity, outside it the peripheral penalty applies. That boundary is the
 * difference between "he saw me instantly" and "he took a while", so it is the
 * second question the tool has to answer at a glance.
 *
 * Drawn flat on the floor rather than as a 3D cone: the perception test itself
 * is planar (it flattens Y before measuring the angle), so a solid 3D cone would
 * imply a vertical limit that does not exist.
 */
export class VisionConeGizmo {
  readonly object = new THREE.Group();
  private readonly outer: THREE.Mesh;
  private readonly inner: THREE.Mesh;
  private readonly axis: THREE.Line;

  constructor() {
    const m = CFG.monster;
    this.outer = VisionConeGizmo.wedge(m.sightRange, m.sightAngle, 0x3aa2ff, 0.13);
    this.inner = VisionConeGizmo.wedge(m.sightRange, m.focusAngle, 0x7fd0ff, 0.17);
    // The centre line: the exact axis the angle is measured from.
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, m.sightRange),
    ]);
    this.axis = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x9fdcff }));
    // Sit just above the floor so the grid does not z-fight through it.
    this.object.position.y = 0.02;
    this.object.add(this.outer, this.inner, this.axis);
  }

  /**
   * A filled wedge of half-angle `half`, centred on +Z, lying in the XZ plane.
   * Built from a triangle fan around the apex so the arc is a real arc rather
   * than a polygon with visibly flat sides at 22 m.
   */
  private static wedge(radius: number, half: number, colour: number, opacity: number): THREE.Mesh {
    const SEGMENTS = 64;
    const pos: number[] = [];
    const idx: number[] = [];
    pos.push(0, 0, 0);
    for (let i = 0; i <= SEGMENTS; i++) {
      // Sweep from -half to +half about +Z.
      const a = -half + (2 * half * i) / SEGMENTS;
      pos.push(Math.sin(a) * radius, 0, Math.cos(a) * radius);
    }
    for (let i = 1; i <= SEGMENTS; i++) idx.push(0, i, i + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity,
      side: THREE.DoubleSide, depthWrite: false,
    }));
  }

  /** Follow the monster's group transform — position and yaw only. */
  syncTo(group: THREE.Object3D) {
    this.object.position.set(group.position.x, 0.02, group.position.z);
    this.object.rotation.y = group.rotation.y;
  }

  setVisible(v: boolean) { this.object.visible = v; }
}

/**
 * Where he is actually trying to go.
 *
 * Two markers, because the user's "he runs in weird circles" is precisely the
 * case where these two disagree:
 *
 *   WAYPOINT (amber)  — the immediate A* waypoint he is stepping toward. This is
 *                       the one that thrashes. A previous, real bug had him
 *                       repathing to the centre of the cell he was already
 *                       standing in, so this marker sat BEHIND him and he walked
 *                       backwards to it, over and over. Watching this marker is
 *                       how that becomes visible instead of arguable.
 *   BEAT CELL (green) — the director's higher-level destination. Stable by
 *                       design; if this is calm while the amber marker jitters,
 *                       the fault is in path following, not in the director.
 *
 * A line is drawn from him to each, because a marker alone does not show which
 * side of him it is on, and "behind him" is the whole diagnosis.
 */
export class TargetGizmo {
  readonly object = new THREE.Group();
  private readonly wpMarker: THREE.Mesh;
  private readonly wpLine: THREE.Line;
  private readonly beatMarker: THREE.Mesh;
  private readonly beatLine: THREE.Line;

  constructor() {
    this.wpMarker = TargetGizmo.marker(0xffb03a, 0.22);
    this.beatMarker = TargetGizmo.marker(0x54d98c, 0.32);
    this.wpLine = TargetGizmo.line(0xffb03a);
    this.beatLine = TargetGizmo.line(0x54d98c);
    this.object.add(this.wpMarker, this.beatMarker, this.wpLine, this.beatLine);
  }

  private static marker(colour: number, r: number): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.OctahedronGeometry(r),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.9 }),
    );
  }

  private static line(colour: number): THREE.Line {
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(),
    ]);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.65 }));
  }

  private static aim(line: THREE.Line, from: THREE.Vector3, to: THREE.Vector3) {
    const p = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    p.setXYZ(0, from.x, from.y, from.z);
    p.setXYZ(1, to.x, to.y, to.z);
    p.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  /**
   * `waypoint` and `beatCell` are world XZ, or null when there is none — in which
   * case that marker and its line are HIDDEN rather than parked at the origin or
   * left at a stale position. "No target" has to look different from "target at
   * 0,0", or the gizmo invents a destination he does not have.
   */
  update(
    origin: THREE.Vector3,
    waypoint: [number, number] | null,
    beatCell: [number, number] | null,
  ) {
    const from = new THREE.Vector3(origin.x, 0.9, origin.z);

    if (waypoint) {
      const to = new THREE.Vector3(waypoint[0], 0.9, waypoint[1]);
      this.wpMarker.position.copy(to);
      TargetGizmo.aim(this.wpLine, from, to);
      this.wpMarker.visible = true; this.wpLine.visible = true;
    } else {
      this.wpMarker.visible = false; this.wpLine.visible = false;
    }

    if (beatCell) {
      const to = new THREE.Vector3(beatCell[0], 0.55, beatCell[1]);
      this.beatMarker.position.copy(to);
      TargetGizmo.aim(this.beatLine, from, to);
      this.beatMarker.visible = true; this.beatLine.visible = true;
    } else {
      this.beatMarker.visible = false; this.beatLine.visible = false;
    }
  }

  setVisible(v: boolean) { this.object.visible = v; }
}
