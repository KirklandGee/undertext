# Brand

- `mark.svg`: the canonical mark, in `currentColor`. Three fanned sheets. One line draws the front
  sheet and runs on into a handwritten "u". It borrows Klipstack's mark, with the u in place of the clip.
- `mark-small.svg`: the same idea on a 24-unit grid for 32px and below. One back sheet, a heavier
  stroke, and a bigger u whose lead-in runs up and back down its first stem.
- `icon.svg`, `icon-small.svg`, `icon.png`, `icon-tile.svg`: generated. `icon-tile.svg` is cropped to
  the tile for the README. The marks in white on the red tile
  (`#e0563f` top left to `#7c1f16`), on the macOS icon grid.

## Regenerate

`pnpm icons` writes everything in `src-tauri/icons/`. The `.icns` and `.ico` use the small mark at
32px and below and the large mark above. Needs macOS `iconutil` and ImageMagick (`magick`).
