// Builds the app icons from brand/mark.svg and brand/mark-small.svg.
//
//   pnpm icons
//
// The large mark (three sheets) is used at 48px and up. The small mark (two
// sheets, heavier stroke) is used at 32px and below, where the large one clogs.
// macOS gets an .icns with both; Windows gets an .ico with both.

import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const icons = join(root, "src-tauri/icons");
const INK = "#ffffff";
const TILE = ["#e0563f", "#7c1f16"]; // editor's red, top left to bottom right

/** The mark on the red tile, on the macOS icon grid (an 824 tile inside 1024). */
function tile(markFile, transform) {
  const mark = readFileSync(join(root, "brand", markFile), "utf8")
    .replace(/<svg[^>]*>/, "")
    .replace("</svg>", "")
    .replaceAll("currentColor", INK);
  const attrs = readFileSync(join(root, "brand", markFile), "utf8").match(/stroke-width="([\d.]+)"/)[1];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${TILE[0]}"/><stop offset="1" stop-color="${TILE[1]}"/></linearGradient></defs>
<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#g)"/>
<g transform="${transform}" fill="none" stroke="${INK}" stroke-width="${attrs}" stroke-linecap="round" stroke-linejoin="round">${mark}</g>
</svg>`;
}

/** Centers a mark on the tile at `share` of its size, as Klipstack does: 68% for the full mark, 88% for the small one. */
function fit(width, height, share) {
  const scale = (824 * share) / Math.max(width, height);
  return `translate(${512 - (width * scale) / 2} ${512 - (height * scale) / 2}) scale(${scale})`;
}

const large = tile("mark.svg", fit(890, 1022, 0.68));
const small = tile("mark-small.svg", fit(24, 24, 0.88));
writeFileSync(join(root, "brand/icon.svg"), large);
writeFileSync(join(root, "brand/icon-small.svg"), small);
// For the README: the same icon cropped to the tile, without the macOS grid's margin.
writeFileSync(
  join(root, "brand/icon-tile.svg"),
  large.replace('width="1024" height="1024" viewBox="0 0 1024 1024"', 'width="824" height="824" viewBox="100 100 824 824"'),
);

const png = (size) => {
  const svg = size <= 32 ? small : large;
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
};

// Everything Tauri knows how to make, from the large icon.
const source = join(root, "brand/icon.png");
writeFileSync(source, png(1024));
execFileSync("pnpm", ["tauri", "icon", source, "-o", icons], { cwd: root, stdio: "inherit" });
// Desktop only: drop the mobile sets Tauri also writes.
for (const dir of ["android", "ios"]) rmSync(join(icons, dir), { recursive: true, force: true });

// Then replace the formats that carry small sizes, so they use the small mark.
writeFileSync(join(icons, "32x32.png"), png(32));

const iconset = join(mkdtempSync(join(tmpdir(), "undertext-")), "icon.iconset");
mkdirSync(iconset);
for (const [name, size] of [
  ["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64],
  ["128x128", 128], ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512],
  ["512x512", 512], ["512x512@2x", 1024],
]) {
  writeFileSync(join(iconset, `icon_${name}.png`), png(size));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(icons, "icon.icns")]);

const sizes = [16, 24, 32, 48, 64, 256];
const files = sizes.map((s) => {
  const f = join(iconset, `ico-${s}.png`);
  writeFileSync(f, png(s));
  return f;
});
execFileSync("magick", [...files, join(icons, "icon.ico")]);
rmSync(join(iconset, ".."), { recursive: true, force: true });

console.log("Icons written to src-tauri/icons");
