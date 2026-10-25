// Runs copies of the guard in throwaway repositories (see test-repo.mjs), the way Claude Code's
// hooks do: the hook's JSON on stdin, from another folder.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo, tempDir, verify } from "./test-repo.mjs";
import { git } from "./tree.mjs";

function guard(dir, event, input = {}, env = {}) {
  const result = spawnSync(process.execPath, [join(dir, "scripts/guard.mjs"), event], {
    cwd: tmpdir(),
    input: typeof input === "string" ? input : JSON.stringify({ session_id: "one", cwd: dir, ...input }),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  expect(result.status).toBe(0); // a hook that errors would stop Claude for the wrong reason
  return result.stdout ? JSON.parse(result.stdout) : null;
}

const write = (dir, path, text) => writeFileSync(join(dir, path), text);

describe("the end-of-turn gate", () => {
  it("lets a turn through that changed nothing, only docs, or undid its edits", () => {
    const dir = makeRepo();
    guard(dir, "turn-start");
    expect(guard(dir, "turn-end")).toBeNull();

    guard(dir, "turn-start");
    write(dir, "LICENSE", "Documented.\n");
    expect(guard(dir, "turn-end")).toBeNull();

    guard(dir, "turn-start");
    write(dir, "app.js", "changed\n");
    write(dir, "app.js", "ok\n");
    expect(guard(dir, "turn-end")).toBeNull();
  });

  it("sends Claude back when a turn changed code without a pass, naming the files", () => {
    const dir = makeRepo();
    guard(dir, "turn-start");
    write(dir, "app.js", "changed\n");
    write(dir, "new.js", "untracked\n");
    const out = guard(dir, "turn-end");
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("app.js, new.js");
    expect(out.reason).toContain("Run `pnpm verify`");
    expect(out.systemMessage).toContain("sent Claude back");
  });

  it("sends Claude back only once per turn, even when another Stop hook continued it", () => {
    const dir = makeRepo();
    guard(dir, "turn-start");
    write(dir, "app.js", "changed\n");
    expect(guard(dir, "turn-end", { stop_hook_active: true }).decision).toBe("block");
    expect(guard(dir, "turn-end", { stop_hook_active: true })).toBeNull();

    guard(dir, "turn-start");
    write(dir, "app.js", "changed again\n");
    expect(guard(dir, "turn-end").decision).toBe("block"); // a new turn starts fresh
  });

  it("lets the turn through once pnpm verify passed, also after later docs edits", () => {
    const dir = makeRepo();
    guard(dir, "turn-start");
    write(dir, "app.js", "changed\n");
    expect(verify(dir).status).toBe(0);
    write(dir, "LICENSE", "Documented.\n");
    expect(guard(dir, "turn-end")).toBeNull();
  });

  it("sends Claude back when code changed after the pass, even in the same second", () => {
    const dir = makeRepo();
    guard(dir, "turn-start");
    write(dir, "app.js", "v1\n");
    expect(verify(dir).status).toBe(0);
    write(dir, "app.js", "v2\n");
    expect(guard(dir, "turn-end").decision).toBe("block");
  });

  it("asks Claude to say CI files are not verified, since local checks can't see them", () => {
    const dir = makeRepo();
    expect(verify(dir).status).toBe(0);
    guard(dir, "turn-start");
    mkdirSync(join(dir, ".github"));
    write(dir, ".github/ci.yml", "on: push\n");
    const out = guard(dir, "turn-end");
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("CI files (.github/ci.yml)");

    // Code an earlier turn left unverified doesn't change what this turn is told.
    write(dir, "app.js", "changed earlier\n");
    guard(dir, "turn-start");
    write(dir, ".github/ci.yml", "on: pull_request\n");
    expect(guard(dir, "turn-end").reason).toContain("CI files (.github/ci.yml)");
  });

  it("keeps sessions apart", () => {
    const dir = makeRepo();
    guard(dir, "turn-start", { session_id: "one" });
    write(dir, "app.js", "changed\n");
    guard(dir, "turn-start", { session_id: "two" });
    expect(guard(dir, "turn-end", { session_id: "two" })).toBeNull();
    expect(guard(dir, "turn-end", { session_id: "one" }).decision).toBe("block");
  });

  it("lets a turn through, and says so, when its start wasn't recorded", () => {
    const dir = makeRepo();
    write(dir, "app.js", "changed\n");
    const out = guard(dir, "turn-end");
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain("not checked");
  });

  it("says the turn was not checked when its start failed, instead of using the last turn's record", () => {
    const dir = makeRepo();
    guard(dir, "turn-start");
    write(dir, "app.js", "changed\n");
    expect(guard(dir, "turn-end").decision).toBe("block");
    expect(guard(dir, "turn-end")).toBeNull();

    const index = readFileSync(join(dir, ".git/index"));
    writeFileSync(join(dir, ".git/index"), "not an index"); // git can't list files
    expect(guard(dir, "turn-start").systemMessage).toContain("guard failed");
    writeFileSync(join(dir, ".git/index"), index);
    write(dir, "app.js", "changed again\n");
    expect(guard(dir, "turn-end").systemMessage).toContain("not checked");
  });

  it("deletes turn records older than a week", () => {
    const dir = makeRepo();
    const turns = join(dir, ".git/undertext/turns");
    mkdirSync(turns, { recursive: true });
    write(dir, ".git/undertext/turns/old.json", "{}");
    write(dir, ".git/undertext/turns/recent.json", "{}");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(turns, "old.json"), eightDaysAgo, eightDaysAgo);
    guard(dir, "turn-start");
    expect(existsSync(join(turns, "old.json"))).toBe(false);
    expect(existsSync(join(turns, "recent.json"))).toBe(true);
  });

  it("fails open, and says so, when it can't read its input or the tree", () => {
    const dir = makeRepo();
    expect(guard(dir, "turn-end", "not json").systemMessage).toContain("guard failed, so it let this turn through");
    expect(guard(dir, "turn-ended").systemMessage).toContain('unknown event "turn-ended"');

    const notGit = tempDir();
    mkdirSync(join(notGit, "scripts"));
    for (const file of ["guard.mjs", "tree.mjs"]) copyFileSync(join(dir, "scripts", file), join(notGit, "scripts", file));
    expect(guard(notGit, "turn-start", { cwd: notGit }).systemMessage).toContain("guard failed");

    write(dir, "scripts/tree.mjs", "export const broken = ;\n");
    expect(guard(dir, "turn-end").systemMessage).toContain("guard failed");
  });

  it("checks its own checkout, not another repository Claude is in", () => {
    const dir = makeRepo();
    const other = makeRepo();
    guard(dir, "turn-start", { cwd: other });
    write(dir, "app.js", "changed\n");
    expect(guard(dir, "turn-end", { cwd: other }).decision).toBe("block");
  });

  it("follows Claude into a linked worktree of its own checkout", () => {
    const dir = makeRepo();
    const tree = join(tempDir(), "linked");
    git(dir, "worktree", "add", "-q", tree);
    guard(dir, "turn-start", { cwd: tree });
    write(tree, "app.js", "changed in the worktree\n");
    expect(guard(dir, "turn-end", { cwd: tree }).decision).toBe("block");

    guard(dir, "turn-start", { cwd: tree });
    write(tree, "app.js", "changed again\n");
    expect(verify(tree).status).toBe(0);
    expect(guard(dir, "turn-end", { cwd: tree })).toBeNull();
  });

  it("says the turn was not checked when it moved to another checkout", () => {
    const dir = makeRepo();
    const tree = join(tempDir(), "linked");
    git(dir, "worktree", "add", "-q", tree);
    guard(dir, "turn-start", { cwd: dir });
    write(tree, "app.js", "changed in the worktree\n");
    const out = guard(dir, "turn-end", { cwd: tree });
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain("this turn moved");
  });

  it("acts on its own checkout when git's hook variables point elsewhere", () => {
    const dir = makeRepo();
    const other = makeRepo();
    const env = { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, ".git/index") };
    guard(dir, "turn-start", {}, env);
    write(dir, "app.js", "changed\n");
    expect(guard(dir, "turn-end", {}, env).decision).toBe("block");
  });
});
