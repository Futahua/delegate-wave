// Canonical digest over the complete experiment apparatus.
//
// Hashing tasks.json alone would not freeze the experiment: a later edit to a fixture input, a
// verifier, the protocol, or the line-ending rule would leave the digest unchanged while altering
// what the experiment actually measures. This covers every normative file, sorted by path, hashing
// path and bytes together so a rename is as visible as an edit.
//
// The DIGEST file itself is excluded, since it cannot contain its own hash.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPARATUS_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Only DIGEST is excluded, because a file cannot contain its own hash. This script is included: it
// defines how the apparatus is hashed, so a change to it changes what "frozen" means.
const EXCLUDED = new Set(["DIGEST"]);

function walk(directory, base = directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = path.relative(base, full).split(path.sep).join("/");
    if (EXCLUDED.has(relative)) continue;
    if (entry.isDirectory()) found.push(...walk(full, base));
    else found.push(relative);
  }
  return found;
}

export function apparatusFiles(root = APPARATUS_ROOT) {
  return walk(root).sort();
}

export function apparatusDigest(root = APPARATUS_ROOT) {
  const hash = crypto.createHash("sha256");
  for (const relative of apparatusFiles(root)) {
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

if (process.argv[2] === "--write") {
  const digest = apparatusDigest();
  fs.writeFileSync(path.join(APPARATUS_ROOT, "DIGEST"), `${digest}\n`);
  console.log(digest);
} else if (process.argv[2] === "--list") {
  for (const file of apparatusFiles()) console.log(file);
}
