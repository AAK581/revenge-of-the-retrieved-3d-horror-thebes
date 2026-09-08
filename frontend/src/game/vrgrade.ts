/**
 * The grade, for VR — as a tone mapping function instead of a fullscreen pass.
 *
 * ## Why this is not a stereo port of `post.ts`
 *
 * The obvious plan was to make the existing three-pass chain eye-aware: render
 * both eyes to a wide target, then run bloom and grade per eye with
 * viewport-aware uniforms. That is a large, delicate piece of work whose only
 * possible verification is looking through a headset, and it would have been
 * written blind.
 *
 * It is also mostly unnecessary, because of what the grade actually does. Split
 * its stages by whether they need to read a NEIGHBOURING pixel:
 *
 *   pointwise (needs only this pixel)   exposure, the log filmic tone curve,
 *                                       linear->sRGB, desaturation, the shadow
 *                                       drain, the cold shadow cast, lift and
 *                                       contrast
 *   screen-space (needs neighbours or   bloom, local contrast, chromatic
 *   a screen position)                  aberration, vignette, grain
 *
 * Everything in the first column is a pure function of one colour, so it can run
 * in the **scene pass** and needs no fullscreen quad, no render target, and no
 * knowledge of viewports. It is correct in stereo for free, because it runs
 * per-fragment on geometry that three is already drawing once per eye.
 *
 * And the second column is exactly the list this project already decided to drop
 * or replace in VR:
 *   - **chromatic aberration** reads as a lens defect in a headset and causes
 *     eye strain — dropped deliberately, not lost.
 *   - **vignette** is replaced by the speed-driven comfort tunnel in `vr.ts`,
 *     which is real head-locked geometry and therefore already per-eye correct.
 *   - **grain** is hashed on pixel coordinates; in stereo, independent noise per
 *     eye is a genuine binocular-rivalry problem, so its absence is a feature.
 *   - **bloom** and local contrast are the real losses. Bloom is the one worth
 *     coming back for once there is a headset to judge it against.
 *
 * ## Why the renderer's tone mapping works here and not in flat play
 *
 * `post.ts` documents at length that `renderer.toneMapping` silently stops doing
 * anything once the scene is rendered into an offscreen target, because three
 * only injects the tonemapping chunk when `_currentRenderTarget === null`. That
 * is precisely why the flat path had to move exposure and the curve into the
 * grade shader.
 *
 * In VR the scene is drawn straight into the session's framebuffer, which three
 * treats as the canvas — so the chunk IS injected and the tone mapping stage runs.
 * The constraint that forced the flat design does not exist on this path.
 *
 * Constants are baked into the source from the same values `post.ts` uses rather
 * than plumbed as uniforms, because `ShaderChunk` overrides have no clean way to
 * introduce new uniforms and every one of these is a static config value. They
 * are read from `CFG` where `CFG` owns them, and mirrored where `post.ts` holds
 * them as literals — see the drift warning on `GRADE`.
 */
import * as THREE from 'three';
import { CFG } from './config';

/**
 * Mirrors the grade uniforms in `post.ts`. **These are a copy, and a copy can
 * drift** — `tools/vrgrade-check.mjs` compares this path against the real post
 * chain on a real frame precisely so drift shows up as a failing number rather
 * than as a VR build that quietly looks different from the flat one.
 */
export const GRADE = {
  toneGrey: 1.0,
  toneMid: 0.24,
  toneToe: 0.88,
  toneShoulder: 0.18,
  /**
   * NOT a copy of post's 0.50 — calibrated.
   *
   * The flat path's measured saturation is the product of its whole chain: the
   * drain, plus bloom laying desaturated highlights over the frame, plus a
   * vignette pulling the edges down. This path has none of those, so copying the
   * drain constant reproduced the STAGE but not the RESULT — a paired within-run
   * measurement put it at 0.379 against the flat path's 0.205. Calibrated so the
   * output matches rather than the source matching.
   */
  desaturate: 0.73,
  /**
   * Display-space gain, closing the brightness gap left by the absent bloom.
   * Same reasoning: bloom contributes real light to the flat frame, and without
   * it the same curve lands measurably darker.
   */
  outputGain: 1.5,
  /** Extra drain applied across the shadow band, and the band itself. */
  shadowDrain: 0.66,
  shadowLo: 0.02,
  shadowHi: 0.22,
  coldShadow: new THREE.Color(0.338, 0.608, 0.772),
  coldStrength: 0.045,
  lift: new THREE.Color(0.016, 0.0152, 0.015),
  contrast: 1.14,
  pivot: 0.13,
};

const f = (n: number) => n.toFixed(6);

