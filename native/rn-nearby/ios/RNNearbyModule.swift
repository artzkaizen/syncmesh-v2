import ExpoModulesCore
import Foundation

/// Peer-to-peer Wi-Fi for React Native: two radios, one module, one port.
///
/// The JavaScript side is `@syncmesh/transports`' `RnP2pManager`, and this is written against it
/// rather than the other way round — the port states exactly what the mesh touches, and every
/// member here exists because that statement asked for it.
///
/// **Every event names its radio.** A device can run both engines at once, and a fabric routes by
/// the handle in the event; an event that did not say which radio it came from would be buffered
/// by the fabric that did not own the handle, for as long as the process lived.
///
/// Bytes cross as `Data`, which Expo converts to and from `Uint8Array` on both sides. There is no
/// base64 anywhere here, on purpose: this is the bulk pipe, and an encode that costs a third of
/// the bandwidth and a JavaScript loop per frame is the wrong tax to pay on it.
public final class RNNearbyModule: Module, P2pReporting, LanReporting {
  /// One serial queue for both engines and every path, so the maps below need no locking.
  private let queue = DispatchQueue(label: "dev.syncmesh.p2p", qos: .userInitiated)

  private var awdl: AwdlEngine?
  private var aware: WifiAwareEngine?
  private var lan: LanEngine?
  private var paths: [String: P2pPath] = [:]

  /// Inbound paths that arrived before JavaScript subscribed.
  ///
  /// The same gap the per-path backlog exists for, one level up: a path opened between the module
  /// loading and the fabric attaching its listener is a path an event would drop on the floor,
  /// leaving a socket open on the radio that nobody will ever read or close.
  private var pending: [P2pPath] = []
  private var watching = false

  public func definition() -> ModuleDefinition {
    Name("RNNearby")

    Events(
      "onPeerFound", "onPeerLost", "onPath", "onPathData", "onPathClosed", "onRadioFailed",
      "onAnnouncement", "onLanConnection", "onLanData", "onLanClosed")

    Function("supports") { (radio: String) -> Bool in
      switch radio {
      case AwdlEngine.radio: return AwdlEngine.isAvailable
      case WifiAwareEngine.radio: return WifiAwareEngine.isAvailable
      default: return false
      }
    }

    AsyncFunction("publish") { (radio: String, service: String, announces: Data) in
      try self.engine(for: radio).publish(service: service, announces: announces)
    }.runOnQueue(queue)

    AsyncFunction("connect") { (radio: String, peer: String, promise: Promise) in
      let handle = UUID().uuidString
      self.engine(for: radio).connect(to: peer, handle: handle) { opened in
        self.queue.async {
          switch opened {
          case let .failure(error): promise.reject(error)
          case let .success(path):
            self.hold(path)
            promise.resolve(path.handle)
          }
        }
      }
    }.runOnQueue(queue)

    AsyncFunction("send") { (handle: String, bytes: Data, promise: Promise) in
      guard let path = self.paths[handle] else {
        promise.reject(P2pPathUnknownException(handle))
        return
      }
      path.send(bytes) { error in
        self.queue.async {
          if let error { promise.reject(P2pWriteFailedException(describe(error))) } else {
            promise.resolve(nil)
          }
        }
      }
    }.runOnQueue(queue)

    Function("resume") { (handle: String) in
      self.queue.async { self.paths[handle]?.resume() }
    }

    Function("closePath") { (handle: String) in
      self.queue.async { self.paths[handle]?.close() }
    }

    AsyncFunction("stop") { (radio: String) in
      for path in self.paths.values where path.radio == radio { path.close() }
      self.engine(for: radio).stop()
    }.runOnQueue(queue)

    // MARK: the local network — announcements on a group, frames on a stream

    Function("lanSupports") { () -> Bool in LanEngine.isAvailable }

    AsyncFunction("lanStart") { (group: String, groupPort: Int) -> Int in
      let made = self.lan ?? LanEngine(queue: self.queue, reporter: self)
      self.lan = made
      return Int(try made.start(group: group, groupPort: UInt16(groupPort)))
    }.runOnQueue(queue)

    Function("lanAnnounce") { (bytes: Data) in
      self.queue.async { self.lan?.announce(bytes) }
    }

    AsyncFunction("lanDial") { (host: String, port: Int, promise: Promise) in
      guard let lan = self.lan else {
        promise.reject(P2pUnsupportedException("lan"))
        return
      }
      let handle = UUID().uuidString
      lan.dial(host: host, port: UInt16(port), handle: handle) { opened in
        self.queue.async {
          switch opened {
          case let .failure(error): promise.reject(error)
          case let .success(path):
            self.holdLan(path)
            promise.resolve(path.handle)
          }
        }
      }
    }.runOnQueue(queue)

    AsyncFunction("lanStop") {
      for path in self.paths.values where path.radio == "lan" { path.close() }
      self.lan?.stop()
    }.runOnQueue(queue)

    /// Only here does an inbound path reach JavaScript — and anything that arrived first goes now.
    OnStartObserving("onPath") {
      self.queue.async {
        self.watching = true
        let waiting = self.pending
        self.pending.removeAll()
        for path in waiting { self.announce(path) }
      }
    }

    OnDestroy {
      self.queue.sync {
        for path in self.paths.values { path.close() }
        self.paths.removeAll()
        self.awdl?.stop()
        self.aware?.stop()
        self.lan?.stop()
      }
    }
  }

