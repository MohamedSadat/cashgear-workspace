//! The desktop's LocalStore on SQLite (D11). The webview never sends SQL: it sends one of a fixed
//! set of typed requests, each run as one transaction. Requests and answers are binary frames, a
//! JSON header and raw byte blobs, so Yjs updates and file bytes cross the Tauri boundary as bytes,
//! never base64 (SYNC_DESIGN.md, "The local store").
//!
//! Frame: `u32 LE` header length, the UTF-8 JSON header, `u32 LE` blob count, then for each blob a
//! `u32 LE` length and its bytes.
//!
//! The tree rules are planned in TypeScript (`@cgw/workspace`'s planner) against the in-memory
//! mirror; this store writes the plan's records, deletes and outbox entries together. The server's
//! answers and change feed are planned the same way (`planSettle`, `planRemote`) and written by the
//! same `applyPlan` request.
//!
//! Store schema 2 (Phase 2, cloud sync) adds the sync state: each outbox entry's workspace and
//! entity, a change-feed cursor per workspace, and a document cursor (head sequence and epoch) per
//! page. A synced workspace is one whose JSON body has `localOnly: false`. An older store is copied
//! beside itself (`workspace.v1.db`) and then migrated in one transaction; a newer one is refused,
//! never wiped.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The store schema version this build reads and writes.
pub const SCHEMA_VERSION: i64 = 2;

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

/// An id that may be absent or null.
fn optional_id<'a>(value: &'a Value, key: &str) -> Result<Option<&'a str>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) => check_id(id).map(Some),
        Some(_) => fail(format!("not an id: \"{key}\"")),
    }
}

/// A list of ids under `key`; absent is empty.
fn ids_of(value: &Value, key: &str) -> Result<Vec<String>> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|id| check_id(id.as_str().unwrap_or("")).map(str::to_owned))
        .collect()
}

/// A member that is present and not null.
fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|member| !member.is_null())
}

/// Schema 1, as Phase 1 shipped it. Frozen: a new store starts here and runs every migration, so a
/// new store and a migrated one are the same.
const SCHEMA_V1: &str = r#"
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

/// Schema 2 (Phase 2, cloud sync): the outbox knows each operation's workspace and entity, and the
/// change-feed and document cursors have tables of their own.
const MIGRATE_1_TO_2: &str = r#"
ALTER TABLE outbox ADD COLUMN workspace_id TEXT;
ALTER TABLE outbox ADD COLUMN entity_id TEXT;
UPDATE outbox SET workspace_id = json_extract(body, '$.workspaceId'),
  entity_id = json_extract(body, '$.entityId');
CREATE INDEX outbox_workspace ON outbox (workspace_id);
CREATE TABLE sync_cursors (workspace_id TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE doc_cursors (page_id TEXT PRIMARY KEY, head_seq INTEGER NOT NULL, epoch INTEGER NOT NULL);
CREATE INDEX doc_updates_seq ON doc_updates (seq, page_id);
CREATE INDEX doc_updates_update ON doc_updates (update_id);
CREATE INDEX sections_workspace ON sections (workspace_id);
CREATE INDEX assets_workspace ON assets (workspace_id);
"#;

/// The migrations in order: `MIGRATIONS[n - 1]` takes a store from version `n` to `n + 1`.
const MIGRATIONS: [&str; 1] = [MIGRATE_1_TO_2];
const _: () = assert!(MIGRATIONS.len() as i64 == SCHEMA_VERSION - 1);

/// A workspace that syncs, for a query that names its row `w`: `localOnly` is false in its body.
const SYNCED: &str = "COALESCE(json_extract(w.body, '$.localOnly'), 0) = 0";

/// The schema version a store records; `None` for a new file (no version was ever written).
fn stored_version(conn: &Connection) -> Result<Option<i64>> {
    let has_meta: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta')",
        [],
        |r| r.get(0),
    )?;
    if !has_meta {
        return Ok(None);
    }
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schemaVersion'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match value {
        None => Ok(None),
        Some(text) => match text.parse::<i64>() {
            Ok(version) if version >= 1 => Ok(Some(version)),
            _ => fail(format!(
                "This store's schema version is unreadable ({text:.20}); it was left as it is."
            )),
        },
    }
}

