//! The desktop's sign-in to the Workspace API (D16; ARCHITECTURE.md, Authentication): the
//! authorisation code with PKCE (RFC 7636) in the system browser, back to a listener on a loopback
//! port the app picks (RFC 8252, 7.3). The code is exchanged here, on the native side; the refresh
//! token goes to the OS keychain ([`crate::keychain`]) and never to the webview, which only ever
//! gets a short-lived access token, kept in memory.
//!
//! The server side is `server/src/Cgw.Api/Identity/ConnectEndpoints.cs`: client `cgw-desktop`,
//! registered redirect `http://127.0.0.1/callback` on any port, access tokens for 15 minutes,
//! refresh tokens for 30 days, rolled on every use.

use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::{timeout, timeout_at, Instant};
use url::{form_urlencoded, Url};

use crate::keychain::{self, SecretStore};

/// The desktop app's client id at the server.
pub const CLIENT_ID: &str = "cgw-desktop";

/// What the desktop asks for: a refresh token, and the Workspace API.
pub const SCOPES: &str = "offline_access workspace";

/// How long a sign-in waits for the browser to come back.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// An access token with less than this left is refreshed before it is handed out.
pub const REFRESH_BEFORE: Duration = Duration::from_secs(60);

/// How long the listener waits for a connection's request, and the most it reads of it.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const HEAD_LIMIT: usize = 16 * 1024;

/// What can go wrong, as the page gets it: `{ code, message }`. No message carries a token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum Error {
    /// The API base is not one this build may sign in to.
    NotAllowed(String),
    /// The server could not be reached.
    Network(String),
    /// The server refused the grant (`invalid_grant`): the device is signed out.
    Refused(String),
    /// The server answered with an error, or with something that is not an answer.
    Server(String),
    /// The OS keychain failed.
    Keychain(String),
    /// The system browser could not be opened.
    Browser(String),
    /// The loopback listener could not start.
    Listener(String),
    /// Anything else.
    Internal(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (Self::NotAllowed(message)
        | Self::Network(message)
        | Self::Refused(message)
        | Self::Server(message)
        | Self::Keychain(message)
        | Self::Browser(message)
        | Self::Listener(message)
        | Self::Internal(message)) = self;
        f.write_str(message)
    }
}

impl std::error::Error for Error {}

// ---------------------------------------------------------------------------------------------
// The API bases a build may sign in to

/// The API bases in a comma-separated list (`CGW_API_BASES` when the app was built), each as an
/// origin: https, or http on a loopback host for development. Entries that are not are dropped,
/// so a token never goes out in the clear to another machine.
pub fn api_bases(list: &str) -> Vec<String> {
    let mut bases: Vec<String> = Vec::new();
    for base in list.split(',').filter_map(|entry| origin(entry.trim())) {
        if !bases.contains(&base) {
            bases.push(base);
        }
    }
    bases
}

fn origin(value: &str) -> Option<String> {
    let url = Url::parse(value.strip_suffix('/').unwrap_or(value)).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let loopback = matches!(url.host_str()?, "localhost" | "127.0.0.1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return None,
    }
    Some(url.origin().ascii_serialization())
}

/// The page's API base, if it is one of the allowed ones exactly (a trailing `/` aside).
pub fn check_base(base: &str, allowed: &[String]) -> Result<String, Error> {
    let base = base.strip_suffix('/').unwrap_or(base);
    allowed
        .iter()
        .find(|allowed| allowed.as_str() == base)
        .cloned()
        .ok_or_else(|| Error::NotAllowed(format!("This app does not sign in to {base}.")))
}

// ---------------------------------------------------------------------------------------------
// PKCE, the authorise URL and the callback

fn random<const N: usize>() -> Result<[u8; N], Error> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|error| Error::Internal(format!("No random bytes: {error}")))?;
    Ok(bytes)
}

/// A PKCE pair (RFC 7636): the verifier stays here, the S256 challenge goes to the browser.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// A new pair from 32 random bytes.
    pub fn new() -> Result<Self, Error> {
        Ok(Self::from_bytes(&random::<32>()?))
    }

    /// The pair for these bytes: the verifier is them in base64url, the challenge its SHA-256.
    pub fn from_bytes(bytes: &[u8; 32]) -> Self {
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

/// A new `state`: 128 random bits, base64url.
pub fn new_state() -> Result<String, Error> {
    Ok(URL_SAFE_NO_PAD.encode(random::<16>()?))
}

/// The sign-in page's language (`ui_locales`) and the callback page's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    En,
    Ar,
}

impl Language {
    /// Arabic for `ar` and its regions, English for anything else.
    pub fn parse(tag: &str) -> Self {
        if tag == "ar" || tag.starts_with("ar-") {
            Self::Ar
        } else {
            Self::En
        }
    }

    fn tag(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Ar => "ar",
        }
    }
}

/// The redirect for a listener on this port (registered as `http://127.0.0.1/callback`; the
/// server takes any port).
pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

/// What goes in the authorise URL.
pub struct Authorize<'a> {
    pub base: &'a str,
    pub redirect_uri: &'a str,
    pub challenge: &'a str,
    pub state: &'a str,
    pub language: Language,
    pub device_name: &'a str,
}

