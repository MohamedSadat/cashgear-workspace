//! The test-only bridge (cargo feature `e2e-bridge`, off by default): how the macOS acceptance run
//! (scripts/macos-acceptance.mjs) drives the installed app, since WKWebView has no debugging port
//! for Playwright the way WebView2 has. It is compiled into test builds only. Release builds set
//! `CGW_RELEASE_BUILD`, which build.rs refuses together with this feature, and the release checks
//! look for this module's names in the binary (scripts/macos-verify.mjs).
//!
//! Started with `CGW_E2E_BRIDGE_PORT` (a port) and `CGW_E2E_BRIDGE_TOKEN` (32 characters or
//! more), the app listens on 127.0.0.1 at that port, and nowhere else, for one JSON object a line,
//! each carrying the token:
//!
//! - `{"id":1,"token":"…","cmd":"eval","script":"async (a) => …","args":[…],"timeoutMs":30000}`
//!   runs the function in the main window with those arguments and answers with what it returned,
//!   as JSON (the page answers through [`e2e_bridge_reply`], a command only this build has);
//! - `{"id":2,"token":"…","cmd":"title"}` answers with the window's title;
//! - `{"id":3,"token":"…","cmd":"quit"}` answers, then closes the window as its close button
//!   does (the page writes pending saves first), which ends the app;
//! - `{"id":4,"token":"…","cmd":"menu","item":"quit"}` answers, then does what the app menu's
//!   Quit (⌘Q on macOS) does, through the same handler, for a runner that cannot press keys.
//!
//! Each answer is one line, `{"id":1,"ok":true,"value":…}` or `{"id":1,"ok":false,"error":"…"}`.
//! Anything else is refused.
//!
//! A start by LaunchServices (`open`, a deep link to an app that is not running, the restart after
//! an update) passes no environment on, so the settings can also come from
//! `cgw-e2e-settings.json` in the folder that holds the app bundle: the variables it names, from a
//! fixed list, as if they had been set. Variables that are set win.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

/// The port to listen on.
pub const PORT: &str = "CGW_E2E_BRIDGE_PORT";
/// What every request must carry.
pub const TOKEN: &str = "CGW_E2E_BRIDGE_TOKEN";
/// The settings file beside the app bundle.
pub const SETTINGS_FILE: &str = "cgw-e2e-settings.json";
/// What the settings file may set: the bridge's own two, and the test settings the app reads.
const SETTINGS: [&str; 6] = [
    PORT,
    TOKEN,
    "CGW_DATA_DIR",
    "CGW_SAVE_DIR",
    "CGW_AUTH_URL_FILE",
    "CGW_KEYCHAIN_SERVICE",
];
const MIN_TOKEN: usize = 32;
const LINE_LIMIT: u64 = 4 * 1024 * 1024;
const DEFAULT_WAIT: Duration = Duration::from_secs(30);
const LONGEST_WAIT: Duration = Duration::from_secs(300);
/// After an update the version before may hold the port for a moment.
const BIND_FOR: Duration = Duration::from_secs(20);

/// The `eval`s waiting for the page's answer.
#[derive(Default)]
pub struct Bridge {
    next: AtomicU64,
    replies: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
}

