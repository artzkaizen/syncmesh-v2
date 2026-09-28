//! The stores an app ships (`storage/src/event-store.ts`, `state-store.ts`): the log, the folded
//! rows and a blob shelf, each over one `rusqlite` connection. A port of the *contract* in
//! [`crate::store`], not of the SQL — the TypeScript's tables carry a `local` scope, a compaction
//! floor and an attached-database dialect this crate has no writes for yet, so the shape here is
//! the smaller one a Rust device needs today, namespaced `sm_` so it can share a file with an
//! app's own tables.
//!
//! One connection per store, and two connections when the two stores share a file: SQLite's
//! writer lock serialises them and WAL lets a read run under a write. A host that wants the log
//! and the rows to land in one transaction puts both behind one connection later; for now the
//! engine appends first and commits state second, so a crash between the two costs a replay of
//! the log above the coverage, never a row (see `Engine::open`).
//!
//! Every `rusqlite::Error` becomes a [`StoreError`] with the statement's name in it. Nothing here
//! unwraps I/O; what the database holds is foreign bytes as far as the decoders are concerned.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use syncmesh_core::event::{PeerId, SeqNum};
use syncmesh_core::hlc::Hlc;
use syncmesh_core::record_codec::{decode_record, encode_record};
use syncmesh_core::state::State;
use syncmesh_core::{decode_event_core, encode_event_core};

use crate::store::{Coverage, Cursors, EventStore, RowWrite, StateStore, StoreError, StoredEvent};

/// The one key `sm_meta` holds today.
const COVERAGE_KEY: &str = "coverage";

/// A five-second wait on the writer lock, because two connections to one file is the normal case
/// here and a `SQLITE_BUSY` surfacing as a failed commit would make the engine report a store
/// fault for what is only the other store finishing its transaction.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

fn failed(what: &'static str) -> impl Fn(rusqlite::Error) -> StoreError {
    move |e| StoreError::new(format!("{what} failed: {e}"))
}

/// Opens a file database in WAL mode, creating it when absent.
fn open_file(path: &Path) -> Result<Connection, StoreError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags).map_err(failed("open"))?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(failed("busy_timeout"))?;
    // WAL is a property of the file and persists; setting it again on an open is a no-op
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(failed("journal_mode"))?;
    Ok(conn)
}

fn open_memory() -> Result<Connection, StoreError> {
    Connection::open_in_memory().map_err(failed("open"))
}

/// The log and the rows over two connections to one file: what an app opens at boot.
pub fn open_stores(path: &Path) -> Result<(SqliteEventStore, SqliteStateStore), StoreError> {
    Ok((SqliteEventStore::open(path)?, SqliteStateStore::open(path)?))
}

/// Both stores in memory, each its own database: what a test opens.
pub fn open_in_memory() -> Result<(SqliteEventStore, SqliteStateStore), StoreError> {
    Ok((
        SqliteEventStore::open_in_memory()?,
        SqliteStateStore::open_in_memory()?,
    ))
}

// --- the log ---------------------------------------------------------------------------------

const EVENTS_DDL: &str = "
CREATE TABLE IF NOT EXISTS sm_events (
    id          TEXT PRIMARY KEY,
    peer        TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    hlc_ms      INTEGER,
    hlc_logical INTEGER,
    partition   TEXT,
    core        BLOB,
    sig         BLOB
);
CREATE INDEX IF NOT EXISTS sm_events_peer_seq ON sm_events (peer, seq);
";

/// The append-only log in SQLite. Idempotent by event id at the statement (`INSERT OR IGNORE`),
/// so a re-arrival that slipped past the engine's `has` still lands once.
///
/// `core` holds the bytes the author's signature covers, never a re-encode of what this build
/// could read: the decoder drops keys it has no name for, and forwarding a re-encode would send
/// bytes the signature does not cover. An entry that arrives with no core — the type allows it,
/// though every write this crate makes carries one — is stored as `encode_event_core` of the
/// event with `sig` NULL, and such a row can never be forwarded: `StoredEvent::envelope` answers
/// `None` without a signature, and nobody but the author can mint one.
pub struct SqliteEventStore {
    conn: Connection,
}

impl std::fmt::Debug for SqliteEventStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteEventStore").finish_non_exhaustive()
    }
}

impl SqliteEventStore {
    pub fn open(path: &Path) -> Result<SqliteEventStore, StoreError> {
        SqliteEventStore::over(open_file(path)?)
    }

