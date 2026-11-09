//! One device, assembled: the engine behind a mutex, the relay link running on the tokio driver,
//! the peer links a host attaches beside it ([`Mesh::attach_peer`]), the ephemeral tier, the grant
//! registry and blobs — the object an application holds.
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
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, oneshot};

use crate::blobs::{
    BLOB_ANSWER_WAIT, BlobError, BlobStore, MemoryBlobStore, PutRefusal, hash_of, verify_blob,
};
use crate::driver::{LinkCommand, LinkEvent, PeerCommand, PeerMedium, run_link, run_peer};
use crate::engine::{
    Engine, EngineOptions, FoldBatch, MutateError, Mutated, RevertError, Reverted,
};
use crate::grants::GrantRegistry;
use crate::join::JoinOutcome;
use crate::peer::{PeerAction, PeerOptions};
use crate::presence::{PresenceEntry, PresenceTier, PresenceTouch};
use crate::random;
use crate::rejoin::{BelowFloor, Rejoins};
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
    /// With `engine.validator` set and its `grants` left `None`, it also decides the validator's
    /// mode: granted, over this mesh's registry, when an issuer is given; ungranted otherwise. A
    /// `grants` source the caller supplied is kept, and learns nothing from the link.
    pub issuer: Option<PeerId>,
}

/// What the room did, as the application sees it. Every variant is a fact already applied to the
/// engine, the tier or the registry; a reader that only wants rows can watch `Folded` alone.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum MeshEvent {
    Online(bool),
    CaughtUp,
    Folded(FoldBatch),
    /// Someone's presence changed at this topic and instance (arrived, moved, left, expired).
    Presence(PresenceTouch),
    /// A device asked the relay's room for a grant. One asked over a peer link arrives as
    /// [`MeshEvent::Peer`], so the answer can go back down that link ([`PeerHandle::send`]).
    GrantRequest {
        peer_id: PeerId,
        invite: Option<String>,
    },
    PeerHeard(PeerId),
    Dropped(String),
    /// The issues [`Mesh::below_floor`] lists changed: a relay refused this device below its floor
    /// (gaps U37), a peer link found it below the peer's floor (D46, answered with
    /// [`PeerCommand::AcceptFloor`] through that link's [`PeerHandle`]), a join a peer link asked
    /// for settled, or one of those is over.
    Recovery,
    /// The link is over for good: a refusal, or `stop`.
    Ended(String),
    /// A fact from a peer link [`Mesh::attach_peer`] runs, under the id its [`PeerHandle`] holds
    /// and the name its options gave it: established, superseded, refused, a grant request, a
    /// receipt or a refusal of this device's write, a divergence, a join that settled, bytes
    /// dropped, the link ended. Its folds and presence arrive as [`MeshEvent::Folded`] and
    /// [`MeshEvent::Presence`] like the relay's.
    Peer {
        link: PeerLinkId,
        name: String,
        fact: PeerAction,
    },
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

/// One put waiting on its answer: the partition its bytes are billed to, and where to say it.
struct Upload {
    partition: Option<PartitionKey>,
    settle: oneshot::Sender<Option<PutRefusal>>,
}

/// Puts in flight, by hash: a `blob-stored` settles every one, a refusal only those billed to the
/// partition it names.
type Uploads = Arc<Mutex<HashMap<String, Vec<Upload>>>>;

/// One peer link a mesh runs, unique within it: two links attached under the same name are still
/// two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PeerLinkId(u64);

impl std::fmt::Display for PeerLinkId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "peer-link-{}", self.0)
    }
}

/// A peer link [`Mesh::attach_peer`] runs: the id its [`MeshEvent::Peer`] facts carry, and where
/// a [`PeerCommand`] reaches it — accept a floor (D46), ask for state or a grant, send grants,
/// resync, close it.
///
/// ```ignore
/// let link = mesh.attach_peer(StreamMedium::new(socket), PeerOptions::default(), &handle);
/// link.try_send(PeerCommand::AcceptFloor)?;
/// ```
#[derive(Debug, Clone)]
pub struct PeerHandle {
    id: PeerLinkId,
    name: String,
    commands: mpsc::Sender<PeerCommand>,
}

