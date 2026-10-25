# Check: nothing private or secret

Applies to every change. The repository is public.

## Report

- Keys, tokens, passwords, or account emails in code, tests, fixtures, docs, or commit messages.
- Someone's real writing or personal documents in tests, fixtures, or the welcome document.
- Paths that name a person's machine, such as a home folder, in committed files.
- An AI request that sends text before the user picks an AI feature, or sends more than the
  Privacy paragraph in `README.md` says.

## Fine

- `ANTHROPIC_API_KEY` read from the environment.
- Sample text written for the repository.
- Generic install paths such as `/opt/homebrew` or `/Applications`.
