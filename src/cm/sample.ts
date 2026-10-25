/** The test document for the CodeMirror build: every kind of Markdown and every layer. */
export const SAMPLE = `# Live preview test

This build runs on CodeMirror. Move the cursor around: Markdown renders in place, and its syntax shows when the cursor touches it. **Bold**, *italic*, ~~strikethrough~~, \`inline code\`, and a [link](https://example.com) all work.

## Layers still work

Much of the {{tension|pressure|>struggle}} comes from here. Put the cursor in it and press ⌥J or ⌥K, then ⌘Z. When you swap in a word that starts with a vowel, like an {{owl|apple|>elephant|bear}}, the article fixes itself. ⌥L and ⌥H jump between them.

Not sure a sentence belongs? Select it and press ⌘/ to ghost it. {-It stays here, faint, so you can read the paragraph without it.-} Put the cursor inside it and press ⌘/ again to revive it.

:::alt
Paragraphs can have versions too. This is the first one.
:::or*
This paragraph has two versions. Press ⌥⇧J or ⌥⇧K to switch between them, then ⌘Z to undo.
:::

## Lists

- A bullet item. Long items wrap, and the wrapped lines start under the text, not under the bullet. Make the window narrow to see it.
- Press Enter at the end of an item to start the next one. Enter on an empty item ends the list.
  - Nested items work too.

1. Numbered items keep their numbers.
2. Add one in the middle and the rest renumber.

- [ ] A task. Click the box.
- [x] A done task.

> A quote. The marker hides when the cursor is elsewhere.
> It can run over several lines.

\`\`\`
Code blocks show as code. {{Layers|are}} not read in here.
\`\`\`

---

Escapes like \\*this\\* show without the backslash. Formatting keys: ⌘B bold, ⌘I italic, ⌘E code, ⌘⇧K link. Paste a URL over selected text to make it a link.

Try the keyboard: arrow keys through **bold text**, up and down across lines, Backspace at the start of a paragraph, and accents typed with dead keys, like é and ñ.

<!-- overflow -->

Overflow text lives here. This build doesn't show it on the page.
`;
