//! The OS keychain, where the desktop keeps its refresh token (D16; ARCHITECTURE.md, Token
//! storage): Windows Credential Manager, or Keychain Services on macOS (a generic password in the
//! user's login keychain, service `com.cashgear.workspace` and the API base as the account). Both
//! go through `keyring-core` with the OS's own store crate. Nothing here writes a secret to a file
//! or a log, and errors never carry one.
//!
//! One Windows credential holds at most 2,560 bytes, and a refresh token can be longer (an
//! encrypted JWT grows with the keys and the claims), so a secret is kept in parts: the entry for
//! the account itself, then `{account}#1`, `{account}#2`, ... Reading joins them in order. macOS
//! has no such limit, but the parts are kept there too, so one tested path serves both.
//!
//! On macOS an item may be read without a prompt by the app that made it, known by its code
//! signature: a Developer ID app keeps that identity across updates, an ad-hoc signed one does
//! not, so after an update of an ad-hoc build macOS asks once before the app can read its token.

use std::sync::Arc;

use keyring_core::{CredentialStore, Error as KeyringError};

/// The keychain service the app's entries are under (the app's identifier).
pub const SERVICE: &str = "com.cashgear.workspace";

/// The longest part one entry holds: Windows' `CRED_MAX_CREDENTIAL_BLOB_SIZE`.
pub const PART: usize = 2560;

/// The most parts a secret may take.
pub const MAX_PARTS: usize = 16;

/// Where secrets are kept, by account: the OS keychain, or memory in tests.
pub trait SecretStore: Send + Sync {
    /// The secret of an entry, or `None` when there is none.
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String>;
    /// Creates or replaces an entry.
    fn set(&self, account: &str, secret: &[u8]) -> Result<(), String>;
    /// Removes an entry; true when there was one.
    fn delete(&self, account: &str) -> Result<bool, String>;
}

/// The OS keychain, for one service.
pub struct Keychain {
    store: Arc<CredentialStore>,
    service: String,
}

impl Keychain {
    /// The keychain of this platform. Fails where there is none the app supports.
    pub fn open(service: &str) -> Result<Self, String> {
        Ok(Self {
            store: native_store()?,
            service: service.into(),
        })
    }

    fn entry(&self, account: &str) -> Result<keyring_core::Entry, String> {
        let modifiers = modifiers();
        self.store
            .build(&self.service, account, modifiers.as_ref())
            .map_err(message)
    }
}

impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        match self.entry(account)?.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(message(error)),
        }
    }

    fn set(&self, account: &str, secret: &[u8]) -> Result<(), String> {
        self.entry(account)?.set_secret(secret).map_err(message)
    }

    fn delete(&self, account: &str) -> Result<bool, String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(error) => Err(message(error)),
        }
    }
}

#[cfg(windows)]
fn native_store() -> Result<Arc<CredentialStore>, String> {
    let store: Arc<CredentialStore> =
        windows_native_keyring_store::Store::new().map_err(message)?;
    Ok(store)
}