impl Bridge {
    fn replies(&self) -> std::sync::MutexGuard<'_, HashMap<u64, mpsc::Sender<Value>>> {
        self.replies
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The folder that holds the app: the bundle's parent inside a macOS bundle
/// (`Name.app/Contents/MacOS/exe`), else the executable's own folder.
fn holder(exe: &Path) -> Option<&Path> {
    let dir = exe.parent()?;
    let contents = dir.parent()?;
    if dir.file_name()? == "MacOS" && contents.file_name()? == "Contents" {
        contents.parent()?.parent()
    } else {
        Some(dir)
    }
}

/// The settings a start by LaunchServices did not pass, from the settings file; before anything
/// reads them, so first in `main`, while the app has one thread.
pub fn load_settings() {
    if std::env::var_os(PORT).is_some() {
        return;
    }
    let Some(file) = std::env::current_exe()
        .ok()
        .and_then(|exe| holder(&exe).map(|dir| dir.join(SETTINGS_FILE)))
    else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(&file) else {
        return;
    };
    let Ok(Value::Object(settings)) = serde_json::from_str::<Value>(&text) else {
        eprintln!("e2e bridge: {} is not a JSON object", file.display());
        return;
    };
    for name in SETTINGS {
        if let (None, Some(Value::String(value))) = (std::env::var_os(name), settings.get(name)) {
            std::env::set_var(name, value);
        }
    }
}

/// Listens when the settings ask for it, on a thread of its own.
pub fn start(app: &AppHandle) {
    app.manage(Bridge::default());
    let Some(port) = std::env::var_os(PORT) else {
        return;
    };
    let Some(port) = port
        .to_str()
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port != 0)
    else {
        eprintln!("e2e bridge: {PORT} is not a port");
        return;
    };
    let Some(token) = std::env::var(TOKEN)
        .ok()
        .filter(|token| token.len() >= MIN_TOKEN)
    else {
        eprintln!("e2e bridge: {TOKEN} must be {MIN_TOKEN} characters or more");
        return;
    };
    let app = app.clone();
    let started = std::thread::Builder::new()
        .name("e2e-bridge".into())
        .spawn(move || listen(app, port, token));
    if let Err(error) = started {
        eprintln!("e2e bridge: no thread: {error}");
    }
}

fn listen(app: AppHandle, port: u16, token: String) {
    let until = Instant::now() + BIND_FOR;
    let listener = loop {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            Ok(listener) => break listener,
            Err(_) if Instant::now() < until => std::thread::sleep(Duration::from_millis(200)),
            Err(error) => {
                eprintln!("e2e bridge: cannot listen on 127.0.0.1:{port}: {error}");
                return;
            }
        }
    };
    eprintln!("e2e bridge: listening on 127.0.0.1:{port}");
    for stream in listener.incoming().flatten() {
        if !stream.peer_addr().is_ok_and(|peer| peer.ip().is_loopback()) {
            continue;
        }
        let (app, token) = (app.clone(), token.clone());
        let _ = std::thread::Builder::new()
            .name("e2e-bridge-client".into())
            .spawn(move || serve(&app, stream, &token));
    }
}

/// One connection: a request a line, an answer a line, in order.
fn serve(app: &AppHandle, stream: TcpStream, token: &str) {
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = Vec::new();
        match (&mut reader).take(LINE_LIMIT).read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if line.last() != Some(&b'\n') {
            let _ = writeln!(writer, "{}", refused(Value::Null, "The line is too long."));
            return;
        }
        let (answer, then) = handle(app, &line, token);
        if writeln!(writer, "{answer}")
            .and_then(|()| writer.flush())
            .is_err()
        {
            return;
        }
        match then {
            Then::Answer => {}
            Then::Close => return crate::close_main_window(app),
            Then::Menu(id) => {
                crate::on_menu(app, id);
                return;
            }
        }
    }
}

fn refused(id: Value, error: &str) -> Value {
    json!({ "id": id, "ok": false, "error": error })
}

/// The same bytes, compared in time that does not depend on where they differ.
fn same(given: &str, token: &str) -> bool {
    given.len() == token.len()
        && given
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

/// What follows an answer.
enum Then {
    Answer,
    /// Close the window as its close button does.
    Close,
    /// Do what this menu item does.
    Menu(&'static str),
}

/// A request's answer, and what follows once it is sent.
fn handle(app: &AppHandle, line: &[u8], token: &str) -> (Value, Then) {
    let Ok(request) = serde_json::from_slice::<Value>(line) else {
        return (refused(Value::Null, "The line is not JSON."), Then::Answer);
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if !request
        .get("token")
        .and_then(Value::as_str)
        .is_some_and(|given| same(given, token))
    {
        return (refused(id, "The token is wrong."), Then::Answer);
    }
    let result = match request.get("cmd").and_then(Value::as_str) {
        Some("eval") => eval(app, &request),
        Some("title") => app
            .get_webview_window("main")
            .ok_or_else(|| "The main window is gone.".to_owned())
            .and_then(|window| window.title().map_err(|error| error.to_string()))
            .map(Value::String),
        Some("quit") => return (json!({ "id": id, "ok": true, "value": null }), Then::Close),
        Some("menu") => match request.get("item").and_then(Value::as_str) {
            Some("quit") => {
                let done = json!({ "id": id, "ok": true, "value": null });
                return (done, Then::Menu(crate::QUIT_MENU_ID));
            }
            _ => Err("The menu item is not one the bridge runs (quit).".to_owned()),
        },
        _ => Err("The bridge takes eval, title, quit and menu only.".to_owned()),
    };
    match result {
        Ok(value) => (
            json!({ "id": id, "ok": true, "value": value }),
            Then::Answer,
        ),
        Err(error) => (refused(id, &error), Then::Answer),
    }
}

/// The script the window runs: the function, awaited with its arguments, its result sent back. A
/// command's failure is an object (`{ code, message }`), not an Error, and goes back as JSON.
fn wrap(id: u64, script: &str, args: &Value) -> String {
    format!(
        r#"(async () => {{
  let reply;
  try {{
    const value = await ({script}
    )(...{args});
    reply = JSON.stringify({{ ok: true, value: value === undefined ? null : value }});
  }} catch (error) {{
    const text = error instanceof Error ? error.stack || String(error)
      : typeof error === 'string' ? error : JSON.stringify(error);
    reply = JSON.stringify({{ ok: false, error: text }});
  }}
  await window.__TAURI_INTERNALS__.invoke('e2e_bridge_reply', {{ id: {id}, reply }});
}})();"#
    )
}

