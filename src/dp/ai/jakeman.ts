/**
 * Port of DefendPeace's JakeMan (DefendPeace/src/AI/JakeMan.java).
 *
 * "Builds infantry, tanks, B-Copters, and Md Tanks. Attacks when he has local
 * force superiority (i.e. takes free dudes). High-level design by
 * @Lost&Found#6348."
 *
 * The idea, in JakeMan's own words at the top of its constructor:
 *
 *   look where all vehicles are and what their threat ranges are
 *   take free dudes that you have more defenders for than them
 *   move your leftover vehicles so they cover the tiles attacking most relevant
 *     stuff (contested cities, own units)
 *   move infs as far towards nearest contested stuff as you can without
 *     underdefending, cap if possible
 *
 * DefendPeace composes this from AIModules, each getting a shot at the whole
 * unit queue in order, restarting from the top after every action. This port
 * keeps that shape exactly -- getNextAction walks the phases in order and
 * returns the first action any of them produces -- because the driver
 * re-snapshots between actions, so restarting from the top is what makes each
 * decision see the consequences of the last.
 *
 * Phases (JakeMan.java:126), and what became of each here:
 *   DeployCOUOnTank      dropped -- CO units are an AW4/Days-of-Ruin mechanic
 *                        that AWBW has no equivalent for
 *   PowerActivator(x3)   collapsed into one turn-start call through
 *                        policy/power.ts, the agreed milestone-1 behaviour and
 *                        what the ISAI port already does
 *   CapChainActuator     ported, via cap-phase.ts
 *   CaptureFinisher      ported
 *   GenerateThreatMap    ported, via threat.ts; rebuilt per action, as the
 *                        module ordering in DefendPeace implies
 *   GetFreeDudes x3      ported
 *   BuildStuff           ported
 *   Travel               ported
 */
import { buildOptionsFor, productionBuildings, unitTypes } from "../../awbw/catalog.js";
import type { BuildOption, UnitTypeInfo } from "../../awbw/catalog.js";
import { predictBattle } from "../../awbw/damage.js";
import type { Destination } from "../../awbw/pathing.js";
import type { BuildingState, GameState, UnitState } from "../../awbw/state.js";
import { areAllied, fromNode, tileAt, toNode, unitAt, unitsOf } from "../../awbw/state.js";
import { choosePower } from "../../policy/power.js";
import type { PlannedAction } from "../action.js";
import type { AiController, TurnContext } from "../controller.js";
import { CapPhaseAnalyzer } from "./cap-phase.js";
import {
  AIR_MOVE_TYPE,
  MASSIVE_THREAT_THRESHOLD,
  canCaptureType,
  hasWeapon,
  health100,
  isGroundVehicle,
  isThreatenedBy,
  isWeakTo,
  maxBaseDamage,
  resolveRoles,
  type Roles,
  type UnitType,
} from "./roles.js";
import { buildThreatMap, type ThreatMap } from "./threat.js";
import {
  enemyUnits,
  findAlliedIndustries,
  findRepairDepots,
  isCapturableHere,
  isCapturing,
  sortByTravelCost,
  stepToward,
  theoreticalCost,
  tilesWithinMoveCost,
  travelCostsTo,
} from "./utils.js";

// --- Tuning constants, verbatim from JakeMan.java:62-74 ----------------------

/** Scales the funds damage dealt to something that threatens us. */
const FIRSTSTRIKE_ON_THREAT_WEIGHT = 2.0;
const STAY_ALIVE_BIAS = 2000;
/** Enemy health at which the expected value of dealing damage doubles. */
const BIG_THREAT_THRESHOLD = 80;
/** How much of our own counter-threat to discount when we aren't attacking. */
const PEACEFUL_SELF_THREAT_RATIO = 1;
/** Health (0-100) at which units go looking for a repair depot. */
const UNIT_HEAL_THRESHOLD = 60;
/** Multiple of the fuel cost to reach a depot below which fuel starts to worry us. */
const UNIT_REFUEL_THRESHOLD = 1.3;
/** Fraction of max ammo below which we consider resupply. */
const UNIT_REARM_THRESHOLD = 0.25;

const EVICTION_STACK_MAX_DEPTH = 7;

/** "Buy one less tank" -- what we hold back when saving for a counter unit. */
const SAVE_BENCHMARK = 6000;
const ROUND_UP_HEALTH = 20;
const MAXIMUM_HEALTH = 100;
/** Budget below which JakeMan stops shopping. Arbitrary, and so labelled upstream. */
const MIN_INTERESTING_BUDGET = 3000;

// --- Counter-build tables ---------------------------------------------------

interface CounterRatio {
  readonly counter: UnitTypeInfo;
  /** Percent of one enemy unit this counter neutralises. */
  readonly power: number;
  /**
   * Round the *remaining* enemy health up to a whole unit. Used where a single
   * counter is not really a full answer -- one B-Copter does not cancel one
   * enemy B-Copter, and a Fighter needs to be healthy to deal with a Stealth.
   */
  readonly roundTargetPercentUp: boolean;
}

interface CounterPlan {
  /** Enemy unit name -> the things we would build to answer it. */
  readonly counters: Map<string, CounterRatio[]>;
  /** Enemy unit name -> our counter's name -> what negates that counter. */
  readonly negation: Map<string, Map<string, CounterRatio[]>>;
  /** Every unit type whose health we need to tally to run the above. */
  readonly contestants: Set<string>;
}

function ratio(
  counter: UnitTypeInfo | null,
  power: number,
  roundTargetPercentUp = false,
): CounterRatio | null {
  return counter ? { counter, power, roundTargetPercentUp } : null;
}

