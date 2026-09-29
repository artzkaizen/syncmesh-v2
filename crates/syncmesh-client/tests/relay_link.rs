//! Two Rust devices converging through the in-process `Room`, driven by a tiny synchronous
//! harness: one queue of bytes both ways, every `Action` and `RoomAction` applied in a loop until
//! nothing is left to do, and the clock fed by hand. No sockets, no timers — which is exactly
//! what lets these tests say what a link does at 2.5× a keepalive without waiting for one.

use std::collections::{BTreeMap, VecDeque};

use syncmesh_client::relay::{Action, REFUSED, RelayLink, RelayOptions, UNPINNED};
use syncmesh_client::room::{Room, RoomAction, RoomOptions, SocketId};
use syncmesh_client::{Engine, EngineOptions, Interest, MemoryEventStore, StoredEvent};
use syncmesh_core::cbor::{Key, Value};
use syncmesh_core::event::{Change, PartitionKey, PeerId};
use syncmesh_core::frames::Frame;
use syncmesh_core::grant::{GrantRequest, issue_grant};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::CellValue;
use syncmesh_core::relay_frames::{
    RelayFrame, blob_get_frame, blob_put_frame, decode_relay_frame, relayed_frame,
};

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

fn room_with(versions: Vec<u64>, keepalive_ms: u64) -> Room {
    Room::new(
        identity(200),
        Box::new(MemoryEventStore::new()),
        RoomOptions {
            versions,
            keepalive_ms,
            page_size: 2,
            ..RoomOptions::default()
        },
    )
    .unwrap()
}

fn acme() -> PartitionKey {
    PartitionKey::parse("org:acme").unwrap()
}

fn globex() -> PartitionKey {
    PartitionKey::parse("org:globex").unwrap()
}

fn insert(key: &str, body: &str) -> Change {
    let mut row = BTreeMap::new();
    row.insert("body".to_owned(), CellValue::text(body));
    Change::Insert {
        table: "notes".into(),
        key: key.into(),
        row,
    }
}

fn write(
    engine: &mut Engine,
    key: &str,
    body: &str,
    partition: Option<PartitionKey>,
) -> StoredEvent {
    engine
        .mutate("notes.create", vec![insert(key, body)], partition)
        .unwrap()
        .entry
}

fn body_of(engine: &Engine, key: &str) -> Option<String> {
    let row = engine.state().read_row("notes", key)?;
    match row.get("body")? {
        CellValue::Text(s) => Some(s.clone()),
        other => panic!("body is not text: {other:?}"),
    }
}

struct Device {
    link: RelayLink,
    engine: Engine,
    socket: Option<SocketId>,
    redial_at: Option<i64>,
    /// Every `Redial { after_ms }` the link asked for, in order.
    redials: Vec<u64>,
    facts: Vec<Action>,
    /// Every plaintext-or-sealed byte string this device sent, for tests on a challenging room
    /// that want to read the join.
    sent: Vec<Vec<u8>>,
}

enum Msg {
    ToRoom { socket: SocketId, bytes: Vec<u8> },
    ToDevice { device: usize, bytes: Vec<u8> },
    RoomHungUp { socket: SocketId },
    DeviceHungUp { device: usize },
}

struct Net {
    room: Room,
    devices: Vec<Device>,
    now: i64,
    queue: VecDeque<Msg>,
    /// Whether `advance` lets the room send its keepalives; off to watch a mute relay.
    room_ticks: bool,
}

impl Net {
    fn new(room: Room) -> Net {
        let mut net = Net {
            room,
            devices: Vec::new(),
            now: 1_700_000_000_000,
            queue: VecDeque::new(),
            room_ticks: true,
        };
        net.room.tick(net.now);
        net
    }

    fn add(&mut self, n: u8, options: RelayOptions) -> usize {
        self.devices.push(Device {
            link: RelayLink::new(identity(n), options),
            engine: engine(n),
            socket: None,
            redial_at: None,
            redials: Vec::new(),
            facts: Vec::new(),
            sent: Vec::new(),
        });
        self.devices.len() - 1
    }

    fn device_of(&self, socket: SocketId) -> Option<usize> {
        self.devices.iter().position(|d| d.socket == Some(socket))
    }

