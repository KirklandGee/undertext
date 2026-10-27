import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { EditorSelection, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CHECKS, CheckId, TRIMS, TrimId } from "../ai/tasks";
import {
  cycleAtCaret,
  cycleVersionAtCaret,
  deleteGhosts,
  dropAlt,
  ghostAt,
  hasGhosts,
  jumpToItem,
  reviveAll,
  setAltActive,
  setVersionActive,
  settleAll,
  settleVersion,
  toggleGhost,
  versionedItems,
} from "../editor/commands";
import { inlineText } from "../editor/format";
import { layersOf } from "../editor/layers";
import { setHeading, toggleBold, toggleCode, toggleItalic, toggleLink, toggleList, toggleStrike } from "../editor/keys";
import { EditorInfo } from "../editor/setup";

export interface PaletteCommand {
  id: string;
  title: string;
  group: string;
  shortcut?: string;
  keywords?: string;
  /** Built from the current document, like "Use “pressure”". Not kept in Recent. */
  dynamic?: boolean;
  run(): void;
}

export interface PaletteContext {
  view: Pick<EditorView, "state" | "dispatch">;
  info: EditorInfo;
  layers: boolean;
  overflowOpen: boolean;
  reviewOpen: boolean;
  altOpen: boolean;
  actions: {
    save(saveAs: boolean): void;
    open(): void;
    newDoc(): void;
    welcome(): void;
    toggleLayers(): void;
    setOverflowOpen(open: boolean): void;
    setReviewOpen(open: boolean): void;
    openAlternatives(): void;
    closeAlternatives(): void;
    stash(): void;
    fork(): void;
    aiAlternatives(): void;
    fixTypos(): void;
    findIssues(): void;
    useFix(): void;
    check(id: CheckId): void;
    trim(id: TrimId): void;
    walkLab(): void;
    makeCuts(): void;
    ghostLab(): void;
    clearLab(): void;
    setKey(): void;
    connectSubscription(): void;
  };
}

/** Group order when the query is empty. The most contextual groups come first. */
export const GROUPS = ["Alternatives", "Review", "Paragraph", "Ghost", "Overflow", "Go to", "Format", "View", "Document", "Edit", "Settings"];

