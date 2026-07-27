/**
 * AWBW's combat maths, ported so the AI can evaluate hundreds of candidate
 * attacks per turn without touching the network.
 *
 * The page's own calculateDamage (game.js:6416) POSTs to
 * api/calculator/calculate_new.php, which is far too chatty for search. The
 * formula itself is public in the repo though, in two places that agree:
 *
 *   - awbw/server/awbw-engine/src/helper/fire.rs:786-796  (the live Rust engine)
 *   - awbw/public_html/funcs/calculate_percentage.php:390  (the older PHP path)
 *
 * Both compute, per luck roll:
 *   attackPower  = coAttack  + (coAttackPower  - 100)
 *   defensePower = coDefense + (coDefensePower - 100)
 *   d1 = ceil(attHP)/10 * (percentage * attackPower/100 + goodLuck - badLuck)
 *   d2 = d1 * (200 - (defensePower + terrainDefense * ceil(defHP))) / 100
 *   d3 = round(d2 * 10) / 10          // one decimal place
 *   d4 = trunc(clamp(d3, 0, 100))     // damage out of 100, i.e. 10 HP
 *
 * HP is a float on a 0-10 scale with 0.1 granularity; damage is out of 100.
 * Displayed HP is ceil(hp).
 *
 * Milestone 1 treats every CO as vanilla (100/100), so coAttack carries only the
 * Com Tower bonus. The CO hooks are left as explicit parameters so adding real
 * CO abilities later is additive rather than a rewrite.
 */
import type { GameState, UnitState } from "./state.js";
import { buildingsOf, tileAt } from "./state.js";
import type { AwbwDamageTable } from "./types.js";

/** Pipe seams give no terrain defence (fire.rs:779). */
const PIPE_SEAM_TERRAIN_IDS = new Set([113, 114]);

/** Air units ignore terrain defence entirely (fire.rs:777). */
const AIR_MOVE_TYPE = "A";

/** Vanilla luck: 0 bad, 0-9 good (fire.rs:768). */
export const VANILLA_LUCK = { badMax: 0, goodMax: 9 } as const;

export interface CoModifiers {
  /** CO base attack %, before the Com Tower bonus. Vanilla is 100. */
  readonly attack: number;
  /** CO base defence %. Vanilla is 100. */
  readonly defense: number;
  /** Attack multiplier from an active power. Vanilla / no power is 100. */
  readonly attackPower: number;
  /** Defence multiplier from an active power. Vanilla / no power is 100. */
  readonly defensePower: number;
}

export const VANILLA_CO: CoModifiers = {
  attack: 100,
  defense: 100,
  attackPower: 100,
  defensePower: 100,
};

export interface DamageSpread {
  /** Damage out of 100 with the worst luck roll -- the guaranteed floor. */
  readonly min: number;
  /** Damage out of 100 with the best luck roll. */
  readonly max: number;
  /** Mean across the luck range; the right number for averaging over a turn. */
  readonly expected: number;
}

export interface BattlePrediction {
  readonly damageToDefender: DamageSpread;
  /** Null when the defender cannot or will not counterattack. */
  readonly damageToAttacker: DamageSpread | null;
  /** Defender HP (0-100 scale) after the guaranteed-minimum attack. */
  readonly defenderHpAfterMin: number;
  /** True when even the minimum roll destroys the defender. */
  readonly guaranteedKill: boolean;
}

/**
 * Looks up the base damage percentage.
 * The primary weapon is used when it has an entry *and* the attacker has ammo;
 * otherwise the secondary. Null means this pairing cannot attack at all
 * (calculate_percentage.php:50-58).
 */
export function basePercentage(
  table: AwbwDamageTable,
  attackerGenericId: number,
  defenderGenericId: number,
  attackerAmmo: number,
): number | null {
  const primary = table.ATTACK1?.[attackerGenericId]?.[defenderGenericId];
  if (primary !== undefined && primary > 0 && attackerAmmo > 0) return primary;

  const secondary = table.ATTACK2?.[attackerGenericId]?.[defenderGenericId];
  if (secondary !== undefined && secondary > 0) return secondary;

  return null;
}

/**
 * Hidden subs and stealths are only attackable by specific counters
 * (calculate_percentage.php:61-73).
 */
export function canTarget(attacker: UnitState, defender: UnitState): boolean {
  if (!defender.hidden) return true;
  if (defender.name === "Sub") {
    return attacker.name === "Cruiser" || attacker.name === "Sub";
  }
  if (defender.name === "Stealth") {
    return attacker.name === "Fighter" || attacker.name === "Stealth";
  }
  return true;
}

/** Com Towers owned by a player, each worth +10 attack (fire.rs:644-659). */
export function comTowerCount(state: GameState, playerId: number): number {
  return buildingsOf(state, playerId).filter((b) => b.terrain.kind === "COM_TOWER").length;
}

/**
 * Terrain defence the defender benefits from while standing on `tile`.
 * Air units and pipe seams both yield 0.
 */
export function terrainDefenseFor(
  state: GameState,
  defender: UnitState,
  x: number,
  y: number,
): number {
  if (defender.moveType === AIR_MOVE_TYPE) return 0;
  const tile = tileAt(state, x, y);
  if (!tile) return 0;
  if (PIPE_SEAM_TERRAIN_IDS.has(tile.terrainId)) return 0;
  return tile.terrain.defense;
}

