/**
 * A miniature AWBW page, for integration tests.
 *
 * The point is to reproduce one specific and easily-broken property of the real
 * page: game.php declares its state with top-level `let`/`const` in a *classic*
 * script, so those bindings live in the global lexical environment and are NOT
 * properties of globalThis. A bundle that reached for `window.unitsInfo` would
 * work fine against a naive stub and fail on the real site.
 *
 * Running the page script through node:vm at the top level of a context
 * reproduces that exactly -- `globalThis.unitsInfo` stays undefined while a bare
 * `unitsInfo` resolves.
 */
import { createContext, runInContext } from "node:vm";

export interface FakePageOptions {
  /** Extra JS appended to the page script, e.g. to override a global. */
  readonly extra?: string;
  readonly maxX?: number;
  readonly maxY?: number;
  readonly currentTurn?: number;
  readonly allViewerPId?: number[];
}

export interface FakePage {
  /** Runs source in the page context, returning its completion value. */
  run<T = unknown>(source: string): T;
  /** Everything emitData() was called with. */
  readonly sent: unknown[];
  readonly context: Record<string, unknown>;
}

/** Minimal DOM, enough for the control panel to mount without throwing. */
const DOM_STUB = `
function makeNode(tag) {
  const node = {
    tagName: tag, id: "", src: "", async: false, textContent: "", innerHTML: "",
    className: "", value: "", checked: false, style: {},
    children: [], dataset: {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { return child; },
    remove() {},
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name]; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return makeNode("stub"); },
    querySelectorAll() { return []; },
    closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return node;
}
var document = {
  head: makeNode("head"),
  body: makeNode("body"),
  documentElement: makeNode("html"),
  createElement: makeNode,
  createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};
var WebSocket = function () {};
WebSocket.OPEN = 1;
WebSocket.CLOSED = 3;
`;

/**
 * A two-player hotseat board:
 *
 *   (0,0) OS base, seat 1     (4,0) BM base, seat 2
 *   (2,0) neutral city
 *   seat 1 infantry at (0,0); seat 2 infantry at (4,0)
 *
 * Everything else is plain. Deliberately tiny so assertions stay readable.
 */