/// Copies the store beside itself before a migration (`workspace.v{version}.db`): the WAL is
/// checkpointed into the file first, so the copy is the whole store, and it is on disk before the
/// migration starts.
fn backup(conn: &Connection, path: &Path, version: i64) -> Result<PathBuf> {
    let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))?;
    if busy != 0 {
        return fail("The store is in use: it could not be copied, so it was not migrated.");
    }
    let target = path.with_file_name(format!("workspace.v{version}.db"));
    let partial = path.with_file_name(format!("workspace.v{version}.db.part"));
    {
        let mut source = fs::File::open(path)?;
        let mut copy = fs::File::create(&partial)?;
        std::io::copy(&mut source, &mut copy)?;
        copy.sync_all()?;
    }
    fs::rename(&partial, &target)?;
    Ok(target)
}

/// Runs the migrations after `from` (and, for a new store, schema 1 first) and records the new
/// version, in one transaction: a migration that fails leaves the store as it was.
fn migrate(conn: &mut Connection, from: Option<i64>) -> Result<()> {
    let tx = conn.transaction()?;
    if from.is_none() {
        tx.execute_batch(SCHEMA_V1)?;
    }
    let first = from.unwrap_or(1) as usize - 1;
    for migration in &MIGRATIONS[first..] {
        tx.execute_batch(migration)?;
    }
    tx.execute(
        "INSERT INTO meta (key, value) VALUES ('schemaVersion', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![SCHEMA_VERSION.to_string()],
    )?;
    tx.commit()?;
    Ok(())
}

pub struct Store {
    conn: Connection,
    assets: PathBuf,
}

