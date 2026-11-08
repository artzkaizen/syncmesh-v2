//! Rejoining from state (`transport/src/rejoin.ts`, `session-join.ts`, D46). A peer that
//! compacted says how far on every cursors frame — its floor, at index 4 — and a device whose
//! cursor is below it knows the history it lacks is in no log that peer still has. Delta sync
//! cannot reach it, so the device asks for state instead, through the [`JoinExchange`].
//!
//! **Who decides what the answer may adopt.** The floor is an unsigned claim, so it never buys
//! coverage on its own. With `trust` set the device asks at once and adopts only state the issuer
//! vouched for; anything less merges its rows and leaves a [`BelowFloor`] issue. With no `trust`
//! nothing could vouch for a snapshot, so the device does not ask at all: it raises the issue and
//! stays where it is until the app accepts it ([`Rejoins::accept`]), which asks and adopts up to
//! the claimed floor for the authors below it (decided 2026-11-08).
//!
//! **How often.** At most once per (peer, floor) per session, and one request at a time across
//! every link to that peer. A request still open when its session ends, or answered with state
//! that was refused, counts as unanswered; three sessions asked with no install completed raise
//! the issue instead of a fourth request. An install that completes and leaves the device below a
//! floor ends the asking for that floor in every later session too. All of it is kept by the
//! [`Rejoins`] record, one per mesh, and not persisted.
//!
//! Sans-IO: one [`PeerJoin`] per peer link holds that session's exchange and its view of the
//! record. The host hands it each decoded cursors and snapshot frame and sends what comes back;
//! after [`Rejoins::accept`] answers `Requested` it calls [`PeerJoin::flush`] on its links. The
//! TypeScript sweeps its issues on every fold; here [`Rejoins::sweep`] is called after one, and
//! [`Rejoins::issues`] sweeps before it answers.

use std::collections::{BTreeMap, BTreeSet};

use syncmesh_core::event::PeerId;
use syncmesh_core::frames::SnapshotFrame;
use syncmesh_core::rejoin::below_peer_floor;

use crate::engine::Engine;
use crate::interest::Interest;
use crate::join::{JoinExchange, JoinOutcome, JoinPolicy, JoinStep, Settled, Ticket};
use crate::relay::{cursors_to_map, cursors_to_pairs};
use crate::store::{Cursors, StoreError};

/// Per author, the sender's floor this device is below — `syncmesh_core::rejoin::below_peer_floor`
/// over this crate's cursor maps.
pub fn below_floor(own: &PeerId, ours: &Cursors, theirs: &Cursors, floor: &Cursors) -> Cursors {
    cursors_to_map(&below_peer_floor(
        own,
        &cursors_to_pairs(ours),
        &cursors_to_pairs(theirs),
        &cursors_to_pairs(floor),
    ))
}

/// Why a device below a peer's floor is still there, as a stable cause.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BelowFloorReason {
    /// The mesh has no `trust`: nothing can vouch for the state, so nothing was asked until accepted.
    Untrusted,
    /// `trust` is set and the state arrived without a certificate from it: rows merged, nothing adopted.
    Unvouched,
    /// An install completed and some authors are still below: withheld tables, a scoped sender, doc columns.
    Incomplete,
    /// Three sessions asked and no install completed.
    Unanswered,
}

impl BelowFloorReason {
    /// The TypeScript's `BelowFloorReason` string.
    pub fn as_str(self) -> &'static str {
        match self {
            BelowFloorReason::Untrusted => "untrusted",
            BelowFloorReason::Unvouched => "unvouched",
            BelowFloorReason::Incomplete => "incomplete",
            BelowFloorReason::Unanswered => "unanswered",
        }
    }

    /// The TypeScript's message for it, word for word.
    pub fn message(self) -> &'static str {
        match self {
            BelowFloorReason::Untrusted => {
                "this mesh has no trust anchor, so nothing can vouch for that peer's state; accept it to take the state and adopt up to its floor"
            }
            BelowFloorReason::Unvouched => {
                "the peer's state carried no certificate this device trusts: its rows merged, the coverage did not move"
            }
            BelowFloorReason::Incomplete => {
                "the peer's state did not cover these authors up to its floor (withheld tables, a scope it does not hold, or document columns)"
            }
            BelowFloorReason::Unanswered => {
                "asked for state in three sessions and no install completed"
            }
        }
    }
}

/// A device below a peer's compaction floor, and what is known about why (D46).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BelowFloor {
    pub peer: PeerId,
    /// Per author this device is below, the floor the peer claimed.
    pub floor: Cursors,
    pub reason: BelowFloorReason,
}

