//! One device, assembled: the engine behind a mutex, the relay link running on the tokio driver,
//! the ephemeral tier, the grant registry and blobs — the object an application holds.
//!
//! The pieces below are sans-IO and each is tested on its own; this file is only where they meet
//! the runtime. A host calls [`Mesh::mutate`] on its own thread and reads [`Mesh::events`] for
//! what the room did; nothing here is exposed that a test could not also drive through the room
//! server in `driver::serve_room`, which is how `tests/mesh.rs` proves it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use syncmesh_core::event::{Change, PartitionKey, PeerId};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::Row;
use syncmesh_core::relay_frames::{blob_get_frame, blob_put_frame};
use tokio::sync::{mpsc, oneshot};

use crate::blobs::{BlobError, BlobStore, MemoryBlobStore, hash_of, verify_blob};
use crate::driver::{LinkCommand, LinkEvent, run_link};
use crate::engine::{Engine, EngineOptions, FoldBatch, MutateError, Mutated};
use crate::grants::GrantRegistry;
use crate::presence::{PresenceEntry, PresenceTier, PresenceTouch};
use crate::random;
use crate::relay::{RelayLink, RelayOptions};
use crate::store::{EventStore, StateStore, StoreError};

pub struct MeshOptions {
    pub identity: Identity,
    /// `ws://host:port/<room>`.
    pub url: String,
    pub relay: RelayOptions,
    pub engine: EngineOptions,
    pub store: Box<dyn EventStore + Send>,
    pub state_store: Option<Box<dyn StateStore + Send>>,
    /// This device's blob cache; memory when absent.
    pub blob_store: Option<Box<dyn BlobStore + Send>>,
    /// Whose grants to believe; this device's own key when absent (a mesh with no authority).
    pub issuer: Option<PeerId>,
}

/// What the room did, as the application sees it. Every variant is a fact already applied to the
/// engine, the tier or the registry; a reader that only wants rows can watch `Folded` alone.
#[derive(Debug, Clone, PartialEq)]
pub enum MeshEvent {
    Online(bool),
    CaughtUp,
    Folded(FoldBatch),
    /// Someone's presence changed at this topic and instance (arrived, moved, left, expired).
    Presence(PresenceTouch),
    GrantRequest {
        peer_id: PeerId,
        invite: Option<String>,
    },
    PeerHeard(PeerId),
    Dropped(String),
    /// The link is over for good: a refusal, or `stop`.
    Ended(String),
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

type Waiters = Arc<Mutex<HashMap<String, Vec<oneshot::Sender<Option<Vec<u8>>>>>>>;

pub struct Mesh {
    identity: Identity,
    engine: Arc<Mutex<Engine>>,
    presence: Arc<Mutex<PresenceTier>>,
    grants: Arc<Mutex<GrantRegistry>>,
    blobs: Arc<Mutex<Box<dyn BlobStore + Send>>>,
    waiters: Waiters,
    commands: mpsc::Sender<LinkCommand>,
    events: mpsc::Receiver<MeshEvent>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Mesh {
    /// Opens the engine over its stores and starts the link on `handle`. Returns once the engine
    /// has booted; the link dials in the background and says `Online(true)` when it is up.
    pub fn open(options: MeshOptions, handle: &tokio::runtime::Handle) -> Result<Mesh, StoreError> {
        let MeshOptions {
            identity,
            url,
            relay,
            engine,
            store,
            state_store,
            blob_store,
            issuer,
        } = options;
        let engine = Arc::new(Mutex::new(Engine::open(
            identity.clone(),
            store,
            state_store,
            engine,
        )?));
        let presence = Arc::new(Mutex::new(PresenceTier::new(
            identity.clone(),
            random::session_id(),
        )));
        let grants = Arc::new(Mutex::new(GrantRegistry::new(
            issuer.unwrap_or_else(|| identity.peer_id().clone()),
        )));
        let blobs: Arc<Mutex<Box<dyn BlobStore + Send>>> = Arc::new(Mutex::new(
            blob_store.unwrap_or_else(|| Box::new(MemoryBlobStore::new())),
        ));
        let waiters: Waiters = Arc::default();
        let (commands, command_rx) = mpsc::channel(256);
        let (link_tx, link_rx) = mpsc::channel(256);
        let (event_tx, events) = mpsc::channel(256);
        let link = RelayLink::new(identity.clone(), relay);
        let tasks = vec![
            handle.spawn(run_link(link, engine.clone(), url, command_rx, link_tx)),
            handle.spawn(pump(
                link_rx,
                event_tx,
                presence.clone(),
                grants.clone(),
                blobs.clone(),
                waiters.clone(),
                commands.clone(),
            )),
            handle.spawn(heartbeat(presence.clone(), commands.clone())),
        ];
        Ok(Mesh {
            identity,
            engine,
            presence,
            grants,
            blobs,
            waiters,
            commands,
            events,
            tasks,
        })
    }

    pub fn peer_id(&self) -> &PeerId {
        self.identity.peer_id()
    }

    /// The engine, for reads. Hold the guard briefly: the link folds under the same lock.
    pub fn engine(&self) -> MutexGuard<'_, Engine> {
        lock(&self.engine)
    }

