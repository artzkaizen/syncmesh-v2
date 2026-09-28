//! The server half of the relay protocol, in process (`relay/src/room.ts`, `connection.ts`,
//! `catchup.ts`, `ingest.ts`, `grant-cache.ts`): store-and-forward of signed bytes by a party
//! that holds no keys. It verifies shapes and signatures, appends, acks and forwards — it
//! interprets nothing, so a compromised room can drop traffic but cannot forge it.
//!
//! Sans-IO like the link: a host owns the sockets, numbers them, and hands every inbound frame to
//! [`Room::receive`]; the room answers with what to send on which socket and which socket to hang
//! up. Here it is the test double every `RelayLink` test converges through, and the same struct
//! is what an app embeds when it wants to *be* the relay for the devices around it.
//!
//! What the TypeScript room has and this one leaves out, on purpose: rate limits, backlog
//! ceilings, retention floors, multi-instance fan-out and telemetry. None of them change a frame
//! a client sees on a room that is not under pressure, and a test double under pressure is a test
//! of the double.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};
use syncmesh_core::cbor::{Key, Value};
use syncmesh_core::envelope::{decode_and_verify, split_envelope};
use syncmesh_core::event::{PeerId, SeqNum, SyncEvent};
use syncmesh_core::frames::{Frame, cursors_frame, presence_frame};
use syncmesh_core::grant::read_grant_origin;
use syncmesh_core::handshake::SEAL_OVERHEAD;
use syncmesh_core::identity::{Identity, verify};
use syncmesh_core::join_proof::verify_join_proof;
use syncmesh_core::relay_frames::{
    HANDSHAKE_VERSION, Join, PageScope, RELAY_PROTOCOL_VERSIONS, RelayFrame, ack_frame, blob_frame,
    blob_missing_frame, challenge_frame, decode_relay_frame, error_frame, hello_frame, ka_frame,
    page_frame, relayed_frame, select_version,
};

use crate::coverage::CoverageTracker;
use crate::interest::{Interest, interest_from, interest_text, matches_interest};
use crate::relay::{SealedLink, cursors_to_map, cursors_to_pairs};
use crate::store::{Coverage, Cursors, EventStore, StoreError, StoredEvent};

/// The host's name for one accepted socket; the room hands them out from `connect`.
pub type SocketId = u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomOptions {
    /// Protocol versions this room accepts (D14). A room lists 3 alone or leaves it out: it
    /// speaks a hello first or a challenge first, and a socket cannot be told both.
    pub versions: Vec<u64>,
    /// Cadence of `ka` frames; the client's liveness deadline is 2.5× this. Default 15000.
    pub keepalive_ms: u64,
    /// Events per catch-up frame. One frame is not a transfer, it is a cliff. Default 2000.
    pub page_size: usize,
    /// The log's lineage id, sent in every `hello`.
    pub epoch: String,
    /// The plaintext cap; a frame over it is measured and refused, never decoded. Default 1 MiB.
    pub max_frame_bytes: usize,
}

