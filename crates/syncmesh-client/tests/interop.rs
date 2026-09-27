//! The acceptance test of the whole crate: a Rust device against the TypeScript relay and a
//! TypeScript peer, over a real WebSocket, byte for byte on the wire.
//!
//! `conformance/src/interop/relay-peer.ts` starts the relay and one TypeScript peer under Bun and
//! takes commands on stdin; this test drives the `tokio` driver against it. Skipped, with a note,
//! where `bun` is not installed — the TypeScript is the reference, and a machine without it cannot
//! run the reference.

#![cfg(feature = "tokio")]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use syncmesh_client::driver::{LinkCommand, LinkEvent, run_link};
use syncmesh_client::relay::{RelayLink, RelayOptions};
use syncmesh_client::{Engine, EngineOptions, MemoryEventStore};
use syncmesh_core::event::{Change, PeerId};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::CellValue;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::time::timeout;

const STEP: Duration = Duration::from_secs(60);

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the crate sits two levels below the repo root")
}

/// `which bun`, then the place Bun's own installer puts it.
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

/// The next stdout line that is JSON and satisfies `want`; anything else is skipped.
async fn next_json(
    lines: &mut Lines<BufReader<ChildStdout>>,
    want: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    loop {
        let line = timeout(STEP, lines.next_line())
            .await
            .expect("the TypeScript peer went quiet")
            .expect("reading the TypeScript peer's stdout")
            .expect("the TypeScript peer ended early");
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line)
            && want(&value)
        {
            return value;
        }
    }
}

async fn next_event(
    events: &mut mpsc::Receiver<LinkEvent>,
    want: impl Fn(&LinkEvent) -> bool,
) -> LinkEvent {
    loop {
        let event = timeout(STEP, events.recv())
            .await
            .expect("the link went quiet")
            .expect("the driver ended early");
        if want(&event) {
            return event;
        }
    }
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

#[tokio::test]
async fn a_rust_device_converges_with_the_typescript_relay_and_peer() {
    let Some(bun) = find_bun() else {
        eprintln!("skipping: `bun` is not on PATH, and the TypeScript reference runs on it");
        return;
    };
    let mut child = Command::new(bun)
        .args(["run", "conformance/src/interop/relay-peer.ts"])
        .current_dir(repo_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("spawning bun");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stdin = child.stdin.take().unwrap();

    let ready = next_json(&mut lines, |v| v["ready"] == true).await;
    let url = ready["url"].as_str().unwrap().to_owned();
    let relay_key = PeerId::parse(ready["peerId"].as_str().unwrap()).unwrap();
    let ts_peer = PeerId::parse(ready["tsPeer"].as_str().unwrap()).unwrap();

    // the Rust device: one engine behind a mutex, one link pinned to the relay's key
    let seed = [42u8; 32];
    let engine = Arc::new(Mutex::new(
        Engine::open(
            Identity::from_seed(&seed),
            Box::new(MemoryEventStore::new()),
            None,
            EngineOptions::default(),
        )
        .unwrap(),
    ));
    let link = RelayLink::new(
        Identity::from_seed(&seed),
        RelayOptions {
            relay_key: Some(relay_key.clone()),
            reconnect_ms: 50,
            ..RelayOptions::default()
        },
    );
    let (commands, command_rx) = mpsc::channel(16);
    let (event_tx, mut events) = mpsc::channel(64);
    let driver = tokio::spawn(run_link(
        link,
        Arc::clone(&engine),
        format!("{url}/interop"),
        command_rx,
        event_tx,
    ));

    next_event(&mut events, |e| *e == LinkEvent::Online(true)).await;
    next_event(&mut events, |e| *e == LinkEvent::CaughtUp).await;

    // the TypeScript peer writes; the Rust engine folds it through the relay
    stdin
        .write_all(b"{\"write\":{\"key\":\"n1\",\"body\":\"hi\"}}\n")
        .await
        .unwrap();
    let wrote = next_json(&mut lines, |v| v["wrote"].is_string()).await;
    assert_eq!(
        wrote["wrote"].as_str().unwrap(),
        format!("{}-1", ts_peer.as_str())
    );
    let folded = next_event(&mut events, |e| matches!(e, LinkEvent::Folded(_))).await;
    let LinkEvent::Folded(batch) = folded else {
        unreachable!()
    };
    assert_eq!(batch.event_count, 1);
    assert!(batch.write_keys["notes"].contains("n1"));
    {
        let engine = engine.lock().unwrap();
        let row = engine.state().read_row("notes", "n1").expect("n1 folded");
        assert_eq!(row["body"], CellValue::text("hi"));
        assert_eq!(engine.cursors()[&ts_peer].get(), 1);
    }

    // the Rust device writes; the TypeScript peer folds it
    let entry = engine
        .lock()
        .unwrap()
        .mutate("notes.create", vec![insert("n2", "from rust")], None)
        .unwrap()
        .entry;
    commands.send(LinkCommand::Write(entry)).await.unwrap();
    let folded = next_json(&mut lines, |v| v["folded"].is_array()).await;
    let rows = folded["folded"].as_array().unwrap();
    assert!(
        rows.iter()
            .any(|r| r[0] == "notes" && r[1] == "n2" && r[2]["body"] == "from rust"),
        "{folded}"
    );

    // and the relay's key was the one both sides pinned
    stdin.write_all(b"{\"quit\":true}\n").await.unwrap();
    let status = timeout(STEP, child.wait())
        .await
        .expect("bun did not exit")
        .unwrap();
    assert!(status.success(), "the TypeScript peer exited with {status}");

    commands.send(LinkCommand::Stop).await.unwrap();
    timeout(STEP, driver)
        .await
        .expect("the driver did not stop")
        .unwrap();
    assert!(
        engine
            .lock()
            .unwrap()
            .state()
            .read_row("notes", "n2")
            .is_some()
    );
}