    /// One write: appended and folded here, then handed to the link. Real once this returns.
    pub fn mutate(
        &self,
        procedure: &str,
        changes: Vec<Change>,
        partition: Option<PartitionKey>,
    ) -> Result<Mutated, MutateError> {
        let mutated = lock(&self.engine).mutate(procedure, changes, partition)?;
        // a link that is gone drops the write on the floor here; the log still holds it and the
        // next session's push after catch-up sends it
        let _ = self
            .commands
            .try_send(LinkCommand::Write(mutated.entry.clone()));
        Ok(mutated)
    }

    /// Publishes this device's value at a topic; conflated at every hop, never queued.
    pub fn presence_set(&self, topic: &str, partition: &PartitionKey, value: Row, ttl_ms: i64) {
        let wire = lock(&self.presence).set(topic, partition, value, ttl_ms, now_ms());
        let _ = self.commands.try_send(LinkCommand::Presence(wire));
    }

    /// An explicit departure from a topic.
    pub fn presence_clear(&self, topic: &str, partition: &PartitionKey) {
        let wire = lock(&self.presence).clear(topic, partition, now_ms());
        let _ = self.commands.try_send(LinkCommand::Presence(wire));
    }

    /// Everyone at a topic right now, this device included once it has set a value.
    pub fn presence_peers(&self, topic: &str, partition: &PartitionKey) -> Vec<PresenceEntry> {
        lock(&self.presence)
            .peers(topic, partition, now_ms())
            .into_iter()
            .cloned()
            .collect()
    }

    pub fn grants(&self) -> MutexGuard<'_, GrantRegistry> {
        lock(&self.grants)
    }

    /// Stores the bytes here under their hash and offers them to the room (D18). Put first,
    /// write the row that names the hash second.
    pub fn blob_put(&self, bytes: &[u8]) -> Result<String, BlobError> {
        let hash = lock(&self.blobs).put(bytes)?;
        let _ = self
            .commands
            .try_send(LinkCommand::RawFrame(blob_put_frame(&hash, bytes)));
        Ok(hash)
    }

    /// Whether this device already holds the bytes, without asking anyone.
    pub fn blob_has(&self, hash: &str) -> bool {
        lock(&self.blobs).has(hash)
    }

