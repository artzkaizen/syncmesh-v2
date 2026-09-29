//! One device's link to one relay room (`relay/src/transport.ts`, `session.ts`, `secure.ts`,
//! `redial.ts`), sans-IO.
//!
//! The TypeScript holds a socket, a timer and a promise chain. This holds none of them: the host
//! opens the socket and reports it with [`RelayLink::on_dialed`], hands every binary message to
//! [`RelayLink::on_bytes`], asks [`RelayLink::next_deadline_ms`] when to call
//! [`RelayLink::on_tick`], and does what each returned [`Action`] says — send these bytes, close
//! the socket, dial again after so long. What the link decides is exactly what the TypeScript
//! decides, frame for frame, so a Rust device and a TypeScript one are the same peer to a room.
//!
//! D36 on the wire: the room speaks first. A 161-byte hello opens a sealed link — our hello goes
//! back in the clear, and from then on every byte either way is sealed under the session keys —
//! while a CBOR challenge is a v2 room, answered only if this build was told to offer 2. The join
//! then names the key the hello proved (or signs the challenge), carries our contiguous cursors,
//! and the room pages back what we lack.
//!
//! Where this deliberately differs from the TypeScript: nothing but our hello leaves before the
//! room has spoken. The TypeScript would send a presence or a grant asked for before the room's
//! first frame in the clear, and a v3 room refuses the socket for it; here that frame is reported
//! `Dropped` and the join that follows the handshake re-sends every grant anyway.

use std::collections::{BTreeMap, BTreeSet};

use syncmesh_core::envelope::decode_and_verify;
use syncmesh_core::event::{PeerId, SeqNum};
use syncmesh_core::frames::{
    Frame, cursors_frame, event_frame, grant_frame, grant_request_frame, presence_frame,
};
use syncmesh_core::handshake::{
    HELLO, HELLO_BYTES, HandshakeFailed, Hello, KEY_BYTES, SEALED, SessionKeys, read_hello, seal,
    session_keys, unseal, write_hello,
};
use syncmesh_core::identity::Identity;
use syncmesh_core::join_proof::prove_join;
use syncmesh_core::relay_frames::{
    HANDSHAKE_VERSION, PageScope, RELAY_PROTOCOL_VERSIONS, RelayFrame, decode_relay_frame,
    join_core, join_frame,
};

use crate::engine::{Engine, FoldBatch};
use crate::holdback::Holdback;
use crate::interest::{Interest, interest_from, interest_text, narrows};
use crate::store::{Coverage, Cursors, StoredEvent};

/// How long a peer stays claimed after it was last heard through this relay. Long against the
/// cursor traffic that re-arms it, short against somebody leaving a building; erring long is the
/// worse mistake, because a claim outranks a medium that says nothing.
pub const HEARD_TTL_MS: i64 = 60_000;

pub const MUTE: &str = "the relay stopped answering: no frame within 2.5 times its keepalive";
pub const REFUSED: &str = "the relay speaks none of the protocol versions this build offers";
pub const UNSECURED: &str =
    "the link is not sealed yet, and nothing but a hello travels before it is";
pub const UNPINNED: &str =
    "the relay's hello is signed by a key other than the one this device was told to expect";
pub const STOPPED: &str = "the link was stopped";
pub const WOKEN: &str = "the network changed, so this link is being re-established";

