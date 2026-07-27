/**
 * Shared AI helpers, corresponding to DefendPeace's AI/AIUtils.java and
 * AI/AICombatUtils.java.
 *
 * Two different path questions get asked here and they need different tools:
 *
 *  - "where can this unit go *this turn*" is answered by ReachIndex, i.e. by
 *    AWBW's own solver, because the answer becomes a path we send to the server.
 *  - "which far-away property should it head for" is answered by theoreticalPath
 *    below: a full-map Dijkstra that ignores units and movement points, matching
 *    DefendPeace's PathCalcParams.setTheoretical() (InfantrySpamAI.java:168).
 *    Its output is only ever used to *rank* goals, never sent to the server, so
 *    it does not need to agree with AWBW down to the tile.
 */
import { g } from "../../awbw/globals.js";
import { predictBattle, type BattlePrediction } from "../../awbw/damage.js";
import type { Destination, ReachIndex } from "../../awbw/pathing.js";
import type { BuildingState, GameState, UnitState } from "../../awbw/state.js";
import { areAllied, distance, numOr, tileAt, unitAt } from "../../awbw/state.js";
import type { TurnContext } from "../controller.js";

/** Units that can capture properties. */
const CAPTURE_UNITS = new Set(["Infantry", "Mech"]);

export function canCapture(unit: UnitState): boolean {
  return CAPTURE_UNITS.has(unit.name);
}

/** Properties not owned by us or an ally -- i.e. worth capturing. */
export function findNonAlliedProperties(
  state: GameState,
  seatId: number,
): BuildingState[] {
  const found: BuildingState[] = [];
  for (const column of state.tiles) {
    for (const tile of column) {
      const building = tile.building;
      if (!building || !building.terrain.capturable) continue;
      if (building.playerId !== null && areAllied(state, seatId, building.playerId)) continue;
      found.push(building);
    }
  }
  return found;
}

/** Enemy units currently visible. */
export function enemyUnits(state: GameState, seatId: number): UnitState[] {
  return [...state.units.values()].filter(
    (u) => !u.carried && !areAllied(state, seatId, u.playerId),
  );
}

export interface AttackOption {
  readonly unit: UnitState;
  readonly target: UnitState;
  /** Tile to strike from. */
  readonly from: Destination;
  readonly prediction: BattlePrediction;
  /**
   * Funds swing: value of damage dealt minus value of the counterattack taken.
   * Positive is a good trade.
   */
  readonly value: number;
}

/**
 * Every attack this unit could make this turn, best trade first.
 *
 * DefendPeace's ISAI simply takes the first attack it finds
 * (InfantrySpamAI.java:139). We rank by funds traded instead -- a small,
 * deliberate improvement that costs nothing and stops the bot throwing
 * infantry into tanks, and it is the same criterion WallyAI optimises.
 */
export function attackOptions(ctx: TurnContext, unit: UnitState): AttackOption[] {
  if (unit.moved) return [];

  const options: AttackOption[] = [];
  for (const target of enemyUnits(ctx.state, ctx.seatId)) {
    for (const from of ctx.reach.attackPositions(unit, target.x, target.y)) {
      const prediction = predictBattle(ctx.state, ctx.damage, unit, target, {
        attackFrom: { x: from.x, y: from.y },
      });
      if (!prediction) continue;

      const dealt = valueOfDamage(target, prediction.damageToDefender.expected);
      const taken = prediction.damageToAttacker
        ? valueOfDamage(unit, prediction.damageToAttacker.expected)
        : 0;

      options.push({ unit, target, from, prediction, value: dealt - taken });
    }
  }

  return options.sort((a, b) => b.value - a.value);
}

/** Funds worth of the HP a unit would lose. */
export function valueOfDamage(unit: UnitState, damage100: number): number {
  const hp100 = Math.round((unit.hp ?? 10) * 10);
  return (unit.cost * Math.min(damage100, hp100)) / 100;
}

