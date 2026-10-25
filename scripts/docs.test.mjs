// The instructions name only files and commands that exist, and every skill says when to use it.
// Reads this checkout's files; writes nothing.
import { readFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { git, isInstructions } from "./tree.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
// Exact names, as git sees them: macOS would find `src/Editor` too.
const files = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
const docs = files.filter((path) => isInstructions(path) && path.endsWith(".md"));
const skills = files.map((path) => /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1]).filter(Boolean);

const isFileOrFolder = (path) => files.includes(path) || files.some((file) => file.startsWith(`${path.replace(/\/$/, "")}/`));
const names = new Set(files.map((file) => basename(file)));

/** Why a path named in a doc is wrong, or null. */
function problem(path) {
  if (/[<>~\s]|^https?:|^mailto:/.test(path)) return null; // placeholders, home folders, the web
  if (path.includes("*")) return files.some((file) => file.startsWith(path.slice(0, path.indexOf("*")))) ? null : "matches nothing";
  if (path.includes("/")) return isFileOrFolder(path) ? null : "doesn't exist";
  return names.has(path) ? null : "no file has this name";
}

const SOURCE = /^(src|src-tauri|scripts|docs|brand|\.claude|\.github|\.agents)\//;
const FILE_NAME = /^[\w.-]+\.(tsx?|mjs|js|json|md|rs|toml|ya?ml|html|css)$/;
const named = (text) =>
  [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].replace(/:\d+$/, "")).filter((path) => SOURCE.test(path) || FILE_NAME.test(path));
const linked = (text, doc) =>
  [...text.matchAll(/\]\(([^)\s#]+)[^)]*\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(https?|mailto):/.test(target))
    .map((target) => normalize(join(dirname(doc), target)));

const scripts = Object.keys(JSON.parse(read("package.json")).scripts);
const namedCommands = (text) => [...text.matchAll(/(?:^|`)pnpm ([\w:-]+)/gm)].map((match) => match[1]);

describe("instructions", () => {
  it("cover CLAUDE.md, the README, the agents page, and every skill", () => {
    expect(docs).toEqual(expect.arrayContaining(["CLAUDE.md", "README.md", "docs/agents.md", ".claude/skills/verify/SKILL.md"]));
  });

  it.each(docs)("%s names and links only files that exist", (doc) => {
    const text = read(doc);
    const wrong = [...named(text), ...linked(text, doc)]
      .map((path) => [path, problem(path)])
      .filter(([, why]) => why)
      .map(([path, why]) => `${path}: ${why}`);
    expect(wrong).toEqual([]);
  });

  it.each(docs)("%s names only pnpm commands that exist", (doc) => {
    const unknown = namedCommands(read(doc)).filter((name) => !scripts.includes(name) && !["install", "exec"].includes(name));
    expect(unknown).toEqual([]);
  });

  it("CLAUDE.md lists every skill, and only those", () => {
    const section = /## Skills\n([\s\S]*?)\n## /.exec(read("CLAUDE.md"))?.[1] ?? "";
    const listed = [...section.matchAll(/^- `([\w-]+)`:/gm)].map((match) => match[1]);
    expect(listed.sort()).toEqual([...skills].sort());
  });

  it.each(skills)("the %s skill is named for its folder and says when to use it", (name) => {
    const head = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(read(`.claude/skills/${name}/SKILL.md`));
    expect(head?.[1]).toBe(name);
    expect(head?.[2]).toMatch(/\. Use when /);
  });
});
