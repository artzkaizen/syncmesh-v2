//! One device's link to one other device, with no relay between them (`transport/src/upgrade.ts`,
//! `session.ts`, `framing.ts`, `bridge.ts`, `ble/src/fragment.ts`), sans-IO (gap U3's radios).
//!
//! What a medium hands over is a byte duplex: a TCP or Wi-Fi Aware stream, a WebSocket that keeps
//! message boundaries, or a BLE characteristic that carries a couple of hundred bytes a write.
//! [`Framing`] says which, and [`PeerLink`] does the rest exactly as the TypeScript upgrader does:
//! frame boundaries, the sealed handshake (both ends send a signed hello unprompted, neither
//! waits), the door, and then the session — grants, cursors, the events the far side lacks, the
//! gap rule, digests, custody, presence and the join exchange (#35) — so a Rust device and a
//! TypeScript one are the same peer to each other, byte for byte.
//!
//! The host owns the medium. It sends what [`PeerAction::Send`] says, in order; closes it on
//! [`PeerAction::Close`] and then calls [`PeerLink::on_closed`]; hands every read to
//! [`PeerLink::on_bytes`]; and calls [`PeerLink::on_tick`] at [`PeerLink::next_deadline_ms`].
//! [`PeerSession`] is the session alone, over plaintext frames, for a host whose medium is already
//! sealed and framed.
//!
//! Where this deliberately differs from the TypeScript:
//!
//! - **No read gate (D40), no routes (book ch. 17).** A Rust device carries everything to every
//!   peer, as a TypeScript bridge with no `readGate` does; an arriving `withheld` frame is ignored
//!   as one is there, and a `routes` frame is ignored as a device with no route table ignores it.
//! - **Sends within one call leave in tag order** (`outbox.ts`): the TypeScript orders by tag
//!   within one turn of its event loop, and a call here is that turn. Cursors that follow a fold
//!   or an exchange leave after the turn, as the TypeScript queues them behind it.
//! - **A frame sent before the handshake has nowhere to go.** The TypeScript attaches the session
//!   only once the hello is proved and the door has answered, so nothing is offered earlier; a
//!   local write or a presence value before that is not sent, and the cursors exchanged on open
//!   carry the write.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use syncmesh_core::envelope::decode_and_verify;
use syncmesh_core::event::{PeerId, SeqNum};
use syncmesh_core::fragment::{
    DEFAULT_MAX_ASSEMBLIES, DEFAULT_MAX_MESSAGE_BYTES, Reassembler, fragment,
};
use syncmesh_core::frames::{
    Frame, SnapshotFrame, cursors_frame, decode_frame, digest_frame, event_frame, grant_frame,
    grant_request_frame, presence_frame, receipt_frame, refusal_frame, tag,
};
use syncmesh_core::framing::{DEFAULT_MAX_FRAME_BYTES, FrameReader, frame_with_length};
use syncmesh_core::handshake::{
    HELLO, Hello, KEY_BYTES, SessionKeys, read_hello, seal, session_keys, unseal, write_hello,
};
use syncmesh_core::identity::Identity;
use syncmesh_core::receipt::{CustodyReceipt, ReceiptRequest, issue_receipt, verify_receipt};
use syncmesh_core::refusal::{RefusalReceipt, RefusalRequest, issue_refusal, verify_refusal};

use crate::digest::{OurDigest, TheirDigest, digest_pairs, divergence_against, table_digests};
use crate::engine::{Engine, FoldBatch};
use crate::grants::GrantRegistry;
use crate::holdback::Holdback;
use crate::interest::{Interest, interest_key};
use crate::join::{JoinExchange, JoinOptions, Settled, Ticket, Withheld};
use crate::presence::decode_presence_core;
use crate::rejoin::{Accepted, PeerJoin, Rejoins};
use crate::relay::cursors_to_map;
use crate::store::{Ahead, StoredEvent};

/// How many of a link's past session keys are kept to refuse a replayed hello with.
pub const KEYS_REMEMBERED: usize = 64;

/// How often a quiet link is prodded; it is hung up on at [`SILENCE_FACTOR`] times this.
pub const DEFAULT_KEEPALIVE_MS: u64 = 5_000;

/// A link silent for this many keepalives is one nothing will ever report ended.
pub const SILENCE_FACTOR: f64 = 2.5;

pub const QUIET: &str = "the peer went quiet past its deadline and was hung up on";
pub const UNPINNED: &str =
    "the peer's hello is signed by a key other than the one this link was told to expect";
pub const NOT_ADMITTED: &str = "the door refused this peer";
pub const CLOSED: &str = "the link was closed";

/// How the medium carries bytes, and so how a frame's boundaries survive it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Framing {
    /// A byte stream with no boundaries — TCP, a Wi-Fi Aware or AWDL data path: a four-byte
    /// big-endian length before every frame (`framed`). A length past `max_frame_bytes` ends the
    /// link: a stranger announcing four gigabytes is not believed.
    Stream { max_frame_bytes: usize },
    /// A medium that keeps message boundaries — a WebSocket, a datagram path that reassembles:
    /// one frame per message, as the TypeScript upgrader's `frames` takes it.
    Messages,
    /// A BLE characteristic: every frame cut into fragments of at most `write_limit` bytes, each
    /// with an eight-byte header (`fragment.ts`, `conformance/fragment-vectors.json`), and put back
    /// together in any order on arrival.
    Fragments {
        write_limit: usize,
        max_message_bytes: usize,
        max_assemblies: usize,
    },
}

impl Framing {
    /// A byte stream under the TypeScript's default cap.
    pub const STREAM: Framing = Framing::Stream {
        max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
    };

    /// A BLE link writing at most `write_limit` bytes at a time, with the TypeScript's caps.
    pub fn fragments(write_limit: usize) -> Framing {
        Framing::Fragments {
            write_limit,
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
            max_assemblies: DEFAULT_MAX_ASSEMBLIES,
        }
    }
}

/// Whether a link to this proved peer may stand (the door, book ch. 14). Asked once, after the
/// handshake has named the peer.
pub type Admits = Box<dyn Fn(&PeerId) -> bool + Send>;

