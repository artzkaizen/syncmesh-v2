import Foundation
import Network

/// The 64 ASCII characters a peer puts on the wire to say who it is.
///
/// A peer id is 64 hex characters, which is one byte past the 63 a Bonjour instance name allows —
/// so the instance name is a digest of it and the id itself travels in the TXT record and, on an
/// accepted connection, as a fixed-length prologue. See `AwdlEngine` for why the prologue exists
/// at all: an inbound peer-to-peer connection arrives from a link-local address with no
/// back-reference to the instance that advertised it, and nothing in Network framework resolves
/// one to the other.
let announceLength = 64

/// One open data path, and everything about it that is this module's rather than the transport's.
///
/// The transport above does framing, the handshake and the door. What is left here is the part a
/// bridge has to do and a socket does not: hold what arrives until JavaScript is listening, and
/// report a close exactly once.
final class P2pPath {
  let handle: String
  /// The id JavaScript knows this peer by — **the same one `onPeerFound` reported**, so a peer
  /// going out of range closes the paths that belong to it.
  let peer: String
  let radio: String
  private let connection: NWConnection
  private let queue: DispatchQueue

  /// What arrived before JavaScript said it was reading.
  ///
  /// The stream starts paused because the peer's hello is already in flight when a path opens, and
  /// an event emitted before anyone subscribed is an event nobody receives. Expo installs
  /// `OnStartObserving` on a module and never on a class, so a per-path object cannot infer this —
  /// it is told, once, by `resume`.
  private var paused = true
  private var backlog: [Data] = []
  private var closePending = false
  private(set) var closed = false

  /// Handed up as events; assigned by the module, which owns the emitter.
  var onData: ((Data) -> Void)?
  var onClosed: (() -> Void)?

  init(handle: String, peer: String, radio: String, connection: NWConnection, queue: DispatchQueue) {
    self.handle = handle
    self.peer = peer
    self.radio = radio
    self.connection = connection
    self.queue = queue
  }

  /// Starts reading immediately, whether or not anybody is listening yet.
  func start() {
    receive()
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) {
      [weak self] content, _, isComplete, error in
      guard let self else { return }
      self.queue.async {
        if let content, !content.isEmpty { self.deliver(content) }
        if let error {
          self.finish(because: error)
          return
        }
        if isComplete {
          self.finish(because: nil)
          return
        }
        if !self.closed { self.receive() }
      }
    }
  }

  private func deliver(_ chunk: Data) {
    if paused {
      backlog.append(chunk)
      return
    }
    onData?(chunk)
  }

  /// JavaScript is reading: everything held goes now, oldest first, and the path goes live.
  func resume() {
    guard paused else { return }
    paused = false
    let waiting = backlog
    backlog.removeAll()
    for chunk in waiting { onData?(chunk) }
    if closePending {
      closePending = false
      onClosed?()
    }
  }

  /// Writes, and reports whether the bytes actually left.
  ///
  /// `.contentProcessed` is the transport's own verdict — it fires when the stack has taken the
  /// bytes and carries an error when it has not. **Never `.idempotent`**, which discards that
  /// verdict: a write that silently went nowhere is how two devices come to believe different
  /// things, and the whole bridge above is built on a failure being loud.
  func send(_ bytes: Data, done: @escaping (Error?) -> Void) {
    if closed {
      done(P2pPathClosedException(handle))
      return
    }
    connection.send(
      content: bytes,
      contentContext: .defaultMessage,
      isComplete: true,
      completion: .contentProcessed { error in done(error) }
    )
  }

  /// Ends the path here and at the platform. Idempotent — a close is reported exactly once.
  func close() {
    finish(because: nil)
  }

  private func finish(because error: Error?) {
    guard !closed else { return }
    closed = true
    connection.cancel()
    // a close that fired into nobody is a close the transport never hears, and it would hold a
    // dead link until a liveness deadline expired; so it waits for a reader like the bytes do
    if paused {
      closePending = true
      return
    }
    onClosed?()
  }
}
