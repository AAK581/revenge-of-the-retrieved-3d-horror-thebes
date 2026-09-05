/**
 * Turns a Maze into geometry, materials and sky.
 *
 * Two things matter for the look. First, every wall segment is merged into a small
 * number of draw calls — a 21x21 maze is ~900 wall quads and one mesh per quad
 * would bury the frame budget before a single light is added. Second, the UVs are
 * generated in world space, so the wood grain runs continuously along a corridor
 * instead of restarting at every cell boundary and announcing the grid.
 */

import * as THREE from 'three';
import type { Maze } from './maze';
import { CFG } from './config';

/**
 * Derives a normal map from the albedo's luminance. Sobel, done once at load.
 *
 * ---- ⛔ THE "BLUR THE SOURCE DERIVATIVE" FIX WAS TRIED AND IT IS WRONG ------
 *
 * Three separate documents in this repo — the wave-5 gate note, the standing
 * comment that used to sit here, and an independent critic's report — all named
 * the same next step: the Sobel gradients are PER-TEXEL, so at roughly one
 * texel per pixel the derived normal stops being relief and becomes sparkle;
 * therefore blur or mip the source before differencing, then re-raise
 * `normalScale` and re-derive `strength`.
 *
 * That was implemented in full (separable Gaussian pre-blur + a central
 * difference widened to the same radius, amplitude-normalised so `strength` and
 * every consumer's `normalScale` kept their meaning) and **measured worse**. It
 * has been reverted. The reasoning that motivated it is sound and the arithmetic
 * behind it is correct; the conclusion simply does not survive measurement, so
 * it is recorded here rather than left for a fourth lane to re-derive.
 *
 * The arithmetic, which is worth keeping because it is right. `woodWall.png` is
 * 1024^2 and the walls' world-space UVs use `SCALE = 0.85`, so one texel is
 * 1.15 mm of wall. At 1280x720 and a 74 deg vertical FOV one output PIXEL spans:
 *
 *     d = 1 m ... 1.8 texels     d = 4 m ...  7.3
 *     d = 2 m ... 3.6 texels     d = 6 m ... 10.9
 *                                d = 8 m ... 14.6
 *
 * So a pixel really does integrate 3.6-14.6 texels across the 2-8 m band, and
 * the 1-texel Sobel really is describing relief finer than that. The inference
 * that widening the operator must therefore help is the part that fails.
 *
 * **What the measurement says** (`tools/wg-fpsweep.mjs`, which rebuilds the map
 * at each footprint IN ONE PAGE LOAD and shoots 8 identical wall-facing cameras,
 * so it is immune to the seed noise that invalidates rebuild-to-rebuild tables —
 * trap 29b). Map amplitude is held constant across the row, mean tilt
 * 10.25-11.15 deg, so this is a pure spatial-frequency comparison:
 *
 *     footprint    mid      hi   coarse   mid/hi     (Amnesia 10.81/4.14/-/2.83)
 *          1     16.13   11.03    20.62     1.46   <- BEST hi, BEST mid/hi
 *          3     16.78   14.63    20.52     1.15
 *          6     18.22   16.23    20.36     1.12
 *         10     19.99   14.79    20.39     1.35
 *         14     21.37   13.19    20.55     1.62
 *
 * `hi` is LOWEST at the narrowest operator and gets worse as it widens; `mid`
 * climbs monotonically toward the wallpaper failure. And a paired A/B of the
 * shipped Sobel against the footprint-3 version (`tools/wg-normal-ab.mjs`, same
 * maze, same 14 cameras, Billy hidden) put `hi` HIGHER with the blurred map in
 * **14 of 14 poses** — 12.15 -> 14.66, `mid/hi` 1.33 -> 1.13.
 *
 * **Why, physically.** Holding relief energy constant while widening the
 * operator does not remove the energy, it REDISTRIBUTES it into fewer, larger
 * gradient features with steeper local slopes. A moving beam raking those
 * produces bigger per-pixel shading swings than the same energy spread thinly
 * across many small ones. The per-texel Sobel's saving grace is that its
 * features are individually tiny; mip and aniso filtering then average them
 * toward flat, which costs relief but is quiet. Widening the derivation defeats
 * that averaging and hands the filter structure it cannot smooth away.
 *
 * The corollary for whoever looks next: **the remaining `hi` excess is not
 * fixable from inside this function.** It is a property of lighting a
 * high-contrast albedo-derived normal with a point-ish light at the eye. The
 * levers that did move it are `normalScale` (swept and set at the wave-5 gate;
 * it has an INTERIOR optimum, trap 40) and material roughness. Do not spend
 * another lane re-deriving the blur.
 *
 * `strength` (2.4) stacks multiplicatively with every consumer's `normalScale`,
 * so the two may never be tuned independently.
 */
function normalFromAlbedo(image: HTMLImageElement | ImageBitmap, strength = 2.4): THREE.Texture {
  const w = (image as any).width, h = (image as any).height;
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const sctx = src.getContext('2d')!;
  sctx.drawImage(image as any, 0, 0);
  const data = sctx.getImageData(0, 0, w, h).data;

  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
  }

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(w, h);
  const L = (x: number, y: number) => lum[((y + h) % h) * w + ((x + w) % w)];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        L(x - 1, y - 1) + 2 * L(x - 1, y) + L(x - 1, y + 1) -
        L(x + 1, y - 1) - 2 * L(x + 1, y) - L(x + 1, y + 1);
      const gy =
        L(x - 1, y - 1) + 2 * L(x, y - 1) + L(x + 1, y - 1) -
        L(x - 1, y + 1) - 2 * L(x, y + 1) - L(x + 1, y + 1);
      const nx = -gx * strength, ny = -gy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * w + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(out);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  /**
   * ---- ANISOTROPY, and why a missing line here was measurable ---------------
   *
   * The albedo gets `anisotropy = 8` where it is loaded; these DERIVED maps got
   * nothing, so they filtered at anisotropy 1 while sitting on the same
   * surfaces, at the same world-space UV scale, seen at the same grazing angles.
   *
   * A normal map is the worst possible texture to under-filter. Minifying it
   * averages VECTORS, so a normal map sampled below its Nyquist limit does not
   * merely blur — it returns a direction that no part of the surface actually
   * has, and it returns a different wrong direction each frame as the camera
   * moves. On a wall seen down a corridor, where the UV compression along the
   * run is severe, that is per-pixel shading noise.
   *
   * It is measurable and it is the specific defect. Lag-1 autocorrelation of
   * the 1-3 px band inside lit pixels, ours against the reference:
   *
   *     AMNESIA st2 ...... lag1-x +0.108   lag1-y +0.631
   *     AMNESIA st5 ...... lag1-x +0.199   lag1-y +0.358
   *     ours p00 ......... lag1-x +0.230   lag1-y -0.118
   *     ours p06 ......... lag1-x +0.031   lag1-y -0.064
   *
   * Amnesia's fine band is strongly POSITIVELY correlated vertically: smooth,
   * properly resolved detail. Ours was NEGATIVE — adjacent scanlines
   * anti-correlated, which is the signature of pixel-to-pixel alternation, i.e.
   * aliasing, not detail. That is most of why our `hi` band measured 25.3
   * against the reference's 4.1 while looking flat.
   */
  tex.anisotropy = 8;
  return tex;
}

/** Inverted, contrast-stretched luminance makes a serviceable roughness map. */
function roughnessFromAlbedo(image: HTMLImageElement | ImageBitmap): THREE.Texture {
  const w = (image as any).width, h = (image as any).height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(image as any, 0, 0);
  const d = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < d.data.length; i += 4) {
    const l = (d.data[i] * 0.299 + d.data[i + 1] * 0.587 + d.data[i + 2] * 0.114) / 255;
    // Dark grain in the wood = the rougher, more light-eating parts.
    //
    // WIDENED from 0.55..1.00 to 0.30..0.92, and the width is the point rather
    // than the level. `roughness` multiplies this map, so a map spanning only
    // 0.45 of the range could never make one part of a plank glance the beam
    // while the part beside it stayed matte — the whole surface sat in the same
    // reflectance regime and the grain had nothing to modulate. A 0.62-wide
    // range lets the hard summer-growth rings go semi-glossy and the soft
    // spring wood stay dead, which is what makes a raking torch pick out grain.
    //
    // ---- A NEGATIVE RESULT, RECORDED SO IT IS NOT RE-SPENT ----------------
    //
    // The obvious reading of the noise profile is that this map is the cause,
    // and it is not. Per-brightness-band 1-3 px noise on a nose-to-wall frame:
    //
    //     lum band    px      hi     mid
    //      25-60    38031   16.46   12.31
    //      60-120   25888   21.15   17.49
    //     120-200   22164   27.11   21.48
    //     200-255    5881   33.27   18.15
    //
    // Noise rises monotonically with brightness, which looks exactly like the
    // beam's hot core resolving this map's per-texel scatter into speckle
    // through a narrow specular lobe. So the floor was raised 0.30 -> 0.52
    // (effective range on the wall 0.19..0.57 -> 0.32..0.57) and measured
    // properly, with `tools/bc-rough-ab.mjs`: 12 wall-facing poses, both
    // variants shot from an IDENTICAL camera in an IDENTICAL maze in ONE page
    // load, monster and dust frozen, beam pinned.
    //
    //     floor 0.30:  mid 16.81   hi 21.27   coarse 20.75   mid/hi 0.77
    //     floor 0.52:  mid 16.89   hi 21.53   coarse 20.90   mid/hi 0.77
    //     paired delta hi: mean -0.01, lower in 5 of 12 — a coin flip.
    //
    // The toggle repainted ~600,000 pixels per pair, so it is emphatically not
    // a no-op (PROGRESS.md trap 16); the term is simply inert for the noise
    // band. Left at the original 0.30..0.92, whose width argument above stands.
    const r = Math.min(1, Math.max(0, 0.30 + (1 - l) * 0.62)) * 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = r;
  }
  ctx.putImageData(d, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Same reason as the normal map's; see the note in `normalFromAlbedo`. This
  // one modulates the specular lobe, so under-filtering it makes the width of
  // the highlight flicker per pixel rather than the direction of the normal.
  tex.anisotropy = 8;
  return tex;
}

/**
 * Drains saturation out of the wall albedo and stretches its contrast, once at
 * load, into a new texture. The result is still woodWall.png — same grain, same
 * planks, same stains — with the orange pulled out and the tonal range opened up.
 *
 * WHY THIS EXISTS. Two separate measurements both landed here.
 *
 * Colour: real Amnesia frames measure mean HSV saturation 0.068. This build
 * measured 0.59-0.83. Chasing it in the colour grade failed, and failed in an
 * instructive way — pushing the grade's desaturation to 0.99 only reached 0.53,
 * because the pixels that carry the saturation are the ones inside the beam, and
 * those are exactly the pixels the "keep the warmth in the lamplight" protection
 * is there to spare. Draining them anyway would delete the one warm thing in the
 * frame. Desaturating the fill lights was tried next and moved the number by
 * 0.01, which located the source: woodWall.png itself measures mean saturation
 * 0.695. It is an orange texture, and no downstream stage can un-orange it
 * without also un-orange-ing the torch.
 *
 * Contrast: the same texture is very low contrast — its planks differ from each
 * other by only a few percent — which is the other half of why a lit wall
 * measured flat. Stretching around the mean gives the plank-to-plank variation
 * something to be, and it costs nothing at runtime.
 *
 * The texture is still the one the brief names. This is a grade on it, done at
 * load in a canvas, not a substitution.
 */