/// What one session carries, decided by whoever opened the link (`BridgeOptions`).
pub struct SessionOptions {
    /// The slice this link syncs: what a join asks with and what digests are counted over. It
    /// narrows nothing else — a peer link sends every event, as the TypeScript bridge does.
    pub interest: Option<Interest>,
    /// Out-of-order events held per author before the run is re-asked from the cursors. 512.
    pub gap_limit: usize,
    /// This device's storage lineage. With one, every fold signs a custody receipt back to the
    /// author's link (D28); without, nothing is vouched for.
    pub incarnation: Option<String>,
    /// Rows per page of a served snapshot. 500.
    pub rows_per_chunk: usize,
    /// This device's checkpoint certificate, relayed with any state it serves.
    pub certificate: Option<Vec<u8>>,
    /// Whose certificate this device believes; `None`, every install stays provisional.
    pub trust: Option<PeerId>,
    /// The mesh's recovery record (D46), shared so a floor asked on one link is not asked again on
    /// another. `None`, the session keeps its own.
    pub rejoins: Option<Arc<Mutex<Rejoins>>>,
    /// Where an arriving grant is registered before anything beside it folds, and where the grants
    /// sent on open come from.
    pub grants: Option<Arc<Mutex<GrantRegistry>>>,
    /// The authority-visibility tables (D24), which no peer link carries: their events are not
    /// sent, their rows not served, their tables not digested.
    pub withheld: Option<Withheld>,
}

impl Default for SessionOptions {
    fn default() -> Self {
        SessionOptions {
            interest: None,
            gap_limit: 512,
            incarnation: None,
            rows_per_chunk: 500,
            certificate: None,
            trust: None,
            rejoins: None,
            grants: None,
            withheld: None,
        }
    }
}

/// How one link behaves (`UpgradeOptions`, `SessionOptions` in `session.ts`).
pub struct PeerOptions {
    /// For log lines a person reads.
    pub name: String,
    pub framing: Framing,
    /// The one peer this link accepts a hello from; another key is refused. `None`, any peer that
    /// proves its key is admitted to the door.
    pub peer_key: Option<PeerId>,
    /// The door; `None` admits every proved peer.
    pub admits: Option<Admits>,
    /// How often a quiet link is prodded with our cursors (`createLiveness`); `None` leaves a dead
    /// medium for the host to notice.
    pub keepalive_ms: Option<u64>,
    pub session: SessionOptions,
}

impl Default for PeerOptions {
    fn default() -> Self {
        PeerOptions {
            name: "peer".to_owned(),
            framing: Framing::STREAM,
            peer_key: None,
            admits: None,
            keepalive_ms: Some(DEFAULT_KEEPALIVE_MS),
            session: SessionOptions::default(),
        }
    }
}

/// What the host is asked to do, or told, in the order it became true.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum PeerAction {
    /// Bytes for the medium: a length-prefixed frame on a stream, one message on a message medium,
    /// one fragment under [`Framing::Fragments`]. From a [`PeerSession`] alone, one plaintext frame.
    Send(Vec<u8>),
    /// A frame that supersedes any still waiting under the same `slot` (D16): a medium that can
    /// back up keeps only the newest per slot (`FrameLink.sendLatest`); one that cannot sends the
    /// units in order, as [`PeerAction::Send`] would.
    SendLatest {
        slot: String,
        units: Vec<Vec<u8>>,
    },
    /// Hang up; then call [`PeerLink::on_closed`].
    Close {
        reason: String,
    },
    /// The hello proved this peer and the door admitted it: the session is open.
    Established(PeerId),
    /// The same peer handshook again on this link and its new session replaced the old one: the
    /// far side's half of the link died with nothing reporting it.
    Superseded(PeerId),
    /// The peer proved its key and was refused: pinned to another, or the door said no. A
    /// [`PeerAction::Close`] follows. Worth remembering, so the next sighting is not re-dialled.
    Refused {
        peer: PeerId,
        reason: String,
    },
    Folded(FoldBatch),
    /// An inbound presence wire for the ephemeral tier (D16).
    Presence(Vec<u8>),
    /// An inbound grant wire; registered already when the session has a registry, and never one
    /// that registry refused.
    Grant(Vec<u8>),
    GrantRequest {
        peer_id: PeerId,
        invite: Option<String>,
    },
    /// A verified receipt for one of this device's own writes: the far side holds it (D28).
    Receipt(CustodyReceipt),
    /// A verified refusal of one of this device's own writes: the far side parked it (D32).
    Refusal(RefusalReceipt),
    /// The far side's fingerprints disagree with ours for these tables over a slice both counted
    /// at the same position (RFC-0014). Repair is the host's.
    Divergence {
        tables: Vec<String>,
    },
    /// A join this device asked for ended (RFC-0019): installed, or refused whole.
    Snapshot(Settled),
    /// This session raised or cleared a floor issue in its [`Rejoins`] record (D46): this device
    /// is below the peer's floor and waits on [`PeerSession::accept_floor`], or that is over.
    /// Re-read [`Rejoins::issues`]; a mesh says it as `MeshEvent::Recovery`.
    Recovery,
    /// Bytes that became nothing, said: an unreadable frame, an event that does not verify.
    Dropped(String),
    /// The link is over; the session's open requests count as never answered.
    Ended {
        reason: String,
    },
}

// --- the session ------------------------------------------------------------------------------

/// Runs `step` on the recovery record under one lock, and says [`PeerAction::Recovery`] when it
/// raised or cleared an issue there.
fn on_record<T>(
    rejoins: &Mutex<Rejoins>,
    out: &mut Vec<PeerAction>,
    step: impl FnOnce(&mut Rejoins) -> T,
) -> T {
    let mut record = lock(rejoins);
    let before = record.changes();
    let result = step(&mut record);
    if record.changes() != before {
        out.push(PeerAction::Recovery);
    }
    result
}

/// Frames offered in one turn, with the slot a presence value supersedes under.
#[derive(Default)]
struct Turn(Vec<(u8, Vec<u8>, Option<String>)>);

impl Turn {
    fn push(&mut self, class: u8, frame: Vec<u8>) {
        self.0.push((class, frame, None));
    }

