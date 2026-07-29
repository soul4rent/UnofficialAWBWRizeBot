/**
 * Port of DefendPeace's CapPhaseAnalyzer (DefendPeace/src/AI/CapPhaseAnalyzer.java).
 *
 * Analyses the map once, at the start of the game, and works out the opening
 * capture plan: which properties are *ours* (we reach them first and nobody
 * contests), and what order a footsoldier built at each factory should walk
 * them in. Each chain starts with the factory it is built at, so a fresh
 * infantry standing on a base picks up the next unclaimed chain rooted there
 * and follows it for the rest of its life.
 *
 * The analysis is deliberately naive about combat -- it plans with a theoretical
 * infantry that walks through enemies -- because it is answering a map-shape
 * question ("who owns what, if nobody fights"), and the combat modules override
 * it every turn anyway.
 *
 * This object holds state *across* turns: chains are consumed as units claim
 * them. That is why the AI instance has to outlive a single turn.
 */
import type { GameState, UnitState } from "../../awbw/state.js";
import { areAllied, fromNode, toNode } from "../../awbw/state.js";
import { theoreticalCost } from "./utils.js";

/** How many turns of walking the planner will look ahead. */
const LOOKAHEAD_TURNS = 3;
/** The horizon the chain sorter scores income against. */
const TURN_LIMIT = 13;

/** AWBW infantry: 3 movement, foot movement type. */
const INFANTRY_MOVE_TYPE = "F";
const INFANTRY_MOVE_POWER = 3;

export interface CapStop {
  /** Turns of walking spent looking ahead before this stop was found. */
  extraTurns: number;
  readonly node: number;
}

export interface CapChainGoal {
  readonly x: number;
  readonly y: number;
}

/**
 * Theoretical multi-turn path cost for a footsoldier, ignoring units.
 * Null when the goal is further than the lookahead allows, matching
 * findFeasiblePath's maxTurns cap (CapPhaseAnalyzer.java:396).
 */
function feasibleCost(
  state: GameState,
  from: { x: number; y: number },
  to: { x: number; y: number },
  movePower = INFANTRY_MOVE_POWER,
): number | null {
  const cost = theoreticalCost(state, INFANTRY_MOVE_TYPE, from, to);
  if (cost === null) return null;
  return cost <= LOOKAHEAD_TURNS * movePower ? cost : null;
}

/** Income a chain will have earned by TURN_LIMIT, for ranking chains. */
function incomeTillTurn(chain: CapStop[]): number {
  // Start at 1: the first stop is the build, not a capture.
  let currentTurn = 1;
  let income = 0;
  for (let i = 1; i < chain.length; i++) {
    currentTurn += chain[i - 1]!.extraTurns + 1;
    income += Math.max(0, TURN_LIMIT - currentTurn);
  }
  return income;
}

export class CapPhaseAnalyzer {
  /** Unclaimed chains, keyed by the tile index of the factory they start at. */
  private readonly chains = new Map<number, CapStop[][]>();
  /** Chains already handed to a unit, keyed by unit id. */
  private readonly allocated = new Map<number, CapStop[]>();
  /** Properties both sides can reach at about the same time. */
  readonly contested: number[] = [];

