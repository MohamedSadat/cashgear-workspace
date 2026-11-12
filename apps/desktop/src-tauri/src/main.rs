#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Cash Gear Workspace desktop shell. The webview reaches native code through typed commands
//! only (ARCHITECTURE.md, Security): the local store takes one of a fixed set of requests in a
//! binary frame, never SQL; saving a file opens the native dialog here, so no command takes a path
//! from the page. A deep link (`cashgear-workspace://p/{pageId}`) can only choose one of the app's
//! routes (crates/cgw-native). Signing in to the Workspace API happens here too (auth.rs): the
//! refresh token stays on this side, in the OS keychain, and the page only gets access tokens.

mod auth;
// Test builds only (`--features e2e-bridge`): never in a release (build.rs).
#[cfg(feature = "e2e-bridge")]
mod bridge;
mod updates;

use std::path::PathBuf;
use std::sync::Mutex;

use cgw_store::Store;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
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

/// The id of the app menu's Quit on macOS (⌘Q).
pub(crate) const QUIT_MENU_ID: &str = "cgw-quit";

/// Closes the main window as its close button does: the page writes its pending saves first
/// (`onCloseRequested`), then the app ends with its last window. Without a window there is
/// nothing left to save.
pub(crate) fn close_main_window<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window("main") {
        Some(window) => {
            if window.close().is_err() {
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}

/// Tauri's default macOS menu, with the app menu's Quit (⌘Q) replaced by an item that closes the
/// window as its close button does. The default Quit ends the app at once (`terminate:`, and tao
/// has no `applicationShouldTerminate`), which skipped the page's pending saves. Quitting from the
/// Dock, logging out and shutting down still end the app at once, a known limit: they can lose
/// what the page had not yet written (its autosave runs 150 ms after typing stops).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn menu_with_saving_quit<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    // On macOS the first submenu is the app's own, and Quit is its last item.
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        if let Some(MenuItemKind::Predefined(quit)) = app_menu.items()?.last() {
            let text = quit.text()?;
            app_menu.remove(quit)?;
            app_menu.append(&MenuItem::with_id(
                app,
                QUIT_MENU_ID,
                text,
                true,
                Some("CmdOrCtrl+Q"),
            )?)?;
        }
    }
    Ok(menu)
}

/// What a menu item does: only Quit is the app's own.
pub(crate) fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    if id == QUIT_MENU_ID {
        close_main_window(app);
        return true;
    }
    false
}

fn main() {
    // A test build started by LaunchServices reads its test settings first (bridge.rs).
    #[cfg(feature = "e2e-bridge")]
    bridge::load_settings();
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
    // macOS has an app menu; its Quit writes pending saves before the app ends.
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(menu_with_saving_quit);
    }
    builder
        .on_menu_event(|app, event| {
            on_menu(app, event.id().as_ref());
        })
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
            // Windows' installer registers the scheme, and a link the app was started with is on
            // its command line. On macOS the bundle's Info.plist registers it, and links come as
            // the system's URL events, to a cold start too, just after this.
            let handle = app.handle().clone();
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                open_links(&handle, urls.into_iter().map(|url| url.to_string()));
            }
            app.deep_link().on_open_url(move |event| {
                open_links(&handle, event.urls().into_iter().map(|url| url.to_string()));
            });
            #[cfg(feature = "e2e-bridge")]
            bridge::start(app.handle());
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
            auth::auth_sign_out,
            #[cfg(feature = "e2e-bridge")]
            bridge::e2e_bridge_reply
        ])
        .run(tauri::generate_context!())
        .expect("the desktop app failed to start");
}

#[cfg(test)]
mod tests {
    /// macOS lays its bundle settings (tauri.macos.conf.json) over tauri.conf.json, and nothing
    /// else: both platforms run under the one CSP and open the same links.
    #[test]
    fn the_macos_settings_change_only_the_bundle() {
        let macos: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.macos.conf.json")).unwrap();
        let keys: Vec<&str> = macos
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .filter(|key| *key != "$schema")
            .collect();
        assert_eq!(keys, ["bundle"]);
        assert_eq!(macos["bundle"]["macOS"]["signingIdentity"], "-");
        assert!(macos["bundle"]["icon"]
            .as_array()
            .unwrap()
            .iter()
            .any(|icon| icon.as_str().unwrap().ends_with(".icns")));
        let base: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            base["plugins"]["deep-link"]["desktop"]["schemes"],
            serde_json::json!([cgw_native::SCHEME])
        );
    }
}
