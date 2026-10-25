// Rules from CLAUDE.md that code can check. Reads this checkout's source; writes nothing.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Every module a file pulls in: `import`, `export … from`, and `import()`. */
const dependencies = (path) =>
  [...readFileSync(join(root, path), "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);

describe("how the editor is built", () => {
  it("keeps the file format free of the editor: format.ts uses only the Markdown parser", () => {
    expect([...new Set(dependencies("src/editor/format.ts"))]).toEqual(["@lezer/markdown"]);
  });
});