    pub fn open_in_memory() -> Result<SqliteEventStore, StoreError> {
        SqliteEventStore::over(open_memory()?)
    }

    fn over(conn: Connection) -> Result<SqliteEventStore, StoreError> {
        conn.execute_batch(EVENTS_DDL).map_err(failed("migrate"))?;
        Ok(SqliteEventStore { conn })
    }

    /// How many events the log holds.
    pub fn len(&self) -> Result<usize, StoreError> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM sm_events", [], |r| r.get(0))
            .map_err(failed("count"))?;
        Ok(usize::try_from(n).unwrap_or(0))
    }

    pub fn is_empty(&self) -> Result<bool, StoreError> {
        Ok(self.len()? == 0)
    }

    fn select(&self, sql: &str, floor: Option<&str>) -> Result<Vec<StoredEvent>, StoreError> {
        let mut statement = self.conn.prepare_cached(sql).map_err(failed("prepare"))?;
        let rows = match floor {
            Some(floor) => statement.query(params![floor]),
            None => statement.query([]),
        }
        .map_err(failed("query"))?;
        rows.and_then(|row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Option<Vec<u8>>>(1)?)))
            .map(|row| {
                row.map_err(failed("read"))
                    .and_then(|(c, s)| decode_stored(c, s))
            })
            .collect()
    }
}

/// Appends one entry inside whatever transaction `conn` is in.
fn insert_event(conn: &Connection, entry: &StoredEvent) -> Result<(), StoreError> {
    let event = &entry.event;
    let core = match &entry.core {
        Some(core) => core.clone(),
        None => encode_event_core(event),
    };
    conn.execute(
        "INSERT OR IGNORE INTO sm_events (id, peer, seq, hlc_ms, hlc_logical, partition, core, sig)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            entry.id(),
            event.peer_id.as_str(),
            seq_to_sql(event.seq_num),
            event.hlc.ms,
            i64::from(event.hlc.logical),
            event.partition.as_ref().map(|p| p.as_str()),
            core,
            entry.sig.as_deref(),
        ],
    )
    .map_err(failed("append"))?;
    Ok(())
}

/// A `(core, sig)` row back to the entry that was stored. The core comes back as the entry's
/// `core`, which is what a relay forwards; a row that decodes no longer is a store fault, because
/// a log that skips rows would move every cursor past events nobody folded.
fn decode_stored(core: Vec<u8>, sig: Option<Vec<u8>>) -> Result<StoredEvent, StoreError> {
    let event = decode_event_core(&core)
        .map_err(|e| StoreError::new(format!("stored event does not decode: {e}")))?;
    Ok(StoredEvent {
        event,
        core: Some(core),
        sig,
    })
}

/// A `SeqNum` is at most `MAX_SAFE_INTEGER`, which is well inside an `i64` column.
fn seq_to_sql(seq: SeqNum) -> i64 {
    i64::try_from(seq.get()).unwrap_or(i64::MAX)
}

fn seq_from_sql(n: i64) -> Result<SeqNum, StoreError> {
    u64::try_from(n)
        .ok()
        .and_then(SeqNum::parse)
        .ok_or_else(|| StoreError::new(format!("stored sequence {n} is not a sequence number")))
}

/// The cursors as the JSON object `json_each` walks: `{"<peer>": seq}`, so one statement answers
/// `all_since` for any number of authors without a query built from string parts.
fn floor_json(cursors: &Cursors) -> String {
    let object: serde_json::Map<String, serde_json::Value> = cursors
        .iter()
        .map(|(peer, seq)| (peer.as_str().to_owned(), serde_json::Value::from(seq.get())))
        .collect();
    serde_json::Value::Object(object).to_string()
}

impl EventStore for SqliteEventStore {
    fn append(&mut self, entry: &StoredEvent) -> Result<(), StoreError> {
        insert_event(&self.conn, entry)
    }

    fn append_batch(&mut self, entries: &[StoredEvent]) -> Result<(), StoreError> {
        let tx = self.conn.transaction().map_err(failed("begin"))?;
        for entry in entries {
            insert_event(&tx, entry)?;
        }
        tx.commit().map_err(failed("commit"))
    }

