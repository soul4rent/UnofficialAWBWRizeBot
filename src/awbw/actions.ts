/**
 * The wire format AWBW's client speaks.
 *
 * Every payload here is a transcription of the object the real UI builds at the
 * cited line in awbw/public_html/js/src/game.js. We send through the page's own
 * emitData() (game.js:3154) rather than touching the socket, so any future change
 * to its transport carries over for free.
 *
 * The board animates identically whether a human clicked or we emitted: the UI
 * redraws from the server's socket response via the actionHandlers table
 * (game.js:1312), not from the click itself.
 *
 * `path` is an array of flat node indices (y * width + x), produced by AWBW's own
 * pathfinder -- see pathing.ts. A path is always non-empty and starts at the
 * unit's current tile; a unit that acts without moving sends just [startNode].
 */
import { g } from "./globals.js";

export type ActionName =
  | "Move"
  | "Capt"
  | "Fire"
  | "AttackSeam"
  | "Build"
  | "Load"
  | "Unload"
  | "Join"
  | "Supply"
  | "Repair"
  | "Hide"
  | "Unhide"
  | "Delete"
  | "Explode"
  | "Launch"
  | "Power"
  | "End"
  | "Tag";

export interface ActionEnvelope {
  action: ActionName;
  [key: string]: unknown;
}

/** Set by main.ts; when false, payloads are logged but never sent. */
let dryRun = false;
let lastSent: ActionEnvelope | null = null;

export function setDryRun(value: boolean): void {
  dryRun = value;
}

export function isDryRun(): boolean {
  return dryRun;
}

export function lastAction(): ActionEnvelope | null {
  return lastSent;
}

function send(payload: ActionEnvelope): ActionEnvelope {
  lastSent = payload;
  if (dryRun) {
    console.info("[awbw-bot] (dry run) would send", payload);
    return payload;
  }
  g.emit(payload);
  return payload;
}

// --- Unit orders ------------------------------------------------------------

/** Move and wait. game.js:2019 */
export function move(playerId: number, unitId: number, path: number[]): ActionEnvelope {
  return send({ action: "Move", path, playerID: playerId, unitID: unitId });
}

/** Move then capture the property underfoot. game.js:1922 */
export function capture(playerId: number, unitId: number, path: number[]): ActionEnvelope {
  return send({ action: "Capt", playerID: playerId, unitID: unitId, path });
}

/**
 * Move then attack. game.js:8869
 * `path` ends on the tile the attack is made from; for an indirect firing in
 * place that is just its current tile.
 */
export function fire(
  attacker: { playerId: number; unitId: number; path: number[] },
  defender: { playerId: number; unitId: number },
): ActionEnvelope {
  return send({
    action: "Fire",
    attacker: {
      playerID: attacker.playerId,
      unitID: attacker.unitId,
      path: attacker.path,
    },
    defender: { playerID: defender.playerId, unitID: defender.unitId },
  });
}

/** Attack a pipe seam, which is addressed by building id rather than unit id. game.js:8884 */
export function attackSeam(
  attacker: { playerId: number; unitId: number; path: number[] },
  seamId: number,
): ActionEnvelope {
  return send({
    action: "AttackSeam",
    attacker: {
      playerID: attacker.playerId,
      unitID: attacker.unitId,
      path: attacker.path,
    },
    seamID: seamId,
  });
}

/** Load into a transport standing at the end of the path. game.js:1930 */
export function load(
  playerId: number,
  cargoUnitId: number,
  transportId: number,
  path: number[],
): ActionEnvelope {
  return send({
    action: "Load",
    playerID: playerId,
    loadID: cargoUnitId,
    transportID: transportId,
    path,
  });
}

/**
 * Drop a passenger onto an adjacent tile. game.js:2694
 * Note this one carries no path: the transport is expected to have already moved.
 */
export function unload(
  playerId: number,
  transportUnitId: number,
  dropX: number,
  dropY: number,
): ActionEnvelope {
  return send({
    action: "Unload",
    playerID: playerId,
    unitID: transportUnitId,
    dropX,
    dropY,
  });
}

/** Merge into an allied unit of the same type. game.js:1987 */
export function join(playerId: number, unitId: number, path: number[]): ActionEnvelope {
  return send({ action: "Join", joinID: unitId, path, playerID: playerId });
}

/** APC resupply of adjacent allies. game.js:1976 */
export function supply(playerId: number, unitId: number, path: number[]): ActionEnvelope {
  return send({ action: "Supply", path, playerID: playerId, unitID: unitId });
}

/** Black Boat repair of a specific adjacent ally. game.js:2709 */
export function repair(
  playerId: number,
  boatUnitId: number,
  targetUnitId: number,
  path: number[],
): ActionEnvelope {
  return send({
    action: "Repair",
    playerID: playerId,
    targetID: targetUnitId,
    unitID: boatUnitId,
    path,
  });
}

/** Sub dive / stealth cloak. game.js:1954 */
export function hide(playerId: number, unitId: number, path: number[]): ActionEnvelope {
  return send({ action: "Hide", path, playerID: playerId, unitID: unitId });
}

/** Surface / decloak. game.js:1965 */
export function unhide(playerId: number, unitId: number, path: number[]): ActionEnvelope {
  return send({ action: "Unhide", path, playerID: playerId, unitID: unitId });
}

/** Scrap a unit where it stands. game.js:2011 */
export function deleteUnit(playerId: number, unitId: number): ActionEnvelope {
  return send({ action: "Delete", playerID: playerId, unitID: unitId });
}

/** Detonate a Black Bomb. game.js:2360 */
export function explode(playerId: number, unitId: number, path: number[]): ActionEnvelope {
  return send({ action: "Explode", path, playerID: playerId, unitID: unitId });
}

/**
 * Fire a missile silo. game.js:2336
 *
 * AWBW spells this one `unitId` rather than the `unitID` every other action
 * uses. That inconsistency is load-bearing -- the server reads exactly this key.
 */
export function launchSilo(
  playerId: number,
  unitId: number,
  from: { x: number; y: number },
  target: { x: number; y: number },
  path: number[],
): ActionEnvelope {
  return send({
    action: "Launch",
    playerID: playerId,
    targetX: target.x,
    targetY: target.y,
    unitId: unitId,
    unitX: from.x,
    unitY: from.y,
    path,
  });
}

// --- Player orders ----------------------------------------------------------

/** Build from a base/airport/port. `unitId` is the *generic* unit id. game.js:2937 */
export function build(
  playerId: number,
  genericUnitId: number,
  buildingId: number,
): ActionEnvelope {
  return send({
    action: "Build",
    playerID: playerId,
    unitID: genericUnitId,
    buildingID: buildingId,
  });
}

/** Activate a CO power. `kind` is "Y" for COP, "S" for SCOP. game.js:51 */
export function activatePower(
  playerId: number,
  coName: string,
  kind: "Y" | "S",
): ActionEnvelope {
  return send({ action: "Power", coName, coPower: kind, playerID: playerId });
}

/** End the turn. game.js:7986 with the "End" literal from game.js:1249. */
export function endTurn(playerId: number): ActionEnvelope {
  return send({ action: "End", playerID: playerId });
}

/** End the turn while swapping tag COs. game.js:1266 */
export function tagAndEndTurn(playerId: number): ActionEnvelope {
  return send({ action: "Tag", playerID: playerId });
}