function gradeAlbedo(
  image: HTMLImageElement | ImageBitmap,
  saturation: number,
  contrast: number,
): THREE.Texture {
  const w = (image as any).width, h = (image as any).height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(image as any, 0, 0);
  const d = ctx.getImageData(0, 0, w, h);
  const px = d.data;

  // Contrast pivots on the image's own mean rather than on 128, so a dark texture
  // is not dragged toward mid-grey and a bright one is not crushed.
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    sum += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  }
  const pivot = sum / (px.length / 4);

  for (let i = 0; i < px.length; i += 4) {
    const l = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    const lc = (l - pivot) * contrast + pivot;
    // Scale each channel by the contrast change rather than adding a constant, so
    // the hue that survives `saturation` is not skewed by the contrast stretch.
    const k = l > 1 ? lc / l : 1;
    for (let ch = 0; ch < 3; ch++) {
      const v = px[i + ch] * k;
      px[i + ch] = Math.max(0, Math.min(255, lc + (v - lc) * saturation));
    }
  }
  ctx.putImageData(d, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The sky: an inward-facing dome of roiling red cloud.
 *
 * The previous version was a two-colour gradient with a little noise on it, and it
 * read exactly like what it was — a red gradient. A sky reads as *weather* when it
 * has structure at more than one scale, when the structure moves at more than one
 * speed, and when something in it is brighter than the rest so the eye has a place
 * to land. This version stacks four octaves of domain-warped FBM, drifts each
 * octave at its own rate, and hides a dim sourceless glow behind the cloud so the
 * mass is backlit and you can see it churn.
 */
function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(400, 40, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    // Drawn first (renderOrder below) with depth entirely out of the picture: it
    // neither tests nor writes, so it behaves as a background fill and every
    // subsequent opaque draw simply covers it.
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(CFG.render.skyTop) },
      horizonColor: { value: new THREE.Color(CFG.render.skyHorizon) },
      uTime: { value: 0 },
      uRadiance: { value: CFG.render.skyRadiance },
      uFogColor: { value: new THREE.Color(CFG.render.fogSkyColor) },
      uHaze: { value: CFG.render.skyHaze },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform float uTime;
      uniform float uRadiance;
      uniform vec3 uFogColor;
      uniform float uHaze;
      varying vec3 vWorld;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
      }

      // Four octaves. Each is offset in time at its own rate and direction, which
      // is what makes the mass shear against itself instead of sliding rigidly.
      float fbm(vec2 p, float t) {
        float v = 0.0, a = 0.5;
        v += a * noise(p + vec2(t * 0.010, t * 0.006));  p *= 2.03; a *= 0.5;
        v += a * noise(p - vec2(t * 0.017, t * 0.004));  p *= 2.01; a *= 0.5;
        v += a * noise(p + vec2(t * 0.029, -t * 0.021)); p *= 2.07; a *= 0.5;
        v += a * noise(p - vec2(t * 0.044, t * 0.038));
        return v;
      }

      void main() {
        vec3 dir = normalize(vWorld);

        // Project onto a plane above the player rather than using dir.xz directly.
        // Straight dir.xz pinches every cloud into a rosette at the zenith, which
        // is the tell-tale "this is a sphere with a texture on it" artifact.
        float y = max(abs(dir.y), 0.06);
        vec2 sp = dir.xz / y * 0.55;

        float t = clamp(dir.y * 1.25 + 0.12, 0.0, 1.0);
        vec3 col = mix(horizonColor, topColor, pow(t, 0.8));

        // Domain warp: run FBM once, use it to displace the lookup for the second
        // pass. This is what turns smooth blobs into torn, curdled cloud edges.
        vec2 warp = vec2(fbm(sp * 1.7, uTime), fbm(sp * 1.7 + 5.2, uTime * 0.8));
        float n = fbm(sp * 2.4 + warp * 1.6, uTime);

        // Push contrast so there are actual dark clots and bright rifts, not haze.
        n = clamp((n - 0.34) * 2.1 + 0.42, 0.0, 1.0);

        // Dark cloud mass multiplied over the gradient.
        col *= 0.42 + 0.95 * n;

        // A sourceless glow low in the sky, as though something enormous is burning
        // just past the walls. It gives the dome a direction and a focal point.
        float glow = pow(max(0.0, 1.0 - abs(dir.y - 0.06) * 2.4), 3.0);
        col += horizonColor * glow * 0.55 * (0.5 + 0.9 * n);

        // Backlight: the thin parts of the cloud transmit, the thick parts do not.
        col += vec3(0.30, 0.045, 0.02) * pow(n, 3.5) * 1.5;

        // Bleed red into the very bottom so the horizon never resolves to a line.
        col += horizonColor * pow(1.0 - t, 4.0) * 0.55;

        // Haze the dome toward the murk colour, hardest near the horizon.
        //
        // The sky opts out of three's fog (a dome at a fixed 400m would just be
        // multiplied by one constant, which is pointless), but it still has to
        // look like it is being seen through the same air as everything else. Once
        // the sky was exempted from the colour grade's desaturation it went the
        // other way and read as a flat vermilion card pasted behind the maze —
        // saturated, yes, but with no atmosphere between it and the eye. Mixing
        // toward the fog colour by view elevation is what puts the air back: the
        // zenith stays clear and deep, and the parts of the sky nearest the top of
        // the walls go soft and dusty, which is where the two have to meet.
        col = mix(col, uFogColor * uRadiance * 0.55, uHaze * pow(1.0 - t, 1.6));

        // Lift the whole dome into HDR. Everything above is authored in the 0..1
        // range the hex colours arrive in, which after three's sRGB->linear
        // conversion puts the brightest part of the sky at about 0.15 LINEAR —
        // dark enough that the post chain's bright-pass never sees it and never
        // blooms it, and dark enough that the colour grade treats it as another
        // dim red surface and drains it to salmon along with the corridor walls.
        //
        // Physically this is backwards: the sky is the single largest light
        // source in the level, and the hemisphere light in game.ts is already
        // being driven at 11 candela on the strength of it. Scaling the dome's
        // own radiance to match means the bright-pass finds it, the desaturation
        // gate spares it, and the ACES shoulder in the grade shapes its highlights
        // into cloud instead of leaving it as flat mid-grey.
        // ALPHA IS A CHANNEL, NOT A COVERAGE VALUE, in this render target.
        //
        // The dome writes alpha 0; every other material in the scene is opaque and
        // writes 1. Nothing blends against it — the sky is drawn first with depth
        // testing and depth writing both off, and every wall simply overwrites it —
        // so the alpha byte is free, and it carries the one piece of information
        // the post chain cannot otherwise recover: which pixels are sky.
        //
        // post.ts needs that because the colour grade drains saturation out of the
        // world so that the beam and the sky are the only coloured things left.
        // Without a sky mask the grade drains the sky too, and the roiling red
        // purgatory — the strongest single thing in this build — comes out as flat
        // pink. Every other way of identifying sky in a post pass is a guess: a
        // depth test needs a depth texture bound as a sampler, and a brightness
        // threshold cannot tell a bright cloud from a lit wall.
        gl_FragColor = vec4(col * uRadiance, 0.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  // The dome must be drawn FIRST and must never write depth, so every wall
  // rasterised afterwards passes the depth test against it and paints over it.
  // Without the explicit renderOrder three sorts it by distance, and because the
  // dome is 400m away it lands last — at which point `depthWrite: false` stops
  // protecting the walls and the sky punches straight through the maze. That is
  // exactly what happened the first time this ran through the composer, where the
  // fresh render target changed the effective draw order.
  mesh.renderOrder = -1000;
  return mesh;
}

/**
 * Dust motes carried with the player.
 *
 * The brief asks for light shafts and volume in the darkness. True volumetrics are
 * out of budget on a software rasterizer, but the *reason* shafts read as volume is
 * that they give the empty air between you and the wall something that scatters
 * light. A few hundred additive points do the same job for a rounding error: they
 * are invisible outside the beam and they sparkle inside it, so the cone acquires
 * a body. They are parented to a group the caller re-centres on the player, so the
 * illusion never runs out of dust and the point count stays constant.
 */
function buildDust(): {
  points: THREE.Points;
  step: (dt: number, elapsed: number) => void;
  /** Feeds the live flashlight cone to the mote shader. Call before render. */
  setCone: (pos: THREE.Vector3, dir: THREE.Vector3) => void;
} {
  const d = CFG.render.dust;
  const n = d.count;
  const pos = new Float32Array(n * 3);
  // Per-mote phase and speed so they do not pulse in unison.
  const phase = new Float32Array(n);
  const speed = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    pos[i * 3 + 0] = (Math.random() * 2 - 1) * d.radius;
    // Biased low: dust settles, and low motes are the ones the beam actually hits.
    pos[i * 3 + 1] = Math.pow(Math.random(), 1.7) * CFG.maze.wallHeight * 0.85;
    pos[i * 3 + 2] = (Math.random() * 2 - 1) * d.radius;
    phase[i] = Math.random() * Math.PI * 2;
    speed[i] = 0.5 + Math.random();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // The mote cloud is re-centred every frame, so a bounding sphere computed once
  // would be wrong immediately. Disabling culling is both correct and cheaper.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), d.radius * 2);

  // A PointsMaterial was used here first and it could not do the job, for a
  // reason worth recording: it has no way to know where the flashlight is
  // pointing, so every mote in the 9m box glows at the same constant opacity.
  // The result reads as a fixed field of specks hanging in front of the camera —
  // dirt on the lens, not dust in the air — and it does nothing at all for the
  // beam, which stayed a flat oval decal on the wall with no body between the
  // torch and the surface.
  //
  // What makes a shaft read as a shaft is in-scattering: you see the air only
  // where the light is, and brightest when you are looking INTO the beam. Both
  // of those are cheap to evaluate per-vertex here, since a point sprite has
  // exactly one vertex, so this costs one dot product and a smoothstep per mote
  // per frame -- 320 of them -- and nothing per fragment.
  //
  // uConeDir/uConePos are written every frame by the caller from the real
  // SpotLight, so the motes track flicker and the chase follow-lag for free
  // rather than approximating them.
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uConePos: { value: new THREE.Vector3() },
      uConeDir: { value: new THREE.Vector3(0, 0, -1) },
      /** cos of the spot's outer angle; motes outside it get nothing. */
      uCosOuter: { value: Math.cos(CFG.flashlight.angle) },
      /** Beam length in metres, for the same inverse-square falloff the spot uses. */
      uRange: { value: CFG.flashlight.distance },
      uSize: { value: d.size },
      uOpacity: { value: d.opacity },
      uColor: { value: new THREE.Color(0xffe2bc) },
    },
    vertexShader: /* glsl */ `
      uniform vec3  uConePos;
      uniform vec3  uConeDir;
      uniform float uCosOuter;
      uniform float uRange;
      uniform float uSize;
      uniform float uOpacity;
      varying float vGlow;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec4 mv = viewMatrix * world;

        vec3 toMote = world.xyz - uConePos;
        float dist = length(toMote);
        vec3 dir = dist > 1e-4 ? toMote / dist : uConeDir;

        // Inside the cone? Softened at the rim so motes fade in rather than
        // popping on as the beam sweeps past them.
        float cosA = dot(dir, uConeDir);
        float cone = smoothstep(uCosOuter, mix(uCosOuter, 1.0, 0.45), cosA);

        // Same inverse-square the SpotLight uses, so the motes dim with distance
        // at the same rate the lit wall behind them does.
        float atten = 1.0 / (1.0 + dist * dist * 0.55);
        atten *= smoothstep(uRange, uRange * 0.35, dist);

        // Forward-scattering: air glows hardest when you look up the beam. This
        // is the term that turns a field of specks into a shaft, because it
        // makes the density you see depend on your angle to the light.
        vec3 toEye = normalize(-mv.xyz);
        float fwd = 1.0 + 0.9 * pow(max(dot(normalize((viewMatrix * vec4(uConeDir, 0.0)).xyz), -toEye), 0.0), 3.0);

        vGlow = cone * atten * fwd * uOpacity;

        gl_Position = projectionMatrix * mv;
        // Size attenuation, matching PointsMaterial's convention.
        gl_PointSize = uSize * 300.0 / max(-mv.z, 0.001);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vGlow;
      void main() {
        // Round, soft-edged mote. A square point sprite at 4px reads as a pixel
        // artifact; the radial falloff is what makes it a speck of dust.
        vec2 c = gl_PointCoord - 0.5;
        float r = dot(c, c);
        if (r > 0.25) discard;
        float a = smoothstep(0.25, 0.0, r);
        gl_FragColor = vec4(uColor * vGlow * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Fog on additive points would ADD fog colour, brightening the far dark.
    fog: false,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 2;

  const attr = geo.attributes.position as THREE.BufferAttribute;
  const R = d.radius;

  return {
    points,
    setCone(pos: THREE.Vector3, dir: THREE.Vector3) {
      (mat.uniforms.uConePos.value as THREE.Vector3).copy(pos);
      (mat.uniforms.uConeDir.value as THREE.Vector3).copy(dir);
    },
    step(dt: number, elapsed: number) {
      const arr = attr.array as Float32Array;
      for (let i = 0; i < n; i++) {
        const iy = i * 3 + 1;
        // Slow convective rise plus a lateral wander. Motes that leave the box are
        // wrapped back in, so density stays flat and the count never grows.
        arr[iy] += d.drift * speed[i] * dt;
        arr[i * 3] += Math.sin(elapsed * 0.35 * speed[i] + phase[i]) * d.drift * 0.6 * dt;
        if (arr[iy] > CFG.maze.wallHeight) {
          arr[iy] = 0;
          arr[i * 3] = (Math.random() * 2 - 1) * R;
          arr[i * 3 + 2] = (Math.random() * 2 - 1) * R;
        }
      }
      attr.needsUpdate = true;
    },
  };
}

/**
 * One wall slab. `sx`/`sz` are the full extents; whichever of the two is the
 * larger tells you which way the wall runs, and the smaller one is its thickness.
 */
type WallBox = { cx: number; cz: number; sx: number; sz: number };

/**
 * Deterministic hash on a world-space coordinate pair. Returns [0,1).
 *
 * Every irregularity in `buildTrim` is driven from this rather than from
 * `Math.random`, and the distinction matters for more than reproducibility: a
 * member's jitter is a function of WHERE IT IS, so two collinear wall slabs meeting
 * at a cell boundary agree about the post that straddles them, and the same maze
 * seed always builds the same carpentry. With Math.random the two halves of a
 * straddling post would jitter independently and split apart at the joint.
 */
function trimHash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Generates the corridor carpentry: a full timber frame on every wall, plus
 * overhead joists — all boxes, all merged into a single geometry, one draw call.
 *
 * Why this exists is documented at `CFG.maze.trim`: it is the fix for a measured
 * ~4x deficit in mid-frequency structure inside LIT pixels against Amnesia, and
 * per-band measurement localises that deficit to the wall at EYE HEIGHT (ours 6.7
 * against Amnesia's 32.5 in the middle third of frame, while our floor already
 * manages 14.3). Everything below is aimed at that band.
 *
 * Three mechanisms do the work, and it is worth separating them because they are
 * not interchangeable:
 *
 *  1. RELIEF. Every member stands proud of the wall face, so its outward face
 *     takes the beam near head-on and goes bright while its top and bottom edges
 *     take it at a grazing angle and go dark. That is N·L, it is free, and it
 *     survives every beam angle. The depths here were raised specifically so the
 *     resulting shading step is wider than the metric's own box(3) kernel at the
 *     4-8 m the beam actually lands.
 *
 *  2. OCCLUSION. The posts and studs stand proud enough to get BETWEEN the
 *     head-mounted beam and the wall behind them at any oblique angle, so they
 *     lay real shadow bars across the plank. An occlusion edge is a step
 *     discontinuity, which is worth far more to a mid-frequency measure than any
 *     gradient — and it is the one thing a normal map fundamentally cannot fake.
 *
 *  3. IRREGULARITY. Sizes, offsets, plumb and presence are all jittered by
 *     `trimHash` of the member's own world position. Perfect repetition reads as
 *     wallpaper, and wallpaper has no scale.
 *
 * UVs are world-space projected exactly as the walls are, so the timber grain is
 * continuous with the plank behind it instead of restarting per band.
 */
/**
 * A volume the carpentry must not enter. Used for doorways: see the note on
 * `push()` below.
 */
export type KeepClear = { x: number; z: number; halfX: number; halfZ: number; maxY: number };

function buildTrim(
  boxes: WallBox[], maze: Maze, keepClear: KeepClear[] = [],
): { geometry: THREE.BufferGeometry } {
  const tr = CFG.maze.trim;
  const { wallHeight, cell } = CFG.maze;
  const parts: THREE.BufferGeometry[] = [];

  /** UV scale must match the walls' or the grain steps at every band edge. */
  const UV = 0.85;

  /**
   * `?nopiers=1` builds everything except the piers, so the largest members in
   * the maze can be A/B'd against their own absence.
   *
   * This exists because the previous lane's carpentry was trusted for three
   * rounds on an unpaired comparison and then measured, properly, at -0.08 —
   * i.e. it had been costing 50,000 triangles for nothing. Any member this
   * large has to be falsifiable the same way, and a rebuild-based comparison
   * cannot do it: the maze seed is `Date.now()` (PROGRESS.md trap 6b), so two
   * builds are two different mazes. Measured directly, the per-frame 1-3 px
   * noise at the same pose index across two consecutive runs correlates at
   * **-0.24** — the pose index carries no meaning across a rebuild at all.
   */
  const noPiers = new URLSearchParams(location.search).has('nopiers');

  /**
   * `rotZ`/`rotX` tilt the box about its own centre before it is placed. Used only
   * for the leaning posts and the diagonal braces; everything else passes 0 and
   * takes the identity path, which skips the rotation entirely.
   */
  /**
   * DOORWAYS GET NO CARPENTRY ACROSS THEM.
   *
   * Every trim member in the maze funnels through this one function, which is why
   * the exclusion lives here rather than in each of the dozen callers below.
   *
   * The bug it fixes: the exit door is set flush into a wall FACE, but the trim
   * plates and posts stand proud of that face INTO the corridor. So a timber
   * plate ran straight across the doorway, 0.11-0.21m in front of the door's void
   * panel, and opening the door revealed a lit beam and post instead of darkness.
   * The user read that as "the door still has a wall behind it", and they were
   * right that something was there — it just was not the wall. Named-mesh raycasts
   * through the open doorway (`__TESTHOOK_DOORWAY_RAYS`) put it beyond doubt:
   *
   *     at [ 0.35, 0.00]  trim@1.84 | doorVoid@1.95 | walls@1.97
   *     at [-0.35, 0.35]  trim@2.05 | doorVoid@2.26 | walls@2.29
   *
   * It is also simply what a builder would do: you do not run a plate across a
   * door. The test is against the member's own EXTENT, not its centre — a long
   * plate whose centre sits outside the opening still crosses it, and a
   * centre-only test let exactly those through.
   */
  const blocked = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) =>
    keepClear.some((k) =>
      cy - sy / 2 < k.maxY &&
      Math.abs(cx - k.x) < k.halfX + sx / 2 &&
      Math.abs(cz - k.z) < k.halfZ + sz / 2);

  const push = (
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    rot?: { axis: 'x' | 'z'; angle: number },
  ) => {
    if (blocked(cx, cy, cz, sx, sy, sz)) return;
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (rot && rot.angle !== 0) {
      if (rot.axis === 'z') g.rotateZ(rot.angle);
      else g.rotateX(rot.angle);
    }
    g.translate(cx, cy, cz);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    for (let v = 0; v < uv.count; v++) {
      const px = pos.getX(v), py = pos.getY(v), pz = pos.getZ(v);
      const ax = Math.abs(nor.getX(v)), ay = Math.abs(nor.getY(v)), az = Math.abs(nor.getZ(v));
      // Project down whichever axis the face points, so up-facing surfaces (the
      // top of a skirting board, the top of a joist) get floor-plan UVs rather
      // than the smeared single-texel streak an XY projection would give them.
      if (ay > ax && ay > az) uv.setXY(v, px * UV, pz * UV);
      else if (ax > az) uv.setXY(v, pz * UV, py * UV);
      else uv.setXY(v, px * UV, py * UV);
    }
    uv.needsUpdate = true;
    parts.push(g);
  };

  for (const b of boxes) {
    // Which way does this slab run? The long extent is the run; the short one is
    // the thickness, and the bands have to grow along the thickness axis so they
    // protrude from *both* faces (a wall is seen from both sides).
    const alongX = b.sx >= b.sz;
    const runLen = alongX ? b.sx : b.sz;
    const thick = alongX ? b.sz : b.sx;
    /** Position of this slab along its own run axis, and along the other one. */
    const axisMin = (alongX ? b.cx - b.sx / 2 : b.cz - b.sz / 2);
    const axisMax = (alongX ? b.cx + b.sx / 2 : b.cz + b.sz / 2);
    /** The slab's fixed cross-axis coordinate — constant across its whole face. */
    const cross = alongX ? b.cz : b.cx;

    /**
     * Places a box in slab-local terms: `a` along the run, `y` vertical, sizes
     * `la` along the run and `d` extra depth beyond the wall thickness on each
     * face. One helper for both wall orientations, so no member below has to
     * branch on `alongX` and get one of the two cases subtly wrong.
     */
    const put = (
      a: number, y: number, la: number, h: number, d: number,
      lean = 0,
    ) => {
      const grown = thick + d * 2;
      // A lean about the run axis would tip the member into or out of the wall,
      // which is invisible; leaning has to be about the axis perpendicular to
      // the run so the member goes out of plumb ALONG the corridor, where you
      // see it against its neighbours.
      const rot = lean !== 0
        ? ({ axis: alongX ? 'z' : 'x', angle: alongX ? lean : -lean } as const)
        : undefined;
      if (alongX) push(a, y, cross, la, h, grown, rot);
      else push(cross, y, a, grown, h, la, rot);
    };

    /**
     * A horizontal band wrapping the full run at height `y`, BROKEN into pieces.
     *
     * The break is the point. A single box spanning the whole run gives a
     * perfectly continuous line, and a perfectly continuous line at a constant
     * height is exactly what the eye files as "texture" rather than "timber".
     * Splitting the run into plank-length pieces with a hashed length, a hashed
     * height wobble, and a `breakChance` of simply not placing one, produces the
     * butt joints and the missing board that tell you this was assembled from
     * parts. Each piece is also individually jittered in depth, so the band's
     * outer face is not one flat plane and the beam finds a different step at
     * each joint.
     */
    const band = (y: number, h: number, d: number, seed: number, breakable: boolean) => {
      // Aim for pieces `boardLength` long, i.e. a board two people could carry,
      // but never fewer than one piece per slab.
      //
      // This is the trim's single biggest triangle line item — five bands on
      // every wall slab in the maze — so the number is in CFG rather than
      // inline. The butt joints it creates are also drawn by the trim shader's
      // end-grain term at `timberLength`, which costs nothing, so the geometry
      // here only has to carry the ones near enough to show real parallax.
      const n = Math.max(1, Math.round(runLen / tr.boardLength));
      const piece = runLen / n;
      for (let i = 0; i < n; i++) {
        const a0 = axisMin + i * piece;
        const hash = trimHash(a0 * 3.1 + seed, cross * 2.7 + seed);
        if (breakable && hash < tr.breakChance) continue;
        const hash2 = trimHash(a0 * 1.9 + seed * 5.0, cross * 4.3 - seed);
        // Shrink each piece slightly and by a varying amount, so consecutive
        // boards leave a visible butt joint of varying width between them.
        const shrink = piece * 0.02 * (0.4 + hash2);
        const la = piece - shrink;
        // Height and depth wobble. Both are ratios of the nominal, so a thin
        // rail wobbles less in absolute terms than a fat plinth — which is what
        // sawn timber does.
        const hh = h * (1 + (hash2 - 0.5) * tr.jitter);
        const dd = d * (1 + (hash - 0.5) * tr.jitter);
        // Vertical wobble, capped well under the member's own height so a band
        // never breaks into a visible staircase.
        const dy = (hash - 0.5) * h * 0.16;
        put(a0 + piece / 2, y + hh / 2 + dy, la, hh, dd);
      }
    };

    // ---- skirting: plinth + capping strip ---------------------------------
    // The floor/wall joint. It sits ON the floor, so its top edge is a hard
    // horizontal line exactly where the two planes meet — the cue that tells you
    // the floor is a floor and not more wall. Built as two members so the cap's
    // overhang throws a permanent self-shadow onto the plinth beneath it, which
    // is a line that survives beam angles a single box's silhouette would not.
    band(0, tr.skirtHeight, tr.skirtDepth, 11.0, false);
    band(tr.skirtHeight, tr.skirtCapHeight, tr.skirtCapDepth, 17.0, false);

    // Waist and head rails: the two the beam crosses while you walk normally.
    band(tr.waistY, tr.railHeight, tr.depth, 23.0, true);
    band(tr.headY, tr.railHeight, tr.depth, 29.0, true);

    // Wall plate: caps the top so the wall ends in a built edge against the sky.
    band(wallHeight - tr.capHeight, tr.capHeight, tr.capDepth, 37.0, false);

    // ---- studwork in the eye-height bay ------------------------------------
    //
    // THIS IS THE LANE'S PRIMARY FIX. The bay between the waist rail's top and
    // the head rail's bottom is 1.01 m of blank wall centred almost exactly on
    // the 1.68 m eye line, and per-band measurement puts our mid-frequency
    // detail there at 6.7 against Amnesia's 32.5. It is where the beam lives and
    // it was the only part of the wall with no geometry in it at all.
    //
    // Studs are placed on a WORLD-SPACE lattice for the same reason the posts
    // are: so studs in adjacent collinear slabs line up into one continuous run
    // down a corridor rather than restarting at every cell boundary.
    const bayLo = tr.waistY + tr.railHeight;
    const bayHi = tr.headY;
    const bayH = bayHi - bayLo;
    if (bayH > 0.25) {
      const sFirst = Math.ceil(axisMin / tr.studSpacing) * tr.studSpacing;
      for (let a = sFirst; a <= axisMax; a += tr.studSpacing) {
        // Clip to the slab so a stud never juts past the end of its own wall.
        const lo = Math.max(axisMin, a - tr.studWidth / 2);
        const hi = Math.min(axisMax, a + tr.studWidth / 2);
        const w = hi - lo;
        if (w < tr.studWidth * 0.45) continue;
        const hash = trimHash(a * 7.3, cross * 1.7 + 4.4);
        if (hash < tr.breakChance) continue;
        const dd = tr.studDepth * (1 + (hash - 0.5) * tr.jitter);
        // Studs are cut a touch short of the rails at random, so the frame has
        // visible shrinkage gaps rather than perfect mitres.
        const gap = bayH * 0.03 * hash;
        put((lo + hi) / 2, bayLo + gap + (bayH - gap) / 2, w, bayH - gap, dd);
      }

      // ---- diagonal braces --------------------------------------------------
      // One slanted member per few bays. Everything else in this module is
      // axis-aligned, and a frame of pure horizontals and verticals reads as a
      // grid however good its relief. A diagonal is the cheapest possible break
      // in that lattice, and it is also the member a real timber frame uses to
      // stop a bay racking — so it is honest as well as useful.
      const bFirst = Math.ceil(axisMin / (tr.studSpacing * 2)) * (tr.studSpacing * 2);
      for (let a = bFirst; a <= axisMax; a += tr.studSpacing * 2) {
        const hash = trimHash(a * 2.11 + 9.7, cross * 3.9 - 2.3);
        if (hash > tr.braceChance) continue;
        const span = tr.studSpacing * 2;
        const lo = Math.max(axisMin, a - span / 2);
        const hi = Math.min(axisMax, a + span / 2);
        if (hi - lo < span * 0.75) continue;
        // Angle from vertical needed to cross the bay corner-to-corner. Mirrored
        // on alternate braces so the frame is not a row of parallel slashes.
        const dir = hash < tr.braceChance * 0.5 ? 1 : -1;
        const angle = Math.atan2((hi - lo) * dir, bayH);
        const len = Math.hypot(hi - lo, bayH) * 0.98;
        put((lo + hi) / 2, bayLo + bayH / 2, tr.braceWidth, len, tr.braceDepth, angle);
      }
    }

    // ---- vertical posts ----------------------------------------------------
    // Placed on a WORLD-SPACE lattice rather than at fractions of this slab's own
    // length, so posts in adjacent collinear slabs line up into one continuous
    // colonnade down a corridor instead of bunching at every cell boundary. That
    // receding rhythm is the depth cue.
    const first = Math.ceil(axisMin / tr.postSpacing) * tr.postSpacing;
    for (let a = first; a <= axisMax; a += tr.postSpacing) {
      // Clip the post to the slab so it never juts past the end of its own wall.
      const lo = Math.max(axisMin, a - tr.postWidth / 2);
      const hi = Math.min(axisMax, a + tr.postWidth / 2);
      const w = hi - lo;
      if (w < tr.postWidth * 0.4) continue;
      const c = (lo + hi) / 2;
      const hash = trimHash(a * 1.31, cross * 6.7 + 1.9);
      const hash2 = trimHash(a * 5.17 + 2.2, cross * 0.91);
      // Stops at the wall plate — a post runs into the plate, not through it.
      const top = wallHeight - tr.capHeight;
      const dd = tr.postDepth * (1 + (hash2 - 0.5) * tr.jitter);
      // Out of plumb. One leaning post in a colonnade is worth more than any
      // amount of surface noise: the eye calibrates vertical against gravity, so
      // a 4-degree lean is noticed instantly and reads as age rather than error.
      const lean = hash < tr.leanChance ? (hash2 - 0.5) * 2 * tr.leanMax : 0;
      put(c, top / 2, w, top, dd, lean);

      // Corbel: the splayed bracket where the post carries the head rail. Two
      // short members stepping outward, so the joint is *made* rather than a bare
      // crossing — and they sit at 2.1-2.3 m, right at the top edge of the beam's
      // footprint at 4-6 m, where they catch the falloff and rim-light.
      if (hash2 > 0.30) {
        const cw = Math.min(tr.corbelWidth, (hi - lo) + tr.studSpacing * 0.9);
        const cy = tr.headY - tr.corbelHeight * 0.5;
        put(c, cy, cw * 0.62, tr.corbelHeight, dd * 0.85);
        put(c, cy - tr.corbelHeight * 0.75, cw * 0.40, tr.corbelHeight * 0.55, dd * 0.72);
      }
    }

    // ---- piers: the coarse-band members -------------------------------------
    //
    // See CFG.maze.trim.pierSpacing for the band-energy measurement that forced
    // these. Short version: every other member in this function is a MID-band
    // term (0.15-0.6 m), the mid band was already oversubscribed 2x against the
    // reference, and the coarse band above 17 px — where Amnesia keeps ~48% of
    // its structure and we kept 28% — had nothing in it at all. A pier is
    // 0.95 m wide and stands 0.42 m proud, so at 4-8 m it subtends 55-120 px
    // and lands squarely in that empty band.
    //
    // A pier is full height on purpose. It is the only member here that runs
    // from floor to wall-plate uninterrupted, so it reads as a structural
    // division of the corridor into bays rather than as another thing stuck on
    // the wall — which is the difference between architecture and trim.
    const pFirst = Math.ceil(axisMin / tr.pierSpacing) * tr.pierSpacing;
    for (let a = noPiers ? Infinity : pFirst; a <= axisMax; a += tr.pierSpacing) {
      // Clip to the slab. A pier is wide, so unlike a post it is common for one
      // to land mostly off the end of a short wall; require most of it to fit
      // rather than let a sliver through, because a 0.2 m stub of a 0.95 m
      // member reads as a mistake rather than as a narrow pier.
      const lo = Math.max(axisMin, a - tr.pierWidth / 2);
      const hi = Math.min(axisMax, a + tr.pierWidth / 2);
      const w = hi - lo;
      if (w < tr.pierWidth * 0.7) continue;
      const c = (lo + hi) / 2;
      const hash = trimHash(a * 0.77 + 31.7, cross * 1.13 - 8.3);
      const hash2 = trimHash(a * 3.41 - 5.1, cross * 2.29 + 17.9);

      // Full height, stopping under the wall plate the same way a post does.
      const top = wallHeight - tr.capHeight;
      const dd = tr.pierDepth * (1 + (hash2 - 0.5) * tr.jitter * 0.5);

      // Some piers step back partway up, the way a real buttress sheds load.
      // Two stacked boxes rather than one, so the step throws its own shadow
      // line across the member's full width — another coarse edge for one box.
      if (hash < tr.pierStepChance) {
        const stepY = top * (0.52 + hash2 * 0.16);
        put(c, stepY / 2, w, stepY, dd);
        put(c, stepY + (top - stepY) / 2, w * 0.82, top - stepY, dd * 0.68);
      } else {
        put(c, top / 2, w, top, dd);
      }

      // Cap and base. Both step OUT past the pier's own depth, so each lays a
      // horizontal shadow line the full width of the member. On a head-mounted
      // light a horizontal edge on a vertical member is the one that survives,
      // because the beam sweeps horizontally and crosses it edge-on.
      put(c, top - tr.pierCapHeight / 2, w * 1.06, tr.pierCapHeight, dd + tr.pierCapOut);
      put(c, tr.pierBaseHeight / 2, w * 1.10, tr.pierBaseHeight, dd + tr.pierBaseOut);
    }
  }

  // ---- overhead joists ----------------------------------------------------
  // Beams spanning between the two walls of a corridor, high up. A joist needs
  // walls under BOTH ends or it is a stick floating in the air, so each one is
  // only laid where the maze actually has a pair of facing walls: for a cell with
  // both a north and a south wall, a joist can run north-south across it, and
  // likewise east-west. Cells at a junction, which is where corridors open out,
  // get none — correctly, because that is where you should be able to see sky.
  const halfW = maze.width / 2, halfD = maze.depth / 2;
  const span = cell + CFG.maze.wallThickness;
  if (span <= tr.joistMaxSpan) {
    for (let y = 0; y < maze.rows; y++) {
      for (let x = 0; x < maze.cols; x++) {
        const c = maze.at(x, y);
        const wx = x * cell - halfW, wz = y * cell - halfD;
        const cx = wx + cell / 2, cz = wz + cell / 2;

        /**
         * One joist, plus the two short bearer blocks its ends rest on.
         *
         * The bearers are what stop a joist reading as a stick that happens to
         * touch two walls. They also do real work for the metric: each is a small
         * proud block high on the wall, so when you look up the corridor the beam
         * finds a row of them receding, and they cut the sky slot into a rhythm
         * rather than a clean stripe.
         *
         * `orient` picks which world axis the joist spans. Sizes are jittered per
         * joist from its own world position, and a joist may be missing entirely
         * — a gap overhead is the cue that the run was once continuous.
         */
        const joist = (jx: number, jz: number, alongZ: boolean) => {
          const hash = trimHash(jx * 4.7 + 13.1, jz * 8.3 - 5.9);
          if (hash < tr.breakChance) return;
          const hash2 = trimHash(jx * 2.9 - 1.7, jz * 3.3 + 6.1);
          const s = tr.joistSize * (1 + (hash2 - 0.5) * tr.jitter);
          // Vertical scatter: joists laid by hand do not share one datum, and a
          // row of them at slightly different heights reads as depth when the
          // beam picks out their undersides.
          const y = tr.joistY + (hash - 0.5) * 0.22;
          if (alongZ) push(jx, y, jz, s, s * 1.35, span);
          else push(jx, y, jz, span, s * 1.35, s);
          // Bearer blocks at each end, sitting on the wall tops the joist lands
          // on. Slightly wider than the joist so they read as separate members.
          const bw = s * 1.9, bh = s * 0.8, e = span / 2 - s * 0.6;
          if (alongZ) {
            push(jx, y - s * 0.9, jz - e, bw, bh, s * 2.2);
            push(jx, y - s * 0.9, jz + e, bw, bh, s * 2.2);
          } else {
            push(jx - e, y - s * 0.9, jz, s * 2.2, bh, bw);
            push(jx + e, y - s * 0.9, jz, s * 2.2, bh, bw);
          }
        };

        // North+south walls present => the corridor runs east-west => joists lie
        // north-south, resting one end on each wall.
        if (c.n && c.s) {
          for (let o = -cell / 2 + tr.joistSpacing / 2; o < cell / 2; o += tr.joistSpacing) {
            joist(cx + o, cz, true);
          }
        }
        if (c.e && c.w) {
          for (let o = -cell / 2 + tr.joistSpacing / 2; o < cell / 2; o += tr.joistSpacing) {
            joist(cx, cz + o, false);
          }
        }
      }
    }
  }

  const geometry = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  return { geometry };
}

export type WorldBuild = {
  group: THREE.Group;
  sky: THREE.Mesh;
  /** Motes carried with the player; the caller re-centres this on the camera. */
  dust: THREE.Points;
  /** Colliders as axis-aligned boxes in the XZ plane: [minX, minZ, maxX, maxZ]. */
  colliders: Float32Array;
  /**
   * The wall surface's finished maps, so other masonry-adjacent objects can be
   * built out of the same material language instead of approximating it.
   *
   * The door is the reason this exists. It was the one large object in the game
   * with no derived relief at all — a flat `MeshStandardMaterial` colour, which
   * next to a normal-mapped, roughness-mapped wall reads exactly like a
   * placeholder ("the door is too smooth looking"). Handing out the SAME
   * `normalFromAlbedo`/`roughnessFromAlbedo` outputs the walls use is both
   * cheaper than re-deriving them (they are canvas readbacks) and the only way
   * the two surfaces can genuinely belong to one world.
   *
   * `albedo` is the GRADED copy — the same one the walls draw with, so the door
   * inherits the wall saturation/contrast grade rather than sitting at raw
   * texture saturation in a desaturated room.
   */
  wallMaps: {
    albedo: THREE.Texture;
    normal: THREE.Texture | null;
    roughness: THREE.Texture | null;
  };
  update(dt: number, elapsed: number): void;
  /**
   * Hands the live flashlight cone to the dust shader, so motes light only where
   * the beam actually is. Must be called each frame AFTER the flashlight's world
   * matrix is up to date, or the shaft lags the torch by a frame.
   */
  setBeam(pos: THREE.Vector3, dir: THREE.Vector3): void;
};

export function buildWorld(
  maze: Maze, wallTexture: THREE.Texture, keepClear: KeepClear[] = [],
): WorldBuild {
  const group = new THREE.Group();
  const { cell, wallHeight, wallThickness } = CFG.maze;
  const halfW = maze.width / 2, halfD = maze.depth / 2;

  // ---- materials ----------------------------------------------------------
  const raw = wallTexture;
  raw.wrapS = raw.wrapT = THREE.RepeatWrapping;
  raw.colorSpace = THREE.SRGBColorSpace;
  raw.anisotropy = 8;

  const source = (raw as any).image;
  // Exposed so a paired A/B probe can re-derive the normal map from the SAME
  // raw image the shipped one is derived from (`tools/wg-normal-ab.mjs`).
  // Deriving the comparison map from the graded albedo instead would confound
  // the derivation change with the grade's luminance stretch. Read-only, and
  // nothing in the game reads it back.
  (window as any).__NORMAL_SRC__ = source;
  // The graded derivative is what every surface samples; see gradeAlbedo. The
  // normal and roughness maps are still derived from the RAW image, because both
  // read luminance and the grade deliberately changes luminance contrast — deriving
  // them from the graded copy would double-apply the same stretch to the surface
  // relief and give the planks a hard plastic edge.
  const albedo = source
    ? gradeAlbedo(source, CFG.render.wallSaturation, CFG.render.wallContrast)
    : raw;

  const wallMat = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: source ? normalFromAlbedo(source) : null,
    /**
     * LOWERED 1.35 -> 0.35 at the wave-5 build gate, applying
     * `docs/handoff/image-tone.md`.
     *
     * Why this only became correct now: the torch core used to SOFT-clip to a
     * flat plateau (trap 30), so normal-map relief inside the beam was quantised
     * out of existence and nobody could see what this number was doing. The tone
     * lane's `installNearFieldFloor()` un-clipped the core (coreFrac 0.786 ->
     * 0.000, verified this gate at max 239/255, clip% 0.000), which exposed a
     * PRE-EXISTING excess of per-pixel energy that the white blob had been
     * hiding.
     *
     * `normalFromAlbedo()` derives the map by finite difference, so its gradients
     * are PER-TEXEL. At the harness's output resolution one texel is about one
     * pixel — exactly the regime where a derived normal map stops being relief
     * and becomes sparkle.
     *
     * Re-measured independently at this gate with `tools/nf-nsweep.mjs`, which
     * toggles the scale inside ONE page load and so is immune to the seed noise
     * that invalidates rebuild-to-rebuild tables (trap 29b):
     *
     *     k      mid      hi   coarse   mid/hi      (Amnesia: hi 4.14, mid/hi 2.83)
     *   1.00   38.77   29.58    27.13     1.31
     *   0.50   36.66   19.39    24.47     1.89
     *   0.35   33.56   15.70    18.55     2.14   <- shipped
     *   0.20   28.88   11.16    16.91     2.59
     *   0.00   11.82    5.82    14.54     2.03
     *
     * ⛔ Do NOT take this to 0. It measures well on `hi` and looks like
     * CARDBOARD — `/tmp/gate5-nsweep/ns_0.png` is a smooth featureless white
     * blob with no floor under it, and `mid` collapses to 11.82 while `mid/hi`
     * actually gets WORSE than 0.2. The metric has an interior optimum and the
     * frames agree with it.
     *
     * 0.35 over 0.2 is the conservative end of the lane's own recommendation:
     * it keeps the most masonry relief of any value that meaningfully cuts the
     * glitter. Chosen by LOOKING at the sweep frames, not by the table alone.
     *
     * The real fix is upstream — blur the source derivative in
     * `normalFromAlbedo()` (or make it mip-aware) and a higher scale becomes
     * affordable again, on a real GPU at 1080p too. That is a bigger change than
     * a build gate should make.
     */
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughnessMap: source ? roughnessFromAlbedo(source) : null,
    /**
     * ---- THE fix for the wave-1 headline gap, and it was never a geometry
     *      problem ----------------------------------------------------------
     *
     * LOWERED 0.96 -> 0.62. This one number took mid-frequency detail in lit
     * pixels from 4.46 to 17.95 on a controlled nose-to-wall frame — a 4x jump,
     * at identical lit fraction (19%) and identical mean luminance (33). No
     * other single change in this lane came close, and three rounds of work had
     * been spent adding geometry, courses and grain to a surface that was
     * physically incapable of showing any of it.
     *
     * Why 0.96 destroys detail, stated as physics rather than as taste: at
     * roughness ~1 a GGX surface is Lambertian, and a Lambertian surface has NO
     * view-dependent response. Its outgoing radiance is albedo * N.L and nothing
     * else. The flashlight is mounted at the camera, so L ~ V, so N.L ~ 1 across
     * the entire lit patch — which means perturbing N does almost nothing. Every
     * normal-mapped feature in this build (the derived grain map, the plank
     * course bevels, the flagstone joints, the trim's own relief) was being
     * evaluated by a BRDF that cannot express it. The specular lobe is the term
     * that reads a normal map, and at 0.96 the lobe is so wide it is flat.
     *
     * Measured, sweeping the material scalar on a live frame with a fixed camera
     * and nothing else changed:
     *
     *   roughness   midFreqStd (lit)   lit%    meanLum
     *   0.96             4.46          19.3     33.7
     *   0.75            10.86          18.7     35.7
     *   0.62            ~14            18.9     35.0
     *   0.55            17.95          19.0     35.6
     *   0.40            20.91          18.5     33.6
     *   Amnesia in-game  5.1 - 17.8      -        -
     *
     * 0.62 is deliberately NOT the value that maximises the metric. 0.55 and
     * below start putting a wet sheen on the timber — the planks read as varnished
     * rather than as dry cellar wood, and at 0.40 the beam's core develops a
     * mirror hotspot that tracks the camera, which is the exact "product shot"
     * look this whole module exists to prevent. 0.62 sits in the upper half of
     * Amnesia's own measured band while keeping the surface unmistakably matte.
     *
     * The roughnessMap multiplies this, and it was widened to 0.30..0.92 in the
     * same pass, so the effective range across a plank is roughly 0.19..0.57:
     * the hard grain lines glance the beam and the soft wood between them stays
     * dead. That variation across a few pixels IS the mid-frequency signal.
     *
     * ---- SWEPT AGAINST THE THREE-BAND METRIC, AND THE METRIC WANTS CARDBOARD --
     *
     * `roughness` was the last lever in this file that had never been swept on a
     * controlled paired instrument. Done at `tools/wg-rsweep.mjs` (one page load,
     * 8 identical wall-facing cameras, so it is immune to trap 29b's seed noise):
     *
     *     roughness    mid      hi   coarse   mid/hi   (Amnesia 10.81/4.14/-/2.83)
     *       0.50     14.34   10.82    18.11     1.32
     *       0.62     13.42    9.19    17.21     1.46   <- shipped
     *       0.72     12.24    7.87    16.18     1.56
     *       0.85     10.43    6.44    15.22     1.62
     *       0.95      9.45    5.87    15.02     1.61
     *
     * Read as a table this says "ship 0.85": `hi` nearly halves, `mid/hi` climbs
     * toward the reference, and `mid` walks from 13.42 down onto Amnesia's 10.81.
     *
     * ⛔ It is a trap, and the frames say so. At 0.95 the wall is FLAT — no sheen
     * anywhere, the torch making no highlight at all, the masonry reading as a
     * printed pattern on matte board. At 0.50 it is the opposite failure, a waxy
     * plastic gloss with the beam pooling as if on vinyl. `hi` improves
     * monotonically as the surface is DESTROYED, because a featureless surface
     * has no noise in it — the same shape as trap 40's `normalScale` result and
     * the same shape as "deleting all architecture scores 31.45".
     *
     * 0.62 is between the two failures and stays. **Do not raise it on the
     * strength of the band table alone.** Both levers in this material are now at
     * interior optima chosen by looking at pictures, and both sweeps are on
     * record. Full write-up: `docs/handoff/beam-catching-normal-derivation.md`.
     */
    roughness: 0.62,
    metalness: 0.0,
    // Warmed from 0x7d7268 (R/B ratio 1.15, essentially neutral) to 0x8a7358
    // (1.57). The tint multiplies the albedo, so a near-grey tint on a
    // desaturated texture leaves the beam nothing warm to land on — see the
    // wallSaturation note in config.ts for the measurement that traced the
    // chalk-grey torch pool back here rather than to the colour grade.
    // Real Amnesia's torch-lit timber measures R/B 1.56-1.80 (am-ff7, am-8f8).
    //
    // RAISED 0x8a7358 -> 0xa08768, same hue and same R/B ratio (1.56), about
    // 1.45x the reflectance. The old value is linear (0.254, 0.171, 0.098) and
    // it multiplies an albedo texture that is itself only ~0.147 linear, which
    // put the finished wall at an effective 2.8% reflector — darker than
    // charcoal, against real dry timber at 15-35%. The consequence is not just
    // "dim": every structural multiplier in the shader below (plank joints at
    // 0.34, per-plank tone at +-0.46, the grime, the AO) is a RATIO, so its
    // absolute contrast in the frame scales with the reflectance it is applied
    // to. At 2.8% all of that detail was being delivered at 3% amplitude.
    color: 0xa08768,
  });

  // ---- wall grime & AO ----------------------------------------------------
  // Flat-lit planks read as cardboard. Two things fix that without a second UV
  // set or a baked lightmap, both computed in the shader from world position:
  //   1. Vertical gradient AO — dark where the wall meets the floor (dirt, damp,
  //      no bounce light reaches a crease) and dark again at the very top where
  //      the wall is furthest from anything that lights it.
  //   2. Large-scale mottled grime, driven by world-space noise at a wavelength
  //      much longer than the texture tile. This is the actual answer to tiling
  //      repetition: the tile still repeats, but the grime laid over it does not,
  //      so the eye stops locking onto the period.
  // vGrimeW is passed from the vertex stage; see the shader patch below.
  const patchWallShader = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uWallHeight = { value: wallHeight };
    shader.uniforms.uCourseHeight = { value: CFG.maze.trim.courseHeight };
    shader.uniforms.uCourseWidth = { value: CFG.maze.trim.courseWidth };
    shader.uniforms.uCourseDepth = { value: CFG.maze.trim.courseDepth };
    shader.uniforms.uPlankAspect = { value: CFG.maze.trim.plankAspect };
    shader.uniforms.uPlankVariance = { value: CFG.maze.trim.plankVariance };
    shader.uniforms.uJointDark = { value: CFG.maze.trim.jointDark };
    shader.uniforms.uPatchDepth = { value: CFG.maze.trim.patchDepth };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vGrimeW;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vGrimeW = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vGrimeW;
         uniform float uWallHeight;
         uniform float uCourseHeight;
         uniform float uCourseWidth;
         uniform float uCourseDepth;
         uniform float uPlankAspect;
         uniform float uPlankVariance;
         uniform float uJointDark;
         uniform float uPatchDepth;

         float gHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         float gNoise(vec2 p){
           vec2 i = floor(p), f = fract(p);
           vec2 u = f * f * (3.0 - 2.0 * f);
           return mix(mix(gHash(i), gHash(i + vec2(1,0)), u.x),
                      mix(gHash(i + vec2(0,1)), gHash(i + vec2(1,1)), u.x), u.y);
         }`,
      )
      // Applied to diffuseColor, i.e. before lighting, so the grime darkens the
      // albedo itself. Doing it to the final colour would wash out under the beam.
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           float h = clamp(vGrimeW.y / uWallHeight, 0.0, 1.0);

           // Floor crease: strong darkening in the bottom ~1.2m, biting hardest
           // in the last few centimetres where wall meets ground.
           float floorAO = smoothstep(0.0, 0.20, h);
           floorAO = mix(0.30, 1.0, floorAO);

           // Top darkening: the wall tops are far from the flashlight and closest
           // to the open sky, so they lose the warm light and gain the red.
           float topAO = 1.0 - smoothstep(0.72, 1.0, h) * 0.45;

           // Long-wavelength grime. Two scales so it has both broad stains and
           // finer streaking, and a vertical stretch so it runs DOWN the wall the
           // way water damage does rather than sitting in round blobs.
           vec2 gp = vec2(vGrimeW.x + vGrimeW.z, vGrimeW.y * 0.30);
           float grime = gNoise(gp * 0.11) * 0.65 + gNoise(gp * 0.37) * 0.35;
           // Streaks: high-frequency horizontally, near-constant vertically.
           float streak = gNoise(vec2((vGrimeW.x + vGrimeW.z) * 1.7, vGrimeW.y * 0.05));
           grime = mix(grime, grime * 0.6 + streak * 0.4, 0.5);
           float grimeMul = mix(0.58, 1.06, grime);

           diffuseColor.rgb *= floorAO * topAO * grimeMul;
           // Damp low wall goes cooler and redder, not just darker.
           diffuseColor.rgb *= mix(vec3(0.82, 0.72, 0.70), vec3(1.0), smoothstep(0.0, 0.30, h));

           // ---- running-bond plank courses ------------------------------
           //
           // This is what closed the measured gap against Amnesia, so it is worth
           // being precise about what each of the three parts does.
           //
           // The metric the critic graded on is mid-frequency structure INSIDE
           // LIT PIXELS. That means brightening the frame does not help at all —
           // a brighter flat blob measures exactly as flat as a dim one. Amnesia
           // scores 30.9 there because the region its lamp lights is stone blocks
           // with dark mortar between them: high contrast at a scale of tens of
           // pixels, right where the beam is. Ours scored 3.34 because the beam
           // landed on a low-contrast mossy plank tile with no joints in it.
           //
           //   1. Horizontal courses: joints at every plank pitch.
           //   2. Staggered vertical butt joints, offset half a plank on
           //      alternate courses. Without these the wall is corduroy — a bond
           //      pattern needs both axes or it reads as a texture, not masonry.
           //   3. Per-plank tone. Each plank gets its own multiplier from a hash
           //      of its (course, position) index. This is the single largest
           //      contributor to the measurement, and it is also the most true to
           //      the reference: in amn1 no two adjacent blocks are the same
           //      value, and that block-to-block variation is most of what you
           //      are actually seeing when you look at that wall.
           //
           // Driven off world position, so the bond is continuous across every
           // wall segment in the maze rather than restarting per box.
           {
             float cP = uCourseHeight;
             // Distance along the wall, in the wall's own plane. Summing x and z
             // works because every wall is axis-aligned: one term is constant
             // across the face and the other is the position along the run.
             float along = vGrimeW.x + vGrimeW.z;

             float row = floor(vGrimeW.y / cP);
             float cf = vGrimeW.y / cP - row;
             float hJoint = min(cf, 1.0 - cf) * cP;

             // Half-plank stagger on odd courses: a running bond, not a stack
             // bond. A stack bond puts every vertical joint in one line and reads
             // as a grid, which is the exact artifact the world-space UVs exist
             // to avoid.
             float plankLen = cP * uPlankAspect;
             float stagger = mod(row, 2.0) * 0.5;
             float colF = along / plankLen + stagger;
             float colI = floor(colF);
             float vf = colF - colI;
             float vJoint = min(vf, 1.0 - vf) * plankLen;

             float joint = min(hJoint, vJoint);
             diffuseColor.rgb *= mix(uJointDark, 1.0, smoothstep(0.0, uCourseWidth, joint));

             // Per-plank tone.
             float pid = gHash(vec2(colI, row) * 0.719 + 3.13);
             diffuseColor.rgb *= mix(1.0 - uPlankVariance, 1.0 + uPlankVariance * 0.55, pid);

             // ---- PATCHES: the term that still resolves at 8-15 m ----------
             //
             // Everything above is fine-scale, and fine scale is exactly what
             // foreshortening destroys. A 16-pose sample across the maze splits
             // cleanly in two: poses with a wall within a few metres measure
             // 23-28, and poses looking down an open corridor measure 11-16.
             // In the second group the courses are 8-15 m away and their period
             // has fallen to about a pixel, which is BELOW the box(3) floor of
             // the measurement and below what the eye resolves either.
             //
             // A feature subtends p/r, so the only structure that survives at
             // range is structure with a long period to begin with. These are
             // metre-scale patches of damp, soot and old repair laid over the
             // bond — spanning several planks each, so they neither replace the
             // fine detail nor compete with it. Near to, they read as staining
             // across the masonry; far off, they are the only thing left with a
             // period wide enough to be seen at all.
             //
             // Two octaves an octave and a half apart, and the result is pushed
             // through a smoothstep rather than used raw: a raw fBm is mostly
             // mid-grey and reads as haze, while a contrast-stretched one has
             // actual clean patches and actual dark ones with edges between
             // them, which is what carries across a box filter.
             vec2 pp = vec2(along, vGrimeW.y * 1.35);
             // wpatch, NOT patch.
             //
             // "patch" is a RESERVED WORD in GLSL ES 3.00 (tessellation), so this
             // fragment shader failed to compile outright:
             //     ERROR: 'patch' : Illegal use of reserved word
             // three.js logs that and carries on, so there was no crash and no
             // visible error - the wall material simply stopped drawing its grime
             // pass. The largest surface in the game was rendering with its entire
             // detail layer dead, silently, while the atmosphere lanes measured
             // midFreqStd against it and tried to make up the difference elsewhere.
             //
             // The floor and trim shaders already used fpatch/tpatch and were
             // unaffected, which is why only the walls looked flat.
             float wpatch = gNoise(pp * 0.42) * 0.62 + gNoise(pp * 1.15) * 0.38;
             wpatch = smoothstep(0.34, 0.72, wpatch);
             // DARKEN-ONLY, and that is deliberate rather than a taste call.
             // A symmetric mix around 1.0 averages ABOVE 1.0 once the
             // smoothstep has skewed the distribution, so the first version of
             // this term lifted mean scene luminance 15.9 -> 21.4 and litFrac
             // 0.128 -> 0.164 while leaving midFreqStd flat: it was brightening
             // the wall, which pushes dim structureless pixels over the metric's
             // lum>25 gate and dilutes the average over a larger, flatter
             // population. That is the same trap that made a global albedo gain
             // measure WORSE. Staining is subtractive in the world too — soot
             // and damp darken masonry, they do not bleach it.
             diffuseColor.rgb *= mix(1.0 - uPatchDepth, 1.0, wpatch);
           }
         }`,
      )
      /**
       * Plank courses, as a normal perturbation in world space.
       *
       * This is the other half of the fix documented at CFG.maze.trim, and it is
       * aimed at the exact failure the timber bands alone do not cover: standing
       * a metre from a wall looking straight at it, the beam lands entirely in
       * the 1.25m gap between the waist rail and the head rail and finds nothing.
       * Measured on that shot, mid-frequency structure inside lit pixels was 5.75
       * against Amnesia's 30.91 even with the bands in.
       *
       * Real geometry at course spacing would be ~13 extra bands per wall — three
       * times the trim's triangle count for a feature only ever seen from close
       * range. A normal perturbation costs nothing per wall and, crucially, is
       * NOT a texture trick: it changes N, so it changes N·L, so a moving light
       * genuinely rakes across it. Each course edge lights up as the beam swings
       * onto it and goes dark as the beam passes, which is precisely the cue the
       * critic said was missing ("a moving light finds nothing to rake across").
       *
       * Injected at normal_fragment_maps, i.e. AFTER the albedo-derived normal
       * map has been applied, so the two compose: fine grain from the texture,
       * structural courses from here.
       *
       * Driven from world Y rather than from UV so every wall in the maze shares
       * one continuous set of course lines. Off a UV the courses would step at
       * every wall segment and re-announce the grid the world-space UVs exist to
       * hide.
       */
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           // Only side walls get courses. On a floor or a wall top the gradient
           // below is degenerate (the surface has no vertical extent to cut) and
           // it would stripe the ground with phantom ridges.
           float sideness = 1.0 - abs(normal.y);
           if (sideness > 0.25) {
             float cP = uCourseHeight;
             float along = vGrimeW.x + vGrimeW.z;

             float row = floor(vGrimeW.y / cP);
             float cf = vGrimeW.y / cP - row;
             float hJoint = min(cf, 1.0 - cf) * cP;

             float plankLen = cP * uPlankAspect;
             float colF = along / plankLen + mod(row, 2.0) * 0.5;
             float vf = fract(colF);
             float vJoint = min(vf, 1.0 - vf) * plankLen;

             // Signed distance across each joint, so the two lips of a groove tilt
             // in OPPOSITE directions. That is what makes one lip catch the beam
             // while the other falls dark, which is the whole read.
             float hSide = (cf < 0.5) ? -1.0 : 1.0;
             float vSide = (vf < 0.5) ? -1.0 : 1.0;
             float hBevel = 1.0 - smoothstep(0.0, uCourseWidth, hJoint);
             float vBevel = 1.0 - smoothstep(0.0, uCourseWidth, vJoint);

             // The horizontal joint tilts the normal about the world horizontal:
             // the wall's own normal is horizontal, so pitching it toward or away
             // from world up is exactly the rotation a chamfered plank edge has.
             //
             // The vertical joint has to tilt ALONG the wall, and the direction
             // that means depends on which way this particular wall faces. Taking
             // the cross product of the surface normal with world up gives the
             // in-plane horizontal for whichever wall this is, so one expression
             // is correct for every wall in the maze without branching on which.
             vec3 tangentAlong = normalize(cross(vec3(0.0, 1.0, 0.0), normal) + vec3(1e-5));
             normal = normalize(
               normal
               + vec3(0.0, hSide * hBevel * uCourseDepth, 0.0)
               + tangentAlong * (vSide * vBevel * uCourseDepth)
             );
           }
         }`,
      );
  };

  wallMat.onBeforeCompile = (shader, renderer) => {
    patchWallShader(shader);
    // Keep the compiled shader reachable so a sweep can move `uPlankVariance`
    // and friends on the LIVE material. Without this every structural-contrast
    // sample costs a full rebuild, which also reseeds the maze and moves the
    // camera — so the variable under test stops being the only difference. See
    // tools/bc-sweep4.mjs.
    void renderer;
    wallMat.userData.shaderRef = shader;
  };
  // Without a distinct key three reuses one compiled program for both materials,
  // and the floor would inherit the wall's grime patch with the wrong height.
  wallMat.customProgramCacheKey = () => 'wall-grime-v5-wpatch';

  // The floor must NOT be the same brightness as the walls, or the scene has no
  // ground and the player floats. It was 0x4a4038 against the wall's 0x8d8378 —
  // only about half a stop apart once lighting landed on both.
  //
  // The correction then went too far the other way. At 0x241d18 the floor was
  // about 14% of the wall's albedo, which is not "grounded", it is absent: in
  // captured frames the lower third of the picture was simply black and the beam
  // pointed at the ground returned nothing. The reference does the opposite — the
  // cobbles in amn1 are one of the most legible things in the shot and they are
  // what tells you how big the room is and how fast you are moving through it.
  //
  // 0x453931 is roughly 55% of the wall, which is the real relationship between a
  // trodden stone floor and a wall nobody touches: darker, but present.
  const floorMat = new THREE.MeshStandardMaterial({
    map: albedo.clone(),
    normalMap: wallMat.normalMap,
    /**
     * Raised 0.7 -> 1.05 alongside the roughness drop below. The floor is always
     * seen at a grazing angle, where a normal map's effect on the specular term
     * is strongest and its effect on the diffuse term is weakest — so this is the
     * surface that gains most from relief, and it had the least.
     */
    /**
     * LOWERED 1.05 -> 0.30 at the wave-5 gate, with the wall — see the long note
     * on `wallMat.normalScale` for the derivation and the sweep table.
     *
     * The floor is the surface this mattered most on. The grazing-angle argument
     * that RAISED this to 1.05 is still correct in principle, but a grazing view
     * is also where a per-texel derived normal produces the worst specular
     * aliasing: the shipped value shattered the beam pool into disconnected
     * glitter specks rather than lighting a floor. Compare
     * `/tmp/gate5-nsweep/ns_1.png` (glitter) against `ns_0p35.png` (a continuous
     * lit floor that still has texture in it) — both from the same page load,
     * same camera, same maze.
     */
    normalScale: new THREE.Vector2(0.30, 0.30),
    /**
     * Was 1.0 — perfectly Lambertian, on the surface the torch spends most of
     * its time pointed at and which is always viewed at a grazing angle. That is
     * the worst possible place to have no specular response: a grazing view of a
     * Lambertian plane is the definition of a featureless smear, and it is why
     * the look-down-at-the-floor frame measured the lowest mid-frequency detail
     * of the whole capture set (3.47) despite the flagstone joints and per-slab
     * tone variation being right there in the shader.
     *
     * 0.72 — rougher than the wall, because trodden stone is duller than a wall
     * nobody touches, but far enough off the Lambertian rail that the flagstone
     * bevels and the grazing beam produce a real sheen down the corridor. That
     * long low glance off a wet-looking floor is one of the most recognisable
     * things in the reference frames.
     */
    roughness: 0.72,
    metalness: 0.0,
    /**
     * RAISED 0x453931 -> 0x6a5c50.
     *
     * The comment block above argues at length that the floor must be ~55% of
     * the wall and not 14%. That ratio was then applied to a wall tint which is
     * itself dark, and the floor also carries no brightening multiplier of its
     * own, so the shipped floor was linear 0.0595 over an albedo of ~0.147 —
     * an effective 0.9% reflector. Measured against the wall's finished value it
     * was not 55%, it was 23%, and in absolute terms it was black.
     *
     * 0x6a5c50 is linear 0.140, which against the wall's new 0.254 is the 55%
     * the comment always intended. The ratio is now what it says it is.
     */
    color: 0x6a5c50,
  });
  // 3m per tile on the floor: fine enough to give the eye a sense of travel speed
  // without turning into moire in the middle distance.
  floorMat.map!.repeat.set(maze.width / 3, maze.depth / 3);
  floorMat.map!.needsUpdate = true;

  /**
   * Flagstones. The same running-bond treatment as the walls, laid in the XZ
   * plane instead of a vertical one, with the normal tilted along both floor
   * axes so the beam rakes across the joints.
   *
   * The floor needs this more than the walls do, not less. It is the surface the
   * torch spends most of its time pointed at, it is always seen at a grazing
   * angle where a plain texture smears into mush, and it is the only surface that
   * can tell you how fast you are walking — a featureless plane slides under you
   * with no sense of travel at all. In the reference frame the cobbles are the
   * clearest structure in the picture.
   */
  floorMat.onBeforeCompile = (shader) => {
    // Same reason as the wall's: keeps the flagstone uniforms sweepable live.
    floorMat.userData.shaderRef = shader;
    shader.uniforms.uFlagSize = { value: CFG.maze.trim.flagSize };
    shader.uniforms.uFlagJoint = { value: CFG.maze.trim.flagJoint };
    shader.uniforms.uFlagDepth = { value: CFG.maze.trim.flagDepth };
    shader.uniforms.uFlagVariance = { value: CFG.maze.trim.flagVariance };
    shader.uniforms.uJointDark = { value: CFG.maze.trim.jointDark };
    shader.uniforms.uPatchDepth = { value: CFG.maze.trim.patchDepth };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
         varying vec3 vFloorW;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
         vFloorW = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
         varying vec3 vFloorW;
         uniform float uFlagSize;
         uniform float uFlagJoint;
         uniform float uFlagDepth;
         uniform float uFlagVariance;
         uniform float uJointDark;
         uniform float uPatchDepth;
         float fHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         float fNoise(vec2 p){
           vec2 i = floor(p), f = fract(p);
           vec2 u = f * f * (3.0 - 2.0 * f);
           return mix(mix(fHash(i), fHash(i + vec2(1,0)), u.x),
                      mix(fHash(i + vec2(0,1)), fHash(i + vec2(1,1)), u.x), u.y);
         }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
         {
           float S = uFlagSize;
           // Half-slab stagger on alternate rows, same running bond as the walls,
           // so a floor joint never lines up with the one in the next row and the
           // pattern does not resolve into a grid.
           float rz = floor(vFloorW.z / S);
           float fx = vFloorW.x / S + mod(rz, 2.0) * 0.5;
           float fz = vFloorW.z / S - rz;
           float jx = min(fract(fx), 1.0 - fract(fx)) * S;
           float jz = min(fz, 1.0 - fz) * S;
           float joint = min(jx, jz);
           diffuseColor.rgb *= mix(uJointDark * 0.88, 1.0, smoothstep(0.0, uFlagJoint, joint));
           float sid = fHash(vec2(floor(fx), rz) * 0.531 + 7.7);
           diffuseColor.rgb *= mix(1.0 - uFlagVariance, 1.0 + uFlagVariance * 0.5, sid);

           // Metre-scale wear patches, the same term the walls carry and for
           // the same reason: the floor is seen at a grazing angle, so its
           // slabs foreshorten harder than anything else in frame and past a
           // few metres the per-slab detail collapses below a pixel. These are
           // the worn tracks and puddled hollows that survive that range, and
           // on a floor they double as the strongest cue for how fast you are
           // walking.
           vec2 fp = vec2(vFloorW.x, vFloorW.z);
           float fpatch = fNoise(fp * 0.38) * 0.62 + fNoise(fp * 1.05) * 0.38;
           fpatch = smoothstep(0.34, 0.72, fpatch);
           // Darken-only; see the note on the wall's patch term.
           diffuseColor.rgb *= mix(1.0 - uPatchDepth, 1.0, fpatch);
         }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
         {
           float S = uFlagSize;
           float rz = floor(vFloorW.z / S);
           float fx = vFloorW.x / S + mod(rz, 2.0) * 0.5;
           float fz = vFloorW.z / S - rz;
           float ffx = fract(fx);
           float jx = min(ffx, 1.0 - ffx) * S;
           float jz = min(fz, 1.0 - fz) * S;
           // Tilt in world X and Z. The floor's normal is world up, so tilting it
           // toward either horizontal axis is exactly a chamfered slab edge.
           float bx = (1.0 - smoothstep(0.0, uFlagJoint, jx)) * ((ffx < 0.5) ? -1.0 : 1.0);
           float bz = (1.0 - smoothstep(0.0, uFlagJoint, jz)) * ((fz  < 0.5) ? -1.0 : 1.0);
           normal = normalize(normal + vec3(bx, 0.0, bz) * uFlagDepth);
         }`);
  };
  // Distinct from the wall's key, or three hands the floor the wall's compiled
  // program — complete with the wall's course pattern driven off world Y, which
  // is constant across a floor and would flat-tint the whole plane.
  floorMat.customProgramCacheKey = () => 'floor-flagstone-v2-patch';

  const ceilMat = new THREE.MeshStandardMaterial({
    map: albedo.clone(),
    roughness: 1.0,
    color: 0x2a231e,
  });
  ceilMat.map!.repeat.set(maze.width / 4, maze.depth / 4);

  // ---- wall segments ------------------------------------------------------
  // Collect every wall as a box, then merge into one BufferGeometry.
  const boxes: WallBox[] = [];
  const t = wallThickness;

  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      const c = maze.at(x, y);
      const wx = x * cell - halfW, wz = y * cell - halfD;
      if (c.n) boxes.push({ cx: wx + cell / 2, cz: wz, sx: cell + t, sz: t });
      if (c.w) boxes.push({ cx: wx, cz: wz + cell / 2, sx: t, sz: cell + t });
      if (y === maze.rows - 1 && c.s) boxes.push({ cx: wx + cell / 2, cz: wz + cell, sx: cell + t, sz: t });
      if (x === maze.cols - 1 && c.e) boxes.push({ cx: wx + cell, cz: wz + cell / 2, sx: t, sz: cell + t });
    }
  }

  const geos: THREE.BufferGeometry[] = [];
  const colliders = new Float32Array(boxes.length * 4);
  boxes.forEach((b, i) => {
    const g = new THREE.BoxGeometry(b.sx, wallHeight, b.sz);
    g.translate(b.cx, wallHeight / 2, b.cz);

    // World-space UVs: grain runs down the corridor, seams stop advertising the grid.
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    /**
     * UV units per metre. This was 0.42, i.e. one full texture every 2.4 metres —
     * so a 6.5m wall was under three tiles tall and, seen from a metre away inside
     * the flashlight's hot spot, a single plank filled the entire screen as a
     * featureless blur. At 0.85 the tile is ~1.2m, planks read as planks, and the
     * wall gains enough vertical repetition to actually look tall. The grime layer
     * in the shader patch is what keeps that repetition from reading as tiling.
     */
    const SCALE = 0.85;
    for (let v = 0; v < uv.count; v++) {
      const px = pos.getX(v), py = pos.getY(v), pz = pos.getZ(v);
      const ax = Math.abs(nor.getX(v)), az = Math.abs(nor.getZ(v));
      // Project along whichever axis the face points down.
      if (ax > az) uv.setXY(v, pz * SCALE, py * SCALE);
      else uv.setXY(v, px * SCALE, py * SCALE);
    }
    uv.needsUpdate = true;
    geos.push(g);

    colliders[i * 4 + 0] = b.cx - b.sx / 2;
    colliders[i * 4 + 1] = b.cz - b.sz / 2;
    colliders[i * 4 + 2] = b.cx + b.sx / 2;
    colliders[i * 4 + 3] = b.cz + b.sz / 2;
  });

  const merged = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  const walls = new THREE.Mesh(merged, wallMat);
  walls.castShadow = true;
  walls.receiveShadow = true;
  // Named so raycast probes can say WHICH surface they hit. An anonymous
  // `Mesh<MeshStandardMaterial>` in a hit list is not a diagnosis.
  walls.name = 'walls';
  group.add(walls);

  // ---- corridor carpentry -------------------------------------------------
  // See CFG.maze.trim for the measurement that forced this. Short version: the
  // flashlight had nothing to rake across, so a lit wall was a featureless oval
  // of brown. Bands and posts standing proud of the wall face give the beam real
  // edges at 2-8m, which is where the deficit was.
  const trim = buildTrim(boxes, maze, keepClear);
  const trimMat = new THREE.MeshStandardMaterial({
    map: albedo.clone(),
    normalMap: wallMat.normalMap,
    /**
     * LOWERED 1.1 -> 0.30 at the wave-5 gate, with the wall and floor — see the
     * long note on `wallMat.normalScale`. The trim shares the wall's derived
     * normal map (`normalMap: wallMat.normalMap`), so it shares the per-texel
     * sparkle problem and has to move with it; leaving the carpentry at 1.1
     * would make the posts and rails the noisiest surfaces in the frame.
     */
    normalScale: new THREE.Vector2(0.30, 0.30),
    roughnessMap: wallMat.roughnessMap,
    /**
     * Was 0.99 — fully Lambertian, so the carpentry that exists specifically to
     * be raked by a moving beam had no view-dependent term at all and could only
     * ever read as a flat tonal step. See the long note on the wall's roughness.
     *
     * LOWERED 0.68 -> 0.34, and this is the one material change in the lane that
     * a sweep actually rewarded. On a fixed frame with the sim frozen, moving
     * only this number:
     *
     *   roughness   midFreqStd (lit)   litP90
     *   0.68             9.93           41.7
     *   0.50             9.93           41.7
     *   0.35            11.66           61.5
     *   0.25            12.77           53.6
     *   0.15             9.17            —     (specular starts to clip)
     *
     * The mechanism is the same one that governs everything else in this lane.
     * The flashlight is mounted at the camera, so L ≈ V, so the diffuse term is
     * nearly constant across every surface facing the player — a member's
     * outward face and the wall behind it have the same N, therefore the same
     * N·L, therefore the same brightness. The SPECULAR lobe is the only term
     * carrying a view dependence, so it is the only term that can turn this
     * carpentry into contrast, and roughness is what sets its width.
     *
     * 0.34 rather than the 0.25 that maximises the metric: below about 0.3 the
     * timber picks up a wet sheen and the beam's core grows a mirror hotspot
     * that tracks the camera, which is the "product shot" look the whole module
     * exists to avoid. 0.34 is the top of the band that still reads as dry,
     * handled wood — and it is now LOWER than the wall's 0.62 rather than
     * higher, which is the correct relationship anyway: these are the surfaces
     * that get touched, and handled timber polishes where a plank nobody reaches
     * stays matte.
     */
    roughness: 0.34,
    metalness: 0.0,
    /**
     * Darker than the wall, and that separation is the point. A band the same
     * tone as its wall relies purely on its cast shadow to be seen, and a cast
     * shadow disappears the moment the beam hits the wall square-on. Aged timber
     * against lighter plaster-stained plank is both the real-world relationship
     * and the one that survives every beam angle.
     *
     * RAISED 0x453a31 -> 0x6d5c4c. The principle above is right; the magnitude
     * was not. 0x453a31 is linear 0.0595 against the wall's 0.254 — the trim was
     * 4.3x darker than a wall that was itself only a 2.8% reflector, which put
     * the finished carpentry near 0.7% and made it optically black. The whole
     * point of this geometry is to be the thing the beam finds at 2-8m, and it
     * was the darkest surface in the frame.
     *
     * 0x6d5c4c is linear 0.148, i.e. 0.58x the wall's new 0.254. That is a
     * legible half-stop of separation — aged timber against lighter plank — and
     * it is a ratio the eye reads as two materials rather than as a hole.
     *
     * WARMED 0x6d5c4c -> 0x6e5741, same luminance to within a percent but R/B
     * 1.42 -> 1.70. With the roughness drop to 0.34 the carpentry acquired a
     * real specular lobe, and a specular highlight on a near-neutral tint comes
     * back the colour of the light — which put a pale grey-white sheen on every
     * member and made the frames read as whitewashed plaster rather than as
     * timber. Real Amnesia's torch-lit woodwork measures R/B 1.56-1.80, and the
     * shipped art (`son.png`, `billyScare.png`) is explicit that the palette is
     * three colours: cold grey flesh, hair-brown, and wet red. The carpentry is
     * the brown.
     */
    color: 0x6e5741,
    name: 'trim',
  });

  /**
   * ---- THE TRIM'S OWN STRUCTURAL SHADER, and the measurement that forced it --
   *
   * The carpentry shipped with no structural shader at all — just the graded
   * albedo, a normal map and a flat tint. That was invisible as a problem until
   * the lit surfaces were attributed rather than assumed. Painting each surface
   * class emissive green in turn and counting how many of the frame's LIT pixels
   * changed colour gives:
   *
   *     trim   32.6% of lit pixels
   *     wall   29.5%
   *     floor   0.0%   (the beam is on a wall in this pose)
   *
   * The carpentry is the LARGEST lit surface in the frame — larger than the wall
   * it is attached to — and it was the only one with no bond, no courses, no
   * per-unit tone and no grain. That also explains a result that had been
   * puzzling: sweeping the WALL's `uPlankVariance` from 0.0 to 3.0, a 6x
   * overdrive, moved lit mid-frequency detail by 0.3. The wall shader was working
   * correctly; it simply was not what the beam was mostly landing on.
   *
   * Three terms, each aimed at a different scale, and all in the albedo rather
   * than in the normal. That choice is deliberate and it is the lesson of the
   * five sweeps behind this file: this light is head-mounted, so L ~ V and the
   * diffuse response is nearly flat across any surface facing the camera. A
   * normal perturbation therefore delivers almost nothing here, while an albedo
   * ratio delivers the same relative contrast at every brightness — including in
   * the dim rim of the beam, which is where 75% of our lit pixels live and where
   * ours measured 3.3-4.3 against the reference's 9.1-19.2.
   */
  trimMat.onBeforeCompile = (shader) => {
    trimMat.userData.shaderRef = shader;
    shader.uniforms.uTimberVariance = { value: CFG.maze.trim.timberVariance };
    shader.uniforms.uTimberLength = { value: CFG.maze.trim.timberLength };
    shader.uniforms.uGrainScale = { value: CFG.maze.trim.grainScale };
    shader.uniforms.uGrainDepth = { value: CFG.maze.trim.grainDepth };
    shader.uniforms.uJointDark = { value: CFG.maze.trim.jointDark };
    shader.uniforms.uPatchDepth = { value: CFG.maze.trim.patchDepth };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
         varying vec3 vTrimW;
         varying vec3 vTrimN;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
         vTrimW = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vTrimN = normalize(mat3(modelMatrix) * objectNormal);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
         varying vec3 vTrimW;
         varying vec3 vTrimN;
         uniform float uTimberVariance;
         uniform float uTimberLength;
         uniform float uGrainScale;
         uniform float uGrainDepth;
         uniform float uJointDark;
         uniform float uPatchDepth;
         float tHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         float tHash3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
         float tNoise(vec2 p){
           vec2 i = floor(p), f = fract(p);
           vec2 u = f * f * (3.0 - 2.0 * f);
           return mix(mix(tHash(i), tHash(i + vec2(1,0)), u.x),
                      mix(tHash(i + vec2(0,1)), tHash(i + vec2(1,1)), u.x), u.y);
         }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
         {
           // ---- 1. per-member tone -------------------------------------------
           //
           // Every physical piece of timber gets its own value. This is the
           // largest of the three terms and it is the one the reference actually
           // carries: in amn1 no two adjacent blocks share a tone, and that
           // block-to-block scatter is most of what you are looking at when you
           // look at that lit wall.
           //
           // "Which member am I on" is recovered by quantising world position
           // along whichever axis this member runs. A member's long axis is the
           // one its normal is NOT aligned with, so the two horizontal cases are
           // separated by the normal's own components — no extra attribute, and
           // it stays correct through the merge because everything is in world
           // space.
           float ax = abs(vTrimN.x), ay = abs(vTrimN.y), az = abs(vTrimN.z);
           // Distance along the member, in metres.
           float runPos = (ax > az) ? vTrimW.z : vTrimW.x;
           // Which piece of timber: quantise the run into board lengths, and key
           // the hash on height too so a rail and the post crossing it differ.
           vec2 memberId = vec2(floor(runPos / uTimberLength),
                                floor(vTrimW.y / 0.55));
           float mid = tHash(memberId * 1.37 + 11.3);
           diffuseColor.rgb *= mix(1.0 - uTimberVariance, 1.0 + uTimberVariance * 0.62, mid);

           // ---- 2. end-grain butt joints -------------------------------------
           // A dark line where one board ends and the next begins. Narrow, hard,
           // and at a metre-scale pitch, so at 4-8 m it lands squarely inside the
           // 3-17 px band the metric measures.
           float endF = fract(runPos / uTimberLength);
           float endJ = min(endF, 1.0 - endF) * uTimberLength;
           diffuseColor.rgb *= mix(uJointDark * 0.88, 1.0, smoothstep(0.0, 0.035, endJ));

           // ---- 3. sawn grain -------------------------------------------------
           // Bands running ALONG the member, stretched hard across it, which is
           // what a sawn face looks like. Two octaves so it is not a sine.
           //
           // The grain is oriented from the member's own axis rather than from a
           // UV, so it runs the correct way on a post and on a rail without the
           // two needing different UV sets.
           vec2 gp = (ay > 0.6)
             ? vec2(vTrimW.x + vTrimW.z, (vTrimW.x - vTrimW.z) * 0.12)   // up-facing
             : ((ax > az) ? vec2(vTrimW.y, vTrimW.z * 0.10)              // x-facing
                          : vec2(vTrimW.y, vTrimW.x * 0.10));            // z-facing
           float grain = tNoise(gp * uGrainScale) * 0.66
                       + tNoise(gp * uGrainScale * 2.7) * 0.34;
           diffuseColor.rgb *= mix(1.0 - uGrainDepth, 1.0 + uGrainDepth * 0.5, grain);

           // ---- 4. face-by-face tone ------------------------------------------
           // A box's six faces are six different pieces of surface: the up-facing
           // top of a rail collects dust and reads pale, the down-facing soffit
           // sits in its own shade and reads dark, and the two vertical faces sit
           // between. Under a head-mounted light the diffuse term cannot separate
           // them — they differ in N, but N·L barely changes when L≈V — so the
           // separation has to be authored into the albedo, and doing it here
           // gives every member a top, a front and an underside instead of one
           // uniform silhouette.
           float up = vTrimN.y;
           diffuseColor.rgb *= 1.0
             + smoothstep(0.55, 1.0, up) * 0.30      // dusty top
             - smoothstep(-0.55, -1.0, up) * 0.42;   // shaded soffit

           // ---- 5. metre-scale patches ---------------------------------------
           // The same long-period term the walls and floor carry. Everything
           // above is fine-scale, and fine scale is what foreshortening
           // destroys: in poses looking down an open corridor the carpentry is
           // 8-15 m away and its grain and butt joints have fallen below a
           // pixel. Patches of damp and soot spanning whole members are what is
           // left to see at that range, and near to they read as the staining
           // an old timber frame in a wet cellar would actually have.
           vec2 tp = vec2(runPos, vTrimW.y * 1.2);
           float tpatch = tNoise(tp * 0.40) * 0.62 + tNoise(tp * 1.10) * 0.38;
           tpatch = smoothstep(0.34, 0.72, tpatch);
           // Darken-only; see the note on the wall's patch term.
           diffuseColor.rgb *= mix(1.0 - uPatchDepth, 1.0, tpatch);
         }`);
  };
  /**
   * Its own cache key, or three hands the carpentry the wall's compiled program —
   * complete with the wall's course pattern driven off world Y, which on a joist
   * soffit or a skirting top is constant and would flat-tint the whole member.
   */
  trimMat.customProgramCacheKey = () => 'trim-timber-v2-patch';
  const trimMesh = new THREE.Mesh(trim.geometry, trimMat);
  /**
   * Trim does NOT cast shadows — kept off, but for a different and better reason
   * than the one originally given, and after actually measuring it both ways.
   *
   * The original argument was that a proud member reads through N·L on its own
   * side faces, so the shadow adds little. That argument is wrong about this
   * light rig: the flashlight is mounted at the camera, so L ≈ V and N·L is
   * nearly identical for a member's outward face and the wall behind it. Under
   * that condition the side faces are a couple of pixels wide at corridor range
   * and the box(17) term averages them out, so N·L relief buys almost nothing
   * either. Both halves of the old reasoning were optimistic.
   *
   * So it was turned ON and measured, on a fixed frame with the sim frozen:
   *
   *     trim castShadow = true .... midFreqStd 12.59
   *     trim castShadow = false ... midFreqStd 13.00
   *
   * Casting is not merely unnecessary, it measures very slightly WORSE — because
   * the carpentry's own cast shadows fall mostly on the wall immediately behind
   * each member, darkening pixels that would otherwise have carried the timber's
   * albedo structure and pushing some of them under the metric's lum>25 gate.
   *
   * What actually carries this lane is the trim's albedo shader above, which
   * works because an albedo RATIO survives a head-mounted light where a normal
   * or a shadow does not. Keeping castShadow off halves the carpentry's
   * rasterisation cost — it is 152k triangles, and drawn twice it was pushing
   * the scene from 349k to 476k against a monster that is himself ~150k.
   *
   * `?trimshadow=1` re-enables it, so this stays an A/B rather than a belief.
   */
  trimMesh.castShadow = new URLSearchParams(location.search).get('trimshadow') === '1';
  trimMesh.receiveShadow = true;
  /**
   * `?notrim=1` drops the carpentry, for perf attribution only.
   *
   * "It got slower" is not actionable on a software rasterizer, and guessing was
   * expensive: the trim looked like the obvious suspect when the frame rate fell,
   * and it was not. Bisecting with this flag against the triangle counter in
   * __GAME_STATE__.render gave the real split — maze 13,430 triangles bare,
   * 48,974 with all the carpentry, against 349,596 for the whole scene. The
   * monster mesh alone is ~300k of that, drawn twice because he casts shadows.
   * The carpentry is 10% of the frame, and the character is 86%.
   */
  trimMesh.name = 'trim';
  if (!new URLSearchParams(location.search).has('notrim')) group.add(trimMesh);

  // ---- floor & ceiling ----------------------------------------------------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(maze.width, maze.depth), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);

  if (CFG.maze.ceiling) {
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(maze.width, maze.depth), ceilMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = wallHeight;
    ceiling.receiveShadow = true;
    ceiling.name = 'ceiling';
    group.add(ceiling);
  }

  const sky = buildSky();

  const dust = buildDust();
  group.add(dust.points);

  return {
    group,
    sky,
    dust: dust.points,
    colliders,
    wallMaps: {
      albedo,
      normal: wallMat.normalMap,
      roughness: wallMat.roughnessMap,
    },
    update(dt, elapsed) {
      (sky.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
      dust.step(dt, elapsed);
    },
    setBeam(pos, dir) {
      dust.setCone(pos, dir);
    },
  };
}