/** Movement cost of a tile for a movement type, or null when impassable. */
export function terrainCost(
  state: GameState,
  moveType: string,
  x: number,
  y: number,
): number | null {
  const tile = tileAt(state, x, y);
  if (!tile || tile.terrainId < 0) return null;

  const weatherCode = g.weather().code;
  const cost = numOr(g.moveCosts()?.[tile.terrainId]?.[weatherCode]?.[moveType] ?? null, 0);
  return cost > 0 ? cost : null;
}

/**
 * Full-map shortest path ignoring units and movement points, for ranking distant
 * goals. Returns total cost, or null when the goal is unreachable for this
 * movement type (an island, for a footsoldier).
 */
export function theoreticalCost(
  state: GameState,
  moveType: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): number | null {
  const width = state.width;
  const height = state.height;
  const startNode = from.y * width + from.x;
  const goalNode = to.y * width + to.x;

  const best = new Map<number, number>([[startNode, 0]]);
  // Small maps and infrequent calls; a sorted-array frontier is plenty.
  const frontier: Array<{ node: number; cost: number }> = [{ node: startNode, cost: 0 }];
  const seen = new Set<number>();

  while (frontier.length > 0) {
    frontier.sort((a, b) => a.cost - b.cost);
    const current = frontier.shift()!;
    if (seen.has(current.node)) continue;
    seen.add(current.node);

    if (current.node === goalNode) return current.cost;

    const x = current.node % width;
    const y = (current.node - x) / width;

    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      const step = terrainCost(state, moveType, nx, ny);
      if (step === null) continue;

      const node = ny * width + nx;
      const cost = current.cost + step;
      if (cost < (best.get(node) ?? Infinity)) {
        best.set(node, cost);
        frontier.push({ node, cost });
      }
    }
  }

  return null;
}

/**
 * Best tile to stop on when heading for a goal we cannot reach this turn.
 *
 * Picks the reachable free tile with the lowest theoretical remaining cost to
 * the goal, so the unit follows real terrain rather than crow-flies distance --
 * an infantry will walk around a lake instead of pressing against the shore.
 * Falls back to Manhattan distance if the goal is unreachable from everywhere,
 * and returns null when standing still is already the best option.
 */
export function stepToward(
  ctx: TurnContext,
  unit: UnitState,
  goal: { x: number; y: number },
): Destination | null {
  const options = ctx.reach.freeDestinations(unit);
  if (options.length === 0) return null;

  let best: Destination | null = null;
  let bestScore = Infinity;

  for (const option of options) {
    const remaining =
      theoreticalCost(ctx.state, unit.moveType, option, goal) ??
      distance(option, goal) * 1000;

    // Prefer getting closer; break ties by spending fewer movement points.
    const score = remaining * 1000 + option.cost;
    if (score < bestScore) {
      bestScore = score;
      best = option;
    }
  }

  if (!best) return null;
  if (best.x === unit.x && best.y === unit.y) return null;
  return best;
}

/** Ranks goals by how far this unit must travel to reach them. */
export function sortByTravelCost<T extends { x: number; y: number }>(
  state: GameState,
  unit: UnitState,
  goals: T[],
): T[] {
  const costs = new Map<T, number>();
  for (const goal of goals) {
    costs.set(goal, theoreticalCost(state, unit.moveType, unit, goal) ?? Infinity);
  }
  return [...goals].sort((a, b) => (costs.get(a) ?? Infinity) - (costs.get(b) ?? Infinity));
}

/** True when the tile holds a property this seat may capture. */
export function isCapturableHere(
  state: GameState,
  seatId: number,
  x: number,
  y: number,
): boolean {
  const building = tileAt(state, x, y)?.building;
  if (!building || !building.terrain.capturable) return false;
  if (building.playerId !== null && areAllied(state, seatId, building.playerId)) return false;
  return true;
}

/** True when another unit already stands on this tile. */
export function isOccupied(state: GameState, x: number, y: number): boolean {
  return unitAt(state, x, y) !== null;
}

export type { ReachIndex };
