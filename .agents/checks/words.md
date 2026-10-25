# Check: UI text, docs, and instructions

Applies to every change that adds or edits words people or agents read.

## Report

- UI text or docs that aren't plain words, short sentences, and active voice.
- A new shortcut missing from the Shortcuts table in `README.md` or from the command palette, or
  listed there with the wrong keys.
- Instructions in `CLAUDE.md`, the skills, the checks, or `docs/agents.md` that contradict each
  other, or describe behavior the code doesn't have. `scripts/docs.test.mjs` checks paths and
  commands; this check covers what the words claim.

## Fine

- English only. The UI has no translations.
- Technical terms the reader needs, such as `TransactionSpec` in a developer doc.