    /// Out in tag order, each class in the order it was offered (`outbox.ts`).
    fn flush(&mut self, out: &mut Vec<PeerAction>) {
        let mut frames = std::mem::take(&mut self.0);
        frames.sort_by_key(|(class, _, _)| *class);
        for (_, frame, slot) in frames {
            out.push(match slot {
                Some(slot) => PeerAction::SendLatest {
                    slot,
                    units: vec![frame],
                },
                None => PeerAction::Send(frame),
            });
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The `(topic, instance, peer)` a presence value is the newest of (`presenceSlot`); `None` for
/// bytes that are not one. Read without verifying: it only chooses which outgoing frame to keep.
pub fn presence_slot(wire: &[u8]) -> Option<String> {
    let (core, _) = syncmesh_core::envelope::split_envelope(wire).ok()?;
    let presence = decode_presence_core(&core).ok()?;
    Some(format!(
        "{} {} {}",
        presence.topic,
        presence.partition.as_str(),
        presence.peer_id.as_str()
    ))
}

/// One session over one link, in plaintext frames (`bridgeFramedLink`): grants first, then
/// cursors, then events, with the gap rule.
pub struct PeerSession {
    identity: Identity,
    /// Who the handshake proved; what the join and the custody judge by.
    peer: PeerId,
    interest: Option<Interest>,
    scope: String,
    incarnation: Option<String>,
    withheld: Option<Withheld>,
    grants: Option<Arc<Mutex<GrantRegistry>>>,
    rejoins: Arc<Mutex<Rejoins>>,
    join: Option<PeerJoin>,
    holdback: Holdback,
    /// Per author, the refusals already said to it on this link: once per refusal per seating.
    said: BTreeMap<PeerId, BTreeSet<String>>,
}

impl std::fmt::Debug for PeerSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerSession")
            .field("peer", &self.peer)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

impl PeerSession {
    /// Opens the session with `peer`: every grant this device holds, then its cursors.
    ///
    /// **Call [`PeerSession::close`] when the link ends**, or its open join requests stay in the
    /// recovery record for good.
    pub fn open(
        identity: Identity,
        peer: PeerId,
        options: SessionOptions,
        engine: &Engine,
    ) -> (PeerSession, Vec<PeerAction>) {
        let rejoins = options.rejoins.unwrap_or_default();
        let exchange = JoinExchange::new(JoinOptions {
            rows_per_chunk: options.rows_per_chunk,
            certificate: options.certificate,
            trust: options.trust,
            withheld: options.withheld.clone(),
            ..JoinOptions::new(
                identity
                    .peer_id()
                    .as_str()
                    .chars()
                    .take(8)
                    .collect::<String>(),
            )
        });
        let join = PeerJoin::open(&mut lock(&rejoins), exchange, options.interest.clone());
        let session = PeerSession {
            scope: interest_key(options.interest.as_ref()),
            identity,
            peer,
            interest: options.interest,
            incarnation: options.incarnation,
            withheld: options.withheld,
            grants: options.grants,
            rejoins,
            join: Some(join),
            holdback: Holdback::new(options.gap_limit),
            said: BTreeMap::new(),
        };
        let mut out = Vec::new();
        let mut turn = Turn::default();
        if let Some(registry) = &session.grants {
            for wire in lock(registry).all_wires() {
                turn.push(tag::GRANT, grant_frame(&wire));
            }
        }
        turn.flush(&mut out);
        session.send_cursors(engine, &mut out);
        (session, out)
    }

    /// The peer the handshake proved.
    pub fn peer(&self) -> &PeerId {
        &self.peer
    }

    /// One plaintext frame from the far side.
    pub fn on_frame(&mut self, engine: &mut Engine, plain: &[u8], now_ms: i64) -> Vec<PeerAction> {
        let mut out = Vec::new();
        let frame = match decode_frame(plain) {
            Ok(frame) => frame,
            Err(e) => {
                out.push(PeerAction::Dropped(e.to_string()));
                return out;
            }
        };
        match frame {
            Frame::Cursors {
                from,
                cursors,
                ahead,
                floor,
                ..
            } => self.on_cursors(engine, from, cursors, ahead, floor, now_ms, &mut out),
            Frame::Event { wire } => self.on_event(engine, &wire, now_ms, &mut out),
            Frame::Presence { wire } => out.push(PeerAction::Presence(wire)),
            Frame::Grant { wire } => self.grant_arrived(engine, wire, now_ms, &mut out),
            Frame::GrantRequest { peer_id, invite } => {
                out.push(PeerAction::GrantRequest { peer_id, invite });
            }
            Frame::Digest {
                scope,
                at,
                digests,
                ahead,
            } => self.on_digest(engine, &scope, &at, &digests, ahead.as_deref(), &mut out),
            Frame::Receipt { wire } => match verify_receipt(&wire) {
                // only this device's own writes: a receipt about another log is not ours to keep
                Ok(signed) if &signed.value.author == self.identity.peer_id() => {
                    out.push(PeerAction::Receipt(signed.value));
                }
                Ok(_) => {}
                Err(e) => out.push(PeerAction::Dropped(format!(
                    "a receipt did not verify: {e}"
                ))),
            },
            Frame::Refusal { wire } => match verify_refusal(&wire) {
                Ok(signed) if &signed.value.author == self.identity.peer_id() => {
                    out.push(PeerAction::Refusal(signed.value));
                }
                Ok(_) => {}
                Err(e) => out.push(PeerAction::Dropped(format!(
                    "a refusal did not verify: {e}"
                ))),
            },
            Frame::Snapshot(frame) => self.on_snapshot(engine, frame, &mut out),
            // no read gate and no route table here: a withheld frame is taken only under a gate
            // (D40), and routes only by a device that keeps a table (book ch. 17)
            Frame::Withheld { .. } | Frame::Routes { .. } | Frame::Unknown => {}
        }
        out
    }

    /// The far side said where it stands: send what it lacks, a digest of what we hold, the
    /// refusals still parked for it, and our cursors when it is ahead of us; ask for state when
    /// this device is below its floor (D46).
    #[allow(
        clippy::too_many_arguments,
        reason = "the cursors frame's fields, taken apart once where the frame is matched"
    )]
    fn on_cursors(
        &mut self,
        engine: &mut Engine,
        from: PeerId,
        cursors: Vec<(PeerId, SeqNum)>,
        ahead: Option<Vec<(PeerId, Vec<SeqNum>)>>,
        floor: Option<Vec<(PeerId, SeqNum)>>,
        now_ms: i64,
        out: &mut Vec<PeerAction>,
    ) {
        let theirs = cursors_to_map(&cursors);
        let their_ahead: Ahead = ahead.unwrap_or_default().into_iter().collect();
        engine.acknowledge(from.clone(), theirs.clone(), now_ms);
        let mut turn = Turn::default();
        match engine.events_since(&theirs, None) {
            Err(e) => out.push(PeerAction::Dropped(format!(
                "the log could not say what the peer lacks: {e}"
            ))),
            Ok(entries) => {
                for entry in entries {
                    // an event they hold above their cursor is not sent again (D13)
                    let held = their_ahead
                        .get(&entry.event.peer_id)
                        .is_some_and(|seqs| seqs.contains(&entry.event.seq_num));
                    if held || self.withholds(&entry) {
                        continue;
                    }
                    match entry.envelope() {
                        Some(wire) => turn.push(tag::EVENT, event_frame(&wire)),
                        None => out.push(PeerAction::Dropped(format!(
                            "{} has no stored signature to relay",
                            entry.id()
                        ))),
                    }
                }
            }
        }
        turn.push(tag::DIGEST, self.digest(engine));
        // still parked, said again: a peer told we hold it above our cursor never re-offers it
        let author = from;
        let parked: Vec<_> = engine
            .quarantine()
            .into_iter()
            .filter(|p| p.entry.event.peer_id == author)
            .cloned()
            .collect();
        let current: BTreeSet<String> = parked.iter().map(refusal_key).collect();
        if let Some(said) = self.said.get_mut(&author) {
            said.retain(|key| current.contains(key));
        }
        self.refuse(parked, now_ms, &mut turn);
        // below their floor, nothing above can reach us: state is the only answer (D46)
        if let Some(join) = self.join.as_mut() {
            let floor = floor.map(|f| cursors_to_map(&f));
            let asks = on_record(&self.rejoins, out, |rejoins| {
                join.on_cursors(rejoins, engine, &self.peer, &theirs, floor.as_ref())
            });
            for frame in asks {
                turn.push(tag::SNAPSHOT, frame);
            }
        }
        turn.flush(out);
        // they hold an author ahead of us: our cursors are the request for the diff
        let ours = engine.coverage().synced;
        let behind = theirs.iter().any(|(author, seq)| {
            author != self.identity.peer_id() && ours.get(author).is_none_or(|s| s < seq)
        });
        if behind {
            self.send_cursors(engine, out);
        }
    }

    /// Verifies, holds back, folds; then the receipt, the refusals, and our cursors.
    /// The grant into the registry, when the session has one, and then reported unless the
    /// registry refused it (said as [`PeerAction::Dropped`] instead). A
    /// grant that becomes the one the registry holds re-offers its device's events parked on a
    /// capability verdict ([`Engine::retry_author`], gaps U42), and what folds is announced as
    /// any fold is; one the registry already held, or held newer, retries nothing.
    fn grant_arrived(
        &self,
        engine: &mut Engine,
        wire: Vec<u8>,
        now_ms: i64,
        out: &mut Vec<PeerAction>,
    ) {
        if let Some(registry) = &self.grants {
            // released before the retry: the validator reads the same registry
            let registered = lock(registry).register_newer(&wire, now_ms);
            match registered {
                Ok(None) => {}
                Ok(Some(device)) => match engine.retry_author(&device) {
                    Ok(received) if received.batch.event_count > 0 => {
                        out.push(PeerAction::Folded(received.batch));
                        self.send_cursors(engine, out);
                    }
                    Ok(_) => {}
                    Err(e) => out.push(PeerAction::Dropped(format!(
                        "events parked for a granted device could not be retried: {e}"
                    ))),
                },
                Err(e) => {
                    // refused, so not reported as a grant: the host would take it as registered
                    out.push(PeerAction::Dropped(format!(
                        "a peer's grant was refused: {e}"
                    )));
                    return;
                }
            }
        }
        out.push(PeerAction::Grant(wire));
    }

    fn on_event(
        &mut self,
        engine: &mut Engine,
        wire: &[u8],
        now_ms: i64,
        out: &mut Vec<PeerAction>,
    ) {
        let verified = match decode_and_verify(wire) {
            Ok(v) => v,
            Err(e) => {
                out.push(PeerAction::Dropped(e.to_string()));
                return;
            }
        };
        let entry = StoredEvent::from_verified(verified);
        let author = entry.event.peer_id.clone();
        if self.holdback.put(entry, engine) {
            // the run overflowed the holdback: ask again from where we stand
            self.send_cursors(engine, out);
            return;
        }
        let ready = self.holdback.drain(&author, engine);
        if ready.is_empty() {
            return;
        }
        let offered: BTreeSet<String> = ready.iter().map(StoredEvent::id).collect();
        let received = match engine.receive_batch(ready) {
            Ok(received) => received,
            Err(e) => {
                out.push(PeerAction::Dropped(format!(
                    "the store refused a batch: {e}"
                )));
                return;
            }
        };
        let mut turn = Turn::default();
        // durable now, so the claim can be signed: a cursor says this and proves none of it
        self.vouch(engine, &author, now_ms, &mut turn);
        // and what this batch parked, said back to whoever offered it (D32)
        let parked: Vec<_> = engine
            .quarantine()
            .into_iter()
            .filter(|p| offered.contains(&p.entry.id()))
            .cloned()
            .collect();
        self.refuse(parked, now_ms, &mut turn);
        turn.flush(out);
        if received.batch.event_count > 0 {
            out.push(PeerAction::Folded(received.batch));
            // this engine now holds more than its neighbours may: announce, so they request
            self.send_cursors(engine, out);
        }
    }

    fn on_digest(
        &self,
        engine: &Engine,
        scope: &str,
        at: &[(PeerId, SeqNum)],
        digests: &[(String, syncmesh_core::frames::Digest)],
        ahead: Option<&[(PeerId, Vec<SeqNum>)]>,
        out: &mut Vec<PeerAction>,
    ) {
        let at = cursors_to_map(at);
        let their_ahead: Option<Ahead> = ahead.map(|a| a.iter().cloned().collect());
        let synced = engine.coverage().synced;
        let our_ahead = engine.ahead();
        let ours = self.open_digests(engine);
        let compared = divergence_against(
            &OurDigest {
                scope: &self.scope,
                interest: self.interest.as_ref(),
                synced: &synced,
                ahead: &our_ahead,
                digests: &ours,
            },
            &TheirDigest {
                scope,
                at: &at,
                digests: &self.open_pairs(digests),
                ahead: their_ahead.as_ref(),
            },
        );
        if let Some(tables) = compared.filter(|t| !t.is_empty()) {
            out.push(PeerAction::Divergence { tables });
        }
    }

    fn on_snapshot(
        &mut self,
        engine: &mut Engine,
        frame: SnapshotFrame,
        out: &mut Vec<PeerAction>,
    ) {
        let Some(join) = self.join.as_mut() else {
            return;
        };
        let mut changed = Vec::new();
        let step = on_record(&self.rejoins, &mut changed, |rejoins| {
            join.on_snapshot(rejoins, engine, frame)
        });
        match step {
            Ok(step) => {
                let mut turn = Turn::default();
                for frame in step.send {
                    turn.push(tag::SNAPSHOT, frame);
                }
                turn.flush(out);
                if let Some(settled) = step.settled {
                    out.push(PeerAction::Snapshot(settled));
                }
            }
            Err(e) => out.push(PeerAction::Dropped(format!(
                "the store refused a snapshot install: {e}"
            ))),
        }
        out.extend(changed);
    }

    /// This device wrote something: signed at `mutate`, sent as it was signed. A local-only write
    /// never leaves, and neither does one to an authority-visibility table (D24).
    pub fn on_local_write(&mut self, entry: &StoredEvent) -> Vec<PeerAction> {
        let mut out = Vec::new();
        if entry.local || self.withholds(entry) {
            return out;
        }
        match entry.envelope() {
            Some(wire) => out.push(PeerAction::Send(event_frame(&wire))),
            None => out.push(PeerAction::Dropped(format!(
                "{} carries no signature to send",
                entry.id()
            ))),
        }
        out
    }

    /// Something folded from another source: this device may now hold what the far side lacks.
    pub fn on_remote_fold(&mut self, engine: &Engine) -> Vec<PeerAction> {
        let mut out = Vec::new();
        self.send_cursors(engine, &mut out);
        out
    }

    /// Re-requests from our contiguous position: the recovery for any lost frame, and the probe a
    /// quiet link is prodded with.
    pub fn resync(&mut self, engine: &Engine) -> Vec<PeerAction> {
        self.on_remote_fold(engine)
    }

    /// Asks the far side for state rather than history (RFC-0019), narrowed to `interest`; a
    /// rebuild adopts its coverage unvouched. [`PeerAction::Snapshot`] says how it ended.
    pub fn request_snapshot(
        &mut self,
        interest: Option<&Interest>,
        adopt_unvouched: bool,
    ) -> (Option<Ticket>, Vec<PeerAction>) {
        let Some(join) = self.join.as_mut() else {
            return (None, Vec::new());
        };
        let (ticket, frame) = join.exchange().request(interest, adopt_unvouched);
        (Some(ticket), vec![PeerAction::Send(frame)])
    }

    /// The app's consent to install unvouched state from this peer, up to the floor it claimed
    /// (`$recovery.accept`, D46): [`Rejoins::accept`] for the proved peer, and the request it
    /// decided sent down this link at once.
    pub fn accept_floor(&mut self, engine: &Engine) -> (Accepted, Vec<PeerAction>) {
        let ours = engine.coverage().synced;
        let mut changed = Vec::new();
        let (accepted, asks) = on_record(&self.rejoins, &mut changed, |rejoins| {
            let accepted = rejoins.accept(&self.peer, &ours);
            let asks = self
                .join
                .as_mut()
                .map(|join| join.flush(rejoins))
                .unwrap_or_default();
            (accepted, asks)
        });
        let mut out: Vec<PeerAction> = asks.into_iter().map(PeerAction::Send).collect();
        out.extend(changed);
        (accepted, out)
    }

    /// Asks the far side for a grant for this device (flow A step ②).
    pub fn request_grant(&self, invite: Option<&str>) -> Vec<PeerAction> {
        vec![PeerAction::Send(grant_request_frame(
            self.identity.peer_id(),
            invite,
        ))]
    }

    /// Grants for the far side: one this device learned, or the answer to a request.
    pub fn send_grants(&self, wires: &[Vec<u8>]) -> Vec<PeerAction> {
        wires
            .iter()
            .map(|wire| PeerAction::Send(grant_frame(wire)))
            .collect()
    }

    /// One ephemeral value, slotted so a medium that backs up keeps only the newest (D16).
    pub fn send_presence(&self, wire: &[u8]) -> Vec<PeerAction> {
        let frame = presence_frame(wire);
        vec![match presence_slot(wire) {
            Some(slot) => PeerAction::SendLatest {
                slot,
                units: vec![frame],
            },
            None => PeerAction::Send(frame),
        }]
    }

    /// The link ended: open join requests count as never answered.
    pub fn close(mut self) {
        if let Some(join) = self.join.take() {
            join.close(&mut lock(&self.rejoins));
        }
    }

    /// Where we stand: cursors, what we hold above them, the floor our log was compacted below
    /// (D46) and our build's schema (D31). `ahead` always travels, as the TypeScript's does.
    fn send_cursors(&self, engine: &Engine, out: &mut Vec<PeerAction>) {
        let cursors: Vec<(PeerId, SeqNum)> = engine.cursors().into_iter().collect();
        let ahead: Vec<(PeerId, Vec<SeqNum>)> = engine.ahead().into_iter().collect();
        let floor: Vec<(PeerId, SeqNum)> = engine.floor().into_iter().collect();
        out.push(PeerAction::Send(cursors_frame(
            self.identity.peer_id(),
            &cursors,
            Some(&ahead),
            (!floor.is_empty()).then_some(floor.as_slice()),
            engine.schema_version(),
        )));
    }

    fn digest(&self, engine: &Engine) -> Vec<u8> {
        let synced: Vec<(PeerId, SeqNum)> = engine.coverage().synced.into_iter().collect();
        let ahead: Vec<(PeerId, Vec<SeqNum>)> = engine.ahead().into_iter().collect();
        digest_frame(
            &self.scope,
            &synced,
            &digest_pairs(&self.open_digests(engine)),
            Some(&ahead),
        )
    }

    /// Our digests with the gated tables left out: devices admitted different rows agree.
    fn open_digests(&self, engine: &Engine) -> BTreeMap<String, u64> {
        let mut digests = table_digests(engine.state(), self.interest.as_ref());
        if let Some(withheld) = &self.withheld {
            digests.retain(|table, _| !withheld.tables.contains(table));
        }
        digests
    }

    fn open_pairs(
        &self,
        pairs: &[(String, syncmesh_core::frames::Digest)],
    ) -> Vec<(String, syncmesh_core::frames::Digest)> {
        pairs
            .iter()
            .filter(|(table, _)| {
                self.withheld
                    .as_ref()
                    .is_none_or(|w| !w.tables.contains(table))
            })
            .cloned()
            .collect()
    }

    fn withholds(&self, entry: &StoredEvent) -> bool {
        self.withheld.as_ref().is_some_and(|w| {
            !w.tables.is_empty()
                && entry
                    .event
                    .changes
                    .iter()
                    .any(|c| w.tables.contains(c.table()))
        })
    }

    /// Signs what this device holds of `author`'s run, when it can say which store holds it. A
    /// scoped cursor stands past events this device was never sent, so a scoped device signs none.
    fn vouch(&self, engine: &Engine, author: &PeerId, now_ms: i64, turn: &mut Turn) {
        let Some(incarnation) = &self.incarnation else {
            return;
        };
        let coverage = engine.coverage();
        if coverage.scope.is_some() {
            return;
        }
        let Some(&through_seq) = coverage.synced.get(author) else {
            return;
        };
        let wire = issue_receipt(
            &self.identity,
            &ReceiptRequest {
                author: author.clone(),
                through_seq,
                incarnation: incarnation.clone(),
                now_ms,
            },
        );
        turn.push(tag::RECEIPT, receipt_frame(&wire));
    }

    /// One signed refusal per parked event not yet said to its author on this link.
    fn refuse(&mut self, parked: Vec<crate::quarantine::Parked>, now_ms: i64, turn: &mut Turn) {
        for each in parked {
            let key = refusal_key(&each);
            let author = each.entry.event.peer_id.clone();
            if !self.said.entry(author.clone()).or_default().insert(key) {
                continue;
            }
            let wire = issue_refusal(
                &self.identity,
                &RefusalRequest {
                    author,
                    seq: each.entry.event.seq_num,
                    reason: each.reason.wire(),
                    verdict: each.verdict.tag().to_owned(),
                    now_ms,
                },
            );
            turn.push(tag::REFUSAL, refusal_frame(&wire));
        }
    }
}

/// One refusal as a seating hears it: the event, and the verdict this build reached on it.
fn refusal_key(parked: &crate::quarantine::Parked) -> String {
    format!("{}:{}", parked.entry.id(), parked.verdict.tag())
}

// --- the sealed link --------------------------------------------------------------------------

/// What one raw frame did to the handshake.
enum Opened {
    /// The peer's hello proved it and the keys are agreed.
    Established(PeerId),
    /// A sealed frame's plaintext.
    Plain(Vec<u8>),
    /// The proved peer started over on this link; `greet` is our fresh hello, to go out unsealed.
    Superseded {
        peer: PeerId,
        greet: Option<Vec<u8>>,
    },
    Dropped(String),
    /// The link is finished.
    Failed(String),
}

/// `secureLink`: our hello and the secret behind it, the agreed keys, and the replay window.
struct Secure {
    identity: Identity,
    secret: [u8; KEY_BYTES],
    ours: Hello,
    keys: Option<SessionKeys>,
    proven: Option<PeerId>,
    /// Whether the peer has used the hello we offer now: a frame opened under its keys.
    confirmed: bool,
    /// Ephemeral keys this link has agreed a session under, oldest first.
    offered: VecDeque<[u8; KEY_BYTES]>,
}

impl Secure {
    fn offer(identity: Identity) -> Secure {
        let secret: [u8; KEY_BYTES] = crate::random::bytes();
        Secure {
            ours: write_hello(&identity, &secret),
            identity,
            secret,
            keys: None,
            proven: None,
            confirmed: false,
            offered: VecDeque::new(),
        }
    }