/** Port of JakeMan.counterBuildSetup (JakeMan.java:1139). */
function buildCounterPlan(roles: Roles, buildCounters: boolean): CounterPlan {
  const counters = new Map<string, CounterRatio[]>();
  const negation = new Map<string, Map<string, CounterRatio[]>>();
  const contestants = new Set<string>();

  const add = (threat: UnitTypeInfo | null, list: Array<CounterRatio | null>): void => {
    if (!threat) return;
    const kept = list.filter((r): r is CounterRatio => r !== null);
    if (kept.length === 0) return;
    counters.set(threat.name, kept);
  };

  if (buildCounters) {
    // Tanks need no arithmetic beyond the Md clause below.
    // Copters: 1.5 copters, or 1 AA, per enemy copter.
    add(roles.copter, [
      ratio(roles.copter, Math.trunc(200 / 3), true),
      ratio(roles.antiAir, 100),
    ]);

    // Md Tanks: a bomber, or 1 Neotank per 1.5 Mds.
    add(roles.mdTank, [ratio(roles.bomber, 250), ratio(roles.neoTank, 150)]);

    // Bombers: 1 fighter per 1.7 bombers, or 2 AA that aren't already busy
    // answering copters -- which is what the negation table encodes.
    if (roles.bomber) {
      add(roles.bomber, [ratio(roles.fighter, 170), ratio(roles.antiAir, 50)]);
      if (roles.copter && roles.antiAir) {
        const negators = new Map<string, CounterRatio[]>();
        negators.set(roles.antiAir.name, [ratio(roles.copter, 100)!]);
        negation.set(roles.bomber.name, negators);
      }
    }

    // Stealth: keep one healthy fighter on the board while one is around.
    if (roles.stealth && roles.fighter) {
      add(roles.stealth, [ratio(roles.fighter, 100, true)]);
    }

    // Fighters: 2 AA each, this time counting AA built for other air units.
    add(roles.fighter, [ratio(roles.antiAir, 50, true)]);
  }

  for (const [threatName, list] of counters) {
    contestants.add(threatName);
    for (const r of list) contestants.add(r.counter.name);
  }

  return { counters, negation, contestants };
}

// --- The AI ------------------------------------------------------------------

export interface JakeManOptions {
  /** Build counter-units at all. Off gives you DefendPeace's "OldSchoolCool". */
  readonly buildCounters?: boolean;
  /** Build Md Tanks to answer a vehicle build-up near a factory. */
  readonly buildMdCounters?: boolean;
  readonly name?: string;
  readonly log?: (message: string) => void;
}

export class JakeMan implements AiController {
  readonly name: string;
  readonly description =
    "Builds infantry, tanks, B-Copters, and Md Tanks. Attacks when it has local " +
    "force superiority — i.e. takes free dudes.";

  private readonly buildCounters: boolean;
  private readonly buildMdCounters: boolean;
  private readonly logMessage: (message: string) => void;

  /**
   * Survives between turns: cap chains are handed out once and followed for the
   * life of the unit, so this must not be rebuilt every turn.
   */
  private capPhase: CapPhaseAnalyzer | null = null;
  private types = new Map<string, UnitTypeInfo>();
  private roles: Roles = resolveRoles(new Map());
  private plan: CounterPlan = { counters: new Map(), negation: new Map(), contestants: new Set() };

  // --- per-turn bookkeeping
  /** Properties we want but do not hold, by tile index. */
  private futureCapTargets = new Set<number>();
  /** Units already given an order this turn -- see the note in infantry-spam.ts. */
  private commanded = new Set<number>();
  private ordered = new Set<number>();
  private powerRequested = false;
  private spentThisTurn = 0;
  private turnNumber = 0;
  /** The shopping list, held across actions so evictions can clear a factory. */
  private builds: Map<number, string> | null = null;

  // --- per-action scratch
  private threat: ThreatMap | null = null;
  private threatFor: GameState | null = null;
  private evictionStack: Set<number> | null = null;

  constructor(options: JakeManOptions = {}) {
    this.buildCounters = options.buildCounters ?? true;
    this.buildMdCounters = options.buildMdCounters ?? true;
    this.name = options.name ?? "JakeMan";
    this.logMessage = options.log ?? (() => {});
  }

  initTurn(ctx: TurnContext): void {
    this.turnNumber++;
    this.commanded.clear();
    this.ordered.clear();
    this.powerRequested = false;
    this.spentThisTurn = 0;
    this.builds = null;
    this.threat = null;
    this.threatFor = null;
    this.evictionStack = null;

    if (this.types.size === 0) {
      this.types = unitTypes();
      this.roles = resolveRoles(this.types);
      this.plan = buildCounterPlan(this.roles, this.buildCounters);
    }
    if (!this.capPhase) {
      this.capPhase = new CapPhaseAnalyzer(ctx.state, ctx.seatId);
    }

    this.futureCapTargets = new Set();
    for (const column of ctx.state.tiles) {
      for (const tile of column) {
        const building = tile.building;
        if (!building || !building.terrain.capturable) continue;
        if (building.playerId !== null && areAllied(ctx.state, ctx.seatId, building.playerId)) {
          continue;
        }
        this.futureCapTargets.add(toNode(ctx.state, tile.x, tile.y));
      }
    }

    this.log(`[======== ${this.name} initializing turn ${this.turnNumber} ========]`);
  }

  endTurn(): void {
    if (this.builds) {
      this.log(`Warning - builds not null on turn end; contains ${[...this.builds.values()]}`);
      this.builds = null;
    }
    this.commanded.clear();
    this.ordered.clear();
    this.log(`[======== ${this.name} ending turn ${this.turnNumber} ========]`);
  }

