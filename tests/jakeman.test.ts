/**
 * Unit tests for the pieces of the JakeMan port that are pure decision logic.
 *
 * Turn-level behaviour is covered in integration.test.ts against the real
 * bundle; what is worth pinning here is the arithmetic that decides *why*
 * JakeMan does things -- which units it considers threats, how it measures a
 * threat map, and how it plans an opening capture route.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import type { AwbwDamageTable } from "../src/awbw/types.js";
import type { GameState, UnitState } from "../src/awbw/state.js";
import type { Destination, ReachIndex } from "../src/awbw/pathing.js";
import { toNode } from "../src/awbw/state.js";
import {
  DIRECT_THREAT_THRESHOLD,
  INDIRECT_THREAT_THRESHOLD,
  hasWeapon,
  health100,
  isThreatenedBy,
  isWeakTo,
  maxBaseDamage,
  resolveRoles,
} from "../src/dp/ai/roles.js";
import { buildThreatMap, threatenedTiles } from "../src/dp/ai/threat.js";
import { theoreticalCost, travelCostsTo } from "../src/dp/ai/utils.js";
import { CapPhaseAnalyzer } from "../src/dp/ai/cap-phase.js";
import type { UnitTypeInfo } from "../src/awbw/catalog.js";
import { TERRAIN, UNIT, board, player, resetIds, unit } from "./helpers/fixture.js";
import { installPageGlobals } from "./helpers/page-globals.js";

const DAMAGE: AwbwDamageTable = JSON.parse(
  readFileSync(new URL("../../awbw/public_html/js/damage_inc.json", import.meta.url), "utf8"),
);

/** A type description, as JakeMan reasons about types not on the board. */
function type(name: string, genericId: number, indirect = false) {
  return { name, genericId, indirect };
}

const INFANTRY = type("Infantry", UNIT.INFANTRY);
const TANK = type("Tank", UNIT.TANK);
const MD_TANK = type("Md.Tank", UNIT.MD_TANK);
const ANTI_AIR = type("Anti-Air", UNIT.ANTI_AIR);
const B_COPTER = type("B-Copter", UNIT.B_COPTER);
const ARTILLERY = type("Artillery", UNIT.ARTILLERY, true);
const APC = type("APC", UNIT.APC);

beforeAll(() => {
  installPageGlobals();
  resetIds();
});

