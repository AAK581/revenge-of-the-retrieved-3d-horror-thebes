/**
 * The audio engine.
 *
 * Built on raw Web Audio rather than three's Audio wrappers, because the things
 * that carry the dread here need control the wrappers don't give: a true
 * equal-power crossfade that can be interrupted and reversed mid-fade without
 * lurching, a monster you hear through walls before you ever see him, and knocks
 * that are placed in space rather than merely panned.
 *
 * Everything is loaded once up front and played from decoded buffers — a chase
 * sting that has to wait on a network fetch has already failed.
 *
 * ---------------------------------------------------------------------------
 * Signal graph
 * ---------------------------------------------------------------------------
 *
 *   ambienceSrc --> ambienceGain --\
 *   chaseSrc    --> chaseGain    ---+--> bedDuckGain ----------------------+
 *                                                                         |
 *   vocal beds  idle/alert/hunt --> per-state gain --\                     |
 *   notice sting --> open lowpass ------------------- +                    |
 *   monster gait ------------------------------------ +                    |
 *   monster breath ---------------------------------- +                    |
 *                                                     v                    |
 *                              monsterPan (HRTF) --> monsterMuffle --> monsterGain --+
 *                                                                  \--> monsterSend -+--> conv
 *   knock one-shots     --> pan --> lowpass --> gain ------------------------------+  |
 *   footsteps           --> pan --> gain --+--> dry ---------------------------+   |  |
 *                                          \--> reverbSend --> conv -----------+   |  |
 *                                                                              v   v  v
 *                                                       duckGain --> limiter -----+
 *                                                                                 |
 *   jumpscare one-shot ------------> scareBus --> scareLimiter -------------------+
 *                                                                                 v
 *                                                                              master --> out
 *
 * Three independent things attenuate, and each owns exactly one AudioParam so
 * none can overwrite another:
 *   - `ambienceGain`/`chaseGain` — the equal-power crossfade between the beds.
 *   - `bedDuckGain`  — the monster pushing the beds aside so his voice has a hole.
 *   - `duckGain`     — the jumpscare clearing the entire stage.
 *
 * TWO SEPARATE DYNAMICS STAGES, and the separation is the point:
 *   - `limiter`      — the BED compressor (-18 dB, 4:1). Keeps the beds and
 *                      one-shots tidy. The scare never passes through it.
 *   - `scareLimiter` — the SCARE brickwall (~-1 dB, 20:1, hard knee). Stops the
 *                      hit clipping the DAC and does nothing else.
 * They are separate because a compressor cannot tell a scare from a bed when
 * they share a bus. While they shared one, the bed compressor gain-reduced the
 * scare by 7.86 dB and pinned its peak at ~0.685 whether it was fired into
 * silence or into a full chase — so the scare measured QUIETER than the corridor
 * it interrupts. The bed is meant to be tidy; the scare is the one sound that
 * must never be.
 *
 * The monster is spatialised by a PannerNode in HRTF mode rather than a stereo
 * panner, because a stereo panner is a one-dimensional L/R fader and cannot tell
 * you whether he is in front of you or behind you — which, in a maze where he is
 * usually behind you, is the most useful thing audio has to say.
 */

import { CFG } from './config';

const FILES = {
  ambience: 'ambience1.ogg',
  chase: 'chase.ogg',
  jumpscare: 'jumpscare.ogg',
  win: 'win.ogg',
  gem: 'SH2Click.ogg',
  gate: 'gate1.ogg',
  knock: 'knock.wav',
  stepLeft: 'left_step.wav',
  stepRight: 'right_step.wav',
} as const;

export type SoundName = keyof typeof FILES;

/** Iteration order for the vocal buses. Declared once so no loop can miss a state. */
const VOCAL_STATES = ['silent', 'idle', 'alert', 'hunt'] as const;

/**
 * What the audio engine needs to know about the monster each frame to place him
 * in space. Supplied by the game loop; the engine never guesses a position.
 */
export type MonsterAudioFrame = {
  /** Monster world position. */
  x: number;
  z: number;
  /** Listener (player) world position. */
  px: number;
  pz: number;
  /** Listener yaw in radians, matching THREE's yaw convention (0 = facing -Z). */
  yaw: number;
  /** True when nothing solid sits between him and you. */
  lineOfSight: boolean;
  /** Is he running? Drives gait rate and breath intensity. */
  chasing: boolean;
  /** True when he is actually moving — a stationary monster does not make footfalls. */
  moving: boolean;
  /**
   * The AI's own perception state, if the caller has it. This drives the vocal
   * state machine directly, which is strictly better than inferring it: 'suspicious'
   * and 'search' are both "he is looking for you" but only one of them knows where
   * you were. Optional so the engine still works — by inference from `chasing` and
   * `lineOfSight` — for any caller that does not pass it.
   */
  state?: 'patrol' | 'suspicious' | 'chase' | 'search';
  /**
   * True on the single frame he transitions into chase. Fires the notice sting.
   * Optional for the same reason; when it is absent the engine detects the
   * silent -> hunt edge itself, which is the same instant in practice.
   */
  justSpotted?: boolean;
};

/**
 * The monster's vocal states, lifted from HPL2's `eLuxEnemySoundState`.
 *
 * Silent is a real state, not the absence of one: it is what he is when he is out
 * of earshot entirely, and having it named means the machine crossfades *into*
 * silence over 3s like every other transition rather than snapping off.
 */
export type VocalState = 'silent' | 'idle' | 'alert' | 'hunt';

/**
 * The shape `makeVocal` synthesizes from. Structurally identical for the three
 * retriggered state beds and for the one-shot notice sting, which is why the
 * sting can reuse the whole synthesis path rather than being a special case.
 */
type VocalSpec = {
  gain: number;
  length: number;
  /** Fundamental at the start and end of the utterance. Rising reads interrogative. */
  f0: number; f0End: number;
  /** Three formant centres, Hz. */
  formants: readonly number[];
  /** 0..1 balance of phonated pulse train against breath noise. */
  voiced: number;
  tremolo: number;
  /** Sub-audio roughness rate, Hz. Slow = groan, fast = snarl. */
  rough: number;
  /** Retrigger window, seconds. Absent on the one-shot sting. */
  minGap?: number; maxGap?: number;
  /**
   * Formant multipliers at the start and end of the utterance — the articulation
   * gesture. Attached by `specFor`/`buildVocals` from `CFG…vocal.glide` rather
   * than living in the per-state config blocks, so the glide table stays readable
   * as a table. Absent means "do not move", which is the old behaviour and is
   * what the drag and any future non-vocal spec want.
   */
  glideStart?: readonly number[];
  glideEnd?: readonly number[];
  /**
   * The PEAK of the articulation, and where in the utterance it lands (0..1).
   *
   * With these present the glide is a three-point one-way gesture — start, snap
   * open to peak at `glideKnee`, then a slower collapse to end — instead of a
   * single ramp. Absent, `makeVocal` falls back to the old start->end ramp
   * exactly, which is what keeps the drag spec and the offline A/B honest.
   */
  glidePeak?: readonly number[];
  glideKnee?: number;
};

/** Snapshot of the live gain values, for the headless crossfade test. */
export type AudioProbe = {
  ambience: number;
  chase: number;
  /** Sum of squares of the normalised bed gains. Equal-power holds this at ~1. */
  power: number;
  monster: number;
  /** Monster lowpass cutoff in Hz — high means "you can hear him clearly". */
  monsterCutoff: number;
  pan: number;
  duck: number;
  ctxTime: number;
  fading: boolean;
  chaseTarget: boolean;
  /** Which vocal state the machine believes he is in. */
  vocalState: VocalState;
  /** Live gain of each state's vocal bus — proves the 3s crossfade really crossfades. */
  vocalGains: Record<VocalState, number>;
  /** How hard the monster is currently ducking the beds. 1 = untouched. */
  bedDuck: number;
  /**
   * The two envelope followers keying the duck. Exposed so a test can prove the
   * duck is tracking actual utterances rather than sitting on a static floor —
   * which is exactly the failure this replaced.
   */
  utterEnv: number;
  stingEnv: number;
  /** Count of vocals actually triggered, per state. Proves the retrigger timer runs. */
  vocalFires: Record<VocalState, number>;
  /** Notice stings fired. Counted apart from the hunt bed so it can be asserted alone. */
  stingFires: number;
  /** Live level of the wet-cord drag bus, and how many strokes have fired. */
  drag: number;
  dragFires: number;
  /**
   * How many baked vocal buffers actually got material derived from
   * `jumpscare.ogg` folded into them. 10 = 3 states x 3 variants + the notice
   * sting. Zero means the derivation silently did not happen, which is the one
   * way this feature can fail without raising anything.
   */
  throatMixed: number;
  /**
   * Live gain reduction, in dB, of each of the three dynamics stages. Negative
   * is attenuation. This is what proves the scare is not being flattened: during
   * a jumpscare `bedGr` should be irrelevant to the hit (the scare does not pass
   * through it at all) and `scareGr` should stay near zero.
   */
  bedGr: number;
  scareGr: number;
  outputGr: number;
};

export class AudioEngine {
  private ctx: AudioContext;
  private master: GainNode;
  private duckGain: GainNode;
  /** Bypasses `duckGain` so the jumpscare is not attenuated by its own duck. */
  private scareBus: GainNode;
  /** The BED compressor. Governs everything except the scare. */
  private limiter: DynamicsCompressorNode;
  /**
   * The scare's own brickwall, on its own path to `master`. Separate node so the
   * bed compressor never sees the scare and cannot gain-reduce its transient.
   */
  private scareLimiter: DynamicsCompressorNode;
  /**
   * The final safety ceiling, after the bed and scare buses sum at `master`.
   * Per-bus limiters cannot see the sum; without this the two buses together
   * clipped the DAC at a real catch.
   */
  private outputLimiter: DynamicsCompressorNode;
  private buffers = new Map<SoundName, AudioBuffer>();

  /** The two looping beds. Both always running; only their gains move. */
  private ambienceGain!: GainNode;
  private chaseGain!: GainNode;
  private ambienceSrc: AudioBufferSourceNode | null = null;
  private chaseSrc: AudioBufferSourceNode | null = null;

  /** Shared stone-corridor space. One convolver, one synthesized impulse. */
  private convolver!: ConvolverNode;
  private reverbReturn!: GainNode;

  /** The monster's voice in the world: gait footfalls + a breath bed. */
  private monsterGain!: GainNode;
  /** HRTF panner. Direction only — distance is handled by the code above it. */
  private monsterPan!: PannerNode;
  /** Last lateral value written, purely so `probe()` can still report a pan number. */
  private monsterPanValue = 0;
  private monsterMuffle!: BiquadFilterNode;
  /** Distance-driven send into the corridor. Rises with distance, not with level. */
  private monsterSend!: GainNode;
  private breathSrc: AudioBufferSourceNode | null = null;
  private breathGain!: GainNode;
  private gaitPhase = 0;
  private monsterFootLeft = false;
  /**
   * Smoothed occlusion, 0 = fully muffled behind walls, 1 = clear line of sight.
   *
   * Deliberately NOT private: a measurement harness binning "can you hear him"
   * by line of sight has to bin on the quantity the MIX responds to. The obvious
   * alternative, `__GAME_STATE__.monsterSeesPlayer`, answers a different question
   * — whether the player is inside HIS vision cone — and a monster in plain view
   * down a corridor who has not noticed you yet is the most common way you hear
   * him clearly. Binning on his cone filed every one of those samples under
   * "behind a wall" and left the LOS rows empty across two full runs.
   */
  openness = 0;

  /**
   * The vocal state machine. One gain node per state, all feeding monsterPan, so
   * a transition is a genuine crossfade between two live vocal beds rather than a
   * cut. Vocals are retriggered one-shots on a per-state random timer, exactly as
   * HPL2 does it: the bed is not a loop, it is a repeated utterance.
   */
  private vocalGains!: Record<VocalState, GainNode>;
  private vocalBank!: Record<Exclude<VocalState, 'silent'>, AudioBuffer[]>;
  private noticeBuf: AudioBuffer | null = null;
  private vocalState: VocalState = 'silent';
  private vocalTimer = 0;
  private vocalNextAt = 0;
  private vocalFires: Record<VocalState, number> = { silent: 0, idle: 0, alert: 0, hunt: 0 };
  /** Edge detector for the notice sting when the caller does not pass justSpotted. */
  private wasHunting = false;

  /** Ambience/chase attenuation applied on top of the crossfade when he speaks. */
  private bedDuckGain!: GainNode;
  private bedDuckValue = 1;

  private knockTimer = 0;
  private nextKnockAt = 0;
  private started = false;

  /** Crossfade bookkeeping, so a reversal knows where it actually is. */
  private chaseTarget = false;
  private fadeEndsAt = 0;

