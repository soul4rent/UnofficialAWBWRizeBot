/**
 * Minimal GameState builders for tests, so specs can describe a board without
 * standing up the whole AWBW page.
 */
import { TERRAIN_BY_ID, type TerrainInfo } from "../../src/awbw/terrain-table.js";
import type {
  BuildingState,
  GameState,
  PlayerState,
  TileState,
  UnitState,
} from "../../src/awbw/state.js";
import type { AwbwPlayer } from "../../src/awbw/types.js";

export const TERRAIN = {
  PLAIN: 1,
  MOUNTAIN: 2,
  WOOD: 3,
  ROAD: 15,
  SEA: 28,
  REEF: 33,
  NEUTRAL_CITY: 34,
  NEUTRAL_BASE: 35,
  OS_CITY: 38,
  OS_BASE: 39,
  OS_HQ: 42,
  BM_CITY: 43,
  BM_BASE: 44,
  BM_HQ: 47,
  HPIPE_SEAM: 113,
  NEUTRAL_COM_TOWER: 133,
} as const;

/** Generic unit ids, as used by the ATTACK1/ATTACK2 damage tables. */
export const UNIT = {
  INFANTRY: 1,
  MECH: 2,
  MD_TANK: 3,
  TANK: 4,
  RECON: 5,
  APC: 6,
  ARTILLERY: 7,
  ROCKET: 8,
  ANTI_AIR: 9,
  MISSILE: 10,
  FIGHTER: 11,
  BOMBER: 12,
  B_COPTER: 13,
  T_COPTER: 14,
  BATTLESHIP: 15,
  CRUISER: 16,
  LANDER: 17,
  SUB: 18,
} as const;

let nextUnitId = 1;

export function resetIds(): void {
  nextUnitId = 1;
}

export interface UnitSpec extends Partial<UnitState> {
  playerId: number;
  x: number;
  y: number;
}

const UNIT_DEFAULTS: Record<number, Partial<UnitState>> = {
  [UNIT.INFANTRY]: {
    name: "Infantry",
    genericId: UNIT.INFANTRY,
    moveType: "F",
    movePoints: 3,
    ammo: 0,
    cost: 1000,
  },
  [UNIT.MECH]: {
    name: "Mech",
    genericId: UNIT.MECH,
    moveType: "B",
    movePoints: 2,
    ammo: 3,
    cost: 3000,
  },
  [UNIT.TANK]: {
    name: "Tank",
    genericId: UNIT.TANK,
    moveType: "T",
    movePoints: 6,
    ammo: 9,
    cost: 7000,
  },
  [UNIT.ARTILLERY]: {
    name: "Artillery",
    genericId: UNIT.ARTILLERY,
    moveType: "T",
    movePoints: 5,
    ammo: 9,
    cost: 6000,
    indirect: true,
    minRange: 2,
    maxRange: 3,
  },
  [UNIT.FIGHTER]: {
    name: "Fighter",
    genericId: UNIT.FIGHTER,
    moveType: "A",
    movePoints: 9,
    ammo: 9,
    cost: 20000,
  },
  [UNIT.SUB]: {
    name: "Sub",
    genericId: UNIT.SUB,
    moveType: "S",
    movePoints: 5,
    ammo: 6,
    cost: 20000,
  },
};

export function unit(genericId: number, spec: UnitSpec): UnitState {
  const defaults = UNIT_DEFAULTS[genericId] ?? {};
  return {
    id: nextUnitId++,
    name: "Unit",
    genericId,
    hp: 10,
    fuel: 99,
    ammo: 9,
    movePoints: 3,
    moveType: "F",
    minRange: 1,
    maxRange: 1,
    indirect: false,
    hasSecondWeapon: true,
    cost: 1000,
    countryCode: "os",
    moved: false,
    fired: false,
    captureProgress: 0,
    hidden: false,
    carried: false,
    cargo: [],
    ...defaults,
    ...spec,
  } as UnitState;
}

function terrainInfoFor(id: number): TerrainInfo {
  const found = TERRAIN_BY_ID[id];
  if (!found) throw new Error(`unknown terrain id ${id}`);
  return found;
}

export interface PlayerSpec extends Partial<PlayerState> {
  id: number;
}

export function player(spec: PlayerSpec): PlayerState {
  const raw = {} as AwbwPlayer;
  return {
    team: String(spec.id),
    funds: 0,
    income: 0,
    eliminated: false,
    order: spec.id,
    countryCode: "os",
    coName: "Andy",
    username: `p${spec.id}`,
    power: { charge: 0, copAt: 3000, scopAt: 6000, active: "N" },
    raw,
    ...spec,
  };
}

export interface BoardSpec {
  width: number;
  height: number;
  /** Default terrain for every tile. */
  fill?: number;
  /** Per-tile terrain overrides, as "x,y" -> terrain id. */
  terrain?: Record<string, number>;
  /** Property ownership, as "x,y" -> player id (or null for neutral). */
  owners?: Record<string, number | null>;
  units?: UnitState[];
  players?: PlayerState[];
  currentTurn?: number;
  day?: number;
  fog?: boolean;
}

export function board(spec: BoardSpec): GameState {
  const {
    width,
    height,
    fill = TERRAIN.PLAIN,
    terrain = {},
    owners = {},
    units = [],
    players = [player({ id: 1 }), player({ id: 2 })],
    currentTurn = 1,
    day = 1,
    fog = false,
  } = spec;

  const unitsById = new Map(units.map((u) => [u.id, u]));
  const occupancy = new Map<string, number>();
  for (const u of units) {
    if (!u.carried) occupancy.set(`${u.x},${u.y}`, u.id);
  }

  let buildingId = 1;
  const tiles: TileState[][] = [];
  for (let x = 0; x < width; x++) {
    const column: TileState[] = [];
    for (let y = 0; y < height; y++) {
      const key = `${x},${y}`;
      const terrainId = terrain[key] ?? fill;
      const info = terrainInfoFor(terrainId);

      let building: BuildingState | null = null;
      if (info.isProperty) {
        const owner = key in owners ? owners[key]! : null;
        building = {
          id: buildingId++,
          x,
          y,
          playerId: owner,
          terrainId,
          terrain: info,
          captureLeft: 20,
          countryCode: info.country ?? "",
        };
      }

      column.push({
        x,
        y,
        terrainId,
        terrain: info,
        building,
        unitId: occupancy.get(key) ?? null,
      });
    }
    tiles.push(column);
  }

  return {
    gameId: 1,
    day,
    fog,
    powersEnabled: true,
    weather: "Clear",
    width,
    height,
    currentTurn,
    gameOver: false,
    controlledSeats: [1, 2],
    captureLimit: 0,
    tiles,
    units: unitsById,
    players: new Map(players.map((p) => [p.id, p])),
  };
}
