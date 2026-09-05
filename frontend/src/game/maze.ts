/**
 * Maze generation and the spatial queries everything else asks of it.
 *
 * The generator is a recursive backtracker (long, snaking, believable corridors)
 * followed by a braiding pass that punches loops through dead ends. The braiding
 * is the important half: in a perfect maze every chase is a straight sprint down
 * a corridor until you hit a wall and die. Loops let you break line of sight,
 * cut a corner, and hear him take the wrong branch — which is the good part.
 */

import { CFG } from './config';

export type Cell = { n: boolean; s: boolean; e: boolean; w: boolean; visited: boolean };

/** Deterministic PRNG so a seed reproduces a layout exactly — critics need this. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Maze {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly cells: Cell[];
  private rng: () => number;

  constructor(
    cols: number, rows: number, cellSize: number, seed: number, braid: number,
    /**
     * Defaults from config so existing call sites get the fairness pass without
     * having to know about it. Pass 0 explicitly to study the raw braided maze.
     */
    maxCulDeSac: number = CFG.maze.maxCulDeSacCells,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.cellSize = cellSize;
    this.rng = mulberry32(seed);
    this.cells = Array.from({ length: cols * rows }, () => ({
      n: true, s: true, e: true, w: true, visited: false,
    }));
    this.carve();
    this.braid(braid);
    if (maxCulDeSac > 0) this.capCulDeSacs(maxCulDeSac);
  }

  idx(x: number, y: number) { return y * this.cols + x; }
  inBounds(x: number, y: number) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }
  at(x: number, y: number) { return this.cells[this.idx(x, y)]; }

  /** Recursive backtracker, iterative so a big maze can't blow the stack. */
  private carve() {
    const stack: [number, number][] = [[0, 0]];
    this.at(0, 0).visited = true;
    const dirs: [number, number, keyof Cell, keyof Cell][] = [
      [0, -1, 'n', 's'],
      [0, 1, 's', 'n'],
      [1, 0, 'e', 'w'],
      [-1, 0, 'w', 'e'],
    ];

    while (stack.length) {
      const [cx, cy] = stack[stack.length - 1];
      const options = dirs.filter(([dx, dy]) => {
        const nx = cx + dx, ny = cy + dy;
        return this.inBounds(nx, ny) && !this.at(nx, ny).visited;
      });

      if (!options.length) { stack.pop(); continue; }

      const [dx, dy, wall, opposite] = options[(this.rng() * options.length) | 0];
      const nx = cx + dx, ny = cy + dy;
      (this.at(cx, cy) as any)[wall] = false;
      (this.at(nx, ny) as any)[opposite] = false;
      this.at(nx, ny).visited = true;
      stack.push([nx, ny]);
    }
  }

  /** Knock a hole in `fraction` of dead ends, turning them into through-routes. */
  private braid(fraction: number) {
    const deadEnds: [number, number][] = [];
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const c = this.at(x, y);
        const open = [c.n, c.s, c.e, c.w].filter((w) => !w).length;
        if (open === 1) deadEnds.push([x, y]);
      }
    }

    for (const [x, y] of deadEnds) {
      if (this.rng() > fraction) continue;
      const c = this.at(x, y);
      // Candidate walls that are still closed and don't lead outside the maze.
      const candidates: [number, number, keyof Cell, keyof Cell][] = [];
      if (c.n && y > 0) candidates.push([0, -1, 'n', 's']);
      if (c.s && y < this.rows - 1) candidates.push([0, 1, 's', 'n']);
      if (c.e && x < this.cols - 1) candidates.push([1, 0, 'e', 'w']);
      if (c.w && x > 0) candidates.push([-1, 0, 'w', 'e']);
      if (!candidates.length) continue;

      const [dx, dy, wall, opposite] = candidates[(this.rng() * candidates.length) | 0];
      (c as any)[wall] = false;
      (this.at(x + dx, y + dy) as any)[opposite] = false;
    }
  }

  /**
   * A shallow dead end is a hiding place; a deep one is an execution chamber.
   *
   * Braiding alone leaves corridors that run 15+ cells to a blank wall — turn down
   * one of those with Billy behind you and there is no play available, which is
   * unfair rather than frightening. This pass measures how far you must commit
   * before you can branch again, and punches a relief opening in anything deeper
   * than `maxDepth`. Dead ends within the cap are deliberately kept: you need
   * somewhere to press yourself into and hope.
   *
   * Repeats because relieving one throat can lengthen another; converges quickly,
   * and the iteration cap keeps a pathological seed from spinning.
   */
  private capCulDeSacs(maxDepth: number) {
    for (let pass = 0; pass < 12; pass++) {
      let relieved = 0;
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          if (this.neighbours(x, y).length !== 1) continue;
          const throat = this.walkCulDeSac(x, y);
          if (throat.length <= maxDepth) continue;
          // Open the deepest cell we can that actually shortens the commitment:
          // work back from the tip so the relief lands inside the dangerous run.
          for (const [cx, cy] of throat.cells.slice(0, throat.cells.length)) {
            if (this.openAnyWall(cx, cy)) { relieved++; break; }
          }
        }
      }
      if (!relieved) break;
    }
  }

  /** Walk a dead end inward until the corridor branches. Returns the run it traced. */
  private walkCulDeSac(x: number, y: number): { length: number; cells: [number, number][] } {
    const cells: [number, number][] = [[x, y]];
    let cx = x, cy = y, prev = -1;
    for (let guard = 0; guard < this.cols * this.rows; guard++) {
      const forward = this.neighbours(cx, cy).filter(([nx, ny]) => this.idx(nx, ny) !== prev);
      if (forward.length !== 1) break;
      prev = this.idx(cx, cy);
      [cx, cy] = forward[0];
      cells.push([cx, cy]);
    }
    return { length: cells.length - 1, cells };
  }

  /** Open one still-closed interior wall of a cell. Returns false if it is already open on all sides. */
  private openAnyWall(x: number, y: number): boolean {
    const c = this.at(x, y);
    const candidates: [number, number, keyof Cell, keyof Cell][] = [];
    if (c.n && y > 0) candidates.push([0, -1, 'n', 's']);
    if (c.s && y < this.rows - 1) candidates.push([0, 1, 's', 'n']);
    if (c.e && x < this.cols - 1) candidates.push([1, 0, 'e', 'w']);
    if (c.w && x > 0) candidates.push([-1, 0, 'w', 'e']);
    if (!candidates.length) return false;
    const [dx, dy, wall, opposite] = candidates[(this.rng() * candidates.length) | 0];
    (c as any)[wall] = false;
    (this.at(x + dx, y + dy) as any)[opposite] = false;
    return true;
  }

  // ---- world-space helpers -------------------------------------------------

  get width() { return this.cols * this.cellSize; }
  get depth() { return this.rows * this.cellSize; }

  /** Centre of a cell in world space, with the maze centred on the origin. */
  cellToWorld(x: number, y: number): [number, number] {
    return [
      (x + 0.5) * this.cellSize - this.width / 2,
      (y + 0.5) * this.cellSize - this.depth / 2,
    ];
  }

  worldToCell(wx: number, wz: number): [number, number] {
    return [
      Math.floor((wx + this.width / 2) / this.cellSize),
      Math.floor((wz + this.depth / 2) / this.cellSize),
    ];
  }

  /** Can you walk straight from cell a to an edge-adjacent cell b? */
  isOpen(x: number, y: number, dx: number, dy: number): boolean {
    if (!this.inBounds(x, y) || !this.inBounds(x + dx, y + dy)) return false;
    const c = this.at(x, y);
    if (dx === 1) return !c.e;
    if (dx === -1) return !c.w;
    if (dy === 1) return !c.s;
    if (dy === -1) return !c.n;
    return false;
  }

  neighbours(x: number, y: number): [number, number][] {
    const out: [number, number][] = [];
    if (this.isOpen(x, y, 0, -1)) out.push([x, y - 1]);
    if (this.isOpen(x, y, 0, 1)) out.push([x, y + 1]);
    if (this.isOpen(x, y, 1, 0)) out.push([x + 1, y]);
    if (this.isOpen(x, y, -1, 0)) out.push([x - 1, y]);
    return out;
  }

  /** Breadth-first distance field from a cell — used for gem placement and AI. */
  distanceField(sx: number, sy: number): Int32Array {
    const dist = new Int32Array(this.cols * this.rows).fill(-1);
    dist[this.idx(sx, sy)] = 0;
    const queue: [number, number][] = [[sx, sy]];
    for (let head = 0; head < queue.length; head++) {
      const [x, y] = queue[head];
      const d = dist[this.idx(x, y)];
      for (const [nx, ny] of this.neighbours(x, y)) {
        if (dist[this.idx(nx, ny)] === -1) {
          dist[this.idx(nx, ny)] = d + 1;
          queue.push([nx, ny]);
        }
      }
    }
    return dist;
  }

  /** A* over cells. Returns world-space waypoints, or null if unreachable. */
  path(sx: number, sy: number, tx: number, ty: number): [number, number][] | null {
    if (!this.inBounds(sx, sy) || !this.inBounds(tx, ty)) return null;
    const n = this.cols * this.rows;
    const g = new Float32Array(n).fill(Infinity);
    const f = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const open = new Set<number>();
    const start = this.idx(sx, sy), goal = this.idx(tx, ty);
    const h = (i: number) => Math.abs((i % this.cols) - tx) + Math.abs(((i / this.cols) | 0) - ty);

    g[start] = 0; f[start] = h(start); open.add(start);

    while (open.size) {
      let cur = -1, best = Infinity;
      for (const i of open) if (f[i] < best) { best = f[i]; cur = i; }
      if (cur === goal) break;
      open.delete(cur);
      const cx = cur % this.cols, cy = (cur / this.cols) | 0;
      for (const [nx, ny] of this.neighbours(cx, cy)) {
        const ni = this.idx(nx, ny);
        const tentative = g[cur] + 1;
        if (tentative < g[ni]) {
          prev[ni] = cur; g[ni] = tentative; f[ni] = tentative + h(ni);
          open.add(ni);
        }
      }
    }

    if (prev[goal] === -1 && goal !== start) return null;
    const out: [number, number][] = [];
    for (let i = goal; i !== -1; i = prev[i]) {
      out.push(this.cellToWorld(i % this.cols, (i / this.cols) | 0));
      if (i === start) break;
    }
    return out.reverse();
  }

  /**
   * Line of sight between two world points, blocked by walls.
   * Steps along the segment and rejects the moment it would cross a closed edge.
   */
  hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax, dz = bz - az;
    const dist = Math.hypot(dx, dz);
    const steps = Math.ceil(dist / (this.cellSize * 0.25));
    let [px, py] = this.worldToCell(ax, az);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const [cx, cy] = this.worldToCell(ax + dx * t, az + dz * t);
      if (cx === px && cy === py) continue;
      // Only ever move one cell at a time; diagonal jumps need both edges open.
      const sx = Math.sign(cx - px), sy = Math.sign(cy - py);
      if (sx !== 0 && sy !== 0) {
        const viaX = this.isOpen(px, py, sx, 0) && this.isOpen(px + sx, py, 0, sy);
        const viaY = this.isOpen(px, py, 0, sy) && this.isOpen(px, py + sy, sx, 0);
        if (!viaX && !viaY) return false;
      } else if (!this.isOpen(px, py, sx, sy)) {
        return false;
      }
      px = cx; py = cy;
    }
    return true;
  }
}
