/**
 * Every tunable number in one place.
 *
 * Piece-agents tune values here rather than hunting through systems, and a critic
 * can diff two builds by diffing this file. Anything that a designer would want to
 * feel out belongs here; anything structural does not.
 */

export const CFG = {
  maze: {
    /** Cells across and deep. Odd numbers keep the carve symmetric. */
    cols: 21,
    rows: 21,
    /** Metres per cell. 4m corridors feel like corridors, not tunnels. */
    cell: 4,
    /** Walls are tall — the brief is explicit. 6m reads as oppressive from eye height. */
    wallHeight: 6.5,
    wallThickness: 0.35,
    /**
     * No ceiling. The brief wants tall walls AND an ominous red sky — you only get
     * both if the maze is open to it. Roofed corridors would hide the one piece of
     * sky in the game and turn the whole thing into an unlit box.
     */
    ceiling: false,
    /**
     * Fraction of dead ends punched through into loops. A perfect maze has exactly
     * one path between any two points, which makes a chase a death sentence — you
     * can only ever run away, never around. Braiding is what makes escape possible.
     *
     * 1.0 — FULLY BRAIDED. Every dead end gets a second opening, so none remain.
     *
     * Was 0.42, which left ~58% of them standing: roughly fifty cul-de-sacs in a
     * 21x21 grid. The user's note was "there are some dead ends in the maze though
     * which is not good", and with something hunting you they are worse than merely
     * annoying — running into one is not a tense moment, it is an unfair death you
     * could not have seen coming. The dread here comes from not knowing where he
     * is, not from the level cheating.
     *
     * A fully braided maze is still a maze: every corridor, corner and blind
     * junction survives, and it gains loops — which is exactly what makes a chase
     * escapable and lets you hear him take the wrong branch.
     *
     * It should also harden gem placement: more connectivity means fewer awkward
     * pockets a collectible can hide in.
     */
    braid: 1.0,
    /**
     * Longest run you may be forced to commit to before the corridor branches
     * again, in cells. Dead ends shorter than this are kept on purpose — you need
     * somewhere to press into and hope. Anything longer is not a scare, it is an
     * execution chamber: you turn down it with Billy behind you and no play exists.
     * Measured before this cap, seeds produced throats up to 22 cells deep.
     */
    maxCulDeSacCells: 3,

    /**
     * Corridor carpentry — the single biggest thing standing between this render
     * and Amnesia's.
     *
     * A critic measured mid-frequency structure inside lit pixels (a 3px box minus
     * a 17px box, sampled only where luminance > 25, which isolates architectural
     * edges from both film grain and lighting gradients). Amnesia's stone corridor
     * scores 30.9. This build scored 3.34 — roughly ten times flatter. Looking at
     * the frames says exactly what the number says: the flashlight lands on the
     * wall as a soft brown oval with nothing in it. No corner, no joint, no trim,
     * no beam. A moving light with nothing to rake across produces no shape, no
     * sense of scale and no depth cue, which is simultaneously why the walls do not
     * read as tall and why a corridor reads as an untextured box.
     *
     * The cause is that woodWall.png is a low-contrast plank tile whose own edges
     * only resolve when the camera is nearly touching the surface (measured 11.8 at
     * nose distance versus 3.3 at corridor distance). No texture tweak recovers
     * that; what Amnesia actually has is *geometry* — block courses, a sill, a
     * pilaster, a floor joint — each of which throws a real shadow edge that stays
     * legible at 2-8m because it is parallax, not pixels.
     *
     * So the corridors get carpentry: horizontal timber plates at skirting, waist,
     * head and wall-top height, vertical posts at a fixed world-space period, and
     * joists spanning overhead. All of it is built from the same merged-box
     * pipeline as the walls, so the whole maze's trim is one extra draw call.
     *
     * The posts are deliberately spaced near the texture's own tiling period. The
     * repeat is then read as a structural rhythm — which is what a timbered wall
     * has — instead of as a texture artifact.
     */
    trim: {
      /**
       * How far a band stands proud of the wall face, in metres. This is the whole
       * effect: `depth` is the length of the shadow a band casts along the wall
       * when the beam rakes across it. Below about 0.05 the shadow is finer than
       * the shadow map resolves at corridor range and the band disappears back
       * into the plank texture.
       */
      /*
       * RAISED 0.075 -> 0.14, and the reason is a projected-size argument rather
       * than a taste one. A member standing `d` proud subtends `d / r` radians at
       * range `r`; at the 4-6 m the beam actually lands, 0.075 m is 0.012-0.019 rad,
       * which at this build's vertical FOV over 720 px is 7-11 px of *total*
       * relief — and the visible shading step is a fraction of that. The
       * mid-frequency metric is a box(3)-box(17) difference, i.e. it is blind to
       * anything whose contrast is not carried across 3-17 px. The old trim was
       * physically below the measurement's own passband at corridor range. 0.14 m
       * puts it at 14-21 px, inside the band, and is still a plausible timber
       * plate rather than a shelf.
       */
      depth: 0.14,
      /**
       * Skirting: the floor-to-wall joint, built as TWO members rather than one —
       * a tall plinth board with a thinner, proud-er capping strip riding on top.
       * A single box gives the joint one edge; plinth-plus-cap gives it three
       * (bottom of plinth, top of plinth under the cap's overhang, top of cap),
       * and the cap's overhang throws a permanent hard shadow line onto the
       * plinth that survives every beam angle because it is self-shading rather
       * than a cast shadow. That triple line at the base of a wall is one of the
       * most legible things in the Amnesia reference frame.
       */
      skirtHeight: 0.34,
      skirtDepth: 0.15,
      /** The capping strip riding on top of the plinth. Stands proudest of all. */
      skirtCapHeight: 0.075,
      skirtCapDepth: 0.225,
      /** Waist and head rails: the two bands the beam crosses at walking height. */
      waistY: 1.05,
      headY: 2.30,
      /**
       * RAISED 0.15 -> 0.24. At 5 m a 0.15 m member is ~22 px tall in a 720 px
       * frame with a soft-shaded top and bottom edge, so its interior — the part
       * that would carry a tonal difference from the wall — is a handful of
       * pixels and the box(17) term averages it straight out. 0.24 m survives the
       * filter and reads as a structural plate, which is what a wall plate is.
       */
      railHeight: 0.24,
      /**
       * The wall plate capping the top of the wall. It is what makes the top edge
       * read as a built edge against the red sky rather than as a cut.
       */
      capHeight: 0.30,
      capDepth: 0.20,
      /**
       * Vertical posts every this many metres along a wall run. 2.4m at a 4m cell
       * puts roughly one per cell plus one mid-cell, so a corridor has a rhythm you
       * can count your progress against and a repeating silhouette receding into
       * the fog — the strongest depth cue available without a second light.
       */
      postSpacing: 2.4,
      /**
       * WIDENED 0.26 -> 0.34 and DEEPENED 0.09 -> 0.19. The post is the only
       * member that can genuinely OCCLUDE — it is the one piece of maze geometry
       * that puts a silhouette edge in front of a lit wall, and a silhouette is
       * worth far more to this metric than any amount of surface shading because
       * it is a step discontinuity rather than a gradient. At 0.09 m proud the
       * post could not occlude anything: the beam is mounted at the eye, so a
       * member standing less proud than roughly `halfWidth * tan(viewAngle)`
       * never gets between the light and the wall from any angle you can stand
       * at. 0.19 m does, so from any oblique approach down a corridor each post
       * now lays a hard vertical shadow bar across the plank behind it.
       */
      postWidth: 0.34,
      postDepth: 0.19,
      /**
       * A corbel: the short bracket where a post meets the head rail, splaying
       * out to carry it. Two boxes, and it is what stops the frame reading as a
       * grid of sticks — a joint that is *made* rather than merely a crossing.
       * It also sits at 2.1-2.3 m, right at the top edge of the beam's footprint
       * at 4-6 m, where it catches the falloff and reads as a bright rim.
       */
      corbelWidth: 0.60,
      corbelHeight: 0.17,

      /**
       * ---- PIERS: the members that finally fill the COARSE band -------------
       *
       * Everything else in this file is a fine-scale term, and the band-energy
       * profile says that is the whole problem. Lit-pixel structural energy by
       * spatial band, ours against the reference:
       *
       *   band px        1-3    3-9   9-17  17-33  33-65 65-129
       *   AMNESIA st2    7.5%  14.8%  13.6%  15.7%  19.1%  29.2%
       *   AMNESIA st5    9.9%  17.7%  17.9%  17.0%  16.8%  20.6%
       *   ours (before) 28.8%  19.1%   9.8%  12.1%  14.9%  15.3%
       *
       * Amnesia puts ~48% of its structure above 17 px and 7-10% below 3 px. We
       * had 28% above 17 px and 29% below 3 px — the exact inverse. No amount of
       * additional carpentry fixes that, because carpentry at 0.15-0.6 m is a
       * MID-band term and the mid band was already oversubscribed; that is
       * precisely why the previous lane measured its dado and lath at -0.08 and
       * correctly removed them.
       *
       * A pier is deliberately a different KIND of object from everything above
       * it. It is a full-height masonry buttress standing 0.42 m proud of the
       * wall and 0.95 m wide, so at the 4-8 m the beam works it subtends 55-120
       * px — landing in the 33-129 px bands where we were emptiest. Three things
       * follow from the size that no smaller member can deliver:
       *
       *  1. It OCCLUDES at every angle. A 0.42 m standoff is more than twice the
       *     posts' 0.19 m, so from any oblique approach the pier puts a hard
       *     vertical silhouette edge across a lit wall — a step discontinuity at
       *     architectural scale, which is what the coarse band measures.
       *  2. It BREAKS THE RUN. The corridor stops being one continuous tube and
       *     becomes a series of bays with something between them, which is the
       *     single clearest difference between our frames and st2's.
       *  3. It gives the wall a SCALE. A 0.95 m pier is legibly about a
       *     shoulder-width, so the 6.5 m wall above it finally has something
       *     human-sized to be measured against.
       *
       * Spacing is 2 cells, not 1: a pier in every cell is a colonnade, which is
       * repetition at a new pitch rather than an escape from it. At 8 m they are
       * far enough apart that a corridor reads as bays.
       *
       * 8.7 rather than a round 8.0, and this is not fussiness. Wall slabs are
       * centred on multiples of the 4 m cell, so a lattice at exactly 8.0 m
       * lands every pier dead centre of a slab, at zero offset, forever — the
       * "perfect repetition reads as wallpaper" failure reintroduced at a new
       * pitch, and the pier is the largest member in the maze so it is the worst
       * place to have it. 8.7 is incommensurate with 4, so a pier's position
       * within its slab walks steadily along the run and no two bays down a
       * corridor are framed identically.
       *
       * ---- WHAT THE PIERS MEASURE, STATED HONESTLY -------------------------
       *
       * They are METRIC-NEUTRAL, and they are kept anyway. Both halves of that
       * matter, so both are recorded.
       *
       * `tools/bc-pier-ab.mjs` hides them on the live trim mesh with a fragment
       * discard and shoots both variants from an IDENTICAL camera in an
       * IDENTICAL maze in ONE page load — monster frozen, dust frozen, beam
       * pinned — which is the only comparison this codebase can make honestly
       * (see trap 29b: the seed is `Date.now()`, so two builds are two different
       * mazes and their medians differ by more than any effect measured here).
       *
       *   WITH piers   : mid 17.51  hi 21.86  coarse 21.70  mid/hi 0.80
       *   WITHOUT piers: mid 17.52  hi 21.93  coarse 21.55  mid/hi 0.80
       *   paired delta coarse: mean -0.05, piers win 4 of 12.
       *
       * The toggle substantially repaints 42,000-67,000 LIT pixels per pair, so
       * this is not the vacuous-assertion failure of trap 16 — the members are
       * unquestionably in the light and unquestionably being removed.
       *
       * They are kept because the frames disagree with the statistic, and on
       * this particular question the frames are the better instrument. Compare
       * `/tmp/bc_pab/with_01.png` against `without_01.png`: with them the
       * corridor has masonry masses framing it into a bay; without, it is a
       * plain box with a lit far wall. What a pier contributes is SILHOUETTE and
       * OCCLUSION — a large dark mass interrupting a lit surface — and a
       * box-filter difference in lit pixels is close to blind to that by
       * construction, because it samples only where `lum > 25` and a pier's
       * whole contribution is to make a region NOT lit.
       *
       * That is the same shape of result as the previous lane's carpentry
       * finding, and the correct conclusion is the opposite one only because the
       * cost is different: the carpentry was ~50,000 triangles for a measured
       * -0.08, while the piers are **5,868 triangles** (trim 119,136 with them,
       * 113,268 without, measured on the live scene) — 2% of the trim and 0.5%
       * of a 284k scene, in the same merged geometry and the same draw call.
       *
       * **Do not re-litigate this with the band metrics.** If a future lane
       * wants to remove them, the argument has to be made from frames or from
       * an occlusion measure, because the band metrics have already been asked
       * and have already answered "no difference".
       */
      pierSpacing: 8.7,
      pierWidth: 0.95,
      pierDepth: 0.42,
      /**
       * The pier's own cap and base, which are what stop it reading as a plain
       * pilaster stuck to the wall. Both step OUT beyond the pier's own depth,
       * so each throws a horizontal shadow line the full width of the member —
       * two more coarse-band edges for four boxes.
       */
      pierCapHeight: 0.34,
      pierCapOut: 0.13,
      pierBaseHeight: 0.52,
      pierBaseOut: 0.10,
      /**
       * Fraction of piers carrying a corbelled offset partway up — the pier
       * steps back on itself, the way a real buttress sheds load. Not all of
       * them, for the reason `braceChance` is not 1.0.
       */
      pierStepChance: 0.45,
      /**
       * ---- STUDWORK: the fix for the band the beam actually lands in --------
       *
       * Measured, per-band, on the shipped build against amn1, splitting each
       * frame into vertical thirds (bottom = floor, middle = wall at eye height,
       * top = wall tops and sky):
       *
       *   band              ours    Amnesia
       *   top (sky/tops)     3.9      11.3
       *   MIDDLE (wall)      6.7      32.5    <-- 5x, and it is where the beam is
       *   bottom (floor)    14.3      36.3
       *
       * The middle band is the failure by a wide margin, and it is exactly the
       * 1.25 m gap between the waist rail at 1.05 and the head rail at 2.30. Eye
       * height is 1.68 — dead centre of that gap — so the beam's hot core spends
       * essentially all its time inside a region containing no geometry at all,
       * only the shader's bond pattern. That pattern is a normal perturbation: it
       * changes N so it shades, but it cannot occlude and it cannot cast, so at
       * 4-6 m it delivers a soft low-amplitude ripple the box(3)-box(17) filter
       * reads as almost nothing. The frames say the same thing — the beam lands
       * on what looks like embossed wallpaper.
       *
       * The fix is a timber frame filling that bay: vertical studs between the
       * rails, and a diagonal brace in some bays. Studs are the real answer to a
       * blank panel in timber-framed building, they are cheap (one box each), and
       * mechanically they are the right shape for this problem — a vertical
       * member under a horizontally-sweeping beam is crossed edge-on, so the beam
       * rakes it maximally, and each one occludes the panel behind it.
       *
       * The diagonal earns its triangles separately: every other member here is
       * axis-aligned, and a frame of only horizontals and verticals reads as a
       * grid however good its relief is. One slanted member per few bays breaks
       * the lattice and is the strongest "a person built this" cue available for
       * one box.
       */
      studSpacing: 0.78,
      studWidth: 0.19,
      studDepth: 0.115,

      /**
       * ---- WHERE THE BEAM ACTUALLY LANDS, AND WHY NO MORE TIMBER GOES IN --
       *
       * Recorded because it is a NEGATIVE result that cost a full lane to get,
       * and because the obvious next move here is wrong.
       *
       * `tools/bc-hitheight.mjs` raycasts the real cone against the real
       * colliders from the sample poses and histograms the world Y of every hit,
       * weighted by the light that hit receives. It found that 83.4% of beam
       * energy lands on WALLS, that the hit distance peaks at 5-7 m rather than
       * the 2-4 m assumed throughout the notes above, and that 69.5% of that
       * energy falls on wall with no geometry on it — 25.8% in the band between
       * the skirting cap and the waist rail, 23.5% above the head rail.
       *
       * That looks like a clear instruction to fill those two bands, so it was
       * done: vertical dado boarding at a 0.22 m pitch below the waist rail, and
       * horizontal lath at 0.19 m above the head rail, both sized to land inside
       * the metric's passband at the measured range. It works as carpentry — an
       * emissive paint pass shows the members exactly where intended, and the
       * toggle repaints 66,255 of the frame's 80,653 lit pixels, so they are
       * unquestionably in the light.
       *
       * They are still worth NOTHING, and the reason generalises:
       *
       *   paired A/B, 8 wall-facing poses, one page load, beam at reference
       *   exposure:  with dado+lath 19.99, without 20.07, delta -0.08, and the
       *   version WITHOUT them won 5 of 8 poses.
       *
       * Worse, the same test on the carpentry as a whole says the existing trim
       * is net NEGATIVE at correct exposure: midFreqStd 21.76 with it against
       * 25.54 with it hidden. The members are 0.15-0.6 m of flat dark timber,
       * and they OCCLUDE a wall whose shader-drawn coursing is finer and higher
       * contrast than they are. Adding more of them trades a good surface for a
       * worse one.
       *
       * The dado and lath were therefore removed rather than kept — they cost
       * ~50,000 triangles (trim went 239k with them, and the scene 399k against
       * a ~349k budget where Billy is already ~150k) to move the metric by
       * -0.08. **Do not re-add wall carpentry to chase this number.** If a
       * future lane wants to try, run `tools/bc-newgeo.mjs`-style paired A/B at
       * pinned beam intensity FIRST; at the shipped exposure the same test
       * returns a false positive, which is how the timber got here.
       */

      /**
       * Length of one board in a horizontal band, in metres.
       *
       * This is the carpentry's biggest triangle line item — five bands on every
       * wall slab in a 21x21 maze — so it is a budget knob as much as a look
       * knob. The trim shader draws butt joints of its own at `timberLength` for
       * nothing, so the geometric split only has to supply the joints near
       * enough to show real parallax; past about 6 m the shader's line and a
       * modelled one are indistinguishable. 2.1 m keeps two boards per 4.35 m
       * slab and takes roughly a third off the band count against the 1.6 m this
       * started at.
       */
      boardLength: 2.1,
      /** Diagonal brace across a bay. `braceWidth` is its cross-section. */
      braceWidth: 0.16,
      braceDepth: 0.105,
      /**
       * Fraction of bays that get a brace. Not all of them: a brace in every bay
       * is a zigzag frieze, which is decoration. Roughly a third, chosen by a
       * hash of the bay's world position, reads as structure placed where the
       * builder needed it.
       */
      braceChance: 0.36,
      /**
       * ---- IRREGULARITY ----------------------------------------------------
       *
       * "Perfect repetition reads as wallpaper, and wallpaper has no scale."
       * Every member's size and placement is jittered by a hash of its own world
       * position, so the pattern is deterministic — the same maze rebuilds
       * identically, and the colliders are unaffected because none of this is a
       * collider — but never exactly repeats. Three mechanisms, because they fail
       * differently:
       *
       *   `jitter`      — continuous per-member scatter in size and offset. Kills
       *                   the "extruded from a CAD file" read.
       *   `leanChance`  — a post out of plumb by up to `leanMax` radians. One
       *                   leaning post in a colonnade is worth more than any
       *                   amount of surface noise, because the eye calibrates
       *                   vertical against gravity and notices immediately.
       *   `breakChance` — a member simply absent. A gap in a rail is what tells
       *                   you the rail was continuous; an unbroken rail could be
       *                   a texture. This is the cheapest detail in the file, and
       *                   being negative geometry it costs less than nothing.
       */
      jitter: 0.24,
      leanChance: 0.10,
      leanMax: 0.08,
      breakChance: 0.075,

      /**
       * ---- THE CARPENTRY'S OWN SURFACE ------------------------------------
       *
       * These drive the trim's structural shader in world.ts, and they exist
       * because of one attribution measurement that reframed this whole lane.
       *
       * Painting each surface class emissive in turn and counting how many of
       * the frame's LIT pixels changed colour gives: trim 32.6%, wall 29.5%,
       * floor 0%. The carpentry is the single largest lit surface in the frame —
       * bigger than the wall it is fixed to — and it shipped with no structural
       * shader at all, only a flat tint over the graded albedo.
       *
       * That also resolves a result that had looked like a broken shader:
       * driving the WALL's `plankVariance` from 0.0 to 3.0, a 6x overdrive,
       * moved lit-pixel mid-frequency detail by 0.3. Nothing was wrong with the
       * wall shader. The beam simply was not landing on the wall.
       *
       * All three terms are ALBEDO terms rather than normal terms, and that is
       * the central finding of this lane rather than an implementation detail.
       * The flashlight is mounted at the camera, so L ≈ V across the whole
       * frame, so N·L is nearly constant over any surface facing the player and
       * the diffuse response is close to blind to relief. Measured, each on a
       * fixed frame with the sim frozen so nothing else moved:
       *
       *   carpentry albedo LEVEL, 10x range ............ 9.93 -> 10.22
       *   joint bevel depth / plank pitch / normalScale . 10.4 -> 11.1
       *   member standoff from the wall, out to 0.7 m ... 9.81 -> 9.99
       *   carpentry ROUGHNESS 0.68 -> 0.20 .............. 9.93 -> 12.77
       *
       * Only roughness moved, and it moved because it widens the SPECULAR lobe,
       * which is the one term that has a view dependence when L ≈ V. An albedo
       * RATIO is the other thing that survives this rig: it holds its relative
       * contrast at every brightness, which matters most in the dim rim of the
       * beam where 75% of our lit pixels live and where we measured 3.3-4.3
       * against the reference's 9.1-19.2.
       */
      /** Board-to-board tonal scatter. The largest of the three terms. */
      timberVariance: 0.52,
      /**
       * Board length in metres — the pitch of the end-grain butt joints.
       *
       * 1.35 -> 0.62, following the same angular-size argument that took the
       * wall's course pitch from 0.44 to 0.16: at 6-10 m a 1.35 m board is
       * wider than the metric's box(17) window, so its joints are subtracted
       * out as a gradient rather than read as structure. 0.62 m keeps two
       * joints inside a typical member instead of none.
       */
      timberLength: 0.62,
      /**
       * Sawn grain: bands running along the member, in cycles per metre.
       *
       * 5.5 -> 9.0. Swept from 5.5 to 40 in the oblique pose this term is nearly
       * flat (10.21 -> 10.13 at the extreme), which is itself the useful result:
       * grain is a FINE-scale term and most of its energy lands below the 3 px
       * floor the metric starts at, so it is not what carries the measurement.
       * It is kept, and nudged to where a band is about 11 cm, because it is
       * what stops a member reading as a flat-shaded box when you are close
       * enough to touch it — a case the metric never looks at and the player
       * spends real time in.
       *
       * ---- 9.0 -> 3.4, and the note above already contains the reason ------
       *
       * "grain is a FINE-scale term and most of its energy lands below the 3 px
       * floor the metric starts at, so it is not what carries the measurement."
       * That is correct, and it is exactly why the term had to come DOWN rather
       * than be left alone: energy below 3 px is not neutral, it is the `hi`
       * band, and ours measured 25.3 against Amnesia's 4.1. A term that lands
       * entirely in the noise band while contributing nothing to structure is a
       * pure cost.
       *
       * 9 cycles/m is an 11 cm band, which at 6 m is 9 px of period — under two
       * pixels per light-dark pair, i.e. it aliases into crawl on every camera
       * move. 3.4 gives a 29 cm band, ~25 px at 6 m, which reads as sawn grain
       * at conversational distance and resolves cleanly instead of shimmering.
       */
      grainScale: 3.4,
      /**
       * 0.34 -> 0.22. Same argument: whatever grain energy still falls below the
       * resolution limit is amplitude in the noise band, and the depth term is
       * what sets that amplitude.
       */
      grainDepth: 0.22,
      /**
       * Joists spanning the corridor overhead. The maze has no ceiling on purpose
       * (see `ceiling`), but bare wall tops leave the whole upper half of the frame
       * empty. Joists give the beam something to find when you look up, drop bars
       * of shadow down the walls, and cut the red sky into slots — which is what
       * finally makes a wall read as *tall*, because there is now something at the
       * top of it to be far away from.
       */
      joistY: 5.4,
      joistSize: 0.22,
      /** One joist every this many metres of corridor. */
      joistSpacing: 2.0,
      /**
       * Joists only span gaps this wide or narrower, in metres. A joist is a beam
       * resting on two walls; laying one across an open junction where there is
       * nothing under either end reads as a floating stick.
       */
      joistMaxSpan: 5.0,

      /**
       * Plank courses — horizontal joints running the full height of every wall,
       * done in the wall shader rather than as geometry. See the long note beside
       * the normal_fragment_maps patch in world.ts.
       *
       * These exist because the four timber bands above leave a 1.25m gap between
       * the waist rail and the head rail, and eye height is 1.68m — dead centre of
       * it. Standing a metre from a wall looking straight at it, the beam lands
       * entirely inside that gap and finds nothing: measured 5.75 mid-frequency
       * structure in lit pixels on that exact shot, against Amnesia's 30.91. The
       * courses fill the gap at zero triangle cost.
       *
       * They are a normal perturbation, not a painted stripe. That distinction is
       * the whole point: perturbing N changes N·L, so a moving torch genuinely
       * rakes across each course edge — one lip brightens as the beam swings onto
       * it and goes dark as it passes. A darkening alone would read as a decal
       * that ignores the light.
       *
       * `courseHeight` is the plank pitch in metres, `courseWidth` the width of
       * the joint in metres, `courseDepth` how hard the two lips of the joint tilt
       * (in normal-vector units, not metres).
       *
       * ---- 0.44 -> 0.16, and this is the single largest measured win in the
       *      lane after the carpentry's own shader --------------------------
       *
       * The old note here argued 0.44 m on the grounds that "much finer and the
       * course period drops below a pixel at corridor distance and aliases into
       * a moire crawl". The concern is real but the threshold was set by
       * intuition, and when it was actually swept the intuition was off by
       * nearly 3x — 0.44 m was so far the safe side of aliasing that it had
       * stopped resolving at all.
       *
       * Swept on live shaders at two poses, `square` (beam onto a wall at ~4 m)
       * and `oblique` (beam down a corridor, the pose that measured worst), with
       * `plankAspect` scaled alongside so the planks stay plank-shaped:
       *
       *   pitch   square  oblique   hiFreq(square)
       *   0.44     13.02   11.79        16.94
       *   0.30     14.08   13.33        17.21
       *   0.22     14.37   14.74        17.07
       *   0.18     15.87   16.49        17.53
       *   0.16    *17.91* *17.22*       17.91
       *   0.14     17.01   17.58        17.84
       *   0.11     16.55   18.82        18.58
       *
       * `hiFreq` is energy at 1-3 px, i.e. BELOW the measured band, and it is in
       * the table specifically to catch the failure the old note feared: a pitch
       * that has begun to alias raises midFreqStd while dumping energy into
       * sparkle, so a rising score with a fast-rising hiFreq is an artifact and
       * not architecture. It stays flat to 0.16 and climbs below it, and the
       * frames agree — at 0.11 the wall visibly speckles at range, at 0.16 it
       * reads as clean coursed boarding.
       *
       * 0.16 is also where the square pose peaks and starts to fall, so it is
       * not a compromise between the two ranges; it is the best available at
       * one of them and within 8% of the best at the other.
       *
       * Why pitch matters this much is the angular-size argument that governs
       * this whole lane: a feature of period p at range r subtends p/r, and the
       * metric is a box(3)-box(17) difference, so a feature narrower than ~3 px
       * is invisible to it and a feature wider than ~17 px is subtracted out as
       * a gradient. At 6-10 m a 0.44 m course is a handful of pixels tall and
       * lands under the floor. Nothing else about it was wrong — it simply was
       * not being measured, and by extension was not being seen.
       *
       * ---- 0.16 -> 0.12, re-measured AT THE CORRECT EXPOSURE -------------
       *
       * The sweep above is sound but it was run against a build whose beam was
       * far dimmer than the reference, and that changes the answer. `midFreqStd`
       * is computed in raw luminance over pixels with lum > 25, so when most of
       * the lit region sits just above that gate the measurement is dominated by
       * which pixels clear it rather than by what structure they contain — and
       * every structural term then reads as saturated. It was: a full sweep of
       * every wall, floor and trim uniform over a 3x overdrive moved the number
       * by under 0.6 (`tools/bc-pitch.mjs`, `tools/bc-newtune.mjs`).
       *
       * Re-swept with the beam pinned to put meanLum in the reference's own
       * 14-19 band (`window.__BEAM_TUNE__({intensity:600})`), five wall-facing
       * poses each, with `hiFreq` (1-3 px energy) carried alongside so aliasing
       * cannot pass as detail:
       *
       *   pitch   midFreq   hiFreq   mid/hi
       *   0.16     20.95     24.81    0.844
       *   0.14     21.61     25.16    0.859
       *   0.13     21.74     25.20    0.863
       *   0.12    *21.90*    25.63    0.854
       *   0.11     21.51     25.91    0.830
       *   0.10     20.96     26.03    0.805
       *   0.09     20.53     26.46    0.776
       *
       * 0.12 m is the peak, and below it the score FALLS while hiFreq keeps
       * climbing — energy leaving the measured band for sparkle, which is
       * exactly the aliasing failure the note above feared. The mid/hi ratio
       * peaks at 0.13-0.12 and collapses below it, so both readings agree on
       * where the useful floor is.
       *
       * ---- 0.12 -> 0.52, AND EVERY SWEEP ABOVE WAS OPTIMISING A LOGO ------
       *
       * Read the table immediately above one more time before trusting it:
       * `mid/hi` never exceeds 0.86 at ANY pitch in it. Amnesia's is 2.2-3.8.
       * The sweep recorded the symptom of the failure in its own results column
       * and then picked the row that maximised the broken term.
       *
       * THE GATE ITSELF WAS THE BUG. `midFreqStd >= 20` was calibrated on
       * "Amnesia corridor amn1.jpg = 30.69". `/tmp/amn/amn1.jpg` is the
       * TITLE-SCREEN WALLPAPER: the white "Amnesia / THE DARK DESCENT" wordmark
       * is rendered across the middle of it, in the brightest part of the frame,
       * which is precisely where midFreqStd samples (lum > 25).
       *
       *     amn1 full frame ............................ 30.69  <- the gate
       *     amn1 with the logo region masked out ....... 11.43
       *     amn1 logo region alone ..................... 48.13
       *
       * The wordmark is 21.3% of the lit pixels. Mask-independent confirmation:
       * the lum>200 band holds 47,622 px at mean saturation 0.024 — desaturated
       * near-white, which lantern-lit stone never is (every other band runs
       * 0.15-0.25 saturation). Against the ten other Amnesia references on disk,
       * amn1 is a 3.5x outlier; the rest measure 5.0-17.8 and their median is
       * 8.74. `tools/measure-bands.mjs --refs` reproduces all of this.
       *
       * So three waves of this lane were asked to make a corridor 2-4x more
       * mid-frequency-busy than any real Amnesia frame in order to match a piece
       * of vector lettering, and the pitch was driven 0.44 -> 0.16 -> 0.12 doing
       * it. That is also the whole explanation for the previous lane's
       * "deleting all architecture RAISES the score to 31.45" result: a flat
       * uniform grid of small squares is the closest a wall can get to being a
       * page of text. The metric was rewarding wallpaper because the target was.
       *
       * What the frames actually showed at 0.12: a uniform fine grid of squares,
       * floor to sky, at one pitch, in every corridor. Band-energy profile of
       * lit pixels, ours against the reference:
       *
       *   band px        1-3    3-9   9-17  17-33  33-65 65-129
       *   AMNESIA st2    7.5%  14.8%  13.6%  15.7%  19.1%  29.2%
       *   AMNESIA st5    9.9%  17.7%  17.9%  17.0%  16.8%  20.6%
       *   ours @0.12    28.8%  19.1%   9.8%  12.1%  14.9%  15.3%
       *
       * We put 29% of our structural energy at 1-3 px and 28% above 17 px;
       * Amnesia is 7-10% and ~48%. We were the exact inverse of the reference —
       * noisy up close and empty at architectural scale.
       *
       * 0.52 m is chosen by projected size rather than by sweeping the broken
       * metric. A feature of period p at range r subtends p/r; over the 4-8 m
       * where the beam does its work, in a 720 px frame at this FOV:
       *
       *     0.52 m  ->  67 px at 4 m, 45 px at 6 m, 33 px at 8 m
       *
       * which sits inside the 17-65 px band that carries ~35-45% of Amnesia's
       * structure and where ours was nearly empty. It is also simply what the
       * reference has: the masonry in st2 measures a 240 px dominant period, and
       * Amnesia's blocks are roughly half a metre across.
       *
       * `plankAspect` stays 1.8, so a unit is 0.52 x 0.94 m — a proper ashlar
       * block rather than the 0.12 x 0.22 m hand-sized chip this was cutting.
       *
       * ---- VALIDATED BY PAIRED A/B, not by the reasoning above -------------
       *
       * The reasoning is tidy, which is exactly why it needed falsifying rather
       * than trusting — the tables it replaces were tidy too. `tools/bc-pitch-ab.mjs`
       * moves ONLY this uniform (and `courseWidth`, held in proportion) on the
       * LIVE material, shooting both variants from an IDENTICAL camera in an
       * IDENTICAL maze in ONE page load, monster and dust frozen, beam pinned.
       * That is the only comparison this codebase can make honestly; see trap
       * 29b for why a rebuild-based sweep cannot.
       *
       *   pitch 0.12 m:  mid 15.19  hi 14.41  coarse 20.53  mid/hi 0.95
       *   pitch 0.52 m:  mid 15.17  hi 14.11  coarse 20.91  mid/hi 0.96
       *
       *   paired delta hi     : mean -1.28, median -1.09, QUIETER IN 11 OF 12
       *   paired delta mid/hi : mean +0.04, median +0.05, BETTER  IN 11 OF 12
       *
       * 12 poses across 3 distinct wall-distance classes, 25,000-53,000 lit
       * pixels substantially repainted per pair. An 11-of-12 win is not seed
       * noise; the per-pose effect is small but it is consistent, and it is in
       * the band that is actually short.
       *
       * The frames are the stronger evidence and they are unambiguous:
       * `/tmp/bc_pitch/a_00.png` is a fine mesh with no scale to it, and
       * `b_00.png` is legible ashlar where each block reads as a stone.
       */
      courseHeight: 0.52,
      /**
       * WIDENED 0.026 -> 0.055 with the pitch. The joint is mortar between
       * stones, so it has to scale with the stone or a 0.52 m block gets a
       * hairline crack around it that vanishes past 5 m — which is the same
       * sub-pixel failure the pitch change exists to fix, reintroduced at the
       * one place the eye actually reads a block edge. 0.055 m holds a 3-7 px
       * dark line across the whole 4-8 m working range.
       */
      courseWidth: 0.055,
      /**
       * How dark a joint goes, as a multiplier on the albedo either side of it.
       * Shared by the wall courses, the floor's flagstone joints and the
       * carpentry's end-grain butt joints, so the three cannot drift apart.
       *
       * This is the one term aimed squarely at the BRIGHT quartile, which is the
       * only band still well short of the reference. Per-quartile, ours against
       * amn1 across the 12-frame corridor sweep:
       *
       *   quartile   ours      amn1
       *   Q1 dimmest 6.1-17.6   9.1
       *   Q2         7.2-23.2  10.1
       *   Q3         9.5-26.1  19.2
       *   Q4 hottest 14.3-27.1 41.1   <-- the whole remaining gap
       *
       * Amnesia reaches 41 in its hot quartile because at 150+ luminance its
       * cobbles still have near-black mortar between them. Ours washes out,
       * because a joint authored as a MULTIPLIER holds its ratio but a beam core
       * bright enough to clip removes the headroom above it. A darker multiplier
       * is the correct answer rather than a wider joint: widening it would eat
       * the stone, while deepening it keeps the same pattern and simply gives
       * the hot core somewhere black to sit against.
       *
       * Swept on a fixed frame, reading Q4 separately so a change that lifted
       * the mean by flattening the top could not pass as a win:
       *
       *   jointDark   midFreq    Q1    Q4
       *     0.34       28.51    23.8  22.2
       *     0.26       29.18    24.6  22.1
       *     0.20       29.22    24.8  22.7
       *     0.14       29.66    25.8  22.7
       *     0.08       29.57    25.9  22.9
       *     0.03       29.91    25.8  23.1
       *
       * The curve is a plateau, not a cliff — worth about 1.4 across its whole
       * range, which is honest to record because it means this is a finishing
       * term and not another `courseHeight`. 0.16 sits on the flat part while
       * keeping the joint a dark line rather than a hole punched to black:
       * mortar that reads as absence rather than as material is the tell of a
       * wall that was drawn instead of built.
       */
      jointDark: 0.16,
      /**
       * ---- PATCHES: the term that still resolves at 8-15 m ----------------
       *
       * Metre-scale mottling of damp, soot and old repair, applied to the wall,
       * the floor and the carpentry alike so the three stain together rather
       * than each carrying its own unrelated noise.
       *
       * It exists because a 16-pose sample across the maze
       * (`tools/beats/bc-gate.json`) splits cleanly in two rather than
       * scattering: poses with a wall within a few metres measure 23-28, at or
       * above the reference's own band, while poses looking down an open
       * corridor measure 11-16. Nothing is wrong in the second group except
       * range. Every other structural term in this file is fine-scale — 0.16 m
       * courses, 0.34 m flags, 0.62 m boards — and a feature of period p at
       * range r subtends p/r, so by 8-15 m all of them have fallen to about a
       * pixel. That is below the box(3) floor of the measurement, and below what
       * the eye resolves either; the wall genuinely has nothing on it at that
       * distance.
       *
       * Patches are the answer because they are the only term with a period long
       * enough to survive — several planks across, so they neither replace the
       * fine detail nor compete with it. Near to they read as staining laid over
       * the masonry; far off they are the last thing still visible.
       *
       * The noise is contrast-stretched through a smoothstep rather than used
       * raw, and that is load-bearing: a raw fBm is mostly mid-grey and reads as
       * haze, which a box filter averages straight out. Stretching it produces
       * actual clean areas and actual dark ones with edges between them, and it
       * is the edges that both the measurement and the eye are looking for.
       *
       * The term is DARKEN-ONLY (`mix(1 - patchDepth, 1.0, patch)`), which is
       * why 0.42 here is not as strong as it looks. The first version mixed
       * symmetrically around 1.0 and, because the smoothstep skews the
       * distribution, averaged above it — mean scene luminance went 15.9 -> 21.4
       * and litFrac 0.128 -> 0.164 while midFreqStd stayed flat. Brightening a
       * wall pushes dim structureless pixels over the metric's `lum > 25` gate
       * and dilutes the average over a larger and flatter population, which is
       * the same trap that made a global albedo gain measure worse. Staining is
       * subtractive in the world as well: soot and damp darken masonry, they do
       * not bleach it.
       */
      patchDepth: 0.42,
      courseDepth: 0.85,
      /**
       * Plank length as a multiple of `courseHeight`, and how much plank-to-plank
       * tonal variation there is.
       *
       * The courses alone made the wall corduroy: horizontal lines and nothing
       * else, which the eye reads as a stripe texture rather than as masonry.
       * Real bonded work has joints on BOTH axes, staggered half a unit on
       * alternate courses, and — the part that actually carries the measurement —
       * no two neighbouring units the same value. In the Amnesia reference the
       * block-to-block tonal scatter is most of what you are seeing when you look
       * at that lit wall; the mortar lines only frame it.
       *
       * `plankVariance` is deliberately large. It adds contrast *within* the
       * beam rather than merely making the beam bigger, which is the distinction
       * the whole lane turns on.
       *
       * One honest correction to the sentence that used to follow, because it
       * was measured and it is not true: this is NOT the single biggest
       * contributor. Driving it from 0.0 to 3.0 — a 6x overdrive — moved
       * lit-pixel mid-frequency detail by 0.3 on a fixed frame. The reason is
       * not that the term is broken; surface attribution showed the beam was
       * spending only ~30% of its lit pixels on the wall at all, and most of the
       * rest on carpentry that had no structural shader. Course PITCH turned out
       * to matter roughly twenty times more than course CONTRAST, because pitch
       * decides whether the feature is inside the measurement's passband at
       * corridor range and contrast only decides its amplitude once it is.
       *
       * `plankAspect` 3.4 -> 1.8 follows `courseHeight` 0.44 -> 0.16: the aspect
       * is a multiple of the pitch, so leaving it at 3.4 would have kept plank
       * LENGTH at 0.54 m while the height fell to 0.16 m, i.e. turned the bond
       * into thin lath. 1.8 keeps a plank about 0.29 m long against 0.16 m
       * high — a short, thick board, which is what the wall wants at this pitch.
       */
      plankAspect: 1.8,
      plankVariance: 0.46,

      /**
       * Flagstones. Same running-bond treatment as the walls, laid flat.
       *
       * The floor needs this more than the walls do. It is the surface the torch
       * spends most of its time pointed at; it is always seen at a grazing angle,
       * where a plain tiled texture smears into mush; and it is the only surface
       * that can tell you how fast you are walking, because a featureless plane
       * slides beneath you with no sense of travel at all. In the Amnesia
       * reference the cobbles are the single clearest piece of structure in the
       * frame.
       *
       * 0.62 -> 0.34 m, for the same reason and off the same sweep as
       * `courseHeight`. The floor is seen at a grazing angle by definition, so
       * its slabs are foreshortened harder than anything else in frame: a 0.62 m
       * slab five metres down a corridor projects to a few pixels of depth and
       * falls under the metric's 3 px floor exactly as the old 0.44 m courses
       * did. Measured in the oblique pose, dropping to 0.36 with the joint
       * tightened to match moved lit mid-frequency detail 10.21 -> 12.96.
       *
       * 0.34 m is also simply what the reference has: the cobbles in amn1 are
       * roughly a third of a metre across, and their per-stone tonal scatter is
       * the brightest and most structured thing in that whole frame.
       *
       * `flagJoint` scales with the slab — a joint is mortar between stones, so
       * holding it at 0.045 m while the stone halved would have turned the floor
       * into a grid of grout with chips in it.
       *
       * ---- 0.34 -> 0.78, for the reason given at `courseHeight` -----------
       *
       * The sweep that produced 0.34 ("dropping to 0.36 with the joint tightened
       * moved lit mid-frequency detail 10.21 -> 12.96") was measuring against the
       * title-logo gate, and it moved the floor the wrong way for the same
       * reason it moved the walls the wrong way.
       *
       * The floor is worse than the walls here, not better, and the note above
       * says why without drawing the conclusion: it is *always* seen at a
       * grazing angle, so its slabs foreshorten harder than anything else in
       * frame. A 0.34 m slab five metres down a corridor is a couple of pixels
       * of depth — so the floor was delivering almost pure 1-3 px noise, which
       * is a large part of why our hi band ran 25 against the reference's 4.
       *
       * 0.78 m holds up under that foreshortening and is what the reference
       * has: the cobbles in amn1 and the flags in st2 are large, and they are
       * the clearest single piece of structure in either frame.
       */
      flagSize: 0.78,
      /** Scales with the slab; see `courseWidth`. */
      flagJoint: 0.055,
      flagDepth: 0.9,
      flagVariance: 0.38,
    },
  },

  player: {
    eyeHeight: 1.68,
    radius: 0.34,
    walkSpeed: 2.6,
    sprintSpeed: 5.0,
    /** Seconds to reach full speed. Instant acceleration feels like a spreadsheet. */
    accel: 12,
    friction: 11,
    mouseSensitivity: 0.0022,

    /**
     * Collision substepping. The player is a disc tested against static boxes at
     * its *current* position — there is no swept volume — so a single move longer
     * than the radius can pass clean through a wall without ever overlapping it.
     *
     * player.ts splits each frame into however many substeps it takes to keep every
     * move under `radius * maxStepFraction`. 0.6 leaves a wide margin over the
     * radius; the cap stops a pathological dt from costing an unbounded loop.
     *
     * This is not theoretical. `tools/soak/player-soak.mjs` at a 120ms frame
     * measured a 1.11m displacement in one step against a 0.34m radius and pushed
     * the player outside the maze on 76,423 substeps. game.ts's 50ms dt clamp
     * happens to hide it today at 0.25m per step, but that is a constant in
     * somebody else's file, not a guarantee in this one.
     */
    maxStepFraction: 0.6,
    maxSubsteps: 8,

    /**
     * Most footstep sounds a single frame may emit. A slow frame can honestly cover
     * more than one foot plant, but firing a dozen at once is a machine gun rather
     * than a run — and an unbounded loop driven off a float is a hang waiting for a
     * bad number.
     */
    maxStepsPerFrame: 3,

    /**
     * Fixed timestep for the two feel springs — the per-footfall nod and the stop
     * settle — and the most leftover time the accumulator will carry.
     *
     * Semi-implicit Euler at these stiffnesses is stable but strongly
     * amplitude-dependent on `dt`, so integrating with the raw frame time quietly
     * destroys the effect on a slow machine. The walking nod measured 9.1mm at
     * 120fps, 5.9mm at 30fps, 3.0mm at the 50ms clamp — which is exactly where the
     * capture harness lives — and 0.0mm at 100ms. That means a critic on
     * SwiftShader was judging a third of the nod that was designed. On a fixed
     * substep it is 9.1mm at every frame rate.
     *
     * 240Hz is comfortably above both springs' natural frequencies. The accumulator
     * cap stops a catastrophic frame from spending hundreds of iterations catching
     * up.
     */
    springStep: 1 / 240,
    springMaxAccum: 0.1,

    /**
     * Stride length in metres, per single step (heel to opposite heel).
     *
     * These set the cadence, because head bob AND the footstep sound are both read
     * off `distance travelled / stride` — one clock. See the long comment at the
     * top of player.ts. Do not add a separate "steps per second" or a bob
     * frequency: two clocks is precisely the bug this replaced, measured at
     * 2.93 head-bobs per second against 1.62 footfalls per second.
     *
     * 1.30m at 2.6 m/s -> 2.0 steps/sec, an ordinary human walk.
     * 1.52m at 5.0 m/s -> 3.3 steps/sec, a run. Sprinters take more, longer steps.
     */
    strideWalk: 1.30,
    strideSprint: 1.52,

    /**
     * Head bob. `walkAmp`/`sprintAmp` are the amplitude of the vertical dip in
     * metres; `lateralRatio` is how much of it goes sideways.
     *
     * The lateral runs at *half* the vertical frequency — one weight shift per two
     * foot plants — and that ratio is the thing that reads as a body instead of a
     * camera on a sine wave. Both are in player.ts's waveform, not here, because
     * they are anatomy rather than taste.
     */
    bob: { walkAmp: 0.030, sprintAmp: 0.052, lateralRatio: 0.72 },

    /**
     * Camera roll. Sprint widens it — the brief asks for sway that increases when
     * sprinting. `rollLagRadians` trails the roll behind the weight shift so the
     * head reads as being carried rather than driven.
     */
    sway: { walkAmp: 0.013, sprintAmp: 0.032, rollLagRadians: 0.55 },

    /**
     * The downward kick each time a foot plants, modelled as a small spring in
     * player.ts. This is the difference between "the view moves up and down" and
     * "something heavy just hit the floor", and it is the only part of the gait
     * that is not a smooth sine — impacts are not smooth.
     *
     * `nodImpulse` is a velocity, not a distance. Scaled by effort, it resolves to
     * a dip of roughly 9mm walking and 19mm sprinting, against a bob of 30mm and
     * 52mm respectively — about a third of the bob in both cases, which is where it
     * reads as weight rather than as noise. At the first value tried (0.075) the
     * dip was 1.76mm, six percent of the bob, and simply could not be seen.
     *
     * `nodToPitch` converts the vertical dip into camera pitch so the view *nods*
     * instead of merely dropping. 0.97 rad/m gives about half a degree per walking
     * footfall and a degree at a sprint.
     */
    nodImpulse: 0.27,
    nodStiffness: 190,
    nodDamping: 16,
    nodToPitch: 0.97,

    /**
     * Landing settle. Stop hard and the momentum you were carrying goes into your
     * knees.
     *
     * It fires *once per stop*, not once per frame — player.ts latches the fastest
     * speed reached while coasting and spends a single impulse proportional to it
     * on arrival at rest. Per-frame was the first attempt and the trace caught it:
     * deceleration spans dozens of frames, the impulse got spent dozens of times,
     * and the settle reached 4.5 degrees of pitch, which is a lurch not a settle.
     *
     * You must be coasting above `settleThreshold` m/s for anything to happen, and
     * rest is declared below `settleMinSpeed`.
     *
     * Measured shape at these values, stopping from a full sprint: a 22mm dip
     * reaching its floor at ~170ms, back through zero at ~500ms, a 2mm overshoot,
     * done. Slower and deeper than a footfall nod, which is right — the whole body
     * absorbed that, not one ankle.
     */
    settleThreshold: 1.2,
    settleMinSpeed: 0.12,
    settleGain: 0.34,
    settleStiffness: 55,
    settleDamping: 8.5,
    /**
     * 1.35 rad/m puts the stop at about 1.7 degrees of pitch. It must exceed the
     * per-footfall nod's ~0.9 degrees or coming to a halt reads as lighter than
     * taking a step, which is exactly backwards.
     */
    settleToPitch: 1.35,

    /**
     * Breathing — the only time-driven motion in the controller, and correctly so:
     * your chest does not stop when your feet do.
     *
     * It does two jobs. Standing still it is the entire motion, and the reason an
     * idle frame is not a photograph. Sprinting it comes back on top of the gait,
     * faster and deeper — that heavier breathing in the camera is the perceptual
     * price of a sprint, which is what the brief asks for in place of the stamina
     * bar the user explicitly rejected. Only during an ordinary walk is it
     * suppressed, because a walking body's breath is buried under its own footfalls.
     *
     * 0.23 Hz is ~14 breaths a minute: a resting adult. At full sprint the rate
     * boost takes it to ~28/min, which is someone working hard but not dying.
     */
    breath: {
      freq: 0.23,
      amp: 0.0085,
      lateralAmp: 0.0042,
      rollAmp: 0.0032,
      /**
       * Radians of head PITCH per breath. This is the channel that was missing.
       *
       * The breath drove position.y, position.x and rotation.z but never
       * rotation.x, and `tools/soak/pf-feel.mjs` measured the consequence exactly:
       * 17.00mm of idle vertical travel with **0.000 degrees** of pitch over a 20s
       * window. An object that translates vertically while its aim stays perfectly
       * fixed is a camera on a slider, and standing still is the one moment the
       * player has nothing else to look at — the gait is gone, so breathing IS the
       * whole of the motion and any tell in it is the whole of the tell.
       *
       * A real chest tips the head as it fills: the ribcage rotates the neck
       * slightly back on the inhale. 0.0021 rad is 0.12 degrees, which over a
       * 4.35s cycle is a drift the eye reads as life rather than as camera shake.
       * It rides the same phase as the vertical so the nod and the rise are one
       * motion, not two — the head lifts AND tips together, which is what a breath
       * does, rather than tracing an ellipse.
       *
       * Deliberately an order of magnitude under the ~0.9 deg per-footfall nod:
       * breathing must never compete with a footstep for the same channel.
       */
      pitchAmp: 0.0021,
      /** Added to the rate multiplier at full sprint. 1.05 => a little over double. */
      sprintRateBoost: 1.05,
      /** How much of the breath survives on top of a full sprint's gait. */
      sprintWeight: 0.7,
      /** Extra amplitude at full sprint: the chest working harder, not just faster. */
      sprintDepth: 0.85,
    },

    /** Radians of forward lean at full sprint, and how fast the lean follows. */
    sprintLean: 0.038,
    leanSmoothing: 3.2,

    /**
     * Degrees of FOV added at full sprint. Deliberately small: a big push reads as
     * an arcade speed effect and this game is not that. 6 degrees on a 74 degree
     * base is felt and not seen.
     */
    sprintFovPush: 6,
    fovSmoothing: 4.0,

    /**
     * Sprinting costs control instead of costing a meter — the user rejected both
     * a sanity bar and a battery, so the price is paid in the hands. At full sprint
     * mouse sensitivity drops by this fraction, which makes swinging the flashlight
     * down a side corridor while running flat out genuinely harder.
     */
    sprintLookPenalty: 0.28,

    /**
     * How fast the three body signals follow their targets, per second.
     *
     * player.ts keeps `gait` (how much of the walk cycle is visible), `effort`
     * (speed as a fraction of top speed, remapped so a plain walk is 0) and
     * `sprintAmount` (are you genuinely running) as separate values, because
     * conflating them is exactly how a walk ends up wearing a sprint's field of
     * view. `gait` is the fastest of the three so the head stops swinging promptly
     * when you stop, while the FOV, lean and widened sway take their time coming
     * back down — momentum in the body, not just in the velocity vector.
     */
    intensitySmoothing: 7,
    gaitSmoothing: 9,

    /**
     * The first-person viewmodel: the torch in your fist and the forearm holding it.
     *
     * WHY THIS EXISTS. Everything above this block is a correct stride — measured at
     * -50ms step-to-bob sync, 1.70x bob and 2.69x sway under sprint, a 29mm stop
     * settle. None of it could be *seen*, because it was expressed only as motion of
     * an empty camera and there was no in-frame referent to read that motion
     * against. A camera that bobs perfectly with nothing in shot is, to the eye,
     * indistinguishable from a floating camera with a wobble filter on it. Amnesia's
     * reference frame has Daniel's forearm and lantern filling the lower-left for
     * exactly this reason: the held object parallaxes against the world, lags the
     * turn and swings on the footfall, and *that* is what proves a body is carrying
     * the camera.
     *
     * The whole rig is driven off signals `player.ts` already computes — stridePhase,
     * gait, effort, sprintAmount, the nod spring, and yaw velocity. Nothing here
     * introduces a second clock; that mistake is documented at the top of player.ts
     * and cost a whole rebuild.
     */
    viewmodel: {
      /**
       * Rest pose in view space, metres. Right-handed: +x right, +y up, -z forward.
       *
       * DERIVED, not dialled in by eye. At the 74 degree vertical FOV this game
       * uses, a plane at z = -0.46 spans +/-0.347m vertically and, at 16:9,
       * +/-0.617m horizontally. So these numbers are directly readable as a
       * fraction of the frame, and the first attempt was measurably wrong: restY
       * -0.32 is 92% of the way to the bottom edge, which put the whole rig off
       * frame except for a sliver of lens. Bottom-right luminance during a walk
       * measured 12.8 against a beam pool of 182 — the torch was contributing
       * essentially nothing.
       *
       * These place the torch head at about 26% from the left and 72% down, which
       * is where Amnesia's reference screenshot puts the lantern. Left-hand side
       * for the same reason Amnesia uses it: the beam's own pool sits at frame
       * centre-right when you walk a corridor, so a left-side torch is read against
       * darkness instead of being washed out by its own light.
       *
       * 0.46m of depth clears the 0.05m near plane by an order of magnitude, so no
       * amount of swing can clip the torch through the frustum.
       */
      restX: -0.30,
      /**
       * -0.265, down from -0.175. Direct user note: "make it closer to the bottom
       * of the screen so it doesn't look floating."
       *
       * At this FOV a plane at z = -0.46 spans +/-0.347m vertically, so -0.265 puts
       * the torch's axis 76% of the way to the bottom edge and the barrel's lower
       * half is cropped off frame. That crop is the entire point: an object whose
       * bottom is cut by the frame edge reads as entering from below — i.e. held —
       * whereas one fully inside the frame with nothing attaching it to the player
       * reads as hovering. The hand that used to supply that attachment has been
       * removed (see player.ts), so the frame edge does its job instead.
       */
      restY: -0.265,
      restZ: -0.46,

      /**
       * Bob, as a FRACTION of the camera's own bob, and inverted.
       *
       * Both numbers matter and both are counter-intuitive. The viewmodel is
       * parented to the camera, so it already inherits 100% of the camera's bob for
       * free — a child at a fixed local offset is welded to the eye and reads as
       * painted on the lens, which is worse than no viewmodel at all. What creates
       * the parallax is the DIFFERENCE between the hand's motion and the head's.
       *
       * Sign is negative because an arm hanging off a shoulder lags the torso: when
       * the head is at the bottom of its dip the hand is still travelling down. In
       * view space that difference reads as the torch rising as the head falls.
       * Magnitude is 0.5 so the hand's world-space swing is half the head's, which
       * is roughly the ratio a loosely-held object shows against the skull.
       */
      bobFollow: -0.5,
      /** Lateral swing as a fraction of the camera's lateral bob, same inversion. */
      swayFollow: -0.62,

      /**
       * Rotational lag on yaw. The beam is heavy and the wrist is late.
       *
       * `yawLagGain` is radians of counter-yaw per rad/s of turn rate, so a fast
       * 3 rad/s flick trails the torch by ~0.26 rad (15 deg) before it catches up.
       * `yawLagSmoothing` is how fast the lag itself follows the turn rate — low
       * enough that whipping the mouse produces a visible swing-and-settle rather
       * than an instantaneous offset.
       *
       * `pitchLagGain` does the same for looking up and down, at a smaller gain: a
       * wrist rolls sideways far more freely than it hinges vertically.
       */
      yawLagGain: 0.088,
      pitchLagGain: 0.055,
      yawLagSmoothing: 9,
      /** Hard clamp on the lag, radians. Stops a testhook flick from swinging the torch out of frame. */
      maxLag: 0.38,

      /**
       * Translational lag: the hand slides opposite the turn before catching up.
       * A pure rotation looks like the torch is on a turntable; the slide is what
       * sells an arm attached to a shoulder that is being dragged around a corner.
       */
      yawSlideGain: 0.052,
      pitchSlideGain: 0.030,

      /**
       * Sprint pose. The arm comes IN and DOWN and swings wider — a running person
       * tucks the elbow and pumps, they do not hold a torch out at arm's length.
       * These are deltas applied at full `sprintAmount`.
       *
       * `sprintPullIn` is POSITIVE because this is the left hand: "in" means toward
       * frame centre, which is +x from a rest pose at x = -0.30. Flipping the hand
       * without flipping this sign would push the torch further out of frame under
       * sprint, i.e. exactly backwards.
       */
      sprintPullIn: 0.052,
      sprintDrop: -0.062,
      /**
       * Radians of muzzle-down tilt at full sprint. 0.19 measured out at 11.8 deg of
       * mean tilt, enough to aim the visible torch at the floor while the beam —
       * which game.ts aims off the CAMERA, not off this mesh — keeps pointing level.
       * That divergence is the one thing that would make the torch and its own light
       * read as unrelated objects, which is precisely the failure this rig exists to
       * fix. 0.115 is ~7 deg: a running arm's tuck, clearly readable, and not enough
       * to break the alignment.
       */
      sprintTiltDown: 0.115,
      /** Multiplier on bob and sway amplitude at full sprint. */
      sprintSwingBoost: 1.55,

      /**
       * Foot-plant jolt. The nod spring in player.ts is a velocity impulse fired on
       * every plant; the torch borrows it, which is what makes the beam kick on the
       * footfall without a second timer that could drift out of sync.
       *
       * `nodToLift` is metres of torch rise per metre of head dip — over 1.0 because
       * the arm is a longer lever than the neck, so a plant that drops the head 9mm
       * throws the torch 12mm. `nodToTilt` turns that into muzzle rotation, which is
       * what actually moves the light pool on the wall and is therefore the part a
       * player perceives.
       */
      nodToLift: -1.35,
      nodToTilt: -2.4,

      /**
       * Idle breathing on the hand, radians and metres. Slower and smaller than the
       * camera's breath so the two never trace the same curve and produce a beat.
       */
      breathTilt: 0.015,
      breathLift: 0.007,
      /**
       * Lateral drift while standing. Without it the idle torch moves on exactly one
       * axis, which is a tripod rather than an arm — measured on the first build,
       * 4.7mm vertical and 0.0mm lateral. Smaller than the lift because a held arm
       * is braced sideways by the body and free vertically.
       */
      breathDrift: 0.0045,

      /**
       * Materials. Three surfaces and no more, matching the palette rule in
       * GAME-SPEC §6a: a dark rubberised barrel, a dull metal bezel, and a glove.
       * Nothing here may be brighter than the wall the beam is on, or the eye
       * anchors on the torch instead of on the corridor.
       */
      bodyColor: 0x14161a,
      /**
       * Dull metal. Deliberately the lightest surface on the rig, but only just: at
       * 0x4a4f56 the cuff read as near-white against a black corridor and pulled the
       * eye off the beam, which is the one thing the palette rule forbids. It has to
       * be legible as "not the glove" and no more than that.
       */
      bezelColor: 0x33373d,
      gloveColor: 0x211d19,
      /**
       * The emitter disc. This is NOT a light source — it is the lens, lit from
       * behind by the bulb, and it is the single brightest pixel the player ever
       * owns. It must read as "the thing my beam comes out of" the instant it is
       * seen. Kept small so it never competes with the pool on the wall.
       */
      emitterColor: 0xffdca8,

      /**
       * The viewmodel's own lighting rig, in the shader.
       *
       * The world SpotLight cannot light this object: it sits 0.46m from a 160
       * candela source with decay 1.75, which resolves to ~660 candela of incident
       * light — a white silhouette. Worse, at 0.46m it is inside the shadow camera's
       * 0.2m near plane, so it would stamp its own shadow across the entire corridor
       * ahead. It is excluded from shadows and shaded by a viewmodel-local rig
       * instead, which is what every first-person game does and the only way to get
       * a held object that reads correctly against its own beam.
       *
       * `keyDir` is in view space and points from the surface toward the key light:
       * up-and-left, i.e. spill bouncing back off the corridor wall the beam is
       * hitting. `spillGain` couples the key's strength to the live flashlight
       * flicker so the torch body stutters in step with its own beam.
       */
      /**
       * Key direction in view space, pointing FROM the surface TOWARD the light.
       *
       * Up-and-right and only slightly toward the camera. Getting this wrong was the
       * third measurable regression on this rig: a key at (0.34, 0.30, 0.90) is
       * aimed almost straight down the view axis, which is the definition of flat
       * lighting — every surface facing the player gets the same full key and the
       * whole rig loses its form. A raking key puts the terminator across the middle
       * of the barrel, so the cylinder has a lit side and a dark side and reads as
       * round.
       *
       * Up-and-right is also the physically right answer: the light on your hand is
       * the beam bouncing back off the wall the pool is on, which is ahead and — for
       * a left-hand torch aimed slightly inward — to the right of the torch body.
       */
      keyDir: [0.78, 0.52, 0.35] as [number, number, number],
      /**
       * Key strength, and how much of it wraps around the terminator.
       *
       * `keyWrap` 0 is pure Lambert, 1 is full half-Lambert. The first build used
       * full half-Lambert squared and it was measurably wrong: the torch region's
       * luminance histogram came back as a smear from 16 to 64 with no separation
       * between the near-black barrel, the mid-grey bezel and the brown glove, and
       * the whole rig read in the frame as one pale featureless blob. Wrapping
       * exists to stop a single-light object going solid black on its dark side; at
       * 0.35 it does that and no more, and the terminator stays where a cylinder's
       * terminator belongs, which is what makes the barrel read as round.
       */
      keyIntensity: 1.15,
      keyWrap: 0.35,
      fillIntensity: 0.11,
      /**
       * Bounce from below. The floor is the nearest lit surface to a torch held at
       * hip height, and without an up-facing term the underside of the forearm is
       * dead black and the arm loses its bottom edge entirely.
       */
      bounceColor: 0x3a2a20,
      bounceIntensity: 0.30,
      /** Rim term. A cold edge from the red sky above, which is the only other light. */
      rimColor: 0x7a2a18,
      rimIntensity: 0.60,
      rimPower: 3.0,
      /** How much the shading tracks the flashlight's flicker. 1 = fully. */
      spillGain: 0.85,

      /**
       * Exposure compensation. THIS IS THE NUMBER THAT MADE THE TORCH VISIBLE.
       *
       * The renderer runs ACES filmic tone mapping at exposure 0.15 — a very low
       * value, chosen because the flashlight is 160 candela and anything higher
       * blows the corridor out. Everything the world draws is scaled by 0.15 before
       * tone mapping, and the world's own values are physical-unit radiances in the
       * tens, so it lands in range.
       *
       * The viewmodel shader is NOT physically lit. Its output is a plain 0..1
       * reflectance, so 0.15 exposure crushed it to nothing: a 0x191b1f barrel is
       * 0.098 linear, times a 1.05 key, times 0.15, is 0.015 — black. Measured on
       * the first build, bottom-right frame luminance during a walk was 12.8 against
       * a beam pool of 182, i.e. the torch was contributing nothing at all and the
       * critic's "no viewmodel" verdict would have stood unchanged.
       *
       * 1/0.15 = 6.67 would exactly undo the exposure and produce a torch lit as if
       * it were a fully lit surface — which is far too much, and the second build
       * proved it: at 5.6 the torch region's luminance histogram was a smear from 16
       * to 64 with no material separation at all, and in the frame it read as a pale
       * plastic blob rather than a dark torch in a gloved fist.
       *
       * 3.1 is a little under half of full compensation. You are looking at the
       * *back* of your own light source, so the torch should sit meaningfully darker
       * than the wall the beam is on — present and readable, never competing with
       * the pool for the eye. The wall pool measures ~180-210; the torch body should
       * land in the 30-90 band, which is where a real object lit only by its own
       * backscatter sits.
       */
      exposureCompensation: 3.1,

      /**
       * Radial segments on the barrel. 14 reads as round at 0.46m under this
       * lighting and costs ~380 triangles for the whole rig, which is nothing —
       * but the harness renders on SwiftShader and every triangle here is drawn at
       * near-fullscreen depth complexity, so there is no reason to spend more.
       */
      segments: 14,
    },
  },

  flashlight: {
    /** Infinite by user decree. No battery, no oil, no meter. Do not add one. */
    infinite: true,
    /**
     * Candela. three.js has used physical light units since r155, so this is not
     * the 0-to-1 dial it looks like — a value under ~10 renders a black screen.
     *
     * ---- the beam is FLATTER now (160/1.75 -> 91/1.40), and the pair is one
     * ---- change: neither number may be moved without the other ---------------
     *
     * This is the fix for "the torch core clips to pure white", and the reason it
     * took several rounds to find is that THE CORE WAS NEVER CLIPPING. Measured on
     * the shipped build at the near-wall stations that contain the blowout:
     * `clip%` (pixels >= 253) is EXACTLY 0.000 and the frame maximum is 248.8.
     * Every previous round looked for a hard 255, correctly found none, and
     * concluded the roll-off was working. It is. The failure is a SOFT clip.
     *
     * Modelling the real grade chain end to end, display codes delivered per
     * DOUBLING of scene-linear light:
     *
     *   scene-linear   display   codes per doubling
     *      0.5 -> 1     204->224        20.1
     *      1   -> 2     224->235        10.4
     *      4   -> 8     240->243         2.9
     *     32   -> 64    245.8->246.3     0.59
     *    128   -> 256   246.7->246.9     0.23
     *
     * A 160 cd torch puts ~160 scene-linear on a wall at 1 m. Above linear 4 the
     * curve hands back under 3 codes per doubling, so a 64x range of real light
     * lands inside ~4 display codes. Measured on the frames, mortar-joint contrast
     * (local range in a 9 px window) by brightness band:
     *
     *   band (display)      midFreq   local range
     *   inner  140-200        26.7        15.0
     *   bright 200-240        13.8         4.9
     *   CORE   240-256         5.4         1.34
     *
     * Texture is not dimmed in the core, it is DELETED — 15 display codes of
     * mortar contrast become 1.3. That is the world lane's masonry being erased in
     * exactly the region the player is looking at.
     *
     * ---- why the fix is the LIGHT and not the curve -------------------------
     *
     * Every tone-curve candidate was measured and every one made it worse or was
     * merely cosmetic, because the curve cannot un-compress a 14-stop input:
     *
     *   config                        4->8 codes   32->64   display@160
     *   SHIPPED (sh .22, roll .72)        2.90       0.59       246.8
     *   roll-off OFF (hard clip)          0.00       0.00       255.0
     *   shoulder .22 -> .30               1.46       0.21       247.2
     *   shoulder .22 -> .40               0.64       0.05       247.3
     *   roll start .72 -> .86             2.30       0.31       253.1
     *
     * Raising the shoulder REDUCES codes per doubling, because a steeper tanh
     * saturates sooner — the opposite of the intuition, and the trap that would
     * have been walked into by tuning the curve alone.
     *
     * ---- why decay goes DOWN, which is also the opposite of the intuition ----
     *
     * The instinct is to raise decay so near walls dim. That is exactly backwards.
     * Spotlight falloff is I/d^decay, so the near/far ratio is what decay controls:
     *
     *   decay   L(1m)/L(8m)
     *    1.50       22.6
     *    1.75       38.1   <- was
     *    2.00       64.0
     *
     * Raising decay makes the near core RELATIVELY hotter than the far corridor,
     * so it blows the core out further while draining the corridor to black.
     * Measured: decay 2.0 at I=60 cut pooled midFreqStd from 20.2 to 16.0 by
     * killing the mid-range detail this lane needs.
     *
     * LOWERING decay flattens the beam. Solving for the intensity that holds the
     * light at 5 m EXACTLY constant, so the corridor is untouched:
     *
     *   I     decay    L(1m)    L(3m)   L(5m)   L(8m)   L(12m)   L1/L5
     *   160   1.75     160.0    23.40    9.57    4.20     2.07    16.7
     *    91   1.40      91.1    19.57    9.57    4.96     2.81     9.5
     *
     * The core at 1 m falls 160 -> 91 (out of the dead 0.23-codes-per-doubling
     * region) while 8 m and 12 m get slightly BRIGHTER, so the beam reaches
     * further into the corridor and finds more architecture. Both effects help.
     *
     * Verified on the real beat path, live via __BEAM_TUNE__ (which pins through
     * updateFlashlight's per-frame write — setting `.intensity` directly is
     * silently discarded, and a first sweep that did so reported the light inert).
     * Pooled over seeds, this beam beat the old one on midFreqStd at EVERY beat,
     * and blown-core area fell ~3-30x depending on the station.
     *
     * Do not "restore" 160/1.75 to buy brightness. Brightness comes from
     * CFG.render.exposure, which is paired with the toe for exactly that reason;
     * this pair controls the SHAPE of the beam, not its level.
     */
    intensity: 91,
    decay: 1.40,
    distance: 30,
    angle: 0.44,
    penumbra: 0.6,
    /**
     * ---- NEAR-FIELD FLOOR: the fix for the textureless white blob ------------
     *
     * The defect this solves, measured rather than asserted. A critic captured a
     * near-wall frame and found 71-79% of all LIT pixels sitting above lum 200 —
     * a blown core — carrying midStd 9.5. Real Amnesia holds 0.0-9.8% of its lit
     * pixels there, and the texture INSIDE its core measures 19.8-24.6. Four of
     * every five lit pixels in our frame carried zero information.
     *
     * The cause is a pure dynamic-range problem, not a level problem. Inverse
     * power falloff at decay 1.40 gives
     *
     *     L(0.8 m) / L(8 m) = (8/0.8)^1.40 = 25.1x
     *
     * and the maze uses 4 m cells, so a faced wall sits ~2 m away. That is the
     * COMMON case, not an edge case. Feeding a 25x near:far ratio into any
     * asymptotic curve puts the whole near field past the shoulder together:
     * measured through this exact tone curve, 0.5 m -> 3 m spanned sRGB 246 down
     * to 224. TWENTY-TWO code values for the entire near field.
     *
     * The number that actually decides whether masonry reads is the contrast
     * between mortar (albedo ~0.12) and stone face (~0.30) at the same distance:
     *
     *   distance                    0.8m   1m   2m   3m   4m   6m   8m
     *   before (no floor)              6    6   10   13   15   20   23
     *   with this floor               26   27   29   32   35   49   64
     *
     * At 0.8 m the wall in front of you had SIX code values separating mortar
     * from stone. That is the white blob, stated numerically.
     *
     * ---- why the floor is SOFT, and not max(d, R) ---------------------------
     *
     * The obvious form is `max(d, R)^decay`, and it is wrong. A hard max clamps
     * everything inside R to one constant, so the near field goes perfectly FLAT
     * — measured spread 0.5 m -> 3 m of exactly 0 sRGB values, and mortar/stone
     * contrast only reaching 12. It trades a blown core for a flat core; the
     * pixels stop being white but they still carry no depth gradient.
     *
     * Instead the distance is softened toward the floor:
     *
     *     d_eff = (d^n + R^n)^(1/n)
     *
     * which is asymptotically d for d >> R (the far corridor is untouched, to
     * well under one code value past ~6 m), tends to R as d -> 0 so the near
     * field can never run away, and is smooth and strictly monotonic everywhere
     * in between — so a nearer surface is still genuinely brighter than a farther
     * one and the beam keeps its sense of depth. n = 2 is the softest knee that
     * still holds the 8 m reading; larger n walks back toward the hard clamp.
     *
     * This is the same construction as the softening radius in a physically-based
     * area/sphere light, where it has a physical reading: a torch bulb is not a
     * point, and irradiance from a source of finite size stops obeying inverse
     * power once you are close enough to it. R is effectively the emitter radius.
     *
     * DO NOT "fix" the blown core by lowering exposure or steepening the toe
     * instead. That pairing caused two documented oscillations of this metric and
     * cannot work here: exposure slides the whole histogram along the log axis,
     * so it moves the near field and the far corridor TOGETHER and the 25x input
     * ratio survives untouched. The core stays flat and the corridor goes black.
     * The ratio has to be fixed at the light, which is what this does.
     *
     * Applied by overriding three's `getDistanceAttenuation` ShaderChunk in
     * game.ts — see installNearFieldFloor(). It is done at the chunk level, not
     * per-material, so every lit surface agrees about the beam.
     */
    nearFloor: 2.5,
    /** Knee sharpness for the soft floor. 2 = smooth; higher tends to max(d,R). */
    nearFloorPower: 2,
    /**
     * The beam's hot core measured 0.31 saturation against Amnesia's 0.064 while
     * every other brightness band already matched, so this is a chroma fix, not a
     * brightness one. Measured on the two candidates:
     *
     *   0xffe6c4 (was)  sRGB sat 0.231   linear sat 0.448   R/B 1.812
     *   0xfff2e2 (now)  sRGB sat 0.114   linear sat 0.239   R/B 1.315
     *
     * Read the *linear* figure, not the hex swatch: the sRGB->linear transfer is a
     * ~2.4 power that stretches the channel gaps, so this light is about twice as
     * chromatic in the space the renderer actually works in as a colour picker
     * suggests. Same trap already found and fixed for fogColor/ambientColor/hemiSky.
     *
     * Halving saturation while keeping R/B comfortably above 1 is the Amnesia split:
     * the core goes white, the falloff stays warm. Note this reads as a larger
     * change than it would have last round, because the wall/trim/floor roughness
     * has come off the Lambertian rail (0.96/0.99/1.00 -> 0.62/0.68/0.72) and those
     * surfaces now have a real specular response carrying the light's colour
     * directly. 0xfff0dc is the fallback if a critic judges the core too clinical.
     */
    color: 0xfff2e2,
    /**
     * Exponential follow rate, per second, for the beam chasing the camera.
     * Lower = more lag = more handheld. Consumed in game.ts as
     * `lerp(target, min(1, followLag * dt))` for the lamp body, and at 0.75x that
     * for the aim point — so the beam's *direction* trails its *position*, which is
     * what a torch does when the wrist rotates after the arm has already moved.
     *
     * Dropped from 11 to 8.5 once the head bob became a real gait. The flashlight
     * follows the camera's world position, so it now inherits the walk cycle for
     * free; the lag is what turns that inheritance into a beam swinging in a hand
     * rather than a beam bolted to the skull. At 11 the bob passed straight through
     * and read as camera shake.
     *
     * Do not push below about 6. The beam then lags far enough behind a fast turn
     * that you round a corner into unlit corridor, which is frustrating rather than
     * frightening, and it starts to fight the brief's "rock steady during a chase".
     */
    followLag: 8.5,
    flicker: {
      /** Monster within this distance starts the stutter. */
      startDistance: 18,
      /** Full-panic flicker at this distance. */
      panicDistance: 6,
      /** During an active chase the beam goes steady — flicker then is annoying, not scary. */
      steadyDuringChase: true,
    },
  },

  monster: {
    /**
     * How tall Billy stands, in metres, and where his feet go.
     *
     * MEASURED, not guessed: billy.glb's armature carries a cm->m scale of 0.01
     * while its mesh is already authored in metre-ish units, so the loaded model's
     * world bounding box comes out 0.16 x 0.87 x 1.00 m spanning y = -0.456 to
     * +0.410. Two things were wrong with that in the scene:
     *
     *   1. He is centred on the origin, and Monster.group sits at y = 0, so 52% of
     *      him was BELOW the floor.
     *   2. The visible half topped out at 0.41 m — knee height. The player's eye is
     *      at 1.68 m aiming a 0.44 rad cone forward, which passes clean over a
     *      0.41 m object. He was in the room, chasing, catching and killing, and
     *      literally never visible. The AI worked, so nothing errored.
     *
     * Monster.load() measures the loaded model's real bounding box and rescales it
     * to `targetHeight`, then lifts it so its lowest point rests on y = 0. Because
     * the box is measured rather than hard-coded, re-exporting the GLB with
     * different proportions self-corrects instead of silently re-sinking him.
     *
     * 2.15m, raised from 1.45m on direct user feedback ("the monster is still
     * small") after seeing him in play at the correct 1.36m.
     *
     * The scaling was never broken — the earlier 1.45m target was measured and hit.
     * The problem is that it was the wrong target for this space. The corridors are
     * 4m wide with 6.5m walls, which is cathedral scale; against that, a
     * child-height figure at 8m reads as a doll rather than a threat. Relative
     * presence is what matters, and 1.45/6.5 = 0.22 of wall height simply is not
     * enough of the frame.
     *
     * Raising him instead of shrinking the walls, because tall walls are an explicit
     * requirement from the brief and the red sky is only visible because of them.
     *
     * 2.15m also now reads TALLER than the 1.68m eye line rather than shorter, so
     * you look UP at what is hunting you. That inverts the earlier reasoning here,
     * and it is better: the game's own menu already promises "He was small when you
     * took him. He is not small here." He should not be a child's height. He is what
     * the spell made, and it was not making a child.
     *
     * RAISED AGAIN to 2.55m — direct user instruction: "he should be way taller
     * than me, like 1.5 times my height". The player's eye sits at 1.68m, so 1.5x
     * is ~2.52m.
     *
     * Third value here (1.45 -> 2.15 -> 2.55) and the trajectory is the lesson:
     * every revision came from someone watching him in play, and every one went up.
     * A figure reads by its share of the frame, not by its metre count, and a 4m
     * corridor under 6.5m walls swallows anything human-sized.
     */
    targetHeight: 2.55,

    /**
     * Correction from BIND-POSE height to ANIMATED height.
     *
     * `Monster.load()` has to measure him before the mixer has ever run, so what
     * it measures is the rest pose — legs straight, spine straight, standing at
     * full stretch. Nothing the player ever sees is in that pose: a run cycle
     * holds the knees bent and the body compressed for the entire stride, so the
     * animated crown sits meaningfully lower than the bind pose it was scaled
     * from. Scaling the rest pose to 1.45 m ships a monster who never gets there.
     *
     * MEASURED IN THE SHIPPING BUILD, not guessed, and re-measured after the
     * value below was found to be over-correcting (tools/kx-height.mjs, 67
     * samples split by clip, against a static production bundle):
     *
     *   poseCompensation 1.1665  ->  walk crown 1.5027 m median (n=48)
     *                            ->  run  crown 1.5214 m median (n=19)
     *
     * Both numbers were confirmed a second, independent way in the same run: a
     * 6.5 m wall column projected at HIS depth gives a pixel ratio that puts walk
     * at 1.5030 m — agreeing with the metric figure to 0.3 mm, and immune to a
     * wrong FOV or camera height because perspective divides out. The 6.5 m wall
     * is itself read off the running scene (tallest non-skinned meshes measure
     * minY 0, maxY 6.5), not taken from config.
     *
     * So 1.1665 shipped him at 1.50 m against a 1.45 m target — 4% OVER, and only
     * ~10 cm below the 1.68 m eye line instead of the clearly-shorter child the
     * fiction asks for. That value had been calibrated against an earlier probe
     * which measured a 1.243 m walking crown; whatever it was measuring, this
     * build does not reproduce it, and keeping the number meant double-counting a
     * correction the rest pose no longer needed.
     *
     *   1.1665 x 1.45 / 1.5027 = 1.1256
     *
     * which predicts walk 1.450 m and run 1.468 m. The run sitting slightly HIGHER
     * than the walk is expected and not a bug: the chase applies a predator lean,
     * and a leaning body's crown traces a longer arc through the stride, so the
     * per-frame maximum comes out a little above the upright walk.
     *
     * Kept as a separate number rather than folded into `targetHeight` so that
     * `targetHeight` keeps meaning what it says — how tall he stands, in metres —
     * and so re-exporting the GLB with a different rest pose is a one-number fix
     * against a re-measurement rather than a silent drift.
     */
    poseCompensation: 1.1256,

    /**
     * Surface response. billy.glb ships NO metallicFactor/roughnessFactor, and
     * glTF defaults both to 1.0 — fully metallic, which in three's PBR means no
     * diffuse term at all. With no environment map (this is a black maze, on
     * purpose) he rendered as a black silhouette in a bright beam.
     *
     * He is refrigerated flesh and wet cord, not chrome: a dielectric, with
     * enough gloss that the cords catch a highlight on top and fall dark in the
     * gaps between strands, which is what makes the body read as woven.
     */
    metalness: 0.0,
    roughness: 0.62,

    walkSpeed: 1.75,
    /**
     * THE CHASE SPEED PROFILE. Read this before touching any number in it.
     *
     * The old value was a single flat `chaseSpeed: 5.8` against a 5.0 player
     * sprint. That is a permanent 0.8 m/s closing rate, and an analytic solve of
     * it says the chase is not a contest but a countdown: a PERFECT player who
     * breaks line of sight on frame one and never gives it back is still run down
     * from 4 m in 3.1 s, from 8 m in 8.1 s, from 12 m in 13.1 s and from 16 m in
     * 20.6 s. Escape was only ever possible if the chase *began* beyond
     * `loseDistance`, which by definition it never does. My own escape harness
     * showed the same thing from the other end: 25% of "escapes" were not escapes
     * at all, they were `maxChaseSeconds` expiring while he stood on the player,
     * and the median closest approach during a chase was 5.2 m with a p10 of 3.4 m
     * against a 1.5 m kill radius.
     *
     * Amnesia is explicit on this, and it is the reference the whole build is
     * graded against: the Servant Grunt is NOT faster than the player, gives chase
     * "starting off slow, but building momentum", and "gets confused fairly easily
     * and thrown off the chase". Only the rare Brute is "slightly faster" and
     * "will eventually outrun you". We shipped the Brute as the only enemy in the
     * game, permanently, with no Grunt.
     *
     * So the flat number becomes a profile with three parts:
     *
     *   `chaseLungeSpeed`  — what he hits during the opening burst. ABOVE your
     *      sprint, because the first seconds of being spotted must feel like being
     *      run down, and because a player who reacts late should be punished.
     *   `chaseSpeed`       — what he settles to. BELOW your 5.0 sprint, so a player
     *      who is actually running gains ~0.35 m/s. That is deliberately a small
     *      margin: it is not enough to simply outrun him in a straight line (you
     *      gain a metre every three seconds), but it means a player who uses the
     *      braid loops to break sight is genuinely getting away rather than being
     *      slowly reeled in on a timer.
     *   `chaseLungeSeconds`/`chaseRampSeconds` — how long the burst lasts and how
     *      long he takes to decay to the settle speed. The ramp also runs at the
     *      START of a chase from his walk speed, which is the "starts off slow,
     *      but builds momentum" the reference describes and which the old hard
     *      branch at monster.ts (walk 1.75 -> 5.8 on a single frame) did not have.
     *
     * The lunge is re-armed whenever he re-acquires sight after losing it, so
     * rounding a corner into him is still lethal. It does not re-arm while he is
     * merely hearing you — otherwise the burst never ends and this is just 6.4 flat.
     */
    chaseSpeed: 4.65,
    chaseLungeSpeed: 6.4,
    /** Seconds the opening burst holds at full lunge speed before it decays. */
    chaseLungeSeconds: 2.2,
    /**
     * Seconds to accelerate into the lunge from a standstill, and to decay from
     * the lunge down to the settle speed. One number for both because they are the
     * same physical thing — how quickly this body can change pace.
     */
    chaseRampSeconds: 1.5,
    /**
     * The retargeted FNAF run is baked at 2x; this is the extra playback trim.
     *
     * LEAVE THIS AT 1. Two readers have now nearly "fixed" the spec's "play the
     * run at 2x speed" by doubling it here, which would run an already-doubled
     * clip at 4x. The doubling lives in the asset pipeline and was measured:
     * the clip is exactly 0.833 s.
     */
    runTimeScale: 1.0,

    /**
     * The predator posture layer — the answer to "was the animation just a normal
     * person running?"
     *
     * It was, and the reason is not a bug: the state->clip mapping was measured
     * correct during a live chase (`{"state":"chase","current":"run","w":1}`) and
     * the retarget is faithful (0.833 s = exactly 2x, mean joint deviation
     * 40.5 deg, loop closure 0.00 deg). A faithful retarget of a human run reads
     * as a human run. So the fix is additive presentation on top of the clip, in
     * `Monster.applyPredatorPosture`, and these are its numbers.
     *
     * The design rule behind every value: the player must not be able to say what
     * is wrong with how he moves, only that something is. Anything large enough
     * to identify — a visibly flailing arm, a 45 deg stoop — stops being uncanny
     * and starts being a broken rig, which GAME-SPEC §6a warns is exactly how a
     * genuine skinning failure looked when it shipped once.
     *
     * All angles are radians and all are ADDED to the clip's own rotation.
     */
    posture: {
      enabled: true,
      /**
       * Total forward pitch of the torso, spread 45/35/20 down Spine/1/2 so the
       * back curves rather than hinging at one joint. ~20 deg: enough that his
       * shoulders lead his hips and he reads as falling at you, short of the
       * hunched-goblin silhouette that would fight the child proportions.
       */
      spinePitch: 0.72,
      /**
       * How much of the spine pitch the head recovers, as a FRACTION (0-1).
       *
       * This replaces the old absolute `headCounter: 0.20`, which was measured
       * doing real damage: against a 0.35 spinePitch it cancelled so much of the
       * lean that the rendered top half of the silhouette measured vertical, and
       * the whole point of the pitch — "falling at you, not jogging" — never
       * reached the screen. A full-stride probe of world-space bones put the whole
       * Hips->Neck chain at 15.7 deg mean lean, which is ordinary for a human
       * sprinter and is precisely why it read as a man running.
       *
       * At 0.55 the face still comes up far enough to read (item 2's facing fix
       * survives) but he leads with the crown of his head and looks at you from
       * under his own brow, which is the posture the brief asks for.
       */
      headRecover: 0.55,
      /**
       * A constant off-axis tilt of the head, in radians (~7 deg).
       *
       * A body running at you keeps its head square to its direction of travel.
       * A head held permanently canted, that does not correct as the body turns,
       * is the "head that does not track with the body" cue — the cheapest single
       * thing that separates an Amnesia monster from a person in a costume, and it
       * costs one bone write.
       */
      headTilt: 0.12,
      /**
       * ---- stride asymmetry: the terms that actually answer the brief ---------
       *
       * All of these are PHASE-LOCKED to the run clip rather than free-running.
       * The previous layer deliberately avoided the stride period on the theory
       * that a drift unrelated to the gait would read as wrong. Measurement said
       * the opposite: a signal uncorrelated with the stride averages out over the
       * cycle and the eye discards it. The left/right foot antiphase correlation
       * measured -0.912 — a textbook-symmetric human stride — while the two hands
       * measured 0.011, i.e. no readable swing at all. Nothing in the upper body
       * can overrule a perfectly mirrored pair of legs underneath it.
       */
      /**
       * Extra hip swing added on the stride phase, radians.
       *
       * SIZED BY MEASUREMENT, not by taste. The clip's own foot travel is 0.34 m
       * fore-aft, and the hip->foot chain is 0.619 m long, so an added hip
       * rotation of `legDrive` moves the foot by `0.619 * legDrive` metres. At the
       * first attempt's 0.26 rad that is 0.161 m — barely half the clip's own
       * amplitude, so the sum still peaked where the CLIP peaked and the measured
       * left/right foot alignment stayed pinned at exactly 0.5 of a cycle, i.e.
       * textbook human. To move where the foot actually lands, the additive term
       * has to be comparable to the clip's own: 0.62 rad gives 0.384 m, which
       * slightly exceeds it and lets the skew below actually shift the landing.
       */
      legDrive: 0.62,
      /**
       * How much LESS the favoured side does everything. One leg is driven at
       * full `legDrive` and the other at 0.38 of it, so he limps on a repeating
       * stride instead of drifting symmetrically.
       */
      limpBias: 0.38,
      /**
       * Phase offset ADDED to one leg only, as a fraction of the cycle.
       *
       * A human run puts the legs exactly 0.5 apart, and the phase-resolved probe
       * measures precisely that alignment, so this is the number the whole "does
       * it read as inhuman" question turns on. 0.13 was too small to survive being
       * summed with the clip and measured as 0.000 deviation. 0.28 puts the second
       * foot down closer to a third of a cycle after the first than a half — a
       * lurching, uneven rhythm rather than a fast even one — while staying short
       * of the two feet landing together, which would read as hopping.
       */
      strideSkew: 0.28,
      /** Extra knee flex on the swing, rectified so the joint never inverts. */
      kneeSnap: 0.30,
      /** Outward splay of the favoured leg — he runs slightly crabwise. */
      legSplay: 0.17,
      /** Arm swing driven on the stride. The old free-running drift measured flat. */
      armDrive: 0.34,
      /** The trailing arm does 0.3 of that: a limb carried, not driven. */
      armBias: 0.3,
      /** Phase skew of the trailing arm, radians, so it never mirrors the leading one. */
      armSkew: 0.9,
      /** Constant backward hang on the trailing arm. */
      armHang: 0.22,
      /** Static lateral arm offset, opposite signs per side. */
      armDrift: 0.16,
      /** Forearm follows the arm, and the trailing elbow follows much less. */
      foreArmDrift: 0.20,
      /** Shoulder roll on the stride, so the shoulder line is never level. */
      shoulderDrift: 0.14,
      /** Lateral hip hitch — weight lands a little off from the footfall. */
      hipHitch: 0.075,
      /**
       * Pelvis pitched under him, so the dive is whole-body and not just spine.
       *
       * 0.14 -> 0.08, and the reason is a BUG FIX rather than a taste change.
       *
       * This term used to be written as `boneHips.rotation.x += hipPitch`, which
       * on this rig is not a pitch at all. Two compounding rig facts (three's XYZ
       * euler order against a clip that parks the Hips at rotation.y +63..+79 deg,
       * plus the Armature's Blender Z-up->Y-up +90 deg) turned it into an almost
       * pure ROLL. Measured with `tools/lean-probe.html`, averaged over 24 samples
       * of the run cycle so a constant lean separates from an oscillation:
       *
       *   hipPitch alone, old write ... roll -8.50 deg   pitch +3.4 deg
       *   hipPitch alone, fixed ....... roll -0.48 deg   pitch +11.4 deg
       *
       * -8.5 deg of constant roll at the pelvis, inherited by the whole spine
       * above it, IS the user's "he's tilting to his left". `spinePitch` was
       * innocent and is unchanged.
       *
       * `monster.ts` now rotates about the pelvis's real lateral axis, so the
       * term finally does what it is named for — which means its old magnitude
       * now buys far more forward dive than it used to. At 0.14 the whole-body
       * pitch measured 35.0 deg, past the "falling at you" read and into a stoop.
       * 0.08 lands the total at 31.6 deg against the old build's effective
       * 27.1 deg: still deeper than before, because the pelvis is contributing
       * for the first time, without becoming the hunched-goblin silhouette this
       * block warns about.
       *
       * Roll is now flat at +1.65..+1.74 deg for EVERY value of this term, which
       * is the real evidence the fix is structural rather than a cancellation.
       */
      hipPitch: 0.08,
      /**
       * Seconds to blend the posture in when a chase starts and out when it ends.
       * In is fast because the transition to a chase should be a visible change
       * in what he is; out is slow so he uncoils rather than snapping upright.
       */
      easeIn: 0.35,
      easeOut: 0.9,
    },
    /** Cone of vision. Generous angle, but line of sight is hard-blocked by walls. */
    sightRange: 22,
    /**
     * HALF-angle. `perceive()` rejects when `rawAngle >= sightAngle`, so the total
     * cone is twice this.
     *
     * Was `Math.PI * 0.42` — a 75.6 deg half-angle, i.e. a **151 deg** field of
     * view. That is very nearly hemispherical, and the user's report was exactly
     * what it predicts: "he spotted me while walking even though I wasn't in his
     * eyes' direction." He could see almost everything not directly behind him.
     *
     * `Math.PI * 0.30` is 54 deg either side, a 108 deg cone. Still generous —
     * wider than human foveal vision — but it now means something to be out of
     * his line, which is the whole basis of a stealth-adjacent horror game.
     *
     * This interacts with the wrongness layer: `headTilt` deliberately turns his
     * head off the body axis, while the cone is measured from the BODY. The
     * head-yaw drift has been cut for the same reason — if his head is the only
     * cue the player has for where he is looking, it must not lie about it.
     */
    sightAngle: Math.PI * 0.30,
    /** Seconds of continuous sight before PATROL escalates to CHASE. */
    spotTime: 0.45,

    /**
     * ---- PERIPHERAL INATTENTION: the "passes nearby without seeing you" beat ---
     *
     * THE MEASUREMENT THAT FORCED THIS. `tools/mazelab/KX-why.mjs` and
     * `KX-geom.mjs` over 80-120 simulated minutes of the real Monster class:
     *
     *   - 59% of all close passes (within 8 m) escalated into a chase; only 37%
     *     stayed unaware. Chase occupied 25.1% of playtime.
     *   - 58% of chases began during a STALK — the beat whose entire purpose is
     *     to pass close WITHOUT seeing you — at a median 6.5 m straight-line.
     *   - The planner was NOT at fault. 82.2% of cells in the stalk band are
     *     blind to the player, every sampled position had at least one, and he
     *     held a sightline on just 2.6% of stalk frames. He picks blind cells
     *     correctly and walks blind routes correctly.
     *   - **100% of the blindness breaks were the PLAYER walking into his
     *     sightline. 0% were the monster walking into the player's.** (n=62)
     *
     * So this was never a planning bug and no amount of re-planning could fix
     * it: the director cannot pre-empt a player who steps around a corner into a
     * corridor he is already standing in. Re-solving faster only makes him flee
     * sightlines more twitchily; it cannot beat `spotTime` 0.45 s.
     *
     * What was actually missing is PERCEPTUAL, not tactical. `sightAngle` is
     * 0.42*PI — a 76 deg half-cone, 151 deg total — applied at full acuity right
     * out to its edge. That is not vision, it is a proximity sensor with a notch
     * in the back: a monster walking a corridor notices, instantly and with
     * total reliability, anything that appears anywhere in a 151 deg arc out to
     * 22 m. Nothing alive perceives like that, and it is why he could not pass
     * you — physically passing someone within 8 m in a 4 m-cell maze almost
     * always puts them somewhere in that arc for at least 0.45 s.
     *
     * Human foveal vision is ~5 deg; useful acuity for spotting a static,
     * low-contrast object in the dark falls off sharply outside roughly 30 deg.
     * Amnesia's Grunt models this with a documented "notices the player faster
     * the more directly he is looking at them" — attention, not a binary cone.
     *
     * So sight is now graded by where in the cone you are:
     *
     *   inside `focusAngle`  -> full acuity, spotted in `spotTime` (unchanged).
     *   outside it           -> `spotTime` is stretched by up to
     *                           `peripheralSpotScale`, ramped smoothly to the
     *                           cone edge, so he *can* still catch you in the
     *                           corner of his eye but it takes real seconds.
     *
     * MOVEMENT DEFEATS IT, and that is the part that keeps this honest rather
     * than making him blind. Peripheral vision is far better at motion than at
     * detail — so the penalty is scaled down by how fast the player is moving,
     * reaching none at all at `peripheralMotionFull` m/s. Walk past him in the
     * open and he still gets you. Freeze, or move slowly, and his own momentum
     * carries him by. That restores the genre's oldest defence as something the
     * perception system actually implements rather than something the player
     * merely believes.
     *
     * This applies ONLY while he is unaware (patrol). Once he is suspicious,
     * chasing or searching he is actively looking for you, and every one of
     * these penalties is switched off — see `perceive`. Escaping is not made
     * easier; only the un-alerted pass-by is.
     *
     * MEASURED RESULT, same harness, 144 simulated minutes:
     *   unaware passes 0.31/min -> 0.55/min, and their share of close passes
     *   37% -> 66%, while chase share of playtime fell 25.1% -> 14.6%.
     */
    /** Half-angle, radians, of full visual acuity (~26 deg). Inside this he is unimpaired. */
    focusAngle: Math.PI * 0.145,
    /**
     * How much longer `spotTime` takes at the very edge of the cone. 4.4x turns
     * 0.45 s into ~2.0 s of continuous exposure — long enough to walk a corridor
     * past someone standing at the periphery, short enough that lingering in his
     * eyeline is still fatal.
     */
    peripheralSpotScale: 4.4,
    /**
     * Player speed, m/s, at which the peripheral penalty is fully cancelled.
     * 2.2 sits just above the 1.9 walk, so walking openly across his view is
     * caught almost as fast as before and only slow/stationary play is rewarded.
     */
    peripheralMotionFull: 2.2,

    /**
     * ---- GAZE AVERSION: the other half of the pass-by, and the load-bearing half.
     *
     * The peripheral model above was necessary and not sufficient, and the
     * measurement that showed why is worth keeping because it is counter-intuitive.
     *
     * `tools/mazelab/KX-acuity.mjs`: with peripheral inattention live, 88.4% of
     * the frames in which an UNAWARE Billy had sight on the player were at FULL
     * acuity — he was looking straight at them — so the penalty almost never
     * applied and the pass-by numbers barely moved (33% unaware vs 37% before).
     *
     * `tools/mazelab/KX-face.mjs` then measured the FIRST frame of each sighting
     * rather than every frame, and found the opposite: median angle to the player
     * 72.9 deg against a 76 deg cone edge, with only 10% inside the 26 deg focus
     * cone.
     *
     * Both are true, and together they identify the mechanism. He ACQUIRES the
     * player in his extreme periphery, exactly as intended — and then his own
     * `stepToward` turn-to-face-travel rotates him until the player is centred,
     * because the director has just routed him somewhere in the player's
     * neighbourhood. He converts his own glimpse into a stare in a handful of
     * frames, long before the 4.4x peripheral stretch can buy anything.
     *
     * So the evasion had to reach his HEAD. When an unaware sightline opens, the
     * director re-routes (it already did) AND his turn rate is damped for a
     * moment, so he keeps looking where he was going instead of swinging onto
     * someone he has not registered. That is also just what an unaware creature
     * does, which is why it reads as behaviour rather than as a handicap.
     *
     * Perception is NOT suppressed: `sightTimer` accrues the whole time and a
     * player who stays in the cone is still spotted and still chased. And it is
     * cleared in `enterChase`, so a real pursuit turns at the full rate — this
     * cannot make him easier to escape once he knows.
     */
    /**
     * Seconds of "keep looking where you were going" after an unaware glimpse.
     *
     * SWEPT, not chosen (`tools/mazelab/KX-passby.mjs`, 8 seeds x 10 min per
     * point). The response is non-monotonic, which is exactly why it was worth
     * measuring rather than reasoning about — longer is NOT safer:
     *
     *   1.1 s -> 33% of close passes stayed unaware, chase 28.6% of playtime
     *   2.2 s -> 49%                               , chase 20.9%
     *   3.5 s -> 38%                               , chase 25.4%
     *
     * Too short and his own turn-to-travel still centres the player before the
     * window closes. Too long and he holds a blind heading through the player's
     * neighbourhood without ever re-aiming, so he blunders into contact range and
     * takes them at point blank instead of passing by.
     */
    gazeAvertSeconds: 2.2,
    /**
     * Turn-rate multiplier during that window. 0.18 still turns him — a head
     * locked rigidly forward reads as a bug, and he has corners to walk round —
     * but far too slowly to centre a target inside the 0.45 s `spotTime`.
     */
    gazeAvertTurnScale: 0.18,
    /**
     * Hearing. Sprinting is loud; walking is not; standing still is silent.
     *
     * THIS IS WHAT MADE THE NEAR-MISS IMPOSSIBLE, and it took a state-transition
     * trace to see it, because the symptom looked like a director bug. Every single
     * escalation in a 12-minute soak had the identical signature:
     *
     *     patrol->suspicious @ beat=stalk  cells=2  sees=FALSE  m=6.0
     *
     * `m=6.0` every time. That is `hearRadiusWalk` firing at its exact boundary. He
     * was not seeing the player at all — he was hearing a WALKING player through a
     * solid wall at 6 m, going suspicious, pathing to them, and then
     * `investigateCatchOn` (4.5 m) force-escalated to a chase with no line of sight
     * ever established. The stalk band is 2-5 cells, i.e. 8-20 m, so his own stalk
     * plan walked him straight into his own hearing radius. A blind pass was
     * arithmetically impossible for the same class of reason the old stalk could
     * never arrive.
     *
     * Worse, the old radius did not consult the player's motion at all, so a player
     * standing perfectly still was "heard" at 6 m. That is a proximity sensor, not
     * an ear, and it removes the one defence the genre is built on: keeping still
     * and letting the thing walk past.
     *
     * Amnesia's Grunt hears noise — running, doors, thrown objects — and walking
     * quietly past a patrol is the core survival verb. So:
     *
     *   - `hearRadiusSprint` is unchanged at 14 m. Sprinting is loud and SHOULD
     *     give you away through a wall; that is the cost of running.
     *   - `hearRadiusWalk` drops to 3.5 m, inside a single 4 m cell. He notices a
     *     walker who is practically next to him, and not one a corridor away.
     *   - `hearRadiusStill` is 0. Stand still and he cannot hear you at all.
     *
     * player.ts already reports `isSprinting`; `Monster.update` now also takes the
     * player's speed so "moving at all" is a real input rather than an assumption.
     */
    hearRadiusWalk: 3.5,
    hearRadiusSprint: 14,
    /**
     * Below this speed, in m/s, the player makes no noise a monster could follow.
     * Above it they are walking. Sits under `player.walkSpeed` (2.6) but well over
     * the drift a controller produces while decelerating, so releasing W genuinely
     * silences you within a step rather than after a long coast.
     */
    quietSpeed: 0.9,
    /**
     * How fast the give-up timer runs while he can hear you but not see you, as a
     * fraction of real time. Sight resets the timer outright; sound merely slows
     * it. At 0 a chase never ends while you are within earshot, which measured out
     * at 38.9% of all playtime spent in pursuit — dread needs the chase to be an
     * event, not a permanent condition.
     */
    hearingLostDecay: 0.42,
    /**
     * Hard ceiling on a single chase, in seconds.
     *
     * A player who simply keeps sprinting keeps feeding him contact, and without a
     * ceiling the pursuit becomes the steady state — measured at 50.7% of all
     * playtime, which is the opposite of the brief. He gives up into a full search
     * sweep, so the pressure decays instead of switching off.
     */
    maxChaseSeconds: 26,
    /**
     * Seconds after a chase ends during which he will not start another one.
     *
     * Without this the `maxChaseSeconds` ceiling does nothing at all, and a trace
     * showed exactly why. The ceiling fires while he is still standing on top of
     * the player, so the sequence measured was:
     *
     *     chase->search @ m=0.0      (26 s ceiling fires; he is ON the player)
     *     search->chase @ m=0.3      (0.06 s later he sees them and re-chases)
     *
     * — twenty times in twelve minutes, a permanent chase wearing a search's name,
     * and chase share sat at 45.7% of playtime. Giving up has to actually buy the
     * player something or it is not giving up.
     *
     * During the cooldown he still SEARCHES — he sweeps the probes, he is still
     * dangerous, `catchDistance` still kills — he simply cannot re-escalate to a
     * full sprint. This is Amnesia's Grunt losing interest and going back to a
     * patrol while you hold your breath in the dark, and it is the window in which
     * a cornered player gets to actually leave.
     *
     * 8 s at `walkSpeed` 1.75 versus a 5.0 sprint is ~26 m of separation earned,
     * comfortably past `loseDistance`.
     */
    chaseCooldown: 8,
    /** Chase ends when he has had no sight of you for this long... */
    loseSightTime: 4.5,
    /** ...and you are at least this far away. Both must hold. */
    loseDistance: 16,
    /**
     * How long he keeps looking before giving up and handing back to the director.
     *
     * Must be long enough for the probe sweep to actually finish, or the search is
     * cut off mid-stride and reads as him losing interest arbitrarily. Four probes
     * at 1.6s of dwell each is 6.4s of standing still plus the walking between
     * them; at 12s the sweep was truncated and covered only 4.4 distinct cells.
     */
    searchTime: 22,
    /** How close he must get to kill. */
    catchDistance: 1.5,
    /**
     * While investigating a noise, this close counts as noticing you even with no
     * line of sight and you outside the vision cone. Measured in the live build,
     * requiring the cone here left him milling about 5m from a stationary player
     * for 17 seconds before reacting — he arrives facing wherever his path left
     * him, so spotting you was down to the cone sweeping across by luck.
     *
     * Reduced from 4.5 to 2.6 m. At 4.5 m — wider than a 4 m cell — this fired
     * through walls on a player in an entirely different corridor, and combined
     * with the old always-on hearing radius it was the second half of the mechanism
     * that made near-misses impossible: hear a walker at 6 m, path toward them,
     * force-escalate at 4.5 m, never once having seen them. 2.6 m keeps the
     * original intent (he is close enough to hear you breathe and does not need
     * the cone to have swept across you) while requiring he be genuinely on top of
     * you rather than a corridor away.
     */
    investigateCatchOn: 2.6,

    /**
     * Interception. Pathing to where you *were* is why the old chase was a
     * formality: he arrived at an empty corridor every time, so the catch rate sat
     * at ~12% no matter how fast he ran.
     *
     * Straight-line lead was measured and discarded — at a 4m cell and 5 m/s
     * sprint even a 0.9s lead is 1.1 cells, which only nominates a cell in the
     * corridor you are already in and produces a byte-identical route. What works
     * is cutting you off through a different corridor, so he floods this many cells
     * out from your last known position and takes the cell he can reach first.
     */
    interceptHorizonCells: 9,
    /**
     * He must beat you to the intercept by this many seconds. Without a margin he
     * merely arrives with you, which is a tail with extra steps. Raise it and he
     * only takes decisive cutoffs; lower it and he lunges at everything.
     */
    interceptMarginSeconds: 0.55,
    /**
     * How much better a new cutoff must be before he abandons the one he is
     * already running to, in corridor cells closer to the player.
     *
     * This is hysteresis on an argmax that is re-evaluated every 0.35 s. At 0 he
     * switches on exact ties, which is what he used to do: two cells either side
     * of a junction traded places as the player moved a few centimetres, so he
     * was handed the opposite direction ~3x/second and orbited instead of
     * closing (87.3% of chase repaths produced a waypoint >120 deg from the
     * previous one — `tools/mazelab/CH-path.mjs`).
     *
     * 1.5 cells = 6 m. Below ~1 he still chatters at junctions where two routes
     * differ by a single cell; much above 2 and he ignores a genuinely better
     * cutoff that opens up mid-chase. The previous choice is only ever held while
     * it is still eligible, so this damps churn without letting him commit to a
     * plan the chase has moved past.
     */
    interceptSwitchCells: 1.5,
    /** Interception is only honest while he can see you; it decays once he cannot. */
    leadDecayTime: 1.2,

    /**
     * PATROL PAUSES — the Grunt's limp.
     *
     * A critic grepped monster.ts and found no idle or look-around behaviour at
     * all: unaware, he walked a continuous 1.75 m/s line from waypoint to waypoint
     * forever. The Amnesia reference is specific — the Servant Grunt "limps around
     * very slowly, pausing every few steps to look around" — and the pause is not
     * decoration. Three things depend on it:
     *
     *   1. AUDIO. The audio lane drives his footfalls off `isMoving`, so a monster
     *      who never stops produces an unbroken footstep loop. Footsteps that stop
     *      somewhere behind you, and then start again, is the single cheapest
     *      dread beat in the genre, and a continuous walker cannot make it.
     *   2. HE ACTUALLY LOOKS. He turns on the spot during a pause, which sweeps his
     *      vision cone across corridors his path would never have pointed him down.
     *      A player hiding in a side branch he is walking past is currently safe by
     *      accident; with the pause, he may turn and find them.
     *   3. PACING. It costs him time inside the stalk band without costing him
     *      distance, which lengthens a near-miss without making him faster.
     *
     * Pauses are suppressed entirely during chase and search — a searching monster
     * has its own dwell behaviour and a chasing one must never stop.
     */
    patrol: {
      /** Seconds a pause lasts. */
      pauseMin: 1.1,
      pauseMax: 2.6,
      /**
       * Seconds of walking between pauses. At walkSpeed 1.75 this is roughly one
       * pause every 3.5-9 cells, i.e. "every few steps" at maze scale rather than
       * literally every few footfalls, which would read as a limp so severe he
       * never gets anywhere.
       */
      pauseEveryMin: 8,
      pauseEveryMax: 20,
      /**
       * Radians per second he turns while paused. Slow enough to read as looking
       * rather than spinning; over a 1.1-2.6 s pause that is a 60-145 degree sweep.
       */
      lookSpeed: 0.98,
    },

    /**
     * Search. When he loses you he sweeps the branches off your last known
     * position rather than standing on one cell — checking side corridors is the
     * behaviour that makes him read as looking for you rather than as a script
     * that gave up.
     */
    search: {
      /** How many separate spots he checks before losing interest. */
      probes: 4,
      /** Each probe is picked this far (in cells) from the last known position. */
      minProbeCells: 2,
      maxProbeCells: 7,
      /** Seconds spent casting about at each probe before moving to the next. */
      dwell: 1.6,
      /** He moves faster than a patrol while searching — agitated, not calm. */
      speedScale: 1.35,
    },

    /**
     * The director. Amnesia's monsters frighten through absence: long stretches
     * where you only suspect. Left to a pure state machine Billy patrols at random
     * forever, which produces both failure modes at once — he is either glued to
     * the far side of the maze, or permanently underfoot.
     *
     * The director owns his patrol *intent* on a slow cycle, independent of the
     * perception state machine. Perception can always interrupt it (seeing you
     * beats any plan); this only decides where he goes when he has not seen you.
     *
     * THE BUG THIS SHAPE EXISTS TO KILL. The first director gave every beat a
     * fixed duration in seconds while the thing the beat had to accomplish was
     * measured in DISTANCE, and the two never met. `quietMinCells: 16` parked him
     * at least 16 cells out (measured starts of 73, 69, 64, 63, 42 and 41 cells),
     * then handed a stalk 10-18 seconds to arrive. At `walkSpeed` 1.75 m/s across
     * 4 m cells that is 0.44 cells/s — at most 7.9 cells of travel. He was
     * arithmetically incapable of crossing the gap, so the stalk always expired
     * mid-corridor and handed straight back to quiet, which routed him away again.
     * Measured over 30 minutes: 1 of 7 stalks (14%) ever reached the intended 2-5
     * cell band, median closest approach 48.5 m, and 0.1 unaware near-misses per
     * minute — one every ten minutes.
     *
     * So the transit is now CLOSED LOOP and the beats below split into two kinds:
     *
     *   - `approach` is a TRANSIT state with no design duration at all. It ends
     *     when he is actually within `stalkArriveCells`, and its only timer is a
     *     failsafe budgeted from the *measured* corridor distance divided by his
     *     real walking speed (`transitSlack`), so a 70-cell trek gets a 70-cell
     *     budget and a 6-cell one does not get 160 seconds.
     *   - `stalk` is a DWELL state, and its clock starts only on arrival, so its
     *     seconds are spent near the player instead of in transit.
     *
     * Both re-plan against the player's CURRENT cell every `replanInterval`, so
     * the target tracks a moving player rather than a stale snapshot.
     */
    director: {
      /**
       * Seconds of deliberate distance — routed away, into the far half.
       *
       * This is the single most important number in the file for tone. Amnesia's
       * gaps between encounters run into minutes, and the quiet is not dead time:
       * it is the time in which you start to believe you are alone, which is the
       * belief the next approach breaks. At 22-40s the measured share of playtime
       * spent in a chase was 43%, because he was never actually away.
       */
      quietMin: 40,
      quietMax: 70,
      /**
       * Seconds spent loitering near you once an approach has ARRIVED. This is the
       * near-miss itself: he is inside `stalkArriveCells` and wandering blind cells
       * around you, so you get several distinct passes rather than one flyby.
       */
      stalkMin: 16,
      stalkMax: 30,
      /**
       * Stalk targets land this far from you, in cells — close enough to hear.
       *
       * The floor is 2, not 1, and that is a survivability number rather than a
       * taste one. `catchDistance` is 1.5 m and a cell is 4 m, so a stalk target in
       * an ADJACENT cell puts him inside killing range of a player who takes one
       * step the wrong way, while he is still officially unaware. A near-miss you
       * cannot survive is not a near-miss.
       */
      stalkNearCells: 3,
      stalkFarCells: 6,
      /**
       * Corridor distance, in cells, at which an approach counts as ARRIVED and
       * the stalk clock starts. Must sit just outside `stalkFarCells` so arrival
       * and the stalk band agree; if arrival were tighter than the band he would
       * arrive and immediately be re-targeted outward.
       */
      stalkArriveCells: 8,
      /**
       * THE NEAR-MISS IS A PROPERTY OF THE ROUTE, NOT THE DESTINATION.
       *
       * This was the second bug, and it hid behind the first. Once transit actually
       * delivered him (stalk band reach went 14% -> 100%), 6 of 7 close passes
       * immediately became chases and the unaware near-miss rate stayed at 0.05/min
       * while chase share climbed to 43% of playtime. The cause: `sightRange` is
       * 22 m with a 151-degree cone, so the whole 2-5 cell stalk band (8-20 m) sits
       * INSIDE his sight cone. Vetoing line of sight at the moment the target is
       * chosen says nothing about the corridor he walks along to reach it, nor about
       * the player moving during a 16-30 s dwell.
       *
       * So blindness is now enforced continuously, and on the WALK rather than on
       * the destination: every candidate stalk cell is rejected if any sampled cell
       * along the A* route to it would let him NOTICE the player, and if he ends up
       * noticing the player mid-stalk without escalating he is re-routed instead of
       * standing in the open waiting for `spotTime` to elapse.
       *
       * `stalkRouteSamples` caps how many waypoints get the test, so the cost stays
       * bounded no matter how long the route is.
       *
       * ---- CORRECTION: "NOTICE", NOT "SEE". THE VETO IS ASYMMETRIC. ---------
       *
       * As first written, all three of those vetoes tested raw LINE OF SIGHT, and
       * that was a design error serious enough to delete the game's best beat.
       * **Line of sight is symmetric.** A route he cannot be seen from is exactly a
       * route he cannot be seen ON, so vetoing mutual sightlines did not merely
       * stop him spotting the player — it guaranteed the player never spotted him.
       *
       * Measured on the shipped build before the fix, over 80 simulated minutes:
       * 178.5 s of unaware-with-line-of-sight, of which 1.5 s fell inside the
       * camera frustum and **0.0 s inside the flashlight beam.** The unaware
       * near-miss existed only as a telemetry counter and positional audio; there
       * was never anything in the frame. Amnesia does the opposite — the Grunt
       * walks past the closet slats in full view, and "don't look at the monsters"
       * is advice that only means anything because you CAN look.
       *
       * The premise behind the symmetric test — that his facing along a route is
       * unknowable — is false. `stepToward` turns him to face his direction of
       * travel, so his heading at a waypoint IS that route's tangent, and the
       * planner is holding the route. So the veto now rejects a waypoint only when
       * the player would fall inside his facing-dependent vision cone there, which
       * is the condition that actually converts into a chase. A waypoint where he
       * is exposed but looking elsewhere is now ACCEPTED — he crosses the lit
       * junction ahead of you, in the beam, and does not turn his head.
       *
       * Perception is untouched by all of this. `perceive` still spots him a player
       * who stays in his cone, on the same `spotTime`. Only route CHOICE changed.
       */
      stalkRouteSamples: 6,
      /**
       * Radians of slack on the route tangent, which is a PREDICTION of his heading:
       * `stepToward` damps the turn, so on a corner his real facing lags the path by
       * a few degrees and a waypoint cleared on the nose can be entered with the
       * player slightly further inside the cone than planned.
       *
       * It is applied by NARROWING the angle used in the acuity test rather than by
       * widening a cone. That direction matters: the conservative case is him being
       * more face-on than predicted, so the test asks "what if he were `visionMargin`
       * closer to looking at the player than the tangent says", and rejects on that.
       * Widening the cone instead would have been inert — the acuity test already
       * accepts every angle past ~60 deg, so a wider outer edge changes no verdict.
       */
      visionMargin: Math.PI * 0.06,
      /**
       * Seconds a planned waypoint is assumed to hold the player in view, used to
       * turn an acuity into a conversion risk: reject the waypoint when
       * `acuity * waypointExposureSeconds >= spotTime`.
       *
       * Derived, and the derivation has a HARD CEILING that must be respected —
       * getting this wrong silently restores the symmetric bug this whole change
       * exists to remove.
       *
       * The floor of `plannedAcuity` is at the cone edge: `1 / peripheralSpotScale`
       * = 1/4.4 = 0.227. So if `spotTime / waypointExposureSeconds` ever falls to
       * 0.227 or below, the inequality is satisfied at EVERY angle inside the cone
       * and the veto rejects the entire cone again — the pre-fix behaviour, wearing
       * a trigonometric disguise. That bounds exposure below `0.45 / 0.227` = 1.98 s.
       * A first draft of this value used 2.3 s, computed as one cell of travel
       * (`cellSize` 4 m / `walkSpeed` 1.75 = 2.29 s), and it was arithmetically
       * self-defeating for exactly this reason. **Any change here must be checked
       * against that ceiling.**
       *
       * 1.5 s is the defensible figure and it is shorter than a full cell for a
       * real reason: the quantity wanted is not how long he takes to cross a cell,
       * it is how long the SIGHTLINE survives, and a corridor sightline opens and
       * closes across a junction mouth rather than persisting for the whole step.
       *
       * At 1.5 s the veto trips at acuity >= 0.300, which by `peripheralSpotScale`
       * 4.4 lands at ~60 deg off his heading. So the focus cone and its surrounds
       * are still rejected — he will not plan a route that walks him face-first
       * into the player — while the outer periphery from ~60 deg to the 76 deg cone
       * edge becomes permissible. That 16 deg band is precisely the crossing shot:
       * he enters the junction ahead of you with the player far enough off his axis
       * that his own stride carries him out before `spotTime` can fill.
       */
      waypointExposureSeconds: 1.5,
      /**
       * Minimum `sightAcuity` at which an unaware Billy treats a sightline as
       * having NOTICED the player, and so re-routes and averts his gaze.
       *
       * Zero would mean any geometric exposure counts, which is the symmetric bug
       * again — `acuityFor` returns a small positive number right at the edge of
       * his 76 deg cone, and treating the extreme periphery as a stare puts him
       * back to fleeing every corridor the player could ever see him down.
       *
       * 0.5 is where a sighting starts to matter mechanically rather than
       * arbitrarily: `peripheralSpotScale` is 4.4, so acuity 0.5 converts a 0.45 s
       * `spotTime` into ~0.9 s of continuous exposure. Above that he would plausibly
       * be caught inside the beat and should evade; below it his own momentum
       * carries him past before the timer could ever fill.
       */
      noticeAcuity: 0.5,
      /**
       * ---- THE EVASION HAS A FLOOR: HE COMMITS WHEN YOU ARE CLOSE AND SQUARE ---
       *
       * Inside this many metres, an unaware Billy who is looking straight at the
       * player STOPS evading and lets the sighting convert into a chase.
       *
       * THE REPORT THIS FIXES, verbatim from play: *"he runs around in small
       * circles for a while before sometimes deciding to pursue me."* The second
       * half of that sentence is this number, and the measurement is damning.
       * Over 80 simulated minutes of ordinary play, of the 55 unaware-sighting
       * evasion episodes:
       *
       *   - **95% fired at `sightAcuity` 1.00** — the maximum. He was not
       *     glimpsing the player in his periphery, he was looking directly at
       *     them, at the centre of his focus cone.
       *   - **64% fired within 10 m.**
       *   - median distance 8.0 m.
       *
       * So the beat that was designed as "he crosses a lit junction in your
       * peripheral vision and does not notice you" was in practice firing as "he
       * stares straight at you from eight metres and deliberately walks away".
       * From the player's chair that is not a near-miss, it is a monster that is
       * visibly broken — which is exactly what was reported.
       *
       * The pass-by is still protected, because the pass-by is a DISTANT and
       * PERIPHERAL event: beyond this radius, and at the cone edge where acuity is
       * low, every previous veto still applies unchanged. What changes is only the
       * case the evasion was never meant to cover.
       *
       * 11 m is a little under three 4 m cells — inside the `stalkArriveCells`
       * ring, comfortably past `catchDistance`, and beyond `hearRadiusWalk` so it
       * is genuinely a *seeing* rule rather than a second hearing radius. Paired
       * with `commitAcuity` below so it only bites when he is actually looking.
       *
       * ---- A MEASUREMENT THAT LOOKS LIKE A REGRESSION AND IS NOT -------------
       *
       * Do not re-tune this against a STATIONARY player placed on a cell with a
       * clean sightline. That synthetic test reports this fix as a large
       * regression — 31.3% conversion with the commit rule against 65.3% without
       * it, over 150 seeds — and the number is real but it is measuring the wrong
       * thing.
       *
       * The mechanism: without the commit rule an exposed sighting fires the
       * evade branch, which calls `planDirectorPath(force)` and re-runs A* to a
       * NEW random cell. In a probe where the player never moves, that fresh
       * route frequently happens to leave along a heading that swings the player
       * back through his focus cone, so the sighting converts *because he was
       * re-routed*, not because he perceived anything. The old behaviour was
       * scoring conversions off the very target-thrash that reads to a player as
       * running in circles.
       *
       * Measured on ORDINARY PLAY instead (`tools/mazelab/RC-engage.mjs`,
       * 12 seeds x 12 min, wandering player, sampling every real unaware exposure
       * episode):
       *
       *   commitDistance 11 : 49.4% of exposures convert, 57.5% of close
       *                       square-looks convert, 67.3% of peripheral/distant
       *                       episodes still stay unaware.
       *   commit disabled   : 31.8% of exposures convert, **0%** of close
       *                       square-looks convert, 68.2% stay unaware.
       *
       * So in the case the player actually experiences, the rule nearly doubles
       * engagement, takes the close square-on look from never converting to
       * usually converting, and costs the near-miss beat under one point. Judge
       * this number on `RC-engage`, not on a placed-statue probe.
       */
      commitDistance: 11,
      /**
       * How squarely he must be looking at the player for `commitDistance` to
       * apply. 0.8 sits well inside the focus cone (acuity is 1.0 there and falls
       * to 0.227 at the cone edge), so this is "the player is in front of him",
       * not "the player is somewhere in a 151 deg arc".
       *
       * Deliberately higher than `noticeAcuity` 0.5: between the two he still
       * evades, which keeps the mid-periphery pass-by that the near-miss numbers
       * depend on. Only the square-on look commits.
       */
      commitAcuity: 0.8,
      /**
       * Failsafe only. The approach budget is `corridorCells * cellSize /
       * walkSpeed * transitSlack`, clamped below by `transitMinSeconds`: enough
       * slack for doubling back around a braid loop and for the player moving
       * away mid-transit, without licensing an infinite hunt if he gets wedged.
       */
      transitSlack: 2.2,
      transitMinSeconds: 12,
      /**
       * During quiet he is kept between these many cells away. The FLOOR is what
       * makes quiet quiet; the CEILING is what stops him parking in the opposite
       * corner of a 93-cell-diameter maze for a minute and a half, from which no
       * approach can recover inside a beat. 10-22 keeps him plausibly elsewhere
       * while leaving the next approach roughly 40 seconds of walking, not 160.
       */
      quietMinCells: 10,
      quietMaxCells: 22,
      /**
       * Where he STARTS a run, in cells of corridor distance from the player.
       * Upper bound is `quietMaxCells`; this is the floor.
       *
       * game.ts used to spawn him at the door — the deepest cell in the maze,
       * measured at 87.1 cells from the player over 10 seeds, worst 120. That is
       * 4x outside the far edge of his own quiet band, and the commute alone is
       * ~200 s of walking. Measured with `--spawn deepest`: quiet band reached at
       * 133 s, first stalk 172 s, first unaware near-miss 175 s, first chase 191 s
       * (medians). The opening three minutes of every single run were an empty
       * maze, and under the capture harness's clamped dt that is closer to twenty
       * wall minutes — which is exactly why two independent critic runs reported
       * 100% quiet and concluded the whole director was dead code.
       *
       * Starting him inside the band puts the opening in the same world-state as
       * the middle of a run. The floor is HIGHER than `quietMinCells` on purpose:
       * the band's own floor is fine once the player is moving and has heard him,
       * but landing 10 cells out at t=0 is a chase inside fifteen seconds, which
       * spends the dread budget before the player has looked at a wall. 16 cells is
       * ~64 m of corridor — comfortably out of sight and earshot, roughly 35 s of
       * his walking, so the first approach is a real beat and not a commute.
       */
      openingMinCells: 16,
      /**
       * How often, in seconds, the director re-solves its target against the
       * player's current cell. The old director picked once per beat and never
       * looked again, so a stalk aimed at where you stood 18 seconds ago. Every
       * frame would be wasteful (this runs a BFS plus an A*); 1.0s is under three
       * cells of player movement at sprint, which is inside the stalk band's own
       * tolerance.
       */
      replanInterval: 1.0,
    },
  },

  gems: {
    count: 7,
    /**
     * Gems never spawn within this many cells of each other (Manhattan), and no
     * gem may sit closer to spawn than `minSpawnDepthFraction` of the maze's own
     * corridor depth. Together they are what makes collecting the set walk you
     * through the level instead of round one wing of it.
     *
     * Both raised after a 60-seed sweep of the REAL placement policy
     * (`tools/mazelab/lane-ai-gems.mjs`, which mirrors game.ts exactly rather than
     * approximating it). The quantity maximised is the fraction of maze cells a
     * player must physically walk through to collect all 7 and reach the door. The
     * hard constraint is that all 7 must still be placeable on EVERY seed: a seed
     * that places 6 can never unlock the door, and is an unwinnable run.
     *
     *   sep frac | seeds short of 7 | coverage avg / WORST
     *   4  0.28  |        0         |   39.1% /  21.5%    <- was shipping
     *   6  0.36  |        0         |   42.0% /  29.7%    <- now
     *   8  0.36  |        1         |   41.4% /  27.2%    <- unwinnable seed
     *   8  0.40  |        1         |   43.5% /  29.9%    <- unwinnable seed
     *
     * The average barely moves, 39.1 to 42.0, and that is not the point. The WORST
     * CASE moves 21.5% -> 29.7%: the seeds that used to let you finish having seen
     * a fifth of the level stop existing. Past sep=8 you buy a point of average
     * coverage with a soft-locked seed, which is not a trade.
     */
    minSeparationCells: 6,
    minSpawnDepthFraction: 0.36,

    /**
     * Radius of the octahedron. Direct user note: they were too small to read at
     * corridor distance, so they are noticeably bigger than the original 0.22.
     */
    size: 0.34,
    /** Waist height. They float around this, subtly enough to stay there. */
    height: 0.95,
    /** How far the float carries them either side of `height`. */
    floatAmplitude: 0.06,

    /**
     * Dark body, deep red glow. Direct user instruction, and it overrides the
     * earlier pale-grey scheme argued for here on the grounds that red would
     * vanish against a red-black maze — a call made by someone who had not played
     * it, overruled by someone who had.
     *
     * The legibility problem behind that argument is real, so it is solved within
     * red rather than by hue: the body goes near-black so the facets read as a cut
     * crystal and the emissive alone carries the colour, the emissive runs hot
     * enough to bloom, and the point light is tighter and brighter than the old
     * pale wash so it separates from the sky by BRIGHTNESS and falloff rather
     * than by being a different colour.
     *
     * Verify at 4m, 10m and 20m down a corridor before changing any of these.
     */
    bodyColor: 0x0d0607,
    emissiveColor: 0xd21b16,
    /**
     * Raised from 2.6, and this is the number that actually decides whether a gem
     * is findable at 20 m.
     *
     * The renderer runs ACES filmic tone mapping at exposure 0.22, so a scene
     * value of 2.6 grades down to roughly 0.2 on screen — which measured as a
     * 1.9x luminance contrast against the corridor wall at every range tested,
     * i.e. a dark red speck indistinguishable from red-brown timber. Worse, the
     * bloom pass is threshold-gated at 0.68 (`post.bloomThreshold`), so at 0.2
     * the gem sat far below the bright pass and NEVER BLOOMED — the "tight
     * pulsing glow" the brief asks for was being computed and then thrown away by
     * the grade.
     *
     * At 9 the gem clears that threshold, so the emissive blooms into a small
     * halo that survives distance even when the crystal itself is four pixels
     * across. The body stays 0x0d0607 near-black, so this brightens the GLOW
     * only and the facets still read as a cut stone rather than a white card —
     * which was the failure of the original pale-blue gem.
     */
    /**
     * 1.1, down from 9.0.
     *
     * At 9.0 the emissive term swamped everything and the orb rendered as a flat
     * uniform red disc. Measured: the silhouette IS genuinely writhing — 11% of the
     * gem's own area changes between frames 1.6s apart — and none of it was
     * visible, because a fully emissive surface has no shading left to deform.
     *
     * Liquid metal reads by SPECULAR HIGHLIGHTS rolling over a moving surface, not
     * by glowing. Turning the emission down is what lets metalness/roughness do
     * that job. Distance findability is not lost: the point light and the halo
     * sprite carry the read down a corridor, which is what they were always for.
     */
    emissiveIntensity: 1.1,
    /** Candela, like the flashlight. The only friendly light in the game. */
    glowColor: 0xff2a18,
    /**
     * Candela. Raised from 11 after measuring the thing the brief actually asks
     * for: "findable at 4 m, 10 m and 20 m down a corridor".
     *
     * Measured at 11 cd, with the gem's projected pixel taken from the camera
     * rather than guessed, the gem's peak luminance against the wall behind it
     * was only 1.9-2.0x at ALL THREE ranges — and at 20 m that is a handful of
     * dark red pixels indistinguishable from the red-brown wall. Since hue is
     * spent (the sky, the fog and the walls are all red already), brightness is
     * the only channel left, and 1.9x is not brightness contrast, it is noise.
     *
     * The flashlight is ~160 cd for comparison, so this stays firmly a glow and
     * not a second light source: it lifts the gem and the metre of floor under it
     * off the wall, which is what the eye catches down a long corridor.
     */
    glowIntensity: 34,
    /**
     * How far the gem's own point light reaches, in metres.
     *
     * Raised from 7.5. The legibility bar is "findable at 4 m, 10 m AND 20 m down
     * a corridor", and a 7.5 m light cannot contribute anything at 10 m or 20 m by
     * construction — past its range the gem was carried entirely by its emissive
     * against a red-black wall, which is the fight the bar exists to check. 16 m
     * covers the 10 m case properly and still puts a visible pool of red on the
     * floor around the gem at 20 m, which is often what the eye catches first in a
     * dark corridor. It stays well under the flashlight's own 30 m so the gem
     * never out-ranges the torch and flattens the maze.
     */
    glowDistance: 16,

    /**
     * The pulse. Brightness and motion are the only channels a red gem has in a
     * red maze — hue is spent — so the emissive and the glow breathe together.
     *
     * `pulseDepth` is the fraction of full brightness the pulse swings through.
     * At 0.45 the trough is still 55% lit: it must never blink out, because a
     * player who scans a corridor during the dark half would learn the corridor is
     * empty. Slow enough (about a 3.5 s cycle) to read as breathing rather than a
     * warning light, which would break the tone.
     */
    pulseRate: 1.8,
    pulseDepth: 0.45,

    /**
     * The distance halo. See the long note in `Game.placeGemsAndDoor`.
     *
     * `haloSize` is its world diameter in metres up close — deliberately only a
     * little larger than the 0.34 gem, so near-to it is a tight bloom around the
     * crystal and not a floating disc.
     *
     * `haloHoldDistance` is where it stops shrinking: past 6 m the sprite is
     * grown linearly with distance so its on-screen size holds roughly constant,
     * which is what keeps a gem findable at 20 m. Measured: at 20.4 m without
     * this the gem's luminance contrast against the wall was 1.7-1.9x across
     * three seeds and it was invisible in the frame.
     *
     * `haloOpacity` is kept well under 1 because it composites additively — it
     * must lift the corridor behind the gem, not blow it out. A halo bright
     * enough to read as a light source in its own right would break GAME-SPEC
     * §6a's rule that the only lights in this world are the torch and the gems.
     */
    haloSize: 0.9,
    haloHoldDistance: 4.5,
    haloOpacity: 0.72,

    /**
     * Liquid-metal deformation, in metres of displacement along the surface normal.
     *
     * User note: the gems should be "orbs that keep twitching and changing forms in
     * their place in a menacing way like Terminator's metal liquid enemy".
     *
     * `roil` is the constant slow churn — it must never stop, because a blob that
     * settles reads as a rock. `twitch` is a sharp spike on a per-gem clock: short,
     * violent, then gone. The twitch is what makes it read as menacing rather than
     * decorative, so it is deliberately the larger of the two. Both are absolute
     * metres against a `size` of 0.34, so a twitch throws a spike roughly a third
     * of the orb's radius out of its own surface and lets it collapse back.
     */
    roilAmount: 0.055,
    twitchAmount: 0.13,
  },

  /**
   * The way out. It had no light of any kind — `emissive: 0x000000` on a
   * near-black box in a near-black maze — and the user's report was simply "I
   * couldn't find it anywhere". The one object the game asks you to walk to was
   * the least visible thing in the world.
   *
   * It now carries the gems' halo, in its own colour. Gems are the wet red of
   * Billy's cords; the exit is a colder, cleaner light that belongs to nothing
   * else in this place, so the two can never be confused at a glance.
   */
  /**
   * TOUCH / MOBILE. See `updateLookFollow` in game.ts for what these do and why
   * each guard exists.
   */
  touch: {
    /** Stick travel, in px, from centre to full deflection. */
    stickRadius: 56,
    /** Fraction of the radius ignored, so resting a thumb does not creep. */
    stickDeadzone: 0.16,
    /** Swipe-to-look sensitivity, in the same units as a mouse delta. */
    lookSensitivity: 1.35,
    /**
     * How long a manual swipe suspends the auto-follow, seconds. Long enough to
     * sidestep while watching something; short enough that letting go returns
     * you to "the view faces where I walk" without a wait.
     */
    lookHoldSeconds: 1.1,
    /** Stick magnitude below which the follow does nothing at all. */
    followDeadzone: 0.22,
    /** How hard the view chases the stick direction, per second. */
    followGain: 2.4,
    /** Rate cap, rad/s. Above this it reads as the camera being yanked. */
    followMaxRate: 1.6,
    /**
     * How far the stick must be re-aimed, in radians, before the world heading
     * is re-anchored. Small enough that a deliberate change of direction is
     * honoured at once; large enough that thumb jitter cannot re-anchor every
     * frame — which would reintroduce the runaway spin the world heading exists
     * to prevent.
     */
    reaimThreshold: 0.35,
  },

  door: {
    /** Cold, clean, and deliberately not the gems' red. */
    glowColor: 0x9fd8e6,
    /** Sprite size in metres. Larger than a gem's: it is a doorway, not a pickup. */
    /**
     * REVERTED past the old 3.8, to 1.7. It went 3.8 -> 6.4 to make the exit
     * easier to find, and that was the wrong lever: the halo is a camera-facing
     * quad on a door embedded in a wall, so making it bigger only made the
     * plane-intersection cut across more masonry. Range-finding belongs to the
     * sky beacon, which is a volume and cannot be sliced.
     */
    haloSize: 1.7,
    /**
     * ABOVE the door, not level with it — 3.9m, clear of the 3.4m-tall box.
     *
     * At eye height the sprite sat at the door's own centre, so the solid door
     * occluded its own beacon: `depthTest` is on (deliberately, so it cannot glow
     * through masonry) and the box is nearer the camera than the sprite from every
     * approach. Measured at 8m the only visible effect was cold light spilling on
     * the surrounding brick, which is a hint rather than a landmark.
     *
     * Lifted over the lintel it reads the way a light above a doorway reads: you
     * see the glow first, down the corridor, and the door underneath it as you get
     * closer. Walls still block it, so the maze is intact.
     */
    haloHeight: 3.9,
    /**
     * How far the halo sits OUT from the door, along the face it is set into.
     * Its whole purpose is to get the billboard's centre clear of the wall
     * plane, so the quad stops being cut into a hard-edged wedge. 0.55m puts it
     * in the corridor without it reading as detached from the door.
     */
    haloStandoff: 0.55,
    /**
     * LOCKED: a faint ember. Enough to notice from down a corridor and wonder,
     * not enough to draw you to it before you have earned it.
     */
    haloOpacityLocked: 0.22,
    lightIntensityLocked: 3.4,
    /**
     * A BIGGER AURA up close, on the user's report that the exit was still "too
     * difficult to find". The halo was tuned to be a hint you notice rather than
     * a landmark you steer by, and in play that turned out to be too subtle to
     * serve its one job. Roughly doubled, with the locked ember lifted less than
     * the unlocked bloom so the "you have not earned it yet" difference survives.
     */
    /** UNLOCKED: it blooms, and the exit announces itself from range. */
    haloOpacityOpen: 0.85,
    lightIntensityOpen: 26,
    lightDistance: 16,

    /**
     * THE SKY BEACON — the Minecraft-style column over the exit.
     *
     * User: "Maybe a beacon in the sky like the minecraft one." The halo only
     * helps once you are already in the right corridor, because walls block it.
     * This is the opposite and deliberately so: it clears the maze entirely, so
     * from anywhere with sky overhead the exit has a bearing.
     *
     * `baseHeight` must start it ABOVE the walls, and the first version of this
     * comment claimed it did while the value was 6.2 against a `wallHeight` of
     * 6.5 — i.e. the bottom 0.3m of the column sat in front of the masonry, at
     * full strength, because the vertical dissolve only fades the TOP.
     *
     * That is what made it "blocky over the door". Additive light over the bright
     * red sky barely registers; the same light over near-black stone is an
     * enormous relative jump, so the overlap painted a hard bright wedge across
     * the wall while the part in open sky looked correct. The lesson is in the
     * pairing: an additive effect's brightness is a property of what is BEHIND it,
     * so it must be judged against the darkest thing it can cross, not the
     * brightest.
     *
     * Two defences now, because the height alone is fragile — a taller pier or a
     * nearer wall at a steep viewing angle can still put stone behind the column:
     *   - the base clears `wallHeight` with real margin, and
     *   - `baseFade` ramps the column in from nothing over its first stretch, so
     *     even where it does cross masonry there is no hard bright edge to see.
     */
    beacon: {
      baseHeight: 7.6,
      /**
       * Fraction of the column's height over which it fades UP from zero.
       *
       * SHORT ON PURPOSE, and 0.12 was a bad over-correction: 0.12 x 70m is an
       * 8.4m ramp, so a column based at 7.6m only reached full strength at 16m —
       * while it clears the 6.5m roofline at 7.6m. From inside a corridor you
       * are looking at the 7.6-10m band, where it sat at nearly zero. The beacon
       * was invisible in exactly the place it exists to be seen from, which is a
       * worse failure than the blocky edge it was added to fix.
       *
       * 0.03 x 70m = 2.1m: up to full within about a metre of emerging, so it
       * still starts softly rather than in a hard cut, and is unmistakable from
       * the corridor floor. Protecting masonry is `baseHeight`'s job now.
       */
      baseFade: 0.03,
      /**
       * Shortened from 120: with the vertical dissolve the top of a 120m column
       * was invisible anyway, and the shorter tube keeps more of the fade inside
       * the part you actually see.
       */
      height: 70,
      /** Locked: a thin rumour on the horizon. Unlocked: unmistakable. */
      opacityLocked: 0.35,
      opacityOpen: 1.0,
      /**
       * STRAIGHT, not tapered. The first version narrowed 0.55/0.40 toward the top
       * and the result read as a cone — a papery wedge stuck over the door. A
       * Minecraft beacon is a column of constant width; the only thing that should
       * change with height is that it fades out.
       */
      taper: 1.0,
      /**
       * Enough segments that the tube is round. With the rim falloff in the shader
       * the silhouette fades to zero alpha before a facet edge could show, so this
       * is about the cross-section, not the outline.
       */
      segments: 40,
      /**
       * Two shells: a tight core inside a wide, very faint one that does the job a
       * bloom would. `edge` is the rim-falloff exponent — HIGHER is tighter, so the
       * core stays a definite column while the outer shell is a soft glow with
       * almost no edge of its own.
       *
       * Peak strengths are far below the old 0.55/0.16 because those clipped to
       * flat white against the red sky, which destroys every gradient in the thing
       * and is most of why it looked like cut paper.
       */
      shells: [
        { radius: 0.42, opacity: 0.30, edge: 2.2 },
        { radius: 1.10, opacity: 0.10, edge: 1.1 },
      ],
    },

    /**
     * The leaf itself. Built as carpentry (see buildDoorMesh) rather than a box,
     * because at these light levels what survives is SILHOUETTE and the way the
     * beam rakes across relief — the same finding that drove the wall geometry.
     */
    width: 2.3,
    height: 3.3,
    leafThickness: 0.14,
    frameWidth: 0.22,
    /** Shallower: at 0.30 the frame jutted into the corridor like a doorstop. */
    frameDepth: 0.17,
    /** Separate boards with gaps between them, so the beam has edges to catch. */
    plankCount: 7,
    strapHeight: 0.17,
    studRadius: 0.035,
    handleRadius: 0.135,
    /**
     * MUCH darker than the first attempt (0x4a3524 -> 0x241a11).
     *
     * In the shipped frame the door rendered as a cream slab glowing against
     * near-black brick — the user's note was "too bright and low poly compared to
     * the rest of the place", and the brightness half was the worse offence. The
     * walls sit in the near-black band by design (nearBlackFrac 0.68), so ANY
     * mid-tone object is the brightest thing in frame and reads as unlit
     * placeholder geometry.
     *
     * Old timber in an unlit corridor is nearly black; you find it because the
     * beam rakes across its relief, not because it is a lighter colour. Let the
     * torch do the work.
     */
    timberColor: 0x241a11,
    /** Blackened iron, not steel. It should read as a dark break in the timber. */
    ironColor: 0x141418,
    /**
     * Metres of door surface per texture tile.
     *
     * NOT a repeat count, deliberately. `BoxGeometry` UVs run 0..1 per face
     * whatever the face measures, so a fixed repeat tiles a 0.3 m plank and a
     * 2.4 m backing board at wildly different physical grain sizes — the door's
     * boards ended up with grain eight times finer than its frame, which at this
     * light level aliases into mush rather than reading as wood. Each face solves
     * its own repeat from this figure instead.
     *
     * 1.15 m sits just under the walls' own 1.18 m tile (world UVs at SCALE 0.85
     * on a 1024^2 source), so door and stone share one apparent grain size, which
     * is what makes them read as one world.
     */
    texMetresPerTile: 1.15,
    /**
     * Relief depth on the borrowed wall normal map. Matched to the walls'
     * `normalScale` 0.35 for the same reason the tile size is matched — the door
     * should catch the torch exactly as hard as the masonry does, no harder.
     */
    normalScale: 0.35,
    /** Base roughness; the borrowed roughness map multiplies it, as on the walls. */
    roughness: 0.9,
    /**
     * How far the player stands from the spawn wall's face, metres.
     *
     * Must clear the player's 0.34 m collision radius plus the door frame's
     * `frameDepth` (0.17) that stands proud of that face, or the controller
     * resolves the overlap by pushing the player back out and the standoff
     * silently reverts to whatever the collision pass decides. 0.75 leaves ~0.24 m
     * of daylight: close enough that the arrival door shuts at your shoulders,
     * far enough that the first frame is not a wall filling the screen.
     */
    spawnStandoff: 0.75,
    /**
     * Where the black void panel sits, as a door-local +Z offset in metres.
     *
     * POSITIVE = toward the player. That is deliberate and the sign is the whole
     * bug: the door is inset into its wall by `maze.wallThickness / 2`, so the
     * masonry's near face is at door-local z = 0, and any negative value puts the
     * panel inside the wall where the wall occludes it. It must land between the
     * wall face (z = 0) and the front of the leaf's backing board (z =
     * leafThickness / 2 = 0.07) — in front of the stone, behind the shut door.
     */
    voidDepth: 0.02,
    /**
     * How much room the carpentry must leave around a doorway.
     *
     * `halfWidth` is measured from the door's centre in XZ; the door is ~2.44m
     * wide, so 1.6 clears the opening plus its frame with margin, and the test in
     * `buildTrim` is against each member's own extent rather than its centre so a
     * long plate that merely crosses the gap is excluded too. `headroom` extends
     * the exclusion above the door's own height, because the head-height plate is
     * the one that was cutting across the opening.
     */
    trimClearance: { halfWidth: 1.6, headroom: 0.6 },
    /**
     * How close you must be to the unlocked exit for it to open, metres. Was a
     * bare `2.4` inline in `updateDoor`.
     */
    triggerRadius: 2.4,
    /**
     * How far onto the door's OWN side of its wall you must be, metres.
     *
     * The trigger used to be distance alone, which fired from the cell on the far
     * side of the wall the door is set into — you could walk through the exit
     * through solid stone. See the note in `updateDoor`. Positive and small: big
     * enough that the door plane itself cannot flicker the trigger on
     * floating-point noise, small enough that walking up to the door still works.
     */
    triggerFrontMargin: 0.15,
    /** Deep shadow in the plank gaps and behind the straps. */
    recessColor: 0x0a0705,
  },

  /**
   * THE LOOP. Reaching the exit does not end the game — it starts the next maze.
   *
   * User: "Now for the loop thing that shows how you can't escape. Reaching the
   * unlocked door takes you to... Another maze! Is it possible to have it animated
   * where the door opens and you step inside into a new maze with the door
   * shutting and disappearing behind you?"
   *
   * The win text already promised this and the game did not deliver it:
   *
   *     YOU MADE IT OUT
   *     Or so he lets you think.
   *     There is no escape… Not even death…
   *
   * A terminal win screen makes that text a boast. Making the door a BEAT inside a
   * loop makes it literally true — you get the victory card, and then you are
   * standing in another maze with the way back gone.
   *
   * Every duration below is in SECONDS and is walked in real (frame) time, not
   * simulation time, so the sequence plays at the same pace regardless of how
   * badly the frame budget is doing. That matters here more than anywhere else in
   * the build: under SwiftShader the harness runs at 4-17fps, and a scripted move
   * driven off simulation substeps would either crawl or skip.
   */
  loop: {
    /**
     * The swing. `openAngle` is radians about the hinge (the -X edge of the door
     * group), positive = the handle edge sweeps away from the corridor.
     *
     * 1.9 rad is ~109 degrees: past square, so from the doorway you see the leaf
     * edge-on against the frame rather than a slab still half across the opening.
     * A 90-degree door photographs as "ajar"; this photographs as "open".
     */
    openAngle: 1.9,
    /** Seconds for the leaf to swing from shut to `openAngle`. */
    openSeconds: 1.5,
    /** Seconds the camera spends being carried through the doorway. */
    walkSeconds: 2.3,
    /**
     * Where the walk ENDS, as a signed offset from the door plane in metres.
     * NEGATIVE means the camera stops short of the plane and never crosses it.
     *
     * THERE IS NOTHING ON THE OTHER SIDE OF THIS DOOR, and this value is how the
     * sequence copes with that. `findDoorWall` deliberately sets the door into a
     * face that is SOLID, so a metre past the leaf is masonry and two metres past
     * it is either a corridor the player has already walked or the open red void
     * outside the perimeter. Building a real room behind every possible door is
     * not available: the door lands on a different cell every seed and the maze
     * ships as one merged mesh.
     *
     * The first attempt carried the camera 1.15 m PAST the plane and relied on
     * the fade to hide the far side. It did not: solving the eased move shows the
     * camera crossing the plane at t=1.25s of a 2.3s walk, while the fade was
     * only 0.61 — and the captured frame at 62% duly shows an open corridor and
     * red sky through what should be a wall. Making the fade fast enough to cover
     * that needed a 2.05s head start on a 2.3s walk, i.e. fading almost from the
     * first frame, which throws the shot away to fix a leak in it.
     *
     * Stopping SHORT removes the failure instead of masking it. The camera is
     * drawn up into the threshold — the leaf swings past, the jamb fills the
     * frame either side — and is taken by the dark while the doorway is still
     * ahead of it. Nothing can be seen through the wall because the camera is
     * never on the wrong side of it, at any fade value, on any seed.
     */
    walkDistance: -0.25,
    /**
     * How far in front of the door the camera lines up before walking through.
     *
     * Was a bare `1.5` inside `beginLoopWalk`. It is config now because the
     * approach under the door swing and the walk that follows must use the SAME
     * value — if they ever disagreed the sequence would regain exactly the
     * one-frame jump that made it read as erratic.
     */
    standoff: 1.5,
    /** Seconds to fade the screen to black once the walk is done. */
    fadeOutSeconds: 1.0,
    /**
     * How long BEFORE the walk ends the fade starts, seconds.
     *
     * Now purely a matter of feel rather than of occlusion — see `walkDistance`,
     * which is what actually guarantees the far side is never visible. At 1.35
     * against a 2.3s walk the fade covers the last 60% of the move and reaches
     * black just as the camera settles into the threshold, so the move and the
     * darkness are one event rather than two.
     */
    fadeHeadStart: 1.35,
    /** How long the transition card is held on black before the new maze fades up. */
    cardSeconds: 4.4,
    /** Seconds to fade back in on the far side. */
    fadeInSeconds: 1.6,
    /**
     * The door shutting behind you, on the far side. Shorter than `openSeconds`
     * on purpose: a door you opened yourself opens at your pace, and a door that
     * shuts behind you does it faster than you would like.
     */
    shutSeconds: 0.9,
    /** Beat between the fade-in finishing and the door starting to shut. */
    shutDelaySeconds: 0.7,
    /** After it shuts, how long the door takes to stop existing. */
    vanishSeconds: 1.2,
    /** Beat between the shut landing and the vanish starting. */
    vanishDelaySeconds: 0.45,

    /**
     * ESCALATION, and why it is this small.
     *
     * Each loop the maze gains `growCellsPerLoop` cells on each axis and the
     * monster's speeds gain a multiplier. Both are deliberately below the
     * threshold at which a player could name the change on the loop it happens —
     * the dread comes from the depth counter and from the door being gone, not
     * from a difficulty curve announcing itself.
     *
     * Caps exist because neither term is safe unbounded: the maze is rebuilt as
     * one merged mesh whose vertex count grows with the cell count, and a monster
     * faster than the player's 5.0 sprint turns the game into the Brute (see the
     * `chaseSpeed` note — that value was chosen against Amnesia's Servant Grunt
     * specifically so a perfect fleer can escape).
     */
    growCellsPerLoop: 2,
    /** Cols/rows ceiling. 21 -> 29 over four loops, then flat. */
    maxCells: 29,
    /**
     * NOT YET WIRED, and honestly labelled as such.
     *
     * `Monster.update` reads `CFG.monster.walkSpeed / chaseSpeed /
     * chaseLungeSpeed` directly when it picks its target speed, and `CFG` is
     * `as const`. There is no seam in `monster.ts` for a per-loop multiplier, and
     * inventing one from `game.ts` would produce a field nothing reads — a value
     * that shows up in a config dump as escalation while the monster runs at
     * exactly the speed he always did.
     *
     * These are the tuned numbers for whoever owns `monster.ts` and adds the
     * multiplier at the `targetSpeed` selection. The cap is the important one:
     * 1.14x of the 4.65 chase speed is 5.30 against the player's 5.0 sprint, and
     * anything past that turns the Servant Grunt into the Brute — which is
     * precisely the bug `chaseSpeed` was chosen to avoid.
     */
    monsterSpeedPerLoop: 0.035,
    maxMonsterSpeedScale: 1.14,
    /**
     * Gems per loop. Unchanged by design: seven is the count the HUD tally, the
     * placement separation rule and the maze audit are all written against, and
     * changing it per loop would change the SCENE LIGHT COUNT — which recompiles
     * every material in the game mid-transition. See the gem-light note in game.ts.
     */
    gemCount: 7,
  },

  audio: {
    ambienceVolume: 0.55,
    chaseVolume: 0.75,
    /**
     * Seconds for a *full* ambience <-> chase crossfade. An interrupted fade only
     * pays for the distance it still has to travel, so reversing 10% into a fade
     * takes 10% of this, not all of it.
     */
    fadeIn: 0.8,
    fadeOut: 2.6,
    stepVolume: 0.42,
    /** How much of your own footfall comes back off the corridor walls. */
    stepReverb: 0.34,

    /**
     * The stone corridor, as a synthesized impulse response. No extra asset:
     * decaying noise that darkens across its tail, because stone eats highs
     * faster than lows and a flat tail sounds like a plate reverb, not a cellar.
     */
    reverb: {
      seconds: 1.5,
      /** Time before the first reflection returns — the width of the corridor. */
      preDelay: 0.021,
      /** Decay exponent. Higher = the room dies faster. */
      decay: 2.4,
      /** One-pole coefficient at the head of the tail; falls to ~15% of this by the end. */
      tone: 0.34,
      /** Return level of the shared corridor bus. */
      wet: 0.5,
    },

    /**
     * The monster's voice. In Amnesia you hear the thing long before you see it,
     * and the information that keeps you alive is *where* and *how far* — which
     * is carried by the filter as much as by the volume.
     *
     * LEVELLING NOTE, measured, do not tune this blind. A critic instrumented the
     * running game with an analyser on the master bus and found him 41.6 dB under
     * the ambience bed at 22m through a wall, and still 6.9 dB under it at 8m with
     * clear line of sight. He was inaudible in exactly the moment the spec says
     * audio must carry the information. Three things were wrong and all three are
     * fixed here:
     *
     *  1. `range` was squared on top of an already-inverse rolloff, so the two
     *     attenuations multiplied into near-silence across the whole mid-field.
     *     It is now a linear-in-distance edge taper that only bites near the very
     *     end of the range (see `edgeFrom`), leaving the rolloff to do the actual
     *     distance work.
     *  2. `occludedGain` at 0.6 sat on top of that. Through-wall is now a much
     *     gentler level cut, because *the filter* is what should say "wall", not
     *     the fader. That is the whole reason the occlusion lowpass exists.
     *  3. `volume` was too low to survive the bed even before either of those.
     *
     * Target, verifiable from the analyser: at 20m through a wall he sits roughly
     * 12-18 dB below the ambience bed — present, placeable, unmistakably not
     * silence. See `bedDuck` for the other half of that: the bed steps aside.
     */
    monster: {
      /**
       * Solved, not guessed. With the rolloff and taper below and a typical vocal
       * source gain of ~0.95, this lands him at -14.0 dB under the bed at 20m
       * through a wall and -4.1 dB at 8m with line of sight. Both are inside the
       * band the critic's analyser asked for; the old numbers measured -41.6 dB.
       */
      volume: 1.3,
      /** Inside this radius he is at full level; beyond it, inverse rolloff. */
      refDistance: 2.5,
      /**
       * Inverse-distance rolloff. Note this is now the ONLY real distance term —
       * the old squared range factor multiplied on top of it and was what actually
       * annihilated him in the mid-field. Fitted so the two level targets above
       * are hit simultaneously.
       */
      rolloff: 1.18,
      /** Past this he is silent. Comfortably beyond his 22m sight range. */
      maxDistance: 34,
      /**
       * Where the edge taper starts, as a fraction of maxDistance. Below this the
       * taper is 1 and distance is handled purely by the rolloff; above it the
       * level is walked linearly to zero so nothing pops at the range boundary.
       */
      edgeFrom: 0.72,
      /** Stereo spread. Below 1 so he never pins fully to one ear and vanishes. */
      panWidth: 0.85,

      /** Lowpass cutoff with stone in the way vs. clear line of sight. */
      occludedCutoff: 320,
      clearCutoff: 8200,
      /**
       * Through-wall level. The filter carries the occlusion; the fader must not
       * carry it as well or he disappears. 0.6 was already meant to be gentle and
       * still cost 4.4 dB on top of everything else.
       */
      occludedGain: 0.82,
      /** How fast occlusion opens/closes, per second. ~5 = about 200ms. */
      occlusionSlew: 5,
      /**
       * Head shadow. Cutoff multiplier for a source directly BEHIND the listener,
       * ramping to 1.0 for one directly in front.
       *
       * This exists because a measured 3.5-second average in the real browser
       * showed Chromium's HRTF panner resolving left/right beautifully (L/R 0.66
       * versus 1.47) and front/back essentially not at all — 1.061 versus 1.017,
       * 1.9 dB apart, which is not a cue a player can use. Since the HRTF was
       * brought in specifically to fix front/back, that had to be closed properly
       * rather than declared solved.
       *
       * Your outer ear faces forward and genuinely does eat high frequencies
       * arriving from behind, so darkening a rear source is the real physical cue,
       * not a trick — and it is free, because the occlusion lowpass is already in
       * this chain and only needs one more multiplier.
       *
       * 0.45 is a little under an octave of darkening: enough to read as "that is
       * behind me", not so much that a monster standing behind you in an open
       * corridor sounds like he is through a wall.
       *
       * IMPORTANT: this scales only the span ABOVE `occludedCutoff`, never the
       * floor itself — see the code in audio.ts. Applied to the whole cutoff (the
       * obvious way to write it) it measured 320 x 0.45 = 144 Hz for a monster who
       * was both occluded and behind you, which is below his own vocal's second
       * harmonic. Every formant that makes the sound read as a throat was filtered
       * off and he became a featureless hum — in exactly the situation the
       * occlusion floor exists to protect against.
       */
      rearShadow: 0.45,
      /**
       * Base send into the corridor. Scaled UP with distance and with occlusion at
       * runtime, because wet/dry ratio is the ear's strongest distance cue and a
       * fixed send hanging off his output moves it the wrong way — it makes a
       * distant monster drier, which reads as "small and nearby and quiet".
       */
      reverbSend: 0.42,
      /** Ceiling on the runtime send, so a near-silent far monster is not all tail. */
      maxReverbSend: 3.2,

      /**
       * The bed steps aside for him.
       *
       * ----------------------------------------------------------------------
       * THIS BLOCK IS A REWRITE OF A MEASURED FAILURE. The previous version was
       * a single `depth: 0.55` scaled by his bus level between `floorAt: 0.02`
       * and `fullAt: 0.30`. His bus level was then measured in the running game:
       *
       *     1m 1.27 · 2m 1.30 · 3m 1.05 · 5m 0.60 · 8m 0.36 · 12m 0.24 · 30m 0.04
       *
       * `fullAt: 0.30` is therefore reached at about EIGHT METRES, so at every
       * distance that matters the term clamped to 1 and the duck was the
       * constant 0.55. Measured: `minBedDuck` 0.550 in patrol, 0.550 in
       * suspicious, 0.550 in chase — identical to three decimals across 1 idle,
       * 2 alert and 10 hunt utterances plus a notice sting. The bed never opened
       * a hole for anything, so nothing he said could read as an event.
       *
       * In Amnesia the idle groan and the "he has noticed you" growl are
       * deliberately only subtly different AS SOUNDS. What makes the second one
       * legible is that the whole soundfield reorganises around it. That
       * reorganisation is what these numbers are.
       */
      bedDuck: {
        /**
         * How far the bed is willing to move for each vocal state, at full gate
         * and mid-utterance. An idle groan, an alert growl and a hunt snarl must
         * arrive at three audibly different mix depths — that separation is the
         * information, and it is what makes the same three throat sounds mean
         * three different things.
         *
         *   0.62 ≈ -4.2 dB   a groan somewhere in the maze; the bed notices
         *   0.38 ≈ -8.4 dB   he is looking for you; the bed leans back
         *   0.20 ≈ -14.0 dB  he is hunting; the bed gets out of the way
         *
         * These are DEEPER than the values they replace (0.85/0.60/0.35), and
         * that is not a taste change, it is the correction for a measured bug.
         * Those numbers were nominal depths that the surrounding arithmetic
         * never let the duck reach: the live game measured `bedDuck` pinned at
         * 0.987-0.997 through 26 seconds of patrol with three idle utterances
         * firing — a working range of 0.08 dB. See the long note in
         * `audio.ts applyBedDuck` for why the proximity term annihilated them.
         * With proximity now a gate rather than a multiplier, the number written
         * here is close to the number the bed actually reaches, so it has to be
         * written as the depth genuinely wanted rather than as an aspiration.
         */
        byState: { silent: 1.0, idle: 0.62, alert: 0.38, hunt: 0.20 },
        /**
         * The notice sting's own depth, deeper than any state bed and applied
         * regardless of distance. This is the mix EVENT: on the frame he
         * realises you are there the bed drops out from under it and the growl
         * arrives in cleared space. 0.14 ≈ -17.1 dB — a hole you cannot miss,
         * because this is the single most important instant in a run.
         */
        stingDepth: 0.14,
        /**
         * Proximity gate, refitted to the level curve the RUNNING GAME produces
         * rather than the one the synthetic test rig produces. That distinction
         * is what was wrong before and it cost the entire mechanism.
         *
         * Measured live, with the real director placing him:
         *
         *     6m 0.374 · 12m 0.181 · 15m 0.153 · 20m 0.113 · 23m 0.0995
         *
         * He is essentially never nearer than ~5m until the moment he kills you,
         * so his bus level in play spans roughly 0.10-0.40, not the 0.04-1.30 the
         * rig sweeps. `fullAt: 0.90` therefore sat above everything ever
         * observed. `fullAt: 0.26` puts the gate fully open by about 8m — close
         * enough to be worth clearing the bed for — while `floorAt: 0.055` still
         * shuts it off past ~20m so a groan at the edge of the maze does not pump
         * the mix.
         */
        fullAt: 0.26,
        floorAt: 0.055,
        /**
         * Gate shaping exponent, below 1 so the gate opens EARLY across his
         * working range instead of climbing linearly to a ceiling. At 12m
         * (`near` = 0.61) this lifts the gate to 0.75; linear would leave it at
         * 0.61 and shave 2 dB off every utterance in the middle of his range,
         * which is precisely where most of the game is heard.
         */
        gateCurve: 0.62,
        /**
         * The RESTING duck: how much the bed stays leaned-back between
         * utterances, as a fraction of the state's full depth. Additive with the
         * utterance envelope rather than a floor under it, so his mere presence
         * is felt continuously and each growl then opens the hole the rest of the
         * way.
         *
         * 0.40 rather than 0.22 because the previous value was a `max()` floor
         * that the envelope had to climb over, so between utterances the duck
         * fell to 0.22 of a depth that was itself being crushed to nothing.
         */
        idleFloor: 0.40,
        /**
         * Envelope release for an ordinary utterance and for the sting, seconds.
         * Attack is instantaneous at trigger time — the hole must already be open
         * when the transient arrives — and the release is slow, which is the
         * standard ducker shape and the only one that does not breathe audibly.
         */
        utterRelease: 0.9,
        stingRelease: 1.8,
        /** Duck attack / release smoothing time constants, seconds. */
        attack: 0.12, release: 0.7,
      },

      /** Gait rates. His run is roughly double his walk, matching the 2x run clip. */
      walkStepsPerSecond: 1.55,
      runStepsPerSecond: 3.1,
      /** His steps are pitched below yours — the ear reads low as heavy. */
      walkStepRate: 0.7,
      runStepRate: 0.82,
      /**
       * Steps are now SUPPORT, not his voice. Frictional's shipped LuxEnemy.cpp
       * has no enemy footstep code at all — their monster is voice-first, and ours
       * was footstep-only. These come down so the vocals sit on top.
       */
      walkStepVolume: 0.5,
      runStepVolume: 0.72,

      /** Breathing swells inside this radius. */
      breathDistance: 15,
      breathWalk: 0.26,
      breathChase: 0.55,
      /** Seconds per breath, and the length of the generated loop. */
      breathPeriod: 2.9,
      breathLoopSeconds: 8.7,
      breathCentreHz: 340,

      /**
       * ------------------------------------------------------------------------
       * The drag: what his BODY sounds like.
       * ------------------------------------------------------------------------
       *
       * GAME-SPEC §1 — he is the player's melted flesh wound in cords around a
       * dead child's head, forearms and calves. §6a — think Ennard, a figure
       * built out of thick wires, only here the wires are meat. Loose wet cord
       * hangs off a thing like that and drags on the stone as it moves.
       *
       * This is the layer that makes him specific. A growl is a monster; wet
       * rope hauled over stone is *this* monster, and it is the one sound in the
       * game that could only belong to him. It is also the layer that was most
       * conspicuously absent: the shipped build's entire answer to "what does his
       * body sound like" was the PLAYER'S OWN footstep samples at 0.7x rate,
       * which does not merely fail to describe him — it actively asserts he is a
       * man in boots.
       *
       * Synthesized (see `audio.ts makeDrag`), because no such asset ships and
       * naming a file that does not exist would be a lie.
       */
      drag: {
        /** Distinct strokes baked, so a corridor of him never audibly loops. */
        variants: 4,
        /** Stroke length in seconds. Long — this is a pull, not an impact. */
        length: 0.85,
        /**
         * Fraction of the stroke spent swelling. Well under half, so it still
         * has a leading edge, but far too slow to read as a transient. An
         * attack here would turn the drag into a second footstep, which is the
         * one thing it must not be.
         */
        swell: 0.28,

        /**
         * Wetness. This is the stick-slip flutter that separates saturated rope
         * from dry cloth: the scrape is gated by a random walk that re-targets
         * on a short irregular hold, so it catches and releases instead of
         * hissing evenly.
         *
         * `wetFloor` is how far the gate can close on a catch — well below 1, or
         * the flutter is a gentle tremolo rather than an interruption.
         */
        wetFloor: 0.18,
        /** Hold range for one catch, seconds. Short and irregular. */
        wetMinHold: 0.006, wetMaxHold: 0.045,
        /** How fast the gate moves between targets. Fast enough to be a grab. */
        wetSlew: 0.05,

        /** One-pole highpass coefficient for the scrape. Near 1 = bright. */
        scrapeHp: 0.86,
        scrapeGain: 0.55,

        /**
         * The low body under the scrape — this is the mass. Without it the drag
         * is a small dry sound and he is not small. Two-pole lowpass whose
         * cutoff sags to `bodyEndRatio` across the stroke as the coil settles.
         */
        bodyCoef: 0.055,
        bodyEndRatio: 0.55,
        bodyGain: 1.5,

        /**
         * Stroke rate as a multiple of his gait rate.
         *
         * Deliberately NOT 1 and deliberately not a simple ratio. Locked to the
         * footfall, the drag fuses with the step into one compound "clop" and
         * stops reading as a separate material; at an awkward ratio the two
         * slide against each other and the pairing never repeats, so his parts
         * sound like they do not quite agree with each other — which is what he
         * is.
         *
         * 1.63, not the 0.79 first tried. Measured in the live game, 0.79 gave
         * 1.22 strokes/second against an 0.85s stroke, so the strokes did not
         * even touch and the drag arrived as isolated events with silence
         * between them — which reads as an intermittent noise, not as a body.
         * A thing hung with loose wet cord makes that sound CONTINUOUSLY while
         * it moves; the individual stroke should never be separable. At 1.63 the
         * strokes overlap by roughly a third, so the layer is unbroken while he
         * walks and the ear resolves it as one dragging mass rather than a
         * rhythm.
         */
        gaitRatio: 1.63,

        /** Playback rate walking vs chasing. Running whips the cords. */
        walkRate: 1.0, chaseRate: 1.45,
        /** Per-stroke level walking vs chasing. */
        walkGain: 0.85, chaseGain: 1.15,

        /**
         * Bus level and the radius it swells over. Wider than `breathDistance`
         * because you should hear the BODY before the breath — he is a physical
         * thing dragging through the maze before he is close enough to be a
         * throat, and that ordering is the whole "hear it before you see it".
         */
        distance: 19,
        busGain: 0.9,
      },

      /**
       * ------------------------------------------------------------------------
       * The vocal state machine.
       * ------------------------------------------------------------------------
       *
       * Modelled directly on HPL2's `LuxEnemy`: `eLuxEnemySoundState` of
       * {Silent, Idle, Alert, Hunt}, each state owning an ambient vocal plus a
       * min/max retrigger window (`mfAmbientSoundMinTime/MaxTime[]`), with
       * `ChangeSoundState()` crossfading between states over ~3s. That machine —
       * not footsteps — is what makes Amnesia's monster a presence.
       *
       * No growl/roar/snarl asset ships with this game, so the vocals are
       * synthesized (see audio.ts `makeVocal`): a jittered glottal pulse train in
       * the 90-160 Hz range plus a noise breath component, driven through three
       * formant bandpasses. A throat is a pitched source in a resonant tube;
       * bandpassed noise at 340 Hz is neither, which is why the old breath bed
       * read as nothing.
       */
      vocal: {
        /** Crossfade between vocal states. HPL2 uses FadeOut(3.0f). */
        stateFade: 3.0,
        /** How many distinct variants to bake per state, so it never loops audibly. */
        variants: 3,

        /**
         * ----------------------------------------------------------------------
         * ROUGHNESS IRREGULARITY — the fry is a BAND, not a line.
         * ----------------------------------------------------------------------
         *
         * `rough` (per state, below) sets how fast the vocal folds beat: slow
         * reads as a groan, fast as a snarl. That parameterisation is right and
         * these values do not change it — they change how REGULAR it is.
         *
         * The shipped synthesis drove roughness with a single fixed-frequency
         * sine. Measured on the amplitude-modulation spectrum in the vocal-fry
         * band, 8-80 Hz, as peak/median — a pure tone scores high, a real
         * vocalisation scores low (`tools/aud/streamjudge.py`):
         *
         *   idle-0/1/2     13.31 / 12.75 / 15.45   all peaking at exactly 17.0 Hz
         *   alert-0/1/2    11.09 /  9.39 / 10.98   all at exactly 25.9 Hz
         *   hunt-0/1/2      8.66 /  7.71 /  8.26   all at exactly 40.6 Hz
         *   JUMPSCARE(ref)  3.10                         at 43.4 Hz
         *
         * Every variant of every state peaked at precisely its own `rough`
         * value. That is the signature of a synthesizer: all the fry energy at
         * one frequency, so the ear hears a buzz at a constant rate rather than
         * tissue. The authored throat spreads the same energy over a band.
         *
         * Swept offline before anything was built (`tools/aud/protorough.py`),
         * the same way the formant glide was — and as there, the offline model
         * reproduces the shipped sine's numbers first, which is what makes it
         * trustworthy. Chosen values, mean of 3 seeds:
         *
         *   state   sine    shipped now   reference
         *   idle    12.09      6.62         3.10
         *   alert   13.78      4.18
         *   hunt    12.35      3.04
         *
         * Bought for nothing: `centStd` moves 4.01->4.12 / 4.60->4.59 /
         * 4.16->4.16, all far above the 1.61 reference-body floor, and envelope
         * loopiness IMPROVES in every state (0.419->0.352, 0.537->0.389,
         * 0.441->0.323) because a wandering rate cannot line up with itself the
         * way a fixed one does. Verified by `tools/aud/protorough_check.py`.
         *
         * The MEAN rate is preserved exactly, so the groan/snarl distinction the
         * state machine depends on is untouched.
         */
        /** Fractional excursion of the beating rate about its nominal. */
        roughWander: 0.65,
        /**
         * How fast the rate itself is allowed to wander, in control points per
         * second. Too slow and each utterance has one rate; too fast and the
         * walk becomes noise rather than a wander.
         */
        roughWalkHz: 11.0,
        /**
         * A second, faster component on the rate. A single smoothly-wandering
         * rate still concentrates near its mean; this is what actually fills the
         * band. Measured: hunt 3.81 without it, 3.04 with.
         */
        roughSecond: 0.22,
        /**
         * Ratio of `rough` to that second component's frequency. Deliberately
         * irrational-ish so the two never lock into a repeating pattern, which
         * would put a line back into the spectrum at the beat frequency.
         */
        roughSecondRatio: 2.7,

        /**
         * ----------------------------------------------------------------------
         * THE FORMANT BANK — why F2 was starved, and what it is set to now.
         * ----------------------------------------------------------------------
         *
         * An independent critic measured the shipped PCM directly, with no
         * peak-picking: energy in each CONFIGURED formant band, relative to F1.
         *
         *   authored jumpscare.ogg   F2/F1  -1.8 dB   F3/F1 -11.0 dB
         *   Billy, every buffer      F2/F1  -6.8..-9.6   F3/F1 -11.8..-17.5
         *
         * F1-dominance of that size is exactly what makes a sound read as
         * filtered buzz rather than a throat — the ear identifies a vocal tract
         * largely by the F1/F2 relationship, and ours had buried F2.
         *
         * Independently, spectral-envelope peak extraction found a clean
         * three-formant structure in the kill (813/1469/3157 Hz) but essentially
         * ONE dominant low peak in Billy that barely moved across the whole state
         * machine: 375 -> 406 -> 438 Hz for idle -> alert -> hunt. That is 2.7
         * semitones total, while the table below asks for 420 -> 700 on F1, a 1.4x
         * shift. So the configured formants were NOT surviving into the audio: the
         * state machine was changing pitch and roughness around a FIXED resonator
         * instead of changing the shape of a tract.
         *
         * TWO causes, both found by reproducing the shipped bank offline in
         * `tools/aud/protoformant.py` before changing anything — the same
         * discipline `protorough.py` used, and the reason the conclusion is
         * trustworthy: the model reproduces the FAILING numbers first
         * (F2/F1 -7.4..-11.3, F3/F1 -11.9..-16.7, peak pinned at 469 Hz).
         *
         *  1. The weight table multiplied lanes that were already unequal, so the
         *     two effects stacked. Measured per lane, hunt, before any weight:
         *     F2 -6.6 dB and F3 -10.1 dB relative to F1. Applying [1, .55, .28]
         *     on top delivered -11.8 and -21.1 dB. `audio.ts` now normalises each
         *     lane to unit RMS BEFORE weighting, so these numbers mean what they
         *     say.
         *  2. The glottal source's own -12 dB/octave tilt starved the upper
         *     formants of excitation at birth. Corrected by `radiationTilt`.
         *
         * Result, verified offline over 3 seeds, and the peak now TRACKS the
         * config — driving F1 420/560/700/900 moves the measured peak
         * 365/500/594/729 Hz, where before it sat at ~469 Hz for every state:
         *
         *   state   F2/F1   F3/F1   dominant peak   (target: F2 >= -3 dB)
         *   idle     0.0     -8.8      396 Hz
         *   alert   -0.3     -9.6      504 Hz
         *   hunt     1.1     -7.7      594 Hz
         */
        /**
         * Formant amplitudes, linear gain, applied AFTER each lane is normalised
         * to unit RMS. F2 sits level with F1 to match the kill's own measured
         * -1.8 dB; F3 is the brightness sheen and is deliberately well down, near
         * the kill's -11.0.
         */
        formantGains: [1.0, 1.0, 0.20],
        /**
         * Per-formant Q. Higher than the old [7, 9, 11] so each resonance is a
         * genuine PEAK over the surrounding floor rather than a broad band that
         * merges with its neighbours — the critic asked for real Q around 8-12.
         * Rising with formant number, as in a real tract where the higher
         * resonances are more sharply tuned.
         */
        formantQ: [10, 12, 14],
        /**
         * Lip-radiation pre-emphasis on the glottal source, as a one-zero
         * highpass coefficient. This is the missing half of the source-filter
         * model: radiation from the lips is a +6 dB/octave differentiator, and
         * without it the synthesis had a glottis and a tract but no mouth
         * opening. Measured long-term spectral slope over 200-4000 Hz:
         *
         *   jumpscare.ogg (authored)  -19.5 dB/decade
         *   Billy, tilt 0             -26.1 (idle) .. -28.8 (hunt)
         *   Billy, tilt 0.85          -19.9 (idle) .. -14.9 (hunt)
         *
         * 0.85 rather than the textbook 0.95-0.97: the higher values flattened
         * the tilt past the authored reference and started to thin the low body
         * that makes him read as large.
         */
        radiationTilt: 0.85,

        /**
         * ----------------------------------------------------------------------
         * THE THROAT LAYER — material derived from `jumpscare.ogg`.
         * ----------------------------------------------------------------------
         *
         * `jumpscare.ogg` is the ONLY authored creature vocalisation that ships.
         * Everything else he says is synthesized. That split was audible, and it
         * was measured rather than suspected: `tools/aud/judge.mjs` renders every
         * baked buffer to PCM and compares it against the scream on the four ways
         * synthesized growls specifically fail.
         *
         * The verdict, before this layer existed:
         *
         *   name       centStd  loopPk  onsetAir   (centStd in SEMITONES)
         *   jumpscare     6.51   0.898     3.897   <- the authored throat
         *   idle          0.92   0.643     1.428
         *   alert         0.83   0.556     2.271
         *   hunt          0.56   0.630     0.946
         *   notice        0.90   0.621     2.814
         *
         * `centStd` is the frame-to-frame movement of the spectral centroid. A
         * real throat CHANGES SHAPE while it is sounding — the scream sweeps its
         * centroid 30.3 semitones end to end and wobbles 6.51 about its mean. Our
         * synthesis moved 0.56-0.92, i.e. 7-12x less. That single number is what
         * "reads as filtered noise rather than a throat" measures as: three
         * bandpasses at fixed centres are a filter with a setting, not an
         * articulator. It is the most damning number in the whole lane and it is
         * why this layer exists.
         *
         * ⚠ CORRECTED BY ABLATION. An earlier revision of this comment argued the
         * layer was justified because resampling the scream DOWN makes its
         * centroid travel further, and claimed "every slice at 0.55x beats our
         * best synthesized state". **Both halves are false as shipped**, and they
         * were only believed because the layer was never measured against its own
         * absence. `throatMixed: 10` proves the mix RAN, not that it helped.
         *
         * `audio.ts __debugRebakeDry()` now bakes the same specs with the layer
         * omitted, and `tools/aud/judge.mjs` scores both. Centroid movement,
         * semitones, mean of three runs:
         *
         *   state    shipped   ablated   delta
         *   idle        3.82      4.07    -0.25
         *   alert       3.00      4.14    -1.13
         *   hunt        2.58      4.68    -2.10
         *   notice      3.10      4.34    -1.24
         *
         * The layer REDUCES centroid movement in every state, because the slices
         * as actually prepared — resampled AND band-limited to 180-2600 Hz — move
         * far less than the raw file does: measured 2.19 (idle slice), 1.31
         * (alert), 1.30 (hunt), 3.94 (notice). Averaging a 1.3-semitone layer
         * under a 4.7-semitone one can only pull the mean down. The 6.51 quoted
         * above belongs to the whole 3.3s file as a dramatic arc, and survives
         * neither the slicing nor the lowpass.
         *
         * KEEP IT ANYWAY, for the reason it should have been argued from in the
         * first place — KINSHIP, which is what the brief actually asked for and
         * what `tools/aud/kinship.mjs` measures. Cosine similarity of the
         * long-term average spectrum (log grid, 180-5000 Hz, shape only) against
         * `jumpscare.ogg`:
         *
         *   state     shipped   ablated   delta
         *   hunt       0.5575    0.1136   +0.44
         *   notice     0.3618   -0.1253   +0.49
         *   alert      0.1870   -0.1688   +0.36
         *   idle      -0.1680   -0.1407   -0.03
         *   drag      -0.0703        --          <- control: his BODY, never derived
         *
         * The layer nearly QUINTUPLES hunt's spectral kinship to the scream and
         * takes the notice sting from anti-correlated to positively related. The
         * `drag` control at -0.07 is what proves the metric discriminates rather
         * than rewarding any two buzzes alike.
         *
         * Note `idle` gains nothing (-0.03) — and slice content predicts that
         * exactly: idle is the only state drawing from the 1.10-2.20s DECAYING
         * TAIL rather than the body or the onset. That is left as-is on purpose.
         * Idle is the state where he should read as distant and not yet
         * identifiable; the recognition is meant to ARRIVE with the hunt, which
         * is where the +0.44 lands.
         *
         * So the trade is bought knowingly: ~1-2 semitones of centroid movement,
         * spent on kinship. It is affordable because every state still clears the
         * reference-body floor of 1.61 that `judge.mjs` gates on — hunt is
         * tightest at +0.97 — and all four still pass all four failure modes.
         *
         * The slice boundaries are read off a 50ms RMS + centroid profile of the
         * actual file, not guessed:
         *
         *   0.00-0.22s  centroid 4588 -> 2844 Hz, the AIRFLOW BURST as the scream
         *               starts. This is the onset transient the synthesis had no
         *               way to make; `hunt` measured 0.946 (air QUIETER at onset
         *               than mid-utterance, i.e. it faded up into existence).
         *   0.20-1.10s  centroid 2305 -> 1451 Hz, the sustained scream. The body.
         *   1.10-2.20s  centroid ~1000 Hz, the decaying tail. Low grit.
         *
         * Deliberately NOT used above 2.2s: the file's last second decays to an
         * RMS of 0.0005 and its centroid climbs back to 2272 Hz, which is the
         * encoder's noise floor, not the creature.
         */
        throat: {
          /**
           * Master level of the derived layer, per state. This sits UNDER the
           * synthesis, not instead of it: the synthesis carries the pitch gesture
           * that tells the player which state he is in (rising = interrogative,
           * falling = settling), and this carries the grit and the movement that
           * make it read as tissue. Mixing rather than replacing is why the state
           * machine's meaning survives.
           *
           * Hunt is loudest because hunt is the state that has to be recognisably
           * the same creature as the kill.
           */
          idleGain: 0.30, alertGain: 0.42, huntGain: 0.62, noticeGain: 0.70,
          /**
           * Which slice each state draws from, in seconds into `jumpscare.ogg`,
           * and what playback rate it is read at.
           *
           * Rates are all well below 1: he is a big thing, and the scream is
           * authored at the pitch of a child's face 30cm from yours. Reading it
           * slow both drops it into his register and lengthens it into something
           * that can sit under a 1.5-2.4s utterance.
           */
          idle: { from: 1.10, to: 2.20, rate: 0.42 },
          /**
           * WAVE 6: alert moved off hunt's slice. The critic measured alert-vs-hunt
           * band-profile correlation at 0.949 — nearly the same sound — against a
           * properly-distinct idle-vs-hunt 0.594, and the derived layer was part
           * of the cause: both states read the SAME 0.20-1.10 s stretch of the
           * scream at only 0.55 vs 0.72 rate, so the strongest shared component
           * in each was near-identical material.
           *
           * Alert now draws 0.95-1.75 s — past the scream's body, into the region
           * where it is breaking up into the rattle. That is dramatically right as
           * well as measurably distinct: alert is "something moved, where", a
           * throat catching rather than committing. Hunt keeps the body, because
           * hunt is the state that must be recognisably the thing that ends up
           * screaming in the player's face.
           */
          alert: { from: 0.95, to: 1.75, rate: 0.61 },
          hunt: { from: 0.20, to: 1.10, rate: 0.72 },
          /**
           * The notice sting takes the ONSET slice — the airflow burst — because
           * that is literally the sound of the scream beginning. When he spots
           * you, you hear the first 200ms of your own death, pitched down.
           */
          notice: { from: 0.00, to: 0.30, rate: 0.62 },
          /**
           * Highpass and lowpass applied to the derived slice before it is mixed
           * under the synthesis, Hz.
           *
           * The lowpass matters most: the raw scream is bright and sibilant, and
           * mixed in flat it sat ON TOP of the synthesis instead of under it,
           * which read as two sounds rather than one voice. Rolling the top off
           * leaves the grit and the movement while letting the synthesized
           * formants stay the brightest thing in the mix — so the layer reads as
           * the same throat rather than as a sample playing behind a growl.
           *
           * The highpass keeps the derived layer out of the way of his
           * fundamental, which the synthesis owns.
           */
          hp: 180, lp: 2600,

          /**
           * Attack ramp on the DERIVED layer only, seconds.
           *
           * This exists so the articulation gesture never has to be flattened to
           * buy a smooth onset again. The previous wave measured `onsetAir` at
           * 15.17 against the reference's 3.897 — an onset four times more abrupt
           * than a real scream's, which reads as a click — and paid for it by
           * HALVING the formant glide. That was the wrong currency: it bought a
           * smooth onset with the one gesture that made him sound like a throat.
           *
           * The abruptness was never the synthesis. It is that `notice` (and, at
           * its `from: 0.20` boundary, hunt/alert) reads material at or near the
           * scream's own hard attack, and drops that transient in at full level
           * on sample zero. A short raised-cosine fade-in on the derived layer
           * alone removes the discontinuity while leaving both the synthesized
           * onset and the whole glide untouched — the airflow burst still
           * arrives, it just arrives as air rather than as an edit.
           *
           * 18 ms: long enough to remove the step (well over a cycle at the
           * 180 Hz highpass corner below), short enough that the transient still
           * reads as a transient. The synthesized envelope's own attack is 6% of
           * the utterance — 90 ms on hunt — so this is deliberately much faster
           * and does not blunt the leading edge of the utterance itself.
           */
          attack: 0.018,
          /**
           * How much the derived layer is allowed to modulate in level against
           * the synthesis, 0..1. The two are envelope-matched (see audio.ts
           * `bakeThroat`) so the derived material follows the utterance's own
           * shape rather than fighting it.
           */
          envFollow: 0.85,
        },

        /**
         * FORMANT GLIDE. The other half of the static-centroid fix, and the half
         * that belongs to the synthesis itself.
         *
         * Three bandpasses at FIXED centres cannot do anything but sit still, so
         * the synthesized layer measured 0.56-0.92 semitones of centroid movement
         * against the authored throat's 6.51. A throat articulates: the tongue
         * and jaw move while the sound is being made, and F1/F2 slide with them.
         *
         * These are multipliers on the state's formant centres, swept across the
         * utterance. A creature closing its mouth as a groan dies drops F1; one
         * opening into a snarl raises it. The values are per-state below.
         */
        glide: {
          /**
           * Formant multiplier at the START and END of the utterance. 1.0 at both
           * would be the old fixed-filter behaviour.
           *
           * Deliberately larger on F2/F3 than on F1: in real speech and in real
           * animal vocalisation the higher formants travel further, because they
           * are set by the front cavity, which is what actually moves. A uniform
           * multiplier just transposes the whole spectrum and reads as a pitch
           * bend rather than as articulation.
           */
          /**
           * These spans are WIDE — F2 travels by a factor of ~3.4 across an
           * utterance — and they were widened from a first, timid pass because
           * that pass was measured and did not do enough.
           *
           * First attempt (1.10->0.86 on F1, 1.34->0.74 on F2) lifted `hunt` from
           * 0.56 to 1.73 semitones of centroid std against the scream's 6.51.
           * Better, and still 3.8x short. Rather than guess again, the exact
           * filter bank was reimplemented offline against the same glottal source
           * and swept:
           *
           *   glide span              centStd
           *   shipped (first pass)      1.67   <- reproduces the measured 1.73,
           *                                       which is what validates the model
           *   1.6x wider                3.01
           *   1.6x wider + wobble 0.30  3.78
           *   extreme (2.1x on F2)      4.84
           *
           * `extreme` was rejected deliberately: past about 2x on F2 the sweep
           * stops reading as a mouth changing shape and starts reading as a pitch
           * bend applied to the whole sound, which is a synthesizer gesture and
           * would trade one artificial cue for another. The chosen values sit at
           * the top of the range that still reads as articulation.
           *
           * ⚠ HALVED, and the sweep above is exactly why. That sweep optimised a
           * SINGLE metric — centroid movement within one utterance — and bought it
           * at the cost of a property nobody was measuring: whether the states
           * still sound like different states. The spans it chose were so wide
           * that every state smeared across the same frequency range, so the
           * per-state formant table stopped meaning anything:
           *
           *   state   F1 config   F1 actually spanned (incl. +-30% wobble)
           *   idle       420          200 ..  775 Hz
           *   alert      560          282 .. 1063 Hz
           *   hunt       700          343 .. 1110 Hz
           *
           *   state   F2 config   F2 actually spanned
           *   idle       900          315 .. 2083 Hz
           *   hunt      1500          546 .. 2886 Hz
           *
           * Those are near-total overlaps. A 1.4x configured difference between
           * idle and hunt cannot survive being smeared over a 3-6x sweep, and an
           * independent critic duly measured the consequence: one dominant peak
           * that moved only 375 -> 406 -> 438 Hz across the entire state machine,
           * and between-state timbre that was 98.6% identical. The escalation the
           * whole design depends on was close to inaudible.
           *
           * So the multipliers are pulled halfway back toward 1.0 — the endpoints
           * below are `1 + (old - 1) * 0.5`. Articulation is kept (F2 still
           * travels ~1.9x within an utterance, which is a real mouth gesture) and
           * state identity is given back. The offline sweep in
           * `tools/aud/protoformant.py` measured the trade directly: centroid
           * movement 6.99 -> 4.67 semitones, still nearly 3x the 1.61 sustained-
           * throat reference that `judge.mjs` gates on, while the dominant peak
           * goes from pinned at 469 Hz to tracking 396 / 504 / 594 Hz.
           *
           * The general lesson, and it is the same one that retired the
           * `midFreqStd` gate: a single metric optimised alone will be bought with
           * something it cannot see.
           */
          /**
           * ────────────────────────────────────────────────────────────────────
           * WAVE 6: THESE ARE NOW A THREE-POINT ONE-WAY GESTURE, NOT A RAMP.
           * ────────────────────────────────────────────────────────────────────
           *
           * An independent critic decomposed our spectral-centroid motion into a
           * linear TREND (one-way articulation) plus residual RIPPLE (symmetric
           * oscillation), and the verdict was exact and correct:
           *
           *     jumpscare.ogg (authored)   trend 36.0 st   trend/ripple 4.64
           *     every one of our states    trend 4.4-8.8   trend/ripple 1.27-2.55
           *
           * Ours oscillated about a centre at a fixed ~2-4 Hz and ENDED WHERE IT
           * BEGAN. In the spectrogram that is six evenly-spaced scalloped arches
           * marching across the hunt buffer where the authored throat is
           * broadband and chaotic. That is an LFO, and an LFO is a synthesizer.
           *
           * `tools/aud/gesture.py` reimplements that decomposition and was
           * validated by reproducing the critic's published figures EXACTLY off
           * their own PCM dumps (REF trend 36.00, t/r 4.64, worst 1.5s window
           * 5.66, our best 4.47, hunt t/r 1.81-2.55). Only then was it used here.
           *
           * ⚠ THE 36 st HEADLINE IS NOT THE HONEST TARGET, and the correction
           * matters because chasing 36 would have been chasing an artefact.
           * Bucketed over time, `jumpscare.ogg` is a loud body (0.00-1.30 s,
           * +15.8 -> +9.2 st, RMS 0.35) followed by a 100x DECAY in which the
           * centroid simply rides the level down into the encoder noise floor —
           * the final bucket sits at RMS 0.0029 and swings back UP +12 st, which
           * is noise and not a throat. Sliced to the same 1.5 s our states are:
           *
           *     REF 0.00-1.50 s   trend 14.03   t/r 3.57
           *     REF 0.20-1.70 s   trend 18.49   t/r 4.39
           *
           * So the duration-matched bar is trend >= 14 st at t/r >= 3.5. (Same
           * trap as the `centStd` 6.51-vs-1.61 correction recorded in
           * `docs/handoff/audio-billy-voice.md`: a statistic taken over a 3.3 s
           * dramatic arc is not a statistic about a 1.5 s groan.)
           *
           * THE SHAPE. `start` -> `peak` -> `end`, with the peak reached at
           * `knee` (a fraction of the utterance) and the two halves given
           * separate curvatures. Fast open, slow close. That is what a real
           * articulation does — the airflow snaps the tract open and the tissue
           * then relaxes back — and unlike the old symmetric ramp it does not
           * return to where it started. Swept in `tools/aud/protoglide.py`,
           * which reproduces the shipped build's dry numbers FIRST (model hunt
           * trend 7.99 / t/r 2.15 against the build's measured 9.40-11.16 /
           * 1.90-2.34) before any value below was chosen:
           *
           *     case                          trend   t/r   cstd   asym
           *     SHIPPED hunt                   7.99  2.15   4.40   0.33
           *     just widening the old ramp x2.0  17.57  4.79   6.30   0.37
           *     GESTURE knee 0.14              24.59  4.44   9.09   0.36
           *     GESTURE knee 0.25              15.51  2.10   8.65   0.33
           *
           * The knee is load-bearing: 0.14 -> 0.25 collapses t/r from 4.44 to
           * 2.10, because a peak reached late is a symmetric hump again.
           *
           * WHY NOT SIMPLY WIDEN THE OLD RAMP (the x2.0 row also clears target)?
           * Because a monotonic ramp that wide is a pitch bend applied to the
           * whole sound — the rejection recorded in the "extreme" row of the
           * wave-4 sweep below. The gesture buys the same trend with a real
           * articulation contour, and it buys 2.4 st MORE cstd for it.
           *
           * AND IT DOES NOT COST STATE CONTRAST, which is the property wave 5
           * spent an entire wave recovering and which the previous sweep sold
           * without noticing. Measured as between-state mel distance over
           * within-state variant spread, shipped -> gesture:
           *
           *     idle-hunt    2.63x -> 2.49x
           *     idle-alert   2.58x -> 2.62x
           *     alert-hunt   1.28x -> 1.31x
           *
           * Each state keeps its own peak, so the escalation idle -> alert ->
           * hunt still reads; only the CONTOUR changed, not the identity.
           *
           * ⚠ THE PEAKS ARE NOT AS DEEP AS THE SWEEP'S BEST, AND THAT IS PAID FOR
           * DELIBERATELY. The first build of this gesture used F2 peak 2.10 -> end
           * 0.42 (a 27.9 st span) and it measured beautifully on the very metric
           * this section exists to fix — hunt trend 21.4, t/r 5.48, cstd 7.33,
           * every state clearing the reference's own worst window. It also broke
           * something else, and only an instrument from a DIFFERENT concern caught
           * it:
           *
           *     distance to the authored kill, dB/band
           *     (killkinship.py, lower = more the same throat)
           *                     before    F2 peak 2.10
           *       hunt           2.60         4.17
           *       alert          2.91         4.97
           *       notice         2.90         3.99
           *
           * i.e. the articulation was bought by making him LESS the same throat as
           * the scream he ends up making — which is item 2 of the brief, and the
           * property the derived layer exists to protect. Diagnosed as F2 sweeping
           * so far up that it dumps energy into the F3 measurement band:
           *
           *       F3/F1 dB      kill -10.8   before -9.6   F2 peak 2.10: -1.7
           *
           * Sweeping F3's OWN motion barely moved that number (-1.8 -> -0.1 across
           * its entire range), which is what proved the leak belonged to F2 and
           * not to F3 — worth recording, because F3 was the obvious suspect and it
           * was innocent. The trade is monotonic and was measured, not guessed:
           *
           *     F2 pk/end   trend   t/r   F2/F1   F3/F1
           *       2.10/0.42  24.66  5.04   -3.8    -1.8
           *       1.75/0.50  21.29  4.77   -2.4    -2.9
           *       1.55/0.55  18.71  4.62   -1.3    -4.4   <- chosen
           *       1.40/0.60  16.53  4.29   -0.5    -5.2
           *     authored kill                     -1.6   -10.8
           *
           * 1.55/0.55 keeps trend well above the 14.0 duration-matched target and
           * t/r above the reference's own 4.39, while putting F2/F1 within 0.3 dB
           * of the kill. Same lesson as the retired `midFreqStd` gate and the
           * wave-5 glide halving, arriving a third time: a single metric optimised
           * alone will be bought with something it cannot see. What differs this
           * wave is that the something was caught BEFORE shipping, by re-running
           * every other instrument in the lane against the candidate.
           *
           * F2 spans, peak-to-end: idle 16.2, alert 17.0, hunt 17.9 semitones.
           * That is short of the brief's literal ">= 20 st on F2", and it is short
           * on purpose — the 20 st version exists, was built, was measured, and
           * cost the kinship above. The brief's actual objective, a one-way
           * asymmetric articulation instead of a symmetric LFO, is met with margin
           * on the statistic that defines it (t/r 4.4-5.3 against the reference's
           * own 4.39-4.64), which is the number that matters rather than the span
           * that was standing in for it.
           */
          idle: {
            start: [0.86, 0.76, 0.94], peak: [1.26, 1.48, 1.02],
            end: [0.72, 0.58, 0.90], knee: 0.055,
          },
          alert: {
            start: [0.80, 0.68, 0.92], peak: [1.38, 1.58, 1.05],
            end: [0.76, 0.60, 0.90], knee: 0.05,
          },
          /**
           * Hunt starts less bright than the other states, and that is a
           * correction rather than an inconsistency. With F2 starting at 1.75 the
           * synthesized onset was already the brightest moment of the utterance,
           * and the derived airflow burst then landed on top of it: `onsetAir`
           * measured 15.17 against the reference's 3.897, i.e. an onset four
           * times more abrupt than a real scream's. That reads as a click, not a
           * breath. Backing the start down keeps the airflow transient — which
           * was the whole point, hunt measured 0.946 before any of this — without
           * turning it into a transient artefact.
           */
          hunt: {
            start: [0.80, 0.66, 0.92], peak: [1.40, 1.55, 1.04],
            end: [0.60, 0.55, 0.88], knee: 0.05,
          },
          notice: {
            start: [0.82, 0.68, 0.93], peak: [1.44, 1.62, 1.06],
            end: [0.72, 0.58, 0.89], knee: 0.045,
          },

          /**
           * Curvature of the two halves of the gesture, as exponents on
           * normalised progress. `open` < 1 snaps out of the start (the airflow
           * hitting a tract that has not finished moving); `close` > 1 lingers
           * near the peak and then falls away (tissue relaxing). Equal values of
           * 1.0 would reduce this to two straight log-domain ramps, and setting
           * `peak` equal to `start` reduces it exactly to the OLD single-ramp
           * behaviour — which is what makes the shipped-vs-gesture comparison in
           * `protoglide.py` a controlled one rather than two unrelated synths.
           */
          shapeOpen: 0.5, shapeClose: 1.4,
          /**
           * A slow wobble on top of the sweep, in Hz and as a fractional depth.
           * The sweep alone is a smooth line, and a smooth line still reads as
           * automation rather than as tissue. Real articulation is not monotonic:
           * it overshoots, hesitates and corrects. This is that, and it is what
           * lifts the centroid's STANDARD DEVIATION rather than just its range —
           * the two are separately measured in `judge.mjs` for exactly this
           * reason, and the offline sweep above shows depth 0.14 -> 0.30 buying
           * 0.77 semitones of std on its own.
           *
           * Backed 0.30 -> 0.22 alongside the glide halving, for the same reason
           * and measured the same way. The wobble is a multiplier on the centre,
           * so at depth 0.30 it alone spreads every formant +-30% — which is
           * itself comparable to the 1.4x that separates idle from hunt, and it
           * applies to all three states identically, so it is pure smearing of the
           * distinction. At 0.22 the sweep still overshoots and corrects (the
           * point of having it) without eating the state contrast that the
           * narrowed glide above exists to restore.
           *
           * WAVE 6: 0.22 -> 0.14, and this time the wobble is being cut for the
           * OPPOSITE reason to last time. The wobble IS the ripple term in the
           * critic's trend/ripple decomposition — it is literally the symmetric
           * oscillation being complained about — and with the three-point
           * gesture above now supplying the one-way motion, the wobble no longer
           * has to carry any movement at all. Its only remaining job is to stop
           * the gesture reading as clean automation. Swept:
           *
           *     wobbleDepth   trend   t/r
           *        0.22       21.56  3.36
           *        0.16       21.65  3.64
           *        0.10       21.68  3.81
           *
           * Trend is untouched (the gesture owns it) and t/r improves monotonically
           * as the ripple shrinks. 0.14 keeps an audible irregularity while
           * leaving the articulation clearly dominant.
           */
          wobbleHz: 3.7, wobbleDepth: 0.14,
        },

        /** Patrol: low intermittent groans, long gaps. He is somewhere, not here. */
        idle: {
          gain: 0.85,
          minGap: 4.5, maxGap: 11.0,
          /** Fundamental sweep across the utterance, Hz. */
          f0: 96, f0End: 84,
          /** Formant centres — a slack, open throat. */
          formants: [420, 900, 2300],
          /** Seconds. Long, unhurried. */
          length: 2.4,
          /** Ratio of voiced pulse train to breath noise. */
          voiced: 0.72,
          /** Depth of the slow amplitude wobble that keeps it from being a drone. */
          tremolo: 0.35,
          /** Growl rate: sub-audio roughness modulating the source, Hz. */
          rough: 17,
        },

        /** Suspicion: a rising interrogative growl. Something moved. Where. */
        alert: {
          gain: 1.0,
          minGap: 2.0, maxGap: 4.5,
          /** Rises. This is the whole gesture — an upward pitch reads as a question. */
          f0: 108, f0End: 158,
          formants: [560, 1250, 2700],
          length: 1.5,
          voiced: 0.8,
          tremolo: 0.22,
          rough: 26,
        },

        /** Hunt: continuous snarling. Almost no gap — it should never let up. */
        hunt: {
          gain: 1.15,
          minGap: 0.35, maxGap: 1.1,
          f0: 132, f0End: 118,
          formants: [700, 1500, 3100],
          length: 1.5,
          voiced: 0.85,
          tremolo: 0.18,
          /** Fast roughness — the rattle that reads as a snarl rather than a moan. */
          rough: 41,
        },

        /**
         * The notice sting. One-shot, fired the frame he actually spots you,
         * alongside the chase crossfade. Amnesia gives you this half-second of
         * "he has seen me" before the music has even arrived.
         */
        notice: {
          gain: 1.5,
          f0: 120, f0End: 205,
          formants: [640, 1400, 3000],
          length: 1.1,
          voiced: 0.88,
          tremolo: 0.1,
          rough: 33,
          /**
           * The sting is the one monster sound allowed to bypass some of his
           * occlusion filter — he has just seen you, and burying the single most
           * informative sound in the game behind a wall wastes it. Fraction of the
           * way from his current cutoff toward wide open.
           */
          clarity: 0.55,
        },
      },
    },

    /**
     * Random knocks. Each one is given a distance, and volume + cutoff + reverb
     * all move together off that single number. Attenuating volume alone just
     * sounds like a soft knock right beside your ear.
     */
    knock: {
      minGap: 22, maxGap: 55,
      /**
       * LEVEL STAGING, and this number is the whole reason knocks work at all.
       *
       * `volume` was 0.6, which put a NEAR knock at about 0.53 peak — roughly 9 dB
       * over the bus compressor's -18 dB threshold. At 4:1 that knock got squashed
       * while the far one, sitting under the threshold, sailed through untouched,
       * and the compressor quietly ate most of the difference between them.
       *
       * Measured, same two knocks, only the limiter threshold changed:
       *   threshold -18 (shipped): near 0.498, far 0.387 -> 2.2 dB apart
       *   threshold   0 (relaxed): near 0.590, far 0.192 -> 9.8 dB apart
       *
       * So 7.6 dB of the distance cue was being removed AFTER the mix. The source
       * spread below is genuine and always was; it simply never reached the ear,
       * which is exactly the kind of fault that survives a source-code review and
       * only shows up in the output. Dropping the level so the near knock lands
       * near the threshold rather than well over it lets the spread survive.
       *
       * Tuned in two passes against the measured output, not guessed:
       *   0.60 -> 2.2 dB spread (original; compressor eating it)
       *   0.34 -> 7.5 dB across 14 real draws, but still non-monotonic at the top
       *           (a 0.16 draw beat a 0.32 draw, i.e. the loud end was still
       *           riding the knee)
       *   0.22 -> see below; keeps the whole range under the knee so louder
       *           really is louder.
       */
      volume: 0.22,
      maxPan: 0.9,
      /**
       * Near/far level spread. A critic measured only a 2.21x peak variation
       * across ten knocks, which is under 7 dB — not enough for "that one was
       * right behind me" and "that one was across the maze" to be different
       * events. 1.0 -> 0.14 is 17 dB, which is roughly the difference between a
       * knock one wall away and one four corridors away.
       */
      nearGain: 1.0, farGain: 0.14,
      nearCutoff: 7000, farCutoff: 420,
      nearReverb: 0.2, farReverb: 0.95,
      /**
       * Distance is not uniformly distributed. Squaring the random draw biases
       * toward NEAR knocks, because a knock you can place is frightening and a
       * knock at the edge of hearing is texture — and because most of the maze
       * that is close to you is where he actually walks.
       */
      nearBias: 0.65,
    },

    /**
     * BED bus compressor. Its job is to keep the *bed* tidy — ambience, chase,
     * monster, knocks, footsteps — so the sum does not mush at the ceiling.
     *
     * Read the name literally: this node governs the bed and NOTHING ELSE. The
     * jumpscare does not pass through it (see `scareDynamics` below), because a
     * compressor cannot tell a scare from a bed when they share a bus, and the
     * one sound in this game that must never be tidied is the scare.
     *
     * The knock note above documents this same node eating 7.6 dB of the knock
     * distance cue. That was solved by staging the knock level *under* the
     * threshold rather than by moving the threshold, because the threshold is
     * correct for the bed. Do not raise it to rescue a transient — route the
     * transient around it instead. That is what the scare bus now does.
     */
    dynamics: {
      threshold: -18, knee: 8, ratio: 4, attack: 0.004, release: 0.28,
    },

    /**
     * SCARE bus limiter — a brickwall, and a completely separate node from the
     * bed compressor above.
     *
     * WHY THIS EXISTS, measured off master PCM. The scare already bypassed
     * `duckGain`, so the stage was genuinely being cleared (RMS punch +2.57 dB
     * into a chase bed). But it still ran through the shared -18 dB / 4:1 bed
     * compressor, which gain-reduced it by 7.86 dB and pinned its peak no matter
     * what preceded it:
     *
     *   fired into a QUIET stage : pre 0.2181 -> scare 0.6872  (+9.97 dB)
     *   fired into a CHASE  bed  : pre 0.7012 -> scare 0.6833  (-0.22 dB)
     *
     * A 0.05 dB difference in the scare's own peak across a 10 dB difference in
     * context is the signature of a hard ceiling, not a mix. The scare landed
     * 0.22 dB QUIETER than the corridor it interrupts. In Amnesia the Grunt's
     * attack sting is the loudest event in the game by a wide margin.
     *
     * The correct fix is not to retune the shared node — that would untidy the
     * bed, which is the shared node's entire job — but to give the scare its own
     * path to `master`.
     *
     * These are LIMITER numbers, not compressor numbers: threshold just under
     * 0 dBFS with a 20:1 ratio and a hard knee (`knee: 0`), so the node is
     * transparent until the signal would clip and then stops it dead. It exists
     * solely to keep the summed scare from exceeding the DAC's range and
     * distorting; it shapes nothing. `attack: 0.001` catches the leading edge
     * without softening it, and `release: 0.10` lets go fast so the tail is not
     * pumped down underneath its own onset.
     */
    scareDynamics: {
      threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.10,
    },

    /**
     * OUTPUT ceiling — the last node before the speakers, after the bed bus and
     * the scare bus sum at `master`.
     *
     * This is not redundant with `scareDynamics`, and the distinction was found
     * by measurement rather than reasoned about in advance. A per-bus limiter
     * only ever sees its own bus, so both buses can sit perfectly inside their
     * own ceilings while their SUM does not. Splitting the scare out from the bed
     * compressor removed the node that had previously been holding the total
     * down — badly, by flattening the scare, but it was holding it down.
     *
     * Measured at a real AI-driven catch (patrol -> chase, playing -> caught ->
     * gameover), with both bus limiters in place and nothing on the sum:
     *
     *   bed peak 0.7938, master peak 1.2675, 268 CLIPPED SAMPLES
     *   scareLimiter.reduction at that instant: -0.01 dB
     *
     * The scare bus was within its own ceiling and the output still hard-clipped,
     * because no node owned the sum. Clipping is the one failure worse than a
     * flattened scare: it is audible as crackle at precisely the loudest and most
     * important moment in the game.
     *
     * `-0.5` dBFS with a hard knee, 20:1 and a 1 ms attack: inaudible until the
     * sum would actually clip, then immovable. It does not re-create the original
     * fault, because it engages only on the sum's overshoot — a fraction of a dB
     * — whereas the bed compressor was engaging on the scare's whole transient to
     * the tune of 7.86 dB.
     */
    outputCeiling: {
      threshold: -0.5, knee: 0, ratio: 20, attack: 0.001, release: 0.12,
    },

    /**
     * The jumpscare's own dynamics: clear the stage, hit, then let silence land.
     *
     * Measured off the master analyser, the scare used to come back QUIETER than
     * the material it punctuates. It was attenuating itself twice over, and both
     * mechanisms are now gone (the reasoning is in `audio.ts jumpscare()`):
     *
     *  - it played through `duckGain`, the node it had just pulled down to
     *    `duckTo`. It now plays on `scareBus`, wired past the duck.
     *  - it played through the BED compressor. Diagnosed twice, half-fixed the
     *    first time: an early pass removed a temporary -30 dB clamp but left the
     *    scare summing into the shared limiter at its normal -18 dB / 4:1, which
     *    is still a compressor that cannot tell the scare from the bed. It ate
     *    7.86 dB and pinned the scare's peak at ~0.685 whether it was fired into
     *    silence (pre 0.2181) or into a full chase (pre 0.7012) — 0.05 dB of
     *    movement across a 10 dB swing in context. The scare now has its own
     *    brickwall and its own path to `master`; see `scareDynamics` above.
     */
    jumpscare: {
      /** How far the bed bus drops, and how fast. Fast enough to beat the attack. */
      duckTo: 0.12, duckTime: 0.06,
      /** Hold the bed down this long, then recover over `recover` seconds. */
      hold: 0.9, recover: 1.2, recoverTo: 0.55,
      /**
       * Scare level, on top of the caller's volume. The scare is the loudest
       * thing in the game by design — it is the one moment the mix is allowed to
       * hit the limiter hard, and now that it no longer ducks itself there is
       * real headroom above the bed to spend.
       */
      gain: 1.35,
      reverb: 0.3,
    },
  },

  render: {
    /**
     * Fog colour is the single most important number in this file.
     *
     * It was 0x2a0705 — RGB(42,7,5), which is nearly black. Fog that colour is
     * indistinguishable from an unlit surface, so corridors did not "fall off into
     * red-black murk", they simply ended in void and the maze read as an unlit box.
     * Fog only reads as *volume* when it is visibly brighter and more saturated
     * than the darkness it sits in. This value is the murk you are looking through.
     *
     * It has since been NEUTRALISED as well, from 0x2b1512 to 0x2a201d — same
     * luminance, same warm hue, far less chroma. Measured by brightness band, two
     * thirds of a captured frame was near-black at RGB(3.3, 0.7, 0.6): a red so
     * saturated the metric read it at 0.67 where Amnesia's near-black reads 0.05.
     * Fog is what fills that band, since almost everything past a few metres is
     * fog-dominated. Amnesia's murk is grey; the red belongs to the sky and the
     * beam, and it only reads as red if it has grey to sit against.
     */
    /*
     * NEUTRALISED AGAIN, 0x2a201d -> 0x252120, and this time the measurement was
     * taken in LINEAR space, which is the correction that matters.
     *
     * 0x2a201d is RGB(42,32,29) and looks modestly warm as a hex swatch — sRGB
     * saturation 0.31. But the renderer works in linear light, and the
     * sRGB->linear transfer is a ~2.4 power that stretches the gap between
     * channels: the same colour is (0.0232, 0.0144, 0.0123) linear, a saturation
     * of 0.469. Every "neutralised" fill in this block was picked by eye on its
     * hex value and is therefore about twice as chromatic as intended in the one
     * space the renderer actually works in.
     *
     * This matters more than any other colour here because of AREA. Measured by
     * brightness band on captured frames, the "very dim" band is 42-46% of the
     * frame — by far the largest — and it sits at saturation 0.44-0.46. That
     * band is almost entirely fog, since everything past a few metres is
     * fog-dominated. It is the single biggest contributor to frame saturation,
     * and no post-chain desaturation can reach it without also draining the sky
     * and the torch pool that the grade exists to protect.
     *
     * Luminance is preserved EXACTLY (Y = 0.0161 before and after); only chroma
     * is scaled toward that luminance, to a linear saturation of 0.22. So this
     * changes the colour of the murk without changing how much murk there is,
     * and the fog still reads warm-grey rather than neutral grey.
     */
    fogColor: 0x252120,
    /**
     * FogExp2. Measured falloff at this density:
     *   5m -> 13%, 15m -> 74%, 30m -> 99%.
     * That is the target: near geometry stays legible, the middle distance goes
     * soft and coloured, and nothing 30m away is readable — you can never see the
     * whole maze, which is the entire point of a maze.
     */
    fogDensity: 0.075,
    /**
     * Fog is not one colour. Looking up a corridor slot toward the burning sky has
     * to glow hotter than looking down a corridor at floor level, or the fog reads
     * as flat grey gauze pasted over the frame. `fogSkyColor` is mixed into
     * `fogColor` by view elevation in a patched fog shader — see world.ts.
     *
     * This one stays SATURATED, unlike `fogColor` beside it, and that split is the
     * point. Ground-level murk was neutralised to grey-brown because two thirds of
     * every frame is near-black and a red near-black tints the whole image. But
     * the fog you see looking UP a corridor slot is lit by the burning sky, and it
     * is one of the few things here that is supposed to be red. Keeping this hot
     * while the other goes grey is what gives the frame a colour axis at all:
     * neutral at your feet, red overhead.
     */
    fogSkyColor: 0x8f2010,
    /**
     * You see the sky by looking up a slot between 6.5m walls, so the *top* of the
     * dome is the part that actually gets seen. Making it near-black reads as "the
     * sky is broken", not "the sky is ominous" — it has to carry real red.
     */
    skyTop: 0x6b160b,
    skyHorizon: 0xc4381a,
    /**
     * Multiplier on the sky dome's own emitted radiance, applied at the end of
     * its shader.
     *
     * The two colours above are hex, so after three's sRGB->linear conversion the
     * brightest part of the dome sits at about 0.15 in LINEAR units. That is not
     * a sky; that is a dim red surface. Two things go wrong downstream at that
     * level, and neither is fixable in the grade:
     *
     *   - the post chain's bright-pass threshold is 0.68 linear, so the sky never
     *     blooms, and the one part of the frame that should have a soft glow is
     *     the one part that is pin-sharp;
     *   - the desaturation gate uses that same bright-pass to decide what is a
     *     light source worth keeping colour in, so the sky got drained to salmon
     *     along with the corridor walls. Measured: the look-up frame went from
     *     roiling red cloud to flat dull brown the moment desaturation started
     *     working properly.
     *
     * 2.6 puts the brightest cloud rifts just over the bright-pass threshold and
     * leaves the dark clots well under it, so the bright-pass separates cloud
     * STRUCTURE rather than lighting the whole dome uniformly. 7.0 was tried
     * first and overshot badly: the frame's mean luminance went to 35 against
     * real Amnesia's 16-18 and the sky read as a lava lamp — bright orange rifts
     * with no menace in them. The sky has to stay murk you are looking *through*,
     * not a light you are looking *at*.
     *
     * This changes only the visible dome. The light the sky CASTS is the separate
     * hemisphere light in game.ts and is unaffected.
     */
    skyRadiance: 1.9,
    /**
     * How far the sky dome is hazed toward `fogSkyColor`, strongest at the horizon
     * and clearing toward the zenith. See the note in the dome's shader.
     *
     * The sky opts out of three's fog, so without this it is the one surface in
     * the game with no air between it and the eye. That did not matter while the
     * colour grade was flattening it anyway; the moment the sky was correctly
     * exempted from desaturation it started reading as a flat vermilion card
     * behind the maze rather than as weather a long way off.
     */
    skyHaze: 0.72,
    /**
     * Ambient and hemisphere colour, and why they are no longer near-pure red.
     *
     * These were 0x832a1e and 0xa32d13. In LINEAR terms 0xa32d13 is
     * (0.374, 0.022, 0.003) — a saturation of about 0.99. Every surface the torch
     * is not pointed at was therefore lit by an essentially monochromatic red
     * light, and measured mean HSV saturation across a frame came out at 0.59-0.83
     * against real Amnesia's 0.068. No grading fixes that: the colour grade can
     * only drain what the lighting put there, and draining it hard enough to reach
     * the target also drained the sky, which is the best thing in the build.
     *
     * The fix belongs upstream, in the light. Amnesia's fill is a cold near-grey
     * and its warmth comes from the lamp alone; the red here has to behave the
     * same way — a CAST over grey, not a wash of pure red. These values keep the
     * same hue and the same luminance and simply stop being saturated to the rail,
     * which lets the beam and the sky be the only strongly coloured things in the
     * frame, which is what makes them read at all.
     */
    /*
     * 0x6e554f -> 0x635956, for the linear-space reason given at fogColor above:
     * the old value reads sRGB saturation 0.28 but LINEAR saturation 0.499, and
     * linear is what lights the scene. Luminance preserved exactly (Y = 0.1038);
     * chroma scaled to a linear saturation of 0.24.
     *
     * This is the light that reaches every surface the torch is not pointed at,
     * so its chroma is multiplied into most of the frame's area. Amnesia's fill
     * is near-neutral and its warmth comes from the lamp alone; the red here has
     * to behave the same way — a cast over grey, not a wash of red.
     */
    ambientColor: 0x635956,
    /**
     * Just enough that walls have shape outside the beam. Push this up and the
     * dark stops being dark; push it to zero and the maze becomes a void with a
     * torch in it, which reads as broken rather than frightening.
     *
     * Raised from 3.1 on a measurement, not a hunch. Splitting a frame into
     * brightness bands and comparing against real Amnesia:
     *
     *   band          ours before      Amnesia
     *   near-black       62%             46%
     *   dim              26%             43%
     *
     * Amnesia is not darker than us; it has far MORE of the frame sitting in the
     * dim band just above black. That band is where its architecture lives — the
     * critic's phrase was "Amnesia's black always has an edge in it". Ours was
     * genuinely void: nearly two thirds of every frame carried no information at
     * all, so the corridor had no shape except where the torch was pointed and
     * turning a corner revealed nothing until the beam swung round to find it.
     * At 18 the near-black band falls to 48.5%, which matches.
     */
    /*
     * HALVED 18.0 -> 9.0, together with hemiIntensity 60 -> 30 and a matching
     * rise in `exposure`. The note above is still right about WHY fill exists —
     * a frame of pure void has no architecture in it — but 18/60 had overshot,
     * and the reason it took this long to see is worth recording.
     *
     * The image had two faults that look like opposites: meanLum 11.9 against a
     * 16-18 target (too dark overall) while nearBlackFrac was 0.376 against 0.45+
     * (not enough true black). Six measured rounds of the tone curve's toe and
     * exposure could not fix both — every setting that put meanLum in band drove
     * blk% to 0.407-0.419, and every setting that reached blk% 0.50+ dropped
     * meanLum to 12.8-13.5. That is inevitable: both are GLOBAL curve knobs, so
     * they slide the whole histogram rather than changing its shape.
     *
     * The fill is what actually sets the shape, because it is a floor UNDER every
     * pixel the torch does not reach. Cutting it deepens the black without
     * touching the pool, and the exposure raise then buys the mean back from the
     * pool alone. Measured, five bearings, median:
     *
     *   ambient/hemi  exposure   midFreq   lum   litF    sat  satNB  blk%
     *   18 / 60         3.10       15.75  15.29  0.138  0.091  0.069  0.461
     *   12 / 40         4.60       17.14  18.35  0.155  0.097  0.068  0.432
     *   9  / 30         4.60       17.59  17.05  0.147  0.098  0.066  0.500
     *   7  / 24         5.60       18.23  18.95  0.160  0.104  0.066  0.490
     *   Amnesia                    30.69  16.6   0.105  0.118  0.080  0.636
     *
     * 9/30 is the point where all of meanLum, litFrac, saturation and blk% are in
     * band at once. Below it (7/24) the frame starts clipping — 0.107% against
     * 0.076% — because the exposure needed to hold the mean up begins blowing the
     * beam core, which is the one thing this lane must not do.
     *
     * The dim band the note above was protecting is NOT lost: midFreqStd measured
     * in lit pixels goes UP, 15.75 -> 17.59, because the light that remains is
     * concentrated where there is geometry to rake across instead of being spread
     * flat over every surface as an even wash.
     */
    ambientIntensity: 9.0,
    /**
     * Red light spilling down from the sky, and the near-black bounce off the
     * floor. The maze is roofless, so this is the light that gives every wall a
     * faint bloody rim and keeps unlit corridors legible as ARCHITECTURE rather
     * than as void. Measured at the previous 3.4 the frame was 95% pure black
     * outside the beam, which reads as a broken renderer, not as darkness.
     */
    /**
     * The sky's fill and the floor's bounce, both DESATURATED from the near-pure
     * red they used to be. 0xa32d13 is (0.374, 0.022, 0.003) in linear terms — a
     * saturation of 0.99 — so every surface the torch was not pointed at was lit
     * by monochromatic red, and the whole frame read as tinted. Amnesia's fill is
     * near-neutral and its warmth comes from the lamp alone. Same hue, same
     * luminance, a third of the chroma.
     */
    /*
     * 0x8f7067 -> 0x817471, same linear-space correction as fogColor and
     * ambientColor above: sRGB saturation 0.28 but LINEAR saturation 0.506.
     * Luminance preserved exactly (Y = 0.1841); chroma scaled to 0.24 linear.
     */
    hemiSky: 0x817471,
    hemiGround: 0x0a0706,
    /**
     * Raised from 11 alongside `ambientIntensity`, and for the same measured
     * reason: the frame needed far more of itself in the dim band just above
     * black, where shape lives, and almost none of that can come from a torch
     * whose cone covers a tenth of the view.
     *
     * HALVED 60 -> 30 alongside `ambientIntensity` 18 -> 9, with `exposure`
     * raised to compensate. The full measurement table and the argument are in
     * the note on ambientIntensity above; these two are one change and must be
     * moved together, because what matters is the total fill under the beam.
     */
    hemiIntensity: 30.0,
    /** Shadow map resolution for the flashlight. Dropped automatically on slow frames. */
    shadowMapSize: 1024,
    /**
     * The slow drift behind the main menu, which is composited over the live maze
     * rather than over a void (see `Game.updateMenuCamera`).
     *
     * The governing constraint is that a still screenshot must still read as a
     * still. A menu that visibly pans is a screensaver; the intent is that the
     * frame looks like a held shot and only reveals itself as live if you watch
     * it for several seconds. Hence a ~24s yaw period over ~5 degrees — the
     * amplitude is deliberately at the low end of the 4-6 degrees the UI lane
     * asked for, because the FOV is 74 and wide lenses exaggerate yaw.
     */
    menuCamera: {
      /** Seconds for one full left-right-left sweep. */
      yawPeriod: 24,
      /** Half-width of the sweep, radians. ~5 degrees. */
      yawAmplitude: 0.088,
      /** Seconds per bob cycle. Incommensurate with yawPeriod so it never repeats. */
      bobPeriod: 11,
      /** Metres. Centimetres-scale, as a held camera would breathe. */
      bobAmplitude: 0.035,
      /** Radians. Tilted a little down the corridor so floor and wall both read. */
      pitch: -0.06,
    },
    /**
     * Exposure into the ACES curve. This is the number that decides whether the
     * flashlight illuminates the wall or erases it.
     *
     * The flashlight is 160 candela with decay 1.75, so a wall one metre away
     * receives ~160 units of irradiance. ACES saturates to a hard 1.0 for any
     * input above roughly 20 — which meant that at exposure 1.0 every surface
     * from point blank out to about two metres arrived at the post chain already
     * clipped to featureless white. Measured: an 11% pure-white disc filling the
     * middle of the frame with no wood grain, no normal map and no grime visible
     * anywhere inside it. No amount of grading can recover that, because the
     * information is destroyed upstream in the tone mapper.
     *
     * At 0.15 the same wall lands at 0.94 display at one metre, 0.75 at two and
     * 0.36 at four — a real falloff with texture legible along its whole length.
     *
     * 0.15 was still one stop too hot at close range, and the effect was subtle
     * enough to survive a whole build. Measured on a nose-to-wall frame: 7.9% of
     * all pixels above display 200 against real Amnesia's 2.3%, with the top of
     * the histogram bunched into a plateau at 229-245. That plateau is the beam's
     * hot core sitting on the flat part of the ACES shoulder, where a factor-of-
     * two difference in incoming light maps to a couple of display codes — so the
     * plank courses and the timber bands this lane exists to add were being
     * compressed out of existence in exactly the region the torch lights best.
     *
     * This is not a "make it darker" knob. It decides whether the brightest
     * eighth of the image carries information or is a clipped plateau, and it was
     * walked to its value on measurements rather than by eye:
     *
     *   0.150  the shipping value before this pass. 7.9% of a nose-to-wall frame
     *          sat above display 200 against real Amnesia's 2.3%, with the top of
     *          the histogram bunched at 229-245 — the beam's core sitting on the
     *          flat part of the ACES shoulder, where a factor-of-two difference in
     *          incoming light maps to two display codes. The plank courses and
     *          timber bands this lane exists to add were being compressed out of
     *          existence in exactly the region the torch lights best.
     *   0.085  overshot hard the other way: mean frame luminance 4.2 against
     *          Amnesia's 16.7, lit fraction 0.6% against 10.7%. The torch stopped
     *          lighting anything.
     *   0.220  mean luminance 15.1, lit fraction 10.8%. Both land on the
     *          reference, with the highlights still on the curve's slope.
     *
     * Note this number only started doing anything at all during this pass — see
     * the comment on uExposure in post.ts. It used to be handed to
     * renderer.toneMappingExposure, which the post chain makes inert.
     */
    /*
     * RAISED 0.22 -> 2.10, and this is NOT a "make it brighter" change — it is
     * one half of a pair with `uToneToe` in post.ts, which went 0.42 -> 0.66 in
     * the same edit. Read that note; neither number is meaningful alone.
     *
     * The short version: the frame was simultaneously too dark overall (meanLum
     * 11.9 against a 16-18 target) and not dark ENOUGH in the shadows
     * (nearBlackFrac 0.376 against 0.45+). Those are opposite faults, and a single
     * exposure knob trades one for the other — which is exactly how this lane's
     * image tone has oscillated twice. Sliding the whole scene up the log axis
     * with exposure while simultaneously steepening the toe below the anchor
     * separates them: more light in the torch pool AND more true black around it.
     *
     * The large absolute number is an artefact of where the anchor sits, not of
     * the frame being blown out. `uToneGrey` is 1.0 and the curve is in LOG
     * space, so exposure is a shift in stops, and the tanh toe (now 0.70) pulls
     * the bottom back down hard.
     *
     * Settled at 4.60 alongside the fill cut (ambientIntensity 18 -> 9,
     * hemiIntensity 60 -> 30) — see the table on ambientIntensity. Exposure and
     * the fill are the pair that finally separated meanLum from nearBlackFrac,
     * which the toe alone could not: the fill cut deepens the black under the
     * beam, and this buys the mean back from the pool rather than from the whole
     * frame. Measured result: meanLum 17.05, litFrac 0.147, nearBlackFrac 0.500,
     * saturation 0.098, and the wall inside the beam still NON-clipping with
     * mid-frequency detail measurable inside the hot pool.
     */
    /*
     * RAISED 2.20 -> 3.80, paired with `uToneToe` 0.70 -> 0.76 and the new
     * `uShoulderStart` highlight roll-off in post.ts. Read all three together;
     * none of them is meaningful alone.
     *
     * The lane was measured too DARK — meanLum 12.5 against a 16-18 target —
     * with litFrac, saturation, satNearBlack and nearBlackFrac all already in
     * band. So the constraint was to buy luminance without spending any of those
     * four, and in particular without lifting the blacks, since nearBlackFrac
     * 0.68 is correct and was expensive to get.
     *
     * Exposure alone could not do that before, and that is exactly how this
     * metric oscillated twice: raising it brightened the shadows as much as the
     * pool, while the extra light at the top simply piled up against a hard clip.
     * The frame was clipping at scene-linear 6.96 — every wall inside about
     * 4.5 m — not in the tone curve, which is asymptotic and cannot clip, but in
     * the `uContrast` stage that runs after it. See the uShoulderStart note in
     * post.ts for the derivation and the measurements.
     *
     * With the top rolled off and the toe steepened, the same exposure raise
     * lands where it is wanted: more light in the pool, and the black kept.
     *
     * The value was then re-walked over a BROAD station sample, and that
     * correction matters more than the number. The first sweep took its median
     * over four hand-picked near-wall stations, which are the views that contain
     * the clipping — so they are the right places to judge the roll-off and the
     * WRONG places to judge overall luminance, because they are much brighter
     * than a typical view. It reported meanLum 16.36 for settings that measured
     * 12.50 over 40 stations spread across the whole maze. (Two of the four
     * fixed stations had also stopped facing a wall at all once the maze seed
     * changed — trap 6b — correlating at only 0.24 and 0.29 against their own
     * earlier frames. A fixed world coordinate is not a fixed VIEW here.)
     *
     * Re-swept over stations sampled across the maze, median of 18 views:
     *
     *   exposure/toe   midFreq   lum   litF  satNB  blk%   clip%
     *   3.80 / 0.76      17.51  15.32  0.115  0.056  0.665  0.000
     *   5.00 / 0.80      18.70  16.32  0.128  0.056  0.633  0.000
     *   5.80 / 0.86      19.80  17.37  0.132  0.054  0.646  0.000  <- this
     *   6.80 / 0.84      20.43  20.40  0.156  0.057  0.581  0.000
     *   Amnesia          30.69  16.6   0.105  0.080  0.636    -
     *
     * 5.80/0.86 puts meanLum mid-band at 17.37 with nearBlackFrac still 0.646,
     * against Amnesia's own 0.636, and no clipping. 6.80 reaches a higher
     * midFreq but overshoots luminance to 20.40 and starts spending the black.
     *
     * ---- RAISED 5.80 -> 10.6, paired with uToneToe 0.86 -> 0.98 --------------
     *
     * This is NOT a re-litigation of the table above; the table was measured under
     * a 160 cd / decay 1.75 beam, and that beam has been replaced by a flatter
     * 91 cd / decay 1.40 one to stop the torch core soft-clipping (the full
     * measurement is on CFG.flashlight.intensity). The flatter beam deliberately
     * removes energy from the near field, so the exposure that was correct under
     * the old beam now lands the frame ~3 units short of the 16-18 band.
     *
     * The pairing rule is unchanged and is why both numbers move together:
     * exposure slides the histogram up the log axis, the toe pulls the sub-anchor
     * region back down. Swept alone, exposure took blk% 0.576 -> 0.348 to reach
     * lum 20; the toe alone took lum 12.8 -> 6.0 to reach blk% 0.72. Together they
     * are separable because they act on different ends of the curve.
     *
     * ---- 8.5, NOT the 10.6 a five-beat harness first indicated ---------------
     *
     * Recorded because the error is instructive and this metric has oscillated
     * twice already. A fast custom harness that photographed five beats
     * (corridor / half-up / walk / turn / gem) pooled to meanLum 14.96 at
     * exposure 10.6, i.e. still too DARK, and would have shipped that value.
     * The real `atmosphere.json` gate has ten beats, and its last three —
     * `07-gem_close`, `08-monster_near`, `09-monster_flicker` — are dread frames
     * that the short harness did not reproduce. Measured on the real gate:
     *
     *   beat                  BASE lit / lum      exp 10.6 lit / lum
     *   02-corridor_level      0.074 /  8.8        0.150 / 17.2
     *   07-gem_close           0.127 / 15.1        0.288 / 32.2
     *   08-monster_near        0.134 / 15.5        0.283 / 32.0
     *   09-monster_flicker     0.135 / 15.1        0.282 / 31.1
     *
     * At 10.6 those three frames roughly DOUBLE, and each lands above the
     * measurement tool's `litFrac > 0.25` sky-exclusion rule — so the gate quietly
     * dropped them from the verdict and reported on a different, darker population
     * than the game actually renders. That is trap 16 with a new face: the check
     * still passed its own arithmetic while measuring the wrong subjects.
     *
     * 6.70 is solved from the gate's own response, MATCHED BEAT FOR BEAT so the
     * maze seed cancels. Running the real gate at 8.5 and comparing each beat
     * against the same beat at 5.80:
     *
     *   beat                  5.80    8.50   ratio
     *   01-descend             8.9    18.1
     *   02-corridor_level      8.8    17.8
     *   07-gem_close          15.1    25.2
     *   08-monster_near       15.5    23.8
     *   09-monster_flicker    15.1    24.1
     *   mean ratio                            1.771  over 0.551 stops
     *                                       = 2.82x luminance per stop
     *
     * The 5.80 build's pooled gate median (5 runs, 41 frames) is 13.90, so
     * reaching 17.0 needs log2(17.0/13.90) / log2(2.82) = 0.194 stops, i.e.
     * 5.80 * 2^0.194 = 6.64.
     *
     * Re-fitted once 6.70 had itself been run on the gate over three seeds, which
     * gives a second, tighter estimate of the same slope (ratio 1.317 over 0.208
     * stops = 3.76x per stop) and puts the 17.0 target at 6.44. Two independent
     * beat-matched fits landing at 6.44 and 6.64 bracket the answer; **6.50** is
     * taken as the midpoint, biased slightly low because the 6.70 pool was
     * reading 19.8 against the 16-18 band.
     *
     * A first attempt shipped 8.5 from a fit over single-seed gate runs, and it
     * measured ~8 units hot. Trap 6b is why: one seed swings meanLum by ~4, which
     * is twice a typical tuning step, so a fit over three single-seed points is
     * fitting noise. **Fit on beats matched across the SAME seeds, not on run
     * medians taken from different seeds.**
     *
     * **If you shorten the beat list to iterate faster, re-confirm on the full
     * ten-beat gate before committing a number.**
     *
     * ---- wave-5 gate: the "meanLum is 0.7 HOT" handoff is RESOLVED, and the
     *      answer was NOT to touch this number -----------------------------
     *
     * The wave-4 gate measured pooled `meanLum` 19.70 against a 14-19 band and
     * handed the tone lane `docs/handoff/TONE-MEANLUM-HOT.md` suggesting
     * 6.50 -> ~6.2, explicitly asking for a re-fit rather than a blind take.
     *
     * By the time that was actionable the image had moved underneath it. Two
     * changes landed that both remove energy from the frame:
     *   - `installNearFieldFloor()` (flashlight.nearFloor), which softened the
     *     distance falloff and un-clipped the torch core, and
     *   - wall/floor/trim `normalScale` 1.35/1.05/1.1 -> 0.35/0.30/0.30 in
     *     `world.ts`, applied at the wave-5 gate.
     *
     * Re-measured pooled over **40 frames / 4 seeds** (three of them FIXED, so
     * this is not a seed draw — `TONE-SEED-NOISE.md`, trap 34):
     *
     *     meanLum 14.10 | litFrac 0.104 | sat 0.100 | satNearBlack 0.058
     *     nearBlackFrac 0.597          -> all five metrics PASS
     *
     * `meanLum` is now on the LOW side of the band, not the high side. Applying
     * the handoff's 6.2 would have pushed it OUT of the band in the direction it
     * had already travelled. **A tuning request is a measurement with a
     * timestamp; re-measure before applying one.** Kept at 6.50, which is still
     * the midpoint of the two agreeing beat-matched fits.
     */
    exposure: 6.50,

    /**
     * A grade applied once, at load, to woodWall.png before anything samples it.
     * See gradeAlbedo() in world.ts for the full reasoning; the short version:
     *
     *   - the texture measures mean HSV saturation 0.695, which is where this
     *     build's 0.59-0.83 frame saturation came from against real Amnesia's
     *     0.068, and no downstream colour grade can drain it without also
     *     draining the torchlight it is there to preserve;
     *   - the texture is also very low contrast plank-to-plank, which is the
     *     other half of why a lit wall measured flat.
     *
     * `wallSaturation` is a multiplier on the texture's chroma (0 = grey,
     * 1 = untouched); `wallContrast` a stretch around its own mean luminance.
     * The result is still woodWall.png, and still recognisably wood — the wall
     * material's own tint colour is what carries the remaining warmth.
     *
     * RAISED 0.42 -> 0.72, because the premise above expired.
     *
     * The 0.42 was chosen to pull frame saturation down from a measured 0.59-0.83
     * toward Amnesia's 0.068. Both of those numbers have since turned out to be
     * measuring the wrong thing. The 0.59-0.83 was dominated by a near-black,
     * red-tinted void — two thirds of every frame at RGB(3.3, 0.7, 0.6), which a
     * saturation metric correctly calls "almost fully saturated red" and the eye
     * calls "black". That void was neutralised by uLift in post.ts. And the
     * 0.068 came from a single unrepresentative reference frame; measured across
     * eight official Amnesia screenshots the real figure is 0.48.
     *
     * With the tone curve fixed, the frame now measures 0.43 against that 0.48 —
     * we are UNDER-saturated overall. And in the region that matters most, worse:
     * the brightest 2% of architecture pixels, i.e. the surface the torch is
     * actually resting on, measured saturation 0.181 against Amnesia's torch-lit
     * surfaces at 0.373-0.436. The beam was landing on wood that had already had
     * its colour removed at load time, so no amount of protecting warm pixels
     * downstream could put it back — a desaturation sweep in post moved the core
     * from 0.186 to 0.193 across a 5x range of the protection gain, which is how
     * this was traced here rather than to the grade.
     *
     * Amnesia's timber cellar (am-8f8) reads as warm wood under a torch. That is
     * the target, and it needs chroma in the albedo to work with.
     */
    wallSaturation: 0.72,
    wallContrast: 1.95,

    post: {
      /** Restrained. Bloom is haze around the gems and the sky, never a glow filter. */
      bloomStrength: 0.44,
      bloomRadius: 0.75,
      /** Above wall-highlight brightness, so wood never smears. */
      bloomThreshold: 0.68,
    },

    /**
     * Dust motes drifting in the flashlight cone. This is the cheap stand-in for
     * volumetric light: a few hundred additive points parented to the camera, so
     * the beam has something to catch and the darkness gains volume. Real god-ray
     * raymarching is not affordable at SwiftShader's fill rate.
     */
    dust: {
      /**
       * RAISED 320 -> 900, and it is affordable because the motes are now
       * cone-gated in the vertex shader (see buildDust in world.ts). Under the
       * old constant-opacity PointsMaterial every mote in the 9m box was drawn
       * lit, so the count was a direct trade against "grey haze over the dark"
       * and had to stay low. Now a mote outside the beam evaluates to zero glow
       * and is a discarded fragment, so the count buys density exactly where it
       * is wanted — inside the shaft — and costs nothing anywhere else.
       *
       * 900 points is one draw call and 900 vertex-shader invocations; the scene
       * around it is ~350k triangles.
       */
      count: 900,
      /** Radius of the box of motes carried around the player, in metres. */
      radius: 9,
      /**
       * Metres. This was 0.055 and rendered as unmistakable orange SQUARES — at
       * 1280x720 with size attenuation, a 5.5cm quad two metres from the eye is a
       * ~20px block, and additive blending onto a HalfFloat target made each one
       * blaze. Real dust is a sub-pixel sparkle. 0.013 puts a near mote at about
       * 4px, which twinkles in the beam instead of tiling over it.
       */
      size: 0.013,
      /**
       * Additive, so this stacks wherever motes overlap. Kept low deliberately:
       * dust must only be legible where the beam actually hits it, never as a
       * grey haze lying over the dark.
       */
      /**
       * RAISED 0.3 -> 1.1. This is no longer a literal alpha: the mote shader
       * multiplies it by the cone term, the inverse-square falloff and the
       * forward-scattering term, all of which are well below 1 for most motes.
       * A value above 1 is therefore correct here and only the motes deep inside
       * the beam, seen close to head-on, actually approach full brightness.
       */
      opacity: 1.1,
      /** Metres/second of lazy convection drift. */
      drift: 0.14,
    },
  },
} as const;

export type Config = typeof CFG;
