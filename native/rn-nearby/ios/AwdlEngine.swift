import CryptoKit
import Foundation
import Network

/// What an engine reports upward. The module turns each of these into one JavaScript event.
protocol P2pReporting: AnyObject {
  func peerFound(radio: String, id: String, announces: Data)
  func peerLost(radio: String, id: String)
  func pathOpened(_ path: P2pPath)
  func failed(radio: String, why: String)
}

/// Apple peer-to-peer Wi-Fi — AWDL — as the fabric the mesh asked for.
///
/// Apple's own words are that *"AWDL is an implementation detail, not an API"*; what is public is
/// `NWParameters.includePeerToPeer`, which lets a Bonjour service be found and dialled with no
/// access point, no router and no network at all. That is the whole reason this file exists.
///
/// **One fixed service type, and the room in the TXT record.** The obvious design — a Bonjour type
/// per room — cannot work: iOS 14 and later will only browse a type listed in `NSBonjourServices`,
/// and that list admits no wildcard, so a type computed at runtime is a type the system refuses to
/// look for. The room is therefore a client-side filter over one declared type.
final class AwdlEngine {
  static let radio = "awdl"
  static let bonjourType = "_syncmesh._tcp"

  private let queue: DispatchQueue
  private weak var reporter: P2pReporting?

  private var listener: NWListener?
  private var browser: NWBrowser?
  private var announces = Data()
  private var room = ""
  private var me = ""
  /// Peers currently reported, by the instance name that is also their id.
  private var known: [String: NWEndpoint] = [:]

  init(queue: DispatchQueue, reporter: P2pReporting) {
    self.queue = queue
    self.reporter = reporter
  }

  /// Every device with a Wi-Fi radio can do this; there is no capability to query.
  static var isAvailable: Bool { true }

  /// The stable id for a peer: a digest, because the announce itself is one byte too long.
  ///
  /// A Bonjour instance name allows 63 bytes and a peer id is 64 hex characters. A digest fits,
  /// is deterministic across restarts, and is what both ends compute — so the id in `onPeerFound`
  /// and the id derived from an accepted connection's prologue are the same string.
  static func idFor(_ announces: Data) -> String {
    SHA256.hash(data: announces).prefix(16).map { String(format: "%02x", $0) }.joined()
  }

  private func parameters() -> NWParameters {
    let params = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
    // the one line that lights up the peer-to-peer radio; off by default because enabling it
    // costs the device's ordinary Wi-Fi some airtime
    params.includePeerToPeer = true
    params.serviceClass = .responsiveData
    return params
  }

  func publish(service: String, announces: Data) throws {
    guard announces.count == announceLength else {
      throw P2pInvalidArgumentException("announces must be \(announceLength) bytes")
    }
    stop()
    self.announces = announces
    room = service
    me = Self.idFor(announces)

    var txt = NWTXTRecord()
    txt.setEntry(.data(announces), for: "a")
    txt.setEntry(.string(service), for: "r")

    let params = parameters()
    let made: NWListener
    do {
      made = try NWListener(using: params)
    } catch {
      throw P2pListenerFailedException(describe(error))
    }
    var advertised = NWListener.Service(
      name: me, type: Self.bonjourType, domain: nil, txtRecord: txt)
    // a lingering record from a previous run would otherwise be renamed to "… (2)" and this
    // device's id would silently change underneath the mesh
    advertised.noAutoRename = true
    made.service = advertised
    made.newConnectionHandler = { [weak self] connection in
      self?.queue.async { self?.accept(connection) }
    }
    made.stateUpdateHandler = { [weak self] state in
      // `.waiting` is not a failure — it is what a radio coming up looks like, and what an
      // unanswered Local Network prompt looks like
      if case let .failed(error) = state {
        self?.reporter?.failed(radio: Self.radio, why: describe(error))
      }
    }
    made.start(queue: queue)
    listener = made

    // the TXT-carrying descriptor, or `result.metadata` comes back `.none` and the announce
    // never arrives
    let found = NWBrowser(
      for: .bonjourWithTXTRecord(type: Self.bonjourType, domain: nil), using: params)
    found.browseResultsChangedHandler = { [weak self] _, changes in
      self?.queue.async { self?.changed(changes) }
    }
    found.stateUpdateHandler = { [weak self] state in
      if case let .failed(error) = state {
        self?.reporter?.failed(radio: Self.radio, why: describe(error))
      }
    }
    found.start(queue: queue)
    browser = found
  }