    fn has(&self, id: &str) -> Result<bool, StoreError> {
        self.conn
            .query_row("SELECT 1 FROM sm_events WHERE id = ?1", params![id], |_| {
                Ok(())
            })
            .optional()
            .map(|found| found.is_some())
            .map_err(failed("has"))
    }

    fn all(&self) -> Result<Vec<StoredEvent>, StoreError> {
        self.select("SELECT core, sig FROM sm_events ORDER BY peer, seq", None)
    }

    fn all_since(&self, cursors: &Cursors) -> Result<Vec<StoredEvent>, StoreError> {
        self.select(
            "SELECT core, sig FROM sm_events
             WHERE seq > COALESCE((SELECT value FROM json_each(?1) WHERE key = sm_events.peer), 0)
             ORDER BY peer, seq",
            Some(&floor_json(cursors)),
        )
    }

    fn last_seq(&self, peer: &PeerId) -> Result<Option<SeqNum>, StoreError> {
        let max: Option<i64> = self
            .conn
            .query_row(
                "SELECT MAX(seq) FROM sm_events WHERE peer = ?1",
                params![peer.as_str()],
                |r| r.get(0),
            )
            .map_err(failed("last_seq"))?;
        max.map(seq_from_sql).transpose()
    }

    fn max_hlc(&self) -> Result<Option<Hlc>, StoreError> {
        let top: Option<(i64, i64)> = self
            .conn
            .query_row(
                "SELECT hlc_ms, hlc_logical FROM sm_events
                 ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(failed("max_hlc"))?;
        top.map(|(ms, logical)| {
            let logical = u32::try_from(logical).map_err(|_| {
                StoreError::new(format!("stored logical counter {logical} is not a counter"))
            })?;
            Ok(Hlc::new(ms, logical))
        })
        .transpose()
    }
}

// --- the rows --------------------------------------------------------------------------------

const STATE_DDL: &str = "
CREATE TABLE IF NOT EXISTS sm_state (
    tbl    TEXT NOT NULL,
    key    TEXT NOT NULL,
    record BLOB NOT NULL,
    PRIMARY KEY (tbl, key)
);
CREATE TABLE IF NOT EXISTS sm_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

/// The folded rows in SQLite: one record blob per `(table, key)` in the record codec's shape, and
/// the coverage they reflect as one JSON value in `sm_meta` —
/// `{"synced":{"<peer>":seq,…},"local":{},"scope":"…"|null}`. Rows and coverage land in one
/// transaction, because a coverage that survived a commit its rows did not (or the other way
/// round) is the mismatch D23 exists to prevent.
pub struct SqliteStateStore {
    conn: Connection,
}

impl std::fmt::Debug for SqliteStateStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteStateStore").finish_non_exhaustive()
    }
}

impl SqliteStateStore {
    pub fn open(path: &Path) -> Result<SqliteStateStore, StoreError> {
        SqliteStateStore::over(open_file(path)?)
    }

    pub fn open_in_memory() -> Result<SqliteStateStore, StoreError> {
        SqliteStateStore::over(open_memory()?)
    }

    fn over(conn: Connection) -> Result<SqliteStateStore, StoreError> {
        conn.execute_batch(STATE_DDL).map_err(failed("migrate"))?;
        Ok(SqliteStateStore { conn })
    }
}

/// The coverage as `sm_meta` holds it.
fn coverage_json(coverage: &Coverage) -> String {
    let cursors = |c: &Cursors| -> serde_json::Value {
        serde_json::Value::Object(
            c.iter()
                .map(|(peer, seq)| (peer.as_str().to_owned(), serde_json::Value::from(seq.get())))
                .collect(),
        )
    };
    serde_json::json!({
        "synced": cursors(&coverage.synced),
        "local": cursors(&coverage.local),
        "scope": coverage.scope,
    })
    .to_string()
}

