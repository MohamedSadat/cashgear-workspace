//! Desktop helpers that need no Tauri, so they are tested on their own: reading a deep link into
//! one of the app's routes, making a file name from what the page suggests, the computer's name,
//! and the sign-in to the Workspace API ([`auth`]) with its refresh token in the OS keychain
//! ([`keychain`]). The same code serves Windows and macOS.

pub mod auth;
pub mod keychain;

/// The app's own scheme (`plugins.deep-link` in tauri.conf.json). Test installs register another.
/// Windows' installer registers it; on macOS the bundle's Info.plist does (`CFBundleURLTypes`,
/// which Tauri's bundler writes from the same setting).
pub const SCHEME: &str = "cashgear-workspace";

/// Reads a deep link into the hash route the app shows, or `None` for anything else.
///
/// `cashgear-workspace://p/{pageId}` opens a page, `.../p/{pageId}/{blockId}` a block in it;
/// `.../trash` and `.../settings` open those; `cashgear-workspace://` alone just brings the app
/// forward (`#/`). Ids are checked as strictly as the page's router does, and anything else in the
/// link (a query, a fragment, another path) is refused rather than passed on, so a link can only
/// ever choose a route.
///
/// Links reach this as the deep-link plugin hands them on: from the command line on Windows (a
/// second start passes it to the first through the single-instance plugin), from the system's URL
/// events on macOS, to a running app and to a cold start alike. Both arrive parsed by the `url`
/// crate and written out again, which this reads the same way as the link itself.
pub fn route(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '+' || c == '.')
    {
        return None;
    }
    if rest.contains(['?', '#', '\\', '%']) || rest.len() > 128 {
        return None;
    }
    let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
    match parts.as_slice() {
        [""] => Some("#/".into()),
        ["trash"] => Some("#/trash".into()),
        ["settings"] => Some("#/settings".into()),
        ["p", page] if is_uuid(page) => Some(format!("#/p/{page}")),
        ["p", page, block] if is_uuid(page) && is_block_id(block) => {
            Some(format!("#/p/{page}/{block}"))
        }
        _ => None,
    }
}

/// A page id: a UUID in lower case, as the workspace writes them.
fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