impl Default for RoomOptions {
    fn default() -> Self {
        RoomOptions {
            versions: RELAY_PROTOCOL_VERSIONS.to_vec(),
            keepalive_ms: 15_000,
            page_size: 2000,
            epoch: "epoch-1".to_owned(),
            max_frame_bytes: 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomAction {
    /// Raw socket bytes, sealed where that socket's link is.
    Send { socket: SocketId, bytes: Vec<u8> },
    /// Hang up on this socket. The room has already forgotten it; a later `closed` is a no-op.
    Close { socket: SocketId, reason: String },
}

/// One socket's conversation with the room.
#[derive(Debug)]
struct Conn {
    /// The sealed link on a v3 room (D36); absent on a room that challenges instead.
    link: Option<SealedLink>,
    /// The challenge this socket was sent on a v1/v2 room (D33).
    challenge: Option<[u8; 32]>,
    /// Who joined on this socket, once a join has been admitted.
    me: Option<PeerId>,
    /// What this socket asked for; absent wants everything the policy already allows.
    interest: Option<Interest>,
    /// A fatal refusal ends the conversation here and not only on the socket: frames the host had
    /// already buffered still arrive after it, and one appended then would leave the log holding
    /// N+1 without N.
    closed: bool,
}

pub struct Room {
    identity: Identity,
    store: Box<dyn EventStore + Send>,
    options: RoomOptions,
    /// Per author, the highest sequence below which the room holds every entry it could serve.
    coverage: CoverageTracker,
    /// Entries in the log, counted up from what was there at open; rides on `ack`, `page` and
    /// `relayed` for a human reading a trace, and nothing folds it.
    offset: u64,
    /// One grant per device, newest mint wins, so a revocation retires what it replaces.
    grants: BTreeMap<PeerId, (i64, Vec<u8>)>,
    /// The ephemeral tier at the middle hop (D16): the latest wire per sender, so a joiner learns
    /// who is here without any history.
    presence: BTreeMap<PeerId, Vec<u8>>,
    /// Bytes by their own sha-256 (D18).
    blobs: BTreeMap<String, Vec<u8>>,
    sockets: BTreeMap<SocketId, Conn>,
    /// One socket per peer; a newer join supersedes.
    clients: BTreeMap<PeerId, SocketId>,
    next_socket: SocketId,
    last_ka_ms: Option<i64>,
}

impl std::fmt::Debug for Room {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Room")
            .field("peer", self.identity.peer_id())
            .field("offset", &self.offset)
            .field("clients", &self.clients.len())
            .finish_non_exhaustive()
    }
}

fn speaks_handshake(versions: &[u64]) -> bool {
    versions.contains(&HANDSHAKE_VERSION)
}

/// The sender a presence wire names, once its signature has been checked against that key. The
/// room reads one field of the core — key 1, the peer — and judges nothing else about the value:
/// it is not the place that interprets presence, only the place that must not forward a forgery.
fn presence_sender(wire: &[u8]) -> Option<PeerId> {
    let (core, sig) = split_envelope(wire).ok()?;
    let Value::Map(map) = syncmesh_core::decode_cbor(&core).ok()? else {
        return None;
    };
    let Some(Value::Bytes(key)) = map.get(&Key::Int(1)) else {
        return None;
    };
    let peer = PeerId::parse(&syncmesh_core::to_hex(key)).ok()?;
    verify(&core, &sig, key).then_some(peer)
}

/// What a filtered catch-up hands over at its end (D23): per author, how far the *unfiltered*
/// run ran contiguously above where the joiner asked from. Measured with the joiner's own
/// tracker, so relay and client apply one rule and cannot disagree about it.
pub fn scanned_coverage(
    entries: &[StoredEvent],
    theirs: &Cursors,
    interest: &Interest,
) -> PageScope {
    let mut tracker = CoverageTracker::new(&Coverage {
        synced: theirs.clone(),
        local: Cursors::new(),
        scope: None,
    });
    for entry in entries {
        tracker.note(&entry.event);
    }
    PageScope {
        synced: cursors_to_pairs(&tracker.cursors()),
        scope: interest_text(Some(interest)),
    }
}

/// A joiner's history as frames: `page_size` events each, grants on the first, and always at least
/// one page — its `more: false` is what releases the client's push-outstanding, so a client that
/// is already caught up still gets told so. The scoped coverage rides the last page rather than a
/// frame of its own: it is only true once every page before it has landed. An entry with no
/// signature stored can never leave this room and is skipped.
pub fn paged(
    entries: &[StoredEvent],
    grant_wires: &[Vec<u8>],
    page_size: usize,
    offset: u64,
    scoped: Option<&PageScope>,
) -> Vec<Vec<u8>> {
    let wires: Vec<Vec<u8>> = entries.iter().filter_map(StoredEvent::envelope).collect();
    let page_size = page_size.max(1);
    let mut pages = Vec::new();
    let mut index = 0;
    loop {
        let end = (index + page_size).min(wires.len());
        let slice = &wires[index.min(wires.len())..end];
        index += page_size;
        let grants: &[Vec<u8>] = if index <= page_size { grant_wires } else { &[] };
        let more = index < wires.len();
        pages.push(page_frame(
            grants,
            slice,
            more,
            offset,
            if more { None } else { scoped },
        ));
        if !more {
            return pages;
        }
    }
}

impl Room {
    /// Opens the room over its log, walking it once for the cursors `hello` advertises.
    ///
    /// Panics on a version list that mixes 3 with an older version: a definition mistake, since a
    /// room speaks a hello first or a challenge first and one socket cannot be told both.
    pub fn new(
        identity: Identity,
        store: Box<dyn EventStore + Send>,
        options: RoomOptions,
    ) -> Result<Room, StoreError> {
        assert!(
            !(speaks_handshake(&options.versions)
                && options.versions.iter().any(|&v| v != HANDSHAKE_VERSION)),
            "a relay room lists {HANDSHAKE_VERSION} alone or leaves it out: the link handshake and the challenge cannot share one socket (got {:?})",
            options.versions
        );
        let boot = store.all()?;
        let mut coverage = CoverageTracker::default();
        for entry in &boot {
            // servable: a signature was stored, so catch-up can hand the entry over
            if entry.sig.is_some() {
                coverage.note(&entry.event);
            }
        }
        Ok(Room {
            identity,
            store,
            options,
            coverage,
            offset: boot.len() as u64,
            grants: BTreeMap::new(),
            presence: BTreeMap::new(),
            blobs: BTreeMap::new(),
            sockets: BTreeMap::new(),
            clients: BTreeMap::new(),
            next_socket: 1,
            last_ka_ms: None,
        })
    }

    /// The key this room signs its hello with — what a client pins with `relay_key`.
    pub fn peer_id(&self) -> &PeerId {
        self.identity.peer_id()
    }

    pub fn options(&self) -> &RoomOptions {
        &self.options
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn cursors(&self) -> Cursors {
        self.coverage.cursors()
    }

    /// Joined peers, by the socket each sits on.
    pub fn clients(&self) -> &BTreeMap<PeerId, SocketId> {
        &self.clients
    }

    pub fn blob(&self, hash: &str) -> Option<&[u8]> {
        self.blobs.get(hash).map(Vec::as_slice)
    }

    /// Every grant wire held, newest mint per device, in the bytes it arrived as.
    pub fn grant_wires(&self) -> Vec<Vec<u8>> {
        self.grants.values().map(|(_, w)| w.clone()).collect()
    }

    pub fn store(&self) -> &dyn EventStore {
        self.store.as_ref()
    }

    // --- sockets ------------------------------------------------------------------------------

    /// A socket was accepted. The room speaks first, either way: on a v3 room its first frame is a
    /// hello signed by the room's key and every frame after the peer's is sealed (D36); on an
    /// older room it is a challenge the join has to sign (D33).
    pub fn connect(&mut self, _now_ms: i64) -> (SocketId, Vec<RoomAction>) {
        let socket = self.next_socket;
        self.next_socket += 1;
        let mut out = Vec::new();
        let conn = if speaks_handshake(&self.options.versions) {
            let link = SealedLink::offer(&self.identity);
            out.push(RoomAction::Send {
                socket,
                bytes: link.hello_frame().to_vec(),
            });
            Conn {
                link: Some(link),
                challenge: None,
                me: None,
                interest: None,
                closed: false,
            }
        } else {
            let nonce: [u8; 32] = crate::random::bytes();
            out.push(RoomAction::Send {
                socket,
                bytes: challenge_frame(&nonce),
            });
            Conn {
                link: None,
                challenge: Some(nonce),
                me: None,
                interest: None,
                closed: false,
            }
        };
        self.sockets.insert(socket, conn);
        (socket, out)
    }

    /// The socket is gone. Idempotent.
    pub fn closed(&mut self, socket: SocketId) {
        if let Some(conn) = self.sockets.remove(&socket)
            && let Some(me) = conn.me
            && self.clients.get(&me) == Some(&socket)
        {
            self.clients.remove(&me);
        }
    }

    /// A keepalive to every joined client once per `keepalive_ms`; the first call only arms it.
    pub fn tick(&mut self, now_ms: i64) -> Vec<RoomAction> {
        let mut out = Vec::new();
        match self.last_ka_ms {
            None => self.last_ka_ms = Some(now_ms),
            Some(last) if now_ms - last >= self.options.keepalive_ms as i64 => {
                self.last_ka_ms = Some(now_ms);
                self.to_clients(&ka_frame(), None, &mut out);
            }
            Some(_) => {}
        }
        out
    }

    fn send(&self, socket: SocketId, plain: Vec<u8>, out: &mut Vec<RoomAction>) {
        let Some(conn) = self.sockets.get(&socket) else {
            return;
        };
        if conn.closed {
            return;
        }
        // before the key exists the only things the room says are its hello and a handshake
        // refusal, both of which have to be readable by an end that cannot open anything yet
        let bytes = match conn.link.as_ref().and_then(|link| link.seal(&plain)) {
            Some(sealed) => sealed,
            None => plain,
        };
        out.push(RoomAction::Send { socket, bytes });
    }

    /// A typed refusal on the wire; `fatal` also hangs up, for a client there is no point talking to.
    fn refuse(
        &mut self,
        socket: SocketId,
        code: &str,
        message: &str,
        fatal: bool,
        out: &mut Vec<RoomAction>,
    ) {
        self.send(socket, error_frame(code, message), out);
        if fatal {
            self.hang_up(socket, code, out);
        }
    }

    fn hang_up(&mut self, socket: SocketId, reason: &str, out: &mut Vec<RoomAction>) {
        let Some(conn) = self.sockets.get_mut(&socket) else {
            return;
        };
        if conn.closed {
            return;
        }
        conn.closed = true;
        if let Some(me) = conn.me.clone()
            && self.clients.get(&me) == Some(&socket)
        {
            self.clients.remove(&me);
        }
        out.push(RoomAction::Close {
            socket,
            reason: reason.to_owned(),
        });
    }

    /// Every joined client but one — the author, who already has what it sent.
    fn to_clients(&self, frame: &[u8], except: Option<&PeerId>, out: &mut Vec<RoomAction>) {
        for (peer, &socket) in &self.clients {
            if Some(peer) != except {
                self.send(socket, frame.to_vec(), out);
            }
        }
    }

    /// The same, minus every client whose interest excludes this event; counts who got it.
    fn to_interested(
        &self,
        frame: &[u8],
        event: &SyncEvent,
        except: Option<&PeerId>,
        out: &mut Vec<RoomAction>,
    ) -> usize {
        let mut receivers = 0;
        for (peer, &socket) in &self.clients {
            if Some(peer) == except {
                continue;
            }
            let wants = self
                .sockets
                .get(&socket)
                .is_none_or(|conn| matches_interest(conn.interest.as_ref(), event));
            if wants {
                self.send(socket, frame.to_vec(), out);
                receivers += 1;
            }
        }
        receivers
    }

    // --- inbound ------------------------------------------------------------------------------

    /// Socket bytes in. On a sealed link the peer's hello completes the handshake and carries
    /// nothing; anything the link refuses is a fatal `handshake`, because a frame in the clear
    /// after the hellos is a downgrade, and one that does not open is not ours.
    pub fn receive(&mut self, socket: SocketId, raw: &[u8], now_ms: i64) -> Vec<RoomAction> {
        let mut out = Vec::new();
        let Some(conn) = self.sockets.get_mut(&socket) else {
            return out;
        };
        if conn.closed {
            return out;
        }
        let sealed = conn.link.is_some();
        // the cheapest refusal there is: a frame over the cap is never decoded, only measured
        let cap = self.options.max_frame_bytes + if sealed { SEAL_OVERHEAD } else { 0 };
        if raw.len() > cap {
            let message = format!(
                "frames are capped at {} bytes",
                self.options.max_frame_bytes
            );
            self.refuse(socket, "frame-too-large", &message, true, &mut out);
            return out;
        }
        let plain = match conn.link.as_mut() {
            None => raw.to_vec(),
            Some(link) => match link.receive(raw) {
                Ok(Some(plain)) => plain,
                Ok(None) => return out, // the handshake completed; nothing to act on
                Err(e) => {
                    let message = e.message();
                    self.refuse(socket, "handshake", &message, true, &mut out);
                    return out;
                }
            },
        };
        self.replay(socket, &plain, now_ms, &mut out);
        out
    }

    /// One plaintext frame acted on.
    fn replay(&mut self, socket: SocketId, plain: &[u8], _now_ms: i64, out: &mut Vec<RoomAction>) {
        let frame = match decode_relay_frame(plain) {
            Ok(frame) => frame,
            Err(e) => {
                self.refuse(socket, "malformed", &e.to_string(), false, out);
                return;
            }
        };
        if let RelayFrame::Join(join) = frame {
            self.on_join(socket, join, out);
            return;
        }
        let joined = self.sockets.get(&socket).is_some_and(|c| c.me.is_some());
        if !joined {
            self.refuse(
                socket,
                "join-first",
                "the first frame on a relay socket is join",
                true,
                out,
            );
            return;
        }
        match frame {
            RelayFrame::BlobPut { hash, bytes } => {
                let actual = syncmesh_core::to_hex(&Sha256::digest(&bytes));
                if actual != hash {
                    self.refuse(
                        socket,
                        "blob-corrupt",
                        "the bytes do not hash to the name they were put under",
                        false,
                        out,
                    );
                    return;
                }
                self.blobs.insert(hash, bytes);
            }
            RelayFrame::BlobGet { hash } => {
                let answer = match self.blobs.get(&hash) {
                    Some(bytes) => blob_frame(&hash, bytes),
                    None => blob_missing_frame(&hash),
                };
                self.send(socket, answer, out);
            }
            RelayFrame::Session(frame) => self.on_session(socket, plain, frame, out),
            // anything else control-shaped is one the room did not ask for, and ignores
            _ => {}
        }
    }

    fn on_join(&mut self, socket: SocketId, join: Join, out: &mut Vec<RoomAction>) {
        let Some(selected) = select_version(&join.versions, &self.options.versions) else {
            let spoken: Vec<String> = self.options.versions.iter().map(u64::to_string).collect();
            let message = format!("this relay speaks {}", spoken.join(", "));
            self.refuse(socket, "version", &message, true, out);
            return;
        };
        let Some(conn) = self.sockets.get(&socket) else {
            return;
        };
        // the join names a key. On a sealed link the hello already proved one, and the join must
        // name that one (D36): a device cannot open a link as itself and sit down as somebody
        // else. At v2 it proves the key by signing the challenge (D33). Both are checked before
        // the seat is taken, and a proof that fails is a refusal on any version
        if let Some(link) = conn.link.as_ref()
            && link.session_peer() != Some(&join.peer_id)
        {
            self.refuse(
                socket,
                "impostor",
                "the join names a key other than the one that opened this link",
                true,
                out,
            );
            return;
        }
        let proven = match (&join.proof, &conn.challenge) {
            (Some(proof), Some(challenge)) => Some(verify_join_proof(
                &join.peer_id,
                challenge,
                &join.core,
                proof,
            )),
            _ => None,
        };
        if proven == Some(false) || (proven.is_none() && selected == 2) {
            let message = if proven == Some(false) {
                "the join was not signed by the key it names"
            } else {
                "a v2 join signs the room's challenge with the key it names"
            };
            self.refuse(socket, "unproven", message, true, out);
            return;
        }
        // one socket per peer, never a silent room switch: the old socket goes first
        if let Some(&old) = self.clients.get(&join.peer_id)
            && old != socket
        {
            self.hang_up(old, "superseded by a newer join", out);
        }
        let wanted = interest_from(join.interest.as_deref());
        if let Some(conn) = self.sockets.get_mut(&socket) {
            conn.me = Some(join.peer_id.clone());
            conn.interest = wanted.clone();
        }
        self.clients.insert(join.peer_id.clone(), socket);
        let hello = hello_frame(
            selected,
            self.options.keepalive_ms,
            &self.options.epoch,
            &cursors_to_pairs(&self.cursors()),
            &[],
        );
        self.send(socket, hello, out);
        // who is here now — never how they got here: presence has no history to page through
        for wire in self.presence.values() {
            self.send(socket, presence_frame(wire), out);
        }
        self.send_catch_up(socket, &join.cursors, wanted.as_ref(), out);
        // what the joiner holds, in its own words, for everyone else's `delivered`
        let cursors = cursors_frame(&join.peer_id, &join.cursors, None);
        self.to_clients(&cursors, Some(&join.peer_id), out);
    }

    /// The catch-up half of a join: everything above the joiner's cursors, narrowed to what it
    /// asked for, in pages; and on a filtered run, the coverage those pages stand for (D23).
    fn send_catch_up(
        &mut self,
        socket: SocketId,
        theirs: &[(PeerId, SeqNum)],
        interest: Option<&Interest>,
        out: &mut Vec<RoomAction>,
    ) {
        let theirs = cursors_to_map(theirs);
        let found = match self.store.all_since(&theirs) {
            Ok(found) => found,
            Err(e) => {
                self.refuse(socket, "store", &e.message, false, out);
                return;
            }
        };
        // narrowed at the sender: an event this device did not ask for never becomes a page
        let admitted: Vec<StoredEvent> = match interest {
            None => found.clone(),
            Some(interest) => found
                .iter()
                .filter(|e| matches_interest(Some(interest), &e.event))
                .cloned()
                .collect(),
        };
        // and said so: only a filtered run needs the coverage, since an unfiltered one leaves the
        // joiner's own fold able to compute the same number
        let scoped = interest.map(|i| scanned_coverage(&found, &theirs, i));
        let pages = paged(
            &admitted,
            &self.grant_wires(),
            self.options.page_size,
            self.offset,
            scoped.as_ref(),
        );
        for page in pages {
            self.send(socket, page, out);
        }
    }

    fn on_session(
        &mut self,
        socket: SocketId,
        bytes: &[u8],
        frame: Frame,
        out: &mut Vec<RoomAction>,
    ) {
        let me = self.sockets.get(&socket).and_then(|c| c.me.clone());
        match frame {
            Frame::Event { wire } => self.ingest_event(socket, &wire, out),
            Frame::Grant { wire } => {
                if !self.admit_grant(&wire) {
                    return;
                }
                // the received frame bytes, untouched: grants forward byte-identical
                self.to_clients(bytes, me.as_ref(), out);
            }
            Frame::Presence { wire } => {
                // junk from a client is dropped, never relayed
                let Some(sender) = presence_sender(&wire) else {
                    return;
                };
                self.presence.insert(sender, wire);
                self.to_clients(bytes, me.as_ref(), out);
            }
            // peer-to-peer facts pass through byte-identical
            Frame::GrantRequest { .. } | Frame::Cursors { .. } => {
                self.to_clients(bytes, me.as_ref(), out);
            }
            _ => {}
        }
    }

    /// Takes a grant and answers whether the room should pass it on: `false` for a mint the room
    /// has already superseded. A grant whose core will not decode is passed on uncached — the
    /// relay is not the place that judges grants, so it forwards what it cannot read.
    fn admit_grant(&mut self, wire: &[u8]) -> bool {
        let Ok(origin) = read_grant_origin(wire) else {
            return true;
        };
        if let Some((issued_at, _)) = self.grants.get(&origin.device)
            && origin.issued_at_ms <= *issued_at
        {
            return false;
        }
        self.grants
            .insert(origin.device, (origin.issued_at_ms, wire.to_vec()));
        true
    }

    /// One event: verify, dedup by id, append, fan out to whoever asked for it, ack. The ack is
    /// sent for a duplicate too — it is the durability answer a write handle counts, and a client
    /// that retried because its first ack was lost must not wait forever for a second.
    fn ingest_event(&mut self, socket: SocketId, wire: &[u8], out: &mut Vec<RoomAction>) {
        let verified = match decode_and_verify(wire) {
            Ok(v) => v,
            Err(e) => {
                self.refuse(socket, "bad-event", &e.to_string(), false, out);
                return;
            }
        };
        let entry = StoredEvent::from_verified(verified);
        let id = entry.id();
        let held = match self.store.has(&id) {
            Ok(held) => held,
            Err(e) => {
                self.refuse(socket, "store", &e.message, false, out);
                return;
            }
        };
        if !held {
            if let Err(e) = self.store.append(&entry) {
                self.refuse(socket, "store", &e.message, false, out);
                return;
            }
            self.offset += 1;
            self.coverage.note(&entry.event);
            let relayed = relayed_frame(wire, self.offset);
            self.to_interested(&relayed, &entry.event, Some(&entry.event.peer_id), out);
        }
        self.send(socket, ack_frame(&id, self.offset), out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::is_hello;
    use crate::store::MemoryEventStore;

    fn identity(n: u8) -> Identity {
        Identity::from_seed(&[n; 32])
    }

    fn room(versions: Vec<u64>) -> Room {
        Room::new(
            identity(9),
            Box::new(MemoryEventStore::new()),
            RoomOptions {
                versions,
                ..RoomOptions::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn a_v3_room_speaks_a_hello_first_and_refuses_a_join_in_the_clear() {
        let mut room = room(vec![3]);
        let (socket, out) = room.connect(0);
        let [RoomAction::Send { bytes, .. }] = out.as_slice() else {
            panic!("expected one frame");
        };
        assert!(is_hello(bytes));
        let join =
            syncmesh_core::relay_frames::join_frame(&[3], identity(1).peer_id(), &[], None, None);
        let out = room.receive(socket, &join, 0);
        assert!(matches!(&out[0], RoomAction::Send { .. })); // the typed error, in the clear
        assert_eq!(
            out[1],
            RoomAction::Close {
                socket,
                reason: "handshake".to_owned()
            }
        );
        // and nothing more is heard from it
        assert!(room.receive(socket, &join, 0).is_empty());
    }

    #[test]
    fn a_v2_room_challenges_and_a_junk_first_frame_is_join_first() {
        let mut room = room(vec![1, 2]);
        let (socket, out) = room.connect(0);
        let [RoomAction::Send { bytes, .. }] = out.as_slice() else {
            panic!("expected one frame");
        };
        assert!(matches!(
            decode_relay_frame(bytes),
            Ok(RelayFrame::Challenge { .. })
        ));
        let out = room.receive(socket, &ka_frame(), 0);
        let RoomAction::Send { bytes, .. } = &out[0] else {
            panic!("expected an error");
        };
        assert!(matches!(
            decode_relay_frame(bytes),
            Ok(RelayFrame::Error { code, .. }) if code == "join-first"
        ));
        assert!(matches!(out[1], RoomAction::Close { .. }));
        // malformed bytes are a non-fatal refusal on a socket still open
        let (socket, _) = room.connect(0);
        let out = room.receive(socket, &[0xff], 0);
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], RoomAction::Send { .. }));
    }

    #[test]
    fn a_frame_over_the_cap_is_measured_not_decoded() {
        let mut small = Room::new(
            identity(9),
            Box::new(MemoryEventStore::new()),
            RoomOptions {
                versions: vec![2],
                max_frame_bytes: 8,
                ..RoomOptions::default()
            },
        )
        .unwrap();
        let (socket, _) = small.connect(0);
        let out = small.receive(socket, &[0; 9], 0);
        assert_eq!(
            out[1],
            RoomAction::Close {
                socket,
                reason: "frame-too-large".to_owned()
            }
        );
    }

    #[test]
    #[should_panic(expected = "lists 3 alone")]
    fn a_room_cannot_speak_a_hello_and_a_challenge_on_one_socket() {
        let _ = room(vec![2, 3]);
    }

    #[test]
    fn pages_always_number_at_least_one_and_carry_grants_first() {
        let pages = paged(&[], &[vec![1]], 2, 0, None);
        assert_eq!(pages.len(), 1);
        let Ok(RelayFrame::Page { grants, more, .. }) = decode_relay_frame(&pages[0]) else {
            panic!("not a page");
        };
        assert_eq!(grants, vec![vec![1]]);
        assert!(!more);
    }
}