    fn apply_device(&mut self, i: usize, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::Send(bytes) => {
                    self.devices[i].sent.push(bytes.clone());
                    if let Some(socket) = self.devices[i].socket {
                        self.queue.push_back(Msg::ToRoom { socket, bytes });
                    }
                }
                Action::Close { .. } => self.queue.push_back(Msg::DeviceHungUp { device: i }),
                Action::Redial { after_ms } => {
                    self.devices[i].redials.push(after_ms);
                    self.devices[i].redial_at = Some(self.now + after_ms as i64);
                }
                fact => self.devices[i].facts.push(fact),
            }
        }
    }

    fn apply_room(&mut self, actions: Vec<RoomAction>) {
        for action in actions {
            match action {
                RoomAction::Send { socket, bytes } => {
                    if let Some(device) = self.device_of(socket) {
                        self.queue.push_back(Msg::ToDevice { device, bytes });
                    }
                }
                RoomAction::Close { socket, .. } => {
                    self.queue.push_back(Msg::RoomHungUp { socket })
                }
            }
        }
    }

    fn dial(&mut self, i: usize) {
        self.devices[i].redial_at = None;
        let (socket, actions) = self.room.connect(self.now);
        self.devices[i].socket = Some(socket);
        let opened = self.devices[i].link.on_dialed(self.now);
        self.apply_device(i, opened);
        self.apply_room(actions);
        self.pump();
    }

    /// Runs the network until nothing is queued and no redial is due.
    fn pump(&mut self) {
        loop {
            while let Some(msg) = self.queue.pop_front() {
                match msg {
                    Msg::ToRoom { socket, bytes } => {
                        let actions = self.room.receive(socket, &bytes, self.now);
                        self.apply_room(actions);
                    }
                    Msg::ToDevice { device, bytes } => {
                        if self.devices[device].socket.is_none() {
                            continue;
                        }
                        let d = &mut self.devices[device];
                        let actions = d.link.on_bytes(&mut d.engine, &bytes, self.now);
                        self.apply_device(device, actions);
                    }
                    Msg::DeviceHungUp { device } => {
                        if let Some(socket) = self.devices[device].socket.take() {
                            self.room.closed(socket);
                            let actions = self.devices[device].link.on_closed(self.now);
                            self.apply_device(device, actions);
                        }
                    }
                    Msg::RoomHungUp { socket } => {
                        if let Some(device) = self.device_of(socket) {
                            self.devices[device].socket = None;
                            let actions = self.devices[device].link.on_closed(self.now);
                            self.apply_device(device, actions);
                        }
                    }
                }
            }
            let due = self
                .devices
                .iter()
                .position(|d| d.socket.is_none() && d.redial_at.is_some_and(|at| at <= self.now));
            match due {
                Some(i) => {
                    self.devices[i].redial_at = None;
                    let (socket, actions) = self.room.connect(self.now);
                    self.devices[i].socket = Some(socket);
                    let opened = self.devices[i].link.on_dialed(self.now);
                    self.apply_device(i, opened);
                    self.apply_room(actions);
                }
                None => return,
            }
        }
    }

    fn advance(&mut self, ms: i64) {
        self.now += ms;
        for i in 0..self.devices.len() {
            if self.devices[i].socket.is_some() {
                let actions = self.devices[i].link.on_tick(self.now);
                self.apply_device(i, actions);
            }
        }
        if self.room_ticks {
            let actions = self.room.tick(self.now);
            self.apply_room(actions);
        }
        self.pump();
    }

    fn write(
        &mut self,
        i: usize,
        key: &str,
        body: &str,
        partition: Option<PartitionKey>,
    ) -> StoredEvent {
        let entry = write(&mut self.devices[i].engine, key, body, partition);
        let actions = self.devices[i].link.on_local_write(&entry);
        self.apply_device(i, actions);
        self.pump();
        entry
    }

    /// The device loses its log and comes back under the same key: a fresh engine and link, as
    /// after deleting the database of an app whose key lives somewhere else (a keychain, a file
    /// beside it). The old socket hangs up first.
    fn lose_log(&mut self, i: usize, n: u8) {
        if let Some(socket) = self.devices[i].socket.take() {
            self.room.closed(socket);
        }
        self.devices[i].link = RelayLink::new(identity(n), RelayOptions::default());
        self.devices[i].engine = engine(n);
        self.devices[i].redial_at = None;
        self.devices[i].facts.clear();
    }

    /// Bytes straight into a device's link, as a room would have sent them.
    fn feed(&mut self, i: usize, bytes: &[u8]) {
        let d = &mut self.devices[i];
        let actions = d.link.on_bytes(&mut d.engine, bytes, self.now);
        self.apply_device(i, actions);
    }

    fn remote_fold(&mut self, i: usize) -> Vec<Action> {
        let d = &mut self.devices[i];
        d.link.on_remote_fold(&d.engine)
    }

    fn take_facts(&mut self, i: usize) -> Vec<Action> {
        std::mem::take(&mut self.devices[i].facts)
    }

    fn folded_count(facts: &[Action]) -> usize {
        facts
            .iter()
            .map(|f| match f {
                Action::Folded(b) => b.event_count,
                _ => 0,
            })
            .sum()
    }

    fn joins_sent(&self, i: usize) -> Vec<syncmesh_core::relay_frames::Join> {
        self.devices[i]
            .sent
            .iter()
            .filter_map(|b| match decode_relay_frame(b) {
                Ok(RelayFrame::Join(j)) => Some(j),
                _ => None,
            })
            .collect()
    }
}

