//! Cash Gear Sheet's desktop app (Track S6; INTEGRATIONS.md, "Opening Sheet's desktop app"):
//! whether the system has something that opens Sheet's `cashgear-sheet` links, and handing it a
//! Workspace launch link, which is the only link this ever opens.
//!
//! The question is the system's own, never a program started to ask: on Windows the scheme's open
//! command through `AssocQueryStringW` (which reads `HKCU\Software\Classes` and
//! `HKLM\Software\Classes` both, and the person's choice of handler), on macOS
//! `LSCopyDefaultApplicationURLForURL`. The link goes to the system the same way a click on it
//! would (`ShellExecuteW`, LaunchServices' `LSOpenCFURLRef`), never to a browser, and is neither
//! logged nor kept: its ticket is one use and two minutes, and means something only to Sheet.

/// Sheet's scheme, which Sheet's installer registers (and its uninstaller removes).
pub const SHEET_SCHEME: &str = "cashgear-sheet";

/// The one link shape Workspace hands Sheet: its path and the ticket's key, before the ticket.
const LAUNCH_PREFIX: &str = "cashgear-sheet://workspace/launch#ticket=";

/// Reads a Workspace launch link for Sheet's desktop app, exactly
/// `cashgear-sheet://workspace/launch#ticket=<ticket>` with a ticket of 43 base64url characters
/// (256 random bits, no padding) and nothing else, and gives it back rebuilt from the ticket alone;
/// `None` for anything else. The API makes the link (`POST /workbooks/{id}/launch` with
/// `{target: "desktop"}`); this is what keeps a page that is not the app's own from handing the
/// system any other link through the same command.
pub fn sheet_launch(url: &str) -> Option<String> {
    let ticket = url.strip_prefix(LAUNCH_PREFIX)?;
    crate::is_base64url(ticket, 43).then(|| format!("{LAUNCH_PREFIX}{ticket}"))
}

/// Whether something on this system opens `cashgear-sheet` links (Sheet's desktop app installed).
pub fn sheet_app_installed() -> bool {
    scheme_handled(SHEET_SCHEME)
}

/// Hands a Workspace launch link to the system, which opens Sheet's desktop app with it. Refuses
/// anything [`sheet_launch`] does not read.
pub fn open_sheet_launch(url: &str) -> Result<(), String> {
    let link = sheet_launch(url).ok_or_else(|| "Not a Cash Gear Sheet launch link.".to_owned())?;
    open_link(&link)
}

#[cfg(windows)]
fn scheme_handled(scheme: &str) -> bool {
    windows::handled(scheme)
}

