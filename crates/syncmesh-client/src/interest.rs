//! What a device wants from a room (`engine/src/interest.ts`), so a sender drops the rest before
//! it becomes bytes. An interest **narrows** and never widens: it is a request, not a permission.
//! Partitions and nothing finer (book ch. 3): a device holds a partition entire or not at all.

use syncmesh_core::event::{PartitionKey, SyncEvent};

/// Only these instances; `None` is every instance the policy already allows.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Interest {
    pub partitions: Option<Vec<PartitionKey>>,
}

impl Interest {
    /// Nothing narrowed: the sender filters nothing.
    pub const EVERYTHING: Interest = Interest { partitions: None };

    pub fn partitions<I: IntoIterator<Item = PartitionKey>>(partitions: I) -> Interest {
        Interest {
            partitions: Some(partitions.into_iter().collect()),
        }
    }

    fn is_everything(&self) -> bool {
        self.partitions.is_none()
    }
}

/// An interest as wire text — `JSON.stringify(interest)` exactly, so the join a Rust device sends
/// re-encodes to the same core a TypeScript device would sign: `""` for none, `{}` for
/// everything, `{"partitions":["org:acme"]}` otherwise. Key order is the TypeScript object's.
pub fn interest_text(interest: Option<&Interest>) -> String {
    match interest {
        None => String::new(),
        Some(Interest { partitions: None }) => "{}".to_owned(),
        Some(Interest {
            partitions: Some(list),
        }) => {
            let items: Vec<serde_json::Value> = list
                .iter()
                .map(|p| serde_json::Value::String(p.as_str().to_owned()))
                .collect();
            serde_json::json!({ "partitions": items }).to_string()
        }
    }
}

/// The interest some text carried, or `None` for text that named none. Junk is `None` too,
/// deliberately: an unreadable request falls back to "everything", never to "nothing".
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
    Some(Interest { partitions })
}

/// Whether one event is in the partitions the asker named.
pub fn matches_interest(interest: Option<&Interest>, event: &SyncEvent) -> bool {
    match interest.and_then(|i| i.partitions.as_ref()) {
        None => true,
        Some(list) => event.partition.as_ref().is_some_and(|p| list.contains(p)),
    }
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
    match (&next.partitions, &previous.partitions) {
        (_, None) => true,
        (None, Some(_)) => false,
        (Some(n), Some(p)) => n.iter().all(|x| p.contains(x)),
    }
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