  private func changed(_ changes: Set<NWBrowser.Result.Change>) {
    for change in changes {
      switch change {
      case let .added(result): sighted(result)
      case let .removed(result):
        guard case let .service(name, _, _, _) = result.endpoint else { continue }
        known[name] = nil
        reporter?.peerLost(radio: Self.radio, id: name)
      case let .changed(_, new, flags):
        if flags.contains(.metadataChanged) { sighted(new) }
      case .identical: continue
      @unknown default: continue
      }
    }
  }

  private func sighted(_ result: NWBrowser.Result) {
    guard case let .service(name, _, _, _) = result.endpoint,
      case let .bonjour(txt) = result.metadata,
      name != me,
      txt["r"] == room,
      case let .data(theirs)? = txt.getEntry(for: "a"),
      theirs.count == announceLength
    else { return }
    known[name] = result.endpoint
    reporter?.peerFound(radio: Self.radio, id: name, announces: theirs)
  }

  /// Dials a peer, writes the identity prologue, and hands back the path.
  func connect(to id: String, handle: String, done: @escaping (Result<P2pPath, Error>) -> Void) {
    guard let endpoint = known[id] else {
      done(.failure(P2pPeerUnknownException(id)))
      return
    }
    let connection = NWConnection(to: endpoint, using: parameters())
    var settled = false
    connection.stateUpdateHandler = { [weak self] state in
      guard let self, !settled else { return }
      switch state {
      case .ready:
        settled = true
        // who we are, first and always: the far end has no other way to learn it
        connection.send(
          content: self.announces, contentContext: .defaultMessage, isComplete: true,
          completion: .contentProcessed { error in
            self.queue.async {
              if let error {
                connection.cancel()
                done(.failure(P2pPeerUnreachableException(describe(error))))
                return
              }
              let path = P2pPath(
                handle: handle, peer: id, radio: Self.radio, connection: connection,
                queue: self.queue)
              done(.success(path))
            }
          })
      case let .failed(error):
        settled = true
        connection.cancel()
        done(.failure(P2pPeerUnreachableException(describe(error))))
      case .cancelled:
        settled = true
        done(.failure(P2pPeerUnreachableException("the dial was cancelled")))
      default:
        // `.waiting` and `.preparing` are a radio coming up, not a failure
        break
      }
    }
    connection.start(queue: queue)
  }

  /// Reads the prologue off an accepted connection, so `from` names the same peer `onPeerFound` did.
  private func accept(_ connection: NWConnection) {
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      if case let .failed(error) = state {
        self.reporter?.failed(radio: Self.radio, why: describe(error))
        connection.cancel()
      }
    }
    connection.start(queue: queue)
    connection.receive(minimumIncompleteLength: announceLength, maximumLength: announceLength) {
      [weak self] content, _, _, error in
      guard let self else { return }
      self.queue.async {
        guard error == nil, let content, content.count == announceLength else {
          // a connection that could not say who it is gets nothing; the transport would have
          // refused it at the handshake anyway, and this costs one socket instead of a session
          connection.cancel()
          self.reporter?.failed(
            radio: Self.radio, why: "an inbound path did not open with an identity")
          return
        }
        let path = P2pPath(
          handle: UUID().uuidString, peer: Self.idFor(content), radio: Self.radio,
          connection: connection, queue: self.queue)
        self.reporter?.pathOpened(path)
      }
    }
  }

  func stop() {
    listener?.cancel()
    listener = nil
    browser?.cancel()
    browser = nil
    known.removeAll()
  }
}
