/**
 * The AIs you can pick between, corresponding to DefendPeace's AILibrary
 * (DefendPeace/src/AI/AILibrary.java).
 *
 * Each entry builds a *fresh* controller. That matters: JakeMan's cap-phase
 * analysis and chain allocation live on the instance and are meant to outlive a
 * single turn, so main.ts keeps one instance per id rather than constructing
 * one per turn the way it used to for ISAI.
 */
import type { AiController } from "../controller.js";
import { InfantrySpamAI } from "./infantry-spam.js";
import { JakeMan, OldSchoolCool } from "./jakeman.js";

export interface AiEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  create(log: (message: string) => void): AiController;
}

export const AI_REGISTRY: readonly AiEntry[] = [
  {
    id: "jakeman",
    label: "JakeMan",
    description:
      "Builds infantry, tanks, B-Copters and Md Tanks. Takes fights it has local " +
      "force superiority for, and counter-builds against what it sees.",
    create: (log) => new JakeMan({ log }),
  },
  {
    id: "oldschoolcool",
    label: "OldSchoolCool",
    description: "JakeMan with the Md Tank counter-build switched off.",
    create: (log) => new OldSchoolCool({ log }),
  },
  {
    id: "isai",
    label: "Infantry Spam",
    description: "Captures everything and buys nothing but infantry.",
    create: () => new InfantrySpamAI(),
  },
];

export const DEFAULT_AI_ID = "jakeman";

export function findAi(id: string): AiEntry {
  return AI_REGISTRY.find((entry) => entry.id === id) ?? AI_REGISTRY[0]!;
}
