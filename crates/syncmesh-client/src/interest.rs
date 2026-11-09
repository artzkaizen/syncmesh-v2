//! What a device wants from a room (`engine/src/interest.ts`), so a sender drops the rest before
//! it becomes bytes. An interest **narrows** and never widens: it is a request, not a permission.
//! Partitions and nothing finer (book ch. 3): a device holds a partition entire or not at all. A
//! snapshot alone can be windowed to the newest rows of its slice (RFC-0019 §3).

use syncmesh_core::event::{PartitionKey, SyncEvent};
use syncmesh_core::snapshot_codec::SnapshotRow;
use syncmesh_core::stamp::Stamp;

/// Only these instances; `None` is every instance the policy already allows.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Interest {
    pub partitions: Option<Vec<PartitionKey>>,
    /// Only the newest rows of the slice, for a snapshot; `None` is every row. Events are never
    /// windowed, and a coverage adopted under a window claims nothing about the rows outside it,
    /// so dropping or growing the window re-pages them (D23).
    pub window: Option<InterestWindow>,
}

/// How many rows a windowed snapshot carries (`InterestWindow`): the `newest` live rows of its
/// slice by each row's newest stamp, plus every tombstone in the slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InterestWindow {
    /// A positive whole number of live rows.
    pub newest: u64,
}

impl Interest {
    /// Nothing narrowed: the sender filters nothing.
    pub const EVERYTHING: Interest = Interest {
        partitions: None,
        window: None,
    };

    pub fn partitions<I: IntoIterator<Item = PartitionKey>>(partitions: I) -> Interest {
        Interest {
            partitions: Some(partitions.into_iter().collect()),
            window: None,
        }
    }

    /// The same interest, its snapshots windowed to the `newest` live rows.
    #[must_use]
    pub fn windowed(self, newest: u64) -> Interest {
        Interest {
            window: Some(InterestWindow { newest }),
            ..self
        }
    }

    fn is_everything(&self) -> bool {
        self.partitions.is_none() && self.window.is_none()
    }
}

/// An interest's fields as JSON members in their one order — `partitions`, then `window` — which
/// is the order the TypeScript's `interestText` writes them in. Written by hand: a JSON map here
/// sorts its keys, and `entitlement` must follow them.
fn interest_members(interest: &Interest) -> Vec<String> {
    let mut members = Vec::new();
    if let Some(list) = &interest.partitions {
        let items: Vec<&str> = list.iter().map(PartitionKey::as_str).collect();
        members.push(format!("\"partitions\":{}", serde_json::json!(items)));
    }
    if let Some(window) = interest.window {
        members.push(format!("\"window\":{{\"newest\":{}}}", window.newest));
    }
    members
}

/// An interest as wire text — the TypeScript's `interestText` exactly, so the join a Rust device
/// sends re-encodes to the same core a TypeScript device would sign: `""` for none, `{}` for
/// everything, `{"partitions":["org:acme"],"window":{"newest":50}}` otherwise.
pub fn interest_text(interest: Option<&Interest>) -> String {
    interest.map_or_else(String::new, |interest| {
        format!("{{{}}}", interest_members(interest).join(","))
    })
}

/// A scope as the TypeScript relay's `scopeText` writes it (D23, D24): the interest's text, or
/// with an entitlement the interest's fields and then `entitlement`.
pub fn scope_text(interest: Option<&Interest>, entitlement: Option<&str>) -> String {
    let Some(entitlement) = entitlement else {
        return interest_text(interest);
    };
    let mut members = interest_members(interest.unwrap_or(&Interest::EVERYTHING));
    members.push(format!(
        "\"entitlement\":{}",
        serde_json::json!(entitlement)
    ));
    format!("{{{}}}", members.join(","))
}

/// The largest whole number a JSON reader in JavaScript holds exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A window as the wire carried it, or `None` for one this build cannot read (`parseWindow`).
fn parse_window(value: &serde_json::Value) -> Option<InterestWindow> {
    let newest = value.as_object()?.get("newest")?.as_f64()?;
    let whole = newest.fract() == 0.0 && newest > 0.0 && newest <= MAX_SAFE_INTEGER;
    // a positive whole number at most 2^53 - 1 fits a u64 exactly
    whole.then_some(InterestWindow {
        newest: newest as u64,
    })
}

/// The interest some text carried, or `None` for text that named none. Junk is `None` too,
/// deliberately: an unreadable request falls back to "everything", never to "nothing". A window
/// this build cannot read is dropped for the same reason: no window is the wider request.
pub fn interest_from(text: Option<&str>) -> Option<Interest> {
    let text = text?;
    if text.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let partitions = match object.get("partitions") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Array(items)) => Some(
            items
                .iter()
                .filter_map(|v| v.as_str())
                .filter_map(|s| PartitionKey::parse(s).ok())
                .collect(),
        ),
        // a list that is not a list is a request this build cannot read: everything, not nothing
        Some(_) => return None,
    };
    let window = object.get("window").and_then(parse_window);
    Some(Interest { partitions, window })
}

