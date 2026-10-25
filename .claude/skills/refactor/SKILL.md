---
name: refactor
description: Changes the structure of code without changing what it does, bugs included. Use when asked to "refactor", "clean up", "restructure", "move", "rename", "split", "extract", or "tidy" code.
---

# Refactor

The structure changes. The behavior doesn't, bugs included. A bug you find goes in a note, for a
separate fix with the `fix-bug` skill.

1. **Pin today's behavior** at the public interface, with tests that pass now. For UI, take
   "before" screenshots in the browser preview. Done when the pins cover everything you will move.
2. **Delete proven-dead code** first: nothing calls it, and `pnpm verify` passes without it. Its
   own tests go with it; name them in the report.
3. **Move one concept at a time,** in small steps. Run `pnpm verify` after each step. The pins stay
   green.
4. **Migrate every caller,** then delete the old API. No shims left behind.
5. **Compare** "after" screenshots with "before".
6. **Keep it only if you can name what got easier to read.** If you can't, revert it.

Existing tests may change how they reach the code: paths, names, call sites. Never their inputs or
expected values. When the editor moved to CodeMirror, 1 of the 8 list tests was ported, and a fix
for stray spaces broke without any test noticing. Port every case.

Report with the `verify` skill. Name the test files whose expected values you left unchanged.
