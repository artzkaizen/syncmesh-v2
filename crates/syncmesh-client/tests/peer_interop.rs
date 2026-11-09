//! The peer link's acceptance test (gap U3's radios): a Rust device and a TypeScript device linked
//! directly, no relay between them, converging both ways — rows, presence, and state through the
//! join exchange — over the TypeScript's own media.
//!
//! `conformance/src/interop/peer-device.ts lan` is the real LAN transport (`lan` over
//! `@syncmesh/lan-node`), which the Rust device dials over TCP and speaks the length-framed sealed
//! link to; `… ble` is the real BLE link (`bleLink`, its fragments and reassembly) as the
//! peripheral, its characteristic carried one length-prefixed packet at a time over a socket, which
//! the Rust device speaks [`Framing::Fragments`] to. Skipped, with a note, where `bun` is missing.

#![cfg(feature = "tokio")]

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use syncmesh_client::driver::{
    PeerCommand, PeerMedium, PeerRead, PeerWrite, StreamMedium, run_peer,
};
use syncmesh_client::{
    Engine, EngineOptions, Framing, JoinOutcome, MemoryEventStore, PeerAction, PeerOptions,
    PresenceTier, decode_and_verify_presence,
};
use syncmesh_core::event::{Change, PartitionKey, PeerId};
use syncmesh_core::framing::{FrameReader, frame_with_length};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::{CellValue, Row};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::time::timeout;

const STEP: Duration = Duration::from_secs(60);
/// What one BLE write carries on the TypeScript side of the `ble` medium.
const BLE_LIMIT: usize = 64;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the crate sits two levels below the repo root")
}

/// Whether the workspace's packages are installed, which the TypeScript reference imports.
fn installed() -> bool {
    repo_root().join("node_modules").is_dir()
}

fn find_bun() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("bun"))
            .find(|candidate| candidate.is_file())
    });
    on_path.or_else(|| {
        let home = std::env::var_os("HOME")?;
        let candidate = Path::new(&home).join(".bun/bin/bun");
        candidate.is_file().then_some(candidate)
    })
}

async fn next_json(
    lines: &mut Lines<BufReader<ChildStdout>>,
    want: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    loop {
        let line = timeout(STEP, lines.next_line())
            .await
            .expect("the TypeScript device went quiet")
            .expect("reading the TypeScript device's stdout")
            .expect(
                "the TypeScript device ended early (is the workspace built? `vp run -r build`)",
            );
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        assert!(
            value["link"]["kind"] != "closed" && value["link"]["kind"] != "refused",
            "the TypeScript side ended the link: {value}"
        );
        if want(&value) {
            return value;
        }
    }
}

async fn next_fact(
    events: &mut mpsc::Receiver<PeerAction>,
    want: impl Fn(&PeerAction) -> bool,
) -> PeerAction {
    loop {
        let fact = timeout(STEP, events.recv())
            .await
            .expect("the link went quiet")
            .expect("the driver ended early");
        assert!(
            !matches!(fact, PeerAction::Ended { .. } | PeerAction::Refused { .. }),
            "the Rust side ended the link: {fact:?}"
        );
        if want(&fact) {
            return fact;
        }
    }
}

fn insert(key: &str, body: &str) -> Change {
    let mut row = Row::new();
    row.insert("body".to_owned(), CellValue::text(body));
    Change::Insert {
        table: "notes".into(),
        key: key.into(),
        row,
    }
}

fn folded_row(value: &serde_json::Value, key: &str) -> Option<String> {
    value["folded"].as_array()?.iter().find_map(|row| {
        (row[0] == "notes" && row[1] == key).then(|| row[2]["body"].as_str().map(str::to_owned))?
    })
}

/// A BLE characteristic over a socket, as the TypeScript side carries it: every packet one
/// length-prefixed record — one write, one notification.
struct Gatt {
    socket: TcpStream,
}

/// Gatt's notifications.
struct GattReader {
    socket: OwnedReadHalf,
    reader: FrameReader,
    ready: VecDeque<Vec<u8>>,
    buffer: Vec<u8>,
}

/// Gatt's writes.
struct GattWriter {
    socket: OwnedWriteHalf,
}

impl PeerMedium for Gatt {
    type Reader = GattReader;
    type Writer = GattWriter;

    fn split(self) -> (GattReader, GattWriter) {
        let (read, write) = self.socket.into_split();
        (
            GattReader {
                socket: read,
                reader: FrameReader::new(BLE_LIMIT),
                ready: VecDeque::new(),
                buffer: vec![0; 4096],
            },
            GattWriter { socket: write },
        )
    }
}