  getNextAction(ctx: TurnContext): PlannedAction | null {
    return (
      this.maybeUsePower(ctx) ??
      this.capChainAction(ctx) ??
      this.finishCapture(ctx) ??
      // Take free kills without standing on our own factories...
      this.getFreeDudes(ctx, false) ??
      // ...then buy, and only then allow the factories to be blocked.
      this.buildStuff(ctx) ??
      this.getFreeDudes(ctx, true) ??
      this.travel(ctx) ??
      null
    );
  }

  private log(message: string): void {
    this.logMessage(message);
  }

  // --- Phase: powers ---------------------------------------------------------

  /** Milestone-1 policy: fire the biggest charged power immediately, once. */
  private maybeUsePower(ctx: TurnContext): PlannedAction | null {
    if (this.powerRequested) return null;

    const choice = choosePower(ctx.state, ctx.seatId);
    if (!choice) return null;

    this.powerRequested = true;
    return { kind: "power", coName: choice.coName, power: choice.kind };
  }

  // --- Phase: cap chains -----------------------------------------------------

  /** Port of ModularAI.CapChainActuator (ModularAI.java:191). */
  private capChainAction(ctx: TurnContext): PlannedAction | null {
    const capPhase = this.capPhase;
    if (!capPhase) return null;

    for (const unit of this.actionableUnits(ctx)) {
      if (!canCaptureType(unit.moveType)) continue;
      // No chain, no business here -- CaptureFinisher picks up the stragglers.
      if (!capPhase.getCapChain(ctx.state, unit)) continue;

      if (unit.captureProgress > 0) {
        // Already standing on it; finish the job.
        return this.claimCapture(ctx, unit, unit.x, unit.y);
      }

      const goal = capPhase.nextStop(ctx.state, ctx.seatId, unit);
      if (!goal) continue;

      if (ctx.reach.canStopAt(unit, goal.x, goal.y)) {
        return this.claimCapture(ctx, unit, goal.x, goal.y);
      }

      const step = stepToward(ctx, unit, goal);
      if (step) {
        this.commanded.add(unit.id);
        return { kind: "move", unitId: unit.id, x: step.x, y: step.y };
      }
    }
    return null;
  }

  /** Port of ModularAI.CaptureFinisher (ModularAI.java:143). */
  private finishCapture(ctx: TurnContext): PlannedAction | null {
    for (const unit of this.actionableUnits(ctx)) {
      if (unit.captureProgress > 0) return this.claimCapture(ctx, unit, unit.x, unit.y);
    }
    return null;
  }

  private claimCapture(
    ctx: TurnContext,
    unit: UnitState,
    x: number,
    y: number,
  ): PlannedAction {
    this.commanded.add(unit.id);
    // This is now a current cap target; don't send more dudes.
    this.futureCapTargets.delete(toNode(ctx.state, x, y));
    return { kind: "capture", unitId: unit.id, x, y };
  }

  // --- Phase: free dudes -----------------------------------------------------

  /**
   * Port of GetFreeDudes (JakeMan.java:278): take any capture or attack we can
   * make from a tile the enemy cannot punish us on.
   *
   * DefendPeace runs this three times, with (canEvict, canStepOnProduction) of
   * (false,false), (true,false) and (true,true). `canEvict` is dead weight --
   * findFreeDude bails on any occupied tile regardless, its eviction branch
   * being commented out at JakeMan.java:326 -- which makes the first two passes
   * identical, so they collapse into one here. Only the "may I stand on my own
   * factories" flag actually changes anything.
   */
  private getFreeDudes(ctx: TurnContext, canStepOnProduction: boolean): PlannedAction | null {
    for (const unit of this.actionableUnits(ctx)) {
      const action = this.findFreeDude(ctx, unit, false, !canStepOnProduction);
      if (action) return action;
    }
    return null;
  }

  private findFreeDude(
    ctx: TurnContext,
    unit: UnitState,
    mustMove: boolean,
    avoidProduction: boolean,
  ): PlannedAction | null {
    const destinations = this.travelDestinations(ctx, unit, mustMove, avoidProduction);

    // Sort by furthest away -- good for capturing.
    const origin = { x: unit.x, y: unit.y };
    destinations.sort(
      (a, b) => manhattan(b, origin) - manhattan(a, origin),
    );

    const shots: Array<{ target: UnitState; from: Destination; value: number }> = [];
    const enemies = enemyUnits(ctx.state, ctx.seatId);

    for (const dest of destinations) {
      // Bail if we can't clear the space.
      const resident = unitAt(ctx.state, dest.x, dest.y);
      if (resident !== null && resident.id !== unit.id) continue;

      if (!this.isDudeFree(ctx, unit, dest.x, dest.y, true)) continue;

      if (
        canCaptureType(unit.moveType) &&
        isCapturableHere(ctx.state, ctx.seatId, dest.x, dest.y)
      ) {
        return this.claimCapture(ctx, unit, dest.x, dest.y);
      }

      for (const target of enemies) {
        if (!this.canAttackFrom(unit, dest, target)) continue;
        const value = this.scoreAttack(ctx, unit, target, dest);
        if (value === null) continue;
        shots.push({ target, from: dest, value });
      }
    }

    return this.bestAttack(unit, shots);
  }

  /** True when this unit could strike the target from that tile. */
  private canAttackFrom(unit: UnitState, from: Destination, target: UnitState): boolean {
    // AWBW forbids move-and-fire for indirects.
    if (unit.indirect && (from.x !== unit.x || from.y !== unit.y)) return false;
    const range = Math.abs(from.x - target.x) + Math.abs(from.y - target.y);
    return range >= unit.minRange && range <= unit.maxRange;
  }