impl PeerHandle {
    pub fn id(&self) -> PeerLinkId {
        self.id
    }

    /// The name its options gave it.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Hands `command` to the link once its queue has room.
    pub async fn send(&self, command: PeerCommand) -> Result<(), PeerSendError> {
        self.commands
            .send(command)
            .await
            .map_err(|_| PeerSendError::Ended)
    }

    /// Hands `command` to the link now.
    pub fn try_send(&self, command: PeerCommand) -> Result<(), PeerSendError> {
        self.commands.try_send(command).map_err(|e| match e {
            TrySendError::Full(_) => PeerSendError::Full,
            TrySendError::Closed(_) => PeerSendError::Ended,
        })
    }

    /// Whether the link has ended.
    pub fn is_closed(&self) -> bool {
        self.commands.is_closed()
    }
}

/// Why a [`PeerHandle`] could not hand a command on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum PeerSendError {
    /// The link's queue is full; [`PeerHandle::send`] waits for room instead.
    Full,
    /// The link has ended.
    Ended,
}

impl std::fmt::Display for PeerSendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PeerSendError::Full => "the peer link's command queue is full",
            PeerSendError::Ended => "the peer link has ended",
        })
    }
}

impl std::error::Error for PeerSendError {}

/// Every running peer link, by id, and where its commands go.
type Links = Arc<Mutex<Vec<(PeerLinkId, mpsc::Sender<PeerCommand>)>>>;

/// The peer links running beside the relay link: where a write, a presence value or a fold
/// elsewhere is handed on, and where a command one could not take is said.
#[derive(Clone)]
struct Peers {
    links: Links,
    said: mpsc::Sender<MeshEvent>,
}

impl Peers {
    fn new(said: mpsc::Sender<MeshEvent>) -> Peers {
        Peers {
            links: Arc::default(),
            said,
        }
    }

    /// Hands `command` to every running peer link but `except`, forgetting the ones that have
    /// ended. A link whose queue is full loses it, said as [`MeshEvent::Dropped`]; its next cursor
    /// exchange carries what the command would have.
    fn hand(&self, except: Option<PeerLinkId>, command: &PeerCommand) {
        let mut full = Vec::new();
        lock(&self.links).retain(|(id, tx)| {
            if Some(*id) != except
                && let Err(TrySendError::Full(_)) = tx.try_send(command.clone())
            {
                full.push(*id);
            }
            !tx.is_closed()
        });
        for id in full {
            let _ = self.said.try_send(MeshEvent::Dropped(format!(
                "{id} had no room for a command; its next cursor exchange carries it"
            )));
        }
    }

    /// Every running link's sender, the list emptied: what [`Mesh::stop`] closes.
    fn take(&self) -> Vec<mpsc::Sender<PeerCommand>> {
        lock(&self.links).drain(..).map(|(_, tx)| tx).collect()
    }
}

/// Everyone waiting on a blob answer from the room: fetches, and puts.
#[derive(Clone, Default)]
struct BlobWaits {
    fetches: Waiters,
    uploads: Uploads,
}

/// Settles the uploads of `hash` that this answer is for, and keeps the rest waiting.
fn settle_uploads(uploads: &Uploads, hash: &str, refusal: Option<PutRefusal>) {
    let mut held = lock(uploads);
    let Some(waits) = held.remove(hash) else {
        return;
    };
    let (answered, rest): (Vec<Upload>, Vec<Upload>) = waits.into_iter().partition(|upload| {
        refusal
            .as_ref()
            .is_none_or(|r| r.partition() == upload.partition.as_ref())
    });
    if !rest.is_empty() {
        held.insert(hash.to_owned(), rest);
    }
    drop(held);
    for upload in answered {
        let _ = upload.settle.send(refusal.clone());
    }
}

