import Foundation
import Network

/// A local network, as the two halves the transport asks for.
///
/// **Announcements on a multicast group, frames on a stream.** They are separate because a LAN is:
/// a datagram is cheap, lossy and repeats, which is exactly right for *I am here, dial me at this
/// port*; a frame must arrive, in order, or a silently dropped one is divergence rather than a
/// resync. One socket carrying both would make the second as unreliable as the first.
///
/// This is the same port `adapters/lan-node` satisfies with `dgram` and `net`, which is the point:
/// a phone and a laptop on one access point are peers on one transport, and the relay under Node
/// meets the app on a handset with nothing in between.
final class LanEngine {
  private let queue: DispatchQueue
  private weak var reporter: LanReporting?

  private var group: NWConnectionGroup?
  private var listener: NWListener?
  /// The port the listener actually got. Asked for zero — a fixed one is a second app failing.
  private(set) var port: UInt16 = 0

  init(queue: DispatchQueue, reporter: LanReporting) {
    self.queue = queue
    self.reporter = reporter
  }

  /// Every build has sockets; there is no capability to query the way a radio has.
  static var isAvailable: Bool { true }

  /// Joins the group and starts listening, and answers with the port peers should be told.
  func start(group host: String, groupPort: UInt16) throws -> UInt16 {
    stop()

    let listening = try NWListener(using: .tcp, on: .any)
    listening.newConnectionHandler = { [weak self] connection in
      self?.queue.async { self?.accept(connection) }
    }
    listening.stateUpdateHandler = { [weak self] state in
      // `.waiting` is a network coming up, not a failure — reporting it would make every cold
      // start look broken
      if case let .failed(error) = state {
        self?.reporter?.lanFailed(describe(error))
      }
    }
    listening.start(queue: queue)
    listener = listening

    guard let multicast = try? NWMulticastGroup(for: [.hostPort(host: .init(host), port: .init(integerLiteral: groupPort))]) else {
      throw P2pInvalidArgumentException("\(host):\(groupPort) is not a multicast group")
    }
    let joined = NWConnectionGroup(with: multicast, using: .udp)
    joined.setReceiveHandler(maximumMessageSize: 8192, rejectOversizedMessages: true) {
      [weak self] message, content, _ in
      guard let self, let content, !content.isEmpty else { return }
      // where the datagram actually came from, which is the address that can be dialled back —
      // not what the announcement claimed, since one of the two is cheap to forge
      guard case let .hostPort(from, fromPort)? = message.remoteEndpoint else { return }
      self.queue.async {
        self.reporter?.heard(
          content, host: Self.plain(from), port: Int(fromPort.rawValue))
      }
    }
    joined.stateUpdateHandler = { [weak self] state in
      if case let .failed(error) = state { self?.reporter?.lanFailed(describe(error)) }
    }
    joined.start(queue: queue)
    self.group = joined

    // the listener's port is assigned asynchronously; nothing may announce before it exists, and
    // the caller holds the promise until it does
    port = listening.port?.rawValue ?? 0
    return port
  }

  /// An interface-scoped address arrives as `fe80::1%en0`; the scope is this device's, not the peer's.
  private static func plain(_ host: NWEndpoint.Host) -> String {
    let text = String(describing: host)
    return text.split(separator: "%").first.map(String.init) ?? text
  }

  /// One announcement onto the group. Lossy by nature — they repeat, so a lost one costs a beat.
  func announce(_ bytes: Data) {
    group?.send(content: bytes) { _ in }
  }

  func dial(host: String, port: UInt16, handle: String, done: @escaping (Result<P2pPath, Error>) -> Void) {
    let connection = NWConnection(
      host: .init(host), port: .init(integerLiteral: port), using: .tcp)
    var settled = false
    connection.stateUpdateHandler = { [weak self] state in
      guard let self, !settled else { return }
      switch state {
      case .ready:
        settled = true
        done(
          .success(
            P2pPath(
              handle: handle, peer: "\(host):\(port)", radio: "lan", connection: connection,
              queue: self.queue)))
      case let .failed(error):
        settled = true
        connection.cancel()
        done(.failure(P2pPeerUnreachableException(describe(error))))
      case .cancelled:
        settled = true
        done(.failure(P2pPeerUnreachableException("the dial was cancelled")))
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  /// A peer dialled us. No prologue here: on a LAN the transport already knows who it dialled,
  /// and an accepted socket is named by its own address, which is dialable and is not a claim.
  private func accept(_ connection: NWConnection) {
    connection.stateUpdateHandler = { [weak self] state in
      if case let .failed(error) = state {
        self?.reporter?.lanFailed(describe(error))
        connection.cancel()
      }
    }
    connection.start(queue: queue)
    var host = ""
    var port = 0
    if case let .hostPort(from, fromPort) = connection.endpoint {
      host = Self.plain(from)
      port = Int(fromPort.rawValue)
    }
    let path = P2pPath(
      handle: UUID().uuidString, peer: "\(host):\(port)", radio: "lan", connection: connection,
      queue: queue)
    reporter?.lanAccepted(path, host: host, port: port)
  }

  func stop() {
    listener?.cancel()
    listener = nil
    group?.cancel()
    group = nil
    port = 0
  }
}

/// What the LAN engine reports upward; the module turns each into one JavaScript event.
protocol LanReporting: AnyObject {
  func heard(_ bytes: Data, host: String, port: Int)
  func lanAccepted(_ path: P2pPath, host: String, port: Int)
  func lanFailed(_ why: String)
}