/// The rows a window keeps (`windowRows`, RFC-0019 §3): the `newest` live rows by each row's
/// newest stamp, ties broken by table and then key, and every tombstone whatever its age. The rows
/// keep the order they came in.
pub fn window_rows(rows: Vec<SnapshotRow>, window: InterestWindow) -> Vec<SnapshotRow> {
    let mut ranked: Vec<(usize, Option<&Stamp>)> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.record.is_visible())
        .map(|(i, row)| (i, newest_stamp(&row.record)))
        .collect();
    ranked.sort_by(|(a, sa), (b, sb)| {
        // newest first, a row with no stamp last; then table, then key, by code point
        sb.cmp(sa)
            .then_with(|| rows[*a].table.cmp(&rows[*b].table))
            .then_with(|| rows[*a].key.cmp(&rows[*b].key))
    });
    let take = usize::try_from(window.newest).unwrap_or(usize::MAX);
    let kept: std::collections::BTreeSet<usize> =
        ranked.into_iter().take(take).map(|(i, _)| i).collect();
    rows.into_iter()
        .enumerate()
        .filter(|(i, row)| kept.contains(i) || !row.record.is_visible())
        .map(|(_, row)| row)
        .collect()
}

/// The latest stamp anywhere in a record: its write, its delete, or any cell's.
fn newest_stamp(record: &syncmesh_core::record::RowRecord) -> Option<&Stamp> {
    record
        .write_stamp
        .iter()
        .chain(record.delete_stamp.iter())
        .chain(record.cells.values().map(|cell| &cell.stamp))
        .max()
}

/// Whether one event is in the partitions the asker named.
///
/// An **unpinned** event matches every interest (D24), as `matchesInterest` does: it is about the
/// mesh rather than about an instance — a `global` row, an authority-visibility row — so "only
/// rows in these instances" says nothing about it.
pub fn matches_interest(interest: Option<&Interest>, event: &SyncEvent) -> bool {
    match (
        interest.and_then(|i| i.partitions.as_ref()),
        &event.partition,
    ) {
        (None, _) | (_, None) => true,
        (Some(list), Some(p)) => list.contains(p),
    }
}

/// Whether a row is in the partitions the asker named (`rowsIn`): an unpinned row is in no
/// instance, so a clause about instances says nothing about it (D24).
pub fn rows_in(record: &syncmesh_core::record::RowRecord, interest: Option<&Interest>) -> bool {
    match (
        interest.and_then(|i| i.partitions.as_ref()),
        &record.partition,
    ) {
        (None, _) | (_, None) => true,
        (Some(list), Some(p)) => list.iter().any(|k| k.as_str() == p),
    }
}

/// The two halves of a scope as the TypeScript relay's `scopeText` writes them (D23, D24): the
/// interest the device asked with, and the entitlement the relay admitted it under.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Scope {
    pub interest: Option<Interest>,
    /// The entitlement the cursors were earned under; `None`, the relay withheld nothing.
    pub entitlement: Option<String>,
}

/// A scope's two halves back (`scopeFrom`). An interest-only text — every scope written before
/// D24 — reads as that interest and no entitlement; junk reads as no scope at all.
pub fn scope_from(text: Option<&str>) -> Scope {
    let interest = interest_from(text);
    let entitlement = text
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| v.get("entitlement")?.as_str().map(str::to_owned));
    // `{}` beside an entitlement is the relay writing back "no interest", not an interest of `{}`
    let interest = match (&entitlement, interest) {
        (Some(_), Some(interest)) if interest.is_everything() => None,
        (_, interest) => interest,
    };
    Scope {
        interest,
        entitlement,
    }
}

/// Whether two interests ask for the same slice however they were spelled (`sameInterest`):
/// `None` and [`Interest::EVERYTHING`] are one request, and so are one list in two orders.
pub fn same_interest(a: Option<&Interest>, b: Option<&Interest>) -> bool {
    type Key<'a> = (Option<Vec<&'a str>>, Option<u64>);
    fn key(i: Option<&Interest>) -> Key<'_> {
        let Some(i) = i else { return (None, None) };
        let sorted = i.partitions.as_ref().map(|list| {
            let mut sorted: Vec<&str> = list.iter().map(PartitionKey::as_str).collect();
            sorted.sort_unstable();
            sorted
        });
        (sorted, i.window.map(|w| w.newest))
    }
    key(a) == key(b)
}

