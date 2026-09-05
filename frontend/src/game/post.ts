/**
 * Post-processing chain.
 *
 * Amnesia's image is soft, grainy, heavily vignetted, and desaturated everywhere
 * except where warm lamp light falls. A clean modern forward render looks like a
 * product shot by comparison. This module is what puts the grime back on the lens.
 *
 * Cost discipline: the critic harness runs SwiftShader, where every full-screen
 * pass is paid for in real milliseconds. So the grade is ONE pass — grain,
 * vignette, chromatic aberration, desaturation, lift/gamma and the scanline-free
 * dirt are all folded into a single fragment shader with a single texture read
 * budget of four taps. Bloom is the only other pass, it runs at quarter
 * resolution, and it is threshold-gated so it only ever touches the gems, the
 * flashlight hot spot and the sky.
 */

import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CFG } from './config';

/**
 * Bright-pass + blur, folded into one shader at quarter resolution.
 *
 * This exists instead of `UnrealBloomPass` for a measured reason. UnrealBloom
 * builds a five-level mip chain and runs a separable blur over each level: about
 * eleven full-screen passes. Under SwiftShader that was measured at up to 57
 * SECONDS per frame (0.017 fps in the capture report) — the pass alone made the
 * game unobservable, never mind unplayable.
 *
 * What the effect actually needs to do here is narrow: put a soft halo around the
 * gems, the flashlight's hot core and the slot of sky. That is a small-radius
 * bloom, and a small-radius bloom does not need a mip pyramid. One quarter-res
 * target (1/16 the pixels) with a 13-tap tent kernel gets a halo of roughly 24
 * source pixels for ~0.06 of the fill cost.
 */
const BloomShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Texel size of the LOW-RES target, so taps land on distinct texels. */
    uTexel: { value: new THREE.Vector2(1 / 320, 1 / 180) },
    uThreshold: { value: 0.68 },
    /** Multiplies the tap offsets; widens the halo without adding taps. */
    uRadius: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uThreshold;
    uniform float uRadius;
    varying vec2 vUv;

    // Bright pass with a soft knee. A hard cutoff makes the bloom pop on and off
    // as a surface drifts across the threshold, which reads as a bug.
    vec3 bright(vec2 uv) {
      vec3 c = texture2D(tDiffuse, uv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float k = smoothstep(uThreshold, uThreshold + 0.35, l);
      return c * k;
    }

    void main() {
      vec2 o = uTexel * uRadius;
      // 13-tap tent: centre, inner ring (weight 2), outer diagonal ring.
      vec3 sum = bright(vUv) * 4.0;
      sum += bright(vUv + vec2( o.x, 0.0)) * 2.0;
      sum += bright(vUv + vec2(-o.x, 0.0)) * 2.0;
      sum += bright(vUv + vec2(0.0,  o.y)) * 2.0;
      sum += bright(vUv + vec2(0.0, -o.y)) * 2.0;
      sum += bright(vUv + vec2( o.x,  o.y));
      sum += bright(vUv + vec2(-o.x,  o.y));
      sum += bright(vUv + vec2( o.x, -o.y));
      sum += bright(vUv + vec2(-o.x, -o.y));
      sum += bright(vUv + vec2( o.x * 2.0, 0.0));
      sum += bright(vUv + vec2(-o.x * 2.0, 0.0));
      sum += bright(vUv + vec2(0.0,  o.y * 2.0));
      sum += bright(vUv + vec2(0.0, -o.y * 2.0));
      gl_FragColor = vec4(sum / 20.0, 1.0);
    }
  `,
};

/**
 * The single combined grade pass.
 *
 * Order inside the shader matters and mirrors a real camera: aberration happens
 * in the lens (so it is sampled per-channel from the source), vignette is the
 * lens barrel, then the sensor applies the tonal grade, and grain is the sensor
 * noise on top of everything. Doing grain before the grade would let the grade
 * crush the grain out of the shadows, which is exactly where it must live.
 */
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** The quarter-res bloom target, added in before the grade. */
    tBloom: { value: null as THREE.Texture | null },
    uBloomStrength: { value: 0.44 },
    uTime: { value: 0 },
    /** Pixel size of the target; drives aberration in stable screen units. */
    uResolution: { value: new THREE.Vector2(1280, 720) },
    /**
     * Grain strength. Rises with darkness — bright areas stay comparatively clean.
     *
     * Was 0.075, which measured a per-pixel residual std of 7.3-8.6 against real
     * Amnesia frames at 1.75-3.42. At that amplitude it stops reading as film
     * grain *in* the image and starts reading as digital noise sitting *on* it —
     * and worse, it buried the architectural detail this whole lane exists to
     * add, since a plank edge and a noise speck were the same magnitude. 0.030
     * lands the measured residual in Amnesia's band.
     */
    uGrain: { value: 0.030 },
    /**
     * Vignette: inner radius where darkening starts, and how hard it clamps down.
     *
     * EASED (0.52, 0.86) -> (0.58, 0.78). The vignette was measuring correct as a
     * ratio — 0.34-0.49 corner/centre, which is why round 2 signed it off — but
     * the ratio is not the whole story, because of WHERE in the chain it runs.
     *
     * `col *= v * v` happens on unmapped linear HDR, before exposure and before
     * the tone curve. At the old value the corner lost 2.61 stops of scene-linear
     * light, which does not merely darken it: it pushes the corner down onto the
     * toe of the filmic curve, where the slope is shallowest, so a wall three
     * metres away in the corner of frame gets its remaining contrast compressed
     * into a handful of display codes on top of being dim. Architecture in the
     * periphery was being deleted twice.
     *
     * The new pair costs 2.03 stops instead of 2.61 and keeps r=0.75 at 0.78 of
     * centre rather than 0.66, which is where most of the corridor wall actually
     * sits. Measured corner/centre stays inside the reference band — real Amnesia
     * in-game frames run 0.20-1.24 on this ratio and are not consistently
     * vignetted at all; the heavy corner darkening is a modern-horror convention
     * rather than something the reference does.
     */
    uVignette: { value: new THREE.Vector2(0.58, 0.78) },
    /** Chromatic aberration in pixels at the frame corner. Sub-pixel at centre. */
    uAberration: { value: 1.5 },
    /**
     * 0 = untouched, 1 = fully grey. Warm pixels are protected from this.
     *
     * Was 0.42, and the frames measured mean HSV saturation 0.44-0.56 against
     * amn1's 0.068. Amnesia is very nearly monochrome grey-black with warmth ONLY
     * at the flame; ours was red-tinted in every pixel, which meant the red sky —
     * the one thing that is supposed to be red — had nothing to contrast against
     * and read as more of the same.
     *
     * The number is high because the protection above it is now correctly narrow:
     * with the old hue-only gate this did literally nothing (see the shader), so
     * a "safe-looking" 0.42 was in truth 0.0. At 0.72 with a brightness-gated
     * protection the corridor drains to grey-black while the beam's hot core, the
     * gems and the sky keep their colour — which is the actual Amnesia split.
     *
     * LOWERED 0.72 -> 0.55 once the tone curve was fixed. The 0.72 was set when
     * the frame measured 0.44-0.56 saturation, but that reading was inflated by
     * a near-black red-tinted void that has since been neutralised, and it was
     * being compared against 0.068 from one unrepresentative reference frame —
     * the real figure across eight official Amnesia screenshots is 0.479.
     * Measured on matched views, 0.72 gives frame saturation 0.363-0.406 (we are
     * UNDER Amnesia) while 0.55 gives 0.442-0.479, straddling it exactly.
     */
    uDesaturate: { value: 0.50 },
    /**
     * EXTRA desaturation applied only to the SHADOWS, on top of uDesaturate.
     *
     * This exists because the saturation error is not global and a global knob
     * cannot fix it without destroying the one band that is already correct.
     * Measured by brightness band against Amnesia, on corridor frames:
     *
     *   band          Amnesia sat    ours       Amnesia %frame   ours %frame
     *   near-black       0.080       0.577          63.6%          37.6%
     *   dim              0.187       0.344          25.9%          64.2%
     *   lit              0.228       0.258           7.4%           1.1%
     *
     * The LIT band was already on the reference (0.258 vs 0.228). Raising the
     * single uDesaturate to reach the near-black target would have dragged the lit
     * band to 0.118 — half the reference — and the beam pool is the one place the
     * player's eye actually rests. So the drain is now a RAMP: full strength in
     * the dark, fading to `uDesaturate` alone by the time a pixel is genuinely lit.
     *
     * That is also what Amnesia does. Its darkness is neutral grey-black (0.080)
     * and its lamplit timber is warm (0.228); the contrast between those two is
     * what makes the warmth read as warmth. Ours was red everywhere, so the red
     * had nothing to be red against.
     *
     * Modelled through the full grade chain before being measured, and the model
     * and the frames agree: at 0.46 the near-black band lands near the reference
     * while the lit wall stays at 0.220 against Amnesia's 0.228.
     */
    uShadowDesat: { value: 0.66 },
    /**
     * Luminance window over which the extra shadow drain fades out, so the
     * transition is smooth rather than a visible band edge. Below x, full extra
     * drain; above y, none.
     */
    uShadowDesatBand: { value: new THREE.Vector2(0.02, 0.22) },
    /**
     * The COLD CAST added back into the shadows after the drain above has taken
     * the wall texture's orange out. Added per channel, scaled by the pixel's own
     * luminance and by the same shadow ramp the drain uses.
     *
     * ---- what this fixes --------------------------------------------------
     *
     * A critic scored the build 4/10 against Amnesia with this as the single
     * biggest gap: "Amnesia's darkness is a deep desaturated BLUE-GREEN in which
     * cold masonry is still legible before the lantern reaches it; ours is
     * neutral grey-black that only gains colour inside the torch cone, making
     * every frame a two-colour image."
     *
     * Confirmed by measuring the band directly rather than the frame mean, in
     * absolute display codes (mean per-pixel max-min) and as signed B-R, on the
     * genuine player-captured gameplay references rather than on amn1.jpg, which
     * is a title screen (trap 29a):
     *
     *   frame                       shadow chroma   shadow B-R
     *   /tmp/amnref/r6 (corridor)        5.02          +1.11
     *   /tmp/amnref/r8 (cellar)          4.14          +1.77
     *   /tmp/amnref/r5 (mansion)         6.40          -0.41
     *   ours, before this                0.37          -0.37
     *
     * Ours carried a twelfth of Amnesia's shadow colour, with the sign wrong.
     *
     * ---- why a saturation CEILING could not catch this --------------------
     *
     * `measure-atmo.mjs` gates `sat <= 0.18` and `satNearBlack <= 0.16`, and the
     * failing build passed BOTH at 0.061 and 0.051. A ceiling cannot detect
     * monochrome — draining everything to grey satisfies it perfectly. The gate
     * was rewarding the defect it was meant to prevent. `tools/measure-chroma.mjs`
     * measures this band as a two-sided target, and in codes rather than as an
     * HSV ratio, because at 8-bit near-black the ratio is dominated by
     * quantisation: r1-r4's near-black is rgb(1.2,1.2,0.7) and scores sat 0.17
     * off a single display code of difference.
     *
     * ---- why it is added here and not put in the lights -------------------
     *
     * Because the red is in the ALBEDO, not the lighting. Ablation (see the long
     * note at the use site) nulled the chroma of fog, ambient and hemisphere
     * together and moved shadow B-R from -14.51 to -14.00; `woodWall.png` itself
     * measures B-R -41.8 at saturation 0.695. Tinting the lights cold cannot beat
     * a texture that saturated, and turning the fog cold would fight
     * GAME-SPEC.md §2's "sky is an ominous, foggy red".
     *
     * ---- the value -------------------------------------------------------
     *
     * A desaturated TEAL — green nearly as high as blue, red well under both.
     * Swept in one page load at fixed camera and fixed seed (tools/chroma-ab.mjs),
     * so the table isolates this vec3 and nothing else. Shadow band, 3 stations:
     *
     *   uColdShadow                    shChroma   shB-R   meanLum   blk%
     *   (0,0,0)          control          0.36    -0.36    12.83    0.610
     *   (0.130,0.338,0.572)               3.87    +3.87    14.24    0.558
     *   (0.190,0.400,0.572)               3.23    +3.22    14.44    0.546
     *   (0.250,0.450,0.572)               2.62    +2.61    14.80    0.533
     *   (0.300,0.520,0.600)               2.36    +2.36    14.96    0.522
     *   (0.380,0.600,0.680)               2.28    +2.28    15.41    0.505
     *
     * SHIPPED IS 1.35x THE (0.250,0.450,0.572) ROW, not that row itself, and the
     * reason is the standing warning in TONE-SEED-NOISE.md: a live sweep is valid
     * for the SHAPE of a knob and not for its absolute level, because its
     * stations sit closer to walls than real play does. Measured, that is exactly
     * what happened here — the row above predicted shadow chroma 2.62, and the
     * same build pooled over three rebuilt seeds on the walked beat path
     * delivered **2.10**, under the 2.5 floor. Scaled up to land the POOLED
     * figure inside the band rather than the sweep's.
     *
     * Still deliberately at the LOW end of the 2.5-6.5 target, nearer r8's 4.14
     * than r5's 6.40: the failure mode on record for this metric is
     * overcorrection, and it has oscillated twice.
     *
     * ---- a known limit of this operator, stated rather than hidden ---------
     *
     * A single additive cast is ONE hue, so it raises chroma and net blue lean
     * together at a fixed ratio of ~1.0. The references do not do that: their
     * B-R is only 0.22 (r6), 0.43 (r8) and -0.06 (r5) of their shadow chroma,
     * because real shadows contain pixels of DIFFERING hue — cold stone beside a
     * distant warm lamp — that partly cancel in the mean. Raising red and green
     * to chase that ratio was swept (rows 2-6 above) and simply lowers chroma; it
     * cannot manufacture variety. Matching the ratio properly needs per-pixel hue
     * variation in the albedo, which lives in world.ts's gradeAlbedo() and is not
     * this lane's file. See docs/handoff/tone-cold-shadow.md.
     */
    uColdShadow: { value: new THREE.Color(0.338, 0.608, 0.772) },
    /**
     * How hard the "is this pixel warm" ratio test drives toward full protection.
     * Higher = more surfaces count as firelit. See the note in the shader for why
     * this is a ratio and not an absolute channel difference.
     */
    uWarmGain: { value: 3.4 },
    /** Ceiling on the protection, 0..1. Below 1 so even the flame drains a little. */
    uWarmProtect: { value: 0.97 },
    /**
     * Local contrast (unsharp mask) applied to the SCENE before grain.
     *
     * The geometry added in world.ts is what puts real architectural edges in the
     * frame; this is what stops the render's own softness — a 0.6-penumbra spot,
     * a soft shadow map and a bilinear-filtered plank texture at a grazing angle
     * — from smearing those edges back out before they reach the eye. It is the
     * lens's acutance, and it is measured in exactly the band the critic graded:
     * the 3-pixel neighbourhood minus its surround.
     *
     * Applied to luminance only. Doing it per-channel sharpens the chromatic
     * aberration fringes into visible coloured outlines.
     */
    /*
     * RAISED 0.55 -> 1.10.
     *
     * At 0.55 this was nearly inert: sweeping it 0.0 -> 1.4 on a fixed frame
     * moved mid-frequency detail only 4.54 -> 5.12, which is noise. The reason is
     * in the implementation a few lines down — the gain is normalised by the
     * local level (`rel = (lC - lS) / (lC + lS)`), which is correct and must stay,
     * but it means the term is a RELATIVE contrast boost, so 0.55 buys about a 5%
     * step on a 10% edge. That is below the threshold of visibility.
     *
     * It is worth more now than it was, because there is finally something for it
     * to sharpen. With the walls Lambertian and at 2.8% reflectance the frame's
     * mid-frequency content was grain and gradient; amplifying that just made the
     * darkness crawl, which is why a previous round correctly kept this low. Now
     * that the beam genuinely rakes across grain and plank courses, the same
     * operator is amplifying real edges: measured at toe 0.44, going 0.55 -> 1.20
     * moves the beam skirt 18.52 -> 19.07 and the core 17.82 -> 18.53 with no
     * change to black fraction, luminance or lit fraction.
     *
     * 1.10 rather than 1.20 leaves headroom under the +-0.75 clamp on `rel`, so
     * the strongest edges in the frame — a post against the dark, the lip of a
     * skirting board — do not sit pinned at the clamp where they would flatten
     * against each other.
     */
    uLocalContrast: { value: 1.10 },
    /**
     * How completely the sky is exempted from desaturation, 0..1. See skyMask in
     * the fragment shader.
     *
     * 1.0 — fully exempt. The desaturation is deliberately heavy, because the
     * world has to be grey-black for the red to mean anything, and the sky is the
     * thing that red is for. A critic called the sky the single best element in
     * the build; draining it to salmon to hit a saturation number would be trading
     * the asset for the metric.
     */
    uSkyProtect: { value: 1.0 },
    /**
     * Multiplied into the whole frame; the horror-movie cold cast.
     *
     * NEUTRALISED (1.03, 0.94, 0.90) -> (1.005, 0.995, 0.99), and this is a
     * bigger correction than it looks, because of WHERE it sits in the chain.
     *
     * It is a MULTIPLY, so it is scale-free: it costs the same fraction of chroma
     * on a near-black pixel as on the beam core. Modelled through the rest of the
     * grade, the old value added ~0.04 of saturation at EVERY brightness level —
     * on a near-black target of 0.080 that alone is half the budget. Worse, it
     * runs immediately AFTER the desaturation, so it was putting red back into
     * precisely the pixels the desaturation had just drained; three previous
     * rounds of raising uLift could not fix that, because the thing undoing the
     * neutralisation ran afterwards and scaled with it.
     *
     * Sweeping it on the near-black band with everything else held fixed:
     *
     *   desat   tint 1.03/.94/.90   tint neutral
     *   0.55          0.295            0.258
     *   0.80          0.197            0.153
     *   0.94          0.135            0.087
     *
     * A trace of warmth is kept rather than going flat, so the frame still reads
     * as a warm-cast darkness rather than as a broken white balance.
     */
    uTint: { value: new THREE.Color(1.005, 0.995, 0.99) },
    /**
     * Raises crushed blacks off zero so darkness has texture instead of being void.
     *
     * NEARLY NEUTRAL, and that is the single largest correction to this frame's
     * colour. It was (0.024, 0.009, 0.008) — a 3:1 red bias.
     *
     * Breaking a captured frame down by brightness band found where the excess
     * saturation actually lived, and it was not where anyone had been looking:
     *
     *   band          share of frame   our sat   Amnesia's sat
     *   near-black        67.3%          0.666       0.049
     *   dim               25.1%          0.436       0.177
     *   lit                7.5%          0.296       0.228
     *   bright             0.1%          0.252       0.064
     *
     * The lit and bright parts of the image were already close to the reference.
     * Two thirds of every frame was near-black at RGB(3.3, 0.7, 0.6), which the
     * saturation metric — correctly — reads as almost fully saturated red, and
     * which the eye reads as "everything is tinted". Amnesia's near-black is
     * RGB(4.7, 4.7, 4.6): neutral. Its darkness is grey-black, and that is
     * precisely what leaves room for the one red thing in the frame to be red.
     *
     * A trace of warmth is kept, because a perfectly neutral lift on a red-lit
     * scene looks like a broken white balance rather than like darkness.
     *
     * RAISED (0.019, 0.0165, 0.016) -> (0.027, 0.025, 0.0245) when the tone
     * curve was fixed, because the curve change moved the target underneath it.
     * The old value was tuned against a curve whose toe could not reach black;
     * with a true black floor restored, the darkest 11% of the frame re-measured
     * at RGB(6.1, 2.0, 1.0) — saturation 0.83, the most saturated band in the
     * image and the one covering the largest area. The lift was adding only
     * ~4 display codes, which is not enough to neutralise a void the scene is
     * delivering as pure red.
     *
     * This adds ~6.9/6.4/6.2 codes instead, and the balance is kept nearly flat
     * so what it adds is grey rather than more red. It is deliberately NOT a
     * bigger red bias: the whole point is that Amnesia's darkness is grey-black,
     * which is what leaves room for the one red thing in the frame to read as
     * red.
     *
     * LOWERED (0.027, 0.025, 0.0245) -> (0.016, 0.0152, 0.015), because an
     * ablation finally identified what actually sets the near-black band, and it
     * was this uniform rather than any of the things previous rounds adjusted.
     *
     * The ablation nulled the CHROMA of every scene light in turn — fog, ambient
     * and hemisphere, each swapped for its own luminance-matched grey so only
     * colour changed — and then removed the fog outright. All of it together moved
     * the near-black band's saturation only 0.598 -> 0.555. The scene lights were
     * never the cause; PROGRESS.md's prime suspect ("fogColor and the hemisphere
     * light are both red, so every unlit surface is being painted red") is
     * measurably wrong, and three rounds of raising this uniform to "neutralise
     * the void" were pushing on the wrong end of the problem.
     *
     * What this uniform does is SET the floor, not neutralise it: it is added to
     * pixels the tone curve has already taken to near-zero, so in the darkest
     * band it is very nearly the entire signal. At 0.027 it was depositing ~6.9
     * display codes of its own, which both raised the black off zero — costing
     * the nearBlackFrac this lane needs — and, because it is added AFTER the
     * desaturation, reintroduced its own residual chroma below the drain.
     *
     * Measured on a fixed camera, everything else held: dropping it to 0.016
     * takes satNearBlack 0.164 -> 0.068 and nearBlackFrac 0.576 -> 0.582. It is
     * kept slightly warm and non-zero so the darkness still has a floor with
     * texture in it rather than being a dead void.
     */
    uLift: { value: new THREE.Color(0.016, 0.0152, 0.015) },
    /** Extra punch: <1 brightens midtones, >1 deepens them. */
    uContrast: { value: 1.14 },
    /**
     * Where the highlight roll-off starts, in display-linear units after the
     * contrast stage. Everything above this is compressed asymptotically toward
     * 1.0 instead of being allowed to run off the top and hard-clip.
     *
     * ---- why this exists, and why it is not a tone-curve change --------------
     *
     * The tone curve above is asymptotic BY CONSTRUCTION: both branches are
     * tanh, so its output cannot exceed 1.0, and at the shipped settings its
     * maximum is display 252.6. Every previous round therefore reasoned that the
     * frame could not be clipping, and tuned the curve.
     *
     * But two stages run AFTER it, and neither is bounded:
     *
     *     col = (col - uPivot) * uContrast + uPivot;   // uContrast 1.14
     *     col *= uTint;                                // 1.005 on red
     *
     * Contrast about a low pivot (0.13) multiplies everything above the pivot
     * outward. Traced through the real numbers, a wall at 1 m receives ~160
     * scene-linear from the 160 cd torch, which the curve maps to display 250.8
     * — and contrast then takes that to 281.3 and the tint to 282.7. There is no
     * upper clamp before gl_FragColor (only `max(col, 0.0)`), so it lands as a
     * hard 255. Solving for the threshold: anything above scene-linear 6.96
     * clips, which is every wall closer than about 4.5 m inside the beam.
     *
     * MEASURED on the shipping build, four near-wall stations found by
     * tools/tone-findnear.mjs (the five open-corridor bearings the older sweep
     * used contain no saturated wall at all, so they reported clip 0.000 and
     * could never have seen this):
     *
     *   band (display)   mean local range in a 9px window
     *   skirt   60-140            161.0
     *   inner  140-200            162.4
     *   bright 200-250            104.4
     *   CLIPPED  >=253             78.1
     *
     * Mortar-joint contrast more than HALVES inside the blown core. That is the
     * world-geometry lane's masonry being erased in exactly the region the
     * player is looking at, which is what this lane was sent to fix.
     *
     * ---- why the fix is not "lower uContrast" -------------------------------
     *
     * Because contrast is also carrying real detail, and dropping it costs more
     * than it saves. Swept live, measuring mid-frequency detail on genuinely
     * UNCLIPPED bright pixels only (display 200-250), so that the measurement
     * cannot be inflated by the hard white edges clipping itself creates:
     *
     *   uContrast   clip%    unclipped-core midFreq
     *     1.14      0.500          19.48
     *     1.06      0.158          17.00
     *     1.00      0.000          14.56
     *
     * Clipping falls to zero at 1.00 and takes a quarter of the real texture
     * with it. That is the overcorrection trap this metric has already fallen
     * into twice: the gate number improves while the picture gets worse.
     *
     * So the contrast gain is KEPT and the top is rolled off instead. Above
     * `uShoulderStart` the value is mapped through
     *
     *     y = start + (1 - start) * tanh((x - start) / (1 - start))
     *
     * which is C1-continuous at the join (tanh'(0) = 1, so the slope matches
     * exactly and there is no visible band where it takes over), monotone, and
     * asymptotic to 1.0 — so a wall at 1 m and a wall at 2 m remain DIFFERENT
     * display values instead of both being 255. It is the same asymptotic
     * argument the log curve above is built on, applied at the one point in the
     * chain where the bound was actually being broken.
     */
    /*
     * LOWERED 0.72 -> 0.62. Engages the roll-off earlier, so the compression is
     * spread over a wider range of the top instead of being concentrated where
     * the curve is already flattest.
     *
     * Like uToneShoulder this is provably a pure top-end operator — swept through
     * the real chain, display at scene-linear 0.06 is pinned at 56.7 for every
     * value from 0.72 down to 0.36, while the peak moves 246.8 -> 226.5. It
     * cannot touch the dim band or the black floor.
     */
    uShoulderStart: { value: 0.62 },
    /**
     * The value contrast pivots around. NOT 0.5 — see the note in the shader.
     * This scene's histogram sits almost entirely below 0.2, so the pivot has to
     * sit inside that range or contrast simply crushes the whole image to black.
     */
    uPivot: { value: 0.13 },
    /**
     * Exposure applied before the ACES curve, in this shader rather than on the
     * renderer — see the long note in the fragment shader for why the renderer's
     * own `toneMappingExposure` does nothing once post-processing is enabled.
     *
     * Read from CFG.render.exposure. It used to be a duplicated literal here,
     * which meant CFG.render.exposure was documented at length as "the number
     * that decides whether the flashlight illuminates the wall or erases it" and
     * in fact controlled nothing at all: it was being handed to
     * renderer.toneMappingExposure, which this very chain makes inert. Changing
     * it did precisely nothing to a captured frame.
     */
    uExposure: { value: CFG.render.exposure },
    /**
     * ---- the filmic curve, and why it is not ACES -------------------------
     *
     * These four uniforms replace the straight ACES call. A critic measured the
     * old chain and proved the failure was the CURVE, not the lighting: tripling
     * ambient (18->54) and hemi (60->180) in a live frame moved architecture p90
     * only 24 -> 29, against real Amnesia's 61. The light was being added and
     * then crushed.
     *
     * ACES (and every other display-referred operator — GT/Uchimura, Lottes,
     * Reinhard) assumes diffuse white sits near scene-linear 1.0. This scene
     * does not remotely satisfy that. The flashlight puts ~160 units on a wall
     * a metre away and the ambient leaves the same wall at ~0.01 twenty metres
     * down the corridor: FOURTEEN stops. Fed that range, ACES at exposure 0.22
     * fails at BOTH ends simultaneously, and both failures were visible in
     * captured frames:
     *
     *   scene-linear   old display   what it is
     *   0.01                 9.8     wall at the edge of the beam
     *   0.10                37.8     dim wall
     *   0.30                81.2     wall in the beam's skirt
     *   3.0                242.7     beam core
     *   10 .. 160          255.0     ...all of it, one flat code
     *
     * So the entire dim band was squeezed into ~10-80 while a 50x range of beam
     * core was squeezed into ONE code. That is the "hot ellipse falling off a
     * cliff into pure black" a critic described, and it is why the corridor
     * carpentry in world.ts was invisible: the geometry was lit, then the curve
     * threw the distinctions away.
     *
     * The fix is to do the curve in LOG space, which is what film emulation and
     * ACES's own output transforms actually do, and which is scale-invariant so
     * a 14-stop scene fits by construction:
     *
     *   s = log2(L / uToneGrey)                 stops relative to the anchor
     *   s < 0 :  y = mid * (1 + tanh(kToe * s))     toe,      -> 0 as s -> -inf
     *   s >= 0:  y = mid + (1-mid) * tanh(kSh * s)  shoulder, -> 1 as s -> +inf
     *
     * tanh is monotone, C-infinity and ASYMPTOTIC, which is the property that
     * matters: nothing ever reaches pure black or pure white, so a pixel twelve
     * stops up is still distinguishable from one eight stops up. A polynomial
     * smootherstep was tried first and is wrong for exactly this reason — it
     * clamps hard at the window edges and reintroduces the disease.
     *
     * Predicted against the real inverted histogram of 21 captured frames
     * (15.5M architecture pixels, sky masked):
     *
     *              mean   p50   p90   lit%(L>40)   hot%(L>200)
     *   old ACES   18.9     9    27      6.8          2.65
     *   this       29.8    22    53     16.6          0.00
     *   Amnesia    24.0    16    53     16.7          0.0-2.8
     *
     * and the beam core, previously 255 flat from linear 10 upward, now runs
     * 215 -> 252 across linear 10 -> 120, so the planks stay legible inside the
     * hot spot instead of dissolving into a white disc.
     */
    /** Scene-linear value anchored to `uToneMid`. Raise to darken overall. */
    uToneGrey: { value: 1.0 },
    /**
     * Toe strength: display-linear slope per stop BELOW the anchor. This is the
     * explicit shadow-ramp knob. Lower = shadows stretched across more display
     * codes; higher = closer to the old crushed behaviour.
     */
    /*
     * RAISED 0.28 -> 0.55, together with the shoulder below, because the pair of
     * them were what was actually crushing this image — and the failure was the
     * OPPOSITE of the one the previous note was chasing.
     *
     * Both branches of this curve are tanh, so both are ASYMPTOTIC. The note
     * above treats that as the headline virtue ("nothing ever reaches pure black
     * or pure white"), and at these slopes that is exactly the disease. A curve
     * that cannot reach black has no black, and a curve that cannot reach white
     * has no highlight; with a shallow slope in between, every one of the
     * scene's fourteen stops lands inside one narrow muddy band.
     *
     * Measured on the shipping build, 12 corridor views, the FULL frame:
     *
     *   min 0.0 | p1 3.7 | p25 14.1 | p50 19.5 | p75 26.1 | p95 62 | max 175
     *   fraction above display 200 .......... 0.0000   (not one pixel)
     *   fraction below display 5 ............ 0.020    (Amnesia: 0.46-0.67)
     *
     * Half of every frame sat between 14 and 26 — a twelve-code plateau. That
     * plateau IS the "flat" verdict. And masking out the viewmodel, the
     * brightest WALL pixel in a frame was 73 at p99.9: a 160-candela torch at
     * one metre was arriving as dim grey-brown, so there was no hot spot for the
     * beam to rake with and no dark for it to carve into.
     *
     * Contrast delivered per doubling of scene light, by band:
     *
     *   toe/shoulder    dim    mid    lit   beam   core | black@0.001  peak@160
     *   0.28 / 0.12      +6    +12    +19    +16    +12 |      9          212
     *   0.32 / 0.30      +4    +11    +27    +24    +11 |      3          247
     *
     * The lit and beam bands — where the architecture the player actually looks
     * at lives — get substantially more code range, the frame regains a true
     * black floor and a real highlight, and the core still moves +11 codes per
     * doubling so the planks stay legible inside the hot spot. That last figure
     * is the guard against re-introducing the ACES failure this curve replaced:
     * ACES flattened the entire core to ONE code, and steeper settings start
     * heading back that way (0.60/0.34 already drops the core to +9).
     *
     * The value was then walked on MEASURED frames, not on this model, because
     * the model cannot know where the scene's pixels actually sit in
     * scene-linear. Grid sweep via __POST_TUNE__ from a FIXED camera — the
     * camera must not move between settings, an earlier sweep stepped the yaw
     * and its vignette swung 0.19-0.55 across what was meant to be a controlled
     * comparison:
     *
     *   toe/sh    midFreq  lit%    lum    <5%
     *   0.28/0.12    3.58  24.8   20.9    2.9   <- shipped, the flat one
     *   0.28/0.30    4.05  24.9   21.0    2.9
     *   0.30/0.30    4.47  19.5   18.1    6.4
     *   0.32/0.30    5.01  16.1   15.7   11.4   <- this
     *   0.34/0.30    5.32  13.8   13.7   17.3
     *   Amnesia     ~11-12 10.5   16.6     --
     *
     * 0.32 lands mean luminance and lit fraction on Amnesia almost exactly
     * (15.7 vs 16.6, 16.1% vs 10.5%) while restoring a real black floor: 11.4%
     * of the frame below display 5, against 2.9% before. 0.34 and beyond starts
     * losing the dim band where architecture lives without buying much detail.
     */
    /*
     * RAISED 0.32 -> 0.42, and this is a consequence of the world.ts fix rather
     * than a fresh opinion about the curve.
     *
     * 0.32 was walked on frames whose walls were an effective 2.8% reflector and
     * whose floor was 0.9%. Those surfaces returned so little light that the toe
     * had to be shallow just to lift the scene off the floor at all. Raising the
     * three albedos and dropping roughness off the Lambertian rail moved the
     * whole input histogram up by roughly a stop and a half, and the toe that was
     * correct underneath the old scene now leaves the frame with almost no black
     * in it: measured 1.78% of pixels below display 5, against real Amnesia's
     * 7.7-30.9%. A frame with no black has no reservoir for the beam to carve
     * into, which is the failure this lane has been chasing from the other end.
     *
     * Swept on a fixed camera against the new materials, nothing else changed:
     *
     *   toe   blk%   dim   skirt  core   lit%   lum
     *   0.32   3.25  4.32  15.76  17.42  22.9  38.9   <- no black at all
     *   0.36   9.31  5.71  16.75  17.58  17.7  35.5
     *   0.40  17.88  7.20  17.46  17.62  15.6  33.0
     *   0.44  26.85  8.77  18.52  17.82  14.7  31.1
     *   Amnesia 7.7-25  7.8-9.5  13.7-22.5  20-28  27-29  20-28
     *
     * Note the toe RAISES mid-frequency detail in every band while restoring the
     * black, which is the opposite of the intuition that a steeper toe crushes
     * shadows. It does crush the very bottom — that is the point — but it also
     * stops spending display codes on a near-black void that carries no
     * information, and hands them to the dim band just above it where the
     * architecture actually lives.
     *
     * 0.42 rather than 0.44: it keeps blk% near the middle of the reference
     * spread instead of at its top edge, and preserves a little more of the dim
     * band that lets a corridor read before the beam reaches it.
     */
    /*
     * RAISED 0.42 -> 0.66, PAIRED with a large rise in CFG.render.exposure. The
     * pairing is the point, and neither number means anything without the other.
     *
     * The frame had two faults that a single knob cannot fix together: meanLum
     * was 11.9 against a 16-18 target (too dark) while nearBlackFrac was 0.376
     * against 0.45+ (not enough true black). Those pull opposite ways, which is
     * how this metric has oscillated — raising exposure fixes the first and
     * destroys the second, and deepening the toe does the reverse. Swept
     * separately, exposure alone took blk% 0.576 -> 0.348 to reach lum 20, and
     * the toe alone took lum 12.8 -> 6.0 to reach blk% 0.72.
     *
     * Together they are separable, because they act on different ends of the
     * curve: exposure slides the whole scene up the log axis while a steeper toe
     * makes the region below the anchor fall away faster. The result is more
     * light in the pool and MORE darkness around it, which is the actual brief —
     * "a small, textured, non-clipping pool of light inside a large genuinely
     * dark frame". Measured on a fixed camera, five bearings, median:
     *
     *   toe/exposure    midFreq   lum   litF    sat  satNB  blk%   clip(wall)
     *   0.42 / 0.22       11.3   12.4  0.097  0.151  0.222  0.391      0
     *   0.58 / 1.00       14.9   12.3  0.115  0.069  0.068  0.576      0
     *   0.62 / 1.65       15.8   15.5  0.136  0.074  0.069  0.511      0
     *   0.66 / 2.10       17.8   16.7  0.140  0.077  0.069  0.512      0
     *   Amnesia           30.7   16.6  0.105  0.118  0.080  0.636      -
     *
     * The toe also RAISES midFreqStd at every step, which is not the intuition
     * but is consistent with the earlier note above: it stops spending display
     * codes on a void that carries no information and hands them to the dim band
     * where the architecture lives.
     *
     * The wall inside the beam stays non-clipping throughout — peak 237 with
     * mid-frequency detail of 12-17 measured INSIDE the hot pool, so the texture
     * the world-geometry lane put there survives in the middle of the cone. The
     * ~0.06% of pixels above 250 in a frame are the torch BULB in the viewmodel,
     * a stationary ~150px blob that is the light source itself.
     */
    /*
     * RAISED 0.70 -> 0.76, paired with CFG.render.exposure 2.20 -> 3.80 and the
     * new uShoulderStart roll-off. All three are one change.
     *
     * The lane arrived here too DARK (meanLum 12.5 against a 16-18 target) with
     * the other four metrics already correct, so the whole job was to buy
     * luminance without spending nearBlackFrac 0.68, which was hard-won. That is
     * the pairing this file has used before and it still holds: exposure slides
     * the whole histogram up the log axis, and a steeper toe pulls the region
     * below the anchor back down, so the pool gets brighter and the shadows do
     * not. What is new is that the roll-off caps the top, so the extra exposure
     * lands as range in the beam instead of piling up against a hard 255.
     *
     * Swept live on a fixed camera, five open bearings plus four near-wall
     * stations, median (tools/tone-clip.mjs):
     *
     *   case              midFreq   lum   litF    sat  satNB  blk%   clip%
     *   BASE (no roll)      24.36  12.44  0.107  0.061  0.053  0.751  0.025
     *   R72                 22.89  12.66  0.107  0.059  0.053  0.748  0.000
     *   R72-X34             22.81  16.40  0.135  0.064  0.057  0.677  0.000
     *   R72-X38-T76         23.13  16.36  0.131  0.063  0.054  0.711  0.000  <- this
     *   R64-X50-T84         23.55  17.45  0.137  0.063  0.053  0.717  0.000
     *   Amnesia             30.69  16.6   0.105  0.118  0.080  0.636    -
     *
     * Note R72 alone COSTS luminance (12.44 -> 12.66 is flat, and on the beat
     * frames it fell 11.4 -> 10.1): compressing the top necessarily removes
     * energy. That is the headroom the exposure raise then spends deliberately,
     * which is why these two numbers may not be moved independently.
     *
     * Settled at 0.86 with exposure 5.80 after re-measuring over a broad
     * station sample rather than the near-wall stations the first sweep used —
     * those contain the clipping and are the right place to judge the roll-off,
     * but they are far brighter than a typical view and overstated meanLum by
     * about 4. The full re-sweep table is on CFG.render.exposure.
     */
    /*
     * RAISED 0.86 -> 0.98, PAIRED with CFG.render.exposure 5.80 -> 10.6. As every
     * previous note on this uniform says, these two may not be moved independently:
     * exposure slides the whole histogram up the log axis and a steeper toe pulls
     * the region below the anchor back down, so together they buy a brighter pool
     * inside a frame that stays just as dark. Alone, exposure destroys
     * nearBlackFrac and the toe destroys meanLum.
     *
     * The pairing is needed here because the flatter beam (CFG.flashlight) removes
     * real energy from the near field by design, so the mean has to be bought back
     * without spending the black reservoir the beam now has room to carve into.
     *
     * Swept on the real beat path, pooled across seeds:
     *
     *   toe / exposure     midFreq   lum    litF   blk%    core%
     *   0.86 / 5.80 (was)    17.8   12.1   0.092  0.708   0.0015
     *   0.96 / 9.6           20.2   18.0   0.107  0.654   0.0006
     *   1.04 / 10.5          19.6   15.6   0.113  0.679   0.0006
     *   1.12 / 11.5          19.3   13.8   0.115  0.708   0.0006
     *
     * SETTLED AT 0.88 once the exposure was re-solved on beat-matched gate data
     * (10.6 -> 6.50; the derivation is on CFG.render.exposure). The toe is scaled
     * with the exposure IN STOPS, which is the only way the pairing stays
     * meaningful: 5.80 is +0.000 stops and wanted 0.86, 10.6 is +0.870 stops and
     * wanted 0.98, so 6.50 at +0.164 stops interpolates to 0.883. Keeping 0.98
     * against the lower exposure would crush the dim band the corridor reads by,
     * which is the half of this pair that is easy to forget to move back.
     */
    uToneToe: { value: 0.88 },
    /**
     * Shoulder slope per stop ABOVE the anchor. Lower = longer highlight roll-off.
     *
     * RAISED 0.12 -> 0.30. At 0.12, tanh needs roughly fifteen stops above the
     * anchor to approach 1.0, so the brightest thing the game can produce — the
     * torch core at 160 candela — topped out at display 212 and the frame had no
     * highlight at all. See the toe note above for the full measurement.
     */
    /*
     * LOWERED 0.22 -> 0.18, paired with the flatter beam in CFG.flashlight.
     *
     * A LOWER shoulder is a LONGER highlight roll-off, and that is the direction
     * that buys texture in the beam core — which is the opposite of what the note
     * above assumes. Modelled through the real chain, display codes per doubling
     * of scene light:
     *
     *   shoulder   0.5->1   4->8   32->64   display@160
     *     0.22      20.05   2.90    0.59       246.8
     *     0.18      20.40   4.13    1.00       246.1
     *     0.15      19.70   5.36    1.52       245.0
     *     0.12      17.90   6.79    2.32       242.8
     *
     * Raising it toward 0.40 collapses 4->8 to 0.64 codes, because a steeper tanh
     * saturates sooner. Lowering it stretches the top of the curve back out.
     *
     * The dim band is untouched across this entire range — display at scene-linear
     * 0.06 measures 56.7 at EVERY value above — so this is a pure top-end
     * operator and it cannot cost the shadow detail the frame is judged on.
     *
     * 0.18 rather than 0.12: below ~0.15 the 0.5->1 band (the beam's skirt, where
     * most lit pixels actually live) starts losing contrast — 20.4 -> 17.9 codes —
     * and the skirt is a larger share of the frame than the core is.
     */
    uToneShoulder: { value: 0.18 },
    /**
     * Display-linear value the anchor maps to; the curve's pivot.
     *
     * Nudged 0.26 -> 0.24 with the steeper slopes above. The anchor sits at
     * scene-linear 1.0 (`uToneGrey`) which, after exposure 0.22, is a wall in the
     * beam's skirt rather than a mid-grey — so pulling the pivot down slightly
     * keeps that skirt from riding up into the midtones now that the shoulder
     * lifts everything above it much faster.
     */
    uToneMid: { value: 0.24 },
    /**
     * Pulses to 1 while the monster is close. Widens the vignette, reddens the
     * lift and doubles the grain — the frame itself panics before the player does.
     */
    uDread: { value: 0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform float uBloomStrength;
    uniform float uTime;
    uniform vec2  uResolution;
    uniform float uGrain;
    uniform vec2  uVignette;
    uniform float uAberration;
    uniform float uDesaturate;
    uniform float uShadowDesat;
    uniform vec2  uShadowDesatBand;
    uniform vec3  uColdShadow;
    uniform float uWarmGain;
    uniform float uWarmProtect;
    uniform float uLocalContrast;
    uniform float uSkyProtect;
    uniform vec3  uTint;
    uniform vec3  uLift;
    uniform float uContrast;
    uniform float uShoulderStart;
    uniform float uPivot;
    uniform float uExposure;
    uniform float uToneGrey;
    uniform float uToneToe;
    uniform float uToneShoulder;
    uniform float uToneMid;
    uniform float uDread;

    varying vec2 vUv;

    // Log-domain filmic curve with an explicit toe and shoulder. See the long
    // note on uToneGrey/uToneToe for why this replaced the ACES fit outright
    // rather than being layered on top of it.
    //
    // Per channel, not on luminance. Running it on luminance and rescaling RGB
    // was tried and it desaturates the beam core badly: when the red channel is
    // deep in the shoulder and blue is still on the toe, a single shared scale
    // factor cannot represent that, and the hot spot goes chalky.
    float toneChannel(float x) {
      float s = log2(max(x, 1e-7) / uToneGrey);
      // Two asymptotic branches meeting with matching value at s = 0. tanh is
      // odd, so both branches pass through uToneMid there; the derivatives
      // differ by design, and that kink IS the filmic shoulder.
      return (s < 0.0)
        ? uToneMid * (1.0 + tanh(uToneToe * s))
        : uToneMid + (1.0 - uToneMid) * tanh(uToneShoulder * s);
    }
    vec3 tonemapFilmic(vec3 c) {
      return vec3(toneChannel(c.r), toneChannel(c.g), toneChannel(c.b));
    }

    // Integer-hash noise (PCG-style bit mixing on the pixel coordinate).
    //
    // This replaces interleaved-gradient noise, which was tried first and is
    // WRONG for this job: IGN is a low-discrepancy sequence built for dithering
    // with a small fixed per-frame offset, and driving it with a large animated
    // offset collapses it into a regular crosshatch. Captured frames showed an
    // unmistakable period-7 lattice across every dark area of the screen — the
    // grain read as a screen-door artifact rather than as film.
    //
    // Bit mixing has no such structure: successive integer inputs decorrelate
    // fully, so the result is white noise at every scale and every frame offset.
    float hash13(vec3 p3) {
      p3 = fract(p3 * 0.1031);
      p3 += dot(p3, p3.zyx + 31.32);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      // Aspect-correct radius, so the vignette is a circle and not an ellipse.
      float aspect = uResolution.x / max(uResolution.y, 1.0);
      vec2 rv = vec2(centred.x * aspect, centred.y);
      float r = length(rv) / length(vec2(aspect, 1.0) * 0.5);

      // ---- lens: chromatic aberration -------------------------------------
      // Radial, zero at the optical centre and growing with r^2 like real
      // lateral chromatic aberration. Green is the reference channel.
      float dread = clamp(uDread, 0.0, 1.0);
      float aber = (uAberration + dread * 2.2) * r * r;
      vec2 dir = (r > 0.0001) ? normalize(centred) : vec2(0.0);
      vec2 off = dir * aber / uResolution;

      vec4 centreTap = texture2D(tDiffuse, uv);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = centreTap.g;
      col.b = texture2D(tDiffuse, uv - off).b;

      // Sky mask. world.ts writes alpha 0 on the sky dome and every other material
      // in the scene is opaque, so this is an exact, free classification of which
      // pixels are sky — see the long note at the end of the dome's shader. It is
      // used by the desaturation below, which would otherwise drain the sky along
      // with the world and turn the roiling red into flat pink.
      float skyMask = 1.0 - clamp(centreTap.a, 0.0, 1.0);

      // ---- lens: acutance --------------------------------------------------
      //
      // An unsharp mask on luminance, at a 1.5-pixel radius. Four extra taps.
      //
      // This is the counterpart to the corridor carpentry in world.ts, not a
      // substitute for it: the geometry supplies real edges, and this stops the
      // renderer's own softness from smearing them out again before they reach
      // the eye. A 0.6-penumbra spotlight, a PCF shadow map and bilinear-filtered
      // planks at a grazing angle all blur in the same band the critic measured
      // (a 3px neighbourhood against its 17px surround), and the un-sharpened
      // frame measured 3.34 there against Amnesia's 30.91.
      //
      // Luminance-only on purpose. Sharpening per-channel would also sharpen the
      // chromatic-aberration fringes above into hard coloured outlines, which is
      // the exact look of a bad phone camera rather than of film.
      //
      // The gain is faded out where the surround is already near-black, because
      // there is nothing there but sensor noise and the amplifier would only make
      // the darkness crawl.
      {
        vec2 sp = 1.5 / uResolution;
        float lC = dot(col, vec3(0.2126, 0.7152, 0.0722));
        float lS =
          dot(texture2D(tDiffuse, uv + vec2( sp.x, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722)) +
          dot(texture2D(tDiffuse, uv + vec2(-sp.x, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722)) +
          dot(texture2D(tDiffuse, uv + vec2(0.0,  sp.y)).rgb, vec3(0.2126, 0.7152, 0.0722)) +
          dot(texture2D(tDiffuse, uv + vec2(0.0, -sp.y)).rgb, vec3(0.2126, 0.7152, 0.0722));
        lS *= 0.25;
        // The scene arrives as unmapped linear HDR, so a raw difference here is in
        // HDR units and would explode inside the beam. Normalising by the local
        // level makes this a RELATIVE contrast boost: a 10% step stays a 10% step
        // whether it is on a wall at 0.2 or one inside the hot spot at 40.
        float denom = max(lC + lS, 0.0025);
        float rel = (lC - lS) / denom;
        float presence = smoothstep(0.004, 0.05, max(lC, lS));
        col *= 1.0 + clamp(rel, -0.75, 0.75) * uLocalContrast * presence;
      }

      // ---- lens: bloom -----------------------------------------------------
      // Added BEFORE the vignette, because a real lens flares inside the barrel:
      // the halo has to be darkened by the vignette along with everything else,
      // or the corners glow through the darkening and the effect reads as a
      // sticker on top of the frame rather than light in the optics.
      // The bloom target is quarter-res, so this single bilinear tap is also
      // doing the last stage of upsample-blur for free.
      vec3 bloomTap = texture2D(tBloom, uv).rgb;
      col += bloomTap * uBloomStrength;

      // Reused below as the "this pixel belongs to a light source" mask. The
      // bright-pass that produced this buffer already answers exactly the
      // question the colour grade needs to ask — is this the flame, or is it a
      // wall the flame happens to be near? — so asking it again with a second
      // threshold on the graded value would be both redundant and worse, since by
      // then the tone curve has flattened the HDR range the answer lives in.
      float sourceMask = clamp(dot(bloomTap, vec3(0.2126, 0.7152, 0.0722)) * 3.0, 0.0, 1.0);

      // ---- lens: vignette --------------------------------------------------
      // Smoothstep from the inner radius outward, then squared so the corners
      // fall off fast without muddying the centre of the frame.
      float vigInner = uVignette.x - dread * 0.12;
      float v = 1.0 - smoothstep(vigInner, 1.28, r) * uVignette.y;
      v = clamp(v, 0.0, 1.0);
      col *= v * v;

      // ---- sensor: exposure + tone mapping ---------------------------------
      //
      // This has to happen HERE, not in the renderer, and that is not a stylistic
      // choice. three.js applies tone mapping only when the render target is the
      // canvas — WebGLRenderer checks _currentRenderTarget === null before it
      // injects the tonemapping chunk. The moment the scene is rendered into an
      // offscreen target for post-processing, renderer.toneMapping and
      // toneMappingExposure silently stop doing anything at all.
      //
      // That produced a genuinely confusing bug: lowering the renderer exposure
      // from 1.0 to 0.15 changed the captured frames by nothing whatsoever,
      // because the scene was arriving here as raw unmapped linear HDR the whole
      // time. The flashlight puts ~160 units on a wall a metre away, so the
      // frame was clipping to an 11% pure-white disc with no texture in it.
      //
      // Applying exposure and the ACES curve here restores the intended
      // behaviour, and doing it after the bloom is correct: bloom must be
      // gathered from the true HDR values, or bright highlights and merely-lit
      // surfaces bloom identically once both have been squashed to 1.0.
      col *= uExposure;
      // Log-domain filmic curve, NOT ACES. The whole argument is in the uniform
      // block above; the short version is that ACES needs diffuse white near
      // linear 1.0 and this scene spans fourteen stops, so ACES crushed the dim
      // band into ten display codes and flattened the entire beam core into one.
      col = clamp(tonemapFilmic(col), 0.0, 1.0);

      // Linear -> sRGB. Also normally the renderer's job, and also skipped when
      // drawing into an offscreen target. Without it every midtone renders far
      // too dark and the image looks like it is missing its gamma, because it is.
      col = pow(col, vec3(1.0 / 2.2));

      // ---- sensor: tonal grade --------------------------------------------
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));

      // Warm pixels keep their colour; everything else drains toward grey. This
      // is the Amnesia look: a desaturated world with warm lamplight surviving.
      //
      // The protection has to be gated on BRIGHTNESS as well as on hue, and
      // getting that wrong made the desaturation a no-op for an entire build.
      // The original test was warmth = (col.r - col.b), full stop. In this scene
      // every single pixel is lit by a red sky, a red hemisphere bounce and an
      // amber torch, so col.r > col.b is true essentially everywhere and the
      // protection cancelled the drain across the whole frame. Measured: mean HSV
      // saturation 0.73-0.83 against real Amnesia's 0.068, i.e. the grade was
      // doing nothing at all no matter what uDesaturate was set to.
      //
      // What Amnesia actually protects is the *flame* — a small, bright, strongly
      // warm region — not everything that happens to be reddish. Requiring real
      // brightness too means the beam's hot core and the gem glow keep their
      // colour while the dim red wash over the corridor drains to grey, which is
      // what finally gives the red sky something to contrast against.
      // sourceMask comes from the bloom bright-pass, so it marks the pixels
      // that were genuinely emissive or hot in the ORIGINAL linear HDR: the
      // beam's core, the gems and the burning sky. Combining it with the
      // brightness gate is what keeps the sky's colour, which is otherwise the
      // one casualty of a hard desaturation — the sky is the best thing in the
      // build and draining it to salmon would be a net loss.
      // Warmth is measured as a RATIO, not as an absolute channel difference,
      // and that correction is what put the colour back in the torch pool.
      //
      // The old test was (col.r - col.b) * 2.6. That is scale-dependent, and
      // the scale it is wrong at is exactly the one that matters: firelight on
      // wood in the beam core grades to about (0.42, 0.37, 0.34), so r - b is
      // 0.08 and the protection came out at 0.21 — meaning four fifths of a 0.72
      // desaturation still landed on the single region the player's eye rests
      // on. Measured on captured frames, the brightest 2% of architecture pixels
      // came back at saturation 0.181 against real Amnesia's torch-lit surfaces
      // at 0.373-0.436, and the beam read as a chalk-grey blob rather than as a
      // lamp on timber.
      //
      // Dividing by the pixel's own level makes the test ask "is this pixel
      // warm?" instead of "is this pixel warm AND bright?", which is what the
      // separate "hot" term is already for. A dim red-washed wall and a bright
      // amber-lit one now score the same warmth, and the brightness gate — not
      // the hue test — decides which of them keeps its colour.
      float level = max(max(col.r, col.g), max(col.b, 0.02));
      float warmth = clamp(((col.r - col.b) / level) * uWarmGain, 0.0, 1.0);
      float hot = max(smoothstep(0.22, 0.55, lum), sourceMask);
      // The drain is a RAMP over brightness, not one global number.
      //
      // Amnesia's darkness is neutral grey-black (measured saturation 0.080) and
      // its lamplit timber is warm (0.228). That SPLIT is the effect — the warmth
      // reads as warmth precisely because it has neutral dark to sit against.
      // Ours measured 0.577 in the near-black band against a lit band that was
      // already correct at 0.258, so a single global knob could only either leave
      // the shadows red or drain the beam pool grey. This drains the shadows hard
      // and leaves the lit band where it already measures right.
      float shadowBand = 1.0 - smoothstep(uShadowDesatBand.x, uShadowDesatBand.y, lum);
      float desatAmt = min(uDesaturate + uShadowDesat * shadowBand, 1.0);
      float desat = desatAmt * (1.0 - warmth * hot * uWarmProtect);
      // The sky is exempt outright. It is not "a warm thing that should keep some
      // colour" — it is the only large saturated surface in the game and the
      // reason the grey-black world around it reads as grey-black at all.
      desat *= (1.0 - skyMask * uSkyProtect);
      col = mix(vec3(lum), col, 1.0 - desat);

      // ---- sensor: COLD SHADOW CHROMA --------------------------------------
      //
      // Everything above this line drains the shadows toward GREY. That is half
      // a fix, and shipping only that half is what made a critic score the build
      // 4/10 with the verdict "our world is chromatically dead ... every frame is
      // a two-colour image": a warm torch pool on a neutral void, with nothing in
      // between. This is the other half — it puts a COLD cast back into the band
      // the drain just neutralised, so unlit masonry reads as cold stone instead
      // of as absence.
      //
      // ---- why the drain above is still right, and is not the thing to undo --
      //
      // Measured by chroma-ablation (tools/chroma-ablate.mjs, one page load, each
      // contributor's hue swapped for a luminance-matched grey so only colour
      // changes). Releasing the drain does restore chroma — and restores the
      // WRONG chroma. Shadow-band B-R, where the genuine Amnesia gameplay
      // captures /tmp/amnref/r6 and r8 sit at +1.11 and +1.77 (COLD):
      //
      //   drain released, control                  B-R  -14.51
      //   ... fog chroma nulled                    B-R  -14.49
      //   ... ambient chroma nulled                B-R  -14.37
      //   ... hemisphere chroma nulled             B-R  -14.13
      //   ... ALL THREE nulled                     B-R  -14.00
      //   ... all three nulled AND fog removed     B-R   -5.61
      //
      // Nulling the hue of every light in the scene moves it by 0.5 of 14. The
      // red is not coming from the lighting: woodWall.png itself measures mean
      // rgb (60.4, 39.9, 18.6), B-R -41.8, saturation 0.695. Every wall in the
      // game is that texture, so "just stop draining the shadows" yields a
      // red-brown world, not a cold one — which is precisely the trade earlier
      // waves were stuck in, and why they kept choosing grey.
      //
      // So: drain the albedo's red out (above), then add the cold back (here).
      // Doing it in this order rather than by tinting the lights is also what
      // keeps the SKY red, which is a hard requirement in GAME-SPEC.md §2 and is
      // the one large saturated surface the frame has.
      //
      // ---- shape ------------------------------------------------------------
      //
      // The cast is strongest in the shadow band and fades out before the beam,
      // reusing shadowBand so it lands exactly where the drain did rather than
      // on a second, differently-shaped ramp that could leave a seam between them.
      // It is ADDITIVE and scaled by the pixel's own luminance, so it tints what
      // is there instead of lifting the black floor: a pixel at zero stays at
      // zero and nearBlackFrac is preserved (measured 0.775 -> 0.771).
      //
      // Warm-protected pixels are exempt by the same warmth * hot term the
      // drain uses, so the torch pool, the gems and the sky keep their warmth and
      // only the unlit masonry goes cold. Without that exemption the cast lands
      // on the beam's skirt and turns the torchlight mint-green.
      float coldAmt = shadowBand * (1.0 - warmth * hot * uWarmProtect)
                    * (1.0 - skyMask * uSkyProtect);
      col += uColdShadow * coldAmt * lum;

      // Contrast about a LOW pivot, not 0.5.
      //
      // Pivoting at 0.5 is the standard formula and it was catastrophic here.
      // This scene lives almost entirely below 0.2, so (c - 0.5) * 1.16 + 0.5
      // pushed every shadow pixel DOWN — anything under about 0.069 went negative
      // and clamped to pure black. Measured result: 95% of the frame was dead
      // black and the maze read as a void with a torch in it.
      //
      // Pivoting at uPivot keeps the shadows where they are and only stretches
      // the range the image actually occupies, so contrast shapes the picture
      // instead of deleting it.
      col = (col - uPivot) * uContrast + uPivot;

      // ---- sensor: highlight roll-off --------------------------------------
      //
      // The line above is where this image was actually clipping, and it took
      // three rounds to find because the tone curve is asymptotic and therefore
      // "cannot clip" — so nobody looked downstream of it. Contrast about a low
      // pivot multiplies everything above that pivot outward, and nothing below
      // clamps: a wall a metre away leaves the curve at display 250.8, leaves
      // this line at 281.3, and lands as a flat 255 with its mortar joints gone.
      //
      // Compress the top instead of letting it run off. tanh is used for the
      // same reason the tone curve uses it — asymptotic, so two different bright
      // surfaces stay different display values — and it is joined at
      // uShoulderStart where tanh'(0) = 1 makes the slope continuous, so there
      // is no seam where the roll-off engages. Below the join this is exactly
      // the identity and the midtones are untouched.
      //
      // Per channel rather than on luminance, matching tonemapFilmic above: a
      // shared luminance scale cannot represent red being deep in the shoulder
      // while blue is still linear, and it turns the torch core chalky.
      col = mix(
        col,
        uShoulderStart + (1.0 - uShoulderStart) *
          tanh(max(col - uShoulderStart, 0.0) / max(1.0 - uShoulderStart, 1e-4)),
        step(vec3(uShoulderStart), col)
      );

      // Tint BEFORE the lift, and the shadow gate re-measured on the CURRENT
      // luminance rather than on the stale one. Both of those are ordering
      // fixes, and between them they are why the void stayed red through three
      // rounds of re-tuning uLift.
      //
      //   - lum was sampled once, up at the top of the grade, before
      //     desaturation, contrast and lift had run. Gating the shadow lift on
      //     it meant the lift was being faded by a luminance that no longer
      //     described the pixel it was being added to.
      //   - the tint was applied AFTER the lift, so uTint (1.03, 0.94, 0.9)
      //     multiplied the deliberately-neutral lift and put the red straight
      //     back into the pixels the lift had just neutralised. The darkest
      //     band measured RGB(6.5, 2.4, 1.2) — saturation 0.83 — while uLift
      //     itself was very nearly grey. Raising uLift could never fix that,
      //     because the thing undoing it ran afterwards and scaled with it.
      //
      // Tint first, then lift on top of the tinted image, keeps the tint as a
      // cast over the picture while the lift stays the neutral grey floor that
      // Amnesia's darkness actually is.
      col *= uTint;
      float shadowLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      // The dread lift, SCALED DOWN from vec3(0.045, 0.004, 0.006).
      //
      // That value was calibrated when uLift was (0.027, 0.025, 0.0245), where it
      // read as a moderate warm push. Against the near-neutral floor uLift now
      // sets, it was overwhelming: at dread 0.35 it put the shadow floor at RGB
      // codes (8.2, 4.2, 4.3), a saturation of 0.48.
      //
      // That was caught on the gate rather than reasoned about. Four of twelve
      // corridor frames measured satNearBlack 0.38-0.83 while the other eight sat
      // at 0.068 on the same build and the same grade — and the four were exactly
      // the frames where the monster was close enough to raise dread. A frame
      // average would have blamed the base grade for a term that only fires near
      // the monster, which is most of a real playthrough.
      //
      // The effect is kept, because the frame reddening as he closes is a real
      // and good idea — it is simply an accent on a neutral floor now, not a
      // replacement for it. Its ratio to the base lift is preserved rather than
      // being re-guessed: this reaches roughly the same PROPORTIONAL warm push
      // over the new floor that the old value made over the old one.
      // Halved again, to 0.0060, after the GATE caught the first reduction still
      // being too strong. Two corridor runs on an identical build measured
      // satNearBlack 0.224 and 0.054; the first had the monster at 1.3-8.9 m for
      // half its frames and the second kept him 34-62 m away, so the whole spread
      // was this one term. At the old value it put the shadow floor at RGB codes
      // (7.3, 4.2, 4.3) — saturation 0.42 — in exactly the band this lane exists
      // to keep neutral, and only during the close-monster moments a player
      // actually spends the game in.
      //
      // Note the red channel is cut hard while green and blue are barely touched.
      // The dread accent stays a WARMING of the floor rather than a red wash, so
      // the frame still tightens as he closes without undoing the neutral black.
      vec3 lift = uLift + vec3(0.0060, 0.0009, 0.0014) * dread;
      // The gate window is NARROW (0.14, not 0.35), and that width is the whole
      // point of this line rather than an incidental constant.
      //
      // The lift is what makes the darkness neutral, but it was being faded in by
      // 1 - smoothstep(0, 0.35, shadowLum) -- so a pixel partway up that ramp
      // received only a FRACTION of the neutralising grey while the scene's own
      // red sat underneath it at full strength. The darkest pixels got a clean
      // floor and the ones just above them got a diluted one, which is the worst
      // possible split.
      //
      // It surfaced as a run-to-run instability that looked like a regression:
      // three corridor runs on an identical build measured satNearBlack 0.057,
      // 0.056 and 0.198, and the outlier's offending pixels were RGB(2.2, 0.8,
      // 0.9) spread evenly over the whole frame. Because the maze seed is
      // Date.now() & 0xffff (trap 6b), a darker seed simply puts more of the
      // frame inside the partial-gate zone. Averaging more runs would have hidden
      // this rather than finding it.
      //
      // Narrowing the window means anything genuinely near-black gets the FULL
      // neutral floor and the ramp lives above the band this lane is judged on.
      col += lift * (1.0 - smoothstep(0.0, 0.14, shadowLum));

      // ---- sensor: grain ---------------------------------------------------
      // Two decorrelated samples per frame give grain that shimmers instead of
      // crawling. Amplitude is highest in the shadows, exactly like real film,
      // and it is what stops flat dark areas from reading as dead pixels.
      // Quantise time into discrete frames before hashing. Feeding a continuous
      // float as the third hash component makes the grain slide smoothly, which
      // looks like drifting fog; real film grain resamples completely every frame.
      vec2 gp = floor(uv * uResolution);
      float frame = floor(uTime * 24.0);
      float n1 = hash13(vec3(gp, frame));
      float n2 = hash13(vec3(gp.yx, frame + 71.0));
      // Two decorrelated uniform samples summed approach a triangular
      // distribution, which is what film grain actually looks like — most pixels
      // barely perturbed, a few strongly so.
      float grain = (n1 + n2) - 1.0;
      // Gated on the post-grade luminance, like the lift above, not on the
      // value sampled before desaturation and contrast ran.
      float shadowBias = 1.0 - smoothstep(0.0, 0.55, shadowLum);
      col += grain * uGrain * (0.35 + shadowBias) * (1.0 + dread * 1.1);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};


export type PostChain = {
  /** Renders scene -> bloom -> grade -> screen. Call instead of renderer.render. */
  render(): void;
  /** Call every frame before render. `dread` is 0..1 monster proximity pressure. */
  update(elapsed: number, dread: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** False if the chain could not be built; caller must render directly. */
  readonly enabled: boolean;
  /**
   * Draw calls and triangles of the SCENE pass, sampled inside render() before
   * the full-screen quads reset the counters. Read by the capture harness: on a
   * software rasterizer "it got slow" is ambiguous between fill cost, geometry
   * cost and the shadow pass, and these separate them.
   */
  readonly sceneStats: { calls: number; triangles: number };
  dispose(): void;
};

export type PostOptions = {
  /** Restrained on purpose — this is a haze around lights, not a glow filter. */
  bloomStrength?: number;
  /** Widens the halo by scaling the tap offsets. Costs nothing extra. */
  bloomRadius?: number;
  /**
   * Only pixels brighter than this bleed. Set above the wall highlights so the
   * bloom belongs to the gems, the beam's hot core and the sky, and the wood
   * never turns into a glowing smear.
   */
  bloomThreshold?: number;
  /**
   * Bloom target divisor. 4 means quarter width and quarter height, i.e. one
   * sixteenth of the pixels. This is the single biggest lever on the cost of the
   * whole chain on a software rasterizer.
   */
  bloomDownsample?: number;
};

/**
 * Builds the chain.
 *
 * Structure, and why it is this shape:
 *
 *   scene ──RenderPass──► sceneRT (full res)
 *   sceneRT ──BloomShader──► bloomRT (quarter res)     [bright-pass + 13-tap tent]
 *   sceneRT + bloomRT ──GradeShader──► screen          [aberration, vignette,
 *                                                       desaturation, lift,
 *                                                       contrast, grain]
 *
 * Two full-res passes and one quarter-res pass. The alternative — three stacked
 * library passes plus UnrealBloom's eleven — was measured at 0.017 fps here.
 *
 * If anything throws, `enabled` comes back false and the caller renders the scene
 * directly. A failed lens effect must never cost the player the game.
 */
export function buildPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: PostOptions = {},
): PostChain {
  const disabled: PostChain = {
    render() { renderer.render(scene, camera); },
    update() { /* nothing to update */ },
    setSize() { /* nothing to size */ },
    enabled: false,
    sceneStats: { calls: 0, triangles: 0 },
    dispose() { /* nothing to dispose */ },
  };

  const {
    bloomStrength = 0.44,
    bloomRadius = 1.0,
    bloomThreshold = 0.68,
    bloomDownsample = 4,
  } = opts;

  const size = new THREE.Vector2();
  renderer.getSize(size);
  const pr = renderer.getPixelRatio();

  let sceneRT: THREE.WebGLRenderTarget;
  let bloomRT: THREE.WebGLRenderTarget;
  let bloomMat: THREE.ShaderMaterial;
  let gradeMat: THREE.ShaderMaterial;
  let quad: FullScreenQuad;

  try {
    const w = Math.max(1, Math.floor(size.x * pr));
    const h = Math.max(1, Math.floor(size.y * pr));

    // HalfFloat so the bright pass has headroom above 1.0 to actually find. With
    // an 8-bit target every lit surface clamps to white and the bloom threshold
    // has nothing meaningful left to separate.
    // A depth buffer is required: this is where the actual scene is rasterised.
    sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: 0,
    });

    const bw = Math.max(1, Math.floor(w / bloomDownsample));
    const bh = Math.max(1, Math.floor(h / bloomDownsample));
    bloomRT = new THREE.WebGLRenderTarget(bw, bh, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      samples: 0,
      // Linear filtering is what makes the single upsample tap in the grade
      // shader smooth instead of blocky.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    bloomMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(BloomShader.uniforms),
      vertexShader: BloomShader.vertexShader,
      fragmentShader: BloomShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    bloomMat.uniforms.uThreshold.value = bloomThreshold;
    bloomMat.uniforms.uRadius.value = bloomRadius;
    (bloomMat.uniforms.uTexel.value as THREE.Vector2).set(1 / bw, 1 / bh);

    gradeMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(GradeShader.uniforms),
      vertexShader: GradeShader.vertexShader,
      fragmentShader: GradeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    gradeMat.uniforms.uBloomStrength.value = bloomStrength;
    (gradeMat.uniforms.uResolution.value as THREE.Vector2).set(w, h);

    /**
     * Live grade knobs for the capture harness.
     *
     * Every grade value interacts with every other one — exposure moves what the
     * bright-pass sees, which moves the desaturation gate, which moves measured
     * saturation, which changes what contrast does. Finding a setting by editing
     * a constant, rebuilding the bundle and re-running a 40-second capture is
     * about ninety seconds per sample, which is too slow to search a six-knob
     * space honestly, so it gets guessed at instead.
     *
     * This writes to the real uniforms of the real material. There is no separate
     * "preview" path that could disagree with what ships: whatever a sweep finds
     * here is exactly what the committed default will produce.
     */
    (window as unknown as Record<string, unknown>).__POST_TUNE__ = (
      o: Record<string, number | [number, number] | [number, number, number]>,
    ) => {
      for (const [k, v] of Object.entries(o)) {
        const u = gradeMat.uniforms[k];
        if (!u) { console.warn('[post] no such uniform', k); continue; }
        // Vector2 and Color uniforms carry the tint, the lift and the shadow-drain
        // band — i.e. exactly the values this lane needs to sweep. A scalar-only
        // hook silently ignored them, which meant a sweep could report that a knob
        // "did nothing" when in truth it had never been written.
        const a: number[] = Array.isArray(v) ? v : [];
        if (typeof u.value === 'number' && typeof v === 'number') u.value = v;
        else if (u.value instanceof THREE.Vector2 && a.length >= 2) u.value.set(a[0], a[1]);
        else if (u.value instanceof THREE.Color && a.length >= 3) u.value.setRGB(a[0], a[1], a[2]);
        else console.warn('[post] uniform/value shape mismatch', k, v);
      }
      const snap: Record<string, unknown> = {};
      for (const [k, u] of Object.entries(gradeMat.uniforms)) {
        if (typeof u.value === 'number') snap[k] = u.value;
        else if (u.value instanceof THREE.Vector2) snap[k] = [u.value.x, u.value.y];
        else if (u.value instanceof THREE.Color) snap[k] = [u.value.r, u.value.g, u.value.b];
      }
      return snap;
    };

    quad = new FullScreenQuad(bloomMat);
  } catch (err) {
    console.error('[post] chain failed to build; falling back to direct render', err);
    return disabled;
  }

  // Dread is smoothed here rather than at the call site so the grade never snaps:
  // the frame should tighten around the player, not blink.
  let dreadSmoothed = 0;
  let lastElapsed = 0;

  /** Draw calls and triangles of the SCENE pass only; see render(). */
  const sceneStats = { calls: 0, triangles: 0 };

  return {
    enabled: true,
    sceneStats,

    update(elapsed: number, dread: number) {
      const dt = Math.min(Math.max(elapsed - lastElapsed, 0), 0.1);
      lastElapsed = elapsed;
      const target = Math.min(1, Math.max(0, dread));
      // Tighten fast, release slow — panic arrives quicker than relief.
      const rate = target > dreadSmoothed ? 3.2 : 1.1;
      dreadSmoothed += (target - dreadSmoothed) * Math.min(1, rate * dt);

      gradeMat.uniforms.uTime.value = elapsed;
      gradeMat.uniforms.uDread.value = dreadSmoothed;
      // The gems bleed harder when he is near.
      gradeMat.uniforms.uBloomStrength.value = bloomStrength * (1 + dreadSmoothed * 0.5);
    },

    render() {
      // The passes are driven directly rather than through EffectComposer.
      // EffectComposer's ping-pong contract is the opposite of what it looks like
      // — RenderPass writes into its `readBuffer` argument and ShaderPass
      // overwrites tDiffuse from `readBuffer.texture`, so hand-assigning textures
      // around it silently renders the wrong thing. Three explicit steps are both
      // correct and easier to reason about.

      // 1. Scene -> sceneRT (full res, with depth).
      renderer.setRenderTarget(sceneRT);
      renderer.clear();
      renderer.render(scene, camera);
      // Snapshot the counters HERE. renderer.info auto-resets at the start of
      // every render() call, so reading it after the two full-screen quads below
      // reports "1 call, 1 triangle" and tells you nothing about the scene.
      sceneStats.calls = renderer.info.render.calls;
      sceneStats.triangles = renderer.info.render.triangles;

      // 2. sceneRT -> bloomRT (quarter res, bright-pass + tent blur).
      bloomMat.uniforms.tDiffuse.value = sceneRT.texture;
      quad.material = bloomMat;
      renderer.setRenderTarget(bloomRT);
      renderer.clear();
      quad.render(renderer);

      // 3. sceneRT + bloomRT -> screen (aberration, bloom, vignette, grade, grain).
      gradeMat.uniforms.tDiffuse.value = sceneRT.texture;
      gradeMat.uniforms.tBloom.value = bloomRT.texture;
      quad.material = gradeMat;
      renderer.setRenderTarget(null);
      quad.render(renderer);
    },

    setSize(width: number, height: number, pixelRatio: number) {
      const w = Math.max(1, Math.floor(width * pixelRatio));
      const h = Math.max(1, Math.floor(height * pixelRatio));
      sceneRT.setSize(w, h);

      const bw = Math.max(1, Math.floor(w / bloomDownsample));
      const bh = Math.max(1, Math.floor(h / bloomDownsample));
      bloomRT.setSize(bw, bh);
      (bloomMat.uniforms.uTexel.value as THREE.Vector2).set(1 / bw, 1 / bh);

      // Aberration and grain are computed in device pixels, so the shader needs
      // the real backing-store size, not the CSS size.
      (gradeMat.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    },

    dispose() {
      sceneRT.dispose();
      bloomRT.dispose();
      bloomMat.dispose();
      gradeMat.dispose();
      quad.dispose();
    },
  };
}
