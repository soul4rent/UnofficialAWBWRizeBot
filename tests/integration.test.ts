/**
 * End-to-end test of the *built bundle* against a simulated AWBW page.
 *
 * This is the test that matters most. The whole design rests on one property:
 * game.php's `let`/`const` game state is reachable by bare identifier from an
 * injected classic script, even though it never becomes a property of window.
 * node:vm reproduces that scoping faithfully, so if this passes, the bundle can
 * genuinely read the real page.
 *
 * Run `npm run build` first -- the test asserts against page/bot.js as shipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createFakePage, type FakePage } from "./helpers/fake-page.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BUNDLE_PATH = new URL("../page/bot.js", import.meta.url);
const DAMAGE = JSON.parse(
  readFileSync(new URL("../../awbw/public_html/js/damage_inc.json", import.meta.url), "utf8"),
);

function loadBundle(page: FakePage): void {
  page.run(readFileSync(BUNDLE_PATH, "utf8"));
}

beforeAll(() => {
  if (!existsSync(BUNDLE_PATH)) {
    throw new Error("page/bot.js is missing — run `npm run build` before the tests");
  }
});

describe("page scoping", () => {
  it("keeps game state off globalThis, as the real page does", () => {
    const page = createFakePage(DAMAGE);
    // If this ever becomes defined, the fixture has stopped reproducing the
    // real page and the integration tests below are worthless.
    expect(page.run("typeof globalThis.unitsInfo")).toBe("undefined");
    expect(page.run("typeof unitsInfo")).toBe("object");
  });
});

describe("bundle boot", () => {
  it("installs its API when injected into the page world", () => {
    const page = createFakePage(DAMAGE);
    loadBundle(page);
    expect(page.run("typeof awbwBot")).toBe("object");
  });

  it("reads the board through the page's lexical bindings", () => {
    const page = createFakePage(DAMAGE);
    loadBundle(page);

    const summary = page.run<{
      width: number;
      height: number;
      day: number;
      units: number;
      players: number;
      currentTurn: number;
    }>(`(function () {
      const s = awbwBot.snapshot();
      return { width: s.width, height: s.height, day: s.day,
               units: s.units.size, players: s.players.size,
               currentTurn: s.currentTurn };
    })()`);

    expect(summary).toEqual({
      width: 5,
      height: 1,
      day: 3,
      units: 2,
      players: 2,
      currentTurn: 2,
    });
  });

  it("resolves terrain and property ownership", () => {
    const page = createFakePage(DAMAGE);
    loadBundle(page);

    const tiles = page.run<Array<{ kind: string; owner: number | null }>>(`(function () {
      const s = awbwBot.snapshot();
      return [[0,0],[2,0],[4,0],[1,0]].map(([x,y]) => {
        const t = s.tiles[x][y];
        return { kind: t.terrain.kind, owner: t.building ? t.building.playerId : null };
      });
    })()`);

    expect(tiles[0]).toEqual({ kind: "BASE", owner: 1 });
    // Neutral properties come through AWBW as player id 0, normalised to null.
    expect(tiles[1]).toEqual({ kind: "CITY", owner: null });
    expect(tiles[2]).toEqual({ kind: "BASE", owner: 2 });
    expect(tiles[3]).toEqual({ kind: "PLAIN", owner: null });
  });

  it("picks the second hotseat seat by default", () => {
    const page = createFakePage(DAMAGE);
    loadBundle(page);
    expect(page.run("awbwBot.defaultSeat()")).toBe(2);
  });

  it("picks the only controlled seat in a game against other people", () => {
    // AWBW puts exactly one seat in allViewerPId outside hotseat (game.js:277),
    // and that seat is the only one the server would take orders for.
    const page = createFakePage(DAMAGE, { allViewerPId: [2] });
    loadBundle(page);
    expect(page.run("awbwBot.defaultSeat()")).toBe(2);
  });

  it("picks no seat when spectating someone else's game", () => {
    const page = createFakePage(DAMAGE, { allViewerPId: [] });
    loadBundle(page);
    expect(page.run("awbwBot.defaultSeat()")).toBe(null);
  });

  it("ignores a viewer id that belongs to no seat", () => {
    const page = createFakePage(DAMAGE, { allViewerPId: [0, 2] });
    loadBundle(page);
    expect(page.run("awbwBot.defaultSeat()")).toBe(2);
  });
});

describe("playing a game against other people", () => {
  it("plays the account's own seat without being told which one", async () => {
    // The whole non-hotseat path: one controlled seat, no seatId configured, so
    // the bot has to fall back to the seat the session actually owns.
    const page = createFakePage(DAMAGE, { allViewerPId: [2] });
    loadBundle(page);
    page.run(`awbwBot.updateSettings({ actionDelayMs: 0, aiId: "isai" })`);
    await (page.run("awbwBot.playOnce()") as Promise<void>);

    const sent = page.sent as Array<Record<string, unknown>>;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.playerID === undefined || s.playerID === 2)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ action: "End", playerID: 2 });
  });

  it("sits out the opponent's turn and plays when it comes round", async () => {
    // What makes a live game work at all: the turn arrives while the page is
    // open. AWBW reassigns `currentTurn` in place from its socket response
    // (endTurnHandler, game.js:4968) rather than reloading, so auto-play's poll
    // is what notices. Start on seat 1's turn to prove it waits for that.
    const page = createFakePage(DAMAGE, { allViewerPId: [2], currentTurn: 1 });
    loadBundle(page);
    page.run(`awbwBot.updateSettings({ actionDelayMs: 0, aiId: "isai" })`);
    page.run("awbwBot.startAutoPlay()");

    try {
      await sleep(1200);
      expect(page.sent, "acted while the opponent held the turn").toHaveLength(0);

      page.run("currentTurn = 2");
      await vi.waitFor(
        () => expect(page.sent.at(-1)).toMatchObject({ action: "End", playerID: 2 }),
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      page.run("awbwBot.stopAutoPlay()");
    }
  }, 20_000);
});

/** Plays seat 2's turn with no inter-action delay and returns what was sent. */
async function playTurn(
  page: FakePage,
  aiId: string,
): Promise<Array<Record<string, unknown>>> {
  loadBundle(page);
  page.run(`awbwBot.updateSettings({ seatId: 2, actionDelayMs: 0, aiId: ${JSON.stringify(aiId)} })`);
  await (page.run("awbwBot.playOnce()") as Promise<void>);
  return page.sent as Array<Record<string, unknown>>;
}