/// Whether `next` provably admits nothing `previous` did not — the test that lets a device keep a
/// scoped cursor through an interest change (D23). Unsure answers `false`: a wrong `true` skips
/// events forever, a wrong `false` costs one re-join.
pub fn narrows(next: Option<&Interest>, previous: Option<&Interest>) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if previous.is_everything() {
        return true;
    }
    let Some(next) = next else { return false };
    let partitions = match (&next.partitions, &previous.partitions) {
        (_, None) => true,
        (None, Some(_)) => false,
        (Some(n), Some(p)) => n.iter().all(|x| p.contains(x)),
    };
    // no window is every row, the widest a window can be; a smaller count narrows
    let window = match (next.window, previous.window) {
        (_, None) => true,
        (None, Some(_)) => false,
        (Some(n), Some(p)) => n.newest <= p.newest,
    };
    partitions && window
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> PartitionKey {
        PartitionKey::parse(s).unwrap()
    }

    #[test]
    fn text_matches_json_stringify() {
        assert_eq!(interest_text(None), "");
        assert_eq!(interest_text(Some(&Interest::EVERYTHING)), "{}");
        assert_eq!(
            interest_text(Some(&Interest::partitions([
                key("org:acme"),
                key("org:globex")
            ]))),
            r#"{"partitions":["org:acme","org:globex"]}"#
        );
    }

    #[test]
    fn text_round_trips_and_junk_is_everything() {
        let acme = Interest::partitions([key("org:acme")]);
        assert_eq!(interest_from(Some(&interest_text(Some(&acme)))), Some(acme));
        assert_eq!(interest_from(Some("{}")), Some(Interest::EVERYTHING));
        assert_eq!(interest_from(Some("")), None);
        assert_eq!(interest_from(Some("not json")), None);
        assert_eq!(interest_from(None), None);
    }

    #[test]
    fn an_unpinned_event_matches_every_interest() {
        use syncmesh_core::event::{PeerId, SeqNum};
        use syncmesh_core::hlc::Hlc;
        let pinned = |partition: Option<PartitionKey>| SyncEvent {
            peer_id: PeerId::parse(&syncmesh_core::to_hex(&[1; 32])).unwrap(),
            seq_num: SeqNum::parse(1).unwrap(),
            hlc: Hlc::new(1, 0),
            procedure: "t".into(),
            partition,
            changes: vec![],
            sealed: false,
            action: None,
            undo_of: None,
            schema_version: None,
        };
        let acme = Interest::partitions([key("org:acme")]);
        assert!(matches_interest(
            Some(&acme),
            &pinned(Some(key("org:acme")))
        ));
        assert!(!matches_interest(
            Some(&acme),
            &pinned(Some(key("org:globex")))
        ));
        assert!(matches_interest(Some(&acme), &pinned(None)));
        assert!(matches_interest(
            Some(&Interest::partitions([])),
            &pinned(None)
        ));
        assert!(matches_interest(None, &pinned(None)));
    }

    #[test]
    fn scope_reads_both_halves_as_the_typescript_writes_them() {
        let acme = Interest::partitions([key("org:acme")]);
        assert_eq!(
            scope_from(Some(
                r#"{"partitions":["org:acme"],"entitlement":"clinic:a"}"#
            )),
            Scope {
                interest: Some(acme.clone()),
                entitlement: Some("clinic:a".into()),
            }
        );
        assert_eq!(
            scope_from(Some(r#"{"entitlement":"clinic:a"}"#)),
            Scope {
                interest: None,
                entitlement: Some("clinic:a".into()),
            }
        );
        assert_eq!(
            scope_from(Some(r#"{"partitions":["org:acme"]}"#)),
            Scope {
                interest: Some(acme),
                entitlement: None,
            }
        );
        assert_eq!(scope_from(None), Scope::default());
    }

    #[test]
    fn same_interest_ignores_spelling() {
        let ab = Interest::partitions([key("org:a"), key("org:b")]);
        let ba = Interest::partitions([key("org:b"), key("org:a")]);
        assert!(same_interest(Some(&ab), Some(&ba)));
        assert!(same_interest(None, Some(&Interest::EVERYTHING)));
        assert!(!same_interest(Some(&ab), None));
    }

    #[test]
    fn narrowing_is_conservative() {
        let acme = Interest::partitions([key("org:acme")]);
        let both = Interest::partitions([key("org:acme"), key("org:globex")]);
        assert!(narrows(Some(&acme), None));
        assert!(narrows(None, Some(&Interest::EVERYTHING)));
        assert!(narrows(Some(&acme), Some(&both)));
        assert!(!narrows(Some(&both), Some(&acme)));
        assert!(!narrows(None, Some(&acme)));
    }
}