/**
 * Makes the scene's fog vary with view elevation instead of being one flat colour.
 *
 * three's FogExp2 blends every fragment toward a single constant. In a maze open
 * to a burning sky that is wrong twice over: fog near the ground should be the
 * dark red-black of the corridor, and fog high up — the murk you see against the
 * slot of sky — should glow, because that is where the light is coming from. One
 * constant means the top of a distant wall and the base of it fade to identical
 * mud, which is exactly what flattens depth.
 *
 * Patching every fogged material's shader is the cheap way to get this; there is
 * no per-frame cost, only a two-line change to the fog blend. Call once after the
 * scene is populated. Materials created later must be patched by their own owner.
 */
export function applyElevationFog(scene: THREE.Scene) {
  const skyFog = new THREE.Color(CFG.render.fogSkyColor);
  const patched = new WeakSet<THREE.Material>();

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat || patched.has(mat)) continue;
      // ShaderMaterial (the sky) opts out of fog entirely; nothing to patch.
      if (!(mat as any).fog) continue;
      patched.add(mat);

      const prev = mat.onBeforeCompile;
      mat.onBeforeCompile = (shader, renderer) => {
        prev?.call(mat, shader, renderer);
        shader.uniforms.uFogSkyColor = { value: skyFog };

        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <fog_pars_fragment>',
            `#include <fog_pars_fragment>
             uniform vec3 uFogSkyColor;`,
          )
          // three gives us vViewPosition = -mvPosition.xyz, i.e. the vector FROM the
          // fragment TO the camera, in view space. The camera->fragment ray is
          // therefore -vViewPosition. Rotating that into world space by the inverse
          // of the view matrix's rotation gives the world-space view direction, and
          // its Y is the elevation we want. viewMatrix's upper 3x3 is orthonormal,
          // so the inverse rotation is the transpose — which is what left-multiplying
          // a vector by the matrix (`v * M`) performs in GLSL.
          .replace(
            '#include <fog_fragment>',
            `#ifdef USE_FOG
               #ifdef FOG_EXP2
                 float elevFogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
               #else
                 float elevFogFactor = smoothstep(fogNear, fogFar, vFogDepth);
               #endif
               // Per-pixel, so the elevation tint varies across a single tall wall
               // rather than snapping per object.
               vec3 rayView  = normalize(-vViewPosition);
               vec3 rayWorld = normalize((vec4(rayView, 0.0) * viewMatrix).xyz);
               float elev = clamp(rayWorld.y * 1.6 + 0.30, 0.0, 1.0);
               vec3 elevFogCol = mix(fogColor, uFogSkyColor, elev * elev);
               gl_FragColor.rgb = mix(gl_FragColor.rgb, elevFogCol, elevFogFactor);
             #endif`,
          );
      };
      // Force a recompile for materials already used this frame.
      mat.needsUpdate = true;
    }
  });

  installBeamTune(scene);
}

