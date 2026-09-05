/**
 * A minimal orbit/zoom/pan camera.
 *
 * Hand-rolled rather than three's `OrbitControls` for the same reason the rest of
 * this page has no dat.gui: the brief asks for a dependency-free tool, and
 * OrbitControls lives in `three/examples` which is a separate import surface.
 * This is ~60 lines and does exactly the three things the page needs.
 *
 *   left-drag  — orbit
 *   right-drag — pan the focus point
 *   wheel      — dolly
 */
import * as THREE from 'three';

export class Orbit {
  readonly target = new THREE.Vector3(0, 1.2, 0);
  private yaw = 0.6;
  private pitch = 0.35;
  private dist = 7;
  private dragging: 'orbit' | 'pan' | null = null;
  private lastX = 0;
  private lastY = 0;

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      this.dragging = e.button === 2 ? 'pan' : 'orbit';
      this.lastX = e.clientX; this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointerup', (e) => {
      this.dragging = null;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      if (this.dragging === 'orbit') {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * 0.006));
      } else {
        // Pan in the camera's own screen plane, scaled by distance so the drag
        // feels the same whether you are close in or far out.
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        const k = this.dist * 0.0016;
        this.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      }
    });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(1.2, Math.min(80, this.dist * (1 + Math.sign(e.deltaY) * 0.12)));
    }, { passive: false });
  }

  /** Frame a point at a given distance — used by the "focus Billy" button. */
  focus(p: THREE.Vector3, dist = this.dist) {
    this.target.set(p.x, p.y, p.z);
    this.dist = dist;
  }

  apply() {
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    this.camera.lookAt(this.target);
  }
}
