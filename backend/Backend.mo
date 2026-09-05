// Revenge of The Retrieved 3D — backend canister on the Thebes substrate.
//
// The game runs in the browser; this canister is the authority for
// everything worth cheating at:
//
//  * Tally (runs / captures / deepest ever) — counted only for signed-in
//    Memphis players.
//  * Usernames — a public display name per Memphis identity, unique,
//    shown on the scoreboard.
//  * Scoreboard — DEEPEST LAYER REACHED per player, gems as the tiebreak.
//    The maze loops forever and the fiction is that you never get out, so
//    "how far down did you get before he took you" is the achievement.
//  * Active runs — the anti-tamper core. THE CLIENT NEVER SENDS A SCORE.
//    It opens a run, reports gems one at a time, and reports each descent
//    through a door; the canister keeps depth and gem count itself, behind
//    plausibility floors it can actually verify (its own clock). Dying
//    finalizes at the SERVER's numbers.
//
// What the floors buy, precisely. Someone at the console can drop their own
// calls or end a run early — that only lowers their score. They cannot
// descend faster than `minLayerNs`, cannot collect gems faster than
// `minGemGapNs`, cannot exceed `maxGemsPerLayer` in one maze, and cannot
// submit an invented total, because there is no method that accepts one.
// Time is the load-bearing floor: it is read from `Time.now()` here, so it
// is the one quantity a client cannot lie about.
//
// Replies are JSON-in-text because the frontend's hand-rolled Candid client
// decodes primitives only.
//
// Built with `moc --legacy-persistence` (see thebes.toml): the stable
// fields below survive `deploy --upgrade`. Active runs are transient on
// purpose — an upgrade ends in-flight games, nothing more.

import Map "mo:core/Map";
import Text "mo:core/Text";
import Nat "mo:core/Nat";
import Int "mo:core/Int";
import Char "mo:core/Char";
import Iter "mo:core/Iter";
import Array "mo:core/Array";
import List "mo:core/List";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";