pub struct Mesh {
    identity: Identity,
    engine: Arc<Mutex<Engine>>,
    presence: Arc<Mutex<PresenceTier>>,
    grants: Arc<Mutex<GrantRegistry>>,
    blobs: Arc<Mutex<Box<dyn BlobStore + Send>>>,
    waits: BlobWaits,
    rejoins: Arc<Mutex<Rejoins>>,
    commands: mpsc::Sender<LinkCommand>,
    events: mpsc::Receiver<MeshEvent>,
    /// Where a peer link's facts join the relay's.
    event_tx: mpsc::Sender<MeshEvent>,
    peers: Peers,
    /// The id the next attached peer link takes.
    next_peer: u64,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    peer_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Mesh {
    /// Opens the engine over its stores and starts the link on `handle`. Returns once the engine
    /// has booted; the link dials in the background and says `Online(true)` when it is up.
    pub fn open(options: MeshOptions, handle: &tokio::runtime::Handle) -> Result<Mesh, StoreError> {
        let MeshOptions {
            identity,
            url,
            relay,
            mut engine,
            store,
            state_store,
            blob_store,
            issuer,
        } = options;
        let grants = Arc::new(Mutex::new(GrantRegistry::new(
            issuer.clone().unwrap_or_else(|| identity.peer_id().clone()),
        )));
        if let Some(validator) = engine.validator.as_mut()
            && validator.grants.is_none()
            && issuer.is_some()
        {
            // granted when an issuer is configured, as the TypeScript client decides: the
            // validator reads the registry the link fills as grants arrive. A source the caller
            // supplied is kept as given.
            validator.grants = Some(Box::new(grants.clone()));
        }
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
        let blobs: Arc<Mutex<Box<dyn BlobStore + Send>>> = Arc::new(Mutex::new(
            blob_store.unwrap_or_else(|| Box::new(MemoryBlobStore::new())),
        ));
        let waits = BlobWaits::default();
        let rejoins = Arc::new(Mutex::new(Rejoins::new()));
        let (commands, command_rx) = mpsc::channel(256);
        let (link_tx, link_rx) = mpsc::channel(256);
        let (event_tx, events) = mpsc::channel(256);
        let peers = Peers::new(event_tx.clone());
        let link = RelayLink::new(identity.clone(), relay).with_grants(grants.clone());
        let relay_name = link.name().to_owned();
        let tasks = vec![
            handle.spawn(run_link(link, engine.clone(), url, command_rx, link_tx)),
            handle.spawn(pump(
                link_rx,
                event_tx.clone(),
                Pumped {
                    presence: presence.clone(),
                    grants: grants.clone(),
                    blobs: blobs.clone(),
                    waits: waits.clone(),
                    rejoins: rejoins.clone(),
                    relay: relay_name,
                    peers: peers.clone(),
                },
                commands.clone(),
            )),
            handle.spawn(heartbeat(presence.clone(), commands.clone(), peers.clone())),
        ];
        Ok(Mesh {
            identity,
            engine,
            presence,
            grants,
            blobs,
            waits,
            rejoins,
            commands,
            events,
            event_tx,
            peers,
            next_peer: 0,
            tasks,
            peer_tasks: Vec::new(),
        })
    }

    /// Runs a peer link over `medium` beside the relay link (gap U3's radios): a socket, a Wi-Fi
    /// Aware data path, a BLE characteristic — whatever reached another device directly. Its
    /// session registers grants in this mesh's registry and records floors in this mesh's
    /// [`Mesh::rejoins`] unless `options` names its own. Every write, presence value and fold from
    /// elsewhere is handed to it as to the relay, and what it folds is handed to the relay and to
    /// every other peer link; its facts arrive as [`MeshEvent::Peer`] under the returned handle's
    /// id, which is unique even when two links share a name. Grants cross a peer link at its open
    /// and when sent through the handle; the mesh forwards none between links. The link ends when
    /// either end closes it, or at [`Mesh::stop`].
    ///
    /// ```ignore
    /// let socket = tokio::net::TcpStream::connect(addr).await?;
    /// let link = mesh.attach_peer(StreamMedium::new(socket), PeerOptions::default(), &handle);
    /// ```
    pub fn attach_peer<M: PeerMedium + 'static>(
        &mut self,
        medium: M,
        mut options: PeerOptions,
        handle: &tokio::runtime::Handle,
    ) -> PeerHandle {
        let id = PeerLinkId(self.next_peer);
        self.next_peer += 1;
        let name = options.name.clone();
        options
            .session
            .grants
            .get_or_insert_with(|| self.grants.clone());
        options
            .session
            .rejoins
            .get_or_insert_with(|| self.rejoins.clone());
        let (commands, command_rx) = mpsc::channel(256);
        let (fact_tx, facts) = mpsc::channel(256);
        lock(&self.peers.links).push((id, commands.clone()));
        self.peer_tasks.push(handle.spawn(run_peer(
            self.identity.clone(),
            options,
            self.engine.clone(),
            medium,
            command_rx,
            fact_tx,
        )));
        self.peer_tasks.push(handle.spawn(pump_peer(
            id,
            name.clone(),
            facts,
            self.event_tx.clone(),
            self.presence.clone(),
            self.commands.clone(),
            self.peers.clone(),
        )));
        PeerHandle { id, name, commands }
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
        self.peers
            .hand(None, &PeerCommand::Write(mutated.entry.clone()));
        Ok(mutated)
    }

