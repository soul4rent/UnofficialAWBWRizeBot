#!/usr/bin/env node
/**
 * Generates src/awbw/terrain-table.ts from AWBW's `awbw_terrain` seed data.
 *
 * Source of truth is the INSERT statement in awbw/db_sanitized.sql. The schema
 * (db_sanitized.sql:2676) is:
 *   terrain_id, terrain_name, terrain_defense, terrain_symbol,
 *   terrain_country_code, terrain_build_type, terrain_active, terrain_offset
 *
 * Regenerate whenever AWBW adds countries or terrain (they do so periodically --
 * see awbw/migrations/*_add_azure_asteroid.sql and friends).
 *
 * Usage: node scripts/gen-terrain.mjs [path/to/db_sanitized.sql]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH =
  process.argv[2] ?? resolve(HERE, "../../awbw/db_sanitized.sql");
const OUT_PATH = resolve(HERE, "../src/awbw/terrain-table.ts");

/** Pulls the single `INSERT INTO \`awbw_terrain\` VALUES (...),(...);` statement. */
function extractInsert(sql) {
  const marker = "INSERT INTO `awbw_terrain` VALUES ";
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error(`no awbw_terrain INSERT found in ${SQL_PATH}`);
  const end = sql.indexOf(";\n", start);
  if (end < 0) throw new Error("unterminated awbw_terrain INSERT");
  return sql.slice(start + marker.length, end);
}

/**
 * Splits `(a,'b',c),(d,'e',f)` into arrays of raw values.
 * Hand-rolled because several rows carry escaped quotes as their map symbol,
 * e.g. (110,'WPipe End',0,'\'',...) and (111,'Missile Silo',3,'\"',...).
 */
function parseTuples(body) {
  const rows = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && body[i] !== "(") i++;
    if (i >= body.length) break;
    i++; // past '('

    const values = [];
    let current = "";
    let inString = false;

    while (i < body.length) {
      const ch = body[i];
      if (inString) {
        if (ch === "\\") {
          current += body[i + 1];
          i += 2;
          continue;
        }
        if (ch === "'") {
          inString = false;
          i++;
          continue;
        }
        current += ch;
        i++;
        continue;
      }
      if (ch === "'") {
        inString = true;
        i++;
        continue;
      }
      if (ch === ",") {
        values.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (ch === ")") {
        values.push(current.trim());
        i++;
        break;
      }
      current += ch;
      i++;
    }
    rows.push(values);
  }
  return rows;
}

/**
 * Maps a terrain row onto the semantic kind the AI reasons about.
 *
 * `terrain_build_type` ('L'/'A'/'S') is authoritative for production properties,
 * but only on *owned* rows -- neutral ones carry an empty build type
 * (e.g. row 35 "Neutral Base"), so fall back to the name suffix.
 */
function classify(name, buildType) {
  if (buildType === "L") return "BASE";
  if (buildType === "A") return "AIRPORT";
  if (buildType === "S") return "PORT";

  if (/ Base$/.test(name)) return "BASE";
  if (/ Airport$/.test(name)) return "AIRPORT";
  if (/ Port$/.test(name)) return "PORT";
  if (/ HQ$/.test(name)) return "HQ";
  if (/ Com Tower$/.test(name)) return "COM_TOWER";
  if (/ Lab$/.test(name)) return "LAB";
  if (/ City$/.test(name)) return "CITY";

  if (name === "Plain") return "PLAIN";
  if (name === "Mountain") return "MOUNTAIN";
  if (name === "Wood") return "WOOD";
  if (name === "Sea") return "SEA";
  if (name === "Reef") return "REEF";
  if (name === "Teleporter") return "TELEPORTER";
  if (name === "Missile Silo") return "SILO";
  if (name === "Missile Silo Empty") return "SILO_EMPTY";

  if (/River$/.test(name)) return "RIVER";
  if (/Road$/.test(name)) return "ROAD";
  if (/Bridge$/.test(name)) return "BRIDGE";
  if (/Shoal/.test(name)) return "SHOAL";
  if (/Pipe Seam$/.test(name)) return "PIPE_SEAM";
  if (/Pipe Rubble$/.test(name)) return "PIPE_RUBBLE";
  if (/Pipe( End)?$/.test(name)) return "PIPE";

  throw new Error(`unclassified terrain: ${name}`);
}

const PROPERTY_KINDS = new Set([
  "CITY",
  "BASE",
  "AIRPORT",
  "PORT",
  "HQ",
  "COM_TOWER",
  "LAB",
]);

/**
 * Income counts every owned property except Com Towers and Labs.
 * Mirrors the funds query in awbw/public_html/funcs/new_turn.php:107.
 */
const NON_INCOME_KINDS = new Set(["COM_TOWER", "LAB"]);

const sql = readFileSync(SQL_PATH, "utf8");
const rows = parseTuples(extractInsert(sql));

const entries = rows.map((row) => {
  const [id, name, defense, , countryCode, buildType, active] = row;
  const kind = classify(name, buildType);
  const isProperty = PROPERTY_KINDS.has(kind);
  return {
    id: Number(id),
    name,
    kind,
    defense: Number(defense),
    country: countryCode || null,
    isProperty,
    // Neutral properties carry no country code but are still capturable.
    capturable: isProperty,
    producesIncome: isProperty && !NON_INCOME_KINDS.has(kind),
    active: active === "Y",
  };
});

entries.sort((a, b) => a.id - b.id);

const kinds = [...new Set(entries.map((e) => e.kind))].sort();

const out = `// AUTO-GENERATED by scripts/gen-terrain.mjs -- do not edit by hand.
// Source: awbw/db_sanitized.sql (table \`awbw_terrain\`, ${entries.length} rows)
// Regenerate with: npm run gen:terrain

export type TerrainKind =
${kinds.map((k) => `  | "${k}"`).join("\n")};

export interface TerrainInfo {
  /** AWBW terrain_id, as found in terrainInfo[x][y] / buildingsInfo[x][y].terrain_id. */
  readonly id: number;
  readonly name: string;
  readonly kind: TerrainKind;
  /** Defence stars; feeds the damage formula. See awbw/funcs/calculate_percentage.php:394. */
  readonly defense: number;
  /** Two-letter country code ("os", "bm", ...); null for neutral and non-property tiles. */
  readonly country: string | null;
  readonly isProperty: boolean;
  readonly capturable: boolean;
  /** Com Towers and Labs are owned but generate no funds (funcs/new_turn.php:107). */
  readonly producesIncome: boolean;
  /** AWBW keeps retired terrain rows around with terrain_active = 'N'. */
  readonly active: boolean;
}

export const TERRAIN_BY_ID: Readonly<Record<number, TerrainInfo>> = Object.freeze({
${entries
  .map(
    (e) =>
      `  ${e.id}: { id: ${e.id}, name: ${JSON.stringify(e.name)}, kind: "${e.kind}", defense: ${e.defense}, country: ${
        e.country ? JSON.stringify(e.country) : "null"
      }, isProperty: ${e.isProperty}, capturable: ${e.capturable}, producesIncome: ${e.producesIncome}, active: ${e.active} },`,
  )
  .join("\n")}
});
`;

writeFileSync(OUT_PATH, out);
console.log(
  `wrote ${OUT_PATH}: ${entries.length} terrain rows, ${kinds.length} kinds`,
);
