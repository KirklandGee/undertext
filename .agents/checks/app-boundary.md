# Check: the line between the web view and the Mac

Applies to changes in `src-tauri/`, `src/lib/files.ts`, `src/lib/links.ts`, and `src/ai/client.ts`.
The web view shows text from documents; the Rust side can touch files, the keychain, and other
programs.

## Report

- A new `#[tauri::command]` that takes a path, URL, or program from the web view without checking
  it, the way `document_path` and `safe_url` do in `src-tauri/src/lib.rs`.
- New permissions in `src-tauri/capabilities/default.json`, or a looser `csp` in
  `src-tauri/tauri.conf.json`.
- The API key, or Claude account details such as the email, reaching the web view. They stay in
  `src-tauri/src/ai.rs` and `src-tauri/src/claude_code.rs`.
- A save that can overwrite another app's change without asking: `write_text` must keep its
  `expected` check.
- `claude` run with tools, MCP servers, settings, or saved sessions turned on. See the flags in
  `src-tauri/src/claude_code.rs`.

## Fine

- New commands that only read the app's own state.
- Error messages that name the file the user picked.
