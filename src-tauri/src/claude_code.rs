//! Calls to Claude through the Claude Code CLI (`claude -p`), so requests run on the
//! person's Claude subscription instead of an API key. Used only when no API key is set
//! and the person chose to use their subscription; a Claude Code login alone is not enough.
//! Undertext never signs anyone in: people sign in to Claude Code themselves, and the
//! app only uses that login once they opt in. Account details stay on the Rust side.

use crate::ai::AiRequest;
use serde::Serialize;
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(180);
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
const NOT_CONNECTED: &str = "no_key: Sign in to Claude Code or add an Anthropic API key first.";
/// Present in the app's config folder once the person chooses to use their subscription.
const CHOICE_FILE: &str = "use-claude-subscription";

fn choice_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(CHOICE_FILE))
}

pub fn enabled(app: &tauri::AppHandle) -> bool {
    choice_file(app).is_some_and(|path| path.is_file())
}

/// Turns the subscription on or off for Undertext. This never signs Claude Code in or out.
#[tauri::command]
pub fn claude_code_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let path = choice_file(&app).ok_or("api: Could not find the app's settings folder.")?;
    let result = if enabled {
        std::fs::create_dir_all(path.parent().expect("config dir"))
            .and_then(|()| std::fs::write(&path, ""))
    } else {
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    };
    result.map_err(|e| format!("api: Could not save the setting ({e})."))
}