    fn remember(&mut self, ephemeral: [u8; KEY_BYTES]) {
        self.offered.push_back(ephemeral);
        if self.offered.len() > KEYS_REMEMBERED {
            self.offered.pop_front();
        }
    }

    fn accept(&mut self, raw: &[u8]) -> Opened {
        let Some(keys) = &self.keys else {
            if raw.first() != Some(&HELLO) {
                return Opened::Dropped("a frame arrived before the session was open".to_owned());
            }
            let theirs = match read_hello(raw) {
                Ok(h) => h,
                Err(e) => return Opened::Failed(e.to_string()),
            };
            return match session_keys(&self.secret, &self.ours, &theirs) {
                Ok(agreed) => {
                    self.keys = Some(agreed);
                    self.confirmed = false;
                    self.proven = Some(theirs.peer_id.clone());
                    self.remember(theirs.ephemeral);
                    Opened::Established(theirs.peer_id)
                }
                Err(e) => Opened::Failed(e.to_string()),
            };
        };
        // a second hello is the peer starting over on a link nothing told us had ended
        if raw.first() == Some(&HELLO) {
            return self.supersede(raw);
        }
        match unseal(&keys.open, raw) {
            Ok(plain) => {
                self.confirmed = true;
                Opened::Plain(plain)
            }
            Err(e) => Opened::Dropped(e.to_string()),
        }
    }

