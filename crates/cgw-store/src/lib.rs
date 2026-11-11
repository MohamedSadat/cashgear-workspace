//! The desktop's LocalStore on SQLite (D11). The webview never sends SQL: it sends one of a fixed
//! set of typed requests, each run as one transaction. Requests and answers are binary frames, a
//! JSON header and raw byte blobs, so Yjs updates and file bytes cross the Tauri boundary as bytes,
//! never base64 (SYNC_DESIGN.md, "The local store").
//!
//! Frame: `u32 LE` header length, the UTF-8 JSON header, `u32 LE` blob count, then for each blob a
//! `u32 LE` length and its bytes.
//!
//! The tree rules are planned in TypeScript (`@cgw/workspace`'s planner) against the in-memory
//! mirror; this store writes the plan's records, deletes and outbox entries together.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The store schema version this build reads and writes.
pub const SCHEMA_VERSION: i64 = 1;

/// The largest frame accepted: a few large images and a page's log fit well inside.
pub const MAX_FRAME: usize = 256 * 1024 * 1024;

#[derive(Debug)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError(format!("sqlite: {error}"))
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        StoreError(format!("json: {error}"))
    }
}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        StoreError(format!("io: {error}"))
    }
}

type Result<T> = std::result::Result<T, StoreError>;

fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(StoreError(message.into()))
}

/// A decoded frame: the JSON header and the blobs after it.
pub struct Frame {
    pub header: Value,
    pub blobs: Vec<Vec<u8>>,
}

fn read_u32(bytes: &[u8], at: &mut usize) -> Result<usize> {
    let end = at.checked_add(4).filter(|end| *end <= bytes.len());
    let Some(end) = end else {
        return fail("frame: truncated length");
    };
    let value = u32::from_le_bytes(bytes[*at..end].try_into().unwrap()) as usize;
    *at = end;
    Ok(value)
}

pub fn decode_frame(bytes: &[u8]) -> Result<Frame> {
    if bytes.len() > MAX_FRAME {
        return fail("frame: too large");
    }
    let mut at = 0;
    let header_len = read_u32(bytes, &mut at)?;
    if header_len > bytes.len() - at {
        return fail("frame: header longer than the frame");
    }
    let header: Value = serde_json::from_slice(&bytes[at..at + header_len])?;
    at += header_len;
    let count = read_u32(bytes, &mut at)?;
    if count > 1_000_000 {
        return fail("frame: too many blobs");
    }
    let mut blobs = Vec::with_capacity(count.min(1024));
    for _ in 0..count {
        let len = read_u32(bytes, &mut at)?;
        if len > bytes.len() - at {
            return fail("frame: blob longer than the frame");
        }
        blobs.push(bytes[at..at + len].to_vec());
        at += len;
    }
    if at != bytes.len() {
        return fail("frame: bytes after the last blob");
    }
    Ok(Frame { header, blobs })
}

pub fn encode_frame(header: &Value, blobs: &[Vec<u8>]) -> Vec<u8> {
    let header = serde_json::to_vec(header).expect("a JSON value always serialises");
    let size = 8 + header.len() + blobs.iter().map(|b| 4 + b.len()).sum::<usize>();
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
    for blob in blobs {
        out.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        out.extend_from_slice(blob);
    }
    out
}

/// Ids are lower-case UUIDs: anything else is refused before it reaches SQL or a file name.
fn check_id(id: &str) -> Result<&str> {
    let ok = id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        });
    if ok {
        Ok(id)
    } else {
        fail(format!("not an id: {id:.40}"))
    }
}

fn str_of<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError(format!("missing string \"{key}\"")))
}

fn i64_of(value: &Value, key: &str) -> Result<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| StoreError(format!("missing number \"{key}\"")))
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, section_id TEXT NOT NULL, parent_id TEXT,
  trashed_at TEXT, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS pages_workspace ON pages (workspace_id);