    /// [`Engine::mutate_local`]: a local-only write, folded here and never handed to the link.
    pub fn mutate_local(
        &self,
        procedure: &str,
        changes: Vec<Change>,
        partition: Option<PartitionKey>,
    ) -> Result<Mutated, MutateError> {
        lock(&self.engine).mutate_local(procedure, changes, partition)
    }

    /// [`Engine::can`] (`mesh.can`): may this device do `"table.op"` on `row`, in `instance`.
    pub fn can(&self, what: &str, row: Option<&Row>, instance: Option<&str>) -> bool {
        lock(&self.engine).can(what, row, instance)
    }

    /// [`Engine::revert`], with the compensating write handed to the link like any other.
    pub fn revert(&self, event_id: &str) -> Result<Reverted, RevertError> {
        let reverted = lock(&self.engine).revert(event_id)?;
        if let Some(mutated) = &reverted.mutated {
            let _ = self
                .commands
                .try_send(LinkCommand::Write(mutated.entry.clone()));
            self.peers
                .hand(None, &PeerCommand::Write(mutated.entry.clone()));
        }
        Ok(reverted)
    }

    /// Publishes this device's value at a topic; conflated at every hop, never queued.
    pub fn presence_set(&self, topic: &str, partition: &PartitionKey, value: Row, ttl_ms: i64) {
        let wire = lock(&self.presence).set(topic, partition, value, ttl_ms, now_ms());
        self.peers.hand(None, &PeerCommand::Presence(wire.clone()));
        let _ = self.commands.try_send(LinkCommand::Presence(wire));
    }

    /// An explicit departure from a topic.
    pub fn presence_clear(&self, topic: &str, partition: &PartitionKey) {
        let wire = lock(&self.presence).clear(topic, partition, now_ms());
        self.peers.hand(None, &PeerCommand::Presence(wire.clone()));
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

    /// The grant registry the validator reads. A grant the room sends is registered by the link,
    /// which then re-offers that device's events parked on a capability verdict (gaps U42). A
    /// grant registered here by hand is not: follow it with
    /// `mesh.engine().retry_author(&device)`, after this guard is dropped, to fold what its device
    /// wrote ahead of it.
    pub fn grants(&self) -> MutexGuard<'_, GrantRegistry> {
        lock(&self.grants)
    }