describe("threat predicates", () => {
  it("reads base damage as the better of the two weapons", () => {
    // Infantry's only weapon is its machine gun (ATTACK2 in AWBW's table).
    expect(maxBaseDamage(DAMAGE, UNIT.INFANTRY, UNIT.INFANTRY)).toBe(55);
    // A tank has both a cannon and a machine gun; the cannon wins vs armour.
    expect(maxBaseDamage(DAMAGE, UNIT.TANK, UNIT.MD_TANK)).toBeGreaterThan(0);
    expect(maxBaseDamage(DAMAGE, UNIT.TANK, UNIT.INFANTRY)).toBe(75);
  });

  it("knows which units can shoot at all", () => {
    expect(hasWeapon(DAMAGE, TANK)).toBe(true);
    expect(hasWeapon(DAMAGE, INFANTRY)).toBe(true);
    // Transports carry; they don't fight.
    expect(hasWeapon(DAMAGE, APC)).toBe(false);
  });

  it("holds direct units to a higher bar before calling something a threat", () => {
    // Infantry does 15% to an artillery: enough to alarm something that cannot
    // shoot back at range 1, not enough to bother something that can. Same
    // attacker, same damage, opposite verdicts -- the threshold follows the
    // victim, which is the whole point of the two constants.
    const chip = maxBaseDamage(DAMAGE, UNIT.INFANTRY, UNIT.ARTILLERY);
    expect(chip).toBeGreaterThanOrEqual(INDIRECT_THREAT_THRESHOLD);
    expect(chip).toBeLessThan(DIRECT_THREAT_THRESHOLD);

    expect(isThreatenedBy(DAMAGE, ARTILLERY, INFANTRY)).toBe(true);
    expect(isThreatenedBy(DAMAGE, TANK, INFANTRY)).toBe(false);
  });

  it("treats a defenceless unit as cautiously as an indirect", () => {
    // An APC has no weapon, so it never "shoots back" and takes the low bar.
    expect(isThreatenedBy(DAMAGE, APC, INFANTRY)).toBe(true);
  });

  it("only counts prey that cannot bite back", () => {
    // Anti-Air eats copters, and a copter can do nothing about it.
    expect(isWeakTo(DAMAGE, B_COPTER, ANTI_AIR)).toBe(true);
    expect(isWeakTo(DAMAGE, ANTI_AIR, B_COPTER)).toBe(false);

    // An Md Tank hits a Tank for 85 and takes 15 back, which clears the bar in
    // one direction only -- so a Tank is prey, and JakeMan will hunt it.
    expect(isThreatenedBy(DAMAGE, TANK, MD_TANK)).toBe(true);
    expect(isThreatenedBy(DAMAGE, MD_TANK, TANK)).toBe(false);
    expect(isWeakTo(DAMAGE, TANK, MD_TANK)).toBe(true);

    // Two Tanks threaten each other, so neither is prey.
    expect(isWeakTo(DAMAGE, TANK, TANK)).toBe(false);
  });

  it("resolves DefendPeace's roles to AWBW's unit names", () => {
    const roster = new Map<string, UnitTypeInfo>(
      [
        ["Infantry", UNIT.INFANTRY],
        ["Tank", UNIT.TANK],
        ["Md.Tank", UNIT.MD_TANK],
        ["Anti-Air", UNIT.ANTI_AIR],
        ["B-Copter", UNIT.B_COPTER],
        ["Fighter", UNIT.FIGHTER],
      ].map(([name, id]) => [
        name as string,
        {
          name: name as string,
          genericId: id as number,
          cost: 0,
          moveType: "T",
          movePoints: 1,
          maxAmmo: 9,
          maxFuel: 99,
          indirect: false,
        },
      ]),
    );

    const roles = resolveRoles(roster);
    expect(roles.infantry?.name).toBe("Infantry");
    expect(roles.mdTank?.name).toBe("Md.Tank");
    expect(roles.copter?.name).toBe("B-Copter");
    expect(roles.antiAir?.name).toBe("Anti-Air");
    // Nothing in this roster fills the Neotank or Bomber slot.
    expect(roles.neoTank).toBeNull();
    expect(roles.bomber).toBeNull();
  });
});

/** A ReachIndex stand-in: everything within movePoints steps, ignoring terrain. */
function fakeReach(state: GameState): ReachIndex {
  return {
    destinations(u: UnitState): Destination[] {
      const found: Destination[] = [];
      for (let x = 0; x < state.width; x++) {
        for (let y = 0; y < state.height; y++) {
          const cost = Math.abs(x - u.x) + Math.abs(y - u.y);
          if (cost > u.movePoints) continue;
          found.push({ x, y, node: toNode(state, x, y), cost, free: true });
        }
      }
      return found;
    },
  } as unknown as ReachIndex;
}

