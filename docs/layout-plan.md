# Plan: side panels with one job each, and room for Hemingway's checks

Status: phase 1 and the first slice of live checks built, 2026-10-26. See "Decisions taken" and
"Open decisions" at the end.

## Goals

- Give each side panel one job, so new features have an obvious home.
- Make room for what [Hemingway Editor](https://hemingwayapp.com) does: readability, highlighted
  issues, and AI rewrites.
- Keep the page calm while writing. Analysis shows only when asked for.
- Every AI result stays a layer: an alternative, a paragraph version, or a Lab mark or cut. Nothing
  replaces the writer's text without a way back.

Not in scope: an outline, a file list, more than one open document.

## What Hemingway does

From its help pages, read on 2026-10-26.

- **Readability grade**, top right. The default target is grade 9. Plus can set it to Accessible,
  Default, or Technical.
- **Highlights**, in color, inline:
  - Hard to read (yellow) and very hard to read (red) sentences.
  - Weakeners (blue): adverbs, passive voice, qualifiers, intensifiers, weak verbs, fillers,
    hidden actions, and negative or indirect phrases. Each has its own count and eye.
  - Simpler words (purple): a word with a plainer synonym.
  - Writing issues (green): grammar, spelling, and style, such as a sentence that starts with
    "And". Plus only.
- **A key on the right** with each category's count and an eye icon that shows or hides it.
- **Stats**: words by default. More on request: letters, characters, sentences, paragraphs,
  reading time.
- **Write and Edit modes.** Write hides all highlights and stats. Edit shows them.
- **AI tools** (Plus) on a floating toolbar over a selection: Simplify, Polish, Rephrase, AI
  synonyms, tone (confident, friendly, casual, formal, persuasive), Shorten, Add detail, Add
  headings, bullets, and bold, and a free-text instruction. Results show in a pop-up with "Use
  suggestion", arrows to step through, and "Get another suggestion".
- **Feedback**: a written review of the whole piece. Structure, logic, flow, clarity, tone.

## What Undertext has already

| Hemingway                         | Undertext today                                      |
| --------------------------------- | ---------------------------------------------------- |
| AI synonyms, Rephrase             | Alternatives, and "Suggest with AI" (⌘⇧G)            |
| Shorten it                        | Trims: −10%, −20%, −35%, −50%                        |
| Hard sentences, qualifiers        | Lab checks: long, convoluted, hedges and filler      |
| Grammar and spelling              | "Fix punctuation and typos", as alternatives         |
| Tone                              | Lab check "Off-tone words" marks words; no rewrite   |
| Use suggestion (replaces text)    | Every result is an alternative; the original stays   |

The gap is Hemingway's free half: **checks that run locally, as you type**, with no AI call. That
is the grade, hard sentences, adverbs, passive voice, qualifiers, and simpler words. The rest is
mostly here already, in a form that keeps the original.

## Today's layout

- Top bar: word and character count, file name. A click on the count toggles the layers, which
  nothing hints at.
- Left panel: Alternatives (`src/components/AltPanel.tsx`), with Word, Sentence, and Paragraph
  tabs. It follows the caret. ⌘⇧A opens it.
- Right panel: Overflow, a scratch text area for the whole page. ⌘⇧O opens it.
- The Lab (`src/components/LabMenu.tsx`): a floating menu of checks, typo fixes, and trims. ⌘⇧E
  opens it. Results show in a bar under the page (`src/components/LabBar.tsx`).
- Bottom bar: Open and Save on the left. The toast in the middle. Lab, ⌘K, Alternatives, and
  Overflow on the right.

The left panel is about the caret. The right panel is about the page. That split is right, but
nothing says so, and the Lab floats outside it.

## The rule

- **Left panel, "Here": the spot at the caret.** The word, sentence, or paragraph you are on. What
  you can swap in, and why it is marked.
- **Right panel: the whole page.** How it reads, what to check, and the text you set aside.

A new feature goes left if it changes with the caret. It goes right if it is about the whole page.

## Left panel: Here

Today's Alternatives panel, grown. Same shortcut, ⌘⇧A.

- **Alternatives and versions**, as today: Word, Sentence, and Paragraph.
- **Rewrite with Claude**: Simplify, Shorter, Polish, Tone (a short list), and a free-text ask.
  Today's "Suggest with AI" becomes one of these.
  - On a word or sentence, each result is a new variant of the alternative.
  - On a whole paragraph, each result is a new paragraph version.
  - ↑↓ steps through results, as today. Nothing is applied until you pick it, and the original
    stays as variant one.
- **Why it's marked**: the reason for the highlight or Lab mark under the caret. For example,
  "Very hard to read. 38 words." Today this is `here` in the Lab bar.

## Right panel: Review and Overflow

One panel, two tabs. ⌘⇧E and ⌘⇧O work the same way. From the page or the other tab, each shows
its tab and focuses it. Pressed inside its own tab, it closes the panel. Esc goes back to the page
and leaves the panel open. A click on a tab's button shows the tab, or closes the panel when that
tab already shows.

**Review**, top to bottom:

1. **Readability**: the grade, then sentences and reading time. "More" shows letters, characters,
   and paragraphs.
2. **Live checks**: one row per category, with its count and an eye toggle. They update as you
   type. Clicking a row jumps to the next one, like ⌥L.
3. **Ask Claude**: one-shot checks. Weakest sentences, convoluted sentences, off-tone words, hedges
   and filler, typos. Later, Feedback.
4. **Trim**: −10%, −20%, −35%, −50%.

**Overflow**: today's text area, unchanged.

The floating Lab menu goes away. Its contents live in Review. The ⌘K entries stay.

## The page

- **Highlights show only while Review is open.** An open Review tab is Hemingway's Edit mode. A
  closed one is Write mode. There is no separate mode switch.
- Highlights use a background tint. Alternatives keep their underline and dots. Ghosts keep their
  fade. The tints avoid the accent purple, which belongs to alternatives.
- Lab marks and cuts work as today.

## Bars

- **Top**: "171 words · grade 8". A click opens Review. The layers toggle moves to ⌘⇧L and ⌘K only.
- **Bottom**: the left panel's toggle at the left edge, the right panel's at the right edge. Open
  and Save stay at the left, then the toast, then ⌘K.

## Shortcuts

| Keys | Today                     | After                                   |
| ---- | ------------------------- | --------------------------------------- |
| ⌘⇧A  | Alternatives panel        | Here panel                              |
| ⌘⇧G  | AI alternatives           | Unchanged                               |
| ⌘⇧E  | Lab menu                  | Review tab                              |
| ⌘⇧O  | Overflow panel            | Overflow tab                            |
| ⌘⇧L  | Layers                    | Unchanged; no longer on the word count  |

## Narrow windows

Below 760px, both panels already float over the page (`src/styles.css`). Keep that. In a very
narrow window with both open, they overlap. That is fine at that width.

## Live checks

All local, no network. `src/editor/readability.ts` holds the rules and imports nothing, so its
tests run on plain strings. `src/editor/highlights.ts` draws them on the page.

- **Prose**: paragraphs, list items, and quotes. Headings, code, tables, HTML, link addresses, and
  ghosted text are skipped. A sentence never runs from one list item into the next.
- **Sentences**: split after `.`, `!`, and `?`. Not after "Mr.", an initial, "e.g.", a decimal
  point, or a word before a lowercase one. "No." and "fig." are abbreviations only before a number.
- **Grade**: the Automated Readability Index, rounded, never below zero.
- **Hard and very hard**: a sentence of 14 or more words, by its own grade: hard from 10, very hard
  from 14.
- **Adverbs**: -ly words, minus a list of words that only end in -ly (family, only, early).
- **Passive voice**: a form of "be", maybe an -ly word, then a past participle.
- **Qualifiers, intensifiers, fillers**: word and phrase lists. "Rather than" and "what kind of"
  don't count.
- **Simpler words**: a phrase list (utilize → use, in order to → to), with -s, -ed, and -ing forms.

The longer match wins where two overlap, so "due to the fact that" is one simpler phrase, not a
filler inside it. Passive voice may hold other marks. Each paragraph's result is kept, so an edit
checks only the paragraph it changed: on a 20,000-word page the first check takes 16 ms, and each
edit after it 0.4 ms.

The rules are for English.

## Phases

Each phase ends with the tests passing and the change tried in the app.

1. **Layout only** (done, 2026-10-26). Right panel with Review and Overflow tabs. Lab contents
   move into Review. Here keeps today's Alternatives contents. Bars and shortcuts as above. No new
   features.
2. **Checker spike, go or no-go** (skipped, 2026-10-26). The real module was built test-first
   instead, and its speed measured on a long page. See "Live checks".
3. **Live checks** (first slice done, 2026-10-26). The module, its tests, the highlights, the
   Review rows with counts, eyes, and jumps, and "Why it's marked" in Review. Still to do: the
   grade in the top bar, the reason in Here, Hemingway's other weakeners (weak verbs, hidden
   actions, negative phrases), and "More" stats.