/// What [`Rejoins::accept`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accepted {
    /// A session to the peer is open; [`PeerJoin::flush`] on it sends the request.
    Requested,
    /// No session to the peer is open: the next one that sees the same floor asks.
    Deferred,
    /// Nothing is waiting on that peer: no issue, or this device is no longer below it.
    NothingToAccept,
}

/// Sessions asked per (peer, floor) before the issue is raised instead of a fourth request.
const ASKS_PER_FLOOR: u32 = 3;

/// A session, as the record names it.
pub type SessionId = u64;

fn floor_key(peer: &PeerId, floor: &Cursors) -> String {
    let mut entries: Vec<String> = floor
        .iter()
        .map(|(author, seq)| format!("{author}:{}", seq.get()))
        .collect();
    entries.sort();
    format!("{peer}|{}", entries.join(","))
}

/// One request a session put on the wire and has not heard back on.
#[derive(Debug, Clone)]
struct Asked {
    key: String,
    peer: PeerId,
    below: Cursors,
    adopt_unvouched: bool,
}

/// An ask the record decided on, waiting for its session's exchange to send it.
#[derive(Debug, Clone)]
struct Ask {
    peer: PeerId,
    below: Cursors,
    adopt_unvouched: bool,
}

#[derive(Debug, Default)]
struct Session {
    /// (peer, floor) pairs this session already acted on.
    acted: BTreeSet<String>,
    /// Peers this session stopped asking: an install left it below, and the issue says so.
    stopped: BTreeSet<PeerId>,
    asked: BTreeMap<Ticket, Asked>,
    pending: Vec<Ask>,
}

/// The mesh's record of every peer this device is below, shared by every session so the count of
/// attempts outlives each one (D46).
#[derive(Debug, Default)]
pub struct Rejoins {
    raised: BTreeMap<PeerId, BelowFloor>,
    attempts: BTreeMap<String, u32>,
    /// (peer, floor) pairs with a request on the wire, and whether it was an accepted one.
    inflight: BTreeMap<String, bool>,
    /// (peer, floor) pairs an install left below: no later session asks again on its own.
    halted: BTreeSet<String>,
    /// Floors the app accepted unvouched, per peer, matched per author.
    accepted: BTreeMap<PeerId, Cursors>,
    /// Open sessions per peer, oldest first.
    live: BTreeMap<PeerId, Vec<SessionId>>,
    sessions: BTreeMap<SessionId, Session>,
    next: SessionId,
    changes: u64,
}

fn still_below(issue: &BelowFloor, ours: &Cursors) -> bool {
    issue
        .floor
        .iter()
        .any(|(author, seq)| ours.get(author).map_or(0, |s| s.get()) < seq.get())
}

impl Rejoins {
    pub fn new() -> Rejoins {
        Rejoins::default()
    }

    /// Counts every time an issue was raised or cleared; a host compares it to know when to
    /// re-read [`Rejoins::issues`] (the TypeScript's `onChange`).
    pub fn changes(&self) -> u64 {
        self.changes
    }

    fn raise(&mut self, peer: &PeerId, floor: Cursors, reason: BelowFloorReason) {
        let issue = BelowFloor {
            peer: peer.clone(),
            floor,
            reason,
        };
        self.raised.insert(peer.clone(), issue);
        self.changes += 1;
    }

    fn clear(&mut self, peer: &PeerId) {
        if self.raised.remove(peer).is_some() {
            self.changes += 1;
        }
    }

    /// Drops every issue whose authors caught up, however they got there; whether any went. What
    /// a host calls after a fold.
    pub fn sweep(&mut self, ours: &Cursors) -> bool {
        let before = self.raised.len();
        self.raised.retain(|_, issue| still_below(issue, ours));
        let dropped = self.raised.len() != before;
        if dropped {
            self.changes += 1;
        }
        dropped
    }

    /// The peers this device is still below, with why; swept against `ours` first.
    pub fn issues(&mut self, ours: &Cursors) -> Vec<BelowFloor> {
        self.sweep(ours);
        self.raised.values().cloned().collect()
    }

    /// Whether the app accepted every author of `below` at the floor it names.
    fn consented(&self, peer: &PeerId, below: &Cursors) -> bool {
        self.accepted
            .get(peer)
            .is_some_and(|floor| below.iter().all(|(a, seq)| floor.get(a) == Some(seq)))
    }

