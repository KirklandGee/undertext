# Check: how the editor is built

Applies to changes in `src/editor/` and the panels that read it. The design is in "How the
editor works" in `CLAUDE.md`.

## Report

- Alternatives, ghosts, or versions changed other than through `setLayers`, in the same
  transaction as the text.
- A layer command without a test that does, undoes, and redoes it, and checks the saved Markdown.
- A command that dispatches on its own instead of returning a `TransactionSpec`, or null when it
  doesn't apply.
- Undertext's own syntax (`{{ }}`, `{- -}`, `:::alt`) placed in the CodeMirror document. The
  document is the page as plain Markdown; the layers sit beside it.
- React state that copies part of the editor state and isn't rebuilt from it on each update, so
  the two can disagree.

## Fine

- New helpers in their own module, with tests on `EditorState`.
- Decorations computed from the editor state on each update.
- `EditorInfo`, which `describe` in `src/editor/setup.ts` rebuilds from the editor state on each
  update for the React panels.
- `src/editor/format.ts` using the Markdown parser from `@lezer/markdown`. It uses nothing else;
  `scripts/rules.test.mjs` checks that.