  /**
   * Port of JakeMan.findBestAttack (JakeMan.java:693).
   *
   * Values the funds traded, doubling the worth of hitting something that
   * threatens us back, discounting damage to units already hurt, and charging a
   * flat STAY_ALIVE_BIAS for any trade we do not expect to survive. Scored
   * pessimistically -- worst luck on our strike, best luck on their counter --
   * matching DefendPeace's CalcType.PESSIMISTIC (AICombatUtils.java:54).
   */
  private scoreAttack(
    ctx: TurnContext,
    unit: UnitState,
    target: UnitState,
    from: Destination,
  ): number | null {
    const prediction = predictBattle(ctx.state, ctx.damage, unit, target, {
      attackFrom: { x: from.x, y: from.y },
    });
    if (!prediction) return null;

    const myHealth = health100(unit);
    const theirHealth = health100(target);

    let loss = Math.min(myHealth, prediction.damageToAttacker?.max ?? 0);
    const extraLoss = loss >= myHealth ? STAY_ALIVE_BIAS : 0;
    loss = (loss * unit.cost) / MAXIMUM_HEALTH + extraLoss;

    let damage = Math.min(theirHealth, prediction.damageToDefender.min);
    damage = (damage * target.cost) / MAXIMUM_HEALTH;
    if (isThreatenedBy(ctx.damage, unit, target)) damage *= FIRSTSTRIKE_ON_THREAT_WEIGHT;
    // Value damage to hurt units less.
    if (theirHealth < BIG_THREAT_THRESHOLD) damage /= 1.5;

    return damage - loss;
  }

  private bestAttack(
    unit: UnitState,
    shots: Array<{ target: UnitState; from: Destination; value: number }>,
  ): PlannedAction | null {
    let best: (typeof shots)[number] | null = null;
    // DefendPeace seeds the best score at 0, so an unprofitable trade is no trade.
    let bestValue = 0;
    for (const shot of shots) {
      if (shot.value > bestValue) {
        bestValue = shot.value;
        best = shot;
      }
    }
    if (!best) return null;

    this.commanded.add(unit.id);
    return {
      kind: "attack",
      unitId: unit.id,
      x: best.from.x,
      y: best.from.y,
      targetUnitId: best.target.id,
    };
  }

  // --- Safety ----------------------------------------------------------------

  /**
   * Port of JakeMan.isDudeFree (JakeMan.java:749): is this tile one the enemy
   * cannot profitably punish us on?
   *
   * Adds up the threat pointed at the tile by every enemy type that can hurt us,
   * then subtracts the average counter-threat our own units project onto the
   * four tiles around it. Anything left over means the tile is unsafe -- with
   * one exception: three or more terrain stars against a single same-type threat
   * is a fight we are happy to have.
   */
  private isDudeFree(
    ctx: TurnContext,
    unit: UnitState,
    x: number,
    y: number,
    amAttacking: boolean,
  ): boolean {
    const threat = this.threatMap(ctx);
    const node = toNode(ctx.state, x, y);

    const threatCounts = new Map<string, number>();
    for (const [name, area] of threat.enemy) {
      const threatType = this.typeFor(name);
      if (!threatType || !isThreatenedBy(ctx.damage, unit, threatType)) continue;
      const power = area.get(node);
      if (power !== undefined) threatCounts.set(name, power);
    }
    if (threatCounts.size < 1) return true;

    const counterCoords = neighbours(ctx.state, x, y);
    if (counterCoords.length === 0) return false;

    for (const threatName of [...threatCounts.keys()]) {
      const threatType = this.typeFor(threatName);
      if (!threatType) continue;

      for (const [counterName, counterArea] of threat.friendly) {
        const counterType = this.typeFor(counterName);
        if (!counterType || !isThreatenedBy(ctx.damage, threatType, counterType)) continue;

        // Our own unit only counts as its own cover if it is here to fight.
        const selfPeaceful = !amAttacking && counterName === unit.name;
        let total = 0;
        for (const coord of counterCoords) {
          let power = counterArea.get(coord) ?? 0;
          if (selfPeaceful) {
            power -= (PEACEFUL_SELF_THREAT_RATIO * Math.ceil(unit.hp ?? 10)) / 10;
          }
          total += Math.max(0, power);
        }

        const average = total / counterCoords.length;
        const remaining = threatCounts.get(threatName);
        if (remaining === undefined) break;
        if (average >= remaining) {
          threatCounts.delete(threatName);
          break;
        }
        threatCounts.set(threatName, remaining - average);
      }
    }
    if (threatCounts.size < 1) return true;

    const defense = tileAt(ctx.state, x, y)?.terrain.defense ?? 0;
    if (defense < 3 || unit.moveType === AIR_MOVE_TYPE) return false;
    if (threatCounts.size > 1) return false;

    const sameType = threatCounts.get(unit.name);
    if (sameType === undefined) return false;
    return sameType < 1.3;
  }

  // --- Phase: production -----------------------------------------------------

  /** Port of BuildStuff (JakeMan.java:375). */
  private buildStuff(ctx: TurnContext): PlannedAction | null {
    const player = ctx.state.players.get(ctx.seatId);
    if (!player) return null;

    if (!this.builds) this.builds = this.planProduction(ctx);

    for (const [node, unitName] of [...this.builds]) {
      const { x, y } = fromNode(ctx.state, node);
      const building = tileAt(ctx.state, x, y)?.building;
      if (!building || building.playerId !== ctx.seatId) {
        this.builds.delete(node);
        continue;
      }
      this.log(`Attempting to build ${unitName} at (${x},${y})`);

      const resident = unitAt(ctx.state, x, y);
      if (resident) {
        const eviction = this.canBeEvicted(ctx, resident)
          ? this.evictUnit(ctx, null, resident, true)
          : null;
        if (eviction) return eviction;

        this.log(`  Can't evict unit #${resident.id} to build ${unitName}`);
        this.builds.delete(node);
        continue;
      }

      const option = buildOptionsFor(ctx.state, building, player).find(
        (o) => o.name === unitName,
      );
      const budget = player.funds - this.spentThisTurn;
      if (option && option.cost <= budget && !this.ordered.has(building.id)) {
        this.builds.delete(node);
        this.ordered.add(building.id);
        this.spentThisTurn += option.cost;
        return {
          kind: "build",
          buildingId: building.id,
          genericUnitId: option.genericId,
          unitName: option.name,
        };
      }

      this.log(`  Trying to build ${unitName}, but it's unavailable at (${x},${y})`);
    }

    this.builds = null;
    return null;
  }

