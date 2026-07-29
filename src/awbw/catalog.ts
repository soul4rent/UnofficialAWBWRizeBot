/**
 * What a player may build, and for how much.
 *
 * Mirrors showBuildOptions (game.js:2846-2925) and findCostMultiplier
 * (game.js:3020) so the AI never queues a purchase the build menu would have
 * greyed out -- a banned unit, a lab unit without a lab, or one it cannot afford.
 */
import { g } from "./globals.js";
import type { BuildingState, GameState, PlayerState } from "./state.js";
import { numOr, tileAt } from "./state.js";
import type { AwbwGenericUnit } from "./types.js";

/** Movement types each property kind can produce (game.js:2858-2866). */
const BUILDABLE_MOVE_TYPES: Partial<Record<BuildingState["terrain"]["kind"], string[]>> = {
  BASE: ["F", "B", "T", "W", "P"],
  AIRPORT: ["A"],
  PORT: ["L", "S"],
};

export interface BuildOption {
  readonly name: string;
  /** Generic unit id -- what the Build action's `unitID` field wants. */
  readonly genericId: number;
  readonly moveType: string;
  /** Cost after the CO multiplier. */
  readonly cost: number;
  readonly baseCost: number;
}

/**
 * Per-CO unit cost multiplier (game.js:3020-3037).
 * Hachi's power discount only applies to purchases, which is the case we want.
 */
export function costMultiplier(player: PlayerState): number {
  switch (player.coName) {
    case "Kanbei":
      return 1.2;
    case "Colin":
      return 0.8;
    case "Hachi":
      return player.power.active === "Y" || player.power.active === "S" ? 0.5 : 0.9;
    default:
      return 1;
  }
}

function bannedUnits(): Record<string, unknown> {
  const banned = (globalThis as Record<string, unknown>)["banUnits"];
  return (banned as Record<string, unknown>) ?? {};
}

/**
 * Every unit this property can produce, cheapest first.
 * `funds` filtering is left to the caller so a planner can see the full list.
 */
export function buildOptionsFor(
  state: GameState,
  building: BuildingState,
  player: PlayerState,
): BuildOption[] {
  const moveTypes = BUILDABLE_MOVE_TYPES[building.terrain.kind];
  if (!moveTypes) return [];

  const multiplier = costMultiplier(player);
  const labUnits = g.labUnits();
  // AWBW exposes lab ownership as a count on the player record.
  const hasLabs = numOr((player.raw as { labs?: number }).labs ?? 0, 0) !== 0;
  const banned = bannedUnits();

  const options: BuildOption[] = [];
  for (const [name, generic] of Object.entries(g.genericUnits() ?? {})) {
    if (banned[name]) continue;
    if (labUnits && labUnits[name] && !hasLabs) continue;

    const unit = generic as AwbwGenericUnit;
    const moveType = unit.units_movement_type;
    if (!moveTypes.includes(moveType)) continue;

    const baseCost = numOr(unit.units_cost, 0);
    options.push({
      name,
      genericId: numOr(unit.units_id, -1),
      moveType,
      baseCost,
      cost: baseCost * multiplier,
    });
  }

  return options.sort((a, b) => a.cost - b.cost);
}

/** Every production property the player owns, occupied or not. */
export function productionBuildings(
  state: GameState,
  playerId: number,
): BuildingState[] {
  const found: BuildingState[] = [];
  for (const column of state.tiles) {
    for (const tile of column) {
      const building = tile.building;
      if (!building || building.playerId !== playerId) continue;
      if (!BUILDABLE_MOVE_TYPES[building.terrain.kind]) continue;
      found.push(building);
    }
  }
  return found;
}

/** Production properties the player owns with nothing standing on them. */
export function openProductionBuildings(
  state: GameState,
  playerId: number,
): BuildingState[] {
  return productionBuildings(state, playerId).filter(
    (b) => tileAt(state, b.x, b.y)?.unitId == null,
  );
}

/**
 * Template stats for a unit type, as opposed to a unit on the board.
 *
 * An AI that reasons about *counter-building* needs to talk about unit types it
 * does not own and cannot see -- "how many Anti-Airs would answer that Bomber" --
 * so it needs the roster, not just the units present. `genericUnits` is the
 * page's own copy of the awbw_units seed rows, which makes it the right source:
 * it already reflects whatever unit set this game was created with.
 */
export interface UnitTypeInfo {
  readonly name: string;
  /** Key into the ATTACK1/ATTACK2 damage tables. */
  readonly genericId: number;
  readonly cost: number;
  readonly moveType: string;
  readonly movePoints: number;
  readonly maxAmmo: number;
  readonly maxFuel: number;
  /** True for units that must fire from where they stand. */
  readonly indirect: boolean;
}

/** The whole unit roster this game was created with, keyed by unit name. */
export function unitTypes(): Map<string, UnitTypeInfo> {
  const types = new Map<string, UnitTypeInfo>();
  for (const [name, generic] of Object.entries(g.genericUnits() ?? {})) {
    const unit = generic as AwbwGenericUnit;
    const longRange = numOr(unit.units_long_range, 0);
    types.set(name, {
      name,
      genericId: numOr(unit.units_id, -1),
      cost: numOr(unit.units_cost, 0),
      moveType: unit.units_movement_type,
      movePoints: numOr(unit.units_movement_points, 0),
      maxAmmo: numOr(unit.units_ammo, 0),
      maxFuel: numOr(unit.units_fuel, 0),
      indirect: longRange > 0,
    });
  }
  return types;
}

/** Looks up a build option by unit name on a given property. */
export function findBuildOption(
  state: GameState,
  building: BuildingState,
  player: PlayerState,
  unitName: string,
): BuildOption | null {
  return buildOptionsFor(state, building, player).find((o) => o.name === unitName) ?? null;
}