/// A coverage back from its JSON; a peer or a sequence that is not one is a store fault, because
/// a cursor this build cannot read is a cursor it cannot ask a question with.
fn coverage_from_json(text: &str) -> Result<Coverage, StoreError> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| StoreError::new(format!("stored coverage is not JSON: {e}")))?;
    let cursors = |name: &str| -> Result<Cursors, StoreError> {
        let mut out = Cursors::new();
        let Some(object) = value.get(name) else {
            return Ok(out);
        };
        let Some(object) = object.as_object() else {
            return Err(StoreError::new(format!(
                "stored coverage `{name}` is not an object"
            )));
        };
        for (peer, seq) in object {
            let peer = PeerId::parse(peer)
                .map_err(|e| StoreError::new(format!("stored coverage names a bad peer: {e}")))?;
            let seq = seq.as_u64().and_then(SeqNum::parse).ok_or_else(|| {
                StoreError::new(format!("stored coverage holds a bad sequence: {seq}"))
            })?;
            out.insert(peer, seq);
        }
        Ok(out)
    };
    let scope = match value.get("scope") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(other) => {
            return Err(StoreError::new(format!(
                "stored coverage scope is not text: {other}"
            )));
        }
    };
    Ok(Coverage {
        synced: cursors("synced")?,
        local: cursors("local")?,
        scope,
    })
}

impl StateStore for SqliteStateStore {
    fn is_empty(&self) -> Result<bool, StoreError> {
        let coverage = self.load_coverage()?;
        Ok(coverage.synced.is_empty() && coverage.local.is_empty())
    }

    fn load_all(&self) -> Result<State, StoreError> {
        let mut statement = self
            .conn
            .prepare_cached("SELECT tbl, key, record FROM sm_state ORDER BY tbl, key")
            .map_err(failed("prepare"))?;
        let rows = statement.query([]).map_err(failed("load_all"))?;
        let mut state = State::new();
        let rows = rows.and_then(|row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        });
        for row in rows {
            let (table, key, bytes) = row.map_err(failed("read"))?;
            let record = decode_record(&bytes).map_err(|e| {
                StoreError::new(format!("stored row {table}/{key} does not decode: {e}"))
            })?;
            state.tables.entry(table).or_default().insert(key, record);
        }
        Ok(state)
    }

    fn load_coverage(&self) -> Result<Coverage, StoreError> {
        let text: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM sm_meta WHERE key = ?1",
                params![COVERAGE_KEY],
                |r| r.get(0),
            )
            .optional()
            .map_err(failed("load_coverage"))?;
        text.as_deref()
            .map_or(Ok(Coverage::default()), coverage_from_json)
    }

    fn commit(&mut self, rows: &[RowWrite], coverage: &Coverage) -> Result<(), StoreError> {
        let tx = self.conn.transaction().map_err(failed("begin"))?;
        for row in rows {
            tx.execute(
                "INSERT INTO sm_state (tbl, key, record) VALUES (?1, ?2, ?3)
                 ON CONFLICT (tbl, key) DO UPDATE SET record = excluded.record",
                params![row.table, row.key, encode_record(&row.record)],
            )
            .map_err(failed("commit row"))?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO sm_meta (key, value) VALUES (?1, ?2)",
            params![COVERAGE_KEY, coverage_json(coverage)],
        )
        .map_err(failed("commit coverage"))?;
        tx.commit().map_err(failed("commit"))
    }

    fn clear(&mut self) -> Result<(), StoreError> {
        let tx = self.conn.transaction().map_err(failed("begin"))?;
        tx.execute("DELETE FROM sm_state", [])
            .map_err(failed("clear rows"))?;
        tx.execute("DELETE FROM sm_meta WHERE key = ?1", params![COVERAGE_KEY])
            .map_err(failed("clear coverage"))?;
        tx.commit().map_err(failed("commit"))
    }
}

// --- the blobs -------------------------------------------------------------------------------

const BLOBS_DDL: &str = "
CREATE TABLE IF NOT EXISTS sm_blobs (
    hash  TEXT PRIMARY KEY,
    bytes BLOB NOT NULL
);
";

/// Content-addressed bytes by their hash (D18), the shelf the blobs module will stand on. Plain
/// methods and no trait on purpose: the blob module owns its trait and wraps this, so the shape
/// of what is persisted is decided once, here, and the contract once, there.
pub struct SqliteBlobStore {
    conn: Connection,
}

impl std::fmt::Debug for SqliteBlobStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteBlobStore").finish_non_exhaustive()
    }
}

impl SqliteBlobStore {
    pub fn open(path: &Path) -> Result<SqliteBlobStore, StoreError> {
        SqliteBlobStore::over(open_file(path)?)
    }

    pub fn open_in_memory() -> Result<SqliteBlobStore, StoreError> {
        SqliteBlobStore::over(open_memory()?)
    }

    fn over(conn: Connection) -> Result<SqliteBlobStore, StoreError> {
        conn.execute_batch(BLOBS_DDL).map_err(failed("migrate"))?;
        Ok(SqliteBlobStore { conn })
    }

