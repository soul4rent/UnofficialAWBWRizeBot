/**
 * Turn sequencing.
 *
 * AWBW plays server responses back as animations, gated by two page globals:
 * `ongoingAction` is true while one is playing and `actionQueue` holds the ones
 * still pending (game.js:1346-1347, drained by handleNextResponse at :1536).
 *
 * Firing a second action while the first is still animating desynchronises our
 * snapshot from the board, so every order waits for both to settle first.
 */
import { g } from "./globals.js";

export interface WaitOptions {
  /** Give up after this long. Defaults to 20s -- longer than any animation. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`timed out after ${ms}ms waiting for ${what}`);
    this.name = "TimeoutError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when no animation is playing and nothing is queued. */
export function isIdle(): boolean {
  return !g.ongoingAction() && g.queueLength() === 0;
}

/**
 * Resolves once the board has finished animating.
 *
 * Note this returns as soon as the queue drains, which for a fast local
 * response can be almost immediately -- callers that just emitted an action
 * should use settleAfterAction() instead.
 */
export async function waitForIdle(options: WaitOptions = {}): Promise<void> {
  const { timeoutMs = 20_000, pollMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;

  while (!isIdle()) {
    if (Date.now() > deadline) throw new TimeoutError("the board to go idle", timeoutMs);
    await sleep(pollMs);
  }
}

/**
 * Waits for the round trip that follows an emitted action.
 *
 * There is a race: we emit, but the response has not arrived yet, so the page
 * still looks idle. So we first wait a beat for the queue to pick up, then wait
 * for it to drain. If nothing ever arrives we still return -- a few actions
 * (notably Delete) can resolve without a visible animation.
 */
export async function settleAfterAction(options: WaitOptions = {}): Promise<void> {
  const { timeoutMs = 20_000, pollMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;

  // Give the socket a window to deliver something before deciding it is idle.
  const busyDeadline = Date.now() + 1_500;
  while (isIdle() && Date.now() < busyDeadline) {
    await sleep(pollMs);
  }

  while (!isIdle()) {
    if (Date.now() > deadline) throw new TimeoutError("an action to resolve", timeoutMs);
    await sleep(pollMs);
  }
}

/** True when the given seat is on turn and the page will accept orders. */
export function canAct(seatId: number): boolean {
  return (
    !g.frozen() &&
    !g.gameOver() &&
    g.currentTurn() === seatId &&
    g.socket()?.readyState === WebSocket.OPEN
  );
}

/** Resolves when it becomes the given seat's turn. Polls, because AWBW has no hook. */
export async function waitForTurn(
  seatId: number,
  options: WaitOptions = {},
): Promise<void> {
  const { pollMs = 500 } = options;
  while (!canAct(seatId)) {
    if (g.gameOver()) throw new Error("game is over");
    await sleep(pollMs);
  }
  await waitForIdle();
}
