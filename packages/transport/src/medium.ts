/**
 * What a medium is, and what it is doing — the two vocabularies a source is described by.
 *
 * Their own module because they are shared nouns rather than part of any one interface: a devtools
 * panel, a settings screen and a status fold all name a condition without ever holding a
 * `Transport`. Splitting them out also keeps `transport.ts` under its length cap, which is a real
 * constraint rather than a stylistic one — that file is the contract every adapter is written
 * against, and it grows every time a medium needs a new fact.
 */

/**
 * The medium behind a source. Central and peripheral BLE permissions are separate because the
 * platforms separate them, and a person can hold one without the other.
 */
export type TransportKind =
  | "ble"
  | "lan"
  | "awdl"
  | "wifi-aware"
  | "websocket"
  | "http"
  | "unknown";

/** What a source is doing, or why it is not (book ch. 18). `ok` is the only one that carries. */
export type TransportCondition =
  | "ok"
  | "connecting-failed"
  | "listen-failed"
  | "discovery-failed"
  | "radio-off"
  | "no-permission-central"
  | "no-permission-peripheral"
  | "no-hardware"
  | "backgrounded"
  | "temporarily-unavailable"
  | "unknown";