  /**
   * Port of queueUnitProductionActions (JakeMan.java:861), which is where most
   * of JakeMan's character lives.
   *
   * The shape: fill every base with infantry to establish a floor, then work out
   * whether the enemy's air and armour need a specific answer built (and save up
   * if one is needed but unaffordable), then spend whatever is left upgrading
   * those infantry slots to the biggest thing each factory can make.
   */
  private planProduction(ctx: TurnContext): Map<number, string> {
    const builds = new Map<number, string>();
    const player = ctx.state.players.get(ctx.seatId);
    if (!player) return builds;

    const facilities = this.availableFacilities(ctx);
    if (facilities.length === 0) {
      this.log("No properties available to build.");
      return builds;
    }

    // Cost of a named unit at a given facility, after the CO multiplier.
    const optionsAt = new Map<number, Map<string, BuildOption>>();
    for (const facility of facilities) {
      const byName = new Map<string, BuildOption>();
      for (const option of buildOptionsFor(ctx.state, facility, player)) {
        byName.set(option.name, option);
      }
      optionsAt.set(toNode(ctx.state, facility.x, facility.y), byName);
    }
    const costOf = (node: number, name: string): number | null =>
      optionsAt.get(node)?.get(name)?.cost ?? null;
    const facilitiesFor = (name: string): number[] =>
      [...optionsAt].filter(([, byName]) => byName.has(name)).map(([node]) => node);

    let budget = player.funds - this.spentThisTurn;

    // Fill out production with inf first, to trim the budget.
    const infantry = this.roles.infantry;
    if (infantry) {
      for (const node of facilitiesFor(infantry.name)) {
        const cost = costOf(node, infantry.name);
        if (cost === null) continue;
        if (cost <= budget) {
          builds.set(node, infantry.name);
          budget -= cost;
        } else {
          budget = -1;
        }
      }
    }
    if (budget < MIN_INTERESTING_BUDGET) return builds;
    this.log("Evaluating Production needs");

    const { niceHealth, meanHealth, mdSites } = this.surveyForces(ctx, facilitiesFor);

    let shouldSave = true;

    // Build an Md if the enemy has 3+ more ground vehicles within 2 tank moves
    // of the factory -- unless there are already 2+ Mds covering it.
    for (const site of mdSites) {
      if (!site.shouldBuildMd()) continue;
      const mdTank = this.roles.mdTank;
      if (!mdTank) continue;

      const cost = costOf(site.node, mdTank.name);
      if (cost === null) continue;
      const existing = builds.get(site.node);
      const marginal = cost - (existing ? (costOf(site.node, existing) ?? 0) : 0);
      if (marginal <= budget) {
        builds.set(site.node, mdTank.name);
        budget -= marginal;
        shouldSave = false;
        this.log(`Building Md to protect ${JSON.stringify(fromNode(ctx.state, site.node))}`);
      }
    }

    // Counter-builds. Either add one before the normal builds, or hold money back.
    let counterNeeded = false;
    for (const [threatName, totalHealth] of meanHealth) {
      const counters = this.plan.counters.get(threatName);
      if (!counters) continue; // Not on our list of things to counter.

      let remaining = totalHealth;
      for (const r of counters) {
        const held = niceHealth.get(r.counter.name);
        if (held === undefined) continue;

        // Some of our counters are already busy answering something else.
        let counterHealth = held;
        for (const negator of this.plan.negation.get(threatName)?.get(r.counter.name) ?? []) {
          const enemyHealth = meanHealth.get(negator.counter.name);
          if (enemyHealth === undefined) continue;
          counterHealth -= Math.trunc((enemyHealth * negator.power) / MAXIMUM_HEALTH);
        }

        remaining -= Math.trunc((counterHealth * r.power) / MAXIMUM_HEALTH);
        if (r.roundTargetPercentUp) {
          const roundable = remaining % MAXIMUM_HEALTH;
          if (roundable >= ROUND_UP_HEALTH) remaining += MAXIMUM_HEALTH - roundable;
        }
      }
      if (remaining < MAXIMUM_HEALTH) continue; // Fully countered already.
      counterNeeded = true;

      for (const r of counters) {
        for (const node of facilitiesFor(r.counter.name)) {
          const cost = costOf(node, r.counter.name);
          if (cost === null) continue;
          const existing = builds.get(node);
          const marginal = cost - (existing ? (costOf(node, existing) ?? 0) : 0);

          if (marginal <= budget && this.safeToBuild(ctx, node, r.counter)) {
            builds.set(node, r.counter.name);
            budget -= marginal;
            shouldSave = false;
            this.log(
              `Building ${r.counter.name} to counter ${remaining} health of ${threatName}`,
            );
            remaining -= r.power;
          }
          if (remaining < MAXIMUM_HEALTH) break;
        }
        if (remaining < MAXIMUM_HEALTH) break;
      }
    }

    // If we can't counter everything and can't afford to start, save up.
    if (counterNeeded && shouldSave) budget -= SAVE_BENCHMARK;
    if (budget < MIN_INTERESTING_BUDGET) return builds;

    // Try to purchase as many of the biggest units as we can.
    const wanted = [this.roles.infantry, this.roles.tank, this.roles.copter, this.roles.mdTank]
      .filter((t): t is UnitTypeInfo => t !== null);
    const wantedNames = new Set(wanted.map((t) => t.name));

    for (const type of wanted) {
      this.log(`Buying ${type.name}?`);
      let built = 0;

      for (const node of facilitiesFor(type.name)) {
        const cost = costOf(node, type.name);
        if (cost === null) continue;

        let marginal = cost;
        const existing = builds.get(node);
        if (existing) {
          // Never override a counter-build: it is either not a standard type, or
          // a standard type more expensive than the one we're considering.
          if (!wantedNames.has(existing)) continue;
          const existingType = this.types.get(existing);
          if (existingType && type.cost < existingType.cost) continue;
          marginal -= costOf(node, existing) ?? 0;
        }

        if (marginal <= budget) {
          builds.set(node, type.name);
          built++;
          budget -= marginal;
          continue;
        }

        // Consider downgrading a planned tank to an inf to afford a copter.
        if (this.roles.copter && type.name === this.roles.copter.name && this.roles.tank && infantry) {
          for (const [otherNode, name] of [...builds]) {
            if (name !== this.roles.tank.name) continue;
            const savings =
              (costOf(otherNode, name) ?? 0) - (costOf(otherNode, infantry.name) ?? 0);
            if (marginal - savings <= budget) {
              builds.set(otherNode, infantry.name);
              builds.set(node, type.name);
              built++;
              budget -= marginal - savings;
              break;
            }
          }
        }
      }
      this.log(`  Built ${built}; Budget: ${budget} / ${player.funds - this.spentThisTurn}`);
    }

    return builds;
  }