persistent actor Backend {

  // ─── Global tally ──────────────────────────────────────────────────

  var runs : Nat = 0;
  var captures : Nat = 0;
  var deepestEver : Nat = 0;

  // ─── Identity ──────────────────────────────────────────────────────

  transient let maxNameLength : Nat = 64;

  func lowerAscii(t : Text) : Text {
    var out = "";
    for (c in t.chars()) {
      let n = Char.toNat32(c);
      out #= Text.fromChar(
        if (n >= 65 and n <= 90) { Char.fromNat32(n + 32) } else { c }
      );
    };
    out;
  };

  /// Every scoring surface goes through this. A score is only worth
  /// keeping if it is attached to an identity somebody had to prove.
  func requirePlayer(name : Text) {
    let size = Text.size(name);
    if (size < 3 or size > maxNameLength) { Runtime.trap("bad identity name") };
    if (not Text.endsWith(name, #text ".thebes")) {
      Runtime.trap("player must be a Memphis identity (name.thebes)");
    };
  };

  // ─── Player profiles (usernames) ───────────────────────────────────
  //
  // A signed-in player may pick a public username shown on the
  // scoreboard. Stored BY MEMPHIS NAME so scores stay keyed to the stable
  // identity — a rename then updates every display at once, and cannot be
  // used to orphan or duplicate a score.

  let profiles = Map.empty<Text, Text>(); // memphis name -> username
  let usernameIndex = Map.empty<Text, Text>(); // lower(username) -> memphis name

  transient let minUsername : Nat = 3;
  transient let maxUsername : Nat = 24;

  func validateUsername(u : Text) {
    let size = Text.size(u);
    if (size < minUsername or size > maxUsername) {
      Runtime.trap("username must be 3-24 characters");
    };
    for (c in u.chars()) {
      let n = Char.toNat32(c);
      // Control characters would let a name break the scoreboard layout;
      // quote and backslash would break the hand-rolled JSON below.
      if (n < 32) { Runtime.trap("username has invalid characters") };
      if (c == '\"' or c == '\\') { Runtime.trap("username has invalid characters") };
    };
    // Reserved: a username that looks like an identity would let someone
    // impersonate another player's Memphis name on the board.
    if (Text.endsWith(u, #text ".thebes")) {
      Runtime.trap("usernames may not end in .thebes");
    };
  };

  public func set_username(memphisName : Text, username : Text) : async Text {
    requirePlayer(memphisName);
    let trimmed = Text.trim(username, #char ' ');
    validateUsername(trimmed);
    let key = lowerAscii(trimmed);
    switch (Map.get(usernameIndex, Text.compare, key)) {
      case (?owner) {
        if (owner != memphisName) { Runtime.trap("that username is already taken") };
      };
      case null {};
    };
    // Release the old name before claiming the new one, or a rename leaks
    // the previous entry and nobody can ever take it.
    switch (Map.get(profiles, Text.compare, memphisName)) {
      case (?old) { ignore Map.delete(usernameIndex, Text.compare, lowerAscii(old)) };
      case null {};
    };
    Map.add(profiles, Text.compare, memphisName, trimmed);
    Map.add(usernameIndex, Text.compare, key, memphisName);
    trimmed;
  };

  public query func get_username(memphisName : Text) : async Text {
    switch (Map.get(profiles, Text.compare, memphisName)) {
      case (?u) { u };
      case null { "" };
    };
  };

  func displayNameFor(key : Text) : Text {
    switch (Map.get(profiles, Text.compare, key)) {
      case (?u) { u };
      case null { key };
    };
  };

  // ─── Scoreboard: deepest layer, gems as the tiebreak ────────────────

  type Best = { depth : Nat; gems : Nat };

  let scores = Map.empty<Text, Best>(); // memphis name -> best run

  transient let maxEntries : Nat = 1_000;
  transient let topCount : Nat = 10;

  /// Strictly better = deeper, or the same depth with more gems.
  func beats(a : Best, b : Best) : Bool {
    if (a.depth != b.depth) { a.depth > b.depth } else { a.gems > b.gems };
  };

  public query func get_high_scores() : async Text { topJson() };

  func recordBest(player : Text, incoming : Best) {
    switch (Map.get(scores, Text.compare, player)) {
      case (?existing) {
        if (beats(incoming, existing)) {
          Map.add(scores, Text.compare, player, incoming);
        };
      };
      case null {
        if (Map.size(scores) >= maxEntries) { evictLowestBelow(incoming) };
        Map.add(scores, Text.compare, player, incoming);
      };
    };
  };

  /// The board is capped, so a newcomer must beat somebody to get on it.
  func evictLowestBelow(incoming : Best) {
    var minKey : ?Text = null;
    var minVal : Best = { depth = 0; gems = 0 };
    for ((k, v) in Map.entries(scores)) {
      switch (minKey) {
        case null { minKey := ?k; minVal := v };
        case (?_) { if (beats(minVal, v)) { minKey := ?k; minVal := v } };
      };
    };
    switch (minKey) {
      case (?k) {
        if (not beats(incoming, minVal)) {
          Runtime.trap("scoreboard is full and this score does not beat the lowest entry");
        };
        ignore Map.delete(scores, Text.compare, k);
      };
      case null {};
    };
  };

  func escapeJson(t : Text) : Text {
    var out = "";
    for (c in t.chars()) {
      // `validateUsername` already rejects quote, backslash and control
      // characters, so this is belt-and-braces for the Memphis name path
      // (which is shown verbatim when a player has picked no username).
      if (c == '\"' or c == '\\') { out #= "_" } else { out #= Text.fromChar(c) };
    };
    out;
  };

  func topJson() : Text {
    let all = Iter.toArray(Map.entries(scores));
    let sorted = Array.sort<(Text, Best)>(
      all,
      func(x, y) {
        let (_, a) = x;
        let (_, b) = y;
        if (a.depth != b.depth) {
          if (a.depth > b.depth) { #less } else { #greater };
        } else if (a.gems != b.gems) {
          if (a.gems > b.gems) { #less } else { #greater };
        } else { #equal };
      },
    );
    var out = "[";
    var n = 0;
    label build for ((name, best) in sorted.values()) {
      if (n >= topCount) { break build };
      if (n > 0) { out #= "," };
      out #= "{\"name\":\"" # escapeJson(displayNameFor(name)) # "\""
        # ",\"depth\":" # Nat.toText(best.depth)
        # ",\"gems\":" # Nat.toText(best.gems) # "}";
      n += 1;
    };
    out # "]";
  };

  /// A player's own best, so the UI can show "your best" without
  /// scanning the top ten for them (they are usually not on it).
  public query func get_best(memphisName : Text) : async Text {
    switch (Map.get(scores, Text.compare, memphisName)) {
      case (?b) { "{\"depth\":" # Nat.toText(b.depth) # ",\"gems\":" # Nat.toText(b.gems) # "}" };
      case null { "{\"depth\":0,\"gems\":0}" };
    };
  };

  public query func get_stats() : async Text {
    "{\"runs\":" # Nat.toText(runs)
    # ",\"captures\":" # Nat.toText(captures)
    # ",\"deepest\":" # Nat.toText(deepestEver)
    # ",\"players\":" # Nat.toText(Map.size(scores)) # "}";
  };

  // ─── Active runs (server-side score authority) ──────────────────────
  //
  // Transient by design: a run is minutes long and worthless after an
  // upgrade. An upgrade ends in-flight games and nothing else.

  type Run = {
    player : Text;
    depth : Nat; // layers reached — THE score, counted HERE
    gems : Nat; // total gems this playthrough, the tiebreak
    layerGems : Nat; // gems reported in the current maze
    startedAt : Int;
    layerStartedAt : Int;
    lastGemAt : Int;
  };

  transient let activeRuns = Map.empty<Text, Run>();
  transient var runNonce : Nat = 0;

  transient let maxActiveRuns : Nat = 300;
  /// The shipped gem requirement. `?gems=N` can lower it client-side for
  /// testing, which only makes a layer FASTER to clear — the time floors
  /// still apply — so this is a ceiling, not an equality check.
  transient let maxGemsPerLayer : Nat = 7;
  transient let runIdleNs : Int = 10 * 60 * 1_000_000_000; // 10 min
  transient let minGemGapNs : Int = 1_200_000_000; // gems are far apart
  transient let minLayerNs : Int = 20 * 1_000_000_000; // crossing a maze takes time
  transient let maxDepth : Nat = 10_000;

  transient let idAlphabet : [Char] = Text.toArray("abcdefghjkmnpqrstuvwxyz23456789");

  func genRunId() : Text {
    var s = Int.abs(Time.now()) + runNonce * 7919;
    runNonce += 1;
    var id = "";
    var i = 0;
    while (i < 12) {
      s := (s * 6364136223846793005 + 1442695040888963407) % 9_223_372_036_854_775_808;
      id #= Text.fromChar(idAlphabet[s % idAlphabet.size()]);
      i += 1;
    };
    id;
  };

  func getRun(id : Text) : Run {
    switch (Map.get(activeRuns, Text.compare, id)) {
      case (?r) { r };
      case null { Runtime.trap("run not found (it may have expired)") };
    };
  };

  func gcRuns() {
    let now = Time.now();
    let stale = List.empty<Text>();
    for ((id, r) in Map.entries(activeRuns)) {
      if (now - r.lastGemAt > runIdleNs) { List.add(stale, id) };
    };
    for (id in List.values(stale)) {
      ignore Map.delete(activeRuns, Text.compare, id);
    };
  };

  /// A signed-in player enters the maze. Returns the run id every later
  /// call refers to. Depth starts at 1 — you are already in a maze.
  public func start_run(name : Text) : async Text {
    requirePlayer(name);
    gcRuns();
    if (Map.size(activeRuns) >= maxActiveRuns) {
      Runtime.trap("too many active runs — try again in a minute");
    };
    let now = Time.now();
    let id = genRunId();
    Map.add(
      activeRuns,
      Text.compare,
      id,
      {
        player = name;
        depth = 1;
        gems = 0;
        layerGems = 0;
        startedAt = now;
        layerStartedAt = now;
        lastGemAt = now;
      },
    );
    runs += 1;
    "{\"id\":\"" # id # "\"}";
  };

  /// One gem, as it is picked up. Returns the server's running total.
  public func record_gem(id : Text) : async Nat {
    let r = getRun(id);
    let now = Time.now();
    if (now - r.lastGemAt < minGemGapNs) {
      Runtime.trap("gem reported too quickly");
    };
    if (r.layerGems >= maxGemsPerLayer) {
      Runtime.trap("too many gems for one layer");
    };
    let next = {
      r with
      gems = r.gems + 1;
      layerGems = r.layerGems + 1;
      lastGemAt = now;
    };
    Map.add(activeRuns, Text.compare, id, next);
    next.gems;
  };

  /// Through the door and into the next maze. This is the scoring event.
  public func descend(id : Text) : async Nat {
    let r = getRun(id);
    let now = Time.now();
    if (now - r.layerStartedAt < minLayerNs) {
      Runtime.trap("layer completed impossibly fast");
    };
    if (r.layerGems == 0) {
      Runtime.trap("cannot descend without collecting anything");
    };
    if (r.depth >= maxDepth) { Runtime.trap("depth limit reached") };
    let next = {
      r with
      depth = r.depth + 1;
      layerGems = 0;
      layerStartedAt = now;
    };
    Map.add(activeRuns, Text.compare, id, next);
    next.depth;
  };

  /// He caught you.
  ///
  /// THIS DOES NOT END THE RUN, and that is deliberate on two counts.
  ///
  /// The game's own Retry keeps your depth — you died at layer 4, you retry at
  /// layer 4 — so a run that ended here would score 4 and then let the player
  /// carry on to 12 with the server counting from 1 again. The HUD and the
  /// board would disagree for the rest of the session.
  ///
  /// It also happens to be the fiction: "There is no escape... Not even
  /// death..." Death is not an exit from the maze, so it is not an exit from
  /// the run either.
  ///
  /// What it DOES do is bank the score. Dying is the common case and the
  /// moment a player is most likely to close the tab, so the best-so-far is
  /// committed here rather than left to depend on them politely going Home.
  public func die_run(id : Text) : async Text {
    let r = getRun(id);
    captures += 1;
    if (r.depth > deepestEver) { deepestEver := r.depth };
    recordBest(r.player, { depth = r.depth; gems = r.gems });
    let best = switch (Map.get(scores, Text.compare, r.player)) {
      case (?b) { b };
      case null { { depth = r.depth; gems = r.gems } };
    };
    "{\"depth\":" # Nat.toText(r.depth) # ",\"gems\":" # Nat.toText(r.gems)
    # ",\"bestDepth\":" # Nat.toText(best.depth)
    # ",\"bestGems\":" # Nat.toText(best.gems) # "}";
  };

  /// Left for the menu. Banks one last time and closes the run out — this is
  /// the only method that ends one. Still scores: the layers were genuinely
  /// reached, and dropping them would only teach players to alt-F4.
  public func abandon_run(id : Text) : async Text {
    let r = getRun(id);
    ignore Map.delete(activeRuns, Text.compare, id);
    if (r.depth > deepestEver) { deepestEver := r.depth };
    recordBest(r.player, { depth = r.depth; gems = r.gems });
    "{\"depth\":" # Nat.toText(r.depth) # ",\"gems\":" # Nat.toText(r.gems) # "}";
  };
};