  constructor() {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

    this.master = this.ctx.createGain();
    this.master.gain.value = 1;

    // The BED compressor. It keeps the beds and one-shots from summing into mush
    // at the ceiling. It governs the bed and nothing else — the scare is wired
    // around it entirely, for the reason spelled out at `scareLimiter` below.
    this.limiter = this.ctx.createDynamicsCompressor();
    const L = CFG.audio.dynamics;
    this.limiter.threshold.value = L.threshold;
    this.limiter.knee.value = L.knee;
    this.limiter.ratio.value = L.ratio;
    this.limiter.attack.value = L.attack;
    this.limiter.release.value = L.release;

    this.duckGain = this.ctx.createGain();
    this.duckGain.gain.value = 1;

    // The scare bus. It exists for exactly one reason: the jumpscare must not be
    // attenuated by its own duck.
    //
    // Everything else in the game — beds, monster, knocks, footsteps, reverb
    // return — hangs off `duckGain`, and `jumpscare()` pulls `duckGain` down to
    // 0.12 to clear the stage. But the scare one-shot was played through `play()`,
    // which also connects into `duckGain`, so the scare was multiplied by the very
    // duck that was supposed to make room for it. Measured directly: the same
    // buffer through the ducked bus peaked at 0.0002 against 0.6536 through an
    // open bus — a 70 dB self-inflicted loss at the duck floor, and the reason the
    // scare measured QUIETER than the material it is supposed to punctuate.
    //
    // Routing it here — past the duck, and (see below) past the BED compressor
    // as well, but still under `master` so the player's volume setting governs
    // it — means the duck now only ducks the things that are meant to get out of
    // the way.
    //
    // KNOWN BOUNDARY, stated rather than papered over: `game.ts setPaused()` also
    // uses `duck()`, so a sound on this bus would not dim when the player pauses.
    // That is unreachable today — pausing is disabled once the phase is `caught`,
    // which is the only phase in which anything plays here, and the scare is a ~2s
    // one-shot. If a second sound is ever put on this bus, that assumption dies
    // and the bus needs its own pause-aware gain.
    this.scareBus = this.ctx.createGain();
    this.scareBus.gain.value = 1;

    // The scare's own brickwall, and the reason the scare finally punches.
    //
    // Bypassing the duck was necessary but not sufficient. The scare still
    // summed into the shared BED compressor, and a compressor cannot tell a
    // scare from a bed when they are the same bus — so it gain-reduced the
    // scare's transient by 7.86 dB and pinned its peak regardless of context.
    // Measured off master PCM, same buffer, same duck, before this change:
    //
    //   fired into a QUIET stage : pre 0.2181 -> scare 0.6872  (+9.97 dB)
    //   fired into a CHASE  bed  : pre 0.7012 -> scare 0.6833  (-0.22 dB)
    //
    // A 0.05 dB difference in the scare's own peak across a 10 dB difference in
    // what preceded it is a hard ceiling, not a mix. The scare landed QUIETER
    // than the corridor it interrupts, which makes it a dip rather than
    // punctuation. The stage was being cleared and then the hit was flattened
    // into the hole it had just made.
    //
    // So the scare gets its own limiter and its own path to `master`. This node
    // is a true brickwall (threshold ~-1 dBFS, 20:1, hard knee) that is
    // transparent until the signal would clip: it stops the DAC distorting and
    // does nothing else. The bed compressor keeps its -18/4:1 settings, which
    // are correct *for the bed* — the same node was separately documented eating
    // 7.6 dB of the knock distance cue, and the answer there was likewise to
    // stage around it rather than detune it.
    this.scareLimiter = this.ctx.createDynamicsCompressor();
    const S = CFG.audio.scareDynamics;
    this.scareLimiter.threshold.value = S.threshold;
    this.scareLimiter.knee.value = S.knee;
    this.scareLimiter.ratio.value = S.ratio;
    this.scareLimiter.attack.value = S.attack;
    this.scareLimiter.release.value = S.release;

    // The OUTPUT safety brickwall, after `master` and after the two buses sum.
    //
    // This is not redundant with `scareLimiter`, and the difference cost a real
    // measurement to find. Each bus limiter only sees its own bus, so each one
    // can be perfectly within its ceiling while the SUM is not. Splitting the
    // scare off the bed compressor removed the thing that had been (badly,
    // by flattening the scare) holding the total down. Measured at a real
    // AI-driven catch, with per-bus limiting in place but nothing on the sum:
    //
    //   bed peak 0.7938 + scare peak -> master peak 1.2675, 268 CLIPPED SAMPLES
    //   scareLimiter.reduction at that moment: -0.01 dB (its own bus was fine)
    //
    // The scare bus was innocent and the output still distorted, because nothing
    // owned the sum. Hard clipping in the DAC is the one failure worse than a
    // flattened scare: it is audible as crackle exactly at the loudest, most
    // important moment in the game.
    //
    // Ratio 20:1 at -0.5 dBFS with a hard knee and a 1 ms attack, so it is
    // inaudible until the sum would actually clip and then stops it dead. It
    // does NOT re-flatten the scare: it engages on the sum's overshoot only,
    // which is a fraction of a dB of material, whereas the bed compressor was
    // engaging on the scare's entire transient by 7.86 dB.
    this.outputLimiter = this.ctx.createDynamicsCompressor();
    const O = CFG.audio.outputCeiling;
    this.outputLimiter.threshold.value = O.threshold;
    this.outputLimiter.knee.value = O.knee;
    this.outputLimiter.ratio.value = O.ratio;
    this.outputLimiter.attack.value = O.attack;
    this.outputLimiter.release.value = O.release;

    this.duckGain.connect(this.limiter);
    this.limiter.connect(this.master);
    // The scare path: scareBus -> its own brickwall -> master. It never touches
    // `limiter`, so nothing the bed is doing can duck, pin or shape the hit.
    this.scareBus.connect(this.scareLimiter);
    this.scareLimiter.connect(this.master);
    this.master.connect(this.outputLimiter);
    this.outputLimiter.connect(this.ctx.destination);

    // The headless harness drives and measures the real engine through this — no
    // parallel mock, no simulated graph. It reads the same AudioParams the player
    // hears. Attached here rather than in the game so the audio lane can be
    // verified without reaching into a file it does not own.
    (window as any).__AUDIO__ = this;
  }

  get context() { return this.ctx; }

