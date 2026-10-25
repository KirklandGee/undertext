// The end-of-turn gate for Claude Code, run by the hooks in .claude/settings.json with the hook's
// JSON on stdin. `turn-start` (UserPromptSubmit) records the tree. `turn-end` (Stop) sends Claude
// back once when the turn changed code that `pnpm verify` hasn't passed. On any error it lets the
// turn through and says why.
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const own = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const WEEK = 7 * 24 * 60 * 60 * 1000;
const list = (paths) => (paths.length > 5 ? `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more` : paths.join(", "));

/** The checkout this script lives in, or a linked worktree of it that Claude is in. Never another repository. */
function checkout(git, cwd) {
  if (!cwd) return own;
  try {
    const top = realpathSync(git(cwd, "rev-parse", "--show-toplevel").trim());
    const common = (dir) => realpathSync(resolve(dir, git(dir, "rev-parse", "--git-common-dir").trim()));
    return common(top) === common(own) ? top : own;
  } catch {
    return own;
  }
}

function turnStart({ git, snapshot }, input, file) {
  rmSync(file, { force: true }); // if the snapshot fails, turn-end finds no record and says so
  mkdirSync(dirname(file), { recursive: true });
  for (const name of readdirSync(dirname(file))) {
    const path = join(dirname(file), name);
    try {
      if (Date.now() - statSync(path).mtimeMs > WEEK) rmSync(path, { force: true });
    } catch {
      // another session removed it first
    }
  }
  const root = checkout(git, input.cwd);
  writeFileSync(file, JSON.stringify({ root, ...snapshot(root) }));
  return null;
}

function turnEnd({ changedPaths, git, isCiOnly, isDoc, readPass, snapshot }, input, file) {
  let start;
  try {
    start = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { systemMessage: "Undertext guard: no record of this turn's start, so this turn was not checked." };
  }
  // Once per turn: the second stop goes through, so Claude can stop on purpose and say what's
  // unfinished. Not `stop_hook_active`: any Stop hook sets that, and it would turn the gate off.
  if (start.blocked) return null;
  const root = checkout(git, input.cwd);
  if (start.root && root !== start.root) {
    return { systemMessage: `Undertext guard: this turn moved from ${start.root} to ${root}, so it was not checked.` };
  }
  const now = snapshot(root);
  const touched = changedPaths(start.files, now.files).filter((path) => !isDoc(path));
  if (touched.length === 0) return null; // nothing changed, only docs, or the edits were undone
  const pass = readPass(root);
  const unverified = pass ? changedPaths(pass.files, now.files).filter((path) => !isDoc(path)) : touched;
  if (unverified.length === 0) return null;

  writeFileSync(file, JSON.stringify({ ...start, blocked: true }));
  const reason = touched.every(isCiOnly)
    ? `This turn changed CI files (${list(touched)}). Local checks can't see them. Say they are not verified until CI runs, then stop.`
    : `This turn changed code that \`pnpm verify\` hasn't passed: ${list(touched)}. Run \`pnpm verify\` and fix what fails. If you are stopping on purpose, say what is not verified, then stop again.`;
  return { decision: "block", reason, systemMessage: "Undertext guard: sent Claude back to verify this turn's changes." };
}

try {
  // Imported here, so that a broken tree.mjs still ends in the message below.
  const tree = await import("./tree.mjs");
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const event = process.argv[2];
  if (event !== "turn-start" && event !== "turn-end") throw new Error(`unknown event "${event}"`);
  // One folder for every checkout of this repository, so a session's record is found wherever it ends.
  const turns = join(realpathSync(resolve(own, tree.git(own, "rev-parse", "--git-common-dir").trim())), "undertext/turns");
  const file = join(turns, `${String(input.session_id ?? "unknown").replace(/[^\w-]/g, "_")}.json`);
  const out = event === "turn-start" ? turnStart(tree, input, file) : turnEnd(tree, input, file);
  if (out) process.stdout.write(JSON.stringify(out));
} catch (error) {
  process.stdout.write(JSON.stringify({ systemMessage: `Undertext guard failed, so it let this turn through: ${error.message}` }));
}