/// Apps opened from Finder get a minimal PATH, so look in the usual install places first.
fn claude_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("CLAUDE_PATH") {
        return Some(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut candidates = vec![
        home.join(".local/bin/claude"),
        home.join(".claude/local/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("claude")));
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Settings that would take priority over the subscription login: an API key, or a cloud provider.
const NON_SUBSCRIPTION_ENV: [&str; 5] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];

/// A `claude` command that uses the subscription login, outside any project folder.
fn claude_command(claude: &Path) -> Command {
    let mut command = Command::new(claude);
    for name in NON_SUBSCRIPTION_ENV {
        command.env_remove(name);
    }
    if let Some(path) = child_path(claude) {
        command.env("PATH", path);
    }
    command.current_dir(std::env::temp_dir()).kill_on_drop(true);
    command
}

/// Finder's minimal PATH lacks `node`, which an npm-installed `claude` needs. It usually
/// sits next to `claude`, so that folder goes first.
fn child_path(claude: &Path) -> Option<OsString> {
    let mut dirs: Vec<PathBuf> = claude.parent().map(Path::to_path_buf).into_iter().collect();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.retain(|dir| !dir.as_os_str().is_empty());
    std::env::join_paths(dirs).ok()
}

fn start_error(e: std::io::Error) -> String {
    format!("api: Could not start Claude Code ({e}).")
}

/// Claude Code prints its error message last on stderr.
fn last_line(stderr: &[u8], fallback: &str) -> String {
    String::from_utf8_lossy(stderr)
        .trim()
        .lines()
        .last()
        .unwrap_or(fallback)
        .to_string()
}

#[derive(Serialize, Default)]
pub struct Status {
    installed: bool,
    /// Claude Code is signed in.
    connected: bool,
    /// The person chose to use their subscription in Undertext.
    enabled: bool,
    /// "pro", "max", … when connected with a Claude subscription
    plan: Option<String>,
    /// Why the sign-in check failed, when Claude Code is installed but did not answer.
    error: Option<String>,
}

#[tauri::command]
pub async fn claude_code_status(app: tauri::AppHandle) -> Status {
    let enabled = enabled(&app);
    let Some(claude) = claude_path() else {
        return Status {
            enabled,
            ..Status::default()
        };
    };
    let output = tokio::time::timeout(
        STATUS_TIMEOUT,
        claude_command(&claude)
            .args(["auth", "status", "--json"])
            .output(),
    )
    .await;
    let status = match output {
        Err(_) => Err("Claude Code did not answer.".to_string()),
        Ok(Err(e)) => Err(format!("Could not start Claude Code ({e}).")),
        Ok(Ok(o)) => serde_json::from_slice::<Value>(&o.stdout)
            .map_err(|_| last_line(&o.stderr, "Claude Code could not check the sign-in.")),
    };
    match status {
        Ok(status) => Status {
            installed: true,
            connected: status["loggedIn"] == true,
            enabled,
            plan: status["subscriptionType"].as_str().map(String::from),
            error: None,
        },
        Err(error) => Status {
            installed: true,
            enabled,
            error: Some(error),
            ..Status::default()
        },
    }
}

fn args(request: &AiRequest, model: &str) -> Vec<String> {
    [
        "-p",
        "--output-format",
        "json",
        "--model",
        model,
        "--effort",
        &request.effort,
        "--system-prompt",
        &request.system,
        "--json-schema",
        &request.schema.to_string(),
        // A plain question and answer: no tools, MCP servers, settings, or saved sessions.
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--safe-mode",
        "--no-session-persistence",
    ]
    .map(String::from)
    .to_vec()
}

/// Runs one request. Errors use the same codes as the API path.
pub async fn request(request: &AiRequest, model: &str) -> Result<Value, String> {
    let claude = claude_path().ok_or(NOT_CONNECTED)?;
    let mut child = claude_command(&claude)
        .args(args(request, model))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(start_error)?;

    // The prompt holds the whole document, so it goes through stdin rather than the arguments.
    // It's written while the output is read, under the same timeout, so a Claude Code that
    // stalls or exits before reading it can't block the request.
    let mut stdin = child.stdin.take().expect("piped stdin");
    let write = async move {
        // If Claude Code exits before reading the prompt, the write fails; stderr says why.
        let _ = stdin.write_all(request.prompt.as_bytes()).await;
    };
    let (_, output) = tokio::time::timeout(TIMEOUT, async {
        tokio::join!(write, child.wait_with_output())
    })
    .await
    .map_err(|_| "network: Claude took too long to answer. Try again.".to_string())?;
    let output = output.map_err(|e| format!("api: {e}"))?;

    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(result) => parse_result(&result),
        Err(_) => Err(classify(&last_line(&output.stderr, "Claude Code failed."))),
    }
}

fn classify(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("not logged in") || lower.contains("/login") {
        NOT_CONNECTED.to_string()
    } else if lower.contains("unknown option") {
        format!("api: Update Claude Code (run claude update in a terminal), then try again. ({message})")
    } else if lower.contains("usage limit") || lower.contains("hit your limit") {
        format!("api: You hit your plan's usage limit. ({message})")
    } else if lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("overloaded")
    {
        format!("api: Claude is busy right now. Try again in a moment. ({message})")
    } else {
        format!("api: {message}")
    }
}

fn parse_result(result: &Value) -> Result<Value, String> {
    if result["is_error"] == true || result["subtype"] != "success" {
        return Err(classify(
            result["result"]
                .as_str()
                .unwrap_or("Claude Code reported an error."),
        ));
    }
    if result["stop_reason"] == "refusal" {
        return Err("refused: Claude declined this request.".into());
    }
    match &result["structured_output"] {
        Value::Null => Err("api: Claude's answer did not match the expected format.".into()),
        answer => Ok(answer.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> AiRequest {
        AiRequest {
            system: "sys".into(),
            prompt: "hi".into(),
            schema: json!({"type": "object"}),
            effort: "low".into(),
            max_tokens: 1000,
        }
    }

    #[test]
    fn builds_the_command_line() {
        assert_eq!(
            args(&request(), "claude-opus-5-5"),
            [
                "-p",
                "--output-format",
                "json",
                "--model",
                "claude-opus-5-5",
                "--effort",
                "low",
                "--system-prompt",
                "sys",
                "--json-schema",
                r#"{"type":"object"}"#,
                "--tools",
                "",
                "--strict-mcp-config",
                "--setting-sources",
                "",
                "--safe-mode",
                "--no-session-persistence",
            ]
        );
    }

    #[test]
    fn reads_structured_output() {
        let result = json!({
            "type": "result", "subtype": "success", "is_error": false, "stop_reason": "end_turn",
            "result": "{\"alternatives\":[\"a\",\"b\"]}",
            "structured_output": {"alternatives": ["a", "b"]}
        });
        assert_eq!(parse_result(&result).unwrap()["alternatives"][1], "b");
    }

    #[test]
    fn reports_errors_and_refusals() {
        let not_logged_in = json!({"subtype": "success", "is_error": true, "result": "Not logged in · Please run /login"});
        assert!(parse_result(&not_logged_in)
            .unwrap_err()
            .starts_with("no_key:"));
        let refusal = json!({"subtype": "success", "is_error": false, "stop_reason": "refusal"});
        assert!(parse_result(&refusal).unwrap_err().starts_with("refused:"));
    }

    #[test]
    fn tells_plan_limits_from_rate_limits() {
        assert!(classify("You've hit your limit · resets 5pm").contains("usage limit"));
        assert!(classify("Claude AI usage limit reached|1760000000").contains("usage limit"));
        let rate = classify(r#"API Error: 429 {"error":{"type":"rate_limit_error"}}"#);
        assert!(rate.contains("Try again in a moment") && !rate.contains("usage limit"));
        assert!(
            !classify("input length and max_tokens exceed context limit").contains("usage limit")
        );
        assert!(classify("error: unknown option '--safe-mode'").contains("Update Claude Code"));
    }

    #[test]
    fn runs_claude_with_its_own_folder_on_the_path() {
        let path = child_path(Path::new("/opt/homebrew/opt/node/bin/claude")).unwrap();
        let first = std::env::split_paths(&path).next().unwrap();
        assert_eq!(first, Path::new("/opt/homebrew/opt/node/bin"));
    }

    /// Calls Claude for real on the logged-in subscription. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn answers_through_the_cli() {
        let request = AiRequest {
            schema: json!({
                "type": "object", "additionalProperties": false, "required": ["alternatives"],
                "properties": {"alternatives": {"type": "array", "items": {"type": "string"}}}
            }),
            prompt: "Give 3 alternatives for the word 'struggle'.".into(),
            ..request()
        };
        let answer =
            tauri::async_runtime::block_on(super::request(&request, "claude-opus-5-5")).unwrap();
        assert!(!answer["alternatives"].as_array().unwrap().is_empty());
    }
}
