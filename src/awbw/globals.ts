/**
 * Access to AWBW's page-scope state.
 *
 * game.php declares its game state with top-level `let`/`const` in a classic
 * <script> (game.php:1185-1300). Those bindings live in the global *lexical*
 * environment, which means they are NOT properties of `window` -- `window.unitsInfo`
 * is undefined even though `unitsInfo` resolves. So we must reference them as bare
 * identifiers, which works because our bundle is injected as a classic script and
 * resolves up the scope chain to the same global environment.
 *
 * Every read is wrapped in a `typeof` guard: a bare reference to a missing binding
 * throws ReferenceError, and we would rather report a precise "AWBW changed" error
 * than half-play a turn. See requireGlobals().
 */
import type {
  AwbwBuilding,
  AwbwDamageTable,
  AwbwGenericUnit,
  AwbwMoveCosts,
  AwbwPlayer,
  AwbwTerrainTile,
  AwbwUnit,
  AwbwUnitMapEntry,
  Numeric,
} from "./types.js";

// --- Bindings owned by game.php's inline script -----------------------------
declare const unitsInfo: Record<string, AwbwUnit>;
declare const unitMap: Array<Array<AwbwUnitMapEntry | undefined> | undefined>;
declare const buildingsInfo: Array<Array<AwbwBuilding | undefined> | undefined>;
declare const terrainInfo: Array<Array<AwbwTerrainTile | undefined> | undefined>;
declare const playersInfo: Record<string, AwbwPlayer>;
declare const playersUnits: Record<string, Record<string, Numeric>>;
declare const playersBuildings: Record<string, unknown>;
declare const genericUnits: Record<string, AwbwGenericUnit>;
declare const moveCosts: AwbwMoveCosts;
declare const banUnits: unknown;
declare const labUnits: Record<string, unknown> | null;
declare const gameId: number;
declare const gameFog: string;
declare const gameCop: string;
declare const gameDay: number;
declare const gameEndDate: string;
declare const gameWeather: { code: string; name: string };
declare const gameCaptureLimit: Numeric;
declare const maxX: number;
declare const maxY: number;
declare const currentTurn: number;
declare const viewerPId: number;
declare const allViewerPId: number[];
declare const freezeGame: boolean;

// --- Bindings owned by js/<build>/game.js -----------------------------------
declare const webSocket: WebSocket;
declare const baseDamageValues: AwbwDamageTable | undefined;
declare const ongoingAction: boolean;
declare const actionQueue: unknown[];
declare function emitData(socket: WebSocket, data: unknown): void;

// --- Bindings owned by js/<build>/draw_movement.js --------------------------
/**
 * AWBW's own movement solver. Returns the solved graph used by findShortestPath.
 * Pass draw=false to compute without painting tiles onto the board
 * (see the debug_attack helper at game.js:8862 for the read-only call shape).
 */
declare function getMovementTiles(
  maxX: number,
  maxY: number,
  mType: string,
  mp: number,
  startTile: { x: number; y: number },
  unitTeam: Numeric | string,
  player: AwbwPlayer,
  draw?: boolean,
): unknown;
/** Turns a solved graph plus a destination node index into a path of node indices. */
declare function findShortestPath(solved: unknown, end: number): number[];

/**
 * The globals we refuse to run without. Production serves js/lib rather than
 * js/src; symbol parity holds today (js/lib is a plain Babel transpile of
 * js/src -- see the `compilegame` script in awbw/public_html/js/socketserver/
 * package.json, which does not minify or rename), but it is a build output, so
 * we check rather than assume.
 *
 * Each entry probes with `typeof` on a *bare* identifier. That is the one
 * operator that tolerates an undeclared name instead of throwing ReferenceError,
 * which lets us test for AWBW's `let`/`const` bindings without eval.
 */
