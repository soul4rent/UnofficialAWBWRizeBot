/**
 * Milestone-1 CO power policy: fire the biggest available power the moment it
 * charges, with no evaluation of whether the board makes it worthwhile.
 *
 * Availability mirrors AWBW's own button logic exactly
 * (updateMainPowerButtons, game.js:6158-6177), including the quirk that Von Bolt
 * has no COP at all and that a negative threshold means "this CO lacks this
 * power".
 *
 * DefendPeace models power *value* through its PowerActivator module; swapping
 * this out for that is the natural upgrade once CO abilities are modelled.
 */
import type { GameState, PlayerState } from "../awbw/state.js";

export type PowerKind = "Y" | "S";

export interface PowerChoice {
  readonly kind: PowerKind;
  readonly coName: string;
}

/** Von Bolt's only power is his SCOP (game.js:6172). */
const NO_COP_COS = new Set(["Von Bolt"]);

export function copAvailable(player: PlayerState): boolean {
  const { charge, copAt, active } = player.power;
  if (active !== "N") return false;
  if (NO_COP_COS.has(player.coName)) return false;
  return copAt !== null && charge >= copAt;
}

export function scopAvailable(player: PlayerState): boolean {
  const { charge, scopAt, active } = player.power;
  if (active !== "N") return false;
  return scopAt !== null && charge >= scopAt;
}

/**
 * The power to fire right now, or null.
 * Prefers the SCOP when both are charged, since holding a full bar wastes charge.
 */
export function choosePower(state: GameState, seatId: number): PowerChoice | null {
  if (!state.powersEnabled) return null;

  const player = state.players.get(seatId);
  if (!player || player.eliminated) return null;

  if (scopAvailable(player)) return { kind: "S", coName: player.coName };
  if (copAvailable(player)) return { kind: "Y", coName: player.coName };
  return null;
}
