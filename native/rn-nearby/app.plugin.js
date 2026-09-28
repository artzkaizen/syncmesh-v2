const {
  withInfoPlist,
  withEntitlementsPlist,
  createRunOncePlugin,
} = require("@expo/config-plugins");

/**
 * What the platform needs declared before either radio will start.
 *
 * Written by a plugin rather than by hand because the two halves cannot drift: the Bonjour type
 * this module browses and the Wi-Fi Aware service it publishes are the same string, and a build
 * where they disagree finds nobody on one radio and crashes on the other.
 */
const SERVICE = "_syncmesh._tcp";

/**
 * @type {import("@expo/config-plugins").ConfigPlugin<
 *   { wifiAware?: boolean; localNetworkReason?: string } | undefined
 * >}
 */
const withNearby = (config, options = {}) => {
  // AWDL: iOS 14+ refuses to browse a Bonjour type the app did not declare, and there is no
  // wildcard — which is why the type is fixed and the room travels in the TXT record.
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSLocalNetworkUsageDescription =
      options.localNetworkReason ?? "Syncs directly with nearby devices when there is no network.";
    const declared = new Set(mod.modResults.NSBonjourServices ?? []);
    declared.add(SERVICE);
    mod.modResults.NSBonjourServices = [...declared];
    if (options.wifiAware !== true) return mod;
    // Wi-Fi Aware: a service missing from this dict, or carrying neither key, is a documented
    // crash at launch rather than an error anybody can catch.
    mod.modResults.WiFiAwareServices = {
      ...mod.modResults.WiFiAwareServices,
      [SERVICE]: { Publishable: {}, Subscribable: {} },
    };
    return mod;
  });

  if (options.wifiAware !== true) return config;
  return withEntitlementsPlist(config, (mod) => {
    mod.modResults["com.apple.developer.wifi-aware"] = ["Publish", "Subscribe"];
    return mod;
  });
};

module.exports = createRunOncePlugin(withNearby, "@syncmesh/rn-nearby", "0.1.0");