/// What the host is asked to do, or told. `Send`, `Close` and `Redial` are requests; the rest are
/// facts about the room and the fold, in the order they became true.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Raw socket bytes, already sealed where the link is.
    Send(Vec<u8>),
    /// Hang up. The host closes the socket and calls `on_closed` once it has.
    Close {
        reason: String,
    },
    /// Dial again after this long, then call `on_dialed` or `on_dial_failed`.
    Redial {
        after_ms: u64,
    },
    /// Permanent: a version the relay will not speak, a hello from a key other than the pinned
    /// one, a challenge this build was told not to answer. No redial follows.
    Refused {
        reason: String,
    },
    Online(bool),
    /// The last catch-up page has landed and what the relay lacked has been pushed.
    CaughtUp,
    Folded(FoldBatch),
    /// An inbound presence wire for the ephemeral tier.
    Presence(Vec<u8>),
    /// An inbound grant wire, for the registry.
    Grant(Vec<u8>),
    GrantRequest {
        peer_id: PeerId,
        invite: Option<String>,
    },
    /// The relay answered a fetch: the bytes, or `None` when it holds none under that hash.
    BlobAnswer {
        hash: String,
        bytes: Option<Vec<u8>>,
    },
    /// Another device spoke through this relay, so the relay demonstrably carries it.
    PeerHeard(PeerId),
    /// Bytes that became nothing, said: a frame this build cannot decode, an event whose
    /// signature does not verify, a send asked for before there was a key to seal under.
    Dropped(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayOptions {
    /// What `join` offers; the room picks the highest in common. Default `RELAY_PROTOCOL_VERSIONS`.
    pub versions: Vec<u64>,
    /// What this device wants from the room. It narrows: a relay applies it after the read
    /// policy, so an interest can make a device see less and never more.
    pub interest: Option<Interest>,
    /// The room's own key (D36): the one peer id this device accepts a link hello from. A hello
    /// signed by any other key is a permanent refusal. Absent, any well-signed hello opens the
    /// link and `wss://` is what stands between this device and a machine in the middle.
    pub relay_key: Option<PeerId>,
    /// First reconnect delay; doubles per failure up to `max_reconnect_ms`. Default 500.
    pub reconnect_ms: u64,
    pub max_reconnect_ms: u64,
    /// Events held per author above a hole before the link gives up on the run and re-joins.
    pub gap_limit: usize,
    pub name: String,
}

impl Default for RelayOptions {
    fn default() -> Self {
        RelayOptions {
            versions: RELAY_PROTOCOL_VERSIONS.to_vec(),
            interest: None,
            relay_key: None,
            reconnect_ms: 500,
            max_reconnect_ms: 30_000,
            gap_limit: 512,
            name: "relay".to_owned(),
        }
    }
}

/// Whether these bytes are shaped like a hello: the one frame that is never CBOR on this wire.
pub fn is_hello(raw: &[u8]) -> bool {
    raw.len() == HELLO_BYTES && raw[0] == HELLO
}

/// Cursors as a frame carries them. A `BTreeMap` iterates by peer id, so a Rust device writes its
/// cursors sorted where a TypeScript one writes them in insertion order; both are the same claim,
/// and nothing on the wire hashes or signs a cursor list — a join proof covers the join's own
/// body, which the room re-encodes from what it read.
pub fn cursors_to_pairs(cursors: &Cursors) -> Vec<(PeerId, SeqNum)> {
    cursors.iter().map(|(p, s)| (p.clone(), *s)).collect()
}

pub fn cursors_to_map(pairs: &[(PeerId, SeqNum)]) -> Cursors {
    pairs.iter().cloned().collect()
}

/// Why a sealed link refused a frame (`secure.ts`'s `LinkRefused`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LinkRefused {
    /// The first frame was not a well-signed hello, or the two hellos agree on no key.
    Handshake(HandshakeFailed),
    /// A plaintext frame after the handshake: a downgrade, not a mistake.
    Unsealed,
    /// A sealed frame this link's key does not open — another link's traffic, or tampering.
    Unopenable(HandshakeFailed),
}

impl LinkRefused {
    pub(crate) fn message(&self) -> String {
        match self {
            LinkRefused::Handshake(e) | LinkRefused::Unopenable(e) => e.to_string(),
            LinkRefused::Unsealed => "a frame in the clear on a sealed link".to_owned(),
        }
    }
}

/// The sealed link state machine both ends run (`secure.ts`): the hello we offered and the
/// secret behind it until the peer's arrives, then the session. Randomness comes from
/// `crate::random`; nothing here holds a socket or a timer.
#[derive(Debug)]
pub(crate) struct SealedLink {
    secret: [u8; KEY_BYTES],
    ours: Hello,
    session: Option<(PeerId, SessionKeys)>,
}

impl SealedLink {
    /// A fresh offer: a new ephemeral key signed by `identity`.
    pub(crate) fn offer(identity: &Identity) -> SealedLink {
        let secret: [u8; KEY_BYTES] = crate::random::bytes();
        SealedLink {
            secret,
            ours: write_hello(identity, &secret),
            session: None,
        }
    }

    /// Our hello, to go out first and in the clear.
    pub(crate) fn hello_frame(&self) -> &[u8] {
        &self.ours.frame
    }

    pub(crate) fn session_peer(&self) -> Option<&PeerId> {
        self.session.as_ref().map(|(p, _)| p)
    }

    /// The peer's hello completes the exchange and yields nothing to deliver.
    pub(crate) fn complete(&mut self, raw: &[u8]) -> Result<PeerId, LinkRefused> {
        let theirs = read_hello(raw).map_err(LinkRefused::Handshake)?;
        let keys =
            session_keys(&self.secret, &self.ours, &theirs).map_err(LinkRefused::Handshake)?;
        self.session = Some((theirs.peer_id.clone(), keys));
        Ok(theirs.peer_id)
    }

    /// A raw frame in: before the handshake it must be the peer's hello (and yields `None`);
    /// after it, a sealed frame, which yields its plaintext.
    pub(crate) fn receive(&mut self, raw: &[u8]) -> Result<Option<Vec<u8>>, LinkRefused> {
        let Some((_, keys)) = &self.session else {
            self.complete(raw)?;
            return Ok(None);
        };
        if !is_hello(raw) && raw.first() != Some(&SEALED) {
            return Err(LinkRefused::Unsealed);
        }
        unseal(&keys.open, raw)
            .map(Some)
            .map_err(LinkRefused::Unopenable)
    }

    /// Plaintext out as a sealed frame, or `None` before there is a key to seal under.
    pub(crate) fn seal(&self, plain: &[u8]) -> Option<Vec<u8>> {
        let (_, keys) = self.session.as_ref()?;
        seal(&keys.seal, plain, &crate::random::nonce()).ok()
    }
}

/// One dialed socket's worth of state; gone when the socket is.
#[derive(Debug)]
struct Live {
    /// This session's sealed link (D36), present from the room's hello on. Absent on a room that
    /// challenges instead.
    link: Option<SealedLink>,
    /// This session's challenge from a v2 room; a v2 join is sent once it has arrived (D33).
    nonce: Option<[u8; 32]>,
    keepalive_ms: Option<u64>,
    deadline_ms: Option<i64>,
    caught_up: bool,
    /// What we know the relay holds: its hello, moved forward by what we have pushed since.
    relay_cursors: Cursors,
    holdback: Holdback,
    /// A `Close` has been asked for; bytes that still arrive belong to a socket on its way out.
    closing: bool,
}

