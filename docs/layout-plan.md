# Plan: side panels with one job each, and room for Hemingway's checks

Status: proposal, 2026-10-26. Nothing is built. See "Open decisions" at the end.

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
  - Weakeners (blue): adverbs, passive voice, qualifiers.
  - Simpler words (purple): a word with a plainer synonym.
  - Grammar and spelling (green), Plus only.
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

One panel, two tabs. ⌘⇧E opens Review, and pressed again closes it, as it does the Lab today. ⌘⇧O
opens Overflow and keeps today's behavior: open and focus, then close from inside.

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

All local, no network. A new module beside `src/editor/format.ts`, with no editor code, so it can
be tested on plain strings.

- **Sentences**: split the page's paragraphs into sentences. Skip headings, code, and list markers.
  Handle "e.g.", "Mr.", decimals, and quotes.
- **Grade**: a published formula on words, sentences, and letters or syllables.
- **Hard and very hard**: a sentence's own grade against the target.
- **Adverbs**: -ly words, minus a stop list (only, family, reply).
- **Passive voice**: a form of "be" followed by a past participle.
- **Qualifiers**: a word list. Today's "hedges and filler" check has a start.
- **Simpler words**: a phrase list (utilize → use, in order to → to).

The rules are for English. The checks run on visible lines first, like the live preview, and on the
whole page after a pause for the counts.

## Phases

Each phase ends with the tests passing and the change tried in the app.

1. **Layout only** (1–2 days). Right panel with Review and Overflow tabs. Lab contents move into
   Review. Here keeps today's Alternatives contents. Bars and shortcuts as above. No new features.
2. **Checker spike, go or no-go** (1–2 days, thrown away after). Sentence splitting and the grade on
   a long real document. Measure a keystroke's cost in the app. Check how tints look under
   alternatives and ghosts. If it is slow or noisy, stop and rethink before phase 3.
3. **Live checks** (4–6 days). The module, its tests, the decorations, the Review rows, and "Why
   it's marked".
4. **Rewrite verbs in Here** (2–3 days). Simplify, Shorter, Polish, Tone, free text. Each result as
   a variant or a version, with undo and redo tests.
5. **Feedback** (1–2 days). After deciding where its text goes.

Phase 1 stands on its own. Phases 3 to 5 wait for phase 2.

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

## Open decisions

1. **Which half of Hemingway.** Live local checks, more AI rewrites, or both. Phase 1 is useful
   either way. Phases 2 and 3 matter only for live checks.
2. **Edit mode.** Highlights only while Review is open, or a separate Write and Edit switch.
3. **Lab results.** Keep the bar under the page, or show results in Review. The bar works with the
   panel closed. Review keeps everything in one place.
4. **Overflow as a tab.** With tabs, Review and Overflow can't show at once. The other choice is
   a third panel, or Overflow under Review in one column.
5. **Which side.** macOS apps put the inspector on the right. Undertext has Alternatives on the
   left. This plan keeps the left, because it is learned and the right has the page tools.
6. **Grade formula.** Automated Readability Index (letters, no syllables) or Flesch-Kincaid
   (syllables, harder in code). Hemingway doesn't say which it uses. Also: a target setting, or a
   fixed grade 9.
7. **Rewrites across paragraphs.** An alternative can't span a line break. A selection across
   paragraphs could become one version per paragraph, or be refused.
8. **Where Feedback goes.** A section in Review, a third tab, or text added to Overflow.
9. **"Why it's marked".** In the Here panel only, or also on hover over the highlight.
10. **The long-sentences check.** Today it is an instant Lab check. Live "hard" and "very hard"
    would replace it. Remove it, or keep it as a one-shot check.
