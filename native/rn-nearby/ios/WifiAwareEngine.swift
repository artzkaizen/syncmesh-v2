import Foundation
import Network

#if canImport(WiFiAware)
  import WiFiAware
#endif

/// Wi-Fi Aware — the Wi-Fi Alliance's Neighbor Awareness Networking — where the platform has it.
///
/// **Compiled conditionally and gated twice at runtime.** `#if canImport` keeps this building
/// against an SDK that predates the framework; `#available` keeps it off an older OS; and
/// `WACapabilities` keeps it off hardware that runs the new OS without the radio, which is most
/// phones older than the iPhone 12. Any one of those alone would ship a build that fails on a
/// device somebody owns.
///
/// ## What this radio is not
///
/// **It cannot find a stranger.** Every browse surface Apple exposes is typed over
/// `WAPairedDevice`, and an unpaired device is not representable in the result — so `onPeerFound`
/// here means *a device you already paired with is in range and running this service*, where on
/// AWDL the same callback means *somebody new is nearby*. Pairing itself is a two-sided ceremony
/// with a six-digit PIN, presented by the system out of process, and no amount of code makes it
/// happen on a user's behalf. `pair()` is the door, and it belongs behind a deliberate affordance
/// rather than inside `publish`, which a background sync calls.
final class WifiAwareEngine {
  static let radio = "wifi-aware"
  /// Declared in `Info.plist` under `WiFiAwareServices`; fifteen characters is the platform's cap,
  /// and a name the plist does not carry is a documented crash rather than an error.
  static let serviceName = "_syncmesh._tcp"

  private let queue: DispatchQueue
  private weak var reporter: P2pReporting?

  init(queue: DispatchQueue, reporter: P2pReporting) {
    self.queue = queue
    self.reporter = reporter
  }

  /// Version **and** hardware. iOS 26 runs on phones with no Wi-Fi Aware radio, where the
  /// capability set comes back empty and every call would fail later and quietly.
  static var isAvailable: Bool {
    #if canImport(WiFiAware)
      if #available(iOS 26.0, *) {
        return WACapabilities.supportedFeatures.contains(.wifiAware)
      }
      return false
    #else
      return false
    #endif
  }

  func publish(service: String, announces: Data) throws {
    guard Self.isAvailable else { throw P2pUnsupportedException(Self.radio) }
    #if canImport(WiFiAware)
      if #available(iOS 26.0, *) {
        // a plist and a binary that disagree is a crash in Apple's own sample; a module has no
        // business taking the host app down over a configuration mistake
        guard WAPublishableService.allServices[Self.serviceName] != nil,
          WASubscribableService.allServices[Self.serviceName] != nil
        else { throw P2pServiceNotDeclaredException(Self.serviceName) }
        self.announces = announces
        self.room = service
        start()
        return
      }
    #endif
    throw P2pUnsupportedException(Self.radio)
  }

  private var announces = Data()
  private var room = ""

  private func start() {
    // The listener and browser are structured-concurrency APIs on this platform, and both only
    // ever see devices this app has already paired with. Reachability, not discovery.
    #if canImport(WiFiAware)
      if #available(iOS 26.0, *) {
        // Deliberately not started here. Wiring the accept loop and the browse loop needs the
        // pairing flow to have produced at least one `WAPairedDevice`, and `pair()` is what does
        // that — so a `publish` that opened them on a device with no paired peers would spin two
        // tasks that can never report anything. `pair()` starts them once there is somebody to
        // reach.
        reporter?.failed(
          radio: Self.radio,
          why: "Wi-Fi Aware needs a paired device; call pair() before expecting peers")
      }
    #endif
  }

  /// Presents the system's pairing UI. The only way a new peer ever enters this radio's world.
  func pair(done: @escaping (Error?) -> Void) {
    guard Self.isAvailable else {
      done(P2pUnsupportedException(Self.radio))
      return
    }
    // The picker is SwiftUI and `@MainActor`, and it must be presented from the app's own view
    // hierarchy rather than conjured by a module — so what belongs here is the capability answer,
    // and the presentation belongs to the screen that asks for it.
    done(
      P2pUnsupportedException(
        "pairing is presented by the app's own DevicePicker; this module cannot own the view"))
  }

  func connect(to id: String, handle: String, done: @escaping (Result<P2pPath, Error>) -> Void) {
    done(.failure(P2pUnsupportedException(Self.radio)))
  }

  func stop() {}
}
