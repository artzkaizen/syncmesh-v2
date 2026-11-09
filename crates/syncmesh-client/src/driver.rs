//! The IO in this crate: a tokio task that dials a relay over a WebSocket and runs a [`RelayLink`]
//! against it, and one that runs a [`PeerLink`] over any [`PeerMedium`] (gap U3's radios).
//! Everything a link decides, it decides sans-IO; these loops only move bytes, sleep when told to,
//! and turn the link's facts into events on a channel.
//!
//! The host talks to a running link through commands and keeps the engine behind a
//! mutex it shares with the task, so a write made on the host's own thread and the fold of a
//! relayed event never interleave inside the engine.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use syncmesh_core::event::PeerId;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::blobs::PutRefusal;
use crate::engine::{Engine, FoldBatch};
use crate::peer::{PeerAction, PeerLink, PeerOptions};
use crate::relay::{Action, RelayLink};
use crate::store::{Cursors, StoredEvent};

/// What a host asks of a running link.
#[derive(Debug, Clone, PartialEq)]
#[allow(
    clippy::large_enum_variant,
    reason = "a write is the command a link carries most; boxing it would allocate per write to save bytes on the rare ones"
)]
pub enum LinkCommand {
    /// This device wrote something (the entry `Engine::mutate` returned).
    Write(StoredEvent),
    Presence(Vec<u8>),
    Grants(Vec<Vec<u8>>),
    /// A plaintext relay or session frame to seal and send — a blob get, say.
    RawFrame(Vec<u8>),
    /// A `blob-put` frame for `hash`; the link says when it could not leave.
    BlobPut {
        hash: String,
        frame: Vec<u8>,
    },
    /// Something folded from another source; push what the relay lacks and report our cursors.
    RemoteFold,
    Resync,
    Wake,
    Stop,
}

/// A fact the link established, in the order it did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkEvent {
    Online(bool),
    CaughtUp,
    Folded(FoldBatch),
    Presence(Vec<u8>),
    Grant(Vec<u8>),
    GrantRequest {
        peer_id: PeerId,
        invite: Option<String>,
    },
    BlobAnswer {
        hash: String,
        bytes: Option<Vec<u8>>,
    },
    BlobPutAnswer {
        hash: String,
        refusal: Option<PutRefusal>,
    },
    BlobPutUnsent {
        hash: String,
    },
    PeerHeard(PeerId),
    Dropped(String),
    /// The room refused the join with `retention`; the link holds off below this floor (gaps U37).
    BelowFloor(Cursors),
    /// The relay's floor issue is over.
    FloorCleared,
    /// Permanent; the task ends after this.
    Refused(String),
    /// The socket ended, and why the link thinks so where it was the one to hang up.
    Closed(String),
    DialFailed(String),
}