    /// Takes state from this peer although nothing vouched for it, adopting per author at most
    /// the floor it claimed. The app's or the operator's call, never this library's. Applies to the
    /// floor in the issue only; the issue stays raised until an install answers it.
    pub fn accept(&mut self, peer: &PeerId, ours: &Cursors) -> Accepted {
        let Some(issue) = self.raised.get(peer).filter(|i| still_below(i, ours)) else {
            self.clear(peer);
            return Accepted::NothingToAccept;
        };
        let floor = issue.floor.clone();
        self.accepted.insert(peer.clone(), floor.clone());
        let Some(&first) = self.live.get(peer).and_then(|s| s.first()) else {
            return Accepted::Deferred;
        };
        let key = floor_key(peer, &floor);
        if let Some(session) = self.sessions.get_mut(&first) {
            session.acted.insert(key.clone());
        }
        // an accepted request for this floor is already on the wire: its answer is this one's
        if self.inflight.get(&key) != Some(&true) {
            self.ask(first, peer, floor, true);
        }
        Accepted::Requested
    }

    fn open(&mut self) -> SessionId {
        self.next += 1;
        self.sessions.insert(self.next, Session::default());
        self.next
    }

    fn register(&mut self, session: SessionId, peer: &PeerId) {
        let sessions = self.live.entry(peer.clone()).or_default();
        if !sessions.contains(&session) {
            sessions.push(session);
        }
    }

    fn ask(&mut self, session: SessionId, peer: &PeerId, below: Cursors, adopt_unvouched: bool) {
        self.inflight
            .insert(floor_key(peer, &below), adopt_unvouched);
        if let Some(s) = self.sessions.get_mut(&session) {
            s.pending.push(Ask {
                peer: peer.clone(),
                below,
                adopt_unvouched,
            });
        }
    }

    fn on_cursors(
        &mut self,
        session: SessionId,
        context: SessionContext<'_>,
        peer: &PeerId,
        theirs: &Cursors,
        floor: Option<&Cursors>,
    ) {
        self.register(session, peer);
        if self
            .raised
            .get(peer)
            .is_some_and(|i| !still_below(i, context.ours))
        {
            self.clear(peer);
        }
        let Some(floor) = floor.filter(|f| !f.is_empty()) else {
            return;
        };
        let below = below_floor(context.own, context.ours, theirs, floor);
        // nothing below, or every entry ignored (a repage frame carries no cursors): no guard used
        if below.is_empty() {
            return;
        }
        let key = floor_key(peer, &below);
        let Some(state) = self.sessions.get(&session) else {
            return;
        };
        // another link to the same peer already asked: its answer is this one's too
        if state.acted.contains(&key) || self.inflight.contains_key(&key) {
            return;
        }
        if self.consented(peer, &below) {
            self.acted(session, key);
            return self.ask(session, peer, below, true);
        }
        if state.stopped.contains(peer) || self.halted.contains(&key) {
            return;
        }
        self.acted(session, key.clone());
        if !context.trusted {
            return self.raise(peer, below, BelowFloorReason::Untrusted);
        }
        let asked = self.attempts.get(&key).copied().unwrap_or(0);
        if asked >= ASKS_PER_FLOOR {
            return self.raise(peer, below, BelowFloorReason::Unanswered);
        }
        self.attempts.insert(key, asked + 1);
        self.ask(session, peer, below, false);
    }

    fn acted(&mut self, session: SessionId, key: String) {
        if let Some(s) = self.sessions.get_mut(&session) {
            s.acted.insert(key);
        }
    }

    fn settled(&mut self, session: SessionId, settled: &Settled, own: &PeerId, ours: &Cursors) {
        let Some(asked) = self
            .sessions
            .get_mut(&session)
            .and_then(|s| s.asked.remove(&settled.ticket))
        else {
            return;
        };
        self.inflight.remove(&asked.key);
        let vouched = match &settled.outcome {
            // a refused install merged nothing and completed nothing: it stays an unanswered ask
            JoinOutcome::Refused(_) => return,
            JoinOutcome::Installed { vouched, .. } => *vouched,
        };
        self.attempts.remove(&asked.key);
        if asked.adopt_unvouched {
            self.accepted.remove(&asked.peer);
        }
        let left = below_floor(own, ours, &asked.below, &asked.below);
        if left.is_empty() {
            return self.clear(&asked.peer);
        }
        if let Some(s) = self.sessions.get_mut(&session) {
            s.stopped.insert(asked.peer.clone());
        }
        self.halted.insert(asked.key);
        let reason = if vouched || asked.adopt_unvouched {
            BelowFloorReason::Incomplete
        } else {
            BelowFloorReason::Unvouched
        };
        self.raise(&asked.peer, left, reason);
    }