    /// The bytes behind a hash: this device's cache first, then the room; verified on arrival.
    pub async fn blob_fetch(&self, hash: &str, timeout: Duration) -> Result<Vec<u8>, BlobError> {
        if let Ok(bytes) = lock(&self.blobs).get(hash) {
            return Ok(bytes);
        }
        let (tx, rx) = oneshot::channel();
        lock(&self.waiters)
            .entry(hash.to_owned())
            .or_default()
            .push(tx);
        let _ = self
            .commands
            .try_send(LinkCommand::RawFrame(blob_get_frame(hash)));
        let answer = tokio::time::timeout(timeout, rx).await;
        match answer {
            Ok(Ok(Some(bytes))) => {
                verify_blob(hash, &bytes)?;
                let _ = lock(&self.blobs).put_at(hash, &bytes);
                Ok(bytes)
            }
            Ok(Ok(None)) => Err(BlobError::NotFound {
                hash: hash.to_owned(),
            }),
            _ => {
                lock(&self.waiters).remove(hash);
                Err(BlobError::Timeout {
                    hash: hash.to_owned(),
                })
            }
        }
    }

    /// The room's facts, in order. `None` once the link has ended and the pump has drained.
    pub async fn next_event(&mut self) -> Option<MeshEvent> {
        self.events.recv().await
    }

    /// Whatever has arrived without waiting.
    pub fn poll_events(&mut self) -> Vec<MeshEvent> {
        let mut out = Vec::new();
        while let Ok(e) = self.events.try_recv() {
            out.push(e);
        }
        out
    }

    /// Ask the link to redial now (the network moved).
    pub fn wake(&self) {
        let _ = self.commands.try_send(LinkCommand::Wake);
    }

    /// Departs every presence topic, stops the link, and waits for the tasks to end.
    pub async fn stop(mut self) {
        let departures = lock(&self.presence).stop(now_ms());
        for wire in departures {
            let _ = self.commands.send(LinkCommand::Presence(wire)).await;
        }
        let _ = self.commands.send(LinkCommand::Stop).await;
        for task in self.tasks.drain(..) {
            let _ = task.await;
        }
    }
}

/// Link facts to mesh events: presence into the tier, grants into the registry, blob answers to
/// their waiters, everything else forwarded.
async fn pump(
    mut link: mpsc::Receiver<LinkEvent>,
    events: mpsc::Sender<MeshEvent>,
    presence: Arc<Mutex<PresenceTier>>,
    grants: Arc<Mutex<GrantRegistry>>,
    blobs: Arc<Mutex<Box<dyn BlobStore + Send>>>,
    waiters: Waiters,
    commands: mpsc::Sender<LinkCommand>,
) {
    while let Some(fact) = link.recv().await {
        let out = match fact {
            LinkEvent::Online(on) => {
                if on {
                    // a fresh socket knows nothing about us: re-announce our presence and grants
                    let wires: Vec<Vec<u8>> = {
                        let mut tier = lock(&presence);
                        tier.announce_all(now_ms())
                    };
                    for wire in wires {
                        let _ = commands.send(LinkCommand::Presence(wire)).await;
                    }
                    let held = lock(&grants).all_wires();
                    if !held.is_empty() {
                        let _ = commands.send(LinkCommand::Grants(held)).await;
                    }
                }
                vec![MeshEvent::Online(on)]
            }
            LinkEvent::CaughtUp => vec![MeshEvent::CaughtUp],
            LinkEvent::Folded(batch) => vec![MeshEvent::Folded(batch)],
            LinkEvent::Presence(wire) => {
                let mut tier = lock(&presence);
                tier.receive(&wire, now_ms());
                tier.take_touched()
                    .into_iter()
                    .map(MeshEvent::Presence)
                    .collect()
            }
            LinkEvent::Grant(wire) => {
                let _ = lock(&grants).register(&wire, now_ms());
                Vec::new()
            }
            LinkEvent::GrantRequest { peer_id, invite } => {
                vec![MeshEvent::GrantRequest { peer_id, invite }]
            }
            LinkEvent::BlobAnswer { hash, bytes } => {
                let bytes = bytes.filter(|b| verify_blob(&hash, b).is_ok());
                if let Some(b) = &bytes {
                    let _ = lock(&blobs).put_at(&hash, b);
                }
                if let Some(list) = lock(&waiters).remove(&hash) {
                    for tx in list {
                        let _ = tx.send(bytes.clone());
                    }
                }
                Vec::new()
            }
            LinkEvent::PeerHeard(peer) => vec![MeshEvent::PeerHeard(peer)],
            LinkEvent::Dropped(why) => vec![MeshEvent::Dropped(why)],
            LinkEvent::Refused(why) => vec![MeshEvent::Ended(why)],
            LinkEvent::Closed(_) | LinkEvent::DialFailed(_) => Vec::new(),
        };
        for event in out {
            if events.send(event).await.is_err() {
                return;
            }
        }
    }
    let _ = events.send(MeshEvent::Ended("stopped".to_owned())).await;
}

