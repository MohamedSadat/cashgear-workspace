//! Cash Gear Sheet's desktop app (Track S6; INTEGRATIONS.md, "Opening Sheet's desktop app"): the
//! commands behind `WorkspacePlatform.sheetApp` (apps/web/src/platform/desktop.ts). Whether the
//! system has something that opens `cashgear-sheet` links, and a Workspace launch link handed to
//! it, read and rebuilt by crates/cgw-native first, so the page can hand the system no other link
//! through this. The link is neither logged nor kept.

use std::path::{Path, PathBuf};

use tauri::State;

pub struct SheetApp {
    /// Tests only: `CGW_SHEET_APP=installed|missing`, read once at start as `CGW_DATA_DIR` is,
    /// answers "is Sheet's app installed" without asking the system.
    installed: Option<bool>,
    /// Tests only: `CGW_OPEN_URL_FILE`, read once at start as `CGW_AUTH_URL_FILE` is. When it is
    /// set, the launch link is written to that file instead of being handed to the system, and the
    /// end-to-end test redeems its ticket itself. Only a test's own environment sets it: the ticket
    /// it writes is one use and two minutes.
    url_file: Option<PathBuf>,
}

impl SheetApp {
    pub fn from_env() -> Self {
        Self {
            installed: installed_from(std::env::var("CGW_SHEET_APP").ok().as_deref()),
            url_file: std::env::var_os("CGW_OPEN_URL_FILE").map(PathBuf::from),
        }
    }
}

/// `installed` or `missing` from the tests; anything else asks the system.
fn installed_from(value: Option<&str>) -> Option<bool> {
    match value {
        Some("installed") => Some(true),
        Some("missing") => Some(false),
        _ => None,
    }
}

/// Writes the link for a test, whole or not at all (a test may be polling the file).
fn write_link(file: &Path, link: &str) -> Result<(), String> {
    let partial = file.with_extension("partial");
    std::fs::write(&partial, link).map_err(|error| error.to_string())?;
    std::fs::rename(&partial, file).map_err(|error| error.to_string())
}

/// Whether something on this system opens `cashgear-sheet` links. It reads only what the system
/// says about the scheme, and never starts a program to ask.
#[tauri::command]
pub fn sheet_app_installed(sheet: State<'_, SheetApp>) -> bool {
    sheet
        .installed
        .unwrap_or_else(cgw_native::sheet::sheet_app_installed)
}

/// Hands a Workspace launch link (`cashgear-sheet://workspace/launch#ticket=…`, from
/// `POST /workbooks/{id}/launch` with `{target: "desktop"}`) to the system, which opens Sheet's
/// desktop app with it. Any other link is refused.
#[tauri::command]
pub fn sheet_app_open(sheet: State<'_, SheetApp>, url: String) -> Result<(), String> {
    let link = cgw_native::sheet::sheet_launch(&url)
        .ok_or_else(|| "Not a Cash Gear Sheet launch link.".to_owned())?;
    match &sheet.url_file {
        Some(file) => write_link(file, &link),
        None => cgw_native::sheet::open_sheet_launch(&link),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_test_setting_says_installed_or_missing_or_nothing() {
        assert_eq!(installed_from(Some("installed")), Some(true));
        assert_eq!(installed_from(Some("missing")), Some(false));
        assert_eq!(installed_from(Some("yes")), None);
        assert_eq!(installed_from(Some("")), None);
        assert_eq!(installed_from(None), None);
    }

    #[test]
    fn writes_the_link_file_whole() {
        let dir = std::env::temp_dir().join(format!("cgw-sheet-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sheet-link.txt");
        let link = format!(
            "cashgear-sheet://workspace/launch#ticket={}",
            "a".repeat(43)
        );
        write_link(&file, &link).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), link);
        assert!(!file.with_extension("partial").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
