# Working with coding agents

Undertext is built with coding agents, mostly Claude Code. This page says what the repository
checks on its own, what it only asks agents to do, and what is still up to you.

The idea: an agent proves its work before it calls it done, without you asking. A passing check
is proof; "I read the code" is not.

## The layers so far

1. **`pnpm verify`** runs every check, in about 10 seconds, and records the tree when they all
   pass.
2. **The end-of-turn gate** sends Claude back once when a turn changed code that `pnpm verify`
   hasn't passed.
3. **Ask first:** Claude Code asks you before it pushes or merges.
4. **Skills** give each kind of work its first step and its proof: verify, fix a bug, build a
   feature, refactor, learn from a mistake.
5. **CI** runs `pnpm verify` on GitHub for every push to `main` and every pull request.
6. **`CLAUDE.md`** tells every agent session what done means, which skill to use, and how tests
   are written.

## Rules, and what holds them

| Rule | What holds it | How sure |
| --- | --- | --- |
| Types, tests, web build, and Rust format, lint, and tests pass | `pnpm verify`, then CI | Checked. CI shows a red run, but nothing blocks a push to `main`. |
| Run `pnpm verify` before calling work done | The end-of-turn gate, `CLAUDE.md` | Checked once per turn. Claude may stop the second time, and must say what is not verified. |
| Push or merge only when you say so | Claude Code `ask` rules | Checked for the usual commands. A speed bump, not a lock. |
| Fix a bug with a failing test first; refactor without changing assertions | The `fix-bug` and `refactor` skills | Asked |
| Expected values written by hand; each new test seen failing once | `CLAUDE.md` | Asked |
| Instructions name only files and `pnpm` commands that exist, and each skill says when to use it | `scripts/docs.test.mjs`, in `pnpm verify` | Checked |
| Never weaken a check to pass it | `CLAUDE.md` | Asked |
| Say what was not verified | `CLAUDE.md` | Asked |

"Asked" means an agent can forget it. Later steps turn some of these into checks.

## The end-of-turn gate

Two Claude Code hooks in `.claude/settings.json` run `scripts/guard.mjs`:

- When a turn starts, it records a hash of every file, as `pnpm verify` does.
- When Claude stops, it compares the tree with that record. If the turn changed code (anything
  but docs) and `pnpm verify` hasn't passed on the tree as it is now, it sends Claude back with
  the files it changed and what to do.
- It does this **once per turn**. The second stop goes through, so Claude can stop on purpose.
  It then has to say what is not verified. Another Stop hook, such as a loop plugin, doesn't turn
  it off.
- Turns that changed nothing, changed only docs, or undid their edits go through.
- A turn that changed only CI files can't be verified on your Mac. The gate asks Claude to say so.

**It fails open.** If the guard breaks, it lets the turn through. Usually it shows a message that
starts with "Undertext guard". If it crashes outright or takes too long, Claude Code shows its own
hook error instead. Either way, the turn was not checked.

**Limits:**

- It sees every change in the turn, also yours: an edit you make in another editor while Claude
  works counts.
- It checks the checkout it lives in, or a linked worktree of it that the session is in. Edits in
  another repository are not checked. A turn that moves to another checkout is not checked, and
  the message says so.
- Two sessions in the same checkout see each other's edits. Each may send its Claude back once for
  the other's work.
- Only Claude Code runs it. Codex, Amp, and Cursor are not set up here.

Its records live in `.git/undertext/turns/`, one file per session, shared by every worktree. Files
older than a week are deleted. Its tests, in `scripts/guard.test.mjs`, run copies of the guard in throwaway
repositories.

## Ask first

`.claude/settings.json` has `ask` rules for `git push`, `gh pr merge`, and any command with
`--no-verify`. Claude Code then asks you, even in auto mode, and even inside a longer command such
as `cd x && git push`.

- **It is a speed bump.** It matches the commands Claude usually writes. A different form of the
  same thing, such as a script that pushes, gets through.
- `--no-verify` skips git hooks. This repository has none today, so that rule guards nothing yet.
  It misses the short form, `git commit -n`.
- The real lock would be branch protection on GitHub. You push to `main` yourself, so there is
  none.

## Skills

The skills are in `.claude/skills/`. Claude Code reads each one's description and loads the full
text only when a task matches, so they cost little until used. `CLAUDE.md` tells Claude to use
them without being asked.

| Skill | For | Its first step | Its proof |
| --- | --- | --- | --- |
| `verify` | Finishing any change | `pnpm verify` | The proof for that kind of change, from its table, and a report that says what was not verified |
| `fix-bug` | Anything broken | A test that fails on the exact symptom | Undo the fix: the test fails. Restore it: it passes. |
| `build-feature` | Anything new | Read the closest feature; settle your decisions in one round | One test per behavior, written first |
| `refactor` | Structure only | Tests that pin today's behavior | The same tests pass, with their expected values untouched |
| `learn` | A correction, or a mistake that repeats | Pick the strongest structure: type, test, script check, then a line of text | The check fails when the mistake is made on purpose |

