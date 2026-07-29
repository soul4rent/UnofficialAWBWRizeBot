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
import { MissingGlobalsError, g, isGamePage, isHotseat, requireGlobals } from "./awbw/globals.js";
import { snapshot } from "./awbw/state.js";
import { canAct, sleep } from "./awbw/sync.js";
import { AI_REGISTRY, DEFAULT_AI_ID, findAi } from "./dp/ai/registry.js";
import type { AiController } from "./dp/controller.js";
import { playTurn } from "./driver.js";
import { mountPanel } from "./ui/panel.js";

const LOG_PREFIX = "[awbw-bot]";

export interface BotSettings {
  /** Seat the AI plays. Defaults to the hotseat seat that is not seat one. */
  seatId: number | null;
  /** Which AI plays it -- an id from dp/ai/registry.ts. */
  aiId: string;
  /** Play every turn automatically as it comes round. */
  autoPlay: boolean;
  actionDelayMs: number;
}

const settings: BotSettings = {
  seatId: null,
  aiId: DEFAULT_AI_ID,
  autoPlay: false,
  actionDelayMs: 600,
};

let running = false;
let watching = false;

function log(message: string): void {
  console.info(`${LOG_PREFIX} ${message}`);
}

/**
 * One live controller per AI id *and seat*.
 *
 * JakeMan analyses the map once and then hands out capture chains that units
 * follow for the rest of the game, so its instance has to survive between
 * turns. Keeping the instance also means switching AIs mid-game and switching
 * back resumes where the first one left off rather than re-planning.
 *
 * The seat is part of the key because that per-game state is seat-specific: the
 * cap analysis is built for one seat's factories, and its units compete with the
 * other seat's for the same neutral properties. Two seats running the same AI
 * must therefore each get their own instance, or one seat plays on the other's
 * plan and they quietly trample each other's bookkeeping.
 */
const controllers = new Map<string, AiController>();

function controllerFor(aiId: string, seatId: number): AiController {
  const entry = findAi(aiId);
  const key = `${entry.id}:${seatId}`;
  const existing = controllers.get(key);
  if (existing) return existing;

  const created = entry.create(log);
  controllers.set(key, created);
  return created;
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
      ai: controllerFor(settings.aiId, seatId),
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
  /** The AIs you can put in `updateSettings({ aiId })`. */
  listAis: () => AI_REGISTRY.map(({ id, label, description }) => ({ id, label, description })),
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
      ? `ready — hotseat detected, seats ${g.allViewerPId().join(", ")}, ` +
          `default AI seat ${settings.seatId}, playing ${findAi(settings.aiId).label}`
      : "ready — not a hotseat game, so no seat is selected by default",
  );
}

boot();

export type BotApi = typeof api;