    /// A hello on an open session, held to being from the peer already proved and not one this
    /// link agreed a session under before. Answered with a fresh hello only when the peer has used
    /// ours — otherwise ours is still in flight and theirs is the answer to it.
    fn supersede(&mut self, raw: &[u8]) -> Opened {
        let theirs = match read_hello(raw) {
            Ok(h) => h,
            Err(e) => return Opened::Dropped(e.to_string()),
        };
        if Some(&theirs.peer_id) != self.proven.as_ref() {
            let held = self
                .proven
                .as_ref()
                .map_or("nobody".to_owned(), |p| short(p).to_owned());
            return Opened::Dropped(format!(
                "{} offered a session on a link held by {held}",
                short(&theirs.peer_id)
            ));
        }
        if self.offered.contains(&theirs.ephemeral) {
            return Opened::Dropped(
                "a hello this link has already agreed a session under, offered again".to_owned(),
            );
        }
        let offering = self.confirmed;
        if offering {
            self.secret = crate::random::bytes();
            self.ours = write_hello(&self.identity, &self.secret);
        }
        let agreed = match session_keys(&self.secret, &self.ours, &theirs) {
            Ok(k) => k,
            Err(e) => return Opened::Failed(e.to_string()),
        };
        self.keys = Some(agreed);
        self.confirmed = false;
        self.remember(theirs.ephemeral);
        Opened::Superseded {
            peer: theirs.peer_id,
            greet: offering.then(|| self.ours.frame.to_vec()),
        }
    }

