---
name: build-feature
description: Builds a new feature that fits the editor's existing shape, with a test for each behavior. Use when asked to "add", "implement", "support", "build a feature", or "make it possible to" do something new.
---

# Build a feature

1. **Read the closest feature** and follow its shape. For an editor command, that is its function
   in `src/editor/commands.ts` or `src/editor/keys.ts`, its key in `src/editor/setup.ts`, its entry
   in `src/palette/commands.ts`, and its tests.
2. **Settle the decisions in one round.** List the choices only the owner can make (behavior,
   shortcut, names, file format), each with your recommendation, and ask them all at once. Done
   when each one has an answer.
3. **Write done as behaviors** a test or a look at the app can check. For example: "⌘⇧D on a
   paragraph with versions adds one more, and undo removes it."
4. **Build in thin slices, test first,** at the public interface: a command that returns a
   `TransactionSpec`, tested on `EditorState`. For each slice: write the test, see it fail, make it
   pass, and run `pnpm verify`.
5. **Update what the change touches,** from the table below.
6. Report with the `verify` skill.

| When you touch | Also update |
| --- | --- |
| A shortcut or command | The keymap in `src/editor/setup.ts`, or the keys in `src/App.tsx`; `src/palette/commands.ts`; the Shortcuts table in `README.md`; the context menu (`buildMenu` in `src/App.tsx`) if it belongs there |
| The file format | `src/editor/format.ts` and its round-trip tests; the File format section of `README.md`. Older files must still open. |
| Something a new user should learn | The welcome document, `src/welcome.ts` |
| A Rust command | `generate_handler!` in `src-tauri/src/lib.rs`; the `invoke` calls that use it, in `src/lib/files.ts`, `src/lib/links.ts`, or `src/ai/client.ts`; `src-tauri/capabilities/default.json` if it needs a permission; a Rust test |
| A new kind of layer | `src/editor/layers.ts`; `src/editor/format.ts` and the File format section of `README.md`; `src/editor/clipboard.ts`; `src/editor/ink.ts`; undo and redo tests |
| An AI task | `src/ai/tasks.ts`; a `mock` result for the browser preview; the AI section of `README.md` |
| How the editor is built | "How the editor works" in `CLAUDE.md` |
| A decision with reasons | "Decisions taken" in `docs/codemirror-plan.md`, or in `docs/layout-plan.md` for the side panels and Review |

If the code you build on needs restructuring, do that first, as its own change, with the
`refactor` skill.