/// The URL the browser opens: `{base}/connect/authorize` with the code flow's parameters.
pub fn authorize_url(request: &Authorize<'_>) -> Result<String, Error> {
    let mut url = Url::parse(&format!("{}/connect/authorize", request.base))
        .map_err(|error| Error::Internal(format!("Not a URL: {error}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("redirect_uri", request.redirect_uri)
        .append_pair("code_challenge", request.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", request.state)
        .append_pair("device_name", request.device_name)
        .append_pair("ui_locales", request.language.tag());
    Ok(url.into())
}

/// The name the device gets in the account's list: the page's, else the computer's, else
/// `Desktop`; without control characters, at most 64 characters.
pub fn device_name(given: Option<&str>, computer: Option<&str>) -> String {
    let clean = |name: &str| -> String {
        let name: String = name.chars().filter(|c| !c.is_control()).collect();
        name.trim()
            .chars()
            .take(64)
            .collect::<String>()
            .trim()
            .into()
    };
    [given, computer]
        .into_iter()
        .flatten()
        .map(clean)
        .find(|name| !name.is_empty())
        .unwrap_or_else(|| "Desktop".into())
}

/// A request that reached the loopback listener.
#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    /// The server's answer for this sign-in: the code to exchange.
    Code(String),
    /// The server's answer for this sign-in: an error, `access_denied` when the user cancelled.
    Refused(String),
    /// The callback, but with another sign-in's state (or none).
    WrongState,
    /// Anything else: another path, another method, a favicon.
    Other,
}

/// Reads a request's head: only `GET /callback?...` counts, and only with this sign-in's `state`
/// and exactly one `code` or `error`.
pub fn read_callback(head: &str, state: &str) -> Callback {
    let line = head.lines().next().unwrap_or_default();
    let mut parts = line.split(' ');
    let (Some("GET"), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Callback::Other;
    };
    if !version.starts_with("HTTP/1.") {
        return Callback::Other;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return Callback::Other;
    }
    let (mut code, mut error, mut given_state) = (None, None, None);
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        let slot = match &*key {
            "code" => &mut code,
            "error" => &mut error,
            "state" => &mut given_state,
            _ => continue,
        };
        // A parameter given twice is not the server's answer.
        if slot.replace(value.into_owned()).is_some() {
            return Callback::Other;
        }
    }
    if given_state.as_deref() != Some(state) {
        return Callback::WrongState;
    }
    match (code, error) {
        (Some(code), None) if !code.is_empty() => Callback::Code(code),
        (None, Some(error)) => Callback::Refused(error),
        _ => Callback::Other,
    }
}

/// How a sign-in ended, for the page the browser shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    SignedIn,
    Cancelled,
    Failed,
}

/// The page the browser shows after the callback: self-contained, in the sign-in's language.
pub fn callback_page(language: Language, outcome: Outcome) -> String {
    let (lang, dir, title, heading, body) = match (language, outcome) {
        (Language::En, Outcome::SignedIn) => (
            "en",
            "ltr",
            "Cash Gear Workspace",
            "You are signed in",
            "You can close this window and go back to Cash Gear Workspace.",
        ),
        (Language::En, Outcome::Cancelled) => (
            "en",
            "ltr",
            "Cash Gear Workspace",
            "Sign-in was cancelled",
            "You can close this window.",
        ),
        (Language::En, Outcome::Failed) => (
            "en",
            "ltr",
            "Cash Gear Workspace",
            "Sign-in did not finish",
            "Close this window and try again from Cash Gear Workspace.",
        ),
        (Language::Ar, Outcome::SignedIn) => (
            "ar",
            "rtl",
            "مساحة عمل كاش جير",
            "تم تسجيل الدخول",
            "يمكنك إغلاق هذه النافذة والعودة إلى مساحة عمل كاش جير.",
        ),
        (Language::Ar, Outcome::Cancelled) => (
            "ar",
            "rtl",
            "مساحة عمل كاش جير",
            "أُلغي تسجيل الدخول",
            "يمكنك إغلاق هذه النافذة.",
        ),
        (Language::Ar, Outcome::Failed) => (
            "ar",
            "rtl",
            "مساحة عمل كاش جير",
            "لم يكتمل تسجيل الدخول",
            "أغلق هذه النافذة وحاول مرة أخرى من مساحة عمل كاش جير.",
        ),
    };
    format!(
        r#"<!doctype html>
<html lang="{lang}" dir="{dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #1f2328; font: 16px/1.5 system-ui, "Segoe UI", Tahoma, sans-serif; }}
main {{ max-width: 28rem; margin: 16px; padding: 32px; border-radius: 12px; background: #ffffff; box-shadow: 0 1px 3px rgb(0 0 0 / 12%); }}
h1 {{ margin: 0 0 8px; font-size: 20px; }}
p {{ margin: 0; color: #59636e; }}
@media (prefers-color-scheme: dark) {{
  body {{ background: #16181c; color: #e6e8eb; }}
  main {{ background: #1f2328; box-shadow: none; }}
  p {{ color: #a0a7b0; }}
}}
</style>
</head>
<body><main><h1>{heading}</h1><p>{body}</p></main></body>
</html>
"#
    )
}

/// A whole HTTP response for the listener to send: the page, or an empty answer.
pub fn response(status: u16, html: &str) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         Referrer-Policy: no-referrer\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        html.len()
    );
    [head.as_bytes(), html.as_bytes()].concat()
}

// ---------------------------------------------------------------------------------------------
// The token endpoint

fn form(pairs: &[(&str, &str)]) -> String {
    form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

/// The code exchange's form (`/connect/token`).
pub fn code_form(code: &str, redirect_uri: &str, verifier: &str) -> String {
    form(&[
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ])
}

/// The refresh's form (`/connect/token`).
pub fn refresh_form(refresh_token: &str) -> String {
    form(&[
        ("grant_type", "refresh_token"),
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
    ])
}

/// The revocation's form (`/connect/revoke`, RFC 7009).
pub fn revoke_form(refresh_token: &str) -> String {
    form(&[
        ("token", refresh_token),
        ("token_type_hint", "refresh_token"),
        ("client_id", CLIENT_ID),
    ])
}

/// The token endpoint's answer. Deliberately not `Debug`: it holds the tokens.
#[derive(Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Seconds.
    #[serde(default)]
    pub expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct Problem {
    error: String,
}

/// Reads the token endpoint's answer: the tokens, [`Error::Refused`] for `invalid_grant`, or
/// [`Error::Server`].
pub fn read_tokens(status: u16, body: &[u8]) -> Result<Tokens, Error> {
    if (200..300).contains(&status) {
        return match serde_json::from_slice::<Tokens>(body) {
            Ok(tokens) if !tokens.access_token.is_empty() => Ok(tokens),
            _ => Err(Error::Server(
                "The server's answer has no access token.".into(),
            )),
        };
    }
    match serde_json::from_slice::<Problem>(body) {
        Ok(problem) if problem.error == "invalid_grant" => {
            Err(Error::Refused("The server signed this device out.".into()))
        }
        // OAuth error codes are short ASCII words; anything else is not repeated.
        Ok(problem)
            if problem.error.len() <= 40
                && problem
                    .error
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_') =>
        {
            Err(Error::Server(format!(
                "The server refused the request ({}).",
                problem.error
            )))
        }
        _ => Err(Error::Server(format!("The server answered {status}."))),
    }
}

// ---------------------------------------------------------------------------------------------
// The loopback listener

/// Aborts a task when dropped: the listener closes with the sign-in that opened it.
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The listener on `127.0.0.1` and a port the system picks. Each connection's request head is
/// read on a task of its own, so a browser's idle preconnection does not hold up the callback.
struct Loopback {
    port: u16,
    requests: mpsc::Receiver<(TcpStream, String)>,
    _accepting: AbortOnDrop,
}

impl Loopback {
    async fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let (sender, requests) = mpsc::channel(8);
        let accepting = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let sender = sender.clone();
                tokio::spawn(async move {
                    if let Ok(Ok(head)) = timeout(HEAD_TIMEOUT, read_head(&mut stream)).await {
                        let _ = sender.send((stream, head)).await;
                    }
                });
            }
        });
        Ok(Self {
            port,
            requests,
            _accepting: AbortOnDrop(accepting),
        })
    }
}

/// A request's head, up to its blank line (a GET has no body), so closing the connection after
/// the answer does not reset it.
async fn read_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        let from = head.len().saturating_sub(3);
        head.extend_from_slice(&chunk[..read]);
        if head[from..].windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(String::from_utf8_lossy(&head).into_owned());
        }
        if head.len() > HEAD_LIMIT {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
    }
}

async fn answer(mut stream: TcpStream, status: u16, html: &str) {
    let bytes = response(status, html);
    let _ = timeout(HEAD_TIMEOUT, async {
        stream.write_all(&bytes).await?;
        stream.shutdown().await
    })
    .await;
}

// ---------------------------------------------------------------------------------------------
// One API base's sign-in

/// How a sign-in shows the authorise page: the system browser, or (in tests) a file.
pub type Open = Box<dyn FnOnce(&str) -> Result<(), String> + Send>;

struct Access {
    token: String,
    until: Instant,
}

/// The sign-in to one API base: the access token in memory, the refresh token in the keychain
/// under the base's name. Refreshes are one at a time, since each one rolls the refresh token.
pub struct Account {
    base: String,
    http: reqwest::Client,
    secrets: Arc<dyn SecretStore>,
    access: Mutex<Option<Access>>,
    pending: StdMutex<Option<AbortHandle>>,
    sign_in_timeout: Duration,
}

impl Account {
    /// The account for an API base already checked against the allowed ones.
    pub fn new(base: String, secrets: Arc<dyn SecretStore>) -> Result<Self, Error> {
        let http = reqwest::Client::builder()
            // A token request goes to the base and nowhere else.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("cgw-desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| Error::Internal(format!("No HTTP client: {error}")))?;
        Ok(Self {
            base,
            http,
            secrets,
            access: Mutex::new(None),
            pending: StdMutex::new(None),
            sign_in_timeout: SIGN_IN_TIMEOUT,
        })
    }

    /// The API base.
    pub fn base(&self) -> &str {
        &self.base
    }

    /// Signs in through the browser: true once signed in; false when abandoned (the timeout, the
    /// user cancelling, a newer sign-in or a sign-out starting, the listener closing).
    pub async fn sign_in(
        self: &Arc<Self>,
        language: Language,
        device_name: String,
        open: Open,
    ) -> Result<bool, Error> {
        let account = Arc::clone(self);
        let task =
            tokio::spawn(async move { account.run_sign_in(language, device_name, open).await });
        if let Some(previous) = self.lock_pending().replace(task.abort_handle()) {
            previous.abort();
        }
        match task.await {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => Ok(false),
            Err(_) => Err(Error::Internal("The sign-in stopped.".into())),
        }
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, Option<AbortHandle>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn run_sign_in(
        &self,
        language: Language,
        device_name: String,
        open: Open,
    ) -> Result<bool, Error> {
        let mut loopback = Loopback::bind()
            .await
            .map_err(|error| Error::Listener(format!("No loopback port: {error}")))?;
        let redirect = redirect_uri(loopback.port);
        let pkce = Pkce::new()?;
        let state = new_state()?;
        let url = authorize_url(&Authorize {
            base: &self.base,
            redirect_uri: &redirect,
            challenge: &pkce.challenge,
            state: &state,
            language,
            device_name: &device_name,
        })?;
        open(&url).map_err(Error::Browser)?;
        let deadline = Instant::now() + self.sign_in_timeout;
        loop {
            let Ok(Some((stream, head))) = timeout_at(deadline, loopback.requests.recv()).await
            else {
                return Ok(false);
            };
            match read_callback(&head, &state) {
                Callback::Other => answer(stream, 404, "").await,
                Callback::WrongState => answer(stream, 400, "").await,
                Callback::Refused(error) => {
                    let cancelled = error == "access_denied";
                    let outcome = if cancelled {
                        Outcome::Cancelled
                    } else {
                        Outcome::Failed
                    };
                    answer(stream, 200, &callback_page(language, outcome)).await;
                    return if cancelled {
                        Ok(false)
                    } else {
                        Err(Error::Server(format!("The sign-in was refused ({error}).")))
                    };
                }
                Callback::Code(code) => {
                    let result = self.exchange(&code, &redirect, &pkce.verifier).await;
                    let outcome = if result.is_ok() {
                        Outcome::SignedIn
                    } else {
                        Outcome::Failed
                    };
                    answer(stream, 200, &callback_page(language, outcome)).await;
                    return result.map(|()| true);
                }
            }
        }
    }

    async fn exchange(&self, code: &str, redirect: &str, verifier: &str) -> Result<(), Error> {
        let tokens = self.post_token(code_form(code, redirect, verifier)).await?;
        let refresh = tokens
            .refresh_token
            .as_deref()
            .filter(|token| !token.is_empty())
            .ok_or_else(|| Error::Server("The server gave no refresh token.".into()))?;
        let mut access = self.access.lock().await;
        let replaced = keychain::read(&*self.secrets, &self.base).ok().flatten();
        keychain::write(&*self.secrets, &self.base, refresh).map_err(Error::Keychain)?;
        *access = Some(Access::from(&tokens));
        drop(access);
        // Signing in again over an earlier sign-in: that one's token is no use to anyone now.
        if let Some(old) = replaced.filter(|old| old != refresh) {
            let (http, base) = (self.http.clone(), self.base.clone());
            tokio::spawn(async move {
                let _ = post(&http, &base, "/connect/revoke", revoke_form(&old)).await;
            });
        }
        Ok(())
    }

    /// A current access token, refreshed first when it has less than [`REFRESH_BEFORE`] left;
    /// `None` when signed out. A refused refresh signs the device out here too (the keychain entry
    /// goes). While the server cannot be reached, the current token is still given until it
    /// expires; after that the error is.
    pub async fn token(&self) -> Result<Option<String>, Error> {
        let mut access = self.access.lock().await;
        let now = Instant::now();
        if let Some(current) = access.as_ref() {
            if current.until > now + REFRESH_BEFORE {
                return Ok(Some(current.token.clone()));
            }
        }
        let Some(refresh) = keychain::read(&*self.secrets, &self.base).map_err(Error::Keychain)?
        else {
            *access = None;
            return Ok(None);
        };
        match self.post_token(refresh_form(&refresh)).await {
            Ok(tokens) => {
                let fresh = Access::from(&tokens);
                let token = fresh.token.clone();
                *access = Some(fresh);
                // The refresh token rolls: the old one is spent.
                if let Some(next) = tokens.refresh_token.as_deref().filter(|t| !t.is_empty()) {
                    keychain::write(&*self.secrets, &self.base, next).map_err(Error::Keychain)?;
                }
                Ok(Some(token))
            }
            Err(Error::Refused(_)) => {
                *access = None;
                keychain::delete(&*self.secrets, &self.base).map_err(Error::Keychain)?;
                Ok(None)
            }
            Err(error) => match access.as_ref() {
                Some(current) if current.until > now => Ok(Some(current.token.clone())),
                _ => Err(error),
            },
        }
    }

    /// Signs out: stops a sign-in under way, forgets the access token, revokes the refresh token
    /// at the server (best effort: the page has already signed the device out there, which
    /// revokes its tokens too) and removes it from the keychain.
    pub async fn sign_out(&self) -> Result<(), Error> {
        if let Some(pending) = self.lock_pending().take() {
            pending.abort();
        }
        let mut access = self.access.lock().await;
        *access = None;
        if let Ok(Some(refresh)) = keychain::read(&*self.secrets, &self.base) {
            let _ = post(
                &self.http,
                &self.base,
                "/connect/revoke",
                revoke_form(&refresh),
            )
            .await;
        }
        keychain::delete(&*self.secrets, &self.base).map_err(Error::Keychain)
    }

    async fn post_token(&self, form: String) -> Result<Tokens, Error> {
        let (status, body) = post(&self.http, &self.base, "/connect/token", form).await?;
        read_tokens(status, &body)
    }

    #[cfg(test)]
    fn with_sign_in_timeout(mut self, timeout: Duration) -> Self {
        self.sign_in_timeout = timeout;
        self
    }
}

impl From<&Tokens> for Access {
    fn from(tokens: &Tokens) -> Self {
        // Fifteen minutes from this server; a day at most from any.
        let seconds = tokens.expires_in.unwrap_or(300).min(86_400);
        Self {
            token: tokens.access_token.clone(),
            until: Instant::now() + Duration::from_secs(seconds),
        }
    }
}

async fn post(
    http: &reqwest::Client,
    base: &str,
    path: &str,
    form: String,
) -> Result<(u16, Vec<u8>), Error> {
    let network = |error: reqwest::Error| Error::Network(error.without_url().to_string());
    let response = http
        .post(format!("{base}{path}"))
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(ACCEPT, "application/json")
        .body(form)
        .send()
        .await
        .map_err(network)?;
    let status = response.status().as_u16();
    let body = response.bytes().await.map_err(network)?;
    Ok((status, body.to_vec()))
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};
    use std::future::Future;

    use super::*;
    use crate::keychain::Memory;

    fn run<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn query(url: &str) -> HashMap<String, String> {
        Url::parse(url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    fn fields(form: &str) -> HashMap<String, String> {
        form_urlencoded::parse(form.as_bytes())
            .into_owned()
            .collect()
    }

    #[test]
    fn allows_only_the_bases_it_was_built_for() {
        let allowed = api_bases(
            " https://workspace-api.cashgearerp.com , http://localhost:5280/,https://workspace-api.cashgearerp.com,\
             http://evil.example,ftp://x.example,https://x.example/path,https://u:p@x.example,,https://x.example?q",
        );
        assert_eq!(
            allowed,
            [
                "https://workspace-api.cashgearerp.com",
                "http://localhost:5280"
            ]
        );
        assert_eq!(
            api_bases("http://127.0.0.1:5280,http://[::1]:5280,HTTPS://Upper.Example:443"),
            [
                "http://127.0.0.1:5280",
                "http://[::1]:5280",
                "https://upper.example"
            ]
        );
        assert_eq!(
            check_base("https://workspace-api.cashgearerp.com/", &allowed).unwrap(),
            "https://workspace-api.cashgearerp.com"
        );
        assert_eq!(
            check_base("http://localhost:5280", &allowed).unwrap(),
            "http://localhost:5280"
        );
        for base in [
            "",
            "https://evil.example",
            "https://workspace-api.cashgearerp.com.evil.example",
            "https://workspace-api.cashgearerp.com/connect",
            "https://workspace-api.cashgearerp.com//",
            "http://workspace-api.cashgearerp.com",
            "HTTPS://WORKSPACE-API.CASHGEARERP.COM",
            "http://localhost:5281",
        ] {
            assert!(
                matches!(check_base(base, &allowed), Err(Error::NotAllowed(_))),
                "{base}"
            );
        }
    }

    #[test]
    fn makes_pkce_pairs_as_rfc_7636_does() {
        // RFC 7636, appendix B.
        let pair = Pkce::from_bytes(&[
            116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212,
            37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
        ]);
        assert_eq!(pair.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(
            pair.challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );

        let (a, b) = (Pkce::new().unwrap(), Pkce::new().unwrap());
        assert_eq!(a.verifier.len(), 43);
        assert_ne!(a.verifier, b.verifier);
        let state = new_state().unwrap();
        assert_eq!(state.len(), 22);
        assert_ne!(state, new_state().unwrap());
    }

    #[test]
    fn builds_the_authorise_url() {
        let url = authorize_url(&Authorize {
            base: "https://workspace-api.cashgearerp.com",
            redirect_uri: &redirect_uri(61234),
            challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            state: "abc",
            language: Language::parse("ar"),
            device_name: "Mona's laptop & co",
        })
        .unwrap();
        assert!(url.starts_with("https://workspace-api.cashgearerp.com/connect/authorize?"));
        let query = query(&url);
        let expected: HashMap<String, String> = [
            ("client_id", "cgw-desktop"),
            ("response_type", "code"),
            ("scope", "offline_access workspace"),
            ("redirect_uri", "http://127.0.0.1:61234/callback"),
            (
                "code_challenge",
                "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            ),
            ("code_challenge_method", "S256"),
            ("state", "abc"),
            ("device_name", "Mona's laptop & co"),
            ("ui_locales", "ar"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(query, expected);
        assert_eq!(Language::parse("ar-EG"), Language::Ar);
        assert_eq!(Language::parse("en"), Language::En);
        assert_eq!(Language::parse("arabic"), Language::En);
    }

    #[test]
    fn names_the_device() {
        assert_eq!(device_name(Some("  Work PC "), Some("HOST")), "Work PC");
        assert_eq!(device_name(Some(" \u{7}\n "), Some("HOST-01")), "HOST-01");
        assert_eq!(device_name(None, None), "Desktop");
        assert_eq!(device_name(Some(&"x".repeat(100)), None).len(), 64);
        assert_eq!(device_name(Some("a\r\nb"), None), "ab");
    }

    #[test]
    fn reads_the_callback() {
        let head = |line: &str| format!("{line}\r\nHost: 127.0.0.1:5000\r\n\r\n");
        assert_eq!(
            read_callback(
                &head("GET /callback?code=c%2B1&state=s&iss=x HTTP/1.1"),
                "s"
            ),
            Callback::Code("c+1".into())
        );
        assert_eq!(
            read_callback(
                &head("GET /callback?error=access_denied&state=s HTTP/1.1"),
                "s"
            ),
            Callback::Refused("access_denied".into())
        );
        assert_eq!(
            read_callback(&head("GET /callback?code=c&state=t HTTP/1.1"), "s"),
            Callback::WrongState
        );
        assert_eq!(
            read_callback(&head("GET /callback?code=c HTTP/1.1"), "s"),
            Callback::WrongState
        );
        assert_eq!(
            read_callback(&head("GET /callback HTTP/1.1"), "s"),
            Callback::WrongState
        );
        for line in [
            "GET /favicon.ico HTTP/1.1",
            "POST /callback?code=c&state=s HTTP/1.1",
            "GET /callback/?code=c&state=s HTTP/1.1",
            "GET /callbackx?code=c&state=s HTTP/1.1",
            "GET /callback?code=c&state=s HTTP/2",
            "GET /callback?code=c&state=s",
            "GET /callback?code=c&state=s HTTP/1.1 extra",
            "GET /callback?code=c&code=d&state=s HTTP/1.1",
            "GET /callback?code=c&state=s&state=s HTTP/1.1",
            "GET /callback?code=&state=s HTTP/1.1",
            "GET /callback?code=c&error=e&state=s HTTP/1.1",
            "GET /callback?state=s HTTP/1.1",
            "",
        ] {
            assert_eq!(read_callback(&head(line), "s"), Callback::Other, "{line}");
        }
    }

    #[test]
    fn answers_with_a_self_contained_page() {
        let page = callback_page(Language::Ar, Outcome::SignedIn);
        assert!(page.contains(r#"<html lang="ar" dir="rtl">"#));
        assert!(page.contains("تم تسجيل الدخول"));
        assert!(!page.contains("http"), "nothing is loaded from anywhere");
        assert!(callback_page(Language::En, Outcome::Failed).contains("did not finish"));
        assert!(callback_page(Language::En, Outcome::Cancelled).contains("cancelled"));

        let bytes = response(200, &page);
        let text = String::from_utf8(bytes).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(head.contains(&format!("Content-Length: {}", page.len())));
        assert!(head.contains("Content-Security-Policy: default-src 'none'"));
        assert_eq!(body, page);
        assert!(String::from_utf8(response(404, ""))
            .unwrap()
            .starts_with("HTTP/1.1 404 Not Found\r\n"));
    }

    #[test]
    fn writes_the_token_forms() {
        assert_eq!(
            fields(&code_form("c&1", "http://127.0.0.1:1/callback", "v")),
            [
                ("grant_type", "authorization_code"),
                ("client_id", "cgw-desktop"),
                ("code", "c&1"),
                ("redirect_uri", "http://127.0.0.1:1/callback"),
                ("code_verifier", "v"),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
        );
        assert_eq!(
            fields(&refresh_form("r+1"))["refresh_token"],
            "r+1".to_string()
        );
        let revoke = fields(&revoke_form("r"));
        assert_eq!(revoke["token"], "r");
        assert_eq!(revoke["token_type_hint"], "refresh_token");
        assert_eq!(revoke["client_id"], "cgw-desktop");
    }

    #[test]
    fn reads_the_token_answer() {
        let tokens = read_tokens(
            200,
            br#"{"access_token":"a","token_type":"Bearer","expires_in":900,"refresh_token":"r","scope":"offline_access workspace"}"#,
        )
        .unwrap();
        assert_eq!(
            (
                tokens.access_token.as_str(),
                tokens.refresh_token.as_deref(),
                tokens.expires_in
            ),
            ("a", Some("r"), Some(900))
        );
        assert!(matches!(
            read_tokens(400, br#"{"error":"invalid_grant","error_description":"x"}"#),
            Err(Error::Refused(_))
        ));
        assert_eq!(
            read_tokens(400, br#"{"error":"invalid_client"}"#).err(),
            Some(Error::Server(
                "The server refused the request (invalid_client).".into()
            ))
        );
        assert_eq!(
            read_tokens(400, br#"{"error":"<script>"}"#).err(),
            Some(Error::Server("The server answered 400.".into()))
        );
        assert_eq!(
            read_tokens(503, b"busy").err(),
            Some(Error::Server("The server answered 503.".into()))
        );
        assert!(matches!(
            read_tokens(200, br#"{"access_token":""}"#),
            Err(Error::Server(_))
        ));
        assert!(matches!(read_tokens(200, b"<html>"), Err(Error::Server(_))));
    }

    #[test]
    fn errors_reach_the_page_as_a_code_and_a_message() {
        assert_eq!(
            serde_json::to_string(&Error::Network("offline".into())).unwrap(),
            r#"{"code":"network","message":"offline"}"#
        );
        assert_eq!(
            serde_json::to_string(&Error::NotAllowed("no".into())).unwrap(),
            r#"{"code":"notAllowed","message":"no"}"#
        );
    }

    /// A request the server got: its path and its form.
    type Request = (String, HashMap<String, String>);

    /// A token endpoint that answers from a script and records what it was sent.
    struct Server {
        base: String,
        requests: Arc<StdMutex<Vec<Request>>>,
        answers: Arc<StdMutex<VecDeque<(u16, String)>>>,
    }

    impl Server {
        async fn start(answers: &[(u16, &str)]) -> Self {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let requests = Arc::new(StdMutex::new(Vec::new()));
            let answers = Arc::new(StdMutex::new(
                answers
                    .iter()
                    .map(|(status, body)| (*status, body.to_string()))
                    .collect::<VecDeque<_>>(),
            ));
            let (seen, script) = (requests.clone(), answers.clone());
            tokio::spawn(async move {
                while let Ok((mut stream, _)) = listener.accept().await {
                    let (path, body) = read_request(&mut stream).await;
                    seen.lock().unwrap().push((path, fields(&body)));
                    let (status, body) = script
                        .lock()
                        .unwrap()
                        .pop_front()
                        .unwrap_or((500, String::new()));
                    let answer = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(answer.as_bytes()).await.unwrap();
                    let _ = stream.shutdown().await;
                }
            });
            Self {
                base,
                requests,
                answers,
            }
        }

        fn requests(&self) -> Vec<Request> {
            self.requests.lock().unwrap().clone()
        }
    }

    async fn read_request(stream: &mut TcpStream) -> (String, String) {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).await.unwrap();
            buffer.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&buffer).into_owned();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                if body.len() >= length || read == 0 {
                    let path = head.split(' ').nth(1).unwrap_or_default().to_string();
                    return (path, body.to_string());
                }
            }
        }
    }

    /// The browser: a GET to the listener, and the whole answer.
    async fn get(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        stream
            .write_all(
                format!(
                    "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/html\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        answer
    }

    /// Opens the "browser" on the authorise URL: it comes back to the listener with `callback`
    /// (`None`: never), after an idle preconnection, a favicon and a forged callback. Sends the
    /// authorise URL and the page the callback got.
    fn browser(callback: Option<&'static str>) -> (Open, mpsc::Receiver<(String, String)>) {
        let (sender, receiver) = mpsc::channel(1);
        let open: Open = Box::new(move |url: &str| {
            let url = url.to_string();
            tokio::spawn(async move {
                let query = query(&url);
                let redirect = Url::parse(&query["redirect_uri"]).unwrap();
                let port = redirect.port().unwrap();
                let _idle = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                    .await
                    .unwrap();
                assert!(get(port, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
                assert!(get(port, "/callback?code=forged&state=guess")
                    .await
                    .starts_with("HTTP/1.1 400"));
                let Some(callback) = callback else {
                    let _ = sender.send((url, String::new())).await;
                    return;
                };
                let target = format!("/callback?{callback}&state={}", query["state"]);
                let page = get(port, &target).await;
                let _ = sender.send((url, page)).await;
            });
            Ok(())
        });
        (open, receiver)
    }

    const FIRST: &str =
        r#"{"access_token":"a1","token_type":"Bearer","expires_in":30,"refresh_token":"r1"}"#;
    const SECOND: &str =
        r#"{"access_token":"a2","token_type":"Bearer","expires_in":900,"refresh_token":"r2"}"#;

    #[test]
    fn signs_in_refreshes_and_signs_out() {
        run(async {
            let server = Server::start(&[(200, FIRST), (200, SECOND), (200, "")]).await;
            let secrets = Arc::new(Memory::default());
            let account = Arc::new(Account::new(server.base.clone(), secrets.clone()).unwrap());
            let (open, mut pages) = browser(Some("code=the%2Bcode"));

            let signed_in = account
                .sign_in(Language::Ar, "Test desktop".into(), open)
                .await
                .unwrap();
            assert!(signed_in);
            let (url, page) = pages.recv().await.unwrap();
            assert!(page.starts_with("HTTP/1.1 200 OK"), "{page}");
            assert!(page.contains("تم تسجيل الدخول"));

            // The exchange: the code, the same redirect, and the verifier of the challenge.
            let authorise = query(&url);
            assert!(url.starts_with(&format!("{}/connect/authorize?", server.base)));
            assert_eq!(authorise["device_name"], "Test desktop");
            assert_eq!(authorise["ui_locales"], "ar");
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            let (path, exchange) = &requests[0];
            assert_eq!(path, "/connect/token");
            assert_eq!(exchange["grant_type"], "authorization_code");
            assert_eq!(exchange["client_id"], "cgw-desktop");
            assert_eq!(exchange["code"], "the+code");
            assert_eq!(exchange["redirect_uri"], authorise["redirect_uri"]);
            assert_eq!(
                URL_SAFE_NO_PAD.encode(Sha256::digest(exchange["code_verifier"].as_bytes())),
                authorise["code_challenge"]
            );
            assert_eq!(
                keychain::read(&*secrets, &server.base).unwrap().as_deref(),
                Some("r1")
            );

            // 30 seconds left is under the margin: the refresh rolls the refresh token.
            assert_eq!(account.token().await.unwrap().as_deref(), Some("a2"));
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[1].1["grant_type"], "refresh_token");
            assert_eq!(requests[1].1["refresh_token"], "r1");
            assert_eq!(
                keychain::read(&*secrets, &server.base).unwrap().as_deref(),
                Some("r2")
            );
            // A token with time left is given without asking.
            assert_eq!(account.token().await.unwrap().as_deref(), Some("a2"));
            assert_eq!(server.requests().len(), 2);

            account.sign_out().await.unwrap();
            let requests = server.requests();
            assert_eq!(requests.len(), 3);
            assert_eq!(requests[2].0, "/connect/revoke");
            assert_eq!(requests[2].1["token"], "r2");
            assert_eq!(requests[2].1["token_type_hint"], "refresh_token");
            assert_eq!(requests[2].1["client_id"], "cgw-desktop");
            assert!(secrets.0.lock().unwrap().is_empty());
            assert_eq!(account.token().await.unwrap(), None);
            assert_eq!(server.requests().len(), 3);
            assert!(server.answers.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn a_refused_refresh_signs_the_device_out() {
        run(async {
            let server =
                Server::start(&[(400, r#"{"error":"invalid_grant","error_description":"x"}"#)])
                    .await;
            let secrets = Arc::new(Memory::default());
            keychain::write(&*secrets, &server.base, "spent").unwrap();
            let account = Account::new(server.base.clone(), secrets.clone()).unwrap();
            assert_eq!(account.token().await.unwrap(), None);
            assert!(secrets.0.lock().unwrap().is_empty());
            assert_eq!(server.requests()[0].1["refresh_token"], "spent");
        });
    }

    #[test]
    fn an_unreachable_server_keeps_the_refresh_token() {
        run(async {
            let port = {
                let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
                listener.local_addr().unwrap().port()
            };
            let base = format!("http://127.0.0.1:{port}");
            let secrets = Arc::new(Memory::default());
            keychain::write(&*secrets, &base, "kept").unwrap();
            let account = Account::new(base.clone(), secrets.clone()).unwrap();
            assert!(matches!(account.token().await, Err(Error::Network(_))));
            assert_eq!(
                keychain::read(&*secrets, &base).unwrap().as_deref(),
                Some("kept")
            );
            // Signing out still removes it.
            account.sign_out().await.unwrap();
            assert!(secrets.0.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn a_server_error_does_not_sign_out() {
        run(async {
            let server = Server::start(&[(503, "busy")]).await;
            let secrets = Arc::new(Memory::default());
            keychain::write(&*secrets, &server.base, "kept").unwrap();
            let account = Account::new(server.base.clone(), secrets.clone()).unwrap();
            assert_eq!(
                account.token().await.err(),
                Some(Error::Server("The server answered 503.".into()))
            );
            assert_eq!(
                keychain::read(&*secrets, &server.base).unwrap().as_deref(),
                Some("kept")
            );
        });
    }

    #[test]
    fn a_cancelled_sign_in_is_not_signed_in() {
        run(async {
            let server = Server::start(&[]).await;
            let secrets = Arc::new(Memory::default());
            let account = Arc::new(Account::new(server.base.clone(), secrets.clone()).unwrap());
            let (open, mut pages) = browser(Some("error=access_denied"));
            let signed_in = account
                .sign_in(Language::En, "Desktop".into(), open)
                .await
                .unwrap();
            assert!(!signed_in);
            let (_, page) = pages.recv().await.unwrap();
            assert!(page.contains("Sign-in was cancelled"));
            assert!(server.requests().is_empty());
            assert!(secrets.0.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn a_failed_exchange_says_so_in_the_browser() {
        run(async {
            let server = Server::start(&[(400, r#"{"error":"invalid_grant"}"#)]).await;
            let secrets = Arc::new(Memory::default());
            let account = Arc::new(Account::new(server.base.clone(), secrets.clone()).unwrap());
            let (open, mut pages) = browser(Some("code=stale"));
            let result = account.sign_in(Language::En, "Desktop".into(), open).await;
            assert!(matches!(result, Err(Error::Refused(_))));
            let (_, page) = pages.recv().await.unwrap();
            assert!(page.contains("Sign-in did not finish"));
            assert!(secrets.0.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn an_abandoned_sign_in_times_out_and_a_newer_one_replaces_it() {
        run(async {
            let server = Server::start(&[]).await;
            let secrets = Arc::new(Memory::default());
            let account = Arc::new(
                Account::new(server.base.clone(), secrets.clone())
                    .unwrap()
                    .with_sign_in_timeout(Duration::from_millis(300)),
            );
            let (open, _pages) = browser(None);
            assert!(!account
                .sign_in(Language::En, "Desktop".into(), open)
                .await
                .unwrap());

            // A sign-in that a newer one, or a sign-out, replaces resolves false at once.
            let account = Arc::new(Account::new(server.base.clone(), secrets.clone()).unwrap());
            let (open, _first) = browser(None);
            let first = tokio::spawn({
                let account = account.clone();
                async move { account.sign_in(Language::En, "Desktop".into(), open).await }
            });
            tokio::time::sleep(Duration::from_millis(100)).await;
            account.sign_out().await.unwrap();
            assert!(!first.await.unwrap().unwrap());
            assert!(server.requests().is_empty());
        });
    }

    #[test]
    fn a_browser_that_cannot_open_is_an_error() {
        run(async {
            let account = Arc::new(
                Account::new("http://127.0.0.1:1".into(), Arc::new(Memory::default())).unwrap(),
            );
            let open: Open = Box::new(|_| Err("no browser".into()));
            assert_eq!(
                account.sign_in(Language::En, "Desktop".into(), open).await,
                Err(Error::Browser("no browser".into()))
            );
        });
    }
}
