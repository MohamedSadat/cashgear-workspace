//! Yjs functions for the server worker, over `yrs`: bytes in, bytes out (D14, spike S3).
//!
//! Every function takes Yjs v1 update bytes and returns bytes, text or an error. None panics on
//! bad input: the C ABI in [`ffi`] also catches any panic and returns it as an error, so nothing
//! unwinds into the .NET host.

pub mod ffi;

use std::fmt;

use serde_json::{Map, Value};
use yrs::any::Number;
use yrs::types::text::YChange;
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Options, Out, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlFragment, XmlOut,
};

/// The Yjs document's shared types, as `docs/DATA_MODEL.md` names them.
pub const CONTENT: &str = "content";
pub const META: &str = "meta";

/// Larger inputs are refused before decoding (S7: oversized updates).
pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
/// Deeper nesting is refused when walking the tree, so a hostile document cannot exhaust the
/// stack (S7). Real pages nest blocks a few levels deep.
pub const MAX_DEPTH: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YdocError {
    /// The bytes are not a Yjs v1 update, or are too large.
    Decode(String),
    /// The update decoded but could not be applied.
    Apply(String),
    /// The update refers to content it does not carry, so compacting it would lose data.
    MissingDependencies,
    /// The document's content is not the shape this library reads.
    Shape(String),
    /// A panic inside the library or `yrs`, caught at the boundary.
    Panic(String),
}

impl YdocError {
    pub fn code(&self) -> i32 {
        match self {
            YdocError::Decode(_) => 1,
            YdocError::Apply(_) => 2,
            YdocError::MissingDependencies => 3,
            YdocError::Shape(_) => 4,
            YdocError::Panic(_) => 5,
        }
    }
}

impl fmt::Display for YdocError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            YdocError::Decode(m) => write!(f, "not a Yjs v1 update: {m}"),
            YdocError::Apply(m) => write!(f, "the update could not be applied: {m}"),
            YdocError::MissingDependencies => {
                write!(f, "the update refers to content it does not carry")
            }
            YdocError::Shape(m) => write!(f, "unexpected document shape: {m}"),
            YdocError::Panic(m) => write!(f, "internal error: {m}"),
        }
    }
}

impl std::error::Error for YdocError {}

pub type Result<T> = std::result::Result<T, YdocError>;

fn check_size(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(YdocError::Decode(format!(
            "{} bytes is over the {MAX_INPUT_BYTES}-byte limit",
            bytes.len()
        )));
    }
    Ok(())
}

fn decode(bytes: &[u8]) -> Result<Update> {
    check_size(bytes)?;
    Update::decode_v1(bytes).map_err(|e| YdocError::Decode(e.to_string()))
}

/// Loads an update into a fresh document with garbage collection on, refusing one with
/// missing dependencies.
fn load(update: &[u8]) -> Result<Doc> {
    let parsed = decode(update)?;
    let doc = Doc::with_options(Options {
        skip_gc: false,
        ..Options::default()
    });
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(parsed)
            .map_err(|e| YdocError::Apply(e.to_string()))?;
        if txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() {
            return Err(YdocError::MissingDependencies);
        }
    }
    Ok(doc)
}

/// Merges updates into one, without loading a document (no garbage collection).
pub fn merge(updates: &[&[u8]]) -> Result<Vec<u8>> {
    for update in updates {
        decode(update)?;
    }
    yrs::merge_updates_v1(updates.iter().copied()).map_err(|e| YdocError::Decode(e.to_string()))
}

/// The state vector an update brings a document to.
pub fn state_vector(update: &[u8]) -> Result<Vec<u8>> {
    decode(update)?;
    yrs::encode_state_vector_from_update_v1(update).map_err(|e| YdocError::Decode(e.to_string()))
}

/// What `update` holds that a peer at `state_vector` lacks.
pub fn diff(update: &[u8], state_vector: &[u8]) -> Result<Vec<u8>> {
    decode(update)?;
    check_size(state_vector)?;
    StateVector::decode_v1(state_vector).map_err(|e| YdocError::Decode(e.to_string()))?;
    yrs::diff_updates_v1(update, state_vector).map_err(|e| YdocError::Decode(e.to_string()))
}