#[cfg(target_os = "macos")]
fn native_store() -> Result<Arc<CredentialStore>, String> {
    let store: Arc<CredentialStore> =
        apple_native_keyring_store::keychain::Store::new().map_err(message)?;
    Ok(store)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn native_store() -> Result<Arc<CredentialStore>, String> {
    Err("This platform has no keychain the app supports.".into())
}

/// On Windows the entry stays on this computer (`CRED_PERSIST_LOCAL_MACHINE`): a device's token
/// does not roam with the profile to another machine.
#[cfg(windows)]
fn modifiers() -> Option<std::collections::HashMap<&'static str, &'static str>> {
    Some([("persistence", "Local")].into())
}

#[cfg(not(windows))]
fn modifiers() -> Option<std::collections::HashMap<&'static str, &'static str>> {
    None
}

/// The keychain's error in words, never with a secret in it: the variants that carry bytes are
/// not printed.
fn message(error: KeyringError) -> String {
    match error {
        KeyringError::PlatformFailure(cause) | KeyringError::NoStorageAccess(cause) => {
            format!("The keychain refused: {cause}")
        }
        KeyringError::TooLong(what, limit) => {
            format!("The keychain takes at most {limit} for the {what}.")
        }
        KeyringError::NoDefaultStore => "There is no keychain.".into(),
        _ => "The keychain could not be used.".into(),
    }
}

fn part(account: &str, index: usize) -> String {
    if index == 0 {
        account.into()
    } else {
        format!("{account}#{index}")
    }
}

/// The secret kept for an account, its parts joined; `None` when there is none.
pub fn read(store: &dyn SecretStore, account: &str) -> Result<Option<String>, String> {
    let mut secret = Vec::new();
    for index in 0..MAX_PARTS {
        match store.get(&part(account, index))? {
            Some(bytes) => secret.extend_from_slice(&bytes),
            None if index == 0 => return Ok(None),
            None => break,
        }
    }
    String::from_utf8(secret)
        .map(Some)
        .map_err(|_| "The keychain entry is not text.".into())
}

/// Keeps a secret for an account, in as many parts as it needs, and removes the parts a longer
/// one left.
pub fn write(store: &dyn SecretStore, account: &str, secret: &str) -> Result<(), String> {
    let parts: Vec<&[u8]> = secret.as_bytes().chunks(PART).collect();
    if parts.is_empty() {
        return Err("An empty secret is not kept.".into());
    }
    if parts.len() > MAX_PARTS {
        return Err("The secret is too long for the keychain.".into());
    }
    for (index, bytes) in parts.iter().enumerate() {
        store.set(&part(account, index), bytes)?;
    }
    for index in parts.len()..MAX_PARTS {
        if !store.delete(&part(account, index))? {
            break;
        }
    }
    Ok(())
}

/// Removes an account's secret, every part of it.
pub fn delete(store: &dyn SecretStore, account: &str) -> Result<(), String> {
    for index in 0..MAX_PARTS {
        if !store.delete(&part(account, index))? && index > 0 {
            break;
        }
    }
    Ok(())
}

/// Secrets in memory, for tests.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Memory(pub std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>);

#[cfg(test)]
impl SecretStore for Memory {
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &[u8]) -> Result<(), String> {
        if secret.len() > PART {
            return Err("too long".into());
        }
        self.0
            .lock()
            .unwrap()
            .insert(account.into(), secret.to_vec());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<bool, String> {
        Ok(self.0.lock().unwrap().remove(account).is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "https://workspace-api.cashgearerp.com";

    fn keys(store: &Memory) -> Vec<String> {
        store.0.lock().unwrap().keys().cloned().collect()
    }

    #[test]
    fn keeps_a_short_secret_in_one_entry() {
        let store = Memory::default();
        assert_eq!(read(&store, ACCOUNT).unwrap(), None);
        write(&store, ACCOUNT, "token").unwrap();
        assert_eq!(keys(&store), [ACCOUNT]);
        assert_eq!(read(&store, ACCOUNT).unwrap().as_deref(), Some("token"));
        delete(&store, ACCOUNT).unwrap();
        assert!(keys(&store).is_empty());
        assert_eq!(read(&store, ACCOUNT).unwrap(), None);
        // Removing what is not there is not an error.
        delete(&store, ACCOUNT).unwrap();
    }

    #[test]
    fn keeps_a_long_secret_in_parts_and_removes_the_parts_left_over() {
        let store = Memory::default();
        let long: String = (0..PART * 2 + 10)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect();
        write(&store, ACCOUNT, &long).unwrap();
        assert_eq!(
            keys(&store),
            [
                ACCOUNT.to_string(),
                format!("{ACCOUNT}#1"),
                format!("{ACCOUNT}#2")
            ]
        );
        assert_eq!(read(&store, ACCOUNT).unwrap().as_deref(), Some(&*long));

        // A shorter secret replaces it, and the parts it no longer needs go.
        let shorter = &long[..PART + 1];
        write(&store, ACCOUNT, shorter).unwrap();
        assert_eq!(keys(&store), [ACCOUNT.to_string(), format!("{ACCOUNT}#1")]);
        assert_eq!(read(&store, ACCOUNT).unwrap().as_deref(), Some(shorter));

        delete(&store, ACCOUNT).unwrap();
        assert!(keys(&store).is_empty());
    }

    #[test]
    fn refuses_secrets_it_cannot_keep() {
        let store = Memory::default();
        assert!(write(&store, ACCOUNT, "").is_err());
        assert!(write(&store, ACCOUNT, &"x".repeat(PART * MAX_PARTS + 1)).is_err());
        assert!(keys(&store).is_empty());
        // Exactly the most it can take.
        write(&store, ACCOUNT, &"x".repeat(PART * MAX_PARTS)).unwrap();
        assert_eq!(keys(&store).len(), MAX_PARTS);
    }

    #[test]
    fn accounts_are_kept_apart() {
        let store = Memory::default();
        write(&store, ACCOUNT, "production").unwrap();
        write(&store, "http://localhost:5280", "development").unwrap();
        delete(&store, "http://localhost:5280").unwrap();
        assert_eq!(
            read(&store, ACCOUNT).unwrap().as_deref(),
            Some("production")
        );
    }

    /// The real keychain, under a service of its own: Credential Manager on Windows, the login
    /// keychain on macOS. It writes there (and removes what it wrote), so it runs on request:
    /// `cargo test -p cgw-native -- --ignored`. The macOS workflow runs it on GitHub's runner.
    #[test]
    #[ignore = "writes to the OS keychain"]
    fn round_trips_through_the_os_keychain() {
        let keychain = Keychain::open(&format!("{SERVICE}.test")).unwrap();
        let account = "http://127.0.0.1:1";
        delete(&keychain, account).unwrap();
        assert_eq!(read(&keychain, account).unwrap(), None);
        let long = "t".repeat(PART + 100);
        write(&keychain, account, &long).unwrap();
        assert_eq!(read(&keychain, account).unwrap().as_deref(), Some(&*long));
        assert!(keychain.get(&format!("{account}#1")).unwrap().is_some());
        // Another service (a test run's, or the person's own) does not see it.
        let other = Keychain::open(&format!("{SERVICE}.test.other")).unwrap();
        assert_eq!(read(&other, account).unwrap(), None);
        write(&keychain, account, "short").unwrap();
        assert_eq!(read(&keychain, account).unwrap().as_deref(), Some("short"));
        assert_eq!(keychain.get(&format!("{account}#1")).unwrap(), None);
        delete(&keychain, account).unwrap();
        assert_eq!(read(&keychain, account).unwrap(), None);
    }
}
