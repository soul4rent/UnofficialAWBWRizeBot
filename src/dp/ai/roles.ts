/**
 * The unit-type vocabulary JakeMan reasons in, corresponding to DefendPeace's
 * UnitModel roles and WeaponModel.getDamage (DefendPeace/src/Units/UnitModel.java:38+).
 *
 * DefendPeace is engine-agnostic, so it names units by role bitmask and asks the
 * model list which unit fills each role. That indirection buys nothing here --
 * this extension only ever plays AWBW, which has exactly one unit set -- so the
 * roles are resolved to AWBW unit names directly. Working through what
 * DefendPeace's own AWBW scheme (Units/AWBWUnits.java:59-101) resolves each
 * lookup to, JakeMan's init() picks out:
 *
 *   getUnitModel(TROOP)                  -> Infantry
 *   getAllModels(ASSAULT)[0..2]          -> Tank, Md Tank, Neotank
 *   getUnitModel(SURFACE_TO_AIR)         -> Anti-Air
 *   getUnitModel(ASSAULT|AIR, all)       -> B-Copter
 *   getUnitModel(AIR_TO_SURFACE|JET, all)-> Bomber
 *   getUnitModel(AIR_TO_AIR|JET, all)    -> Fighter
 *   getAllModels(A2S|A2A|JET, all)       -> Stealth
 *
 * The names below are AWBW's own (awbw_units.units_name), which is why "Md.Tank"
 * carries a full stop where DefendPeace writes "Md Tank".
 *
 * Everything here is pure: it takes the damage table and unit descriptions and
 * returns answers, so it can be tested without a page.
 */
import type { UnitTypeInfo } from "../../awbw/catalog.js";
import type { UnitState } from "../../awbw/state.js";
import type { AwbwDamageTable } from "../../awbw/types.js";

/**
 * What JakeMan needs to know about a unit *type*, whether or not one is on the
 * board. UnitState satisfies this structurally, so board units can be passed
 * straight in.
 */
export interface UnitType {
  readonly name: string;
  readonly genericId: number;
  readonly indirect: boolean;
}

/** AWBW unit names for the roles JakeMan names explicitly. */
export const UNIT_NAMES = {
  infantry: "Infantry",
  mech: "Mech",
  tank: "Tank",
  mdTank: "Md.Tank",
  neoTank: "Neotank",
  megaTank: "Mega Tank",
  antiAir: "Anti-Air",
  copter: "B-Copter",
  bomber: "Bomber",
  fighter: "Fighter",
  stealth: "Stealth",
} as const;

/**
 * The unit types JakeMan builds and counter-builds with, or null where this
 * game's roster has no such unit (a banned-unit game, say). DefendPeace
 * null-checks every one of these for the same reason.
 */
export interface Roles {
  readonly infantry: UnitTypeInfo | null;
  readonly tank: UnitTypeInfo | null;
  readonly mdTank: UnitTypeInfo | null;
  readonly neoTank: UnitTypeInfo | null;
  readonly antiAir: UnitTypeInfo | null;
  readonly copter: UnitTypeInfo | null;
  readonly bomber: UnitTypeInfo | null;
  readonly fighter: UnitTypeInfo | null;
  readonly stealth: UnitTypeInfo | null;
}

export function resolveRoles(types: ReadonlyMap<string, UnitTypeInfo>): Roles {
  const pick = (name: string): UnitTypeInfo | null => types.get(name) ?? null;
  return {
    infantry: pick(UNIT_NAMES.infantry),
    tank: pick(UNIT_NAMES.tank),
    mdTank: pick(UNIT_NAMES.mdTank),
    neoTank: pick(UNIT_NAMES.neoTank),
    antiAir: pick(UNIT_NAMES.antiAir),
    copter: pick(UNIT_NAMES.copter),
    bomber: pick(UNIT_NAMES.bomber),
    fighter: pick(UNIT_NAMES.fighter),
    stealth: pick(UNIT_NAMES.stealth),
  };
}

/** Movement types of ground vehicles -- DefendPeace's UnitModel.TANK role. */
const GROUND_VEHICLE_MOVE_TYPES = new Set(["T", "W", "P"]);

export function isGroundVehicle(moveType: string): boolean {
  return GROUND_VEHICLE_MOVE_TYPES.has(moveType);
}

export const AIR_MOVE_TYPE = "A";

/** Footsoldiers -- DefendPeace's UnitModel.CAPTURE role. */
const CAPTURE_MOVE_TYPES = new Set(["F", "B"]);

export function canCaptureType(moveType: string): boolean {
  return CAPTURE_MOVE_TYPES.has(moveType);
}

// --- Threat predicates ------------------------------------------------------

/**
 * The strongest base damage this attacker type can do to this defender type,
 * across both weapons -- DefendPeace's `for( WeaponModel wm : threat.weapons )`
 * loop over `wm.getDamage(um)` (JakeMan.java:737).
 *
 * Ammo is deliberately ignored: this is a question about unit *types*, asked to
 * decide what counters what, not about a particular unit's current magazine.
 */
export function maxBaseDamage(
  table: AwbwDamageTable,
  attackerGenericId: number,
  defenderGenericId: number,
): number {
  const primary = table.ATTACK1?.[attackerGenericId]?.[defenderGenericId] ?? 0;
  const secondary = table.ATTACK2?.[attackerGenericId]?.[defenderGenericId] ?? 0;
  return Math.max(primary, secondary);
}

/** True when this type can shoot anything at all. */
export function hasWeapon(table: AwbwDamageTable, type: UnitType): boolean {
  for (const bucket of [table.ATTACK1, table.ATTACK2]) {
    const row = bucket?.[type.genericId];
    if (!row) continue;
    for (const damage of Object.values(row)) if (damage > 0) return true;
  }
  return false;
}

/** What % base damage JakeMan will ignore when checking safety (JakeMan.java:63). */
export const INDIRECT_THREAT_THRESHOLD = 7;
export const DIRECT_THREAT_THRESHOLD = 30;
export const MASSIVE_THREAT_THRESHOLD = 70;

/**
 * Whether `threat` is worth worrying about if you are a `victim`.
 *
 * The threshold depends on the victim, not the threat: something that shoots
 * back at range 1 can afford to shrug off chip damage, while an indirect (or a
 * defenceless transport, which lands in the same branch) cannot. Ported from
 * JakeMan.java:733.
 */
export function isThreatenedBy(
  table: AwbwDamageTable,
  victim: UnitType,
  threat: UnitType,
): boolean {
  const shootsBack = !victim.indirect && hasWeapon(table, victim);
  const threshold = shootsBack ? DIRECT_THREAT_THRESHOLD : INDIRECT_THREAT_THRESHOLD;
  return maxBaseDamage(table, threat.genericId, victim.genericId) >= threshold;
}

/**
 * True when `victim` is prey for `hunter` -- threatened by it, and not
 * threatening in return (JakeMan.java:742). This is what sends units after
 * targets they beat rather than at whatever is nearest.
 */
export function isWeakTo(
  table: AwbwDamageTable,
  victim: UnitType,
  hunter: UnitType,
): boolean {
  return isThreatenedBy(table, victim, hunter) && !isThreatenedBy(table, hunter, victim);
}

/** Health on DefendPeace's 0-100 scale, from AWBW's 1-10 (fog reads as full). */
export function health100(unit: UnitState): number {
  return Math.round((unit.hp ?? 10) * 10);
}