/// The document's whole state as one update, with deleted content garbage-collected.
pub fn compact(update: &[u8]) -> Result<Vec<u8>> {
    let doc = load(update)?;
    let txn = doc.transact();
    Ok(txn.encode_state_as_update_v1(&StateVector::default()))
}

/// One client's run of clocks in an update: `[start, end)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientRange {
    pub client: u64,
    pub start: u32,
    pub end: u32,
}

/// The client ids an update writes as, with the clock range of each, and the clients whose
/// content it deletes. The worker checks these against the pushing device's pool (S7).
pub fn client_ranges(update: &[u8]) -> Result<(Vec<ClientRange>, Vec<u64>)> {
    let parsed = decode(update)?;
    // From the blocks the update inserts, deleted and collected ones included: every client it
    // writes as, wherever its clocks start. (`Update::state_vector` counts a client only when its
    // blocks start at clock 0, so an update continuing a client, the second keystroke on, named
    // no client at all, and the check that it is the pusher's never ran.)
    let mut ranges: Vec<ClientRange> = parsed
        .insertions(true)
        .iter()
        .filter_map(|(client, clocks)| {
            let (start, end) = clocks.iter().fold((u32::MAX, 0), |(start, end), range| {
                (start.min(range.start), end.max(range.end))
            });
            (end > start).then(|| ClientRange {
                client: client.get(),
                start,
                end,
            })
        })
        .collect();
    ranges.sort_by_key(|r| r.client);
    let mut deleting: Vec<u64> = parsed
        .delete_set()
        .iter()
        .map(|(client, _)| client.get())
        .collect();
    deleting.sort_unstable();
    deleting.dedup();
    Ok((ranges, deleting))
}

pub fn to_json_ranges(ranges: &[ClientRange], deleting: &[u64]) -> String {
    let list: Vec<Value> = ranges
        .iter()
        .map(|r| serde_json::json!({ "client": r.client, "start": r.start, "end": r.end }))
        .collect();
    serde_json::json!({ "ranges": list, "deletes": deleting }).to_string()
}

fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(Number::Int(n)) => Value::from(*n),
        Any::Number(Number::Float(n)) => {
            serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number)
        }
        Any::String(s) => Value::String(s.to_string()),
        Any::Buffer(b) => Value::Array(b.iter().map(|x| Value::from(*x)).collect()),
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), any_to_json(v)))
                .collect(),
        ),
    }
}

fn out_to_json(out: &Out) -> Result<Value> {
    match out {
        Out::Any(any) => Ok(any_to_json(any)),
        other => Err(YdocError::Shape(format!(
            "an attribute holds a shared type: {other:?}"
        ))),
    }
}

/// A mark's name from its text attribute: overlapping marks carry `--hash` (y-prosemirror).
fn mark_name(attribute: &str) -> &str {
    attribute.split("--").next().unwrap_or(attribute)
}

fn marks_json(attributes: &Attrs) -> Vec<Value> {
    let mut marks: Vec<Value> = attributes
        .iter()
        .map(|(key, value)| {
            let mut mark = Map::new();
            mark.insert("type".into(), Value::String(mark_name(key).to_string()));
            if let Value::Object(attrs) = any_to_json(value) {
                if !attrs.is_empty() {
                    mark.insert("attrs".into(), Value::Object(attrs));
                }
            }
            Value::Object(mark)
        })
        .collect();
    marks.sort_by(|a, b| a["type"].as_str().cmp(&b["type"].as_str()));
    marks
}