  /**
   * Facilities we could build at, counting those blocked by one of our own units
   * that has not moved yet -- DefendPeace's `includeFriendlyOccupied`
   * (CommanderProductionInfo.java:52), which is what lets a build order trigger
   * an eviction.
   */
  private availableFacilities(ctx: TurnContext): BuildingState[] {
    return productionBuildings(ctx.state, ctx.seatId).filter((building) => {
      const resident = unitAt(ctx.state, building.x, building.y);
      return !resident || this.canBeEvicted(ctx, resident);
    });
  }

  /**
   * True when this unit is ours and still has its turn, so asking it to move is
   * something it can actually do. DefendPeace spells this `!unit.isTurnOver`;
   * `commanded` is the local half of that, covering orders we have issued but
   * whose response has not yet come back from the server.
   */
  private canBeEvicted(ctx: TurnContext, unit: UnitState): boolean {
    return unit.playerId === ctx.seatId && !unit.moved && !this.commanded.has(unit.id);
  }

  /** Don't build counter units where something they're squishy to can reach them. */
  private safeToBuild(ctx: TurnContext, node: number, counter: UnitTypeInfo): boolean {
    const threat = this.threatMap(ctx);
    for (const [name, area] of threat.enemy) {
      const power = area.get(node);
      if (power === undefined) continue;
      const threatType = this.typeFor(name);
      if (!threatType) continue;

      const base = maxBaseDamage(ctx.damage, threatType.genericId, counter.genericId);
      if (base <= 0) continue;
      if (Math.trunc(base * power) > MASSIVE_THREAT_THRESHOLD) return false;
    }
    return true;
  }

  /**
   * Tallies health by unit type for both sides, and works out which factories
   * are looking at an armour build-up. Port of the survey loop at
   * JakeMan.java:896-947 plus FactoryThreatState (JakeMan.java:812).
   */
  private surveyForces(
    ctx: TurnContext,
    facilitiesFor: (name: string) => number[],
  ): {
    niceHealth: Map<string, number>;
    meanHealth: Map<string, number>;
    mdSites: FactoryThreatState[];
  } {
    const niceHealth = new Map<string, number>();
    const meanHealth = new Map<string, number>();

    const mdSites: FactoryThreatState[] = [];
    const mdTank = this.roles.mdTank;
    const tank = this.roles.tank;
    if (mdTank && tank && this.buildMdCounters) {
      for (const node of facilitiesFor(mdTank.name)) {
        mdSites.push(
          new FactoryThreatState(ctx.state, node, tank, mdTank.name),
        );
      }
    }

    for (const unit of ctx.state.units.values()) {
      if (unit.carried) continue;
      const isMine = areAllied(ctx.state, ctx.seatId, unit.playerId);

      for (const site of mdSites) site.trackUnit(ctx.state, unit, isMine);

      if (!this.plan.contestants.has(unit.name)) continue;
      const bucket = isMine ? niceHealth : meanHealth;
      bucket.set(unit.name, (bucket.get(unit.name) ?? 0) + health100(unit));
    }

    return { niceHealth, meanHealth, mdSites };
  }

  // --- Phase: travel ---------------------------------------------------------

  private travel(ctx: TurnContext): PlannedAction | null {
    for (const unit of this.actionableUnits(ctx)) {
      const action = this.findTravelAction(ctx, unit, false, false);
      if (action) return action;
    }
    return null;
  }

