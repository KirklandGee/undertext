import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./files";

/** Turns a Markdown link target into a URL the browser can open, or null when it isn't a web or mail link. */
export function linkUrl(target: string): string | null {
  const t = target.trim();
  if (/^(https?:\/\/|mailto:)\S+$/i.test(t)) return t;
  if (/^www\.\S+$/i.test(t)) return `https://${t}`;
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(t)) return `mailto:${t}`;
  return null;
}

/** Opens a link in the default browser or mail app. */
export async function openUrl(target: string): Promise<void> {
  const url = linkUrl(target);
  if (!url) return;
  if (isTauri) await invoke("open_url", { url });
  else window.open(url, "_blank", "noopener,noreferrer");
}
