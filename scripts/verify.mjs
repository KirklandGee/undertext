// pnpm verify: every check CI runs, in seconds. Records the tree only when all of them pass on it.
// `--force` runs the checks even when nothing changed since the last pass.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths, forgetPass, isCiOnly, isDoc, readPass, recordPass, snapshot, stateDir } from "./tree.mjs";
import { steps, unseen } from "./verify-steps.mjs";

// The checkout this script lives in, wherever it is run from.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const list = (paths) => (paths.length > 3 ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more` : paths.join(", "));

const before = snapshot(root);
const last = readPass(root);
const changed = last ? changedPaths(last.files, before.files) : null;
// Local checks can't vouch for CI files, so a change to them alone is never recorded, even with --force.
const ciOnly = changed !== null && changed.some(isCiOnly) && changed.every((path) => isDoc(path) || isCiOnly(path));
const ciNote = () => {
  console.log(`Only CI files changed since the last pass (${list(changed.filter(isCiOnly))}).`);
  console.log("Local checks can't see them. Push and read the CI run. Nothing recorded.");
};
if (changed && !force) {
  if (changed.length === 0) {
    console.log(`Nothing changed since the last pass (${last.at}). Use --force to run the checks anyway.`);
    process.exit(0);
  }
  if (changed.every(isDoc)) {
    recordPass(root, before);
    console.log(`Only docs changed since the last pass (${list(changed)}). Nothing to check.`);
    process.exit(0);
  }
  if (ciOnly) {
    ciNote();
    process.exit(0);
  }
}

const logs = join(stateDir(root), "logs");
mkdirSync(logs, { recursive: true });
const started = Date.now();
const failed = [];

for (const step of steps(root)) {
  const log = join(logs, `${step.name.replaceAll(" ", "-")}.log`);
  const begin = Date.now();
  let output;
  let problem = null;
  if (step.missing) {
    output = step.missing;
    problem = step.missing;
  } else {
    const result = spawnSync(step.cmd, step.args, {
      cwd: step.cwd ?? root,
      env: { ...process.env, ...step.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    output = `$ ${step.cmd} ${step.args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.error) problem = `Could not start: ${result.error.message}. Run pnpm install?`;
    else if (result.status !== 0) problem = `Exited with ${result.status ?? result.signal}.`;
    else problem = step.check?.(output) ?? null;
  }
  writeFileSync(log, problem ? `${output}\n${problem}\n` : output);
  console.log(`${problem ? "✗" : "✓"} ${step.name.padEnd(13)} ${seconds(Date.now() - begin)}`);
  if (problem) {
    failed.push(step.name);
    const tail = readFileSync(log, "utf8").trimEnd().split("\n").slice(-25);
    console.log(tail.map((line) => `    ${line}`).join("\n"));
    console.log(`    Full log: ${relative(process.cwd(), log) || log}`);
  }
}

const after = snapshot(root);
const moved = changedPaths(before.files, after.files);
// A failed run forgets an earlier pass.
if (failed.length > 0) {
  forgetPass(root);
  console.log(`Failed: ${failed.join(", ")}. Nothing recorded.`);
  process.exit(1);
}
if (moved.length > 0) {
  forgetPass(root);
  console.log(`Files changed during the run (${list(moved)}). Nothing recorded. Run it again.`);
  process.exit(1);
}
if (ciOnly) {
  ciNote();
  process.exit(0);
}
recordPass(root, after);
console.log(`Passed in ${seconds(Date.now() - started)}. Recorded ${after.fingerprint.slice(0, 12)}.`);
console.log(`Not checked: ${unseen}.`);