    /// Idempotent: the same hash names the same bytes, so a second put of a hash is a no-op.
    pub fn put(&mut self, hash: &str, bytes: &[u8]) -> Result<(), StoreError> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO sm_blobs (hash, bytes) VALUES (?1, ?2)",
                params![hash, bytes],
            )
            .map_err(failed("put"))?;
        Ok(())
    }

    pub fn get(&self, hash: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.conn
            .query_row(
                "SELECT bytes FROM sm_blobs WHERE hash = ?1",
                params![hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(failed("get"))
    }

    pub fn has(&self, hash: &str) -> Result<bool, StoreError> {
        self.conn
            .query_row(
                "SELECT 1 FROM sm_blobs WHERE hash = ?1",
                params![hash],
                |_| Ok(()),
            )
            .optional()
            .map(|found| found.is_some())
            .map_err(failed("has"))
    }

    /// Whether a blob was there to remove.
    pub fn delete(&mut self, hash: &str) -> Result<bool, StoreError> {
        self.conn
            .execute("DELETE FROM sm_blobs WHERE hash = ?1", params![hash])
            .map(|removed| removed > 0)
            .map_err(failed("delete"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syncmesh_core::event::SyncEvent;

    fn peer(n: u8) -> PeerId {
        PeerId::parse(&syncmesh_core::to_hex(&[n; 32])).unwrap()
    }

    fn unsigned(p: u8, seq: u64) -> StoredEvent {
        StoredEvent {
            event: SyncEvent {
                peer_id: peer(p),
                seq_num: SeqNum::parse(seq).unwrap(),
                hlc: Hlc::new(1_000 + seq as i64, 0),
                procedure: "t".into(),
                partition: None,
                changes: vec![],
                sealed: false,
                action: None,
                undo_of: None,
            },
            core: None,
            sig: None,
        }
    }

    #[test]
    fn an_entry_without_a_core_is_kept_as_a_re_encode_and_can_never_be_forwarded() {
        let mut log = SqliteEventStore::open_in_memory().unwrap();
        let entry = unsigned(1, 1);
        log.append(&entry).unwrap();
        let back = log.all().unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].event, entry.event);
        assert_eq!(
            back[0].core.as_deref(),
            Some(&encode_event_core(&entry.event)[..])
        );
        assert_eq!(back[0].sig, None);
        assert_eq!(back[0].envelope(), None);
        assert_eq!(log.last_seq(&peer(1)).unwrap(), SeqNum::parse(1));
        assert_eq!(log.max_hlc().unwrap(), Some(Hlc::new(1_001, 0)));
    }

    #[test]
    fn coverage_json_round_trips_and_refuses_what_it_cannot_read() {
        let mut coverage = Coverage::default();
        coverage.synced.insert(peer(1), SeqNum::parse(7).unwrap());
        coverage.synced.insert(peer(2), SeqNum::parse(1).unwrap());
        coverage.scope = Some(r#"{"partitions":["org:a"]}"#.into());
        let text = coverage_json(&coverage);
        assert_eq!(coverage_from_json(&text).unwrap(), coverage);
        assert_eq!(
            coverage_from_json(r#"{"synced":{},"local":{},"scope":null}"#).unwrap(),
            Coverage::default()
        );
        assert!(coverage_from_json("not json").is_err());
        assert!(coverage_from_json(r#"{"synced":{"zz":1}}"#).is_err());
        assert!(coverage_from_json(&format!(r#"{{"synced":{{"{}":0}}}}"#, peer(1))).is_err());
        assert!(coverage_from_json(r#"{"synced":{},"scope":3}"#).is_err());
    }

    #[test]
    fn blobs_put_get_has_delete() {
        let mut blobs = SqliteBlobStore::open_in_memory().unwrap();
        assert!(!blobs.has("h1").unwrap());
        blobs.put("h1", b"hello").unwrap();
        blobs.put("h1", b"ignored").unwrap();
        assert!(blobs.has("h1").unwrap());
        assert_eq!(blobs.get("h1").unwrap().as_deref(), Some(&b"hello"[..]));
        assert_eq!(blobs.get("h2").unwrap(), None);
        assert!(blobs.delete("h1").unwrap());
        assert!(!blobs.delete("h1").unwrap());
        assert!(!blobs.has("h1").unwrap());
    }
}