impl LinkEvent {
    /// The facts among a link's actions; `Send`, `Close` and `Redial` are the driver's to act on.
    pub fn from_action(action: Action) -> Option<LinkEvent> {
        Some(match action {
            Action::Online(on) => LinkEvent::Online(on),
            Action::CaughtUp => LinkEvent::CaughtUp,
            Action::Folded(batch) => LinkEvent::Folded(batch),
            Action::Presence(wire) => LinkEvent::Presence(wire),
            Action::Grant(wire) => LinkEvent::Grant(wire),
            Action::GrantRequest { peer_id, invite } => LinkEvent::GrantRequest { peer_id, invite },
            Action::BlobAnswer { hash, bytes } => LinkEvent::BlobAnswer { hash, bytes },
            Action::BlobPutAnswer { hash, refusal } => LinkEvent::BlobPutAnswer { hash, refusal },
            Action::BlobPutUnsent { hash } => LinkEvent::BlobPutUnsent { hash },
            Action::PeerHeard(peer) => LinkEvent::PeerHeard(peer),
            Action::Dropped(why) => LinkEvent::Dropped(why),
            Action::BelowFloor { floor } => LinkEvent::BelowFloor(floor),
            Action::FloorCleared => LinkEvent::FloorCleared,
            Action::Refused { reason } => LinkEvent::Refused(reason),
            Action::Send(_) | Action::Close { .. } | Action::Redial { .. } => return None,
        })
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What a batch of actions asked the socket to do, once the facts have been reported.
#[derive(Default)]
struct Asked {
    send: Vec<Vec<u8>>,
    close: Option<String>,
    redial: Option<u64>,
}

async fn report(actions: Vec<Action>, events: &mpsc::Sender<LinkEvent>) -> Asked {
    let mut asked = Asked::default();
    for action in actions {
        match action {
            Action::Send(bytes) => asked.send.push(bytes),
            Action::Close { reason } => asked.close = Some(reason),
            Action::Redial { after_ms } => asked.redial = Some(after_ms),
            fact => {
                if let Some(event) = LinkEvent::from_action(fact) {
                    // a host that stopped listening has stopped caring; the link runs on
                    let _ = events.send(event).await;
                }
            }
        }
    }
    asked
}

fn apply(link: &mut RelayLink, engine: &Arc<Mutex<Engine>>, command: LinkCommand) -> Vec<Action> {
    match command {
        LinkCommand::Write(entry) => link.on_local_write(&entry),
        LinkCommand::Presence(wire) => link.send_presence(&wire),
        LinkCommand::Grants(wires) => link.send_grants(wires),
        LinkCommand::RawFrame(plain) => link.send_raw_frame(plain),
        LinkCommand::BlobPut { hash, frame } => link.send_blob_put(hash, frame),
        LinkCommand::RemoteFold => {
            let engine = engine.lock().unwrap_or_else(PoisonError::into_inner);
            link.on_remote_fold(&engine)
        }
        LinkCommand::Resync => {
            let engine = engine.lock().unwrap_or_else(PoisonError::into_inner);
            link.resync(&engine)
        }
        LinkCommand::Wake => link.wake(),
        LinkCommand::Stop => link.stop(),
    }
}

/// Runs the link until it is stopped or refused. Dials `url`, feeds every binary message to the
/// link, honours its closes and redials, ticks it at its deadline, and reports its facts.
pub async fn run_link(
    mut link: RelayLink,
    engine: Arc<Mutex<Engine>>,
    url: String,
    mut commands: mpsc::Receiver<LinkCommand>,
    events: mpsc::Sender<LinkEvent>,
) {
    // `None` waits for a command alone: the link holds off below a relay's floor (gaps U37)
    let mut wait_ms: Option<u64> = Some(0);
    loop {
        // the backoff, interruptible by a command: a stop must not wait out thirty seconds
        let sleep = tokio::time::sleep(Duration::from_millis(wait_ms.unwrap_or(0)));
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep, if wait_ms.is_some() => break,
                command = commands.recv() => {
                    let Some(command) = command else {
                        link.stop();
                        return;
                    };
                    let stopping = matches!(command, LinkCommand::Stop);
                    let asked = report(apply(&mut link, &engine, command), &events).await;
                    if stopping || link.is_stopped() || link.is_refused() {
                        return;
                    }
                    // a wake, or a fold that brought this device up to the floor it held off below
                    if asked.redial == Some(0) {
                        break;
                    }
                }
            }
        }

        let (mut socket, _) = match tokio_tungstenite::connect_async(&url).await {
            Ok(opened) => opened,
            Err(e) => {
                let _ = events.send(LinkEvent::DialFailed(e.to_string())).await;
                let asked = report(link.on_dial_failed(now_ms()), &events).await;
                match asked.redial {
                    Some(after) => {
                        wait_ms = Some(after);
                        continue;
                    }
                    None => return,
                }
            }
        };
        let asked = report(link.on_dialed(now_ms()), &events).await;
        if asked.close.is_some() {
            let _ = socket.close(None).await;
            return;
        }

        let mut stopping = false;
        let closed_for: String = loop {
            let deadline = link.next_deadline_ms();
            let until = Duration::from_millis(deadline.map_or(0, |d| (d - now_ms()).max(0)) as u64);
            let actions = tokio::select! {
                message = socket.next() => match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        let mut engine = engine.lock().unwrap_or_else(PoisonError::into_inner);
                        link.on_bytes(&mut engine, &bytes, now_ms())
                    }
                    // pings are answered by the socket itself; text is noise on a binary protocol
                    Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Text(_) | Message::Frame(_))) => Vec::new(),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break "the socket closed".to_owned(),
                },
                command = commands.recv() => match command {
                    Some(LinkCommand::Stop) | None => {
                        stopping = true;
                        link.stop()
                    }
                    Some(command) => apply(&mut link, &engine, command),
                },
                _ = tokio::time::sleep(until), if deadline.is_some() => link.on_tick(now_ms()),
            };
            let asked = report(actions, &events).await;
            let mut sent_ok = true;
            for bytes in asked.send {
                if socket.send(Message::Binary(bytes.into())).await.is_err() {
                    sent_ok = false;
                    break;
                }
            }
            if !sent_ok {
                break "the frame did not leave the relay socket".to_owned();
            }
            if let Some(reason) = asked.close {
                let _ = socket.close(None).await;
                break reason;
            }
        };
        let _ = events.send(LinkEvent::Closed(closed_for)).await;
        if stopping {
            return;
        }
        let asked = report(link.on_closed(now_ms()), &events).await;
        match asked.redial {
            Some(after) => wait_ms = Some(after),
            None if link.is_holding() => wait_ms = None,
            None => return,
        }
    }
}