describe("playing a turn as ISAI", () => {
  const playTurnAsIsai = (page: FakePage) => playTurn(page, "isai");

  it("fires a charged power, acts, and ends the turn", async () => {
    const page = createFakePage(DAMAGE);
    const sent = await playTurnAsIsai(page);
    const kinds = sent.map((s) => s.action);

    // Seat 2 starts with a full SCOP bar, so milestone-1 policy fires it first.
    expect(kinds[0]).toBe("Power");
    expect(sent[0]).toMatchObject({ action: "Power", coPower: "S", playerID: 2 });

    // ...and the turn is always closed out.
    expect(kinds.at(-1)).toBe("End");
    expect(sent.at(-1)).toMatchObject({ action: "End", playerID: 2 });
  });

  it("buys infantry from its base", async () => {
    const page = createFakePage(DAMAGE);
    const sent = await playTurnAsIsai(page);

    const build = sent.find((s) => s.action === "Build");
    expect(build).toMatchObject({
      action: "Build",
      playerID: 2,
      // Generic unit id 1 is Infantry; building 103 is Blue Moon's base.
      unitID: 1,
      buildingID: 103,
    });
  });

  it("marches into range and attacks, with a path from its own tile", async () => {
    const page = createFakePage(DAMAGE);
    const sent = await playTurnAsIsai(page);

    const attack = sent.find((s) => s.action === "Fire") as
      | { attacker: { unitID: number; path: number[] }; defender: { unitID: number } }
      | undefined;
    expect(attack).toBeDefined();

    // Seat 2's infantry starts at (4,0) with 3 MP on a uniform-cost row, so it
    // should walk to (1,0) and hit the enemy infantry standing on (0,0).
    expect(attack!.attacker.unitID).toBe(202);
    expect(attack!.defender.unitID).toBe(201);
    // Paths must start on the unit's own tile -- node 4 on a width-5 map.
    expect(attack!.attacker.path[0]).toBe(4);
    expect(attack!.attacker.path.at(-1)).toBe(1);
  });

  it("walks toward a capturable property when no attack is reachable", async () => {
    // Same board stretched out, with the AI's infantry parked at the far end so
    // the enemy is well beyond its 3 movement points.
    const page = createFakePage(DAMAGE, {
      maxX: 9,
      extra: "__placeUnit(unitsInfo[202], 8, 0);",
    });
    const sent = await playTurnAsIsai(page);

    expect(sent.find((s) => s.action === "Fire")).toBeUndefined();

    const move = sent.find((s) => s.action === "Move") as
      | { path: number[]; unitID: number }
      | undefined;
    expect(move).toBeDefined();
    expect(move!.unitID).toBe(202);

    // It should head for the neutral city at (2,0) -- three tiles of progress,
    // landing on (5,0), i.e. node 5 on a width-9 map.
    expect(move!.path[0]).toBe(8);
    expect(move!.path.at(-1)).toBe(5);
  });

  it("captures on the same turn it walks onto the property", async () => {
    // Regression: the AI used to send a plain Move onto a reachable property and
    // only capture on the following turn, wasting one turn per property. A Move
    // ends the unit's turn; AWBW's Capt carries the path, so it must be one order.
    //
    // Infantry at (5,0) with 3 MP puts the neutral city at (2,0) exactly in
    // range, while the enemy at (0,0) needs 4 MP to close on -- so no attack
    // outranks the capture.
    const page = createFakePage(DAMAGE, {
      maxX: 9,
      extra: "__placeUnit(unitsInfo[202], 5, 0);",
    });
    const sent = await playTurnAsIsai(page);

    const capture = sent.find((s) => s.action === "Capt") as
      | { path: number[]; unitID: number; playerID: number }
      | undefined;
    expect(capture).toBeDefined();
    expect(capture!.unitID).toBe(202);
    expect(capture!.playerID).toBe(2);

    // Path walks (5,0) -> (2,0); nodes are just x on a single-row width-9 map.
    expect(capture!.path).toEqual([5, 4, 3, 2]);

    // The walk must not also go out as a separate Move.
    expect(sent.find((s) => s.action === "Move")).toBeUndefined();

    // And the capture actually landed: 10 HP off the city's 20-point counter.
    const captured = page.run<number>("buildingsInfo[2][0].buildings_capture");
    expect(captured).toBe(10);
  });

  it("does nothing when it is not the configured seat's turn", async () => {
    const page = createFakePage(DAMAGE, { currentTurn: 1 });
    loadBundle(page);
    page.run(`awbwBot.updateSettings({ seatId: 2, actionDelayMs: 0 })`);
    await (page.run("awbwBot.playOnce()") as Promise<void>);
    expect(page.sent).toHaveLength(0);
  });

  it("fires its power exactly once", async () => {
    const page = createFakePage(DAMAGE);
    const sent = await playTurnAsIsai(page);
    expect(sent.filter((s) => s.action === "Power")).toHaveLength(1);
  });
});

