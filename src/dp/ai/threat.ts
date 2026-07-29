/**
 * Where every unit on the board could shoot next turn, by unit type.
 *
 * Port of JakeMan's GenerateThreatMap module (JakeMan.java:227) and the
 * AICombatUtils.findThreatPower call underneath it (AICombatUtils.java:75).
 *
 * The map is keyed by unit *type* rather than by unit, because that is the
 * question isDudeFree asks: not "will that particular tank shoot me" but "how
 * much tank is pointed at this tile, and how much of my own stuff answers it".
 * Each unit contributes the square of its health fraction, so a 3HP tank counts
 * for about a tenth of a full one -- JakeMan's way of not respecting cripples.
 *
 * Both sides get a map. The friendly one is what lets JakeMan walk into a
 * threatened tile anyway when enough of its own units cover the ground around it.
 */
import type { GameState, UnitState } from "../../awbw/state.js";
import { areAllied, toNode } from "../../awbw/state.js";
import type { ReachIndex } from "../../awbw/pathing.js";

/** Tile index -> summed threat, for one unit type. */
export type ThreatArea = Map<number, number>;

export interface ThreatMap {
  /** Threat pointed at us, by enemy unit type name. */
  readonly enemy: Map<string, ThreatArea>;
  /** Threat we point back, by our own unit type name. */
  readonly friendly: Map<string, ThreatArea>;
}

/**
 * Every tile this unit could attack next turn.
 *
 * Indirects are measured from where they stand, since AWBW forbids
 * move-and-fire for them -- the same split DefendPeace makes on
 * `wep.canFireAfterMoving()` (AICombatUtils.java:91).
 *
 * Movement uses AWBW's solver including allied-occupied tiles, matching
 * DefendPeace's `includeOccupiedSpaces = true` and its stated reason: "we assume
 * the enemy knows how to manage positioning within his turn".
 */
export function threatenedTiles(
  state: GameState,
  reach: ReachIndex,
  unit: UnitState,
): number[] {
  const origins: Array<{ x: number; y: number }> = unit.indirect
    ? [{ x: unit.x, y: unit.y }]
    : reach.destinations(unit);

  const tiles = new Set<number>();
  for (const origin of origins) {
    for (let dx = -unit.maxRange; dx <= unit.maxRange; dx++) {
      const span = unit.maxRange - Math.abs(dx);
      for (let dy = -span; dy <= span; dy++) {
        const range = Math.abs(dx) + Math.abs(dy);
        if (range < unit.minRange || range > unit.maxRange) continue;

        const x = origin.x + dx;
        const y = origin.y + dy;
        if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
        tiles.add(toNode(state, x, y));
      }
    }
  }
  return [...tiles];
}

/** Builds both threat maps for the given seat. */
export function buildThreatMap(
  state: GameState,
  reach: ReachIndex,
  seatId: number,
): ThreatMap {
  const enemy = new Map<string, ThreatArea>();
  const friendly = new Map<string, ThreatArea>();

  for (const unit of state.units.values()) {
    if (unit.carried) continue;

    const side = areAllied(state, seatId, unit.playerId) ? friendly : enemy;
    let area = side.get(unit.name);
    if (!area) {
      area = new Map<number, number>();
      side.set(unit.name, area);
    }

    // Square the health fraction so low-HP units aren't valued so much.
    const fraction = (unit.hp ?? 10) / 10;
    const value = fraction * fraction;

    for (const node of threatenedTiles(state, reach, unit)) {
      area.set(node, (area.get(node) ?? 0) + value);
    }
  }

  return { enemy, friendly };
}