fn eval(app: &AppHandle, request: &Value) -> Result<Value, String> {
    let script = request
        .get("script")
        .and_then(Value::as_str)
        .ok_or("An eval takes a script.")?;
    let args = match request.get("args") {
        None | Some(Value::Null) => Value::Array(Vec::new()),
        Some(args @ Value::Array(_)) => args.clone(),
        Some(_) => return Err("args is not a list.".into()),
    };
    let wait = request
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_WAIT, Duration::from_millis)
        .min(LONGEST_WAIT);
    let window = app
        .get_webview_window("main")
        .ok_or("The main window is gone.")?;
    let bridge = app.state::<Bridge>();
    let id = bridge.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = mpsc::channel();
    bridge.replies().insert(id, sender);
    let reply = window
        .eval(wrap(id, script, &args))
        .map_err(|error| error.to_string())
        .and_then(|()| {
            receiver
                .recv_timeout(wait)
                .map_err(|_| format!("The page did not answer in {} ms.", wait.as_millis()))
        });
    bridge.replies().remove(&id);
    let reply = reply?;
    if reply.get("ok") == Some(&Value::Bool(true)) {
        Ok(reply.get("value").cloned().unwrap_or(Value::Null))
    } else {
        Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The script failed.")
            .to_owned())
    }
}

/// The page's answer to an `eval` (the script [`wrap`] makes calls it). Only this build has it.
#[tauri::command]
pub fn e2e_bridge_reply(bridge: State<'_, Bridge>, id: u64, reply: String) -> Result<(), String> {
    let reply: Value = serde_json::from_str(&reply).map_err(|error| error.to_string())?;
    if let Some(sender) = bridge.replies().remove(&id) {
        let _ = sender.send(reply);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_folder_that_holds_the_app() {
        let exe = Path::new("/Users/me/Apps/Cash Gear Workspace.app/Contents/MacOS/cgw-desktop");
        assert_eq!(holder(exe), Some(Path::new("/Users/me/Apps")));
        let exe = Path::new("/work/target/release/cgw-desktop");
        assert_eq!(holder(exe), Some(Path::new("/work/target/release")));
    }

    #[test]
    fn compares_tokens_whole() {
        let token = "a".repeat(MIN_TOKEN);
        assert!(same(&token, &token));
        assert!(!same(&token[1..], &token));
        assert!(!same(&format!("{token}a"), &token));
        assert!(!same(&"b".repeat(MIN_TOKEN), &token));
    }

    #[test]
    fn wraps_a_function_and_its_arguments() {
        let script = wrap(7, "(a, b) => a + b // a comment", &json!([1, "x\u{2028}"]));
        assert!(script.contains(
            "const value = await ((a, b) => a + b // a comment\n    )(...[1,\"x\u{2028}\"]);"
        ));
        assert!(script.contains("invoke('e2e_bridge_reply', { id: 7, reply })"));
    }

    #[test]
    fn the_settings_file_sets_only_its_own_variables() {
        assert!(SETTINGS.iter().all(|name| name.starts_with("CGW_")));
        assert!(!SETTINGS.contains(&"PATH"));
    }
}