CREATE INDEX IF NOT EXISTS pages_parent ON pages (parent_id);
CREATE TABLE IF NOT EXISTS favourites (workspace_id TEXT NOT NULL, page_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (workspace_id, page_id));
CREATE TABLE IF NOT EXISTS visits (workspace_id TEXT NOT NULL, page_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (workspace_id, page_id));
CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS doc_logs (page_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL, snapshot BLOB, snapshot_covers INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS doc_updates (
  page_id TEXT NOT NULL, local_seq INTEGER NOT NULL, update_id TEXT NOT NULL, data BLOB NOT NULL, seq INTEGER,
  PRIMARY KEY (page_id, local_seq));
CREATE TABLE IF NOT EXISTS corrupt (
  id INTEGER PRIMARY KEY, page_id TEXT NOT NULL, local_seq INTEGER NOT NULL, update_id TEXT NOT NULL,
  data BLOB NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, created_at TEXT NOT NULL, size_bytes INTEGER NOT NULL, data BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS history_page ON history (page_id);
CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  page_id UNINDEXED, workspace_id UNINDEXED, title, text, tokenize = 'unicode61 remove_diacritics 0');
"#;

pub struct Store {
    conn: Connection,
    assets: PathBuf,
}

impl Store {
    /// Opens (or creates) the store in a directory: `workspace.db` and an `assets` folder.
    pub fn open(dir: &Path) -> Result<Store> {
        fs::create_dir_all(dir.join("assets"))?;
        let conn = Connection::open(dir.join("workspace.db"))?;
        // WAL with NORMAL survives a killed process; every method is one transaction.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
        )?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schemaVersion'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);
        if let Some(version) = existing.and_then(|v| v.parse::<i64>().ok()) {
            if version > SCHEMA_VERSION {
                // Never wipe a newer store: its outbox may hold unsent work (SYNC_DESIGN.md).
                return fail(format!(
                    "This store was written by a newer version ({version}); update the app."
                ));
            }
        }
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schemaVersion', ?1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(Store {
            conn,
            assets: dir.join("assets"),
        })
    }

    /// Runs one request frame and returns the answer frame. Errors are answers too.
    pub fn handle(&mut self, request: &[u8]) -> Vec<u8> {
        let result = decode_frame(request).and_then(|frame| self.dispatch(frame));
        match result {
            Ok((value, blobs)) => encode_frame(&json!({ "ok": value }), &blobs),
            Err(error) => encode_frame(&json!({ "error": error.0 }), &[]),
        }
    }

    fn dispatch(&mut self, frame: Frame) -> Result<(Value, Vec<Vec<u8>>)> {
        let Frame { header, blobs } = frame;
        let op = str_of(&header, "op")?.to_owned();
        let none = |value: Value| Ok((value, Vec::new()));
        match op.as_str() {
            "schemaVersion" => none(json!(SCHEMA_VERSION)),
            "loadDoc" => self.load_doc(check_id(str_of(&header, "pageId")?)?),
            "appendDocUpdates" => none(self.append_doc_updates(&header, blobs)?),
            "compactDoc" => none(self.compact_doc(&header, blobs)?),
            "quarantineUpdates" => none(self.quarantine(&header)?),
            "docLogLength" => none(self.doc_log_length(check_id(str_of(&header, "pageId")?)?)?),
            "addHistory" => none(self.add_history(&header, blobs)?),
            "listHistory" => none(self.list_history(check_id(str_of(&header, "pageId")?)?)?),
            "getHistory" => self.get_history(check_id(str_of(&header, "id")?)?),
            "readMirror" => {
                none(self.read_mirror(header.get("workspaceId").and_then(Value::as_str))?)
            }
            "applyPlan" => none(self.apply_plan(&header["plan"])?),
            "nextOutboxBatch" => none(self.next_outbox(i64_of(&header, "limit")?)?),
            "settleOps" => none(self.settle_ops(&header)?),
            "putSearchEntry" => none(self.put_search(&header["entry"])?),
            "deleteSearchEntries" => none(self.delete_search(&header)?),
            "search" => none(self.search(&header)?),
            "putAsset" => none(self.put_asset(&header["asset"], blobs)?),
            "getAssetBytes" => self.get_asset(check_id(str_of(&header, "id")?)?),
            "getPref" => none(self.get_pref(str_of(&header, "key")?)?),
            "setPref" => none(self.set_pref(str_of(&header, "key")?, &header["value"])?),
            other => fail(format!("unknown request: {other:.40}")),
        }
    }

    // Documents ----------------------------------------------------------------------------------

    fn load_doc(&mut self, page: &str) -> Result<(Value, Vec<Vec<u8>>)> {
        let tx = self.conn.transaction()?;
        let log: Option<(Option<Vec<u8>>, i64)> = tx
            .query_row(
                "SELECT snapshot, snapshot_covers FROM doc_logs WHERE page_id = ?1",
                params![page],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let mut blobs = Vec::new();
        let (snapshot, covers) = log.unwrap_or((None, 0));
        let has_snapshot = snapshot.is_some();
        if let Some(bytes) = snapshot {
            blobs.push(bytes);
        }
        let mut updates = Vec::new();
        {
            let mut statement = tx.prepare(
                "SELECT update_id, local_seq, seq, data FROM doc_updates WHERE page_id = ?1 ORDER BY local_seq",
            )?;
            let rows = statement.query_map(params![page], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            })?;
            for row in rows {
                let (update_id, local_seq, seq, data) = row?;
                updates.push(json!({ "updateId": update_id, "localSeq": local_seq, "seq": seq }));
                blobs.push(data);
            }
        }
        tx.commit()?;
        Ok((
            json!({ "hasSnapshot": has_snapshot, "snapshotCovers": covers, "updates": updates }),
            blobs,
        ))
    }

    fn append_doc_updates(&mut self, header: &Value, blobs: Vec<Vec<u8>>) -> Result<Value> {
        let page = check_id(str_of(header, "pageId")?)?.to_owned();
        let ids: Vec<String> = serde_json::from_value(header["updateIds"].clone())?;
        if ids.len() != blobs.len() {
            return fail("appendDocUpdates: one id per update");
        }
        let tx = self.conn.transaction()?;
        let mut next: i64 = tx
            .query_row(
                "SELECT next_seq FROM doc_logs WHERE page_id = ?1",
                params![page],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(1);
        let mut seqs = Vec::with_capacity(ids.len());
        for (id, data) in ids.iter().zip(blobs) {
            check_id(id)?;
            tx.execute(
                "INSERT INTO doc_updates (page_id, local_seq, update_id, data, seq) VALUES (?1, ?2, ?3, ?4, NULL)",
                params![page, next, id, data],
            )?;
            seqs.push(next);
            next += 1;
        }
        tx.execute(
            "INSERT INTO doc_logs (page_id, next_seq, snapshot, snapshot_covers) VALUES (?1, ?2, NULL, 0)
             ON CONFLICT (page_id) DO UPDATE SET next_seq = excluded.next_seq",
            params![page, next],
        )?;
        tx.commit()?;
        Ok(json!(seqs))
    }

    fn compact_doc(&mut self, header: &Value, mut blobs: Vec<Vec<u8>>) -> Result<Value> {
        let page = check_id(str_of(header, "pageId")?)?.to_owned();
        let covers = i64_of(header, "coversLocalUpTo")?;
        let Some(snapshot) = blobs.pop() else {
            return fail("compactDoc: no snapshot");
        };
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO doc_logs (page_id, next_seq, snapshot, snapshot_covers) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (page_id) DO UPDATE SET snapshot = excluded.snapshot,
               snapshot_covers = MAX(doc_logs.snapshot_covers, excluded.snapshot_covers),
               next_seq = MAX(doc_logs.next_seq, excluded.next_seq)",
            params![page, covers + 1, snapshot, covers],
        )?;
        tx.execute(
            "DELETE FROM doc_updates WHERE page_id = ?1 AND local_seq <= ?2",
            params![page, covers],
        )?;
        tx.commit()?;
        Ok(Value::Null)
    }

    fn quarantine(&mut self, header: &Value) -> Result<Value> {
        let page = check_id(str_of(header, "pageId")?)?.to_owned();
        let seqs: Vec<i64> = serde_json::from_value(header["localSeqs"].clone())?;
        let reason = str_of(header, "reason")?.to_owned();
        let tx = self.conn.transaction()?;
        for seq in seqs {
            tx.execute(
                "INSERT INTO corrupt (page_id, local_seq, update_id, data, reason, at)
                 SELECT page_id, local_seq, update_id, data, ?3, datetime('now') FROM doc_updates
                 WHERE page_id = ?1 AND local_seq = ?2",
                params![page, seq, reason],
            )?;
            tx.execute(
                "DELETE FROM doc_updates WHERE page_id = ?1 AND local_seq = ?2",
                params![page, seq],
            )?;
        }
        tx.commit()?;
        Ok(Value::Null)
    }

    fn doc_log_length(&mut self, page: &str) -> Result<Value> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM doc_updates WHERE page_id = ?1",
            params![page],
            |r| r.get(0),
        )?;
        Ok(json!(n))
    }

    // History ------------------------------------------------------------------------------------

    fn add_history(&mut self, header: &Value, mut blobs: Vec<Vec<u8>>) -> Result<Value> {
        let entry = &header["entry"];
        let id = check_id(str_of(entry, "id")?)?.to_owned();
        let page = check_id(str_of(entry, "pageId")?)?.to_owned();
        let created = str_of(entry, "createdAt")?.to_owned();
        let keep = i64_of(header, "keep")?;
        let Some(data) = blobs.pop() else {
            return fail("addHistory: no snapshot");
        };
        let size = data.len() as i64;
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO history (id, page_id, created_at, size_bytes, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, page, created, size, data],
        )?;
        tx.execute(
            "DELETE FROM history WHERE page_id = ?1 AND id NOT IN
               (SELECT id FROM history WHERE page_id = ?1 ORDER BY id DESC LIMIT ?2)",
            params![page, keep],
        )?;
        tx.commit()?;
        Ok(json!({ "id": id, "pageId": page, "createdAt": created, "sizeBytes": size }))
    }

    fn list_history(&mut self, page: &str) -> Result<Value> {
        let mut statement = self.conn.prepare(
            "SELECT id, created_at, size_bytes FROM history WHERE page_id = ?1 ORDER BY id DESC",
        )?;
        let rows = statement.query_map(params![page], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "pageId": page,
                "createdAt": r.get::<_, String>(1)?,
                "sizeBytes": r.get::<_, i64>(2)?,
            }))
        })?;
        Ok(Value::Array(rows.collect::<rusqlite::Result<_>>()?))
    }

    fn get_history(&mut self, id: &str) -> Result<(Value, Vec<Vec<u8>>)> {
        let data: Option<Vec<u8>> = self
            .conn
            .query_row("SELECT data FROM history WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(match data {
            Some(bytes) => (json!(true), vec![bytes]),
            None => (json!(false), Vec::new()),
        })
    }

    // Mirror and outbox --------------------------------------------------------------------------

    fn read_mirror(&mut self, workspace: Option<&str>) -> Result<Value> {
        if let Some(id) = workspace {
            check_id(id)?;
        }
        let tx = self.conn.transaction()?;
        let read = |sql_all: &str, sql_one: &str| -> Result<Vec<Value>> {
            let mut statement = tx.prepare(if workspace.is_some() {
                sql_one
            } else {
                sql_all
            })?;
            let mut out = Vec::new();
            let mut rows = match workspace {
                Some(id) => statement.query(params![id])?,
                None => statement.query([])?,
            };
            while let Some(row) = rows.next()? {
                let body: String = row.get(0)?;
                out.push(serde_json::from_str(&body)?);
            }
            Ok(out)
        };
        let snapshot = json!({
            "workspaces": read("SELECT body FROM workspaces", "SELECT body FROM workspaces WHERE id = ?1")?,
            "sections": read("SELECT body FROM sections", "SELECT body FROM sections WHERE workspace_id = ?1")?,
            "pages": read("SELECT body FROM pages", "SELECT body FROM pages WHERE workspace_id = ?1")?,
            "favourites": read("SELECT body FROM favourites", "SELECT body FROM favourites WHERE workspace_id = ?1")?,
            "visits": read("SELECT body FROM visits", "SELECT body FROM visits WHERE workspace_id = ?1")?,
            "assets": read("SELECT body FROM assets", "SELECT body FROM assets WHERE workspace_id = ?1")?,
        });
        tx.commit()?;
        Ok(snapshot)
    }

    /// Writes a plan from `@cgw/workspace`'s planner: records, deletes and the outbox, together.
    fn apply_plan(&mut self, plan: &Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Pair {
            workspace_id: String,
            page_id: String,
        }
        let list = |key: &str| {
            plan.get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let tx = self.conn.transaction()?;
        for w in list("workspaces") {
            tx.execute(
                "INSERT OR REPLACE INTO workspaces (id, body) VALUES (?1, ?2)",
                params![check_id(str_of(&w, "id")?)?, w.to_string()],
            )?;
        }
        for s in list("sections") {
            tx.execute(
                "INSERT OR REPLACE INTO sections (id, workspace_id, body) VALUES (?1, ?2, ?3)",
                params![
                    check_id(str_of(&s, "id")?)?,
                    check_id(str_of(&s, "workspaceId")?)?,
                    s.to_string()
                ],
            )?;
        }
        for id in list("deleteSections") {
            tx.execute(
                "DELETE FROM sections WHERE id = ?1",
                params![check_id(id.as_str().unwrap_or(""))?],
            )?;
        }
        for p in list("pages") {
            let parent = p.get("parentPageId").and_then(Value::as_str);
            if let Some(parent) = parent {
                check_id(parent)?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO pages (id, workspace_id, section_id, parent_id, trashed_at, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    check_id(str_of(&p, "id")?)?,
                    check_id(str_of(&p, "workspaceId")?)?,
                    check_id(str_of(&p, "sectionId")?)?,
                    parent,
                    p.get("trashedAt").and_then(Value::as_str),
                    p.to_string()
                ],
            )?;
        }
        for (table, key) in [("favourites", "favourites"), ("visits", "visits")] {
            for f in list(key) {
                tx.execute(
                    &format!("INSERT OR REPLACE INTO {table} (workspace_id, page_id, body) VALUES (?1, ?2, ?3)"),
                    params![check_id(str_of(&f, "workspaceId")?)?, check_id(str_of(&f, "pageId")?)?, f.to_string()],
                )?;
            }
        }
        for (table, key) in [
            ("favourites", "deleteFavourites"),
            ("visits", "deleteVisits"),
        ] {
            for f in list(key) {
                let pair: Pair = serde_json::from_value(f)?;
                tx.execute(
                    &format!("DELETE FROM {table} WHERE workspace_id = ?1 AND page_id = ?2"),
                    params![check_id(&pair.workspace_id)?, check_id(&pair.page_id)?],
                )?;
            }
        }
        for op in list("outbox") {
            tx.execute(
                "INSERT INTO outbox (op_id, body) VALUES (?1, ?2)",
                params![check_id(str_of(&op, "opId")?)?, op.to_string()],
            )?;
        }
        for id in list("deletePages") {
            let id = check_id(id.as_str().unwrap_or(""))?.to_owned();
            drop_page(&tx, &id)?;
        }
        tx.commit()?;
        Ok(Value::Null)
    }

    fn next_outbox(&mut self, limit: i64) -> Result<Value> {
        let mut statement = self
            .conn
            .prepare("SELECT body FROM outbox ORDER BY seq LIMIT ?1")?;
        let rows = statement.query_map(params![limit], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str::<Value>(&row?)?);
        }
        Ok(Value::Array(out))
    }

    fn settle_ops(&mut self, header: &Value) -> Result<Value> {
        let ids: Vec<String> = serde_json::from_value(header["opIds"].clone())?;
        let tx = self.conn.transaction()?;
        for id in ids {
            tx.execute(
                "DELETE FROM outbox WHERE op_id = ?1",
                params![check_id(&id)?],
            )?;
        }
        tx.commit()?;
        Ok(Value::Null)
    }

    // Search: the caller sends normalised text (D25); FTS5 matches word prefixes ------------------

    fn put_search(&mut self, entry: &Value) -> Result<Value> {
        let page = check_id(str_of(entry, "pageId")?)?.to_owned();
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM search WHERE page_id = ?1", params![page])?;
        tx.execute(
            "INSERT INTO search (page_id, workspace_id, title, text) VALUES (?1, ?2, ?3, ?4)",
            params![
                page,
                check_id(str_of(entry, "workspaceId")?)?,
                str_of(entry, "title")?,
                str_of(entry, "text")?
            ],
        )?;
        tx.commit()?;
        Ok(Value::Null)
    }

    fn delete_search(&mut self, header: &Value) -> Result<Value> {
        let ids: Vec<String> = serde_json::from_value(header["pageIds"].clone())?;
        let tx = self.conn.transaction()?;
        for id in ids {
            tx.execute(
                "DELETE FROM search WHERE page_id = ?1",
                params![check_id(&id)?],
            )?;
        }
        tx.commit()?;
        Ok(Value::Null)
    }

    fn search(&mut self, header: &Value) -> Result<Value> {
        let workspace = check_id(str_of(header, "workspaceId")?)?.to_owned();
        let query = str_of(header, "query")?;
        let limit = i64_of(header, "limit")?.clamp(1, 200);
        // Each normalised term as a quoted prefix; every term must match.
        let expression = query
            .split(' ')
            .filter(|term| !term.is_empty())
            .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        if expression.is_empty() {
            return Ok(json!([]));
        }
        let mut statement = self.conn.prepare(
            "SELECT s.page_id, s.title, s.text FROM search s JOIN pages p ON p.id = s.page_id
             WHERE search MATCH ?1 AND s.workspace_id = ?2 AND p.trashed_at IS NULL
             ORDER BY bm25(search, 0.0, 0.0, 4.0, 1.0) LIMIT ?3",
        )?;
        let rows = statement.query_map(params![expression, workspace, limit], |r| {
            Ok(json!({
                "pageId": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "text": r.get::<_, String>(2)?,
            }))
        })?;
        Ok(Value::Array(rows.collect::<rusqlite::Result<_>>()?))
    }

    // Assets and preferences ---------------------------------------------------------------------

    fn put_asset(&mut self, asset: &Value, mut blobs: Vec<Vec<u8>>) -> Result<Value> {
        let id = check_id(str_of(asset, "id")?)?.to_owned();
        let Some(bytes) = blobs.pop() else {
            return fail("putAsset: no bytes");
        };
        // The file first, then the record: a record never points at a missing file.
        let path = self.assets.join(&id);
        let temporary = self.assets.join(format!("{id}.part"));
        {
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        fs::rename(&temporary, &path)?;
        self.conn.execute(
            "INSERT OR REPLACE INTO assets (id, workspace_id, body) VALUES (?1, ?2, ?3)",
            params![
                id,
                check_id(str_of(asset, "workspaceId")?)?,
                asset.to_string()
            ],
        )?;
        Ok(Value::Null)
    }

    fn get_asset(&mut self, id: &str) -> Result<(Value, Vec<Vec<u8>>)> {
        match fs::read(self.assets.join(id)) {
            Ok(bytes) => Ok((json!(true), vec![bytes])),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok((json!(false), Vec::new()))
            }
            Err(error) => Err(error.into()),
        }
    }

    fn get_pref(&mut self, key: &str) -> Result<Value> {
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM prefs WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match value {
            Some(text) => serde_json::from_str(&text)?,
            None => Value::Null,
        })
    }

    fn set_pref(&mut self, key: &str, value: &Value) -> Result<Value> {
        self.conn.execute(
            "INSERT OR REPLACE INTO prefs (key, value) VALUES (?1, ?2)",
            params![key, value.to_string()],
        )?;
        Ok(Value::Null)
    }
}