/// Re-signs every live value at a third of its TTL, as the TypeScript's interval does.
async fn heartbeat(presence: Arc<Mutex<PresenceTier>>, commands: mpsc::Sender<LinkCommand>) {
    loop {
        let (due, next) = {
            let mut tier = lock(&presence);
            let now = now_ms();
            (tier.heartbeats_due(now), tier.next_heartbeat_ms())
        };
        for wire in due {
            if commands.send(LinkCommand::Presence(wire)).await.is_err() {
                return;
            }
        }
        let wait = next
            .map(|at| (at - now_ms()).clamp(50, 60_000) as u64)
            .unwrap_or(1_000);
        tokio::time::sleep(Duration::from_millis(wait)).await;
        if commands.is_closed() {
            return;
        }
    }
}

/// The sha-256 hex a row names for some bytes — re-exported so a caller can write the row
/// before the put has left.
pub fn blob_hash(bytes: &[u8]) -> String {
    hash_of(bytes)
}

#[cfg(test)]
mod tests {
    use syncmesh_core::record::CellValue;

    use super::*;
    use crate::presence::decode_and_verify_presence;

    #[tokio::test]
    async fn announce_on_link_return_uses_the_clock() {
        let identity = Identity::from_seed(&[5; 32]);
        let partition = PartitionKey::parse("project:demo").unwrap();
        let mut tier = PresenceTier::new(identity.clone(), "s-offline".to_owned());
        let mut cursor = Row::new();
        cursor.insert("x".to_owned(), CellValue::Number(1.0));
        // set while offline: the wire this returns has nowhere to go and is dropped
        let _ = tier.set("cursor", &partition, cursor, 10_000, now_ms());
        let presence = Arc::new(Mutex::new(tier));

        let (link_tx, link_rx) = mpsc::channel(8);
        let (event_tx, mut events) = mpsc::channel(8);
        let (commands, mut sent) = mpsc::channel(8);
        let blobs: Arc<Mutex<Box<dyn BlobStore + Send>>> =
            Arc::new(Mutex::new(Box::new(MemoryBlobStore::new())));
        let pumping = tokio::spawn(pump(
            link_rx,
            event_tx,
            presence.clone(),
            Arc::new(Mutex::new(GrantRegistry::new(identity.peer_id().clone()))),
            blobs,
            Waiters::default(),
            commands,
        ));

        let before = now_ms();
        link_tx.send(LinkEvent::Online(true)).await.unwrap();
        assert_eq!(events.recv().await, Some(MeshEvent::Online(true)));
        let after = now_ms();
        let Some(LinkCommand::Presence(wire)) = sent.recv().await else {
            panic!("the link came up and nothing was re-announced");
        };
        let announced = decode_and_verify_presence(&wire).unwrap().presence;
        assert!(
            (before + 10_000..=after + 10_000).contains(&announced.expires_ms),
            "expiry {} is not now + ttl",
            announced.expires_ms
        );
        let next = lock(&presence).next_heartbeat_ms().unwrap();
        assert!(
            (before..=after + 10_000).contains(&next),
            "the heartbeat clock restarted at the real now, not {next}"
        );

        drop(link_tx);
        pumping.await.unwrap();
    }
}
