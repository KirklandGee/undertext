// The checks `pnpm verify` runs, in order. CI runs the same list through `pnpm verify`.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { stateDir } from "./tree.mjs";

/** The folder with cargo: PATH, rustup's default, or Homebrew's rustup, which fish leaves off PATH. */
function cargoDir() {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".cargo/bin"), "/opt/homebrew/opt/rustup/bin"];
  return dirs.find((dir) => dir && existsSync(join(dir, "cargo"))) ?? null;
}

/** How many tests passed, from the runner's summary. Zero means the step checked nothing. */
export const vitestPassed = (log) => Number(/Tests\s+.*?(\d+) passed/.exec(log)?.[1] ?? 0);
export const cargoPassed = (log) =>
  [...log.matchAll(/test result: \w+\. (\d+) passed/g)].reduce((sum, m) => sum + Number(m[1]), 0);

const ranTests = (count) => (log) => (count(log) > 0 ? null : "No tests ran.");

export function steps(root) {
  const bin = (name) => join(root, "node_modules/.bin", name);
  const rust = join(root, "src-tauri");
  const cargo = cargoDir();
  const cargoStep = (name, args, check) =>
    cargo
      ? { name, cmd: join(cargo, "cargo"), args, cwd: rust, env: { PATH: `${cargo}${delimiter}${process.env.PATH}` }, check }
      : { name, missing: "cargo not found. Install Rust (see README), or put cargo on PATH." };
  return [
    { name: "types", cmd: bin("tsc"), args: ["--noEmit", "-p", "."] },
    // composite would write tsconfig.node.tsbuildinfo into the tree.
    { name: "config types", cmd: bin("tsc"), args: ["--noEmit", "-p", "tsconfig.node.json", "--composite", "false"] },
    // CI rejects a stray `.only`; so does this, or a local pass would fail there.
    { name: "tests", cmd: bin("vitest"), args: ["run", "--allowOnly=false"], check: ranTests(vitestPassed) },
    // Outside the tree, so dist/ stays as the last real build left it.
    { name: "web build", cmd: bin("vite"), args: ["build", "--outDir", join(stateDir(root), "web"), "--emptyOutDir"] },
    cargoStep("rust format", ["fmt", "--check"]),
    cargoStep("rust lint", ["clippy", "--all-targets", "--locked", "--", "-D", "warnings"]),
    cargoStep("rust tests", ["test", "--lib", "--locked"], ranTests(cargoPassed)),
  ];
}

/** What these checks can't see. */
export const unseen = "the app window (WebKit), real AI calls, file dialogs, and the keychain";
