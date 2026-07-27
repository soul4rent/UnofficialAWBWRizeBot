#!/usr/bin/env node
/**
 * Bundles src/ into page/bot.js.
 *
 * Format must be `iife`, not `esm`: the bundle is injected as a classic script
 * so that bare identifiers resolve to AWBW's global lexical bindings. A module
 * would get its own scope and could not see `unitsInfo` and friends at all.
 *
 * Usage: node scripts/build.mjs [--watch] [--minify]
 */
import { context, build as esbuild } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [resolve(ROOT, "src/main.ts")],
  outfile: resolve(ROOT, "page/bot.js"),
  bundle: true,
  format: "iife",
  target: "firefox115",
  platform: "browser",
  minify,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  banner: {
    js: "/* Unofficial AWBW Rize Bot — injected into the AWBW page world. */",
  },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching src/ -> page/bot.js");
} else {
  const result = await esbuild(options);
  if (result.errors.length === 0) console.log("built page/bot.js");
}
