/**
 * Translates the AI's planned actions into AWBW wire payloads.
 *
 * This is the only place the two vocabularies meet. Two invariants are enforced
 * here rather than trusted upstream:
 *
 *   1. Every path is resolved from the live ReachIndex, i.e. from AWBW's own
 *      solver. If the AI asks for a destination the solver will not path to, we
 *      refuse to send rather than let the server reject it.
 *   2. The acting unit must still be actionable. Between planning and emitting,
 *      a socket response may have moved or killed something.
 */
import * as actions from "../awbw/actions.js";
import type { ActionEnvelope } from "../awbw/actions.js";
import type { ReachIndex } from "../awbw/pathing.js";
import type { GameState, UnitState } from "../awbw/state.js";
import { tileAt } from "../awbw/state.js";
import type { PlannedAction } from "../dp/action.js";
import { describe } from "../dp/action.js";

export class IllegalActionError extends Error {
  constructor(
    readonly action: PlannedAction,
    reason: string,
  ) {
    super(`refusing to send ${describe(action)}: ${reason}`);
    this.name = "IllegalActionError";
  }
}

export interface EmitContext {
  readonly state: GameState;
  readonly reach: ReachIndex;
  readonly seatId: number;
}

function requireUnit(ctx: EmitContext, action: PlannedAction, unitId: number): UnitState {
  const unit = ctx.state.units.get(unitId);
  if (!unit) throw new IllegalActionError(action, `unit #${unitId} no longer exists`);
  if (unit.playerId !== ctx.seatId) {
    throw new IllegalActionError(action, `unit #${unitId} is not ours`);
  }
  if (unit.moved) throw new IllegalActionError(action, `unit #${unitId} has already acted`);
  return unit;
}

/**
 * Resolves the node path for a unit ending on (x, y), via AWBW's solver.
 * Throws rather than returning a guess -- an unsendable path is a bug upstream.
 */
function requirePath(
  ctx: EmitContext,
  action: PlannedAction,
  unit: UnitState,
  x: number,
  y: number,
): number[] {
  const path = ctx.reach.pathTo(unit, x, y);
  if (!path) {
    throw new IllegalActionError(action, `no legal path for #${unit.id} to (${x},${y})`);
  }
  return path;
}

/** Sends one planned action, returning the payload that went out. */
export function emit(ctx: EmitContext, action: PlannedAction): ActionEnvelope {
  switch (action.kind) {
    case "power":
      return actions.activatePower(ctx.seatId, action.coName, action.power);

    case "build": {
      const building = findBuilding(ctx.state, action.buildingId);
      if (!building) {
        throw new IllegalActionError(action, `building #${action.buildingId} not found`);
      }
      if (building.playerId !== ctx.seatId) {
        throw new IllegalActionError(action, "building is not ours");
      }
      if (tileAt(ctx.state, building.x, building.y)?.unitId != null) {
        throw new IllegalActionError(action, "building is occupied");
      }
      return actions.build(ctx.seatId, action.genericUnitId, action.buildingId);
    }

    case "move": {
      const unit = requireUnit(ctx, action, action.unitId);
      if (!ctx.reach.canStopAt(unit, action.x, action.y)) {
        throw new IllegalActionError(action, `cannot stop at (${action.x},${action.y})`);
      }
      return actions.move(
        ctx.seatId,
        unit.id,
        requirePath(ctx, action, unit, action.x, action.y),
      );
    }

    case "capture": {
      const unit = requireUnit(ctx, action, action.unitId);
      // Capt carries a path, so the destination must be somewhere this unit can
      // legally *end* its move, not merely somewhere the solver can route to --
      // an allied-occupied tile is traversable but not a landing spot.
      if (!ctx.reach.canStopAt(unit, action.x, action.y)) {
        throw new IllegalActionError(action, `cannot stop at (${action.x},${action.y})`);
      }
      const building = tileAt(ctx.state, action.x, action.y)?.building;
      if (!building) throw new IllegalActionError(action, "no property on that tile");
      return actions.capture(
        ctx.seatId,
        unit.id,
        requirePath(ctx, action, unit, action.x, action.y),
      );
    }

    case "attack": {
      const unit = requireUnit(ctx, action, action.unitId);
      const target = ctx.state.units.get(action.targetUnitId);
      if (!target) throw new IllegalActionError(action, "target no longer exists");

      const path = requirePath(ctx, action, unit, action.x, action.y);
      const range = Math.abs(action.x - target.x) + Math.abs(action.y - target.y);
      if (range < unit.minRange || range > unit.maxRange) {
        throw new IllegalActionError(action, `target out of range (${range})`);
      }

      // Pipe seams are terrain, not units, and take a different action.
      if (target.name === "Pipe Seam") {
        const seam = tileAt(ctx.state, target.x, target.y)?.building;
        if (!seam) throw new IllegalActionError(action, "pipe seam has no building id");
        return actions.attackSeam(
          { playerId: ctx.seatId, unitId: unit.id, path },
          seam.id,
        );
      }

      return actions.fire(
        { playerId: ctx.seatId, unitId: unit.id, path },
        { playerId: target.playerId, unitId: target.id },
      );
    }

    case "wait": {
      const unit = requireUnit(ctx, action, action.unitId);
      return actions.move(ctx.seatId, unit.id, ctx.reach.stayPath(unit));
    }
  }
}

function findBuilding(state: GameState, buildingId: number) {
  for (const column of state.tiles) {
    for (const tile of column) {
      if (tile.building?.id === buildingId) return tile.building;
    }
  }
  return null;
}