fn node_json<T: ReadTxn>(txn: &T, node: &XmlOut, depth: usize, out: &mut Vec<Value>) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(YdocError::Shape(format!("nested deeper than {MAX_DEPTH}")));
    }
    match node {
        XmlOut::Text(text) => {
            for chunk in text.diff(txn, YChange::identity) {
                let insert = match &chunk.insert {
                    Out::Any(Any::String(s)) => s.to_string(),
                    other => {
                        return Err(YdocError::Shape(format!("text holds an embed: {other:?}")))
                    }
                };
                let mut json = Map::new();
                json.insert("type".into(), Value::String("text".into()));
                json.insert("text".into(), Value::String(insert));
                if let Some(attributes) = &chunk.attributes {
                    if !attributes.is_empty() {
                        json.insert("marks".into(), Value::Array(marks_json(attributes)));
                    }
                }
                // Adjacent runs with the same marks are one text node, as ProseMirror keeps them.
                if let Some(Value::Object(previous)) = out.last_mut() {
                    if previous.get("type") == Some(&Value::String("text".into()))
                        && previous.get("marks") == json.get("marks")
                    {
                        let joined = format!(
                            "{}{}",
                            previous["text"].as_str().unwrap_or_default(),
                            json["text"].as_str().unwrap_or_default()
                        );
                        previous.insert("text".into(), Value::String(joined));
                        continue;
                    }
                }
                out.push(Value::Object(json));
            }
        }
        XmlOut::Element(element) => {
            let mut json = Map::new();
            json.insert("type".into(), Value::String(element.tag().to_string()));
            let mut attrs = Map::new();
            for (key, value) in element.attributes(txn) {
                attrs.insert(key.to_string(), out_to_json(&value)?);
            }
            if !attrs.is_empty() {
                json.insert("attrs".into(), Value::Object(attrs));
            }
            // As y-prosemirror: `content` is present whenever the element has children, even
            // when they hold no text (an empty text node gives `[]`).
            let mut content = Vec::new();
            let mut has_children = false;
            for child in element.children(txn) {
                has_children = true;
                node_json(txn, &child, depth + 1, &mut content)?;
            }
            if has_children {
                json.insert("content".into(), Value::Array(content));
            }
            out.push(Value::Object(json));
        }
        XmlOut::Fragment(_) => return Err(YdocError::Shape("a fragment inside content".into())),
    }
    Ok(())
}

/// The ProseMirror JSON of the named fragment, as y-prosemirror reads it; for the derived JSON
/// and search text the worker keeps for every page.
pub fn to_prosemirror_json(update: &[u8], fragment: &str) -> Result<String> {
    let doc = load(update)?;
    let root = doc.get_or_insert_xml_fragment(fragment);
    let txn = doc.transact();
    let mut content = Vec::new();
    for child in root.children(&txn) {
        node_json(&txn, &child, 1, &mut content)?;
    }
    Ok(serde_json::json!({ "type": "doc", "content": content }).to_string())
}

fn collect_text<T: ReadTxn>(txn: &T, node: &XmlOut, depth: usize, out: &mut String) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(YdocError::Shape(format!("nested deeper than {MAX_DEPTH}")));
    }
    match node {
        XmlOut::Text(text) => {
            for chunk in text.diff(txn, YChange::identity) {
                if let Out::Any(Any::String(s)) = &chunk.insert {
                    out.push_str(s);
                }
            }
        }
        XmlOut::Element(element) => {
            let mut inner = String::new();
            for child in element.children(txn) {
                collect_text(txn, &child, depth + 1, &mut inner)?;
            }
            // Each text body ends a line, so words in two blocks never run together.
            let has_text = element.children(txn).any(|c| matches!(c, XmlOut::Text(_)));
            out.push_str(&inner);
            if has_text && !inner.ends_with('\n') {
                out.push('\n');
            }
        }
        XmlOut::Fragment(_) => {}
    }
    Ok(())
}

/// Plain text, one line per text body, for search.
pub fn to_plain_text(update: &[u8], fragment: &str) -> Result<String> {
    let doc = load(update)?;
    let root = doc.get_or_insert_xml_fragment(fragment);
    let txn = doc.transact();
    let mut out = String::new();
    for child in root.children(&txn) {
        collect_text(&txn, &child, 1, &mut out)?;
    }
    Ok(out)
}

/// `meta.schemaVersion` and `meta.epoch` (DATA_MODEL.md), as JSON.
pub fn meta_json(update: &[u8]) -> Result<String> {
    use yrs::Map as _;
    let doc = load(update)?;
    let meta = doc.get_or_insert_map(META);
    let txn = doc.transact();
    let mut out = Map::new();
    for (key, value) in meta.iter(&txn) {
        out.insert(key.to_string(), out_to_json(&value)?);
    }
    Ok(Value::Object(out).to_string())
}

