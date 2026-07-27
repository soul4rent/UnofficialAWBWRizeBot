/**
 * Shapes of the game-state records AWBW exposes to the page.
 *
 * These mirror the arrays assembled in awbw/public_html/funcs/game_map_viewer_data.php
 * and serialised into game.php's inline <script> (game.php:1185-1300).
 *
 * PHP's json_encode emits DB columns as strings about as often as numbers, and fog
 * replaces hidden values with "?" -- so numeric fields are typed loosely here and
 * coerced once, in state.ts.
 */

export type Numeric = number | string;

/** A value AWBW hides under fog of war. */
export const FOG_HIDDEN = "?";

export interface AwbwUnit {
  units_id: Numeric;
  units_games_id: Numeric;
  units_players_id: Numeric;
  units_name: string;
  /** Already adjusted for CO and CO-power effects (game_map_viewer_data.php:367). */
  units_movement_points: Numeric;
  units_vision: Numeric;
  units_fuel: Numeric;
  units_fuel_per_turn: Numeric;
  /** "Y"/"D" when a sub is dived or a stealth is hidden, "N" otherwise. */
  units_sub_dive: string;
  units_ammo: Numeric;
  units_short_range: Numeric;
  units_long_range: Numeric;
  units_second_weapon: string;
  units_cost: Numeric;
  /** AWBW movement-type code; indexes into the moveCosts table. */
  units_movement_type: string;
  units_x: Numeric;
  units_y: Numeric;
  /** "Y" once the unit has acted this turn. */
  units_moved: string;
  /** Capture progress contributed by this unit, or 0. */
  units_capture: Numeric;
  units_fired: string;
  /** 1-10, or "?" under fog. */
  units_hit_points: Numeric;
  units_cargo1_units_id: Numeric;
  units_cargo2_units_id: Numeric;
  units_carried: string;
  countries_code: string;
  /** Key into genericUnits / the ATTACK1/ATTACK2 damage tables. */
  generic_id: Numeric;
}

/** Template stats for a unit type, keyed by unit name in the `genericUnits` global. */
export interface AwbwGenericUnit {
  units_id: Numeric;
  units_name: string;
  units_cost: Numeric;
  units_movement_points: Numeric;
  units_movement_type: string;
  units_fuel: Numeric;
  units_fuel_per_turn: Numeric;
  units_ammo: Numeric;
  units_short_range: Numeric;
  units_long_range: Numeric;
  units_second_weapon: string;
  units_vision: Numeric;
}

export interface AwbwBuilding {
  /** Capture counter: 20 when untouched, counting down to 0 (game.js:3125). */
  buildings_capture: Numeric;
  buildings_id: Numeric;
  buildings_games_id: Numeric;
  buildings_players_id: Numeric;
  buildings_team: Numeric | null;
  buildings_x: Numeric;
  buildings_y: Numeric;
  countries_code: string;
  terrain_defense: Numeric;
  terrain_id: Numeric;
  terrain_name: string;
  is_occupied?: boolean;
}

export interface AwbwPlayer {
  players_id: Numeric;
  players_team: Numeric | string;
  players_funds: Numeric;
  players_income: Numeric;
  players_eliminated: string;
  players_order: Numeric;
  countries_code: string;
  co_name: string;
  /** Current power charge. */
  players_co_power: Numeric;
  /** COP / SCOP charge thresholds. Negative means the power is unavailable. */
  players_co_max_power: Numeric;
  players_co_max_spower: Numeric;
  /** "N" | "Y" (COP active) | "S" (SCOP active). */
  players_co_power_on: string;
  users_username: string;
}

/** unitMap[x][y] -- occupancy index, present only where a unit stands. */
export interface AwbwUnitMapEntry {
  units_id: Numeric;
  team: Numeric | string;
}

/**
 * A tile of the base map. terrainInfo[x][y] holds the joined awbw_tiles row, not
 * a bare id (see findTerrainCost, draw_movement.js:205). Tiles beyond the map
 * edge are "Black Tile" records with no terrain_id at all
 * (funcs/update_game_state.php:203).
 */
export interface AwbwTerrainTile {
  terrain_id?: Numeric;
  terrain_name?: string;
  tiles_x?: Numeric;
  tiles_y?: Numeric;
}

/**
 * moveCosts[terrainId][weatherCode][movementType] -> cost.
 * Built in funcs/update_game_replay_state.php:337 and read back with exactly
 * that nesting in draw_movement.js:207. A missing or zero entry means the
 * terrain is impassable for that movement type.
 */
export type AwbwMoveCosts = Record<
  string,
  Record<string, Record<string, Numeric>>
>;

/**
 * Base damage percentages: ATTACK1 is the primary weapon, ATTACK2 the secondary.
 * Indexed [attackerGenericId][defenderGenericId]. Loaded from js/damage_inc.json
 * into the `baseDamageValues` global (game.js:8793).
 */
export interface AwbwDamageTable {
  ATTACK1: Record<string, Record<string, number>>;
  ATTACK2: Record<string, Record<string, number>>;
}
