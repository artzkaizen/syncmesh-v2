//! The join exchange, both sides of it (`transport/src/join.ts`, RFC-0019, D46): a device asks
//! for state rather than history, gets a manifest saying what is coming, takes the rows a page at
//! a time, and adopts the coverage **only** once every page the manifest named has arrived.
//!
//! Sans-IO like the relay link: a host's peer link hands every decoded [`SnapshotFrame`] to
//! [`JoinExchange::dispatch`], and sends the frames each call returns, in order, back down the
//! same link. The bytes are the TypeScript's (`snap-frame.ts`, `snapshot-codec.ts`), measured
//! against `conformance/snapshot-vectors.json` by both runtimes.
//!
//! **Only an answer is taken.** Every request queues the policy its install runs under, and each
//! manifest takes the oldest one (D46). A manifest that arrives with nothing queued was not asked
//! for: it is dropped, and its pages with it, so no peer can install state or adopt coverage on a
//! device that never asked (gaps U20). The queue is sound because every frame on one exchange
//! comes from the one far side the requests went to, which answers in order over an ordered link;
//! a lost frame drops the link, and the exchange goes with the session.
//!
//! **A lost page.** The receiver notices at the last page it was told to expect and asks for the
//! gaps by index; the sender re-sends exactly those. A lost *last* page is noticed by nothing, and
//! the recovery is the link dropping and the next session asking again.
//!
//! **A snapshot is unsigned.** The rows arrive without the per-event signatures the log carries.
//! An install adopts coverage only as the asker's policy allows: a certificate from `trust` that
//! matches the rows adopts what it signs (never more than the manifest claims), and anything else
//! adopts what the policy says, which for a request answering a floor is at most the floor.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use syncmesh_core::checkpoint::{CheckpointRow, verify_checkpoint};
use syncmesh_core::doc::LineageCellRefused;
use syncmesh_core::event::{PeerId, SeqNum};
use syncmesh_core::frames::{
    SnapshotFrame, snap_ack_frame, snap_chunk_frame, snap_manifest_frame, snap_request_frame,
};
use syncmesh_core::snapshot_codec::{SnapshotRow, decode_snapshot_rows, encode_snapshot_rows};

use crate::engine::{Engine, FoldBatch};
use crate::interest::{Interest, interest_from, interest_text, narrows, scope_from};
use crate::relay::{cursors_to_map, cursors_to_pairs};
use crate::snapshot::{InstallError, Snapshot};
use crate::store::{Coverage, Cursors, StoreError};

/// Names one request, so the outcome of its install can be told to whoever asked.
pub type Ticket = u64;

/// The authority-visibility tables (D24) as a link that is not the authority's gate sees them:
/// rows it never serves, and the run it claims nothing of.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Withheld {
    /// The gated tables, by name.
    pub tables: BTreeSet<String>,
    /// Their only author: a snapshot served over this link claims none of its run.
    pub author: Option<PeerId>,
}

/// What a request is served under: what it asked for, cut to what the asker may read (D40).
pub type Serves = Box<dyn Fn(Option<&Interest>) -> Option<Interest> + Send>;

/// How one exchange behaves; `JoinOptions::new(prefix)` for the defaults.
pub struct JoinOptions {
    /// Distinguishes one exchange from another; the sender picks it. The TypeScript uses the first
    /// eight characters of its peer id.
    pub id_prefix: String,
    /// Rows per page: small enough that one page is a reasonable write on a slow radio. 500.
    pub rows_per_chunk: usize,
    /// This device's checkpoint certificate, relayed unchanged with the state it serves.
    pub certificate: Option<Vec<u8>>,
    /// Whose certificate this device believes; `None`, every install stays provisional.
    pub trust: Option<PeerId>,
    /// `None`, a request is served what it asked for: an ungranted mesh.
    pub serves: Option<Serves>,
    /// The gated tables, none of whose rows a served snapshot carries.
    pub withheld: Option<Withheld>,
}

impl JoinOptions {
    pub fn new(id_prefix: impl Into<String>) -> JoinOptions {
        JoinOptions {
            id_prefix: id_prefix.into(),
            rows_per_chunk: 500,
            certificate: None,
            trust: None,
            serves: None,
            withheld: None,
        }
    }
}

/// What an install answering one request may adopt, decided by whoever asked (D46).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct JoinPolicy {
    /// Take the sender's coverage although nothing vouched for it: a rebuild wants that, a cold
    /// join does not.
    pub adopt_unvouched: bool,
    /// A request prompted by a peer's floor: the authors this device is below and the floor the
    /// peer claimed for each. Unvouched state then adopts per author at most that floor, for those
    /// authors only, and a schema with document columns adopts nothing.
    pub floor: Option<Cursors>,
}

