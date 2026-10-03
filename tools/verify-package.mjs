/**
 * Verify package.json "files" against the real tree, and every relative import
 * against what would actually ship.
 *
 * Why this exists: pnpm installs a `file:` dependency by filtering on "files", so
 * anything the plugin needs but the list omits is simply absent from the installed
 * copy. 5.3.0 shipped exactly that — `carousel.mjs` was missing from the list while
 * `ui-host.mjs` imports it, so a fresh install died at startup with
 * ERR_MODULE_NOT_FOUND.
 *
 * It went unnoticed locally because every change was copied into the profile by hand,
 * which bypasses the filter, so the checks always passed. Exporting the check means
 * the mistake has to be made twice.
 *
 * Run: node tools/verify-package.mjs
 * Exits non-zero when something the plugin needs would not ship.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const files = pkg.files ?? [];

/** npm and pnpm always include these regardless of "files". */
const ALWAYS = new Set(["package.json", "LICENSE", "LICENCE", "README.md", "README", "CHANGELOG.md"]);
const IGNORE = new Set([".git", "node_modules", ".gitignore", "tools"]);

const covered = (rel) =>
  ALWAYS.has(rel) || files.some((entry) => rel === entry || rel.startsWith(entry.replace(/\/$/, "") + "/"));

const all = [];
(function walk(dir, prefix) {
  for (const name of readdirSync(dir)) {
    if (IGNORE.has(name)) continue;
    const full = path.join(dir, name);
    const rel = prefix ? prefix + "/" + name : name;
    if (statSync(full).isDirectory()) walk(full, rel);
    else all.push(rel);
  }
})(ROOT, "");

const uncovered = all.filter((rel) => !covered(rel)).sort();

console.log("package: " + pkg.name + " " + pkg.version);
console.log("files entries : " + files.length);
console.log("files on disk : " + all.length);
console.log("covered       : " + (all.length - uncovered.length));

/* Relative imports are the part that actually breaks a startup: a module that ships
   but is not covered is invisible until the host loads it. */
const problems = [];
for (const rel of all.filter((f) => /\.(mjs|js)$/.test(f))) {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    const asIndex = target + "/index.js";
    const onDisk = all.includes(target) || all.includes(asIndex);
    if (!onDisk) problems.push(rel + " -> " + m[1] + ": not on disk");
    else if (!covered(target) && !covered(asIndex)) {
      problems.push(rel + " -> " + m[1] + ": would NOT ship (missing from files)");
    }
  }
}

if (uncovered.length) {
  console.log("\nnot covered by the list:");
  for (const rel of uncovered) console.log("  - " + rel);
}

if (problems.length) {
  console.error("\nFAIL — these imports would break at runtime:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

if (uncovered.length) {
  console.log("\nOK — every relative import resolves to a file that ships.");
  console.log("     (the entries above are not imported; include them only if you want them installed)");
} else {
  console.log("\nOK — the list covers the whole tree and every import ships.");
}