function defaultPageScript(options: FakePageOptions): string {
  const maxX = options.maxX ?? 5;
  const maxY = options.maxY ?? 1;

  return `
// --- game.php inline script (game.php:1185-1300) ---------------------------
const gameId = 42;
const gameCop = "Y";
const gameFog = "N";
let gameDay = 3;
let gameEndDate = "";
const maxX = ${maxX};
const maxY = ${maxY};
const gameWeather = { code: "C", name: "Clear" };
const gameCaptureLimit = 0;
let currentTurn = ${options.currentTurn ?? 2};
let viewerPId = 1;
let allViewerPId = ${JSON.stringify(options.allViewerPId ?? [1, 2])};
let freezeGame = false;
const banUnits = {};
const labUnits = null;

// The real roster, from awbw_units in awbw/db_sanitized.sql. An AI that
// counter-builds reasons about types nobody has built yet, so a two-entry stub
// would quietly disable half of JakeMan.
function __generic(id, name, cost, move, mType, fuel, ammo, shortR, longR) {
  return { units_id: id, units_name: name, units_cost: cost,
    units_movement_points: move, units_movement_type: mType, units_fuel: fuel,
    units_fuel_per_turn: 0, units_ammo: ammo, units_short_range: shortR,
    units_long_range: longR, units_second_weapon: "Y", units_vision: 2 };
}

const genericUnits = {
  "Infantry":   __generic(1, "Infantry", 1000, 3, "F", 99, 0, 0, 0),
  "Mech":       __generic(2, "Mech", 3000, 2, "B", 70, 3, 0, 0),
  "Md.Tank":    __generic(3, "Md.Tank", 16000, 5, "T", 50, 8, 0, 0),
  "Tank":       __generic(4, "Tank", 7000, 6, "T", 70, 9, 0, 0),
  "Recon":      __generic(5, "Recon", 4000, 8, "W", 80, 0, 0, 0),
  "APC":        __generic(6, "APC", 5000, 6, "T", 70, 0, 0, 0),
  "Artillery":  __generic(7, "Artillery", 6000, 5, "T", 50, 9, 2, 3),
  "Rocket":     __generic(8, "Rocket", 15000, 5, "W", 50, 6, 3, 5),
  "Anti-Air":   __generic(9, "Anti-Air", 8000, 6, "T", 60, 9, 0, 0),
  "Missile":    __generic(10, "Missile", 12000, 4, "W", 50, 6, 3, 5),
  "Fighter":    __generic(11, "Fighter", 20000, 9, "A", 99, 9, 0, 0),
  "Bomber":     __generic(12, "Bomber", 22000, 7, "A", 99, 9, 0, 0),
  "B-Copter":   __generic(13, "B-Copter", 9000, 6, "A", 99, 6, 0, 0),
  "T-Copter":   __generic(14, "T-Copter", 5000, 6, "A", 99, 0, 0, 0),
  "Battleship": __generic(15, "Battleship", 28000, 5, "S", 99, 9, 2, 6),
  "Cruiser":    __generic(16, "Cruiser", 18000, 6, "S", 99, 9, 0, 0),
  "Lander":     __generic(17, "Lander", 12000, 6, "L", 99, 0, 0, 0),
  "Sub":        __generic(18, "Sub", 20000, 5, "S", 60, 6, 0, 0),
  "Stealth":    __generic(30, "Stealth", 24000, 6, "A", 60, 6, 0, 0),
  "Neotank":    __generic(46, "Neotank", 22000, 6, "T", 99, 9, 0, 0),
  "Mega Tank":  __generic(1141438, "Mega Tank", 28000, 4, "T", 50, 3, 0, 0),
};

let playersInfo = {
  1: { players_id: 1, players_team: "1", players_funds: 5000, players_income: 2000,
       players_eliminated: "N", players_order: 1, countries_code: "os",
       co_name: "Andy", players_co_power: 0, players_co_max_power: 3000,
       players_co_max_spower: 6000, players_co_power_on: "N", users_username: "human" },
  2: { players_id: 2, players_team: "2", players_funds: 9000, players_income: 2000,
       players_eliminated: "N", players_order: 2, countries_code: "bm",
       co_name: "Max", players_co_power: 6000, players_co_max_power: 3000,
       players_co_max_spower: 6000, players_co_power_on: "N", users_username: "bot" },
};
let tagsInfo = {};

// terrainInfo holds joined awbw_tiles rows, not bare ids (draw_movement.js:205).
const terrainInfo = (function () {
  const grid = [];
  for (let x = 0; x < maxX; x++) {
    grid[x] = [];
    for (let y = 0; y < maxY; y++) grid[x][y] = { terrain_id: 1, terrain_name: "Plain" };
  }
  return grid;
})();

let buildingsInfo = (function () {
  const grid = [];
  for (let x = 0; x < maxX; x++) grid[x] = [];
  grid[0][0] = { buildings_id: 101, buildings_games_id: 42, buildings_players_id: 1,
    buildings_team: 1, buildings_capture: 20, buildings_x: 0, buildings_y: 0,
    countries_code: "os", terrain_defense: 3, terrain_id: 39, terrain_name: "Orange Star Base" };
  grid[2][0] = { buildings_id: 102, buildings_games_id: 42, buildings_players_id: 0,
    buildings_team: null, buildings_capture: 20, buildings_x: 2, buildings_y: 0,
    countries_code: "", terrain_defense: 3, terrain_id: 34, terrain_name: "Neutral City" };
  grid[4][0] = { buildings_id: 103, buildings_games_id: 42, buildings_players_id: 2,
    buildings_team: 2, buildings_capture: 20, buildings_x: 4, buildings_y: 0,
    countries_code: "bm", terrain_defense: 3, terrain_id: 44, terrain_name: "Blue Moon Base" };
  return grid;
})();

function makeUnit(id, playerId, x, y, template, country) {
  return {
    units_id: id, units_games_id: 42, units_players_id: playerId,
    units_name: template.units_name,
    units_movement_points: template.units_movement_points,
    units_vision: template.units_vision, units_fuel: template.units_fuel,
    units_fuel_per_turn: 0, units_sub_dive: "N", units_ammo: template.units_ammo,
    units_short_range: template.units_short_range,
    units_long_range: template.units_long_range,
    units_second_weapon: template.units_second_weapon,
    units_cost: template.units_cost,
    units_movement_type: template.units_movement_type,
    units_x: x, units_y: y, units_moved: "N", units_capture: 0, units_fired: "N",
    units_hit_points: 10, units_cargo1_units_id: 0, units_cargo2_units_id: 0,
    units_carried: "N", countries_code: country, generic_id: template.units_id,
  };
}

let unitsInfo = {
  201: makeUnit(201, 1, 0, 0, genericUnits.Infantry, "os"),
  202: makeUnit(202, 2, 4, 0, genericUnits.Infantry, "bm"),
};

let unitMap = (function () {
  const grid = [];
  for (let x = 0; x < maxX; x++) grid[x] = [];
  grid[0][0] = { units_id: 201, team: "1" };
  grid[4][0] = { units_id: 202, team: "2" };
  return grid;
})();

let playersUnits = { 1: { 201: 201 }, 2: { 202: 202 } };
let playersUnitCount = {};
let playersBuildings = {};

// moveCosts[terrainId][weather][moveType] (update_game_replay_state.php:337)
const moveCosts = (function () {
  const costs = {};
  const terrains = [1, 34, 39, 44];
  for (const t of terrains) costs[t] = { C: { F: 1, B: 1, T: 1, W: 1, A: 1, S: 1, L: 1, P: 1 } };
  return costs;
})();

// --- game.js ---------------------------------------------------------------
let ongoingAction = false;
let actionQueue = [];
let webSocket = { readyState: 1, send() {} };
const __sent = [];
let baseDamageValues = __damageTable;
let __nextUnitId = 900;

function __coordsOf(node) {
  const x = node % maxX;
  return { x: x, y: (node - x) / maxX };
}

/**
 * Hands the turn to a seat, freeing every unit to act again.
 *
 * This is the *online* handover: endTurnHandler only refetches the board when the
 * viewer holds more than one seat (game.js:5001), so records the socket has
 * already replaced stay as they are from one turn to the next.
 */
function __handTurnTo(playerId) {
  currentTurn = playerId;
  for (const id in unitsInfo) unitsInfo[id].units_moved = "N";
}

/**
 * Swaps a unit's record for the one the server sends back, the way game.js does
 * (\`unitsInfo[unitResId] = unitResponse\` in moveUnit, game.js:3146).
 *
 * The reply is a ClientDetailedUnit (api/client/mod.rs:153), which carries no
 * \`generic_id\` -- that field only ever comes from the PHP view layer
 * (game_map_viewer_data.php:388). So every unit that acts loses it, and only a
 * hotseat handover restores it. Mutating in place instead would hand the bot a
 * page it will never actually meet online.
 */
function __respondWith(unit) {
  const response = Object.assign({}, unit);
  delete response.generic_id;
  unitsInfo[unit.units_id] = response;
  return response;
}

function __placeUnit(unit, x, y) {
  delete unitMap[unit.units_x][unit.units_y];
  unit.units_x = x;
  unit.units_y = y;
  unitMap[x][y] = { units_id: unit.units_id, team: String(playersInfo[unit.units_players_id].players_team) };
}

/**
 * Applies the board effects AWBW's server would send back, so the driver sees
 * real consequences between actions -- without this, units never get marked as
 * moved and the AI re-plans the same order forever.
 */
function __applyAction(data) {
  const acting = unitsInfo[data.unitID];

  switch (data.action) {
    case "Move": {
      if (!acting) break;
      const unit = __respondWith(acting);
      const end = __coordsOf(data.path[data.path.length - 1]);
      __placeUnit(unit, end.x, end.y);
      unit.units_moved = "Y";
      break;
    }
    case "Capt": {
      if (!acting) break;
      const unit = __respondWith(acting);
      const end = __coordsOf(data.path[data.path.length - 1]);
      __placeUnit(unit, end.x, end.y);
      unit.units_moved = "Y";
      const building = buildingsInfo[end.x] && buildingsInfo[end.x][end.y];
      if (building) {
        building.buildings_capture -= Math.ceil(unit.units_hit_points);
        unit.units_capture = 20 - building.buildings_capture;
        if (building.buildings_capture <= 0) {
          building.buildings_capture = 20;
          building.buildings_players_id = unit.units_players_id;
          unit.units_capture = 0;
        }
      }
      break;
    }
    case "Fire": {
      if (!unitsInfo[data.attacker.unitID]) break;
      const attacker = __respondWith(unitsInfo[data.attacker.unitID]);
      const end = __coordsOf(data.attacker.path[data.attacker.path.length - 1]);
      __placeUnit(attacker, end.x, end.y);
      attacker.units_moved = "Y";
      attacker.units_fired = "Y";
      if (unitsInfo[data.defender.unitID]) __respondWith(unitsInfo[data.defender.unitID]);
      break;
    }
    case "Build": {
      const building = (function () {
        for (let x = 0; x < maxX; x++)
          for (let y = 0; y < maxY; y++)
            if (buildingsInfo[x][y] && buildingsInfo[x][y].buildings_id === data.buildingID)
              return buildingsInfo[x][y];
        return null;
      })();
      if (!building) break;
      const template = Object.values(genericUnits).find(function (u) {
        return u.units_id === data.unitID;
      });
      if (!template) break;

      const player = playersInfo[data.playerID];
      player.players_funds -= template.units_cost;

      const id = __nextUnitId++;
      const built = makeUnit(id, data.playerID, building.buildings_x, building.buildings_y,
                             template, player.countries_code);
      built.units_moved = "Y"; // freshly built units cannot act
      __respondWith(built);
      unitMap[building.buildings_x][building.buildings_y] =
        { units_id: id, team: String(player.players_team) };
      break;
    }
    case "Power": {
      const player = playersInfo[data.playerID];
      player.players_co_power_on = data.coPower;
      player.players_co_power = 0;
      break;
    }
    case "End": {
      currentTurn = data.playerID === 1 ? 2 : 1;
      for (const id in unitsInfo) unitsInfo[id].units_moved = "N";
      break;
    }
  }
}

/**
 * Stands in for game.js:3154 plus the round trip that follows. The client marks
 * itself busy while the response animates (game.js:1346-1347), which is exactly
 * what the driver waits on.
 */
function emitData(socket, data) {
  __sent.push(data);
  __applyAction(data);

  ongoingAction = true;
  actionQueue.push(data);
  setTimeout(function () {
    actionQueue.length = 0;
    ongoingAction = false;
  }, 1);
}

// --- draw_movement.js ------------------------------------------------------
// A faithful-enough stand-in: uniform cost 1, blocked by enemy-occupied tiles,
// which is all the fixtures above need.
function getMovementTiles(mx, my, mType, mp, startTile, unitTeam, player, draw) {
  const nodes = mx * my;
  const dist = new Array(nodes).fill(Infinity);
  const previous = new Array(nodes).fill(null);
  const mCost = new Array(nodes).fill(null);
  const start = startTile.y * mx + startTile.x;
  dist[start] = 0;
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    const x = node % mx, y = (node - x) / mx;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= mx || ny >= my) continue;
      const next = ny * mx + nx;
      const occupant = unitMap[nx] && unitMap[nx][ny];
      if (occupant && String(occupant.team) !== String(unitTeam)) {
        mCost[next] = "A";
        if (previous[next] === null) previous[next] = node;
        continue;
      }
      const step = 1;
      const cost = dist[node] + step;
      if (cost <= mp && cost < dist[next]) {
        dist[next] = cost; previous[next] = node; queue.push(next);
      }
    }
  }
  return { dist, previous, mCost, mp };
}

function findShortestPath(solved, end) {
  const { dist, previous } = solved;
  const path = [];
  if (dist[end] === Infinity && previous[end] !== null) end = previous[end];
  if (dist[end] === Infinity) return path;
  for (let i = end; i !== null; i = previous[i]) path.push(i);
  return path.reverse();
}

${options.extra ?? ""}
`;
}

export function createFakePage(
  damageTable: unknown,
  options: FakePageOptions = {},
): FakePage {
  const sent: unknown[] = [];
  const sandbox: Record<string, unknown> = {
    __damageTable: damageTable,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Infinity,
  };
  sandbox["globalThis"] = sandbox;

  const context = createContext(sandbox);
  runInContext(DOM_STUB, context, { filename: "dom-stub.js" });
  runInContext(defaultPageScript(options), context, { filename: "game.php" });

  // Mirror emitData's captures out to the test.
  const captured = runInContext("__sent", context) as unknown[];

  return {
    run<T>(source: string): T {
      return runInContext(source, context) as T;
    },
    get sent() {
      return captured;
    },
    context: sandbox,
  };
}
