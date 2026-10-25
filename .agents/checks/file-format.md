# Check: saved files keep the user's writing

Applies to changes in `src/editor/format.ts`, and to anything that changes what a save writes.
Saved files are the user's data. A wrong change here loses writing, and no undo brings it back.

## Report

- A change to how files are read or written without a round-trip test in
  `src/editor/format.test.ts`.
- A file the current version saved that the new version reads differently, or text lost on
  save. Run real older content through the new code to show it opens the same.
- Plain text that reads as Undertext syntax after a save: `{{`, `{-`, a line reading `:::alt` or
  `<!-- overflow -->`. The save must escape it.
- Undertext syntax read inside code spans or code blocks.
- The File format section of `README.md` no longer matching the code.

## Fine

- New syntax that older files can't contain, with tests that it reads and writes back unchanged.
- A known loss that is already listed under "Known limitations" in `README.md`, if the change
  doesn't make it worse.