  /**
   * Port of findTravelDestinations (JakeMan.java:453): a list of long-term
   * objectives for this unit, best first.
   *
   * Priority is resupply, then capturing, then hunting whatever this unit beats,
   * then enemy factories, then -- if there is genuinely nothing to do -- home.
   */
  private findTravelGoals(
    ctx: TurnContext,
    unit: UnitState,
    avoidProduction: boolean,
  ): Array<{ x: number; y: number }> {
    const goals: Array<{ x: number; y: number }> = [];

    const stations = sortByTravelCost(
      ctx.state,
      unit,
      findRepairDepots(ctx.state, ctx.seatId, unit),
    );
    const closest = stations[0];
    const toClosest = closest
      ? theoreticalCost(ctx.state, unit.moveType, unit, closest)
      : null;

    if (closest && toClosest !== null) {
      const maxAmmo = this.types.get(unit.name)?.maxAmmo ?? 0;
      const shouldResupply =
        health100(unit) <= UNIT_HEAL_THRESHOLD ||
        unit.fuel <= UNIT_REFUEL_THRESHOLD * toClosest ||
        (maxAmmo > 0 && unit.ammo <= maxAmmo * UNIT_REARM_THRESHOLD);

      if (shouldResupply) {
        this.log(`  #${unit.id} needs supplies.`);
        const industries = avoidProduction
          ? findAlliedIndustries(ctx.state, ctx.seatId, stations, false)
          : new Set<number>();
        for (const station of stations) {
          if (industries.has(toNode(ctx.state, station.x, station.y))) continue;
          goals.push({ x: station.x, y: station.y });
        }
        return this.rankGoals(ctx, unit, goals);
      }
    }

    if (canCaptureType(unit.moveType)) {
      for (const node of this.futureCapTargets) {
        const { x, y } = fromNode(ctx.state, node);
        if (!isCapturing(ctx.state, ctx.seatId, x, y)) goals.push({ x, y });
      }
    } else if (hasWeapon(ctx.damage, unit)) {
      // Head for the nearest example of each type we beat -- not the nearest
      // enemy, which is how units end up feeding themselves to their counters.
      const byType = new Map<string, Array<{ x: number; y: number }>>();
      for (const target of enemyUnits(ctx.state, ctx.seatId)) {
        if (theoreticalCost(ctx.state, unit.moveType, unit, target) === null) continue;
        if (!isWeakTo(ctx.damage, target, unit)) continue;
        const list = byType.get(target.name) ?? [];
        list.push({ x: target.x, y: target.y });
        byType.set(target.name, list);
      }
      for (const list of byType.values()) {
        const nearest = sortByTravelCost(ctx.state, unit, list)[0];
        if (nearest) goals.push(nearest);
      }
    }

    // Send 'em at production facilities if they haven't got anything better to do.
    if (goals.length === 0) {
      for (const node of this.futureCapTargets) {
        const { x, y } = fromNode(ctx.state, node);
        const building = tileAt(ctx.state, x, y)?.building;
        if (!building) continue;
        if (building.terrain.kind !== "BASE" && building.terrain.kind !== "AIRPORT" &&
            building.terrain.kind !== "PORT") {
          continue;
        }
        if (building.playerId !== null && areAllied(ctx.state, ctx.seatId, building.playerId)) {
          continue;
        }
        goals.push({ x, y });
      }
    }

    // If there's really nothing to do, go to MY HQ.
    if (goals.length === 0) {
      for (const column of ctx.state.tiles) {
        for (const tile of column) {
          if (tile.building?.terrain.kind === "HQ" && tile.building.playerId === ctx.seatId) {
            goals.push({ x: tile.x, y: tile.y });
          }
        }
      }
      this.log(`Warning: ${this.name} has no goals for #${unit.id}`);
    }

    return this.rankGoals(ctx, unit, goals);
  }

  private rankGoals<T extends { x: number; y: number }>(
    ctx: TurnContext,
    unit: UnitState,
    goals: T[],
  ): T[] {
    return sortByTravelCost(ctx.state, unit, goals);
  }

  /**
   * Port of findTravelAction (JakeMan.java:602): pick a long-term objective,
   * then take the safest step toward it, shooting anything worth shooting on
   * the way and shoving our own units aside if they are in the road.
   */
  private findTravelAction(
    ctx: TurnContext,
    unit: UnitState,
    mustMove: boolean,
    avoidProduction: boolean,
  ): PlannedAction | null {
    const destinations = this.travelDestinations(ctx, unit, mustMove, avoidProduction);
    const goals = this.findTravelGoals(ctx, unit, avoidProduction);

    let goal: { x: number; y: number } | null = null;
    for (const candidate of goals) {
      if (mustMove && candidate.x === unit.x && candidate.y === unit.y) continue;
      if (theoreticalCost(ctx.state, unit.moveType, unit, candidate) !== null) {
        goal = candidate;
        break;
      }
    }
    // If we have to move and have no destinations, make the start tile the goal.
    if (mustMove && !goal) goal = { x: unit.x, y: unit.y };
    if (!goal) return null;

    // Sort reachable tiles by how close they get us to the goal. DefendPeace
    // snips the theoretical path to just past this turn's range and measures
    // straight-line distance to that point; measuring the remaining travel cost
    // to the goal answers the same question without the intermediate step, and
    // routes around obstacles rather than pressing against them.
    const toGoal = travelCostsTo(ctx.state, unit.moveType, goal);
    const ranked = [...destinations].sort((a, b) => {
      const diff = (toGoal.get(a.node) ?? Infinity) - (toGoal.get(b.node) ?? Infinity);
      return diff !== 0 ? diff : a.cost - b.cost;
    });

    this.log(`  #${unit.id} is traveling toward (${goal.x},${goal.y}) mustMove?: ${mustMove}`);

    for (const dest of ranked) {
      if (!this.isDudeFree(ctx, unit, dest.x, dest.y, false)) continue;

      const resident = unitAt(ctx.state, dest.x, dest.y);
      if (resident && resident.id !== unit.id) {
        if (this.canBeEvicted(ctx, resident)) {
          const eviction = this.evictUnit(ctx, unit, resident, avoidProduction);
          if (eviction) return eviction;
        }
        continue;
      }

      // Since we're moving anyway, might as well try shooting the scenery.
      const shots: Array<{ target: UnitState; from: Destination; value: number }> = [];
      for (const target of enemyUnits(ctx.state, ctx.seatId)) {
        if (!this.canAttackFrom(unit, dest, target)) continue;
        const value = this.scoreAttack(ctx, unit, target, dest);
        if (value !== null) shots.push({ target, from: dest, value });
      }
      const attack = this.bestAttack(unit, shots);
      if (attack) return attack;

      // Just wait if we can't do anything cool.
      if (dest.x !== unit.x || dest.y !== unit.y) {
        this.commanded.add(unit.id);
        return { kind: "move", unitId: unit.id, x: dest.x, y: dest.y };
      }
      return null;
    }
    return null;
  }