4. **Rewrite verbs in Here** (2–3 days). Simplify, Shorter, Polish, Tone, free text. Each result as
   a variant or a version, with undo and redo tests.
5. **Feedback** (1–2 days). After deciding where its text goes.

Phases 4 and 5 don't need the checker, so either can come next.

## Risks

- **Visual noise.** Tints, underlines, dots, ghost fades, and Lab marks on one line. The rule
  "highlights only while Review is open" is the main defense. The spike checks it.
- **Speed.** Splitting sentences on each keystroke in a long document. Decorations must stay
  limited to the viewport.
- **Sentence splitting in Markdown.** Abbreviations, quotes, links, inline code, and list items
  break naive rules. Tests need many real cases.
- **Grade worship.** Hemingway's grade rewards short words and short sentences. Undertext should
  show it, not push it.
- **English only.** Writing in another language gets wrong highlights.

## Decisions taken

- The tab is called Review. "The Lab" is gone from the UI, the README, and the palette. Code names
  such as `src/editor/lab.ts` stay.
- ⌘⇧E works like ⌘⇧O: it shows and focuses its tab, and closes the panel from inside it. Esc goes
  back to the page and leaves the panel open.
- Review and Overflow are two tabs of one panel. Only one shows at a time.
- Lab results stay in the bar under the page for now. Revisit in phase 3.
- A run from Review keeps the panel open and puts the focus on the page, where the results are.
- Live local checks come first: Hemingway's highlights are what Undertext lacks.
- Highlights show only while Review is open. There is no separate Write and Edit switch.
- The grade is the Automated Readability Index, as in open-source Hemingway clones. The target is
  fixed: hard from grade 10.
