// The checkout's files by content hash, and the record of the last tree that passed `pnpm verify`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The environment without git's own variables, so git acts on `root` even when run from a git hook. */
let cleanEnv;
function gitEnv() {
  if (!cleanEnv) {
    cleanEnv = { ...process.env };
    for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).split("\n")) {
      if (name) delete cleanEnv[name];
    }
  }
  return cleanEnv;
}

export const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

/**
 * Every file git sees in `root`: tracked, staged and untracked, but not ignored. Hashes contents, so
 * an edit in the same second counts, and writes nothing to git's object store.
 */
export function snapshot(root) {
  const paths = new Set(git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0"));
  const files = {};
  for (const path of [...paths].filter(Boolean).sort()) {
    const hash = hashFile(join(root, path));
    if (hash) files[path] = hash;
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { fingerprint, files };
}

function hashFile(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return null; // deleted
  }
  if (stat.isSymbolicLink()) return `link:${readlinkSync(file)}`;
  if (!stat.isFile()) return null;
  const mode = stat.mode & 0o111 ? "x" : "-";
  return createHash("sha256").update(mode).update(readFileSync(file)).digest("hex");
}

/** Paths that differ between two snapshots' files. */
export function changedPaths(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => before[path] !== after[path]).sort();
}

/**
 * Docs: no check reads them, so a change to them alone needs no verify. Markdown under src/ or
 * src-tauri/ may be a fixture the code reads, so it counts as code.
 */
export const isDoc = (path) =>
  !/^src(-tauri)?\//.test(path) && (path.endsWith(".md") || path.startsWith("docs/") || path === "LICENSE");

/** Only CI reads these. Local checks can't vouch for them. */
export const isCiOnly = (path) => path.startsWith(".github/");

/** Per checkout: a linked worktree keeps its own record. */
export const stateDir = (root) => resolve(root, git(root, "rev-parse", "--git-path", "undertext").trim());

const passFile = (root) => join(stateDir(root), "verified.json");

/** The last pass, or null when there is none or the record is unreadable. */
export function readPass(root) {
  try {
    const pass = JSON.parse(readFileSync(passFile(root), "utf8"));
    return typeof pass?.fingerprint === "string" && pass.files && typeof pass.files === "object" ? pass : null;
  } catch {
    return null;
  }
}

export function recordPass(root, snap) {
  const file = passFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...snap, at: new Date().toISOString() }));
}

export const forgetPass = (root) => rmSync(passFile(root), { force: true });
