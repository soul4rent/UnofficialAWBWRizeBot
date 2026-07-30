/**
 * A normalised, immutable snapshot of the AWBW board.
 *
 * Everything downstream reasons over this rather than poking at page globals, so
 * the AI can be tested against fixtures. Snapshots are cheap; take a fresh one
 * after every completed action rather than caching across a turn, because the
 * page mutates its state in place as socket responses play back.
 */
import { g } from "./globals.js";
import { TERRAIN_BY_ID, type TerrainInfo } from "./terrain-table.js";
import {
  FOG_HIDDEN,
  type AwbwGenericUnit,
  type AwbwPlayer,
  type AwbwUnit,
  type Numeric,
} from "./types.js";

/** Coerces AWBW's mixed number/string columns. Fog's "?" becomes null. */
export function num(value: Numeric | null | undefined): number | null {
  if (value === null || value === undefined || value === FOG_HIDDEN) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerces with a fallback, for fields that are never legitimately unknown. */
export function numOr(value: Numeric | null | undefined, fallback: number): number {
  return num(value) ?? fallback;
}

export interface Coord {
  readonly x: number;
  readonly y: number;
}

export interface UnitState {
  readonly id: number;
  readonly playerId: number;
  readonly name: string;
  /** Key into genericUnits and the ATTACK1/ATTACK2 damage tables. */
  readonly genericId: number;
  readonly x: number;
  readonly y: number;
  /** 1-10, or null when fog hides it. */
  readonly hp: number | null;
  readonly fuel: number;
  readonly ammo: number;
  readonly movePoints: number;
  readonly moveType: string;
  /**
   * Attack range, inclusive. AWBW stores direct-combat units with both
   * short_range and long_range at 0, which means "adjacent only" -- normalised
   * to [1, 1] here. Indirect units carry a real [short, long] span.
   */
  readonly minRange: number;
  readonly maxRange: number;
  /**
   * True for indirect units. This is the flag the engine actually branches on:
   * a counterattack is skipped when *either* combatant is indirect
   * (awbw/server/awbw-engine/src/helper/fire.rs:430).
   */
  readonly indirect: boolean;
  readonly hasSecondWeapon: boolean;
  readonly cost: number;
  readonly countryCode: string;
  /** True once the unit has acted this turn and can no longer be ordered. */
  readonly moved: boolean;
  readonly fired: boolean;
  /** Capture progress this unit has already contributed to the tile it stands on. */
  readonly captureProgress: number;
  /** Sub dived or stealth hidden. */
  readonly hidden: boolean;
  /** True while loaded inside a transport. */
  readonly carried: boolean;
  readonly cargo: readonly number[];
}

export interface BuildingState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** Owning player, or null when neutral. */
  readonly playerId: number | null;
  readonly terrainId: number;
  readonly terrain: TerrainInfo;
  /** Capture counter: 20 when untouched, 0 when captured (game.js:3125). */
  readonly captureLeft: number;
  readonly countryCode: string;
}

export interface PowerState {
  readonly charge: number;
  /** Charge needed for a COP; null when the CO has no COP. */
  readonly copAt: number | null;
  /** Charge needed for a SCOP; null when the CO has no SCOP. */
  readonly scopAt: number | null;
  /** "N" | "Y" (COP running) | "S" (SCOP running). */
  readonly active: string;
}

export interface PlayerState {
  readonly id: number;
  readonly team: string;
  readonly funds: number;
  readonly income: number;
  readonly eliminated: boolean;
  readonly order: number;
  readonly countryCode: string;
  readonly coName: string;
  readonly username: string;
  readonly power: PowerState;
  /** The raw record, for the few call sites AWBW's own helpers demand it. */
  readonly raw: AwbwPlayer;
}

export interface TileState {
  readonly x: number;
  readonly y: number;
  readonly terrainId: number;
  readonly terrain: TerrainInfo;
  /** Present when the tile is a property (buildingsInfo, not terrainInfo). */
  readonly building: BuildingState | null;
  /** Occupying unit id, if any is visible. */
  readonly unitId: number | null;
}

export interface GameState {
  readonly gameId: number;
  readonly day: number;
  readonly fog: boolean;
  readonly powersEnabled: boolean;
  readonly weather: string;
  readonly width: number;
  readonly height: number;
  readonly currentTurn: number;
  readonly gameOver: boolean;
  /** Seats the browser session controls; length > 1 means hotseat. */
  readonly controlledSeats: readonly number[];
  readonly captureLimit: number;
  readonly tiles: readonly (readonly TileState[])[];
  readonly units: ReadonlyMap<number, UnitState>;
  readonly players: ReadonlyMap<number, PlayerState>;
}

const UNKNOWN_TERRAIN: TerrainInfo = {
  id: -1,
  name: "Unknown",
  kind: "PLAIN",
  defense: 0,
  country: null,
  isProperty: false,
  capturable: false,
  producesIncome: false,
  active: false,
};

