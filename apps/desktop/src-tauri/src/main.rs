#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Cash Gear Workspace desktop shell. Phase 0 shows the web app's page; the local store,
//! keychain and deep links arrive in Phase 1 as typed commands (ARCHITECTURE.md, Security).

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("the desktop app failed to start");
}