describe("threat map", () => {
  it("measures an indirect from where it stands, not where it could go", () => {
    const artillery = unit(UNIT.ARTILLERY, { playerId: 1, x: 5, y: 5 });
    const state = board({ width: 11, height: 11, units: [artillery] });

    const tiles = new Set(threatenedTiles(state, fakeReach(state), artillery));

    // Range 2-3 from (5,5): a ring, with the doughnut hole left alone.
    expect(tiles.has(toNode(state, 5, 2))).toBe(true);
    expect(tiles.has(toNode(state, 7, 5))).toBe(true);
    expect(tiles.has(toNode(state, 5, 6))).toBe(false); // range 1
    expect(tiles.has(toNode(state, 5, 5))).toBe(false); // its own tile
    expect(tiles.has(toNode(state, 5, 1))).toBe(false); // range 4
  });

  it("covers move-and-fire range for a direct unit", () => {
    const tank = unit(UNIT.TANK, { playerId: 1, x: 0, y: 0, movePoints: 2 });
    const state = board({ width: 8, height: 1, units: [tank] });

    const tiles = new Set(threatenedTiles(state, fakeReach(state), tank));

    // Two tiles of movement plus one of reach.
    expect(tiles.has(toNode(state, 3, 0))).toBe(true);
    expect(tiles.has(toNode(state, 4, 0))).toBe(false);
  });

  it("weights each unit by the square of its health, and sums by type", () => {
    const healthy = unit(UNIT.TANK, { playerId: 1, x: 1, y: 0, movePoints: 0, hp: 10 });
    const hurt = unit(UNIT.TANK, { playerId: 1, x: 3, y: 0, movePoints: 0, hp: 5 });
    const state = board({ width: 5, height: 1, units: [healthy, hurt] });

    const map = buildThreatMap(state, fakeReach(state), 2);
    const tankThreat = map.enemy.get("Tank");
    expect(tankThreat).toBeDefined();

    // Only the healthy tank reaches (0,0): a full unit is worth 1.
    expect(tankThreat!.get(toNode(state, 0, 0))).toBeCloseTo(1);
    // A 5HP tank counts for a quarter, not a half.
    expect(tankThreat!.get(toNode(state, 4, 0))).toBeCloseTo(0.25);
    // (2,0) is adjacent to both, so the two contributions add up.
    expect(tankThreat!.get(toNode(state, 2, 0))).toBeCloseTo(1.25);

    // Nothing of ours is on the board, so our side of the map is empty.
    expect(map.friendly.size).toBe(0);
  });

  it("splits the map by side, from the acting seat's point of view", () => {
    const mine = unit(UNIT.TANK, { playerId: 2, x: 0, y: 0, movePoints: 0 });
    const theirs = unit(UNIT.INFANTRY, { playerId: 1, x: 4, y: 0, movePoints: 0 });
    const state = board({ width: 5, height: 1, units: [mine, theirs] });

    const map = buildThreatMap(state, fakeReach(state), 2);
    expect([...map.friendly.keys()]).toEqual(["Tank"]);
    expect([...map.enemy.keys()]).toEqual(["Infantry"]);
  });
});

describe("health conversion", () => {
  it("puts AWBW's 1-10 HP onto DefendPeace's 0-100 scale", () => {
    expect(health100(unit(UNIT.TANK, { playerId: 1, x: 0, y: 0, hp: 10 }))).toBe(100);
    expect(health100(unit(UNIT.TANK, { playerId: 1, x: 0, y: 0, hp: 3 }))).toBe(30);
    // Fog hides HP; assume full, which is the conservative read.
    expect(health100(unit(UNIT.TANK, { playerId: 1, x: 0, y: 0, hp: null }))).toBe(100);
  });
});

