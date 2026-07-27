/**
 * Page-world entry point.
 *
 * Injected as a classic <script> so it shares the global lexical scope where
 * game.php declares its state (see awbw/globals.ts for why that matters).
 *
 * Nothing runs automatically. The bot only acts when explicitly armed from the
 * control panel, and only on the seat you nominate -- this drives a live
 * third-party server, so opting in per game is the point.
 */
import { setDryRun } from "./awbw/actions.js";
import { MissingGlobalsError, g, isGamePage, isHotseat, requireGlobals } from "./awbw/globals.js";
import { snapshot } from "./awbw/state.js";
import { canAct, sleep } from "./awbw/sync.js";
import { InfantrySpamAI } from "./dp/ai/infantry-spam.js";
import { playTurn } from "./driver.js";
import { mountPanel } from "./ui/panel.js";

const LOG_PREFIX = "[awbw-bot]";

export interface BotSettings {
  /** Seat the AI plays. Defaults to the hotseat seat that is not seat one. */
  seatId: number | null;
  /** Play every turn automatically as it comes round. */
  autoPlay: boolean;
  /** Log payloads without sending them. */
  dryRun: boolean;
  actionDelayMs: number;
}

const settings: BotSettings = {
  seatId: null,
  autoPlay: false,
  dryRun: false,
  actionDelayMs: 600,
};

let running = false;
let watching = false;

function log(message: string): void {
  console.info(`${LOG_PREFIX} ${message}`);
}

/**
 * The seat to take over by default: in a hotseat game, the controlled seat that
 * is not the first one -- i.e. "player 2", the seat the human is not driving.
 */
export function defaultSeat(): number | null {
  const seats = [...g.allViewerPId()].sort((a, b) => a - b);
  return seats.length > 1 ? (seats[1] ?? null) : null;
}

export function getSettings(): Readonly<BotSettings> {
  return settings;
}

export function updateSettings(patch: Partial<BotSettings>): void {
  Object.assign(settings, patch);
  setDryRun(settings.dryRun);
}

/**
 * Plays a single turn for the configured seat.
 * Returns the number of actions taken, or -1 if the turn could not be played.
 */
export async function playOnce(): Promise<number> {
  if (running) {
    log("already playing a turn");
    return -1;
  }

  const seatId = settings.seatId ?? defaultSeat();
  if (seatId === null) {
    log("no seat selected, and this does not look like a hotseat game");
    return -1;
  }

  if (!canAct(seatId)) {
    log(`seat ${seatId} is not on turn`);
    return -1;
  }

  running = true;
  try {
    const count = await playTurn({
      seatId,
      ai: new InfantrySpamAI(),
      actionDelayMs: settings.actionDelayMs,
      log,
    });
    log(`turn complete (${count} actions)`);
    return count;
  } catch (error) {
    console.error(`${LOG_PREFIX} turn failed`, error);
    return -1;
  } finally {
    running = false;
  }
}

/** Watches for the AI seat's turn and plays it, until auto-play is switched off. */
export async function startAutoPlay(): Promise<void> {
  if (watching) return;
  watching = true;
  updateSettings({ autoPlay: true });
  log("auto-play armed");

  try {
    while (settings.autoPlay) {
      const seatId = settings.seatId ?? defaultSeat();
      if (seatId !== null && !running && canAct(seatId) && !g.gameOver()) {
        await playOnce();
      }
      await sleep(1000);
    }
  } finally {
    watching = false;
    log("auto-play stopped");
  }
}

export function stopAutoPlay(): void {
  updateSettings({ autoPlay: false });
}

/** Exposed for poking at from the devtools console. */
const api = {
  playOnce,
  startAutoPlay,
  stopAutoPlay,
  getSettings,
  updateSettings,
  defaultSeat,
  snapshot,
};

function boot(): void {
  if (!isGamePage()) return;

  try {
    requireGlobals();
  } catch (error) {
    if (error instanceof MissingGlobalsError) {
      console.error(`${LOG_PREFIX} ${error.message}`);
      return;
    }
    throw error;
  }

  settings.seatId = defaultSeat();

  (globalThis as Record<string, unknown>)["awbwBot"] = api;
  mountPanel(api, settings);

  log(
    isHotseat()
      ? `ready — hotseat detected, seats ${g.allViewerPId().join(", ")}, default AI seat ${settings.seatId}`
      : "ready — not a hotseat game, so no seat is selected by default",
  );
}

boot();

export type BotApi = typeof api;
