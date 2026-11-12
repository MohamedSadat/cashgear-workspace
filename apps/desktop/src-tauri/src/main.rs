#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Cash Gear Workspace desktop shell. The webview reaches native code through typed commands
//! only (ARCHITECTURE.md, Security): the local store takes one of a fixed set of requests in a
//! binary frame, never SQL; saving a file opens the native dialog here, so no command takes a path
//! from the page. A deep link (`cashgear-workspace://p/{pageId}`) can only choose one of the app's
//! routes (crates/cgw-native). Signing in to the Workspace API happens here too (auth.rs): the
//! refresh token stays on this side, in the OS keychain, and the page only gets access tokens.

mod auth;
mod updates;

use std::path::PathBuf;
use std::sync::Mutex;

use cgw_store::Store;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

struct LocalStore(Mutex<Store>);

/// A route from a deep link that came before the page was listening, and whether it listens now.
#[derive(Default)]
struct DeepLinks(Mutex<(Option<String>, bool)>);

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
        .map(cgw_native::file_name)
        .unwrap_or_else(|| "export.zip".into());
    // The end-to-end tests set CGW_SAVE_DIR, as they set CGW_DATA_DIR: files go there under the
    // safe name, with no dialog to answer.
    if let Some(dir) = std::env::var_os("CGW_SAVE_DIR") {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        std::fs::write(dir.join(&name), bytes).map_err(|error| error.to_string())?;
        return Ok(true);
    }
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

/// The route a deep link asked for before the page listened, once; from now on links come as
/// `deep-link` events.
#[tauri::command]
fn take_deep_link(links: State<'_, DeepLinks>) -> Option<String> {
    let mut links = links.0.lock().ok()?;
    links.1 = true;
    links.0.take()
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
}

/// The app's version from its bundle settings, which the updater compares.
#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
    }
}

/// Brings the window forward and hands the last link that names a route to the page.
fn open_links(app: &AppHandle, urls: impl IntoIterator<Item = String>) {
    let Some(route) = urls
        .into_iter()
        .filter_map(|url| cgw_native::route(&url))
        .last()
    else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let state = app.state::<DeepLinks>();
    let Ok(mut links) = state.0.lock() else {
        return;
    };
    if links.1 {
        let _ = app.emit("deep-link", route);
    } else {
        links.0 = Some(route);
    }
}

fn main() {
    let mut builder = tauri::Builder::default();
    // One app per data folder, since one process owns the store: starting it again (a deep link
    // clicked while it runs) brings this window forward, and the link comes to this instance.
    // Tests give each run a data folder of its own and may run beside an installed app.
    if std::env::var_os("CGW_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(DeepLinks::default())
        .manage(auth::Auth::from_env())
        .setup(|app| {
            let dir = data_dir(app.handle())?;
            let store = Store::open(&dir).map_err(|error| error.to_string())?;
            app.manage(LocalStore(Mutex::new(store)));
            // The installer registers the scheme; a link the app was started with comes first.
            let handle = app.handle().clone();
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                open_links(&handle, urls.into_iter().map(|url| url.to_string()));
            }
            app.deep_link().on_open_url(move |event| {
                open_links(&handle, event.urls().into_iter().map(|url| url.to_string()));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            store,
            save_file,
            take_deep_link,
            app_info,
            updates::update_check,
            updates::update_install,
            auth::auth_sign_in,
            auth::auth_token,
            auth::auth_sign_out
        ])
        .run(tauri::generate_context!())
        .expect("the desktop app failed to start");
}
