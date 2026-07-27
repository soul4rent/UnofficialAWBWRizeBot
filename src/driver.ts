/**
 * Runs one AI turn, then stops.
 *
 * The loop deliberately re-snapshots the board between every action instead of
 * simulating ahead. AWBW mutates its state in place as socket responses play
 * back, so a snapshot goes stale the moment an action resolves -- and a stale
 * ReachIndex will happily path through a tile that is now occupied. Re-reading
 * is cheap and removes the whole class of desync bugs.
 */
import { endTurn as emitEndTurn, isDryRun } from "./awbw/actions.js";
import { g } from "./awbw/globals.js";
import { ReachIndex } from "./awbw/pathing.js";
import { snapshot } from "./awbw/state.js";
import { canAct, settleAfterAction, sleep, waitForIdle } from "./awbw/sync.js";
import type { AwbwDamageTable } from "./awbw/types.js";
import { IllegalActionError, emit } from "./bridge/fromDp.js";
import { describe } from "./dp/action.js";
import type { AiController, TurnContext } from "./dp/controller.js";

export interface DriverOptions {
  readonly seatId: number;
  readonly ai: AiController;
  /** Pause between actions, so a turn is watchable and paced like a human's. */
  readonly actionDelayMs?: number;
  /** Safety valve against an AI that never returns null. */
  readonly maxActionsPerTurn?: number;
  readonly log?: (message: string) => void;
}

export class TurnAborted extends Error {}

/** Falls back to fetching the damage table if the page has not loaded it yet. */
async function requireDamageTable(): Promise<AwbwDamageTable> {
  const existing = g.damageTable();
  if (existing) return existing;

  // loadDamageValues (game.js:8793) fetches this asynchronously on page load, so
  // on a fast start we can arrive first.
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    const table = g.damageTable();
    if (table) return table;
  }
  throw new Error("baseDamageValues never loaded; cannot evaluate combat");
}

function buildContext(seatId: number, damage: AwbwDamageTable): TurnContext {
  const state = snapshot();
  return { state, reach: new ReachIndex(state), damage, seatId };
}

/**
 * Plays the seat's turn to completion, ending it.
 * Returns the number of actions taken.
 */
export async function playTurn(options: DriverOptions): Promise<number> {
  const {
    seatId,
    ai,
    actionDelayMs = 600,
    maxActionsPerTurn = 400,
    log = () => {},
  } = options;

  const damage = await requireDamageTable();

  if (!canAct(seatId)) throw new TurnAborted(`seat ${seatId} is not on turn`);
  await waitForIdle();

  ai.initTurn(buildContext(seatId, damage));
  log(`--- ${ai.name} starting turn for seat ${seatId} ---`);

  let taken = 0;
  while (taken < maxActionsPerTurn) {
    if (!canAct(seatId)) {
      log("no longer able to act; stopping");
      break;
    }

    const ctx = buildContext(seatId, damage);
    const action = ai.getNextAction(ctx);
    if (!action) break;

    try {
      emit(ctx, action);
      log(`${taken + 1}. ${describe(action)}`);
    } catch (error) {
      if (error instanceof IllegalActionError) {
        // The AI proposed something the board no longer permits. Skip it and let
        // the next snapshot re-plan rather than sending a payload we know is bad.
        log(`skipped: ${error.message}`);
        taken++;
        continue;
      }
      throw error;
    }

    taken++;
    // A dry run never reaches the server, so there is no round trip to wait on.
    if (!isDryRun()) await settleAfterAction();
    if (actionDelayMs > 0) await sleep(actionDelayMs);
  }

  if (taken >= maxActionsPerTurn) {
    log(`hit the ${maxActionsPerTurn}-action safety limit; ending turn`);
  }

  ai.endTurn();

  if (canAct(seatId)) {
    emitEndTurn(seatId);
    log(`--- ended turn after ${taken} actions ---`);
    if (!isDryRun()) await settleAfterAction();
  }

  return taken;
}
