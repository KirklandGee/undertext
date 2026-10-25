---
name: verify
description: Proves a change works, and reports what was and wasn't verified. Use when finishing any change, or when someone asks "does it work?", "did you test it?", "is it done?", or "check it".
---

# Verify a change

1. Run `pnpm verify` and fix every failure. Done when it exits 0: it prints "Passed", or says
   nothing but docs changed since its last pass.
2. Get the proof the table asks for.
3. Check that the proof can fail: undo the change or break it on purpose, see the test or the app
   show it, then restore it.
4. Write the report below.

| Kind of change | Proof |
| --- | --- |
| Editor command, key, layer, or Lab | A test on `EditorState` in `src/editor/*.test.ts` that fails without the change |
| File format (`src/editor/format.ts`) | A round-trip test in `src/editor/format.test.ts`, and an older file that still opens the same |
| Live preview or ink (`src/editor/preview.ts`, `src/editor/ink.ts`) | The browser preview, with the cursor on the text and away from it, in light and dark |
| React panel, palette, menu, or dialog | The browser preview: a screenshot, no console errors, at 640 px wide and full size |
| Caret, IME, dead keys, spellcheck, or drag | The desktop app. WebKit behaves differently from the browser preview. |
| Rust command (`src-tauri/src/`) | A test in that file's `mod tests`, then the desktop app |
| AI request or prompt | A test on the parsing in `src/ai/tasks.ts`. The real call only works in the app, with a key or a subscription. |
| Tooling in `scripts/` | A test in `scripts/*.test.mjs`. Tests that run git or write files use a throwaway repository from `scripts/test-repo.mjs`. |
| Instructions: `CLAUDE.md`, `README.md`, `docs/agents.md`, skills | `pnpm verify` runs `scripts/docs.test.mjs` on them. Also read what the words claim against the code. |
| Other docs | Nothing to run. |

## The browser preview

- Start the `web` entry in `.claude/launch.json` (`pnpm dev`, port 1420).
- It has no file access. AI calls return the `mock` result passed to `callClaude` in
  `src/ai/client.ts`. There are no accounts to sign in to.
- Check: a screenshot, the console for errors, the window at 640 × 480 (the app's minimum) and at
  full size, and both light and dark (the app follows the system theme). The UI is English only.

## The desktop app

- `pnpm tauri dev`. It needs `cargo` on `PATH` (see `CLAUDE.md`).
- Use it, with computer use if you can, for WebKit behavior, file dialogs, the keychain, and real
  AI calls. If you can't run it, say so under "Not verified".

## The report

Rate each claim on this ladder:

1. **said:** you believe it
2. **cited:** you quote the line that shows it
3. **traced:** you followed the code path
4. **ran:** a test or script ran the code
5. **seen:** you saw it in the app

- "Fixed", "works", and "safe" need ran or seen. A fact visible in the code needs cited.
- A claim below the rung it needs goes under "Not verified", with the reason.
- When the change touches code others rely on (the file format, layers, Rust commands, or
  `scripts/`), name the one fact that makes it safe, and how you proved it.

```
Ran: pnpm verify (passed, recorded <hash>); <other tests or app checks>
Showed: <what each one showed>
Safe because: <one fact> (<rung>)
Not verified: <claim>, because <reason>
```