/// What a completed install installed, and whether anything vouched for it.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotInstalled {
    pub rows: usize,
    /// The slice the rows were complete for; `None` means the sender's whole state.
    pub scope: Option<Interest>,
    /// No certificate from `trust` matched the rows.
    pub provisional: bool,
    pub batch: FoldBatch,
}

/// How one requested install ended.
#[derive(Debug, Clone, PartialEq)]
pub enum JoinOutcome {
    Installed {
        installed: SnapshotInstalled,
        /// A certificate from `trust` matched the rows.
        vouched: bool,
    },
    /// Every page came and the engine refused the state whole (RFC-0023 §16.1).
    Refused(LineageCellRefused),
}

/// An install that ended, and the request it answered.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub ticket: Ticket,
    pub outcome: JoinOutcome,
}

/// What one dispatched frame did: frames to send back, in order, and an install that ended.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct JoinStep {
    pub send: Vec<Vec<u8>>,
    pub settled: Option<Settled>,
}

/// A join in progress: what was promised, and the pages that have arrived so far.
struct Incoming {
    chunks: u64,
    at: Cursors,
    scope: Option<Interest>,
    pages: BTreeMap<u64, Vec<SnapshotRow>>,
    certificate: Option<Vec<u8>>,
    ticket: Ticket,
    policy: JoinPolicy,
}

/// Both halves of the exchange for one session.
pub struct JoinExchange {
    options: JoinOptions,
    incoming: BTreeMap<String, Incoming>,
    /// The pages each served exchange sent, kept so a page named as missing can be sent again.
    outgoing: BTreeMap<String, Vec<Vec<SnapshotRow>>>,
    exchanges: u64,
    /// One policy per request still unanswered, oldest first. Empty means nobody asked.
    asked: VecDeque<(Ticket, JoinPolicy)>,
    tickets: Ticket,
}

impl JoinExchange {
    /// Whether this exchange names a `trust`, so a certificate could vouch for what it installs.
    pub fn trusts(&self) -> bool {
        self.options.trust.is_some()
    }

    pub fn new(options: JoinOptions) -> JoinExchange {
        JoinExchange {
            options,
            incoming: BTreeMap::new(),
            outgoing: BTreeMap::new(),
            exchanges: 0,
            asked: VecDeque::new(),
            tickets: 0,
        }
    }

    /// Asks the far side for state instead of history, narrowed to `interest`. A rebuild takes
    /// unvouched coverage (`adopt_unvouched`); a device joining because it is empty does not.
    /// Returns the request's ticket and the frame to send.
    pub fn request(
        &mut self,
        interest: Option<&Interest>,
        adopt_unvouched: bool,
    ) -> (Ticket, Vec<u8>) {
        let policy = JoinPolicy {
            adopt_unvouched,
            floor: None,
        };
        self.request_under(interest, policy)
    }

    /// The same ask under a whole [`JoinPolicy`]: what a device below a peer's floor sends.
    pub fn request_under(
        &mut self,
        interest: Option<&Interest>,
        policy: JoinPolicy,
    ) -> (Ticket, Vec<u8>) {
        self.tickets += 1;
        // queued until the manifest it triggers arrives: the exchange id is the sender's, so this
        // side cannot tie one to its own ask — order is what ties them
        self.asked.push_back((self.tickets, policy));
        let text = interest.map(|i| interest_text(Some(i)));
        (self.tickets, snap_request_frame(text.as_deref()))
    }

    /// Requests still waiting for their manifest.
    pub fn pending(&self) -> usize {
        self.asked.len() + self.incoming.len()
    }

    /// One arriving frame of the exchange. A store that refuses the install is the one error: the
    /// exchange is dropped unacknowledged, and its request never settles in this session.
    pub fn dispatch(
        &mut self,
        engine: &mut Engine,
        frame: SnapshotFrame,
    ) -> Result<JoinStep, StoreError> {
        match frame {
            SnapshotFrame::Request { interest } => {
                let asked = interest_from(interest.as_deref());
                let served = match &self.options.serves {
                    Some(serves) => serves(asked.as_ref()),
                    None => asked,
                };
                Ok(JoinStep {
                    send: self.serve(engine, served.as_ref()),
                    settled: None,
                })
            }
            SnapshotFrame::Manifest {
                id,
                chunks,
                at,
                scope,
                certificate,
                ..
            } => {
                // nobody asked: nothing installs and nothing is adopted, and the pages that
                // follow find no exchange to land in (gaps U20)
                let Some((ticket, policy)) = self.asked.pop_front() else {
                    return Ok(JoinStep::default());
                };
                let held = Incoming {
                    chunks,
                    at: cursors_to_map(&at),
                    scope: interest_from(scope.as_deref()),
                    pages: BTreeMap::new(),
                    certificate,
                    ticket,
                    policy,
                };
                // an empty snapshot has no pages to wait for, so it is already complete
                if chunks == 0 {
                    return self.complete(engine, id, held);
                }
                self.incoming.insert(id, held);
                Ok(JoinStep::default())
            }
            SnapshotFrame::Chunk { id, index, bytes } => self.on_chunk(engine, id, index, &bytes),
            SnapshotFrame::Ack { id, missing } => Ok(JoinStep {
                send: self.on_ack(&id, &missing),
                settled: None,
            }),
        }
    }