fn v2_options() -> RelayOptions {
    RelayOptions {
        versions: vec![2, 3],
        ..RelayOptions::default()
    }
}

#[test]
fn a_write_before_joining_reaches_the_other_device_and_both_catch_up() {
    let mut net = Net::new(room_with(vec![3], 15_000));
    let a = net.add(1, RelayOptions::default());
    let b = net.add(2, RelayOptions::default());
    write(&mut net.devices[a].engine, "n1", "hello", None);
    net.dial(a);
    net.dial(b);
    assert_eq!(
        body_of(&net.devices[b].engine, "n1").as_deref(),
        Some("hello")
    );
    assert_eq!(net.devices[a].engine.state(), net.devices[b].engine.state());
    for i in [a, b] {
        let facts = net.take_facts(i);
        assert!(facts.contains(&Action::Online(true)), "{facts:?}");
        assert_eq!(facts.iter().filter(|f| **f == Action::CaughtUp).count(), 1);
        assert!(net.devices[i].link.caught_up());
        assert_eq!(net.devices[i].link.session_peer(), Some(net.room.peer_id()));
    }
    assert_eq!(net.room.offset(), 1);
    assert_eq!(net.room.clients().len(), 2);
}

#[test]
fn a_live_write_is_relayed_once_folded_once_and_acked() {
    // a challenging room, so the ack can be read off the wire in the clear
    let mut net = Net::new(room_with(vec![1, 2], 15_000));
    let a = net.add(1, v2_options());
    let b = net.add(2, v2_options());
    net.dial(a);
    net.dial(b);
    net.take_facts(a);
    net.take_facts(b);
    let entry = net.write(a, "n2", "live", None);
    let facts = net.take_facts(b);
    let folded: Vec<&Action> = facts
        .iter()
        .filter(|f| matches!(f, Action::Folded(_)))
        .collect();
    assert_eq!(folded.len(), 1, "{facts:?}");
    assert_eq!(Net::folded_count(&facts), 1);
    assert_eq!(
        body_of(&net.devices[b].engine, "n2").as_deref(),
        Some("live")
    );
    assert!(net.room.store().has(&entry.id()).unwrap());
    assert_eq!(net.room.offset(), 1);
    // the author heard nothing but the ack, which the link keeps to itself
    assert!(net.take_facts(a).is_empty());
    // a duplicate push is acked and nothing else
    let dup = net.devices[a].link.on_local_write(&entry);
    net.apply_device(a, dup);
    net.pump();
    assert_eq!(net.room.offset(), 1);
    assert!(net.take_facts(b).is_empty());
}

#[test]
fn a_relayed_frame_and_an_ack_read_as_such_on_a_challenging_room() {
    let mut room = room_with(vec![1, 2], 15_000);
    let mut a = engine(1);
    let mut link = RelayLink::new(identity(1), v2_options());
    let (socket, first) = room.connect(0);
    link.on_dialed(0);
    let RoomAction::Send { bytes, .. } = &first[0] else {
        panic!()
    };
    let mut to_room = Vec::new();
    for action in link.on_bytes(&mut a, bytes, 0) {
        if let Action::Send(b) = action {
            to_room.push(b);
        }
    }
    let mut back = Vec::new();
    for b in to_room {
        back.extend(room.receive(socket, &b, 0));
    }
    for action in back {
        if let RoomAction::Send { bytes, .. } = action {
            link.on_bytes(&mut a, &bytes, 0);
        }
    }
    assert!(link.caught_up());
    let entry = write(&mut a, "n1", "x", None);
    let sent = link.on_local_write(&entry);
    let [Action::Send(frame)] = sent.as_slice() else {
        panic!("expected one event frame");
    };
    let answers = room.receive(socket, frame, 0);
    let [RoomAction::Send { bytes, .. }] = answers.as_slice() else {
        panic!("expected one ack, got {answers:?}");
    };
    assert_eq!(
        decode_relay_frame(bytes),
        Ok(RelayFrame::Ack {
            id: entry.id(),
            offset: 1
        })
    );
}

#[test]
fn pinning_the_rooms_key_admits_it_and_refuses_any_other_for_good() {
    let mut net = Net::new(room_with(vec![3], 15_000));
    let room_key = net.room.peer_id().clone();
    let pinned = net.add(
        1,
        RelayOptions {
            relay_key: Some(room_key),
            ..RelayOptions::default()
        },
    );
    let wrong = net.add(
        2,
        RelayOptions {
            relay_key: Some(identity(77).peer_id().clone()),
            ..RelayOptions::default()
        },
    );
    net.dial(pinned);
    net.dial(wrong);
    assert!(net.take_facts(pinned).contains(&Action::CaughtUp));
    let facts = net.take_facts(wrong);
    assert!(
        facts.contains(&Action::Refused {
            reason: UNPINNED.to_owned()
        }),
        "{facts:?}"
    );
    assert!(!facts.contains(&Action::Online(true)));
    assert!(net.devices[wrong].redials.is_empty());
    assert!(net.devices[wrong].socket.is_none());
    assert!(net.devices[wrong].link.is_refused());
    for _ in 0..60 {
        net.advance(1000);
    }
    assert!(net.devices[wrong].socket.is_none());
    assert_eq!(net.room.clients().len(), 1);
}