## Asking for work

| To start | Say | Your part |
| --- | --- | --- |
| A bug fix | What you did, what happened, what should happen | Confirm Claude's restatement if the report was vague |
| A feature | What it should do, and how you'd check it works | Answer the decisions Claude lists, all at once |
| A refactor | What should get easier, and that behavior must not change | Read the list of tests whose expected values stayed the same |

Any request works better with:

- **The goal**, and a done check that can pass or fail: "pasting a link over a selection makes a
  link, and undo restores the text".
- **The proof you want**: a test, a screenshot, a run in the app.
- **What you already know**, and real constraints: "only in the desktop app", "don't touch the
  file format".

Leave out the method and your theory of the cause, unless you are sure. They anchor Claude on
them. Start a new session for unrelated work, so it starts with a clean context.

Then read the report's "Not verified" part. Try in the app what Claude couldn't.

## `pnpm verify`

It runs, in order, and prints one line per check:

| Check | Command |
| --- | --- |
| types | `tsc --noEmit -p .` |
| config types | `tsc` on `vite.config.ts` |
| tests | `vitest run`, with no `.only` allowed (fails if no test ran) |
| web build | `vite build`, into a scratch folder, so `dist/` stays as it was |
| rust format | `cargo fmt --check` |
| rust lint | `cargo clippy --all-targets --locked -- -D warnings` |
| rust tests | `cargo test --lib --locked` (fails if no test ran) |

- It never picks a subset of the checks. They are fast, so there is nothing to gain. It runs all
  of them, or none in the three cases below.
- On a failure it prints the end of that check's log and the full log's path. Logs live in
  `.git/undertext/logs/`, or under `.git/worktrees/<name>/` in a linked worktree.
- **It records a pass** only when every check passed and no file changed during the run. The
  record is a hash of every file's contents, untracked files included, in
  `.git/undertext/verified.json`. Each worktree keeps its own. A failed run deletes the record.
- **Nothing changed** since the last pass: it says so and stops. `pnpm verify --force` runs the
  checks anyway, for example after `rustup update`.
- **Only docs changed** since the last pass: nothing to check. It records the new tree. Docs are
  `docs/`, `LICENSE`, and Markdown outside `src/` and `src-tauri/`, but not the instructions:
  `CLAUDE.md`, `README.md`, `docs/agents.md`, and everything in `.claude/`. The docs test reads
  those, so a change to them runs every check.
- **Only CI files changed** (`.github/`): local checks can't see them. It records nothing, even
  with `--force`. Push and read the CI run.
- It finds `cargo` on `PATH`, in `~/.cargo/bin`, or in Homebrew's rustup folder. Without cargo it
  fails. It never skips a check it can't run.

**What it can't see:** the app window, which is WebKit, while `pnpm dev` runs in Chromium; real AI
calls; file dialogs; and the keychain. For those, run `pnpm tauri dev` and try the change.

**Known limits:**

- It compares the tree before and after the run. An edit made and undone while it runs goes
  unseen.
- It checks the files on disk, not what is staged. When you stage only part of a change, the
  commit holds a tree that was never checked. CI checks the commit after you push.
- A stray `.only` fails it, as in CI. A `.skip` does not.

The script is `scripts/verify.mjs`, the checks are in `scripts/verify-steps.mjs`, and its tests are
in `scripts/verify.test.mjs`. The tests run copies of the scripts in throwaway repositories.

## CI

`.github/workflows/verify.yml` runs `pnpm verify` on a GitHub macOS machine. It is free for public
repositories.

- **Why macOS:** the app is built and tested there. On Linux, Tauri needs extra WebKit packages.
- **It is a signal, not a gate.** `main` has no branch protection, so a red run blocks nothing.
  You push to `main` yourself, and that stays as it is.
- **Cancelled runs are not failures.** A newer push to the same branch cancels the older run. A
  run that never got a machine or timed out needs a re-run, not a code change.
- **Rust is not pinned.** CI uses the latest stable Rust. A new Clippy lint can fail CI before it
  fails on your Mac. Run `rustup update`, then `pnpm verify --force`.
- Each action is pinned to one commit, with its version in a comment, so a changed tag can't
  change what runs.

## Where the ideas come from

Kent Beck, Simon Willison, Mitchell Hashimoto, Anthropic's and Amp's guidance on coding agents,
OpenAI's harness engineering, Lauren Tan's pstack, Matt Pocock's skills, and Jesse Vincent's
superpowers.
