/**
 * Port of DefendPeace's InfantrySpamAI (DefendPeace/src/AI/InfantrySpamAI.java).
 *
 * "ISAI knows there are two objectives in this game: shoot things and capture
 * things. Infantry can do both, so why build anything else?"
 *
 * Turn shape, following the Java one-action-at-a-time structure:
 *   1. fire a power if one is charged
 *   2. for the first unit with something to do: attack, else capture, else walk
 *      toward the nearest capturable property
 *   3. once no unit has anything left, buy infantry on every open base
 *   4. return null to end the turn
 *
 * Two deliberate deviations from the Java, both noted at their call sites:
 *   - attacks are ranked by funds traded rather than taken in arbitrary order
 *   - powers follow policy/power.ts (fire as soon as charged), which is the
 *     agreed milestone-1 behaviour rather than DefendPeace's PowerActivator
 */
import { choosePower } from "../../policy/power.js";
import { actionableUnits, tileAt } from "../../awbw/state.js";
import { buildOptionsFor, openProductionBuildings } from "../../awbw/catalog.js";
import type { PlannedAction } from "../action.js";
import type { AiController, TurnContext } from "../controller.js";
import {
  attackOptions,
  canCapture,
  findNonAlliedProperties,
  isCapturableHere,
  sortByTravelCost,
  stepToward,
} from "./utils.js";

/** The one unit ISAI ever buys. */
const SPAM_UNIT = "Infantry";

export class InfantrySpamAI implements AiController {
  readonly name = "ISAI";
  readonly description =
    "Infantry Spam AI. Captures everything, attacks when the trade is good, and " +
    "buys nothing but infantry.";

  /** Tiles already being captured this turn, so two units do not converge. */
  private claimedCaptures = new Set<string>();
  /**
   * Units we have already issued an order for this turn.
   *
   * DefendPeace gets this from Unit.isTurnOver; we cannot, because the board
   * only marks a unit as moved once the server's response animates. Tracking it
   * locally keeps a slow or failed response from making us reissue the same
   * order, and is what stops the AI looping when nothing comes back at all.
   */
  private commanded = new Set<number>();
  /** Buildings already given a purchase order this turn. */
  private ordered = new Set<number>();
  /**
   * Whether a power has been requested this turn.
   *
   * Needed because the driver re-snapshots between actions: until the server's
   * response lands, players_co_power_on still reads "N" and the power still
   * looks charged, so without this the AI proposes it over and over.
   */
  private powerRequested = false;
  private spentThisTurn = 0;
  private turnNumber = 0;

  initTurn(ctx: TurnContext): void {
    this.turnNumber++;
    this.claimedCaptures.clear();
    this.commanded.clear();
    this.ordered.clear();
    this.powerRequested = false;
    this.spentThisTurn = 0;

    // Units mid-capture are already committed to their tile.
    for (const unit of ctx.state.units.values()) {
      if (unit.playerId === ctx.seatId && unit.captureProgress > 0) {
        this.claimedCaptures.add(key(unit.x, unit.y));
      }
    }
  }

  endTurn(): void {
    this.claimedCaptures.clear();
    this.commanded.clear();
    this.ordered.clear();
  }

  getNextAction(ctx: TurnContext): PlannedAction | null {
    return (
      this.maybeUsePower(ctx) ?? this.nextUnitAction(ctx) ?? this.nextPurchase(ctx) ?? null
    );
  }

  /** Milestone-1 policy: fire the biggest charged power immediately, once. */
  private maybeUsePower(ctx: TurnContext): PlannedAction | null {
    if (this.powerRequested) return null;

    const choice = choosePower(ctx.state, ctx.seatId);
    if (!choice) return null;

    this.powerRequested = true;
    return { kind: "power", coName: choice.coName, power: choice.kind };
  }