#[test]
fn versions_meet_or_refuse_permanently() {
    // a challenging room against a link that offers only the sealed link: refused, no redial
    let mut net = Net::new(room_with(vec![2], 15_000));
    let only3 = net.add(1, RelayOptions::default());
    net.dial(only3);
    let facts = net.take_facts(only3);
    assert!(facts.contains(&Action::Refused {
        reason: REFUSED.to_owned()
    }));
    assert!(net.devices[only3].redials.is_empty());
    // a link offering 2 and 3 goes through the challenge and its proof
    let both = net.add(2, v2_options());
    net.dial(both);
    assert!(net.take_facts(both).contains(&Action::CaughtUp));
    let joins = net.joins_sent(both);
    assert_eq!(joins.len(), 1);
    assert!(joins[0].proof.is_some());
    assert_eq!(joins[0].versions, vec![2, 3]);
    // a room that lists only 1 answers a v2 offer with a typed version error
    let mut old = Net::new(room_with(vec![1], 15_000));
    let v2 = old.add(
        3,
        RelayOptions {
            versions: vec![2],
            ..RelayOptions::default()
        },
    );
    old.dial(v2);
    let facts = old.take_facts(v2);
    assert!(
        facts.contains(&Action::Refused {
            reason: REFUSED.to_owned()
        }),
        "{facts:?}"
    );
    assert!(old.devices[v2].redials.is_empty());
    // a sealed room against a link that was told not to offer 3
    let mut sealed = Net::new(room_with(vec![3], 15_000));
    let v2 = sealed.add(
        4,
        RelayOptions {
            versions: vec![2],
            ..RelayOptions::default()
        },
    );
    sealed.dial(v2);
    assert!(sealed.take_facts(v2).contains(&Action::Refused {
        reason: REFUSED.to_owned()
    }));
}

#[test]
fn a_mute_relay_is_hung_up_on_at_two_and_a_half_keepalives_and_redialed_with_backoff() {
    let mut net = Net::new(room_with(vec![3], 1000));
    net.room_ticks = false;
    let a = net.add(1, RelayOptions::default());
    net.dial(a);
    assert!(net.take_facts(a).contains(&Action::Online(true)));
    assert_eq!(net.devices[a].link.next_deadline_ms(), Some(net.now + 2500));
    net.advance(2499);
    assert!(net.devices[a].socket.is_some());
    assert!(net.take_facts(a).is_empty());
    net.advance(1);
    // hung up, said offline, and a redial after the first delay
    assert_eq!(net.take_facts(a), vec![Action::Online(false)]);
    assert_eq!(net.devices[a].redials, vec![500]);
    assert!(net.devices[a].socket.is_none());
    // the dial fails: the next wait doubles
    let failed = net.devices[a].link.on_dial_failed(net.now);
    assert_eq!(failed, vec![Action::Redial { after_ms: 1000 }]);
    // a keepalive that does arrive keeps the socket alive
    net.room_ticks = true;
    net.devices[a].redial_at = Some(net.now);
    net.pump();
    assert!(net.take_facts(a).contains(&Action::Online(true)));
    for _ in 0..5 {
        net.advance(1000);
    }
    assert!(net.devices[a].socket.is_some());
    assert!(net.take_facts(a).is_empty());
}

#[test]
fn a_reconnect_rejoins_from_its_cursors_and_receives_only_what_it_lacks() {
    let mut net = Net::new(room_with(vec![3], 15_000));
    let a = net.add(1, RelayOptions::default());
    let b = net.add(2, RelayOptions::default());
    for n in 1..=3 {
        write(&mut net.devices[a].engine, &format!("n{n}"), "x", None);
    }
    net.dial(a);
    net.dial(b);
    assert_eq!(Net::folded_count(&net.take_facts(b)), 3);
    // the network moves under b: hang up, redial after the backoff
    let woken = net.devices[b].link.wake();
    net.apply_device(b, woken);
    net.pump();
    assert!(net.devices[b].socket.is_none());
    assert_eq!(net.devices[b].redials, vec![500]);
    assert_eq!(net.take_facts(b), vec![Action::Online(false)]);
    net.write(a, "n4", "x", None);
    net.write(a, "n5", "x", None);
    assert!(net.take_facts(b).is_empty());
    net.advance(500);
    assert!(net.devices[b].socket.is_some());
    let facts = net.take_facts(b);
    assert_eq!(Net::folded_count(&facts), 2, "{facts:?}");
    assert!(facts.contains(&Action::CaughtUp));
    assert_eq!(
        net.devices[b].engine.cursors()[net.devices[a].engine.peer_id()].get(),
        5
    );
    // and the hello reset the backoff
    let woken = net.devices[b].link.wake();
    net.apply_device(b, woken);
    net.pump();
    assert_eq!(net.devices[b].redials, vec![500, 500]);
}

