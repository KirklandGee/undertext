// Throwaway repositories for the tooling tests. Each holds copies of the scripts, never this
// checkout. A fake check stands in for the real ones: it counts its runs, fails while a `broken`
// file exists, and writes a file into the tree while a `touch` file exists.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { git } from "./tree.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const made = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "undertext-tooling-test-"));
  made.push(dir);
  return dir;
}

const FAKE_CHECK = `const fs = require("fs");
fs.appendFileSync(process.env.RUNS, "x");
if (fs.existsSync("broken")) process.exit(1);
if (fs.existsSync("touch")) fs.writeFileSync("made-during-run.txt", "x");`;

export const fakeSteps = (step = `{ name: "check", cmd: process.execPath, args: ["-e", ${JSON.stringify(FAKE_CHECK)}] }`) =>
  `export const unseen = "nothing";\nexport const steps = () => [${step}];\n`;

export function makeRepo(steps = fakeSteps()) {
  const dir = tempDir();
  mkdirSync(join(dir, "scripts"));
  for (const file of ["verify.mjs", "tree.mjs", "guard.mjs"]) copyFileSync(join(here, file), join(dir, "scripts", file));
  writeFileSync(join(dir, "scripts/verify-steps.mjs"), steps);
  writeFileSync(join(dir, "app.js"), "ok\n");
  writeFileSync(join(dir, "README.md"), "# App\n");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Start");
  return dir;
}

/** Runs the repository's copy of `pnpm verify` from another folder. `runs` counts the fake check's runs. */
export function verify(dir, args = [], env = {}) {
  const runs = join(tempDir(), "runs");
  writeFileSync(runs, "");
  const result = spawnSync(process.execPath, [join(dir, "scripts/verify.mjs"), ...args], {
    cwd: tmpdir(),
    env: { ...process.env, RUNS: runs, ...env },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout + result.stderr, runs: readFileSync(runs, "utf8").length };
}

export const passFile = (dir) => join(dir, ".git/undertext/verified.json");
export const recorded = (dir) => (existsSync(passFile(dir)) ? JSON.parse(readFileSync(passFile(dir), "utf8")).fingerprint : null);