#[cfg(test)]
mod hostile_tests;
#[cfg(test)]
mod tests;

/// What the worker allows in a pushed update (S7). Empty lists allow everything of that kind.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    /// Yjs client ids the pushing device may write as (Q9: a pool per device).
    pub clients: Vec<u64>,
    /// Element names the document's schema version knows.
    pub elements: Vec<String>,
    pub max_bytes: usize,
    /// Every `block` element's `id`, when it has one, is 12 base-62 characters (D4).
    pub block_ids: bool,
}

/// A block id as the editor mints them: 12 characters of base 62 (DATA_MODEL.md, Identifiers).
fn valid_block_id(id: &str) -> bool {
    id.len() == 12 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Link schemes allowed when a link is parsed, drawn or clicked (ARCHITECTURE.md, Links).
fn safe_href(href: &str) -> bool {
    let lower = href.trim().to_ascii_lowercase();
    ["https:", "http:", "mailto:", "tel:", "#", "/"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

fn check_tree<T: ReadTxn>(
    txn: &T,
    node: &XmlOut,
    depth: usize,
    policy: &Policy,
    problems: &mut Vec<String>,
) {
    if depth > MAX_DEPTH {
        problems.push(format!("nested deeper than {MAX_DEPTH}"));
        return;
    }
    match node {
        XmlOut::Element(element) => {
            let name = element.tag().to_string();
            if !policy.elements.is_empty() && !policy.elements.contains(&name) {
                problems.push(format!("unknown element <{name}>"));
            }
            for (key, value) in element.attributes(txn) {
                if !matches!(value, Out::Any(_)) {
                    problems.push(format!("<{name}> attribute {key:.40} holds a shared type"));
                } else if policy.block_ids && name == "block" && key == "id" {
                    let ok = matches!(&value, Out::Any(Any::String(id)) if valid_block_id(id));
                    if !ok {
                        problems.push("a block id that is not 12 base-62 characters".into());
                    }
                }
            }
            for child in element.children(txn) {
                check_tree(txn, &child, depth + 1, policy, problems);
                if problems.len() > 20 {
                    return;
                }
            }
        }
        XmlOut::Text(text) => {
            for chunk in text.diff(txn, YChange::identity) {
                let Some(attributes) = &chunk.attributes else {
                    continue;
                };
                for (key, value) in attributes.iter() {
                    if mark_name(key) != "link" {
                        continue;
                    }
                    let href = match any_to_json(value).get("href") {
                        Some(Value::String(h)) => h.clone(),
                        _ => String::new(),
                    };
                    if !href.is_empty() && !safe_href(&href) {
                        problems.push(format!("link with an unsafe scheme: {href:.40}"));
                    }
                }
            }
        }
        XmlOut::Fragment(_) => problems.push("a fragment inside content".into()),
    }
}

/// Checks an update pushed on top of `state` (the page's current state as one update) against
/// `policy`. Returns the problems found; an empty list means the update may be kept.
pub fn validate(state: &[u8], update: &[u8], policy: &Policy) -> Result<Vec<String>> {
    let mut problems = Vec::new();
    if policy.max_bytes > 0 && update.len() > policy.max_bytes {
        problems.push(format!(
            "{} bytes is over the {}-byte limit",
            update.len(),
            policy.max_bytes
        ));
        return Ok(problems);
    }
    let (ranges, _) = client_ranges(update)?;
    if !policy.clients.is_empty() {
        for range in &ranges {
            if !policy.clients.contains(&range.client) {
                problems.push(format!(
                    "writes as client {} outside the device's pool",
                    range.client
                ));
            }
        }
    }
    let merged = if state.is_empty() {
        update.to_vec()
    } else {
        merge(&[state, update])?
    };
    let doc = load(&merged)?;
    let root = doc.get_or_insert_xml_fragment(CONTENT);
    let txn = doc.transact();
    for child in root.children(&txn) {
        check_tree(&txn, &child, 1, policy, &mut problems);
    }
    Ok(problems)
}
