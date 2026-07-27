/**
 * Movement queries, delegated to AWBW's own solver.
 *
 * We deliberately do not reimplement pathfinding. getMovementTiles
 * (draw_movement.js:1) already accounts for move costs, weather, Olaf/Drake/Sturm
 * /Lash CO effects, fog trap avoidance, teleport tiles and enemy blocking. Using
 * it means the set of moves the AI believes are legal is, by construction, the
 * set the server will accept -- there is no second implementation to drift.
 *
 * The solved graph it returns looks like:
 *   { dist: number[], previous: (number|null)[], mCost: (number|"A"|null)[], mp }
 * where node = y * width + x, dist is Infinity for unreachable tiles, and an
 * enemy-occupied tile is flagged with mCost "A" and a `previous` link but an
 * Infinity dist -- that is how findShortestPath knows to stop one tile short
 * when you target an enemy (draw_movement.js:349).
 */
import { g } from "./globals.js";
import type { GameState, UnitState } from "./state.js";
import { toNode, unitAt } from "./state.js";

/** The shape getMovementTiles returns (draw_movement.js:120). */
interface SolvedMovement {
  dist: number[];
  previous: Array<number | null>;
  mCost: Array<number | "A" | null>;
  mp: number;
}

export interface Destination {
  readonly x: number;
  readonly y: number;
  readonly node: number;
  /** Movement points consumed to get here. */
  readonly cost: number;
  /** True when no other unit stands here, so the unit can legally stop. */
  readonly free: boolean;
}

/**
 * Per-turn cache of every owned unit's reachable set.
 *
 * Build one per decision, and rebuild after any action changes the board: the
 * page mutates unitMap in place as socket responses play back, so a stale index
 * will happily produce a path through a tile that is now occupied.
 */
export class ReachIndex {
  private readonly solved = new Map<number, SolvedMovement>();

  constructor(private readonly state: GameState) {}

  /** Runs (and memoises) AWBW's solver for one unit. */
  private solveFor(unit: UnitState): SolvedMovement | null {
    const cached = this.solved.get(unit.id);
    if (cached) return cached;

    const player = this.state.players.get(unit.playerId);
    if (!player) return null;

    // Fuel caps effective movement, exactly as the UI does before calling the
    // solver (game.js:8856).
    const mp = Math.min(unit.movePoints, unit.fuel);

    const result = g.solveMovement(
      unit.moveType,
      mp,
      { x: unit.x, y: unit.y },
      player.team,
      player.raw,
    ) as SolvedMovement | null;

    if (!result || !Array.isArray(result.dist)) return null;
    this.solved.set(unit.id, result);
    return result;
  }

  /** Movement cost to reach a tile, or null if it is out of range. */
  costTo(unit: UnitState, x: number, y: number): number | null {
    const solved = this.solveFor(unit);
    if (!solved) return null;
    const node = toNode(this.state, x, y);
    const cost = solved.dist[node];
    return cost === undefined || !Number.isFinite(cost) ? null : cost;
  }

  /** True when the unit could move here (ignoring whether the tile is free). */
  canReach(unit: UnitState, x: number, y: number): boolean {
    return this.costTo(unit, x, y) !== null;
  }

  /**
   * True when the unit can both reach the tile and legally stop on it.
   * Its own tile counts; any other occupant does not.
   */
  canStopAt(unit: UnitState, x: number, y: number): boolean {
    if (!this.canReach(unit, x, y)) return false;
    return this.isFree(unit, x, y);
  }

  private isFree(unit: UnitState, x: number, y: number): boolean {
    const occupant = unitAt(this.state, x, y);
    return occupant === null || occupant.id === unit.id;
  }

  /**
   * Every tile the unit can reach. Allied-occupied tiles are traversable but not
   * landing spots, so they come back with free=false -- callers wanting a plain
   * move should filter on it, while Join and Load specifically want them.
   */
  destinations(unit: UnitState): Destination[] {
    const solved = this.solveFor(unit);
    if (!solved) return [];

    const found: Destination[] = [];
    for (let node = 0; node < solved.dist.length; node++) {
      const cost = solved.dist[node];
      if (cost === undefined || !Number.isFinite(cost)) continue;

      const x = node % this.state.width;
      const y = (node - x) / this.state.width;
      if (x >= this.state.width || y >= this.state.height) continue;

      found.push({ x, y, node, cost, free: this.isFree(unit, x, y) });
    }
    return found;
  }

  /** Reachable tiles the unit can actually stop on. */
  freeDestinations(unit: UnitState): Destination[] {
    return this.destinations(unit).filter((d) => d.free);
  }

  /**
   * The node path to send to the server, or null if unreachable.
   * Always starts at the unit's current tile; a unit acting in place gets a
   * single-element path, matching what the UI sends (game.js:8850).
   */
  pathTo(unit: UnitState, x: number, y: number): number[] | null {
    const solved = this.solveFor(unit);
    if (!solved) return null;

    const start = toNode(this.state, unit.x, unit.y);
    const end = toNode(this.state, x, y);
    if (start === end) return [start];

    const path = g.shortestPath(solved, end);
    if (!Array.isArray(path) || path.length === 0) return null;

    // A well-formed path begins on the unit's own tile. Anything else means we
    // asked for a destination the solver could not actually link up.
    if (path[0] !== start) return null;
    return path;
  }

  /** Convenience: the path for a unit that acts without moving. */
  stayPath(unit: UnitState): number[] {
    return [toNode(this.state, unit.x, unit.y)];
  }

  /**
   * Tiles from which `unit` could attack the target, given its range.
   * Direct units need an adjacent free tile they can reach; indirects must fire
   * from where they already stand, since AWBW forbids move-and-fire for them.
   */
  attackPositions(unit: UnitState, targetX: number, targetY: number): Destination[] {
    if (unit.indirect) {
      const distance = Math.abs(unit.x - targetX) + Math.abs(unit.y - targetY);
      if (distance < unit.minRange || distance > unit.maxRange) return [];
      return [
        {
          x: unit.x,
          y: unit.y,
          node: toNode(this.state, unit.x, unit.y),
          cost: 0,
          free: true,
        },
      ];
    }

    return this.freeDestinations(unit).filter((d) => {
      const distance = Math.abs(d.x - targetX) + Math.abs(d.y - targetY);
      return distance >= unit.minRange && distance <= unit.maxRange;
    });
  }
}