/// A room behind a WebSocket listener: the server half in Rust, for a process that wants to be
/// its own relay and for the tests that need one without Bun. Every accepted socket is one
/// [`crate::room::Room`] conversation; the room speaks first, as it must (D33/D36).
///
/// Runs until the listener is dropped or the task is aborted. The room is shared behind a mutex
/// because one socket's ingest fans out to every other socket's sender.
pub async fn serve_room(listener: tokio::net::TcpListener, room: crate::room::Room) {
    use crate::room::{RoomAction, SocketId};
    type Senders =
        Arc<Mutex<std::collections::HashMap<SocketId, mpsc::UnboundedSender<Option<Vec<u8>>>>>>;
    let room = Arc::new(Mutex::new(room));
    let senders: Senders = Arc::default();

    /// Delivers a batch of room actions to their sockets; `None` closes one.
    fn deliver(actions: Vec<RoomAction>, senders: &Senders) {
        let senders = senders.lock().unwrap_or_else(PoisonError::into_inner);
        for action in actions {
            match action {
                RoomAction::Send { socket, bytes } => {
                    if let Some(tx) = senders.get(&socket) {
                        let _ = tx.send(Some(bytes));
                    }
                }
                RoomAction::Close { socket, .. } => {
                    if let Some(tx) = senders.get(&socket) {
                        let _ = tx.send(None);
                    }
                }
            }
        }
    }

    // keepalives on the room's cadence
    {
        let room = room.clone();
        let senders = senders.clone();
        let keepalive = room
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .options()
            .keepalive_ms;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(keepalive.max(50))).await;
                if Arc::strong_count(&room) == 1 {
                    return;
                }
                let actions = room
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .tick(now_ms());
                deliver(actions, &senders);
            }
        });
    }

    while let Ok((stream, _)) = listener.accept().await {
        let Ok(socket) = tokio_tungstenite::accept_async(stream).await else {
            continue;
        };
        let (mut sink, mut source) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
        let (id, first) = room
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .connect(now_ms());
        senders
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, tx);
        deliver(first, &senders);
        let room = room.clone();
        let senders = senders.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    out = rx.recv() => match out {
                        Some(Some(bytes)) => {
                            if sink.send(Message::Binary(bytes.into())).await.is_err() { break; }
                        }
                        Some(None) | None => {
                            let _ = sink.close().await;
                            break;
                        }
                    },
                    message = source.next() => match message {
                        Some(Ok(Message::Binary(bytes))) => {
                            let actions = room.lock().unwrap_or_else(PoisonError::into_inner).receive(id, &bytes, now_ms());
                            deliver(actions, &senders);
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Text(_) | Message::Frame(_))) => {}
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    },
                }
            }
            senders
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&id);
            room.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .closed(id);
        });
    }
}