function terrainFor(id: number | null): TerrainInfo {
  if (id === null) return UNKNOWN_TERRAIN;
  return TERRAIN_BY_ID[id] ?? { ...UNKNOWN_TERRAIN, id };
}

/** AWBW's capture counter: a pristine, uncaptured property reads 20. */
const FULL_CAPTURE = 20;

/**
 * Capture progress a unit standing on (x,y) has banked, read from the *building*
 * rather than the unit.
 *
 * AWBW clears units_capture to 0 at the start of every turn (new_turn.php:423)
 * and only ever sets it to a bare 1 flag on a partial capture
 * (capture_building.php:122), so the unit's own field cannot tell us it is
 * mid-capture once its turn comes round again. The building's counter is what
 * persists -- it drops as the capture progresses and only springs back to 20
 * when the footsoldier steps off (perform_move.php:150). So a capturable
 * property sitting below full, that is not already ours, is one this unit is
 * partway through taking.
 */
function captureProgressAt(
  buildings: ReturnType<typeof g.buildings>,
  x: number,
  y: number,
  unitPlayerId: number,
): number {
  const raw = buildings[x]?.[y];
  if (!raw) return 0;
  if (!terrainFor(num(raw.terrain_id)).capturable) return 0;

  const owner = num(raw.buildings_players_id);
  const ownerId = owner !== null && owner > 0 ? owner : null;
  if (ownerId === unitPlayerId) return 0;

  const captureLeft = numOr(raw.buildings_capture, FULL_CAPTURE);
  return captureLeft < FULL_CAPTURE ? FULL_CAPTURE - captureLeft : 0;
}

function readPlayers(): Map<number, PlayerState> {
  const players = new Map<number, PlayerState>();
  for (const [key, raw] of Object.entries(g.players())) {
    const id = numOr(key, -1);
    if (id < 0) continue;

    // A negative threshold is AWBW's way of saying "this CO has no such power"
    // (see updateMainPowerButtons, game.js:6164).
    const maxPower = numOr(raw.players_co_max_power, -1);
    const maxSpower = numOr(raw.players_co_max_spower, -1);

    players.set(id, {
      id,
      team: String(raw.players_team),
      funds: numOr(raw.players_funds, 0),
      income: numOr(raw.players_income, 0),
      eliminated: raw.players_eliminated !== "N",
      order: numOr(raw.players_order, 0),
      countryCode: raw.countries_code,
      coName: raw.co_name,
      username: raw.users_username,
      power: {
        charge: numOr(raw.players_co_power, 0),
        copAt: maxPower < 0 ? null : Math.abs(maxPower),
        scopAt: maxSpower < 0 ? null : Math.abs(maxSpower),
        active: raw.players_co_power_on ?? "N",
      },
      raw,
    });
  }
  return players;
}

/**
 * The unit's key into the damage tables, resolved by name rather than trusted
 * from the record.
 *
 * `generic_id` is not a column -- PHP synthesises it per render as
 * `$genericUnits[$unitName]["units_id"]` (game_map_viewer_data.php:388). The
 * socket sends back `ClientDetailedUnit` (api/client/mod.rs:153), which has no
 * such field, and game.js swaps the record in wholesale on every order
 * (`unitsInfo[unitResId] = unitResponse` in moveUnit, game.js:3146). So the
 * field vanishes from any unit that acts.
 *
 * Hotseat hides this: handing over the turn calls swapActiveVision (game.js:5001,
 * guarded on `allViewerPId.length > 1`), which refetches through the PHP view and
 * puts `generic_id` back. Online the account holds one seat, that guard is false,
 * and nothing ever restores it -- leaving the AI unable to look up any damage
 * figure, so it neither shoots nor recognises a threat.
 *
 * `genericUnits` is a page-load constant keyed by the same unit names, and no
 * socket traffic touches it, so it is the stable source.
 */
function genericIdFor(generics: Record<string, AwbwGenericUnit>, raw: AwbwUnit): number {
  const byName = numOr(generics[raw.units_name]?.units_id, -1);
  return byName > 0 ? byName : numOr(raw.generic_id, -1);
}

function readUnits(): Map<number, UnitState> {
  const units = new Map<number, UnitState>();
  const buildings = g.buildings();
  const generics = g.genericUnits() ?? {};
  for (const raw of Object.values(g.units())) {
    const id = num(raw.units_id);
    const playerId = num(raw.units_players_id);
    const x = num(raw.units_x);
    const y = num(raw.units_y);
    if (id === null || playerId === null || x === null || y === null) continue;

    const cargo = [raw.units_cargo1_units_id, raw.units_cargo2_units_id]
      .map(num)
      .filter((c): c is number => c !== null && c > 0);

    const dive = raw.units_sub_dive;
    const shortRange = numOr(raw.units_short_range, 0);
    const longRange = numOr(raw.units_long_range, 0);
    const indirect = longRange > 0;

    units.set(id, {
      id,
      playerId,
      name: raw.units_name,
      genericId: genericIdFor(generics, raw),
      x,
      y,
      hp: num(raw.units_hit_points),
      fuel: numOr(raw.units_fuel, 0),
      ammo: numOr(raw.units_ammo, 0),
      movePoints: numOr(raw.units_movement_points, 0),
      moveType: raw.units_movement_type,
      minRange: indirect ? shortRange : 1,
      maxRange: indirect ? longRange : 1,
      indirect,
      hasSecondWeapon: raw.units_second_weapon === "Y",
      cost: numOr(raw.units_cost, 0),
      countryCode: raw.countries_code,
      moved: raw.units_moved === "Y" || numOr(raw.units_moved, 0) === 1,
      fired: raw.units_fired === "Y" || numOr(raw.units_fired, 0) === 1,
      captureProgress: captureProgressAt(buildings, x, y, playerId),
      hidden: dive === "Y" || dive === "D",
      carried: raw.units_carried === "Y",
      cargo,
    });
  }
  return units;
}