    /// Answers a request with a manifest and then the pages: the whole of the sending side.
    fn serve(&mut self, engine: &Engine, interest: Option<&Interest>) -> Vec<Vec<u8>> {
        let snapshot = held_scope(
            &engine.coverage(),
            interest,
            servable(self.options.withheld.as_ref(), engine.snapshot(interest)),
        );
        let per = self.options.rows_per_chunk.max(1);
        let pages: Vec<Vec<SnapshotRow>> = snapshot
            .rows
            .chunks(per)
            .map(<[SnapshotRow]>::to_vec)
            .collect();
        self.exchanges += 1;
        let id = format!("{}:{}", self.options.id_prefix, self.exchanges);
        let scope = snapshot.scope.as_ref().map(|i| interest_text(Some(i)));
        let mut out = vec![snap_manifest_frame(
            &id,
            pages.len() as u64,
            snapshot.rows.len() as u64,
            &cursors_to_pairs(&snapshot.coverage.synced),
            scope.as_deref(),
            self.options.certificate.as_deref(),
        )];
        for (index, page) in pages.iter().enumerate() {
            out.push(snap_chunk_frame(
                &id,
                index as u64,
                &encode_snapshot_rows(page),
            ));
        }
        self.outgoing.insert(id, pages);
        out
    }

    fn on_chunk(
        &mut self,
        engine: &mut Engine,
        id: String,
        index: u64,
        bytes: &[u8],
    ) -> Result<JoinStep, StoreError> {
        // a page for an exchange we were never told about: the manifest is what says it is coming
        let Some(held) = self.incoming.get_mut(&id) else {
            return Ok(JoinStep::default());
        };
        // an unreadable page is a missing page: the ack names it and the sender sends it again.
        // A page past the count the manifest named is no page of this exchange
        if index < held.chunks
            && let Ok(rows) = decode_snapshot_rows(bytes)
        {
            held.pages.insert(index, rows);
        }
        if held.pages.len() as u64 == held.chunks {
            let Some(held) = self.incoming.remove(&id) else {
                unreachable!("the exchange was just read")
            };
            return self.complete(engine, id, held);
        }
        // the last page the manifest named has come and something is still short: ask for the gaps
        if index + 1 == held.chunks {
            let missing: Vec<u64> = (0..held.chunks)
                .filter(|i| !held.pages.contains_key(i))
                .collect();
            return Ok(JoinStep {
                send: vec![snap_ack_frame(&id, &missing)],
                settled: None,
            });
        }
        Ok(JoinStep::default())
    }

    /// Every page is here: install as one, adopt the coverage last, and close the exchange.
    ///
    /// The rows merge through the ordinary field-level merge, so unvouched rows cannot corrupt
    /// anything a verified event later contradicts. Adopting the coverage is the irreversible
    /// half, so an install nothing vouched for offers this device's own coverage back, which
    /// advances nothing, unless the asker's policy says otherwise.
    fn complete(
        &mut self,
        engine: &mut Engine,
        id: String,
        held: Incoming,
    ) -> Result<JoinStep, StoreError> {
        let rows: Vec<SnapshotRow> = held.pages.into_values().flatten().collect();
        let signed = certified(
            held.certificate.as_deref(),
            self.options.trust.as_ref(),
            &rows,
        );
        let vouched = signed.is_some();
        let synced = adopted(
            &held.policy,
            &held.at,
            signed.as_ref(),
            engine.has_doc_columns(),
        );
        // the scope travels with the coverage it qualifies, so an install that adopts nothing
        // keeps neither; `local` stays empty, because a device's own local-only events never travel
        let (coverage, scope) = match synced {
            Some(synced) => (
                Coverage {
                    synced,
                    ..Coverage::default()
                },
                held.scope.clone(),
            ),
            None => (engine.coverage(), None),
        };
        let installed = engine.install_snapshot(Snapshot {
            rows,
            coverage,
            scope,
        });
        // every page came, so the exchange is closed either way: a refused one is not sent again
        let send = vec![snap_ack_frame(&id, &[])];
        let outcome = match installed {
            Ok(installed) => JoinOutcome::Installed {
                installed: SnapshotInstalled {
                    rows: installed.rows,
                    scope: held.scope,
                    provisional: !vouched,
                    batch: installed.batch,
                },
                vouched,
            },
            Err(InstallError::Refused(refused)) => JoinOutcome::Refused(refused),
            Err(InstallError::Store(e)) => return Err(e),
        };
        Ok(JoinStep {
            send,
            settled: Some(Settled {
                ticket: held.ticket,
                outcome,
            }),
        })
    }