// --- peer links -------------------------------------------------------------------------------

/// A byte duplex a [`PeerLink`] runs over: a TCP socket, a Wi-Fi Aware data path, a WebSocket, a
/// BLE characteristic's writes and notifications. [`StreamMedium`] adapts anything that is
/// `AsyncRead + AsyncWrite`; [`MessageMedium`] anything that is a `Stream` and a `Sink` of whole
/// messages. A medium of another shape implements this directly.
///
/// `write` must fail when the bytes did not leave: a loud failure ends the link and the next one
/// resyncs from the cursors, a silent one leaves two devices believing different things.
pub trait PeerMedium: Send {
    /// The next read, or `None` once the medium has closed. Must be cancel-safe: the driver drops
    /// a pending read when a command or a deadline comes first.
    fn read(&mut self) -> impl std::future::Future<Output = Option<Vec<u8>>> + Send;
    fn write(
        &mut self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = std::io::Result<()>> + Send;
    fn close(&mut self) -> impl std::future::Future<Output = ()> + Send;
}

/// A medium that streams bytes with no boundaries; pair it with [`crate::peer::Framing::Stream`].
#[derive(Debug)]
pub struct StreamMedium<S> {
    inner: S,
    buffer: Vec<u8>,
}

impl<S> StreamMedium<S> {
    pub fn new(inner: S) -> StreamMedium<S> {
        StreamMedium {
            inner,
            buffer: vec![0; 64 * 1024],
        }
    }
}

impl<S> PeerMedium for StreamMedium<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    async fn read(&mut self) -> Option<Vec<u8>> {
        use tokio::io::AsyncReadExt;
        match self.inner.read(&mut self.buffer).await {
            Ok(0) | Err(_) => None,
            Ok(n) => Some(self.buffer[..n].to_vec()),
        }
    }

    async fn write(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt;
        self.inner.write_all(&bytes).await?;
        self.inner.flush().await
    }

    async fn close(&mut self) {
        use tokio::io::AsyncWriteExt;
        let _ = self.inner.shutdown().await;
    }
}

/// A medium that keeps message boundaries; pair it with [`crate::peer::Framing::Messages`], or
/// [`crate::peer::Framing::Fragments`] when each message is one BLE write.
#[derive(Debug)]
pub struct MessageMedium<T> {
    inner: T,
}

impl<T> MessageMedium<T> {
    pub fn new(inner: T) -> MessageMedium<T> {
        MessageMedium { inner }
    }
}

impl<T, E> PeerMedium for MessageMedium<T>
where
    T: futures_util::Stream<Item = Result<Vec<u8>, E>>
        + futures_util::Sink<Vec<u8>, Error = E>
        + Unpin
        + Send,
    E: std::fmt::Display + Send,
{
    async fn read(&mut self) -> Option<Vec<u8>> {
        self.inner.next().await?.ok()
    }

    async fn write(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        self.inner
            .send(bytes)
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))
    }

    async fn close(&mut self) {
        let _ = self.inner.close().await;
    }
}

