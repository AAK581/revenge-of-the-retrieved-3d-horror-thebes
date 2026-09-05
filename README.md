# Revenge of the Retrieved

A first-person horror maze that runs in the browser and lives on the **Thebes**
substrate.

You murdered a man's son. The father did not go to the law. He conjured a spell
that used your flesh to bring the boy back — and trapped you in the boy's
domain.

Collect what the spell took. Reach the door. Do not let him reach you.

> **There is no escape… Not even death…**

The maze **loops**. Reaching the unlocked door opens it, carries you through,
and shuts it behind you — into a new maze. The scoreboard measures how many
layers deep you got before he took you.

---

## Play

| | Desktop | Mobile |
|---|---|---|
| Move | `WASD` / arrows | left analog stick |
| Sprint | `Shift` | `RUN` button |
| Look | mouse | swipe anywhere |
| Pause | `Esc` | button, top right |

On mobile the view **follows where you are walking**, so you never have to swipe
just to face down the corridor you are already moving along. A deliberate swipe
suspends that briefly, so you can still sidestep while watching something.

An infinite flashlight is your only light. It flickers when he is near, and
holds steady once he is actually chasing you — you have enough to deal with.

## Identity and the scoreboard

Sign-in is **optional**. Anonymous play works exactly the same; it simply is not
counted.

Signing in uses a **Memphis passkey** — no password, and no external wallet to
connect. Pick a name ending in `.thebes`, register a passkey, then choose a
public username for the board.

> Passkeys are bound to the gateway origin, so **sign-in does not work on
> `localhost`**. Deploy first, then sign in there.

Scores rank by **deepest layer reached**, gems as the tiebreak.

**The client never sends a score.** It opens a run, reports each gem as it is
picked up and each descent through a door, and the canister keeps the count
itself behind plausibility floors checked against its own clock. There is no
method that accepts a total, so there is nothing to forge — the worst a tamperer
can do is drop their own calls and score lower.

Dying does not end a run; it banks it. Which is fitting.

## Build and run

```bash
cd frontend && npm install && npm run dev
```

Node 20+. The dev server plays the whole game — only passkey sign-in needs the
deployed origin.

## Deploy

```bash
thebes-deploy identity new default   # once per machine
thebes-deploy setup                  # checks moc / mops / npm
thebes-deploy deploy --network wan-experimental
```

`thebes.toml` is the single source of truth: which network, which canisters, how
they build, who signs. After a deploy the app is served at
`<gateway>/_/raw/<frontend-cid>/index.html`, printed at the end of every run.

### Two things that will bite you

**Keep `--legacy-persistence` in the backend build line.** An upgrade carries the
canister's *stable* memory to a fresh instance of the new module, and
`--legacy-persistence` compiles for exactly that. moc's default keeps state in
*main* memory, which needs replica-side retention this platform does not provide
— the canister would come back up blank. Remove the flag and `deploy --upgrade`
refuses rather than wiping you quietly.

**`.thebes/deployed/<cid>.most` is committed on purpose.** It records the
stable-type signature of what is currently installed. Without it a later
`deploy --upgrade` cannot prove your data survives, so it refuses to run. Keep it
with the source that produced it.

## Layout

```
thebes.toml           deploy manifest — the single source of truth
backend/Backend.mo    the canister: identities, usernames, scoreboard, runs
frontend/src/game/    engine — maze, monster, lighting, audio, controls
frontend/src/lib/     the on-chain client
frontend/public/      shipped assets (models, audio, textures)
```

## Credits

Built with [three.js](https://threejs.org). `passkey.js` is vendored from the
Memphis client — provenance in `frontend/public/passkey.PROVENANCE.md`.