#[test]
fn the_holdback_releases_a_run_in_order_and_a_hole_past_the_limit_rejoins() {
    let mut net = Net::new(room_with(vec![1, 2], 15_000));
    let b = net.add(2, v2_options());
    let d = net.add(
        3,
        RelayOptions {
            gap_limit: 2,
            ..v2_options()
        },
    );
    net.dial(b);
    net.dial(d);
    net.take_facts(b);
    net.take_facts(d);
    // an author nobody is connected to; its frames are hand-fed as `relayed`, out of order
    let mut c = engine(9);
    let run: Vec<StoredEvent> = (1..=4)
        .map(|n| write(&mut c, &format!("c{n}"), "x", None))
        .collect();
    let relayed = |n: usize| relayed_frame(&run[n - 1].envelope().unwrap(), n as u64);
    for n in [3, 2] {
        net.feed(b, &relayed(n));
    }
    assert!(net.take_facts(b).is_empty());
    assert!(!net.devices[b].engine.cursors().contains_key(c.peer_id()));
    net.feed(b, &relayed(1));
    let facts = net.take_facts(b);
    assert_eq!(facts.len(), 1);
    assert_eq!(Net::folded_count(&facts), 3);
    assert_eq!(net.devices[b].engine.cursors()[c.peer_id()].get(), 3);
    assert!(net.devices[b].engine.ahead().is_empty());
    // d never gets c1: the third event above the hole overflows a limit of two, and a fresh join goes out
    let joins_before = net.joins_sent(d).len();
    for n in [2, 3, 4] {
        net.feed(d, &relayed(n));
    }
    net.pump();
    let joins = net.joins_sent(d);
    assert_eq!(joins.len(), joins_before + 1);
    assert!(joins.last().unwrap().cursors.is_empty());
    assert!(!net.devices[d].engine.cursors().contains_key(c.peer_id()));
    // the room answered the re-join with an (empty) last page: caught up again
    assert!(net.take_facts(d).contains(&Action::CaughtUp));
}

fn presence_wire(author: &Identity) -> Vec<u8> {
    let core = syncmesh_core::encode_cbor(&Value::map([
        (Key::Int(0), Value::Int(1)),
        (Key::Int(1), Value::Bytes(author.public_key().to_vec())),
        (Key::Int(2), Value::text("cursor")),
        (Key::Int(3), Value::text("org:acme")),
        (Key::Int(4), Value::text("s1")),
        (Key::Int(5), Value::Int(1)),
        (Key::Int(6), Value::Null),
        (Key::Int(7), Value::Int(1_700_000_060_000)),
    ]));
    let sig = author.sign(&core);
    syncmesh_core::envelope::envelope(&core, &sig)
}

fn grant_wire(device: &Identity) -> Vec<u8> {
    issue_grant(
        &identity(100),
        &GrantRequest {
            account: "acct_a".to_owned(),
            device: device.peer_id().clone(),
            role: Some("member".to_owned()),
            partitions: vec![acme()],
            claims: BTreeMap::new(),
            keys: Vec::new(),
            valid_for_ms: 86_400_000,
            now_ms: 1_700_000_000_000,
        },
    )
}