  private nextUnitAction(ctx: TurnContext): PlannedAction | null {
    for (const unit of actionableUnits(ctx.state, ctx.seatId)) {
      if (this.commanded.has(unit.id)) continue;

      // Every branch below consumes the unit's turn, so claim it up front.
      this.commanded.add(unit.id);

      // 1. Attack, if any trade is worth making.
      const attacks = attackOptions(ctx, unit);
      const best = attacks[0];
      if (best && best.value > 0) {
        return {
          kind: "attack",
          unitId: unit.id,
          x: best.from.x,
          y: best.from.y,
          targetUnitId: best.target.id,
        };
      }

      // 2. Capture what we are standing on.
      if (canCapture(unit) && isCapturableHere(ctx.state, ctx.seatId, unit.x, unit.y)) {
        this.claimedCaptures.add(key(unit.x, unit.y));
        return { kind: "capture", unitId: unit.id, x: unit.x, y: unit.y };
      }

      // 3. Failing that, take any attack at all rather than idle -- an even
      //    trade still denies the enemy tempo.
      if (best) {
        return {
          kind: "attack",
          unitId: unit.id,
          x: best.from.x,
          y: best.from.y,
          targetUnitId: best.target.id,
        };
      }

      // 4. Walk toward the nearest property nobody has claimed.
      const action = this.advanceTowardProperty(ctx, unit);
      if (action) return action;

      // Nothing to do: stand down so the loop moves on.
      return { kind: "wait", unitId: unit.id };
    }

    return null;
  }

  private advanceTowardProperty(ctx: TurnContext, unit: TurnUnit): PlannedAction | null {
    if (!canCapture(unit)) {
      // Non-capturing units have no goal of their own in ISAI; leave them put.
      return null;
    }

    const targets = findNonAlliedProperties(ctx.state, ctx.seatId).filter(
      (b) => !this.claimedCaptures.has(key(b.x, b.y)),
    );
    if (targets.length === 0) return null;

    for (const goal of sortByTravelCost(ctx.state, unit, targets)) {
      // Reachable and free this turn? Go stand on it and start capturing next call.
      if (ctx.reach.canStopAt(unit, goal.x, goal.y)) {
        this.claimedCaptures.add(key(goal.x, goal.y));
        return { kind: "move", unitId: unit.id, x: goal.x, y: goal.y };
      }

      const step = stepToward(ctx, unit, goal);
      if (step) {
        this.claimedCaptures.add(key(goal.x, goal.y));
        return { kind: "move", unitId: unit.id, x: step.x, y: step.y };
      }
    }

    return null;
  }

  /**
   * Buy infantry on every open base we can afford, one call at a time.
   * Purchases cannot conflict with each other, but they do share a wallet, so we
   * track spending locally -- the server's funds update only lands after the
   * response animates.
   */
  private nextPurchase(ctx: TurnContext): PlannedAction | null {
    const player = ctx.state.players.get(ctx.seatId);
    if (!player) return null;

    const budget = player.funds - this.spentThisTurn;

    for (const building of openProductionBuildings(ctx.state, ctx.seatId)) {
      if (this.ordered.has(building.id)) continue;
      // Only bases make infantry; airports and ports are left idle by ISAI.
      if (building.terrain.kind !== "BASE") continue;

      const option = buildOptionsFor(ctx.state, building, player).find(
        (o) => o.name === SPAM_UNIT,
      );
      if (!option || option.cost > budget) continue;

      this.ordered.add(building.id);
      this.spentThisTurn += option.cost;
      return {
        kind: "build",
        buildingId: building.id,
        genericUnitId: option.genericId,
        unitName: option.name,
      };
    }

    return null;
  }
}

type TurnUnit = ReturnType<typeof actionableUnits>[number];

function key(x: number, y: number): string {
  return `${x},${y}`;
}

/** Guard against a tile index that no longer exists after a board change. */
export function tileExists(ctx: TurnContext, x: number, y: number): boolean {
  return tileAt(ctx.state, x, y) !== null;
}