/// One device's link to one room. See the module notes for how a host drives it.
pub struct RelayLink {
    identity: Identity,
    options: RelayOptions,
    live: Option<Live>,
    stopped: bool,
    fatal: bool,
    /// This join asked from nothing because the interest outgrew what our cursors describe (D23).
    repaging: bool,
    online: bool,
    backoff_ms: u64,
    heard: BTreeMap<PeerId, i64>,
    /// Every grant wire the host registered, re-sent straight after every join.
    grant_wires: Vec<Vec<u8>>,
}

impl std::fmt::Debug for RelayLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayLink")
            .field("name", &self.options.name)
            .field("peer", self.identity.peer_id())
            .field("online", &self.online)
            .field("caught_up", &self.caught_up())
            .finish_non_exhaustive()
    }
}

impl RelayLink {
    pub fn new(identity: Identity, options: RelayOptions) -> RelayLink {
        RelayLink {
            backoff_ms: options.reconnect_ms,
            identity,
            options,
            live: None,
            stopped: false,
            fatal: false,
            repaging: false,
            online: false,
            heard: BTreeMap::new(),
            grant_wires: Vec::new(),
        }
    }

    pub fn name(&self) -> &str {
        &self.options.name
    }

    pub fn peer_id(&self) -> &PeerId {
        self.identity.peer_id()
    }

    pub fn options(&self) -> &RelayOptions {
        &self.options
    }