    /// Stores the bytes here under their hash and offers them to the room (D18), billed to
    /// `partition`'s byte budget there; answers once the relay has said it kept them. Put first,
    /// write the row that names the hash second.
    ///
    /// A refusal is a value: [`BlobError::QuotaExceeded`] when the partition's budget would pass
    /// its quota, [`BlobError::NotGranted`] when a grant-gated room's grant for this device does
    /// not name the partition — either way the room stored nothing and this device is still the
    /// holder. A room that keeps no blobs (`no-store`), a code this build cannot name, and a relay
    /// that says nothing for [`BLOB_ANSWER_WAIT`] are not refusals: the bytes are here, and the put
    /// succeeds, as it did before rooms answered at all. A put made while the link is not up
    /// answers at once, the same way: the frame could not leave, so nothing will answer it, and it
    /// is not sent again on the next session — put it again once [`MeshEvent::Online`] says so.
    pub async fn blob_put(
        &self,
        bytes: &[u8],
        partition: Option<PartitionKey>,
    ) -> Result<String, BlobError> {
        let hash = lock(&self.blobs).put(bytes)?;
        let (settle, answer) = oneshot::channel();
        let frame = blob_put_frame(&hash, bytes, partition.as_ref());
        lock(&self.waits.uploads)
            .entry(hash.clone())
            .or_default()
            .push(Upload { partition, settle });
        let command = LinkCommand::BlobPut {
            hash: hash.clone(),
            frame,
        };
        if self.commands.try_send(command).is_err() {
            // the link is gone or its queue is full: the frame never left, so nothing will answer
            settle_uploads(&self.waits.uploads, &hash, None);
        }
        match tokio::time::timeout(BLOB_ANSWER_WAIT, answer).await {
            Ok(Ok(Some(refusal))) => Err(refusal.into_error(&hash)),
            Ok(_) => Ok(hash),
            Err(_) => {
                // silence: a relay that predates the answer; this wait is over, others are not
                let mut held = lock(&self.waits.uploads);
                if let Some(waits) = held.get_mut(&hash) {
                    waits.retain(|upload| !upload.settle.is_closed());
                    if waits.is_empty() {
                        held.remove(&hash);
                    }
                }
                Ok(hash)
            }
        }
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
        lock(&self.waits.fetches)
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
                lock(&self.waits.fetches).remove(hash);
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

    /// Every floor this device is below, with why (`$recovery.belowFloor`): a relay that refused
    /// it with `retention` (gaps U37), and the peers whose floors this mesh's peer links, or a
    /// host's own links, raised in [`Mesh::rejoins`]. [`MeshEvent::Recovery`] says when the relay's
    /// issue or one this mesh's peer links raised changed; a host that drives its own links reads
    /// [`Rejoins::changes`] for theirs.
    pub fn below_floor(&self) -> Vec<BelowFloor> {
        let ours = lock(&self.engine).coverage().synced;
        lock(&self.rejoins).issues(&ours)
    }

    /// The mesh's recovery record, for a host that drives its own peer links ([`crate::PeerJoin`])
    /// so their floors and the relay's are one list.
    pub fn rejoins(&self) -> MutexGuard<'_, Rejoins> {
        lock(&self.rejoins)
    }

    /// Something folded or installed from a source this mesh does not run (a host's own peer
    /// link, a snapshot): the link pushes what the relay lacks, and a link holding off below the
    /// relay's floor dials again once this device holds it (gaps U37).
    pub fn folded_elsewhere(&self) {
        let _ = self.commands.try_send(LinkCommand::RemoteFold);
        self.peers.hand(None, &PeerCommand::RemoteFold);
    }

    /// Departs every presence topic, stops the links, and waits for the tasks to end. Events not
    /// yet read are dropped, so a link waiting to report one is free to stop.
    pub async fn stop(mut self) {
        // nobody reads past here: a pump blocked on a full event queue lets go, and so does the
        // link behind it
        self.events.close();
        let departures = lock(&self.presence).stop(now_ms());
        let links = self.peers.take();
        for wire in departures {
            for link in &links {
                let _ = link.send(PeerCommand::Presence(wire.clone())).await;
            }
            let _ = self.commands.send(LinkCommand::Presence(wire)).await;
        }
        // waited for, not tried: a handle the host still holds keeps the queue open, so a lost
        // close would leave the link running and this waiting on it
        for link in links {
            let _ = link.send(PeerCommand::Close).await;
        }
        for task in self.peer_tasks.drain(..) {
            let _ = task.await;
        }
        let _ = self.commands.send(LinkCommand::Stop).await;
        for task in self.tasks.drain(..) {
            let _ = task.await;
        }
    }
}