/// What a host asks of a running peer link.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
#[allow(
    clippy::large_enum_variant,
    reason = "a write is the command a link carries most; boxing it would allocate per write"
)]
pub enum PeerCommand {
    /// This device wrote something (the entry `Engine::mutate` returned).
    Write(StoredEvent),
    Presence(Vec<u8>),
    Grants(Vec<Vec<u8>>),
    RequestGrant(Option<String>),
    /// Ask for state rather than history (RFC-0019).
    RequestSnapshot {
        interest: Option<crate::interest::Interest>,
        adopt_unvouched: bool,
    },
    /// Consent to install unvouched state from this peer up to its floor (D46).
    AcceptFloor,
    /// Something folded from another source; tell the peer where this device stands now.
    RemoteFold,
    Resync,
    Close,
}

fn apply_peer(
    link: &mut PeerLink,
    engine: &Arc<Mutex<Engine>>,
    command: PeerCommand,
) -> Vec<PeerAction> {
    let engine = || engine.lock().unwrap_or_else(PoisonError::into_inner);
    match command {
        PeerCommand::Write(entry) => link.on_local_write(&entry),
        PeerCommand::Presence(wire) => link.send_presence(&wire),
        PeerCommand::Grants(wires) => link.send_grants(&wires),
        PeerCommand::RequestGrant(invite) => link.request_grant(invite.as_deref()),
        PeerCommand::RequestSnapshot {
            interest,
            adopt_unvouched,
        } => link.request_snapshot(interest.as_ref(), adopt_unvouched).1,
        PeerCommand::AcceptFloor => link.accept_floor(&engine()).1,
        PeerCommand::RemoteFold => link.on_remote_fold(&engine()),
        PeerCommand::Resync => link.resync(&engine()),
        PeerCommand::Close => link.close(),
    }
}

/// Runs one peer link over `medium` until either end closes it. Sends our hello at once — both
/// ends speak first — feeds every read to the link, ticks it at its deadline, writes what it asks,
/// and reports its facts on `events`, the last of which is [`PeerAction::Ended`].
pub async fn run_peer<M: PeerMedium>(
    identity: syncmesh_core::identity::Identity,
    options: PeerOptions,
    engine: Arc<Mutex<Engine>>,
    mut medium: M,
    mut commands: mpsc::Receiver<PeerCommand>,
    events: mpsc::Sender<PeerAction>,
) {
    let (mut link, first) = PeerLink::open(identity, options, now_ms());
    let mut actions = first;
    let reason = loop {
        let mut close = None;
        for action in actions {
            match action {
                PeerAction::Send(bytes) => {
                    if close.is_none() && medium.write(bytes).await.is_err() {
                        close = Some("the frame did not leave the medium".to_owned());
                    }
                }
                PeerAction::SendLatest { units, .. } => {
                    for bytes in units {
                        if close.is_none() && medium.write(bytes).await.is_err() {
                            close = Some("the frame did not leave the medium".to_owned());
                        }
                    }
                }
                PeerAction::Close { reason } => close = close.or(Some(reason)),
                fact => {
                    // a host that stopped listening has stopped caring; the link runs on
                    let _ = events.send(fact).await;
                }
            }
        }
        if let Some(reason) = close {
            medium.close().await;
            break reason;
        }
        let deadline = link.next_deadline_ms();
        let until = Duration::from_millis(deadline.map_or(0, |d| (d - now_ms()).max(0)) as u64);
        actions = tokio::select! {
            read = medium.read() => match read {
                Some(bytes) => {
                    let mut engine = engine.lock().unwrap_or_else(PoisonError::into_inner);
                    link.on_bytes(&mut engine, &bytes, now_ms())
                }
                None => break "the medium closed".to_owned(),
            },
            command = commands.recv() => match command {
                Some(command) => apply_peer(&mut link, &engine, command),
                None => link.close(),
            },
            _ = tokio::time::sleep(until), if deadline.is_some() => {
                let engine = engine.lock().unwrap_or_else(PoisonError::into_inner);
                link.on_tick(&engine, now_ms())
            }
        };
    };
    for fact in link.on_closed(&reason) {
        let _ = events.send(fact).await;
    }
}
