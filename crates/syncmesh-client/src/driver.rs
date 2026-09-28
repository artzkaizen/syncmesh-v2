//! The one piece of IO in this crate: a tokio task that dials a relay over a WebSocket and runs a
//! [`RelayLink`] against it. Everything the link decides, it decides sans-IO; this loop only
//! moves bytes, sleeps when told to, and turns the link's facts into [`LinkEvent`]s on a channel.
//!
//! The host talks to the running link through [`LinkCommand`]s and keeps the engine behind a
//! mutex it shares with the task, so a write made on the host's own thread and the fold of a
//! relayed event never interleave inside the engine.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use syncmesh_core::event::PeerId;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::engine::{Engine, FoldBatch};
use crate::relay::{Action, RelayLink};
use crate::store::StoredEvent;

/// What a host asks of a running link.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkCommand {
    /// This device wrote something (the entry `Engine::mutate` returned).
    Write(StoredEvent),
    Presence(Vec<u8>),
    Grants(Vec<Vec<u8>>),
    /// A plaintext relay or session frame to seal and send — a blob put or get, say.
    RawFrame(Vec<u8>),
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
    PeerHeard(PeerId),
    Dropped(String),
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
            Action::PeerHeard(peer) => LinkEvent::PeerHeard(peer),
            Action::Dropped(why) => LinkEvent::Dropped(why),
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
    let mut wait_ms: u64 = 0;
    loop {
        // the backoff, interruptible by a command: a stop must not wait out thirty seconds
        let sleep = tokio::time::sleep(Duration::from_millis(wait_ms));
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                command = commands.recv() => {
                    let Some(command) = command else {
                        link.stop();
                        return;
                    };
                    let woken = matches!(command, LinkCommand::Wake);
                    let stopping = matches!(command, LinkCommand::Stop);
                    let asked = report(apply(&mut link, &engine, command), &events).await;
                    if stopping || link.is_stopped() || link.is_refused() {
                        return;
                    }
                    if woken && asked.redial == Some(0) {
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
                        wait_ms = after;
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
            Some(after) => wait_ms = after,
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
