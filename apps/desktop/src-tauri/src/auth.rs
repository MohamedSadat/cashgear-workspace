//! The sign-in to the Workspace API (D16; ARCHITECTURE.md, Authentication): the commands behind
//! `WorkspacePlatform.auth` (apps/web/src/platform/desktop.ts). The flow itself, PKCE through the
//! system browser back to a loopback listener, is in crates/cgw-native (`auth`, `keychain`).
//!
//! The page names the API base on every call, and it must be one this build allows
//! (`CGW_API_BASES` when it was built), so a compromised page cannot have a token sent elsewhere.
//! The refresh token stays here and in the OS keychain; the page only ever gets an access token.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use cgw_native::auth::{self, Account, Error, Language, Open};
use cgw_native::keychain::{Keychain, SERVICE};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// The API bases this build may sign in to: `CGW_API_BASES` when it was built (comma-separated
/// origins), else production and the local development server. Entries that are neither https
/// nor on a loopback host are dropped (`cgw_native::auth::api_bases`). The CSP's `connect-src` in
/// tauri.conf.json lists the same bases.
const API_BASES: &str = match option_env!("CGW_API_BASES") {
    Some(list) => list,
    None => "https://workspace-api.cashgearerp.com,http://127.0.0.1:5280,http://localhost:5280",
};

pub struct Auth {
    allowed: Vec<String>,
    /// Tests only: `CGW_AUTH_URL_FILE`, read once at start, as `CGW_DATA_DIR` is. When it is set,
    /// a sign-in writes the authorise URL to that file instead of opening the system browser, and
    /// the end-to-end test drives a browser of its own to it. The URL holds no secret: the PKCE
    /// verifier never leaves this process.
    url_file: Option<PathBuf>,
    /// The keychain service the refresh tokens are kept under. Tests set `CGW_KEYCHAIN_SERVICE`
    /// (with `CGW_DATA_DIR`) so a test run never replaces the person's own sign-in.
    service: String,
    accounts: Mutex<HashMap<String, Arc<Account>>>,
}

impl Auth {
    pub fn from_env() -> Self {
        Self {
            allowed: auth::api_bases(API_BASES),
            url_file: std::env::var_os("CGW_AUTH_URL_FILE").map(PathBuf::from),
            service: std::env::var("CGW_KEYCHAIN_SERVICE")
                .ok()
                .filter(|s| s.starts_with(SERVICE) && s.len() <= 100)
                .unwrap_or_else(|| SERVICE.to_owned()),
            accounts: Mutex::new(HashMap::new()),
        }
    }

    /// The sign-in for an allowed API base, made on first use.
    fn account(&self, base: &str) -> Result<Arc<Account>, Error> {
        let base = auth::check_base(base, &self.allowed)?;
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(account) = accounts.get(&base) {
            return Ok(account.clone());
        }
        let keychain = Keychain::open(&self.service).map_err(Error::Keychain)?;
        let account = Arc::new(Account::new(base.clone(), Arc::new(keychain))?);
        accounts.insert(base, account.clone());
        Ok(account)
    }
}

/// Writes the authorise URL for a test, whole or not at all (a test may be polling the file).
fn write_url(file: &Path, url: &str) -> Result<(), String> {
    let partial = file.with_extension("partial");
    std::fs::write(&partial, url).map_err(|error| error.to_string())?;
    std::fs::rename(&partial, file).map_err(|error| error.to_string())
}

/// Signs in through the system browser: true once signed in, false when abandoned (five minutes
/// without an answer, the user cancelling, another sign-in or a sign-out starting). `language`
/// is the sign-in page's (`en` or `ar`); `device_name` the name the device gets in the account's
/// list, the computer's name when the page gives none.
#[tauri::command]
pub async fn auth_sign_in(
    app: AppHandle,
    auth: State<'_, Auth>,
    api_base: String,
    language: String,
    device_name: Option<String>,
) -> Result<bool, Error> {
    let account = auth.account(&api_base)?;
    let computer = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok();
    let name = auth::device_name(device_name.as_deref(), computer.as_deref());
    let open: Open = match auth.url_file.clone() {
        Some(file) => Box::new(move |url| write_url(&file, url)),
        None => {
            let app = app.clone();
            Box::new(move |url| {
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|error| error.to_string())
            })
        }
    };
    let signed_in = account
        .sign_in(Language::parse(&language), name, open)
        .await?;
    if signed_in {
        // Back from the browser to the app.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
    Ok(signed_in)
}

/// A current access token for the API base, refreshed here when it has under a minute left, or
/// null when signed out.
#[tauri::command]
pub async fn auth_token(auth: State<'_, Auth>, api_base: String) -> Result<Option<String>, Error> {
    auth.account(&api_base)?.token().await
}

/// Revokes the refresh token at the server, removes it from the keychain and forgets the access
/// token.
#[tauri::command]
pub async fn auth_sign_out(auth: State<'_, Auth>, api_base: String) -> Result<(), Error> {
    auth.account(&api_base)?.sign_out().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_bases_are_allowed() {
        let allowed = auth::api_bases(API_BASES);
        if option_env!("CGW_API_BASES").is_none() {
            assert_eq!(
                allowed,
                [
                    "https://workspace-api.cashgearerp.com",
                    "http://127.0.0.1:5280",
                    "http://localhost:5280"
                ]
            );
        }
        assert!(!allowed.is_empty(), "CGW_API_BASES allows nothing");
    }

    #[test]
    fn the_csp_lets_the_page_reach_every_allowed_base() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        let connect = csp
            .split(';')
            .map(str::trim)
            .find_map(|directive| directive.strip_prefix("connect-src "))
            .unwrap();
        let sources: Vec<&str> = connect.split_whitespace().collect();
        for base in auth::api_bases(API_BASES) {
            assert!(
                sources.contains(&base.as_str()),
                "{base} is not in connect-src"
            );
        }
    }

    #[test]
    fn writes_the_url_file_whole() {
        let dir = std::env::temp_dir().join(format!("cgw-auth-url-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("authorize.txt");
        write_url(&file, "http://127.0.0.1:5280/connect/authorize?x=1").unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "http://127.0.0.1:5280/connect/authorize?x=1"
        );
        assert!(!file.with_extension("partial").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
