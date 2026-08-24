export type {
  EventId,
  PartitionKey,
  Procedure,
  ProtocolVersion,
  SeqNum,
  SyncEvent,
} from "./event.js";
export {
  InvalidEventId,
  InvalidSeqNum,
  eventId,
  parseEventId,
  parseSeqNum,
  stampOf,
} from "./event.js";
