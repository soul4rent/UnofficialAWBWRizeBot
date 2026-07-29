# Unofficial AWBW Rize Bot

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
    catalog.ts    what each property can build, and the unit roster
    sync.ts       waits on ongoingAction / actionQueue between orders
  dp/         the ported AIs
    ai/registry.ts        the AIs you can pick between
    ai/infantry-spam.ts   port of InfantrySpamAI
    ai/jakeman.ts         port of JakeMan (and OldSchoolCool)
    ai/cap-phase.ts       port of CapPhaseAnalyzer — opening capture routes
    ai/threat.ts          port of GenerateThreatMap / findThreatPower
    ai/roles.ts           DefendPeace's unit roles, resolved to AWBW names
    ai/utils.ts           shared helpers (AIUtils / AICombatUtils)
  bridge/     the only place the two vocabularies meet
  policy/     power usage policy
  driver.ts   plays one turn
  main.ts     entry point + console API
```

`dp/` plans in its own action vocabulary and never emits; `bridge/fromDp.ts` is the
only translator. That boundary is what keeps the AIs testable against fixtures and
makes the next one a drop-in.

**`ReachIndex` is the load-bearing piece.** It caches AWBW's solved movement graphs
and serves *both* the AI's reasoning and the emitted payload, so what the AI
believes is reachable cannot diverge from what it asks the server to do. The
bridge refuses to send any action whose path did not come from it.

## Choosing an AI

The panel has an **AI** dropdown:

| AI | What it does |
|---|---|
| **JakeMan** (default) | Port of DefendPeace's `JakeMan`. Plans capture routes off each base, takes fights where it has local force superiority, and counter-builds against what it can see. |
| **OldSchoolCool** | JakeMan with the Md Tank counter-build switched off, as in DefendPeace. |
| **Infantry Spam** | Port of `InfantrySpamAI`. Captures everything, buys nothing but infantry. |

You can switch mid-game. Each AI keeps its own state, so switching away and back
resumes rather than re-planning — which matters for JakeMan, whose capture chains
are worked out once and then followed for the life of each unit.

`awbwBot.listAis()` and `awbwBot.updateSettings({ aiId })` do the same from the console.

### What JakeMan does

DefendPeace builds it out of modules, each getting a shot at every unit in turn,
restarting from the top after every action. The port keeps that shape exactly,
because the driver re-snapshots between actions — so restarting from the top is
what makes each decision see the consequences of the last.

1. fire a charged power
2. **cap chains** — follow the opening capture route planned for this unit
3. finish any capture already in progress
4. **free dudes** — any capture or attack available from a tile the enemy cannot
   profitably punish, ranked by funds traded
5. **build** — fill every base with infantry, work out whether the enemy's air and
   armour need a specific answer (and save up if one is needed but unaffordable),
   then upgrade what is left to the biggest thing each factory can make
6. free dudes again, this time allowed to stand on our own factories
7. **travel** — head for resupply, or a capture, or the nearest thing this unit
   beats, shoving our own units aside if they are in the way

The load-bearing idea is `isDudeFree`: sum the threat pointed at a tile by every
enemy type that can hurt this unit, subtract the counter-threat our own units
project onto the tiles around it, and only go there if nothing is left over. That
one predicate is what stops it feeding units in a few at a time.

Two things in the Java did not survive the crossing, both noted at their call sites:

- **`DeployCOUOnTank`** — CO units are an AW4/Days-of-Ruin mechanic with no AWBW
  equivalent, so the phase is dropped rather than faked.
- **`GetFreeDudes`' `canEvict` flag** — dead in DefendPeace too, its eviction
  branch being commented out, which makes two of the three passes identical; they
  collapse into one.

DefendPeace's `unitCap` check is also skipped: AWBW does not expose a unit cap to
the page.

Where DefendPeace asks its unit-model list which unit fills a role, this port
resolves the roles straight to AWBW names (`Tank`, `Md.Tank`, `Anti-Air`,
`B-Copter`, …), since AWBW has exactly one unit set. `dp/ai/roles.ts` shows the
working for each lookup.

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

A panel appears bottom-right. Pick the seat and the AI, then **Play this turn**, or
**Start auto-play** to let it take every turn as it comes round.

Nothing happens until you arm it. There is also a console API on `window.awbwBot`
(`playOnce()`, `startAutoPlay()`, `stopAutoPlay()`, `snapshot()`, `listAis()`).

**Try "Dry run" first** — it logs the exact payloads without sending anything.

## Current scope (milestone 1)

Working:
- 2-player hotseat, fog **off**
- standard units and standard game mode
- Move, Capture, Fire, Build, End Turn, and CO powers
- powers fired as soon as they charge
- damage prediction matching AWBW exactly for vanilla COs
- two AI ports — `JakeMan` (with its `OldSchoolCool` variant) and `InfantrySpamAI`

Not yet:
- **fog of war** — needs a vision model; the bot would cheat by reading state the
  seat cannot see, so keep fog off
- **CO abilities** — every CO is treated as vanilla (100/100) when predicting
  damage, though powers still fire. `damage.ts` already takes CO modifiers as
  parameters, so this is additive
- tag COs, capture limits
- Black Bomb, Piperunner, Stealth, sub diving, transports, silos — the action
  emitters exist in `actions.ts`, but no AI uses them yet. JakeMan will *counter-build*
  against air units it sees, but it has no naval or transport play at all
- **powers as JakeMan intends them** — DefendPeace fires them at three separate
  points in the turn (start, after buying, at the end); the port keeps the
  milestone-1 policy of firing once, as soon as charged
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
