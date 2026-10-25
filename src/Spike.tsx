import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { countWords } from "./cm/commands";
import { parsePage, serializePage } from "./cm/format";
import { layersOf } from "./cm/layers";
import { SAMPLE } from "./cm/sample";
import { createEditorState } from "./cm/setup";
import { openDocument } from "./lib/files";

// A minimal shell around the CodeMirror editor, to try live preview and the
// layers. Files open read-only: nothing is saved. ⌘⇧M shows the Markdown a
// save would write.

export default function Spike() {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const overflowRef = useRef("");
  const [counts, setCounts] = useState({ words: 0, chars: 0 });
  const [name, setName] = useState("Sample.md");
  const [layersOn, setLayersOn] = useState(true);
  const [source, setSource] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const sourceOpen = useRef(false);

  const markdown = () => {
    const v = viewRef.current!;
    return serializePage({ text: v.state.doc.toString(), ...layersOf(v.state), overflow: overflowRef.current });
  };

  const load = (md: string, fileName: string) => {
    const { text, alts, ghosts, versions, overflow } = parsePage(md);
    overflowRef.current = overflow;
    const v = viewRef.current!;
    v.setState(createEditorState(text, { alts, ghosts, versions }));
    setName(fileName);
    setCounts(countWords(v.state));
    if (sourceOpen.current) setSource(markdown());
    v.focus();
  };

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  };

  useEffect(() => {
    const v = new EditorView({
      parent: mountRef.current!,
      dispatchTransactions(trs, view) {
        view.update(trs);
        if (trs.some((tr) => tr.docChanged || tr.effects.length)) {
          setCounts(countWords(view.state));
          if (sourceOpen.current) setSource(markdown());
        }
      },
    });
    viewRef.current = v;
    if (import.meta.env.DEV) Object.assign(window, { __cm: v });
    load(SAMPLE, "Sample.md");
    return () => {
      viewRef.current = null;
      v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "o" && !e.shiftKey) {
        e.preventDefault();
        void openDocument().then((f) => f && load(f.content, f.name));
      } else if (key === "s") {
        e.preventDefault();
        flash("Saving is off in this test build. ⌘⇧M shows the Markdown.");
      } else if (key === "m" && e.shiftKey) {
        e.preventDefault();
        sourceOpen.current = !sourceOpen.current;
        setSource(sourceOpen.current ? markdown() : null);
      } else if (key === "l" && e.shiftKey) {
        e.preventDefault();
        setLayersOn((on) => !on);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`app${layersOn ? " layers" : ""}`}>
      <header className="topbar" data-tauri-drag-region>
        <span className="quiet count">
          {counts.words} {counts.words === 1 ? "word" : "words"}
          <span className="chars"> · {counts.chars} chars</span>
        </span>
        <span className="filename" data-tauri-drag-region>
          {name.replace(/\.md$/, "")} <span className="dirty">(test build)</span>
        </span>
        <span className="topbar-end" data-tauri-drag-region />
      </header>
      <div className="body">
        <main className="page">
          <div className="column" ref={mountRef} />
        </main>
        {source !== null && (
          <aside className="side side-right spike-source" aria-label="Markdown">
            <header className="side-title">Markdown a save would write</header>
            <pre>{source}</pre>
          </aside>
        )}
      </div>
      <footer className="bottombar">
        <div className="group" />
        <div className="toast" aria-live="polite">
          {toast ?? "⌘O opens a file read-only · ⌘⇧M shows the Markdown · ⌘⇧L layers"}
        </div>
        <div className="group" />
      </footer>
    </div>
  );
}