/**
 * Live beam knobs for the capture harness, matching `__LIGHT_TUNE__` in game.ts
 * and `__POST_TUNE__` in post.ts.
 *
 * WHY THIS EXISTS. The readable 20-120 display band can be filled two completely
 * different ways, and the frame metrics that measure *how much* of it is filled
 * cannot tell them apart:
 *
 *   - a WIDE BEAM fills it with directional light, which arrives at a range of
 *     incidence angles across a surface, so N.L varies and relief reads;
 *   - AMBIENT FILL fills it with light that arrives equally from everywhere, so
 *     N.L is constant, nothing casts, and the band contains no architecture.
 *
 * Both raise `band20_120`. Only the first raises mid-frequency detail. A round
 * that optimised the band alone therefore pushed ambientIntensity 3.1 -> 18 and
 * hemiIntensity 11 -> 60, hit the band target, and dropped lit-pixel midFreq
 * from ~12 to 4.65 — which is the wave-1 failure level, reintroduced by the fix
 * for a different metric. The two axes have to be swept together and read
 * jointly, and that needs the live objects rather than a rebuild per sample.
 *
 * `angle`, `penumbra` and `decay` are constructor arguments to SpotLight and are
 * never re-read from CFG, so a config edit alone cannot move them at runtime;
 * this writes the light itself. `intensity` is recomputed every frame in
 * `updateFlashlight` as `CFG.flashlight.intensity * flickerValue`, so it is
 * pinned through a property override rather than assigned, or the next frame
 * stomps it.
 *
 * Harness-only. It reads nothing and changes nothing unless a caller invokes it.
 */
