# Undertext

A local Markdown writing tool with layers under the text: alternatives, ghosts, paragraph
versions, Overflow, and an AI Lab. React and CodeMirror 6 in a Tauri 2 app, built for macOS.

What comes next, and the decisions behind the editor: the "Next" section of
`docs/codemirror-plan.md`.

## Commands

```bash
pnpm install
pnpm dev                          # the editor in a plain browser: no files, fake AI results
pnpm tauri dev                    # the desktop app, with live reload
pnpm test                         # editor, format, Lab, and palette tests (vitest, no DOM)
pnpm exec tsc --noEmit -p .       # type check
cd src-tauri && cargo test --lib  # Rust tests
pnpm tauri build --bundles app    # src-tauri/target/release/bundle/macos/Undertext.app
```

`cargo` must be on `PATH`. With Homebrew's rustup it lives in `/opt/homebrew/opt/rustup/bin`.

## How the editor works

- The CodeMirror document is the page as plain Markdown. Undertext's own syntax is not in it.
- `src/editor/format.ts` reads and writes the file: `{{a|>b}}` alternatives, `{-x-}` ghosts,
  `:::alt` paragraph versions, `<!-- overflow -->`. It has no editor imports.
- `src/editor/layers.ts` keeps alternatives, ghosts, and versions as ranges beside the text, in a
  state field that maps through edits. Change them only with `setLayers`, in the same transaction
  as the text. Undo restores them from a snapshot when a change touches a layer.
- `preview.ts` hides Markdown syntax away from the cursor. `keys.ts` has Enter, Backspace, and the
  formatting, heading, and list commands. `ink.ts` draws underlines, gutter lines, and dots.
  `lab.ts` holds the Lab's temporary marks and cuts. `clipboard.ts` keeps layers on copy and paste.
  `setup.ts` puts it together and builds the `EditorInfo` the React panels read.
- `src/App.tsx` is the app shell. `src/ai/tasks.ts` turns Claude's answers into page ranges.
- `src-tauri/src/lib.rs`: file reads and writes (a save refuses to overwrite a change from another
  app unless told to), and `open_url` for web and mail links.

## Conventions

- Tests run on `EditorState`, without a DOM. Add one for each command, with undo when it touches
  layers.
- Commands return a `TransactionSpec`, or null when they don't apply.
- Docs and UI text: plain words, short sentences, active voice.
