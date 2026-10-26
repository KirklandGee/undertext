---
name: fix-bug
description: Fixes a bug so it stays fixed, with a regression test that proves the fix is needed. Use when something is "broken", "wrong", "a bug", "a regression", "doesn't work", or "used to work".
---

# Fix a bug

1. **Restate the symptom** in one line: what you did, what happened, what should happen. If the
   report is vague, write your restatement and ask before you start.
2. **Reproduce it at the lowest layer that shows it.** A test on `EditorState` in
   `src/editor/*.test.ts` beats one through React. A test in the Rust file's `mod tests` beats the
   app. Run it: it must fail, for the reason in the report. Done when you have that failing test.
   - Example, for "Enter in a list item leaves a stray space", in `src/editor/keys.test.ts`:
     `expect(run(stateFor("1. one‸ two"), enter).text).toBe("1. one\n2. ‸two")`
   - Some bugs show only in WebKit: caret, IME, dead keys. Reproduce those in `pnpm tauri dev` and
     write the steps down. Still add a test for any part the editor state can show.
3. **Find the root cause.** Say why it happens and cite the line. Don't patch the symptom in a
   caller.
4. **Make the smallest fix.** No restructuring in the same change. Note it for the `refactor`
   skill instead.
5. **Prove the fix is needed:** undo it and see the test fail, then restore it and see it pass.
6. Run `pnpm verify`, then report with the `verify` skill.

The new test stays as the regression test. Never change an existing test's expected value to make
it pass, unless the owner says the old behavior was wrong.

After three fixes that didn't work, stop. Say what you tried and what you learned, then rethink the
cause before you try again.
