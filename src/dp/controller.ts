/**
 * The AI contract, mirroring DefendPeace's AIController
 * (DefendPeace/src/AI/AIController.java).
 *
 * getNextAction returns one action at a time and null to end the turn, exactly
 * as DefendPeace does. The driver re-snapshots the board between calls, so each
 * decision sees the true consequences of the last one rather than a simulation.
 */
import type { AwbwDamageTable } from "../awbw/types.js";
import type { GameState } from "../awbw/state.js";
import type { ReachIndex } from "../awbw/pathing.js";
import type { PlannedAction } from "./action.js";

export interface TurnContext {
  readonly state: GameState;
  readonly reach: ReachIndex;
  readonly damage: AwbwDamageTable;
  /** The seat the AI is playing. */
  readonly seatId: number;
}

export interface AiController {
  readonly name: string;
  readonly description: string;

  /** Called once when the AI's turn begins. */
  initTurn(ctx: TurnContext): void;

  /** One action, or null when the AI is done and the turn should end. */
  getNextAction(ctx: TurnContext): PlannedAction | null;

  /** Called after the turn is ended. */
  endTurn(): void;
}
