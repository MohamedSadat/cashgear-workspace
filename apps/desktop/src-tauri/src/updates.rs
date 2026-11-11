//! Updates from the release feed (`plugins.updater` in tauri.conf.json), as Sheet does: the page
//! asks whether a newer version is out, then has it downloaded, checked against the updater's
//! public key and installed. On Windows the installer closes the app and starts the new version.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// The newer version the feed offers, if any.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| UpdateInfo {
        version: update.version,
        notes: update.body,
    }))
}

/// Downloads and installs the newer version, reporting `update-progress` events (bytes so far,
/// and the total when known). The installer then takes over.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or("No update is waiting.")?;
    let mut received = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                received += chunk as u64;
                let _ = app.emit("update-progress", (received, total));
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    // Windows exits for the installer before this; elsewhere the new files are in place.
    app.restart();
}
