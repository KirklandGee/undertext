// Runs copies of the verify scripts in throwaway repositories, never in this checkout. A fake check
// stands in for the real ones: it counts its runs, fails while a `broken` file exists, and writes a
// file into the tree while a `touch` file exists.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git, snapshot } from "./tree.mjs";
import { cargoPassed, vitestPassed } from "./verify-steps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const made = [];
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "undertext-verify-test-"));
  made.push(dir);
  return dir;
};

const FAKE_CHECK = `const fs = require("fs");
fs.appendFileSync(process.env.RUNS, "x");
if (fs.existsSync("broken")) process.exit(1);
if (fs.existsSync("touch")) fs.writeFileSync("made-during-run.txt", "x");`;

const fakeSteps = (step = `{ name: "check", cmd: process.execPath, args: ["-e", ${JSON.stringify(FAKE_CHECK)}] }`) =>
  `export const unseen = "nothing";\nexport const steps = () => [${step}];\n`;

function makeRepo(steps = fakeSteps()) {
  const dir = tempDir();
  mkdirSync(join(dir, "scripts"));
  for (const file of ["verify.mjs", "tree.mjs"]) copyFileSync(join(here, file), join(dir, "scripts", file));
  writeFileSync(join(dir, "scripts/verify-steps.mjs"), steps);
  writeFileSync(join(dir, "app.js"), "ok\n");
  writeFileSync(join(dir, "README.md"), "# App\n");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Start");
  return dir;
}

function verify(dir, args = [], env = {}) {
  const runs = join(tempDir(), "runs");
  writeFileSync(runs, "");
  const result = spawnSync(process.execPath, [join(dir, "scripts/verify.mjs"), ...args], {
    cwd: tmpdir(),
    env: { ...process.env, RUNS: runs, ...env },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout + result.stderr, runs: readFileSync(runs, "utf8").length };
}

const passFile = (dir) => join(dir, ".git/undertext/verified.json");
const recorded = (dir) => (existsSync(passFile(dir)) ? JSON.parse(readFileSync(passFile(dir), "utf8")).fingerprint : null);

describe("pnpm verify", () => {
  it("records a pass, then skips an unchanged tree unless forced", () => {
    const dir = makeRepo();
    const first = verify(dir);
    expect(first).toMatchObject({ status: 0, runs: 1 });
    expect(first.out).toContain("✓ check");
    expect(first.out).toContain("Not checked: nothing.");
    expect(recorded(dir)).toBe(snapshot(dir).fingerprint);

    const again = verify(dir);
    expect(again).toMatchObject({ status: 0, runs: 0 });
    expect(again.out).toContain("Nothing changed since the last pass");
    expect(verify(dir, ["--force"])).toMatchObject({ status: 0, runs: 1 });
  });

  it("records nothing when a check fails, and forgets the earlier pass", () => {
    const dir = makeRepo();
    verify(dir);
    writeFileSync(join(dir, "broken"), "");
    const failed = verify(dir);
    expect(failed).toMatchObject({ status: 1, runs: 1 });
    expect(failed.out).toContain("✗ check");
    expect(failed.out).toMatch(/Full log: .*check\.log/);
    expect(failed.out).toContain("Failed: check. Nothing recorded.");
    expect(recorded(dir)).toBeNull();
  });

  it("records nothing when a check exits cleanly but ran no tests", () => {
    const dir = makeRepo(fakeSteps(`{ name: "tests", cmd: process.execPath, args: ["-e", ""], check: () => "No tests ran." }`));
    const result = verify(dir);
    expect(result.status).toBe(1);
    expect(result.out).toContain("✗ tests");
    expect(result.out).toContain("No tests ran.");
    expect(recorded(dir)).toBeNull();
  });

  it("runs the checks when the record is unreadable", () => {
    const dir = makeRepo();
    mkdirSync(dirname(passFile(dir)), { recursive: true });
    writeFileSync(passFile(dir), '{"fingerprint":"abc"}');
    expect(verify(dir)).toMatchObject({ status: 0, runs: 1 });
    expect(recorded(dir)).toBe(snapshot(dir).fingerprint);
  });

  it("records nothing when files change during the run", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "touch"), "");
    const result = verify(dir);
    expect(result.status).toBe(1);
    expect(result.out).toContain("Files changed during the run (made-during-run.txt)");
    expect(recorded(dir)).toBeNull();
  });

  it("checks nothing when only docs changed since the last pass, and records that tree", () => {
    const dir = makeRepo();
    verify(dir);
    writeFileSync(join(dir, "README.md"), "# App, with docs\n");
    const result = verify(dir);
    expect(result).toMatchObject({ status: 0, runs: 0 });
    expect(result.out).toContain("Only docs changed since the last pass (README.md)");
    expect(recorded(dir)).toBe(snapshot(dir).fingerprint);

    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/fixture.md"), "Code may read this.\n");
    expect(verify(dir)).toMatchObject({ status: 0, runs: 1 });
  });

  it("records nothing when only CI files changed, and checks again once code changes", () => {
    const dir = makeRepo();
    verify(dir);
    const before = recorded(dir);
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/ci.yml"), "on: push\n");
    const ci = verify(dir);
    expect(ci).toMatchObject({ status: 0, runs: 0 });
    expect(ci.out).toContain("Only CI files changed since the last pass (.github/workflows/ci.yml)");
    expect(recorded(dir)).toBe(before);
    const forced = verify(dir, ["--force"]);
    expect(forced).toMatchObject({ status: 0, runs: 1 });
    expect(forced.out).toContain("Nothing recorded.");
    expect(recorded(dir)).toBe(before);

    writeFileSync(join(dir, "app.js"), "changed\n");
    expect(verify(dir)).toMatchObject({ status: 0, runs: 1 });
    expect(recorded(dir)).toBe(snapshot(dir).fingerprint);
  });

  it("fails clearly when a check can't start or its tool is missing", () => {
    const cantStart = verify(makeRepo(fakeSteps(`{ name: "check", cmd: "/no/such/tool", args: [] }`)));
    expect(cantStart.status).toBe(1);
    expect(cantStart.out).toContain("Could not start");

    const missing = verify(makeRepo(fakeSteps(`{ name: "rust", missing: "cargo not found." }`)));
    expect(missing.status).toBe(1);
    expect(missing.out).toContain("✗ rust");
    expect(missing.out).toContain("cargo not found.");
  });

  it("keeps a separate record in a linked worktree", () => {
    const dir = makeRepo();
    const tree = join(tempDir(), "linked");
    git(dir, "worktree", "add", "-q", tree);
    expect(verify(tree)).toMatchObject({ status: 0, runs: 1 });
    expect(existsSync(join(dir, ".git/worktrees", basename(tree), "undertext/verified.json"))).toBe(true);
    expect(recorded(dir)).toBeNull();
  });

  it("acts on its own checkout when git's hook variables point elsewhere", () => {
    const dir = makeRepo();
    const other = makeRepo();
    const env = { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, ".git/index") };
    expect(verify(dir, [], env)).toMatchObject({ status: 0, runs: 1 });
    expect(recorded(dir)).toBe(snapshot(dir).fingerprint);
    expect(recorded(other)).toBeNull();
  });
});