describe("travel cost fields", () => {
  /**
   * A row with a mountain in it, so entry costs differ tile to tile -- which is
   * exactly the case where the "cost to a goal" shortcut could go wrong.
   *
   *   0:road  1:plain  2:mountain  3:wood  4:plain
   */
  function ridge(): GameState {
    return board({
      width: 5,
      height: 1,
      terrain: {
        "0,0": TERRAIN.ROAD,
        "1,0": TERRAIN.PLAIN,
        "2,0": TERRAIN.MOUNTAIN,
        "3,0": TERRAIN.WOOD,
        "4,0": TERRAIN.PLAIN,
      },
    });
  }

  it("charges terrain on entry, not on exit", () => {
    const state = ridge();
    // (0,0) -> (2,0) pays for the plain and the mountain, but not the road.
    expect(theoreticalCost(state, "F", { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(3);
    // ...and coming back pays for the plain and the road instead.
    expect(theoreticalCost(state, "F", { x: 2, y: 0 }, { x: 0, y: 0 })).toBe(2);
  });

  it("gives the same answer from one flood fill as from many", () => {
    const state = ridge();
    const goal = { x: 4, y: 0 };
    const toGoal = travelCostsTo(state, "F", goal);

    // The whole point of travelCostsTo: one fill out of the goal must agree,
    // tile for tile, with a separate fill out of each tile -- including over
    // asymmetric terrain, where the naive reuse of travelCostsFrom would not.
    for (let x = 0; x < state.width; x++) {
      const direct = theoreticalCost(state, "F", { x, y: 0 }, goal);
      expect(toGoal.get(toNode(state, x, 0))).toBe(direct);
    }
  });

  it("leaves out tiles this movement type cannot reach", () => {
    const state = ridge();
    // Tracked vehicles cannot cross a mountain, so nothing past it is reachable.
    const toGoal = travelCostsTo(state, "T", { x: 0, y: 0 });
    expect(toGoal.get(toNode(state, 1, 0))).toBe(1);
    expect(toGoal.has(toNode(state, 3, 0))).toBe(false);
  });
});

describe("cap phase analysis", () => {
  /**
   * A tug-of-war row, wide enough for the three cases to separate. Infantry
   * moves 3 and the planner looks 3 turns ahead, so it will not consider a
   * property more than 9 tiles from a factory at all.
   *
   *   0: our base      1,2: near cities, only we can reach them
   *   6: middle city, equidistant      11: their city      12: their base
   */
  const OURS = [1, 2];
  const MIDDLE = 6;
  const THEIRS = 11;

  function tugOfWar(capturedByUs: number[] = []): GameState {
    const terrain: Record<string, number> = {
      "0,0": TERRAIN.OS_BASE,
      "12,0": TERRAIN.BM_BASE,
    };
    const owners: Record<string, number | null> = { "0,0": 1, "12,0": 2 };
    for (const x of [...OURS, MIDDLE, THEIRS]) {
      const mine = capturedByUs.includes(x);
      terrain[`${x},0`] = mine ? TERRAIN.OS_CITY : TERRAIN.NEUTRAL_CITY;
      if (mine) owners[`${x},0`] = 1;
    }
    return board({
      width: 13,
      height: 1,
      terrain,
      owners,
      players: [player({ id: 1 }), player({ id: 2 })],
    });
  }

  it("flags a property both sides reach at once, and claims the ones we don't share", () => {
    const state = tugOfWar();
    const capPhase = new CapPhaseAnalyzer(state, 1);

    expect(capPhase.contested).toContain(toNode(state, MIDDLE, 0));
    for (const x of OURS) {
      expect(capPhase.contested).not.toContain(toNode(state, x, 0));
    }
  });

  it("routes units built on our base at the properties it claimed", () => {
    const state = tugOfWar();
    const capPhase = new CapPhaseAnalyzer(state, 1);

    const soldier = unit(UNIT.INFANTRY, { playerId: 1, x: 0, y: 0 });
    const stop = capPhase.nextStop(state, 1, soldier);

    expect(stop).not.toBeNull();
    // Never the contested city, and never one that is really theirs.
    expect(OURS).toContain(stop!.x);
  });

  it("gives two units built on the same base different targets", () => {
    const state = tugOfWar();
    const capPhase = new CapPhaseAnalyzer(state, 1);

    const first = unit(UNIT.INFANTRY, { playerId: 1, x: 0, y: 0 });
    const second = unit(UNIT.INFANTRY, { playerId: 1, x: 0, y: 0 });

    const firstStop = capPhase.nextStop(state, 1, first);
    const secondStop = capPhase.nextStop(state, 1, second);

    expect(firstStop).not.toBeNull();
    expect(secondStop).not.toBeNull();
    // Two units on one base must not be sent after the same property.
    expect(secondStop).not.toEqual(firstStop);
  });

  it("keeps handing a unit the same chain across turns", () => {
    const state = tugOfWar();
    const capPhase = new CapPhaseAnalyzer(state, 1);

    const soldier = unit(UNIT.INFANTRY, { playerId: 1, x: 0, y: 0 });
    const chain = capPhase.getCapChain(state, soldier);
    expect(chain).not.toBeNull();
    expect(capPhase.getCapChain(state, soldier)).toBe(chain);
  });

  it("drops stops we already own as the unit passes them", () => {
    const state = tugOfWar();
    const capPhase = new CapPhaseAnalyzer(state, 1);
    const soldier = unit(UNIT.INFANTRY, { playerId: 1, x: 0, y: 0 });

    const first = capPhase.nextStop(state, 1, soldier);
    expect(first).not.toBeNull();

    // Same board, but that property has since fallen to us.
    const after = tugOfWar([first!.x]);
    expect(capPhase.nextStop(after, 1, soldier)).not.toEqual(first);
  });
});
