/**
 * What a player may build, and for how much.
 *
 * Mirrors showBuildOptions (game.js:2846-2925) and findCostMultiplier
 * (game.js:3020) so the AI never queues a purchase the build menu would have
 * greyed out -- a banned unit, a lab unit without a lab, or one it cannot afford.
 */
import { g } from "./globals.js";
import type { BuildingState, GameState, PlayerState } from "./state.js";
import { numOr } from "./state.js";
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

/** Production properties the player owns with nothing standing on them. */
export function openProductionBuildings(
  state: GameState,
  playerId: number,
): BuildingState[] {
  const open: BuildingState[] = [];
  for (const column of state.tiles) {
    for (const tile of column) {
      const building = tile.building;
      if (!building || building.playerId !== playerId) continue;
      if (!BUILDABLE_MOVE_TYPES[building.terrain.kind]) continue;
      if (tile.unitId !== null) continue;
      open.push(building);
    }
  }
  return open;
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
