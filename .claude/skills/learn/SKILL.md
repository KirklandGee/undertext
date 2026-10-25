---
name: learn
description: Turns a correction or a repeated mistake into a check that catches it next time. Use when the owner says "don't do that again", "you keep doing this", "remember this", "this happened before", or corrects the same thing twice.
---

# Learn from a mistake

1. **Name the mistake** in one line, with the example that showed it.
2. **Pick the strongest structure that holds it,** in this order:
   1. a type, in TypeScript or Rust
   2. a test, in `src/`, `src-tauri/`, or `scripts/`
   3. a script check: a step in `scripts/verify-steps.mjs`, or the gate in `scripts/guard.mjs`
   4. a line in `CLAUDE.md` or a skill, only for what no code can check

   A rule that is already written down and still broken goes straight to code.
3. **Prove it catches the mistake:** make the mistake on purpose and see the check fail.
4. **Delete the instructions it replaces** in `CLAUDE.md`, the skills, and `docs/`.
5. **Update the rules table** in `docs/agents.md`: the rule, what holds it, and how sure.
6. Make it its own small change. Commit it when the owner asks.

Claude's memory notes hold the owner's preferences, such as how they like commits. They are not
the place for a rule a check can hold.