impl PeerRead for GattReader {
    async fn read(&mut self) -> Option<Vec<u8>> {
        loop {
            if let Some(packet) = self.ready.pop_front() {
                return Some(packet);
            }
            let n = self.socket.read(&mut self.buffer).await.ok()?;
            if n == 0 {
                return None;
            }
            self.reader.push(&self.buffer[..n]);
            let (packets, broken) = self.reader.drain();
            if broken.is_some() {
                return None;
            }
            self.ready.extend(packets);
        }
    }
}

impl PeerWrite for GattWriter {
    async fn write(&mut self, bytes: Vec<u8>) -> std::io::Result<()> {
        assert!(bytes.len() <= BLE_LIMIT, "a {}-byte BLE write", bytes.len());
        let framed = frame_with_length(&bytes, BLE_LIMIT).map_err(std::io::Error::other)?;
        self.socket.write_all(&framed).await
    }

    async fn close(&mut self) {
        let _ = self.socket.shutdown().await;
    }
}

struct Typescript {
    lines: Lines<BufReader<ChildStdout>>,
    stdin: ChildStdin,
    child: tokio::process::Child,
    port: u16,
    peer: PeerId,
}

impl Typescript {
    async fn start(bun: &Path, medium: &str) -> Typescript {
        let mut child = Command::new(bun)
            .args(["run", "conformance/src/interop/peer-device.ts", medium])
            .current_dir(repo_root())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("spawning bun");
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let stdin = child.stdin.take().unwrap();
        let ready = next_json(&mut lines, |v| v["ready"] == true).await;
        Typescript {
            port: u16::try_from(ready["port"].as_u64().unwrap()).unwrap(),
            peer: PeerId::parse(ready["tsPeer"].as_str().unwrap()).unwrap(),
            lines,
            stdin,
            child,
        }
    }

    async fn say(&mut self, line: serde_json::Value) {
        self.stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn quit(mut self) {
        self.say(serde_json::json!({ "quit": true })).await;
        let status = timeout(STEP, self.child.wait())
            .await
            .expect("bun did not exit")
            .unwrap();
        assert!(
            status.success(),
            "the TypeScript device exited with {status}"
        );
    }
}

/// The whole conversation, over whichever medium `connect` opened. `quiet` holds the link idle
/// past both sides' liveness deadlines before the last step.
async fn converge<M: PeerMedium + 'static>(
    mut ts: Typescript,
    medium: M,
    framing: Framing,
    quiet: Option<Duration>,
) {
    let seed = [43u8; 32];
    let identity = Identity::from_seed(&seed);
    let engine = Arc::new(Mutex::new(
        Engine::open(
            identity.clone(),
            Box::new(MemoryEventStore::new()),
            None,
            EngineOptions::default(),
        )
        .unwrap(),
    ));
    // written before the link: the cursors exchanged on open carry it across
    engine
        .lock()
        .unwrap()
        .mutate("notes.create", vec![insert("r0", "before")], None)
        .unwrap();
    let options = PeerOptions {
        framing,
        // pinned: the hello has to prove the TypeScript device's own key
        peer_key: Some(ts.peer.clone()),
        ..PeerOptions::default()
    };
    let (commands, command_rx) = mpsc::channel(16);
    let (fact_tx, mut facts) = mpsc::channel(256);
    let driver = tokio::spawn(run_peer(
        identity.clone(),
        options,
        Arc::clone(&engine),
        medium,
        command_rx,
        fact_tx,
    ));
    let established = next_fact(&mut facts, |f| matches!(f, PeerAction::Established(_))).await;
    assert_eq!(established, PeerAction::Established(ts.peer.clone()));
    let carried = next_json(&mut ts.lines, |v| folded_row(v, "r0").is_some()).await;
    assert_eq!(folded_row(&carried, "r0").as_deref(), Some("before"));

    // the TypeScript device writes; the Rust engine folds it, straight off the link
    ts.say(serde_json::json!({ "write": { "key": "n1", "body": "hi" } }))
        .await;
    next_fact(&mut facts, |f| {
        matches!(f, PeerAction::Folded(b) if b.write_keys.get("notes").is_some_and(|k| k.contains("n1")))
    })
    .await;
    assert_eq!(
        engine
            .lock()
            .unwrap()
            .state()
            .read_row("notes", "n1")
            .unwrap()["body"],
        CellValue::text("hi")
    );

    // the Rust device writes; the TypeScript device folds it
    let entry = engine
        .lock()
        .unwrap()
        .mutate("notes.create", vec![insert("n2", "from rust")], None)
        .unwrap()
        .entry;
    commands.send(PeerCommand::Write(entry)).await.unwrap();
    let folded = next_json(&mut ts.lines, |v| folded_row(v, "n2").is_some()).await;
    assert_eq!(folded_row(&folded, "n2").as_deref(), Some("from rust"));

    // presence, both ways (D16)
    let partition = PartitionKey::parse("org:acme").unwrap();
    let mut tier = PresenceTier::new(identity.clone(), "rust-session".to_owned());
    let mut value = Row::new();
    value.insert("x".to_owned(), CellValue::Number(7.0));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let wire = tier.set("cursor", &partition, value, 60_000, now);
    commands.send(PeerCommand::Presence(wire)).await.unwrap();
    let arrived = next_json(&mut ts.lines, |v| v["presence"]["topic"] == "cursor").await;
    assert_eq!(arrived["presence"]["peer"], identity.peer_id().as_str());
    assert_eq!(arrived["presence"]["x"], 7);
    ts.say(
        serde_json::json!({ "presence": { "topic": "pointer", "partition": "org:acme", "x": 3 } }),
    )
    .await;
    let PeerAction::Presence(wire) =
        next_fact(&mut facts, |f| matches!(f, PeerAction::Presence(_))).await
    else {
        unreachable!()
    };
    let presence = decode_and_verify_presence(&wire).unwrap().presence;
    assert_eq!(&presence.peer_id, &ts.peer);
    assert_eq!(presence.topic, "pointer");
    assert_eq!(presence.value.unwrap()["x"], CellValue::Number(3.0));

    // state rather than history, asked by the Rust device and served by the TypeScript one
    commands
        .send(PeerCommand::RequestSnapshot {
            interest: None,
            adopt_unvouched: true,
        })
        .await
        .unwrap();
    let PeerAction::Snapshot(settled) =
        next_fact(&mut facts, |f| matches!(f, PeerAction::Snapshot(_))).await
    else {
        unreachable!()
    };
    let JoinOutcome::Installed { installed, .. } = settled.outcome else {
        panic!("the TypeScript device's state was refused");
    };
    assert_eq!(installed.rows, 3, "r0, n1 and n2");

    // and asked by the TypeScript device, served by the Rust one
    ts.say(serde_json::json!({ "snapshot": true })).await;
    let installed = next_json(&mut ts.lines, |v| v["snapshot"].is_object()).await;
    assert_eq!(installed["snapshot"]["rows"], 3);

    if let Some(quiet) = quiet {
        // idle past both sides' deadlines: each one's probe is answered, so neither hangs up
        tokio::time::sleep(quiet).await;
        while let Ok(fact) = facts.try_recv() {
            assert!(
                !matches!(fact, PeerAction::Ended { .. } | PeerAction::Close { .. }),
                "{fact:?}"
            );
        }
        ts.say(serde_json::json!({ "write": { "key": "n3", "body": "still here" } }))
            .await;
        next_fact(&mut facts, |f| {
            matches!(f, PeerAction::Folded(b) if b.write_keys.get("notes").is_some_and(|k| k.contains("n3")))
        })
        .await;
    }

    assert_eq!(
        engine.lock().unwrap().state().read_rows("notes").len(),
        if quiet.is_some() { 4 } else { 3 }
    );
    ts.quit().await;
    let ended = next_ended(&mut facts).await;
    assert!(matches!(ended, PeerAction::Ended { .. }), "{ended:?}");
    drop(commands);
    timeout(STEP, driver)
        .await
        .expect("the driver did not stop")
        .unwrap();
}