#[cfg(target_os = "macos")]
fn scheme_handled(scheme: &str) -> bool {
    macos::handled(scheme)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn scheme_handled(_scheme: &str) -> bool {
    false
}

#[cfg(windows)]
fn open_link(link: &str) -> Result<(), String> {
    windows::open(link)
}

#[cfg(target_os = "macos")]
fn open_link(link: &str) -> Result<(), String> {
    macos::open(link)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_link(_link: &str) -> Result<(), String> {
    Err("Cash Gear Sheet's desktop app runs on Windows and macOS only.".into())
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;

    #[link(name = "shlwapi")]
    extern "system" {
        fn AssocQueryStringW(
            flags: u32,
            string: u32,
            assoc: *const u16,
            extra: *const u16,
            out: *mut u16,
            out_len: *mut u32,
        ) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            window: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> *mut c_void;
    }

    /// `pszAssoc` names a protocol (Windows 8 on), whose handler may be the person's own choice.
    const ASSOCF_IS_PROTOCOL: u32 = 0x1000;
    /// An unknown scheme is unknown, not "open with" (the `Unknown` key's command).
    const ASSOCF_INIT_IGNOREUNKNOWN: u32 = 0x400;
    const ASSOCSTR_COMMAND: u32 = 1;
    const SW_SHOWNORMAL: i32 = 1;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// The scheme's `open` command exists: with no buffer, the call gives the command's length
    /// (`S_FALSE`, or `S_OK`) when there is one, and fails (`ERROR_NO_ASSOCIATION`) when not.
    pub fn handled(scheme: &str) -> bool {
        let assoc = wide(scheme);
        let verb = wide("open");
        let mut len: u32 = 0;
        // SAFETY: both strings are NUL-terminated and outlive the call; a null `out` with a valid
        // `out_len` asks for the length only.
        let result = unsafe {
            AssocQueryStringW(
                ASSOCF_IS_PROTOCOL | ASSOCF_INIT_IGNOREUNKNOWN,
                ASSOCSTR_COMMAND,
                assoc.as_ptr(),
                verb.as_ptr(),
                std::ptr::null_mut(),
                &mut len,
            )
        };
        result >= 0 && len > 1
    }

    /// The link to the shell, as a click on it would go: its handler starts (or is told, when it
    /// runs already). A result above 32 is success.
    pub fn open(link: &str) -> Result<(), String> {
        let file = wide(link);
        let verb = wide("open");
        // SAFETY: the strings are NUL-terminated and outlive the call; no window, parameters or
        // folder.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        let code = result as usize;
        if code > 32 {
            Ok(())
        } else {
            Err(format!("The system could not open the link ({code})."))
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateWithBytes(
            allocator: CFTypeRef,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            base: CFTypeRef,
        ) -> CFTypeRef;
        fn CFRelease(object: CFTypeRef);
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyDefaultApplicationURLForURL(
            url: CFTypeRef,
            roles: u32,
            error: *mut CFTypeRef,
        ) -> CFTypeRef;
        fn LSOpenCFURLRef(url: CFTypeRef, launched: *mut CFTypeRef) -> i32;
    }

    const UTF8: u32 = 0x0800_0100;
    /// `kLSRolesAll`.
    const ROLES_ALL: u32 = 0xFFFF_FFFF;

    /// A `CFURL`, released when dropped.
    struct Url(CFTypeRef);

    impl Url {
        fn new(text: &str) -> Option<Self> {
            let length = isize::try_from(text.len()).ok()?;
            // SAFETY: the bytes are valid for `length`; a null allocator is the default one.
            let url = unsafe {
                CFURLCreateWithBytes(
                    std::ptr::null(),
                    text.as_ptr(),
                    length,
                    UTF8,
                    std::ptr::null(),
                )
            };
            (!url.is_null()).then_some(Self(url))
        }
    }

    impl Drop for Url {
        fn drop(&mut self) {
            // SAFETY: made by a Create function, released once.
            unsafe { CFRelease(self.0) }
        }
    }

    /// LaunchServices names an application for a link on the scheme.
    pub fn handled(scheme: &str) -> bool {
        let Some(url) = Url::new(&format!("{scheme}://workspace/launch")) else {
            return false;
        };
        // SAFETY: a live CFURL; the answer follows the Copy rule and is released here.
        let app =
            unsafe { LSCopyDefaultApplicationURLForURL(url.0, ROLES_ALL, std::ptr::null_mut()) };
        if app.is_null() {
            return false;
        }
        // SAFETY: a copied CFURL, released once.
        unsafe { CFRelease(app) };
        true
    }

    /// The link to LaunchServices, which opens (or tells) its application.
    pub fn open(link: &str) -> Result<(), String> {
        let url = Url::new(link).ok_or_else(|| "Not a link.".to_owned())?;
        // SAFETY: a live CFURL; the launched application's URL is not asked for.
        let status = unsafe { LSOpenCFURLRef(url.0, std::ptr::null_mut()) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("The system could not open the link ({status})."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICKET: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

    #[test]
    fn reads_the_one_launch_link() {
        assert_eq!(TICKET.len(), 43);
        let link = format!("cashgear-sheet://workspace/launch#ticket={TICKET}");
        assert_eq!(sheet_launch(&link), Some(link.clone()));
    }

    #[test]
    fn refuses_any_other_link() {
        let short = &TICKET[1..];
        let long = format!("{TICKET}A");
        let bad = TICKET.replace('A', "+");
        for link in [
            String::new(),
            "cashgear-sheet://".into(),
            "cashgear-sheet://workspace/launch".into(),
            "cashgear-sheet://workspace/launch#".into(),
            "cashgear-sheet://workspace/launch#ticket=".into(),
            format!("cashgear-sheet://workspace/launch#ticket={short}"),
            format!("cashgear-sheet://workspace/launch#ticket={long}"),
            format!("cashgear-sheet://workspace/launch#ticket={bad}"),
            format!("cashgear-sheet://workspace/launch#ticket={TICKET}&x=1"),
            format!("cashgear-sheet://workspace/launch#ticket={TICKET}#again"),
            format!("cashgear-sheet://workspace/launch?x=1#ticket={TICKET}"),
            format!("cashgear-sheet://workspace/launch/#ticket={TICKET}"),
            format!("cashgear-sheet://workspace/other#ticket={TICKET}"),
            format!("cashgear-sheet://erp/launch#ticket={TICKET}"),
            format!("CASHGEAR-SHEET://workspace/launch#ticket={TICKET}"),
            format!("cashgear-sheet://Workspace/launch#ticket={TICKET}"),
            format!("cashgear-workspace://workspace/launch#ticket={TICKET}"),
            format!("https://sheet.cashgearerp.com/cloud#launch={TICKET}"),
            format!("cashgear-sheet://workspace/launch#ticket={TICKET}\n"),
            format!(" cashgear-sheet://workspace/launch#ticket={TICKET}"),
            format!("cashgear-sheet://workspace/launch#ticket%3D{TICKET}"),
        ] {
            assert_eq!(sheet_launch(&link), None, "{link:?}");
            assert!(open_sheet_launch(&link).is_err(), "{link:?}");
        }
    }

    /// Asking never starts anything; a scheme nothing registers is not handled.
    #[test]
    fn a_scheme_nothing_registers_is_not_handled() {
        let scheme = format!("cgw-no-such-scheme-{}", std::process::id());
        assert!(!scheme_handled(&scheme));
    }

    /// By hand on a machine with a browser (`cargo test -p cgw-native -- --ignored`): a scheme the
    /// system does handle reads as handled, so the question is asked the right way.
    #[test]
    #[ignore = "needs a browser registered for https"]
    fn a_scheme_the_system_handles_is_handled() {
        assert!(scheme_handled("https"));
    }
}