    fn seal(&self, plain: &[u8]) -> Option<Vec<u8>> {
        let keys = self.keys.as_ref()?;
        seal(&keys.seal, plain, &crate::random::nonce()).ok()
    }
}

fn short(peer: &PeerId) -> &str {
    let id = peer.as_str();
    id.get(..8).unwrap_or(id)
}

/// The inbound half of a [`Framing`].
enum Unframe {
    Stream(FrameReader),
    Messages,
    Fragments(Reassembler),
}

// --- the link ---------------------------------------------------------------------------------

/// One link to one peer over a byte duplex. See the module notes for how a host drives it.
pub struct PeerLink {
    name: String,
    framing: Framing,
    unframe: Unframe,
    /// The next fragment message id.
    message: u32,
    secure: Secure,
    peer_key: Option<PeerId>,
    admits: Option<Admits>,
    /// Taken when the session opens.
    options: Option<SessionOptions>,
    session: Option<PeerSession>,
    keepalive_ms: Option<u64>,
    heard_ms: Option<i64>,
    check_ms: Option<i64>,
    closing: bool,
    ended: bool,
}

impl std::fmt::Debug for PeerLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerLink")
            .field("name", &self.name)
            .field("peer", &self.peer())
            .field("closing", &self.closing)
            .finish_non_exhaustive()
    }
}

