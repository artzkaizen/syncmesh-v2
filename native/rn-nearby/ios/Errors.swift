import ExpoModulesCore
import Network

/// Why a call failed, in codes the JavaScript side can switch on.
///
/// The line drawn here is **will retrying help**. An ordinary failure rejects the one call that
/// caused it and leaves the radio running — a peer wandering off mid-dial is the normal weather on
/// this medium, not a fault. A fatal one is a fact about this device or this build that will not
/// change while the app runs, and the mesh should stop asking and fall back rather than retry a
/// thousand times: no entitlement, no hardware, a service the Info.plist never declared.
enum P2pCode {
  // ordinary — reject this call, keep going
  static let peerUnreachable = "ERR_P2P_PEER_UNREACHABLE"
  static let peerUnknown = "ERR_P2P_PEER_UNKNOWN"
  static let pathUnknown = "ERR_P2P_PATH_UNKNOWN"
  static let pathClosed = "ERR_P2P_PATH_CLOSED"
  static let writeFailed = "ERR_P2P_WRITE_FAILED"
  static let handshakeFailed = "ERR_P2P_HANDSHAKE_FAILED"
  static let invalidArgument = "ERR_P2P_INVALID_ARGUMENT"

  // fatal — this radio will not work in this build on this device
  static let unsupported = "ERR_P2P_UNSUPPORTED"
  static let entitlementMissing = "ERR_P2P_ENTITLEMENT_MISSING"
  static let serviceNotDeclared = "ERR_P2P_SERVICE_NOT_DECLARED"
  static let listenerFailed = "ERR_P2P_LISTENER_FAILED"
}

final class P2pUnsupportedException: GenericException<String> {
  override var code: String { P2pCode.unsupported }
  override var reason: String { "this device cannot speak \(param)" }
}

final class P2pPeerUnknownException: GenericException<String> {
  override var code: String { P2pCode.peerUnknown }
  override var reason: String { "no peer is currently reported as \(param)" }
}

final class P2pPeerUnreachableException: GenericException<String> {
  override var code: String { P2pCode.peerUnreachable }
  override var reason: String { "no path could be opened: \(param)" }
}

final class P2pPathUnknownException: GenericException<String> {
  override var code: String { P2pCode.pathUnknown }
  override var reason: String { "there is no open path called \(param)" }
}

final class P2pPathClosedException: GenericException<String> {
  override var code: String { P2pCode.pathClosed }
  override var reason: String { "the path \(param) is closed" }
}

final class P2pWriteFailedException: GenericException<String> {
  override var code: String { P2pCode.writeFailed }
  override var reason: String { "the bytes did not leave: \(param)" }
}

final class P2pInvalidArgumentException: GenericException<String> {
  override var code: String { P2pCode.invalidArgument }
  override var reason: String { param }
}

final class P2pServiceNotDeclaredException: GenericException<String> {
  override var code: String { P2pCode.serviceNotDeclared }
  override var reason: String {
    "'\(param)' is not declared in this app's WiFiAwareServices, so the system will not publish it"
  }
}

final class P2pListenerFailedException: GenericException<String> {
  override var code: String { P2pCode.listenerFailed }
  override var reason: String { "the radio would not start: \(param)" }
}

/// A network error in words, kept rather than flattened to a number.
///
/// `.waiting` is deliberately **not** an error anywhere this is used: it is the ordinary state
/// while a radio comes up or while the Local Network prompt is unanswered, and treating it as a
/// failure would make every cold start look broken.
func describe(_ error: Error) -> String {
  guard let network = error as? NWError else { return String(describing: error) }
  switch network {
  case let .posix(code): return "posix \(code.rawValue)"
  case let .dns(code): return "dns \(code)"
  case let .tls(code): return "tls \(code)"
  @unknown default: return String(describing: network)
  }
}

/// Whether a failure means "this peer went away", which on a radio is weather rather than a bug.
func isPeerGone(_ error: Error) -> Bool {
  guard case let .posix(code)? = error as? NWError else { return false }
  switch code {
  case .ECONNABORTED, .ECONNREFUSED, .ECONNRESET, .ETIMEDOUT, .EHOSTUNREACH, .ENETUNREACH:
    return true
  default:
    return false
  }
}
