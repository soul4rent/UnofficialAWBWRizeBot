/**
 * Installs the handful of AWBW page globals that fixture-based tests need.
 *
 * The bindings game.php declares are read as *bare* identifiers (see
 * src/awbw/globals.ts for why), and an unqualified name falls back to the
 * global object -- so assigning to globalThis is enough to satisfy them here.
 * The integration suite exercises the real lexical-scope path through node:vm;
 * this is only for unit tests that want a board without a whole page.
 */
import { TERRAIN } from "./fixture.js";

const ALL_MOVE_TYPES = ["F", "B", "T", "W", "A", "S", "L", "P"] as const;

/**
 * Real AWBW clear-weather costs for the terrain the fixtures use, so tests
 * exercise varied terrain rather than a uniform grid. A 0 means impassable,
 * matching how AWBW's own table encodes it.
 */
const COSTS_BY_KIND: Record<string, Partial<Record<string, number>>> = {
  // Foot, Boot(mech), Tread, Wheel, Air, Sea, Lander, Pipe
  plain: { F: 1, B: 1, T: 1, W: 2, A: 1 },
  mountain: { F: 2, B: 1, A: 1 },
  wood: { F: 1, B: 1, T: 2, W: 3, A: 1 },
  road: { F: 1, B: 1, T: 1, W: 1, A: 1, P: 1 },
  property: { F: 1, B: 1, T: 1, W: 1, A: 1 },
  sea: { A: 1, S: 1, L: 1 },
};

function kindOf(id: number): keyof typeof COSTS_BY_KIND {
  if (id === TERRAIN.MOUNTAIN) return "mountain";
  if (id === TERRAIN.WOOD) return "wood";
  if (id === TERRAIN.ROAD) return "road";
  if (id === TERRAIN.SEA || id === TERRAIN.REEF) return "sea";
  if (id === TERRAIN.PLAIN) return "plain";
  return "property";
}

function moveCostTable(): Record<string, Record<string, Record<string, number>>> {
  const costs: Record<string, Record<string, Record<string, number>>> = {};
  for (const id of Object.values(TERRAIN)) {
    const table = COSTS_BY_KIND[kindOf(id)]!;
    const perType: Record<string, number> = {};
    for (const moveType of ALL_MOVE_TYPES) perType[moveType] = table[moveType] ?? 0;
    costs[id] = { C: perType };
  }
  return costs;
}

export function installPageGlobals(): void {
  const global = globalThis as Record<string, unknown>;
  global["gameWeather"] = { code: "C", name: "Clear" };
  global["moveCosts"] = moveCostTable();
}
