/**
 * Verifies the damage port against AWBW's own engine.
 *
 * The two headline cases are lifted straight from the Rust engine's test suite
 * (awbw/server/awbw-engine/src/helper/fire.rs:918-957), including one that is a
 * documented regression from a real game:
 * https://awbw.amarriner.com/game.php?games_id=1686082&ndx=20
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  VANILLA_CO,
  basePercentage,
  canTarget,
  predictBattle,
  predictDamage,
  terrainDefenseFor,
  type CoModifiers,
} from "../src/awbw/damage.js";
import type { AwbwDamageTable } from "../src/awbw/types.js";
import { TERRAIN, UNIT, board, player, resetIds, unit } from "./helpers/fixture.js";

/** The real table AWBW ships to the browser, not a hand-written stub. */
const DAMAGE: AwbwDamageTable = JSON.parse(
  readFileSync(
    new URL("../../awbw/public_html/js/damage_inc.json", import.meta.url),
    "utf8",
  ),
);

/** AWBW's Kanbei: +30% firepower and +30% defence. */
const KANBEI: CoModifiers = { ...VANILLA_CO, attack: 130, defense: 130 };

/** Nell's gimmick is luck, not raw power, so her modifiers stay vanilla. */
const NELL_LUCK = { badMax: 0, goodMax: 19 };

describe("basePercentage", () => {
  it("uses the secondary weapon for units with no primary", () => {
    // Infantry has no ATTACK1 entry at all -- its machine gun is the secondary.
    expect(DAMAGE.ATTACK1["1"]).toBeUndefined();
    expect(basePercentage(DAMAGE, UNIT.INFANTRY, UNIT.INFANTRY, 0)).toBe(55);
  });

  it("prefers the primary weapon while ammo remains", () => {
    expect(basePercentage(DAMAGE, UNIT.TANK, UNIT.TANK, 9)).toBe(55);
  });

  it("falls back to the secondary once ammo is spent", () => {
    // A Tank out of shells drops from its 55% cannon to its machine gun, which
    // still shreds infantry but only chips armour.
    expect(basePercentage(DAMAGE, UNIT.TANK, UNIT.TANK, 9)).toBe(55);
    expect(basePercentage(DAMAGE, UNIT.TANK, UNIT.TANK, 0)).toBe(6);
    expect(basePercentage(DAMAGE, UNIT.TANK, UNIT.INFANTRY, 0)).toBe(75);
  });

  it("returns null for pairings that cannot engage", () => {
    // Infantry cannot touch a Fighter.
    expect(basePercentage(DAMAGE, UNIT.INFANTRY, UNIT.FIGHTER, 0)).toBeNull();
  });
});

describe("predictDamage — parity with the Rust engine", () => {
  it("Kindle infantry vs Javier infantry on sea yields 55-64", () => {
    resetIds();
    const attacker = unit(UNIT.INFANTRY, { playerId: 1, x: 0, y: 0 });
    const defender = unit(UNIT.INFANTRY, { playerId: 2, x: 1, y: 0 });
    const state = board({
      width: 4,
      height: 1,
      fill: TERRAIN.SEA,
      units: [attacker, defender],
    });

    // Neither CO's ability applies here: Kindle's bonus is property-only and
    // Javier's needs indirect fire or com towers, so both resolve to vanilla.
    const result = predictDamage(state, DAMAGE, attacker, defender);

    expect(result).not.toBeNull();
    expect(result!.min).toBe(55);
    expect(result!.max).toBe(64);
  });

  it("Nell 3HP tank vs Kanbei 10HP tank on an HQ yields 5-6", () => {
    resetIds();
    const attacker = unit(UNIT.TANK, { playerId: 1, x: 0, y: 0, hp: 3 });
    const defender = unit(UNIT.TANK, { playerId: 2, x: 1, y: 0 });
    const state = board({
      width: 4,
      height: 1,
      fill: TERRAIN.PLAIN,
      terrain: { "1,0": TERRAIN.OS_HQ },
      owners: { "1,0": 2 },
      units: [attacker, defender],
    });

    const result = predictDamage(state, DAMAGE, attacker, defender, {
      defenderCo: KANBEI,
      luck: NELL_LUCK,
    });

    expect(result).not.toBeNull();
    // 4.95 rounds up to 5.0 then truncates to 5; 6.66 rounds to 6.7 then to 6.
    expect(result!.min).toBe(5);
    expect(result!.max).toBe(6);
  });
});