describe("playing a turn as JakeMan", () => {
  const playTurnAsJakeMan = (page: FakePage) => playTurn(page, "jakeman");

  it("follows its cap chain onto the neutral city", async () => {
    // JakeMan plans capture routes out of each base before it does anything
    // else, so the infantry sitting on Blue Moon's base at (4,0) walks the
    // chain to the neutral city at (2,0) and starts capturing in one order.
    const page = createFakePage(DAMAGE);
    const sent = await playTurnAsJakeMan(page);

    const capture = sent.find((s) => s.action === "Capt") as
      | { path: number[]; unitID: number }
      | undefined;
    expect(capture).toBeDefined();
    expect(capture!.unitID).toBe(202);
    expect(capture!.path).toEqual([4, 3, 2]);
  });

  it("finishes a capture in progress at the start of a fresh turn", async () => {
    // Regression: the bot read capture progress off the unit's units_capture
    // field, but AWBW clears that to 0 at the start of every turn -- so a unit
    // that half-captured last turn looked idle this turn and wandered off to a
    // different property, leaving captures perpetually unfinished. The progress
    // that actually survives lives on the building's counter.
    //
    // Seat 2's infantry stands on the neutral city at (2,0), half-taken (counter
    // at 10 of 20), with units_capture cleared exactly as the server leaves it.
    // A second, untouched city sits farther out at (5,0): without the fix the bot
    // reads no progress and GetFreeDudes -- which prefers the furthest capture --
    // marches the unit off to that one, abandoning the half-done capture.
    const page = createFakePage(DAMAGE, {
      maxX: 6,
      extra: `
        buildingsInfo[5][0] = { buildings_id: 105, buildings_games_id: 42,
          buildings_players_id: 0, buildings_team: null, buildings_capture: 20,
          buildings_x: 5, buildings_y: 0, countries_code: "", terrain_defense: 3,
          terrain_id: 34, terrain_name: "Neutral City" };
        __placeUnit(unitsInfo[202], 2, 0);
        buildingsInfo[2][0].buildings_capture = 10;
        unitsInfo[202].units_capture = 0;
      `,
    });
    const sent = await playTurnAsJakeMan(page);

    // It must stay put and finish the capture, not move off to the far city.
    const capture = sent.find((s) => s.action === "Capt" && s.unitID === 202) as
      | { path: number[] }
      | undefined;
    expect(capture, "should finish the capture it already started").toBeDefined();
    expect(capture!.path).toEqual([2]); // stays on (2,0)
    expect(sent.find((s) => s.action === "Move" && s.unitID === 202)).toBeUndefined();

    // And it landed: the city's counter drops from 10 to 0 and flips to seat 2.
    expect(page.run<number>("buildingsInfo[2][0].buildings_players_id")).toBe(2);
  });

  it("spends up to the best unit its base can make, rather than stopping at infantry", async () => {
    // Seat 2 holds 9000. JakeMan fills the base with infantry to set a floor,
    // then upgrades that slot as far as the budget stretches -- to a Tank.
    const page = createFakePage(DAMAGE);
    const sent = await playTurnAsJakeMan(page);

    const build = sent.find((s) => s.action === "Build");
    expect(build).toMatchObject({
      action: "Build",
      playerID: 2,
      // Generic unit id 4 is Tank; 103 is Blue Moon's base.
      unitID: 4,
      buildingID: 103,
    });
  });

  it("ends the turn, having fired its power exactly once", async () => {
    const page = createFakePage(DAMAGE);
    const sent = await playTurnAsJakeMan(page);

    expect(sent.filter((s) => s.action === "Power")).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ action: "End", playerID: 2 });
  });

  it("builds on every base it can afford, not just the first", async () => {
    // Regression: JakeMan netted its own spending out of player.funds, but the
    // driver re-snapshots after each order settles, so that balance already
    // reflected the spend -- the double count drove the budget negative and every
    // base after the first expensive build was skipped despite ample funds.
    //
    // Seat 2 holds 9000 and now has two bases: enough for a Tank on one and
    // Infantry on the other. Both must produce.
    const page = createFakePage(DAMAGE, {
      extra: `buildingsInfo[3][0] = { buildings_id: 104, buildings_games_id: 42,
        buildings_players_id: 2, buildings_team: 2, buildings_capture: 20,
        buildings_x: 3, buildings_y: 0, countries_code: "bm", terrain_defense: 3,
        terrain_id: 44, terrain_name: "Blue Moon Base" };`,
    });
    const sent = await playTurnAsJakeMan(page);

    const builtAt = new Set(
      sent.filter((s) => s.action === "Build").map((s) => s.buildingID),
    );
    // Blue Moon's original base and the added one both get an order.
    expect(builtAt.has(103)).toBe(true);
    expect(builtAt.has(104)).toBe(true);
  });
});