/// A page removed for good: its record, document, history, search entry, favourites and visits.
fn drop_page(tx: &Transaction, id: &str) -> Result<()> {
    for sql in [
        "DELETE FROM pages WHERE id = ?1",
        "DELETE FROM doc_logs WHERE page_id = ?1",
        "DELETE FROM doc_updates WHERE page_id = ?1",
        "DELETE FROM history WHERE page_id = ?1",
        "DELETE FROM search WHERE page_id = ?1",
        "DELETE FROM favourites WHERE page_id = ?1",
        "DELETE FROM visits WHERE page_id = ?1",
    ] {
        tx.execute(sql, params![id])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

    fn call(store: &mut Store, header: Value, blobs: &[Vec<u8>]) -> (Value, Vec<Vec<u8>>) {
        let answer = decode_frame(&store.handle(&encode_frame(&header, blobs))).unwrap();
        (answer.header, answer.blobs)
    }

    #[test]
    fn frames_round_trip_and_refuse_lies() {
        let frame = encode_frame(&json!({ "op": "x" }), &[vec![0, 1, 255], vec![]]);
        let decoded = decode_frame(&frame).unwrap();
        assert_eq!(decoded.header["op"], "x");
        assert_eq!(decoded.blobs, vec![vec![0, 1, 255], vec![]]);
        let mut lying = frame.clone();
        lying[0] = 255;
        assert!(decode_frame(&lying).is_err());
        assert!(decode_frame(&frame[..frame.len() - 1]).is_err());
        let mut extra = frame;
        extra.push(0);
        assert!(decode_frame(&extra).is_err());
    }

    #[test]
    fn keeps_document_updates_as_bytes_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let (answer, _) = call(
            &mut store,
            json!({ "op": "appendDocUpdates", "pageId": PAGE, "updateIds": [PAGE, PAGE] }),
            &[vec![1, 0, 2], vec![9]],
        );
        assert_eq!(answer["ok"], json!([1, 2]));
        let (answer, blobs) = call(&mut store, json!({ "op": "loadDoc", "pageId": PAGE }), &[]);
        assert_eq!(answer["ok"]["hasSnapshot"], false);
        assert_eq!(blobs, vec![vec![1, 0, 2], vec![9]]);
        // Survives closing and opening again.
        drop(store);
        let mut store = Store::open(dir.path()).unwrap();
        let (_, blobs) = call(&mut store, json!({ "op": "loadDoc", "pageId": PAGE }), &[]);
        assert_eq!(blobs.len(), 2);
    }

    #[test]
    fn refuses_what_is_not_an_id_or_a_request() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let (answer, _) = call(
            &mut store,
            json!({ "op": "getAssetBytes", "id": "../../secrets" }),
            &[],
        );
        assert!(answer["error"].as_str().unwrap().contains("not an id"));
        let (answer, _) = call(&mut store, json!({ "op": "DROP TABLE pages" }), &[]);
        assert!(answer["error"]
            .as_str()
            .unwrap()
            .contains("unknown request"));
    }

    #[test]
    fn refuses_a_store_from_a_newer_version() {
        let dir = tempfile::tempdir().unwrap();
        drop(Store::open(dir.path()).unwrap());
        let conn = Connection::open(dir.path().join("workspace.db")).unwrap();
        conn.execute(
            "UPDATE meta SET value = '99' WHERE key = 'schemaVersion'",
            [],
        )
        .unwrap();
        drop(conn);
        match Store::open(dir.path()) {
            Err(error) => assert!(error.0.contains("newer version")),
            Ok(_) => panic!("a newer store opened"),
        }
    }
}