/// What the pump writes link facts into.
struct Pumped {
    presence: Arc<Mutex<PresenceTier>>,
    grants: Arc<Mutex<GrantRegistry>>,
    blobs: Arc<Mutex<Box<dyn BlobStore + Send>>>,
    waits: BlobWaits,
    rejoins: Arc<Mutex<Rejoins>>,
    /// The relay link's name, which its floor issue is raised under.
    relay: String,
    /// Told of every fold the relay brings, so they can offer it on.
    peers: Peers,
}

/// Link facts to mesh events: presence into the tier, blob answers to their waiters, a relay's
/// floor into the recovery record, everything else forwarded.
async fn pump(
    mut link: mpsc::Receiver<LinkEvent>,
    events: mpsc::Sender<MeshEvent>,
    into: Pumped,
    commands: mpsc::Sender<LinkCommand>,
) {
    let Pumped {
        presence,
        grants,
        blobs,
        waits,
        rejoins,
        relay,
        peers,
    } = into;
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
            LinkEvent::Folded(batch) => {
                peers.hand(None, &PeerCommand::RemoteFold);
                vec![MeshEvent::Folded(batch)]
            }
            LinkEvent::Presence(wire) => {
                let mut tier = lock(&presence);
                tier.receive(&wire, now_ms());
                tier.take_touched()
                    .into_iter()
                    .map(MeshEvent::Presence)
                    .collect()
            }
            // the link registered it before folding anything that arrived beside it
            LinkEvent::Grant(_) => Vec::new(),
            LinkEvent::GrantRequest { peer_id, invite } => {
                vec![MeshEvent::GrantRequest { peer_id, invite }]
            }
            LinkEvent::BlobAnswer { hash, bytes } => {
                let bytes = bytes.filter(|b| verify_blob(&hash, b).is_ok());
                if let Some(b) = &bytes {
                    let _ = lock(&blobs).put_at(&hash, b);
                }
                if let Some(list) = lock(&waits.fetches).remove(&hash) {
                    for tx in list {
                        let _ = tx.send(bytes.clone());
                    }
                }
                Vec::new()
            }
            LinkEvent::BlobPutAnswer { hash, refusal } => {
                settle_uploads(&waits.uploads, &hash, refusal);
                Vec::new()
            }
            LinkEvent::BlobPutUnsent { hash } => {
                settle_uploads(&waits.uploads, &hash, None);
                Vec::new()
            }
            LinkEvent::PeerHeard(peer) => vec![MeshEvent::PeerHeard(peer)],
            LinkEvent::Dropped(why) => vec![MeshEvent::Dropped(why)],
            LinkEvent::BelowFloor(floor) => {
                lock(&rejoins).relay_refused(&relay, floor);
                vec![MeshEvent::Recovery]
            }
            LinkEvent::FloorCleared => {
                lock(&rejoins).relay_cleared(&relay);
                vec![MeshEvent::Recovery]
            }
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
async fn heartbeat(
    presence: Arc<Mutex<PresenceTier>>,
    commands: mpsc::Sender<LinkCommand>,
    peers: Peers,
) {
    loop {
        let (due, next) = {
            let mut tier = lock(&presence);
            let now = now_ms();
            (tier.heartbeats_due(now), tier.next_heartbeat_ms())
        };
        for wire in due {
            peers.hand(None, &PeerCommand::Presence(wire.clone()));
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

/// A peer link's facts to mesh events: its folds handed to the relay and the other peer links, its
/// presence into the tier, an install it settled said as a recovery change too.
async fn pump_peer(
    id: PeerLinkId,
    name: String,
    mut facts: mpsc::Receiver<PeerAction>,
    events: mpsc::Sender<MeshEvent>,
    presence: Arc<Mutex<PresenceTier>>,
    relay: mpsc::Sender<LinkCommand>,
    peers: Peers,
) {
    while let Some(fact) = facts.recv().await {
        let out = match fact {
            PeerAction::Folded(batch) => {
                let _ = relay.try_send(LinkCommand::RemoteFold);
                peers.hand(Some(id), &PeerCommand::RemoteFold);
                vec![MeshEvent::Folded(batch)]
            }
            PeerAction::Presence(wire) => {
                let mut tier = lock(&presence);
                tier.receive(&wire, now_ms());
                tier.take_touched()
                    .into_iter()
                    .map(MeshEvent::Presence)
                    .collect()
            }
            // the session registered it in this mesh's registry before anything beside it folded
            PeerAction::Grant(_) => Vec::new(),
            // the session raised or cleared a peer's floor in this mesh's record
            PeerAction::Recovery => vec![MeshEvent::Recovery],
            PeerAction::Snapshot(settled) => {
                let installed = matches!(settled.outcome, JoinOutcome::Installed { .. });
                if installed {
                    let _ = relay.try_send(LinkCommand::RemoteFold);
                    peers.hand(Some(id), &PeerCommand::RemoteFold);
                }
                vec![
                    MeshEvent::Peer {
                        link: id,
                        name: name.clone(),
                        fact: PeerAction::Snapshot(settled),
                    },
                    MeshEvent::Recovery,
                ]
            }
            fact => vec![MeshEvent::Peer {
                link: id,
                name: name.clone(),
                fact,
            }],
        };
        for event in out {
            if events.send(event).await.is_err() {
                return;
            }
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
        let peers = Peers::new(event_tx.clone());
        let pumping = tokio::spawn(pump(
            link_rx,
            event_tx,
            Pumped {
                presence: presence.clone(),
                grants: Arc::new(Mutex::new(GrantRegistry::new(identity.peer_id().clone()))),
                blobs,
                waits: BlobWaits::default(),
                rejoins: Arc::new(Mutex::new(Rejoins::new())),
                relay: "relay".to_owned(),
                peers,
            },
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

    #[test]
    fn a_command_a_full_peer_link_could_not_take_is_said() {
        let (said, mut events) = mpsc::channel(8);
        let peers = Peers::new(said);
        let (tx, _rx) = mpsc::channel(1);
        lock(&peers.links).push((PeerLinkId(0), tx));
        peers.hand(None, &PeerCommand::Resync);
        assert!(events.try_recv().is_err(), "the first fit");
        peers.hand(None, &PeerCommand::Resync);
        assert!(
            matches!(events.try_recv(), Ok(MeshEvent::Dropped(why)) if why.contains("peer-link-0")),
            "the second was lost, and said"
        );
        // the link a fact came from is not handed it, so nothing is lost there
        peers.hand(Some(PeerLinkId(0)), &PeerCommand::Resync);
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn a_put_answer_settles_the_uploads_it_is_for() {
        let acme = PartitionKey::parse("org:acme").unwrap();
        let globex = PartitionKey::parse("org:globex").unwrap();
        let uploads = Uploads::default();
        let wait = |partition: Option<PartitionKey>| {
            let (settle, answer) = oneshot::channel();
            lock(&uploads)
                .entry("h".to_owned())
                .or_default()
                .push(Upload { partition, settle });
            answer
        };
        let mut at_acme = wait(Some(acme.clone()));
        let mut at_globex = wait(Some(globex));
        let quota = PutRefusal::Quota {
            partition: Some(acme),
            limit: 40,
            used: 30,
        };
        // a refusal is about the budget of the one partition it names
        settle_uploads(&uploads, "h", Some(quota.clone()));
        assert_eq!(at_acme.try_recv(), Ok(Some(quota)));
        assert!(
            at_globex.try_recv().is_err(),
            "another partition still waits"
        );
        // a `blob-stored` answers every put of those bytes
        settle_uploads(&uploads, "h", None);
        assert_eq!(at_globex.try_recv(), Ok(None));
        assert!(lock(&uploads).is_empty());
    }
}