describe("the tree's fingerprint", () => {
  it("sees untracked files, same-second edits and deletions, but not ignored files", () => {
    const dir = makeRepo();
    const start = snapshot(dir).fingerprint;
    mkdirSync(join(dir, "ignored"));
    writeFileSync(join(dir, "ignored/cache"), "x");
    expect(snapshot(dir).fingerprint).toBe(start);

    writeFileSync(join(dir, "new.js"), "x");
    expect(snapshot(dir).fingerprint).not.toBe(start);
    rmSync(join(dir, "new.js"));
    writeFileSync(join(dir, "app.js"), "ko\n"); // same size, same second
    expect(snapshot(dir).fingerprint).not.toBe(start);
    rmSync(join(dir, "app.js"));
    expect(snapshot(dir).fingerprint).not.toBe(start);
    writeFileSync(join(dir, "app.js"), "ok\n"); // an undone edit is the same tree
    expect(snapshot(dir).fingerprint).toBe(start);
    chmodSync(join(dir, "app.js"), 0o755);
    expect(snapshot(dir).fingerprint).not.toBe(start);
  });
});

describe("test counts", () => {
  // Summary lines copied from real vitest 5 and cargo runs.
  it("reads how many tests passed, and zero when none ran", () => {
    expect(vitestPassed("      Tests  73 passed (73)")).toBe(73);
    expect(vitestPassed("      Tests  4 failed | 6 passed (10)")).toBe(6);
    expect(vitestPassed("No test files found, exiting with code 1")).toBe(0);
    expect(cargoPassed("test result: ok. 11 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out")).toBe(11);
    expect(cargoPassed("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out")).toBe(0);
  });
});