const quote = (text: string, max = 36) => `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;

/** Everything you can do right now, given where the caret is. */
export function buildCommands(ctx: PaletteContext): PaletteCommand[] {
  const { view, info, actions } = ctx;
  const { state } = view;
  const sel = state.selection.main;
  const apply = (spec: TransactionSpec | null) => spec && view.dispatch(spec, { scrollIntoView: true });
  const run = (cmd: typeof undo) => cmd({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
  const out: PaletteCommand[] = [];
  const add = (cmd: PaletteCommand) => out.push(cmd);

  // Alternatives for the word or sentence at the caret
  if (info.alt && info.alt.variants.length > 1) {
    const { id, variants, active } = info.alt;
    add({
      id: "alt.show",
      group: "Alternatives",
      title: `Show alternatives for ${quote(variants[active])}`,
      shortcut: "⌘⇧A",
      keywords: "panel variants versions synonyms",
      run: actions.openAlternatives,
    });
    add({ id: "alt.next", group: "Alternatives", title: "Next alternative", shortcut: "⌥J", run: () => apply(cycleAtCaret(view.state, 1)) });
    add({ id: "alt.prev", group: "Alternatives", title: "Previous alternative", shortcut: "⌥K", run: () => apply(cycleAtCaret(view.state, -1)) });
    variants.forEach((v, i) => {
      if (i === active) return;
      add({
        id: `alt.use.${i}`,
        dynamic: true,
        group: "Alternatives",
        title: `Use ${quote(v)}`,
        keywords: i === 0 ? "original" : "variant",
        run: () => apply(setAltActive(view.state, id, i)),
      });
    });
    add({
      id: "alt.keep",
      group: "Alternatives",
      title: `Keep ${quote(variants[active])}, drop the other alternatives`,
      keywords: "accept settle remove clear choose",
      run: () => apply(dropAlt(view.state, id)),
    });
  } else if (info.candidate) {
    add({
      id: "alt.add",
      group: "Alternatives",
      title: `Add alternatives for ${quote(info.candidate.text)}`,
      shortcut: "⌘⇧A",
      keywords: "variants versions synonyms word sentence",
      run: actions.openAlternatives,
    });
  }
  const aiTarget = info.alt ? info.alt.variants[info.alt.active] : info.candidate?.text;
  if (aiTarget) {
    add({
      id: "alt.ai",
      group: "Alternatives",
      title: `Suggest alternatives for ${quote(aiTarget)} with AI`,
      shortcut: "⌘⇧G",
      keywords: "claude ideas synonyms words",
      run: actions.aiAlternatives,
    });
  }

  // Review: results first, then the tools
  if (info.lab?.kind === "cuts") {
    add({ id: "lab.walk", group: "Review", title: "Next proposed cut", shortcut: "⌥L", keywords: "trim walk through review", run: actions.walkLab });
    add({ id: "lab.cut", group: "Review", title: "Make the cuts", keywords: "trim delete apply", run: actions.makeCuts });
    add({ id: "lab.ghostCuts", group: "Review", title: "Keep the proposed cuts as ghosts", keywords: "trim dim later", run: actions.ghostLab });
    add({ id: "lab.discard", group: "Review", title: "Discard the trim (back to the original)", keywords: "cancel undo original", run: actions.clearLab });
  } else if (info.lab?.kind === "marks") {
    add({ id: "lab.next", group: "Review", title: "Next mark", shortcut: "⌥L", keywords: "review walk", run: actions.walkLab });
    add({ id: "lab.ghostMarks", group: "Review", title: "Ghost the marked text", keywords: "dim cut", run: actions.ghostLab });
    add({ id: "lab.clear", group: "Review", title: "Clear the marks", shortcut: "esc", keywords: "remove hide", run: actions.clearLab });
  }
  add({
    id: "lab.open",
    group: "Review",
    title: ctx.reviewOpen ? "Close Review" : "Open Review",
    shortcut: "⌘⇧E",
    keywords: "lab ai claude tools checks trims sidebar panel",
    run: () => actions.setReviewOpen(!ctx.reviewOpen),
  });
  if (info.checks?.fix) {
    add({ id: "lab.useFix", group: "Review", title: `Use the fix: ${quote(info.checks.fix)}`, keywords: "grammar writing issue apply", run: actions.useFix });
  }
  add({ id: "lab.issues", group: "Review", title: "Find writing issues", keywords: "ai grammar style spelling hemingway", run: actions.findIssues });
  add({ id: "lab.typos", group: "Review", title: "Fix punctuation and typos", keywords: "ai spelling proofread grammar", run: actions.fixTypos });
  for (const c of CHECKS) {
    add({ id: `lab.check.${c.id}`, group: "Review", title: c.title, keywords: c.ai ? "ai check review" : "check review", run: () => actions.check(c.id) });
  }
  for (const t of TRIMS) {
    add({
      id: `lab.trim.${t.id}`,
      group: "Review",
      title: `${t.label} (cut about ${t.percent}%)`,
      keywords: "ai trim shorten tighten cut",
      run: () => actions.trim(t.id),
    });
  }

  // Paragraph versions
  if (info.para) {
    const { at, variants, active } = info.para;
    add({
      id: "para.fork",
      group: "Paragraph",
      title: "New version of this paragraph",
      shortcut: "⌘⇧D",
      keywords: "fork duplicate copy rewrite variant",
      run: actions.fork,
    });
    if (variants.length > 1) {
      add({ id: "para.next", group: "Paragraph", title: "Next paragraph version", shortcut: "⌥⇧J", run: () => apply(cycleVersionAtCaret(view.state, 1)) });
      add({ id: "para.prev", group: "Paragraph", title: "Previous paragraph version", shortcut: "⌥⇧K", run: () => apply(cycleVersionAtCaret(view.state, -1)) });
      variants.forEach((v, i) => {
        if (i === active) return;
        add({
          id: `para.use.${i}`,
          dynamic: true,
          group: "Paragraph",
          title: `Switch to version ${i + 1}: ${quote(inlineText(v), 40)}`,
          keywords: i === 0 ? "original" : "variant",
          run: () => apply(setVersionActive(view.state, at, i)),
        });
      });
      add({
        id: "para.keep",
        group: "Paragraph",
        title: "Keep this version, drop the other paragraph versions",
        keywords: "accept settle remove clear choose",
        run: () => apply(settleVersion(view.state, at)),
      });
    }
  }

  // Ghost
  if (!sel.empty) {
    const ghosted = layersOf(state).ghosts.some((g) => g.from < sel.to && g.to > sel.from);
    add({
      id: ghosted ? "ghost.revive" : "ghost.add",
      group: "Ghost",
      title: ghosted ? "Revive the selection" : "Ghost the selection",
      shortcut: "⌘/",
      keywords: "dim fade hide maybe cut",
      run: () => run(toggleGhost),
    });
  } else if (ghostAt(state, sel.from)) {
    add({ id: "ghost.revive", group: "Ghost", title: "Revive this ghosted text", shortcut: "⌘/", keywords: "undim restore show", run: () => run(toggleGhost) });
  }
  if (hasGhosts(state)) {
    add({ id: "ghost.reviveAll", group: "Ghost", title: "Revive all ghosted text", keywords: "undim restore show", run: () => apply(reviveAll(view.state)) });
    add({ id: "ghost.cut", group: "Ghost", title: "Delete all ghosted text", keywords: "make the cuts trim remove", run: () => apply(deleteGhosts(view.state)) });
  }

  // Overflow
  if (!sel.empty) {
    add({ id: "overflow.stash", group: "Overflow", title: "Stash the selection in Overflow", shortcut: "⌘⇧X", keywords: "move keep later", run: actions.stash });
  }
  add({
    id: "overflow.toggle",
    group: "Overflow",
    title: ctx.overflowOpen ? "Close Overflow" : "Open Overflow",
    shortcut: "⌘⇧O",
    keywords: "sidebar panel notes leftovers",
    run: () => actions.setOverflowOpen(!ctx.overflowOpen),
  });

  // Go to
  const items = versionedItems(state);
  if (items.length) {
    add({ id: "goto.next", group: "Go to", title: "Next word or paragraph with versions", shortcut: "⌥L", keywords: "jump navigate", run: () => apply(jumpToItem(view.state, 1, null)?.spec ?? null) });
    add({ id: "goto.prev", group: "Go to", title: "Previous word or paragraph with versions", shortcut: "⌥H", keywords: "jump navigate", run: () => apply(jumpToItem(view.state, -1, null)?.spec ?? null) });
    for (const item of items) {
      const text = state.doc.sliceString(item.from, item.to).replace(/\n/g, " ");
      add({
        id: `goto.${item.from}`,
        dynamic: true,
        group: "Go to",
        title: item.kind === "alt" ? `Go to ${quote(text)}` : `Go to paragraph ${quote(text, 40)}`,
        keywords: "jump navigate",
        run: () => apply({ selection: EditorSelection.cursor(item.from) }),
      });
    }
  }

  // View
  add({ id: "view.layers", group: "View", title: ctx.layers ? "Hide layers" : "Show layers", shortcut: "⌘⇧L", keywords: "underlines dots focus clean", run: actions.toggleLayers });
  add({
    id: "view.alternatives",
    group: "View",
    title: ctx.altOpen ? "Close the Alternatives panel" : "Open the Alternatives panel",
    shortcut: ctx.altOpen ? "esc" : "⌘⇧A",
    keywords: "sidebar panel",
    run: ctx.altOpen ? actions.closeAlternatives : actions.openAlternatives,
  });

  // Document
  add({ id: "doc.new", group: "Document", title: "New document", shortcut: "⌘N", keywords: "file create blank", run: actions.newDoc });
  add({
    id: "doc.welcome",
    group: "Document",
    title: "Open the welcome document",
    keywords: "help guide tutorial intro shortcuts reset start",
    run: actions.welcome,
  });
  add({ id: "doc.open", group: "Document", title: "Open…", shortcut: "⌘O", keywords: "file load", run: actions.open });
  add({ id: "doc.save", group: "Document", title: "Save", shortcut: "⌘S", keywords: "file write", run: () => actions.save(false) });
  add({ id: "doc.saveAs", group: "Document", title: "Save as…", shortcut: "⌘⇧S", keywords: "file write copy", run: () => actions.save(true) });
  if (items.length) {
    add({
      id: "doc.settle",
      group: "Document",
      title: "Accept all current choices",
      keywords: "settle finalize publish clean drop alternatives versions",
      run: () => apply(settleAll(view.state)),
    });
  }

  // Settings
  add({ id: "settings.key", group: "Settings", title: "Set the Anthropic API key…", keywords: "ai claude token keychain", run: actions.setKey });
  add({ id: "settings.subscription", group: "Settings", title: "Use your Claude subscription…", keywords: "ai claude code login account plan pro max", run: actions.connectSubscription });

  // Format
  const format = [
    { id: "bold", title: "Bold", shortcut: "⌘B", cmd: toggleBold },
    { id: "italic", title: "Italic", shortcut: "⌘I", cmd: toggleItalic },
    { id: "code", title: "Inline code", shortcut: "⌘E", cmd: toggleCode },
    { id: "strike", title: "Strikethrough", shortcut: undefined, cmd: toggleStrike },
    { id: "link", title: "Link", shortcut: "⌘⇧K", cmd: toggleLink },
    { id: "h1", title: "Heading 1", shortcut: "⌥⌘1", cmd: setHeading(1) },
    { id: "h2", title: "Heading 2", shortcut: "⌥⌘2", cmd: setHeading(2) },
    { id: "h3", title: "Heading 3", shortcut: "⌥⌘3", cmd: setHeading(3) },
    { id: "plain", title: "Plain paragraph (no heading or list)", shortcut: "⌥⌘0", cmd: setHeading(0) },
    { id: "bullets", title: "Bulleted list", shortcut: "⌘⇧8", cmd: toggleList("bullet") },
    { id: "numbers", title: "Numbered list", shortcut: "⌘⇧7", cmd: toggleList("ordered") },
    { id: "tasks", title: "Task list", shortcut: "⌘⇧9", cmd: toggleList("task") },
  ];
  for (const f of format) {
    add({ id: `format.${f.id}`, group: "Format", title: f.title, shortcut: f.shortcut, keywords: "markdown style", run: () => run(f.cmd) });
  }

  // Edit
  if (undoDepth(state) > 0) add({ id: "edit.undo", group: "Edit", title: "Undo", shortcut: "⌘Z", run: () => run(undo) });
  if (redoDepth(state) > 0) add({ id: "edit.redo", group: "Edit", title: "Redo", shortcut: "⌘⇧Z", run: () => run(redo) });

  return out;
}
