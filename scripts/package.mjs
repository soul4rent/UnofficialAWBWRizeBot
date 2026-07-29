#!/usr/bin/env node
/**
 * Builds the extension and produces an AMO-ready ZIP.
 *
 * The archive contains ONLY the runtime files the manifest actually references,
 * with `manifest.json` at the ZIP root (no wrapping directory). This is what the
 * addons.mozilla.org validator expects — zipping the whole project folder (with
 * node_modules/, .git/, src/, tests/) is what produced the
 * "manifest.json was not found" error plus dozens of node_modules warnings.
 *
 * Dependency-free: a minimal ZIP writer is implemented below with node:zlib.
 *
 * Usage: node scripts/package.mjs
 */
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// CRC32 lookup table (defined at top so it is initialized before makeZip runs).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Files included in the package. Paths are relative to ROOT and become the
 *  entry names inside the ZIP (so manifest.json lands at the root). */
const INCLUDE = [
  "manifest.json",
  "content/bootstrap.js",
  "page/bot.js",
  "res/icon48.png",
  "res/icon96.png",
];

// 1. Rebuild page/bot.js so the package is never stale.
console.log("building page/bot.js ...");
execFileSync("node", [resolve(HERE, "build.mjs")], { stdio: "inherit" });

// 2. Sanity-check every included file exists.
const missing = INCLUDE.filter((p) => !existsSync(resolve(ROOT, p)));
if (missing.length) {
  console.error("missing required files:\n  " + missing.join("\n  "));
  process.exit(1);
}

// 3. Build the ZIP in memory.
const { version } = JSON.parse(readFileSync(resolve(ROOT, "manifest.json")));
const entries = INCLUDE.map((name) => ({
  name,
  data: readFileSync(resolve(ROOT, name)),
}));
const zip = makeZip(entries);

const outDir = resolve(ROOT, "web-ext-artifacts");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, `unofficial-awbw-rize-bot-${version}.zip`);
writeFileSync(outFile, zip);

console.log(`\npackaged ${entries.length} files -> ${basename(outFile)}`);
for (const e of entries) console.log(`  ${e.name} (${e.data.length} bytes)`);

// --- minimal ZIP writer -----------------------------------------------------

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {{name: string, data: Buffer}[]} files */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const deflated = deflateRawSync(data);
    // Store uncompressed if deflate did not help.
    const useStore = deflated.length >= data.length;
    const method = useStore ? 0 : 8;
    const body = useStore ? data : deflated;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0x21, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const cdOffset = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8); // entries on this disk
  end.writeUInt16LE(files.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}
