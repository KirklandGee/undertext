mod ai;
mod claude_code;
mod spelling;

use std::fs;
use std::path::Path;

/// The page can only read and write text documents, never other files on disk.
const DOCUMENT_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

fn document_path(path: &str) -> Result<&Path, String> {
    let target = Path::new(path);
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if DOCUMENT_EXTENSIONS.contains(&ext.as_str()) {
        Ok(target)
    } else {
        Err(format!(
            "Undertext only opens and saves .md, .markdown, and .txt files: {path}"
        ))
    }
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(document_path(&path)?).map_err(|e| format!("Could not read {path}: {e}"))
}

/// The error `write_text` returns when the file no longer holds `expected`.
const CHANGED_ON_DISK: &str = "changed_on_disk";

/// Writes to a temp file next to the target, then renames it, so a crash
/// never leaves a half-written document. With `expected`, it first checks
/// that the file still holds what the page last read or wrote, so a change
/// made in another app is never overwritten without asking. A missing file
/// is written again.
#[tauri::command]
fn write_text(path: String, contents: String, expected: Option<String>) -> Result<(), String> {
    let target = document_path(&path)?;
    if let Some(expected) = expected {
        match fs::read_to_string(target) {
            Ok(current) if current != expected => return Err(CHANGED_ON_DISK.into()),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("Could not read {path}: {e}"))
            }
            _ => {}
        }
    }
    let tmp = target.with_extension("undertext-tmp");
    fs::write(&tmp, contents).map_err(|e| format!("Could not write {path}: {e}"))?;
    fs::rename(&tmp, target).map_err(|e| format!("Could not save {path}: {e}"))
}

/// Only web and mail links, with no spaces or control characters.
fn safe_url(url: &str) -> Result<&str, String> {
    let lower = url.to_lowercase();
    let scheme_ok = ["http://", "https://", "mailto:"]
        .iter()
        .any(|s| lower.starts_with(s));
    if scheme_ok && !url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        Ok(url)
    } else {
        Err(format!("Undertext only opens web and mail links: {url}"))
    }
}

#[cfg(target_os = "macos")]
const OPENER: &str = "/usr/bin/open";
#[cfg(not(target_os = "macos"))]
const OPENER: &str = "xdg-open";

/// Opens a link from the page in the default browser or mail app.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    std::process::Command::new(OPENER)
        .arg(safe_url(&url)?)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open {url}: {e}"))
}

/// What the command line asked for.
/// `undertext notes.md` opens notes.md, or starts it if it isn't there.
/// `--new` starts an empty, untitled page. `--dir <folder>` is where its first save goes.
#[derive(serde::Serialize, Default, PartialEq, Debug)]
struct Startup {
    /// A document as an absolute path, and whether it exists yet.
    document: Option<(String, bool)>,
    new: bool,
    dir: Option<String>,
}

fn absolute(arg: &str) -> Option<String> {
    Some(std::path::absolute(arg).ok()?.to_str()?.to_string())
}

fn parse_startup(args: impl IntoIterator<Item = String>) -> Startup {
    let mut startup = Startup::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--new" => startup.new = true,
            "--dir" => startup.dir = args.next().and_then(|d| absolute(&d)),
            _ if arg.starts_with('-') => {}
            _ if startup.document.is_none() => {
                startup.document = absolute(&arg)
                    .filter(|p| document_path(p).is_ok())
                    .map(|p| {
                        let exists = Path::new(&p).exists();
                        (p, exists)
                    });
            }
            _ => {}
        }
    }
    startup
}

#[tauri::command]
fn startup_options() -> Startup {
    parse_startup(std::env::args().skip(1))
}

/// The page colors for the current Omarchy theme. Omarchy renders
/// `~/.config/omarchy/themed/undertext.css.tpl` into the theme folder on every
/// theme change. None off Omarchy, or before the template is installed.
#[tauri::command]
fn omarchy_theme_css() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    fs::read_to_string(Path::new(&home).join(".local/state/omarchy/current/theme/undertext.css")).ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ai::AiClient::default())
        .invoke_handler(tauri::generate_handler![
            read_text,
            write_text,
            open_url,
            startup_options,
            omarchy_theme_css,
            spelling::check_spelling,
            spelling::spelling_guesses,
            spelling::learn_spelling,
            spelling::learned_spelling,
            spelling::unlearn_spelling,
            ai::ai_key_status,
            ai::ai_set_key,
            ai::ai_clear_key,
            ai::ai_request,
            ai::ai_cancel,
            claude_code::claude_code_status,
            claude_code::claude_code_set_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_text_documents_are_allowed() {
        assert!(document_path("/tmp/notes.md").is_ok());
        assert!(document_path("/tmp/Notes.MARKDOWN").is_ok());
        assert!(document_path("/tmp/draft.txt").is_ok());
        assert!(document_path("/Users/me/.zshrc").is_err());
        assert!(document_path("/Users/me/.ssh/id_ed25519").is_err());
        assert!(document_path("/tmp/notes.md.sh").is_err());
    }

    #[test]
    fn reads_the_command_line() {
        let args = |a: &[&str]| parse_startup(a.iter().map(|s| s.to_string()));

        assert_eq!(args(&[]), Startup::default());
        assert_eq!(
            args(&["--new", "--dir", "/home/me/writings"]),
            Startup { document: None, new: true, dir: Some("/home/me/writings".into()) }
        );
        assert_eq!(
            args(&["/tmp/undertext-missing-note.md"]),
            Startup { document: Some(("/tmp/undertext-missing-note.md".into(), false)), new: false, dir: None }
        );
        // Not a text document: ignored, not opened.
        assert_eq!(args(&["/home/me/.ssh/id_ed25519"]), Startup::default());
        // A relative path becomes absolute.
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            args(&["draft.md"]).document,
            Some((cwd.join("draft.md").to_string_lossy().into_owned(), false))
        );
    }

    #[test]
    fn never_overwrites_a_change_from_another_app() {
        let dir = std::env::temp_dir().join(format!("undertext-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.md");
        let path = file.to_string_lossy().to_string();
        fs::write(&file, "mine").unwrap();

        // Unchanged since the page read it: the save goes through.
        assert!(write_text(path.clone(), "edited".into(), Some("mine".into())).is_ok());
        assert_eq!(fs::read_to_string(&file).unwrap(), "edited");
        // Another app changed it: refused, and the file keeps their text.
        // `src/lib/files.ts` matches this exact error.
        fs::write(&file, "theirs").unwrap();
        assert_eq!(
            write_text(path.clone(), "again".into(), Some("edited".into())),
            Err("changed_on_disk".to_string())
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "theirs");
        // Without `expected` (Keep mine), it overwrites.
        assert!(write_text(path.clone(), "again".into(), None).is_ok());
        assert_eq!(fs::read_to_string(&file).unwrap(), "again");
        // A deleted file is written again.
        fs::remove_file(&file).unwrap();
        assert!(write_text(path, "back".into(), Some("again".into())).is_ok());
        assert_eq!(fs::read_to_string(&file).unwrap(), "back");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_web_and_mail_links_open() {
        assert!(safe_url("https://example.com/a?b=c").is_ok());
        assert!(safe_url("HTTP://example.com").is_ok());
        assert!(safe_url("mailto:me@example.com").is_ok());
        assert!(safe_url("file:///etc/passwd").is_err());
        assert!(safe_url("/Applications/Calculator.app").is_err());
        assert!(safe_url("-a Calculator").is_err());
        assert!(safe_url("https://example.com/a b").is_err());
    }
}
