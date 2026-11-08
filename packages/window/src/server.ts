import type { RetryPolicy } from "@syncmesh/temporal";

import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { bytesToHex, randomBytes } from "@syncmesh/wire";

import type { Draft, WindowBook } from "./book.js";
import type { Desire, RowPatch, StreamPosition, Undesire } from "./frames.js";
import type { ReadRequest } from "./request.js";
import type { Page, PageSource, ReadRefused } from "./source.js";

import { createWindowBook, emptyDraft, isEmpty } from "./book.js";
import { decodeWindowFrame, rowsFrame } from "./frames.js";
import { parseRequest, readKey } from "./request.js";
import { ReadFailed } from "./source.js";

export interface ServerWindowsOptions {
  /** Runs each window's read, already scoped to the reader this socket belongs to. */
  readonly source: PageSource;
  /** Where the encoded `rows` frames go: the socket's queue, never the raw socket (E12). */
  readonly send: (frame: Uint8Array) => void;
  /** A fresh epoch name. Each reset starts a new epoch, so a stale patch can never land. */
  readonly epoch?: () => string;
  /**
   * Windows one socket may hold at once. A desire for a new id past it is refused, so what the
   * server holds stays at most `maxWindows` pages whatever the client sends.
   * @default 64
   */
  readonly maxWindows?: number;
  /**
   * Rows one page may hold. A read that returns more is refused rather than sent, so a window
   * costs at most this many rows whatever its read asks for.
   * @default 1000
   */
  readonly maxRows?: number;
  /**
   * When a window whose read failed is read again. A commit to a table it reads re-reads it
   * sooner.
   * @default { first: 1 second, most: 30 seconds }
   */
  readonly retry?: RetryPolicy;
  /**
   * Hangs up the socket, once, when `send` throws. A patch that never left puts the client's
   * stream behind the server's for good, so the socket goes and the reconnect resnapshots.
   */
  readonly close?: (reason: string) => void;
}

/** The {@link ServerWindowsOptions.maxWindows} a socket takes when none is given. */
export const MAX_WINDOWS = 64;

/** The {@link ServerWindowsOptions.maxRows} a page takes when none is given. */
export const MAX_ROWS = 1000;

/** The {@link ServerWindowsOptions.retry} a socket takes when none is given. */
export const RETRY = {
  first: Temporal.Duration.from({ seconds: 1 }),
  most: Temporal.Duration.from({ seconds: 30 }),
} as const satisfies RetryPolicy;

/**
 * The server's half of one socket's windows (E27). A row reaches the client once, however many
 * of this socket's windows hold it, and is evicted when the last of them lets it go. Every change
 * leaves as one versioned patch (E24).
 *
 * Work runs one step at a time, so a patch always describes the step before it, whatever each
 * read costs. Work is coalesced while a step runs: a window's latest desire replaces any earlier
 * one not yet read, every commit since the last re-read is one re-read, and windows asking the
 * same read are read once. A re-read hands the source every read it needs at once
 * ({@link PageSource.readPages}). So a socket has at most one read in flight and one pending per
 * window, however many frames or commits arrive.
 *
 * A read that fails ({@link ReadFailed}) leaves its window holding the rows it had, marked
 * failed, and the window is read again after {@link ServerWindowsOptions.retry} or on the next
 * commit to a table it reads, whichever is first. A read that is refused closes the window.
 */
export interface ServerWindows {
  /**
   * Reads one frame off the socket and acts on a `desire` or `undesire`. Returns `false` for a
   * frame that is not one of those, which the socket's other reader handles.
   */
  readonly receive: (bytes: Uint8Array) => boolean;
  /** Distinct rows this socket's windows hold: what the server keeps for it. */
  readonly held: () => number;
  /** Resolves once every frame received and every commit seen so far has been answered. */
  readonly idle: () => Promise<void>;
  /** Stops listening for commits. A stopped socket reads nothing more and sends nothing more. */
  readonly stop: () => void;
}

/**
 * What a window's frames have asked for and no step has acted on: only the latest counts, but a
 * resync's `since` is kept by whatever replaces it, as the reset it asked for is still owed.
 */
type Want =
  | { readonly kind: "desire"; readonly text: string; readonly since: StreamPosition | undefined }
  | { readonly kind: "undesire"; readonly since: StreamPosition | undefined };

const freshEpoch = (): string => bytesToHex(randomBytes(8));

const causeMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

/** A client that names a position this stream is not at missed a patch, and is resnapshot. */
const missed = (since: StreamPosition | undefined, at: StreamPosition | undefined): boolean =>
  since !== undefined &&
  (at === undefined || since.epoch !== at.epoch || since.version !== at.version);

type Answer = Result<Page, ReadRefused | ReadFailed>;

/** A source that throws rather than answering is one that could not run the read. */
const unran = (cause: unknown) =>
  new ReadFailed({ message: causeMessage(cause, "the read failed") });

/** One read's page. */
const readOne = async (source: PageSource, request: ReadRequest): Promise<Answer> =>
  (await Result.tryPromise({ try: () => source.readPage(request), catch: unran })).andThen(
    (page) => page,
  );

/** Several reads' pages in order: at once when the source can, one by one when it cannot. */
const readAll = async (
  source: PageSource,
  requests: readonly ReadRequest[],
): Promise<readonly Answer[]> => {
  const { readPages } = source;
  if (readPages === undefined || requests.length < 2) {
    const answers: Answer[] = [];
    for (const request of requests) answers.push(await readOne(source, request));
    return answers;
  }
  const read = await Result.tryPromise({ try: () => readPages(requests), catch: unran });
  // a source that answers a different number of reads answered none of them
  if (read.isOk() && read.value.length === requests.length) return read.value;
  const failed = read.isErr() ? read.error : unran(new Error("the reads were not all answered"));
  return requests.map(() => Result.err(failed));
};

/**
 * The patch a draft becomes at `at`: a reset carrying the whole book when the draft asks for one
 * or nothing was sent yet, the next version otherwise, and nothing for a draft with nothing in it.
 */
const nextPatch = (
  draft: Draft,
  at: StreamPosition | undefined,
  nextEpoch: () => string,
  book: WindowBook,
): RowPatch | undefined => {
  if (draft.reset || at === undefined)
    return {
      epoch: nextEpoch(),
      version: 1,
      reset: true,
      dels: [],
      refused: draft.refused,
      ...book.whole(),
    };
  if (isEmpty(draft)) return undefined;
  return {
    epoch: at.epoch,
    version: at.version + 1,
    reset: false,
    puts: [...draft.puts.values()],
    dels: [...draft.dels.values()],
    windows: [...draft.windows.values()],
    refused: draft.refused,
    failed: [...draft.failed.values()],
  };
};

/** Keeps a window's latest frame; a resync's `since` survives any later frame, as the reset is still owed. */
const coalesce = (wanted: Map<string, Want>, frame: Desire | Undesire): void => {
  const owed = wanted.get(frame.id)?.since;
  if (frame.kind === "undesire") wanted.set(frame.id, { kind: "undesire", since: owed });
  else wanted.set(frame.id, { kind: "desire", text: frame.request, since: frame.since ?? owed });
};

