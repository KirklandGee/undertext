# Check: tests not weakened, new behavior tested

Applies to every change. The rules are in the "Tests" section of `CLAUDE.md`; this check follows
them.

## Report

- A test deleted, skipped, or marked `.only`.
- An assertion made looser: an exact value replaced by `toContain`, `toBeTruthy`, or
  `not.toBeNull()`; fewer cases in a list; a `toBe` on text turned into a length check.
- An expected value changed to match new output, when the owner didn't ask for the new behavior.
- In a refactor: any changed test input or expected value.
- New behavior with no test, or a test that would still pass with the feature broken. For
  example, it asserts only that a command returned something, not what the text became.
- A command that changes layers without a test that undoes and redoes it and checks the saved
  Markdown.
- A multi-step test that checks only the end, where a step that does nothing would still pass.
- An expected value taken from the code under test, such as an error code the TypeScript side
  matches.
- A fake of code in `src/` that decides the result.
- A new test the report doesn't show failing once.

## Fine

- A test moved, renamed, or reaching the code by a new path, with the same inputs and expected
  values.
- A hash or id taken from the code, asserted equal or not equal, when another test pins that code.
  Example: the fingerprints in `scripts/verify.test.mjs`.
- Stubs the test never calls, such as the app actions in the palette test in
  `src/editor/lab.test.ts`.
- `not.toBeNull()` as a guard before using the value, as in the `apply` helper in
  `src/editor/layers.test.ts`, or when null is the failure ruled out and a nearby case pins the
  null, as for `matchScore`.
- A skipped test that needs the network or an account, with a comment saying how to run it, like
  the `#[ignore]` test in `src-tauri/src/claude_code.rs`.
- Tooling tests in `scripts/` that swap the real checks for a fake one in a throwaway repository.
- An expected value that changed because the owner asked for the new behavior. Quote the request.