    pub fn is_online(&self) -> bool {
        self.online
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    /// Permanently refused: nothing will be dialled again.
    pub fn is_refused(&self) -> bool {
        self.fatal
    }

    pub fn caught_up(&self) -> bool {
        self.live.as_ref().is_some_and(|l| l.caught_up)
    }

    /// The room's key, once its hello has been read on a sealed link.
    pub fn session_peer(&self) -> Option<&PeerId> {
        self.live
            .as_ref()
            .and_then(|l| l.link.as_ref())
            .and_then(SealedLink::session_peer)
    }

    /// When `on_tick` next has something to do, in the host's clock.
    pub fn next_deadline_ms(&self) -> Option<i64> {
        self.live
            .as_ref()
            .filter(|l| !l.closing)
            .and_then(|l| l.deadline_ms)
    }

    /// Peers still claimed, with the ones that have gone quiet dropped on the way past. Nothing
    /// is claimed while this source is down or stopped: a claim ranks above a medium that merely
    /// says nothing, and a relay that went on claiming a room it could no longer reach would
    /// take frames from the radio sitting next to the device.
    pub fn heard(&mut self, now_ms: i64) -> BTreeSet<PeerId> {
        let cutoff = now_ms - HEARD_TTL_MS;
        self.heard.retain(|_, at| *at >= cutoff);
        if self.online && !self.stopped {
            self.heard.keys().cloned().collect()
        } else {
            BTreeSet::new()
        }
    }

    // --- the socket's lifecycle -------------------------------------------------------------

    /// The socket opened. Nothing is sent: the room speaks first, and its hello or its challenge
    /// is what gets answered. A socket that opened after `stop` or a refusal is closed again.
    pub fn on_dialed(&mut self, _now_ms: i64) -> Vec<Action> {
        if self.stopped || self.fatal {
            return vec![Action::Close {
                reason: if self.stopped { STOPPED } else { REFUSED }.to_owned(),
            }];
        }
        self.live = Some(Live {
            link: None,
            nonce: None,
            keepalive_ms: None,
            deadline_ms: None,
            caught_up: false,
            relay_cursors: Cursors::new(),
            holdback: Holdback::new(self.options.gap_limit),
            closing: false,
        });
        Vec::new()
    }

    /// The socket closed, for whatever reason. Unless stopped or refused, a redial follows on the
    /// current backoff, which doubles; a hello resets it.
    pub fn on_closed(&mut self, _now_ms: i64) -> Vec<Action> {
        let mut out = Vec::new();
        self.live = None;
        if self.online {
            self.online = false;
            out.push(Action::Online(false));
        }
        if self.stopped || self.fatal {
            return out;
        }
        out.push(self.redial_later());
        out
    }

    /// A dial that never opened is not a link that closed: nothing was ever there to end. The
    /// next attempt waits out the backoff like a close does.
    pub fn on_dial_failed(&mut self, _now_ms: i64) -> Vec<Action> {
        if self.stopped || self.fatal {
            return Vec::new();
        }
        vec![self.redial_later()]
    }

    fn redial_later(&mut self) -> Action {
        let after_ms = self.backoff_ms;
        self.backoff_ms = (self.backoff_ms.saturating_mul(2)).min(self.options.max_reconnect_ms);
        Action::Redial { after_ms }
    }

    /// The liveness deadline: a relay that announced a keepalive and then said nothing for 2.5×
    /// it is hung up on, and the reconnect that follows re-joins. A hello-less relay arms nothing.
    pub fn on_tick(&mut self, now_ms: i64) -> Vec<Action> {
        let mut out = Vec::new();
        let due = self
            .live
            .as_ref()
            .filter(|l| !l.closing)
            .and_then(|l| l.deadline_ms)
            .is_some_and(|deadline| deadline <= now_ms);
        if due {
            if let Some(live) = self.live.as_mut() {
                live.deadline_ms = None;
            }
            self.hang_up(MUTE, &mut out);
        }
        out
    }

    /// Something outside knows the network moved: drop whatever we are holding and dial again
    /// at once. Hanging up first matters — after a Wi-Fi drop the old socket is usually not
    /// closed, merely orphaned — and the backoff is reset, because a network that just came back
    /// should not wait out a delay earned while it was gone.
    pub fn wake(&mut self) -> Vec<Action> {
        let mut out = Vec::new();
        if self.stopped || self.fatal {
            return out;
        }
        self.backoff_ms = self.options.reconnect_ms;
        if self.live.is_none() {
            out.push(Action::Redial { after_ms: 0 });
        } else {
            self.hang_up(WOKEN, &mut out);
        }
        out
    }

    /// Ends the link for good: the socket is closed and nothing is dialled again.
    pub fn stop(&mut self) -> Vec<Action> {
        let mut out = Vec::new();
        self.stopped = true;
        if self.live.take().is_some() {
            out.push(Action::Close {
                reason: STOPPED.to_owned(),
            });
        }
        if self.online {
            self.online = false;
            out.push(Action::Online(false));
        }
        out
    }

    // --- inbound ------------------------------------------------------------------------------

    /// Raw socket bytes in. The room's first frame says which protocol it speaks: a hello opens a
    /// sealed link, and our hello answers it in the clear before anything else; a CBOR frame is a
    /// challenging room, whose frames arrive as they are. After the handshake every frame must
    /// open under the session key, and one in the clear is a downgrade this link hangs up on.
    pub fn on_bytes(&mut self, engine: &mut Engine, raw: &[u8], now_ms: i64) -> Vec<Action> {
        let mut out = Vec::new();
        let Some(live) = self.live.as_mut() else {
            return out;
        };
        if live.closing {
            return out;
        }
        let plain: Vec<u8> = match live.link.as_mut() {
            None if is_hello(raw) => {
                if !self.options.versions.contains(&HANDSHAKE_VERSION) {
                    self.refused(REFUSED, &mut out);
                    return out;
                }
                let mut link = SealedLink::offer(&self.identity);
                let peer = match link.complete(raw) {
                    Ok(peer) => peer,
                    Err(e) => {
                        self.hang_up(&e.message(), &mut out);
                        return out;
                    }
                };
                // pinned: the hello proved *a* key; it has to be *the* key, or this is not our relay
                if self
                    .options
                    .relay_key
                    .as_ref()
                    .is_some_and(|pin| pin != &peer)
                {
                    self.refused(UNPINNED, &mut out);
                    return out;
                }
                let hello = link.hello_frame().to_vec();
                live.link = Some(link);
                // our hello answers the room's, in the clear; it is the last thing that travels so
                out.push(Action::Send(hello));
                self.join(engine, &mut out);
                return out;
            }
            None => raw.to_vec(),
            Some(link) => match link.receive(raw) {
                Ok(Some(plain)) => plain,
                // the client's link is completed in one step, so a hello here is a re-run
                // handshake, which the room never does; `receive` refuses it as unopenable
                Ok(None) => return out,
                Err(e) => {
                    self.hang_up(&e.message(), &mut out);
                    return out;
                }
            },
        };
        self.rearm(now_ms);
        match decode_relay_frame(&plain) {
            Err(e) => out.push(Action::Dropped(e.to_string())),
            Ok(frame) => self.dispatch(engine, frame, now_ms, &mut out),
        }
        out
    }

    fn rearm(&mut self, now_ms: i64) {
        if let Some(live) = self.live.as_mut()
            && let Some(keepalive) = live.keepalive_ms
        {
            live.deadline_ms = Some(now_ms.saturating_add((keepalive as f64 * 2.5) as i64));
        }
    }

    fn dispatch(
        &mut self,
        engine: &mut Engine,
        frame: RelayFrame,
        now_ms: i64,
        out: &mut Vec<Action>,
    ) {
        match frame {
            RelayFrame::Challenge { nonce } => {
                // a challenge is a v2 room; a build offering only the sealed link has nothing to sign it with
                if !self.options.versions.contains(&2) {
                    self.refused(REFUSED, out);
                    return;
                }
                if let Some(live) = self.live.as_mut() {
                    live.nonce = Some(nonce);
                }
                self.join(engine, out);
            }
            RelayFrame::Hello {
                keepalive_ms,
                cursors,
                ..
            } => {
                let relay_cursors = cursors_to_map(&cursors);
                // the room's run of our own author: never number at or below it (G7)
                if let Some(&own) = relay_cursors.get(self.identity.peer_id()) {
                    match engine.adopt_own_position(own) {
                        Ok(position) => {
                            if let Some(warning) = position.warning() {
                                out.push(Action::Dropped(warning));
                            }
                        }
                        Err(e) => out.push(Action::Dropped(format!(
                            "the store could not say what this device last wrote: {e}"
                        ))),
                    }
                }
                if let Some(live) = self.live.as_mut() {
                    live.relay_cursors = relay_cursors;
                    live.keepalive_ms = Some(keepalive_ms);
                }
                self.rearm(now_ms);
                self.backoff_ms = self.options.reconnect_ms;
                self.online = true;
                out.push(Action::Online(true));
            }
            RelayFrame::Page {
                grants,
                events,
                more,
                scoped,
                ..
            } => {
                for wire in grants {
                    out.push(Action::Grant(wire));
                }
                let repaging = self.repaging;
                // an overflow re-joins and abandons the rest of this page's events; the last-page
                // handling still runs, exactly as the TypeScript's synchronous half of it does
                self.fold(engine, &events, repaging, out);
                if !more {
                    if let Some(scoped) = scoped {
                        self.adopt_scoped(engine, scoped, out);
                    } else if repaging {
                        self.rescope(engine);
                    }
                    if let Some(live) = self.live.as_mut() {
                        live.caught_up = true;
                    }
                    self.push_outstanding(engine, out);
                    self.repaging = false;
                    out.push(Action::CaughtUp);
                }
            }
            RelayFrame::Relayed { wire, .. } => {
                self.fold(engine, std::slice::from_ref(&wire), false, out);
            }
            RelayFrame::Blob { hash, bytes } => out.push(Action::BlobAnswer {
                hash,
                bytes: Some(bytes),
            }),
            RelayFrame::BlobMissing { hash } => out.push(Action::BlobAnswer { hash, bytes: None }),
            RelayFrame::Error { code, message } => {
                if code == "version" {
                    self.fatal = true;
                    out.push(Action::Refused {
                        reason: REFUSED.to_owned(),
                    });
                }
                self.hang_up(&format!("{code}: {message}"), out);
            }
            RelayFrame::Session(frame) => self.on_session(engine, frame, now_ms, out),
            // ka and unknown: the rearm was the whole point; ack is durability the log already
            // has; the rest are frames a room never sends a device
            RelayFrame::Ka
            | RelayFrame::Ack { .. }
            | RelayFrame::Unknown
            | RelayFrame::Join(_)
            | RelayFrame::BlobPut { .. }
            | RelayFrame::BlobGet { .. } => {}
        }
    }

    fn on_session(
        &mut self,
        engine: &mut Engine,
        frame: Frame,
        now_ms: i64,
        out: &mut Vec<Action>,
    ) {
        match frame {
            Frame::Presence { wire } => out.push(Action::Presence(wire)),
            Frame::Grant { wire } => out.push(Action::Grant(wire)),
            Frame::Cursors { from, cursors, .. } => {
                // cursors rather than events, deliberately: a relayed event may be history from a
                // device that left hours ago, while cursors are a live peer reporting now
                self.heard.insert(from.clone(), now_ms);
                out.push(Action::PeerHeard(from.clone()));
                engine.acknowledge(from, cursors_to_map(&cursors), now_ms);
            }
            Frame::GrantRequest { peer_id, invite } => {
                out.push(Action::GrantRequest { peer_id, invite });
            }
            Frame::Event { wire } => {
                self.fold(engine, std::slice::from_ref(&wire), false, out);
            }
            Frame::Digest { .. }
            | Frame::Receipt { .. }
            | Frame::Routes { .. }
            | Frame::Snapshot(_)
            | Frame::Unknown => {}
        }
    }

    /// Verifies, holds back, folds. `direct` skips the holdback, and only a widening re-page sets
    /// it: that re-page is being handed a run this device's cursor already claims, so the gap
    /// rule would read every event in it as one already held and drop the very events the
    /// re-page exists to deliver. The engine dedups on what is stored, which is the question
    /// that matters there. Answers whether the holdback overflowed (and a re-join went out).
    fn fold(
        &mut self,
        engine: &mut Engine,
        wires: &[Vec<u8>],
        direct: bool,
        out: &mut Vec<Action>,
    ) -> bool {
        let mut authors: BTreeSet<PeerId> = BTreeSet::new();
        let mut straight: Vec<StoredEvent> = Vec::new();
        for wire in wires {
            let verified = match decode_and_verify(wire) {
                Ok(v) => v,
                Err(e) => {
                    // junk from a relay is dropped, never folded — and said, because a relay handing
                    // this device unverifiable bytes is a fact about the room, not about this event
                    out.push(Action::Dropped(e.to_string()));
                    continue;
                }
            };
            let entry = StoredEvent::from_verified(verified);
            if direct {
                straight.push(entry);
                continue;
            }
            let author = entry.event.peer_id.clone();
            let Some(live) = self.live.as_mut() else {
                return false;
            };
            if live.holdback.put(entry, engine) {
                self.join(engine, out);
                return true;
            }
            authors.insert(author);
        }
        if !straight.is_empty() {
            Self::receive(engine, straight, out);
        }
        self.release(engine, authors, out);
        false
    }

    fn receive(engine: &mut Engine, entries: Vec<StoredEvent>, out: &mut Vec<Action>) {
        match engine.receive_batch(entries) {
            Ok(received) => {
                if received.batch.event_count > 0 {
                    out.push(Action::Folded(received.batch));
                }
            }
            // the log already holds the truth or nothing at all; the reconnect's join re-pages
            Err(e) => out.push(Action::Dropped(format!("the store refused a batch: {e}"))),
        }
    }

    /// Everything the holdback can let go of for these authors, in run order.
    fn release(
        &mut self,
        engine: &mut Engine,
        authors: impl IntoIterator<Item = PeerId>,
        out: &mut Vec<Action>,
    ) {
        for author in authors {
            let Some(live) = self.live.as_mut() else {
                return;
            };
            let batch = live.holdback.drain(&author, engine);
            if !batch.is_empty() {
                Self::receive(engine, batch, out);
            }
        }
    }

    /// Takes on the coverage a filtered catch-up ended with (D23): the events it accounts for are
    /// folded before this device claims to hold them. A coverage scoped to something other than
    /// what we asked with is dropped rather than adopted — it would be a claim about a slice this
    /// device did not request, and adopting it is how a cursor comes to describe events nobody
    /// will ever send again.
    fn adopt_scoped(&mut self, engine: &mut Engine, scoped: PageScope, out: &mut Vec<Action>) {
        if scoped.scope != interest_text(self.options.interest.as_ref()) {
            return;
        }
        let coverage = Coverage {
            synced: cursors_to_map(&scoped.synced),
            local: Cursors::new(),
            scope: Some(scoped.scope),
        };
        for (author, seq) in &coverage.synced {
            let Some(live) = self.live.as_mut() else {
                return;
            };
            let held = live.holdback.up_to(author, seq.get());
            if !held.is_empty() {
                Self::receive(engine, held, out);
            }
        }
        engine.adopt_coverage(&coverage);
        let authors: Vec<PeerId> = coverage.synced.keys().cloned().collect();
        self.release(engine, authors, out);
    }

    /// After a widening re-page the relay did not filter: the cursors this device holds are now
    /// true for the wider interest, because the repair ran from nothing and delivered the whole
    /// run. Saying so is what stops the next join re-paging the same history again.
    fn rescope(&mut self, engine: &mut Engine) {
        let Coverage { synced, local, .. } = engine.coverage();
        let scope = interest_text(self.options.interest.as_ref());
        // rebuilt rather than carried, so an interest that widened all the way back to
        // everything drops the old scope instead of keeping it
        engine.adopt_coverage(&Coverage {
            synced,
            local,
            scope: if scope.is_empty() { None } else { Some(scope) },
        });
    }

    /// Everything this device holds that the relay does not, whoever wrote it — forwarding is the
    /// whole of carrying an event written where there was no network. `relay_cursors` moves with
    /// what is sent so a second call sends the difference rather than the run again.
    fn push_outstanding(&mut self, engine: &Engine, out: &mut Vec<Action>) {
        let Some(live) = self.live.as_ref() else {
            return;
        };
        let theirs = live.relay_cursors.clone();
        let Ok(entries) = engine.events_since(&theirs, None) else {
            return;
        };
        let mut sent = theirs;
        for entry in entries {
            let Some(wire) = entry.envelope() else {
                continue;
            };
            self.send_safe(event_frame(&wire), out);
            let at = sent
                .entry(entry.event.peer_id.clone())
                .or_insert(entry.event.seq_num);
            if entry.event.seq_num > *at {
                *at = entry.event.seq_num;
            }
        }
        if let Some(live) = self.live.as_mut() {
            live.relay_cursors = sent;
        }
    }

    /// Our contiguous position, for every other peer's `delivered`; the relay passes it on.
    fn send_cursors(&mut self, engine: &Engine, out: &mut Vec<Action>) {
        let pairs = cursors_to_pairs(&engine.coverage().synced);
        self.send_safe(cursors_frame(self.identity.peer_id(), &pairs, None), out);
    }

    // --- outbound -----------------------------------------------------------------------------

    /// Seals and sends where the link is, or says why it could not. Nothing leaves in the clear
    /// before the room has spoken: on a sealed link that would be a downgrade, and on a
    /// challenging room the first frame has to be the join.
    fn send_safe(&mut self, plain: Vec<u8>, out: &mut Vec<Action>) {
        let Some(live) = self.live.as_ref() else {
            return;
        };
        if live.closing {
            return;
        }
        match live.link.as_ref() {
            Some(link) => match link.seal(&plain) {
                Some(sealed) => out.push(Action::Send(sealed)),
                None => out.push(Action::Dropped(UNSECURED.to_owned())),
            },
            None if live.nonce.is_some() => out.push(Action::Send(plain)),
            None => out.push(Action::Dropped(UNSECURED.to_owned())),
        }
    }

    fn hang_up(&mut self, why: &str, out: &mut Vec<Action>) {
        if let Some(live) = self.live.as_mut() {
            if live.closing {
                return;
            }
            live.closing = true;
        }
        out.push(Action::Close {
            reason: why.to_owned(),
        });
    }

    /// The relay refused this build, in one of its voices. Permanent — no reconnect loop.
    fn refused(&mut self, why: &str, out: &mut Vec<Action>) {
        out.push(Action::Refused {
            reason: why.to_owned(),
        });
        self.fatal = true;
        self.hang_up(why, out);
    }

    /// The position to ask from — ours, unless our cursors describe a slice this device has since
    /// widened past (D23). Widening asks from nothing and re-pages the run under the new
    /// interest; the engine dedups on what it has stored, so the repair is complete. Narrowing
    /// keeps the cursor, because a cursor true for a wider slice is true for a smaller one.
    fn ask_from(&mut self, engine: &Engine) -> Vec<(PeerId, SeqNum)> {
        let coverage = engine.coverage();
        self.repaging = !narrows(
            self.options.interest.as_ref(),
            interest_from(coverage.scope.as_deref()).as_ref(),
        );
        if self.repaging {
            Vec::new()
        } else {
            cursors_to_pairs(&coverage.synced)
        }
    }

    /// Joins the room. On a sealed link the join proves nothing itself: the hello already proved
    /// this key, and the room holds the join to that name. On a challenging room it signs the
    /// challenge, and nothing is sent before that challenge has arrived. Every registered grant
    /// follows the join, so the room can hand them to the next joiner.
    fn join(&mut self, engine: &Engine, out: &mut Vec<Action>) {
        let Some(live) = self.live.as_ref() else {
            return;
        };
        let (sealed, nonce) = (live.link.is_some(), live.nonce);
        let text = interest_text(self.options.interest.as_ref());
        let interest = (!text.is_empty()).then_some(text.as_str());
        let peer = self.identity.peer_id().clone();
        let versions = self.options.versions.clone();
        let frame = if sealed {
            let cursors = self.ask_from(engine);
            join_frame(&versions, &peer, &cursors, interest, None)
        } else {
            let Some(nonce) = nonce else { return };
            let cursors = self.ask_from(engine);
            let core = join_core(&versions, &peer, &cursors, interest);
            let proof = prove_join(&self.identity, &nonce, &core);
            join_frame(&versions, &peer, &cursors, interest, Some(&proof))
        };
        self.send_safe(frame, out);
        for wire in self.grant_wires.clone() {
            self.send_safe(grant_frame(&wire), out);
        }
    }

    /// A fresh join from our contiguous position on the same socket — what the host calls when
    /// it has reason to believe the room holds something the session missed.
    pub fn resync(&mut self, engine: &Engine) -> Vec<Action> {
        let mut out = Vec::new();
        self.join(engine, &mut out);
        out
    }

    /// This device wrote something. After catch-up it goes out at once; before, the push after the
    /// last page covers it, since it is already in the store the push reads.
    pub fn on_local_write(&mut self, entry: &StoredEvent) -> Vec<Action> {
        let mut out = Vec::new();
        if !self.caught_up() {
            return out;
        }
        if let Some(wire) = entry.envelope() {
            self.send_safe(event_frame(&wire), &mut out);
        }
        out
    }

    /// A fold of peers' events from another source moved our position: say so, and hand over
    /// what moved it. Saying so alone was the hole — a device that learns an event over
    /// Bluetooth and only reports its new cursor tells the relay that something happened and
    /// never what. Only once caught up; before that the push after the last page covers it.
    pub fn on_remote_fold(&mut self, engine: &Engine) -> Vec<Action> {
        let mut out = Vec::new();
        if !self.caught_up() {
            return out;
        }
        self.push_outstanding(engine, &mut out);
        self.send_cursors(engine, &mut out);
        out
    }

    pub fn send_presence(&mut self, wire: &[u8]) -> Vec<Action> {
        let mut out = Vec::new();
        self.send_safe(presence_frame(wire), &mut out);
        out
    }

    /// Grants this device holds. Remembered, so every join re-sends them; a wire already
    /// remembered is not sent twice.
    pub fn send_grants(&mut self, wires: Vec<Vec<u8>>) -> Vec<Action> {
        let mut out = Vec::new();
        for wire in wires {
            if self.grant_wires.contains(&wire) {
                continue;
            }
            self.grant_wires.push(wire.clone());
            self.send_safe(grant_frame(&wire), &mut out);
        }
        out
    }

    pub fn request_grant(&mut self, invite: Option<&str>) -> Vec<Action> {
        let mut out = Vec::new();
        let frame = grant_request_frame(self.identity.peer_id(), invite);
        self.send_safe(frame, &mut out);
        out
    }

    /// A plaintext relay or session frame the host built itself — what a blob channel's puts and
    /// gets go through — sealed and sent like anything else.
    pub fn send_raw_frame(&mut self, plain: Vec<u8>) -> Vec<Action> {
        let mut out = Vec::new();
        self.send_safe(plain, &mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::EngineOptions;
    use crate::store::MemoryEventStore;
    use syncmesh_core::relay_frames::{challenge_frame, error_frame, hello_frame};

    fn identity(n: u8) -> Identity {
        Identity::from_seed(&[n; 32])
    }

    fn engine(n: u8) -> Engine {
        Engine::open(
            identity(n),
            Box::new(MemoryEventStore::new()),
            None,
            EngineOptions::default(),
        )
        .unwrap()
    }

    #[test]
    fn a_link_offering_only_three_refuses_a_challenge_for_good() {
        let mut engine = engine(1);
        let mut link = RelayLink::new(identity(1), RelayOptions::default());
        assert!(link.on_dialed(0).is_empty());
        let out = link.on_bytes(&mut engine, &challenge_frame(&[7; 32]), 0);
        assert_eq!(
            out,
            vec![
                Action::Refused {
                    reason: REFUSED.to_owned()
                },
                Action::Close {
                    reason: REFUSED.to_owned()
                }
            ]
        );
        assert!(link.is_refused());
        // and nothing is dialled again
        assert!(link.on_closed(1).is_empty());
        assert!(link.wake().is_empty());
    }

    #[test]
    fn a_challenging_room_is_answered_with_a_signed_join_and_hello_arms_liveness() {
        let mut engine = engine(1);
        let mut link = RelayLink::new(
            identity(1),
            RelayOptions {
                versions: vec![2, 3],
                ..RelayOptions::default()
            },
        );
        link.on_dialed(0);
        let out = link.on_bytes(&mut engine, &challenge_frame(&[7; 32]), 0);
        let [Action::Send(join)] = out.as_slice() else {
            panic!("expected one join, got {out:?}");
        };
        let Ok(RelayFrame::Join(join)) = decode_relay_frame(join) else {
            panic!("not a join");
        };
        assert_eq!(join.versions, vec![2, 3]);
        assert!(join.proof.is_some());
        assert!(link.next_deadline_ms().is_none());
        let out = link.on_bytes(&mut engine, &hello_frame(2, 1000, "e", &[], &[]), 10);
        assert_eq!(out, vec![Action::Online(true)]);
        assert_eq!(link.next_deadline_ms(), Some(2510));
        assert!(link.on_tick(2509).is_empty());
        assert_eq!(
            link.on_tick(2510),
            vec![Action::Close {
                reason: MUTE.to_owned()
            }]
        );
        // a second tick does not close twice
        assert!(link.on_tick(2600).is_empty());
        assert_eq!(
            link.on_closed(2600),
            vec![Action::Online(false), Action::Redial { after_ms: 500 }]
        );
        assert_eq!(
            link.on_dial_failed(3100),
            vec![Action::Redial { after_ms: 1000 }]
        );
        assert_eq!(
            link.on_dial_failed(4100),
            vec![Action::Redial { after_ms: 2000 }]
        );
    }

    #[test]
    fn a_version_error_is_permanent_and_other_errors_merely_close() {
        let mut engine = engine(1);
        let mut link = RelayLink::new(
            identity(1),
            RelayOptions {
                versions: vec![2],
                ..RelayOptions::default()
            },
        );
        link.on_dialed(0);
        link.on_bytes(&mut engine, &challenge_frame(&[7; 32]), 0);
        let out = link.on_bytes(&mut engine, &error_frame("rate", "slow down"), 0);
        assert_eq!(
            out,
            vec![Action::Close {
                reason: "rate: slow down".to_owned()
            }]
        );
        assert!(!link.is_refused());
        link.on_closed(0);
        link.on_dialed(1);
        link.on_bytes(&mut engine, &challenge_frame(&[8; 32]), 1);
        let out = link.on_bytes(
            &mut engine,
            &error_frame("version", "this relay speaks 1"),
            1,
        );
        assert!(matches!(out[0], Action::Refused { .. }));
        assert!(matches!(out[1], Action::Close { .. }));
        assert!(link.is_refused());
    }

    #[test]
    fn nothing_leaves_in_the_clear_before_the_room_speaks() {
        let mut link = RelayLink::new(identity(1), RelayOptions::default());
        assert!(link.send_presence(&[1, 2, 3]).is_empty()); // no socket: nothing to say it on
        link.on_dialed(0);
        assert_eq!(
            link.send_presence(&[1, 2, 3]),
            vec![Action::Dropped(UNSECURED.to_owned())]
        );
        assert_eq!(
            link.send_grants(vec![vec![9]]),
            vec![Action::Dropped(UNSECURED.to_owned())]
        );
        // remembered all the same, for the join to carry
        assert_eq!(link.grant_wires, vec![vec![9]]);
    }

    #[test]
    fn a_sealed_link_opens_only_what_its_peer_sealed() {
        let room = identity(9);
        let device = identity(1);
        let mut theirs = SealedLink::offer(&room);
        let mut ours = SealedLink::offer(&device);
        assert!(ours.receive(theirs.hello_frame()).unwrap().is_none());
        assert!(theirs.receive(ours.hello_frame()).unwrap().is_none());
        assert_eq!(ours.session_peer(), Some(room.peer_id()));
        let sealed = theirs.seal(b"hello there").unwrap();
        assert_eq!(
            ours.receive(&sealed).unwrap(),
            Some(b"hello there".to_vec())
        );
        assert_eq!(ours.receive(b"plain").unwrap_err(), LinkRefused::Unsealed);
        let mut other = SealedLink::offer(&identity(2));
        let mut stranger = SealedLink::offer(&identity(3));
        other.receive(stranger.hello_frame()).unwrap();
        stranger.receive(other.hello_frame()).unwrap();
        let foreign = stranger.seal(b"x").unwrap();
        assert!(matches!(
            ours.receive(&foreign).unwrap_err(),
            LinkRefused::Unopenable(_)
        ));
        // a hello with a broken signature is not one
        let mut broken = theirs.hello_frame().to_vec();
        broken[100] ^= 1;
        assert!(matches!(
            SealedLink::offer(&device).complete(&broken).unwrap_err(),
            LinkRefused::Handshake(HandshakeFailed::BadSignature)
        ));
    }
}