const REQUIRED_GLOBALS: ReadonlyArray<readonly [string, () => boolean]> = [
  ["unitsInfo", () => typeof unitsInfo !== "undefined"],
  ["unitMap", () => typeof unitMap !== "undefined"],
  ["buildingsInfo", () => typeof buildingsInfo !== "undefined"],
  ["terrainInfo", () => typeof terrainInfo !== "undefined"],
  ["playersInfo", () => typeof playersInfo !== "undefined"],
  ["genericUnits", () => typeof genericUnits !== "undefined"],
  ["moveCosts", () => typeof moveCosts !== "undefined"],
  ["maxX", () => typeof maxX !== "undefined"],
  ["maxY", () => typeof maxY !== "undefined"],
  ["currentTurn", () => typeof currentTurn !== "undefined"],
  ["allViewerPId", () => typeof allViewerPId !== "undefined"],
  ["webSocket", () => typeof webSocket !== "undefined"],
  ["emitData", () => typeof emitData !== "undefined"],
  ["getMovementTiles", () => typeof getMovementTiles !== "undefined"],
  ["findShortestPath", () => typeof findShortestPath !== "undefined"],
];

export class MissingGlobalsError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `AWBW page is missing expected globals: ${missing.join(", ")}. ` +
        `The site's client has probably changed; refusing to act.`,
    );
    this.name = "MissingGlobalsError";
  }
}

/** Throws MissingGlobalsError unless every binding we depend on is present. */
export function requireGlobals(): void {
  const missing = REQUIRED_GLOBALS.filter(([, probe]) => !probe()).map(([name]) => name);
  if (missing.length > 0) throw new MissingGlobalsError(missing);
}

/** True when the page looks like a playable AWBW game (not a replay or map view). */
export function isGamePage(): boolean {
  return typeof gameId !== "undefined" && typeof playersInfo !== "undefined";
}

// --- Accessors --------------------------------------------------------------
// `webSocket` is reassigned on reconnect (game.js:1444) and `currentTurn`,
// `ongoingAction` and `actionQueue` all mutate constantly, so every one of these
// reads live rather than caching.

export const g = {
  units: () => unitsInfo,
  unitMap: () => unitMap,
  buildings: () => buildingsInfo,
  terrain: () => terrainInfo,
  players: () => playersInfo,
  playersUnits: () => playersUnits,
  playersBuildings: () => playersBuildings,
  genericUnits: () => genericUnits,
  moveCosts: () => moveCosts,
  labUnits: () => (typeof labUnits !== "undefined" ? labUnits : null),
  gameId: () => gameId,
  gameDay: () => (typeof gameDay !== "undefined" ? gameDay : 0),
  gameFog: () => (typeof gameFog !== "undefined" ? gameFog : "N"),
  gameCop: () => (typeof gameCop !== "undefined" ? gameCop : "N"),
  gameOver: () =>
    typeof gameEndDate !== "undefined" && gameEndDate !== "" && gameEndDate !== "0",
  weather: () =>
    typeof gameWeather !== "undefined" ? gameWeather : { code: "C", name: "Clear" },
  captureLimit: () => (typeof gameCaptureLimit !== "undefined" ? gameCaptureLimit : 0),
  maxX: () => maxX,
  maxY: () => maxY,
  currentTurn: () => currentTurn,
  viewerPId: () => (typeof viewerPId !== "undefined" ? viewerPId : 0),
  allViewerPId: () => (typeof allViewerPId !== "undefined" ? allViewerPId : []),
  frozen: () => typeof freezeGame !== "undefined" && freezeGame === true,

  socket: () => webSocket,
  damageTable: () => (typeof baseDamageValues !== "undefined" ? baseDamageValues : undefined),
  ongoingAction: () => typeof ongoingAction !== "undefined" && ongoingAction === true,
  queueLength: () => (typeof actionQueue !== "undefined" ? actionQueue.length : 0),

  /**
   * Sends through AWBW's own emitter rather than touching the socket directly,
   * so any future change to its transport carries over for free (game.js:3154).
   */
  emit: (data: unknown) => emitData(webSocket, data),

  solveMovement: (
    mType: string,
    mp: number,
    start: { x: number; y: number },
    team: Numeric | string,
    player: AwbwPlayer,
  ) => getMovementTiles(maxX, maxY, mType, mp, start, team, player, false),
  shortestPath: (solved: unknown, end: number) => findShortestPath(solved, end),
};

/** True when this game is a hotseat game (the viewer controls more than one seat). */
export function isHotseat(): boolean {
  return g.allViewerPId().length > 1;
}
