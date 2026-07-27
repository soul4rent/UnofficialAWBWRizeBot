# Vibe Unofficial AWBW Bot

A Firefox extension that plays the second seat of an [Advance Wars By Web](https://awbw.amarriner.com)
**hotseat** game, using AI logic ported from [DefendPeace](https://github.com/Sri-Vastav/DefendPeace).

Frontend only. **No changes to AWBW are required or made.**

---

## How it works

AWBW's client turns out to be entirely scriptable from the page, which makes the
whole thing simpler than driving synthetic clicks.

**State.** `game.php` declares its game state as top-level `let`/`const` in a classic
`<script>` (`game.php:1185-1300`): `unitsInfo`, `unitMap`, `buildingsInfo`,
`terrainInfo`, `playersInfo`, `moveCosts`, and so on. Those bindings live in the
global *lexical* environment, so they are **not** properties of `window` — a
content script cannot see them at all. The extension therefore injects its bundle
as a page-world `<script>`, where a bare `unitsInfo` resolves normally.

**Actions.** Every order is a single JSON object sent over one WebSocket via
AWBW's own `emitData()` (`game.js:3154`). We build the same payloads the UI
builds and send them through the same function. The board animates identically
either way, because it redraws from the *server's* response
(`actionHandlers`, `game.js:1312`), not from the click.

**Three things are reused rather than reimplemented**, which is what keeps the
bot honest:

| Concern | Reused from | Why |
|---|---|---|
| Pathfinding | `getMovementTiles` / `findShortestPath` (`draw_movement.js:1,346`) | Move costs, weather, CO move effects, fog traps and enemy blocking all come out correct by construction, and every path we send is one the server will accept. |
| Damage | Ported from `awbw-engine/src/helper/fire.rs:786` | The page's own `calculateDamage` is a server round-trip, useless for evaluating hundreds of candidates. The formula is public, and its luck-free mode gives exact predictions offline. |
| Power availability | Mirrors `updateMainPowerButtons` (`game.js:6158`) | Including the quirk that Von Bolt has no COP. |

The damage port is verified against the Rust engine's own test vectors,
including a documented regression from [a real game](https://awbw.amarriner.com/game.php?games_id=1686082&ndx=20).

## Layout

```
src/
  awbw/       everything that touches AWBW
    globals.ts    typed, guarded access to the page's lexical bindings
    state.ts      immutable board snapshot
    actions.ts    one emitter per action verb
    pathing.ts    ReachIndex — cached wrapper over AWBW's own solver
    damage.ts     combat maths, ported from the Rust engine
    catalog.ts    what each property can build, and for how much
    sync.ts       waits on ongoingAction / actionQueue between orders
  dp/         the ported AI — never imports from awbw/
    ai/infantry-spam.ts   port of DefendPeace's InfantrySpamAI
  bridge/     the only place the two vocabularies meet
  policy/     power usage policy
  driver.ts   plays one turn
  main.ts     entry point + console API
```

`dp/` reasons over its own action vocabulary and never imports `awbw/`; `bridge/fromDp.ts`
translates. That boundary is what keeps the AI testable against fixtures and makes
the next AI a drop-in.

**`ReachIndex` is the load-bearing piece.** It caches AWBW's solved movement graphs
and serves *both* the AI's reasoning and the emitted payload, so what the AI
believes is reachable cannot diverge from what it asks the server to do. The
bridge refuses to send any action whose path did not come from it.

## Build

```sh
npm install
npm run gen:terrain   # regenerate the terrain table from awbw/db_sanitized.sql
npm run build         # -> page/bot.js
npm test
npm run typecheck
```

`npm run watch` rebuilds on change.

`gen:terrain` reads `../awbw/db_sanitized.sql` by default; pass a path to override.
Re-run it when AWBW adds countries or terrain.

## Install (temporary, for development)

1. `npm run build`
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** and pick `manifest.json`
4. Open a hotseat game on awbw.amarriner.com

A panel appears bottom-right. Pick the seat, then **Play this turn**, or
**Start auto-play** to let it take every turn as it comes round.

Nothing happens until you arm it. There is also a console API on `window.awbwBot`
(`playOnce()`, `startAutoPlay()`, `stopAutoPlay()`, `snapshot()`).

**Try "Dry run" first** — it logs the exact payloads without sending anything.

## Current scope (milestone 1)

Working:
- 2-player hotseat, fog **off**
- standard units and standard game mode
- Move, Capture, Fire, Build, End Turn, and CO powers
- powers fired as soon as they charge
- damage prediction matching AWBW exactly for vanilla COs

Not yet:
- **fog of war** — needs a vision model; the bot would cheat by reading state the
  seat cannot see, so keep fog off
- **CO abilities** — every CO is treated as vanilla (100/100) when predicting
  damage, though powers still fire. `damage.ts` already takes CO modifiers as
  parameters, so this is additive
- tag COs, capture limits
- Black Bomb, Piperunner, Stealth, sub diving, transports, silos — the action
  emitters exist in `actions.ts`, but the AI does not yet use them
- stronger play: `WallyAI` is the intended next port

## A note on running this

This drives a live third-party server. Hotseat is solo — you control both seats,
so no opponent is being played against — but it is still automation pointed at
someone else's site. It ships paced at ~600ms between actions and does nothing
until explicitly armed per game. Worth checking AWBW's stance on automation
before making heavy use of it.

For iteration, the AWBW repo runs locally (`awbw/docker-compose.yml`); add a
`http://localhost/*` match to `manifest.json` to develop against that instead.

## Known fragility

Production serves `js/lib`, not `js/src`. Symbol parity holds today — `js/lib` is
a plain Babel transpile with no minification or renaming (see the `compilegame`
script in `awbw/public_html/js/socketserver/package.json`) — but it is a build
output. If AWBW ever minifies it, `requireGlobals()` fails loudly and the
extension disables itself rather than half-playing a turn.

`web-ext lint` reports one advisory warning, `MISSING_DATA_COLLECTION_PERMISSIONS`.
That key would be needed for an AMO submission but requires Firefox 140+, which is
not worth the compatibility floor for a locally-loaded extension.