impl PeerLink {
    /// A link over a medium that just opened, and our hello — the first thing it sends, unprompted,
    /// whichever end dialled. `now_ms` starts the liveness clock.
    pub fn open(
        identity: Identity,
        options: PeerOptions,
        now_ms: i64,
    ) -> (PeerLink, Vec<PeerAction>) {
        let unframe = match options.framing {
            Framing::Stream { max_frame_bytes } => {
                Unframe::Stream(FrameReader::new(max_frame_bytes))
            }
            Framing::Messages => Unframe::Messages,
            Framing::Fragments {
                max_message_bytes,
                max_assemblies,
                ..
            } => Unframe::Fragments(Reassembler::new(max_message_bytes, max_assemblies)),
        };
        let mut link = PeerLink {
            name: options.name,
            framing: options.framing,
            unframe,
            message: 0,
            secure: Secure::offer(identity),
            peer_key: options.peer_key,
            admits: options.admits,
            options: Some(options.session),
            session: None,
            keepalive_ms: options.keepalive_ms,
            heard_ms: Some(now_ms),
            check_ms: options
                .keepalive_ms
                .map(|every| now_ms.saturating_add(every as i64)),
            closing: false,
            ended: false,
        };
        let mut out = Vec::new();
        let hello = link.secure.ours.frame.to_vec();
        link.write(&hello, None, &mut out);
        (link, out)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The peer the handshake proved, once the session is open.
    pub fn peer(&self) -> Option<&PeerId> {
        self.session.as_ref().map(PeerSession::peer)
    }

    pub fn is_established(&self) -> bool {
        self.session.is_some()
    }

    /// A close has been asked for, or the link has ended.
    pub fn is_closed(&self) -> bool {
        self.closing || self.ended
    }

    /// When [`PeerLink::on_tick`] next has something to do, in the host's clock.
    pub fn next_deadline_ms(&self) -> Option<i64> {
        if self.is_closed() {
            return None;
        }
        self.check_ms
    }

    /// Raw bytes from the medium: one read of a stream, one message, or one fragment.
    pub fn on_bytes(&mut self, engine: &mut Engine, raw: &[u8], now_ms: i64) -> Vec<PeerAction> {
        let mut out = Vec::new();
        if self.is_closed() {
            return out;
        }
        self.heard_ms = Some(now_ms);
        let frames = match &mut self.unframe {
            Unframe::Messages => vec![raw.to_vec()],
            Unframe::Fragments(reader) => {
                let frame = reader.accept(raw);
                for gone in reader.take_abandoned() {
                    out.push(PeerAction::Dropped(format!(
                        "a {}-byte partial message {} was given up on ({:?})",
                        gone.held, gone.message, gone.why
                    )));
                }
                frame.into_iter().collect()
            }
            Unframe::Stream(reader) => {
                reader.push(raw);
                let (frames, broken) = reader.drain();
                if let Some(e) = broken {
                    out.push(PeerAction::Dropped(e.to_string()));
                    // what arrived before the broken length is still read; the link goes after
                    for frame in frames {
                        self.on_frame(engine, &frame, now_ms, &mut out);
                    }
                    self.hang_up(&e.to_string(), &mut out);
                    return out;
                }
                frames
            }
        };
        for frame in frames {
            if self.closing {
                break;
            }
            self.on_frame(engine, &frame, now_ms, &mut out);
        }
        out
    }

    fn on_frame(
        &mut self,
        engine: &mut Engine,
        frame: &[u8],
        now_ms: i64,
        out: &mut Vec<PeerAction>,
    ) {
        match self.secure.accept(frame) {
            Opened::Plain(plain) => {
                if let Some(session) = self.session.as_mut() {
                    let actions = session.on_frame(engine, &plain, now_ms);
                    self.seal_all(actions, out);
                }
            }
            Opened::Established(peer) => self.establish(engine, peer, out),
            Opened::Superseded { peer, greet } => {
                if let Some(hello) = greet {
                    self.write(&hello, None, out);
                }
                out.push(PeerAction::Superseded(peer));
            }
            Opened::Dropped(why) => out.push(PeerAction::Dropped(why)),
            Opened::Failed(why) => {
                self.hang_up(&format!("the session with a peer failed: {why}"), out);
            }
        }
    }

    /// The hello proved `peer`: the pin and the door, then the session.
    fn establish(&mut self, engine: &mut Engine, peer: PeerId, out: &mut Vec<PeerAction>) {
        let refused = if self.peer_key.as_ref().is_some_and(|pin| pin != &peer) {
            Some(UNPINNED)
        } else if self.admits.as_ref().is_some_and(|admits| !admits(&peer)) {
            Some(NOT_ADMITTED)
        } else {
            None
        };
        if let Some(reason) = refused {
            out.push(PeerAction::Refused {
                peer,
                reason: reason.to_owned(),
            });
            self.hang_up(reason, out);
            return;
        }
        let Some(options) = self.options.take() else {
            return;
        };
        let identity = self.secure.identity.clone();
        out.push(PeerAction::Established(peer.clone()));
        let (session, actions) = PeerSession::open(identity, peer, options, engine);
        self.session = Some(session);
        self.seal_all(actions, out);
    }

    /// A session's plaintext sends, sealed and framed; its facts passed through.
    fn seal_all(&mut self, actions: Vec<PeerAction>, out: &mut Vec<PeerAction>) {
        for action in actions {
            match action {
                PeerAction::Send(plain) => {
                    if let Some(sealed) = self.secure.seal(&plain) {
                        self.write(&sealed, None, out);
                    }
                }
                PeerAction::SendLatest { slot, units } => {
                    for plain in units {
                        if let Some(sealed) = self.secure.seal(&plain) {
                            self.write(&sealed, Some(slot.clone()), out);
                        }
                    }
                }
                fact => out.push(fact),
            }
        }
    }

    /// One frame onto the medium, framed as it carries frames.
    fn write(&mut self, frame: &[u8], slot: Option<String>, out: &mut Vec<PeerAction>) {
        let units = match self.framing {
            Framing::Messages => Ok(vec![frame.to_vec()]),
            Framing::Stream { max_frame_bytes } => frame_with_length(frame, max_frame_bytes)
                .map(|framed| vec![framed])
                .map_err(|e| e.to_string()),
            Framing::Fragments { write_limit, .. } => {
                self.message = self.message.wrapping_add(1);
                fragment(frame, write_limit, self.message).map_err(|e| e.to_string())
            }
        };
        match (units, slot) {
            (Err(why), _) => out.push(PeerAction::Dropped(format!("a frame did not leave: {why}"))),
            (Ok(units), Some(slot)) => out.push(PeerAction::SendLatest { slot, units }),
            (Ok(units), None) => out.extend(units.into_iter().map(PeerAction::Send)),
        }
    }

    fn hang_up(&mut self, reason: &str, out: &mut Vec<PeerAction>) {
        if self.is_closed() {
            return;
        }
        self.closing = true;
        out.push(PeerAction::Close {
            reason: reason.to_owned(),
        });
    }

    /// Runs the session's half of a call, sealed, when the session is open.
    fn through(
        &mut self,
        run: impl FnOnce(&mut PeerSession) -> Vec<PeerAction>,
    ) -> Vec<PeerAction> {
        let mut out = Vec::new();
        if self.is_closed() {
            return out;
        }
        let Some(session) = self.session.as_mut() else {
            return out;
        };
        let actions = run(session);
        self.seal_all(actions, &mut out);
        out
    }

    /// This device wrote something (the entry `Engine::mutate` returned).
    pub fn on_local_write(&mut self, entry: &StoredEvent) -> Vec<PeerAction> {
        self.through(|s| s.on_local_write(entry))
    }

    /// Something folded from another link or a snapshot: our cursors, so the peer asks for it.
    pub fn on_remote_fold(&mut self, engine: &Engine) -> Vec<PeerAction> {
        self.through(|s| s.on_remote_fold(engine))
    }

    pub fn resync(&mut self, engine: &Engine) -> Vec<PeerAction> {
        self.through(|s| s.resync(engine))
    }

    /// [`PeerSession::request_snapshot`]; `None` before the session is open.
    pub fn request_snapshot(
        &mut self,
        interest: Option<&Interest>,
        adopt_unvouched: bool,
    ) -> (Option<Ticket>, Vec<PeerAction>) {
        let mut ticket = None;
        let out = self.through(|s| {
            let (t, actions) = s.request_snapshot(interest, adopt_unvouched);
            ticket = t;
            actions
        });
        (ticket, out)
    }

    /// [`PeerSession::accept_floor`]; `None` before the session is open.
    pub fn accept_floor(&mut self, engine: &Engine) -> (Option<Accepted>, Vec<PeerAction>) {
        let mut accepted = None;
        let out = self.through(|s| {
            let (a, actions) = s.accept_floor(engine);
            accepted = Some(a);
            actions
        });
        (accepted, out)
    }

    pub fn request_grant(&mut self, invite: Option<&str>) -> Vec<PeerAction> {
        self.through(|s| s.request_grant(invite))
    }

    pub fn send_grants(&mut self, wires: &[Vec<u8>]) -> Vec<PeerAction> {
        self.through(|s| s.send_grants(wires))
    }

    /// One ephemeral value; not sent before the session is open (D16 drops, never queues).
    pub fn send_presence(&mut self, wire: &[u8]) -> Vec<PeerAction> {
        self.through(|s| s.send_presence(wire))
    }

    /// The liveness check (`createLiveness`): past the deadline the link is hung up on; quiet for
    /// a keepalive, it is prodded with our cursors, which the far side answers with a digest.
    pub fn on_tick(&mut self, engine: &Engine, now_ms: i64) -> Vec<PeerAction> {
        let mut out = Vec::new();
        let (Some(every), Some(due)) = (self.keepalive_ms, self.check_ms) else {
            return out;
        };
        if self.is_closed() || now_ms < due {
            return out;
        }
        self.check_ms = Some(now_ms.saturating_add(every as i64));
        let silence = now_ms - self.heard_ms.unwrap_or(now_ms);
        if silence as f64 > every as f64 * SILENCE_FACTOR {
            self.hang_up(QUIET, &mut out);
            return out;
        }
        if silence >= every as i64 {
            out.extend(self.resync(engine));
        }
        out
    }

    /// Asks the host to hang up; [`PeerLink::on_closed`] follows once it has.
    pub fn close(&mut self) -> Vec<PeerAction> {
        let mut out = Vec::new();
        self.hang_up(CLOSED, &mut out);
        out
    }

    /// The medium is gone, for whatever reason. The session's open join requests count as never
    /// answered. Idempotent.
    pub fn on_closed(&mut self, reason: &str) -> Vec<PeerAction> {
        if self.ended {
            return Vec::new();
        }
        self.ended = true;
        self.closing = true;
        if let Some(session) = self.session.take() {
            session.close();
        }
        vec![PeerAction::Ended {
            reason: reason.to_owned(),
        }]
    }
}