#[test]
fn presence_grants_and_blobs_pass_through_the_room() {
    let mut net = Net::new(room_with(vec![3], 15_000));
    let a = net.add(1, RelayOptions::default());
    let b = net.add(2, RelayOptions::default());
    net.dial(a);
    net.dial(b);
    net.take_facts(a);
    net.take_facts(b);
    let presence = presence_wire(&identity(1));
    let actions = net.devices[a].link.send_presence(&presence);
    net.apply_device(a, actions);
    net.pump();
    assert_eq!(net.take_facts(b), vec![Action::Presence(presence.clone())]);
    // a forged presence goes nowhere
    let mut forged = presence.clone();
    let last = forged.len() - 1;
    forged[last] ^= 1;
    let actions = net.devices[a].link.send_presence(&forged);
    net.apply_device(a, actions);
    net.pump();
    assert!(net.take_facts(b).is_empty());
    let grant = grant_wire(&identity(1));
    let actions = net.devices[a].link.send_grants(vec![grant.clone()]);
    net.apply_device(a, actions);
    net.pump();
    assert_eq!(net.take_facts(b), vec![Action::Grant(grant.clone())]);
    // a later joiner is handed who is here and the grants before any event
    let c = net.add(3, RelayOptions::default());
    net.dial(c);
    let facts = net.take_facts(c);
    let presence_at = facts
        .iter()
        .position(|f| *f == Action::Presence(presence.clone()));
    let grant_at = facts
        .iter()
        .position(|f| *f == Action::Grant(grant.clone()));
    let caught_at = facts.iter().position(|f| *f == Action::CaughtUp);
    assert!(presence_at < grant_at && grant_at < caught_at, "{facts:?}");
    // the others heard c join: the room passed its cursors on
    assert_eq!(
        net.take_facts(a),
        vec![Action::PeerHeard(identity(3).peer_id().clone())]
    );
    net.take_facts(b);
    // a grant request travels to everyone else
    let actions = net.devices[c].link.request_grant(Some("invite-1"));
    net.apply_device(c, actions);
    net.pump();
    assert_eq!(
        net.take_facts(a),
        vec![Action::GrantRequest {
            peer_id: identity(3).peer_id().clone(),
            invite: Some("invite-1".to_owned())
        }]
    );
    // ... everyone else, including b
    assert_eq!(net.take_facts(b).len(), 1);
    // blobs: put by one, fetched by another; an unknown hash is `None`
    let bytes = b"the bytes of a blob".to_vec();
    let hash = syncmesh_core::to_hex(&<sha2::Sha256 as sha2::Digest>::digest(&bytes));
    let actions = net.devices[a]
        .link
        .send_raw_frame(blob_put_frame(&hash, &bytes));
    net.apply_device(a, actions);
    net.pump();
    assert_eq!(net.room.blob(&hash), Some(bytes.as_slice()));
    let actions = net.devices[b].link.send_raw_frame(blob_get_frame(&hash));
    net.apply_device(b, actions);
    net.pump();
    assert_eq!(
        net.take_facts(b),
        vec![Action::BlobAnswer {
            hash: hash.clone(),
            bytes: Some(bytes.clone())
        }]
    );
    let actions = net.devices[b].link.send_raw_frame(blob_get_frame("00ff"));
    net.apply_device(b, actions);
    net.pump();
    assert_eq!(
        net.take_facts(b),
        vec![Action::BlobAnswer {
            hash: "00ff".to_owned(),
            bytes: None
        }]
    );
    // who this relay demonstrably carries: everyone whose cursors came through it
    let heard = net.devices[a].link.heard(net.now);
    assert!(heard.contains(identity(2).peer_id()) && heard.contains(identity(3).peer_id()));
    // a put under the wrong name is refused and stored nowhere; the typed error hangs the link
    // up (every error frame does), and a link that is down claims nobody
    let actions = net.devices[a]
        .link
        .send_raw_frame(blob_put_frame("00ff", &bytes));
    net.apply_device(a, actions);
    net.pump();
    assert!(net.room.blob("00ff").is_none());
    assert_eq!(net.take_facts(a), vec![Action::Online(false)]);
    assert!(net.devices[a].link.heard(net.now).is_empty());
}

#[test]
fn a_fold_from_elsewhere_is_pushed_to_the_relay_with_our_cursors() {
    let mut net = Net::new(room_with(vec![3], 15_000));
    let a = net.add(1, RelayOptions::default());
    let b = net.add(2, RelayOptions::default());
    net.dial(a);
    net.dial(b);
    net.take_facts(a);
    net.take_facts(b);
    // c wrote where there was no network; b learnt it over some other medium
    let mut c = engine(9);
    let entry = write(&mut c, "c1", "carried", None);
    net.devices[b].engine.receive(entry.clone()).unwrap();
    let actions = net.remote_fold(b);
    assert_eq!(actions.len(), 2, "{actions:?}");
    net.apply_device(b, actions);
    net.pump();
    assert_eq!(
        body_of(&net.devices[a].engine, "c1").as_deref(),
        Some("carried")
    );
    let facts = net.take_facts(a);
    assert_eq!(Net::folded_count(&facts), 1);
    assert!(facts.contains(&Action::PeerHeard(identity(2).peer_id().clone())));
    let acks = net.devices[a].engine.acks();
    assert_eq!(acks[identity(2).peer_id()].cursors[c.peer_id()].get(), 1);
    assert!(net.room.store().has(&entry.id()).unwrap());
    // a second call sends the difference, which is nothing but the cursors
    let again = net.remote_fold(b);
    assert_eq!(again.len(), 1);
    // before catch-up nothing is pushed: the last page's push covers it
    let mut fresh = RelayLink::new(identity(5), RelayOptions::default());
    assert!(fresh.on_remote_fold(&net.devices[b].engine).is_empty());
}

