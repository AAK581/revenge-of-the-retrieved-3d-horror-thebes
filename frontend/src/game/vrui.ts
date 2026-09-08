/**
 * In-world UI: canvas-textured panels and a ray pointer.
 *
 * This project has no in-scene text of any kind — every menu, the HUD, the loop
 * card and the death screen are DOM overlays, and DOM does not exist inside a
 * headset. This module is what replaces them.
 *
 * ## Why the UI gets its own scene and its own pass
 *
 * The obvious implementation is to park a textured quad in the world and let it
 * render with everything else. That is wrong here, and not subtly: `post.ts`
 * desaturates the frame by 0.50, drains a further 0.66 out of the shadow band,
 * runs a log tone curve and lays a vignette over the result. The DOM overlays it
 * replaces are composited *on top of* that and never touch it. A panel rendered
 * into the main scene goes through all of it and comes out muddy brown with its
 * corners eaten. `toneMapped = false` does not rescue it either, because the grade
 * pass samples the render target — the material flag only speaks to the renderer's
 * own tone mapping, which post already bypasses.
 *
 * So the panels live in a separate `THREE.Scene` composited afterwards with the
 * depth buffer cleared. That also means they are never fogged, never lit, and
 * never occluded by maze geometry — all three of which are correct for a menu you
 * are meant to be able to read in a pitch-dark corridor.
 *
 * ## The pointer is deliberately ray-shaped, not mouse-shaped
 *
 * `setRay()` takes a world-space origin and direction. In VR that is a controller
 * pose; on a flat screen `rayFromMouse()` builds the identical thing out of the
 * camera and an NDC coordinate. Everything downstream — hover, press, select —
 * sees only a ray, so the flat path is not a stand-in for the VR path, it *is*
 * the VR path with a different origin. That is what makes this whole layer
 * testable a week before the hardware arrives.
 */
import * as THREE from 'three';

/** Ember, bone and ash — the same tokens `game.css` uses. */
const BONE = '#d9cfc2';
const ASH = '#6d635a';
const EMBER = '#c8330f';
const EMBER_DIM = '#7a1f09';

/**
 * Canvas pixels per world metre.
 *
 * Sets how sharp the text is, and it is worth being deliberate rather than
 * picking a round power of two. A 0.9m panel read at 1.5m subtends
 * 2·atan(0.45/1.5) ≈ 33.4°, so at this density it carries ~46 canvas pixels per
 * degree of view. A tethered PC VR headset resolves somewhere near 15-20 px/deg,
 * so the texture is comfortably not the limiting factor — the display is. Drop
 * this and text becomes the bottleneck; raise it and you are paying memory to
 * render detail the optics cannot pass.
 */
const PX_PER_M = 1800;

/** Deterministic noise, so a panel texture is byte-identical between runs. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PanelItem =
  | { kind: 'title'; text: string }
  /**
   * `scale` multiplies the base size, `tone` picks bone over ash. Both exist for
   * the HUD: at its panel width the default 0.038 ratio produces glyphs 0.016m
   * tall, which at 1.5m subtend 0.6° — roughly a third of the ~1.5° floor for
   * comfortable reading in a headset, and it rendered as an illegible smudge.
   */
  | { kind: 'text'; text: string; scale?: number; tone?: 'bone' | 'ash' }
  /**
   * The gem tally, drawn as SHAPES rather than characters.
   *
   * The first version used ◆ and ◇. Neither is guaranteed to exist in Georgia,
   * and a missing glyph renders as tofu — in the middle of the one element the
   * player looks at most. The flat HUD has the same instinct: its ticks are
   * styled spans, not text.
   */
  | { kind: 'ticks'; got: number; total: number }
  | { kind: 'rule' }
  | { kind: 'gap'; h: number }
  | { kind: 'button'; id: string; label: string; primary?: boolean }
  /** 0..1. Pointing at the track and pressing sets it; holding drags it. */
  | { kind: 'slider'; id: string; label: string; value: number }
  /** Scoreboard row. `weights` are column fractions and must sum to 1. */
  | { kind: 'row'; cells: string[]; weights: number[]; head?: boolean; you?: boolean }
  /** The depth card's numeral. */
  | { kind: 'bignum'; value: string; caption: string };