    fn close(&mut self, session: SessionId) {
        let Some(state) = self.sessions.remove(&session) else {
            return;
        };
        // a request still open when its session ends counts as never answered
        for asked in state.asked.values() {
            self.inflight.remove(&asked.key);
        }
        for ask in &state.pending {
            self.inflight.remove(&floor_key(&ask.peer, &ask.below));
        }
        self.live.retain(|_, sessions| {
            sessions.retain(|s| *s != session);
            !sessions.is_empty()
        });
    }
}

/// What a session's decisions read of the device: who it is, what it holds, and whether a
/// certificate could vouch for state here at all.
#[derive(Clone, Copy)]
struct SessionContext<'a> {
    own: &'a PeerId,
    ours: &'a Cursors,
    trusted: bool,
}

/// One peer link's join exchange and its view of the mesh's [`Rejoins`] record (`session-join.ts`).
pub struct PeerJoin {
    exchange: JoinExchange,
    session: SessionId,
    /// The slice this link syncs: a device that joined with an interest asks with it.
    interest: Option<Interest>,
}

impl PeerJoin {
    /// A session over `exchange`, recorded in `rejoins`. Whether the device asks at once below a
    /// floor is the exchange's own `JoinOptions::trust`: set, a certificate could vouch for the
    /// answer.
    ///
    /// **Call [`PeerJoin::close`] when the link ends.** A dropped `PeerJoin` leaves its open
    /// requests in `rejoins` for good, and every later session then reads that floor as asked by
    /// another link and never asks it again.
    pub fn open(
        rejoins: &mut Rejoins,
        exchange: JoinExchange,
        interest: Option<Interest>,
    ) -> PeerJoin {
        PeerJoin {
            exchange,
            session: rejoins.open(),
            interest,
        }
    }

    pub fn exchange(&mut self) -> &mut JoinExchange {
        &mut self.exchange
    }

    /// A cursors frame arrived from `peer`; `floor` absent is an older build or no compaction.
    /// Returns the frames to send: a request for state when this device is below the floor and
    /// may ask.
    pub fn on_cursors(
        &mut self,
        rejoins: &mut Rejoins,
        engine: &Engine,
        peer: &PeerId,
        theirs: &Cursors,
        floor: Option<&Cursors>,
    ) -> Vec<Vec<u8>> {
        let ours = engine.coverage().synced;
        let context = SessionContext {
            own: engine.peer_id(),
            ours: &ours,
            trusted: self.exchange.trusts(),
        };
        rejoins.on_cursors(self.session, context, peer, theirs, floor);
        self.flush(rejoins)
    }

    /// Sends what the record decided for this session and has not sent yet: a request it raised
    /// on a cursors frame, or one [`Rejoins::accept`] put here.
    pub fn flush(&mut self, rejoins: &mut Rejoins) -> Vec<Vec<u8>> {
        let Some(state) = rejoins.sessions.get_mut(&self.session) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for ask in std::mem::take(&mut state.pending) {
            let policy = JoinPolicy {
                adopt_unvouched: ask.adopt_unvouched,
                floor: Some(ask.below.clone()),
            };
            let (ticket, frame) = self.exchange.request_under(self.interest.as_ref(), policy);
            state.asked.insert(
                ticket,
                Asked {
                    key: floor_key(&ask.peer, &ask.below),
                    peer: ask.peer,
                    below: ask.below,
                    adopt_unvouched: ask.adopt_unvouched,
                },
            );
            out.push(frame);
        }
        out
    }

    /// One frame of the join exchange. An install that answers a floor request is settled into
    /// the record here, raising or clearing its issue; the step is returned whole either way.
    pub fn on_snapshot(
        &mut self,
        rejoins: &mut Rejoins,
        engine: &mut Engine,
        frame: SnapshotFrame,
    ) -> Result<JoinStep, StoreError> {
        let step = self.exchange.dispatch(engine, frame)?;
        if let Some(settled) = &step.settled {
            let ours = engine.coverage().synced;
            rejoins.settled(self.session, settled, engine.peer_id(), &ours);
        }
        Ok(step)
    }

    /// The link ended: requests still open count as never answered. Required: see
    /// [`PeerJoin::open`].
    pub fn close(self, rejoins: &mut Rejoins) {
        rejoins.close(self.session);
    }
}