describe("terrain defence", () => {
  it("is ignored by air units", () => {
    resetIds();
    const flier = unit(UNIT.FIGHTER, { playerId: 2, x: 1, y: 1 });
    const state = board({
      width: 3,
      height: 3,
      fill: TERRAIN.MOUNTAIN,
      units: [flier],
    });
    expect(terrainDefenseFor(state, flier, 1, 1)).toBe(0);
  });

  it("is zero on pipe seams", () => {
    resetIds();
    const ground = unit(UNIT.TANK, { playerId: 2, x: 1, y: 0 });
    const state = board({
      width: 3,
      height: 1,
      terrain: { "1,0": TERRAIN.HPIPE_SEAM },
      units: [ground],
    });
    expect(terrainDefenseFor(state, ground, 1, 0)).toBe(0);
  });

  it("reduces damage as defender HP rises", () => {
    resetIds();
    const attacker = unit(UNIT.TANK, { playerId: 1, x: 0, y: 0 });
    const healthy = unit(UNIT.TANK, { playerId: 2, x: 1, y: 0 });
    const state = board({
      width: 3,
      height: 1,
      fill: TERRAIN.MOUNTAIN,
      units: [attacker, healthy],
    });

    const atFull = predictDamage(state, DAMAGE, attacker, healthy)!;
    const atHalf = predictDamage(state, DAMAGE, attacker, healthy, { defenderHp: 5 })!;

    // Terrain defence scales with the defender's displayed HP, so a wounded
    // unit on a mountain takes proportionally more.
    expect(atHalf.min).toBeGreaterThan(atFull.min);
  });
});

describe("canTarget", () => {
  it("blocks non-counters from hitting a dived sub", () => {
    resetIds();
    const tank = unit(UNIT.TANK, { playerId: 1, x: 0, y: 0 });
    const sub = unit(UNIT.SUB, { playerId: 2, x: 1, y: 0, hidden: true });
    expect(canTarget(tank, sub)).toBe(false);
  });

  it("allows a cruiser to hit a dived sub", () => {
    resetIds();
    const cruiser = unit(UNIT.CRUISER, { playerId: 1, x: 0, y: 0, name: "Cruiser" });
    const sub = unit(UNIT.SUB, { playerId: 2, x: 1, y: 0, hidden: true });
    expect(canTarget(cruiser, sub)).toBe(true);
  });
});

describe("predictBattle — counterattacks", () => {
  it("counters when both units are direct and the defender survives", () => {
    resetIds();
    const attacker = unit(UNIT.TANK, { playerId: 1, x: 0, y: 0, hp: 5 });
    const defender = unit(UNIT.TANK, { playerId: 2, x: 1, y: 0 });
    const state = board({ width: 3, height: 1, units: [attacker, defender] });

    const result = predictBattle(state, DAMAGE, attacker, defender)!;

    expect(result.guaranteedKill).toBe(false);
    expect(result.damageToAttacker).not.toBeNull();
    expect(result.damageToAttacker!.min).toBeGreaterThan(0);
  });

  it("does not counter when the attacker is indirect", () => {
    resetIds();
    const artillery = unit(UNIT.ARTILLERY, { playerId: 1, x: 0, y: 0 });
    const defender = unit(UNIT.TANK, { playerId: 2, x: 2, y: 0 });
    const state = board({ width: 4, height: 1, units: [artillery, defender] });

    const result = predictBattle(state, DAMAGE, artillery, defender)!;
    expect(result.damageToAttacker).toBeNull();
  });

  it("does not counter when the defender dies", () => {
    resetIds();
    const attacker = unit(UNIT.TANK, { playerId: 1, x: 0, y: 0 });
    const defender = unit(UNIT.INFANTRY, { playerId: 2, x: 1, y: 0, hp: 1 });
    const state = board({ width: 3, height: 1, units: [attacker, defender] });

    const result = predictBattle(state, DAMAGE, attacker, defender)!;
    expect(result.guaranteedKill).toBe(true);
    expect(result.damageToAttacker).toBeNull();
  });

  it("deals the counter at the defender's surviving HP", () => {
    resetIds();
    const attacker = unit(UNIT.TANK, { playerId: 1, x: 0, y: 0 });
    const strong = unit(UNIT.TANK, { playerId: 2, x: 1, y: 0 });
    const state = board({ width: 3, height: 1, units: [attacker, strong] });

    const full = predictDamage(state, DAMAGE, strong, attacker)!;
    const battle = predictBattle(state, DAMAGE, attacker, strong)!;

    // The counter comes from a damaged unit, so it must be weaker than a
    // full-health strike in the other direction.
    expect(battle.damageToAttacker!.min).toBeLessThan(full.min);
  });
});