type HitRect = { id: string; x: number; y: number; w: number; h: number; slider?: boolean };

/** Where on a control the ray landed. `u` is 0..1 across it — the slider needs it. */
export type HitInfo = { id: string; u: number; slider: boolean };

export class Panel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly widthM: number;
  /** Grows to fit content — see `setItems`. Read it, do not assume it. */
  heightM: number;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private items: PanelItem[] = [];
  private hits: HitRect[] = [];
  private hovered: string | null = null;
  private pressed: string | null = null;
  /**
   * Smallest glyph height actually laid out, in canvas px.
   *
   * Recorded rather than recomputed so a legibility check reads what was drawn
   * instead of mirroring the ratio constants in this file — a mirror drifts, and
   * a drifted legibility floor fails silently in the safe direction.
   */
  private minGlyph = Infinity;

  /**
   * `bare` drops the plank and its edge, leaving only the text.
   *
   * The HUD needs it. A gem tally rendered on a wooden card is a *menu* pinned in
   * your view; the flat game's HUD is unbacked text over the corridor and reads as
   * part of the world. Backing it would be the single most immersion-breaking
   * thing in the VR port.
   */
  private readonly style: 'plank' | 'bare';

  constructor(widthM: number, heightM: number, style: 'plank' | 'bare' = 'plank') {
    this.widthM = widthM;
    this.heightM = heightM;
    this.style = style;

    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(widthM * PX_PER_M);
    this.canvas.height = Math.round(heightM * PX_PER_M);
    this.ctx = this.canvas.getContext('2d')!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // The pointer often meets a panel at a shallow angle; without anisotropy the
    // text at the far edge smears exactly where a laser makes you look.
    this.texture.anisotropy = 8;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, heightM),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        // Never fogged, never tone-mapped: this is composited over the graded
        // frame, so it must arrive with the colours it was authored in.
        fog: false,
        toneMapped: false,
      }),
    );
    this.mesh.renderOrder = 10;
  }

  get buttonIds() { return this.hits.map((h) => h.id); }

  /** Smallest glyph actually drawn, canvas px. Ground truth for legibility checks. */
  get minGlyphPx() { return this.minGlyph; }

  /**
   * Set the contents, growing the panel if they do not fit.
   *
   * The height argument to the constructor is a *minimum*, not a promise. The
   * first fixture built for this class asked for 0.62m and laid its last button
   * out at y=1117 on a canvas 1116 pixels tall: the control was never painted and
   * its hit rect sat outside the quad, so it was invisible AND unclickable, and
   * nothing anywhere reported a problem. A menu that silently drops its last
   * option is a bug that reaches players, and "remember to size the panel" is not
   * a fix. So content is measured before it is painted and the quad is rebuilt to
   * fit — overflow is not handled, it is made unrepresentable.
   */
  setItems(items: PanelItem[]) {
    this.items = items;

    const pad = Math.round(this.canvas.width * 0.085);
    const needed = Math.ceil(this.layout(false) + pad);
    if (needed > this.canvas.height) this.resizeTo(needed);

    this.draw();
  }

  /** True if content still exceeds the canvas. Should never be true after setItems. */
  get overflows() {
    return this.layout(false) > this.canvas.height;
  }

  private resizeTo(pxHeight: number) {
    this.canvas.height = pxHeight;
    this.heightM = pxHeight / PX_PER_M;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(this.widthM, this.heightM);
  }

  /**
   * Map a hit on this panel to a button id.
   *
   * `uv` comes from three's raycaster and has its origin at the BOTTOM-left, while
   * every canvas coordinate here has its origin at the TOP-left. The flip below is
   * the whole reason `tools/vrui-check.mjs` tests an asymmetric layout: a
   * vertically mirrored hit-test still lands correctly on a single centred button
   * and only reveals itself on a stack, where it selects Home when you point at
   * Resume. That is a bug that ships.
   */
  hitTest(uv: THREE.Vector2): string | null {
    return this.hitInfo(uv)?.id ?? null;
  }

  hitInfo(uv: THREE.Vector2): HitInfo | null {
    const x = uv.x * this.canvas.width;
    const y = (1 - uv.y) * this.canvas.height;
    for (const h of this.hits) {
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        return { id: h.id, u: (x - h.x) / h.w, slider: !!h.slider };
      }
    }
    return null;
  }

  setHover(id: string | null) {
    if (this.hovered === id) return;
    this.hovered = id;
    this.draw();
  }

  setPressed(id: string | null) {
    if (this.pressed === id) return;
    this.pressed = id;
    this.draw();
  }

  /** Canvas-space rect of a button, for tests that need to aim at one. */
  rectOf(id: string): HitRect | null {
    return this.hits.find((h) => h.id === id) ?? null;
  }

  /**
   * Convert a canvas-space point to the UV a raycast would report for it.
   * Inverse of the flip in `hitTest`; lets a test aim without duplicating the math.
   */
  uvOf(px: number, py: number) {
    return new THREE.Vector2(px / this.canvas.width, 1 - py / this.canvas.height);
  }

  dispose() {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  // ---- drawing -------------------------------------------------------------

  private draw() {
    this.hits = [];
    this.drawPlank(this.ctx, this.canvas.width, this.canvas.height);
    this.layout(true);
    this.texture.needsUpdate = true;
  }

  /**
   * One flow pass. Returns the y the content ends at.
   *
   * `paint` is what lets `setItems` measure before it commits to a canvas size.
   * Measuring still sets fonts, because `measureText` is meaningless without
   * them — it just never puts ink down and never registers a hit rect, so a
   * measure pass cannot leave a phantom button behind.
   */
  private layout(paint: boolean): number {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const pad = Math.round(W * 0.085);
    let y = pad;
    if (paint) this.minGlyph = Infinity;
    const note = (px: number) => { if (paint) this.minGlyph = Math.min(this.minGlyph, px); };

    for (const item of this.items) {
      switch (item.kind) {
        case 'title': {
          /**
           * Titles WRAP. They did not, and the menu shipped its own game's name as
           * "REVENGE OF THE RETRI" — sheared off at the panel edge, with eighteen
           * assertions green, because not one of them looked at where the ink
           * landed. Letter spacing is set before measuring as well as before
           * painting: it widens the string materially at this size, so measuring
           * without it wraps a line that then does not fit.
           */
          const size = Math.round(W * 0.072);
          note(size);
          ctx.font = `${size}px Georgia, 'Times New Roman', serif`;
          ctx.letterSpacing = `${Math.round(size * 0.06)}px`;
          if (paint) {
            ctx.fillStyle = BONE;
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(0,0,0,0.9)';
            ctx.shadowBlur = size * 0.25;
          }
          y = this.wrapText(item.text, pad, y, W - pad * 2, size * 1.16, paint);
          if (paint) ctx.shadowBlur = 0;
          ctx.letterSpacing = '0px';
          y += size * 0.24;
          break;
        }
        case 'text': {
          const size = Math.round(W * 0.042 * (item.scale ?? 1));
          note(size);
          ctx.font = `${size}px Georgia, 'Times New Roman', serif`;
          if (paint) {
            ctx.fillStyle = item.tone === 'bone' ? BONE : ASH;
            ctx.textBaseline = 'top';
          }
          y = this.wrapText(item.text, pad, y, W - pad * 2, size * 1.42, paint);
          y += size * 0.5;
          break;
        }
        case 'ticks': {
          const r = W * 0.030;
          const gap = r * 2.9;
          const rowH = r * 3.4;
          if (paint) {
            for (let i = 0; i < item.total; i++) {
              const cx = pad + r + i * gap;
              const cy = y + r;
              // A diamond, drawn: rotate 45° about its own centre.
              ctx.beginPath();
              ctx.moveTo(cx, cy - r);
              ctx.lineTo(cx + r, cy);
              ctx.lineTo(cx, cy + r);
              ctx.lineTo(cx - r, cy);
              ctx.closePath();
              if (i < item.got) {
                const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
                g.addColorStop(0, '#f0e4d2');
                g.addColorStop(1, EMBER);
                ctx.fillStyle = g;
                ctx.fill();
              } else {
                ctx.strokeStyle = 'rgba(109,99,90,0.75)';
                ctx.lineWidth = Math.max(1, W * 0.005);
                ctx.stroke();
              }
            }
          }
          y += rowH;
          break;
        }
        case 'rule': {
          if (paint) {
            const g = ctx.createLinearGradient(pad, 0, W - pad, 0);
            g.addColorStop(0, 'rgba(200,51,15,0.55)');
            g.addColorStop(1, 'rgba(200,51,15,0)');
            ctx.fillStyle = g;
            ctx.fillRect(pad, y, W - pad * 2, Math.max(1, Math.round(W * 0.0022)));
          }
          y += Math.round(W * 0.035);
          break;
        }
        case 'gap':
          y += Math.round(item.h * PX_PER_M);
          break;
        case 'button':
          y = this.drawButton(item, pad, y, W - pad * 2, paint);
          break;
        case 'slider':
          y = this.drawSlider(item, pad, y, W - pad * 2, paint);
          break;
        case 'row':
          y = this.drawRow(item, pad, y, W - pad * 2, paint);
          break;
        case 'bignum': {
          const size = Math.round(W * 0.30);
          ctx.font = `${size}px Georgia, 'Times New Roman', serif`;
          if (paint) {
            ctx.fillStyle = BONE;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(200,51,15,0.35)';
            ctx.shadowBlur = size * 0.22;
            ctx.fillText(item.value, W / 2, y);
            ctx.shadowBlur = 0;
            const cap = Math.round(W * 0.045);
            note(cap);
            ctx.font = `${cap}px Georgia, 'Times New Roman', serif`;
            ctx.fillStyle = ASH;
            ctx.fillText(item.caption, W / 2, y + size * 1.04);
            ctx.textAlign = 'left';
          }
          y += size * 1.04 + Math.round(W * 0.045) * 1.8;
          break;
        }
      }
    }
    return y;
  }

  /**
   * A slider you aim at rather than grab.
   *
   * The knob is drawn large relative to the track on purpose: a controller ray at
   * 1.5m has roughly a centimetre of jitter at the panel from hand tremor alone,
   * so a thin knob is a target you fight. The whole row is the hit region and
   * pressing anywhere on it jumps the value there, which means a shaky hand still
   * lands the value it was pointing at instead of missing the control entirely.
   */
  private drawSlider(item: Extract<PanelItem, { kind: 'slider' }>, x: number, y: number, w: number, paint: boolean) {
    const { ctx } = this;
    const W = this.canvas.width;
    const labelSize = Math.round(W * 0.038);
    if (paint) this.minGlyph = Math.min(this.minGlyph, labelSize);
    const rowH = Math.round(W * 0.105);

    if (!paint) return y + rowH + Math.round(W * 0.022);
    this.hits.push({ id: item.id, x, y, w, h: rowH, slider: true });

    const isHover = this.hovered === item.id;
    ctx.font = `${labelSize}px Georgia, 'Times New Roman', serif`;
    ctx.fillStyle = isHover ? BONE : ASH;
    ctx.textBaseline = 'top';
    ctx.fillText(item.label, x, y);

    const v = Math.max(0, Math.min(1, item.value));
    ctx.textAlign = 'right';
    ctx.fillStyle = ASH;
    ctx.fillText(`${Math.round(v * 100)}%`, x + w, y);
    ctx.textAlign = 'left';

    const trackY = y + rowH * 0.68;
    const trackH = Math.max(2, Math.round(W * 0.006));
    ctx.fillStyle = 'rgba(109,99,90,0.35)';
    ctx.fillRect(x, trackY, w, trackH);
    ctx.fillStyle = isHover ? EMBER : EMBER_DIM;
    ctx.fillRect(x, trackY, w * v, trackH);

    const knobR = Math.round(W * 0.017);
    ctx.beginPath();
    ctx.arc(x + w * v, trackY + trackH / 2, knobR, 0, Math.PI * 2);
    ctx.fillStyle = isHover ? BONE : '#b6ab9c';
    ctx.fill();
    if (isHover) {
      ctx.strokeStyle = EMBER;
      ctx.lineWidth = Math.max(1, Math.round(W * 0.003));
      ctx.stroke();
    }

    return y + rowH + Math.round(W * 0.022);
  }

  private drawRow(item: Extract<PanelItem, { kind: 'row' }>, x: number, y: number, w: number, paint: boolean) {
    const W = this.canvas.width;
    const size = Math.round(W * (item.head ? 0.034 : 0.036));
    if (paint) this.minGlyph = Math.min(this.minGlyph, size);
    const rowH = Math.round(size * 1.75);
    if (!paint) return y + rowH;

    const { ctx } = this;
    if (item.you) {
      ctx.fillStyle = 'rgba(200,51,15,0.10)';
      ctx.fillRect(x - W * 0.02, y, w + W * 0.04, rowH);
    }
    ctx.font = `${size}px Georgia, 'Times New Roman', serif`;
    ctx.fillStyle = item.head ? ASH : item.you ? BONE : '#b6ab9c';
    ctx.textBaseline = 'middle';
    let cx = x;
    for (let i = 0; i < item.cells.length; i++) {
      const cw = w * (item.weights[i] ?? 1 / item.cells.length);
      // Numbers right-aligned, names left: a ragged right edge on a score column
      // is the fastest way to make a leaderboard look untrustworthy.
      const numeric = i > 1;
      ctx.textAlign = numeric ? 'right' : 'left';
      // Truncate to the column. Memphis names are user-chosen and unbounded, and
      // an over-long one does not clip at the panel edge — it walks straight into
      // the Deepest column, which no margin check can see.
      const text = this.ellipsize(item.cells[i], cw * 0.92);
      ctx.fillText(text, numeric ? cx + cw : cx, y + rowH / 2);
      cx += cw;
    }
    ctx.textAlign = 'left';
    return y + rowH;
  }

  /**
   * The panel ground: dark timber with a grain, an ember rim and a corner falloff.
   *
   * Deliberately procedural rather than a crop of `woodWall.png`. The wall texture
   * is graded at load for a surface being raked by a torch beam, and a menu is lit
   * by nothing at all — reusing it produced a panel that read as a lit object
   * floating in an unlit corridor, which is worse than one that reads as a card.
   */
  private drawPlank(ctx: CanvasRenderingContext2D, W: number, H: number) {
    ctx.clearRect(0, 0, W, H);
    if (this.style === 'bare') return;

    /**
     * These values were set by looking at a render, not by reasoning about them,
     * and the first pass got all three wrong in the same direction — too dark.
     *
     * The base was #140c08 with a 0.85 corner falloff over it, which crushed the
     * courses and the grain to nothing: the panel rendered as flat black with a
     * red outline and every one of the twelve passing assertions was blind to it,
     * because none of them look at the background. The rim was worse — 0.75 alpha
     * ember at 6% of the panel width read as a glowing red rectangle, the single
     * loudest element on screen, which is the visual language of an error dialog
     * and not of this game.
     */
    ctx.fillStyle = '#241812';
    ctx.fillRect(0, 0, W, H);

    // Plank courses running the long axis.
    const rnd = mulberry32(0x5eed);
    const courses = 7;
    for (let i = 0; i < courses; i++) {
      const y0 = (i / courses) * H;
      const h = H / courses;
      const shade = 0.78 + rnd() * 0.5;
      ctx.fillStyle = `rgb(${Math.round(38 * shade)},${Math.round(25 * shade)},${Math.round(18 * shade)})`;
      ctx.fillRect(0, y0, W, h);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, y0 + h - Math.max(1, H * 0.0018), W, Math.max(1, H * 0.0018));
    }

    // Grain: short horizontal scratches, seeded so the texture is reproducible.
    ctx.globalAlpha = 0.14;
    for (let i = 0; i < 1400; i++) {
      const x = rnd() * W, y = rnd() * H, len = rnd() * W * 0.11;
      ctx.strokeStyle = rnd() > 0.5 ? '#000' : '#8a6f4e';
      ctx.lineWidth = Math.max(1, H * 0.0012);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y + (rnd() - 0.5) * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Corner falloff, so the card sits in the dark instead of on top of it. Gentle:
    // its job is to soften the edge, not to erase the surface it is drawn over.
    const vig = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.34, W / 2, H / 2, Math.max(W, H) * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);

    // Edge: a dark cut first so the card separates from the corridor behind it,
    // then a hairline of ember well under the text in prominence.
    const dark = Math.max(2, Math.round(W * 0.009));
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = dark;
    ctx.strokeRect(dark / 2, dark / 2, W - dark, H - dark);

    const rim = Math.max(1, Math.round(W * 0.0016));
    ctx.strokeStyle = 'rgba(160,54,20,0.34)';
    ctx.lineWidth = rim;
    ctx.strokeRect(dark + rim, dark + rim, W - (dark + rim) * 2, H - (dark + rim) * 2);
  }

  private drawButton(item: Extract<PanelItem, { kind: 'button' }>, x: number, y: number, w: number, paint: boolean) {
    const { ctx } = this;
    const h = Math.round(this.canvas.width * 0.105);
    const isHover = this.hovered === item.id;
    const isPressed = this.pressed === item.id;

    if (!paint) return y + h + Math.round(this.canvas.width * 0.028);
    this.hits.push({ id: item.id, x, y, w, h });

    ctx.fillStyle = isPressed ? '#241109' : isHover ? '#22140d' : '#180e09';
    ctx.fillRect(x, y, w, h);

    // The hover tell is the rim and the ember wash, not a colour swap: at a metre
    // and a half a fill change is ambiguous, an edge is not.
    ctx.strokeStyle = isHover || isPressed ? EMBER : 'rgba(109,99,90,0.5)';
    ctx.lineWidth = Math.max(1, Math.round(w * 0.004)) * (isHover ? 2 : 1);
    ctx.strokeRect(x, y, w, h);

    if (isHover || isPressed) {
      const wash = ctx.createLinearGradient(x, y, x, y + h);
      wash.addColorStop(0, 'rgba(200,51,15,0.16)');
      wash.addColorStop(1, 'rgba(200,51,15,0.02)');
      ctx.fillStyle = wash;
      ctx.fillRect(x, y, w, h);
    }

    const size = Math.round(this.canvas.width * 0.042);
    this.minGlyph = Math.min(this.minGlyph, size);
    ctx.font = `${size}px Georgia, 'Times New Roman', serif`;
    ctx.fillStyle = item.primary ? BONE : isHover ? BONE : '#b6ab9c';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(item.label, x + w / 2, y + h / 2 + size * 0.04);
    ctx.textAlign = 'left';

    if (item.primary) {
      ctx.fillStyle = EMBER_DIM;
      ctx.fillRect(x, y + h - Math.max(2, h * 0.035), w, Math.max(2, h * 0.035));
    }

    return y + h + Math.round(this.canvas.width * 0.028);
  }

  /** Trim to fit `maxW`, appending an ellipsis. Assumes the font is already set. */
  private ellipsize(text: string, maxW: number) {
    if (this.ctx.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return `${text.slice(0, lo)}…`;
  }

  private wrapText(text: string, x: number, y: number, maxW: number, lineH: number, paint: boolean) {
    const words = text.split(/\s+/);
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (this.ctx.measureText(test).width > maxW && line) {
        if (paint) this.ctx.fillText(line, x, y);
        y += lineH;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      if (paint) this.ctx.fillText(line, x, y);
      y += lineH;
    }
    return y;
  }
}