/// A block id: twelve letters or digits.
fn is_block_id(value: &str) -> bool {
    value.len() == 12 && value.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// The computer's name, for the account's list of devices: `COMPUTERNAME` on Windows; on macOS
/// the name set under System Settings, General, Sharing (`scutil --get ComputerName`), which a
/// person knows better than the host name, and an app started from the Dock has no `HOSTNAME`;
/// elsewhere `HOSTNAME`. `None` when there is none.
pub fn computer_name() -> Option<String> {
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(target_os = "macos")]
    let name = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .or_else(|| std::env::var("HOSTNAME").ok());
    #[cfg(not(any(windows, target_os = "macos")))]
    let name = std::env::var("HOSTNAME").ok();
    name.map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

/// A file name from the percent-encoded name the page suggests in a header: decoded, with no
/// folders and none of the characters Windows refuses, and never empty.
pub fn file_name(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    let name: String = String::from_utf8_lossy(&out)
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows drops trailing dots and spaces, and a name of only those is no name.
    let name = name.trim_end_matches(['.', ' ']).trim_start();
    if name.is_empty() {
        "export.zip".into()
    } else {
        name.chars().take(200).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "01933b5e-7c2a-7d4e-9f00-1a2b3c4d5e6f";

    #[test]
    fn reads_the_routes_a_link_can_open() {
        assert_eq!(route("cashgear-workspace://"), Some("#/".into()));
        assert_eq!(route("cashgear-workspace:///"), Some("#/".into()));
        assert_eq!(route("cashgear-workspace://trash"), Some("#/trash".into()));
        assert_eq!(
            route("cashgear-workspace://settings/"),
            Some("#/settings".into())
        );
        assert_eq!(
            route(&format!("cashgear-workspace://p/{PAGE}")),
            Some(format!("#/p/{PAGE}"))
        );
        assert_eq!(
            route(&format!("cashgear-workspace://p/{PAGE}/a1B2c3D4e5F6")),
            Some(format!("#/p/{PAGE}/a1B2c3D4e5F6"))
        );
        // A test install's scheme reads the same way.
        assert_eq!(route("cgw-installer-test://trash"), Some("#/trash".into()));
    }

    #[test]
    fn refuses_anything_else() {
        for url in [
            "",
            "cashgear-workspace:",
            "cashgear-workspace:p",
            "://trash",
            "cash gear://trash",
            "cashgear-workspace://p",
            "cashgear-workspace://p/not-a-page",
            &format!("cashgear-workspace://p/{}", PAGE.to_uppercase()),
            &format!("cashgear-workspace://p/{PAGE}/short"),
            &format!("cashgear-workspace://p/{PAGE}/a1B2c3D4e5F6/more"),
            &format!("cashgear-workspace://p/{PAGE}?x=1"),
            &format!("cashgear-workspace://p/{PAGE}#/settings"),
            "cashgear-workspace://p/%2e%2e",
            "cashgear-workspace://..\\settings",
            "cashgear-workspace://javascript:alert(1)",
            "cashgear-workspace://unknown",
        ] {
            assert_eq!(route(url), None, "{url}");
        }
    }

    /// tao reads a macOS URL event's `NSURL` with the `url` crate and the deep-link plugin hands it
    /// on written out again; on Windows the plugin parses the command line the same way. What the
    /// parser does to a link (an empty path, `%2e%2e`) must not change the route it chooses.
    #[test]
    fn reads_links_as_the_url_parser_hands_them_over() {
        for link in [
            "cashgear-workspace://",
            "cashgear-workspace:///",
            "cashgear-workspace://trash",
            "cashgear-workspace://settings/",
            &format!("cashgear-workspace://p/{PAGE}"),
            &format!("cashgear-workspace://p/{PAGE}/"),
            &format!("cashgear-workspace://p/{PAGE}/a1B2c3D4e5F6"),
            &format!("cashgear-workspace://p/{}", PAGE.to_uppercase()),
            &format!("cashgear-workspace://p/{PAGE}?x=1"),
            &format!("cashgear-workspace://p/{PAGE}#/settings"),
            "cashgear-workspace://p/%2e%2e",
            "cashgear-workspace://p/../settings",
            "cashgear-workspace://P/settings",
            "cashgear-workspace://unknown",
        ] {
            let parsed = url::Url::parse(link).unwrap().to_string();
            assert_eq!(route(&parsed), route(link), "{link} parsed as {parsed}");
        }
    }

    #[test]
    fn names_the_computer() {
        let name = computer_name();
        if let Some(name) = &name {
            assert!(!name.is_empty() && name.trim() == name && !name.contains('\n'));
        }
        #[cfg(windows)]
        assert_eq!(
            name,
            std::env::var("COMPUTERNAME")
                .ok()
                .map(|n| n.trim().to_owned())
                .filter(|n| !n.is_empty())
        );
        // Every Mac has a computer name (GitHub's runners too).
        #[cfg(target_os = "macos")]
        assert!(name.is_some());
    }

    #[test]
    fn makes_safe_file_names() {
        assert_eq!(file_name("Budget%202026.zip"), "Budget 2026.zip");
        assert_eq!(file_name("%D8%AE%D8%B7%D8%A9.zip"), "خطة.zip");
        assert_eq!(
            file_name("..%2F..%2Fwindows%2Fwin.ini"),
            ".._.._windows_win.ini"
        );
        assert_eq!(file_name("a:b*c?.md"), "a_b_c_.md");
        assert_eq!(file_name("%0Aname"), "_name");
        assert_eq!(file_name("%"), "%");
        assert_eq!(file_name("%zz"), "%zz");
        assert_eq!(file_name("%E2%82"), "\u{fffd}");
        assert_eq!(file_name(""), "export.zip");
        assert_eq!(file_name(". . ."), "export.zip");
        assert_eq!(file_name("report. "), "report");
    }
}
