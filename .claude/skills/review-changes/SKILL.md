---
name: review-changes
description: Reviews a change with fresh reviewers who see the task and the diff but none of the author's reasoning, then settles each finding with evidence. Use when the owner says "review this", "ready for a PR", "before I merge", or "before a release".
---

# Review a change

A review costs several agent runs. Run it when the owner says the change is ready, or asks for a
review. While you work, `pnpm verify` is the check.

1. **Run `pnpm verify`.** Review only a change that passes it.
2. **Check what reviewers will see:** `git status --short`. Ask the owner about any untracked file
   that doesn't belong to the change. Never `git add -A`.
3. **Write the brief.** Give the task in the owner's words, what done means, and the decisions
   made. Say where to read the change: `git diff <base>` for every commit and edit since the base
   branch, and the untracked files from `git status`. Never give your opinion of the change, or
   where you think the problems are. Add this rule, word for word, with the paths filled in:
   > The working tree is read-only for you. To run or break code, make your own worktree, copy
   > in the uncommitted and untracked files, and link the installed packages:
   > `git worktree add --detach <folder> HEAD`
   > `git ls-files -z -m -o --exclude-standard | xargs -0 -I{} rsync -R "{}" <folder>/`
   > `ln -s <checkout>/node_modules <folder>/node_modules`
   > Delete there any file the change deletes. Never run `pnpm install` in it: through the link,
   > that would empty the checkout's packages. For Rust, set
   > `CARGO_TARGET_DIR=<checkout>/src-tauri/target` to skip a cold build. When you are done,
   > run `git worktree remove --force <folder>`.
4. **Start the reviewers in parallel,** each a fresh subagent with the brief:
   - **Task review, always:** missing pieces, changes nobody asked for, cases not handled, and
     tests that would pass with the feature broken. In a refactor, any changed test input or
     expected value. Read each new rule against every skill, check, and script, and report any
     that disagree.
   - **Blast-radius review,** when the change alters code or config others rely on:
     `src/editor/format.ts` (files already saved on disk), `src/editor/layers.ts`, the Rust
     commands in `src-tauri/src/`, `src-tauri/tauri.conf.json`,
     `src-tauri/capabilities/default.json`, `package.json`, `.claude/settings.json`, or
     `scripts/`. It names the one fact that makes the change safe, and proves it by running code.
     It also looks where a text search can't: files saved by older versions, library versions,
     timing.
   - **Code review:** one reviewer for each check in `.agents/checks/` that applies to the diff.
5. **Reviewers rate each finding** on the ladder in the `verify` skill: said, cited, traced, ran,
   seen.
6. **Settle each finding** at the rung its claim needs: the cited line for what the diff shows, a
   test or command that runs the code for behavior. Then fix it, dismiss it with that evidence
   (never with an argument), or leave it open for the owner. Look again when new evidence comes
   in.
7. **Fix, run `pnpm verify`,** and give a large fix its own fresh review.
8. **Report** each finding, what you did with it, and the evidence. Open findings go first.