  /**
   * Reachable tiles, minus allied factories we shouldn't be standing on.
   * Allied-occupied tiles stay in: JakeMan knows how to shift its own units out
   * of the way, so it wants to consider landing on them.
   */
  private travelDestinations(
    ctx: TurnContext,
    unit: UnitState,
    mustMove: boolean,
    avoidProduction: boolean,
  ): Destination[] {
    const industries = findAlliedIndustries(
      ctx.state,
      ctx.seatId,
      ctx.reach.destinations(unit),
      !avoidProduction,
    );

    return ctx.reach.destinations(unit).filter((d) => {
      if (mustMove && d.x === unit.x && d.y === unit.y) return false;
      return !industries.has(d.node);
    });
  }

  /**
   * Port of evictUnit (JakeMan.java:556): the first action that gets a unit out
   * of the way. Recurses, because the unit we're moving may itself be blocked --
   * hence the stack, which both breaks cycles and caps how far the shuffle goes.
   */
  private evictUnit(
    ctx: TurnContext,
    evicter: UnitState | null,
    unit: UnitState,
    avoidProduction: boolean,
  ): PlannedAction | null {
    let isBase = false;
    if (!this.evictionStack) {
      this.evictionStack = new Set<number>();
      isBase = true;
    }
    const stack = this.evictionStack;

    try {
      if (evicter) stack.add(evicter.id);
      if (stack.has(unit.id)) {
        this.log("  Eviction cycle! Bailing.");
        return null;
      }
      if (stack.size > EVICTION_STACK_MAX_DEPTH) {
        this.log("  Too many units blocking! Bailing.");
        return null;
      }
      stack.add(unit.id);

      const result =
        this.findFreeDude(ctx, unit, true, avoidProduction) ??
        this.findTravelAction(ctx, unit, true, avoidProduction);
      this.log(`  Eviction of #${unit.id} success? ${result !== null}`);
      return result;
    } finally {
      if (isBase) this.evictionStack = null;
    }
  }

  // --- Shared plumbing -------------------------------------------------------

  /** Our units that can still act, most valuable first (AIUtils.java:295). */
  private actionableUnits(ctx: TurnContext): UnitState[] {
    return unitsOf(ctx.state, ctx.seatId)
      .filter((u) => !u.moved && !this.commanded.has(u.id))
      .sort((a, b) => b.cost * health100(b) - a.cost * health100(a));
  }

  /**
   * The threat map for the current board. DefendPeace regenerates this on every
   * getNextAction call (its module list restarts from the top each time), so we
   * cache it against the snapshot rather than across the turn.
   */
  private threatMap(ctx: TurnContext): ThreatMap {
    if (this.threat && this.threatFor === ctx.state) return this.threat;
    this.threat = buildThreatMap(ctx.state, ctx.reach, ctx.seatId);
    this.threatFor = ctx.state;
    return this.threat;
  }

  /** Type info for a unit name, for reasoning about types not on the board. */
  private typeFor(name: string): UnitType | null {
    return this.types.get(name) ?? null;
  }
}

/**
 * Port of FactoryThreatState (JakeMan.java:812): how much armour is converging
 * on one of our factories.
 *
 * "Build an Md if the enemy has 3+ more ground vehicles within 2 tank moves of
 * your base... but don't if there are 2+ Mds in the area."
 */
class FactoryThreatState {
  private readonly checkTiles: Set<number>;
  private niceMdCount = 0;
  private meanVehCount = 0;
  private niceVehCount = 0;

  constructor(
    state: GameState,
    readonly node: number,
    tank: UnitTypeInfo,
    private readonly mdTankName: string,
  ) {
    this.checkTiles = tilesWithinMoveCost(
      state,
      tank.moveType,
      fromNode(state, node),
      tank.movePoints * 2,
    );
  }

  trackUnit(state: GameState, unit: UnitState, isMine: boolean): void {
    if (!this.checkTiles.has(toNode(state, unit.x, unit.y))) return;
    if (!isGroundVehicle(unit.moveType)) return;

    if (isMine) {
      this.niceVehCount++;
      if (unit.name === this.mdTankName) this.niceMdCount++;
    } else {
      this.meanVehCount++;
    }
  }

  shouldBuildMd(): boolean {
    if (this.niceMdCount > 1) return false;
    return this.meanVehCount - this.niceVehCount > 2;
  }
}

/** DefendPeace's OldSchoolCool: JakeMan with the Md counter-build switched off. */
export class OldSchoolCool extends JakeMan {
  constructor(options: JakeManOptions = {}) {
    super({ ...options, name: options.name ?? "OldSchoolCool", buildMdCounters: false });
  }
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** The four orthogonal neighbours of a tile, clipped to the map. */
function neighbours(state: GameState, x: number, y: number): number[] {
  const found: number[] = [];
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
    found.push(toNode(state, nx, ny));
  }
  return found;
}