- The first slice has hard and very hard sentences, five weakeners (adverbs, passive voice,
  qualifiers, intensifiers, fillers), and simpler words. Grammar waits: rules can't do it well.
- Simpler words are green, not Hemingway's purple. Purple is the accent, and it belongs to
  alternatives.
- Ghosted text isn't checked, as it isn't counted.
- "Why it's marked" shows in Review, under the grade, and on hover over the highlight.

## Open decisions

1. **Which side.** macOS apps put the inspector on the right. Undertext has Alternatives on the
   left. Phase 1 kept the left, because it is learned and the right has the page tools.
2. **Rewrites across paragraphs.** An alternative can't span a line break. A selection across
   paragraphs could become one version per paragraph, or be refused.
3. **Where Feedback goes.** A section in Review, a third tab, or text added to Overflow.
4. **"Why it's marked" in Here.** It shows in Review now. Also show it in the Here panel, or not.
5. **The long-sentences check.** Today it is an instant check in Review. Live "hard" and "very
   hard" now cover it. Remove it, or keep it as a one-shot check.
6. **Grammar.** Hemingway's green "writing issues". A Claude run that marks them, like the other
   checks, or nothing.
7. **The grade in the top bar.** The checks run only while Review is open, so the top bar can't
   show a grade with Review closed. Run them always for the grade alone, or leave it in Review.