/**
 * The replacement for three's `tonemapping_pars_fragment`.
 *
 * Runs in the scene's fragment shader on linear HDR, and returns linear colour —
 * three applies the sRGB conversion afterwards via the output colour space, so
 * unlike `post.ts` this must NOT do its own `pow(col, 1/2.2)`. Doing both is a
 * double gamma and the classic way to end up with a washed-out image.
 *
 * The desaturation and cold cast therefore operate in LINEAR space here, where
 * the flat grade applies them after its own sRGB step. That is a real difference
 * and the reason the check tolerates a band rather than demanding equality.
 */
function toneMappingChunk() {
  return /* glsl */`
    float rrToneChannel(float x) {
      float s = log2(max(x, 1e-7) / ${f(GRADE.toneGrey)});
      return (s < 0.0)
        ? ${f(GRADE.toneMid)} * (1.0 + tanh(${f(GRADE.toneToe)} * s))
        : ${f(GRADE.toneMid)} + (1.0 - ${f(GRADE.toneMid)}) * tanh(${f(GRADE.toneShoulder)} * s);
    }

    vec3 RRVRToneMapping(vec3 color) {
      color *= toneMappingExposure;

      // Log-domain filmic curve, not ACES. ACES wants diffuse white near linear
      // 1.0 and this scene spans fourteen stops; it crushed the dim band into
      // about ten display codes and flattened the beam core into one.
      color = clamp(vec3(
        rrToneChannel(color.r),
        rrToneChannel(color.g),
        rrToneChannel(color.b)
      ), 0.0, 1.0);

      /**
       * The tonal grade runs in DISPLAY space, not linear — and getting that
       * wrong is not a subtlety.
       *
       * post.ts applies its sRGB conversion and only then desaturates, lifts
       * and adds contrast. The first version here did all of it in linear and
       * then let three's output conversion gamma-encode the result, which
       * measured **meanSat 0.340 against the flat path's 0.211**: desaturating
       * in linear and then encoding re-expands the very chroma the drain just
       * removed, so the VR image came out MORE colourful than the flat one it
       * was supposed to match.
       *
       * So: encode, grade, decode. Three re-encodes on output, and the round trip
       * puts every operation in the same space post.ts performs it in.
       */
      vec3 disp = pow(color, vec3(1.0 / 2.2));

      float lum = dot(disp, vec3(0.2126, 0.7152, 0.0722));

      // Base desaturation, plus an extra drain across the shadow band. The open
      // atmosphere defect is that our chromatic pixels are dead neutral where
      // Amnesia's carry a warm cast, so the cold cast is applied at low strength
      // and ONLY in shadow — a tint on the darkest end, not a wash over the frame.
      float shadow = 1.0 - smoothstep(${f(GRADE.shadowLo)}, ${f(GRADE.shadowHi)}, lum);
      float drain = ${f(GRADE.desaturate)} + ${f(GRADE.shadowDrain)} * shadow * (1.0 - ${f(GRADE.desaturate)});
      disp = mix(disp, vec3(lum), clamp(drain, 0.0, 1.0));

      disp += vec3(${f(GRADE.coldShadow.r)}, ${f(GRADE.coldShadow.g)}, ${f(GRADE.coldShadow.b)})
            * (shadow * ${f(GRADE.coldStrength)} * lum);

      // Lift the floor off pure black, then contrast about a low pivot. The
      // pivot is well below mid-grey because this frame lives in its bottom end.
      disp *= ${f(GRADE.outputGain)};
      disp += vec3(${f(GRADE.lift.r)}, ${f(GRADE.lift.g)}, ${f(GRADE.lift.b)});
      disp = (disp - ${f(GRADE.pivot)}) * ${f(GRADE.contrast)} + ${f(GRADE.pivot)};

      return pow(max(disp, vec3(0.0)), vec3(2.2));
    }
  `;
}

let installed = false;

/**
 * Install the custom curve. Idempotent, and safe to call before any material
 * compiles — after that, three has already cached programs built against the old
 * chunk and they will not pick this up.
 */
export function installVrGrade() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.tonemapping_pars_fragment =
    THREE.ShaderChunk.tonemapping_pars_fragment.replace(
      'vec3 CustomToneMapping( vec3 color ) { return color; }',
      `${toneMappingChunk()}\n vec3 CustomToneMapping( vec3 color ) { return RRVRToneMapping( color ); }`,
    );
}

/**
 * Turn the VR grade on or off on a live renderer.
 *
 * `NoToneMapping` is the correct "off" state, not ACES: in flat play `post.ts`
 * owns exposure and the curve entirely, and the renderer's own tone mapping is
 * inert there anyway because the scene goes to an offscreen target. Setting ACES
 * would only matter on the one path where post is disabled, and it would double
 * up with the grade shader if post were later re-enabled mid-session.
 */
export function setVrGrade(renderer: THREE.WebGLRenderer, on: boolean) {
  renderer.toneMapping = on ? THREE.CustomToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = on ? CFG.render.exposure : 1;
}