    fn on_ack(&mut self, id: &str, missing: &[u64]) -> Vec<Vec<u8>> {
        let Some(pages) = self.outgoing.get(id) else {
            return Vec::new();
        };
        if missing.is_empty() {
            self.outgoing.remove(id);
            return Vec::new();
        }
        missing
            .iter()
            .filter_map(|&index| {
                let page = pages.get(usize::try_from(index).ok()?)?;
                Some(snap_chunk_frame(id, index, &encode_snapshot_rows(page)))
            })
            .collect()
    }
}

/// The coverage the authority signed for exactly these rows, or `None` when nothing vouches for
/// them: the signature is `trust`'s, and the rows hash to what it covers.
fn certified(
    certificate: Option<&[u8]>,
    trust: Option<&PeerId>,
    rows: &[SnapshotRow],
) -> Option<BTreeMap<PeerId, u64>> {
    let (certificate, trust) = (certificate?, trust?);
    let hashed: Vec<CheckpointRow> = rows
        .iter()
        .map(|row| CheckpointRow {
            table: row.table.clone(),
            key: row.key.clone(),
            record: row.record_bytes(),
        })
        .collect();
    verify_checkpoint(certificate, trust, Some(&hashed))
        .ok()
        .map(|signed| signed.value.coverage)
}

/// The synced coverage an install adopts, or `None` for none (D46's table). A vouched install
/// adopts per author the lower of the manifest's claim and what the certificate signs. Without a
/// floor, unvouched state adopts everything claimed when the asker takes unvouched state; with
/// one, at most the floor per author it names, and a schema with document columns adopts nothing.
pub fn adopted(
    policy: &JoinPolicy,
    at: &Cursors,
    signed: Option<&BTreeMap<PeerId, u64>>,
    docs: bool,
) -> Option<Cursors> {
    if policy.floor.is_some() && docs {
        return None;
    }
    if let Some(signed) = signed {
        return Some(lower(at, signed.iter().map(|(p, s)| (p, *s))));
    }
    if !policy.adopt_unvouched {
        return None;
    }
    Some(match &policy.floor {
        None => at.clone(),
        Some(floor) => lower(at, floor.iter().map(|(p, s)| (p, s.get()))),
    })
}

/// Per author named by `cap`, the lower of `at` and the cap; an author either leaves out is dropped.
fn lower<'a>(at: &Cursors, cap: impl Iterator<Item = (&'a PeerId, u64)>) -> Cursors {
    cap.filter_map(|(author, limit)| {
        let claimed = at.get(author).map_or(0, |s| s.get());
        SeqNum::parse(claimed.min(limit)).map(|seq| (author.clone(), seq))
    })
    .collect()
}

/// What a sender may claim for a request: its coverage only where it holds the asked slice. A
/// sender whose own cursors are scoped (D23) to a slice the asked interest is not inside claims
/// nothing (D46). Nor does a sender whose cursors were adopted under a window, for any request:
/// events are never windowed, so it may hold a row in part (`heldScope`).
pub fn held_scope(own: &Coverage, asked: Option<&Interest>, snapshot: Snapshot) -> Snapshot {
    let held = scope_from(own.scope.as_deref()).interest;
    let windowed = held.as_ref().is_some_and(|i| i.window.is_some());
    if own.scope.is_none() || (!windowed && narrows(asked, held.as_ref())) {
        return snapshot;
    }
    Snapshot {
        coverage: Coverage::default(),
        ..snapshot
    }
}

/// The snapshot a peer may be served: no gated rows, and no claim over the authority's run.
pub fn servable(withheld: Option<&Withheld>, snapshot: Snapshot) -> Snapshot {
    let Some(withheld) = withheld.filter(|w| !w.tables.is_empty()) else {
        return snapshot;
    };
    let rows = snapshot
        .rows
        .into_iter()
        .filter(|row| !withheld.tables.contains(&row.table))
        .collect();
    let mut coverage = snapshot.coverage;
    if let Some(author) = &withheld.author {
        coverage.synced.remove(author);
    }
    Snapshot {
        rows,
        coverage,
        scope: snapshot.scope,
    }
}
