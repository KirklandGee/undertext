import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];

export interface OpenedFile {
  path: string | null;
  name: string;
  content: string;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function readDocument(path: string): Promise<OpenedFile> {
  const content = await invoke<string>("read_text", { path });
  return { path, name: basename(path), content };
}

/** Where an untitled page's first save goes, from `--dir` on the command line. */
let saveDir: string | null = null;

export interface Startup {
  /** A document named on the command line, read, or empty if it doesn't exist yet. */
  document: OpenedFile | null;
  /** `--new`: start an empty, untitled page. */
  fresh: boolean;
}

/** `Startup` in src-tauri/src/lib.rs. */
interface RawStartup {
  document: [string, boolean] | null;
  new: boolean;
  dir: string | null;
}

async function readStartup(raw: RawStartup): Promise<Startup> {
  if (raw.dir) saveDir = raw.dir;
  let document: OpenedFile | null = null;
  if (raw.document) {
    const [path, exists] = raw.document;
    document = exists ? await readDocument(path) : { path, name: basename(path), content: "" };
  }
  return { document, fresh: raw.new };
}

/** What the command line asked for at launch. */
export async function startupOptions(): Promise<Startup> {
  if (!isTauri) return { document: null, fresh: false };
  return readStartup(await invoke<RawStartup>("startup_options"));
}

/**
 * Calls `handle` each time the app is launched again while it runs, as `undertext notes.md`.
 * Returns a function that stops listening.
 */
export function onRelaunch(handle: (startup: Startup) => void, fail: (err: unknown) => void): () => void {
  if (!isTauri) return () => {};
  const stop = listen<RawStartup>("startup", (e) => {
    readStartup(e.payload).then(handle, fail);
  });
  return () => void stop.then((unlisten) => unlisten());
}

/** CSS from the current Omarchy theme, or null off Omarchy. */
export async function omarchyThemeCss(): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>("omarchy_theme_css");
}

export async function openDocument(): Promise<OpenedFile | null> {
  if (isTauri) {
    const path = await open({ multiple: false, directory: false, filters: FILTERS });
    return typeof path === "string" ? readDocument(path) : null;
  }
  return browserOpen();
}

/** Thrown when a save finds that another app changed the file. */
export class ChangedOnDisk extends Error {
  constructor() {
    super("The file changed in another app");
  }
}

/**
 * Saves to `path`, or asks for one. In a plain browser it only keeps the
 * session copy. With `expected` (what the file held when the page last read
 * or wrote it), the save is refused with ChangedOnDisk if the file now holds
 * something else.
 */
export async function saveDocument(
  path: string | null,
  name: string,
  content: string,
  expected?: string,
): Promise<{ path: string | null; name: string } | null> {
  if (!isTauri) return { path: null, name };
  const file = name.endsWith(".md") ? name : `${name}.md`;
  const target = path ?? (await save({ defaultPath: saveDir ? `${saveDir}/${file}` : file, filters: FILTERS }));
  if (!target) return null;
  try {
    await invoke("write_text", { path: target, contents: content, expected: path ? expected : undefined });
  } catch (err) {
    throw String(err) === "changed_on_disk" ? new ChangedOnDisk() : err;
  }
  return { path: target, name: basename(target) };
}

/** Asks what to do about a file another app changed. True means load their version. */
export async function askReloadChanged(name: string): Promise<boolean> {
  const message = `“${name}” changed in another app. Load that version, or keep yours and overwrite it?`;
  if (isTauri) return ask(message, { title: "Undertext", kind: "warning", okLabel: "Load theirs", cancelLabel: "Keep mine" });
  return window.confirm(message);
}

export async function confirmDiscard(): Promise<boolean> {
  const message = "This document has unsaved changes. Discard them?";
  if (isTauri) return ask(message, { title: "Undertext", kind: "warning" });
  return window.confirm(message);
}

function browserOpen(): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,text/markdown,text/plain";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { path: null, name: file.name, content: await file.text() } : null);
    };
    input.click();
  });
}