  constructor(state: GameState, seatId: number) {
    const factoryOwners = new Map<number, number | null>();
    const props: number[] = [];

    for (const column of state.tiles) {
      for (const tile of column) {
        const building = tile.building;
        if (!building) continue;
        if (building.terrain.kind === "BASE") {
          factoryOwners.set(toNode(state, tile.x, tile.y), building.playerId);
        } else if (building.terrain.producesIncome && building.terrain.capturable) {
          props.push(toNode(state, tile.x, tile.y));
        }
      }
    }

    const startingFactories: number[] = [];
    const rightfulFactories: number[] = [];
    for (const [node, owner] of factoryOwners) {
      if (owner !== null) {
        if (areAllied(state, seatId, owner)) startingFactories.push(node);
      }
    }

    // Assume neutral factories fall to whoever can walk an infantry there first.
    for (const [node, owner] of [...factoryOwners]) {
      if (owner !== null) continue;

      let bestOwner: number | null = null;
      let bestDistance = Infinity;
      for (const [ownedNode, ownedBy] of factoryOwners) {
        if (ownedBy === null) continue;
        const cost = feasibleCost(state, fromNode(state, ownedNode), fromNode(state, node));
        if (cost === null) continue;
        if (cost < bestDistance) {
          bestDistance = cost;
          bestOwner = ownedBy;
        }
      }
      factoryOwners.set(node, bestOwner);
      if (bestOwner !== null && areAllied(state, seatId, bestOwner)) {
        rightfulFactories.push(node);
      }
    }

    // Now sort the rest into "contested" and "rightfully mine".
    const rightfulProps: number[] = [];
    for (const propNode of props) {
      // Turns-to-capture per team, measured in percent of one turn's movement.
      const byTeam = new Map<string, { distance: number; playerId: number }>();
      for (const [factoryNode, owner] of factoryOwners) {
        if (owner === null) continue;
        const cost = feasibleCost(
          state,
          fromNode(state, factoryNode),
          fromNode(state, propNode),
        );
        if (cost === null) continue;

        const team = state.players.get(owner)?.team ?? String(owner);
        const distance = Math.trunc((cost * 100) / INFANTRY_MOVE_POWER);
        const existing = byTeam.get(team);
        if (!existing || distance < existing.distance) {
          byTeam.set(team, { distance, playerId: owner });
        }
      }

      let closest: { team: string; distance: number; playerId: number } | null = null;
      for (const [team, entry] of byTeam) {
        if (!closest || entry.distance < closest.distance) {
          closest = { team, distance: entry.distance, playerId: entry.playerId };
        }
      }
      if (!closest) continue;

      // Contested if a rival is within one turn's walk of the same property.
      let contested = false;
      for (const [team, entry] of byTeam) {
        if (team === closest.team) continue;
        contested ||= Math.abs(closest.distance - entry.distance) <= 100;
      }

      if (contested) {
        this.contested.push(propNode);
        continue;
      }
      if (!areAllied(state, seatId, closest.playerId)) continue;

      // Don't try to cap it if we already own it.
      const coord = fromNode(state, propNode);
      const owner = state.tiles[coord.x]?.[coord.y]?.building?.playerId ?? null;
      if (owner === null || !areAllied(state, seatId, owner)) rightfulProps.push(propNode);
    }

    // Chains to neutral factories stop there: chains rooted at that factory get
    // planned separately, so continuing would double-book the properties.
    const factoryChains: CapStop[][] = [];
    const remainingFactories = [...rightfulFactories];
    while (remainingFactories.length > 0 && startingFactories.length > 0) {
      const dest = remainingFactories.shift()!;
      const destCoord = fromNode(state, dest);
      const start = [...startingFactories].sort(
        (a, b) => manhattan(state, a, destCoord) - manhattan(state, b, destCoord),
      )[0]!;

      const cost = feasibleCost(state, fromNode(state, start), destCoord);
      if (cost === null) continue;

      // A pile of "free funding turns" pushes factory captures to the front.
      const build: CapStop = {
        node: start,
        extraTurns: Math.trunc(cost / INFANTRY_MOVE_POWER) - TURN_LIMIT,
      };
      factoryChains.push([build, { node: dest, extraTurns: 0 }]);

      // From here on it is just another factory to plan chains from.
      startingFactories.push(dest);
    }

    this.buildBaseCapChains(state, rightfulProps, startingFactories);

    for (const chain of factoryChains) {
      this.chains.get(chain[0]!.node)?.unshift(chain);
    }
  }

