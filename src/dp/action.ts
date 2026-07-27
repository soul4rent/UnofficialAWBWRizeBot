/**
 * The vocabulary the AI plans in.
 *
 * Deliberately independent of AWBW's wire format: dp/ never imports from awbw/,
 * so the decision logic stays testable against fixtures and portable if AWBW's
 * protocol shifts. bridge/fromDp.ts is the only translator.
 *
 * This mirrors the role of DefendPeace's Engine.GameAction subclasses
 * (DefendPeace/src/Engine/GameAction.java:51+).
 */

export interface MoveAction {
  readonly kind: "move";
  readonly unitId: number;
  /** Destination; the path is resolved at emit time from the live ReachIndex. */
  readonly x: number;
  readonly y: number;
}

export interface AttackAction {
  readonly kind: "attack";
  readonly unitId: number;
  /** Tile to attack from. Equals the unit's own tile for indirects. */
  readonly x: number;
  readonly y: number;
  readonly targetUnitId: number;
}

export interface CaptureAction {
  readonly kind: "capture";
  readonly unitId: number;
  readonly x: number;
  readonly y: number;
}

export interface BuildAction {
  readonly kind: "build";
  readonly buildingId: number;
  readonly genericUnitId: number;
  /** For logging only. */
  readonly unitName: string;
}

export interface PowerAction {
  readonly kind: "power";
  readonly coName: string;
  readonly power: "Y" | "S";
}

export interface WaitAction {
  readonly kind: "wait";
  readonly unitId: number;
}

export type PlannedAction =
  | MoveAction
  | AttackAction
  | CaptureAction
  | BuildAction
  | PowerAction
  | WaitAction;

export function describe(action: PlannedAction): string {
  switch (action.kind) {
    case "move":
      return `move #${action.unitId} -> (${action.x},${action.y})`;
    case "attack":
      return `attack #${action.targetUnitId} with #${action.unitId} from (${action.x},${action.y})`;
    case "capture":
      return `capture (${action.x},${action.y}) with #${action.unitId}`;
    case "build":
      return `build ${action.unitName} at building #${action.buildingId}`;
    case "power":
      return `activate ${action.power === "S" ? "SCOP" : "COP"} (${action.coName})`;
    case "wait":
      return `wait #${action.unitId}`;
  }
}