function installBeamTune(scene: THREE.Scene) {
  const w = window as unknown as Record<string, unknown>;
  if (w.__BEAM_TUNE__) return;

  w.__BEAM_TUNE__ = (o: {
    angle?: number; decay?: number; penumbra?: number; intensity?: number;
  }) => {
    let spot: THREE.SpotLight | null = null;
    scene.traverse((obj) => {
      if (!spot && (obj as THREE.SpotLight).isSpotLight) spot = obj as THREE.SpotLight;
    });
    if (!spot) return { error: 'no SpotLight in scene' };
    const s = spot as THREE.SpotLight;

    if (o.angle !== undefined) s.angle = o.angle;
    if (o.decay !== undefined) s.decay = o.decay;
    if (o.penumbra !== undefined) s.penumbra = o.penumbra;

    if (o.intensity !== undefined) {
      const rec = s as unknown as Record<string, unknown>;
      if (!rec.__pinned) {
        let held = s.intensity;
        Object.defineProperty(s, 'intensity', {
          // The per-frame write in updateFlashlight lands on the setter and is
          // discarded, so the pinned value survives; flicker is suspended for
          // the duration, which is what a fixed-camera comparison wants anyway.
          get() { return (rec.__pin as number) ?? held; },
          set(x: number) { held = x; },
          configurable: true,
        });
        rec.__pinned = true;
      }
      rec.__pin = o.intensity;
    }

    return {
      angle: s.angle, decay: s.decay, penumbra: s.penumbra, intensity: s.intensity,
    };
  };
}