function readTiles(width: number, height: number): TileState[][] {
  const terrain = g.terrain();
  const buildings = g.buildings();
  const occupancy = g.unitMap();

  const tiles: TileState[][] = [];
  for (let x = 0; x < width; x++) {
    const column: TileState[] = [];
    for (let y = 0; y < height; y++) {
      const rawBuilding = buildings[x]?.[y];
      let building: BuildingState | null = null;
      let terrainId: number | null;

      if (rawBuilding) {
        terrainId = num(rawBuilding.terrain_id);
        const owner = num(rawBuilding.buildings_players_id);
        building = {
          id: numOr(rawBuilding.buildings_id, -1),
          x,
          y,
          // AWBW stores neutral properties with player id 0.
          playerId: owner !== null && owner > 0 ? owner : null,
          terrainId: terrainId ?? -1,
          terrain: terrainFor(terrainId),
          captureLeft: numOr(rawBuilding.buildings_capture, 20),
          countryCode: rawBuilding.countries_code ?? "",
        };
      } else {
        // terrainInfo holds joined awbw_tiles rows; off-map "Black Tile"
        // records carry no terrain_id (update_game_state.php:203).
        terrainId = num(terrain[x]?.[y]?.terrain_id ?? null);
      }

      column.push({
        x,
        y,
        terrainId: terrainId ?? -1,
        terrain: building ? building.terrain : terrainFor(terrainId),
        building,
        unitId: num(occupancy[x]?.[y]?.units_id ?? null),
      });
    }
    tiles.push(column);
  }
  return tiles;
}

/** Reads the live page state into an immutable snapshot. */
export function snapshot(): GameState {
  const width = g.maxX();
  const height = g.maxY();

  return {
    gameId: g.gameId(),
    day: g.gameDay(),
    fog: g.gameFog() === "Y",
    powersEnabled: g.gameCop() === "Y",
    weather: g.weather().name,
    width,
    height,
    currentTurn: g.currentTurn(),
    gameOver: g.gameOver(),
    controlledSeats: [...g.allViewerPId()].map((id) => numOr(id, -1)),
    captureLimit: numOr(g.captureLimit(), 0),
    tiles: readTiles(width, height),
    units: readUnits(),
    players: readPlayers(),
  };
}

// --- Queries ----------------------------------------------------------------

export function tileAt(state: GameState, x: number, y: number): TileState | null {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
  return state.tiles[x]?.[y] ?? null;
}

export function unitAt(state: GameState, x: number, y: number): UnitState | null {
  const id = tileAt(state, x, y)?.unitId;
  return id != null ? (state.units.get(id) ?? null) : null;
}

export function unitsOf(state: GameState, playerId: number): UnitState[] {
  return [...state.units.values()].filter((u) => u.playerId === playerId && !u.carried);
}

/** Units that still have an action available this turn. */
export function actionableUnits(state: GameState, playerId: number): UnitState[] {
  return unitsOf(state, playerId).filter((u) => !u.moved);
}

export function buildingsOf(state: GameState, playerId: number | null): BuildingState[] {
  const found: BuildingState[] = [];
  for (const column of state.tiles) {
    for (const tile of column) {
      if (tile.building && tile.building.playerId === playerId) found.push(tile.building);
    }
  }
  return found;
}

/** True when two players are on the same team (AWBW teams are strings). */
export function areAllied(state: GameState, a: number, b: number): boolean {
  if (a === b) return true;
  const teamA = state.players.get(a)?.team;
  const teamB = state.players.get(b)?.team;
  return teamA !== undefined && teamA === teamB;
}

export function isEnemy(state: GameState, viewer: number, other: number): boolean {
  return !areAllied(state, viewer, other);
}

/** Manhattan distance -- AWBW ranges and movement are both orthogonal. */
export function distance(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * AWBW addresses tiles by a flat node index in its movement graph and in the
 * `path` arrays sent to the server (draw_movement.js:35).
 */
export function toNode(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

export function fromNode(state: GameState, node: number): Coord {
  const x = node % state.width;
  return { x, y: (node - x) / state.width };
}
