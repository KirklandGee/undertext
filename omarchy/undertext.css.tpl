/* Omarchy theme for Undertext. Rendered on every `omarchy theme set`. */

:root[data-omarchy][data-theme] {
  color-scheme: {{ mode }};

  --bg: {{ background }};
  --panel: {{ dark_background }};
  --fg: {{ foreground }};
  --fg-dim: {{ mix foreground background 35% }};
  --faint: {{ muted }};
  --heading: {{ bright_foreground }};
  --line: {{ lighter_background }};
  --menu: {{ mix background lighter_background 60% }};

  --accent: {{ accent }};
  --accent-dim: rgba({{ accent_rgb }}, 0.45);
  --underline: rgba({{ accent_rgb }}, 0.32);
  --selection: {{ selection_background }};

  --mark: rgba({{ bright_yellow_rgb }}, 0.22);
  --mark-line: rgba({{ bright_yellow_rgb }}, 0.7);

  --hl-very-hard: rgba({{ red_rgb }}, 0.26);
  --hl-hard: rgba({{ bright_yellow_rgb }}, 0.22);
  --hl-weak: rgba({{ blue_rgb }}, 0.27);
  --hl-simpler: rgba({{ green_rgb }}, 0.22);
  --hl-dash: rgba({{ cyan_rgb }}, 0.24);
  --hl-grammar: rgba({{ magenta_rgb }}, 0.26);
  --spelling: rgba({{ red_rgb }}, 0.85);
  --punctuation: rgba({{ blue_rgb }}, 0.95);
}