#[test]
fn a_scoped_interest_receives_its_slice_carries_the_scope_and_widening_repages_from_nothing() {
    let mut net = Net::new(room_with(vec![1, 2], 15_000));
    let a = net.add(1, v2_options());
    let b = net.add(
        2,
        RelayOptions {
            interest: Some(Interest::partitions([acme()])),
            ..v2_options()
        },
    );
    write(&mut net.devices[a].engine, "n1", "acme", Some(acme()));
    write(&mut net.devices[a].engine, "n2", "globex", Some(globex()));
    write(&mut net.devices[a].engine, "n3", "acme again", Some(acme()));
    net.dial(a);
    net.dial(b);
    let facts = net.take_facts(b);
    assert_eq!(Net::folded_count(&facts), 2, "{facts:?}");
    assert!(facts.contains(&Action::CaughtUp));
    assert_eq!(
        body_of(&net.devices[b].engine, "n1").as_deref(),
        Some("acme")
    );
    assert!(body_of(&net.devices[b].engine, "n2").is_none());
    assert_eq!(
        body_of(&net.devices[b].engine, "n3").as_deref(),
        Some("acme again")
    );
    let coverage = net.devices[b].engine.coverage();
    assert_eq!(
        coverage.scope.as_deref(),
        Some(r#"{"partitions":["org:acme"]}"#)
    );
    // the scanned coverage carried b past the hole the filter made
    assert_eq!(coverage.synced[identity(1).peer_id()].get(), 3);
    // live fan-out obeys the same interest: n4 never reaches b. And n5 waits: 4 is a hole the
    // filter made and nothing live will fill, so the holdback keeps 5 behind it until a re-join's
    // scanned coverage moves the cursor past it — exactly what the TypeScript link does
    net.write(a, "n4", "globex live", Some(globex()));
    net.write(a, "n5", "acme live", Some(acme()));
    let facts = net.take_facts(b);
    assert_eq!(Net::folded_count(&facts), 0, "{facts:?}");
    assert!(body_of(&net.devices[b].engine, "n4").is_none());
    assert!(body_of(&net.devices[b].engine, "n5").is_none());
    assert_eq!(
        net.devices[b].engine.cursors()[identity(1).peer_id()].get(),
        3
    );
    // widening: a new link over the same engine wants everything, so it asks from nothing
    let stopped = net.devices[b].link.stop();
    net.apply_device(b, stopped);
    net.pump();
    net.devices[b].link = RelayLink::new(identity(2), v2_options());
    net.devices[b].sent.clear();
    net.dial(b);
    let joins = net.joins_sent(b);
    assert_eq!(joins.len(), 1);
    assert!(joins[0].cursors.is_empty(), "{:?}", joins[0].cursors);
    assert_eq!(joins[0].interest, None);
    let facts = net.take_facts(b);
    // n2 and n4 were kept back by the filter and n5 by the holdback; n1 and n3 dedup on the store
    assert_eq!(Net::folded_count(&facts), 3, "{facts:?}");
    assert_eq!(
        body_of(&net.devices[b].engine, "n5").as_deref(),
        Some("acme live")
    );
    assert_eq!(
        body_of(&net.devices[b].engine, "n2").as_deref(),
        Some("globex")
    );
    assert_eq!(
        body_of(&net.devices[b].engine, "n4").as_deref(),
        Some("globex live")
    );
    let coverage = net.devices[b].engine.coverage();
    assert_eq!(coverage.scope, None);
    assert_eq!(coverage.synced[identity(1).peer_id()].get(), 5);
    // narrowing back keeps the cursor: a cursor true for everything is true for a slice
    let stopped = net.devices[b].link.stop();
    net.apply_device(b, stopped);
    net.pump();
    net.devices[b].link = RelayLink::new(
        identity(2),
        RelayOptions {
            interest: Some(Interest::partitions([acme()])),
            ..v2_options()
        },
    );
    net.devices[b].sent.clear();
    net.dial(b);
    let joins = net.joins_sent(b);
    assert_eq!(joins[0].cursors.len(), 1);
    assert_eq!(Net::folded_count(&net.take_facts(b)), 0);
}

#[test]
fn a_second_join_by_the_same_peer_supersedes_the_first_socket() {
    let mut net = Net::new(room_with(vec![3], 15_000));
    let a = net.add(1, RelayOptions::default());
    net.dial(a);
    net.take_facts(a);
    let first = net.devices[a].socket.unwrap();
    // the same identity on a second link, as a device that lost its socket without noticing would
    let twin = net.add(1, RelayOptions::default());
    net.dial(twin);
    assert!(net.take_facts(twin).contains(&Action::CaughtUp));
    assert_eq!(net.room.clients().len(), 1);
    assert_ne!(net.room.clients()[identity(1).peer_id()], first);
    // the first link saw its socket close and is redialling
    assert!(net.devices[a].socket.is_none());
    assert_eq!(net.take_facts(a), vec![Action::Online(false)]);
    assert_eq!(net.devices[a].redials, vec![500]);
}

#[test]
fn junk_from_the_room_is_dropped_and_said_and_a_bad_event_is_refused_by_the_room() {
    let mut net = Net::new(room_with(vec![1, 2], 15_000));
    let a = net.add(1, v2_options());
    net.dial(a);
    net.take_facts(a);
    // a relayed frame carrying a forged event: dropped, not folded
    let mut c = engine(9);
    let entry = write(&mut c, "c1", "x", None);
    let mut wire = entry.envelope().unwrap();
    let last = wire.len() - 1;
    wire[last] ^= 1;
    net.feed(a, &relayed_frame(&wire, 1));
    let facts = net.take_facts(a);
    assert!(
        matches!(facts.as_slice(), [Action::Dropped(_)]),
        "{facts:?}"
    );
    // and the same bytes offered to the room are refused with a typed `bad-event`; the link hangs
    // up on any error frame, as the TypeScript does, and redials on its backoff — not permanent
    let sent = net.devices[a]
        .link
        .send_raw_frame(syncmesh_core::frames::event_frame(&wire));
    net.apply_device(a, sent);
    net.pump();
    assert_eq!(net.room.offset(), 0);
    assert!(net.devices[a].socket.is_none());
    assert_eq!(net.take_facts(a), vec![Action::Online(false)]);
    assert_eq!(net.devices[a].redials, vec![500]);
    assert!(!net.devices[a].link.is_refused());
    net.advance(500);
    assert!(net.devices[a].socket.is_some());
    net.take_facts(a);
    // a frame that is not CBOR at all is dropped too
    net.feed(a, &[0xff, 0x00]);
    assert!(matches!(net.take_facts(a).as_slice(), [Action::Dropped(_)]));
    // a session frame the room never sends a device is ignored (a receipt; `routes` shares tag 8
    // with `join` and is not a frame a relay socket can carry at all)
    let receipt = Frame::Receipt { wire: vec![1, 2] }.encode().unwrap();
    net.feed(a, &receipt);
    assert!(net.take_facts(a).is_empty());
    let _ = PeerId::parse(&"a".repeat(64)).unwrap();
}

#[test]
fn a_device_that_lost_its_log_resumes_numbering_after_what_the_room_holds() {
    let mut net = Net::new(room_with(vec![3], 15_000));
    let a = net.add(1, RelayOptions::default());
    let b = net.add(2, RelayOptions::default());
    net.dial(a);
    net.dial(b);
    for (key, body) in [("n1", "one"), ("n2", "two"), ("n3", "three")] {
        net.write(a, key, body, None);
    }
    assert_eq!(
        body_of(&net.devices[b].engine, "n3").as_deref(),
        Some("three")
    );

    // the log is gone, the key is not: the same author rejoins with nothing
    net.lose_log(a, 1);
    net.dial(a);
    // its own history comes back from the room and is its own again
    assert_eq!(
        body_of(&net.devices[a].engine, "n1").as_deref(),
        Some("one")
    );
    assert_eq!(
        net.devices[a].engine.cursors()[identity(1).peer_id()].get(),
        3
    );
    let facts = net.take_facts(a);
    assert!(
        !facts.iter().any(|f| matches!(f, Action::Dropped(_))),
        "a fresh log that wrote nothing lost nothing: {facts:?}"
    );

    // and its next write is numbered after it, so the room takes it and B receives it
    let next = net.write(a, "n4", "four", None);
    assert_eq!(next.event.seq_num.get(), 4);
    assert_eq!(
        body_of(&net.devices[b].engine, "n4").as_deref(),
        Some("four")
    );
}

#[test]
fn a_lost_log_that_wrote_before_rejoining_is_told_and_numbers_after_the_room() {
    let mut net = Net::new(room_with(vec![3], 15_000));
    let a = net.add(1, RelayOptions::default());
    let b = net.add(2, RelayOptions::default());
    net.dial(a);
    net.dial(b);
    for (key, body) in [("n1", "one"), ("n2", "two"), ("n3", "three")] {
        net.write(a, key, body, None);
    }

    // log lost; one write lands in the fresh log while offline, as seq 1 — a number the room
    // already holds for a different event
    net.lose_log(a, 1);
    let offline = write(&mut net.devices[a].engine, "x1", "offline", None);
    assert_eq!(offline.event.seq_num.get(), 1);
    net.dial(a);
    let facts = net.take_facts(a);
    assert!(
        facts.iter().any(
            |f| matches!(f, Action::Dropped(why) if why.contains("holds writes by this device"))
        ),
        "the collision is said, not swallowed: {facts:?}"
    );

    // what comes after is numbered past the room's run, and arrives
    let next = net.write(a, "n4", "four", None);
    assert_eq!(next.event.seq_num.get(), 4);
    assert_eq!(
        body_of(&net.devices[b].engine, "n4").as_deref(),
        Some("four")
    );
}
