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
import { beforeAll, describe, expect, it } from "vitest";

import { createFakePage, type FakePage } from "./helpers/fake-page.js";

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
});

describe("playing a turn", () => {
  /** Plays seat 2's turn with no inter-action delay and returns what was sent. */
  async function playTurn(page: FakePage): Promise<Array<Record<string, unknown>>> {
    loadBundle(page);
    page.run(`awbwBot.updateSettings({ seatId: 2, actionDelayMs: 0 })`);
    await (page.run("awbwBot.playOnce()") as Promise<void>);
    return page.sent as Array<Record<string, unknown>>;
  }

  it("fires a charged power, acts, and ends the turn", async () => {
    const page = createFakePage(DAMAGE);
    const sent = await playTurn(page);
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
    const sent = await playTurn(page);

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
    const sent = await playTurn(page);

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
    const sent = await playTurn(page);

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
    const sent = await playTurn(page);

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
    const sent = await playTurn(page);
    expect(sent.filter((s) => s.action === "Power")).toHaveLength(1);
  });

  it("sends nothing in dry-run mode, and still terminates", async () => {
    // Regression: the driver re-snapshots between actions, so with no server to
    // respond, a charged power keeps looking un-fired. Without the once-per-turn
    // guard the AI proposed it until the 400-action safety limit tripped.
    const page = createFakePage(DAMAGE);
    loadBundle(page);
    page.run(`awbwBot.updateSettings({ seatId: 2, actionDelayMs: 0, dryRun: true })`);

    const actionCount = await (page.run("awbwBot.playOnce()") as Promise<number>);

    expect(page.sent).toHaveLength(0);
    expect(actionCount).toBeGreaterThan(0);
    expect(actionCount).toBeLessThan(20);
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