/** One luck roll of the damage formula. Returns damage out of 100. */
function damageForLuck(
  percentage: number,
  attackerHp: number,
  defenderHp: number,
  terrainDefense: number,
  co: CoModifiers,
  towerBonus: number,
  goodLuck: number,
  badLuck: number,
): number {
  const attackPower = co.attack + towerBonus + (co.attackPower - 100);
  const defensePower = co.defense + (co.defensePower - 100);

  const d1 = (Math.ceil(attackerHp) / 10) * (percentage * (attackPower / 100) + goodLuck - badLuck);
  const d2 = (d1 * (200 - (defensePower + terrainDefense * Math.ceil(defenderHp)))) / 100;
  // Round to one decimal, then truncate. Only .95 and up rounds a point upward --
  // see the worked example in fire.rs:934.
  const d3 = Math.round(d2 * 10) / 10;
  return Math.trunc(Math.min(100, Math.max(0, d3)));
}

export interface DamageOptions {
  /** Defaults to the attacker's live position. */
  readonly attackFrom?: { x: number; y: number };
  readonly attackerCo?: CoModifiers;
  readonly defenderCo?: CoModifiers;
  /** Defaults to vanilla (0 bad, 0-9 good). */
  readonly luck?: { badMax: number; goodMax: number };
  /**
   * HP override on the 0-10 scale, for evaluating a follow-up strike against a
   * unit already damaged earlier in the same turn.
   */
  readonly defenderHp?: number;
  readonly attackerHp?: number;
}

/**
 * Damage this attacker would deal to this defender, out of 100.
 * Null when the pairing cannot attack (no damage entry, or a hidden sub/stealth).
 *
 * Fog leaves enemy HP unknown; we assume full health, which is the conservative
 * read for an attacker deciding whether a kill is guaranteed.
 */
export function predictDamage(
  state: GameState,
  table: AwbwDamageTable,
  attacker: UnitState,
  defender: UnitState,
  options: DamageOptions = {},
): DamageSpread | null {
  if (!canTarget(attacker, defender)) return null;

  const attackerHp = options.attackerHp ?? attacker.hp ?? 10;
  const defenderHp = options.defenderHp ?? defender.hp ?? 10;

  const percentage = basePercentage(table, attacker.genericId, defender.genericId, attacker.ammo);
  if (percentage === null) return null;

  const terrainDefense = terrainDefenseFor(state, defender, defender.x, defender.y);
  const co = options.attackerCo ?? VANILLA_CO;
  const defCo = options.defenderCo ?? VANILLA_CO;
  const towerBonus = 10 * comTowerCount(state, attacker.playerId);
  const luck = options.luck ?? VANILLA_LUCK;

  const effectiveCo: CoModifiers = {
    attack: co.attack,
    attackPower: co.attackPower,
    defense: defCo.defense,
    defensePower: defCo.defensePower,
  };

  const rolls: number[] = [];
  for (let bad = 0; bad <= luck.badMax; bad++) {
    for (let good = 0; good <= luck.goodMax; good++) {
      rolls.push(
        damageForLuck(
          percentage,
          attackerHp,
          defenderHp,
          terrainDefense,
          effectiveCo,
          towerBonus,
          good,
          bad,
        ),
      );
    }
  }

  const total = rolls.reduce((sum, d) => sum + d, 0);
  return {
    min: Math.min(...rolls),
    max: Math.max(...rolls),
    expected: total / rolls.length,
  };
}

/**
 * Full exchange, including the counterattack.
 *
 * A counter happens only when the defender survives, neither unit is indirect,
 * and the defender has a damage entry against the attacker
 * (fire.rs:419-444). The counter is dealt at the defender's *remaining* HP.
 */
export function predictBattle(
  state: GameState,
  table: AwbwDamageTable,
  attacker: UnitState,
  defender: UnitState,
  options: DamageOptions = {},
): BattlePrediction | null {
  const damageToDefender = predictDamage(state, table, attacker, defender, options);
  if (damageToDefender === null) return null;

  const defenderHp = options.defenderHp ?? defender.hp ?? 10;
  const defenderHp100 = Math.round(defenderHp * 10);
  const defenderHpAfterMin = Math.max(0, defenderHp100 - damageToDefender.min);
  const guaranteedKill = defenderHp100 - damageToDefender.min <= 0;

  const counterPossible =
    !guaranteedKill &&
    !attacker.indirect &&
    !defender.indirect &&
    basePercentage(table, defender.genericId, attacker.genericId, defender.ammo) !== null;

  let damageToAttacker: DamageSpread | null = null;
  if (counterPossible) {
    damageToAttacker = predictDamage(state, table, defender, attacker, {
      ...options,
      // The counter is dealt with whatever HP survived the initial strike.
      attackerHp: defenderHpAfterMin / 10,
      defenderHp: options.attackerHp ?? attacker.hp ?? 10,
      attackerCo: options.defenderCo ?? VANILLA_CO,
      defenderCo: options.attackerCo ?? VANILLA_CO,
    });
  }

  return { damageToDefender, damageToAttacker, defenderHpAfterMin, guaranteedKill };
}

/** Value in funds of the HP a unit would lose, for trade evaluation. */
export function fundsValueOfDamage(unit: UnitState, damage100: number): number {
  const hp100 = Math.round((unit.hp ?? 10) * 10);
  const applied = Math.min(damage100, hp100);
  return (unit.cost * applied) / 100;
}