impl Store {
    /// Opens (or creates) the store in a directory: `workspace.db` and an `assets` folder. An older
    /// store is copied to `workspace.v{n}.db` and migrated; a newer one is refused, never wiped.
    pub fn open(dir: &Path) -> Result<Store> {
        fs::create_dir_all(dir.join("assets"))?;
        let path = dir.join("workspace.db");
        let mut conn = Connection::open(&path)?;
        // WAL with NORMAL survives a killed process; every method is one transaction.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
        )?;
        match stored_version(&conn)? {
            None => migrate(&mut conn, None)?,
            Some(version) if version > SCHEMA_VERSION => {
                // Never wipe a newer store: its outbox may hold unsent work (SYNC_DESIGN.md).
                return fail(format!(
                    "This store was written by a newer version ({version}); update the app."
                ));
            }
            Some(version) if version < SCHEMA_VERSION => {
                backup(&conn, &path, version)?;
                migrate(&mut conn, Some(version))?;
            }
            Some(_) => {}
        }
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
            "nextOutboxBatch" => none(self.next_outbox(
                i64_of(&header, "limit")?,
                optional_id(&header, "workspaceId")?,
            )?),
            "outboxIndex" => none(self.outbox_index()?),
            "outboxOps" => none(self.outbox_ops(&header)?),
            "syncCursor" => none(self.sync_cursor(check_id(str_of(&header, "workspaceId")?)?)?),
            "unsentDocUpdates" => self.unsent_doc_updates(i64_of(&header, "limit")?),
            "ackDocUpdates" => none(self.ack_doc_updates(&header)?),
            "applyRemoteDocUpdates" => none(self.apply_remote_doc_updates(&header, blobs)?),
            "docCursor" => none(self.doc_cursor(check_id(str_of(&header, "pageId")?)?)?),
            "docCursors" => none(self.doc_cursors(check_id(str_of(&header, "workspaceId")?)?)?),
            "replaceDoc" => none(self.replace_doc(&header, blobs)?),
            "pendingAssets" => none(self.pending_assets(i64_of(&header, "limit")?)?),
            "markAssetUploaded" => {
                none(self.mark_asset_uploaded(check_id(str_of(&header, "id")?)?)?)
            }
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
        let mut next = next_seq(&tx, &page)?;
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
        // In a synced workspace, updates not yet on the server stay to be pushed.
        let keep_unsent: bool = tx.query_row(
            &format!(
                "SELECT EXISTS (SELECT 1 FROM pages p JOIN workspaces w ON w.id = p.workspace_id
                 WHERE p.id = ?1 AND {SYNCED})"
            ),
            params![page],
            |r| r.get(0),
        )?;
        tx.execute(
            "DELETE FROM doc_updates WHERE page_id = ?1 AND local_seq <= ?2
               AND (seq IS NOT NULL OR NOT ?3)",
            params![page, covers, keep_unsent],
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

    // Documents and the server (store schema 2) --------------------------------------------------

    /// Updates not yet on the server, of synced workspaces' pages, at most `limit`: pages in the
    /// order of their oldest unsent update, each page's in log order. The bytes are the blobs.
    fn unsent_doc_updates(&mut self, limit: i64) -> Result<(Value, Vec<Vec<u8>>)> {
        let mut statement = self.conn.prepare(&format!(
            "WITH unsent AS (
               SELECT u.page_id, u.local_seq, u.update_id, u.data,
                 FIRST_VALUE(u.update_id) OVER (PARTITION BY u.page_id ORDER BY u.local_seq) AS first_id
               FROM doc_updates u
               JOIN pages p ON p.id = u.page_id
               JOIN workspaces w ON w.id = p.workspace_id
               WHERE u.seq IS NULL AND {SYNCED})
             SELECT page_id, local_seq, update_id, data FROM unsent
             ORDER BY first_id, page_id, local_seq LIMIT ?1"
        ))?;
        let mut rows = statement.query(params![limit.max(0)])?;
        let mut updates = Vec::new();
        let mut blobs = Vec::new();
        while let Some(row) = rows.next()? {
            updates.push(json!({
                "pageId": row.get::<_, String>(0)?,
                "localSeq": row.get::<_, i64>(1)?,
                "updateId": row.get::<_, String>(2)?,
            }));
            blobs.push(row.get::<_, Vec<u8>>(3)?);
        }
        Ok((Value::Array(updates), blobs))
    }

    /// The server's sequences for pushed updates.
    fn ack_doc_updates(&mut self, header: &Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Ack {
            update_id: String,
            seq: i64,
        }
        let page = check_id(str_of(header, "pageId")?)?.to_owned();
        let acks: Vec<Ack> = serde_json::from_value(header["acks"].clone())?;
        let tx = self.conn.transaction()?;
        for ack in &acks {
            tx.execute(
                "UPDATE doc_updates SET seq = ?3 WHERE page_id = ?1 AND update_id = ?2",
                params![page, check_id(&ack.update_id)?, ack.seq],
            )?;
        }
        tx.commit()?;
        Ok(Value::Null)
    }

    /// Pulled updates, in order: one this device pushed takes its sequence, one already held is
    /// skipped, the rest are added (acknowledged); then the page's cursor moves. Answers which of
    /// the request's updates were added (`index`) with their local sequences.
    fn apply_remote_doc_updates(&mut self, header: &Value, blobs: Vec<Vec<u8>>) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Incoming {
            seq: i64,
            /// The pusher's idempotency key, when the server has one.
            update_id: Option<String>,
            /// The id to keep the update under if it is added (the key, or a new one).
            id: String,
        }
        let page = check_id(str_of(header, "pageId")?)?.to_owned();
        let epoch = i64_of(header, "epoch")?;
        let head = i64_of(header, "headSeq")?;
        let updates: Vec<Incoming> = serde_json::from_value(header["updates"].clone())?;
        if updates.len() != blobs.len() {
            return fail("applyRemoteDocUpdates: one blob per update");
        }
        let tx = self.conn.transaction()?;
        let mut next = next_seq(&tx, &page)?;
        let mut added = Vec::new();
        for (index, (update, data)) in updates.iter().zip(blobs).enumerate() {
            if let Some(key) = &update.update_id {
                let mine = tx.execute(
                    "UPDATE doc_updates SET seq = COALESCE(seq, ?3) WHERE page_id = ?1 AND update_id = ?2",
                    params![page, check_id(key)?, update.seq],
                )?;
                if mine > 0 {
                    continue;
                }
            }
            let held: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM doc_updates WHERE page_id = ?1 AND seq = ?2)",
                params![page, update.seq],
                |r| r.get(0),
            )?;
            if held {
                continue;
            }
            tx.execute(
                "INSERT INTO doc_updates (page_id, local_seq, update_id, data, seq) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![page, next, check_id(&update.id)?, data, update.seq],
            )?;
            added.push(json!({ "index": index, "updateId": update.id, "localSeq": next }));
            next += 1;
        }
        tx.execute(
            "INSERT INTO doc_logs (page_id, next_seq, snapshot, snapshot_covers) VALUES (?1, ?2, NULL, 0)
             ON CONFLICT (page_id) DO UPDATE SET next_seq = excluded.next_seq",
            params![page, next],
        )?;
        // A new epoch starts the cursor again; within one, the head only rises.
        let current: Option<(i64, i64)> = tx
            .query_row(
                "SELECT head_seq, epoch FROM doc_cursors WHERE page_id = ?1",
                params![page],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let kept = match current {
            Some((head_seq, current_epoch)) if current_epoch == epoch => head_seq,
            _ => 0,
        };
        tx.execute(
            "INSERT OR REPLACE INTO doc_cursors (page_id, head_seq, epoch) VALUES (?1, ?2, ?3)",
            params![page, kept.max(head), epoch],
        )?;
        tx.commit()?;
        Ok(Value::Array(added))
    }

    fn doc_cursor(&mut self, page: &str) -> Result<Value> {
        let cursor: Option<(i64, i64)> = self
            .conn
            .query_row(
                "SELECT head_seq, epoch FROM doc_cursors WHERE page_id = ?1",
                params![page],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(match cursor {
            Some((head_seq, epoch)) => json!({ "headSeq": head_seq, "epoch": epoch }),
            None => Value::Null,
        })
    }

    /// The cursors of a workspace's pages, by page id.
    fn doc_cursors(&mut self, workspace: &str) -> Result<Value> {
        let mut statement = self.conn.prepare(
            "SELECT c.page_id, c.head_seq, c.epoch FROM doc_cursors c JOIN pages p ON p.id = c.page_id
             WHERE p.workspace_id = ?1",
        )?;
        let rows = statement.query_map(params![workspace], |r| {
            Ok((
                r.get::<_, String>(0)?,
                json!({ "headSeq": r.get::<_, i64>(1)?, "epoch": r.get::<_, i64>(2)? }),
            ))
        })?;
        let mut out = serde_json::Map::new();
        for row in rows {
            let (page, cursor) = row?;
            out.insert(page, cursor);
        }
        Ok(Value::Object(out))
    }

    /// The page's whole log becomes one unsent update, and its cursor goes.
    fn replace_doc(&mut self, header: &Value, mut blobs: Vec<Vec<u8>>) -> Result<Value> {
        let page = check_id(str_of(header, "pageId")?)?.to_owned();
        let update_id = check_id(str_of(header, "updateId")?)?.to_owned();
        let Some(data) = blobs.pop() else {
            return fail("replaceDoc: no update");
        };
        let tx = self.conn.transaction()?;
        let next = next_seq(&tx, &page)?;
        tx.execute("DELETE FROM doc_updates WHERE page_id = ?1", params![page])?;
        tx.execute(
            "INSERT INTO doc_updates (page_id, local_seq, update_id, data, seq) VALUES (?1, ?2, ?3, ?4, NULL)",
            params![page, next, update_id, data],
        )?;
        tx.execute(
            "INSERT INTO doc_logs (page_id, next_seq, snapshot, snapshot_covers) VALUES (?1, ?2, NULL, 0)
             ON CONFLICT (page_id) DO UPDATE SET next_seq = excluded.next_seq, snapshot = NULL,
               snapshot_covers = 0",
            params![page, next + 1],
        )?;
        tx.execute("DELETE FROM doc_cursors WHERE page_id = ?1", params![page])?;
        tx.commit()?;
        Ok(Value::Null)
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

    /// Writes a plan from `@cgw/workspace`'s planners (`planOps`, `planSettle`, `planRemote`, or an
    /// upload's start): the outbox, records, deletes and the change-feed cursor, together. A remote
    /// plan's parts go first: answered operations leave the outbox, lost workspaces go with all they
    /// hold, and an upload's creates replace a workspace's outbox.
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
        let mut gone_assets = Vec::new();
        let tx = self.conn.transaction()?;
        for id in ids_of(plan, "settled")? {
            tx.execute("DELETE FROM outbox WHERE op_id = ?1", params![id])?;
        }
        for id in ids_of(plan, "deleteWorkspaces")? {
            gone_assets.extend(drop_workspace(&tx, &id)?);
        }
        if let Some(replace) = present(plan, "replaceOutbox") {
            let workspace = check_id(str_of(replace, "workspaceId")?)?;
            tx.execute(
                "DELETE FROM outbox WHERE workspace_id = ?1",
                params![workspace],
            )?;
            for op in replace
                .get("ops")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                insert_op(&tx, op)?;
            }
        }
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
            insert_op(&tx, &op)?;
        }
        for id in ids_of(plan, "deletePages")? {
            drop_page(&tx, &id)?;
        }
        if let Some(cursor) = present(plan, "cursor") {
            tx.execute(
                "INSERT INTO sync_cursors (workspace_id, value) VALUES (?1, ?2)
                 ON CONFLICT (workspace_id) DO UPDATE SET value = excluded.value",
                params![
                    check_id(str_of(cursor, "workspaceId")?)?,
                    i64_of(cursor, "value")?
                ],
            )?;
        }
        tx.commit()?;
        // The files go once their records have: a record never points at a missing file. A file
        // left behind by a crash here is only space.
        for id in gone_assets {
            let _ = fs::remove_file(self.assets.join(&id));
        }
        Ok(Value::Null)
    }

    /// The oldest operations first, of every workspace or of one.
    fn next_outbox(&mut self, limit: i64, workspace: Option<&str>) -> Result<Value> {
        let mut statement = self.conn.prepare(
            "SELECT body FROM outbox WHERE ?2 IS NULL OR workspace_id = ?2 ORDER BY seq LIMIT ?1",
        )?;
        let rows =
            statement.query_map(params![limit.max(0), workspace], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str::<Value>(&row?)?);
        }
        Ok(Value::Array(out))
    }

    /// Which entity each operation in the outbox is about: what the webview keeps to know which
    /// entities wait for the server (the remote planners' `pending`).
    fn outbox_index(&mut self) -> Result<Value> {
        let mut statement = self
            .conn
            .prepare("SELECT op_id, workspace_id, entity_id FROM outbox ORDER BY seq")?;
        let rows = statement.query_map([], |r| {
            Ok(json!({
                "opId": r.get::<_, String>(0)?,
                "workspaceId": r.get::<_, Option<String>>(1)?,
                "entityId": r.get::<_, Option<String>>(2)?,
            }))
        })?;
        Ok(Value::Array(rows.collect::<rusqlite::Result<_>>()?))
    }

    /// The operations with these ids that are still in the outbox (what `settleOps` plans with).
    fn outbox_ops(&mut self, header: &Value) -> Result<Value> {
        let ids = ids_of(header, "opIds")?;
        let tx = self.conn.transaction()?;
        let mut out = Vec::new();
        {
            let mut statement = tx.prepare("SELECT body FROM outbox WHERE op_id = ?1")?;
            for id in &ids {
                let body: Option<String> =
                    statement.query_row(params![id], |r| r.get(0)).optional()?;
                if let Some(body) = body {
                    out.push(serde_json::from_str::<Value>(&body)?);
                }
            }
        }
        tx.commit()?;
        Ok(Value::Array(out))
    }

    fn sync_cursor(&mut self, workspace: &str) -> Result<Value> {
        let value: Option<i64> = self
            .conn
            .query_row(
                "SELECT value FROM sync_cursors WHERE workspace_id = ?1",
                params![workspace],
                |r| r.get(0),
            )
            .optional()?;
        Ok(json!(value))
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
        // An upsert keeps the row, so assets stay in the order they were first put.
        self.conn.execute(
            "INSERT INTO assets (id, workspace_id, body) VALUES (?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET workspace_id = excluded.workspace_id, body = excluded.body",
            params![
                id,
                check_id(str_of(asset, "workspaceId")?)?,
                asset.to_string()
            ],
        )?;
        Ok(Value::Null)
    }

    /// Assets of synced workspaces the server does not hold yet, whose bytes this device holds.
    fn pending_assets(&mut self, limit: i64) -> Result<Value> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT a.id, a.body FROM assets a JOIN workspaces w ON w.id = a.workspace_id
             WHERE {SYNCED} AND COALESCE(json_extract(a.body, '$.uploaded'), 0) = 0
             ORDER BY a.rowid"
        ))?;
        let rows =
            statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            if out.len() as i64 >= limit {
                break;
            }
            let (id, body) = row?;
            if self.assets.join(check_id(&id)?).is_file() {
                out.push(serde_json::from_str::<Value>(&body)?);
            }
        }
        Ok(Value::Array(out))
    }

    fn mark_asset_uploaded(&mut self, id: &str) -> Result<Value> {
        self.conn.execute(
            "UPDATE assets SET body = json_set(body, '$.uploaded', json('true')) WHERE id = ?1",
            params![id],
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

/// A page removed for good: its record, document and its cursor, history, search entry,
/// favourites and visits.
fn drop_page(tx: &Transaction, id: &str) -> Result<()> {
    for sql in [
        "DELETE FROM pages WHERE id = ?1",
        "DELETE FROM doc_logs WHERE page_id = ?1",
        "DELETE FROM doc_updates WHERE page_id = ?1",
        "DELETE FROM doc_cursors WHERE page_id = ?1",
        "DELETE FROM history WHERE page_id = ?1",
        "DELETE FROM search WHERE page_id = ?1",
        "DELETE FROM favourites WHERE page_id = ?1",
        "DELETE FROM visits WHERE page_id = ?1",
    ] {
        tx.execute(sql, params![id])?;
    }
    Ok(())
}

/// A workspace removed with all it holds: its pages (as `drop_page`), sections, favourites,
/// visits, search entries, asset records, outbox operations and change-feed cursor. Returns its
/// asset ids: their files go after the commit.
fn drop_workspace(tx: &Transaction, id: &str) -> Result<Vec<String>> {
    let ids = |sql: &str| -> Result<Vec<String>> {
        let mut statement = tx.prepare(sql)?;
        let rows = statement.query_map(params![id], |r| r.get::<_, String>(0))?;
        let out = rows.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(out)
    };
    for page in ids("SELECT id FROM pages WHERE workspace_id = ?1")? {
        drop_page(tx, &page)?;
    }
    let assets = ids("SELECT id FROM assets WHERE workspace_id = ?1")?;
    for sql in [
        "DELETE FROM assets WHERE workspace_id = ?1",
        "DELETE FROM sections WHERE workspace_id = ?1",
        "DELETE FROM favourites WHERE workspace_id = ?1",
        "DELETE FROM visits WHERE workspace_id = ?1",
        "DELETE FROM search WHERE workspace_id = ?1",
        "DELETE FROM outbox WHERE workspace_id = ?1",
        "DELETE FROM sync_cursors WHERE workspace_id = ?1",
        "DELETE FROM workspaces WHERE id = ?1",
    ] {
        tx.execute(sql, params![id])?;
    }
    Ok(assets)
}

/// An operation into the outbox, after every other: it is sent in this order.
fn insert_op(tx: &Transaction, op: &Value) -> Result<()> {
    tx.execute(
        "INSERT INTO outbox (op_id, workspace_id, entity_id, body) VALUES (?1, ?2, ?3, ?4)",
        params![
            check_id(str_of(op, "opId")?)?,
            check_id(str_of(op, "workspaceId")?)?,
            check_id(str_of(op, "entityId")?)?,
            op.to_string()
        ],
    )?;
    Ok(())
}

/// The local sequence the page's next update takes.
fn next_seq(tx: &Transaction, page: &str) -> Result<i64> {
    Ok(tx
        .query_row(
            "SELECT next_seq FROM doc_logs WHERE page_id = ?1",
            params![page],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(1))
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
        // Refused, not wiped: the store is as it was, and nothing was copied.
        let conn = Connection::open(dir.path().join("workspace.db")).unwrap();
        let version: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schemaVersion'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, "99");
        assert!(!dir.path().join("workspace.v99.db").exists());
    }

    const WS: &str = "0193a1b2-c3d4-7e5f-8a9b-000000000010";
    const SECTION: &str = "0193a1b2-c3d4-7e5f-8a9b-000000000020";
    const OP: &str = "0193a1b2-c3d4-7e5f-8a9b-000000000030";
    const ASSET: &str = "0193a1b2-c3d4-7e5f-8a9b-000000000040";

    fn page_body() -> Value {
        json!({ "id": PAGE, "workspaceId": WS, "sectionId": SECTION, "parentPageId": null,
                "title": "Kept", "trashedAt": null })
    }

    fn op_body() -> Value {
        json!({ "opId": OP, "type": "page.create", "workspaceId": WS, "entityId": PAGE,
                "baseVersion": null, "payload": page_body(), "createdAt": "2026-11-01T00:00:00.000Z" })
    }

    #[test]
    fn migrates_a_version_1_store_after_copying_it() {
        let dir = tempfile::tempdir().unwrap();
        // A store as Phase 1 wrote it. Its last writes are still in the WAL (no checkpoint runs
        // while this connection is open), so the copy holds them only if the WAL went in first.
        let old = Connection::open(dir.path().join("workspace.db")).unwrap();
        old.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;")
            .unwrap();
        old.execute_batch(SCHEMA_V1).unwrap();
        let workspace = json!({ "id": WS, "name": "Old", "localOnly": true });
        let section = json!({ "id": SECTION, "workspaceId": WS, "name": "Pages" });
        for (sql, values) in [
            (
                "INSERT INTO meta (key, value) VALUES ('schemaVersion', '1')",
                vec![],
            ),
            (
                "INSERT INTO workspaces (id, body) VALUES (?1, ?2)",
                vec![WS.to_owned(), workspace.to_string()],
            ),
            (
                "INSERT INTO sections (id, workspace_id, body) VALUES (?1, ?2, ?3)",
                vec![SECTION.to_owned(), WS.to_owned(), section.to_string()],
            ),
            (
                "INSERT INTO pages (id, workspace_id, section_id, parent_id, trashed_at, body)
                 VALUES (?1, ?2, ?3, NULL, NULL, ?4)",
                vec![
                    PAGE.to_owned(),
                    WS.to_owned(),
                    SECTION.to_owned(),
                    page_body().to_string(),
                ],
            ),
            (
                "INSERT INTO outbox (op_id, body) VALUES (?1, ?2)",
                vec![OP.to_owned(), op_body().to_string()],
            ),
            (
                "INSERT INTO doc_logs (page_id, next_seq, snapshot, snapshot_covers) VALUES (?1, 2, NULL, 0)",
                vec![PAGE.to_owned()],
            ),
        ] {
            old.execute(sql, rusqlite::params_from_iter(values))
                .unwrap();
        }
        old.execute(
            "INSERT INTO doc_updates (page_id, local_seq, update_id, data, seq) VALUES (?1, 1, ?2, ?3, NULL)",
            params![PAGE, OP, vec![0u8, 255, 7]],
        )
        .unwrap();

        let mut store = Store::open(dir.path()).unwrap();
        drop(old);
        let (answer, _) = call(&mut store, json!({ "op": "schemaVersion" }), &[]);
        assert_eq!(answer["ok"], 2);
        let (answer, _) = call(&mut store, json!({ "op": "readMirror" }), &[]);
        assert_eq!(answer["ok"]["workspaces"], json!([workspace]));
        assert_eq!(answer["ok"]["pages"], json!([page_body()]));
        let (answer, blobs) = call(&mut store, json!({ "op": "loadDoc", "pageId": PAGE }), &[]);
        assert_eq!(answer["ok"]["updates"][0]["localSeq"], 1);
        assert_eq!(blobs, vec![vec![0u8, 255, 7]]);
        // The outbox learned each operation's workspace and entity.
        let (answer, _) = call(
            &mut store,
            json!({ "op": "nextOutboxBatch", "limit": 10, "workspaceId": WS }),
            &[],
        );
        assert_eq!(answer["ok"], json!([op_body()]));
        let (answer, _) = call(&mut store, json!({ "op": "outboxIndex" }), &[]);
        assert_eq!(
            answer["ok"],
            json!([{ "opId": OP, "workspaceId": WS, "entityId": PAGE }])
        );
        let (answer, _) = call(
            &mut store,
            json!({ "op": "syncCursor", "workspaceId": WS }),
            &[],
        );
        assert_eq!(answer["ok"], Value::Null);

        // The copy is the whole version-1 store, as it was.
        let copy = Connection::open(dir.path().join("workspace.v1.db")).unwrap();
        let version: String = copy
            .query_row(
                "SELECT value FROM meta WHERE key = 'schemaVersion'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, "1");
        let counts: (i64, i64, i64) = copy
            .query_row(
                "SELECT (SELECT COUNT(*) FROM pages), (SELECT COUNT(*) FROM outbox),
                        (SELECT COUNT(*) FROM doc_updates)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (1, 1, 1));
        let columns: i64 = copy
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('outbox') WHERE name = 'workspace_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(columns, 0);

        // Opening again migrates nothing more.
        drop(store);
        let mut store = Store::open(dir.path()).unwrap();
        let (answer, _) = call(&mut store, json!({ "op": "schemaVersion" }), &[]);
        assert_eq!(answer["ok"], 2);
    }

    #[test]
    fn a_new_store_has_the_migrated_schema() {
        let fresh = tempfile::tempdir().unwrap();
        drop(Store::open(fresh.path()).unwrap());
        let migrated = tempfile::tempdir().unwrap();
        {
            let old = Connection::open(migrated.path().join("workspace.db")).unwrap();
            old.execute_batch(SCHEMA_V1).unwrap();
            old.execute(
                "INSERT INTO meta (key, value) VALUES ('schemaVersion', '1')",
                [],
            )
            .unwrap();
        }
        drop(Store::open(migrated.path()).unwrap());
        let schema = |dir: &Path| -> Vec<(String, String)> {
            let conn = Connection::open(dir.join("workspace.db")).unwrap();
            let mut statement = conn
                .prepare("SELECT name, COALESCE(sql, '') FROM sqlite_master ORDER BY name")
                .unwrap();
            let rows = statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(schema(fresh.path()), schema(migrated.path()));
        assert!(!fresh.path().join("workspace.v1.db").exists());
    }

    #[test]
    fn removes_a_lost_workspace_with_its_files_outbox_and_cursors() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let workspace = json!({ "id": WS, "name": "Synced", "localOnly": false });
        let plan = json!({
            "workspaces": [workspace],
            "sections": [{ "id": SECTION, "workspaceId": WS }],
            "pages": [page_body()],
            "outbox": [op_body()],
            "cursor": { "workspaceId": WS, "value": 5 },
        });
        let (answer, _) = call(&mut store, json!({ "op": "applyPlan", "plan": plan }), &[]);
        assert_eq!(answer["ok"], Value::Null);
        let asset = json!({ "id": ASSET, "workspaceId": WS });
        call(
            &mut store,
            json!({ "op": "putAsset", "asset": asset }),
            &[vec![1, 2]],
        );
        call(
            &mut store,
            json!({ "op": "applyRemoteDocUpdates", "pageId": PAGE, "epoch": 1, "headSeq": 4,
                    "updates": [{ "seq": 4, "updateId": null, "id": OP }] }),
            &[vec![4]],
        );
        let (answer, _) = call(
            &mut store,
            json!({ "op": "pendingAssets", "limit": 5 }),
            &[],
        );
        assert_eq!(answer["ok"], json!([asset]));
        assert!(dir.path().join("assets").join(ASSET).is_file());

        let plan = json!({ "deleteWorkspaces": [WS], "deletePages": [PAGE] });
        let (answer, _) = call(&mut store, json!({ "op": "applyPlan", "plan": plan }), &[]);
        assert_eq!(answer["ok"], Value::Null);
        assert!(!dir.path().join("assets").join(ASSET).exists());
        let (answer, _) = call(&mut store, json!({ "op": "readMirror" }), &[]);
        for key in ["workspaces", "sections", "pages", "assets"] {
            assert_eq!(answer["ok"][key], json!([]), "{key}");
        }
        let (answer, _) = call(
            &mut store,
            json!({ "op": "nextOutboxBatch", "limit": 10 }),
            &[],
        );
        assert_eq!(answer["ok"], json!([]));
        let (answer, _) = call(
            &mut store,
            json!({ "op": "syncCursor", "workspaceId": WS }),
            &[],
        );
        assert_eq!(answer["ok"], Value::Null);
        let (answer, _) = call(
            &mut store,
            json!({ "op": "docCursor", "pageId": PAGE }),
            &[],
        );
        assert_eq!(answer["ok"], Value::Null);
        let (_, blobs) = call(&mut store, json!({ "op": "loadDoc", "pageId": PAGE }), &[]);
        assert!(blobs.is_empty());
    }
}
