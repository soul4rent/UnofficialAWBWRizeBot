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
 * Travel cost from one tile to every other, ignoring units and movement points.
 * Node indices are state.toNode order; unreachable tiles are simply absent.
 *
 * Results are memoised per snapshot. JakeMan asks this question a great many
 * times per turn -- once per candidate destination when ranking travel goals,
 * and once per (factory, property) pair when planning cap chains -- and a
 * GameState is immutable, so caching on it is safe and turns an O(goals * map)
 * pass into one flood fill per (unit type, origin).
 */
const costFieldCache = new WeakMap<GameState, Map<string, Map<number, number>>>();

export function travelCostsFrom(
  state: GameState,
  moveType: string,
  from: { x: number; y: number },
): Map<number, number> {
  const width = state.width;
  const height = state.height;
  const startNode = from.y * width + from.x;

  let perState = costFieldCache.get(state);
  if (!perState) {
    perState = new Map();
    costFieldCache.set(state, perState);
  }
  const cacheKey = `${moveType}:${startNode}`;
  const cached = perState.get(cacheKey);
  if (cached) return cached;

  const best = new Map<number, number>([[startNode, 0]]);
  const frontier = new MinHeap();
  frontier.push(startNode, 0);
  const seen = new Set<number>();

  while (frontier.size > 0) {
    const current = frontier.pop()!;
    if (seen.has(current.node)) continue;
    seen.add(current.node);

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
        frontier.push(node, cost);
      }
    }
  }

  perState.set(cacheKey, best);
  return best;
}

/**
 * Travel cost to a fixed goal from every tile -- the mirror of
 * travelCostsFrom, and the one to reach for when ranking many candidate tiles
 * against a single destination.
 *
 * It is computed from one flood fill out of the goal rather than one per
 * candidate. Terrain cost is charged on the tile you *enter*, so for any path
 * between two tiles, cost(tile -> goal) and cost(goal -> tile) differ by exactly
 * `enterCost(goal) - enterCost(tile)`. That is a fixed offset per endpoint pair,
 * so the same paths are optimal both ways and correcting for it is exact, not
 * an approximation.
 */
export function travelCostsTo(
  state: GameState,
  moveType: string,
  goal: { x: number; y: number },
): Map<number, number> {
  const fromGoal = travelCostsFrom(state, moveType, goal);
  const goalCost = terrainCost(state, moveType, goal.x, goal.y) ?? 0;

  const costs = new Map<number, number>();
  for (const [node, cost] of fromGoal) {
    const x = node % state.width;
    const y = (node - x) / state.width;
    const own = terrainCost(state, moveType, x, y);
    if (own === null) continue;
    costs.set(node, cost + goalCost - own);
  }
  return costs;
}

/** A plain binary min-heap, so the flood fill is O(n log n) rather than O(n² log n). */
class MinHeap {
  private readonly nodes: number[] = [];
  private readonly costs: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, cost: number): void {
    this.nodes.push(node);
    this.costs.push(cost);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent]! <= this.costs[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { node: number; cost: number } | null {
    if (this.nodes.length === 0) return null;
    const node = this.nodes[0]!;
    const cost = this.costs[0]!;

    const lastNode = this.nodes.pop()!;
    const lastCost = this.costs.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.costs[0] = lastCost;

      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.costs.length && this.costs[left]! < this.costs[smallest]!) {
          smallest = left;
        }
        if (right < this.costs.length && this.costs[right]! < this.costs[smallest]!) {
          smallest = right;
        }
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { node, cost };
  }

  private swap(a: number, b: number): void {
    [this.nodes[a], this.nodes[b]] = [this.nodes[b]!, this.nodes[a]!];
    [this.costs[a], this.costs[b]] = [this.costs[b]!, this.costs[a]!];
  }
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
  return travelCostsFrom(state, moveType, from).get(to.y * state.width + to.x) ?? null;
}

/**
 * Tiles a unit of this movement type could reach with the given movement
 * budget, ignoring units entirely. Corresponds to a PathCalcParams flood fill
 * with canTravelThroughEnemies set (JakeMan.java:823).
 */
export function tilesWithinMoveCost(
  state: GameState,
  moveType: string,
  from: { x: number; y: number },
  budget: number,
): Set<number> {
  const within = new Set<number>();
  for (const [node, cost] of travelCostsFrom(state, moveType, from)) {
    if (cost <= budget) within.add(node);
  }
  return within;
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

  const toGoal = travelCostsTo(ctx.state, unit.moveType, goal);

  let best: Destination | null = null;
  let bestScore = Infinity;

  for (const option of options) {
    const remaining = toGoal.get(option.node) ?? distance(option, goal) * 1000;

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

/**
 * Property kinds that repair and resupply each movement type.
 * Straight from AWBW's own turn processing (funcs/new_turn.php:295): ground
 * units and piperunners on a base, city or HQ; sea units on a port; air units
 * on an airport. Com Towers and Labs repair nothing, despite being properties.
 */
const REPAIRS_ON: Record<string, ReadonlyArray<BuildingState["terrain"]["kind"]>> = {
  F: ["BASE", "CITY", "HQ"],
  B: ["BASE", "CITY", "HQ"],
  T: ["BASE", "CITY", "HQ"],
  W: ["BASE", "CITY", "HQ"],
  P: ["BASE", "CITY", "HQ"],
  L: ["PORT"],
  S: ["PORT"],
  A: ["AIRPORT"],
};

/** Our properties where this unit would be repaired and resupplied. */
export function findRepairDepots(
  state: GameState,
  seatId: number,
  unit: UnitState,
): BuildingState[] {
  const kinds = REPAIRS_ON[unit.moveType];
  if (!kinds) return [];

  const depots: BuildingState[] = [];
  for (const column of state.tiles) {
    for (const tile of column) {
      const building = tile.building;
      if (!building || building.playerId === null) continue;
      if (!areAllied(state, seatId, building.playerId)) continue;
      if (kinds.includes(building.terrain.kind)) depots.push(building);
    }
  }
  return depots;
}

/** True when one of our own units is already capturing this tile. */
export function isCapturing(
  state: GameState,
  seatId: number,
  x: number,
  y: number,
): boolean {
  const unit = unitAt(state, x, y);
  if (!unit || !areAllied(state, seatId, unit.playerId)) return false;
  return unit.captureProgress > 0;
}

/**
 * Allied production properties among the given tiles.
 * Port of AIUtils.findAlliedIndustries (AIUtils.java:340): with `ignoreMyOwn`,
 * our own factories are left out of the result -- which is how JakeMan
 * distinguishes "never stand on a factory" from "don't block an *ally's*".
 */
export function findAlliedIndustries(
  state: GameState,
  seatId: number,
  coords: Iterable<{ x: number; y: number }>,
  ignoreMyOwn: boolean,
): Set<number> {
  const found = new Set<number>();
  for (const coord of coords) {
    const building = tileAt(state, coord.x, coord.y)?.building;
    if (!building || building.playerId === null) continue;
    if (!areAllied(state, seatId, building.playerId)) continue;
    if (ignoreMyOwn && building.playerId === seatId) continue;
    if (!PRODUCTION_KINDS.has(building.terrain.kind)) continue;
    found.add(coord.y * state.width + coord.x);
  }
  return found;
}

const PRODUCTION_KINDS = new Set<BuildingState["terrain"]["kind"]>([
  "BASE",
  "AIRPORT",
  "PORT",
]);

export type { ReachIndex };