describe("choosing an AI", () => {
  it("offers JakeMan, OldSchoolCool and Infantry Spam, defaulting to JakeMan", () => {
    const page = createFakePage(DAMAGE);
    loadBundle(page);

    const ids = page.run<string[]>("awbwBot.listAis().map(a => a.id)");
    expect(ids).toEqual(["jakeman", "oldschoolcool", "isai"]);
    expect(page.run("awbwBot.getSettings().aiId")).toBe("jakeman");
  });

  it("changes how the turn is played when you switch", async () => {
    // Same board, same seat, same funds -- the only difference is the choice.
    const isai = await playTurn(createFakePage(DAMAGE), "isai");
    const jakeman = await playTurn(createFakePage(DAMAGE), "jakeman");

    const builtBy = (sent: Array<Record<string, unknown>>) =>
      (sent.find((s) => s.action === "Build") as { unitID: number } | undefined)?.unitID;

    // ISAI buys nothing but infantry; JakeMan buys the biggest thing it can.
    expect(builtBy(isai)).toBe(1);
    expect(builtBy(jakeman)).toBe(4);
  });

  it("keeps each AI's own state, so switching back resumes rather than restarts", async () => {
    const page = createFakePage(DAMAGE);
    loadBundle(page);
    page.run(`awbwBot.updateSettings({ seatId: 2, actionDelayMs: 0, aiId: "jakeman" })`);
    await (page.run("awbwBot.playOnce()") as Promise<void>);

    // Hand the next turn to ISAI and back again; JakeMan must not throw or
    // re-plan from scratch when it picks the game back up.
    page.run("__handTurnTo(2)");
    page.run(`awbwBot.updateSettings({ aiId: "isai" })`);
    await (page.run("awbwBot.playOnce()") as Promise<void>);

    page.run("__handTurnTo(2)");
    page.run(`awbwBot.updateSettings({ aiId: "jakeman" })`);
    const count = await (page.run("awbwBot.playOnce()") as Promise<number>);

    expect(count).toBeGreaterThan(0);
    expect(page.sent.at(-1)).toMatchObject({ action: "End", playerID: 2 });
  });
});

describe("refusing to run against a changed AWBW", () => {
  it("bails out when an expected global is missing", () => {
    // Simulates AWBW renaming or dropping getMovementTiles.
    const page = createFakePage(DAMAGE, { extra: "getMovementTiles = undefined;" });
    loadBundle(page);
    expect(page.run("typeof awbwBot")).toBe("undefined");
  });
});