  async load(base: string, onProgress?: (loaded: number, total: number) => void) {
    const entries = Object.entries(FILES) as [SoundName, string][];
    let done = 0;
    await Promise.all(entries.map(async ([name, file]) => {
      const res = await fetch(`${base}${file}`);
      if (!res.ok) throw new Error(`audio: ${file} -> HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      this.buffers.set(name, await this.ctx.decodeAudioData(bytes));
      onProgress?.(++done, entries.length);
    }));

    // Both beds pass through bedDuckGain before the main bus. This is the node the
    // monster pushes down when he vocalises, so his voice cuts a hole in the mix
    // rather than competing with a 0.55 bed for the same space. It sits *after* the
    // crossfade gains and before duckGain, so it composes with both without either
    // one overwriting the other — three independent things (crossfade, monster
    // ducking, jumpscare ducking) each own exactly one AudioParam.
    this.bedDuckGain = this.ctx.createGain();
    this.bedDuckGain.gain.value = 1;
    this.bedDuckGain.connect(this.duckGain);

    this.ambienceGain = this.ctx.createGain();
    this.ambienceGain.gain.value = 0;
    this.ambienceGain.connect(this.bedDuckGain);

    this.chaseGain = this.ctx.createGain();
    this.chaseGain.gain.value = 0;
    this.chaseGain.connect(this.bedDuckGain);

    this.buildReverb();
    this.buildMonsterChain();
    this.buildVocals();
  }

  // ---- stone corridor space -------------------------------------------------

  /**
   * A synthesized impulse response for the corridor. Cheap, deterministic, and
   * no extra asset to ship.
   *
   * Shape: a short pre-delay of near-silence (the time for sound to reach the
   * far wall and come back), then exponentially decaying noise. The noise is
   * darkened progressively over the tail because stone absorbs high frequencies
   * faster than low ones — a flat-spectrum tail sounds like a plate, not a
   * cellar. Stereo decorrelation between the two channels gives it width.
   */
  private buildReverb() {
    const r = CFG.audio.reverb;
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * r.seconds));
    const preDelay = Math.floor(rate * r.preDelay);
    const ir = this.ctx.createBuffer(2, len, rate);

    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      // One-pole lowpass state, per channel, whose coefficient closes over the tail.
      let lp = 0;
      for (let i = 0; i < len; i++) {
        if (i < preDelay) { data[i] = 0; continue; }
        const t = (i - preDelay) / (len - preDelay);
        // Exponential decay; r.decay controls how fast the room dies.
        const env = Math.pow(1 - t, r.decay);
        const white = Math.random() * 2 - 1;
        // Coefficient falls from open to closed across the tail -> darkening stone.
        const a = r.tone * (1 - t * 0.85);
        lp += a * (white - lp);
        data[i] = lp * env;
      }
    }

    this.convolver = this.ctx.createConvolver();
    this.convolver.normalize = true;
    this.convolver.buffer = ir;

    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = r.wet;
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.duckGain);
  }

  // ---- the monster you hear before you see -----------------------------------

  /**
   * The monster's bus. Everything he emits runs through one pan -> muffle -> gain
   * chain, so his footfalls and his breathing always agree about where he is and
   * how much wall is in the way.
   */
  private buildMonsterChain() {
    const m = CFG.audio.monster;

    this.monsterGain = this.ctx.createGain();
    this.monsterGain.gain.value = 0;

    // The occlusion filter. Wide open on clear line of sight, clamped down to a
    // thud when he is behind stone. This is the whole trick: you always hear him,
    // but only hear him *clearly* when there is nothing between you.
    this.monsterMuffle = this.ctx.createBiquadFilter();
    this.monsterMuffle.type = 'lowpass';
    this.monsterMuffle.frequency.value = m.occludedCutoff;
    this.monsterMuffle.Q.value = 0.7;

    // Spatialisation.
    //
    // A StereoPannerNode is a one-dimensional L/R fader. It was measured placing
    // the monster correctly left and right — and placing him 5m directly IN FRONT
    // and 5m directly BEHIND at literally identical output, L/R 0.98 vs 1.02. In a
    // maze where he is behind you most of the time, "is that in front of me or
    // about to be on top of me" is the single most useful thing audio can tell
    // you, and a stereo panner structurally cannot say it.
    //
    // So the monster gets a real PannerNode in HRTF mode — the same head-related
    // transfer function approach OpenAL gives Amnesia. It applies the interaural
    // time and level differences AND the spectral pinna cues that are what
    // actually resolve front from back. Distance handling is left switched off
    // (`linear` with a huge maxDistance, refDistance == maxDistance) because the
    // existing rolloff + occlusion code already does distance far better than the
    // node's built-in curves, and having two things attenuate would put us right
    // back in the double-attenuation hole that made him inaudible in the first
    // place. The panner is used for DIRECTION only.
    this.monsterPan = this.ctx.createPanner();
    this.monsterPan.panningModel = 'HRTF';
    this.monsterPan.distanceModel = 'linear';
    this.monsterPan.refDistance = 1;
    this.monsterPan.maxDistance = 1;
    this.monsterPan.rolloffFactor = 0;
    this.monsterPan.coneInnerAngle = 360;

    // The listener sits at the origin facing -Z, and the monster is placed on the
    // unit sphere around it in listener-local coordinates. Keeping the listener
    // fixed and rotating the source into its frame — rather than moving the
    // listener with the player — means the whole thing stays a pure function of
    // the frame we were handed, with no accumulated state to drift.
    const lis = this.ctx.listener;
    if (lis.positionX) {
      lis.positionX.value = 0; lis.positionY.value = 0; lis.positionZ.value = 0;
      lis.forwardX.value = 0; lis.forwardY.value = 0; lis.forwardZ.value = -1;
      lis.upX.value = 0; lis.upY.value = 1; lis.upZ.value = 0;
    } else {
      // Older signature, still shipping in some browsers.
      (lis as any).setPosition?.(0, 0, 0);
      (lis as any).setOrientation?.(0, 0, -1, 0, 1, 0);
    }

    this.monsterPan.connect(this.monsterMuffle);
    this.monsterMuffle.connect(this.monsterGain);
    this.monsterGain.connect(this.duckGain);

    // He lives in the same room you do — and the amount of that room you hear
    // around him is the single strongest distance cue the ear actually has.
    //
    // The send is driven per-frame (see `updateMonsterAudio`) and rises with
    // distance. That is deliberately the opposite of what a fixed send does when
    // it hangs off `monsterGain`: a fixed send scales down with him, so a distant
    // monster gets *less* room, which is backwards. Real distance raises the
    // wet/dry ratio — close sources are mostly direct sound, far ones are mostly
    // the reflections that reached you off four walls.
    this.monsterSend = this.ctx.createGain();
    this.monsterSend.gain.value = m.reverbSend;
    this.monsterGain.connect(this.monsterSend);
    this.monsterSend.connect(this.convolver);

    // Breath bed: a continuously running noise loop, shaped into something
    // lung-like by a bandpass. Its gain is driven per-frame by proximity, so it
    // swells as he closes. Generated, not sampled — there is no breath asset and
    // inventing a filename would be a lie.
    this.breathGain = this.ctx.createGain();
    this.breathGain.gain.value = 0;
    this.breathGain.connect(this.monsterPan);

    const breathBuf = this.makeBreathBuffer();
    const src = this.ctx.createBufferSource();
    src.buffer = breathBuf;
    src.loop = true;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = m.breathCentreHz;
    band.Q.value = 0.9;
    src.connect(band);
    band.connect(this.breathGain);
    this.breathSrc = src;
  }

  /**
   * A few seconds of breath-shaped noise: filtered noise amplitude-modulated by a
   * slow asymmetric envelope (fast in, slow out — inhale is sharper than exhale).
   */
  private makeBreathBuffer() {
    const m = CFG.audio.monster;
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * m.breathLoopSeconds);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    const cycle = rate * m.breathPeriod;
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      lp += 0.16 * (white - lp);           // brown-ish noise, body not hiss
      const ph = (i % cycle) / cycle;      // 0..1 over one breath
      // Asymmetric: rises over the first 35%, falls over the remaining 65%.
      const env = ph < 0.35
        ? Math.sin((ph / 0.35) * Math.PI * 0.5)
        : Math.pow(1 - (ph - 0.35) / 0.65, 1.6);
      d[i] = lp * env;
    }
    return buf;
  }

  // ---- the vocal state machine ----------------------------------------------

  /**
   * Build the per-state vocal buses and bake their sample banks.
   *
   * Why this exists at all: the shipped build's entire monster vocabulary was
   * bandpassed noise at 340 Hz plus *the player's own footstep samples pitched to
   * 0.7x*. Frictional's own `LuxEnemy.cpp` contains no enemy footstep code
   * whatsoever — their monster is voice-first, driven by a four-state machine with
   * per-state ambient vocals on random retrigger timers and a 3s fade between
   * states. That is what is reproduced here.
   *
   * Each state gets its own gain node feeding the shared monsterPan, so all the
   * spatialisation, occlusion and distance work already in that chain applies to
   * the voice for free, and a state change is a crossfade of two live beds.
   */
  private buildVocals() {
    const v = CFG.audio.monster.vocal;

    const mk = () => {
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.connect(this.monsterPan);
      return g;
    };
    // Silent gets a bus like the others even though nothing is ever routed into
    // it. That is deliberate and it is how HPL2 models it too: Silent is a real
    // state, not the absence of one. Giving it a node means the crossfade loop can
    // treat all four uniformly — entering Silent fades the other three DOWN over
    // the same 3s as any other transition, so he trails off rather than being cut.
    // Its own gain is therefore only ever a readout, which `probe()` reports.
    this.vocalGains = { silent: mk(), idle: mk(), alert: mk(), hunt: mk() };

    // Attach the articulation gesture from the glide table. Kept out of the
    // per-state config blocks so the table reads as a table; see the note on
    // `VocalSpec.glideStart`.
    const withGlide = (
      spec: VocalSpec,
      g: {
        start: readonly number[]; end: readonly number[];
        peak: readonly number[]; knee: number;
      },
    ): VocalSpec => ({
      ...spec, glideStart: g.start, glideEnd: g.end,
      glidePeak: g.peak, glideKnee: g.knee,
    });

    const idleSpec = withGlide(v.idle, v.glide.idle);
    const alertSpec = withGlide(v.alert, v.glide.alert);
    const huntSpec = withGlide(v.hunt, v.glide.hunt);
    const noticeSpec = withGlide(v.notice, v.glide.notice);

    const bake = (spec: VocalSpec) =>
      Array.from({ length: v.variants }, (_, i) => this.makeVocal(spec, i));

    this.vocalBank = {
      idle: bake(idleSpec),
      alert: bake(alertSpec),
      hunt: bake(huntSpec),
    };
    this.noticeBuf = this.makeVocal(noticeSpec, 0);

    // ---- the throat layer ---------------------------------------------------
    // Fold material derived from `jumpscare.ogg` into every utterance, so the
    // voice you hear in the corridor is literally made of the sound that ends
    // the run. See `bakeThroat` for the method and the config block for the
    // measurements that motivated it.
    //
    // This mutates the buffers baked above in place rather than adding a parallel
    // bus, and that is deliberate: two buses would be two sounds that have to be
    // kept in sync forever, and would let the derived layer drift away from the
    // utterance it belongs to. One buffer is one voice.
    const th = v.throat;
    this.throatMixed = 0;
    for (const [state, slice, gain] of [
      ['idle', th.idle, th.idleGain],
      ['alert', th.alert, th.alertGain],
      ['hunt', th.hunt, th.huntGain],
    ] as const) {
      const bank = this.vocalBank[state];
      for (let i = 0; i < bank.length; i++) {
        if (this.mixThroat(bank[i], slice, gain, i)) this.throatMixed++;
      }
    }
    if (this.noticeBuf && this.mixThroat(this.noticeBuf, th.notice, th.noticeGain, 0)) {
      this.throatMixed++;
    }

    // The body. See `makeDrag`.
    const dg = CFG.audio.monster.drag;
    this.dragGain = this.ctx.createGain();
    this.dragGain.gain.value = 0;
    this.dragGain.connect(this.monsterPan);
    this.dragBank = Array.from({ length: dg.variants }, (_, i) => this.makeDrag(i));
  }

  /**
   * How many buffers actually received derived material. Exposed through
   * `probe()` because "the hunt voice is made from the scream" is a claim that a
   * test must be able to falsify — and the honest failure mode here is silent:
   * if `jumpscare.ogg` were ever missing or renamed, `mixThroat` would decline
   * to run and the voice would quietly revert to pure synthesis with no error
   * anywhere. A count that a test can assert against is the difference between a
   * feature and a hope. (PROGRESS.md trap 14: assert that your assertion has
   * subjects.)
   */
  private throatMixed = 0;

  /**
   * Mix a slice of `jumpscare.ogg` into an already-baked synthesized utterance.
   *
   * The derived layer is not a sample playing behind a growl — that reads as two
   * sounds. Four things make it read as ONE voice:
   *
   *  1. **Resampled, not retriggered.** The slice is read at `rate` by linear
   *     interpolation, which pitches it down and lengthens it together, exactly
   *     as a playbackRate change would. Reading it slow drops the scream out of
   *     a child's register into his, and — measured — INCREASES its centroid
   *     movement in semitone terms, because resampling scales the excursion.
   *  2. **Band-limited.** Highpassed off his fundamental (which the synthesis
   *     owns) and lowpassed so it sits UNDER the synthesized formants rather
   *     than on top of them. Mixed in flat, the raw scream's sibilance was the
   *     brightest thing present and the ear separated it out immediately.
   *  3. **Envelope-matched.** The derived material is forced to follow the
   *     synthesized utterance's own amplitude envelope. This is the step that
   *     actually fuses them: two signals that rise and fall together are heard
   *     as one source, and two that do not are heard as two. It also means the
   *     derived layer inherits the state's phrasing for free — a long unhurried
   *     idle groan and a short hunt snarl get the same treatment without either
   *     needing its own edit.
   *  4. **Looped to length with a crossfade if short.** A slice shorter than the
   *     utterance is wrapped with an equal-power crossfade rather than
   *     hard-repeated, because a hard repeat is precisely the audible loop this
   *     whole exercise is trying to avoid.
   *
   * Returns false if the source buffer is unavailable, so the caller can count
   * what really happened rather than assume.
   */
  private mixThroat(
    target: AudioBuffer,
    slice: { from: number; to: number; rate: number },
    gain: number,
    variant: number,
  ): boolean {
    const scare = this.buffers.get('jumpscare');
    if (!scare || gain <= 0) return false;

    const rate = this.ctx.sampleRate;
    const srcRate = scare.sampleRate;
    const s = scare.getChannelData(0);
    const out = target.getChannelData(0);
    const len = out.length;

    // Slice bounds in SOURCE samples, clamped to the file.
    const a = Math.max(0, Math.floor(slice.from * srcRate));
    const b = Math.min(s.length, Math.floor(slice.to * srcRate));
    const span = b - a;
    if (span < 64) return false;

    // Per-variant read offset so the three variants of a state do not all draw
    // the identical stretch of the scream — that would be an audible loop across
    // the bank, which is one of the four failure modes being fixed here.
    const jitter = Math.floor((variant * 0.17) * span) % Math.max(1, span);

    // --- resample the slice, wrapping with a crossfade if it runs out ---------
    // Read rate accounts for any sample-rate difference between the file and the
    // context as well as the musical pitch shift, so the same config value means
    // the same pitch on a 44.1k and a 48k context.
    const step = slice.rate * (srcRate / rate);
    const xf = Math.min(Math.floor(span * 0.25), Math.floor(0.08 * srcRate));
    const derived = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      // Position within the slice, wrapped.
      let p = (i * step + jitter) % span;
      const read = (q: number) => {
        const idx = a + q;
        const i0 = Math.floor(idx);
        const f = idx - i0;
        const s0 = s[i0] ?? 0, s1 = s[i0 + 1] ?? 0;
        return s0 + (s1 - s0) * f;
      };
      let v = read(p);
      // Equal-power wrap: as the read head approaches the end of the slice, fade
      // in a second head starting at the beginning.
      if (xf > 0 && p > span - xf) {
        const k = (p - (span - xf)) / xf;         // 0..1
        const w = Math.sin(k * Math.PI * 0.5);
        v = v * Math.cos(k * Math.PI * 0.5) + read(p - (span - xf)) * w;
      }
      derived[i] = v;
    }

    // --- band-limit ------------------------------------------------------------
    // One-pole each way. Cheap and, at bake time, entirely adequate — this is a
    // supporting layer, not the thing carrying the formants.
    const th = CFG.audio.monster.vocal.throat;
    const aLp = 1 - Math.exp((-2 * Math.PI * th.lp) / rate);
    const aHp = 1 - Math.exp((-2 * Math.PI * th.hp) / rate);
    let lp = 0, hpState = 0;
    for (let i = 0; i < len; i++) {
      lp += aLp * (derived[i] - lp);
      hpState += aHp * (lp - hpState);
      derived[i] = lp - hpState;               // bandpass = lowpass minus its own lowpass
    }

    // --- envelope-match against the synthesized utterance ----------------------
    // Both envelopes are measured on the same hop so they are directly
    // comparable, then the derived layer is scaled to follow the target's shape.
    const hop = Math.max(1, Math.floor(rate * 0.01));
    const envOf = (d: Float32Array) => {
      const e = new Float32Array(Math.ceil(len / hop));
      for (let h = 0; h < e.length; h++) {
        let sum = 0, n = 0;
        for (let i = h * hop; i < Math.min(len, (h + 1) * hop); i++) { sum += d[i] * d[i]; n++; }
        e[h] = Math.sqrt(sum / Math.max(1, n));
      }
      return e;
    };
    // --- attack ramp on the derived layer --------------------------------------
    // THIS IS WHAT PAYS FOR THE ARTICULATION GESTURE, and it is the whole reason
    // the glide could be restored rather than flattened again.
    //
    // `onsetAir` previously measured 15.17 against the authored scream's 3.897 —
    // an onset four times more abrupt than a real scream — and the previous wave
    // fixed it by HALVING the formant glide, i.e. by paying with the one gesture
    // that made him sound like a throat rather than a filter.
    //
    // The abruptness was never in the synthesis. `notice` reads the scream from
    // 0.00 s and hunt/alert from 0.20 s, so the derived layer can begin ON the
    // scream's own hard attack and is then dropped in at full level at sample
    // zero — a step discontinuity, which is a click. A short raised-cosine
    // fade-in on the DERIVED material alone removes the step and leaves both the
    // synthesized onset and the entire glide untouched. The airflow transient
    // still arrives; it arrives as air instead of as an edit.
    const ramp = Math.min(len, Math.max(1, Math.floor(th.attack * rate)));
    for (let i = 0; i < ramp; i++) {
      // Raised cosine: zero value AND zero slope at i=0, so neither the sample
      // nor its derivative steps. A linear ramp still corners audibly here.
      derived[i] *= 0.5 - 0.5 * Math.cos((i / ramp) * Math.PI);
    }

    const eT = envOf(out), eD = envOf(derived);
    let peakT = 0;
    for (const x of eT) if (x > peakT) peakT = x;
    if (peakT < 1e-6) return false;

    // --- sum -------------------------------------------------------------------
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const h = Math.min(eT.length - 1, (i / hop) | 0);
      // Gain that maps the derived layer's local level onto the target's, blended
      // toward flat by `envFollow` so some of the derived material's own dynamics
      // survive — a fully-forced envelope sounds like a gate.
      const want = eT[h] / Math.max(1e-5, eD[h]);
      const follow = 1 + (want - 1) * th.envFollow;
      // Clamp: an envelope ratio in a near-silent hop can explode.
      const k = Math.min(6, Math.max(0, follow));
      const v = out[i] + derived[i] * k * gain;
      out[i] = v;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
    // Re-normalise to the same headroom `makeVocal` uses, so adding this layer
    // does not change what `gain` means in the per-state config.
    if (peak > 1e-6) {
      const n = 0.85 / peak;
      for (let i = 0; i < len; i++) out[i] *= n;
    }
    return true;
  }

  /**
   * The sound of his body moving — and the reason it is a separate layer from
   * his voice.
   *
   * GAME-SPEC §1: he is the player's own melted flesh wound in cords around the
   * son's surviving pieces. §6a: think Ennard, a figure built out of thick
   * wires, except the wires are meat. A creature shaped like that does not walk
   * quietly and it does not walk like a person. Loose wet cord hangs off him and
   * drags, and that drag is the single most specific thing audio can say about
   * what he is. A growl says "monster"; wet rope hauled over stone says *this*
   * monster.
   *
   * The previous build's answer to "what does his body sound like" was the
   * PLAYER'S OWN footstep samples at 0.7x rate. That is worse than nothing:
   * it is the sound of a person in boots, so the one channel that could have
   * carried his anatomy instead insisted he was an ordinary man.
   *
   * Synthesis, and every term is doing a specific job:
   *
   *  - **Wet, not dry.** Two noise streams: a broadband scrape, and a resonant
   *    low body. The wetness is a fast, irregular amplitude flutter on the
   *    scrape — sticking and releasing, the way a saturated rope does on stone
   *    rather than sliding evenly like a dry one. A steady hiss reads as fabric.
   *  - **A slither contour, not a hit.** The envelope swells and dies over a
   *    long stroke instead of an impact transient. A transient would be a
   *    footstep; this must read as something *continuous* being pulled.
   *  - **Low resonance under it.** A lowpassed band with a little Q gives the
   *    mass — the ear reads a low-frequency body under a scrape as "that is
   *    heavy". Without it the drag is a small sound, and he is not small.
   *  - **A pitch fall across the stroke.** The resonance sags as the stroke
   *    ends, which is what happens as the coil settles. It is also the cue that
   *    stops repeated strokes reading as a loop.
   */
  private makeDrag(variant: number) {
    const g = CFG.audio.monster.drag;
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * g.length));
    const buf = this.ctx.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);

    // Per-variant character, symmetric about the spec.
    const k = 1 + (variant - (g.variants - 1) / 2) * 0.13;

    // Resonant low body: a state-variable lowpass swept down across the stroke.
    let lp1 = 0, lp2 = 0;
    // Broadband scrape: a highpassed noise, tracked as a difference.
    let hpPrev = 0, hpOut = 0;
    // The wet flutter: a slow random walk that gates the scrape irregularly.
    let flut = 0, flutTarget = 1;
    let flutHold = 0;

    let peak = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const white = Math.random() * 2 - 1;

      // --- wet stick-slip flutter ---------------------------------------------
      // Re-target on a short random hold, so the gate is irregular rather than
      // periodic. Periodic amplitude modulation is a tremolo and sounds musical;
      // rope catching and letting go is neither periodic nor smooth.
      if (flutHold <= 0) {
        flutTarget = g.wetFloor + Math.random() * (1 - g.wetFloor);
        flutHold = Math.floor(rate * (g.wetMinHold + Math.random() * (g.wetMaxHold - g.wetMinHold)));
      }
      flutHold--;
      flut += (flutTarget - flut) * g.wetSlew;

      // --- scrape: one-pole highpass on the noise ------------------------------
      hpOut = g.scrapeHp * (hpOut + white - hpPrev);
      hpPrev = white;
      const scrape = hpOut * flut;

      // --- body: two-pole lowpass, cutoff falling across the stroke ------------
      // Coefficient from the sweeping cutoff. Falls to `bodyEndRatio` of its
      // start, which is the coil settling as the stroke runs out.
      const a = g.bodyCoef * k * (1 - t * (1 - g.bodyEndRatio));
      lp1 += a * (white - lp1);
      lp2 += a * (lp1 - lp2);
      const body = lp2 * g.bodyGain;

      // --- stroke envelope ------------------------------------------------------
      // Slow swell, long fall. Deliberately NOT an attack transient: an impact
      // would read as a footfall, and the whole point is that this is a pull.
      const env = t < g.swell
        ? Math.pow(t / g.swell, 1.4)
        : Math.pow(1 - (t - g.swell) / (1 - g.swell), 1.8);
      // Smooth the corner so the join is not a click.
      const e = env * env * (3 - 2 * env);

      const s = (scrape * g.scrapeGain + body) * e;
      out[i] = s;
      const abs = s < 0 ? -s : s;
      if (abs > peak) peak = abs;
    }

    // Normalise to fixed headroom so `gain` in config means one thing.
    if (peak > 1e-6) {
      const n = 0.85 / peak;
      for (let i = 0; i < len; i++) out[i] *= n;
    }
    return buf;
  }

  /**
   * One drag stroke, fired from the gait accumulator so his body sounds tied to
   * his movement rather than sprinkled over it at random.
   */
  private fireDrag(chasing: boolean) {
    if (!this.dragBank?.length) return;
    const g = CFG.audio.monster.drag;
    const src = this.ctx.createBufferSource();
    src.buffer = this.dragBank[(Math.random() * this.dragBank.length) | 0];
    // Faster and higher when he runs — the cords are being whipped rather than
    // hauled. Chase also shortens the stroke, which is what makes the drag read
    // as urgency instead of just as more of the same sound.
    src.playbackRate.value = (chasing ? g.chaseRate : g.walkRate) * (0.9 + Math.random() * 0.2);
    const gain = this.ctx.createGain();
    gain.gain.value = (chasing ? g.chaseGain : g.walkGain) * (0.8 + Math.random() * 0.4);
    src.connect(gain);
    gain.connect(this.dragGain);
    src.start();
    this.dragFires++;
  }

  private dragBank: AudioBuffer[] = [];
  private dragGain!: GainNode;
  private dragFires = 0;
  private dragPhase = 0;

  /**
   * Synthesize one vocalisation.
   *
   * A throat is two things at once: a *pitched* glottal source — the vocal folds
   * slapping shut at f0 — and turbulent noise from air forcing past them, both
   * shaped by the resonances of the tube above. Filtered noise alone has no f0, so
   * it reads as wind or hiss; that is precisely why the old 340 Hz breath bed
   * carried no information about a creature.
   *
   * So, in order:
   *
   *  - **Glottal source.** Not a sine and not a raw sawtooth. Each pitch period
   *    gets a Liljencrants-Fant-ish asymmetric pulse: a slow rise then a sharp
   *    closure. The sharp closure is what generates the upper harmonics a formant
   *    filter needs something to resonate *with* — a sine gives the formants
   *    nothing to work on and comes out as a hum.
   *  - **Jitter.** Real folds are not a clock. A few percent of period-to-period
   *    randomness is the difference between a creature and a synthesizer.
   *  - **Roughness.** A sub-audio amplitude/period modulation at `rough` Hz. This
   *    is the growl gesture: vocal fry, the folds beating irregularly. Slow (17Hz)
   *    reads as a groan, fast (41Hz) as a snarl.
   *  - **Pitch envelope.** f0 -> f0End across the utterance. Rising is
   *    interrogative (alert: "what was that"), falling is a settling groan (idle).
   *    This gesture, more than the timbre, is what tells the player which state he
   *    is in.
   *  - **Formants.** Three resonant bandpasses in parallel, hand-run as biquads on
   *    the sample buffer rather than as graph nodes, so a whole utterance is one
   *    buffer that can be fired as a cheap one-shot with no per-voice filter cost.
   *  - **Amplitude envelope.** Fast-ish attack, long decay, plus a tremolo. Not a
   *    gate: a vocalisation that starts and stops instantly reads as an edit.
   *
   * `variant` seeds nothing random directly — it just means each baked buffer gets
   * a different random walk, and slightly different formant/pitch offsets, so the
   * three variants of a state are recognisably the same creature and audibly not
   * the same take.
   */
  private makeVocal(spec: VocalSpec, variant: number) {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * spec.length));
    const buf = this.ctx.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);

    // Per-variant detune, symmetric about the spec so the set averages to it.
    const detune = 1 + (variant - 1) * 0.055;
    const fShift = 1 + (variant - 1) * 0.06;

    // --- glottal source + noise ------------------------------------------------
    const src = new Float32Array(len);
    let phase = 0;          // 0..1 within the current pitch period
    let period = rate / (spec.f0 * detune);
    let noiseLp = 0;

    // ---- the roughness RATE, which wanders -----------------------------------
    //
    // This used to be `Math.sin(2 * Math.PI * spec.rough * t)` — a single sine at
    // a fixed rate. The comment above it claimed "the folds beating irregularly"
    // and the code was perfectly regular, which is exactly the kind of gap
    // between a name and a behaviour that this codebase treats as a defect.
    //
    // It was caught by measuring the AMPLITUDE-MODULATION SPECTRUM in the vocal
    // fry band (8-80 Hz) and reporting peak/median — a line scores high, a band
    // scores low (`tools/aud/streamjudge.py`). Off the shipped build:
    //
    //   idle-0/1/2     13.31 / 12.75 / 15.45   all peaking at exactly 17.0 Hz
    //   alert-0/1/2    11.09 /  9.39 / 10.98   all at exactly 25.9 Hz
    //   hunt-0/1/2      8.66 /  7.71 /  8.26   all at exactly 40.6 Hz
    //   JUMPSCARE(ref)  3.10                         at 43.4 Hz
    //
    // Every variant of every state peaked at precisely its config `rough` value,
    // because a sine has all its energy at one frequency. The authored throat
    // puts its fry energy in a BAND in the same region. That fixed line is what
    // a listener hears as a buzz at a constant rate, and no amount of formant
    // glide downstream can disguise it, because the problem is in the source.
    //
    // So the rate itself now performs a bounded, smooth random walk about the
    // configured nominal (`roughWander`), plus a second incommensurate component
    // (`roughSecond`) — a single smoothly-wandering rate still concentrates near
    // its mean, and the second term is what actually fills the band.
    //
    // Swept offline first (`tools/aud/protorough.py`, the same discipline that
    // validated the formant glide: the offline model reproduces the shipped
    // sine's numbers before anything is changed). Chosen values, mean of 3 seeds:
    //
    //   state   sine    wander+   reference
    //   idle    12.09     6.62      3.10
    //   alert   13.78     4.18
    //   hunt    12.35     3.04
    //
    // And it is FREE against everything this lane already holds — `centStd` moves
    // 4.01->4.12, 4.60->4.59, 4.16->4.16, and envelope loopiness actually
    // IMPROVES in all three states (0.419->0.352, 0.537->0.389, 0.441->0.323),
    // because a wandering rate cannot line up with itself the way a fixed one
    // does. Verified by `tools/aud/protorough_check.py`.
    //
    // The mean rate is preserved exactly, so the groan/snarl distinction the
    // state machine depends on — slow reads as a groan, fast as a snarl — is
    // untouched. Only its regularity changes.
    const rv = CFG.audio.monster.vocal;
    // Smooth control points for the walk, interpolated across the buffer. Folds
    // change how fast they are beating over tens of milliseconds, not per sample,
    // so generating this at audio rate would be noise rather than a wander.
    const walkPoints = Math.max(4, Math.floor(spec.length * rv.roughWalkHz));
    const walk = new Float32Array(walkPoints);
    for (let k = 0; k < walkPoints; k++) walk[k] = Math.random() * 2 - 1;
    // Three-point smooth, then normalise, so `roughWander` means the same
    // fractional excursion regardless of how the random draw happened to land.
    const walkS = new Float32Array(walkPoints);
    let walkMax = 1e-9;
    for (let k = 0; k < walkPoints; k++) {
      const a = walk[Math.max(0, k - 1)], b = walk[k], c = walk[Math.min(walkPoints - 1, k + 1)];
      walkS[k] = (a + b + c) / 3;
      const abs = Math.abs(walkS[k]);
      if (abs > walkMax) walkMax = abs;
    }
    for (let k = 0; k < walkPoints; k++) walkS[k] /= walkMax;

    // Integrated phase rather than `sin(2*pi*rough*t)`, because a varying rate
    // cannot be expressed by evaluating a sine at a fixed frequency. Reduces to
    // exactly the old behaviour when the rate is constant.
    let roughPhase = 0;

    for (let i = 0; i < len; i++) {
      const t = i / len;

      // Pitch envelope, exponential between the two endpoints so equal musical
      // intervals take equal time — a linear Hz sweep sounds like it decelerates.
      const f0 = spec.f0 * Math.pow((spec.f0End / spec.f0), t) * detune;

      // The instantaneous beating rate: nominal, walked, then stirred by a
      // faster incommensurate term.
      const wp = t * (walkPoints - 1);
      const w0i = Math.min(walkPoints - 1, Math.floor(wp));
      const w1i = Math.min(walkPoints - 1, w0i + 1);
      const wf = wp - w0i;
      const wander = walkS[w0i] + (walkS[w1i] - walkS[w0i]) * wf;
      const roughHz = spec.rough
        * (1 + rv.roughWander * wander)
        * (1 + rv.roughSecond * Math.sin(
          2 * Math.PI * (spec.rough / rv.roughSecondRatio) * (i / rate) + variant,
        ));

      // Roughness: modulate the *period*, not just the amplitude. Modulating
      // amplitude alone gives tremolo; modulating the period is what makes folds
      // sound like they are catching on each other.
      const rough = Math.sin(roughPhase);
      roughPhase += (2 * Math.PI * Math.max(1, roughHz)) / rate;
      period = rate / (f0 * (1 + rough * 0.09));

      phase += 1 / period;
      if (phase >= 1) {
        phase -= 1;
        // Jitter: each new period starts a hair early or late.
        phase += (Math.random() - 0.5) * 0.06;
        if (phase < 0) phase = 0;
      }

      // Asymmetric glottal pulse: 62% opening ramp, 18% sharp closure, then closed.
      // The closure discontinuity is the harmonic generator.
      let glottal: number;
      if (phase < 0.62) {
        glottal = Math.sin((phase / 0.62) * Math.PI * 0.5);
      } else if (phase < 0.80) {
        const c = (phase - 0.62) / 0.18;
        glottal = Math.cos(c * Math.PI * 0.5) * (1 - c * 0.15);
      } else {
        glottal = 0;
      }
      // Bipolar and DC-light.
      glottal = glottal * 2 - 0.55;

      // Breath component: brown-ish noise, the air that is not being phonated.
      const white = Math.random() * 2 - 1;
      noiseLp += 0.22 * (white - noiseLp);

      // Roughness also gates amplitude a little, which is the audible "fry".
      const fry = 1 - Math.max(0, -rough) * 0.45;

      src[i] = (glottal * spec.voiced + noiseLp * (1 - spec.voiced) * 2.2) * fry;
    }

    // --- source tilt correction (pre-emphasis) ---------------------------------
    // The glottal pulse above is a physically-shaped source, and a real glottal
    // source rolls off steeply — about -12 dB/octave. That is correct physics and
    // it is also why the formant bank downstream had nothing to work with up top:
    // measured on the raw source, the band at F2 sits -3.5 dB and the band at F3
    // -4.5 dB below the band at F1 BEFORE any filtering, so F2/F3 were being
    // starved at birth.
    //
    // Real vocal tracts get this back for free: radiation from the lips is a
    // +6 dB/octave differentiator, which is exactly a one-zero highpass. Modelling
    // it is not a cheat, it is the missing half of the source-filter model — the
    // synthesis had the glottis and the tract but not the mouth opening.
    //
    // Measured effect on the long-term spectrum slope over 200-4000 Hz, against
    // the one authored vocalisation we can compare to:
    //
    //     jumpscare.ogg (authored kill)   -19.5 dB/decade
    //     Billy, no pre-emphasis          -26.1 (idle) .. -28.8 (hunt)
    //     Billy, radiationTilt 0.85       -19.9 (idle) .. -14.9 (hunt)
    //
    // So this single line moves our spectral tilt from 7-9 dB/decade steeper than
    // the authored throat to straddling it. Everything the formant bank does below
    // depends on the excitation reaching the upper formants at all.
    const tilt = rv.radiationTilt;
    if (tilt > 0) {
      let prev = src[0];
      for (let i = 1; i < len; i++) {
        const x = src[i];
        src[i] = x - tilt * prev;
        prev = x;
      }
    }

    // --- formants ---------------------------------------------------------------
    // Three parallel resonant bandpasses, run as direct-form biquads over the
    // buffer, each normalised to unit RMS and THEN set to its configured
    // amplitude — so the weight table is a real formant amplitude table rather
    // than three arbitrary scalings of three unequal lanes. See the long note
    // below the glide comment for the measurements that forced that change.
    //
    // THE CENTRES MOVE, and that is the difference between a throat and a filter.
    //
    // This used to compute one set of coefficients per formant and run them over
    // the whole buffer. It was measured against `jumpscare.ogg` — the only
    // authored vocalisation in the game — with `tools/aud/judge.mjs`, which
    // tracks the spectral centroid frame by frame and reports its movement in
    // semitones:
    //
    //     jumpscare.ogg  6.51 semitones of centroid std, 30.31 of range
    //     idle 0.92 · alert 0.83 · hunt 0.56 · notice 0.90
    //
    // Seven to twelve times less movement than the real thing. A static centroid
    // is exactly what "sounds like filtered noise" IS: the ear identifies a
    // vocal tract by hearing it change shape, and a fixed bandpass bank cannot
    // change shape. No amount of source-side roughness fixes it, because the
    // problem is downstream of the source.
    //
    // So the centres are now swept across the utterance (an articulation
    // gesture: mouth opening or closing) with a slow non-monotonic wobble on top,
    // because a clean sweep still reads as automation rather than as tissue. F2
    // travels furthest, F1 least, which is how a real front cavity behaves.
    //
    // Cost: the coefficients are recomputed per sample, so this is a handful of
    // trig calls per sample at bake time. It happens ONCE at load for ~13 short
    // buffers and never again during play — the buffers are fired as cheap
    // one-shots exactly as before.
    // WHY EACH LANE IS NORMALISED BEFORE IT IS WEIGHTED — the defect this fixes.
    //
    // `weights` reads like a formant amplitude table, and for two waves it was
    // treated as one. It was not one, because it multiplied three lanes that were
    // already at very different levels, and the two effects stacked. Measured on
    // the shipped bank, hunt, per lane RMS before any weight:
    //
    //     lane RMS rel F1:      F1  0.0 dB   F2  -6.6 dB   F3 -10.1 dB
    //     weights [1,.55,.28]:  F1  0.0 dB   F2  -5.2 dB   F3 -11.1 dB
    //     SUM ACTUALLY SHIPPED: F1  0.0 dB   F2 -11.8 dB   F3 -21.1 dB
    //
    // Two causes of the lane imbalance, both real: the glottal source's own
    // downward tilt (now corrected above by `radiationTilt`), and the fact that a
    // constant-Q RBJ bandpass at 0 dB peak gain passes less TOTAL energy the
    // narrower its relative bandwidth gets. So asking for -5.2 dB of F2 actually
    // delivered -11.8 dB, and asking for -11.1 dB of F3 delivered -21.1 dB.
    //
    // An independent critic measured exactly this in the shipped PCM, without
    // peak-picking, as energy in each CONFIGURED formant band relative to F1:
    //
    //     authored jumpscare.ogg   F2/F1  -1.8 dB   F3/F1 -11.0 dB
    //     Billy, every buffer      F2/F1  -6.8..-9.6   F3/F1 -11.8..-17.5
    //
    // F1-dominance is precisely what makes a sound read as filtered buzz rather
    // than as a throat: a real tract puts near-comparable energy in F1 and F2, and
    // it is the F2/F1 relationship that the ear uses to identify a vowel at all.
    //
    // The fix is to make `weights` mean what it says. Each lane is run, held, and
    // scaled to unit RMS; only THEN is the weight applied. The table below is
    // therefore a genuine formant amplitude table in linear gain, and it is set to
    // reproduce the authored kill's own measured profile rather than a guess.
    // Verified offline first (`tools/aud/protoformant.py`, which reproduces the
    // shipped bank's failing numbers before proposing any change), 3 seeds:
    //
    //     state   F2/F1   F3/F1   dominant peak
    //     idle     0.0     -8.8      396 Hz
    //     alert   -0.3     -9.6      504 Hz
    //     hunt     1.1     -7.7      594 Hz
    //
    // and the peak now MOVES with the config, which it did not before: driving
    // config F1 420 -> 560 -> 700 -> 900 Hz moves the measured peak
    // 365 -> 500 -> 594 -> 729 Hz. Previously it sat at ~469 Hz for every state.
    const weights = rv.formantGains;
    const qs = rv.formantQ;
    const shaped = new Float32Array(len);
    const gl = CFG.audio.monster.vocal.glide;

    for (let f = 0; f < spec.formants.length; f++) {
      const base = spec.formants[f] * fShift;
      const g0 = spec.glideStart?.[f] ?? 1;
      const g1 = spec.glideEnd?.[f] ?? 1;
      // The peak of the one-way gesture, and where it lands. Absent — the drag,
      // or any future spec that does not articulate — collapses the maths in the
      // loop below to exactly the old single start->end ramp, which is what makes
      // the offline shipped-vs-gesture A/B a controlled comparison.
      const gp = spec.glidePeak?.[f];
      const knee = spec.glideKnee ?? 0;
      const gestured = gp !== undefined && gp > 0 && knee > 0 && knee < 1;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      // Per-variant wobble phase, so the three variants of a state do not all
      // articulate in lockstep — that would be a loop across variants.
      const wobPhase = variant * 1.9 + f * 0.7;
      // Hold this lane so it can be normalised before it is weighted.
      const lane = new Float32Array(len);
      let sumSq = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // THE ARTICULATION GESTURE. Interpolation is exponential throughout,
        // because formants are heard logarithmically and a linear Hz sweep
        // audibly decelerates.
        //
        // Gestured: start -> peak over the first `knee` of the utterance, then
        // peak -> end over the remainder, with `shapeOpen`/`shapeClose` bending
        // each half. shapeOpen < 1 snaps out of the start; shapeClose > 1 hangs
        // near the peak and then falls away. One way, ending nowhere near where
        // it began — which is the entire point, and the difference between an
        // articulation and the symmetric LFO wobble this replaced.
        //
        // Ungestured: the old single ramp, bit for bit.
        let sweep: number;
        if (gestured) {
          if (t < knee) {
            const u = Math.pow(t / knee, gl.shapeOpen);
            sweep = g0 * Math.pow(gp / g0, u);
          } else {
            const u = Math.pow((t - knee) / (1 - knee), gl.shapeClose);
            sweep = gp * Math.pow(g1 / gp, u);
          }
        } else {
          sweep = g0 * Math.pow(g1 / g0, t);
        }
        const wob = 1 + gl.wobbleDepth * Math.sin(
          2 * Math.PI * gl.wobbleHz * (i / rate) + wobPhase,
        );
        // Clamp well inside Nyquist; a bandpass whose centre runs past it goes
        // unstable and prints as a click rather than as a formant.
        const fc = Math.min(rate * 0.45, Math.max(40, base * sweep * wob));
        const w0 = (2 * Math.PI * fc) / rate;
        const alpha = Math.sin(w0) / (2 * qs[f]);
        // RBJ bandpass (constant 0 dB peak gain).
        const b0 = alpha, b2 = -alpha;
        const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
        const x0 = src[i];
        const y0 = (b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        lane[i] = y0;
        sumSq += y0 * y0;
      }
      // Unit RMS, then the configured formant amplitude. A silent lane (possible
      // if a centre got clamped into a region the source has no energy in) is
      // skipped rather than divided by ~0.
      const rms = Math.sqrt(sumSq / len);
      if (rms < 1e-9) continue;
      const k = weights[f] / rms;
      for (let i = 0; i < len; i++) shaped[i] += lane[i] * k;
    }

    // --- amplitude envelope + normalise -----------------------------------------
    const attack = Math.max(1, Math.floor(len * 0.06));
    const release = Math.max(1, Math.floor(len * 0.38));
    let peak = 0;
    for (let i = 0; i < len; i++) {
      let env = 1;
      if (i < attack) env = i / attack;
      else if (i > len - release) env = (len - i) / release;
      // Smooth the corners; a linear ramp corner is an audible click at this level.
      env = env * env * (3 - 2 * env);
      const trem = 1 - spec.tremolo * 0.5 *
        (1 - Math.cos(2 * Math.PI * 1.7 * (i / rate)));
      const s = shaped[i] * env * trem;
      out[i] = s;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    // Normalise to a fixed headroom so `gain` in config means the same thing for
    // every state regardless of how the filters happened to sum.
    if (peak > 1e-6) {
      const k = 0.85 / peak;
      for (let i = 0; i < len; i++) out[i] *= k;
    }
    return buf;
  }

  /**
   * Decide which vocal state he is in, and drive the crossfade and the retrigger
   * timer. Called once per frame from `updateMonsterAudio`.
   *
   * `level` is his current bus gain: below audibility he goes Silent, which is why
   * a monster on the far side of the maze is not muttering to himself into a bus
   * that is about to multiply him by zero anyway.
   */
  private updateVocals(dt: number, f: MonsterAudioFrame, level: number) {
    const v = CFG.audio.monster.vocal;
    const t = this.ctx.currentTime;

    // --- which state ----------------------------------------------------------
    // Prefer the AI's own state when the caller supplies it. The fallback is not a
    // stub: chasing is unambiguously Hunt, and "he can see you but has not
    // committed" is exactly the suspicion beat, so the inference is faithful for
    // any caller that has not been updated yet.
    let want: VocalState;
    if (level < 0.012) {
      want = 'silent';
    } else if (f.state) {
      want = f.state === 'chase' ? 'hunt'
        : f.state === 'suspicious' || f.state === 'search' ? 'alert'
        : 'idle';
    } else {
      want = f.chasing ? 'hunt' : (f.lineOfSight ? 'alert' : 'idle');
    }

    if (want !== this.vocalState) {
      this.vocalState = want;
      // HPL2's ChangeSoundState: fade every state out over ~3s and the new one in
      // over the same window. setTargetAtTime's time constant reaches ~95% in 3
      // constants, so stateFade/3 makes the audible fade the configured length.
      const tau = v.stateFade / 3;
      for (const s of VOCAL_STATES) {
        this.vocalGains[s].gain.setTargetAtTime(s === want ? 1 : 0, t, tau);
      }
      // Entering a new state should speak soon, not wait out a full idle gap —
      // the transition is the informative moment.
      this.vocalTimer = 0;
      this.vocalNextAt = want === 'silent' ? Infinity : 0.15;
    }

    if (this.vocalState === 'silent') return;

    // --- retrigger timer ------------------------------------------------------
    // HPL2: cMath::RandRectf(mfAmbientSoundMinTime[state], mfAmbientSoundMaxTime[state]).
    this.vocalTimer += dt;
    if (this.vocalTimer >= this.vocalNextAt) {
      this.fireVocal(this.vocalState);
      const spec = this.specFor(this.vocalState);
      // The three state beds all define a window; the fallbacks exist only so the
      // type stays honest about the sting sharing this spec shape.
      const lo = spec.minGap ?? 3, hi = spec.maxGap ?? 6;
      this.vocalTimer = 0;
      this.vocalNextAt = lo + Math.random() * Math.max(0, hi - lo);
    }
  }

  /**
   * Push the beds down under him — the "mix event" half of the design.
   *
   * -------------------------------------------------------------------------
   * WHY THIS WAS REWRITTEN. The previous version drove the duck from his bus
   * level alone, through `k = (busLevel - floorAt) / (fullAt - floorAt)` with
   * `fullAt = 0.30`. His bus level was measured in the running game across the
   * whole distance range:
   *
   *     1m 1.27 · 2m 1.30 · 3m 1.05 · 5m 0.60 · 8m 0.36 · 12m 0.24 · 30m 0.04
   *
   * so `fullAt = 0.30` is reached at about EIGHT METRES. Anywhere nearer than
   * that — i.e. every moment that matters — `k` clamped to 1 and `wanted`
   * collapsed to the constant `depth`. Measured consequence: `minBedDuck` came
   * back 0.550 in patrol, 0.550 in suspicious and 0.550 in chase, identical to
   * three decimals, while 1 idle, 2 alert and 10 hunt utterances plus a notice
   * sting fired through it. An idle groan, "he has noticed you" and a full hunt
   * growl were all delivered at exactly the same mix depth. The bed never
   * opened a hole for any of them, so none of them could read as an event.
   *
   * The rebuilt duck is the product of three independent terms, and it is the
   * PRODUCT that matters — each one alone is the degenerate case that failed:
   *
   *  1. **State depth.** How far the bed is willing to move for this state at
   *     all: idle barely (~0.85), alert noticeably (~0.6), hunt hard (~0.35).
   *     This is the term the old code did not have in any form, and it is the
   *     one carrying the actual information. In Amnesia the idle groan and the
   *     notice growl are deliberately only *subtly* different as sounds — what
   *     separates them is that the whole soundfield reorganises around the
   *     second one. That reorganisation is this number.
   *  2. **Proximity.** Fitted to the measured level curve above, so it spans
   *     his real range instead of saturating at 8m. A groan from across the
   *     maze must not pump the mix; a snarl at your shoulder must flatten it.
   *  3. **Utterance envelope.** A follower keyed to the actual utterances (see
   *     `noteUtterance`), so the hole opens FOR the growl and closes between
   *     growls, rather than sitting open as a static shelf. Fast attack so the
   *     bed is already out of the way before the transient lands; slow release
   *     so the mix does not audibly breathe between snarls.
   *
   * The `min` against the sting term is separate and deliberate: the notice
   * sting is a one-shot that must punch a hole regardless of how far away he is
   * or how relaxed the state machine still thinks it is on that frame.
   */
  private applyBedDuck(dt: number, busLevel: number) {
    const d = CFG.audio.monster.bedDuck;

    // --- (3) utterance envelope, decayed on the wall clock --------------------
    // Fast attack is applied at trigger time in `noteUtterance`; here it only
    // decays, which is what gives the slow release.
    this.utterEnv *= Math.exp(-dt / d.utterRelease);
    if (this.utterEnv < 1e-4) this.utterEnv = 0;
    this.stingEnv *= Math.exp(-dt / d.stingRelease);
    if (this.stingEnv < 1e-4) this.stingEnv = 0;

    // --- (1) how deep is this state allowed to go ----------------------------
    const stateDepth = d.byState[this.vocalState];

    // --- (2) proximity ---------------------------------------------------------
    // A GATE, not a multiplier on the depth. This distinction is the entire fix
    // and it is worth stating plainly, because the previous two versions were
    // both degenerate in the same way from opposite ends.
    //
    // The duck was `stateDepth * near * key` — a triple product of three numbers
    // each under 1, which cannot help but collapse. Measured in the live game
    // with the real AI driving him, `bedDuck` sat at 0.987-0.997 for a full 26
    // seconds of patrol, i.e. between -0.11 dB and -0.03 dB, while three idle
    // utterances fired through it. That is not a duck; it is a rounding error.
    //
    // The arithmetic, worked from the levels the running game actually produces:
    //
    //   his measured bus level:  6m 0.374 · 12m 0.181 · 15m 0.153 · 23m 0.0995
    //   `fullAt` was 0.90, so `near` = (0.374-0.03)/0.87 = 0.395 AT BEST
    //   idle depth 0.85 -> 1 - 0.15*0.395*0.65 = 0.961 = -0.34 dB
    //
    // `fullAt: 0.90` is not reachable at ANY distance the AI ever puts him at.
    // It was fitted to the synthetic test rig's curve (which reads 1.27 at 2m
    // because the rig stands him closer than the director ever does), so the
    // proximity term was multiplying by ~0.1-0.4 everywhere that matters. The
    // version before it used `fullAt: 0.30` and saturated to a *constant* by 8m.
    // One was always off; the other was always on.
    //
    // The real question a duck answers is binary and it is not about distance:
    // IS HE SPEAKING? Distance decides whether he is close enough to be worth
    // making room for at all — so it belongs as a gate that reaches 1 well
    // inside his audible range and simply fades him out past it, not as a scalar
    // that erodes the depth at every distance he is ever actually heard from.
    const span = Math.max(1e-6, d.fullAt - d.floorAt);
    const near = Math.max(0, Math.min(1, (busLevel - d.floorAt) / span));
    // Shaped so the gate is already most of the way open across his normal
    // working range instead of climbing linearly to a ceiling he never reaches.
    const gate = Math.pow(near, d.gateCurve);

    // --- (3) is he speaking ----------------------------------------------------
    // `idleFloor` is the *resting* duck for a state: the bed leans back a little
    // whenever he is present at all, and leans back hard on each utterance. That
    // resting component is what makes his presence felt between growls, and it
    // must not be multiplied away by the envelope.
    const key = d.idleFloor + (1 - d.idleFloor) * Math.min(1, this.utterEnv);
    let wanted = 1 - (1 - stateDepth) * gate * key;

    // The sting is its own event and overrides everything above it.
    if (this.stingEnv > 0) {
      wanted = Math.min(wanted, 1 - (1 - d.stingDepth) * Math.min(1, this.stingEnv));
    }

    const tau = wanted < this.bedDuckValue ? d.attack : d.release;
    // Exponential approach, frame-rate independent.
    this.bedDuckValue += (wanted - this.bedDuckValue) * (1 - Math.exp(-dt / tau));
    this.bedDuckGain.gain.setTargetAtTime(this.bedDuckValue, this.ctx.currentTime, 0.05);
  }

  /**
   * Register that an utterance just started, so the duck can be keyed to it.
   *
   * `weight` is how much of the hole this particular utterance deserves — a
   * hunt snarl asks for the whole thing, a distant idle groan for a fraction.
   * The envelope is a fast attack (applied here, instantly) followed by an
   * exponential release (applied per-frame in `applyBedDuck`), which is the
   * standard ducker shape and the one the brief asked for.
   *
   * `max` rather than `+=` on purpose: two overlapping snarls should not duck
   * twice as hard as one, they should duck as hard as the louder of them.
   */
  private noteUtterance(weight: number) {
    this.utterEnv = Math.max(this.utterEnv, Math.max(0, weight));
  }

  /** Envelope followers for the two duck keys. 0 = nothing speaking. */
  private utterEnv = 0;
  private stingEnv = 0;

  /** No monster: walk the duck back to unity on the release constant. */
  private releaseBedDuck(dt: number) {
    // Let the envelopes die too, or a monster despawned mid-growl leaves a key
    // stuck open and the next one he spawns starts already ducked.
    const d = CFG.audio.monster.bedDuck;
    this.utterEnv *= Math.exp(-dt / d.utterRelease);
    this.stingEnv *= Math.exp(-dt / d.stingRelease);
    if (this.bedDuckValue > 0.999) return;
    this.bedDuckValue += (1 - this.bedDuckValue) * (1 - Math.exp(-dt / d.release));
    this.bedDuckGain.gain.setTargetAtTime(this.bedDuckValue, this.ctx.currentTime, 0.05);
  }

  private specFor(s: Exclude<VocalState, 'silent'>): VocalSpec {
    const v = CFG.audio.monster.vocal;
    return s === 'hunt' ? v.hunt : s === 'alert' ? v.alert : v.idle;
  }

  /** One vocalisation, into that state's bus so the crossfade governs whether it is heard. */
  private fireVocal(s: VocalState) {
    if (s === 'silent') return;
    const bank = this.vocalBank[s];
    if (!bank?.length) return;
    const spec = this.specFor(s);
    const src = this.ctx.createBufferSource();
    src.buffer = bank[(Math.random() * bank.length) | 0];
    // Per-utterance pitch variation on top of the per-variant detune. Together
    // these mean he effectively never repeats himself.
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const g = this.ctx.createGain();
    const utterGain = spec.gain * (0.85 + Math.random() * 0.3);
    g.gain.value = utterGain;
    src.connect(g);
    g.connect(this.vocalGains[s]);
    src.start();
    this.vocalFires[s]++;

    // Key the bed duck to this specific utterance. Normalised against the hunt
    // spec's gain so the weight is "how big is this utterance for him", not an
    // absolute level — which keeps the duck stable if the vocal gains are
    // retuned. A loud snarl asks for the whole hole; a soft groan for part of it.
    this.noteUtterance(utterGain / CFG.audio.monster.vocal.hunt.gain);
  }

  /**
   * The notice sting: the sound of him realising you are there.
   *
   * Fired on the spot-you frame, in parallel with the chase crossfade — which
   * takes 0.8s to arrive, so without this the most important beat in the game is
   * announced by nothing at all. It deliberately bypasses part of his occlusion
   * filter (`clarity`), because this is the one sound whose whole job is to be
   * understood, and muffling it behind a wall throws that away.
   */
  noticeSting() {
    if (!this.started || !this.noticeBuf) return;
    const n = CFG.audio.monster.vocal.notice;
    const m = CFG.audio.monster;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noticeBuf;
    src.playbackRate.value = 0.96 + Math.random() * 0.1;

    const g = this.ctx.createGain();
    g.gain.value = n.gain;

    // Its own, more open lowpass in front of the shared muffle. The muffle still
    // applies (he is still behind whatever he is behind) but this one lets more
    // through, so the sting reads as a shout rather than a thud.
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const cur = this.monsterMuffle.frequency.value;
    lp.frequency.value = cur + (m.clearCutoff - cur) * n.clarity;
    lp.Q.value = 0.7;

    src.connect(g); g.connect(lp); lp.connect(this.monsterPan);
    src.start();
    // Counted separately from the hunt bed, so a test can prove the sting fired
    // once on the spot-you frame rather than inferring it from a bed that is
    // retriggering several times a second anyway.
    this.stingFires++;

    // The notice is the single most important mix event in the game: this is the
    // moment the bed has to get out of the way so "he has seen me" is readable.
    // It gets its own envelope, deeper and longer than an ordinary utterance's,
    // and it is applied unconditionally — not scaled by proximity — because it
    // matters just as much when he spots you from across the maze.
    this.stingEnv = 1;
    // Drive the gain node immediately as well. `applyBedDuck` runs on the game
    // loop's frame and the sting can land between frames; without this the first
    // ~16ms of the most important sound in the game plays into an un-ducked bed.
    const d = CFG.audio.monster.bedDuck;
    if (d.stingDepth < this.bedDuckValue) {
      this.bedDuckValue = d.stingDepth;
      this.bedDuckGain.gain.setTargetAtTime(d.stingDepth, this.ctx.currentTime, d.attack);
    }
  }

  private stingFires = 0;

  /**
   * Per-frame monster audio. Call this every frame you have a monster.
   *
   * Attenuation is inverse-distance with a rolloff, and — the part that matters —
   * the lowpass moves *with* the distance and the occlusion, never volume alone.
   * A quiet-but-bright sound reads as "small and far"; a quiet-and-dark sound
   * reads as "big, far, and behind something". Only the second one is scary.
   */
  /**
   * The game loop's entry point.
   *
   * While a headless test is driving synthetic positions (`testMonsterAt`), the
   * game loop is still running and still calling this every frame — usually with
   * `null`, since no monster is spawned. Two writers on the same AudioParams means
   * the test measures neither. So the public entry yields to an active test; the
   * test calls `driveMonster` directly. The flag is only ever set by the test
   * hook, so a real session is exactly the old code path.
   */
  updateMonsterAudio(dt: number, f: MonsterAudioFrame | null) {
    if (this.testDriving) return;
    this.driveMonster(dt, f);
  }

  private testDriving = false;

  private driveMonster(dt: number, f: MonsterAudioFrame | null) {
    if (!this.started || !this.monsterGain) return;
    const m = CFG.audio.monster;
    const t = this.ctx.currentTime;

    if (!f) {
      this.monsterGain.gain.setTargetAtTime(0, t, 0.15);
      this.breathGain.gain.setTargetAtTime(0, t, 0.2);
      this.dragGain?.gain.setTargetAtTime(0, t, 0.2);
      this.dragPhase = 0;
      // Let the beds back up and hush the voice, or a monster removed mid-growl
      // leaves the mix permanently ducked around a hole with nothing in it.
      this.releaseBedDuck(dt);
      if (this.vocalState !== 'silent') {
        this.vocalState = 'silent';
        const tau = CFG.audio.monster.vocal.stateFade / 3;
        for (const s of VOCAL_STATES) this.vocalGains[s].gain.setTargetAtTime(0, t, tau);
      }
      this.wasHunting = false;
      return;
    }

    const dx = f.x - f.px, dz = f.z - f.pz;
    const dist = Math.hypot(dx, dz);

    // --- distance attenuation ------------------------------------------------
    // Inverse rolloff clamped at a reference distance, so standing on top of him
    // doesn't produce an infinite gain.
    const ref = m.refDistance;
    const atten = dist <= ref
      ? 1
      : Math.max(0, ref / (ref + m.rolloff * (dist - ref)));
    // Edge taper. This used to be `(1 - d/max)²` applied across the WHOLE range,
    // which multiplied a second, steeper attenuation on top of the rolloff and is
    // the specific reason he measured 41.6 dB under the bed at 22m. Distance is
    // the rolloff's job; this exists only so nothing pops at the range boundary,
    // so it is flat until `edgeFrom` and then walks linearly to zero.
    const edge0 = m.edgeFrom * m.maxDistance;
    const taper = dist <= edge0
      ? 1
      : Math.max(0, 1 - (dist - edge0) / (m.maxDistance - edge0));
    const level = atten * taper;

    // --- panning -------------------------------------------------------------
    // Rotate the monster into the listener's frame. THREE yaw 0 faces -Z, so the
    // listener's right axis is (cos yaw, ... , ...) resolved below.
    const sin = Math.sin(f.yaw), cos = Math.cos(f.yaw);
    // Right vector for yaw about +Y with -Z forward: right = (cos, 0, sin)... but
    // in THREE's convention forward = (-sin, 0, -cos) so right = (cos, 0, -sin).
    const right = dx * cos - dz * sin;
    const forward = -dx * sin - dz * cos;
    const lateral = dist > 0.001 ? right / dist : 0;
    const depth = dist > 0.001 ? forward / dist : -1;

    // Place him on the unit sphere around a listener fixed at the origin facing
    // -Z. Because the panner's own distance model is disabled, the radius carries
    // no level information and unit distance is the honest choice — all of the
    // "how far" work is done above, and this node answers only "which way".
    //
    // `panWidth` narrows the lateral axis a little so he never pins so hard to one
    // ear that the other loses him entirely; the front/back axis is left at full
    // scale, since that is the discrimination the whole node is here to provide.
    // Web Audio's source frame matches THREE's: -Z is in front of the listener.
    const px = lateral * m.panWidth;
    const pz = -depth;
    // Renormalise after narrowing, or a hard-left source would sit closer to the
    // head than a straight-ahead one and pick up a spurious elevation cue.
    const norm = Math.max(1e-4, Math.hypot(px, pz));
    const sx = px / norm, sz = pz / norm;

    if (this.monsterPan.positionX) {
      this.monsterPan.positionX.setTargetAtTime(sx, t, 0.05);
      this.monsterPan.positionY.setTargetAtTime(0, t, 0.05);
      this.monsterPan.positionZ.setTargetAtTime(sz, t, 0.05);
    } else {
      (this.monsterPan as any).setPosition?.(sx, 0, sz);
    }
    // Kept only so `probe()` can still report a single comparable pan number; the
    // sound itself is the HRTF above, not this value.
    this.monsterPanValue = Math.max(-1, Math.min(1, sx));

    // --- occlusion -----------------------------------------------------------
    // Smoothed so stepping past a doorway opens the sound up over ~200ms instead
    // of snapping, which would sound like a bug rather than a room.
    const wanted = f.lineOfSight ? 1 : 0;
    this.openness += (wanted - this.openness) * Math.min(1, dt * m.occlusionSlew);

    // Cutoff is the product of three things: how much wall is in the way, how far
    // he is (air itself eats highs over distance), and whether he is in front of
    // you or behind you.
    //
    // That third term is a HEAD SHADOW, and it is doing real work. A PannerNode in
    // HRTF mode was expected to resolve front from back on its own — it is the
    // whole reason the stereo panner was replaced. Measured over 3.5-second
    // averages in the actual browser, it does not: a source 6m directly in front
    // and one 6m directly behind came back at L/R 1.061 vs 1.017 and within 1.9 dB
    // of total energy. Chromium's HRTF gives excellent lateral cues and very weak
    // front/back ones, so relying on it alone would have left the exact defect it
    // was brought in to fix.
    //
    // The physical cue it is missing is spectral: your outer ear faces forward, so
    // sound arriving from behind loses high frequencies before it reaches the ear
    // canal. Darkening a rear source is not a trick, it is what a head does — and
    // it is free here, because there is already a lowpass in this chain.
    const airLoss = Math.max(0, 1 - dist / m.maxDistance);
    // -1 = directly behind, +1 = directly in front. `depth` is already normalised.
    const frontness = (depth + 1) * 0.5;
    const shadow = m.rearShadow + (1 - m.rearShadow) * frontness;

    // The head shadow scales only the part of the cutoff ABOVE the occluded floor,
    // never the floor itself.
    //
    // Multiplying the whole cutoff was the obvious way to write this and it was
    // wrong. Measured in the live game: a monster behind a wall and behind the
    // player landed at 320 x 0.45 = 144 Hz, which is below the 96 Hz idle vocal's
    // own second harmonic. Everything that makes the sound read as a throat — the
    // formants at 420/900/2300 Hz — was filtered off, leaving a featureless hum
    // exactly where the design wants "something alive is over there".
    //
    // The floor exists precisely so an occluded monster is still legible. Nothing
    // is allowed to push through it; direction may only decide how far ABOVE it he
    // sits.
    const openSpan = (m.clearCutoff - m.occludedCutoff) * this.openness *
      (0.35 + 0.65 * airLoss);
    const openHz = m.occludedCutoff + openSpan * shadow;
    this.monsterMuffle.frequency.setTargetAtTime(openHz, t, 0.08);

    // Occluded sound is quieter as well as darker, but only a little — the whole
    // point is that he is audible through the wall, and the FILTER is what says
    // "wall". Stacking a big fader cut on top of an 8x cutoff swing was belt and
    // braces that between them left nothing to hear.
    const occGain = m.occludedGain + (1 - m.occludedGain) * this.openness;
    const busLevel = level * occGain * m.volume;
    this.monsterGain.gain.setTargetAtTime(busLevel, t, 0.06);

    // --- wet/dry with distance -------------------------------------------------
    // Far and behind a wall = mostly reflections; close and in the open = mostly
    // direct sound. Wet/dry ratio is the ear's strongest distance cue, and it has
    // to move the right way for the whole spatial chain to read.
    //
    // The send taps `monsterGain`, which is already falling with distance, so a
    // FIXED send would make a far monster drier — backwards. Compensating by
    // dividing through by `level` overshoots the other way and pins at the cap by
    // 10m, leaving no gradient across the half of the range that matters most.
    //
    // A square-root compensation is the middle: it recovers most of the level
    // falloff while staying monotonic all the way out to `maxDistance`, so every
    // metre of distance is still audible as a change in the amount of room.
    const far = Math.min(1, dist / m.maxDistance);
    // Occluded sound is also more reverberant — what reaches you through stone got
    // there by bouncing. Both terms push the same way.
    const wetness = m.reverbSend * (1 + far * 2.2) * (1 + (1 - this.openness) * 0.5);
    const comp = 1 / Math.sqrt(Math.max(0.05, level));
    const sendGain = Math.min(m.maxReverbSend, wetness * comp);
    this.monsterSend.gain.setTargetAtTime(sendGain, t, 0.12);

    // --- vocals ---------------------------------------------------------------
    // The state machine, and the sting on the frame he spots you.
    //
    // Exactly ONE of two triggers is live, never both. If the caller supplies
    // `justSpotted` we use it and nothing else; otherwise we detect the entry into
    // hunt ourselves, which lands on the same instant. Running both would double
    // the sting on every real spot, because a caller passing justSpotted:true is
    // also, on that same frame, transitioning the machine into hunt.
    this.updateVocals(dt, f, busLevel);
    const hunting = this.vocalState === 'hunt';
    const spotted = f.justSpotted !== undefined
      ? f.justSpotted
      : (hunting && !this.wasHunting);
    if (spotted) this.noticeSting();
    this.wasHunting = hunting;

    // --- the bed steps aside ---------------------------------------------------
    // Duck ambience/chase in proportion to how present he is. Without this his
    // voice competes with a 0.55 bed for the same midrange and loses; with it, the
    // bed opens a hole exactly where he is and the growl reads as an event.
    this.applyBedDuck(dt, busLevel);

    // --- breathing -----------------------------------------------------------
    // Swells as he closes. Louder and more ragged in a chase.
    const closeness = Math.max(0, 1 - dist / m.breathDistance);
    const breath = closeness * closeness * (f.chasing ? m.breathChase : m.breathWalk);
    this.breathGain.gain.setTargetAtTime(breath, t, 0.25);

    // --- gait ----------------------------------------------------------------
    // His footfalls are driven off a phase accumulator running at his real gait
    // rate, so they land at the pace he is actually travelling.
    if (f.moving && level > 0.0005) {
      const rate = f.chasing ? m.runStepsPerSecond : m.walkStepsPerSecond;
      this.gaitPhase += dt * rate;
      while (this.gaitPhase >= 1) {
        this.gaitPhase -= 1;
        this.monsterFootLeft = !this.monsterFootLeft;
        this.monsterFootstep(f.chasing);
      }

      // --- the body drags --------------------------------------------------
      // Its own accumulator, deliberately NOT locked to the footfall phase.
      //
      // Loose cord hanging off a walking figure does not swing at exactly the
      // step rate; a drag that fired on every footfall would fuse with the step
      // into one compound "clop" and stop reading as a separate material. Run at
      // an irrational-ish ratio of the gait so the two slide against each other
      // and the pairing never repeats — the ear hears a body whose parts are not
      // quite in agreement with each other, which is exactly what he is.
      const g = CFG.audio.monster.drag;
      this.dragPhase += dt * rate * g.gaitRatio;
      while (this.dragPhase >= 1) {
        this.dragPhase -= 1;
        this.fireDrag(f.chasing);
      }
    } else {
      this.gaitPhase = 0;
      this.dragPhase = 0;
    }

    // The drag bus follows proximity like the breath does — he is a body before
    // he is a voice, and you should hear the body first as he closes.
    const dragClose = Math.max(0, 1 - dist / CFG.audio.monster.drag.distance);
    this.dragGain.gain.setTargetAtTime(
      f.moving ? dragClose * dragClose * CFG.audio.monster.drag.busGain : 0, t, 0.2,
    );
  }

  /**
   * One monster footfall, routed through his spatial chain so it lands where he
   * is. Deliberately pitched down from the player's own steps — his are heavier
   * and drier than yours, and the ear reads the pitch difference as mass.
   */
  private monsterFootstep(chasing: boolean) {
    const m = CFG.audio.monster;
    const buf = this.buffers.get(this.monsterFootLeft ? 'stepLeft' : 'stepRight');
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (chasing ? m.runStepRate : m.walkStepRate) *
      (0.94 + Math.random() * 0.12);
    const g = this.ctx.createGain();
    g.gain.value = chasing ? m.runStepVolume : m.walkStepVolume;
    src.connect(g);
    g.connect(this.monsterPan);
    // Parallel measurement send, only if a harness has asked for one. This is an
    // extra connection, never a rerouting, so the sound the player hears is
    // identical whether or not anything is measuring it.
    if (this.gaitTap) g.connect(this.gaitTap);
    src.start();
  }

  /** Browsers suspend audio until a gesture; call this from the click that starts play. */
  async resume() {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  startBeds() {
    if (this.started) return;
    this.started = true;
    this.ambienceSrc = this.loop('ambience', this.ambienceGain);
    this.chaseSrc = this.loop('chase', this.chaseGain);
    try { this.breathSrc?.start(); } catch { /* already started */ }
    this.setChase(false, 0);
    this.scheduleKnock();
  }

  private loop(name: SoundName, dest: GainNode) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get(name)!;
    src.loop = true;
    src.connect(dest);
    src.start();
    return src;
  }

  // ---- the crossfade ---------------------------------------------------------

  /**
   * Crossfade between the ambient bed and the chase theme.
   *
   * Equal-power (cosine/sine) rather than linear, so the midpoint of the fade
   * doesn't dip into an audible hole where neither track is carrying the scene.
   * Measured: `ambience² + chase²` holds at 1.0 across the whole fade.
   *
   * The subtle part is interruption. The previous implementation always scheduled
   * its ramp chain from `x = 1 - 1/steps`, which meant a fade-*out* fired 60ms
   * into a fade-in would first slam the chase bed from 0.09 up to 0.75 before
   * receding — measured, not theorised. Interrupting a chase made the chase get
   * *louder*. The fix is to solve for the crossfade position `x` that the beds
   * are actually at right now, start the new ramp chain from there, and scale the
   * duration by the remaining distance so a 10%-in fade doesn't take as long as a
   * 100%-in one.
   */
  setChase(on: boolean, duration?: number) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const a = this.ambienceGain.gain, c = this.chaseGain.gain;
    const x1 = on ? 1 : 0;

    // ---- the re-entrancy guard ------------------------------------------------
    //
    // `game.ts:426` calls this EVERY FRAME while the monster is patrolling. That
    // makes a naive implementation stall permanently, and it is worth spelling out
    // why, because the failure is invisible in the obvious test.
    //
    // The old code recovered its start position `x0` by reading `c.value`, then
    // cancelled and rescheduled the whole ramp chain. But `AudioParam.value`
    // during a ramp is only updated by the audio thread at 128-sample render
    // quantum boundaries. Cancel-and-reschedule at 60Hz can easily happen twice
    // within one quantum, so `c.value` reads back UNCHANGED, `x0` is recomputed
    // identically, and the ramp restarts from precisely where it restarted last
    // time. Forever. Measured: an interrupted fade froze at chase=0.2163 and did
    // not move for the full 2 seconds sampled.
    //
    // This is invisible if you only test spamming setChase(false) from a standing
    // start, because at x0 = 0 the early-return below lands the value exactly and
    // the bed is already where it belongs. It only bites mid-fade — which is
    // exactly when a chase is being broken off, the one moment it matters.
    //
    // The fix: a repeat call that changes nothing is a no-op. If the target has
    // not changed and a fade toward that same target is already scheduled and
    // still running, leave it alone and let it finish. The ramp chain is already
    // correct; touching it is the only thing that could break it.
    //
    // `duration === 0` is excluded from the guard on purpose: that is the explicit
    // instant-cut used by the jumpscare and by the reset path, and it must always
    // be honoured immediately no matter what is in flight. Any other duration is
    // treated as a request for a fade toward a target, and a fade toward the
    // target we are already heading for is by definition already happening.
    const instant = duration !== undefined && duration <= 0;
    if (!instant && on === this.chaseTarget && this.ctx.currentTime < this.fadeEndsAt) {
      return;
    }

    // Where are we right now? Recover x from the live chase gain, which is
    // sin(x*pi/2)*chaseVolume. Safe here precisely because we only reach this
    // point when the target actually changed or the previous fade has landed.
    const cNorm = Math.max(0, Math.min(1, c.value / CFG.audio.chaseVolume));
    const x0 = Math.asin(cNorm) / (Math.PI / 2);

    this.chaseTarget = on;

    const full = duration ?? (on ? CFG.audio.fadeIn : CFG.audio.fadeOut);
    // Only pay for the distance still to travel: reversing 10% into a fade should
    // take 10% of the time, not the full duration, or a quick in-and-out of line
    // of sight leaves the music lagging seconds behind the fiction.
    //
    // Note this SCALING is also why the re-entrancy guard above has to exist and
    // has to be strict. Re-solving `remaining` on every frame compounds: each call
    // measures a shorter distance and therefore schedules a shorter fade, so the
    // fade accelerates into itself. Measured before the guard: a 2.6s fade-out
    // completed in 0.8s in four visible steps. With the guard, a fade that is
    // already heading to the right target is left alone to run its course.
    const remaining = Math.abs(x1 - x0);
    const dur = full * remaining;

    a.cancelScheduledValues(t); c.cancelScheduledValues(t);
    a.setValueAtTime(a.value, t); c.setValueAtTime(c.value, t);

    if (dur <= 1e-4 || remaining <= 1e-4) {
      // Nothing to travel (or an explicit instant cut): land exactly.
      a.setValueAtTime(Math.cos((x1 * Math.PI) / 2) * CFG.audio.ambienceVolume, t);
      c.setValueAtTime(Math.sin((x1 * Math.PI) / 2) * CFG.audio.chaseVolume, t);
      this.fadeEndsAt = t;
      return;
    }

    // Approximate the cosine/sine pair with a chain of short linear ramps. Each
    // segment starts where the last ended, so there is no discontinuity anywhere,
    // including at the very first segment — which is the bug that was there.
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const x = x0 + (x1 - x0) * k;
      const when = t + dur * k;
      a.linearRampToValueAtTime(Math.cos((x * Math.PI) / 2) * CFG.audio.ambienceVolume, when);
      c.linearRampToValueAtTime(Math.sin((x * Math.PI) / 2) * CFG.audio.chaseVolume, when);
    }
    this.fadeEndsAt = t + dur;
  }

  /** Fire-and-forget one-shot with optional pan and pitch variation. */
  play(name: SoundName, opts: {
    volume?: number; pan?: number; rate?: number;
    /** Lowpass cutoff in Hz. Omit for full band. */
    cutoff?: number;
    /** 0..1 how much of this goes into the corridor. */
    reverb?: number;
    /**
     * Route past `duckGain`, onto the scare bus. Only the jumpscare uses this:
     * it is the one sound that must not be attenuated by the duck it fires.
     */
    bypassDuck?: boolean;
  } = {}) {
    const buf = this.buffers.get(name);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;

    const gain = this.ctx.createGain();
    gain.gain.value = opts.volume ?? 1;

    let head: AudioNode = gain;
    let tail: AudioNode = gain;

    if (opts.cutoff !== undefined) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = opts.cutoff;
      lp.Q.value = 0.7;
      tail.connect(lp);
      tail = lp;
    }

    if (opts.pan !== undefined && this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
      tail.connect(panner);
      tail = panner;
    }

    src.connect(head);
    tail.connect(opts.bypassDuck ? this.scareBus : this.duckGain);

    if (opts.reverb) {
      const send = this.ctx.createGain();
      send.gain.value = opts.reverb;
      tail.connect(send);
      send.connect(this.convolver);
    }

    src.start();
    return src;
  }

  /**
   * Player footsteps. These get a real send into the corridor convolver, which is
   * most of what makes the maze feel like stone rather than a soundproof booth:
   * your own steps come back at you off the walls a beat later.
   */
  footstep(left: boolean) {
    this.play(left ? 'stepLeft' : 'stepRight', {
      volume: CFG.audio.stepVolume,
      // A hair of pitch drift stops the loop from turning into a metronome.
      rate: 0.94 + Math.random() * 0.12,
      pan: left ? -0.18 : 0.18,
      reverb: CFG.audio.stepReverb,
    });
  }

  private scheduleKnock() {
    const { minGap, maxGap } = CFG.audio.knock;
    this.nextKnockAt = minGap + Math.random() * (maxGap - minGap);
    this.knockTimer = 0;
  }

  /**
   * Random knocks from random places. This is the single cheapest source of dread
   * in the build: a sound with a location, from somewhere you are not looking,
   * that never resolves into anything.
   *
   * The knock is given a *distance*, not just a pan. Volume, lowpass cutoff and
   * reverb send all move together off that one number, because that is how
   * distance actually sounds: far things are quiet AND dark AND more reverberant
   * than dry. Dropping the volume alone just sounds like someone knocking gently
   * right next to your ear, which is not the same feeling at all.
   */
  updateKnocks(dt: number, suppress: boolean) {
    if (!this.started || suppress) return;
    this.knockTimer += dt;
    if (this.knockTimer < this.nextKnockAt) return;

    const k = CFG.audio.knock;
    // 0 = right behind the wall next to you, 1 = far off across the maze.
    // Biased toward near, because a knock you can place is a scare and a knock at
    // the edge of hearing is only texture.
    const d = Math.pow(Math.random(), 1 / Math.max(0.05, k.nearBias));

    // Near knocks stay wide (you can tell exactly which side); far ones collapse
    // toward centre because you genuinely can't localise a distant sound well.
    const pan = (Math.random() * 2 - 1) * k.maxPan * (1 - d * 0.55);

    const volume = k.volume * (k.nearGain + (k.farGain - k.nearGain) * d);
    const cutoff = k.nearCutoff + (k.farCutoff - k.nearCutoff) * d;
    const reverb = k.nearReverb + (k.farReverb - k.nearReverb) * d;

    this.play('knock', {
      volume,
      pan,
      cutoff,
      reverb,
      // Bigger, slower knock when it's far away — distance lowers apparent pitch.
      rate: (0.95 - d * 0.16) * (0.93 + Math.random() * 0.14),
    });
    this.scheduleKnock();
  }

  /**
   * User volume. Safe to set at any time: `duck()` writes `duckGain`, never
   * `master`, so a jumpscare duck cannot overwrite the player's setting — and
   * because the scare bus also sits under `master`, the scare obeys the volume
   * slider even though it bypasses the duck.
   */
  setMasterVolume(v: number) {
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.min(1, Math.max(0, v)), t);
  }

  /**
   * Duck everything that is supposed to get out of the way.
   *
   * This pulls the *bus* down, not the master. Since the jumpscare now plays on
   * `scareBus`, which is wired past this node, ducking here clears the stage
   * without touching the sound the stage is being cleared for.
   */
  duck(to: number, seconds: number) {
    const t = this.ctx.currentTime;
    const g = this.duckGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(to, t + Math.max(0.001, seconds));
  }

  /**
   * The jumpscare. Clears the stage, drops the scare into the cleared space, and
   * lets the bus back up under its tail so the silence afterwards is audible.
   *
   * -------------------------------------------------------------------------
   * WHAT WAS WRONG. Measured off the master analyser, the scare came back
   * QUIETER than the two seconds preceding it. Two separate mechanisms, both of
   * which had the scare attenuating itself:
   *
   *  1. **It ducked its own path.** `play('jumpscare')` connected into
   *     `duckGain`, and the first thing this method does is pull `duckGain` to
   *     `duckTo`. The scare was therefore multiplied by the duck that exists to
   *     make room for it. Isolated and measured: the same buffer through the
   *     ducked bus peaked 0.0002 versus 0.6536 through an open one. Fixed by
   *     `bypassDuck` — the scare now plays on `scareBus`, wired past the duck
   *     straight into the limiter.
   *  2. **It played through the bed's compressor.** This was diagnosed twice and
   *     only half-fixed the first time. The first pass removed a temporary clamp
   *     that dropped the shared limiter to -30 dB during the scare — but left the
   *     scare summing into that shared limiter at its normal -18 dB / 4:1, which
   *     is still a compressor that cannot tell the scare from the bed. Measured
   *     off master PCM with the clamp already gone:
   *
   *       into a QUIET stage : pre 0.2181 -> scare 0.6872  (+9.97 dB)
   *       into a CHASE  bed  : pre 0.7012 -> scare 0.6833  (-0.22 dB)
   *       bus gain reduction during the hit: -7.86 dB
   *
   *     The scare's peak moved 0.05 dB across a 10 dB swing in context. That is
   *     a hard ceiling. Fixed properly this time by giving the scare its own
   *     brickwall and its own path to `master` (`scareLimiter`), so the bed
   *     compressor never sees it.
   *
   * A jumpscare that measures -2 dB against what preceded it is not punctuation,
   * it is a dip. The scare's job is to be the loudest thing in the game.
   */
  jumpscare(volume = 1) {
    const j = CFG.audio.jumpscare;
    const t = this.ctx.currentTime;

    // Slam the stage clear — beds, monster, knocks, footsteps. Fast enough that
    // the hole is open before the scare's own attack lands.
    this.duck(j.duckTo, j.duckTime);

    // The monster's own bed-duck must let go too. Otherwise it keeps fighting to
    // hold the beds down through the recovery and the mix never reopens.
    this.bedDuckValue = 1;
    this.bedDuckGain?.gain.setTargetAtTime(1, t, 0.08);
    this.utterEnv = 0;
    this.stingEnv = 0;

    // Straight past the duck, at scare level. The reverb send still lands in the
    // shared convolver whose return is ducked — deliberately: the dry hit should
    // punch through untouched while its room tail sits down with everything else.
    const src = this.play('jumpscare', {
      volume: volume * j.gain,
      reverb: j.reverb,
      bypassDuck: true,
    });

    // Bring the bus back up under the tail of the scare, not instantly.
    const g = this.duckGain.gain;
    g.linearRampToValueAtTime(j.duckTo, t + j.hold);
    g.linearRampToValueAtTime(j.recoverTo, t + j.hold + j.recover);
    return src;
  }

  // ---- test surface ----------------------------------------------------------

  /**
   * Live gain snapshot. This exists so the crossfade can be *proved* from a
   * headless browser rather than asserted in a summary — the harness reads these
   * numbers back out of the running game.
   */
  probe(): AudioProbe {
    const a = this.ambienceGain?.gain.value ?? 0;
    const c = this.chaseGain?.gain.value ?? 0;
    return {
      ambience: a,
      chase: c,
      power: Math.pow(a / CFG.audio.ambienceVolume, 2) + Math.pow(c / CFG.audio.chaseVolume, 2),
      monster: this.monsterGain?.gain.value ?? 0,
      monsterCutoff: this.monsterMuffle?.frequency.value ?? 0,
      pan: this.monsterPanValue,
      duck: this.duckGain.gain.value,
      ctxTime: this.ctx.currentTime,
      fading: this.ctx.currentTime < this.fadeEndsAt,
      chaseTarget: this.chaseTarget,
      vocalState: this.vocalState,
      vocalGains: {
        silent: this.vocalGains?.silent.gain.value ?? 0,
        idle: this.vocalGains?.idle.gain.value ?? 0,
        alert: this.vocalGains?.alert.gain.value ?? 0,
        hunt: this.vocalGains?.hunt.gain.value ?? 0,
      },
      bedDuck: this.bedDuckGain?.gain.value ?? 1,
      utterEnv: this.utterEnv,
      stingEnv: this.stingEnv,
      vocalFires: { ...this.vocalFires },
      stingFires: this.stingFires,
      drag: this.dragGain?.gain.value ?? 0,
      dragFires: this.dragFires,
      throatMixed: this.throatMixed,
      bedGr: this.limiter.reduction,
      scareGr: this.scareLimiter.reduction,
      outputGr: this.outputLimiter.reduction,
    };
  }

  /**
   * A real measurement tap on the master bus.
   *
   * `probe()` reports what the AudioParams have been *told* to be. That is useful
   * for asserting the crossfade maths, but it is not evidence that anything is
   * audible — a bus can be commanded to 0.9 while the source feeding it is
   * silent, and the last critic was right to refuse declared values as proof.
   *
   * This splits the master into its two channels and reads actual PCM back, so a
   * test can assert "the monster is genuinely louder than the bed in the output"
   * and "the right ear has more energy than the left". Built lazily: an analyser
   * on every player's master bus for no reason is a real cost.
   */
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private analyserBuf: Float32Array | null = null;

  private ensureAnalysers() {
    if (this.analyserL) return;
    const split = this.ctx.createChannelSplitter(2);
    // Tap the LAST node before the destination — `outputLimiter`, not `master` —
    // and do NOT insert into the path; an analyser in series would put the
    // measurement instrument between the mix and the speakers.
    //
    // Tapping `master` would measure the signal BEFORE the output ceiling, so a
    // test could report a peak of 1.27 that the player never hears, or miss that
    // the ceiling is working. Measure what leaves the graph, not what enters the
    // last node.
    this.outputLimiter.connect(split);
    const mk = () => {
      const a = this.ctx.createAnalyser();
      a.fftSize = 2048;
      return a;
    };
    this.analyserL = mk();
    this.analyserR = mk();
    split.connect(this.analyserL, 0);
    split.connect(this.analyserR, 1);
    this.analyserBuf = new Float32Array(this.analyserL.fftSize);
  }

  /** Measured output: per-channel RMS and peak, from real samples. */
  measure(): { rmsL: number; rmsR: number; peakL: number; peakR: number } {
    this.ensureAnalysers();
    const read = (a: AnalyserNode) => {
      const b = this.analyserBuf!;
      a.getFloatTimeDomainData(b);
      let sum = 0, peak = 0;
      for (let i = 0; i < b.length; i++) {
        const s = b[i];
        sum += s * s;
        const abs = s < 0 ? -s : s;
        if (abs > peak) peak = abs;
      }
      return { rms: Math.sqrt(sum / b.length), peak };
    };
    const l = read(this.analyserL!), r = read(this.analyserR!);
    return { rmsL: l.rms, rmsR: r.rms, peakL: l.peak, peakR: r.peak };
  }

  /**
   * Drive the real monster chain from a synthetic position, for tests. This is not
   * a mock: it calls the same `updateMonsterAudio` the game loop calls, with the
   * same frame shape, so whatever it measures is what a player would hear.
   */
  testMonsterAt(dist: number, opts: {
    lineOfSight?: boolean; bearing?: number;
    state?: MonsterAudioFrame['state']; moving?: boolean; dt?: number;
  } = {}) {
    const bearing = opts.bearing ?? 0;
    const state = opts.state ?? 'patrol';
    this.testDriving = true;
    this.driveMonster(opts.dt ?? 1 / 60, {
      // Place him on a circle around the origin at the given bearing, with the
      // listener at the origin facing -Z (THREE's convention, yaw 0).
      x: Math.sin(bearing) * dist,
      z: -Math.cos(bearing) * dist,
      px: 0, pz: 0, yaw: 0,
      lineOfSight: opts.lineOfSight ?? false,
      chasing: state === 'chase',
      moving: opts.moving ?? true,
      state,
    });
  }

  /** Hand the monster chain back to the game loop after a synthetic sweep. */
  testRelease() { this.testDriving = false; }

  /**
   * The baked vocal buffers, for offline spectral analysis.
   *
   * Exposed because "the states sound different" is a claim about PCM and has to
   * be settled by looking at PCM. A test can FFT these directly rather than
   * trying to catch an utterance mid-flight through a chain that is also
   * applying occlusion, panning and reverb — which measures the chain, not the
   * voice. Returns the live buffers; nothing here copies or synthesizes anew, so
   * what a test analyses is exactly what the player hears.
   */
  /**
   * A parallel tap point per audible layer, so "is he voice-first" can be
   * measured rather than asserted.
   *
   * GAME-SPEC and the brief both require voice-first: Frictional's
   * `LuxEnemy.cpp` contains no enemy footstep code whatsoever, and a monster
   * announced primarily by boots reads as a man rather than as a thing. Ours
   * does have a gait layer, so the balance is a claim about energy.
   *
   * WHY TAPS RATHER THAN A MUTE FLAG. The obvious instrument — mute the gait,
   * measure, unmute, measure, subtract — was built first and had to be thrown
   * away. His utterances are retriggered one-shots on a random timer, so two
   * consecutive windows contain different numbers of growls and that difference
   * swamps the footsteps. Measured: the same cell reported the gait at 98.7% of
   * his energy over a 22 s window and 0.0% over a 55 s one, and three rows came
   * back with NEGATIVE gait energy. It is the same failure
   * `docs/handoff/audio-billy-voice.md` records for the two bed-subtraction
   * schemes, and it has now cost this lane three attempts in total: subtracting
   * two moments of an evolving source measures the evolution.
   *
   * Tapping every layer at once removes the subtraction entirely — all four
   * numbers describe the same instant by construction, and the shares are exact.
   *
   * `gait` needs a node to exist at all: footfalls are one-shots created and
   * discarded in `monsterFootstep`, with nothing persistent to attach an
   * analyser to. `gaitTap` is that node. It is created ONLY when this method is
   * called, and it is a parallel send — the footstep still routes to
   * `monsterPan` exactly as before, so attaching the instrument cannot change
   * the mix it is measuring.
   */
  __debugLayerTaps(): Record<string, AudioNode> {
    if (!this.gaitTap) this.gaitTap = this.ctx.createGain();
    const voice = this.ctx.createGain();
    for (const s of VOCAL_STATES) this.vocalGains[s].connect(voice);
    return {
      voice,
      gait: this.gaitTap,
      drag: this.dragGain,
      breath: this.breathGain,
    };
  }

  /**
   * Parallel send carrying only his footfalls. Null until `__debugLayerTaps`
   * asks for it, so a real session never allocates it.
   */
  private gaitTap: GainNode | null = null;

  __debugVocalBuffers(): Record<string, AudioBuffer[]> | null {
    if (!this.vocalBank) return null;
    return {
      idle: this.vocalBank.idle,
      alert: this.vocalBank.alert,
      hunt: this.vocalBank.hunt,
      ...(this.noticeBuf ? { notice: [this.noticeBuf] } : {}),
      ...(this.dragBank?.length ? { drag: this.dragBank } : {}),
    };
  }

  /**
   * Re-bake the vocal buffers with the `jumpscare.ogg`-derived layer OMITTED,
   * for ablation. Returns fresh buffers; the live ones are untouched.
   *
   * This exists because `throatMixed: 10` proves only that `mixThroat` RAN, not
   * that it changed anything a listener could hear — a gain of 0, a slice
   * shorter than 64 samples, or a filter pair that cancelled would all still
   * count to 10. The claim "the hunt voice is made from the scream" is a claim
   * about PCM, so it has to be falsifiable against PCM: bake the same specs
   * through the same `makeVocal` and simply skip the mix, then compare spectral
   * centroid movement on both sets. If the two measure the same, the layer is
   * decorative and the claim is false. (PROGRESS.md trap 14.)
   */
  __debugRebakeDry(): Record<string, AudioBuffer[]> | null {
    if (!this.vocalBank) return null;
    const v = CFG.audio.monster.vocal;
    const withGlide = (
      spec: VocalSpec,
      g: {
        start: readonly number[]; end: readonly number[];
        peak: readonly number[]; knee: number;
      },
    ): VocalSpec => ({
      ...spec, glideStart: g.start, glideEnd: g.end,
      glidePeak: g.peak, glideKnee: g.knee,
    });
    const bake = (spec: VocalSpec) =>
      Array.from({ length: v.variants }, (_, i) => this.makeVocal(spec, i));
    return {
      idle: bake(withGlide(v.idle, v.glide.idle)),
      alert: bake(withGlide(v.alert, v.glide.alert)),
      hunt: bake(withGlide(v.hunt, v.glide.hunt)),
      notice: [this.makeVocal(withGlide(v.notice, v.glide.notice), 0)],
    };
  }

  stopAll() {
    try {
      this.ambienceSrc?.stop();
      this.chaseSrc?.stop();
      this.breathSrc?.stop();
    } catch { /* already stopped */ }
    this.ambienceSrc = this.chaseSrc = this.breathSrc = null;
    this.started = false;
  }
}