async fn next_ended(events: &mut mpsc::Receiver<PeerAction>) -> PeerAction {
    loop {
        let fact = timeout(STEP, events.recv())
            .await
            .expect("the link did not end")
            .expect("the driver ended without saying so");
        if matches!(fact, PeerAction::Ended { .. }) {
            return fact;
        }
    }
}

#[tokio::test]
async fn a_rust_device_and_a_typescript_device_converge_over_the_lan_transport() {
    let Some(bun) = find_bun().filter(|_| installed()) else {
        eprintln!(
            "skipping: the TypeScript reference needs `bun` on PATH and an installed workspace \
             (`vp install`, then `vp run -r build`)"
        );
        return;
    };
    let ts = Typescript::start(&bun, "lan").await;
    let socket = TcpStream::connect(("127.0.0.1", ts.port)).await.unwrap();
    // 13s: past the LAN transport's 12.5s deadline (5s keepalive) and this link's own
    converge(
        ts,
        StreamMedium::new(socket),
        Framing::STREAM,
        Some(Duration::from_secs(13)),
    )
    .await;
}

#[tokio::test]
async fn a_rust_device_and_a_typescript_device_converge_over_ble_fragments() {
    let Some(bun) = find_bun().filter(|_| installed()) else {
        eprintln!(
            "skipping: the TypeScript reference needs `bun` on PATH and an installed workspace \
             (`vp install`, then `vp run -r build`)"
        );
        return;
    };
    let ts = Typescript::start(&bun, "ble").await;
    let socket = TcpStream::connect(("127.0.0.1", ts.port)).await.unwrap();
    let gatt = Gatt { socket };
    converge(ts, gatt, Framing::fragments(BLE_LIMIT), None).await;
}