/**
 * Minimal geometry merge. three's BufferGeometryUtils would do, but it pulls in
 * the examples tree; this handles the one case we need — same attributes, no index
 * reuse across inputs.
 */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'uv'];
  let totalVerts = 0, totalIndex = 0;
  for (const g of geos) {
    totalVerts += g.attributes.position.count;
    totalIndex += g.index ? g.index.count : g.attributes.position.count;
  }

  const buffers: Record<string, Float32Array> = {};
  const sizes: Record<string, number> = { position: 3, normal: 3, uv: 2 };
  for (const n of names) buffers[n] = new Float32Array(totalVerts * sizes[n]);
  const index = new Uint32Array(totalIndex);

  let vOff = 0, iOff = 0;
  for (const g of geos) {
    const count = g.attributes.position.count;
    for (const n of names) {
      const attr = g.attributes[n] as THREE.BufferAttribute;
      buffers[n].set(attr.array as Float32Array, vOff * sizes[n]);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[iOff + i] = g.index.getX(i) + vOff;
      iOff += g.index.count;
    } else {
      for (let i = 0; i < count; i++) index[iOff + i] = i + vOff;
      iOff += count;
    }
    vOff += count;
  }

  for (const n of names) out.setAttribute(n, new THREE.BufferAttribute(buffers[n], sizes[n]));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}
