# Undertext on Omarchy

Local setup for running Undertext on [Omarchy](https://omarchy.org/). Not part of upstream.

- `undertext.css.tpl`: Omarchy theme template. Omarchy renders it into
  `~/.local/state/omarchy/current/theme/undertext.css` on every theme change, and the app picks
  that file up within a few seconds.
- `undertext`: launcher. `undertext` reopens the last page, and `undertext --new` starts a fresh
  untitled one. An untitled page's first save goes to
  `~/Documents/writings`. `undertext notes.md` opens notes.md, or starts it.
- `undertext.desktop`: launcher entry, shown as "Write".
- Spelling uses Enchant with Hunspell dictionaries: `sudo pacman -S hunspell-en_us`. Learned words
  go to `~/.config/enchant/en_US.dic`.

## Install

```bash
pnpm install
pnpm tauri build --no-bundle

ln -s "$PWD/omarchy/undertext.css.tpl" ~/.config/omarchy/themed/undertext.css.tpl
ln -s "$PWD/omarchy/undertext" ~/.local/bin/undertext
cp omarchy/undertext.desktop ~/.local/share/applications/
omarchy theme set "$(omarchy theme current)"   # render the template for the current theme
```

`/usr/bin/write` is the Unix messaging tool and comes before `~/.local/bin` on `PATH`, so use an
alias for a `write` command: `alias write='undertext'` in `~/.bashrc`.

The launcher and desktop entry expect the repo at `~/Work/write-on-research/undertext`.