  /**
   * Grows a chain out of each owned factory, one property at a time, letting a
   * chain spend up to LOOKAHEAD_TURNS walking to its next stop.
   */
  private buildBaseCapChains(
    state: GameState,
    rightfulProps: number[],
    startingFactories: number[],
  ): void {
    const remainingFactories = [...startingFactories];
    for (const start of remainingFactories) this.chains.set(start, []);

    let madeProgress = true;
    while (madeProgress && rightfulProps.length > 0) {
      for (const start of remainingFactories) {
        this.chains.get(start)?.unshift([{ node: start, extraTurns: 0 }]);
      }

      madeProgress = false;
      for (const chainList of this.chains.values()) {
        for (const chain of chainList) {
          if (rightfulProps.length === 0) break;

          const last = chain[chain.length - 1]!;
          if (last.extraTurns >= LOOKAHEAD_TURNS) {
            if (chain.length === 1) {
              const index = remainingFactories.indexOf(last.node);
              if (index >= 0) remainingFactories.splice(index, 1);
            }
            break;
          }

          const from = fromNode(state, last.node);
          let bestProp: number | null = null;
          let bestCost = Infinity;
          for (const prop of rightfulProps) {
            const cost = theoreticalCost(
              state,
              INFANTRY_MOVE_TYPE,
              from,
              fromNode(state, prop),
            );
            if (cost !== null && cost < bestCost) {
              bestCost = cost;
              bestProp = prop;
            }
          }

          if (bestProp === null || bestCost > LOOKAHEAD_TURNS * INFANTRY_MOVE_POWER) {
            last.extraTurns = LOOKAHEAD_TURNS + 1;
            continue;
          }
          madeProgress = true;

          const reachableThisFar = (last.extraTurns + 1) * INFANTRY_MOVE_POWER;
          if (bestCost <= reachableThisFar) {
            rightfulProps.splice(rightfulProps.indexOf(bestProp), 1);
            chain.push({ node: bestProp, extraTurns: 0 });
          } else {
            last.extraTurns++;
          }
        }
      }
    }

    for (const [start, chainList] of this.chains) {
      // A chain that never captures anything is just a unit standing on a base.
      const withCaps = chainList.filter((chain) => chain.length >= 2);
      withCaps.sort((a, b) => incomeTillTurn(b) - incomeTillTurn(a));
      this.chains.set(start, withCaps);
    }
  }

  /**
   * The chain this unit is following, claiming a fresh one rooted at its tile if
   * it has none yet. Null when there is nothing left to claim.
   */
  getCapChain(state: GameState, unit: UnitState): CapStop[] | null {
    const existing = this.allocated.get(unit.id);
    if (existing) return existing;

    const here = toNode(state, unit.x, unit.y);
    const chainList = this.chains.get(here);
    if (!chainList || chainList.length === 0) return null;

    const chain = chainList.shift()!;
    this.allocated.set(unit.id, chain);
    if (chainList.length === 0) this.chains.delete(here);
    return chain;
  }

  /**
   * The next stop this unit should head for, or null when its chain is spent.
   * Stops already reached, or already ours, are dropped as we pass them.
   */
  nextStop(state: GameState, seatId: number, unit: UnitState): CapChainGoal | null {
    const chain = this.getCapChain(state, unit);
    if (!chain) return null;

    const here = toNode(state, unit.x, unit.y);
    while (chain.length > 0) {
      const stop = chain[0]!;
      const { x, y } = fromNode(state, stop.node);
      const owner = state.tiles[x]?.[y]?.building?.playerId ?? null;
      const ours = owner !== null && areAllied(state, seatId, owner);

      if (stop.node === here || ours) {
        chain.shift();
        continue;
      }
      return { x, y };
    }

    this.allocated.delete(unit.id);
    return null;
  }

  /** Forgets a unit's allocation, e.g. once it has died. */
  release(unitId: number): void {
    this.allocated.delete(unitId);
  }
}

function manhattan(state: GameState, node: number, to: { x: number; y: number }): number {
  const { x, y } = fromNode(state, node);
  return Math.abs(x - to.x) + Math.abs(y - to.y);
}
