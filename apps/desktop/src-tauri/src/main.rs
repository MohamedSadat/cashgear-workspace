#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Cash Gear Workspace desktop shell. The webview reaches native code through typed commands
//! only (ARCHITECTURE.md, Security): the local store takes one of a fixed set of requests in a
//! binary frame, never SQL; saving a file opens the native dialog here, so no command takes a path
//! from the page.

use std::path::PathBuf;
use std::sync::Mutex;

use cgw_store::Store;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

struct LocalStore(Mutex<Store>);

/// Where the store lives: the app's data folder, or `CGW_DATA_DIR` (set by the end-to-end tests,
/// read once at start).
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("CGW_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    app.path().app_data_dir().map_err(|error| error.to_string())
}

/// One store request: a frame in, a frame out (crates/cgw-store). Bytes stay bytes.
#[tauri::command]
fn store(request: Request<'_>, store: State<'_, LocalStore>) -> Result<Response, String> {
    let InvokeBody::Raw(frame) = request.body() else {
        return Err("The store takes a binary frame.".into());
    };
    let mut store = store.0.lock().map_err(|error| error.to_string())?;
    Ok(Response::new(store.handle(frame)))
}

/// Saves bytes to a file the user picks in the system's dialog. The page sends the bytes and a
/// suggested name in the headers; it never sends a path.
#[tauri::command]
async fn save_file(app: AppHandle, request: Request<'_>) -> Result<bool, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Save takes the file's bytes.".into());
    };
    let bytes = bytes.clone();
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| "export.zip".into());
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(&name)
        .save_file(move |chosen| {
            let _ = sender.send(chosen);
        });
    let chosen = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
        .await
        .map_err(|error| error.to_string())?;
    let Some(path) = chosen.and_then(|chosen| chosen.into_path().ok()) else {
        return Ok(false);
    };
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(true)
}

/// Header values are ASCII; the page sends the name percent-encoded.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    let decoded = String::from_utf8_lossy(&out).into_owned();
    // A file name only: no folders, no characters Windows refuses.
    decoded
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = data_dir(app.handle())?;
            let store = Store::open(&dir).map_err(|error| error.to_string())?;
            app.manage(LocalStore(Mutex::new(store)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![store, save_file])
        .run(tauri::generate_context!())
        .expect("the desktop app failed to start");
}