/**
 * The panel layer: owns the UI scene, the pointer ray and its laser.
 *
 * `update()` is split from `press()`/`release()` on purpose. A controller reports
 * pose and button state on different cadences, and folding them together is how
 * you end up selecting whatever the ray happened to cross on the frame the
 * trigger was polled rather than what the player was pointing at when they pulled
 * it. Press latches the target; release only fires if the ray is still on it.
 */
export class UILayer {
  readonly scene = new THREE.Scene();
  readonly panels: Panel[] = [];
  onSelect: ((id: string) => void) | null = null;

  /** Fires while a slider is being aimed at with the trigger held. Value is 0..1. */
  onSlide: ((id: string, value: number) => void) | null = null;

  private raycaster = new THREE.Raycaster();
  private hoverU = 0;
  private hoverIsSlider = false;
  private dragging: string | null = null;
  private laser: THREE.Line;
  private reticle: THREE.Mesh;
  private hoverId: string | null = null;
  private hoverPanel: Panel | null = null;
  private latched: string | null = null;
  private rayActive = false;

  constructor() {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1),
    ]);
    this.laser = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xc8330f, transparent: true, opacity: 0.55, fog: false, toneMapped: false }),
    );
    this.laser.visible = false;
    this.laser.renderOrder = 11;
    this.scene.add(this.laser);

    this.reticle = new THREE.Mesh(
      new THREE.CircleGeometry(0.006, 20),
      new THREE.MeshBasicMaterial({ color: 0xd9cfc2, transparent: true, opacity: 0.9, fog: false, toneMapped: false }),
    );
    this.reticle.visible = false;
    this.reticle.renderOrder = 12;
    this.scene.add(this.reticle);
  }

  add(panel: Panel) {
    this.panels.push(panel);
    this.scene.add(panel.mesh);
    return panel;
  }

  clear() {
    for (const p of this.panels) {
      this.scene.remove(p.mesh);
      p.dispose();
    }
    this.panels.length = 0;
    this.hoverId = null;
    this.hoverPanel = null;
  }

  get hovered() { return this.hoverId; }

  /** Point the ray. Controller pose in VR, `rayFromMouse` on a flat screen. */
  setRay(origin: THREE.Vector3, direction: THREE.Vector3) {
    this.raycaster.set(origin, direction.clone().normalize());
    this.rayActive = true;
  }

  rayFromMouse(ndcX: number, ndcY: number, camera: THREE.Camera) {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    this.rayActive = true;
  }

  clearRay() {
    this.rayActive = false;
    this.laser.visible = false;
    this.reticle.visible = false;
    this.setHover(null, null);
  }

  update() {
    if (!this.rayActive) return;
    const hits = this.raycaster.intersectObjects(this.panels.map((p) => p.mesh), false);
    const hit = hits[0];

    if (!hit || !hit.uv) {
      this.setHover(null, null);
      this.drawRay(null);
      return;
    }
    const panel = this.panels.find((p) => p.mesh === hit.object) ?? null;
    const info = panel ? panel.hitInfo(hit.uv) : null;
    this.hoverU = info?.u ?? 0;
    this.hoverIsSlider = !!info?.slider;
    this.setHover(panel, info?.id ?? null);
    this.drawRay(hit.point);

    // A slider being dragged keeps receiving the ray's x even as it wanders off
    // the row vertically — let go of that and the value snaps back the instant a
    // shaking hand drifts a few millimetres above the track.
    if (this.dragging && info) this.onSlide?.(this.dragging, info.u);
  }

  press() {
    this.latched = this.hoverId;
    this.hoverPanel?.setPressed(this.latched);
    if (this.hoverId && this.hoverIsSlider) {
      this.dragging = this.hoverId;
      this.onSlide?.(this.hoverId, this.hoverU);
    }
  }

  /**
   * Fire only if the ray is still on the control that was pressed. Sliding off a
   * button before releasing cancels it, which is what every pointer UI does and
   * what a shaking hand at the end of a chase sequence needs.
   */
  release() {
    const id = this.latched;
    const wasDragging = this.dragging;
    this.latched = null;
    this.dragging = null;
    for (const p of this.panels) p.setPressed(null);
    // A slider does not "select" on release — it already committed its value on
    // press and on every drag frame. Firing onSelect here too would make releasing
    // the trigger over a volume slider read as clicking a button.
    if (wasDragging) return;
    if (id && id === this.hoverId) this.onSelect?.(id);
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    // Clear depth only: the graded frame underneath is the background, but panels
    // must depth-sort against each other rather than against the maze.
    renderer.clearDepth();
    renderer.render(this.scene, camera);
    renderer.autoClear = prevAutoClear;
  }

  private setHover(panel: Panel | null, id: string | null) {
    if (this.hoverPanel && this.hoverPanel !== panel) this.hoverPanel.setHover(null);
    this.hoverPanel = panel;
    this.hoverId = id;
    panel?.setHover(id);
  }

  private drawRay(point: THREE.Vector3 | null) {
    const origin = this.raycaster.ray.origin;
    if (!point) {
      const far = origin.clone().addScaledVector(this.raycaster.ray.direction, 3);
      this.laser.geometry.setFromPoints([origin, far]);
      this.laser.visible = true;
      this.reticle.visible = false;
      return;
    }
    this.laser.geometry.setFromPoints([origin, point]);
    this.laser.visible = true;
    this.reticle.position.copy(point).addScaledVector(this.raycaster.ray.direction, -0.004);
    this.reticle.lookAt(origin);
    this.reticle.visible = true;
  }
}