  // MARK: - engines

  private func engine(for radio: String) -> P2pEngine {
    switch radio {
    case AwdlEngine.radio:
      let made = awdl ?? AwdlEngine(queue: queue, reporter: self)
      awdl = made
      return made
    case WifiAwareEngine.radio:
      let made = aware ?? WifiAwareEngine(queue: queue, reporter: self)
      aware = made
      return made
    default:
      return UnknownEngine(radio: radio)
    }
  }

  // MARK: - paths

  private func hold(_ path: P2pPath) {
    paths[path.handle] = path
    path.onData = { [weak self] chunk in
      self?.sendEvent(
        "onPathData", ["protocol": path.radio, "path": path.handle, "bytes": chunk])
    }
    path.onClosed = { [weak self] in
      guard let self else { return }
      self.paths[path.handle] = nil
      self.sendEvent("onPathClosed", ["protocol": path.radio, "path": path.handle])
    }
    path.start()
  }

  private func announce(_ path: P2pPath) {
    hold(path)
    sendEvent("onPath", ["protocol": path.radio, "path": path.handle, "from": path.peer])
  }

  /// A LAN socket, reported on its own events so a fabric never sees a radio's traffic.
  private func holdLan(_ path: P2pPath) {
    paths[path.handle] = path
    path.onData = { [weak self] chunk in
      self?.sendEvent("onLanData", ["path": path.handle, "bytes": chunk])
    }
    path.onClosed = { [weak self] in
      guard let self else { return }
      self.paths[path.handle] = nil
      self.sendEvent("onLanClosed", ["path": path.handle])
    }
    path.start()
  }

  // MARK: - LanReporting

  func heard(_ bytes: Data, host: String, port: Int) {
    sendEvent("onAnnouncement", ["bytes": bytes, "host": host, "port": port])
  }

  func lanAccepted(_ path: P2pPath, host: String, port: Int) {
    holdLan(path)
    sendEvent("onLanConnection", ["path": path.handle, "host": host, "port": port])
  }

  func lanFailed(_ why: String) {
    sendEvent("onRadioFailed", ["protocol": "lan", "why": why])
  }

  // MARK: - P2pReporting

  func peerFound(radio: String, id: String, announces: Data) {
    sendEvent("onPeerFound", ["protocol": radio, "id": id, "announces": announces])
  }

  func peerLost(radio: String, id: String) {
    sendEvent("onPeerLost", ["protocol": radio, "id": id])
  }

  func pathOpened(_ path: P2pPath) {
    // held either way: a path nobody is listening for is still a socket this process owns
    if watching {
      announce(path)
      return
    }
    pending.append(path)
  }

  func failed(radio: String, why: String) {
    sendEvent("onRadioFailed", ["protocol": radio, "why": why])
  }
}

/// What the module asks of either radio. Narrow on purpose — the engines share nothing else.
protocol P2pEngine {
  func publish(service: String, announces: Data) throws
  func connect(to id: String, handle: String, done: @escaping (Result<P2pPath, Error>) -> Void)
  func stop()
}

extension AwdlEngine: P2pEngine {}
extension WifiAwareEngine: P2pEngine {}

/// A radio this build has never heard of — refused where it is asked for, rather than later.
private struct UnknownEngine: P2pEngine {
  let radio: String
  func publish(service: String, announces: Data) throws { throw P2pUnsupportedException(radio) }
  func connect(to id: String, handle: String, done: @escaping (Result<P2pPath, Error>) -> Void) {
    done(.failure(P2pUnsupportedException(radio)))
  }
  func stop() {}
}
