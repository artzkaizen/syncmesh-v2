//! The folded state: table → key → record.

use std::collections::BTreeMap;

use crate::event::{PartitionKey, RowKey, TableName};
use crate::record::{Row, RowRecord};

pub type TableState = BTreeMap<RowKey, RowRecord>;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct State {
    pub tables: BTreeMap<TableName, TableState>,
}

impl State {
    pub fn new() -> State {
        State::default()
    }

    pub fn record(&self, table: &str, key: &str) -> Option<&RowRecord> {
        self.tables.get(table)?.get(key)
    }

    /// The row's current values, or `None` when it is absent or deleted.
    pub fn read_row(&self, table: &str, key: &str) -> Option<Row> {
        let record = self.record(table, key)?;
        record.is_visible().then(|| record.values())
    }

    /// Every visible row of the table.
    pub fn read_rows(&self, table: &str) -> BTreeMap<RowKey, Row> {
        self.tables
            .get(table)
            .into_iter()
            .flatten()
            .filter(|(_, r)| r.is_visible())
            .map(|(k, r)| (k.clone(), r.values()))
            .collect()
    }

    /// Every visible row of the table that belongs to `partition`.
    pub fn read_rows_in(&self, table: &str, partition: &PartitionKey) -> BTreeMap<RowKey, Row> {
        self.tables
            .get(table)
            .into_iter()
            .flatten()
            .filter(|(_, r)| r.partition.as_deref() == Some(partition.as_str()) && r.is_visible())
            .map(|(k, r)| (k.clone(), r.values()))
            .collect()
    }
}