export function createServerWindows(options: ServerWindowsOptions): ServerWindows {
  const {
    source,
    send,
    close,
    epoch: nextEpoch = freshEpoch,
    maxWindows = MAX_WINDOWS,
    maxRows = MAX_ROWS,
    retry = RETRY,
  } = options;
  /** Frames not yet acted on, one per window, in the order each window first asked. */
  const wanted = new Map<string, Want>();
  /** Tables committed since the last re-read began; one re-read answers every commit behind it. */
  const dirty = new Set<string>();
  /** Failed windows whose wait is over. */
  const due = new Set<string>();
  /** A new change feed may have missed any commit, so every window is read again. */
  let everything = false;
  /** Why the change feed is down, while it is: no commit is heard, so every window is failed. */
  let feedLost: string | undefined;
  /** The feed went down and the windows have not been told. */
  let lossUntold = false;
  let position: StreamPosition | undefined;
  let stopped = false;
  let working: Promise<void> | undefined;
  const book = createWindowBook({
    maxRows,
    retry,
    feedLost: () => feedLost,
    due: (id) => {
      due.add(id);
      pump();
    },
  });

  const halt = (): void => {
    stopped = true;
    unsubscribe();
    unfeed?.();
    book.stop();
    wanted.clear();
  };

  const transmit = (patch: RowPatch): void => {
    position = { epoch: patch.epoch, version: patch.version };
    const sent = Result.try({
      try: () => send(rowsFrame(patch)),
      catch: (cause) => causeMessage(cause, "the socket would not take a patch"),
    });
    if (sent.isOk()) return;
    halt();
    close?.(sent.error);
  };

  const readPage = (request: ReadRequest) => readOne(source, request);

  const flush = (draft: Draft): void => {
    const patch = stopped ? undefined : nextPatch(draft, position, nextEpoch, book);
    if (patch !== undefined) transmit(patch);
  };

  const desire = async (id: string, want: Extract<Want, { kind: "desire" }>): Promise<void> => {
    const draft = emptyDraft();
    const request = parseRequest(want.text);
    if (request.isErr()) {
      book.unplace(draft, id);
      draft.refused.push({ id, reason: request.error.message });
    } else if (!book.has(id) && book.count() >= maxWindows)
      draft.refused.push({ id, reason: `a socket holds at most ${maxWindows} windows` });
    else book.settle(draft, id, request.value, await readPage(request.value));
    draft.reset = missed(want.since, position);
    flush(draft);
  };

  /** Re-reads every window a commit touched, every failed one whose wait is over, or every one. */
  const reread = async (): Promise<void> => {
    const targets = book.targets(new Set(dirty), new Set(due), everything);
    dirty.clear();
    due.clear();
    everything = false;
    // a commit that touches no open window sends nothing, so an idle socket is sent nothing
    if (targets.size === 0) return;
    const draft = emptyDraft();
    // two windows asking the same read are read once, and every read is asked at once
    const distinct = new Map<string, ReadRequest>();
    for (const request of targets.values()) distinct.set(readKey(request), request);
    const keys = [...distinct.keys()];
    const answers = await readAll(source, [...distinct.values()]);
    const pages = new Map(keys.map((key, n) => [key, answers[n]]));
    for (const [id, request] of targets) {
      const page = pages.get(readKey(request)) ?? Result.err(unran(new Error("no answer")));
      book.settle(draft, id, request, page);
    }
    flush(draft);
  };

  /** One step of whatever is waiting, desires first; `false` when nothing was. */
  const step = async (): Promise<boolean> => {
    const [first] = wanted;
    if (first !== undefined) {
      const [id, want] = first;
      wanted.delete(id);
      if (want.kind === "desire") await desire(id, want);
      else {
        const draft = emptyDraft();
        book.unplace(draft, id);
        draft.reset = missed(want.since, position);
        flush(draft);
      }
    } else if (lossUntold) {
      lossUntold = false;
      // the windows keep their rows, failed, until the feed is back
      const draft = emptyDraft();
      if (feedLost !== undefined) book.failAll(draft, feedLost);
      flush(draft);
    } else if (dirty.size > 0 || everything || due.size > 0) await reread();
    else return false;
    return true;
  };

  const drain = async (): Promise<void> => {
    let more = true;
    while (more && !stopped) more = await step();
  };

  const waiting = (): boolean =>
    wanted.size > 0 || lossUntold || dirty.size > 0 || everything || due.size > 0;

  /** Starts working through what is waiting, unless a step already is. */
  const pump = (): void => {
    if (working !== undefined || stopped) return;
    working = Result.tryPromise({
      try: drain,
      catch: (cause) => causeMessage(cause, "a step failed"),
    }).then((done) => {
      working = undefined;
      // a step that threw has left the stream in no known state: hang up rather than guess
      if (done.isErr()) {
        halt();
        close?.(done.error);
      } else if (waiting()) pump();
    });
  };

  const unsubscribe = source.onCommit((tables) => {
    // kept even with no window open: a desire whose read is in flight may have read before
    // this commit, and the re-read behind it is what catches that
    for (const table of tables) dirty.add(table);
    pump();
  });

  const unfeed = source.onFeed?.((state) => {
    feedLost = state.kind === "lost" ? state.reason : undefined;
    lossUntold = state.kind === "lost";
    everything ||= state.kind === "resumed";
    pump();
  });

  return {
    receive: (bytes) => {
      const frame = decodeWindowFrame(bytes);
      // a malformed window frame is consumed and changes nothing: there is no window to name
      if (frame.isErr()) return true;
      const { value } = frame;
      if (value === undefined || value.kind === "rows") return false;
      if (!stopped) {
        coalesce(wanted, value);
        pump();
      }
      return true;
    },
    held: book.held,
    idle: async () => {
      // a step can start another (a commit seen mid-read), so wait until none is running
      while (working !== undefined) await working;
    },
    stop: halt,
  };
}
