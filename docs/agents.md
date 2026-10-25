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
4. **CI** runs `pnpm verify` on GitHub for every push to `main` and every pull request.
5. **`CLAUDE.md`** tells every agent session what done means and to run `pnpm verify`.

## Rules, and what holds them

| Rule | What holds it | How sure |
| --- | --- | --- |
| Types, tests, web build, and Rust format, lint, and tests pass | `pnpm verify`, then CI | Checked. CI shows a red run, but nothing blocks a push to `main`. |
| Run `pnpm verify` before calling work done | The end-of-turn gate, `CLAUDE.md` | Checked once per turn. Claude may stop the second time, and must say what is not verified. |
| Push or merge only when you say so | Claude Code `ask` rules | Checked for the usual commands. A speed bump, not a lock. |
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
- **Only docs changed** since the last pass (`docs/`, `LICENSE`, and `*.md` outside `src/` and
  `src-tauri/`): nothing to check. It records the new tree.
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
